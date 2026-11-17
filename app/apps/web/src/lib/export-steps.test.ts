import type { ExportStep, ExportSteps } from "@edit/types/export_steps";
import { describe, expect, it } from "vitest";

import { cardFace } from "./export-face";
import { aboutLeft, currentWords, leftWords, rowsOf, whereLine } from "./export-steps";

const graphic = (state: ExportStep["state"], label: string, left: number | null, over: Partial<ExportStep> = {}): ExportStep => ({ kind: "graphic", state, label, progress: state === "current" ? 0.92 : null, left_s: left, ...over });
const rest = (state: ExportStep["state"], left: number | null): ExportStep[] => [
  { kind: "video", state, label: "1:48:29", progress: state === "current" ? 0.4 : null, left_s: left },
  { kind: "save", state: "waiting", label: "~/Downloads/Edit", progress: null, left_s: 0 },
];
/** Design B's example: five graphics, two done, the third drawing, two to come. */
const FIVE: ExportStep[] = [graphic("done", "0:12", 0), graphic("done", "5:40", 0), graphic("current", "41:12", 4, { what: "map" }), graphic("waiting", "50:02", 15), graphic("waiting", "1:02:10", 25), ...rest("waiting", 180)];
const steps = (list: ExportStep[], left: number | null, over: Partial<ExportSteps> = {}): ExportSteps => ({ where: "here", steps: list, queued: false, elapsed_s: 60, left_s: left, progress: 0.2, ...over });

describe("an export's steps as rows", () => {
  it("folds the done graphics and those to come, names the one under way by its place, and times the rest", () => {
    expect(rowsOf(FIVE).map((row) => [row.state, row.text, row.right])).toEqual([
      ["done", "Graphics 1–2", "done"],
      ["current", "Graphic 3 of 5 · the map at 41:12", "92%"],
      ["waiting", "Graphics 4–5", "~40 s"],
      ["waiting", "Video · 1:48:29", "~3 min"],
      ["waiting", "Save to ~/Downloads/Edit", "a moment"],
    ]);
  });

  it("says a lone graphic by what and where it is, and a time only with a basis for all of a row", () => {
    const one = rowsOf([graphic("current", "0:40", null, { what: "map", progress: 0.1 }), ...rest("waiting", null)]);
    expect(one.map((row) => [row.text, row.right])).toEqual([
      ["The map at 0:40", "10%"],
      ["Video · 1:48:29", null],
      ["Save to ~/Downloads/Edit", "a moment"],
    ]);
    expect(rowsOf([graphic("current", "0:10", 3), graphic("waiting", "0:20", 10), graphic("waiting", "0:30", null)])[1]!.right).toBeNull();
  });

  it("lays out a share's steps: the review copy and the upload in place of the save", () => {
    const share: ExportStep[] = [
      { kind: "video", state: "done", label: "12:04", progress: null, left_s: 0 },
      { kind: "copy", state: "current", label: "", progress: null, left_s: 20 },
      { kind: "upload", state: "waiting", label: "", progress: null, left_s: 95 },
    ];
    expect(rowsOf(share).map((row) => [row.state, row.text, row.right])).toEqual([
      ["done", "Video · 12:04", "done"],
      ["current", "Review copy", "~20 s"],
      ["waiting", "Upload to the review link", "~2 min"],
    ]);
  });

  it("says times plainly and never below nothing", () => {
    expect([leftWords(null), leftWords(4), leftWords(38), leftWords(170), leftWords(5 * 3600 + 20 * 60)]).toEqual([null, "a moment", "~40 s", "~3 min", "~5 h 20 min"]);
    expect([aboutLeft(240), aboutLeft(42), aboutLeft(3), aboutLeft(null)]).toEqual(["About 4 min left", "About 40 s left", "Almost done", null]);
    expect(currentWords(steps(FIVE, 240))).toBe("Graphics 3 of 5");
    expect(whereLine(steps(FIVE, 240))).toMatch(/^Save to .+ · ~\/Downloads\/Edit · 1:48:29$/);
  });
});

describe("the Exports card", () => {
  it("is one number across every job queued and running, each by its whole time, with the current step and the queue's time left", () => {
    const running = { name: "Officers", state: "running", progress: 0, steps: steps(FIVE, 540, { elapsed_s: 120, progress: 120 / 660 }) };
    const next = { name: "Cops Found 3 Bodies", state: "queued", progress: 0, steps: steps(rest("waiting", 360), 360, { queued: true, elapsed_s: 0, progress: 0 }) };
    const alone = cardFace([running]);
    expect(alone).toMatchObject({ percent: 18, subtitle: "Graphics 3 of 5 · ~9 min left", graphics: true });
    const two = cardFace([running, next]);
    // 120 s done of 660 + 360.
    expect(two.percent).toBe(Math.round((120 / 1020) * 100));
    expect(two.subtitle).toBe("2 exports · Graphics 3 of 5 · ~15 min left");
    const video = cardFace([{ ...running, steps: steps([graphic("done", "0:12", 0), ...rest("current", 180)], 180, { progress: 0.64 }) }]);
    expect(video).toMatchObject({ percent: 64, subtitle: "Video · ~3 min left", graphics: false });
    expect(JSON.stringify([alone, two, video])).not.toMatch(/cutfx|effect/);
  });
});
