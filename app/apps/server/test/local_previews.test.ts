import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { NoRoom } from "../src/cloud_blocks.ts";
import { localPath } from "../src/cloud_media.ts";
import * as localPreviews from "../src/local_previews.ts";
import * as playing from "../src/playing.ts";
import * as storage from "../src/storage.ts";
import { scratch } from "./helpers/home.ts";
import { media, project as newProject } from "./helpers/model.ts";

const realFetch = localPreviews.hooks.fetch;
const realFree = storage.diskHooks.free;
afterEach(() => {
  localPreviews.hooks.fetch = realFetch;
  storage.diskHooks.free = realFree;
  localPreviews.reset();
  storage.resetRoom();
  playing.reset();
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

/** What whole copies leave free (storage.ts `cacheFloor`; the tests' disk: 15 GB, what Edit keeps free on it). */
const FLOOR = storage.cacheFloor("/");

/** A disk with `free` bytes free, which each fake fetch fills as it "writes" (telling its room what's left). */
function disk(free: number) {
  const state = { free, lowest: free };
  storage.diskHooks.free = () => state.free;
  const write = (bytes: number) => {
    state.free -= bytes;
    state.lowest = Math.min(state.lowest, state.free);
  };
  return { state, write };
}

const own = (name: string, size: number) => {
  const key = `edit/originals/sha256/${name}/clip.mp4`;
  return { key, cloud: { source: name, original: key, proxy: key, size } };
};

function projectOf(files: { key: string; cloud: object }[]) {
  const project = newProject();
  files.forEach((one, n) => project.media.push(media({ id: `m${n}`, name: `m${n}`, path: stream(one.key), kind: "video", duration: 60, cloud: one.cloud } as never)));
  project.clips.push(...files.map((_, n) => ({ type: "video", id: `c${n}`, track: "v1", media: `m${n}`, start: n * 100, duration: 100, source_in: 0, speed: 1 }) as never));
  return project;
}

test("whole copies start only while the disk keeps the cache's floor beside what's still coming; one with no room streams on, and starts once there's room (kenobi, Nov 17: 3.3 GB in a minute, to ENOSPC)", async () => {
  const home = scratch("local-previews");
  try {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    localPreviews.hooks.fetch = (key) => new Promise<void>((resolve) => { started.push(key); finish.set(key, resolve); });
    // 300 MB over the cache's floor.
    const { state } = disk(FLOOR + 300_000_000);
    const big = own("big", 250_000_000);
    const bigger = own("bigger", 200_000_000);
    const small = own("small", 40_000_000);
    const project = projectOf([big, bigger, small]);
    // All three wait their turn; the first fits; the second doesn't beside it (until Nov 17 nothing under way was
    // counted); the third does.
    expect(localPreviews.fetchInPlayheadOrder(home.dir, project, 0)).toBe(3);
    await Bun.sleep(5);
    expect(started).toEqual([big.key, small.key]);
    // Asked again (a warm, every 5 s of a play): nothing more starts.
    localPreviews.fetchInPlayheadOrder(home.dir, project, 0);
    await Bun.sleep(5);
    expect(started).toEqual([big.key, small.key]);
    // The big one written and in: still no room for the one waiting beside the small one's 40 MB.
    state.free -= 250_000_000;
    finish.get(big.key)!();
    await Bun.sleep(5);
    expect(started).toEqual([big.key, small.key]);
    // Room again (something deleted): it starts as the queue next moves.
    state.free += 500_000_000;
    finish.get(small.key)!();
    await Bun.sleep(5);
    expect(started).toEqual([big.key, small.key, bigger.key]);
  } finally {
    home.cleanup();
  }
});

test("a whole copy's exact size is checked again once its first block says it: one too big stops, isn't failed, and the censor check reads the stream at once", async () => {
  const home = scratch("local-previews");
  try {
    disk(FLOOR + 300_000_000);
    let asked = 0;
    localPreviews.hooks.fetch = async (_key, _local, room) => {
      asked++;
      // The first block: 500 MB, where nothing was known (Edit.app's window queues by key alone).
      if (room !== undefined && !room(500_000_000, 500_000_000)) throw new NoRoom();
    };
    const key = "edit/proxies/youtube/abc/0-1000.mp4";
    const local = localPath(home.dir, key);
    localPreviews.fetchWhole(key, local);
    await Bun.sleep(5);
    expect(asked).toBe(1);
    // It waits with its size known: not asked again (no block read again) while there's no room for it.
    localPreviews.fetchWhole(key, local);
    localPreviews.fetchNow(key, local);
    await Bun.sleep(5);
    expect(asked).toBe(1);
    await expect(localPreviews.whenHere(key, local, 1_000)).rejects.toThrow("the disk too full to keep it whole");
  } finally {
    home.cleanup();
  }
});

test("no whole copy starts while a play is watched; what waited starts once it stops", async () => {
  const home = scratch("local-previews");
  try {
    disk(Number.POSITIVE_INFINITY);
    const started: string[] = [];
    localPreviews.hooks.fetch = (key) => new Promise<void>(() => { started.push(key); });
    playing.note("p", true);
    const one = own("one", 10_000_000);
    localPreviews.fetchInPlayheadOrder(home.dir, projectOf([one]), 0);
    // A jump in the window (`hurry`) doesn't start one either.
    localPreviews.hurry(one.key);
    await Bun.sleep(5);
    expect(started).toEqual([]);
    playing.note("p", false);
    await Bun.sleep(5);
    expect(started).toEqual([one.key]);
  } finally {
    home.cleanup();
  }
});

test("a project's every file asked for at once, from both players, on a small disk: the cache's floor is never crossed, and what doesn't fit streams", async () => {
  const home = scratch("local-previews");
  try {
    // 1 GB over the floor free, 60 files of 150 MB each (9 GB), written 10 MB at a time as the blocks of a fill would be.
    const { state, write } = disk(FLOOR + 1_000_000_000);
    const files = Array.from({ length: 60 }, (_, n) => own(`f${n}`, 150_000_000));
    let kept = 0;
    localPreviews.hooks.fetch = async (_key, _local, room) => {
      let left = 150_000_000;
      if (room !== undefined && !room(left, left)) throw new NoRoom();
      while (left > 0) {
        await Bun.sleep(1);
        write(10_000_000);
        left -= 10_000_000;
        room?.(left, 150_000_000);
      }
      kept++;
    };
    const project = projectOf(files);
    localPreviews.fetchInPlayheadOrder(home.dir, project, 0);
    // Edit.app's window queues each by key alone, and every warm asks again.
    for (const one of files) localPreviews.fetchWhole(one.key, localPath(home.dir, one.key));
    for (let n = 0; n < 20; n++) {
      localPreviews.fetchInPlayheadOrder(home.dir, project, n * 100);
      await Bun.sleep(10);
    }
    for (let wait = 0; wait < 200 && state.free > FLOOR + 150_000_000; wait++) await Bun.sleep(5);
    await Bun.sleep(100);
    expect(state.lowest).toBeGreaterThanOrEqual(FLOOR);
    expect(kept).toBe(Math.floor(1_000_000_000 / 150_000_000));
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

test("the censor check waits for a streamed preview's whole copy: resolved with its path once it lands, rejected when it can't come (Nov 16: read through the stream during an import, it failed with an I/O error)", async () => {
  const home = scratch("local-previews-when-here");
  try {
    const local = localPath(home.dir, KEY);
    let land: () => void = () => {};
    localPreviews.hooks.fetch = (_key, at) =>
      new Promise<void>((resolve) => {
        land = () => {
          fs.mkdirSync(path.dirname(at), { recursive: true });
          fs.writeFileSync(at, "mp4");
          resolve();
        };
      });
    const waited = localPreviews.whenHere(KEY, local);
    let settled = false;
    void waited.then(() => (settled = true));
    await Bun.sleep(10);
    expect(settled).toBe(false);
    land();
    expect(await waited).toBe(local);
    // Here already: at once.
    expect(await localPreviews.whenHere(KEY, local)).toBe(local);
    // One that fails to come down: said, not waited on for good.
    const other = "edit/proxies/youtube/def/0-1000.mp4";
    localPreviews.hooks.fetch = async () => {
      throw new Error("offline");
    };
    await expect(localPreviews.whenHere(other, localPath(home.dir, other))).rejects.toThrow("offline");
    // And a timeout, however long the queue.
    localPreviews.reset();
    localPreviews.hooks.fetch = () => new Promise<void>(() => {});
    await expect(localPreviews.whenHere(other, localPath(home.dir, other), 20)).rejects.toThrow("not here");
  } finally {
    home.cleanup();
  }
});

test("whole copies come in the order a person is likely to watch: the next half minute, the edit's start, each part's start, then on, then what's before (Nov 16: a jump to the B-roll waited behind everything between)", async () => {
  const home = scratch("local-previews-likely");
  try {
    const started: string[] = [];
    localPreviews.hooks.fetch = (key) => new Promise<void>(() => void started.push(key));
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => `edit/originals/sha256/${name}/clip.mp4`);
    const project = newProject();
    project.settings.fps = 30;
    keys.forEach((key, n) => project.media.push(media({ id: `m${n}`, name: `m${n}`, path: stream(key), kind: "video", duration: 600, cloud: { proxy: key } } as never)));
    // A minute each: m0 at the start, m1, m2, m3 at a part's start (6000), m4 after it, m5 the playhead's (12000), m6 after, m7 just before the playhead.
    const at = (id: string, media: string, start: number) => ({ type: "video", id, track: "v1", media, start, duration: 1800, source_in: 0, speed: 1 }) as never;
    project.clips.push(at("c0", "m0", 0), at("c1", "m1", 1800), at("c2", "m2", 3600), at("c3", "m3", 6000), at("c4", "m4", 7800), at("c7", "m7", 10200), at("c5", "m5", 12000), at("c6", "m6", 13800));
    expect(localPreviews.fetchInPlayheadOrder(home.dir, project, 12000, [0, 6000])).toBe(8);
    // Four at a time: the playhead's minute, the start, the part's start, then on from the playhead.
    await Bun.sleep(5);
    expect(started).toEqual([keys[5]!, keys[0]!, keys[3]!, keys[6]!]);
  } finally {
    home.cleanup();
  }
});
