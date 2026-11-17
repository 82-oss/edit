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
  /** At the right: "done", the current step's percent, a time still to come. */
  right: string | null;
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

function rightOf(state: StepState, steps: ExportStep[]): string | null {
  if (state === "done") return "done";
  const step = steps[0]!;
  if (state === "current" && step.progress !== null) return `${Math.round(step.progress * 100)}%`;
  return leftWords(sum(steps));
}

function otherText(step: ExportStep): string {
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
