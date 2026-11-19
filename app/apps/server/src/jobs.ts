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
  | "writer";

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

/** An entry as written by any build: older ones had `resumes` and no state. */
function normal(raw: Record<string, unknown>): Job {
  const job = raw as unknown as Job & { resumes?: number };
  const attempts = typeof job.attempts === "number" ? job.attempts : typeof job.resumes === "number" ? job.resumes : 0;
  const state: State = typeof job.state === "string" ? job.state : job.given_up !== undefined ? "given_up" : "running";
  const started = typeof job.started_ms === "number" ? job.started_ms : 0;
  const { resumes: _old, ...rest } = job;
  return { ...rest, args: typeof rest.args === "object" && rest.args !== null ? rest.args : {}, state, attempts, started_ms: started, updated_ms: typeof job.updated_ms === "number" ? job.updated_ms : started };
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

function fresh(kind: Kind, project: string, args: Record<string, unknown>, part: string, listed: Job | undefined, step?: string): Job {
  const now = nowMs();
  // One listed and still to do (a resumer starting it again, or a repeat) keeps its count; one that ended, failed or was given up starts over.
  const going = listed !== undefined && live(listed);
  const attempts = going ? listed.attempts : 0;
  // Started again after being put off: still counted as put off (its next wait, one at a time), until it gets further.
  const putOff = going && listed.put_off !== undefined ? { put_off: listed.put_off } : {};
  return { key: keyOf(kind, project, part), kind, project, args, state: "running", ...(step === undefined ? {} : { step }), attempts, ...putOff, started_ms: going ? listed.started_ms : now, updated_ms: now };
}

/**
 * Notes a job as running; returns its key. One already listed under its key
 * is replaced in place: a live one keeps its count, one that ended or was
 * given up starts its count over.
 */
export function begin(home: string | null, kind: Kind, project: string, args: Record<string, unknown>, part = "", step?: string): string {
  const key = keyOf(kind, project, part);
  if (home === null) return key;
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
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    settled(job, state, fields);
  });
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
export function wait(home: string | null, key: string, error: unknown): number | null {
  if (home === null) return null;
  return (
    change(home, (jobs) => {
      const job = jobs.find((one) => one.key === key);
      if (job === undefined) return false;
      return postpone(job, error);
    }) || null
  );
}

/** `wait`, by the name its callers had (exports' cloud copies, full-quality uploads, uploads): a passing failure's words. */
export const putOff = (home: string | null, key: string, why: string): number | null => wait(home, key, why);

function postpone(job: Job, error: unknown): number | null {
  const why = typeof error === "string" ? error : diag.messageOf(error);
  const kind = failure.kindOf(error);
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
  if (kind === "person") {
    job.until = "person";
    diag.warn("jobs", `${job.key}: ${why}; waiting for the person`);
    return null;
  }
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
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined || (!(job.attempts > 0) && job.put_off === undefined)) return false;
    job.attempts = 0;
    delete job.put_off;
  });
}

/** Still going (a turn's minute, an idea's lease): its time noted, and as it got further, its restarts so far forgiven. */
export function touch(home: string | null, key: string): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    job.updated_ms = nowMs();
    job.attempts = 0;
    delete job.put_off;
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
        // Its count stays: cut short again once it's woken, it waits again at once, a little longer.
        postpone(job, `cut short by ${job.attempts + 1} restarts in a row`);
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

/** Whether a sleeping job is due: its time has come, or the encoder it waits for is free. */
function due(job: Job, now: number): boolean {
  if (!asleep(job)) return false;
  if (job.until === "person") return false;
  if (job.until === "encoder" && encoder.busy()) return false;
  return job.retry_at === undefined || job.retry_at <= now;
}

/**
 * The waiting jobs that are due, marked running and handed back (their count
 * untouched: nothing cut them short). Only `kinds`, when given.
 */
export function dueNow(home: string, kinds?: readonly Kind[]): Job[] {
  const out: Job[] = [];
  const now = nowMs();
  const kept = held(home);
  change(home, (jobs) => {
    // Work put off goes one at a time: none while another put off is under way (noted lately), and one a round.
    let putOffGoing = jobs.some((job) => job.state === "running" && job.put_off !== undefined && now - job.updated_ms < PUT_OFF_RUN_MS);
    for (const job of jobs) {
      if (!due(job, now) || (kinds !== undefined && !kinds.includes(job.kind)) || kept.includes(job.kind)) continue;
      if (job.put_off !== undefined) {
        if (putOffGoing) continue;
        putOffGoing = true;
      }
      job.state = "running";
      job.step = "trying again";
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
  change(home, (jobs) => {
    for (const job of jobs) {
      if (job.state !== "waiting" || job.retry_at === undefined || job.retry_at <= now) continue;
      // What it waits on: its put-off reason, or the import's own word for it (`waiting_on`); a wait with neither (credit, Drive's day) is left.
      const on = typeof job.args.waiting_on === "string" ? job.args.waiting_on : undefined;
      const said = job.why ?? on;
      if (said === undefined) continue;
      const kind = job.why === undefined ? (on === "passing" ? "passing" : "other") : failure.kindOf(said);
      if (kind !== "passing" && kind !== "signin") continue;
      job.retry_at = now + keys.length * failure.scaled(3_000);
      keys.push(job.key);
    }
    return keys.length > 0;
  });
  if (keys.length > 0) {
    diag.info("jobs", `${why}: ${keys.length} waiting job${keys.length === 1 ? "" : "s"} woken (${keys.join(", ")})`);
    void wake(home).catch((error: unknown) => diag.warn("jobs", `waking waiting jobs: ${diag.messageOf(error)}`));
  }
  return keys;
}

/** How often the waiting jobs are looked at (a quota's 30 min, an export's end). */
export const WAKE_MS = { value: 30_000 };
const waking = new Map<string, ReturnType<typeof setInterval>>();

/** Starts the waiting jobs that are due now (the timer does this every `WAKE_MS`; tests call it). */
export function wake(home: string, kinds?: readonly Kind[]): Promise<void> {
  const resumers = registered.get(home);
  if (resumers === undefined) return Promise.resolve();
  const list = dueNow(home, kinds);
  if (list.length === 0) return Promise.resolve();
  return startAll(home, list, resumers, "waited");
}

/** Wakes the waiting jobs as they fall due, from now until Edit quits. */
function keepWaking(home: string): void {
  if (waking.has(home)) return;
  const timer = setInterval(() => void wake(home).catch((error: unknown) => diag.warn("jobs", `waking waiting jobs: ${diag.messageOf(error)}`)), WAKE_MS.value);
  timer.unref?.();
  waking.set(home, timer);
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

function startAll(home: string, list: Job[], resumers: Resumers, why: "restart" | "waited" = "restart"): Promise<void> {
  return runPromise(
    Effect.forEach(
      list,
      (job) => {
        const run = resumers[job.kind];
        if (run === undefined) return Effect.void;
        return Effect.logInfo(`starting ${job.key} again${job.step ? ` from ${job.step}` : ""} (${why === "restart" ? "cut short by a restart" : "its wait is over"})`).pipe(
          Effect.andThen(Effect.tryPromise(async () => run(job))),
          Effect.timeoutOrElse({ duration: RESUME_MS.value, orElse: () => Effect.logWarning(`${job.key} is still starting after ${Math.round(RESUME_MS.value / 1000)} s; the others go on`) }),
          Effect.catch((error) => {
            const cause = error instanceof Error && !(error instanceof Gone) && (error as { cause?: unknown }).cause !== undefined ? (error as { cause?: unknown }).cause : error;
            if (cause instanceof Gone) {
              return Effect.sync(() => end(home, job.key)).pipe(Effect.andThen(Effect.logInfo(`not starting ${job.key} again: ${cause.message}`)));
            }
            // Failed as it starts (an outage, a sign-in lapse, a full disk): waits by what it is and is tried again by itself.
            if (job.kind !== "turn") return Effect.sync(() => void wait(home, job.key, cause));
            return Effect.logWarning(`couldn't start ${job.key} again (kept for the next start): ${diag.messageOf(cause)}`);
          }),
        );
      },
      { discard: true },
    ).pipe(inArea("jobs")),
  );
}

/**
 * Starts again what the last run left unfinished, one after another: a
 * handler that fails is logged and skipped (its job kept), one still
 * starting after `RESUME_MS` is left running and the next goes on. Only
 * `kinds`, when given (tests).
 */
export function resume(home: string, resumers: Resumers, kinds?: readonly Kind[]): Promise<void> {
  if (kinds === undefined) {
    registered.set(home, resumers);
    keepWaking(home);
  }
  return startAll(home, takeOver(home, kinds), resumers);
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
