// The export registry on the encoder's lease (Nov 22): exports run one fewer at once while a play is watched, the
// play's own smooth render still goes, and smooth playback's render waits for a share's review copy and gives way to
// one that starts while it renders.

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import * as encoder from "../src/encoder.ts";
import * as capacity from "../src/export_capacity.ts";
import { exportCloud, ExportRegistry } from "../src/exports.ts";
import type { Project } from "../src/model.ts";
import * as playing from "../src/playing.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  playing.note("p", false);
  encoder.reset();
});

/** A registry whose engine renders until each export's release, on a Mac with room for `most` at once. */
async function setUp(most: number, names: string[]) {
  const was = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = String(most);
  const size = capacity.machine.totalBytes;
  capacity.machine.totalBytes = 24 * 1024 ** 3;
  const free = spyOn(capacity.machine, "availablePercent").mockReturnValue(70);
  const load = spyOn(capacity.machine, "load").mockReturnValue(1);
  const t = fixtureHome("export-lease");
  const registry = new ExportRegistry(t.home);
  t.app.exports = registry;
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const plan = spyOn(t.native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(t.native.ExportJob, "start").mockImplementation((job) => {
    const name = JSON.parse(job.project.json).name as string;
    started.push(name);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    releases.set(name, release);
    return { cancel: () => release(), wait: async () => { await wait; fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  restores.push(() => {
    for (const release of releases.values()) release();
    render.mockRestore(); archive.mockRestore(); plan.mockRestore(); free.mockRestore(); load.mockRestore();
    capacity.machine.totalBytes = size;
    if (was === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
    else process.env.EDIT_LOCAL_EXPORTS = was;
    t.cleanup();
  });
  const projects: Project[] = [];
  for (const name of names) {
    const id = t.store.create(name, { width: 64, height: 36, fps: 30 }).project.id;
    await t.store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    projects.push(structuredClone(t.store.get(id)!.project));
  }
  const start = (project: Project) => registry.start(t.store, t.app.library, project, t.native.exportDefaults(), `${t.dir}/${project.name}.mp4`, { drive: false, keepLocal: true });
  return { registry, started, releases, projects, start };
}

const until = async (ok: () => boolean) => {
  for (let tries = 0; !ok() && tries < 400; tries++) await Bun.sleep(5);
};

test("while a play is watched a Mac with two encoders runs one export at a time, the play's smooth render beside it; the second goes when the play stops", async () => {
  const { registry, started, releases, projects, start } = await setUp(2, ["one", "two"]);
  playing.note("p", true);
  await start(projects[0]!);
  await start(projects[1]!);
  await until(() => started.length >= 1);
  await Bun.sleep(50);
  expect(started).toEqual(["one"]);
  expect(registry.activity().find((one) => one.name === "two")?.state).toBe("queued");
  // The play's own render still has its place beside the one export.
  let given: (() => void) | null = null;
  const render = registry.takeTurn((release) => { given = release; });
  expect(render.release ?? given).not.toBeNull();
  (render.release ?? given)!();
  playing.note("p", false);
  await until(() => started.length >= 2);
  expect(started).toEqual(["one", "two"]);
  releases.get("one")!();
  releases.get("two")!();
  await until(() => !registry.running());
});

test("while a play is watched a lone export still starts: never none", async () => {
  const { started, releases, projects, start } = await setUp(1, ["only"]);
  playing.note("p", true);
  await start(projects[0]!);
  await until(() => started.length >= 1);
  expect(started).toEqual(["only"]);
  releases.get("only")!();
});

test("smooth playback's render waits while a share's review copy holds the encoder, and gives way to one that starts while it renders", async () => {
  const { registry } = await setUp(1, []);
  const copy = encoder.hold("a share's review copy", "share");
  let given: (() => void) | null = null;
  const turn = registry.takeTurn((release) => { given = release; });
  expect(turn.release).toBeNull();
  await Bun.sleep(30);
  expect(given).toBeNull();
  copy.release();
  await until(() => given !== null);
  expect(given).not.toBeNull();
  expect(encoder.holding("playback")).toEqual(["smooth playback's render"]);
  // Rendering: a review copy taking the encoder asks it to give way.
  let gaveWay = 0;
  given!();
  const next = registry.takeTurn(() => { throw new Error("given at once"); }, () => gaveWay++);
  expect(next.release).not.toBeNull();
  const again = encoder.hold("a share's review copy", "share");
  expect(gaveWay).toBe(1);
  next.release!();
  again.release();
  expect(encoder.busy()).toBe(false);
});
