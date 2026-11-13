// What's marked on the timeline stays on what it marks as the edit shifts: a stretch marked to export left behind
// exported the footage that slid into its place (review, Nov 13).
import { expect, test } from "bun:test";

import { closeMarks, moveMarks } from "@edit/types/marks";

import type { Project } from "../src/model.ts";

const marked = (): Pick<Project, "mark_in" | "mark_out" | "ranges" | "markers"> => ({
  mark_in: 40,
  mark_out: 119,
  markers: [{ frame: 100, name: "slam" }] as Project["markers"],
  ranges: [
    { start: 0, end: 50, name: "Cut-in 1" },
    { start: 50, end: 120, name: "Cut-in 2" },
    { start: 120, end: 200, name: "Cut-in 3" },
  ],
});

test("a cut-in grown at its end: the stretch ending there takes the frames in, what comes after moves on", () => {
  const p = marked();
  moveMarks(p, 120, 30);
  expect(p.ranges).toEqual([
    { start: 0, end: 50, name: "Cut-in 1" },
    { start: 50, end: 150, name: "Cut-in 2" },
    { start: 150, end: 230, name: "Cut-in 3" },
  ]);
  expect([p.mark_in, p.mark_out, p.markers?.[0]?.frame]).toEqual([40, 119, 100]);
});

test("a cut-in shrunk to nothing past a stretch's start: the stretch goes", () => {
  const p = marked();
  moveMarks(p, 50, -50);
  expect(p.ranges?.map((one) => one.name)).toEqual(["Cut-in 2", "Cut-in 3"]);
  expect(p.ranges?.[0]).toEqual({ start: 0, end: 70, name: "Cut-in 2" });
  expect([p.mark_in, p.mark_out, p.markers?.[0]?.frame]).toEqual([40, 69, 50]);
});

test("frames taken out: what's after moves back, what's inside goes to their start, a stretch wholly inside goes", () => {
  const p = marked();
  closeMarks(p, 50, 120);
  expect(p.ranges).toEqual([
    { start: 0, end: 50, name: "Cut-in 1" },
    { start: 50, end: 130, name: "Cut-in 3" },
  ]);
  expect([p.mark_in, p.mark_out, p.markers?.[0]?.frame]).toEqual([40, 50, 50]);
  // Every stretch gone: none are left marked.
  closeMarks(p, 0, 200);
  expect(p.ranges).toBeUndefined();
});
