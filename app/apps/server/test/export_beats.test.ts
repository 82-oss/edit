// An export's row says it's moving while it moves (Nov 21): a running row nothing has noted for `jobs.STILL_MS` is
// reported as still (the log, the Mac's report), and an export's was noted only between its steps, so a 2-hour edit's
// 30-minute render, the exports queued behind it and its cloud copy's upload of hours all read as still.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { archiveFinished, exportCloud, ExportRegistry, stall, type ExportRecord } from "../src/exports.ts";
import * as jobs from "../src/jobs.ts";
import type { Project } from "../src/model.ts";
import * as wake from "../src/wake.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

const was = { stall: { ...stall }, still: jobs.STILL_MS.value, beat: jobs.BEAT_MS.value, most: process.env.EDIT_LOCAL_EXPORTS };
beforeEach(() => {
  process.env.EDIT_LOCAL_EXPORTS = "1";
  // Still after 600 ms, a beat written at most every 60 ms; no stall stops the render that says nothing. (150 and 20
  // at first: CI's Mac, Check on 291562fd, went quiet for longer than that once and a moving row read as still.)
  jobs.STILL_MS.value = 600;
  jobs.BEAT_MS.value = 60;
  Object.assign(stall, { ms: 60_000, everyMs: 10 });
});
afterEach(() => {
  jobs.STILL_MS.value = was.still;
  jobs.BEAT_MS.value = was.beat;
  Object.assign(stall, was.stall);
  if (was.most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
  else process.env.EDIT_LOCAL_EXPORTS = was.most;
  wake.stopForTests();
});

/** A home whose engine renders `named` for `ms`, reporting progress every 10 ms unless it's `silent`. */
function engine(name: string, ms: number, silent: Set<string>) {
  const t = fixtureHome(name);
  const registry = new ExportRegistry(t.home);
  t.app.exports = registry;
  const plan = spyOn(t.native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(t.native.ExportJob, "start").mockImplementation((job, progress) => {
    const named = JSON.parse(job.project.json).name as string;
    let at = 0;
    const ticking = silent.has(named) ? null : setInterval(() => progress((at += 0.01)), 10);
    return {
      cancel: () => {},
      wait: async () => {
        await Bun.sleep(ms);
        if (ticking !== null) clearInterval(ticking);
        fs.writeFileSync(job.output, "export");
        return { seconds: 1, bytes: 6 };
      },
    };
  });
  const project = async (named: string): Promise<Project> => {
    const id = t.store.create(named, { width: 64, height: 36, fps: 30 }).project.id;
    await t.store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    return structuredClone(t.store.get(id)!.project);
  };
  const cleanup = () => {
    render.mockRestore();
    archive.mockRestore();
    plan.mockRestore();
    t.cleanup();
  };
  return { ...t, registry, project, cleanup };
}

test("a render whose engine reports progress for longer than the still time is never listed as still, nor the export waiting behind it; one that says nothing is", async () => {
  const t = engine("export-beats", 2400, new Set(["Silent"]));
  try {
    const options = t.native.exportDefaults();
    const moving = await t.project("Moving");
    const behind = await t.project("Behind");
    await t.registry.start(t.store, t.app.library, moving, options, `${t.dir}/moving.mp4`, { drive: false, keepLocal: true });
    await t.registry.start(t.store, t.app.library, behind, options, `${t.dir}/behind.mp4`, { drive: false, keepLocal: true });
    expect(t.registry.activity().find((one) => one.id === behind.id)?.state).toBe("queued");
    // Four still times over its render: looked at throughout, never still.
    const seen = new Set<string>();
    const end = Date.now() + 2200;
    while (Date.now() < end) {
      for (const row of jobs.still(t.home)) seen.add(row.project);
      await Bun.sleep(15);
    }
    expect([...seen]).toEqual([]);

    // The engine that reports nothing for as long: its row is still, as it should be.
    const silent = await t.project("Silent");
    for (let tries = 0; t.registry.running() && tries < 1200; tries++) await Bun.sleep(10);
    await t.registry.start(t.store, t.app.library, silent, options, `${t.dir}/silent.mp4`, { drive: false, keepLocal: true });
    await Bun.sleep(1200);
    expect(jobs.still(t.home).map((row) => row.project)).toEqual([silent.id]);
  } finally {
    for (let tries = 0; t.registry.running() && tries < 1200; tries++) await Bun.sleep(10);
    t.cleanup();
  }
  // Its clocks (four still times, then one more) take about five seconds since they were made four times longer:
  // past bun's own limit on a slow machine (Nov 21, this test alone timed out at 5.0 s on Linux).
}, 30_000);

test("an export's cloud copy going up for longer than the still time is never listed as still while its bytes move", async () => {
  const t = fixtureHome("archive-beats");
  const output = `${t.dir}/up.mp4`;
  fs.writeFileSync(output, "x".repeat(50));
  const head = spyOn(exportCloud, "head").mockResolvedValue({ size: 50 });
  const upload = spyOn(exportCloud, "upload").mockImplementation(async (_path, _key, _signal, moving) => {
    for (let n = 0; n < 60; n++) {
      moving?.();
      await Bun.sleep(40);
    }
  });
  try {
    const key = jobs.begin(t.home, "archive", "p1", { output }, "", "uploading");
    const record: ExportRecord = { path: output, name: "up.mp4", finished_ms: Date.now(), seconds: 1, bytes: 50, frames: 30, whole: true, start: 0, format: "h264", cloudKey: "edit/exports/p1/up.mp4" };
    const sending = archiveFinished(t.home, "p1", output, "edit/exports/p1/up.mp4", record);
    const seen = new Set<string>();
    let done = false;
    void sending.finally(() => (done = true));
    while (!done) {
      for (const row of jobs.still(t.home)) seen.add(row.key);
      await Bun.sleep(15);
    }
    expect(await sending).toBe("up");
    expect([...seen]).toEqual([]);
    void key;
  } finally {
    upload.mockRestore();
    head.mockRestore();
    t.cleanup();
  }
});
