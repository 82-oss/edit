// removal_modes.ts: which of Vmake's modes each stretch of an edit is cleaned
// in (Sphe and JJ, Nov 18): Smart Pro on the intro, Smart on the first two
// cases, nothing from the third on; footage shown in two sections gets the
// better mode; a single-case video is its intro and one case; an exception is
// one start_removal; and a channel taught nothing keeps what it had (nothing
// by itself, Smart Pro on what's asked).

import { afterEach, expect, test } from "bun:test";

import { dispatch } from "../src/mcp/index.ts";
import type { Project } from "../src/model.ts";
import { findAddon, native, useNative, wrap, type Native } from "../src/native/index.ts";
import * as asks from "../src/removal_asks.ts";
import * as removal from "../src/removal_lesson.ts";
import * as modes from "../src/removal_modes.ts";
import * as removalSchedule from "../src/removal_schedule.ts";
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
const plain = (by: modes.ByMode) => Object.fromEntries([...by].filter(([, one]) => one.pro.length + one.smart.length > 0).sort(([a], [b]) => a.localeCompare(b)));

test.skipIf(real === null)("by section: Smart Pro on the intro, Smart on cases 1 and 2, nothing from case 3 on; footage in the intro and a case gets Smart Pro there", async () => {
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
      ["case 3", 3, 150, 200, null],
      ["case 4", 4, 200, 260, null],
    ]);
    // Each file's seconds: a's and b's teasers Smart Pro (shown in the intro), the rest of their cases Smart; c nothing;
    // d's teaser Smart Pro though its case (the fourth) gets nothing.
    expect(plain(modes.byMode(saved, app.store.home, shownIn(saved)))).toEqual({
      a: { pro: [[30, 35]], smart: [[0, 30], [35, 60]] },
      b: { pro: [[100, 105]], smart: [[0, 60]] },
      d: { pro: [[10, 15]], smart: [] },
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
      a: { pro: [[30, 35]], smart: [[0, 30], [35, 60]] },
      b: { pro: [[100, 105]], smart: [[0, 60]] },
      c: { pro: [], smart: [[0, 50]] },
      d: { pro: [[10, 15]], smart: [[0, 10], [15, 60]] },
    });
    // No script to tell an intro by: the whole video is its case.
    const bare: Project = { ...single, script: undefined };
    expect(modes.parts(bare).map(({ name, start, end, mode }) => [name, start, end / 30, mode])).toEqual([["the case", 0, 260, "smart"]]);
  } finally {
    cleanup();
  }
});

test.skipIf(real === null)("an exception is one start_removal: Smart on case 3 too, Smart Pro on case 1; said in the agent's context and the line", async () => {
  const { app, store, cleanup } = fixtureHome("modes-asks");
  teach();
  tr.useProvider(null);
  try {
    const live = store.create("Compilation", { width: 1920, height: 1080, fps: 30 });
    const p = compilation(live.project);
    await store.replace(p.id, null, p, "test");
    const call = async (args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: p.id, ...args } } }, null)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
    const before = modes.outline(store.get(p.id)!.project, app.store.home);
    expect(before).toContain("Smart Pro on the intro (0:00–0:15); Smart on case 1 (0:15–1:25) and case 2 (1:25–2:30); nothing from case 3 on (2:30–)");
    expect(before).toContain('{case: 3, mode: "smart"}');
    const three = await call({ case: 3, mode: "smart" });
    expect(three.isError).toBe(false);
    expect(three.content[0]!.text).toContain("their subtitles out of case 3 in Vmake's Smart");
    const one = await call({ case: 1, mode: "smart_pro" });
    expect(one.isError).toBe(false);
    expect((await call({ case: 9, mode: "smart" })).content[0]!.text).toContain("this edit has no case 9: it has 4");
    expect((await call({ case: 2, mode: "best" })).content[0]!.text).toContain('mode is "smart" or "smart_pro"');
    const saved = store.get(p.id)!.project;
    // c Smart now; a Smart Pro wholly (its case and its teaser); b and d as their sections say.
    expect(plain(modes.byMode(saved, app.store.home, shownIn(saved)))).toEqual({
      a: { pro: [[0, 60]], smart: [] },
      b: { pro: [[100, 105]], smart: [[0, 60]] },
      c: { pro: [], smart: [[0, 50]] },
      d: { pro: [[10, 15]], smart: [] },
    });
    expect(modes.outline(saved, app.store.home)).toContain("Asked here: Smart on case 3; Smart Pro on case 1.");
    // The editor's line names the split of what's sent, by the mode most of each section's footage has.
    const sent = modes.byMode(saved, app.store.home, shownIn(saved));
    expect(modes.describe(saved, sent, sent, shownIn(saved))).toBe("Smart Pro on the intro and case 1, Smart on cases 2 and 3");
    // An ask with no mode on a stretch the defaults leave out gives it Smart (the person asked for it); the whole video's keeps the sections.
    asks.add(app.store.home, p.id, { at: Date.now(), kinds: ["subtitles"], media: "all" });
    expect(modes.byMode(saved, app.store.home, shownIn(saved)).get("d")!.smart).toEqual([]);
    asks.add(app.store.home, p.id, { at: Date.now(), kinds: ["subtitles"], media: { d: "all" } });
    expect(modes.byMode(saved, app.store.home, shownIn(saved)).get("d")).toEqual({ pro: [[10, 15]], smart: [[0, 10], [15, 60]] });
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
    expect(by.get("c")).toEqual({ pro: [[0, 50]], smart: [] });
    expect(by.get("d")).toEqual({ pro: [[0, 60]], smart: [] });
  } finally {
    cleanup();
  }
});
