// An export's bar (Nov 21, a MacBook Air): one killed at 29.9% was carried on by itself with 6 of its 26 chunks made,
// and its bar went back to 1%, crawled, and went from 77% to 100% at the end; a fresh export's join (22 s there) said
// 100% all the while. The engine here is a stand-in that does what render.rs `export_chunked` does as far as the
// server can see: it writes its plan, counts the chunks already there as made, reports its fraction over the chunks it
// has left (and 5% for the sound's mix, which it writes beside its file), renames each chunk into place whole, writes
// the list it joins from and then the file, growing, and reports 1 once the file is whole.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { barLooks, ExportRegistry, exportCloud, JOIN_SHARE, JOINING } from "../src/exports.ts";
import type { Project } from "../src/model.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

const CHUNKS = 12;
const FRAMES = 30;
/** The engine's pace here: a report every `STEP_MS`, three to a chunk; its join a little longer than a chunk. */
const STEP_MS = 30;
const JOIN_MS = 400;

const was = { looks: barLooks.everyMs, most: process.env.EDIT_LOCAL_EXPORTS };
beforeEach(() => {
  process.env.EDIT_LOCAL_EXPORTS = "1";
  barLooks.everyMs = 25;
});
afterEach(() => {
  barLooks.everyMs = was.looks;
  if (was.most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
  else process.env.EDIT_LOCAL_EXPORTS = was.most;
});

interface Seen {
  state: string;
  progress: number;
  phase?: string;
  /** The stand-in was joining as it was said. */
  joining: boolean;
}

/** A home whose engine is the stand-in; `stopAfter` chunks made in a run, it stands still until it's stopped. */
function home(name: string) {
  const t = fixtureHome(name);
  const plan = spyOn(t.native, "exportPlan").mockReturnValue({ plan: { start: 0, end: CHUNKS * FRAMES, width: 64, height: 36, audio: true }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const engine = { stopAfter: Infinity, joining: false, made: 0 };
  const render = spyOn(t.native.ExportJob, "start").mockImplementation((job, progress) => {
    const id = JSON.parse(job.project.json).id as string;
    // render.rs `chunk_folder`, `partial_path`: named as the engine names them.
    const dir = `${job.cacheDir}/export-chunks/${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const partial = `${job.output}.${process.pid}-${id}.partial.mp4`;
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let cancelled = false;
    const wait = async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(partial, "");
      const keys = Array.from({ length: CHUNKS }, (_, at) => `chunk${at}`);
      fs.writeFileSync(`${dir}/plan-v1.json`, JSON.stringify({ version: 1, extension: "mp4", chunks: keys.map((key, at) => ({ start: at * FRAMES, end: (at + 1) * FRAMES, key })) }));
      const todo = keys.filter((key) => !fs.existsSync(`${dir}/${key}.mp4`));
      const sound = 0.05;
      const picture = (1 - sound) * (todo.length / CHUNKS);
      const mix = `${partial}.sound.m4a`;
      fs.writeFileSync(`${mix}.mixing.m4a`, "mixing");
      let rendered = 0;
      let made = 0;
      const total = todo.length * FRAMES;
      for (const key of todo) {
        for (let third = 1; third <= 3; third++) {
          await Promise.race([Bun.sleep(STEP_MS), stopped]);
          if (cancelled) throw new Error("cancelled");
          rendered += FRAMES / 3;
          const done = rendered / total;
          const heard = Math.min(1, done * 2);
          if (heard >= 1 && fs.existsSync(`${mix}.mixing.m4a`)) fs.renameSync(`${mix}.mixing.m4a`, mix);
          progress(sound * heard + picture * done);
        }
        fs.writeFileSync(`${dir}/${key}.partial.mp4`, Buffer.alloc(1000));
        fs.renameSync(`${dir}/${key}.partial.mp4`, `${dir}/${key}.mp4`);
        made += 1;
        engine.made += 1;
        if (made >= engine.stopAfter) {
          await stopped;
          throw new Error("cancelled");
        }
      }
      if (fs.existsSync(`${mix}.mixing.m4a`)) fs.renameSync(`${mix}.mixing.m4a`, mix);
      // The join: its list, then the file growing to the chunks' bytes, then its index moved and its frames counted.
      engine.joining = true;
      fs.writeFileSync(`${partial}.chunks.txt`, keys.map((key) => `file '${dir}/${key}.mp4'`).join("\n"));
      for (let part = 1; part <= 8; part++) {
        await Bun.sleep(JOIN_MS / 10);
        fs.appendFileSync(partial, Buffer.alloc((CHUNKS * 1000) / 8));
      }
      await Bun.sleep((JOIN_MS / 10) * 2);
      engine.joining = false;
      progress(1);
      fs.renameSync(partial, job.output);
      for (const extra of [`${partial}.chunks.txt`, mix]) fs.rmSync(extra, { force: true });
      for (const key of keys) fs.rmSync(`${dir}/${key}.mp4`, { force: true });
      return { seconds: 1, bytes: CHUNKS * 1000 };
    };
    return {
      cancel: () => {
        cancelled = true;
        stop();
      },
      wait,
    };
  });
  const project = async (): Promise<Project> => {
    const id = t.store.create("Welfare check", { width: 64, height: 36, fps: 30 }).project.id;
    await t.store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: CHUNKS * FRAMES, type: "solid" })));
    return structuredClone(t.store.get(id)!.project);
  };
  /** Every `export` event of `id` from now on, with whether the engine was joining as it went. */
  const listen = (id: string) => {
    const seen: Seen[] = [];
    const off = t.store.subscribe((event) => {
      const one = event as { type?: string; id?: string; state?: string; progress?: number; phase?: string };
      if (one.type !== "export" || one.id !== id) return;
      seen.push({ state: one.state ?? "", progress: one.progress ?? 0, ...(one.phase === undefined ? {} : { phase: one.phase }), joining: engine.joining });
    });
    return { seen, off };
  };
  const cleanup = () => {
    render.mockRestore();
    archive.mockRestore();
    plan.mockRestore();
    t.cleanup();
  };
  return { ...t, engine, project, listen, cleanup };
}

async function until(done: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await Bun.sleep(5);
}

/** The bar's numbers while it ran: never back, never 1 before the end, no step past `most`. */
function climbs(seen: Seen[], most: number): number[] {
  const running = seen.filter((one) => one.state === "running").map((one) => one.progress);
  running.forEach((value, at) => {
    if (at > 0) expect(value).toBeGreaterThanOrEqual(running[at - 1]!);
    expect(value).toBeLessThan(1);
  });
  const all = [...running, seen.at(-1)!.progress];
  for (let at = 1; at < all.length; at++) expect(all[at]! - all[at - 1]!).toBeLessThanOrEqual(most);
  return running;
}

test("an export carried on with chunks made counts them as done from its first line, climbs steadily and reaches 100% only once its file is whole", async () => {
  const t = home("export-progress-carried");
  try {
    const project = await t.project();
    const options = t.native.exportDefaults();
    const output = `${t.dir}/carried.mp4`;
    // Cut short with 4 of its 12 chunks made (Edit killed: here, stopped), as Sphe's Air was at 29.9%.
    t.engine.stopAfter = 4;
    const first = new ExportRegistry(t.home);
    t.app.exports = first;
    await first.start(t.store, t.app.library, project, options, output, { drive: false, keepLocal: true });
    await until(() => t.engine.made >= 4);
    first.cancel(project.id);
    await until(() => !first.running());
    // Carried on by a new Edit (a new registry), the 4 chunks kept.
    t.engine.stopAfter = Infinity;
    const second = new ExportRegistry(t.home);
    t.app.exports = second;
    const { seen, off } = t.listen(project.id);
    await second.start(t.store, t.app.library, project, options, output, { drive: false, keepLocal: true });
    await until(() => !second.running());
    off();
    expect(seen.at(-1)).toMatchObject({ state: "done", progress: 1 });
    // The share made before, as the bar counts it: its picture, short of the sound's mix and the join's own ends.
    const made = (4 / CHUNKS) * (1 - 0.05) * (1 - JOIN_SHARE);
    const running = seen.filter((one) => one.state === "running").map((one) => one.progress);
    expect(Math.min(...running)).toBeGreaterThanOrEqual(made - 1e-9);
    climbs(seen, 0.06);
    // It said its join, and the end of the bar wasn't reached before it.
    expect(seen.some((one) => one.phase === JOINING)).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("a fresh export climbs from 0, and its join has its own end of the bar, said, never 100% before the file is whole", async () => {
  const t = home("export-progress-fresh");
  try {
    const project = await t.project();
    const registry = new ExportRegistry(t.home);
    t.app.exports = registry;
    const { seen, off } = t.listen(project.id);
    await registry.start(t.store, t.app.library, project, t.native.exportDefaults(), `${t.dir}/fresh.mp4`, { drive: false, keepLocal: true });
    await until(() => !registry.running());
    off();
    expect(seen.at(-1)).toMatchObject({ state: "done", progress: 1 });
    const running = climbs(seen, 0.06);
    expect(running[0]).toBeLessThan(0.05);
    // While it joins: under 1, said as the join, and it moves.
    const joining = seen.filter((one) => one.state === "running" && one.joining);
    expect(joining.length).toBeGreaterThan(0);
    for (const one of joining) expect(one.progress).toBeLessThan(1);
    expect(joining.some((one) => one.phase === JOINING)).toBe(true);
    expect(joining.at(-1)!.progress).toBeGreaterThan(joining[0]!.progress);
  } finally {
    t.cleanup();
  }
});
