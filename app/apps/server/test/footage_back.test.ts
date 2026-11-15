// archive.ts `bringBack` / cloud_media `unfetchable`, `fetchFootageAgain`: footage the footage sweep cleared
// (mamagi's footage.ts) brought back from its sources, a replacement link where its own is gone.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as archive from "../src/archive.ts";
import * as cloud from "../src/cloud.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { CLEARED_NOTE, messageContext } from "../src/media_tools.ts";
import type { Media, Probe, ScriptJob } from "../src/model.ts";
import { useNative, wrap } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token", EDIT_CLOUD_HOLDER: undefined });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

const VIDEO: Probe = { kind: "video", duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true };
const LOCAL = `sha256:${"d".repeat(64)}`;

/** Drive's download for each of `files` (id → name and bytes), and its 404 for any other. */
function drive(files: Record<string, { name: string; bytes: Uint8Array }>): void {
  mock.on("GET", "/drive.usercontent.google.com/download", (request) => {
    const file = files[request.query.get("id") ?? ""];
    if (file === undefined) return new Response("", { status: 404 });
    const headers = { "content-type": "video/mp4", "content-disposition": `attachment; filename="${file.name}"` };
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (range === null) return new Response(file.bytes, { headers });
    const from = Number(range[1]);
    const to = range[2] === "" ? file.bytes.length - 1 : Math.min(Number(range[2]), file.bytes.length - 1);
    return new Response(file.bytes.slice(from, to + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${from}-${to}/${file.bytes.length}` } });
  });
}

function footage(id: string, source: string, original: string, proxy: string): Media {
  return { id, name: `${id}.mp4`, path: `/nowhere/${id}.mp4`, kind: "video", duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, cloud: { source, original, proxy, size: 100 } };
}

test("cleared footage: sources checked, the gone ones named, a replacement link used, the rest fetched again into the same media, and the cloud's mark cleared", async () => {
  const fixture = fixtureHome("footage-back");
  try {
    const raw = createStub();
    raw.init({ home: fixture.home, cacheDir: `${fixture.home}/cache`, ffmpeg: "ffmpeg", ffprobe: "ffprobe", log: () => {} });
    raw.probe = async () => VIDEO;
    raw.makeCloudProxy = async (_source: string, _probe: Probe, out: string) => fs.writeFileSync(out, "proxy");
    useNative(wrap(raw));
    cloudMedia.configurePlayback(fixture.app);
    const bytes = new Uint8Array(5000).map((_, n) => n % 251);
    drive({ BackFile123456789012: { name: "Bodycam 1.mp4", bytes }, Replacement1234567890: { name: "Interview.mp4", bytes } });
    const { store } = fixture;
    const id = store.create("Done long ago", { width: 1920, height: 1080, fps: 30 }).project.id;
    const render = `sha256:${"e".repeat(64)}`;
    await store.update(id, "test", (project) => {
      project.media.push(
        footage("back", "drive:BackFile123456789012", "edit/originals/drive/BackFile123456789012/Bodycam 1.mp4", "edit/proxies/drive/BackFile123456789012.mp4"),
        footage("gone", "drive:GoneFile123456789012", "edit/originals/drive/GoneFile123456789012/Gone.mp4", "edit/proxies/drive/GoneFile123456789012.mp4"),
        footage("disk", LOCAL, `edit/originals/sha256/${"d".repeat(64)}/Interview.mov`, `edit/proxies/sha256/${"d".repeat(64)}.mp4`),
        // A render Edit made, uploaded as itself: never the sweep's.
        footage("map", render, `edit/originals/sha256/${"e".repeat(64)}/map.mp4`, `edit/originals/sha256/${"e".repeat(64)}/map.mp4`),
      );
    });
    // As the sweep left them: the registry says none is there.
    for (const [source, key] of [["drive:BackFile123456789012", "edit/originals/drive/BackFile123456789012/Bodycam 1.mp4"], ["drive:GoneFile123456789012", "edit/originals/drive/GoneFile123456789012/Gone.mp4"], [LOCAL, `edit/originals/sha256/${"d".repeat(64)}/Interview.mov`]] as const) {
      mock.cloud.convex.media.set(source, { source, name: key.split("/").at(-1)!, originalKey: key, originalReady: false, proxyReady: false, size: 100, createdAt: 1, updatedAt: 1 });
    }
    mock.cloud.convex.saveElsewhere({ id, name: "Done long ago" }, "JJ's Mac");
    mock.cloud.convex.projects.get(id)!.footageCleared = { at: 1, media: [{ id: "back", name: "back.mp4", key: "edit/originals/drive/BackFile123456789012/Bodycam 1.mp4", size: 100, source: { kind: "drive", id: "drive:BackFile123456789012" } }] };

    expect(await archive.lookUp(id)).toMatchObject({ at: 1 });
    // The agent is told plainly, with each message.
    expect(await messageContext(fixture.app, id, null, false)).toBe(CLEARED_NOTE);
    expect([...cloudMedia.footageBySource(store.get(id)!.project).keys()]).toEqual(["drive:BackFile123456789012", "drive:GoneFile123456789012", LOCAL]);

    const missing = await cloudMedia.unfetchable(fixture.app, id);
    expect(missing.map((one) => one.source)).toEqual(["drive:GoneFile123456789012", LOCAL]);
    expect(missing[0]!.why).toContain("can't find this file");
    expect(missing[1]!.why).toBe("It came from someone's disk, so it can't be downloaded again.");

    const jobs: ScriptJob[] = [];
    const unsubscribe = store.subscribe((event) => {
      if (event.type === "script" && event.id === id) jobs.push(event.job as ScriptJob);
    });
    try {
      await archive.bringBack(fixture.app, id, { [LOCAL]: "https://drive.google.com/file/d/Replacement1234567890/view" }, new Set(["drive:GoneFile123456789012"]));
    } finally {
      unsubscribe();
    }
    // Back under the same keys: its original and proxy on R2, the registry says so.
    expect(Buffer.from(mock.cloud.objects.get("edit/originals/drive/BackFile123456789012/Bodycam 1.mp4")!).equals(Buffer.from(bytes))).toBe(true);
    expect(mock.cloud.objects.has("edit/proxies/drive/BackFile123456789012.mp4")).toBe(true);
    expect(mock.cloud.convex.media.get("drive:BackFile123456789012")).toMatchObject({ originalReady: true, proxyReady: true });
    const media = store.get(id)!.project.media;
    expect(media.map((one) => one.id)).toEqual(["back", "gone", "disk", "map"]);
    expect(media[0]!.cloud).toMatchObject({ source: "drive:BackFile123456789012", original: "edit/originals/drive/BackFile123456789012/Bodycam 1.mp4", proxy: "edit/proxies/drive/BackFile123456789012.mp4" });
    // The one from a disk now comes from the replacement, in the same medium (its clips untouched).
    expect(media[2]!.cloud).toMatchObject({ source: "drive:Replacement1234567890", original: "edit/originals/drive/Replacement1234567890/Interview.mp4" });
    expect(media[2]!.name).toBe("disk.mp4");
    // Left out, as asked: as it was.
    expect(media[1]!.cloud!.source).toBe("drive:GoneFile123456789012");
    // Shown as an import's progress, then done; the cloud's mark is gone.
    expect(jobs[0]).toMatchObject({ back: true, state: "downloading", files: [{ file: "drive:BackFile123456789012" }, { file: LOCAL }] });
    expect(jobs.at(-1)!.state).toBe("done");
    expect(mock.cloud.convex.projects.get(id)!.footageCleared).toBeUndefined();
    expect(archive.clearedOf(id)).toBeNull();
    expect(await messageContext(fixture.app, id, null, false)).toBe("");
  } finally {
    fixture.cleanup();
  }
});

test("a source that fails to come back keeps the cloud's mark, so opening the project offers it again", async () => {
  const fixture = fixtureHome("footage-back-failed");
  try {
    cloudMedia.configurePlayback(fixture.app);
    drive({});
    const { store } = fixture;
    const id = store.create("Done long ago", { width: 1920, height: 1080, fps: 30 }).project.id;
    await store.update(id, "test", (project) => {
      project.media.push(footage("gone", "drive:GoneFile123456789012", "edit/originals/drive/GoneFile123456789012/Gone.mp4", "edit/proxies/drive/GoneFile123456789012.mp4"));
    });
    mock.cloud.convex.saveElsewhere({ id, name: "Done long ago" }, "JJ's Mac");
    mock.cloud.convex.projects.get(id)!.footageCleared = { at: 1, media: [] };
    await archive.lookUp(id);
    await archive.bringBack(fixture.app, id, {}, new Set());
    expect(mock.cloud.convex.projects.get(id)!.footageCleared).toEqual({ at: 1, media: [] });
    expect(archive.clearedOf(id)).not.toBeNull();
    // A link that isn't one video is refused before anything starts.
    await expect(archive.bringBack(fixture.app, id, { "drive:GoneFile123456789012": "https://example.com/folder" }, new Set())).rejects.toThrow("isn't a link to one video");
  } finally {
    fixture.cleanup();
  }
});

test("a source another project already brought back is reused, not fetched twice", async () => {
  const fixture = fixtureHome("footage-back-shared");
  try {
    const raw = createStub();
    raw.init({ home: fixture.home, cacheDir: `${fixture.home}/cache`, ffmpeg: "ffmpeg", ffprobe: "ffprobe", log: () => {} });
    raw.probe = async () => VIDEO;
    let proxies = 0;
    raw.makeCloudProxy = async (_source: string, _probe: Probe, out: string) => {
      proxies++;
      fs.writeFileSync(out, "proxy");
    };
    useNative(wrap(raw));
    cloudMedia.configurePlayback(fixture.app);
    drive({ SharedFile1234567890: { name: "Shared.mp4", bytes: new Uint8Array(4000) } });
    const { store } = fixture;
    const shared = footage("shared", "drive:SharedFile1234567890", "edit/originals/drive/SharedFile1234567890/Shared.mp4", "edit/proxies/drive/SharedFile1234567890.mp4");
    const make = async (name: string) => {
      const id = store.create(name, { width: 1920, height: 1080, fps: 30 }).project.id;
      await store.update(id, "test", (project) => {
        project.media.push(structuredClone(shared));
      });
      mock.cloud.convex.saveElsewhere({ id, name }, "JJ's Mac");
      mock.cloud.convex.projects.get(id)!.footageCleared = { at: 1, media: [] };
      await archive.lookUp(id);
      return id;
    };
    // Cleared together with another finished project (mamagi's footage sweep).
    const [first, second] = [await make("First"), await make("Second")];
    mock.cloud.convex.media.set("drive:SharedFile1234567890", { source: "drive:SharedFile1234567890", name: "Shared.mp4", originalKey: shared.cloud!.original, originalReady: false, proxyReady: false, size: 4000, createdAt: 1, updatedAt: 1 });
    await archive.bringBack(fixture.app, first, {}, new Set());
    const downloads = mock.calls("/drive.usercontent.google.com/download").length;
    expect([downloads > 0, proxies]).toEqual([true, 1]);
    // The other one's mark stayed; opening it, nothing is missing and nothing is fetched again.
    expect(mock.cloud.convex.projects.get(second)!.footageCleared).toBeDefined();
    expect(await cloudMedia.unfetchable(fixture.app, second)).toEqual([]);
    await archive.bringBack(fixture.app, second, {}, new Set());
    expect([mock.calls("/drive.usercontent.google.com/download").length, proxies]).toEqual([downloads, 1]);
    expect(store.get(second)!.project.media[0]!.cloud).toMatchObject({ original: shared.cloud!.original, proxy: shared.cloud!.proxy });
    expect(mock.cloud.convex.projects.get(second)!.footageCleared).toBeUndefined();
  } finally {
    fixture.cleanup();
  }
});
