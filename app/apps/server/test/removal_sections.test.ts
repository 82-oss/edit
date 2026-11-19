// removal_sections.ts: an edit's intro and cases (for an ask by place), a
// single-case video its intro and one case; their text under the tracked blur
// in every section, only where the agent marked it; and a channel taught
// nothing doing nothing by itself.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import { fillsFrame } from "../src/frames_fill.ts";
import { dispatch } from "../src/mcp/index.ts";
import type { Project } from "../src/model.ts";
import { findAddon, native, useNative, wrap, type Native } from "../src/native/index.ts";
import { REUSE_LABEL, subtitledSpans } from "../src/project.ts";
import * as asks from "../src/removal_asks.ts";
import * as removal from "../src/removal_lesson.ts";
import * as sections from "../src/removal_sections.ts";
import * as removalSchedule from "../src/removal_schedule.ts";
import * as blur from "../src/text_blur.ts";
import * as tr from "../src/text_removal.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome as stubbedHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

/** The engine's own sections (edit_core::sections finds the intro), on the fixture's stub: these run when the addon is built. */
const addon = findAddon();
const real = addon === null ? null : wrap(require(addon) as Native);
function fixtureHome(name: string): ReturnType<typeof stubbedHome> {
  const made = stubbedHome(name);
  useNative({ ...native(), sections: (input) => real!.sections(input) });
  return made;
}

afterEach(() => {
  asks.reset();
  removalSchedule.reset();
  blur.reset();
  v2cloud.useSkillsForTests([]);
});

/** Their subtitles taught out, for the projects of channel ch-taught. */
function teach(): void {
  const lesson = removal.changed(null, { subtitles: true, watermarks: true }, []);
  v2cloud.useSkillsForTests([{ name: removal.SKILL, key: v2cloud.ownKey("skill", "ch-taught--edit", removal.SKILL), text: removal.write(lesson) }]);
}

/**
 * A compilation of four cases (tapes a–d) as a Writer script lays it out:
 * teasers of b, a and d (0–15 s), the "On <date>" cut-in that ends the intro,
 * case 1 (a) from 15 s, case 2 (b) from 85 s, case 3 (c) from 150 s, case 4
 * (d) from 200 s to 260 s. The teasers show a 30–35 s, b 100–105 s, d 10–15 s.
 */
function compilation(into: Project): Project {
  const p = structuredClone(into);
  p.channel = "ch-taught";
  p.compilation = true;
  for (const id of ["a", "b", "c", "d"]) p.media.push(media({ id, name: `tape ${id}`, path: `/tmp/${id}.mp4`, kind: "video", duration: 600, width: 1920, height: 1080, fps: 30 }));
  const s = 30;
  const v = (id: string, m: string, at: number, len: number, from: number) => clip({ id, track: "v1", start: at * s, duration: len * s, type: "video", media: m, source_in: from });
  const card = (id: string, at: number, len: number, text: string) => clip({ id, track: "v3", start: at * s, duration: len * s, type: "text", text });
  p.clips = [v("t1", "b", 0, 5, 100), v("t2", "a", 5, 5, 30), v("t3", "d", 10, 5, 10), card("n1", 15, 5, "On May 29, 2024, officers"), v("c1", "a", 20, 60, 0), card("n2", 80, 5, "In March 2021, a man"), v("c2", "b", 85, 60, 0), card("n3", 145, 5, "On June 2, 2023"), v("c3", "c", 150, 50, 0), v("c4", "d", 200, 60, 0)];
  const footage = (m: string, c: string, a: number, b: number) => ({ kind: "footage" as const, url: "", file: `file-${m}`, start: a, end: b, label: "", media: m, clip: c });
  const said = (text: string, c: string) => ({ kind: "narration" as const, text, clip: c });
  p.script = {
    source: "writer:x",
    blocks: [footage("b", "t1", 100, 105), footage("a", "t2", 30, 35), footage("d", "t3", 10, 15), said("On May 29, 2024, officers", "n1"), footage("a", "c1", 0, 60), said("In March 2021, a man", "n2"), footage("b", "c2", 0, 60), said("On June 2, 2023", "n3"), footage("c", "c3", 0, 50), footage("d", "c4", 0, 60)],
  } as Project["script"];
  return p;
}


const call = async (app: Parameters<typeof dispatch>[0], id: string, args: Record<string, unknown>) =>
  ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: id, ...args } } }, null)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
const near = (spans: [number, number][]) => spans.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);

test.skipIf(real === null)("the intro and each case, back to back: by their notes, one case for a video of one, the whole video's case with no script", async () => {
  const { store, cleanup } = fixtureHome("sections-parts");
  teach();
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    await store.replace(p.id, null, p, "test");
    const saved = store.get(p.id)!.project;
    expect(sections.parts(saved).map(({ name, case: number, start, end }) => [name, number, start / 30, end / 30])).toEqual([
      ["the intro", null, 0, 15],
      ["case 1", 1, 15, 85],
      ["case 2", 2, 85, 150],
      ["case 3", 3, 150, 200],
      ["case 4", 4, 200, 260],
    ]);
    expect(sections.stretchOf(saved, 3)).toEqual([150, 200]);
    expect(sections.stretchOf(saved, "intro")).toEqual([0, 15]);
    expect(sections.stretchOf(saved, 5)).toBeNull();
    // A case's footage named by its notes ("Case N:", a compilation's pasted sources) is one case across files.
    const noted = structuredClone(saved);
    for (const block of noted.script!.blocks) if (block.kind === "footage") block.notes = [`Case ${block.media === "d" ? 3 : block.media === "c" ? 3 : 1}: https://drive.google.com/file/d/x/view`];
    expect(sections.parts(noted).map((part) => [part.name, part.start / 30])).toEqual([["the intro", 0], ["case 1", 15], ["case 2", 150]]);
    // One case (the channel's or the project's say): its intro, then the case.
    const single = { ...saved, compilation: false };
    expect(sections.parts(single).map(({ name, start, end }) => [name, start / 30, end / 30])).toEqual([
      ["the intro", 0, 15],
      ["the case", 15, 260],
    ]);
    // No script to tell an intro by: the whole video is its case.
    const bare: Project = { ...single, script: undefined };
    expect(sections.parts(bare).map(({ name, start, end }) => [name, start, end / 30])).toEqual([["the case", 0, 260]]);
    // What the agent reads: one way for their text, every section; the sections for an ask by place; how to mark.
    const outline = sections.outline(saved);
    expect(outline.how).toBe("Their subtitles and text get a tight blur tracked over their words, in every section, only where you mark them; their watermarks come out of the whole video here, free.");
    expect(outline.sections).toContain("the intro (0:00–0:15), case 1 (0:15–1:25), case 2 (1:25–2:30), case 3 (2:30–3:20), case 4 (3:20–4:20)");
    expect(outline.marks).toContain("start_removal {marks: [{from: 12.4, to: 15.0}");
  } finally {
    cleanup();
  }
});

test.skipIf(real === null)("a channel taught nothing does nothing by itself, and marks are refused there in words", async () => {
  const { app, store, cleanup } = fixtureHome("sections-untaught");
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    await store.replace(p.id, null, p, "test");
    await removalSchedule.ensure(app, p.id);
    expect(await tr.blurPlan(app, store.get(p.id)!.project)).toEqual([]);
    expect(removalSchedule.statusOf(app, p.id)).toEqual({ background: null });
    const marked = await call(app, p.id, { marks: [{ from: 1, to: 3 }] });
    expect(marked.isError).toBe(true);
    expect(marked.content[0]!.text).toContain("this channel isn't taught to take their text out");
    expect(asks.marked(app.store.home, p.id).size).toBe(0);
  } finally {
    cleanup();
  }
});

test.skipIf(real === null)("only the agent's marks are blurred, in every section (the intro's teaser, case 1, case 3 alike), unmarked seconds never; an unmark takes them back", async () => {
  const { app, store, cleanup } = fixtureHome("sections-marks");
  teach();
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    // Real files, so each has its identity (sha256) as the blur's tracks key it.
    for (const one of p.media) {
      one.path = `${app.store.home}/${one.id}.mp4`;
      fs.writeFileSync(one.path, `footage ${one.id}`);
    }
    await store.replace(p.id, null, p, "test");
    const saved = () => store.get(p.id)!.project;
    // Taught: nothing goes until marked, however much the timeline shows.
    expect(tr.marksOnly(saved())).toBe(true);
    expect(await tr.blurPlan(app, saved())).toEqual([]);
    // The tracked blur's reads stand in (no words: nothing laid; this is about what goes where).
    blur.reader.read = async (_input, _size, _fps, _region, times) => times.map(() => []);
    // In and out points: a's case 1 at 21–24 s (its 1–4 s), the intro's b teaser at 2–3 s (b 102–103 s), c's case 3 at 152–155 s (c 2–5 s) and 170–171 s (c 20–21 s).
    const marked = await call(app, p.id, { marks: [{ from: 21, to: 24 }, { from: 2, to: 3 }, { from: 152, to: 155 }, { from: 170, to: 171 }] });
    expect(marked.isError).toBe(false);
    expect(marked.content[0]!.text).toContain("Marked 4 stretches (8.0 s)");
    expect(marked.content[0]!.text).toContain("Only marked stretches get the tracked blur, tight to their words, in every section");
    expect([...asks.marked(app.store.home, p.id)].map(([id, spans]) => [id, near(spans)]).sort()).toEqual([
      ["a", [[1, 4]]],
      ["b", [[102, 103]]],
      ["c", [[2, 5], [20, 21]]],
    ]);
    // Every marked stretch blurred, whatever its section; nothing else of the file (a's 0–60 s case, b's 0–60 s).
    const plan = async () => (await tr.blurPlan(app, saved())).map((one) => [one.media.id, near(one.spans), one.subtitles]).sort();
    expect(await plan()).toEqual([
      ["a", [[1, 4]], true],
      ["b", [[102, 103]], true],
      ["c", [[2, 5], [20, 21]], true],
    ]);
    // Proposed and marked, as get_edit_context lists them for the agent.
    const listed = sections.outline(saved(), tr.proposed(app, saved()));
    expect(listed.marked).toContain("0:21.0–0:24.0 tape a");
    // An unmark takes its seconds back out.
    expect((await call(app, p.id, { unmark: [{ from: 21, to: 24 }] })).content[0]!.text).toContain("Unmarked 1 stretch (3.0 s)");
    expect((await plan()).some(([id]) => id === "a")).toBe(false);
    expect((await call(app, p.id, { marks: [{ from: 5, to: 3 }] })).content[0]!.text).toContain("each is {from, to} with to after from");
  } finally {
    await blur.settled();
    cleanup();
  }
});

test.skipIf(real === null)("the agent's marks go under our own see-through subtitles and on a finished video reused whole, after the person's Stop too, never waiting on detection; our subtitles then go where theirs came out (Nov 19, Sphe's Cuffed & Caught edit: 138 marks, nothing done for cases 2, 5 and 6)", async () => {
  const { app, store, cleanup } = fixtureHome("sections-marks-under");
  teach();
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    for (const one of p.media) {
      one.path = `${app.store.home}/${one.id}.mp4`;
      fs.writeFileSync(one.path, `footage ${one.id}`);
    }
    // Our subtitles: an effect's picture over its alpha, the whole edit long, filling the frame but see-through.
    p.media.push(media({ id: "subs", name: "subs-01", path: `${app.store.home}/subs.mp4`, kind: "video", duration: 260, width: 1920, height: 1080, fps: 30, effect: "subs-01", effect_key: "k", stacked_alpha: true }));
    p.tracks.push({ id: "v9", kind: "video", hidden: false, muted: false, locked: false });
    p.clips.push(clip({ id: "s1", track: "v9", start: 0, duration: 260 * 30, type: "video", media: "subs", source_in: 0 }));
    // Case 4 (tape d) is a finished video reused whole: its subtitles burned in.
    for (const block of p.script!.blocks) if (block.kind === "footage" && block.media === "d") block.label = REUSE_LABEL;
    await store.replace(p.id, null, p, "test");
    const saved = () => store.get(p.id)!.project;
    expect(fillsFrame(saved(), saved().clips.find((one) => one.id === "s1")!)).toBe(false);
    // Left alone by itself: a reused video of ours isn't footage to clean until it's pointed at.
    expect(tr.shownSeconds(saved()).has("d")).toBe(false);
    blur.reader.read = async (_input, _size, _fps, _region, times) => times.map(() => []);
    // The person stopped it; then the agent marks a's case 1 at 21–24 s (a 1–4 s) and the reused d's case 4 at 230–233 s (d 30–33 s), nothing read by detection.
    removalSchedule.stop(app, p.id);
    await Bun.sleep(5);
    const marked = await call(app, p.id, { marks: [{ from: 21, to: 24 }, { from: 230, to: 233 }, { from: 300, to: 301 }] });
    expect(marked.isError).toBe(false);
    expect(marked.content[0]!.text).toContain("on 2 files: a 3.0 s, d 3.0 s (no footage at 300–301)");
    expect((await tr.blurPlan(app, saved())).map((one) => [one.media.id, near(one.spans)]).sort()).toEqual([
      ["a", [[1, 4]]],
      ["d", [[30, 33]]],
    ]);
    // What ran by itself stays stopped: unmarked seconds of a never go.
    expect(asks.isStopped(app.store.home, p.id)).toBe(true);
    // Where the blur took theirs out of the reused d, ours go; the rest of d keeps its own burned in.
    const fps = 30;
    const withBlur = structuredClone(saved());
    withBlur.clips.push(clip({ id: "tb", track: "v9", start: 230 * fps, duration: 3 * fps, type: "adjustment", name: "Text blur · c4" }));
    expect(subtitledSpans(withBlur, 200 * fps, 260 * fps)).toEqual([[230 * fps, 233 * fps]]);
    expect(subtitledSpans(saved(), 200 * fps, 260 * fps)).toEqual([]);
    // Each blur's track is kept as a file, a folder an earlier build left in its place taken away (Nov 19: EISDIR, every blur piece failed).
    await removalSchedule.ensure(app, p.id);
    await blur.settled();
    expect(blur.piecesOf(p.id).map((one) => [one.media, one.state, one.why ?? ""]).sort()).toEqual([
      ["a", "done", ""],
      ["d", "done", ""],
    ]);
    const kept = `${app.store.home}/cache/cleaned/tracks`;
    const files = fs.readdirSync(kept, { recursive: true, withFileTypes: true }).filter((one) => one.name.endsWith(".json"));
    expect(files.length).toBe(2);
    expect(files.every((one) => one.isFile())).toBe(true);
  } finally {
    await blur.settled();
    cleanup();
  }
});
