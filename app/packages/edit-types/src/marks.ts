// What's marked on the timeline (the in and out points, the stretches marked
// to export, the markers) kept on what it marks when frames [start, end) are
// taken out of the edit, as edit-core's `remove_time` warps them
// (crates/edit-core/src/timeline.rs), or when the edit grows or shrinks at a
// moment. For the shifts done here rather than there: the server's
// `closeGaps`, a voice-over laid on one cut-in, and the timeline's Backspace
// on a gap. A stretch left behind exported the footage that slid into its
// place.

import type { Project } from "./generated";

type Marks = Pick<Project, "mark_in" | "mark_out" | "ranges" | "markers">;

/** Drops the stretches left empty (none left: the key goes, as `set_ranges` leaves it). */
function keepRanges(project: Marks): void {
  if (project.ranges === undefined) return;
  project.ranges = project.ranges.filter((range) => range.end > range.start);
  if (project.ranges.length === 0) delete project.ranges;
}

/** Moves the marks at or after `at` by `frames` (fewer when negative): a stretch ending there takes the change in, as the clip that ends there grew or shrank by it. */
export function moveMarks(project: Marks, at: number, frames: number): void {
  if (frames === 0) return;
  for (const key of ["mark_in", "mark_out"] as const) {
    const mark = project[key];
    if (mark !== undefined && mark !== null && mark >= at) project[key] = mark + frames;
  }
  for (const marker of project.markers ?? []) if (marker.frame >= at) marker.frame += frames;
  for (const range of project.ranges ?? []) {
    if (range.start >= at) range.start += frames;
    if (range.end >= at) range.end += frames;
  }
  keepRanges(project);
}

/** Moves the marks for frames [start, end) taken out: those after it back by its length, those inside to `start`; a stretch wholly inside goes. */
export function closeMarks(project: Marks, start: number, end: number): void {
  const length = end - start;
  if (length <= 0) return;
  const warp = (frame: number) => (frame >= end ? frame - length : frame > start ? start : frame);
  for (const key of ["mark_in", "mark_out"] as const) {
    const mark = project[key];
    if (mark === undefined || mark === null) continue;
    project[key] = warp(mark);
  }
  for (const marker of project.markers ?? []) marker.frame = warp(marker.frame);
  for (const range of project.ranges ?? []) {
    range.start = warp(range.start);
    range.end = warp(range.end);
  }
  keepRanges(project);
}
