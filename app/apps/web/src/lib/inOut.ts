// In and out points (I / O): a span of the edit marked to export, one of the
// marked stretches (`marked`), that playback also stops at the end of.
// They're part of the project (mark_in, mark_out), so every change is an undo
// step and is saved with it.

import { useEditor } from "./store";
import type { Project } from "./types";
import { projectDuration } from "./edit";

export interface Points {
  /** First frame of the span. */
  in: number | null;
  /** Last frame of the span (shown, inclusive). */
  out: number | null;
}

export const pointsOf = (project: Project | null | undefined): Points => ({ in: project?.mark_in ?? null, out: project?.mark_out ?? null });

/** The open project's in and out points. */
export function useInOut(): Points {
  const start = useEditor((state) => state.project?.mark_in ?? null);
  const out = useEditor((state) => state.project?.mark_out ?? null);
  return { in: start, out };
}

/** Sets the in point at `frame`; an out point before it goes. */
export function setIn(project: Project, frame: number) {
  project.mark_in = Math.max(0, Math.round(frame));
  if (project.mark_out != null && project.mark_out < project.mark_in) delete project.mark_out;
}

/** Sets the out point at `frame` (that frame is the last one in); an in point after it goes. */
export function setOut(project: Project, frame: number) {
  project.mark_out = Math.max(0, Math.round(frame));
  if (project.mark_in != null && project.mark_in > project.mark_out) delete project.mark_in;
}

const edit = (recipe: (project: Project) => void) => useEditor.getState().edit(recipe);

export const markIn = (frame: number) => edit((project) => setIn(project, frame));
export const markOut = (frame: number) => edit((project) => setOut(project, frame));
export const clearIn = () => edit((project) => void delete project.mark_in);
export const clearOut = () => edit((project) => void delete project.mark_out);
export const clearInOut = () =>
  edit((project) => {
    delete project.mark_in;
    delete project.mark_out;
  });

/**
 * The marked span as frames `[start, end)` within an edit `duration` long,
 * or null when no point is set. A missing in is the start; a missing out, the end.
 * (As Project::in_out.)
 */
export function inOutSpan(duration: number, points: Points): [number, number] | null {
  if (points.in === null && points.out === null) return null;
  const start = Math.min(points.in ?? 0, Math.max(0, duration - 1));
  const end = Math.min(points.out === null ? duration : points.out + 1, duration);
  return end > start ? [start, end] : null;
}

/** What the in and out points are called as a marked stretch (as ranges.ts IN_OUT). */
export const IN_OUT = "In–out";

/**
 * Everything marked to export, as frames `[start, end)` named: the stretches
 * and the in and out points as one more (Sphe, Nov 13: "I thought the in and
 * out points are the export ranges"), in order, inside the edit, none
 * overlapping (as ranges.ts `marked`).
 */
export function marked(project: Project): { start: number; end: number; name: string }[] {
  const length = projectDuration(project);
  const all = [...(project.ranges ?? [])];
  const span = inOutSpan(length, pointsOf(project));
  if (span !== null) all.push({ start: span[0], end: span[1], name: IN_OUT });
  const sorted = all
    .map((one) => ({ start: Math.max(0, Math.round(one.start)), end: Math.min(length, Math.round(one.end)), name: one.name.trim() }))
    .filter((one) => one.end > one.start)
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number; name: string }[] = [];
  for (const one of sorted) {
    const before = out.at(-1);
    const start = before === undefined ? one.start : Math.max(one.start, before.end);
    if (one.end > start) out.push({ ...one, start });
  }
  return out;
}
