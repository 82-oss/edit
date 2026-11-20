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

/** A registry whose start waits for `gate` first, as one does on an export made ahead stopping or a watermark going on. */
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
