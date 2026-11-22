// Exports made ahead are gone (export_ahead.ts, Nov 22): nothing makes one any more, and what earlier builds made
// (8.6 GB of one project's on Sphe's Linux Edit) goes as the server starts.

import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import * as ahead from "../src/export_ahead.ts";
import { exportCloud, ExportRegistry } from "../src/exports.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

test("what earlier builds made ahead goes as the server starts, and nothing else of the cache with it", async () => {
  const { store, app, cleanup } = fixtureHome("ahead-leftovers");
  const cache = store.cacheDir();
  try {
    fs.mkdirSync(`${cache}/ahead`, { recursive: true });
    fs.writeFileSync(`${cache}/ahead/p1-2.mp4`, Buffer.alloc(700));
    fs.writeFileSync(`${cache}/ahead/p1-2.mp4.json`, "{}");
    fs.mkdirSync(`${cache}/export-chunks/p1-2`, { recursive: true });
    fs.writeFileSync(`${cache}/export-chunks/p1-2/manifest-v1.json`, "{}");
    ahead.start(app);
    for (let tries = 0; fs.existsSync(`${cache}/ahead`) && tries < 200; tries++) await Bun.sleep(5);
    expect(fs.existsSync(`${cache}/ahead`)).toBe(false);
    // The chunks the next export of the same edit copies from stay.
    expect(fs.existsSync(`${cache}/export-chunks/p1-2/manifest-v1.json`)).toBe(true);
    // None there (every start after the first): nothing to do.
    expect(await ahead.removeLeftovers(cache)).toBe(0);
  } finally {
    cleanup();
  }
});

test("an export someone asks for takes the encoder at once: nothing is made in the background before or after it", async () => {
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "1";
  const { dir, home, store, app, native, cleanup } = fixtureHome("ahead-none");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const outputs: string[] = [];
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => {
    outputs.push(job.output);
    return { cancel: () => {}, wait: async () => { fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  try {
    const id = store.create("Asked", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", (p) => p.clips.push(clip({ id: "s1", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    ahead.start(app);
    await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), `${dir}/asked.mp4`, { drive: false, keepLocal: true });
    for (let tries = 0; registry.activity().find((one) => one.id === id)?.state !== "done" && tries < 200; tries++) await Bun.sleep(5);
    expect(registry.activity().find((one) => one.id === id)?.state).toBe("done");
    expect(outputs).toEqual([`${dir}/asked.mp4`]);
    expect(fs.existsSync(`${store.cacheDir()}/ahead`)).toBe(false);
    expect("startAhead" in registry).toBe(false);
  } finally {
    render.mockRestore(); archive.mockRestore(); plan.mockRestore();
    if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
    else process.env.EDIT_LOCAL_EXPORTS = most;
    cleanup();
  }
});
