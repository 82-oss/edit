// watermark_removal.ts and clean_strips.ts: each footage file's own
// see-through watermark (looked for once, kept by its source; none for most)
// taken out of it on the timeline by the engine, free: the
// cells of each file the timeline shows (fixed 30 s, so a clip extended later
// only does its new cells), each kept and never made twice (another project on
// the same footage reuses them), strips laid under a text strip of the same
// frames, and only a text strip ending the blur over their subtitles. The
// engine is a stand-in here (its own tests are Rust's: edit-engine watermark).

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import { enforceCleanStrips, NAME, strippedFrames, WATERMARK_NAME } from "../src/clean_strips.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import type { Media, Project, VideoClip } from "../src/model.ts";
import type { WatermarkPiece, WatermarkRemoved } from "../src/native/index.ts";
import { join } from "../src/paths.ts";
import * as tools from "../src/tools.ts";
import * as removalSchedule from "../src/removal_schedule.ts";
import * as removerCloud from "../src/remover_cloud.ts";
import * as wm from "../src/watermark_removal.ts";
import { fixtureHome } from "./helpers/home.ts";

// One cell at a time unless a test says (the Mac's memory would decide: watermark_removal.ts `limits`).
wm.limits.cells = 1;

// The footage's own seconds, whatever lesson another file's import set up (removal_schedule.ts's hints read the channel's).
const neutral = wm.hintsFor.project;
beforeEach(() => {
  wm.hintsFor.project = () => ({ hint: () => null, keep: [] });
});

afterEach(() => {
  wm.hintsFor.project = neutral;
  wm.useEngine(null);
  wm.useShelf(null);
  wm.reset();
});

test("cells: the fixed 30 s of each file the timeline shows, a second's handle each side, within the file", () => {
  expect(wm.cellsFor([[10, 20], [95, 100]], 120)).toEqual([[0, 30], [90, 120]]);
  // A handle crossing into the next cell takes it too; the file's end holds the last one in.
  expect(wm.cellsFor([[29.5, 31]], 45)).toEqual([[0, 30], [30, 45]]);
  expect(wm.cellsFor([[0, 12]], 12)).toEqual([[0, 12]]);
  // A kept cell's name reads back, for its own mark only.
  expect(wm.parseCell("30000-60000.watermark-abc123-3734-6167-6281-8417.mp4", "abc123")).toEqual({ from: 30, to: 60, box: [0.3734, 0.6167, 0.6281, 0.8417] });
  expect(wm.parseCell("0-30000.watermark-abc123-none.json", "abc123")).toEqual({ from: 0, to: 30, box: null });
  expect(wm.parseCell("0-30000.watermark-def456-none.json", "abc123")).toBeNull();
  // A text piece kept in the same folder (strips from before Nov 19) is never a cell.
  expect(wm.parseCell("9000-31000.text.mp4", "abc123")).toBeNull();
});

/** A project: footage `m` on v1 in one clip, a blur over its subtitles, a text strip and a watermark strip of the same seconds. */
function stacked(): Project {
  const clip: VideoClip = { id: "c1", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 };
  const strip = (id: string, what: "text" | "watermark" | undefined, box: [number, number, number, number]): Media => ({
    id,
    name: id,
    path: `/tmp/${id}.mp4`,
    kind: "video",
    duration: 30,
    width: 640,
    height: 120,
    fps: 30,
    has_audio: false,
    stacked_alpha: true,
    cleans: { media: "m", from: 0, to: 30, box, ...(what === undefined ? {} : { what }) },
  });
  return {
    id: "p",
    name: "p",
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
      { id: "v2", kind: "video", hidden: false, muted: false, locked: false },
    ],
    media: [{ id: "m", name: "tape", path: "/tmp/tape.mp4", kind: "video", duration: 60, width: 1280, height: 720, fps: 30, has_audio: false }, strip("t", undefined, [0, 0.8, 1, 1]), strip("w", "watermark", [0.37, 0.61, 0.63, 0.84])],
    clips: [clip, { id: "blur", track: "v2", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "adjustment", name: "Burned-in cover · c1", parent: "c1" } as unknown as Project["clips"][number]],
    next_id: 10,
  } as unknown as Project;
}

test("a watermark strip lies under a text strip of the same frames, both stuck to the clip; only the text strip ends the subtitles' blur", () => {
  const project = stacked();
  enforceCleanStrips(null, project);
  const text = project.clips.find((clip) => (clip.name ?? "").startsWith(`${NAME} · `)) as VideoClip;
  const mark = project.clips.find((clip) => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `)) as VideoClip;
  expect(text).toMatchObject({ media: "t", parent: "c1", start: 0, duration: 300 });
  expect(mark).toMatchObject({ media: "w", parent: "c1", start: 0, duration: 300 });
  const lane = (id: string) => project.tracks.findIndex((track) => track.id === id);
  expect(lane("v1")).toBeLessThan(lane(mark.track));
  expect(lane(mark.track)).toBeLessThan(lane(text.track));
  // The text strip ended the blur; the frames counted as stripped are the text strip's only.
  expect(project.clips.some((clip) => clip.id === "blur")).toBe(false);
  expect(strippedFrames(project).get("c1")).toEqual([[0, 300]]);
  // Saved again: nothing changes.
  const again = structuredClone(project);
  enforceCleanStrips(project, again);
  expect(again).toEqual(project);
  // With only a watermark strip, the blur over their subtitles stays.
  const alone = stacked();
  alone.media = alone.media.filter((media) => media.id !== "t");
  enforceCleanStrips(null, alone);
  expect(alone.clips.some((clip) => clip.id === "blur")).toBe(true);
  expect(strippedFrames(alone).size).toBe(0);
  expect(alone.clips.filter((clip) => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `)).length).toBe(1);
});

test("a watermark strip is always strictly beneath an overlapping subtitle strip, even when previously on a mixed track, inverted, or laid incrementally", () => {
  const lane = (project: Project, id: string) => project.tracks.findIndex((track) => track.id === id);
  const assertOrdered = (project: Project) => {
    const subs = project.clips.filter((clip): clip is VideoClip => (clip.name ?? "").startsWith(`${NAME} · `));
    const wms = project.clips.filter((clip): clip is VideoClip => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `));
    for (const s of subs) {
      for (const w of wms) {
        if (s.parent === w.parent && s.start < w.start + w.duration && w.start < s.start + s.duration) {
          expect(lane(project, w.track)).toBeLessThan(lane(project, s.track));
        }
      }
    }
  };

  // Case 1 (SMART Cops): watermark overlay sitting on a mixed track (`v9584`, with a cut-in) ABOVE `Subtitles removed`.
  const mixed = stacked();
  enforceCleanStrips(null, mixed);
  const oldSub = mixed.clips.find((clip) => (clip.name ?? "").startsWith(`${NAME} · `)) as VideoClip;
  const oldWm = mixed.clips.find((clip) => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `)) as VideoClip;
  mixed.tracks.push({ id: "v_mixed", kind: "video", hidden: false, muted: false, locked: false });
  oldWm.track = "v_mixed";
  mixed.clips.push({ id: "cutin", track: "v_mixed", start: 400, duration: 60, color: "green", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as VideoClip);
  expect(lane(mixed, oldWm.track)).toBeGreaterThan(lane(mixed, oldSub.track));
  enforceCleanStrips(null, mixed);
  assertOrdered(mixed);
  const afterMixed = structuredClone(mixed);
  enforceCleanStrips(mixed, afterMixed);
  expect(afterMixed).toEqual(mixed);

  // Case 2: watermark overlay on a pure-overlay lane stacked ABOVE an overlapping `Subtitles removed` lane.
  const inverted = stacked();
  enforceCleanStrips(null, inverted);
  const subTrackIdx = lane(inverted, inverted.clips.find((c) => (c.name ?? "").startsWith(`${NAME} · `))!.track);
  const wmTrackIdx = lane(inverted, inverted.clips.find((c) => (c.name ?? "").startsWith(`${WATERMARK_NAME} · `))!.track);
  // Swap the two pure-overlay lanes so watermark is above subtitles.
  const [wmTrack] = inverted.tracks.splice(wmTrackIdx, 1);
  inverted.tracks.splice(subTrackIdx, 0, wmTrack!);
  enforceCleanStrips(null, inverted);
  assertOrdered(inverted);
  const afterInverted = structuredClone(inverted);
  enforceCleanStrips(inverted, afterInverted);
  expect(afterInverted).toEqual(inverted);

  // Case 3: incremental saves across two clips where clip 1 gets watermark first, clip 2 gets subtitles first, then both get the other strip.
  const inc = stacked();
  inc.clips = [
    { id: "c1", track: "v1", start: 0, duration: 150, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as VideoClip,
    { id: "c2", track: "v1", start: 150, duration: 150, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 10, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as VideoClip,
  ];
  const fullMedia = structuredClone(inc.media);
  // Save 1: only watermark on [0, 5) (covers c1) and text on [10, 15) (covers c2).
  inc.media = [
    fullMedia[0]!,
    { ...fullMedia[2]!, id: "w1", cleans: { media: "m", from: 0, to: 5, box: [0.37, 0.61, 0.63, 0.84], what: "watermark" } },
    { ...fullMedia[1]!, id: "t2", cleans: { media: "m", from: 10, to: 15, box: [0, 0.4, 1, 1], what: "text" } },
  ];
  enforceCleanStrips(null, inc);
  // Save 2: now text arrives for c1 and watermark arrives for c2.
  inc.media.push(
    { ...fullMedia[1]!, id: "t1", cleans: { media: "m", from: 0, to: 5, box: [0, 0.4, 1, 1], what: "text" } },
    { ...fullMedia[2]!, id: "w2", cleans: { media: "m", from: 10, to: 15, box: [0.37, 0.61, 0.63, 0.84], what: "watermark" } },
  );
  enforceCleanStrips(null, inc);
  assertOrdered(inc);
  expect(inc.clips.filter((c) => (c.name ?? "").startsWith(`${NAME} · `)).length).toBe(2);
  expect(inc.clips.filter((c) => (c.name ?? "").startsWith(`${WATERMARK_NAME} · `)).length).toBe(2);
  const afterInc = structuredClone(inc);
  enforceCleanStrips(inc, afterInc);
  expect(afterInc).toEqual(inc);
});

/** A stand-in engine: a mark learned from any file but one named "plain" (none there); each piece a small stacked strip as long as the piece, or nothing where `absent` says. */
function standIn(calls: WatermarkPiece[], absent: (from: number) => boolean = () => false, learned: string[] = []): wm.Engine {
  return {
    async learn(source, _size, _duration, hint) {
      learned.push(`${source.slice(source.lastIndexOf("/") + 1)} ${JSON.stringify(hint)}`);
      if (source.includes("plain")) throw new Error("no see-through watermark that stays put was found in the footage");
      return JSON.stringify({ version: 1, of: source.slice(source.lastIndexOf("/") + 1) });
    },
    async remove(piece): Promise<WatermarkRemoved | null> {
      calls.push(piece);
      if (absent(piece.from)) return null;
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:size=64x64:rate=30:duration=${piece.to - piece.from}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", piece.out]);
      return { region: [0.37, 0.61, 0.63, 0.84], frames: Math.round((piece.to - piece.from) * 30), marked: 1, filled: 0.9, left: 0.08, took: 1 };
    },
  };
}

const clipOf = (id: string, media: string, start: number, seconds: number): VideoClip => ({ id, track: "v1", start, duration: Math.round(seconds * 30), color: "blue", fade_in: 0, fade_out: 0, type: "video", media, source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 });

/** A project with each of `files` on the timeline one after another, `seconds` of each from its start. */
async function project(app: App, files: string[], seconds: number, name = "p"): Promise<string> {
  const live = app.store.create(name, { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project) as Project;
  project.media = files.map((file, at): Media => ({ id: `m${at}`, name: `tape ${at}`, path: file, kind: "video", duration: 70, width: 1280, height: 720, fps: 30, has_audio: false }));
  project.clips = files.map((_, at) => clipOf(`f${at}`, `m${at}`, at * Math.round(seconds * 30), seconds));
  project.channel = "ch";
  await app.store.replace(project.id, null, project, "test");
  return project.id;
}

test("every footage file is looked at once for a mark of its own, kept by its source: cleaned where there's one, cell by cell; nothing where there's none; reused by another project", async () => {
  const { app, dir, store, cleanup } = fixtureHome("watermark-run");
  const calls: WatermarkPiece[] = [];
  const learned: string[] = [];
  wm.useEngine(standIn(calls, (from) => from === 60, learned));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  try {
    // A compilation: one re-uploader's tape with their mark, another's with none.
    const marked = join(dir, "marked.mp4");
    const plain = join(dir, "plain.mp4");
    fs.writeFileSync(marked, "a stand-in tape with a mark");
    fs.writeFileSync(plain, "a stand-in tape with none");
    const id = await project(app, [marked, plain], 40);
    await wm.ensure(app, id);
    await wm.settled();
    expect(learned).toEqual(["marked.mp4 null", "plain.mp4 null"]);
    // Only the marked tape's cells, by its own mark.
    expect(calls.map((piece) => [piece.source.endsWith("marked.mp4"), piece.from, piece.to])).toEqual([[true, 0, 30], [true, 30, 60]]);
    expect(calls[0]).toMatchObject({ size: [1280, 720], fps: 30, model: JSON.stringify({ version: 1, of: "marked.mp4" }) });
    const strips = store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark");
    expect(strips.map((media) => [media.cleans!.media, media.cleans!.from, media.cleans!.to])).toEqual([["m0", 0, 30], ["m0", 30, 60]]);
    expect(strips[0]).toMatchObject({ stacked_alpha: true, has_audio: false, cleans: { media: "m0", box: [0.37, 0.61, 0.63, 0.84] } });
    expect(store.get(id)!.project.clips.filter((clip) => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `)).length).toBe(2);
    expect(wm.piecesOf(id).map((piece) => [piece.from, piece.state, piece.left])).toEqual([[0, "done", 0.08], [30, "done", 0.08]]);
    expect(wm.isNone(await wm.markOf(app, `sha256:${await cloudMedia.sha256File(plain)}`))).toBe(true);
    // Again: nothing new, nothing looked at again.
    await wm.ensure(app, id);
    await wm.settled();
    expect([calls.length, learned.length]).toEqual([2, 2]);
    // The marked clip grows to 70 s: only the new cell, where the mark isn't (kept as nothing, never asked again).
    const grown = structuredClone(store.get(id)!.project);
    (grown.clips.find((clip) => clip.id === "f0") as VideoClip).duration = 70 * 30;
    (grown.clips.find((clip) => clip.id === "f1") as VideoClip).start = 70 * 30;
    await app.store.replace(id, null, grown, "test");
    await wm.ensure(app, id);
    await wm.settled();
    expect(calls.map((piece) => piece.from)).toEqual([0, 30, 60]);
    await wm.ensure(app, id);
    await wm.settled();
    expect(calls.length).toBe(3);
    // Another project (any channel's) on the same footage: the kept marks and cells, nothing looked at or made.
    const other = await project(app, [plain, marked], 70, "q");
    await wm.ensure(app, other);
    await wm.settled();
    expect([calls.length, learned.length]).toEqual([3, 2]);
    expect(store.get(other)!.project.media.filter((media) => media.cleans?.what === "watermark").map((media) => media.cleans!.media)).toEqual(["m1", "m1"]);
  } finally {
    cleanup();
  }
}, 60_000);

test("a file looked at with no mark found is looked at again once the team shows where theirs is; a file still being looked at keeps an export waiting", async () => {
  const { app, dir, cleanup } = fixtureHome("watermark-hint");
  const calls: WatermarkPiece[] = [];
  const learned: string[] = [];
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const engine = standIn(calls, () => false, learned);
  wm.useEngine({ ...engine, learn: async (...args) => (await gate, engine.learn(...args)) });
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  try {
    const plain = join(dir, "plain.mp4");
    fs.writeFileSync(plain, "a faint mark the search missed");
    const id = await project(app, [plain], 10);
    await wm.ensure(app, id);
    expect(wm.lookingAt(id)).toBe(1);
    open();
    await wm.settled();
    expect(wm.lookingAt(id)).toBe(0);
    expect(learned).toEqual(["plain.mp4 null"]);
    const source = `sha256:${await cloudMedia.sha256File(plain)}`;
    const hints: wm.Hints = { hint: (one) => (one === source ? [0.3, 0.6, 0.7, 0.85] : null), keep: [] };
    await wm.ensure(app, id, hints);
    await wm.settled();
    expect(learned).toEqual(["plain.mp4 null", `plain.mp4 ${JSON.stringify([0.3, 0.6, 0.7, 0.85])}`]);
    // Looked at with that hint and still none: not again for the same hint.
    await wm.ensure(app, id, hints);
    await wm.settled();
    expect(learned.length).toBe(2);
    expect(calls).toEqual([]);
  } finally {
    cleanup();
  }
}, 60_000);

test("the person's Stop lets a cell under way go at once: no piece stays running, a rented machine's job is called off (Nov 24, the Trooper edit)", async () => {
  const { app, dir, store, cleanup } = fixtureHome("watermark-stop");
  const base = standIn([]);
  let started = 0;
  let calledOff = 0;
  // A rented machine's job: it runs until it's called off.
  wm.useEngine({
    ...base,
    remove: async (_piece, _progress, stopped) => {
      started += 1;
      while (stopped?.() !== true) await Bun.sleep(10);
      calledOff += 1;
      throw new Error("stopped");
    },
  });
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  const before = wm.limits.cells;
  try {
    const file = join(dir, "marked.mp4");
    fs.writeFileSync(file, "a long stand-in tape with a mark");
    const id = await project(app, [file], 70);
    wm.limits.cells = 3;
    await wm.ensure(app, id);
    while (started < 3) await Bun.sleep(10);
    expect(wm.piecesOf(id).map((piece) => piece.state)).toEqual(["running", "running", "running"]);
    wm.stop(id);
    expect(wm.piecesOf(id)).toEqual([]);
    await wm.settled();
    expect(calledOff).toBe(3);
    // Nothing failed, nothing laid, nothing queued again.
    expect(wm.piecesOf(id)).toEqual([]);
    expect(store.get(id)!.project.media.filter((media) => media.cleans != null)).toEqual([]);
  } finally {
    wm.limits.cells = before;
    cleanup();
  }
}, 60_000);

test("a cell here that finishes after the Stop is kept and laid only when clean; one unclean is let go, nothing kept of it", async () => {
  const { app, dir, store, cleanup } = fixtureHome("watermark-stop-here");
  const base = standIn([]);
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let started = 0;
  // This computer's engine: it runs to its end whatever the Stop; the cell at 0 s comes out clean, the one at 30 s not.
  wm.useEngine({
    ...base,
    remove: async (piece, progress) => {
      started += 1;
      await gate;
      const done = await base.remove(piece, progress);
      return done === null ? null : { ...done, left: piece.from === 0 ? 0.08 : 0.6 };
    },
  });
  const shelf = wm.shelfIn(join(dir, "shelf"), () => false);
  wm.useShelf(shelf);
  const before = wm.limits.cells;
  try {
    const file = join(dir, "marked.mp4");
    fs.writeFileSync(file, "a stand-in tape with a mark");
    const id = await project(app, [file], 50);
    wm.limits.cells = 2;
    await wm.ensure(app, id);
    while (started < 2) await Bun.sleep(10);
    wm.stop(id);
    open();
    await wm.settled();
    const laid = store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark");
    expect(laid.map((media) => media.cleans!.from)).toEqual([0]);
    const source = `sha256:${await cloudMedia.sha256File(file)}`;
    const model = await wm.markOf(app, source);
    expect((await shelf.list(source, (model as wm.Model).hash)).map((one) => one.from)).toEqual([0]);
    expect(wm.piecesOf(id)).toEqual([]);
  } finally {
    wm.limits.cells = before;
    cleanup();
  }
}, 60_000);

test("an unclean cell's automatic look leaves alone the cell another project on the same footage kept meanwhile", async () => {
  const { app, dir, store, cleanup } = fixtureHome("watermark-shared-reject");
  const base = standIn([]);
  const gates = new Map<string, () => void>();
  let first = "";
  // Two projects on one tape run the same cell at once: the first project's comes out clean, the second's not.
  wm.useEngine({
    ...base,
    remove: async (piece, progress) => {
      const ours = piece.out.includes(`${first}-`);
      await new Promise<void>((resolve) => gates.set(ours ? "first" : "second", resolve));
      const done = await base.remove(piece, progress);
      return done === null ? null : { ...done, left: ours ? 0.08 : 0.6 };
    },
  });
  const shelf = wm.shelfIn(join(dir, "shelf"), () => false);
  wm.useShelf(shelf);
  const before = wm.limits.cells;
  try {
    const file = join(dir, "marked.mp4");
    fs.writeFileSync(file, "a stand-in tape with a mark");
    first = await project(app, [file], 20);
    const second = await project(app, [file], 20, "q");
    wm.limits.cells = 2;
    await wm.ensure(app, first);
    await wm.ensure(app, second);
    while (gates.size < 2) await Bun.sleep(10);
    gates.get("first")!();
    while (!store.get(first)!.project.media.some((media) => media.cleans?.what === "watermark")) await Bun.sleep(10);
    gates.get("second")!();
    await wm.settled();
    const source = `sha256:${await cloudMedia.sha256File(file)}`;
    const model = (await wm.markOf(app, source)) as wm.Model;
    // The first project's strip and its kept cell stay; the second's is done once more from that kept cell.
    const kept = await shelf.list(source, model.hash);
    expect(kept.map((one) => one.from)).toEqual([0]);
    const strip = store.get(first)!.project.media.find((media) => media.cleans?.what === "watermark")!;
    expect(fs.existsSync(strip.path)).toBe(true);
  } finally {
    wm.limits.cells = before;
    cleanup();
  }
}, 60_000);

test("a plan begun before the person's Stop queues nothing after it", async () => {
  const { app, dir, cleanup } = fixtureHome("watermark-stop-plan");
  const calls: WatermarkPiece[] = [];
  wm.useEngine(standIn(calls));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = join(dir, "marked.mp4");
    fs.writeFileSync(file, "a stand-in tape with a mark");
    const id = await project(app, [file], 20);
    // Its mark known first, so the next plan goes straight to its cells.
    await wm.ensure(app, id);
    await wm.settled();
    await app.store.update(id, "test", (p) => {
      p.media = p.media.filter((one) => one.cleans == null);
    });
    wm.reset();
    const planning = wm.ensure(app, id);
    wm.stop(id);
    await planning;
    await wm.settled();
    expect(wm.piecesOf(id)).toEqual([]);
  } finally {
    cleanup();
  }
}, 60_000);

test("cells run several at once by the Mac's memory (8 GB: one; 16 GB: three), a file looked at for its mark one at a time beside them", async () => {
  // The M4 (17.2 GB): three.
  expect([8, 11, 12, 16, 17.2, 32].map((gb) => wm.cellsAtOnceFor(gb * 2 ** 30))).toEqual([1, 1, 2, 3, 3, 3]);
  const { app, dir, cleanup } = fixtureHome("watermark-parallel");
  let active = 0;
  let most = 0;
  const base = standIn([]);
  wm.useEngine({
    ...base,
    remove: async (piece, progress) => {
      active += 1;
      most = Math.max(most, active);
      await Bun.sleep(150);
      const done = await base.remove(piece, progress);
      active -= 1;
      return done;
    },
  });
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  const before = wm.limits.cells;
  try {
    const file = join(dir, "marked.mp4");
    fs.writeFileSync(file, "a long stand-in tape with a mark");
    const id = await project(app, [file], 70);
    wm.limits.cells = 3;
    await wm.ensure(app, id);
    await wm.settled();
    expect(most).toBe(3);
    expect(wm.piecesOf(id).map((piece) => piece.state)).toEqual(["done", "done", "done"]);
    // One at a time where memory says so.
    wm.reset();
    most = 0;
    const other = await project(app, [file], 70, "q");
    await app.store.update(other, "test", (p) => {
      p.media = p.media.filter((one) => one.cleans == null);
    });
    wm.limits.cells = 1;
    wm.useShelf(wm.shelfIn(join(dir, "shelf2"), () => false));
    await wm.ensure(app, other);
    await wm.settled();
    expect(most).toBe(1);
  } finally {
    wm.limits.cells = before;
    cleanup();
  }
}, 60_000);

/**
 * Real footage through the product path (`EDIT_WATERMARK_REAL`: a file with a re-uploader's see-through mark, e.g.
 * Tulsa's 35 min; `EDIT_WATERMARK_AT`: seconds into it of 10 s on the timeline; `EDIT_WATERMARK_OUT`: a folder for the
 * strips): the real addon learns the mark from the whole file and cleans the timeline's cells. Signed out: nothing
 * reaches the cloud.
 */
test.skipIf(process.env.EDIT_WATERMARK_REAL === undefined)("real footage: the mark learned and the timeline's cells cleaned by the engine", async () => {
  const { useNative, initNative, isReal } = await import("../src/native/index.ts");
  const { app, store, cleanup } = fixtureHome("watermark-real");
  const previous = useNative(null);
  try {
    initNative({ home: app.store.home, cacheDir: app.store.cacheDir(), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe() });
    expect(isReal()).toBe(true);
    const source = process.env.EDIT_WATERMARK_REAL!;
    const probed = await (await import("../src/media.ts")).probe(source);
    const media: Media = { id: "m", name: "footage", path: source, kind: "video", duration: probed.duration, width: probed.width, height: probed.height, fps: probed.fps, has_audio: false };
    const live = app.store.create("real", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    project.media = [media];
    project.clips = [{ id: "f", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: Number(process.env.EDIT_WATERMARK_AT ?? "0"), speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }];
    project.channel = "real-test";
    await app.store.replace(project.id, null, project, "test");
    let started = Date.now();
    const model = await wm.learn(app, media, null);
    if (wm.isNone(model)) throw new Error("no mark found in that footage");
    const learned = JSON.parse(model.json) as { gamma: number; white: number; strength: number; at: number[] };
    console.log(`learned in ${((Date.now() - started) / 1000).toFixed(1)} s: gamma ${learned.gamma} white ${learned.white.toFixed(3)} strength ${learned.strength.toFixed(3)} at ${learned.at}`);
    started = Date.now();
    await wm.ensure(app, project.id);
    await wm.settled();
    console.log(`cleaned in ${((Date.now() - started) / 1000).toFixed(1)} s: ${JSON.stringify(wm.piecesOf(project.id))}`);
    const strips = store.get(project.id)!.project.media.filter((one) => one.cleans?.what === "watermark");
    expect(strips.length).toBeGreaterThan(0);
    const out = process.env.EDIT_WATERMARK_OUT;
    if (out !== undefined) {
      fs.mkdirSync(out, { recursive: true });
      for (const strip of strips) fs.copyFileSync(strip.path, join(out, `strip-${strip.cleans!.from}.mp4`));
      fs.writeFileSync(join(out, "strips.json"), JSON.stringify(strips.map((strip) => strip.cleans)));
    }
  } finally {
    useNative(previous);
    cleanup();
  }
}, 1_800_000);

test("a cell RunPod refused a machine for isn't waited for or sent again at once; half an hour on it is, and done once RunPod rents", async () => {
  const { app, dir, store, cleanup } = fixtureHome("watermark-refused");
  const calls: WatermarkPiece[] = [];
  const engine = standIn(calls);
  const words = `RunPod wouldn't rent a CPU machine for 10 minutes (402: {"detail":"Your account balance is too low to rent a pod."})`;
  let refusing = true;
  // As the relay fails a job it couldn't rent a machine for (remover_cloud.ts `call`): its words, flagged.
  wm.useEngine({ ...engine, remove: async (piece, ...rest) => (refusing ? (calls.push(piece), Promise.reject(new removerCloud.RelaySaid(words, true))) : engine.remove(piece, ...rest)) });
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const marked = join(dir, "marked.mp4");
    fs.writeFileSync(marked, "a stand-in tape with a mark");
    const id = await project(app, [marked], 40);
    await wm.ensure(app, id);
    await wm.settled();
    expect(wm.piecesOf(id).map((piece) => [piece.from, piece.state, piece.refused, piece.tries])).toEqual([[0, "failed", words, 0], [30, "failed", words, 0]]);
    // Not waited for: an export goes on without them, and says so (Nov 25, Boyfriends: up to three hours on two machines).
    expect(removalSchedule.progressOf(id).out).toBe(0);
    expect(removalSchedule.exportNote(id)).toBe(`Going without 2 pieces of their text and watermarks taken out, left as they are: RunPod won't rent the machines (${words}). They're tried again within half an hour; once RunPod rents machines again (top up its account) and they're done, export again.`);
    await removalSchedule.waitForPieces(app, id, 200);
    // Not sent again at once (each try is refused only after ten minutes at the relay).
    clock.mockReturnValue(now + removerCloud.REFUSED_RETRY_MS - 1000);
    await wm.ensure(app, id);
    await wm.settled();
    expect(calls.length).toBe(2);
    // Half an hour on, with the account topped up: sent again, done, and nothing more to say.
    refusing = false;
    clock.mockReturnValue(now + removerCloud.REFUSED_RETRY_MS + 1000);
    await wm.ensure(app, id);
    await wm.settled();
    expect(calls.length).toBe(4);
    expect(wm.piecesOf(id).map((piece) => [piece.from, piece.state])).toEqual([[0, "done"], [30, "done"]]);
    expect(removalSchedule.exportNote(id)).toBeNull();
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(2);
  } finally {
    clock.mockRestore();
    cleanup();
  }
}, 60_000);
