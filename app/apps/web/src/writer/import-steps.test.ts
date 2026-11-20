import { describe, expect, it } from "vitest";
import { creeping, stillLine } from "./import-steps";
import { timeOfDay } from "../lib/import_progress";

describe("an import's percentage as shown", () => {
  it("eases a little ahead only while the server moves, and a clock read early never makes it NaN (JJ, Nov 10)", () => {
    const at = 1_800_000_000_000;
    expect(creeping("a", 58, at, at)).toBe(58);
    // A dialog's clock from before the number came: nothing crept, still a number.
    expect(creeping("a", 58, at - 5 * 60_000, at)).toBe(58);
    // Moving (the server saw a byte five seconds ago): a little ahead, never more than a few points.
    const later = creeping("a", 58, at + 5 * 60_000, at + 5 * 60_000 - 5_000);
    expect(later).toBeGreaterThan(58);
    expect(later).toBeLessThanOrEqual(62);
    // Never back, never past 99.
    expect(creeping("a", 58, at + 60_000, at + 60_000)).toBe(later);
    expect(creeping("a", 98, at, at)).toBe(98);
    expect(creeping("a", 98, at + 1_000_000 * 60_000, at + 1_000_000 * 60_000)).toBe(99);
    // A NaN from the server reads as nothing yet, never NaN.
    expect(Number.isNaN(creeping("b", Number.NaN, at))).toBe(false);
  });

  it("the same answer from the server for ten minutes: the number never rises (Nov 20: Home crept to 99 on a wait)", () => {
    const at = 1_800_000_000_000;
    const moved = at - 30_000;
    const first = creeping("c", 37, at, moved);
    for (let second = 0; second <= 600; second += 7) expect(creeping("c", 37, at + second * 1000, moved)).toBe(first);
    expect(first).toBe(37);
    // No time from the server at all (an older server, a script's saved progress): the same.
    expect(creeping("d", 37, at)).toBe(37);
    expect(creeping("d", 37, at + 10 * 60_000)).toBe(37);
  });

  it("five minutes without a move, the line says since when and that Edit keeps at it", () => {
    const moved = new Date(2026, 10, 20, 14, 2).getTime();
    expect(stillLine(moved, moved + 4 * 60_000)).toBeNull();
    expect(stillLine(undefined, moved)).toBeNull();
    expect(stillLine(moved, moved + 5 * 60_000)).toBe(`Nothing has come in since ${timeOfDay(moved)}. Edit keeps trying by itself.`);
  });
});
