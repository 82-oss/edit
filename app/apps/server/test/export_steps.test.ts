import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import { overall, type ExportSteps } from "@edit/types/export_steps";

import * as effects from "../src/effects.ts";
import * as speeds from "../src/export_speeds.ts";
import * as steps from "../src/export_steps.ts";
import { fixtureHome } from "./helpers/home.ts";

// The Export dialog's steps and the Exports queue (Sphe, Nov 17): an export is in the queue from the moment it's asked
// for, its graphics counted in plain words, and its times from this computer's measured speeds, smoothed.

afterEach(() => {
  steps.reset();
  steps.clock.now = () => Date.now();
  speeds.reset();
});

const PAGE = "<!doctype html><script>window.duration = 2; window.ready = Promise.resolve(); window.seek = () => {};</script>";
const MAP = `<!doctype html><script src="edit-map/map.js"></script>${PAGE}`;

/** A V2 project of 60 s showing three graphics, at 0:10, 0:40 and 0:20; the one at 0:20 already rendered from its code. */
async function project() {
  const home = fixtureHome("export-steps");
  const id = home.app.store.create("Welfare check", { width: 1920, height: 1080, fps: 30 }).project.id;
  for (const [name, page] of [["cutfx-21", PAGE], ["cutfx-22", MAP], ["titles", PAGE]] as const) {
    const dir = effects.folder(home.app.store, id, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), page);
  }
  const keys = Object.fromEntries(effects.list(home.app.store, id).map((one) => [one.name, one.key]));
  await home.app.store.update(id, "test", (edit) => {
    edit.hq = true;
    for (const n of [1, 2, 3]) edit.tracks.push({ id: `t${n}`, kind: "video", name: `V${n}`, hidden: false, muted: false, locked: false } as unknown as (typeof edit.tracks)[number]);
    const media = (n: number, name: string, rendered: boolean) =>
      ({ id: `m${n}`, name, path: `/x/${name}.jpg`, kind: "image", duration: 2, width: 1920, height: 1080, fps: 30, has_audio: false, effect: name, ...(rendered ? { effect_key: keys[name] } : {}) }) as unknown as (typeof edit.media)[number];
    edit.media.push(media(1, "cutfx-21", false), media(2, "cutfx-22", false), media(3, "titles", true));
    const clip = (n: number, start: number, length = 60) => ({ id: `c${n}`, type: "video", track: `t${n}`, start, duration: length, media: `m${n}`, source_in: 0 }) as unknown as (typeof edit.clips)[number];
    edit.clips.push(clip(1, 300), clip(2, 1200), clip(3, 600, 1200));
  });
  return { ...home, id };
}

test("an export still waiting on its graphics is in the queue from the start, each graphic by its place, never its name", async () => {
  const { app, id, cleanup } = await project();
  try {
    steps.clock.now = () => 1_000_000;
    effects.noteWait(app, id);
    const wait = steps.waitBegins(id, "/home/me/Movies/Edit/Welfare check.mp4");
    const rows = steps.activity(app, new Set([id]), 1_000_000);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ id, name: "Welfare check", state: "running" });
    const given = row.steps!;
    expect(given.where).toBe("here");
    // The rendered one isn't counted; the first waiting is the one it's on, then the rest by place.
    expect(given.steps.map((one) => [one.kind, one.state, one.label, one.what ?? null])).toEqual([
      ["graphic", "current", "0:10", null],
      ["graphic", "waiting", "0:40", "map"],
      ["video", "waiting", "1:00", null],
      ["save", "waiting", expect.stringMatching(/Movies\/Edit$/), null],
    ]);
    expect(JSON.stringify(given)).not.toContain("cutfx");
    // Nothing measured here yet: no time is said.
    expect(given.left_s).toBeNull();
    // Cancelled while it waits: it leaves the queue.
    expect(steps.cancelWait(id)).toBe(true);
    expect(wait.cancelled).toBe(true);
    expect(steps.activity(app, new Set([id]), 1_000_000)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("times come from this computer's measured speeds, and the whole is their sum", async () => {
  const { app, home, id, cleanup } = await project();
  try {
    // 30 frames a second for a page, 6 for a map, a frame of export in a tenth of a second.
    speeds.noteGraphic(home, false, 300, 10);
    speeds.noteGraphic(home, true, 60, 10);
    speeds.noteExport(home, 1800, 180);
    effects.noteWait(app, id);
    steps.waitBegins(id, "/x/out.mp4");
    const given = steps.stepsOf(app, id, undefined, 2_000_000)!;
    const left = given.steps.map((one) => one.left_s);
    // 60 frames at 30/s, 60 at 6/s, 1800 frames at 0.1 s, the save at once.
    expect(left).toEqual([2, 10, 180, 0]);
    expect(given.left_s).toBe(192);
    expect(given.progress).toBe(0);
  } finally {
    cleanup();
  }
});

test("a time counts down between looks, follows a new estimate gradually, and never goes up by a little or below zero", () => {
  const run = { shown: new Map<string, { value: number; at: number }>() };
  expect(steps.smooth(run, "v", 100, 0)).toBe(100);
  // Ten seconds on, the estimate says the same: ten seconds less (it doesn't go back up to it).
  expect(steps.smooth(run, "v", 100, 10_000)).toBe(90);
  // A lower estimate is followed part of the way.
  expect(steps.smooth(run, "v", 50, 12_000)).toBeCloseTo(88 + (50 - 88) * (1 - Math.exp(-2 / 8)), 5);
  const before = run.shown.get("v")!.value;
  // A second later, a little higher: still counting down.
  expect(steps.smooth(run, "v", before + 5, 13_000)).toBeCloseTo(before - 1, 5);
  // Much higher (the export slowed): it rises, part of the way.
  const risen = steps.smooth(run, "v", 400, 14_000)!;
  expect(risen).toBeGreaterThan(before);
  expect(risen).toBeLessThan(400);
  // Long past its time: zero, never less.
  expect(steps.smooth(run, "w", 5, 0)).toBe(5);
  expect(steps.smooth(run, "w", 0, 60_000)).toBe(0);
});

const job = (state: string, elapsed: number, left: number | null, progress = 0): { state: string; progress: number; steps: ExportSteps } => ({
  state,
  progress,
  steps: { where: "here", steps: [], queued: state === "queued", elapsed_s: elapsed, left_s: left, progress: left === null ? progress : elapsed / (elapsed + left) },
});

test("the queue's one number weighs each job by its whole time, and says the time left once every job has one", () => {
  // 10 min done of 20, and a 10 min export in line: 600 of 1800 s.
  const two = overall([job("running", 600, 600), job("queued", 0, 600)]);
  expect(two.progress).toBeCloseTo(1 / 3, 5);
  expect(two.left_s).toBe(1200);
  // A finished one doesn't count.
  expect(overall([job("running", 600, 600), job("done", 100, 0)]).progress).toBeCloseTo(0.5, 5);
  // One with no time yet weighs as much as the timed ones do on average; the time left isn't said.
  const untimed = overall([job("running", 300, 300), job("running", 0, null, 0.5)]);
  expect(untimed.progress).toBeCloseTo(0.5, 5);
  expect(untimed.left_s).toBeNull();
  // A script share (no steps) by its own share.
  expect(overall([{ state: "running", progress: 0.25 }]).progress).toBeCloseTo(0.25, 5);
  expect(overall([])).toEqual({ progress: 0, left_s: null });
});

test("a video whose engine stands still holds the bar where it is and says for how long and what ends it", async () => {
  // Nov 20: the bar crept on by the clock (`left_s` counting down) to 99% after the engine had stopped.
  const { app, home, id, cleanup } = await project();
  try {
    speeds.noteExport(home, 1800, 180);
    const job = { id, name: "Welfare check", path: "/x/out.mp4", state: "running" as const, progress: 0.3, updated_ms: 0, started_ms: 1_000_000, seconds: 60 };
    const t0 = 1_000_000;
    const first = steps.stepsOf(app, id, job, t0)!;
    // 30 s later, the engine on: the bar has moved.
    const moving = steps.stepsOf(app, id, { ...job, progress: 0.35 }, t0 + 30_000)!;
    expect(moving.progress).toBeGreaterThan(first.progress);
    // Then nothing new for three minutes: it stops where it was a minute in, and the video's line says so.
    const at = (s: number) => steps.stepsOf(app, id, { ...job, progress: 0.35 }, t0 + 30_000 + s * 1000)!;
    // Looked at as the page does (every second or so; 10 s here).
    for (let s = 10; s <= 60; s += 10) at(s);
    const held = at(61);
    for (let s = 70; s <= 200; s += 10) expect(at(s).progress).toBe(held.progress);
    const later = at(210);
    expect(later.progress).toBe(held.progress);
    expect(later.left_s).toBeNull();
    const video = later.steps.find((one) => one.kind === "video")!;
    expect(video.note).toBe("nothing new for 3 min: Edit starts it again by itself at 8 min");
    // It moves again: the line goes, the bar goes on.
    const again = steps.stepsOf(app, id, { ...job, progress: 0.4 }, t0 + 30_000 + 215_000)!;
    expect(again.steps.find((one) => one.kind === "video")!.note).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("an export the job table holds waiting to start again (an update's, that couldn't start) is in the queue with its line", async () => {
  // Nov 20: after an update, the export the person asked for was gone from the Exports queue with nothing said.
  const jobs = await import("../src/jobs.ts");
  const { app, home, id, cleanup } = await project();
  try {
    const key = jobs.begin(home, "export", id, { options: {}, output: "/x/Welfare check.mp4" });
    jobs.wait(home, key, "the cutfx-21 effect is still rendering: export again in a minute or two");
    const rows = steps.activity(app, new Set([id]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, name: "Welfare check", state: "queued", path: "/x/Welfare check.mp4" });
    expect(rows[0]!.waiting).toMatch(/^waiting to start again at \d\d:\d\d \(the cutfx-21 effect is still rendering: export again in a minute or two\)$/);
    // Failed and kept (until the project's next export): said with why.
    jobs.settle(home, key, "failed", { error: "Your disk is full" });
    expect(steps.activity(app, new Set([id]))[0]).toMatchObject({ state: "failed", error: "Your disk is full" });
    // A share's export is its share's row, not this.
    jobs.end(home, key);
    jobs.wait(home, jobs.begin(home, "export", id, { share: true, output: "/x/y.mp4" }), "the line dropped");
    expect(steps.activity(app, new Set([id]))).toEqual([]);
  } finally {
    cleanup();
  }
});

test("an export carried on with part of its video made counts that part in the queue's percent, never goes back, and says its join", async () => {
  // Nov 21, a MacBook Air: carried on after a restart with 6 of 26 chunks made, the bar read 1% (its time counted from
  // the restart alone) and the join said nothing.
  const { JOINING } = await import("../src/exports.ts");
  const { app, home, store, cleanup } = fixtureHome("export-steps-carried");
  try {
    const id = store.create("Welfare check", { width: 1920, height: 1080, fps: 30 }).project.id;
    // This Mac exports a minute's video in three minutes.
    speeds.noteExport(home, 1800, 180);
    const t0 = 5_000_000;
    steps.clock.now = () => t0;
    const job = { id, name: "Welfare check", path: "/x/out.mp4", state: "running" as const, progress: 0.3, updated_ms: t0, started_ms: t0, seconds: 60, made: 0.3 };
    const seen: number[] = [];
    for (let s = 0; s <= 60; s += 5) {
      const given = steps.stepsOf(app, id, { ...job, progress: 0.3 + s * 0.004 }, t0 + s * 1000)!;
      seen.push(given.progress);
    }
    // From its first look: about the share made, not the time since the restart (which reads 0).
    expect(seen[0]!).toBeGreaterThanOrEqual(0.25);
    for (let at = 1; at < seen.length; at++) expect(seen[at]!).toBeGreaterThanOrEqual(seen[at - 1]!);
    expect(seen.at(-1)!).toBeGreaterThanOrEqual(0.5);
    // Its join: the video's line says so.
    const joining = steps.stepsOf(app, id, { ...job, progress: 0.96, phase: JOINING }, t0 + 70_000)!;
    expect(joining.steps.find((one) => one.kind === "video")!.note).toBe(JOINING);
    expect(joining.progress).toBeLessThan(1);
  } finally {
    cleanup();
  }
});

// Sphe, Nov 21: "I have no idea of progress other than the 'about 9 minutes left'". A step's own time is said only
// where Edit saw it start and end (looked at every few seconds): the video's time so far while it runs, its length once
// it's done, and the run's steps kept, done with their times, for the dialog's Done. Never a guess.
test("a step's time so far and its length are said where they were seen, and the steps are kept done with their times once it ends", async () => {
  const { app, store, cleanup } = fixtureHome("export-steps-times");
  try {
    const id = store.create("Welfare check", { width: 1920, height: 1080, fps: 30 }).project.id;
    const t0 = 7_000_000;
    let row: Record<string, unknown> = { id, name: "Welfare check", path: "/x/out.mp4", state: "running", progress: 0.1, updated_ms: t0, started_ms: t0, seconds: 60 };
    (app as unknown as { exports: unknown }).exports = { activity: () => [row] };
    const look = (s: number) => steps.activity(app, new Set([id]), t0 + s * 1000)[0]!;
    // Looked at from its start, every two seconds, as Home does.
    for (let s = 1; s <= 59; s += 2) {
      row = { ...row, progress: 0.1 + s * 0.015 };
      const video = look(s).steps!.steps.find((one) => one.kind === "video")!;
      if (s !== 41) continue;
      expect(video).toMatchObject({ state: "current", elapsed_s: 41 });
      expect(video.took_s).toBeUndefined();
    }
    // Done 60 s in: its steps, each done, the video's length as seen; the save has none of its own.
    row = { ...row, state: "done", progress: 1, updated_ms: t0 + 60_000 };
    const done = look(61);
    expect(done.state).toBe("done");
    expect(done.steps!.steps.map((one) => [one.kind, one.state, one.took_s ?? null])).toEqual([["video", "done", 60], ["save", "done", null]]);
    // Kept a while for the dialog, then gone.
    expect(look(120).steps?.steps).toHaveLength(2);
    expect(look(61 + 11 * 60).steps).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("a run first looked at long after it began says no time for the step it was on: its start wasn't seen", async () => {
  const { app, store, cleanup } = fixtureHome("export-steps-unseen");
  try {
    const id = store.create("Welfare check", { width: 1920, height: 1080, fps: 30 }).project.id;
    const t0 = 9_000_000;
    let row: Record<string, unknown> = { id, name: "Welfare check", path: "/x/out.mp4", state: "running", progress: 0.5, updated_ms: t0, started_ms: t0, seconds: 60 };
    (app as unknown as { exports: unknown }).exports = { activity: () => [row] };
    // Nobody looked for five minutes (the dialog closed, Home not open).
    const first = steps.activity(app, new Set([id]), t0 + 300_000)[0]!;
    expect(first.steps!.steps.find((one) => one.kind === "video")!.elapsed_s).toBeUndefined();
    row = { ...row, state: "done", progress: 1, updated_ms: t0 + 302_000 };
    const done = steps.activity(app, new Set([id]), t0 + 302_000)[0]!;
    expect(done.steps!.steps.find((one) => one.kind === "video")).toMatchObject({ state: "done" });
    expect(done.steps!.steps.find((one) => one.kind === "video")!.took_s).toBeUndefined();
  } finally {
    cleanup();
  }
});

// Nov 22, a MacBook Air, the new dialog's big percent: after two exports that reused every chunk (2,400 frames "in
// 1.6 s") this computer's pace read three times too fast, so the next export's video was guessed at 5 s; 5.4 s in, the
// percent read 99% "almost done" with the video 37% made, and stood at 99% for the rest of the export, since it never
// goes back. A step's time is trusted for the whole's percent only once that step has said its own pace.
test("a pace learnt wrong never puts the percent ahead of the video: it goes by the video's real share until the engine's own pace is heard", async () => {
  const { app, home, id, cleanup } = await project();
  try {
    // Far too fast: a 60 s video (1,800 frames) guessed at 1.2 s.
    speeds.noteExport(home, 2400, 1.6);
    const t0 = 7_000_000;
    const job = { id, name: "Welfare check", path: "/x/out.mp4", state: "running" as const, progress: 0, updated_ms: t0, started_ms: t0, seconds: 60 };
    const at = (s: number, progress: number) => steps.stepsOf(app, id, { ...job, progress }, t0 + s * 1000)!;
    at(0, 0);
    at(1, 0.05);
    at(3, 0.2);
    // The engine's own pace isn't heard yet (under 5 s of it): never ahead of the video's real share.
    const early = at(5.4, 0.37);
    expect(early.progress).toBeLessThanOrEqual(0.37);
    // Heard: 7% a second, so about 6 s are left at 58%, said as that, not as the guess's "a moment".
    const heard = at(8, 0.58);
    expect(heard.progress).toBeGreaterThan(early.progress);
    expect(heard.progress).toBeLessThan(0.8);
    const video = heard.steps.find((one) => one.kind === "video")!;
    expect(video.left_s!).toBeGreaterThan(4);
    expect(video.left_s!).toBeLessThan(9);
    // And it ends near the end, not long before it.
    const late = at(13, 0.93);
    expect(late.progress).toBeGreaterThan(0.85);
  } finally {
    cleanup();
  }
});
