import { expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import { formatOf } from "../../src/writer/formats.ts";
import { apply, current, editNote, seen, settle } from "../../src/writer/revise.ts";

function script(): Script {
  const said = ["Hi,", "I'm", "Detective", "Smith.", "Where", "were", "you?", "Home.", "All", "night."];
  return {
    id: "a1", title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 10_000, revision: 3, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null,
    words: said.map((text, index) => ({ id: `w${index}`, text, startMs: index * 1_000, endMs: index * 1_000 + 500, speaker: index < 7 ? "a" : "b" })),
    clips: [
      { id: "c1", startMs: 0, endMs: 3_900 },
      { id: "n1", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He said he was home." },
      { id: "c2", startMs: 3_850, endMs: 9_900 },
      { id: "n2", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "" },
    ],
  };
}

test("applies edits in order and names new items", () => {
  const [clips, , proposals] = apply(script(), [
    { op: "split", id: "i3", wordId: "w7" },
    { op: "insert_cut_in", afterId: "i3", narration: "Then he changed his story." },
    { op: "move", ids: ["n2"], beforeId: "i1" },
    { op: "trim", id: "n1", edge: "out", wordId: "w8" },
  ], [], false);
  expect(clips.map((clip) => (clip.kind === "cut-in" ? "cut" : "clip"))).toEqual(["cut", "clip", "cut", "clip", "clip", "cut"]);
  expect(clips[0]!.narration).toBe("Then he changed his story.");
  // The second half of the split, trimmed to end after "All".
  expect([clips[4]!.startMs, clips[4]!.endMs]).toEqual([7_000, 8_900]);
  expect(proposals).toEqual([]);
});

test("an edge goes at a time the producer gives, where nobody speaks, and a clip of silent footage goes in by its times", () => {
  // Sphe, Nov 12: "start it at 00:29 and go until 00:58" was refused: "a clip can only start just before a spoken word".
  const [clips] = apply(script(), [
    { op: "trim", id: "i3", edge: "in", at: "0:05.2" },
    { op: "trim", id: "i3", edge: "out", at: "0:09.8" },
    { op: "insert_words", from: "0:00.6", to: "0:00.9", afterId: "start" },
  ], [], false);
  expect([clips[3]!.startMs, clips[3]!.endMs]).toEqual([5_200, 9_800]);
  expect([clips[0]!.startMs, clips[0]!.endMs]).toEqual([600, 900]);
  expect(() => apply(script(), [{ op: "trim", id: "i1", edge: "in", at: "0:30" }], [], false)).toThrow(/past the end of the footage/);
  expect(() => apply(script(), [{ op: "trim", id: "i1", edge: "in", at: "soon" }], [], false)).toThrow(/isn't a footage time/);
});

test("a blank time beside a word is no time: the word stands", () => {
  const byWord = apply(script(), [{ op: "trim", id: "i3", edge: "in", wordId: "w7" }], [], false)[0];
  const blank = apply(script(), [{ op: "trim", id: "i3", edge: "in", wordId: "w7", at: " " }], [], false)[0];
  expect(byWord[2]!.startMs).toBeGreaterThan(3_850);
  expect([blank[2]!.startMs, blank[2]!.endMs]).toEqual([byWord[2]!.startMs, byWord[2]!.endMs]);
});

test("an out-point at a recording's very end stays in that recording", () => {
  const two = { ...script(), parts: [{ startMs: 0, durationMs: 6_000 }, { startMs: 6_000, durationMs: 6_000 }] } as ReturnType<typeof script>;
  const clip = two.clips.find((one) => one.narration === undefined && one.endMs <= 6_000 && one.endMs - one.startMs >= 400)!;
  const index = two.clips.indexOf(clip);
  const [clips] = apply(two, [{ op: "trim", id: `i${index + 1}`, edge: "out", at: "0:06" }], [], false);
  expect(clips[index]!.endMs).toBe(6_000);
  expect(() => apply(two, [{ op: "trim", id: `i${index + 1}`, edge: "out", at: "0:06.5" }], [], false)).toThrow(/another recording/);
});

test("a review fix writes saved narration straight in", () => {
  const [clips, , proposals] = apply(script(), [{ op: "write", id: "i2", narration: "He swore he was home." }], [], true);
  expect(clips[1]!.narration).toBe("He swore he was home.");
  expect(proposals).toEqual([]);
});

test("an edit note goes on the words it's about: a cut-in's narration or what a clip says (Nov 10, JJ: \"the note should stay on the text not on the clip\")", () => {
  const [clips] = apply(script(), [{ op: "note", id: "i1", text: "a blue waveform for this call" }], [], false);
  expect(clips[0]!.notes?.at(-1)?.text).toBe("edit: a blue waveform for this call");
  // On a cut-in, on its words.
  const [onText] = apply(script(), [{ op: "note", id: "i2", on: "he was home", text: "edit: the porch footage under this" }], [], false);
  expect(onText[1]!.notes?.at(-1)).toMatchObject({ text: "edit: the porch footage under this", anchor: { start: 8, end: 19, quote: "he was home" } });
  // On a footage clip, on what's said there.
  const [onFootage] = apply(script(), [{ op: "note", id: "i3", on: "where were you?", text: "edit: zoom in" }], [], false);
  expect(onFootage[2]!.notes?.at(-1)?.anchor?.quote).toBe("Where were you?");
  expect(() => apply(script(), [{ op: "note", id: "i2", on: "never said", text: "edit: zoom" }], [], false)).toThrow("isn't in that cut-in's narration");
  // Moved: taken off one item, put on another.
  const noted = script();
  noted.clips[0]!.notes = [{ id: "x", text: "edit: zoom", at: 0 }];
  expect(current(noted, formatOf("interrogation", false, "Case")).includes("note 1, the producer's comment for the editor")).toBe(true);
  const [moved] = apply(noted, [{ op: "remove_note", id: "i1", note: 1 }, { op: "note", id: "i2", on: "home", text: "edit: zoom" }], [], false);
  expect(moved[0]!.notes).toEqual([]);
  expect(moved[1]!.notes?.at(-1)?.anchor?.quote).toBe("home");
  expect(() => apply(noted, [{ op: "remove_note", id: "i1", note: 2 }], [], false)).toThrow("1 notes");
  expect(editNote("Edit:  zoom in slowly ")).toBe("edit: zoom in slowly");
});

test("a note on a cut-in rewritten in the same answer goes on its new words (Nov 25: the charges note on a rewritten outro was refused against the old one)", () => {
  const edits = [{ op: "write", id: "i2", narration: "He was charged with kidnapping and murder." }, { op: "note", id: "i2", on: "kidnapping and murder", text: "edit: charges on screen" }];
  const [direct] = apply(script(), edits, [], true);
  expect(direct[1]!.notes?.at(-1)?.anchor).toMatchObject({ start: 20, end: 41, quote: "kidnapping and murder" });
  // Proposed (not yet accepted): the note waits with the proposal, never on the narration it may not get (Codex on #11).
  const [proposed, , proposals] = apply(script(), edits, [], false);
  expect(proposals).toHaveLength(1);
  expect(proposed[1]!.notes ?? []).toEqual([]);
  expect(proposals[0]!.notes?.map((note) => note.anchor?.quote)).toEqual(["kidnapping and murder"]);
  // A note on words both have stays on the cut-in; a rewrite again keeps the earlier proposal's notes its words still have.
  const both = [{ op: "write", id: "i2", narration: "He said he was home, and was charged with kidnapping and murder." }, { op: "note", id: "i2", on: "he was home", text: "edit: the porch" }];
  const [kept, , once] = apply(script(), both, [], false);
  expect(kept[1]!.notes?.map((note) => note.text)).toEqual(["edit: the porch"]);
  expect(once[0]!.notes).toBeUndefined();
  const again = { ...script(), clips: script().clips, proposals };
  const [, , twice] = apply(again, [{ op: "write", id: "i2", narration: "He was charged with kidnapping and murder in 2011." }], [], false);
  expect(twice).toHaveLength(1);
  expect(twice[0]!.notes?.map((note) => note.text)).toEqual(["edit: charges on screen"]);
});

test("writes an empty cut-in and proposes a change to a saved one", () => {
  const [clips, , proposals] = apply(script(), [{ op: "write", id: "i2", narration: "He swore he was home." }, { op: "write", id: "i4", narration: "He was not." }], [], false);
  expect(clips[1]!.narration).toBe("He said he was home.");
  expect(clips[3]!.narration).toBe("He was not.");
  expect(proposals).toHaveLength(1);
  expect([proposals[0]!.before, proposals[0]!.after]).toEqual(["He said he was home.", "He swore he was home."]);
  // Accepting it (the paragraph now reads as proposed) settles it.
  const accepted = structuredClone(clips);
  accepted[1]!.narration = "He swore he was home.";
  expect(settle(accepted, proposals)).toEqual([]);
});

test("refuses a bad edit and keeps nothing", () => {
  expect(() => apply(script(), [{ op: "delete", ids: ["i1"] }, { op: "trim", id: "i9", edge: "in", wordId: "w1" }], [], false)).toThrow(/^Edit 2 \(trim\): There is no item i9/);
  expect(() => apply(script(), [{ op: "write", id: "i4", narration: "A dash — here." }], [], false)).toThrow("em dash");
});

test("removes words from every clip and fixes spelling", () => {
  const [clips, corrections] = apply(script(), [{ op: "remove_words", firstWordId: "w4", lastWordId: "w6" }, { op: "correct_word", wordId: "w3", text: "Smyth." }], [], false);
  expect(clips.filter((clip) => clip.kind !== "cut-in").every((clip) => clip.endMs <= 4_000 || clip.startMs >= 6_500)).toBe(true);
  expect(corrections.w3).toBe("Smyth.");
});

test("lists the script for Claude", () => {
  const text = current(script(), formatOf("interrogation", false, "Case"));
  expect(text).toContain('i1 clip [0:00–0:03] w0–w3 "Hi, I\'m Detective Smith."');
  expect(text).toContain('i2 cut-in (Intro): "He said he was home."');
  expect(text).toContain("i4 cut-in (Outro): (nothing written)");
});

// JJ, Nov 18: "mark clips inside of a script and say, 'Cut this down,' or 'Remove this'… It's pretty frustrating that you have to describe where you want a clip changed."
test("a revision about marked clips changes only those clips", () => {
  const marked = { pointed: ["c2"], beyond: false };
  // Cut down: the marked clip trimmed, a word span taken out of it, a pause pass and an edge pass, nothing else moves.
  const [clips] = apply(script(), [{ op: "trim", id: "i3", edge: "out", wordId: "w8" }, { op: "remove_words", firstWordId: "w5", lastWordId: "w5" }, { op: "tighten_pauses" }, { op: "polish_edges" }], [], false, marked);
  const before = script().clips;
  expect(clips.find((clip) => clip.id === "c1")).toEqual(before[0]!);
  expect(clips.find((clip) => clip.id === "n1")).toEqual(before[1]!);
  expect(clips.find((clip) => clip.id === "n2")).toEqual(before[3]!);
  expect(clips.filter((clip) => clip.kind !== "cut-in" && clip.id !== "c1").every((clip) => clip.startMs >= 3_850 && clip.endMs <= 8_900)).toBe(true);
  // Remove this: the marked clip goes, the rest stays as it was.
  expect(apply(script(), [{ op: "delete", ids: ["i3"] }], [], false, marked)[0]).toEqual(before.filter((clip) => clip.id !== "c2"));
  // A new item beside it, or moving it, is about it too.
  expect(apply(script(), [{ op: "insert_cut_in", afterId: "i3", narration: "Then he changed his story." }, { op: "move", ids: ["i3"], beforeId: "i1" }], [], false, marked)[0].map((clip) => clip.id).slice(0, 2)).toEqual(["c2", "c1"]);
  // Anything that reaches another item is refused, with what it touched, so the repair turn keeps to the marked ones.
  expect(() => apply(script(), [{ op: "trim", id: "i1", edge: "out", wordId: "w2" }], [], false, marked)).toThrow("The producer marked i3 for this request, and these edits also changed i1");
  expect(() => apply(script(), [{ op: "delete", ids: ["i3", "i4"] }], [], false, marked)).toThrow("removed i4");
  expect(() => apply(script(), [{ op: "write", id: "i2", narration: "He swore he was home." }], [], false, marked)).toThrow("rewrote i2's narration");
  expect(() => apply(script(), [{ op: "move", ids: ["i4"], beforeId: "i1" }], [], false, marked)).toThrow("moved other items around");
  expect(() => apply(script(), [{ op: "remove_words", firstWordId: "w2", lastWordId: "w5" }], [], false, marked)).toThrow("changed i1");
  // Unless the producer's words named more as well ("…and the intro"): the model says so with beyond.
  expect(apply(script(), [{ op: "trim", id: "i1", edge: "out", wordId: "w2" }], [], false, { pointed: ["c2"], beyond: true })[0][0]!.endMs).toBeLessThan(3_900);
  // Unmarked, as before: any item.
  expect(apply(script(), [{ op: "trim", id: "i1", edge: "out", wordId: "w2" }], [], false)[0][0]!.endMs).toBeLessThan(3_900);
});

test("Claude is told which clips were marked, by the names it edits them by", () => {
  expect(seen(script(), { selected: ["c2", "n2"], picked: null, playheadMs: null, pointed: true })).toContain("The producer marked i3, i4 in the script for this message");
  // A timeline selection that the message isn't about stays a hint, as before.
  expect(seen(script(), { selected: ["c2"], picked: null, playheadMs: null })).toContain("Selected in the timeline: i3.");
});
