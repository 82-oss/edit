// An export's plan on a long edit (Nov 21: "native exportPlan kept the server's thread for 716 ms" on a 2-hour edit,
// again and again). Sent as JSON, nearly all of a plan is the native side reading the whole project again; by
// reference to the revision it already holds it's a few milliseconds, and the same plan asked again is kept
// (exports.ts `planExport`). On the real engine, when it's built.

import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { exportCloud, ExportRegistry, forgetPlans, planExport, revOf } from "../src/exports.ts";
import { findAddon, native, useNative, wrap, type Native, type ProjectInput } from "../src/native/index.ts";
import { jsonForSerde } from "../src/rust.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";

const addon = findAddon();
let before: Native | null = null;
afterAll(() => {
  if (addon !== null) useNative(before);
  forgetPlans();
});

/** A 2-hour edit's size: 4,000 clips of 600 files, in a store whose saves the real engine holds. */
async function bigEdit(name: string) {
  const home = fixtureHome(name);
  const previous = useNative(wrap(require(addon!) as Native));
  before ??= previous;
  (require(addon!) as Native).init({ home: home.app.store.home, cacheDir: home.app.store.cacheDir(), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe(), log: () => {} });
  const id = home.app.store.create("Long", { width: 1920, height: 1080, fps: 30 }).project.id;
  // Its footage here (an export waits for footage that isn't).
  const footage = `${home.dir}/footage.mp4`;
  fs.writeFileSync(footage, "footage");
  await home.app.store.update(id, "test", (p) => {
    for (let n = 0; n < 600; n++) p.media.push({ id: `m${n}`, name: `f${n}.mp4`, path: footage, kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true } as never);
    for (let n = 0; n < 4000; n++) p.clips.push({ id: `c${n}`, type: "video", track: p.tracks[0]!.id, start: n * 54, duration: 54, media: `m${n % 600}`, source_in: (n % 10) * 3, speed: 1, volume: 1, fade_in: 0, fade_out: 0 } as never);
  });
  return { ...home, id };
}

/** Native's plans while `work` runs: how many, how each was sent, and the time they kept the thread. */
function counted() {
  const sent: ("ref" | "json")[] = [];
  let ms = 0;
  const real = native().exportPlan.bind(native());
  const spy = spyOn(native(), "exportPlan").mockImplementation((project: ProjectInput, options) => {
    sent.push("ref" in project ? "ref" : "json");
    const began = performance.now();
    try {
      return real(project, options);
    } finally {
      ms += performance.now() - began;
    }
  });
  return { sent, ms: () => ms, restore: () => spy.mockRestore() };
}

test.skipIf(addon === null)("a long edit's plan is made by reference to its revision, once for the same options, and is the plan JSON would give", async () => {
  const t = await bigEdit("plan-kept");
  try {
    forgetPlans();
    const live = t.store.get(t.id)!;
    const options = native().exportDefaults();
    expect(revOf(t.store, live.project)).toBe(live.rev);
    expect(revOf(t.store, structuredClone(live.project))).toBeNull();

    // As it was: five asks, five plans sent as JSON.
    const was = counted();
    const began = performance.now();
    const before = [0, 1, 2, 3, 4].map(() => native().exportPlan({ json: jsonForSerde(live.project) }, options));
    const wasMs = performance.now() - began;
    was.restore();

    const now = counted();
    const started = performance.now();
    const after = [0, 1, 2, 3, 4].map(() => planExport(live.project, options, live.rev));
    const nowMs = performance.now() - started;
    // Another stretch of the same revision is its own plan, by reference too.
    const stretch = planExport(live.project, { ...options, range: [0, 300] }, live.rev);
    now.restore();
    console.log(`five plans of 4,000 clips: as JSON ${Math.round(wasMs)} ms on the thread (native ${Math.round(was.ms())} ms); kept by revision ${Math.round(nowMs)} ms (native ${Math.round(now.ms())} ms, ${now.sent.length - 1} call)`);
    expect(now.sent).toEqual(["ref", "ref"]);
    expect(after).toEqual(before);
    expect(stretch.plan.end).toBe(300);
    expect(nowMs).toBeLessThan(wasMs / 10);

    // A new revision is planned again.
    await t.store.update(t.id, "test", (p) => void (p.name = "Longer"));
    const next = counted();
    planExport(t.store.get(t.id)!.project, options, t.store.get(t.id)!.rev);
    next.restore();
    expect(next.sent).toEqual(["ref"]);
  } finally {
    t.cleanup();
  }
});

test.skipIf(addon === null)("an Export of the edit as it is plans it by reference, and one of a copy (a snapshot, a share's) as JSON", async () => {
  const t = await bigEdit("plan-kept-export");
  const registry = new ExportRegistry(t.home);
  t.app.exports = registry;
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(native().ExportJob, "start").mockImplementation((job) => ({ cancel: () => {}, wait: async () => { fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } }));
  const plans = counted();
  try {
    forgetPlans();
    const options = { ...native().exportDefaults(), range: [0, 30] as [number, number] };
    await registry.start(t.store, t.app.library, t.store.get(t.id)!.project, options, `${t.dir}/one.mp4`, { drive: false, keepLocal: true });
    for (let tries = 0; registry.running() && tries < 400; tries++) await Bun.sleep(10);
    await registry.start(t.store, t.app.library, structuredClone(t.store.get(t.id)!.project), options, `${t.dir}/two.mp4`, { drive: false, keepLocal: true });
    for (let tries = 0; registry.running() && tries < 400; tries++) await Bun.sleep(10);
    expect(plans.sent).toEqual(["ref", "json"]);
  } finally {
    plans.restore();
    render.mockRestore();
    archive.mockRestore();
    t.cleanup();
  }
});
