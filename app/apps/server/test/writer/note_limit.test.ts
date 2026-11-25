// A build note's 2,000 characters are the producer's: what Edit adds after it never counts (Codex on #10, Nov 25: a
// 1,900-character note that asked for another channel's style was refused once Edit's note on that style was added).

import { expect, test } from "bun:test";

import { checkNote, producerPart } from "../../src/writer/build.ts";

test("Edit's notes after a producer's note are left out of its length", () => {
  const theirs = "x".repeat(1_900);
  const sent = `${theirs}\n\n(Edit's note: Female Felons' script style was brought into this channel's own before this build.)\n\n(Edit's note on the footage: one clip is missing.)`;
  expect(producerPart(sent)).toBe(theirs);
  expect(producerPart("(Edit's note on the footage: one clip is missing.)")).toBe("");
  expect(producerPart("Keep it tight. Edit's note style, please.")).toBe("Keep it tight. Edit's note style, please.");
});

test("a note over its limit is refused on its own words, Edit's notes after it never counted", () => {
  expect(() => checkNote(`${"x".repeat(1_900)}\n\n(Edit's note: ${"y".repeat(500)})`, true)).not.toThrow();
  expect(() => checkNote("x".repeat(2_001))).toThrow("Keep the note under 2,000 characters.");
  // A producer's own note is counted whole: their words that read like Edit's never slip past it.
  const lookalike = `(Edit's note: ${"x".repeat(2_100)})`;
  expect(() => checkNote(lookalike)).toThrow("Keep the note under 2,000 characters.");
  expect(() => checkNote(lookalike, true)).not.toThrow();
});

test("a style's lessons not brought are told to the writer with why, as the report says it", async () => {
  const { whyHeld } = await import("../../src/writer/scripting.ts");
  expect(whyHeld(["intro", "music"], [])).toBe("intro, music, held back for this channel's own");
  expect(whyHeld(["intro", "thud"], ["thud"])).toBe("intro, held back for this channel's own; and thud, which couldn't be read just now");
  expect(whyHeld(["thud"], ["thud"])).toBe("thud, which couldn't be read just now");
});
