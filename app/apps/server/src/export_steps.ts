// An export's steps and how long each has left (Sphe, Nov 17): what the
// Export dialog's list and the Exports queue show, from the moment Export is
// pressed, graphics renders included. One model for both pages: the queue's
// rows (`activity`, GET /api/exports/activity) each carry their `steps`, and
// the dialog reads its project's row.
//
// The order is what an export really does: the graphics its edit shows that
// weren't rendered from their code yet (effects.ts `noteWait`), the video,
// then where it goes: saved to the exports folder, or for a share the review
// copy and its upload to the review link. Each time comes from this computer's
// own measured speeds (export_speeds.ts) and, once a step is under way, its
// own pace; a step with no basis has no time, and then neither has the whole.
// Times are smoothed: they count down between looks, and move toward a new
// estimate gradually, rising only when the estimate really does.

import type { ExportStep, ExportSteps } from "@edit/types/export_steps";

import type { App } from "./app.ts";
import * as effects from "./effects.ts";
import * as removalSchedule from "./removal_schedule.ts";
import * as speeds from "./export_speeds.ts";
import { JOINING, MIXING, reviewBytes, stall as exportsStall, type ExportActivity } from "./exports.ts";
import * as jobs from "./jobs.ts";
import { homePath, parent } from "./paths.ts";
import { duration, fps as rateOf } from "./project.ts";
import * as reviews from "./reviews.ts";
import * as seams from "./seams.ts";

/** The clock (tests move it). */
export const clock = { now: () => Date.now() };

/** Exports asked for here that wait for their graphics before they start (routes.ts `whenReady`), by project. */
interface Wait {
  since: number;
  output: string;
  cancelled: boolean;
  /** Its waits end on this (a Cancel, or another Export asked for the project). */
  stop: AbortController;
  /** Another Export of the project took its place: what it does as it ends is no longer the project's. */
  replaced: boolean;
}
const waits = new Map<string, Wait>();

/**
 * An export of `project` waits for what it shows to be ready before it starts (its row is in the queue meanwhile). A
 * second Export pressed while one waits takes its place (the Nov 21 audit: the first went on waiting, orphaned, out of
 * Cancel's reach, and started by itself as its graphics came in): the first is stopped, and leaves the row alone.
 */
export function waitBegins(project: string, output: string): Wait {
  const was = waits.get(project);
  if (was !== undefined) {
    was.cancelled = true;
    was.replaced = true;
    was.stop.abort();
  }
  const wait = { since: clock.now(), output, cancelled: false, stop: new AbortController(), replaced: false };
  waits.set(project, wait);
  return wait;
}

/** It started (or failed, or was cancelled): its row is the export's now. */
export function waitEnds(project: string, wait: Wait): void {
  if (waits.get(project) === wait) waits.delete(project);
}

/** Cancels a project's export still waiting for its graphics (in memory, or written down before a restart); whether one was. */
export function cancelWait(project: string, home: string | null = null): boolean {
  const wait = waits.get(project);
  const written = graphicsRow(home, project) !== undefined;
  if (written) jobs.end(home, jobs.keyOf("export", project));
  if (wait === undefined) return written;
  wait.cancelled = true;
  wait.stop.abort();
  waits.delete(project);
  return true;
}

// ---------------------------------------------------------------- written down
//
// An Export waiting for its graphics was kept in memory alone (Nov 21): no row in jobs.json until it started, so after
// an update or a crash the export the person asked for simply wasn't there. Its row is written as the wait goes on in
// the background (routes.ts `whenReady`), with what it was asked with, and carried on after a restart as the same wait
// (routes.ts `carryOnAsked`, from serve.ts's export resumer). The export's own row takes its place as it starts.

/** The step of an export's row while it waits for its graphics. */
export const GRAPHICS_STEP = "waiting for its graphics";

/** An Export as it was asked for: what `app.exports.start` is given once what it shows is ready. */
export interface Asked {
  options: import("./model.ts").ExportOptions;
  output: string;
  extra: import("./exports.ts").StartExtra;
}

/** Whether `job` is an Export written down while it waited for its graphics. */
export function waitsForGraphics(job: jobs.Job): boolean {
  return job.kind === "export" && job.args.graphics === true && typeof job.args.output === "string" && typeof job.args.options === "object" && job.args.options !== null;
}

/** Project `project`'s row waiting for its graphics, when that's what its export row is. */
function graphicsRow(home: string | null, project: string): jobs.Job | undefined {
  const job = jobs.get(home, jobs.keyOf("export", project));
  return job !== undefined && jobs.live(job) && waitsForGraphics(job) ? job : undefined;
}

/**
 * Writes down `project`'s Export waiting for its graphics, as `asked`. Not over another export's row (one running, or
 * failed or waiting to go again: the start that follows is refused, or takes that row's place, as before).
 */
export function waitWritten(home: string | null, project: string, asked: Asked): void {
  const listed = jobs.get(home, jobs.keyOf("export", project));
  if (listed !== undefined && jobs.live(listed) && !waitsForGraphics(listed)) return;
  jobs.begin(home, "export", project, { graphics: true, options: asked.options, output: asked.output, extra: asked.extra, ...(asked.extra.note === undefined ? {} : { note: asked.extra.note }) }, "", GRAPHICS_STEP);
}

/** What it waits on moved (a render's frames): its row is noted as moving. */
export function waitMoved(home: string | null, project: string): void {
  jobs.beat(home, jobs.keyOf("export", project));
}

/** It started (its row is the export's now), failed or was cancelled: its row as a wait is crossed off (not by one another Export replaced: the row is that one's). */
export function waitDone(home: string | null, project: string, wait?: Wait): void {
  if (wait?.replaced === true) return;
  if (graphicsRow(home, project) !== undefined) jobs.end(home, jobs.keyOf("export", project));
}

/** What a written-down wait was asked with. */
export function askedOf(job: jobs.Job): Asked {
  return { options: job.args.options as Asked["options"], output: job.args.output as string, extra: (job.args.extra ?? {}) as Asked["extra"] };
}

/** What's kept between looks at one run of a project's export: when it began, its stage's start, the video's first progress, the times shown. */
interface Run {
  since: number;
  seen: number;
  stage: string;
  stageAt: number;
  video: [number, number] | null;
  shown: Map<string, { value: number; at: number }>;
  /** Its real progress as last seen (frames drawn, the engine's share, bytes up, the prep's line), and since when it stood so. */
  real?: string;
  realAt?: number;
  /** The bar as last shown, and where it's held while the real progress stands still (`STILL_MS`). */
  last?: number;
  held?: number | null;
  /** The highest it has shown: it never goes back within a run (Nov 21). */
  top?: number;
  /** The time the video made before this run would have taken at this run's pace (`ExportActivity.made`). */
  credit?: number;
  /** Its last look before this one: a stage's change is known to within the time between. */
  prev?: number;
  /** Each stage's start, when it was seen within `LOOK_MS` of happening ("1" graphics, "2" video, "3" copy, "4" upload). */
  starts?: Map<string, number>;
  /** Each stage's length (seconds) once it's over, when its start and end were both seen so. */
  took?: Map<string, number>;
  /** The steps as last said, for its end (`doneSteps`). */
  said?: ExportSteps;
  /** Which steps' times are from their own pace by now (`ownPace`). */
  own?: Set<string>;
  /** The video's join or sound mix after its frames (`JOINING`, `MIXING`), and its progress as it began: its own pace. */
  phase?: string;
  phaseVideo?: [number, number] | null;
  /** When its upload's bytes were up and the page's details and the publish began. */
  upAt?: number;
}

/**
 * A stage's start or end is taken as seen when the look before was this recent: the dialog looks every second and Home
 * every two, so it's right to a few seconds. Looked at less often (nothing open), its times aren't said: never a guess.
 */
const LOOK_MS = 5_000;
/** How long a run's steps are kept once it's over, for the Export dialog's Done. */
const FINISHED_MS = 10 * 60_000;
/** Runs that ended, their steps all done and each one's time where it was seen. */
const finished = new Map<string, { steps: ExportSteps; at: number }>();
/** The stage each step is part of (graphics and removal are the run's first, taken together: no one graphic's time). */
const STAGE_OF: Partial<Record<ExportStep["kind"], string>> = { video: "2", copy: "3", upload: "4" };

/**
 * Nothing real (frames, bytes, the prep's line) new for this long: the bar stops where it is and its step says so (Nov
 * 20: it crept on by the clock to 99% after the engine had stopped). A minute: the engine reports at least every few
 * seconds, a slow home line's upload moves its bytes within that, and a lid's sleep stops the clock with the server.
 */
export const STILL_MS = 60_000;
const runs = new Map<string, Run>();
/** Looked at within this long: the same run (a wait that became its export). */
const SAME_RUN_MS = 15_000;

function runOf(project: string, since: number, now: number): Run {
  const was = runs.get(project);
  if (was !== undefined && now - was.seen < SAME_RUN_MS) {
    was.seen = now;
    was.since = Math.min(was.since, since);
    return was;
  }
  const run: Run = { since, seen: now, stage: "", stageAt: now, video: null, shown: new Map() };
  runs.set(project, run);
  return run;
}

/**
 * A time shown, smoothed: it counts down by the time since it was last shown,
 * then moves part of the way toward the new estimate (about an eighth a
 * second), and rises only when the estimate is a good deal above it, so it
 * neither jumps about nor goes back up by a few seconds.
 */
export function smooth(run: { shown: Map<string, { value: number; at: number }> }, key: string, raw: number | null, now: number): number | null {
  if (raw === null) {
    run.shown.delete(key);
    return null;
  }
  const was = run.shown.get(key);
  let value = Math.max(0, raw);
  if (was !== undefined) {
    const dt = Math.max(0, (now - was.at) / 1000);
    const expected = Math.max(0, was.value - dt);
    const pull = 1 - Math.exp(-dt / 8);
    value = expected + (value - expected) * pull;
    if (value > expected && raw < expected * 1.25 + 15) value = expected;
  }
  run.shown.set(key, { value, at: now });
  return value;
}

/**
 * A step's time left, from its own pace once that's heard (`own`), else from this computer's measured speeds (`guess`).
 * The first time its own pace is heard the time shown starts again from it: `smooth` never lets a time rise by a
 * little, so a guess that was far too short ("a moment") stood through a step of ten seconds and more (Nov 22).
 */
function ownPace(run: Run, key: string, own: number | null, guess: number | null, now: number): number | null {
  if (own === null) return smooth(run, key, guess, now);
  run.own ??= new Set();
  if (!run.own.has(key)) {
    run.own.add(key);
    run.shown.delete(key);
  }
  return smooth(run, key, own, now);
}

/**
 * A step still to come: its time is what it's guessed to take, said as it is and not counted down. `smooth` counts a
 * shown time down with the clock, which is right for the step under way and wrong for one that hasn't begun: while
 * the video rendered, the review copy's and the upload's times ran down to nothing, so the whole read 99% "almost
 * done" from the video's end through both (Nov 22, a MacBook Air: 16 of a share's 30 s). Counted from when it begins.
 */
function waitingFor(run: Run, key: string, guess: number | null, now: number): number | null {
  if (guess === null) {
    run.shown.delete(key);
    return null;
  }
  const value = Math.max(0, guess);
  run.shown.set(key, { value, at: now });
  return value;
}

/** "41:12", "1:48:29": a place or a length on the timeline. */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Where the share is, by its line (reviews.ts `sharing`) and else its listed step: 1 the graphics, 2 the video, 3 the review copy, 4 the upload. */
function shareStage(line: string, step: string | null): number {
  if (line === "waiting for map shots") return 1;
  // "review copy", "copy check": the job's own step, which is the line until the share says more (carried on after a restart).
  if (/^(making the review copy|checking the review copy|fetching the export back|review copy$|copy check$)/.test(line)) return 3;
  if (/^(uploading|describing it|publishing|making it v1)/.test(line)) return 4;
  if (line === "sharing" || line === "cancelling") {
    if (step === "review copy" || step === "copy check") return 3;
    if (step === "uploading" || step === "publishing") return 4;
  }
  return 2;
}

/** The review copy's share made, from the share's line ("making the review copy 40%"), or null when it says none. */
function copyShare(line: string | null): number | null {
  const percent = line === null ? undefined : /^making the review copy (\d+)%$/.exec(line)?.[1];
  return percent === undefined ? null : Math.min(1, Number(percent) / 100);
}

/**
 * The steps of project `id`'s export or share under way here, or null when
 * none is. `job` is its row in the export registry (absent: not started yet).
 */
export function stepsOf(app: App, id: string, job: ExportActivity | undefined, now = clock.now()): ExportSteps | null {
  const live = app.store.get(id);
  if (live === null) return null;
  const home = app.store.home;
  const { line, share } = reviews.shareNow(home, id);
  const wait = waits.get(id);
  const exporting = job !== undefined && (job.state === "queued" || job.state === "running");
  if (line === null && wait === undefined && !exporting) {
    runs.delete(id);
    return null;
  }
  const project = live.project;
  const fps = rateOf(project);
  const seconds = job?.seconds ?? duration(project) / fps;
  const frames = Math.round(seconds * fps);
  const feedback = line !== null || job?.share === true;
  const since = line !== null ? (share?.started ?? now) : wait !== undefined ? wait.since : (job?.started_ms ?? now);
  const run = runOf(id, since, now);
  // 1 graphics, 2 the video, 3 the review copy, 4 the upload; 3 for a save is its end.
  const stage = line !== null ? shareStage(line, share?.step ?? null) : wait !== undefined ? 1 : 2;
  const stageKey = `${stage}`;
  // When each stage began and how long it took, where that was seen within a few seconds (`LOOK_MS`): the first look
  // of a run soon after it began has its first stage's start too.
  const gap = now - (run.prev ?? run.since);
  run.prev = now;
  run.starts ??= new Map();
  run.took ??= new Map();
  if (run.stage !== stageKey) {
    const start = run.starts.get(run.stage);
    if (run.stage !== "" && start !== undefined && gap <= LOOK_MS) run.took.set(run.stage, (now - start) / 1000);
    if (gap <= LOOK_MS) run.starts.set(stageKey, run.stage === "" ? run.since : now);
    run.stage = stageKey;
    run.stageAt = now;
  }
  const measured = speeds.read(home);
  const queued = stage === 2 && job?.state === "queued";
  const steps: ExportStep[] = [];
  /**
   * Whether the step under way has said its own pace yet (the engine's frames over some seconds, the copy's percent,
   * this upload's bytes a second, a graphic's own rate). Until it has, the whole's percent goes by the steps done and
   * the current one's real share, never by a time guessed from another run (Nov 22, a MacBook Air: after two exports
   * that reused every chunk the guess for the video was 5 s; the percent read 99% "almost done" at 5.4 s with the
   * video 37% made, and stood there for the rest of the export and its share, since it never goes back).
   */
  let grounded = false;

  // The graphics: in the order they're done. One waiting behind another project's render is the current one, said so.
  const graphics = effects.graphicsOf(app, id, now);
  const drawingRate = (map: boolean) => graphics.find((one) => one.state === "current" && one.map === map)?.rate ?? null;
  const fpsFor = (map: boolean) => (map ? measured.map_fps : measured.graphic_fps) ?? drawingRate(map);
  if (stage === 1 && graphics.length > 0 && !graphics.some((one) => one.state === "current")) {
    const first = graphics.find((one) => one.state === "waiting");
    if (first !== undefined) first.state = "current";
  }
  for (const graphic of graphics) {
    const state = stage > 1 ? "done" : graphic.state;
    const rate = graphic.rate ?? fpsFor(graphic.map) ?? null;
    const left = state === "done" ? 0 : rate === null ? null : (graphic.frames - (state === "current" ? graphic.drawn : 0)) / rate;
    if (state === "current" && graphic.rate !== null) grounded = true;
    const step: ExportStep = {
      kind: "graphic",
      state,
      label: clockOf(graphic.at / graphic.fps),
      ...(graphic.map ? { what: "map" as const } : graphic.sound ? { what: "sound" as const } : {}),
      progress: state === "current" ? graphic.drawn / Math.max(1, graphic.frames) : null,
      left_s: state === "waiting" ? waitingFor(run, `graphic:${graphic.name}`, left, now) : smooth(run, `graphic:${graphic.name}`, left, now),
    };
    if (state === "current" && graphic.drawn === 0 && graphic.rate === null && effects.renderingLine(id)?.startsWith("waiting behind") === true) step.note = "waiting for another project's graphics";
    steps.push(step);
  }

  // Their text and watermark still being taken out of the footage (removal_schedule.ts): waited for before the video.
  const removing = stage === 1 ? removalSchedule.progressOf(id) : { done: 0, out: 0 };
  if (removing.out > 0) {
    const total = removing.done + removing.out;
    steps.push({ kind: "removal", state: graphics.some((one) => one.state === "current") ? "waiting" : "current", label: `${removing.done} of ${total} pieces`, progress: removing.done / total, left_s: null });
  }

  // The video.
  const p = exporting && job.state === "running" ? Math.min(1, Math.max(0, job.progress)) : 0;
  if (stage === 2 && p > 0 && run.video === null) run.video = [now, p];
  // Past its frames, the join and the sound's mix go at their own pace, not the frames': at the frames' pace the join's
  // end of the bar read "a moment" with 11 s to go (Nov 22, a MacBook Air). No time for it until its own is heard.
  const phase = stage === 2 && (job?.phase === JOINING || job?.phase === MIXING) ? job.phase : "";
  if ((run.phase ?? "") !== phase) {
    run.phase = phase;
    run.phaseVideo = phase === "" ? null : [now, p];
  }
  let videoOwn: number | null = null;
  let videoGuess: number | null = null;
  if (stage > 2) videoGuess = 0;
  else {
    const from = phase === "" ? run.video : (run.phaseVideo ?? null);
    const own = from !== null && now - from[0] >= (phase === "" ? 5000 : 3000) && p - from[1] >= (phase === "" ? 0.005 : 0.002) ? (p - from[1]) / ((now - from[0]) / 1000) : null;
    if (own !== null) videoOwn = (1 - p) / own;
    else if (phase === "" && measured.export_spf !== undefined) videoGuess = frames * measured.export_spf * (1 - p);
  }
  if (stage === 2 && videoOwn !== null) grounded = true;
  const video: ExportStep = {
    kind: "video",
    state: stage > 2 ? "done" : stage === 2 && !queued ? "current" : "waiting",
    label: clockOf(seconds),
    progress: stage === 2 && !queued ? p : null,
    left_s: stage < 2 ? waitingFor(run, "video", videoGuess, now) : ownPace(run, "video", videoOwn, videoGuess, now),
  };
  // What it waits on before its first frame: the encoder, another export, slowed shots, map shots that aren't graphics.
  const before = job?.state === "queued" ? job.waiting : stage === 1 && graphics.length === 0 ? "waiting for the map shots" : line === "waiting for slowed shots" ? "waiting for the slowed shots" : line === "waiting for this project's other export" ? "waiting for its other export" : undefined;
  // Past its frames: the sound's mix after the picture, or the join into one file (exports.ts `ExportBar`), said.
  const after = stage === 2 && (job?.phase === JOINING || job?.phase === MIXING) ? job.phase : undefined;
  if (before !== undefined && (video.state === "current" || queued)) video.note = before;
  else if (after !== undefined && video.state === "current") video.note = after;
  else if (stage === 1 && graphics.length === 0 && removing.out === 0) {
    // Nothing to render but map shots: the video is what it's on.
    video.state = "current";
    video.progress = 0;
    video.note = "waiting for the map shots";
  }
  steps.push(video);

  if (feedback) {
    const copyGuess = measured.copy_spv === undefined ? null : seconds * measured.copy_spv;
    // Its own percent, as FFmpeg reports it (reviews.ts `copyLine`): its pace once it has one.
    const copied = stage === 3 ? copyShare(line) : null;
    const inCopy = (now - run.stageAt) / 1000;
    const copyOwn = copied !== null && copied >= 0.02 && inCopy >= 3 ? (inCopy * (1 - copied)) / copied : null;
    const copyLeft = stage > 3 ? 0 : copyGuess === null ? null : stage === 3 ? Math.max(1, copyGuess - inCopy) : copyGuess;
    if (stage === 3 && copyOwn !== null) grounded = true;
    steps.push({ kind: "copy", state: stage > 3 ? "done" : stage === 3 ? "current" : "waiting", label: "", progress: copied, left_s: stage < 3 ? waitingFor(run, "copy", copyLeft, now) : ownPace(run, "copy", stage === 3 ? copyOwn : null, copyLeft, now) });
    const upload = speeds.uploadOf(id);
    const bytes = upload?.total ?? reviewBytes(seconds);
    const sent = stage === 4 ? (upload?.done ?? 0) : 0;
    const bps = (stage === 4 ? upload?.bps : null) ?? measured.upload_bps ?? null;
    // Up: the page's details and the publish, as long as they take here (`publish_spv`), counted in the upload's time
    // (Nov 22: the last seconds, "Describing it…" and the publish, weren't in the time left).
    const up = stage === 4 && line !== null && !line.startsWith("uploading");
    if (up) run.upAt ??= now;
    const publishing = measured.publish_spv === undefined ? 3 : seconds * measured.publish_spv;
    const uploadLeft = up ? Math.max(1, publishing - (now - run.upAt!) / 1000) : bps === null ? null : (bytes - sent) / bps + publishing;
    // Its own pace: this upload's measured bytes a second, or the last seconds once its bytes are up.
    const uploadOwn = stage === 4 && (up || (upload?.bps ?? null) !== null);
    if (uploadOwn) grounded = true;
    steps.push({ kind: "upload", state: stage === 4 ? "current" : "waiting", label: "", progress: stage === 4 ? (up ? 1 : bytes > 0 ? sent / bytes : 0) : null, left_s: stage < 4 ? waitingFor(run, "upload", uploadLeft, now) : ownPace(run, "upload", uploadOwn ? uploadLeft : null, uploadLeft, now) });
  } else {
    const output = job?.path || wait?.output || "";
    steps.push({ kind: "save", state: "waiting", label: output === "" ? "" : homePath(parent(output) ?? output), progress: null, left_s: 0 });
  }

  const ahead = steps.filter((step) => step.state !== "done");
  let left = ahead.every((step) => step.left_s !== null) ? ahead.reduce((sum, step) => sum + step.left_s!, 0) : null;
  // The video, the review copy or the upload under way with its own pace not heard yet: no time is said for the
  // whole. Its guess is another run's pace, and a wrong one read "almost done" at 0% with a quarter of a minute to go,
  // and again as the review copy began with 15 s to go (Nov 22, twice); a few seconds without a time, then a true one.
  if (stage >= 2 && !queued && !grounded) left = null;
  const elapsed = queued ? 0 : Math.max(0, (now - run.since) / 1000);
  // Carried on (a restart, a stall): the video made before is time already spent, at this run's pace (Nov 21: an
  // export carried on with 6 of 26 chunks made read 1% here, its time counted from the restart alone).
  const made = exporting ? Math.min(1, Math.max(0, job.made ?? 0)) : 0;
  if (stage === 2 && made > 0 && video.left_s !== null && p < 0.999) run.credit = made * (video.left_s / (1 - p));
  const credit = stage >= 2 ? (run.credit ?? 0) : 0;
  // By its steps, the current one's real share counted: the whole's percent when no time can be said, and its ceiling
  // while the step under way hasn't said its own pace (`grounded`).
  // The save takes no time of its own, so it isn't one of the shares (an export carried on a third made reads a third).
  const timed = steps.filter((step) => step.kind !== "save");
  const bySteps = timed.reduce((sum, step) => sum + (step.state === "done" ? 1 : step.state === "current" ? (step.progress ?? 0) : 0), 0) / Math.max(1, timed.length);
  let progress: number;
  if (queued) progress = 0;
  else if (left !== null && elapsed + credit + left > 0) progress = (elapsed + credit) / (elapsed + credit + left);
  else progress = bySteps;
  if (!queued && !grounded) progress = Math.min(progress, bySteps);
  // Standing still (`STILL_MS`): held where it is, no time said, and its step says for how long and what ends it. Only
  // where Edit hears real progress: the graphics' frames, the video (the engine, or its prep's line), the upload's bytes.
  const current = steps.find((step) => step.state === "current");
  const heard = !queued && current !== undefined && (current.kind === "graphic" || current.kind === "video" || (current.kind === "upload" && line !== null && line.startsWith("uploading")) || (current.kind === "copy" && current.progress !== null));
  const real = JSON.stringify([stage, job?.progress ?? 0, job?.phase ?? "", graphics.map((one) => one.drawn), removing.done, speeds.uploadOf(id)?.done ?? 0, line]);
  if (run.real !== real) {
    run.real = real;
    run.realAt = now;
    run.held = null;
  }
  const still = now - (run.realAt ?? now);
  if (heard && still > STILL_MS) {
    run.held ??= run.last ?? progress;
    progress = run.held;
    left = null;
    if (current.note === undefined) {
      const minutes = Math.floor(still / 60_000);
      // The engine encoding (no prep line): a stall starts it again by itself (exports.ts `stall`).
      const restarts = current.kind === "video" && job?.state === "running" && (job.phase ?? "") === "" && job.progress > 0;
      const by = Math.round(exportsStall.ms / 60_000);
      current.note = restarts && minutes < by ? `nothing new for ${minutes} min: Edit starts it again by itself at ${by} min` : `nothing new for ${minutes} min`;
    }
  }
  // Never back within a run: an estimate that rose (a slower pace heard), a stall's restart, the engine trying again.
  if (!queued) progress = Math.max(progress, run.top ?? 0);
  run.top = progress;
  run.last = progress;
  // Each step's own time where it was seen: a done one's length, the current one's so far.
  for (const step of steps) {
    const key = STAGE_OF[step.kind];
    if (key === undefined) continue;
    const took = run.took.get(key);
    const start = run.starts.get(key);
    if (step.state === "done" && took !== undefined) step.took_s = Math.round(took);
    else if (step.state === "current" && !queued && start !== undefined && key === stageKey) step.elapsed_s = Math.round((now - start) / 1000);
  }
  const said: ExportSteps = { where: feedback ? "feedback" : "here", steps, queued, elapsed_s: Math.round(elapsed), left_s: left === null ? null : Math.round(left), progress: Math.min(0.99, Math.max(0, progress)) };
  run.said = said;
  return said;
}

/**
 * Project `id`'s run that just ended at `end`: its steps as last said, each done, with how long each took where its
 * start and end were seen (the last one's end is `end`: its publish, or its export's end), kept `FINISHED_MS` for the
 * Export dialog's Done. Null when none was followed here, or it's long over.
 */
function doneSteps(id: string, end: number, now: number): ExportSteps | null {
  const run = runs.get(id);
  if (run?.said !== undefined) {
    const start = run.starts?.get(run.stage);
    // Its end seen soon after it came (the last look was recent): the last stage's time is known.
    if (start !== undefined && end >= start && end - (run.prev ?? 0) <= LOOK_MS) run.took?.set(run.stage, (end - start) / 1000);
    const steps = run.said.steps.map((step): ExportStep => {
      const took = STAGE_OF[step.kind] === undefined ? undefined : run.took?.get(STAGE_OF[step.kind]!);
      const { note: _note, elapsed_s: _elapsed, took_s: _took, ...rest } = step;
      return { ...rest, state: "done", progress: null, left_s: 0, ...(took === undefined ? {} : { took_s: Math.round(took) }) };
    });
    finished.set(id, { steps: { where: run.said.where, steps, queued: false, elapsed_s: Math.round(Math.max(0, end - run.since) / 1000), left_s: 0, progress: 1 }, at: end });
    runs.delete(id);
  }
  const kept = finished.get(id);
  if (kept === undefined) return null;
  if (now - kept.at > FINISHED_MS) {
    finished.delete(id);
    return null;
  }
  return kept.steps;
}

/**
 * The Exports queue (GET /api/exports/activity): the registry's exports, with
 * an export still waiting for its graphics and a share not yet at its export
 * in it from the start, each going one carrying its steps. A share's export
 * is the share's: while the share goes on past it (the review copy, the
 * upload, the publish) it's shown going, with the share's own line, and a
 * share that failed after it shows why; never "done" before it's up.
 */
export function activity(app: App, visible: Set<string>, now = clock.now()): (ExportActivity & { steps?: ExportSteps })[] {
  const home = app.store.home;
  const rows = new Map<string, ExportActivity>();
  let registry: ExportActivity[] = [];
  try {
    registry = app.exports.activity?.() ?? [];
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  const table = tableRows(app);
  for (const job of registry) {
    if (!visible.has(job.id)) continue;
    const kept = newerInTable(table, job.id, job);
    if (kept !== undefined) {
      rows.set(job.id, kept);
      continue;
    }
    if (job.state !== "done") {
      rows.set(job.id, job);
      continue;
    }
    const { line, share } = reviews.shareNow(home, job.id);
    if (line !== null) rows.set(job.id, { ...job, state: "running", phase: `Sharing: ${line}` });
    else if (share?.state === "failed" && share.at >= job.updated_ms) rows.set(job.id, { ...job, state: "failed", error: share.error ?? "the share failed" });
    else rows.set(job.id, job);
  }
  for (const [id, row] of table) if (visible.has(id) && !rows.has(id) && !waits.has(id)) rows.set(id, row);
  // Asked for, not yet exporting: waiting for its graphics, or a share before its export.
  const asked = new Map<string, number>();
  for (const [id, wait] of waits) asked.set(id, wait.since);
  for (const id of reviews.sharesGoing()) if (!asked.has(id)) asked.set(id, reviews.shareNow(home, id).share?.started ?? now);
  for (const [id, since] of asked) {
    const was = rows.get(id);
    if (!visible.has(id) || (was !== undefined && (was.state === "queued" || was.state === "running"))) continue;
    const live = app.store.get(id);
    if (live === null) continue;
    const line = reviews.shareNow(home, id).line;
    rows.set(id, {
      id,
      name: live.project.name,
      path: waits.get(id)?.output ?? "",
      state: "running",
      progress: 0,
      updated_ms: since,
      started_ms: since,
      ...(line !== null ? { phase: `Sharing: ${line}`, share: true } : { waiting: effects.renderingLine(id) ?? "waiting for its effects to render" }),
    });
  }
  return [...rows.values()].map((row) => {
    if (row.state === "done") {
      // Ended: its steps done, with their times, for a while (the dialog's Done); a share's end is its publish.
      const share = reviews.shareNow(home, row.id).share;
      const end = row.share === true && share?.state === "done" ? share.at : row.updated_ms;
      const steps = doneSteps(row.id, end, now);
      return steps === null ? row : { ...row, steps };
    }
    if (row.state !== "queued" && row.state !== "running") {
      // Ended without being done (cancelled, failed): what was measured of it isn't the next one's. Exported again
      // within `SAME_RUN_MS`, the new run took the old one's start and samples: "about 40 s left" with 11 to go, and
      // the percent held at 35% while the video went from 29 to 60 (Nov 22, a MacBook Air; the audit's E12.2).
      runs.delete(row.id);
      return row;
    }
    const steps = stepsOf(app, row.id, row, now);
    return steps === null ? row : { ...row, steps };
  });
}

/**
 * Project exports the job table holds that nothing here runs (Nov 20): one a restart (an update) carried on that
 * couldn't start (an effect rendering again, footage not here yet, a folder macOS asks about) waits there to go
 * again, and one that failed is kept until the project's next export. Both were gone from the Exports queue after an
 * update, the export the person asked for vanished with nothing said. A share's export is its share's row.
 */
function tableRows(app: App): Map<string, ExportActivity> {
  const rows = new Map<string, ExportActivity>();
  let listed: jobs.Job[] = [];
  try {
    listed = jobs.list(app.store.home, "export");
  } catch {
    return rows;
  }
  for (const job of listed) {
    // A wait for its graphics written down and not yet carried on here (just after a restart) is in the queue too.
    const graphics = job.state === "running" && waitsForGraphics(job) && !waits.has(job.project);
    if (job.args.share === true || (job.state !== "waiting" && job.state !== "failed" && !graphics)) continue;
    const live = app.store.get(job.project);
    if (live === null) continue;
    const base = { id: job.project, name: live.project.name, path: typeof job.args.output === "string" ? job.args.output : "", progress: 0, updated_ms: job.updated_ms, ...(typeof job.args.note === "string" ? { note: job.args.note } : {}) };
    if (job.state === "failed") rows.set(job.project, { ...base, state: "failed", error: job.error ?? "the export failed" });
    else if (graphics) rows.set(job.project, { ...base, state: "queued", waiting: effects.renderingLine(job.project) ?? "waiting for its effects to render" });
    else rows.set(job.project, { ...base, state: "queued", waiting: waitingLine(job) });
  }
  return rows;
}

/** A waiting export job's line: when it goes again, and why it waits ("waiting to start again at 14:05 (…)"). */
function waitingLine(job: jobs.Job): string {
  const at = job.retry_at;
  const clock = (ms: number) => {
    const day = new Date(ms);
    return `${String(day.getHours()).padStart(2, "0")}:${String(day.getMinutes()).padStart(2, "0")}`;
  };
  const when = job.until === "encoder" ? " once the encoder is free" : at === undefined ? "" : ` at ${clock(at)}`;
  const why = job.why ?? job.error;
  return `waiting to start again${when}${why === undefined || why === "" ? "" : ` (${why.replace(/\.$/u, "")})`}`;
}

/** The job table's row for a project, when it says more than the registry's (none, or one that ended before it was put off). */
function newerInTable(table: Map<string, ExportActivity>, id: string, registry: ExportActivity | undefined): ExportActivity | undefined {
  const row = table.get(id);
  if (row === undefined) return undefined;
  if (registry === undefined) return row;
  if (registry.state === "queued" || registry.state === "running") return undefined;
  return row.state === "queued" && row.updated_ms >= registry.updated_ms ? row : undefined;
}

/**
 * Project `id`'s export as its `export` events said it last (GET /api/projects/{id}/export), for a page whose socket
 * was down when one went (Nov 20: a lid's wake closed it, the export failed in the second before it reconnected, and
 * the dialog sat on "Exporting 40%" with Export greyed out until a reload). Null when there's none to say.
 */
export function exportNow(app: App, id: string): { state: ExportActivity["state"]; progress: number; path: string; error?: string; waiting?: string; phase?: string } | null {
  const shown = (row: ExportActivity) => ({
    state: row.state,
    progress: row.progress,
    path: row.path,
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(row.waiting === undefined ? {} : { waiting: row.waiting }),
    ...(row.phase === undefined ? {} : { phase: row.phase }),
  });
  const wait = waits.get(id);
  if (wait !== undefined) return { state: "queued", progress: 0, path: wait.output, waiting: effects.renderingLine(id) ?? removalSchedule.exportLine(id) ?? "waiting for its effects to render" };
  let registry: ExportActivity | undefined;
  try {
    registry = (app.exports.activity?.() ?? []).find((one) => one.id === id);
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  const table = newerInTable(tableRows(app), id, registry);
  if (table !== undefined) return shown(table);
  return registry === undefined ? null : shown(registry);
}

/** For tests: forget the waits and the runs. */
export function reset(): void {
  waits.clear();
  runs.clear();
  finished.clear();
}
