// A build note's 2,000 characters are the producer's: what Edit adds after it never counts (Codex on #10, Nov 25: a
// 1,900-character note that asked for another channel's style was refused once Edit's note on that style was added).

import { expect, test } from "bun:test";

import { producerPart } from "../../src/writer/build.ts";

test("Edit's notes after a producer's note are left out of its length", () => {
  const theirs = "x".repeat(1_900);
  const sent = `${theirs}\n\n(Edit's note: Female Felons' script style was brought into this channel's own before this build.)\n\n(Edit's note on the footage: one clip is missing.)`;
  expect(producerPart(sent)).toBe(theirs);
  expect(producerPart("(Edit's note on the footage: one clip is missing.)")).toBe("");
  expect(producerPart("Keep it tight. Edit's note style, please.")).toBe("Keep it tight. Edit's note style, please.");
});
