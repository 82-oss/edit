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
import * as speeds from "./export_speeds.ts";
import { reviewBytes, type ExportActivity } from "./exports.ts";
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
}
const waits = new Map<string, Wait>();

/** An export of `project` waits for what it shows to be ready before it starts (its row is in the queue meanwhile). */
export function waitBegins(project: string, output: string): Wait {
  const wait = { since: clock.now(), output, cancelled: false };
  waits.set(project, wait);
  return wait;
}

/** It started (or failed, or was cancelled): its row is the export's now. */
export function waitEnds(project: string, wait: Wait): void {
  if (waits.get(project) === wait) waits.delete(project);
}

/** Cancels a project's export still waiting for its graphics; whether one was. */
export function cancelWait(project: string): boolean {
  const wait = waits.get(project);
  if (wait === undefined) return false;
  wait.cancelled = true;
  waits.delete(project);
  return true;
}

/** What's kept between looks at one run of a project's export: when it began, its stage's start, the video's first progress, the times shown. */
interface Run {
  since: number;
  seen: number;
  stage: string;
  stageAt: number;
  video: [number, number] | null;
  shown: Map<string, { value: number; at: number }>;
}
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
  if (/^(making the review copy|checking the review copy|fetching the export back)/.test(line)) return 3;
  if (/^(uploading|describing it|publishing|making it v1)/.test(line)) return 4;
  if (line === "sharing" || line === "cancelling") {
    if (step === "review copy" || step === "copy check") return 3;
    if (step === "uploading" || step === "publishing") return 4;
  }
  return 2;
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
  if (run.stage !== stageKey) {
    run.stage = stageKey;
    run.stageAt = now;
  }
  const measured = speeds.read(home);
  const queued = stage === 2 && job?.state === "queued";
  const steps: ExportStep[] = [];

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
    const step: ExportStep = {
      kind: "graphic",
      state,
      label: clockOf(graphic.at / graphic.fps),
      ...(graphic.map ? { what: "map" as const } : graphic.sound ? { what: "sound" as const } : {}),
      progress: state === "current" ? graphic.drawn / Math.max(1, graphic.frames) : null,
      left_s: smooth(run, `graphic:${graphic.name}`, left, now),
    };
    if (state === "current" && graphic.drawn === 0 && graphic.rate === null && effects.renderingLine(id)?.startsWith("waiting behind") === true) step.note = "waiting for another project's graphics";
    steps.push(step);
  }

  // The video.
  const p = exporting && job.state === "running" ? Math.min(1, Math.max(0, job.progress)) : 0;
  if (stage === 2 && p > 0 && run.video === null) run.video = [now, p];
  let videoLeft: number | null = null;
  if (stage > 2) videoLeft = 0;
  else {
    const own = run.video !== null && now - run.video[0] >= 5000 && p - run.video[1] >= 0.005 ? (p - run.video[1]) / ((now - run.video[0]) / 1000) : null;
    if (own !== null) videoLeft = (1 - p) / own;
    else if (measured.export_spf !== undefined) videoLeft = frames * measured.export_spf * (1 - p);
  }
  const video: ExportStep = {
    kind: "video",
    state: stage > 2 ? "done" : stage === 2 && !queued ? "current" : "waiting",
    label: clockOf(seconds),
    progress: stage === 2 && !queued ? p : null,
    left_s: smooth(run, "video", videoLeft, now),
  };
  // What it waits on before its first frame: the encoder, another export, slowed shots, map shots that aren't graphics.
  const before = job?.state === "queued" ? job.waiting : stage === 1 && graphics.length === 0 ? "waiting for the map shots" : line === "waiting for slowed shots" ? "waiting for the slowed shots" : line === "waiting for this project's other export" ? "waiting for its other export" : undefined;
  if (before !== undefined && (video.state === "current" || queued)) video.note = before;
  else if (stage === 1 && graphics.length === 0) {
    // Nothing to render but map shots: the video is what it's on.
    video.state = "current";
    video.progress = 0;
    video.note = "waiting for the map shots";
  }
  steps.push(video);

  if (feedback) {
    const copyGuess = measured.copy_spv === undefined ? null : seconds * measured.copy_spv;
    const copyLeft = stage > 3 ? 0 : copyGuess === null ? null : stage === 3 ? Math.max(1, copyGuess - (now - run.stageAt) / 1000) : copyGuess;
    steps.push({ kind: "copy", state: stage > 3 ? "done" : stage === 3 ? "current" : "waiting", label: "", progress: null, left_s: smooth(run, "copy", copyLeft, now) });
    const upload = speeds.uploadOf(id);
    const bytes = upload?.total ?? reviewBytes(seconds);
    const sent = stage === 4 ? (upload?.done ?? 0) : 0;
    const bps = (stage === 4 ? upload?.bps : null) ?? measured.upload_bps ?? null;
    // Up: the page's details and the publish, seconds.
    const up = stage === 4 && line !== null && !line.startsWith("uploading");
    const uploadLeft = up ? 3 : bps === null ? null : (bytes - sent) / bps;
    steps.push({ kind: "upload", state: stage === 4 ? "current" : "waiting", label: "", progress: stage === 4 ? (up ? 1 : bytes > 0 ? sent / bytes : 0) : null, left_s: smooth(run, "upload", uploadLeft, now) });
  } else {
    const output = job?.path || wait?.output || "";
    steps.push({ kind: "save", state: "waiting", label: output === "" ? "" : homePath(parent(output) ?? output), progress: null, left_s: 0 });
  }

  const ahead = steps.filter((step) => step.state !== "done");
  const left = ahead.every((step) => step.left_s !== null) ? ahead.reduce((sum, step) => sum + step.left_s!, 0) : null;
  const elapsed = queued ? 0 : Math.max(0, (now - run.since) / 1000);
  let progress: number;
  if (queued) progress = 0;
  else if (left !== null && elapsed + left > 0) progress = elapsed / (elapsed + left);
  else {
    // Untimed: by its steps, the current one's share counted.
    const counted = steps.reduce((sum, step) => sum + (step.state === "done" ? 1 : step.state === "current" ? (step.progress ?? 0) : 0), 0);
    progress = counted / steps.length;
  }
  return { where: feedback ? "feedback" : "here", steps, queued, elapsed_s: Math.round(elapsed), left_s: left === null ? null : Math.round(left), progress: Math.min(0.99, Math.max(0, progress)) };
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
  for (const job of registry) {
    if (!visible.has(job.id)) continue;
    if (job.state !== "done") {
      rows.set(job.id, job);
      continue;
    }
    const { line, share } = reviews.shareNow(home, job.id);
    if (line !== null) rows.set(job.id, { ...job, state: "running", phase: `Sharing: ${line}` });
    else if (share?.state === "failed" && share.at >= job.updated_ms) rows.set(job.id, { ...job, state: "failed", error: share.error ?? "the share failed" });
    else rows.set(job.id, job);
  }
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
    if (row.state !== "queued" && row.state !== "running") return row;
    const steps = stepsOf(app, row.id, row, now);
    return steps === null ? row : { ...row, steps };
  });
}

/** For tests: forget the waits and the runs. */
export function reset(): void {
  waits.clear();
  runs.clear();
}
