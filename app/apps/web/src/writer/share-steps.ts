import type { ShareFailed, ShareStep, Sharing } from "@edit/types/writer";

import { THIS_MACHINE } from "../lib/platform";

/**
 * A script share's steps in words, as its dialog and its row on Home say
 * them (Sphe, Nov 22: "I don't have a very good breakdown in the UI of the
 * progress, as well as I do with the editing"). Only what the server says
 * (writer/reviews.ts shareState): a percent where it counted bytes, a time
 * left where it measured a rate, else how long the step has run. Pure, so
 * Home takes it without the script page.
 *
 * The edit's share dialog lays out its own steps (components/ExportSteps.tsx,
 * lib/export-steps.ts); this is the script's own until the two are one.
 */

/** "4 min 12 s", "38 s", "under a second". */
export function took(seconds: number): string {
  if (seconds < 1) return "under a second";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return whole % 60 === 0 ? `${minutes} min` : `${minutes} min ${whole % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** "about 4 min", "about 30 s", "a moment". */
export function about(seconds: number): string {
  if (seconds < 10) return "a moment";
  if (seconds < 60) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} s`;
  if (seconds < 90 * 60) return `about ${Math.max(1, Math.round(seconds / 60))} min`;
  const minutes = Math.round(seconds / 60);
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function bytes(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)} GB`;
  if (count >= 1e6) return `${Math.round(count / 1e6)} MB`;
  return `${Math.max(1, Math.round(count / 1e3))} KB`;
}

/** A length as the page prints one: "37:32", "1:02:05". */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}` : `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

/** A step's name: what it does, the same whether it waits, runs or is done. */
export function stepName(step: ShareStep, given: { version?: number; durationMs?: number } = {}): string {
  if (step.kind === "check") return "Its preview in the cloud";
  if (step.kind === "script") return "The script";
  if (step.kind === "fetch") return `Its preview to ${THIS_MACHINE}`;
  if (step.kind === "footage") return given.durationMs ? `Footage for the review page · ${clock(given.durationMs)}` : "Footage for the review page";
  return given.version ? `Publish v${given.version}` : "Publish";
}

/** The step's share done (0–1), when it counted bytes. */
export function stepShare(step: ShareStep): number | null {
  return step.state === "current" && step.done !== undefined && step.total ? Math.min(1, step.done / step.total) : null;
}

/** What sits at a step's right: how long it took, how far it is (and its time left when measured), or the size it will send. */
export function stepRight(step: ShareStep): string {
  if (step.state === "done") return step.skipped ? "already there" : step.seconds !== undefined ? took(step.seconds) : "";
  if (step.state === "current") {
    const share = stepShare(step);
    if (share === null) return step.seconds !== undefined ? took(step.seconds) : "";
    return step.leftS !== undefined ? `${Math.floor(share * 100)}% · ${about(step.leftS)}` : `${Math.floor(share * 100)}%`;
  }
  return step.total !== undefined && (step.kind === "footage" || step.kind === "fetch") ? bytes(step.total) : "";
}

/** The step a share is on, as a few words for its row ("Sending the footage"). */
export function nowWords(sharing: Sharing): string {
  if (sharing.stage === "cancelling") return "Stopping";
  const step = sharing.steps?.find((one) => one.state === "current");
  if (step === undefined) return "Sharing";
  if (step.kind === "check") return "Checking its preview";
  if (step.kind === "script") return "Sending the script";
  if (step.kind === "fetch") return "Bringing its preview here";
  if (step.kind === "footage") return "Sending the footage";
  return "Publishing";
}

/** The dialog's heading while a share runs: what is happening, in a line. */
export function runningTitle(sharing: Sharing): string {
  if (sharing.stage === "cancelling") return "Stopping the share";
  return sharing.version ? `Putting v${sharing.version} on the review link` : "Sharing on the review link";
}

/** The whole share's one number and time: a percent where it counts bytes, the time left where it's measured. */
export function overallLine(sharing: Sharing): { percent: number | null; left: string | null } {
  const percent = typeof sharing.progress === "number" ? Math.floor(Math.max(0, Math.min(1, sharing.progress)) * 100) : null;
  const left = typeof sharing.leftS === "number" ? (sharing.leftS < 10 ? "almost done" : `${about(sharing.leftS)} left`) : null;
  return { percent, left };
}

/** Where a failed share stopped, said before its own words ("Sharing stopped while sending the footage."); "" for one refused before it began (its words say it all). */
export function failedLine(failed: ShareFailed): string {
  const where: Record<ShareStep["kind"], string> = {
    check: "while checking its preview in the cloud",
    script: "while sending the script",
    fetch: `while bringing its preview to ${THIS_MACHINE}`,
    footage: "while sending the footage",
    publish: "while publishing",
  };
  return failed.step ? `Sharing stopped ${where[failed.step]}.` : "";
}
