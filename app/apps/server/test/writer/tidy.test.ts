import { expect, test } from "bun:test";

import type { Clip, Script, Word } from "@edit/types/writer";

import { lineCount, pageCount, textWidth } from "../../src/writer/pages.ts";
import { editNote, editLines, noteAnchor } from "../../src/writer/blocks.ts";
import { keepNotes } from "../../src/writer/exact.ts";
import { beatForFloor, boundaryIssues, joinLate, joinSlivers, PAUSE_BEAT_MS, polish, removeRange, tighten } from "../../src/writer/tidy.ts";

const clip = (id: string, startMs: number, endMs: number): Clip => ({ id, startMs, endMs });

const words = (said: [string, string, number, number][]): Word[] =>
  said.map(([text, speaker, startMs, endMs], i) => ({ id: `w${i}`, text, startMs, endMs, speaker }));

test("a sliver left by a cut pause joins its neighbour", () => {
  const card: Clip = { ...clip("", 0, 3_000), kind: "cut-in" };
  const joined = joinSlivers([clip("", 856_400, 856_900), clip("", 857_800, 860_500), card, clip("", 900_000, 900_800), clip("", 950_000, 955_000)], [], { words: [], corrections: {} });
  expect(joined.map((one) => [one.startMs, one.endMs])).toEqual([
    [856_400, 860_500],
    [0, 3_000],
    [900_000, 900_800],
    [950_000, 955_000],
  ]);
});

test("fixes an edge that runs on into fillers", () => {
  const said = words([["No.", "a", 0, 400], ["Yeah,", "a", 500, 800], ["so", "a", 900, 1_100], ["Next.", "b", 3_000, 3_400]]);
  const issues = boundaryIssues([clip("c", 0, 1_200)], said);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.end).toBe(true);
  expect(issues[0]!.issue).toContain("runs on past");
  const [fixed, count] = polish([clip("c", 0, 1_200)], said, {}, 10_000);
  expect(count).toBe(1);
  // Back to "No." with room that stops short of "Yeah,".
  expect([fixed[0]!.startMs, fixed[0]!.endMs]).toEqual([0, 440]);
});

test("fixes that cross leave a short clip as it was", () => {
  const said = words([["Okay.", "a", 0, 300], ["John,", "a", 400, 700], ["so", "a", 800, 1_000], ["Next.", "b", 3_000, 3_300]]);
  const [fixed] = polish([clip("c", 0, 1_100)], said, {}, 10_000);
  expect(fixed[0]!.endMs).toBeGreaterThan(fixed[0]!.startMs);
});

test("finishes a sentence cut short", () => {
  const said = words([["Do", "a", 0, 200], ["you", "a", 250, 400], ["feel", "a", 450, 600], ["remorse?", "a", 650, 1_000], ["No.", "b", 2_000, 2_300]]);
  const [fixed, count] = polish([clip("c", 0, 520)], said, {}, 10_000);
  expect(count).toBe(1);
  expect(fixed[0]!.endMs).toBe(1_400);
});

test("tightens only quiet gaps", () => {
  const said = words([["Hi.", "a", 0, 500], ["There.", "a", 5_500, 6_000], ["Again.", "a", 11_000, 11_500]]);
  // Loud sound in the second gap (untranscribed speech), silence in the first.
  const peaks = new Array<number>(600).fill(0.5);
  for (let i = 30; i < 270; i++) peaks[i] = 0;
  const done = tighten({ words: said, corrections: {}, peaks, parts: [], durationMs: 12_000, compilation: false, relaxed: false }, [clip("c", 0, 12_000)], PAUSE_BEAT_MS, () => false);
  expect(done.pauses).toBe(1);
  expect(done.clips.reduce((sum, one) => sum + one.endMs - one.startMs, 0)).toBe(12_000 - 4_000);
});

test("finds the shortest beat that keeps the floor", () => {
  const beat = beatForFloor((value) => 9_000 + value, 1_000, 10_000, 50_000);
  expect(beat).not.toBeNull();
  expect(beat!).toBeGreaterThanOrEqual(1_000);
  expect(beat!).toBeLessThanOrEqual(1_100);
  expect(beatForFloor(() => 5_000, 1_000, 10_000, 50_000)).toBeNull();
});

test("measures Arial and wraps lines", () => {
  // As Repack's textWidth measures them, kerning included.
  expect(Math.abs(textWidth("Hello", 16, false) - 36.448)).toBeLessThan(0.001);
  expect(Math.abs(textWidth("INTERRO The Case", (19 * 96) / 72, true) - 233.674_666)).toBeLessThan(0.001);
  expect(lineCount("short", 16, false)).toBe(1);
  expect(lineCount("word ".repeat(200), 16, false)).toBe(13);
});

test("a long script runs onto more pages", () => {
  const script = { id: "a1", title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 10_000, words: [], clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null } as Script;
  const block = (n: number): Clip[] => [clip(`c${n}`, 0, 5_000), { ...clip(`n${n}`, 0, 3_000), kind: "cut-in", narration: "A sentence of narration. ".repeat(12) }];
  const short = [0, 1].flatMap(block);
  expect(pageCount(script, short)).toBe(1);
  expect(pageCount(script, Array.from({ length: 40 }, (_, n) => block(n)).flat())).toBeGreaterThan(5);
});

test("clips a courtroom's relaxed half joins keep their notes, on the same words", () => {
  const said = words([["Where", "s", 30_000, 30_500], ["were", "s", 30_600, 31_000], ["you?", "s", 31_100, 31_500], ["Um", "s", 32_500, 33_000], ["Home", "s", 34_000, 34_500], ["all", "s", 34_600, 35_000], ["night", "s", 35_100, 35_500]]);
  const corrections = { w4: "Home," };
  const note = { id: "n", text: "edit: zoom in", at: 0, anchor: { start: 6, end: 9, quote: "all" } };
  const clips: Clip[] = [clip("c0", 0, 20_000), { id: "i", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "Intro." }, clip("a", 30_000, 32_000), { ...clip("b", 34_000, 36_000), notes: [note] }];
  const joined = joinLate(clips, { words: said, corrections }, { s: "Officer" }, [], false);
  expect(joined.map((one) => one.id)).toEqual(["c0", "i", "a"]);
  const a = joined[2]!;
  expect(a.notes).toEqual([{ ...note, anchor: { start: 25, end: 28, quote: "all" } }]);
  const script = { words: said, corrections } as unknown as Script;
  expect(noteAnchor(script, a, "all", 25)).toEqual({ start: 25, end: 28, quote: "all" });
  expect(clips[3]!.notes![0]!.anchor!.start).toBe(6);
});

test("a split clip's notes go to the piece that says their words, the same occurrence", () => {
  const said = words([["Yes.", "s", 0, 500], ["Where", "s", 600, 1_000], ["were", "s", 1_100, 1_500], ["Yes.", "s", 5_000, 5_500], ["all", "s", 5_600, 6_000], ["night", "s", 6_100, 6_500], ["Home.", "s", 9_000, 9_500]]);
  const text = { words: said, corrections: {} };
  const second = { id: "n1", text: "edit: zoom in", at: 0, anchor: { start: 16, end: 20, quote: "Yes." } };
  const first = { id: "n2", text: "edit: a map", at: 0, anchor: { start: 0, end: 4, quote: "Yes." } };
  const loose = { id: "n3", text: "edit: black and white", at: 0 };
  const across = { id: "n4", text: "edit: slow down", at: 0, anchor: { start: 11, end: 20, quote: "were Yes." } };
  const pieces = removeRange([{ id: "c", startMs: 0, endMs: 7_000, notes: [second, first, loose, across] }, { id: "i", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "Then." }], 2_000, 4_500, text);
  expect(pieces.map((one) => one.id.length > 1 ? "new" : one.id)).toEqual(["c", "new", "i"]);
  expect(pieces[0]!.notes!.map((note) => note.id)).toEqual(["n2", "n3", "n4"]);
  expect(pieces[1]!.notes).toEqual([{ ...second, anchor: { start: 0, end: 4, quote: "Yes." } }]);
  const script = { words: said, corrections: {} } as unknown as Script;
  expect(noteAnchor(script, pieces[1]!, "Yes.", 0)).toEqual({ start: 0, end: 4, quote: "Yes." });
});

test("a note whose words are cut stays on its clip, never on a later one saying them too", () => {
  const said = words([["First.", "s", 0, 500], ["Home.", "s", 1_000, 1_500], ["Home.", "s", 9_000, 9_500]]);
  const note = { id: "n", text: "edit: zoom in", at: 0, anchor: { start: 7, end: 12, quote: "Home." } };
  const cut = removeRange([{ id: "a", startMs: 0, endMs: 2_000, notes: [note] }, { id: "b", startMs: 8_800, endMs: 9_800 }], 900, 2_000, { words: said, corrections: {} });
  expect(cut[0]!.notes).toEqual([note]);
  expect(cut[1]!.notes ?? []).toEqual([]);
});

test("every line of an editor's note is one the editor is shown", () => {
  expect(editNote("Show the house.")).toBe("edit: Show the house.");
  expect(editNote("Edit: Show the house.\nThen show the map.")).toBe("edit: Show the house.\nedit: Then show the map.");
  expect(editLines([editNote("Show the house.\n\nThen show the map.")])).toEqual(["edit: Show the house.", "edit: Then show the map."]);
});

test("a note's offsets follow its words when polishing moves an edge", () => {
  const said = words([["Okay,", "s", 0, 400], ["Home.", "s", 600, 1_000], ["All", "s", 6_000, 6_300], ["night.", "s", 6_400, 6_800]]);
  const note = { id: "n", text: "edit: zoom in", at: 0, anchor: { start: 6, end: 11, quote: "Home." } };
  const [polished] = polish([{ id: "c", startMs: 0, endMs: 7_000, notes: [note] }], said, {}, 10_000);
  const clipped = polished[0]!;
  const script = { words: said, corrections: {} } as unknown as Script;
  const at = noteAnchor(script, clipped, "Home.")!;
  expect(clipped.notes![0]!.anchor).toEqual({ ...note.anchor, start: at.start, end: at.end });
  // Split at the pause, it stays with "Home.".
  const pieces = removeRange(polished, 1_500, 5_500, { words: said, corrections: {} });
  expect(pieces[0]!.notes!.map((one) => one.anchor!.quote)).toEqual(["Home."]);
  expect(pieces[1]!.notes).toEqual([]);
});

test("a re-cut on the exact hearing puts each cut-in's notes back on it", () => {
  const note = { id: "n", text: "edit: a photo of Payton", at: 0, anchor: { start: 4, end: 10, quote: "Payton" } };
  const before: Clip[] = [clip("a", 0, 1_000), { id: "i", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "She Payton.", notes: [note] }];
  const after: Clip[] = [clip("b", 0, 1_000), { id: "j", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "She Payton." }];
  keepNotes([], before, [], after);
  expect(after[1]!.notes).toEqual([note]);
});

test("a note whose words a correction recased goes with them when the clip splits", () => {
  const said = words([["Start.", "s", 0, 500], ["Um", "s", 2_000, 2_300], ["Home.", "s", 4_000, 4_500]]);
  const note = { id: "n", text: "edit: zoom in", at: 0, anchor: { start: 10, end: 15, quote: "Home." } };
  const pieces = removeRange([{ id: "c", startMs: 0, endMs: 5_000, notes: [note] }], 1_900, 2_400, { words: said, corrections: { w2: "HOME." } });
  expect(pieces[0]!.notes).toEqual([]);
  expect(pieces[1]!.notes).toEqual([{ ...note, anchor: { start: 0, end: 5, quote: "HOME." } }]);
});
