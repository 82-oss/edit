// An engine job that never ends once it's told to stop (Nov 20, "exports just freeze out of nowhere"): a VideoToolbox
// session or GPU lost across a lid close, a writer's cancel that never returns. The fakes here never settle and ignore
// cancel; the one in exports.test.ts's stall test settles on cancel, which is why it never caught this.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { abandon, aheadFile, exportCloud, ExportRegistry, REMAKE_MS, resetAbandoned, stall, STUCK_ENGINE } from "../src/exports.ts";
import * as seams from "../src/seams.ts";
import * as jobs from "../src/jobs.ts";
import type { Project } from "../src/model.ts";
import * as wake from "../src/wake.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

const was = { stall: { ...stall }, abandon: { ...abandon }, most: process.env.EDIT_LOCAL_EXPORTS };
beforeEach(() => {
  // One place at a time, whatever Mac runs the tests; the clocks shortened.
  process.env.EDIT_LOCAL_EXPORTS = "1";
  Object.assign(stall, { ms: 40, everyMs: 10 });
  Object.assign(abandon, { ms: 60 });
  resetAbandoned();
});
afterEach(() => {
  Object.assign(stall, was.stall);
  Object.assign(abandon, was.abandon);
  if (was.most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
  else process.env.EDIT_LOCAL_EXPORTS = was.most;
  wake.stopForTests();
  resetAbandoned();
});

/** A fixture whose engine hangs for the projects named in `stuck` (never ends, cancel does nothing) and finishes the rest. */
function hanging(name: string, stuck: Set<string>) {
  const t = fixtureHome(name);
  const registry = new ExportRegistry(t.home);
  t.app.exports = registry;
  const started: string[] = [];
  const cancels: string[] = [];
  const plan = spyOn(t.native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(t.native.ExportJob, "start").mockImplementation((job, progress) => {
    const named = JSON.parse(job.project.json).name as string;
    started.push(named);
    if (stuck.has(named)) {
      progress(0.2);
      return { cancel: () => void cancels.push(named), wait: () => new Promise<never>(() => {}) };
    }
    return { cancel: () => {}, wait: async () => { fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  const project = async (named: string): Promise<Project> => {
    const id = t.store.create(named, { width: 64, height: 36, fps: 30 }).project.id;
    await t.store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    return structuredClone(t.store.get(id)!.project);
  };
  const until = async (done: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await Bun.sleep(5);
    return done();
  };
  const cleanup = () => {
    render.mockRestore();
    archive.mockRestore();
    plan.mockRestore();
    t.cleanup();
  };
  return { ...t, registry, started, cancels, project, until, cleanup };
}

test("a stalled render the engine never ends is given up on: the export fails as passing, its place goes to the next, and nothing follows it any more", async () => {
  const t = hanging("engine-hangs", new Set(["Stuck"]));
  try {
    const stuck = await t.project("Stuck");
    const next = await t.project("Next");
    const options = t.native.exportDefaults();
    // Told it's in line to go again by itself, never "failed" with a Retry to press (the Nov 21 audit).
    const failed: string[] = [];
    t.store.subscribe((event) => {
      if (event.type === "export" && event.id === stuck.id && event.state === "failed") failed.push(String(event.error));
      if (event.type === "export" && event.id === stuck.id && event.state === "queued") failed.push(String(event.waiting));
    });
    await t.registry.start(t.store, t.app.library, stuck, options, `${t.dir}/stuck.mp4`, { drive: false, keepLocal: true });
    await t.registry.start(t.store, t.app.library, next, options, `${t.dir}/next.mp4`, { drive: false, keepLocal: true });
    expect(t.registry.activity().find((one) => one.id === next.id)?.state).toBe("queued");
    // Within the stall (40 ms), its stop and the time it's given (60 ms): over, said as trouble that passes.
    expect(await t.until(() => failed.length > 0)).toBe(true);
    expect(t.cancels).toEqual(["Stuck"]);
    expect(failed[0]).toStartWith("waiting to start again by itself (");
    expect(failed[0]).toContain("Edit tries again by itself");
    // A share following it (reviews.ts exportOnce) waits on this, and on the event above.
    expect(t.registry.runningFor(stuck.id)).toBeNull();
    // It waits in the job table to go again by itself, a fresh engine job (the export resumer).
    const row = jobs.list(t.home, "export").find((one) => one.project === stuck.id);
    expect(row).toMatchObject({ state: "waiting" });
    expect(row?.retry_at).toBeGreaterThan(Date.now());
    // The export behind it had the place.
    expect(await t.until(() => t.registry.activity().find((one) => one.id === next.id)?.state === "done")).toBe(true);
    expect(t.started).toEqual(["Stuck", "Next"]);
    expect(t.registry.running()).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("a second engine job given up on in one run says to quit and reopen Edit, and isn't tried again by itself", async () => {
  const t = hanging("engine-hangs-twice", new Set(["One", "Two"]));
  try {
    const options = t.native.exportDefaults();
    const one = await t.project("One");
    await t.registry.start(t.store, t.app.library, one, options, `${t.dir}/one.mp4`, { drive: false, keepLocal: true });
    expect(await t.until(() => t.registry.activity().find((row) => row.id === one.id)?.state === "queued")).toBe(true);
    const two = await t.project("Two");
    await t.registry.start(t.store, t.app.library, two, options, `${t.dir}/two.mp4`, { drive: false, keepLocal: true });
    expect(await t.until(() => t.registry.activity().find((row) => row.id === two.id)?.state === "failed")).toBe(true);
    expect(t.registry.activity().find((row) => row.id === two.id)?.error).toBe(STUCK_ENGINE);
    expect(jobs.list(t.home, "export").find((row) => row.project === two.id)).toMatchObject({ state: "failed" });
  } finally {
    t.cleanup();
  }
});

test("Cancel on a render the engine never ends: cancelled within the time it's given, and the next export starts", async () => {
  // A long stall, so only the Cancel stops it.
  Object.assign(stall, { ms: 60_000, everyMs: 10 });
  const t = hanging("engine-hangs-cancel", new Set(["Stuck"]));
  try {
    const stuck = await t.project("Stuck");
    const next = await t.project("Next");
    const options = t.native.exportDefaults();
    await t.registry.start(t.store, t.app.library, stuck, options, `${t.dir}/stuck.mp4`, { drive: false, keepLocal: true });
    await t.registry.start(t.store, t.app.library, next, options, `${t.dir}/next.mp4`, { drive: false, keepLocal: true });
    expect(await t.until(() => t.started.includes("Stuck"))).toBe(true);
    expect(t.registry.cancel(stuck.id)).toBe(true);
    expect(await t.until(() => t.registry.activity().find((one) => one.id === stuck.id)?.state === "cancelled")).toBe(true);
    expect(await t.until(() => t.registry.activity().find((one) => one.id === next.id)?.state === "done")).toBe(true);
    expect(jobs.list(t.home, "export").some((one) => one.project === stuck.id)).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("an export someone asks for never waits for ever on one made ahead that's stuck in the engine", async () => {
  Object.assign(stall, { ms: 60_000, everyMs: 10 });
  const t = hanging("engine-hangs-ahead", new Set(["Ahead"]));
  try {
    const ahead = await t.project("Ahead");
    const asked = await t.project("Asked");
    const options = t.native.exportDefaults();
    expect(t.registry.startAhead(t.store, t.app.library, ahead, options, aheadFile(t.store.cacheDir(), ahead.id))).toBe(true);
    expect(await t.until(() => t.started.includes("Ahead"))).toBe(true);
    // Its own project's Export stops it first (start → stopAhead): that returns.
    const began = Date.now();
    await t.registry.start(t.store, t.app.library, ahead, options, `${t.dir}/ahead.mp4`, { drive: false, keepLocal: true });
    expect(Date.now() - began).toBeLessThan(2000);
    expect(t.registry.aheadFor()).toBeNull();
    expect(await t.until(() => t.started.filter((one) => one === "Ahead").length > 1)).toBe(true);
    // That one is stuck too; cancelled, another project's export gets the place.
    t.registry.cancel(ahead.id);
    await t.registry.start(t.store, t.app.library, asked, options, `${t.dir}/asked.mp4`, { drive: false, keepLocal: true });
    expect(await t.until(() => t.registry.activity().find((one) => one.id === asked.id)?.state === "done", 5000)).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("a lid closed past the stall's time is no stall: the clock starts again at the wake", async () => {
  // Finding 10: performance.now() may count a Mac's sleep. Stalled after 80 ms here; a wake every 30 ms keeps it going.
  Object.assign(stall, { ms: 80, everyMs: 10 });
  const t = hanging("engine-wake", new Set(["Sleeper"]));
  try {
    const sleeper = await t.project("Sleeper");
    await t.registry.start(t.store, t.app.library, sleeper, t.native.exportDefaults(), `${t.dir}/sleeper.mp4`, { drive: false, keepLocal: true });
    expect(await t.until(() => t.started.includes("Sleeper"))).toBe(true);
    for (let at = 0; at < 10; at++) {
      await Bun.sleep(30);
      wake.woke(10 * 60_000);
    }
    expect(t.cancels).toEqual([]);
    expect(t.registry.activity().find((one) => one.id === sleeper.id)?.state).toBe("running");
    // Without wakes it stalls as before.
    expect(await t.until(() => t.cancels.length > 0)).toBe(true);
  } finally {
    t.cleanup();
  }
});

/** An export whose engine can't read its effect's render: `remake` is asked for it, and here it never comes back. */
async function remaking(name: string) {
  const t = fixtureHome(name);
  const registry = new ExportRegistry(t.home);
  t.app.exports = registry;
  const render = `${t.dir}/fx-k1.mp4`;
  fs.writeFileSync(render, "not a video");
  const plan = spyOn(t.native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const engine = spyOn(t.native.ExportJob, "start").mockImplementation(() => ({ cancel: () => {}, wait: async () => { throw new Error(`couldn't read ${render}`); } }));
  let asked = 0;
  const remake = spyOn(seams.broll, "remakeEffect").mockImplementation(() => { asked += 1; return new Promise<void>(() => {}); });
  const id = t.store.create("Remade", { width: 64, height: 36, fps: 30 }).project.id;
  await t.store.update(id, "test", (p) => {
    p.media.push({ id: "fx", name: "fx", path: render, kind: "video", duration: 1, width: 64, height: 36, fps: 30, has_audio: false, effect: "fx", effect_key: "k1" } as never);
    p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" }));
  });
  const project = structuredClone(t.store.get(id)!.project);
  const until = async (done: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await Bun.sleep(5);
    return done();
  };
  return {
    ...t, registry, id, project, until, asked: () => asked,
    cleanup: () => { remake.mockRestore(); engine.mockRestore(); archive.mockRestore(); plan.mockRestore(); t.cleanup(); },
  };
}

test("an export waiting for an effect's render to be made again stops at once on Cancel", async () => {
  const t = await remaking("remake-cancel");
  try {
    await t.registry.start(t.store, t.app.library, t.project, t.native.exportDefaults(), `${t.dir}/remade.mp4`, { drive: false, keepLocal: true });
    expect(await t.until(() => t.asked() === 1)).toBe(true);
    const asked = Date.now();
    t.registry.cancel(t.id);
    expect(await t.until(() => t.registry.activity().find((one) => one.id === t.id)?.state === "cancelled", 1000)).toBe(true);
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(t.registry.running()).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("an effect's render that takes too long to make again ends the export as a wait that goes again by itself", async () => {
  const limit = REMAKE_MS.value;
  REMAKE_MS.value = 50;
  const t = await remaking("remake-limit");
  try {
    await t.registry.start(t.store, t.app.library, t.project, t.native.exportDefaults(), `${t.dir}/remade.mp4`, { drive: false, keepLocal: true });
    // In line to go again by itself, said so, never "failed" with a Retry to press while it waits (the Nov 21 audit).
    expect(await t.until(() => t.registry.activity().find((one) => one.id === t.id)?.state === "queued")).toBe(true);
    expect(t.registry.activity().find((one) => one.id === t.id)?.waiting).toBe("waiting to start again by itself (making the fx effect's render again took more than 0 s and was stopped)");
    expect(jobs.list(t.home, "export").find((one) => one.project === t.id)).toMatchObject({ state: "waiting" });
  } finally {
    REMAKE_MS.value = limit;
    t.cleanup();
  }
});

// Nov 21, bad-day's cold-export-drop on the final code: the line dropped two minutes while an export read its footage
// from the cloud. It tried three ways in 25 seconds ("could not decode <url> failed to fill whole buffer" each time),
// then was "failed" with a Retry to press. The same words ended exports 26 times in two days in Sphe's log.
test("an export the connection dropped under waits and goes again by itself; one that fails for a reason of its own still fails", async () => {
  const t = fixtureHome("export-line-dropped");
  const registry = new ExportRegistry(t.home);
  t.app.exports = registry;
  const plan = spyOn(t.native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(t.native.ExportJob, "start").mockImplementation((job) => {
    const named = JSON.parse(job.project.json).name as string;
    const why = named === "Dropped" ? "could not decode <url> failed to fill whole buffer" : named === "Full" ? "No space left on device (os error 28)" : "the encoder stopped early";
    return { cancel: () => {}, wait: () => Promise.reject(new Error(`${named}: ${why}`)) };
  });
  const make = async (named: string): Promise<Project> => {
    const id = t.store.create(named, { width: 64, height: 36, fps: 30 }).project.id;
    await t.store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    return structuredClone(t.store.get(id)!.project);
  };
  const rowOf = (id: string) => jobs.list(t.home, "export").find((one) => one.project === id);
  const settled = async (id: string) => {
    for (let waited = 0; waited < 5000 && (rowOf(id)?.state ?? "running") === "running"; waited += 10) await Bun.sleep(10);
    return rowOf(id);
  };
  // What the page is told, project by project: the last `export` event.
  const told = new Map<string, string>();
  const stop = t.store.subscribe((event) => {
    const one = event as { type?: string; id?: string; state?: string };
    if (one.type === "export" && one.id !== undefined && one.state !== undefined) told.set(one.id, one.state);
  });
  try {
    const options = t.native.exportDefaults();
    const dropped = await make("Dropped");
    await registry.start(t.store, t.app.library, dropped, options, `${t.dir}/dropped.mp4`, { drive: false, keepLocal: true });
    const waiting = await settled(dropped.id);
    expect(waiting).toMatchObject({ state: "waiting" });
    expect(waiting?.retry_at).toBeGreaterThan(Date.now());
    expect(String(waiting?.why)).toContain("the connection dropped");
    // The page is told it's in line to go again, not that it failed (the Nov 21 audit).
    expect(told.get(dropped.id)).toBe("queued");
    // The disk full: it waits for room and goes by itself, never a Retry to press (Nov 22).
    const full = await make("Full");
    await registry.start(t.store, t.app.library, full, options, `${t.dir}/full.mp4`, { drive: false, keepLocal: true });
    expect(await settled(full.id)).toMatchObject({ state: "waiting" });
    expect(told.get(full.id)).toBe("queued");
    // Its own failure (nothing failure.ts knows as trouble that passes): failed, as before, for a person or the next build.
    const broken = await make("Broken");
    await registry.start(t.store, t.app.library, broken, options, `${t.dir}/broken.mp4`, { drive: false, keepLocal: true });
    expect(await settled(broken.id)).toMatchObject({ state: "failed" });
    expect(told.get(broken.id)).toBe("failed");
  } finally {
    stop();
    render.mockRestore();
    archive.mockRestore();
    plan.mockRestore();
    t.cleanup();
  }
});
