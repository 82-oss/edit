// What Edit is doing on this computer, and on which project or script: the
// one answer every "is this busy" reads (Nov 8 audit, item C: five answers
// had grown apart). `busyWith` is what a restart or an update would cut off
// (remote_actions, routes, reviews.busyHere); `workingOn` is whether work here
// holds a project's or a script's cloud lock (cloud_projects, writer/cloud).

import type { App } from "./app.ts";
import { importing } from "./drive_import.ts";
import { importingNow } from "./import.ts";
import * as ideaRuns from "./ideas/run.ts";
import * as jobs from "./jobs.ts";
import * as progress from "./progress.ts";
import * as seams from "./seams.ts";
import * as thumbnailRuns from "./thumbnails/run.ts";
import * as writerImports from "./writer/imports.ts";
import * as writerJobs from "./writer/jobs.ts";

/** Others' work this computer is doing (reviews' fixes): each says what runs, or nothing. */
const others = new Set<() => string | null>();

/** Adds work only its own module knows about (the review's feedback fixes); undone by the function returned. */
export function register(what: () => string | null): () => void {
  others.add(what);
  return () => others.delete(what);
}

/** Work on a project only its own module knows about (an effect's render, a removal's pieces), each saying whether it runs for an edit. */
const projectWork = new Set<(id: string) => boolean>();

/** Adds such work (wired where the server starts, serve.ts); undone by the function returned. */
export function registerProjectWork(runs: (id: string) => boolean): () => void {
  projectWork.add(runs);
  return () => projectWork.delete(runs);
}

/**
 * Whether anything runs for edit `id` on this computer now: an agent turn, an export, a job the table holds for it
 * (an export, a share, smoothing, a watch, footage coming in, a turn a restart cut short), work under way that shows
 * on its page (progress.ts), an effect's render or a removal's pieces. The cache's cleaner keeps such a project's
 * files whatever its state (cache_cleanup.ts).
 */
export function workingFor(app: App, id: string): boolean {
  return workingNow(app)(id);
}

/** `workingFor` for many projects at once: the job table and the agent's turns read once. */
export function workingNow(app: App): (id: string) => boolean {
  const agents = app.agents as { runningProjects?: () => string[] } | undefined;
  const turns = new Set(agents?.runningProjects?.() ?? []);
  const listed = new Set(jobs.list(app.store.home ?? null).filter(jobs.live).map((job) => job.project));
  return (id) => {
    if (turns.has(id) || listed.has(id) || progress.pending(id).length > 0) return true;
    try {
      if (app.exports.runningFor?.(id) != null) return true;
    } catch {
      // No exports here (tests).
    }
    for (const runs of projectWork) {
      try {
        if (runs(id)) return true;
      } catch {
        // Its module can't say: not counted.
      }
    }
    return false;
  };
}

/** What shows on an edit's page as running (progress.ts), in a word each. */
const PROGRESS_WORDS: Record<progress.Work, string> = { smooth: "smoothing", map: "a map shot", watch: "a watch", export: "an export", import: "a footage import", link: "footage coming in" };

/**
 * `workingFor` in words: each thing running for edit `id` now, or waiting in the job table for its next try, so a
 * refusal can say what to wait for (channel_move.ts, Nov 21: an edit isn't moved onto a channel under any of them).
 */
export function workFor(app: App, id: string): string[] {
  const said: string[] = [];
  const agents = app.agents as { runningProjects?: () => string[] } | undefined;
  if (agents?.runningProjects?.().includes(id) === true) said.push("an agent turn");
  for (const job of jobs.list(app.store.home ?? null)) if (job.project === id && jobs.live(job)) said.push(WORDS[job.kind]);
  for (const entry of progress.pending(id)) said.push(PROGRESS_WORDS[entry.kind]);
  try {
    if (app.exports.runningFor?.(id) != null) said.push("an export");
  } catch {
    // No exports here (tests).
  }
  if ((app.scripts as ScriptJobs | undefined)?.working?.(id) === true) said.push("a script's import");
  if ([...projectWork].some((runs) => safely(() => runs(id)))) said.push("an effect's render or footage being cleaned");
  return [...new Set(said)];
}

interface ScriptJobs {
  get?(project: string): { state: string } | null;
  running?(): boolean;
  working?(project: string): boolean;
}

const RUNNING_IMPORT = new Set(["downloading", "transcribing", "placing", "voicing"]);

/** Whether work here holds `key`'s lock: an agent turn or a script import on that edit, or an import or Claude on that script. */
export function workingOn(app: App, key: string): boolean {
  if (key.startsWith("script:")) {
    const id = key.slice("script:".length);
    return writerImports.importing(id) || writerJobs.running(id);
  }
  const agents = app.agents as { runningProjects?: () => string[] } | undefined;
  if (agents?.runningProjects?.().includes(key) === true) return true;
  const scripts = app.scripts as ScriptJobs | undefined;
  // Working here, not one read back after a restart that its resumer hasn't picked up yet.
  if (scripts?.working !== undefined) return scripts.working(key);
  const job = scripts?.get?.(key) ?? null;
  return job !== null && RUNNING_IMPORT.has(job.state);
}

/** When this run began: a running row written before it was cut short by the restart. */
const STARTED_MS = Date.now();

/** A running job's word, by its kind. */
const WORDS: Record<jobs.Kind, string> = {
  export: "an export",
  archive: "an export going up to the cloud",
  drive: "an upload to Drive",
  smooth: "smoothing",
  watch: "a watch",
  upload: "an upload",
  map: "a map shot",
  case: "a footage import",
  full: "a share's full-quality file",
  share: "a share",
  fix: "a feedback fix",
  turn: "an agent turn",
  idea: "Claude on an idea",
  thumbnail: "Claude on a thumbnail",
  playback: "a smooth playback render",
  script: "a script's import",
  footage: "a footage import",
  writer: "Claude on a script",
  missing: "a script's import",
  media: "a footage import",
};

/**
 * What runs on this computer now, in a word each: the one answer that keeps the Mac awake (serve.ts), holds a restart
 * from afar (remote_actions, reviews.busyHere) and that the diagnostics say (honest council change 7i, Nov 19: three
 * hand-kept lists had grown apart; keeping the Mac awake missed Script mode's imports, Claude's runs and shares, and
 * a restart's list missed effects' renders and removal, so Sphe's M4 slept 20 minutes mid-removal on Nov 18). An
 * export, its cloud copy, a share running, an upload to Drive, an import of either kind, Claude on a script, an
 * agent turn, Claude on a thumbnail or an idea, a fix, an effect's render, footage being cleaned. Work waiting in the
 * job table for its next try isn't running: nothing is cut off by a restart, and the Mac may sleep.
 */
export function runningNow(app: App, agentTurns = true): string[] {
  let uploading = false;
  try {
    uploading = seams.drive.uploading();
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  const shares = jobs.list(app.store.home ?? null, "share").filter((job) => job.state === "running" || job.state === "queued").length;
  const agents = app.agents as { hasRunningTurns?: () => boolean; runningProjects?: () => string[] } | undefined;
  const turns = agents?.hasRunningTurns?.() ?? (agents?.runningProjects?.().length ?? 0) > 0;
  let exporting = false;
  let archiving = false;
  try {
    exporting = app.exports.running();
    archiving = app.exports.archiving?.() === true;
  } catch {
    // No exports here (tests).
  }
  const said = [
    exporting ? "an export" : "",
    archiving ? "an export going up to the cloud" : "",
    shares > 0 ? (shares === 1 ? "a share" : `${shares} shares`) : "",
    uploading ? "an upload to Drive" : "",
    (app.scripts as ScriptJobs | undefined)?.running?.() || importing() || importingNow() ? "a footage import" : "",
    writerImports.anyImporting() ? "a script's import" : "",
    writerJobs.runningList().length > 0 ? "Claude on a script" : "",
    agentTurns && turns ? "an agent turn" : "",
    agentTurns && thumbnailRuns.anyRunning() ? "Claude on a thumbnail" : "",
    agentTurns && ideaRuns.anyRunning() ? "Claude on an idea" : "",
  ];
  for (const what of others) said.push(what() ?? "");
  // Whatever the job table holds as running, written by this run (one read back from before a restart is its
  // resumer's to start): each module's own word above can miss a moment between its steps, and the table is the one
  // record (bad-day awake-and-busy, Nov 19: the share's full-quality file going up alone said nothing, and the Mac
  // could sleep mid-upload).
  for (const job of jobs.list(app.store.home ?? null)) {
    if (job.state !== "running" || job.updated_ms < STARTED_MS) continue;
    if (!agentTurns && (job.kind === "turn" || job.kind === "idea" || job.kind === "thumbnail")) continue;
    said.push(WORDS[job.kind]);
  }
  // An effect's render or footage being cleaned, on any edit.
  if (projectWork.size > 0) {
    let projects: string[] = [];
    try {
      projects = (app.store.list?.() ?? []).map((one: { id: string }) => one.id);
    } catch {
      projects = [];
    }
    for (const id of projects) {
      if ([...projectWork].some((runs) => safely(() => runs(id)))) {
        said.push("an effect's render or footage being cleaned");
        break;
      }
    }
  }
  return [...new Set(said.filter(Boolean))];
}

function safely(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

/** What a restart would cut off now (`runningNow`): one list for everything that restarts Edit from afar. */
export const busyWith = (app: App, agentTurns = true): string[] => runningNow(app, agentTurns);
