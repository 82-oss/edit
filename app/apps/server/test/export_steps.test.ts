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
