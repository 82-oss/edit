// removal_modes.ts: how each stretch of an edit has their text taken out
// (Sphe and JJ, Nov 18): Smart Pro on the intro, Smart on the first two
// cases, a tracked blur from the third on; footage shown in two sections gets
// the better; a single-case video is its intro and one case; an exception is
// one start_removal; only what the agent marks goes; and a channel taught
// nothing keeps what it had (nothing by itself, Smart Pro on what's asked).

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import { dispatch } from "../src/mcp/index.ts";
import type { Project } from "../src/model.ts";
import { findAddon, native, useNative, wrap, type Native } from "../src/native/index.ts";
import * as asks from "../src/removal_asks.ts";
import * as removal from "../src/removal_lesson.ts";
import * as modes from "../src/removal_modes.ts";
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
  tr.useProvider(undefined);
  tr.reset();
  asks.reset();
  removalSchedule.reset();
  blur.reset();
  tr.useShelf(null);
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

const shownIn = (p: Project) => (from: number, to: number) => tr.shownBetween(p, from, to);
const plain = (by: modes.ByMode) => Object.fromEntries([...by].filter(([, one]) => one.pro.length + one.smart.length + one.blur.length > 0).sort(([a], [b]) => a.localeCompare(b)));

test.skipIf(real === null)("by section: Smart Pro on the intro, Smart on cases 1 and 2, the tracked blur from case 3 on; footage in the intro and a case gets Smart Pro there", async () => {
  const { app, store, cleanup } = fixtureHome("modes-sections");
  teach();
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    await store.replace(p.id, null, p, "test");
    const saved = store.get(p.id)!.project;
    expect(modes.parts(saved).map(({ name, case: number, start, end, mode }) => [name, number, start / 30, end / 30, mode])).toEqual([
      ["the intro", null, 0, 15, "pro"],
      ["case 1", 1, 15, 85, "smart"],
      ["case 2", 2, 85, 150, "smart"],
      ["case 3", 3, 150, 200, "blur"],
      ["case 4", 4, 200, 260, "blur"],
    ]);
    // Each file's seconds: a's and b's teasers Smart Pro (shown in the intro), the rest of their cases Smart; c blurred;
    // d's teaser Smart Pro though the rest of its case (the fourth) is blurred.
    expect(plain(modes.byMode(saved, app.store.home, shownIn(saved)))).toEqual({
      a: { pro: [[30, 35]], smart: [[0, 30], [35, 60]], blur: [] },
      b: { pro: [[100, 105]], smart: [[0, 60]], blur: [] },
      c: { pro: [], smart: [], blur: [[0, 50]] },
      d: { pro: [[10, 15]], smart: [], blur: [[0, 10], [15, 60]] },
    });
    expect(modes.stretchOf(saved, 3)).toEqual([150, 200]);
    expect(modes.stretchOf(saved, "intro")).toEqual([0, 15]);
    expect(modes.stretchOf(saved, 5)).toBeNull();
    // A case's footage named by its notes ("Case N:", a compilation's pasted sources) is one case across files.
    const noted = structuredClone(saved);
    for (const block of noted.script!.blocks) if (block.kind === "footage") block.notes = [`Case ${block.media === "d" ? 3 : block.media === "c" ? 3 : 1}: https://drive.google.com/file/d/x/view`];
    expect(modes.parts(noted).map((part) => [part.name, part.start / 30])).toEqual([["the intro", 0], ["case 1", 15], ["case 2", 150]]);

    // One case (the channel's or the project's say): its intro, then the case, all of it Smart.
    const single = { ...saved, compilation: false };
    expect(modes.parts(single).map(({ name, start, end, mode }) => [name, start / 30, end / 30, mode])).toEqual([
      ["the intro", 0, 15, "pro"],
      ["the case", 15, 260, "smart"],
    ]);
    expect(plain(modes.byMode(single, app.store.home, shownIn(single)))).toEqual({
      a: { pro: [[30, 35]], smart: [[0, 30], [35, 60]], blur: [] },
      b: { pro: [[100, 105]], smart: [[0, 60]], blur: [] },
      c: { pro: [], smart: [[0, 50]], blur: [] },
      d: { pro: [[10, 15]], smart: [[0, 10], [15, 60]], blur: [] },
    });
    // No script to tell an intro by: the whole video is its case.
    const bare: Project = { ...single, script: undefined };
    expect(modes.parts(bare).map(({ name, start, end, mode }) => [name, start, end / 30, mode])).toEqual([["the case", 0, 260, "smart"]]);
  } finally {
    cleanup();
  }
});

test.skipIf(real === null)("an exception is one start_removal: Smart on case 3 too, Smart Pro on case 1, just a blur on case 2; said in the agent's context and the line", async () => {
  const { app, store, cleanup } = fixtureHome("modes-asks");
  teach();
  tr.useProvider(null);
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    await store.replace(p.id, null, p, "test");
    const call = async (args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: p.id, ...args } } }, null)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
    const before = modes.outline(store.get(p.id)!.project, app.store.home).split;
    expect(before).toContain("Smart Pro on the intro (0:00–0:15); Smart on case 1 (0:15–1:25) and case 2 (1:25–2:30); a tracked blur from case 3 on (2:30–)");
    expect(before).toContain('{case: 3, mode: "smart"}');
    const three = await call({ case: 3, mode: "smart" });
    expect(three.isError).toBe(false);
    expect(three.content[0]!.text).toContain("their subtitles out of case 3 in Vmake's Smart");
    const one = await call({ case: 1, mode: "smart_pro" });
    expect(one.isError).toBe(false);
    expect((await call({ case: 9, mode: "smart" })).content[0]!.text).toContain("this edit has no case 9: it has 4");
    expect((await call({ case: 2, mode: "best" })).content[0]!.text).toContain('mode is "smart", "smart_pro" or "blur"');
    const saved = store.get(p.id)!.project;
    // c Smart now; a Smart Pro wholly (its case and its teaser); b and d as their sections say.
    expect(plain(modes.byMode(saved, app.store.home, shownIn(saved)))).toEqual({
      a: { pro: [[0, 60]], smart: [], blur: [] },
      b: { pro: [[100, 105]], smart: [[0, 60]], blur: [] },
      c: { pro: [], smart: [[0, 50]], blur: [] },
      d: { pro: [[10, 15]], smart: [], blur: [[0, 10], [15, 60]] },
    });
    expect(modes.outline(saved, app.store.home).split).toContain("Asked here: Smart on case 3; Smart Pro on case 1.");
    // The editor's line names the split of what's sent, by the mode most of each section's footage has.
    const sent = modes.byMode(saved, app.store.home, shownIn(saved));
    expect(modes.describe(saved, sent, sent, shownIn(saved))).toBe("Smart Pro on the intro and case 1, Smart on cases 2 and 3, a tracked blur on case 4");
    // An ask with no mode (the whole video, a file) says what goes, never how: the sections' stay.
    asks.add(app.store.home, p.id, { at: Date.now(), kinds: ["subtitles"], media: "all" });
    asks.add(app.store.home, p.id, { at: Date.now(), kinds: ["subtitles"], media: { d: "all" } });
    expect(modes.byMode(saved, app.store.home, shownIn(saved)).get("d")).toEqual({ pro: [[10, 15]], smart: [], blur: [[0, 10], [15, 60]] });
    // "Just blur case 2": b's case blurred, its teaser still the intro's Smart Pro.
    expect((await call({ case: 2, mode: "blur" })).content[0]!.text).toContain("out of case 2 with a tracked blur");
    expect(modes.byMode(saved, app.store.home, shownIn(saved)).get("b")).toEqual({ pro: [[100, 105]], smart: [], blur: [[0, 60]] });
  } finally {
    cleanup();
  }
});

test.skipIf(real === null)("a channel taught nothing still does nothing by itself, and what's asked there stays Smart Pro", async () => {
  const { app, store, cleanup } = fixtureHome("modes-untaught");
  const log: string[] = [];
  tr.useProvider({ id: "vmake-web", price: () => "", remove: async () => (log.push("remove"), { credits: null }), check: async () => {} });
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    await store.replace(p.id, null, p, "test");
    const saved = store.get(p.id)!.project;
    await removalSchedule.ensure(app, p.id);
    await tr.settled(p.id);
    expect(await tr.plan(app, saved)).toEqual({ files: [], reading: [] });
    expect(log).toEqual([]);
    expect(await removalSchedule.statusOf(app, p.id)).toEqual({ line: null, action: null, running: null });
    // What's asked there: Smart Pro on whatever the timeline shows, as before Nov 18 (the sections are a taught channel's).
    const by = modes.byMode(saved, app.store.home, shownIn(saved));
    expect(by.get("c")).toEqual({ pro: [[0, 50]], smart: [], blur: [] });
    expect(by.get("d")).toEqual({ pro: [[0, 60]], smart: [], blur: [] });
    // Marks are a taught channel's: here they're refused in words, and nothing is kept.
    const marked = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: p.id, marks: [{ from: 1, to: 3 }] } } }, null)) as { result: { content: { text?: string }[]; isError: boolean } };
    expect(marked.result.isError).toBe(true);
    expect(marked.result.content[0]!.text).toContain("this channel isn't taught to take their text out");
    expect(asks.marked(app.store.home, p.id).size).toBe(0);
  } finally {
    cleanup();
  }
});

test.skipIf(real === null)("only the agent's marks go: nothing before it marks; then each marked stretch as its section says (case 1 to Smart, the intro's teaser to Smart Pro, case 3 to the tracked blur), unmarked seconds never; an unmark takes them back", async () => {
  const { app, store, cleanup } = fixtureHome("modes-marks");
  teach();
  tr.useProvider(null);
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    // Real files, so each has its identity (sha256) as the shelf keys it.
    for (const one of p.media) {
      one.path = `${app.store.home}/${one.id}.mp4`;
      fs.writeFileSync(one.path, `footage ${one.id}`);
    }
    await store.replace(p.id, null, p, "test");
    tr.useShelf(tr.shelfIn(`${app.store.home}/shelf`, () => false));
    const saved = () => store.get(p.id)!.project;
    // Taught: nothing goes until marked, however much the timeline shows.
    expect(tr.marksOnly(saved())).toBe(true);
    expect((await tr.plan(app, saved())).files).toEqual([]);
    expect(await tr.blurPlan(app, saved())).toEqual([]);
    const call = async (args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: p.id, ...args } } }, null)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
    // The tracked blur's reads stand in (no words: nothing laid; this is about what goes where).
    blur.reader.read = async (_input, _size, _fps, _region, times) => times.map(() => []);
    // In and out points: a's case 1 at 21–24 s (its 1–4 s), the intro's b teaser at 2–3 s (b 102–103 s), c's case 3 at 152–155 s (c 2–5 s) and 170–171 s (c 20–21 s).
    const marked = await call({ marks: [{ from: 21, to: 24 }, { from: 2, to: 3 }, { from: 152, to: 155 }, { from: 170, to: 171 }] });
    expect(marked.isError).toBe(false);
    expect(marked.content[0]!.text).toContain("Marked 4 stretches (8.0 s)");
    const near = (spans: [number, number][]) => spans.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
    expect([...asks.marked(app.store.home, p.id)].map(([id, spans]) => [id, near(spans)]).sort()).toEqual([
      ["a", [[1, 4]]],
      ["b", [[102, 103]]],
      ["c", [[2, 5], [20, 21]]],
    ]);
    const { files } = await tr.plan(app, saved());
    const sends = Object.fromEntries(files.map((file) => [`${file.media.id}:${file.mode}`, near(file.send)]));
    // Each marked stretch with a second's handle; nothing else of the file (a's 0–60 s case, b's 0–60 s) goes.
    expect(sends).toEqual({ "a:smart": [[0, 5]], "b:pro": [[101, 104]] });
    // Case 3's marks are the tracked blur's, never Vmake's.
    expect((await tr.blurPlan(app, saved())).map((one) => [one.media.id, near(one.spans), one.subtitles])).toEqual([["c", [[2, 5], [20, 21]], true]]);
    // Proposed and marked, as get_edit_context lists them for the agent.
    const listed = modes.outline(saved(), app.store.home, tr.proposed(app, saved()));
    expect(listed.marks).toContain("start_removal {marks: [{from: 12.4, to: 15.0}");
    expect(listed.marked).toContain("0:21.0–0:24.0 tape a");
    // "Smart on case 3 too": one call, and its marks go to Smart instead of the blur.
    await call({ case: 3, mode: "smart" });
    expect(Object.fromEntries((await tr.plan(app, saved())).files.map((file) => [`${file.media.id}:${file.mode}`, near(file.send)]))["c:smart"]).toEqual([[1, 6], [19, 22]]);
    expect(await tr.blurPlan(app, saved())).toEqual([]);
    // An unmark takes its seconds back out.
    expect((await call({ unmark: [{ from: 21, to: 24 }] })).content[0]!.text).toContain("Unmarked 1 stretch (3.0 s)");
    expect((await tr.plan(app, saved())).files.some((file) => file.media.id === "a")).toBe(false);
    expect((await call({ marks: [{ from: 5, to: 3 }] })).content[0]!.text).toContain("each is {from, to} with to after from");
  } finally {
    await blur.settled();
    cleanup();
  }
});
