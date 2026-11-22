// The export routes (routes.ts): a Cancel pressed while a quick Export is still starting, and the export's state for a
// page that was away when its events went.

import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import { exportCloud, ExportRegistry } from "../src/exports.ts";
import * as exportSteps from "../src/export_steps.ts";
import * as jobs from "../src/jobs.ts";
import type { ExportOptions, Project } from "../src/model.ts";
import type * as seams from "../src/seams.ts";
import type { Store } from "../src/store.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

function client(app: App) {
  const router = buildRouter();
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost:7700");
    return (await respond(app, router, new Request(`http://localhost:7700${path}`, { ...init, headers }), null))!;
  };
  return { send, post: (path: string, value: unknown) => send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }) };
}

/** A registry whose start waits for `gate` first, as one does on a watermark going on. */
class Slow extends ExportRegistry {
  gate: Promise<void> = Promise.resolve();
  override async start(store: Store, library: seams.Library, project: Project, options: ExportOptions, output: string, extra = {}): Promise<string> {
    await this.gate;
    return super.start(store, library, project, options, output, extra);
  }
}

test("Cancel pressed while a quick Export is still starting stops it once it's there", async () => {
  const registry = new Slow();
  const { dir, app, store, native, cleanup } = fixtureHome("route-cancel-starting", { services: { exports: registry } });
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    return { cancel: () => stop(), wait: async () => {
      const how = await Promise.race([stopped.then(() => "stopped"), Bun.sleep(2000).then(() => "done")]);
      if (how === "stopped") throw new Error("cancelled");
      fs.writeFileSync(job.output, "export");
      return { seconds: 1, bytes: 6 };
    } };
  });
  try {
    const id = store.create("Starting", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    let open!: () => void;
    registry.gate = new Promise<void>((resolve) => { open = resolve; });
    const { send, post } = client(app);
    const asked = post(`/api/projects/${id}/export`, { path: `${dir}/starting.mp4`, options: { format: "h264" } });
    await Bun.sleep(20);
    expect(await (await send(`/api/projects/${id}/export/cancel`, { method: "POST" })).json()).toEqual({ cancelled: true });
    open();
    expect(await (await asked).json()).toMatchObject({ cancelled: true });
    for (let tries = 0; registry.running() && tries < 200; tries++) await Bun.sleep(5);
    expect(registry.running()).toBe(false);
    expect(registry.activity().find((one) => one.id === id)?.state).toBe("cancelled");
  } finally {
    render.mockRestore(); archive.mockRestore(); plan.mockRestore();
    exportSteps.reset();
    cleanup();
  }
});

test("a page back from away reads the export as its events said it: failed, running, or none", async () => {
  const registry = new ExportRegistry();
  const { dir, app, store, native, home, cleanup } = fixtureHome("route-export-now", { services: { exports: registry } });
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(native.ExportJob, "start").mockImplementation(() => ({ cancel: () => {}, wait: async () => { throw new Error("Fixture encoder failed"); } }));
  try {
    const id = store.create("Away", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    const { send } = client(app);
    expect(await (await send(`/api/projects/${id}/export`)).json()).toEqual({ export: null });
    await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), `${dir}/away.mp4`, { drive: false, keepLocal: true });
    for (let tries = 0; registry.running() && tries < 200; tries++) await Bun.sleep(5);
    expect(await (await send(`/api/projects/${id}/export`)).json()).toMatchObject({ export: { state: "failed", progress: 0, error: "Fixture encoder failed" } });
    // After a restart (nothing in memory), one the job table holds waiting to start again is said as queued, with when.
    const fresh = fixtureHome("route-export-now-restarted", { services: { exports: new ExportRegistry() } });
    try {
      const other = fresh.store.create("Resumed", { width: 64, height: 36, fps: 30 }).project.id;
      const key = jobs.begin(fresh.home, "export", other, { options: native.exportDefaults(), output: `${fresh.dir}/resumed.mp4` });
      jobs.wait(fresh.home, key, "the cutfx-3 effect is still rendering: export again in a minute or two");
      const said = (await (await client(fresh.app).send(`/api/projects/${other}/export`)).json()) as { export: { state: string; waiting: string } };
      expect(said.export.state).toBe("queued");
      expect(said.export.waiting).toMatch(/^waiting to start again at \d\d:\d\d \(the cutfx-3 effect is still rendering/);
    } finally {
      fresh.cleanup();
    }
    void home;
  } finally {
    render.mockRestore(); archive.mockRestore(); plan.mockRestore();
    cleanup();
  }
});

test("an Export waiting for its graphics is written down, found again after a restart, waits again and starts as it was asked", async () => {
  const { carryOnAsked } = await import("../src/routes.ts");
  const broll = await import("../src/broll.ts");
  const { dir, app, store, home, cleanup } = fixtureHome("route-graphics-restart", { services: { exports: new ExportRegistry() } });
  // Before the restart its graphics never come in (the run ends); after it, once `rendered` is called.
  let restarted = false;
  let rendered!: () => void;
  const done = new Promise<void>((resolve) => (rendered = resolve));
  const wait = spyOn(broll, "waitForMaps").mockImplementation(async (_app, _id, limit) => {
    if (limit <= 5000) throw new Error("The board effect is still rendering (12 of 60 frames): export again in a minute or two.");
    await (restarted ? done : new Promise<never>(() => {}));
  });
  try {
    const id = store.create("Graphics", { width: 64, height: 36, fps: 30 }).project.id;
    const asked = await client(app).post(`/api/projects/${id}/export`, { path: `${dir}/graphics.mp4`, keepLocal: true, options: { format: "h264", quality: "high" } });
    expect(await asked.json()).toMatchObject({ started: true });
    const key = jobs.keyOf("export", id);
    expect(jobs.get(home, key)).toMatchObject({ state: "running", step: exportSteps.GRAPHICS_STEP, args: { graphics: true, output: `${dir}/graphics.mp4`, options: { format: "h264", quality: "high" }, extra: { keepLocal: true } } });

    // The restart: nothing in memory, a new registry. The queue still has it.
    restarted = true;
    exportSteps.reset();
    const registry = new ExportRegistry(home);
    app.exports = registry;
    const started: { options: ExportOptions; output: string; extra: unknown }[] = [];
    const start = spyOn(registry, "start").mockImplementation(async (_store, _library, _project, options, output, extra) => {
      started.push({ options, output, extra });
      return output;
    });
    expect(exportSteps.activity(app, new Set([id]))).toMatchObject([{ id, state: "queued", waiting: "waiting for its effects to render" }]);
    expect(await carryOnAsked(app, jobs.get(home, key)!)).toBe(true);
    // Waiting again, in the queue as it was, until its graphics are in.
    expect(exportSteps.activity(app, new Set([id]))).toMatchObject([{ id, state: "running", waiting: "waiting for its effects to render" }]);
    expect(started).toEqual([]);
    rendered();
    for (let tries = 0; started.length === 0 && tries < 200; tries++) await Bun.sleep(5);
    expect(started).toHaveLength(1);
    expect(started[0]!.options).toMatchObject({ format: "h264", quality: "high" });
    expect(started[0]!).toMatchObject({ output: `${dir}/graphics.mp4`, extra: { keepLocal: true } });
    // Its row is the export's from here (the registry's start writes it; mocked here): the wait's is crossed off.
    start.mockRestore();
  } finally {
    wait.mockRestore();
    exportSteps.reset();
    cleanup();
  }
});

test("an Export written down waiting for its graphics is cancelled from its row after a restart", async () => {
  const { dir, app, store, home, cleanup } = fixtureHome("route-graphics-cancel", { services: { exports: new ExportRegistry() } });
  try {
    const id = store.create("Graphics", { width: 64, height: 36, fps: 30 }).project.id;
    exportSteps.waitWritten(home, id, { options: { format: "h264" } as ExportOptions, output: `${dir}/g.mp4`, extra: {} });
    expect(await (await client(app).send(`/api/projects/${id}/export/cancel`, { method: "POST" })).json()).toEqual({ cancelled: true });
    expect(jobs.get(home, jobs.keyOf("export", id))).toBeUndefined();
  } finally {
    cleanup();
  }
});

// The Nov 21 audit: a second Export pressed while one waited for its graphics left the first waiting, out of Cancel's
// reach, to start by itself once they came in: two exports of one press.
test("a second Export while one waits for its graphics takes its place: one export starts, and Cancel reaches it", async () => {
  const broll = await import("../src/broll.ts");
  const { dir, app, store, home, cleanup } = fixtureHome("route-graphics-twice", { services: { exports: new ExportRegistry() } });
  let rendered!: () => void;
  const done = new Promise<void>((resolve) => (rendered = resolve));
  const signals: AbortSignal[] = [];
  const wait = spyOn(broll, "waitForMaps").mockImplementation(async (_app, _id, limit, signal) => {
    if (signal !== undefined) signals.push(signal);
    if (limit <= 5000) throw new Error("The board effect is still rendering (12 of 60 frames): export again in a minute or two.");
    await Promise.race([done, new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled while waiting for its graphics")), { once: true }))]);
  });
  const started: string[] = [];
  const start = spyOn(app.exports as ExportRegistry, "start").mockImplementation(async (_store, _library, _project, _options, output) => {
    started.push(output);
    return output;
  });
  try {
    const id = store.create("Graphics", { width: 64, height: 36, fps: 30 }).project.id;
    const ask = async (name: string) => (await client(app).post(`/api/projects/${id}/export`, { path: `${dir}/${name}.mp4`, keepLocal: true, options: { format: "h264", quality: "high" } })).json();
    expect(await ask("first")).toMatchObject({ started: true });
    expect(await ask("second")).toMatchObject({ started: true });
    // The first's wait was told to stop; its row is the second's.
    expect(signals[0]!.aborted).toBe(true);
    await Bun.sleep(20);
    expect(jobs.get(home, jobs.keyOf("export", id))).toMatchObject({ args: { output: `${dir}/second.mp4` } });
    rendered();
    for (let tries = 0; started.length === 0 && tries < 200; tries++) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(started).toEqual([`${dir}/second.mp4`]);
  } finally {
    start.mockRestore();
    wait.mockRestore();
    exportSteps.reset();
    cleanup();
  }
});
