// Edit V2's effect renders kept to what an edit can use (effect_cloud.ts):
// two in the cloud an effect, one copy on the disk, none for what's gone.

import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { previewable } from "../src/cloud_playback.ts";
import * as effectCloud from "../src/effect_cloud.ts";

function home(): string {
  return fs.mkdtempSync(join(os.tmpdir(), "edit-effect-cloud-"));
}

/** Just enough of an App: its store's home and cache. */
function appAt(dir: string) {
  return { store: { home: dir, cacheDir: () => join(dir, "cache") } } as never;
}

test("a render's key is its project's own, which only that project's renders match", () => {
  const key = effectCloud.keyOf("p1-2", "call-map-a-0123456789ab.mp4");
  expect(key).toBe("edit/exports/p1-2/effect-call-map-a-0123456789ab.mp4");
  expect(effectCloud.isRender("p1-2", key)).toBe(true);
  expect(effectCloud.isRender("p1-3", key)).toBe(false);
  // Footage and the project's own exports are never one.
  expect(effectCloud.isRender("p1-2", "edit/originals/sha256/ab/call-map-a")).toBe(false);
  expect(effectCloud.isRender("p1-2", "edit/exports/p1-2/final.mp4")).toBe(false);
  expect(effectCloud.isRender("p1-2", "edit/exports/p1-2/effect-x/y.mp4")).toBe(false);
  expect(effectCloud.effectOf(key)).toBe("call-map-a");
  // The viewer streams it as it does footage; never another export of the project, nor playback's or results'.
  expect(previewable(key)).toBe(true);
  expect(previewable("edit/exports/p1-2/final.mp4")).toBe(false);
  expect(previewable("edit/exports/playback/effect-x.mp4")).toBe(false);
});

test("an effect keeps the render in use and the one before it; older ones go from the cloud and the cache", async () => {
  const dir = home();
  const app = appAt(dir);
  const removed: string[][] = [];
  const before = effectCloud.hooks.remove;
  effectCloud.hooks.remove = async (keys) => void removed.push(keys);
  try {
    const key = (n: number) => effectCloud.keyOf("p1", `board-${String(n).padStart(12, "0")}.mp4`);
    // A copy of the first in this computer's cache.
    const cached = effectCloud.cachePath(join(dir, "cache"), key(1));
    fs.mkdirSync(join(cached, ".."), { recursive: true });
    fs.writeFileSync(cached, "x");
    await effectCloud.inUse(app, "p1", "board", key(1));
    await effectCloud.inUse(app, "p1", "board", key(2));
    expect(removed).toEqual([]);
    await effectCloud.inUse(app, "p1", "board", key(3));
    expect(removed).toEqual([[key(1)]]);
    expect(fs.existsSync(cached)).toBe(false);
    // Made on another computer: the render it replaced is said at the swap, and the one before that here goes.
    effectCloud.replaced(dir, "p1", "board", key(4));
    await effectCloud.inUse(app, "p1", "board", key(5));
    expect(removed.at(-1)).toEqual([key(2), key(3)]);
    // Another effect's are its own.
    await effectCloud.inUse(app, "p1", "titles", effectCloud.keyOf("p1", "titles-000000000001.mp4"));
    expect(removed.length).toBe(2);
    // A delete that failed is tried again with the next render.
    effectCloud.hooks.remove = async () => {
      throw new Error("offline");
    };
    await effectCloud.inUse(app, "p1", "board", key(6));
    effectCloud.hooks.remove = async (keys) => void removed.push(keys);
    await effectCloud.inUse(app, "p1", "board", key(7));
    expect(removed.at(-1)).toEqual([key(4), key(5)]);
    // A deleted project's: all of them, and the ones it used.
    await effectCloud.forgetProject(app, "p1", [key(9), "edit/originals/sha256/ab/x", null]);
    expect(new Set(removed.at(-1))).toEqual(new Set([key(6), key(7), effectCloud.keyOf("p1", "titles-000000000001.mp4"), key(9)]));
  } finally {
    effectCloud.hooks.remove = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a render goes into the cache as the same file, and comes back from it rather than being drawn again", () => {
  const dir = home();
  try {
    const out = join(dir, "media", "p1", "effect-renders", "board-0123456789ab.mp4");
    fs.mkdirSync(join(out, ".."), { recursive: true });
    fs.writeFileSync(out, "render");
    const key = effectCloud.keyOf("p1", "board-0123456789ab.mp4");
    const cache = join(dir, "cache");
    expect(effectCloud.linkInto(out, cache, key)).toBe(true);
    const copy = effectCloud.cachePath(cache, key);
    expect(fs.statSync(copy).ino).toBe(fs.statSync(out).ino);
    fs.rmSync(out);
    expect(effectCloud.bringBack(cache, "p1", "board-0123456789ab.mp4", out)).toBe(true);
    expect(fs.readFileSync(out, "utf8")).toBe("render");
    expect(effectCloud.bringBack(cache, "p1", "board-ffffffffffff.mp4", join(dir, "nope.mp4"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("render files no edit plays from go; one still playing from its file, and the one before it, stay", () => {
  const dir = home();
  try {
    const renders = (id: string) => join(dir, "media", id, "effect-renders");
    const file = (id: string, name: string, at = Date.now() - 2 * 3600_000) => {
      fs.mkdirSync(renders(id), { recursive: true });
      const path = join(renders(id), name);
      fs.writeFileSync(path, "x".repeat(10));
      fs.utimesSync(path, at / 1000, at / 1000);
      return path;
    };
    fs.mkdirSync(join(dir, "projects"), { recursive: true });
    const playing = file("p1", "local-000000000002.mp4");
    const before = file("p1", "local-000000000001.mp4");
    const upNow = file("p1", "board-000000000002.mp4");
    const gone = file("p1", "removed-000000000001.mp4");
    const fresh = file("p1", "board-000000000003.mp4", Date.now());
    const deleted = file("p9", "board-000000000001.mp4");
    fs.writeFileSync(
      join(dir, "projects", "p1.json"),
      JSON.stringify({
        media: [
          // Not up (signed out): plays from its file, and the one before it stays for an undo.
          { path: playing, effect: "local", cloud: null },
          // In the cloud: its files here are done with.
          { path: "http://127.0.0.1:7700/api/cloud/preview?key=x", effect: "board", cloud: { original: "x" } },
        ],
      }),
    );
    // An unreadable project keeps all of its.
    fs.writeFileSync(join(dir, "projects", "p2.json"), "{");
    const kept2 = file("p2", "board-000000000001.mp4");
    expect(effectCloud.sweepRenders(dir)).toEqual({ files: 3, bytes: 30 });
    for (const path of [playing, before, fresh, kept2]) expect(fs.existsSync(path)).toBe(true);
    for (const path of [upNow, gone, deleted]) expect(fs.existsSync(path)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
