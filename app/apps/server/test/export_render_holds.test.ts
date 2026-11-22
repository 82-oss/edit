// An export never loses an effect's render it planned, never reports Edit's
// own render as the person's damaged footage, and keeps the last export it
// copies its chunks from (Sphe's M4, Nov 17, nightly-78: "Officers
// Traumatized…", 1:48:29, 37 effects: cutfx-10's render deleted 5 s into the
// export by its swap into the cache, the export failing on it 9 minutes in
// with "Edit can't read that video … download it again", and Retry rendering
// all 88 chunks again after its room-making took the 7.3 GB file it copied from).

import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { explain } from "@edit/types/problems";

import { chunkFolder, effectIn, ExportRegistry, exportCloud, located, room } from "../src/exports.ts";
import { pinned } from "../src/file_pins.ts";
import type { Media, Project } from "../src/model.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

function render(id: string, path: string, key: string, extra: Partial<Media> = {}): Media {
  return { id, name: "board", path, kind: "video", duration: 1, width: 64, height: 36, fps: 30, has_audio: false, effect: "board", effect_key: key, ...extra };
}

async function edit(store: ReturnType<typeof fixtureHome>["store"], path: string): Promise<string> {
  const id = store.create("V2", { width: 64, height: 36, fps: 30 }).project.id;
  await store.update(id, "test", (p) => {
    p.media.push(render("m1", path, "a1caed560fbc"));
    p.clips.push(clip({ id: "c1", track: p.tracks[0]!.id, start: 0, duration: 30, type: "video", media: "m1" }));
  });
  return id;
}

/** The media paths the engine was handed for each start. */
function pathsOf(job: { project: { json: string } }): string[] {
  return (JSON.parse(job.project.json) as Project).media.map((one) => one.path);
}

async function settled(registry: ExportRegistry): Promise<void> {
  for (let tries = 0; registry.running() && tries < 1000; tries++) await Bun.sleep(5);
}

test("an export taken of the edit before its render moved reads the render where the edit has it now", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("export-render-moved");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const handed: string[][] = [];
  const job = spyOn(native.ExportJob, "start").mockImplementation((started) => {
    handed.push(pathsOf(started));
    return { cancel: () => {}, wait: async () => { fs.writeFileSync(started.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  try {
    fs.mkdirSync(`${dir}/effect-renders`, { recursive: true });
    const file = `${dir}/effect-renders/board-a1caed560fbc.mp4`;
    fs.writeFileSync(file, "render");
    const id = await edit(store, file);
    // The edit as the export is asked for; then the render goes up and its file moves to the cache's copy.
    const taken = structuredClone(store.get(id)!.project);
    fs.mkdirSync(`${dir}/cache-copy`, { recursive: true });
    fs.renameSync(file, `${dir}/cache-copy/board.mp4`);
    await store.update(id, "test", (p) => void (p.media[0]!.path = `${dir}/cache-copy/board.mp4`));
    await registry.start(store, app.library, taken, native.exportDefaults(), `${dir}/out.mp4`, { drive: false, keepLocal: true });
    await settled(registry);
    expect(handed).toEqual([[`${dir}/cache-copy/board.mp4`]]);
    expect(registry.activity().find((one) => one.id === id)).toMatchObject({ state: "done" });
    // A render of other code is another render: never swapped in for the one the export is of.
    const other = located(taken, { ...taken, media: [render("m1", `${dir}/elsewhere.mp4`, "ffffffffffff")] });
    expect(other.media[0]!.path).toBe(file);
  } finally {
    job.mockRestore(); archive.mockRestore(); plan.mockRestore(); cleanup();
  }
});

test("a render the engine can't read is made again and the export carries on; only past that is it said, as Edit's own file", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("export-render-unreadable");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const remade: [string, string, string, boolean][] = [];
  const remake = spyOn(seams.broll as Required<typeof seams.broll>, "remakeEffect").mockImplementation(async (project, name, key, unreadable) => {
    remade.push([project, name, key, unreadable]);
    fs.writeFileSync(`${dir}/effect-renders/board-a1caed560fbc.mp4`, "drawn again");
  });
  let starts = 0;
  const job = spyOn(native.ExportJob, "start").mockImplementation((started) => {
    starts += 1;
    const [path] = pathsOf(started);
    return {
      cancel: () => {},
      wait: async () => {
        // What the engine said on the M4 (render.rs), the first time only.
        if (starts === 1) throw new Error(`p1: could not decode ${path}: failed to fill whole buffer`);
        fs.writeFileSync(started.output, "export");
        return { seconds: 1, bytes: 6 };
      },
    };
  });
  try {
    fs.mkdirSync(`${dir}/effect-renders`, { recursive: true });
    const file = `${dir}/effect-renders/board-a1caed560fbc.mp4`;
    fs.writeFileSync(file, "half a render");
    const id = await edit(store, file);
    await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), `${dir}/out.mp4`, { drive: false, keepLocal: true });
    await settled(registry);
    expect(remade).toEqual([[id, "board", "a1caed560fbc", true]]);
    expect(starts).toBe(2);
    expect(registry.activity().find((one) => one.id === id)).toMatchObject({ state: "done" });
    // Gone, and nothing makes it again: the export says so plainly, never "download it again … import it again".
    remake.mockImplementation(async () => {
      throw new Error("The board effect is still rendering: export again in a minute or two.");
    });
    fs.rmSync(file);
    fs.rmSync(`${dir}/out.mp4`);
    await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), `${dir}/out.mp4`, { drive: false, keepLocal: true });
    await settled(registry);
    const failed = registry.activity().find((one) => one.id === id);
    expect(failed).toMatchObject({ state: "failed", error: "The board effect is still rendering: export again in a minute or two." });
    // The engine's own words naming a render (an older build, a render past every remake) read as Edit's file.
    const said = explain(`p1: could not decode ${file.replace(dir, "/Users/x/.edit/media/p1")}: failed to fill whole buffer`);
    expect(said.title).toBe("One of the edit's effects couldn't be read");
    expect(said.fix).not.toContain("Download it again");
    expect(explain("the board effect's render couldn't be read, even after Edit made it again").title).toBe("One of the edit's effects couldn't be read");
    // A person's own footage still gets the footage line.
    expect(explain("p1: could not decode /Users/x/Downloads/bodycam.mp4: failed to fill whole buffer").title).toBe("Edit can't read that video");
    expect(effectIn(`could not decode ${file}: x`, store.get(id)!.project)).toMatchObject({ name: "board", key: "a1caed560fbc", unreadable: false });
  } finally {
    remake.mockRestore();
    job.mockRestore(); archive.mockRestore(); plan.mockRestore(); cleanup();
  }
});

test("an export short of room keeps the last export it copies from while anything else can go, and holds its renders until it ends", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("export-keeps-ahead");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const before = room.make;
  const heldLast: boolean[] = [];
  try {
    fs.mkdirSync(`${dir}/effect-renders`, { recursive: true });
    const file = `${dir}/effect-renders/board-a1caed560fbc.mp4`;
    fs.writeFileSync(file, "render");
    const id = await edit(store, file);
    // The last export, its chunk folder's manifest naming it: what an export of this edit copies every unchanged chunk from.
    const ahead = `${dir}/last.mp4`;
    fs.writeFileSync(ahead, "last export");
    const chunks = chunkFolder(store.cacheDir(), id);
    fs.mkdirSync(chunks, { recursive: true });
    fs.writeFileSync(`${chunks}/manifest-v1.json`, JSON.stringify({ output: ahead, size: 11, fps: 30, chunks: [{ key: "c0", at: 0, frames: 30 }] }));
    room.make = () => void heldLast.push(pinned(ahead));
    // Ten terabytes: no room whatever goes, so it's let go for the second ask, then refused.
    await expect(registry.start(store, app.library, store.get(id)!.project, { ...native.exportDefaults(), target_mb: 10_000_000 }, `${dir}/big.mp4`, { drive: false })).rejects.toThrow("This export needs about");
    expect(heldLast).toEqual([true, false]);
    expect(pinned(file)).toBe(false);
    // An export that starts holds its render while it renders, and lets go once it's done.
    room.make = before;
    let during = false;
    const job = spyOn(native.ExportJob, "start").mockImplementation((started) => ({ cancel: () => {}, wait: async () => { during = pinned(file) && pinned(ahead); fs.writeFileSync(started.output, "export"); return { seconds: 1, bytes: 6 }; } }));
    try {
      await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), `${dir}/out.mp4`, { drive: false, keepLocal: true });
      await settled(registry);
      expect(during).toBe(true);
      expect(pinned(file)).toBe(false);
      expect(pinned(ahead)).toBe(false);
    } finally {
      job.mockRestore();
    }
  } finally {
    room.make = before;
    archive.mockRestore(); plan.mockRestore(); cleanup();
  }
});
