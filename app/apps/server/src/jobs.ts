// The one table of durable work (`<home>/jobs.json`; Oct 18, then the
// Nov 8 audit's item B): 95 restarts in three days of logs, each dropping the
// export, smoothing or watch under way, which nobody started again; and four
// ledgers beside this one (running agent turns, the retry after an update, the
// failed exports, the fixes under way), each with its own rules. Now there is
// this table and one resumer (serve.ts `resumeJobs`).
//
// A job is written down when it starts and as each step finishes, before the
// next begins; a job still running when the server starts was cut short and is
// started again from its last finished step. Each kind's resumer checks a
// step's output is there (the export listed, the R2 object there by HEAD, the
// version published) before doing it again, so nothing's done twice. A job
// that ends well is crossed off (`end`), or kept as `done` when what it did is
// shown (a share: "Up on the link"); one that fails is kept as `failed`, with
// its error and the build it failed on, so a new build tries it once more
// (retry_after_update.ts). A job stays listed while it's started again (a
// second crash during recovery, or a resumer that fails, never loses it). One
// cut short three times in a row that didn't get further (`progressed`) may be
// what brings the server down: it then waits and is tried again by itself on
// failure.ts's passing schedule (1, 5, 15 minutes, then every 30), one put off
// at a time, until it ends or is cancelled (`postpone`). Nothing is given up
// for restarts (honest council change 7a, Nov 19: Marc's archive sat "given up
// … cut short by 3 restarts in a row" for days, waiting on an unstick); an
// agent's turn is the one exception, ended with its line in the chat. Work
// that fails as it starts waits the same way (`wait`), by what its failure is.
// Given up otherwise means it can't change: a `Gone` source.
//
// The file stays an array of plain objects, readable by hand.

import * as fs from "node:fs";

import { Effect } from "effect";

import * as diag from "./diag.ts";
import * as encoder from "./encoder.ts";
import * as failure from "./failure.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import { nowMs, readState, writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

export type Kind =
  | "export"
  | "archive"
  | "drive"
  | "smooth"
  | "watch"
  | "upload"
  | "map"
  | "case"
  | "full"
  /** A share: export → review copy → copy check → upload → publish (reviews.ts), then its full-quality file as a `full` job. */
  | "share"
  /** Ready for changes: the agent fixing a review's notes, followed to its share (reviews.ts). */
  | "fix"
  /** An agent turn (agent.ts): carried on after a restart within `TURN_RESUME_MS`. */
  | "turn"
  /** Claude on an idea or a thumbnail: its lease while it runs, then its ending until the cloud has it. */
  | "idea"
  | "thumbnail"
  /** A smooth playback render (playback_render.ts): listed so `busyWith` sees it; not resumed. */
  | "playback"
  /** A Writer script's import (writer/imports.ts), or its chosen footage's exact hearing (`script:<id>:exact`, writer/exact_after.ts), waiting on the transcription plan's credit: woken to try again. */
  | "script"
  /** Footage from a Drive link into an edit (drive_import.ts): downloaded (resuming) and added again after a restart. */
  | "footage"
  /** Claude on a Writer script (writer/jobs.ts: a build, a revision, review fixes…), with what it was started with and kept: carried on from it after a restart (writer/work.ts). */
  | "writer"
  /** A Writer script's recordings that didn't come in (writer/missing.ts): tried again by itself, joined when they come. */
  | "missing"
  /** An edit's footage that isn't here (missing_media.ts): fetched again by itself from where it came from. */
  | "media";

export type State = "queued" | "running" | "waiting" | "done" | "failed" | "given_up";

export interface Job {
  /** One job per key: kind, project and what in it (a clip). */
  key: string;
  kind: Kind;
  project: string;
  args: Record<string, unknown>;
  state: State;
  /** Where it is, in a word or two, for the UI ("exporting", "review copy", "uploading", "publishing"…). */
  step?: string;
  /** How many times it was started again after a restart (raised as it's handed back, before it starts). */
  attempts: number;
  started_ms: number;
  updated_ms: number;
  /** Why it failed (state failed). */
  error?: string;
  /** The build it failed on (state failed): a new build tries it again once. */
  build?: string;
  /** The build it's queued to be tried again on (retry_after_update.ts), cleared as it's taken. */
  retry?: string;
  /** Why it isn't started again any more (state given_up); unstick clears it. */
  given_up?: string;
  /** State waiting: when the one resumer wakes it to try again (ms since the epoch). */
  retry_at?: number;
  /** State waiting: what it waits on instead of a time: the hardware encoder to be free, or the person (never woken by itself). */
  until?: "encoder" | "person";
  /** How many times it's waited to be tried again by itself (`wait`): its next wait follows failure.ts's schedule. Cleared as it gets further. */
  put_off?: number;
  /** Why it was last put off (state waiting, `put_off`), for the diagnostics. */
  why?: string;
  /** Put off for being cut short by restarts in a row: it may be what brings the server down, so such work goes one at a time. Cleared as it gets further. */
  crashy?: boolean;
}

/** Thrown by a resumer when there's nothing left to start again (the project, clip or file is gone): the job is crossed off. */
export class Gone extends Error {}

/** Cut short this many times in a row without ending or getting further: it waits and is tried again by itself (`postpone`), never given up. */
const IN_A_ROW = 2;

/** A job put off and started again by itself counts as the one under way for this long after its last note; then another may go. */
const PUT_OFF_RUN_MS = 3 * 3_600_000;
/** Done jobs (a share's outcome) and failed ones nothing retries are kept this long, then dropped. */
const KEEP_ENDED_MS = 30 * 24 * 3_600_000;
/** A turn cut short is carried on when Edit is back this soon after it was last noted (a restart, not a quit). */
export const TURN_RESUME_MS = 10 * 60_000;

const LIVE: readonly State[] = ["queued", "running", "waiting"];

/** Whether a job is still to do (not done, failed or given up). */
export function live(job: Job): boolean {
  return LIVE.includes(job.state);
}

function file(home: string): string {
  return join(home, "jobs.json");
}

/** An entry as written: its args always an object (every build since nightly-69, Nov 8, writes a state and attempts). */
function normal(raw: Record<string, unknown>): Job {
  const job = raw as unknown as Job;
  return { ...job, args: typeof job.args === "object" && job.args !== null ? job.args : {} };
}

function load(home: string): Job[] {
  // A file that won't read is set aside, never read as empty and written over (files.readState).
  const value = readState(file(home), (message) => diag.warn("jobs", message));
  return Array.isArray(value) ? (value as Record<string, unknown>[]).filter((job) => typeof job?.key === "string").map(normal) : [];
}

function read(home: string): Job[] {
  return load(home);
}

/**
 * Set once Edit is about to restart itself (an update), before it stops the
 * programs its work runs: what that stop makes the work say (failed, ended)
 * isn't written, so the table stays as it was and the next start carries
 * every job on. Written, an import whose FFmpeg was killed under it was
 * listed failed, which nothing carries on.
 */
let frozen = false;
export function freeze(on = true): void {
  frozen = on;
}

function write(home: string, jobs: Job[]): void {
  if (frozen) return;
  const now = nowMs();
  // Failed exports and shares stay until they're done again (a new build retries them); other ended jobs go after a while.
  const kept = jobs.filter((job) => live(job) || job.state === "given_up" || (job.state === "failed" && (job.kind === "export" || job.kind === "share")) || now - job.updated_ms < KEEP_ENDED_MS);
  try {
    writeAtomic(file(home), JSON.stringify(kept, null, 1));
  } catch (error) {
    diag.warn("jobs", `couldn't note the running jobs: ${diag.messageOf(error)}`);
  }
}

/** Reads the table, changes it, and writes it back when `change` says so (returns true or a value other than false). */
function change<T>(home: string, edit: (jobs: Job[]) => T): T {
  const jobs = read(home);
  const result = edit(jobs);
  if (result !== (false as unknown)) write(home, jobs);
  return result;
}

export function keyOf(kind: Kind, project: string, part = ""): string {
  return part === "" ? `${kind}:${project}` : `${kind}:${project}:${part}`;
}

// ---------------------------------------------------------------- owned
//
// Which rows code in this run is holding, in memory (Nov 20: rows said "running" with nothing running for the rest
// of a run, a resumer's failure dropped or its work ended without a word, and only the next start looked at them).
// A row is held from `begin` (or a resumer's start, or a step or beat: code that notes it is holding it) until it is
// ended, settled or put to wait. Work in any module that goes through `begin` is counted with no change of its own.
// What nothing holds and nothing has noted for `UNOWNED_MS` is put to wait by itself (`cutShortUnowned`).

const owners = new Map<string, Set<string>>();

function own(home: string, key: string): void {
  let held = owners.get(home);
  if (held === undefined) owners.set(home, (held = new Set()));
  held.add(key);
}

function disown(home: string, key: string): void {
  owners.get(home)?.delete(key);
  beats.get(home)?.delete(key);
}

/** Whether code in this run holds `key` (its work began or was started again here, and hasn't ended, settled or waited). */
export function owned(home: string, key: string): boolean {
  return owners.get(home)?.has(key) === true;
}

/** How many of a row's steps are kept to tell getting further from reaching a step again (a step's words may change as it goes). */
const STEPS_KEPT = 30;

function fresh(kind: Kind, project: string, args: Record<string, unknown>, part: string, listed: Job | undefined, step?: string): Job {
  const now = nowMs();
  // One listed and still to do (a resumer starting it again, or a repeat) keeps its count; one that ended, failed or was given up starts over.
  const going = listed !== undefined && live(listed);
  const attempts = going ? listed.attempts : 0;
  // Started again after being put off: still counted as put off (its next wait, one at a time), until it gets further.
  const putOff = going && listed.put_off !== undefined ? { put_off: listed.put_off, ...(listed.crashy === true ? { crashy: true } : {}) } : {};
  // Its count of the same failure in a row and the steps it reached too (a Script import begins its row afresh on
  // each wake, which lost them, so its count never grew and every wake read as getting further).
  const same = going && typeof listed.args.same_count === "number" && args.same_count === undefined ? { same_why: listed.args.same_why, same_count: listed.args.same_count } : {};
  const steps = going && Array.isArray(listed.args.steps_seen) && args.steps_seen === undefined ? { steps_seen: listed.args.steps_seen } : {};
  return { key: keyOf(kind, project, part), kind, project, args: { ...args, ...same, ...steps }, state: "running", ...(step === undefined ? {} : { step }), attempts, ...putOff, started_ms: going ? listed.started_ms : now, updated_ms: now };
}

/**
 * Notes a job as running; returns its key. One already listed under its key
 * is replaced in place: a live one keeps its count, one that ended or was
 * given up starts its count over.
 */
export function begin(home: string | null, kind: Kind, project: string, args: Record<string, unknown>, part = "", step?: string): string {
  const key = keyOf(kind, project, part);
  if (home === null) return key;
  own(home, key);
  change(home, (jobs) => {
    const at = jobs.findIndex((job) => job.key === key);
    const job = fresh(kind, project, args, part, jobs[at], step);
    if (at < 0) jobs.push(job);
    else jobs[at] = job;
  });
  return key;
}

/** Crosses a job off: it ended (done with nothing to show, or cancelled). */
export function end(home: string | null, key: string): void {
  if (home === null) return;
  disown(home, key);
  change(home, (jobs) => {
    const at = jobs.findIndex((job) => job.key === key);
    if (at < 0) return false;
    jobs.splice(at, 1);
  });
}

/**
 * One step of a job finished and the next begins: its `step` and what it
 * made (`args`, merged) written before that next step starts, so a restart
 * picks it up from there. Nothing when the job isn't listed (it was cancelled).
 */
export function step(home: string | null, key: string, step: string, args: Record<string, unknown> = {}): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    own(home, key);
    // Getting further forgives its waits and restarts so far (verify.md finding 3: otherwise every blip waited longer):
    // a step this row has never reached before, not one it reaches again after a wait (Fable's last look, Nov 19: a
    // file the relay refused every time was tried every minute for good, each start's first step read as progress).
    const seen = Array.isArray(job.args.steps_seen) ? (job.args.steps_seen as unknown[]).filter((one): one is string => typeof one === "string") : [];
    if (!seen.includes(step)) {
      job.attempts = 0;
      delete job.put_off;
      delete job.crashy;
      delete job.args.same_why;
      delete job.args.same_count;
      job.args.steps_seen = [...seen, step].slice(-STEPS_KEPT);
    }
    job.step = step;
    job.state = "running";
    delete job.retry_at;
    delete job.until;
    delete job.why;
    Object.assign(job.args, args);
    job.updated_ms = nowMs();
  });
}

/** What a job is settled with. `retry_at` and `until` only for `waiting`: when, or on what, it's woken. */
export interface Settled {
  error?: string;
  build?: string;
  step?: string;
  args?: Record<string, unknown>;
  retry_at?: number;
  until?: "encoder" | "person";
}

/**
 * A job ends and is kept: `done` (what it did is shown), `failed` (its error
 * and build kept for a retry), or `waiting`: it carries on later by itself,
 * at the next start, at `retry_at`, or once the encoder is free (`until`), or
 * when the person answers (`until: "person"`; never woken by itself).
 */
export function settle(home: string | null, key: string, state: "done" | "failed" | "waiting", fields: Settled = {}): void {
  if (home === null) return;
  disown(home, key);
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    settled(job, state, fields);
  });
  if (state === "waiting" && fields.retry_at !== undefined) wakeAt(home, fields.retry_at);
}

function settled(job: Job, state: "done" | "failed" | "waiting", fields: Settled): void {
  job.state = state;
  delete job.retry_at;
  delete job.until;
  if (state === "waiting") {
    if (fields.retry_at !== undefined) job.retry_at = fields.retry_at;
    if (fields.until !== undefined) job.until = fields.until;
  }
  if (fields.step !== undefined) job.step = fields.step;
  if (fields.args !== undefined) Object.assign(job.args, fields.args);
  if (state === "failed") {
    job.error = fields.error ?? job.error ?? "failed";
    if (fields.build !== undefined) job.build = fields.build;
  } else {
    delete job.error;
    delete job.build;
  }
  delete job.retry;
  delete job.why;
  job.updated_ms = nowMs();
}

/**
 * Stopped by `error` (its words will do): waits and is tried again by itself as failure.ts says for what it is, a
 * passing failure after 1, 5 and 15 minutes then every 30, credit in half an hour, a full disk in five minutes; the
 * person's waits for them; Edit's own bug is failed (a new build tries it once). Nothing when it isn't listed
 * (cancelled). When it'll be tried, or null.
 */
export function wait(home: string | null, key: string, error: unknown, step?: string): number | null {
  if (home === null) return null;
  disown(home, key);
  return (
    change(home, (jobs) => {
      const job = jobs.find((one) => one.key === key);
      if (job === undefined) return false;
      const at = postpone(job, error);
      if (step !== undefined && job.state === "waiting") job.step = step;
      if (at !== null) wakeAt(home, at);
      return at;
    }) || null
  );
}

/** `wait`, by the name its callers had (exports' cloud copies, full-quality uploads, uploads): a passing failure's words. */
export const putOff = (home: string | null, key: string, why: string): number | null => wait(home, key, why);

/** The same failure, word for word, this many times in a row with nothing between: a refusal that's the same every time, so Edit's to fix (failure.ts `broken`). */
const SAME_TIMES = 4;

/**
 * Whether `error` counts toward `SAME_TIMES`: only words nothing recognises (and FFmpeg's "Invalid data found", a file
 * it can't read). A known network error, a full disk or a sign-in passes however often it comes, and a restart isn't a
 * failure at all (Fable's last look, Nov 19: a 21-minute outage failed an export's cloud copy for good on its fourth
 * try, and six kills in a row failed work on "cut short by 3 restarts", giving up for restarts again).
 */
function counts(error: unknown, why: string): boolean {
  if (why.startsWith("cut short")) return false;
  return /Invalid data found/i.test(why) || failure.surely(error) === null;
}

/** Work nobody is shown (an export's cloud copy, a share's full-quality file, a footage upload): never failed by the count, it goes on waiting its half hour. */
const UNSEEN: readonly Kind[] = ["archive", "full", "upload"];

function postpone(job: Job, error: unknown): number | null {
  const why = typeof error === "string" ? error : diag.messageOf(error);
  let kind = failure.kindOf(error);
  // Counted across its waits (not forgiven by a step: the same stage fails the same way each time it's reached).
  if (counts(error, why)) {
    const same = job.args.same_why === why.slice(0, 300) && typeof job.args.same_count === "number" ? job.args.same_count + 1 : 1;
    job.args.same_why = why.slice(0, 300);
    job.args.same_count = same;
    if (kind === "passing" && same >= SAME_TIMES && !UNSEEN.includes(job.kind)) kind = "broken";
  } else {
    delete job.args.same_why;
    delete job.args.same_count;
  }
  const times = job.put_off ?? 0;
  const now = nowMs();
  delete job.given_up;
  delete job.until;
  delete job.retry_at;
  job.updated_ms = now;
  job.why = why.slice(0, 300);
  if (kind === "broken") {
    job.state = "failed";
    job.error = why.slice(0, 300);
    diag.warn("jobs", `${job.key}: ${why}; it needs a fix in Edit (a new build tries it again)`);
    return null;
  }
  delete job.error;
  delete job.build;
  job.state = "waiting";
  job.put_off = times + 1;
  // Only an import shows the person a question (its file); anything else that reads as the person's (an upload of a
  // file gone, a 403) is looked at again in half an hour, never parked where nobody is asked (verify.md finding 6).
  if (kind === "person" && job.kind === "case") {
    job.until = "person";
    diag.warn("jobs", `${job.key}: ${why}; waiting for the person`);
    return null;
  }
  // Waiting for room: the bytes it needs are kept, so the table looks at the disk before starting it again (`due`),
  // never redoing the work every five minutes into a full disk (verify.md finding 5).
  const needs = roomNeeded(error);
  if (kind === "room" && needs > 0) job.args.room_bytes = needs;
  else delete job.args.room_bytes;
  const at = failure.nextTry(kind, times, now, error);
  if (at === null) {
    job.until = "encoder";
    diag.warn("jobs", `${job.key}: ${why}; waiting for the encoder`);
    return null;
  }
  job.retry_at = at;
  diag.warn("jobs", `${job.key}: ${why} (${kind}); trying it again by itself at ${new Date(at).toISOString()}`);
  return at;
}

/**
 * One job hands over to the next in one write, so no crash falls between
 * them (an export to its archive, a share to its full-quality upload): `from`
 * crossed off, or kept as `done` when `keep` says so; the next begun.
 */
export function handOff(home: string | null, from: string, next: { kind: Kind; project: string; args: Record<string, unknown>; part?: string; step?: string }, keep?: { state: "done"; step?: string; args?: Record<string, unknown> }): string {
  const key = keyOf(next.kind, next.project, next.part ?? "");
  if (home === null) return key;
  disown(home, from);
  own(home, key);
  change(home, (jobs) => {
    const at = jobs.findIndex((job) => job.key === from);
    if (at >= 0) {
      if (keep === undefined) jobs.splice(at, 1);
      else settled(jobs[at]!, keep.state, keep);
    }
    const listed = jobs.findIndex((job) => job.key === key);
    const job = fresh(next.kind, next.project, next.args, next.part ?? "", jobs[listed], next.step);
    if (listed < 0) jobs.push(job);
    else jobs[listed] = job;
  });
  return key;
}

/** A job that got further this run than the last (a big upload sending parts past those already up): its restarts so far don't count against it. */
export function progressed(home: string | null, key: string): void {
  if (home === null) return;
  // Getting further is moving: noted as a beat too, so an hour's upload never reads as still.
  beat(home, key);
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined || (!(job.attempts > 0) && job.put_off === undefined && job.args.same_count === undefined)) return false;
    job.attempts = 0;
    delete job.put_off;
    delete job.crashy;
    // Getting further isn't the same failure in a row.
    delete job.args.same_why;
    delete job.args.same_count;
  });
}

/** Still going (a turn's minute, an idea's lease): its time noted, and as it got further, its restarts so far forgiven. */
export function touch(home: string | null, key: string): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    own(home, key);
    job.updated_ms = nowMs();
    job.attempts = 0;
    delete job.put_off;
    delete job.crashy;
  });
}

/** When each row's beat was last written, by data folder (`beat`). */
const beats = new Map<string, Map<string, number>>();
/** A beat is written at most this often per row: the row says it's moving without a disk write per byte. */
export const BEAT_MS = { value: 30_000 };

/**
 * Still moving (bytes coming down, a percent): its time noted, at most every `BEAT_MS` per row, so a row that works
 * for an hour never reads as still (`still`). Nothing else changes: its counts are forgiven only by a new step.
 */
export function beat(home: string | null, key: string): void {
  if (home === null) return;
  const now = nowMs();
  let last = beats.get(home);
  if (last === undefined) beats.set(home, (last = new Map()));
  if (now - (last.get(key) ?? 0) < BEAT_MS.value) return;
  last.set(key, now);
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined || job.state !== "running") return false;
    own(home, key);
    job.updated_ms = now;
  });
}

/** Adds what a job made to its args (a durable remote receipt), without touching its count. */
export function patch(home: string | null, key: string, args: Record<string, unknown>): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    Object.assign(job.args, args);
  });
}

/** Marks or clears a failed job's retry on `build` (retry_after_update.ts). */
export function queueRetry(home: string, key: string, build: string | null): void {
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined || job.state !== "failed") return false;
    if (build === null) delete job.retry;
    else job.retry = build;
  });
}

/** One job, by key. */
export function get(home: string | null, key: string): Job | undefined {
  if (home === null) return undefined;
  return read(home).find((job) => job.key === key);
}

/** The jobs listed, of a kind when given. */
export function list(home: string | null, kind?: Kind): Job[] {
  if (home === null) return [];
  const all = read(home);
  return kind === undefined ? all : all.filter((job) => job.kind === kind);
}

/**
 * The jobs the last run left unfinished, to start again: each stays listed,
 * its count raised and saved before it's handed back, so a crash while they
 * start counts too. One cut short too often is marked given up instead
 * (kept, said, not handed back). Only `kinds`, when given.
 */
export function takeOver(home: string, kinds?: readonly Kind[]): Job[] {
  const out: Job[] = [];
  const gaveUp: Job[] = [];
  // Edit restarted itself on purpose (an update): the jobs it cut aren't failing, and aren't counted.
  const planned = wasPlanned(home);
  const kept = kinds === undefined ? held(home) : [];
  change(home, (jobs) => {
    let changed = false;
    for (const job of jobs) {
      // Given up for restarts by an older build (Marc's archive, Nov 18): waits now, tried again in a minute by itself.
      if (job.state === "given_up" && job.kind !== "turn" && (job.given_up ?? "").startsWith("cut short by") && (kinds === undefined || kinds.includes(job.kind))) {
        postpone(job, job.given_up ?? "given up");
        job.retry_at = nowMs() + failure.scaled(60_000);
        job.crashy = true;
        changed = true;
        continue;
      }
      if (!live(job) || (kinds !== undefined && !kinds.includes(job.kind)) || kept.includes(job.kind)) continue;
      // Waiting on a time, the encoder or the person: not cut short by the restart; woken when it's due (`wake`).
      if (asleep(job)) continue;
      changed = true;
      if (planned) {
        out.push(job);
      } else if (job.attempts >= IN_A_ROW && job.kind !== "turn") {
        // Its count stays: cut short again once it's woken, it waits again at once, a little longer, one at a time.
        postpone(job, `cut short by ${job.attempts + 1} restarts in a row`);
        job.crashy = true;
      } else if (job.attempts >= IN_A_ROW) {
        // An agent's turn: ended, with its line in the chat (`whenGivenUp`); the person sends again.
        job.state = "given_up";
        job.given_up = `cut short by ${job.attempts + 1} restarts in a row`;
        gaveUp.push(job);
        diag.warn("jobs", `${job.key} was cut short ${job.attempts + 1} times; not starting it again (kept; unstick starts it again)`);
      } else {
        job.attempts += 1;
        out.push(job);
      }
    }
    return changed;
  });
  for (const job of gaveUp) {
    try {
      givingUp.get(home)?.[job.kind]?.(job);
    } catch (error) {
      diag.warn("jobs", `telling ${job.key} was given up: ${diag.messageOf(error)}`);
    }
  }
  return out;
}

/** Told as a kind's job is given up (`takeOver`), by data folder: its owner says so where the person looks (a turn: its chat). */
const givingUp = new Map<string, Partial<Record<Kind, (job: Job) => void>>>();

/** `tell` hears of each `kind` job in `home` given up from now on (the last one registered for the kind). */
export function whenGivenUp(home: string, kind: Kind, tell: (job: Job) => void): void {
  givingUp.set(home, { ...givingUp.get(home), [kind]: tell });
}

/** How long a planned restart's note counts: an exec takes seconds; an older note is a restart that never happened. */
const PLANNED_MS = 5 * 60_000;

function restartNote(home: string): string {
  return join(home, "restart.json");
}

/**
 * Noted just before Edit restarts itself on purpose (an update, remote
 * support's restart), after the work that could be stopped cleanly was: the
 * next start carries every job on without counting the restart against it.
 */
export function plannedRestart(home: string): void {
  writeAtomic(restartNote(home), JSON.stringify({ at: Date.now(), pid: process.pid }));
}

/** Whether this start follows a planned restart (read once, then forgotten). */
function wasPlanned(home: string): boolean {
  const path = restartNote(home);
  let at = 0;
  try {
    at = Number((JSON.parse(fs.readFileSync(path, "utf8")) as { at?: unknown }).at ?? 0);
    fs.rmSync(path, { force: true });
  } catch {
    return false;
  }
  return Date.now() - at < PLANNED_MS;
}

/** A waiting job with something to wait for (a time, the encoder, the person): `wake` starts it, never a restart. */
function asleep(job: Job): boolean {
  return job.state === "waiting" && (job.retry_at !== undefined || job.until !== undefined);
}

/** Whether a sleeping job is due: its time has come, or the encoder it waits for is free, and the room it waits for is there. */
function due(job: Job, now: number): boolean {
  if (!asleep(job)) return false;
  if (job.until === "person") return false;
  if (job.until === "encoder" && encoder.busy()) return false;
  if (!(job.retry_at === undefined || job.retry_at <= now)) return false;
  const bytes = job.args.room_bytes;
  return typeof bytes !== "number" || bytes <= 0 || roomCheck.has(bytes);
}

/** How many bytes a `NoRoom` failure (or its cause) says it needs; 0 when it doesn't say. */
function roomNeeded(error: unknown): number {
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    if (at instanceof failure.NoRoom) return at.needBytes;
  }
  return 0;
}

/** Whether there's room now for `bytes` (serve.ts sets it from storage.ts; without it, there always is). */
export const roomCheck = { has: (_bytes: number): boolean => true };

/**
 * The waiting jobs that are due, marked running and handed back (their count
 * untouched: nothing cut them short). Only `kinds`, when given.
 */
export function dueNow(home: string, kinds?: readonly Kind[]): Job[] {
  const out: Job[] = [];
  const now = nowMs();
  const kept = held(home);
  change(home, (jobs) => {
    // Work put off for restarts in a row goes one at a time (it may be what brings the server down): none while
    // another is under way (noted lately), and one a round. Work that waited on a failure goes when it's due.
    let putOffGoing = jobs.some((job) => job.state === "running" && job.crashy === true && now - job.updated_ms < PUT_OFF_RUN_MS);
    for (const job of jobs) {
      if (!due(job, now) || (kinds !== undefined && !kinds.includes(job.kind)) || kept.includes(job.kind)) continue;
      if (job.crashy === true) {
        if (putOffGoing) continue;
        putOffGoing = true;
      }
      // Its step stays what it was: the resumer carries on from it, and reaching it again isn't getting further.
      job.state = "running";
      delete job.retry_at;
      delete job.until;
      delete job.why;
      job.updated_ms = now;
      out.push(job);
    }
    return out.length > 0;
  });
  return out;
}

/**
 * The trouble is over (the relay or R2 answered again, the machine woke with its sign-in renewed): every job waiting
 * on something that passes is due now, a few seconds apart, and woken. Nobody waits half an hour because the Wi-Fi
 * came back a minute after a try. Returns the keys woken.
 */
export function wakePassing(home: string, why: string): string[] {
  const now = nowMs();
  const keys: string[] = [];
  // The times of those after the first, a few seconds apart (the first goes now).
  const later: number[] = [];
  // The same kind of signal again within seconds wakes nothing it just woke (Nov 20: twelve sign-ins in six seconds
  // tried a refused recording 80 ms apart and spent its schedule). Another kind of signal still wakes it at once.
  const signal = signalOf(why);
  let woken = lastWoken.get(home);
  if (woken === undefined) lastWoken.set(home, (woken = new Map()));
  for (const [key, at] of woken) if (now - at.at >= WAKE_AGAIN_MS()) woken.delete(key);
  change(home, (jobs) => {
    for (const job of jobs) {
      if (job.state !== "waiting" || job.retry_at === undefined || job.retry_at <= now) continue;
      if (woken.get(job.key)?.signal === signal) continue;
      // What it waits on: its put-off reason, or the import's own word for it (`waiting_on`); a wait with neither (credit, Drive's day) is left.
      const on = typeof job.args.waiting_on === "string" ? job.args.waiting_on : undefined;
      const said = job.why ?? on;
      if (said === undefined) continue;
      const kind = job.why === undefined ? (on === "passing" ? "passing" : "other") : failure.kindOf(said);
      if (kind !== "passing" && kind !== "signin") continue;
      job.retry_at = now + keys.length * failure.scaled(3_000);
      if (keys.length > 0) later.push(job.retry_at);
      keys.push(job.key);
    }
    return keys.length > 0;
  });
  for (const key of keys) woken.set(key, { signal, at: now });
  if (keys.length > 0) diag.info("jobs", `${why}: ${keys.length} waiting job${keys.length === 1 ? "" : "s"} woken (${keys.join(", ")})`);
  // Each one after the first gets its timer as its time comes (Nov 21, audit I15.a: they had a time and no timer, so
  // went up to 30 s late at the table's next look). `wakeAt` keeps one timer a data folder, the soonest, so the next
  // is asked for once the one before it has gone.
  const arm = (left: number[]): void => {
    const at = left[0];
    if (at === undefined) return;
    wakeAt(home, at);
    if (left.length === 1) return;
    const next = setTimeout(() => arm(left.slice(1)), Math.max(at - nowMs(), 0) + 100);
    next.unref?.();
  };
  arm(later);
  // Also what fell due since the table's last look (a try due a few seconds ago waited for the next 30-second tick:
  // the bad-day wifi-drop-editor-import case, done 29 s after the line came back).
  void wake(home).catch((error: unknown) => diag.warn("jobs", `waking waiting jobs: ${diag.messageOf(error)}`));
  return keys;
}

/** What a job was last woken by (`wakePassing`), and when, by data folder. */
const lastWoken = new Map<string, Map<string, { signal: string; at: number }>>();

/**
 * A job woken by a kind of signal isn't woken by the same kind again for this long: longer than a storm of one
 * signal (a sign-in renewed a dozen times in six seconds), much shorter than the passing schedule's first minute, so
 * a line that drops and comes back twice a few seconds apart still gets its job going the second time, at worst at
 * its own minute. Nothing to do with the line's speed; after a lid close the wake is a new kind of signal.
 */
const WAKE_AGAIN_MS = (): number => Math.max(failure.scaled(10_000), 1_000);

/** The kind of a waking signal, from its words: the machine woke (whatever it slept), signed in, or which service answers again. */
function signalOf(why: string): string {
  if (why.startsWith("the machine woke")) return "woke";
  return why;
}

/** How often the waiting jobs are looked at (a quota's 30 min, an export's end). */
export const WAKE_MS = { value: 30_000 };

/** The soonest try a timer is set for, by data folder. */
const soonest = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

/**
 * A wait falls due sooner than the table's next look: a timer for it, so it goes when it's due, not up to a look
 * later (bad-day wifi-drop-editor-import, Nov 19: a file that failed as the line came back waited 26 s for the tick).
 */
function wakeAt(home: string, at: number): void {
  const wait = at - nowMs();
  if (wait >= WAKE_MS.value || !registered.has(home)) return;
  const set = soonest.get(home);
  if (set !== undefined && set.at <= at) return;
  if (set !== undefined) clearTimeout(set.timer);
  const timer = setTimeout(() => {
    soonest.delete(home);
    void wake(home).catch((error: unknown) => diag.warn("jobs", `waking waiting jobs: ${diag.messageOf(error)}`));
  }, Math.max(wait, 0) + 50);
  timer.unref?.();
  soonest.set(home, { at, timer });
}
const waking = new Map<string, ReturnType<typeof setInterval>>();

/** What waking waits for first, by data folder: the sign-in's renewal after the machine woke (serve.ts). */
const holds = new Map<string, Promise<unknown>>();

/** The table's waking waits for `until` (a wake's renewal) before it starts anything that fell due meanwhile. */
export function holdWaking(home: string, until: Promise<unknown>): void {
  const held = until.catch(() => undefined).finally(() => {
    if (holds.get(home) === held) holds.delete(home);
  });
  holds.set(home, held);
}

/** Starts the waiting jobs that are due now (the timer does this every `WAKE_MS`; tests call it). */
export async function wake(home: string, kinds?: readonly Kind[]): Promise<void> {
  const held = holds.get(home);
  if (held !== undefined) await held;
  const resumers = registered.get(home);
  if (resumers === undefined) return Promise.resolve();
  const list = dueNow(home, kinds);
  if (list.length === 0) return Promise.resolve();
  return startAll(home, list, resumers, "waited");
}

/** Wakes the waiting jobs as they fall due, from now until Edit quits. */
function keepWaking(home: string): void {
  if (waking.has(home)) return;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    // Late by more than a beat: the machine slept or was frozen. The wake's own listener renews the sign-in first and
    // then wakes what fell due (serve.ts); this tick leaves it to that, so nothing goes before the token is back.
    if (gap > WAKE_MS.value * 2 + 10_000) return;
    try {
      cutShortUnowned(home);
      still(home);
    } catch (error) {
      diag.warn("jobs", `looking for rows nothing is moving: ${diag.messageOf(error)}`);
    }
    void wake(home).catch((error: unknown) => diag.warn("jobs", `waking waiting jobs: ${diag.messageOf(error)}`));
  }, WAKE_MS.value);
  timer.unref?.();
  waking.set(home, timer);
}

/**
 * A row said running that nothing in this run holds is put to wait after this long since it was last noted: no code
 * holds it, so nothing can be moving it, and minutes are enough to be sure (a resumer's queue owns every row it was
 * handed from the start, however long the queue is). Its wait then follows the passing schedule, the first try a
 * minute on. Nothing to do with the line or a lid close: a held row is never taken, however slow, and after a wake
 * a row nobody holds is as still as before it.
 */
export const UNOWNED_MS = { value: 5 * 60_000 };

/** Rows nothing in this run holds that say running (Nov 20): put to wait, tried again by themselves. Returns their keys. */
export function cutShortUnowned(home: string, now = nowMs()): string[] {
  const kept = held(home);
  const keys: string[] = [];
  change(home, (jobs) => {
    for (const job of jobs) {
      // An agent's turn is carried on only within minutes of a restart (agent.ts): its own minute's note holds it.
      if (job.state !== "running" || job.kind === "turn" || kept.includes(job.kind) || owned(home, job.key)) continue;
      if (now - job.updated_ms < failure.scaled(UNOWNED_MS.value)) continue;
      postpone(job, "cut short: nothing was running");
      keys.push(job.key);
    }
    return keys.length > 0;
  });
  if (keys.length > 0) diag.warn("jobs", `${keys.length} row${keys.length === 1 ? "" : "s"} said running with nothing running, put to wait (${keys.join(", ")})`);
  return keys;
}

/** A running row with nothing noted for this long is reported (remote_actions.ts selfCheck, the log): it only says so. */
export const STILL_MS = { value: 15 * 60_000 };
/** The rows already said in the log as still, with the time they were last noted: said again only once they moved. */
const saidStill = new Map<string, Map<string, number>>();

/**
 * The running rows nothing has noted for `STILL_MS` (a step, a beat), oldest first; each logged once as it crosses
 * the line. It stops nothing: slow isn't stuck, and the row's owner is the one to end it.
 */
export function still(home: string | null, now = nowMs()): Job[] {
  if (home === null) return [];
  const rows = read(home)
    .filter((job) => job.state === "running" && now - job.updated_ms > STILL_MS.value)
    .sort((a, b) => a.updated_ms - b.updated_ms);
  let said = saidStill.get(home);
  if (said === undefined) saidStill.set(home, (said = new Map()));
  for (const job of rows) {
    if (said.get(job.key) === job.updated_ms) continue;
    said.set(job.key, job.updated_ms);
    diag.warn("jobs", `${stillLine(job, now)}${owned(home, job.key) ? "" : " (nothing holds it)"}`);
  }
  for (const key of said.keys()) if (!rows.some((job) => job.key === key)) said.delete(key);
  return rows;
}

/** A still row's line: "Job export:p1: running, nothing noted for 20 min (step uploading)". */
export function stillLine(job: Job, now = nowMs()): string {
  return `Job ${job.key}: running, nothing noted for ${Math.round((now - job.updated_ms) / 60_000)} min${job.step === undefined ? "" : ` (step ${job.step})`}`;
}

// ---------------------------------------------------------------- held

/**
 * Work an admin held back (remote_control.ts; Sphe, Nov 15: "because of this
 * particular issue we don't want exports or agent threads or imports to
 * continue"): its kinds aren't started again after a restart, nor woken,
 * until `release`. Kept in `<home>/held-work.json` across restarts.
 */
export function held(home: string): Kind[] {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, "held-work.json"), "utf8")) as { kinds?: unknown };
    return Array.isArray(value.kinds) ? value.kinds.filter((kind): kind is Kind => typeof kind === "string") : [];
  } catch {
    return [];
  }
}

/** Holds `kinds` back from now (added to what's held), or nothing more. */
export function hold(home: string, kinds: readonly Kind[]): Kind[] {
  const next = [...new Set([...held(home), ...kinds])];
  writeAtomic(join(home, "held-work.json"), JSON.stringify({ kinds: next, at: nowMs() }));
  return next;
}

/** Lets what was held go: its jobs started now (this run's resumers), and nothing held any more. The kinds that were held. */
export async function release(home: string): Promise<Kind[]> {
  const kinds = held(home);
  fs.rmSync(join(home, "held-work.json"), { force: true });
  const resumers = registered.get(home);
  if (kinds.length > 0 && resumers !== undefined) await startAll(home, takeOver(home, kinds), resumers);
  return kinds;
}

/** The jobs not started again any more (cut short too often), for the diagnostics. */
export function givenUp(home: string | null): Job[] {
  if (home === null) return [];
  return read(home).filter((job) => job.state === "given_up");
}

/** The jobs put off, waiting to be tried again by themselves (`putOff`), for the diagnostics. */
export function putOffNow(home: string | null): Job[] {
  if (home === null) return [];
  return read(home).filter((job) => job.state === "waiting" && job.put_off !== undefined);
}

/** What starts each kind again; a handler that throws is logged and skipped (the job stays listed), one that throws `Gone` crosses it off. */
export type Resumers = Partial<Record<Kind, (job: Job) => Promise<void> | void>>;

/** A resumer that hasn't come back in this long is left to it, and the next is started (one hanging used to hold up every other). */
export const RESUME_MS = { value: 60_000 };

/** The resumers this run was started with, by data folder, so unstick can start given-up jobs without a restart. */
const registered = new Map<string, Resumers>();

/**
 * Starts the rows handed over. Those that may be what brings the server down (put off for restarts in a row, or cut
 * short by two in a row) go one at a time, after the rest have started; the rest start together, none waiting on
 * another's work (Nov 21: after a wake each was given up to `RESUME_MS` in turn, and an archive's resumer waits on its
 * whole cloud copy, minutes on an 8 Mbit/s line: a Script import behind three of them started three minutes late).
 */
function startAll(home: string, list: Job[], resumers: Resumers, why: "restart" | "waited" = "restart"): Promise<void> {
  // Every row handed over is held from now, the last in the queue too (each before it may take up to `RESUME_MS`).
  for (const job of list) if (resumers[job.kind] !== undefined) own(home, job.key);
  const one = (job: Job) => {
    const run = resumers[job.kind];
    if (run === undefined) return Effect.void;
    return Effect.logInfo(`starting ${job.key} again${job.step ? ` from ${job.step}` : ""} (${why === "restart" ? "cut short by a restart" : "its wait is over"})`).pipe(
      Effect.andThen(Effect.promise(() => started(home, job, run))),
    );
  };
  const alone = (job: Job) => job.crashy === true || job.attempts >= IN_A_ROW;
  return runPromise(
    Effect.forEach(list.filter((job) => !alone(job)), one, { discard: true, concurrency: "unbounded" }).pipe(
      Effect.andThen(Effect.forEach(list.filter(alone), one, { discard: true })),
      inArea("jobs"),
    ),
  );
}

/**
 * Runs one resumer; still starting after `RESUME_MS`, it's left to it and the next goes on, its failure, however
 * late, settled all the same (Nov 20: one past the minute that then failed left its row "running" for the run).
 */
async function started(home: string, job: Job, run: (job: Job) => Promise<void> | void): Promise<void> {
  const going = (async () => run(job))();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), RESUME_MS.value)));
  const outcome = await Promise.race([going.then(() => "done" as const, (error: unknown) => ({ error })), late]);
  clearTimeout(timer);
  if (outcome === "done") return;
  if (outcome === "late") {
    diag.warn("jobs", `${job.key} is still starting after ${Math.round(RESUME_MS.value / 1000)} s; the others go on`);
    going.catch((error: unknown) => failedToStart(home, job, error));
    return;
  }
  failedToStart(home, job, outcome.error);
}

/** A resumer failed: crossed off when what it needs is `Gone`, else it waits by what it is (a turn is kept for the next start). */
function failedToStart(home: string, job: Job, error: unknown): void {
  try {
    const cause = error instanceof Error && !(error instanceof Gone) && (error as { cause?: unknown }).cause !== undefined ? (error as { cause?: unknown }).cause : error;
    if (cause instanceof Gone) {
      end(home, job.key);
      diag.info("jobs", `not starting ${job.key} again: ${cause.message}`);
      return;
    }
    // Failed as it starts (an outage, a sign-in lapse, a full disk): waits by what it is and is tried again by itself.
    if (job.kind !== "turn") {
      wait(home, job.key, cause);
      return;
    }
    disown(home, job.key);
    diag.warn("jobs", `couldn't start ${job.key} again (kept for the next start): ${diag.messageOf(cause)}`);
  } catch (failed) {
    diag.warn("jobs", `settling ${job.key} after its start failed: ${diag.messageOf(failed)}`);
  }
}

/**
 * Starts again what the last run left unfinished (together, but for work cut
 * short by restarts in a row: `startAll`): a handler that fails is logged and
 * skipped (its job kept), one still starting after `RESUME_MS` is left
 * running. Only `kinds`, when given (tests).
 */
export function resume(home: string, resumers: Resumers, kinds?: readonly Kind[]): Promise<void> {
  if (kinds === undefined) {
    registered.set(home, resumers);
    keepWaking(home);
  }
  const taken = takeOver(home, kinds);
  // A wait already there as this run starts (left by the last one, or set just now for work cut short by restarts in a
  // row) gets its timer too when it's due before the table's next look (Nov 21: `wakeAt` was only asked as a wait was
  // set with resumers in, so such a row went up to 30 s late).
  const soon = read(home).reduce((least, job) => (asleep(job) && job.retry_at !== undefined && job.retry_at < least ? job.retry_at : least), Number.POSITIVE_INFINITY);
  if (Number.isFinite(soon)) wakeAt(home, soon);
  return startAll(home, taken, resumers);
}

/** The resumers registered for `home` (tests register theirs to wake waiting jobs). */
export function useResumers(home: string, resumers: Resumers): void {
  registered.set(home, resumers);
}

/**
 * Unstick: the given-up jobs and those put off, their counts cleared and
 * started again (now if this run's resumers are in; otherwise the start-up
 * resume picks them up). Returns their keys.
 */
export function startGivenUp(home: string | null): { keys: string[]; started: Promise<void> } {
  if (home === null) return { keys: [], started: Promise.resolve() };
  const revived: Job[] = [];
  change(home, (jobs) => {
    for (const job of jobs) {
      if (job.state !== "given_up" && !(job.state === "waiting" && job.put_off !== undefined)) continue;
      delete job.given_up;
      delete job.retry_at;
      delete job.put_off;
      delete job.crashy;
      delete job.why;
      job.state = "running";
      job.attempts = 0;
      revived.push(job);
    }
    return revived.length > 0;
  });
  if (revived.length === 0) return { keys: [], started: Promise.resolve() };
  const resumers = registered.get(home);
  return { keys: revived.map((job) => job.key), started: resumers === undefined ? Promise.resolve() : startAll(home, revived, resumers) };
}
