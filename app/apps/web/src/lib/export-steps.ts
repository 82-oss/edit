import type { ExportStep, ExportSteps, StepState } from "@edit/types/export_steps";

import { THIS_MACHINE } from "./platform";

/**
 * An export's steps as rows (the Export dialog and the Exports queue, one
 * list: components/ExportSteps.tsx). The server says where each step stands
 * (export_steps.ts); this says it in plain words: graphics by their number
 * and place ("Graphic 3 of 5 · the map at 41:12"), those done and those still
 * to come folded into one row each ("Graphics 1–2", "Graphics 4–5").
 */
export interface StepRow {
  key: string;
  state: StepState;
  text: string;
  /** Muted after the text: what the current step waits on. */
  note?: string;
  /** The current step's bar (0–1), when it's measured. */
  progress: number | null;
  /** At the right: a done step's time ("52 s", else "done"), the current one's percent and time left (or its time so far), a time still to come. */
  right: string | null;
}

/** A time that was measured, said whole: "52 s", "6 min 48 s", "1 h 2 min". */
export function tookWords(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3600) return whole % 60 === 0 ? `${whole / 60} min` : `${Math.floor(whole / 60)} min ${whole % 60} s`;
  return `${Math.floor(whole / 3600)} h ${Math.round((whole % 3600) / 60)} min`;
}

/** "a moment", "~40 s", "~3 min", "~1 h 20 min"; null with no basis. */
export function leftWords(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  if (seconds < 10) return "a moment";
  if (seconds < 60) return `~${Math.max(10, Math.round(seconds / 10) * 10)} s`;
  if (seconds < 90 * 60) return `~${Math.max(1, Math.round(seconds / 60))} min`;
  const minutes = Math.round(seconds / 60);
  return `~${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The whole export's time, under the steps: "About 4 min left". */
export function aboutLeft(seconds: number | null | undefined): string | null {
  const words = leftWords(seconds);
  if (words === null) return null;
  if (words === "a moment") return "Almost done";
  return `About ${words.slice(1)} left`;
}

/** "the map at 41:12", "at 41:12". */
function place(step: ExportStep): string {
  return step.what ? `the ${step.what} at ${step.label}` : `at ${step.label}`;
}

const capitalize = (text: string) => (text === "" ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`);

function sum(steps: ExportStep[]): number | null {
  return steps.every((step) => step.left_s !== null) ? steps.reduce((total, step) => total + step.left_s!, 0) : null;
}

/**
 * What a row says at its right, only what the server measured (Sphe, Nov 21: "improve the ability to see progress"):
 * done, how long it took when that was seen (else "done"); under way, its percent and time left, or with no percent
 * its time so far; to come, its estimate.
 */
function rightOf(state: StepState, steps: ExportStep[]): string | null {
  const step = steps[0]!;
  if (state === "done") return steps.length === 1 && step.took_s !== undefined ? tookWords(step.took_s) : "done";
  const left = leftWords(sum(steps));
  if (state === "current" && step.progress !== null) return [`${Math.round(step.progress * 100)}%`, left].filter(Boolean).join(" · ");
  if (state === "current" && step.elapsed_s !== undefined) return `${tookWords(step.elapsed_s)} so far`;
  return left;
}

function otherText(step: ExportStep): string {
  if (step.kind === "removal") return step.label ? `Removing their text · ${step.label}` : "Removing their text";
  if (step.kind === "video") return step.label ? `Video · ${step.label}` : "Video";
  if (step.kind === "copy") return "Review copy";
  if (step.kind === "upload") return "Upload to the review link";
  return step.label ? `Save to ${step.label}` : "Save";
}

export function rowsOf(steps: ExportStep[]): StepRow[] {
  const graphics = steps.filter((step) => step.kind === "graphic");
  const total = graphics.length;
  const rows: StepRow[] = [];
  let at = 0;
  while (at < steps.length) {
    const step = steps[at]!;
    if (step.kind !== "graphic") {
      rows.push({ key: step.kind, state: step.state, text: otherText(step), ...(step.note ? { note: step.note } : {}), progress: step.state === "current" ? step.progress : null, right: rightOf(step.state, [step]) });
      at += 1;
      continue;
    }
    // Graphics alike in state side by side are one row, but the one under way.
    let end = at + 1;
    if (step.state !== "current") while (end < steps.length && steps[end]!.kind === "graphic" && steps[end]!.state === step.state) end += 1;
    const group = steps.slice(at, end);
    const first = graphics.indexOf(step) + 1;
    const last = first + group.length - 1;
    let text: string;
    if (total === 1) text = capitalize(step.what ? `the ${step.what} at ${step.label}` : `the graphic at ${step.label}`);
    else if (group.length > 1) text = `Graphics ${first}–${last}`;
    else if (step.state === "current") text = `Graphic ${first} of ${total} · ${place(step)}`;
    else text = `Graphic ${first} · ${place(step)}`;
    rows.push({ key: `graphic-${first}`, state: step.state, text, ...(step.note ? { note: step.note } : {}), progress: step.state === "current" ? step.progress : null, right: rightOf(step.state, group) });
    at = end;
  }
  return rows;
}

/** What it's on, for the Exports card: "Graphics 4 of 27", "Video", "Uploading". */
export function currentWords(given: ExportSteps): string {
  if (given.queued) return "Queued";
  const step = given.steps.find((one) => one.state === "current");
  if (step === undefined) return "Starting";
  if (step.kind === "graphic") {
    const graphics = given.steps.filter((one) => one.kind === "graphic");
    return graphics.length === 1 ? "Graphics" : `Graphics ${graphics.indexOf(step) + 1} of ${graphics.length}`;
  }
  if (step.kind === "removal") return "Removing their text";
  if (step.kind === "video") return "Video";
  if (step.kind === "copy") return "Review copy";
  if (step.kind === "upload") return "Uploading";
  return "Saving";
}

/** Under a job's name in the queue: where it goes, and how long the video is. "Save to this Mac · ~/Movies/Edit · 1:48:29". */
export function whereLine(given: ExportSteps): string {
  const save = given.steps.find((one) => one.kind === "save");
  const video = given.steps.find((one) => one.kind === "video");
  return [given.where === "here" ? `Save to ${THIS_MACHINE}` : "Send for feedback", save?.label ?? "", video?.label ?? ""].filter((one) => one !== "").join(" · ");
}

/** Whether it's on its graphics now (the fill shimmers). */
export function onGraphics(given: ExportSteps | null | undefined): boolean {
  return given?.steps.some((one) => one.kind === "graphic" && one.state === "current") === true;
}
