import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { localPath } from "../src/cloud_media.ts";
import * as localPreviews from "../src/local_previews.ts";
import { scratch } from "./helpers/home.ts";
import { media, project as newProject } from "./helpers/model.ts";

const realFetch = localPreviews.hooks.fetch;
afterEach(() => {
  localPreviews.hooks.fetch = realFetch;
  localPreviews.reset();
});

const KEY = "edit/proxies/youtube/abc/0-1000.mp4";
const stream = (key: string) => `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(key)}`;

function cloudProject() {
  const project = newProject();
  project.media.push(
    media({ id: "m1", name: "a", path: stream(KEY), kind: "video", duration: 60, cloud: { proxy: KEY } } as never),
    media({ id: "m2", name: "b", path: stream("edit/proxies/youtube/def/0-1000.mp4"), kind: "video", duration: 60, cloud: { proxy: "edit/proxies/youtube/def/0-1000.mp4" } } as never),
    media({ id: "m3", name: "here", path: "/footage/here.mp4", kind: "video", duration: 60 }),
  );
  return project;
}

test("a cloud preview whose whole file is here is read from it; the rest stream, and come down behind", async () => {
  const home = scratch("local-previews");
  try {
    const cache = home.dir;
    const fetched: string[] = [];
    localPreviews.hooks.fetch = async (key, local) => {
      fetched.push(key);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, "mp4");
    };
    const project = cloudProject();
    // Nothing here yet: nothing swapped, both fetched.
    expect(localPreviews.localized(cache, project)).toBeNull();
    await Bun.sleep(10);
    expect(fetched.sort()).toEqual(["edit/proxies/youtube/abc/0-1000.mp4", "edit/proxies/youtube/def/0-1000.mp4"]);
    // Here now: both read from the files; the saved project keeps the cloud's paths.
    const local = localPreviews.localized(cache, project)!;
    expect(local.media.map((one) => one.path)).toEqual([localPath(cache, KEY), localPath(cache, "edit/proxies/youtube/def/0-1000.mp4"), "/footage/here.mp4"]);
    expect(project.media[0]!.path).toBe(stream(KEY));
    expect(localPreviews.pathOf(cache, project.media[0]!)).toBe(localPath(cache, KEY));
    expect(localPreviews.pathOf(cache, project.media[2]!)).toBe("/footage/here.mp4");
  } finally {
    home.cleanup();
  }
});

test("a media streaming something other than its preview is left as it is", () => {
  const home = scratch("local-previews");
  try {
    const project = newProject();
    const original = "https://r2.example/edit/originals/abc.mp4?X-Amz-Signature=1";
    project.media.push(media({ id: "m1", name: "a", path: original, kind: "video", duration: 60, cloud: { proxy: KEY } } as never));
    const local = localPath(home.dir, KEY);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, "mp4");
    expect(localPreviews.localized(home.dir, project)).toBeNull();
    expect(localPreviews.pathOf(home.dir, project.media[0]!)).toBe(original);
  } finally {
    home.cleanup();
  }
});

test("a preview that failed to come isn't asked again on every frame", async () => {
  const home = scratch("local-previews");
  try {
    let asked = 0;
    localPreviews.hooks.fetch = async () => {
      asked += 1;
      throw new Error("offline");
    };
    const project = cloudProject();
    localPreviews.fetchAll(home.dir, project);
    await Bun.sleep(10);
    localPreviews.fetchAll(home.dir, project);
    localPreviews.localized(home.dir, project);
    await Bun.sleep(10);
    expect(asked).toBe(2);
  } finally {
    home.cleanup();
  }
});

test("the page player's footage comes down whole in the timeline's order from the playhead; a file read now comes next", async () => {
  const home = scratch("local-previews");
  try {
    const cache = home.dir;
    const started: string[] = [];
    const finish: (() => void)[] = [];
    localPreviews.hooks.fetch = (key) => new Promise<void>((resolve) => { started.push(key); finish.push(resolve); });
    const keys = ["a", "b", "c", "d", "e", "f"].map((name) => `edit/originals/sha256/${name}/clip.mp4`);
    const project = newProject();
    keys.forEach((key, n) => project.media.push(media({ id: `m${n}`, name: `m${n}`, path: stream(key), kind: n === 5 ? "audio" : "video", duration: 60, cloud: { proxy: key } } as never)));
    // On the timeline: m4 first, then m3, m2 (its sound on m5), m1; m0 isn't played.
    const clip = (id: string, media: string, start: number, type = "video") => ({ type, id, track: type === "video" ? "v1" : "a1", media, start, duration: 100, source_in: 0, speed: 1 }) as never;
    project.clips.push(clip("c1", "m4", 0), clip("c2", "m3", 100), clip("c3", "m2", 200), clip("c4", "m5", 200, "audio"), clip("c5", "m1", 300));
    // From frame 150: what plays from there first (m3 still playing, m2, its sound, m1), then what's before (m4).
    expect(localPreviews.fetchInPlayheadOrder(cache, project, 150)).toBe(5);
    await Bun.sleep(5);
    expect(started).toEqual([keys[3]!, keys[2]!, keys[5]!, keys[1]!]);
    // The page reads m4 now (a jump back): it's next, ahead of what was waiting.
    localPreviews.fetchNow(keys[4]!, localPath(cache, keys[4]!));
    finish.shift()!();
    await Bun.sleep(5);
    expect(started.at(-1)).toBe(keys[4]);
    expect(started).not.toContain(keys[0]);
  } finally {
    home.cleanup();
  }
});

test("a preview read now (a jump to it in the window) comes down next, beside the ones under way, and its landing is told", async () => {
  const home = scratch("local-previews");
  try {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    localPreviews.hooks.fetch = (key, local) => {
      started.push(key);
      return new Promise<void>((resolve) => finish.set(key, () => {
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, "mp4");
        resolve();
      }));
    };
    const landed: string[] = [];
    const stop = localPreviews.onLanded((key) => landed.push(key));
    const keys = Array.from({ length: 8 }, (_, n) => `edit/proxies/youtube/k${n}/0-1000.mp4`);
    for (const key of keys) localPreviews.fetchWhole(key, localPath(home.dir, key));
    // Four at a time, in the order asked.
    expect(started).toEqual(keys.slice(0, 4));
    // The last one is read now: it starts at once, ahead of the four waiting.
    localPreviews.hurry(keys[7]!);
    expect(started).toEqual([...keys.slice(0, 4), keys[7]!]);
    // One not waiting (here already, or never asked) changes nothing.
    localPreviews.hurry("edit/proxies/youtube/nothing/0-1.mp4");
    expect(started.length).toBe(5);
    finish.get(keys[7]!)!();
    await Bun.sleep(5);
    expect(landed).toEqual([keys[7]!]);
    stop();
  } finally {
    home.cleanup();
  }
});
