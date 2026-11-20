// Nov 20: a lid closed during a Script mode preview encode was judged "too slow" on opening (the judge counted the
// sleep as the encode's time), and the join then encoded every recording again, the cloud ones over the network.

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join as joinPath } from "node:path";

import type { Script } from "@edit/types/writer";

import { ffmpeg } from "../../src/tools.ts";
import * as imports from "../../src/writer/imports.ts";
import * as media from "../../src/writer/media.ts";
import * as store from "../../src/writer/store.ts";
import { fixtureHome } from "../helpers/home.ts";

const has = Bun.which("ffmpeg") !== null;
const restores: (() => void)[] = [];
afterEach(() => {
  for (const undo of restores.splice(0)) undo();
});

function make(args: string[], out: string) {
  const done = Bun.spawnSync([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
}

test.skipIf(!has)("two hours away mid-encode (a lid closed) is time away, not its pace: the encode finishes", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "edit-pace-away-"));
  const was = { ...media.PACE };
  Object.assign(media.PACE, { afterMs: 1_500, everyMs: 20 });
  const real = Date.now.bind(Date);
  try {
    const source = joinPath(dir, "a.mp4");
    make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=90", "-f", "lavfi", "-i", "sine=d=90", "-shortest", "-c:v", "libx264", "-preset", "ultrafast"], source);
    // Every 200 ms the clock jumps two hours, as it does across a sleep (each try of the encode sees some).
    let jump = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => real() + jump);
    restores.push(() => clock.mockRestore());
    const sleeps = setInterval(() => (jump += 2 * 3_600_000), 200);
    restores.push(() => clearInterval(sleeps));
    const said: string[] = [];
    const diag = await import("../../src/diag.ts");
    const warn = spyOn(diag, "warn").mockImplementation((_area: string, line: string) => void said.push(line));
    restores.push(() => warn.mockRestore());
    await media.encodeProxy(source, joinPath(dir, "out.mp4"), 90_000);
    // Never stopped as slow (the hardware's try included: libx264 taking over would say so).
    expect(said.filter((line) => /too slowly|made no progress/u.test(line))).toEqual([]);
    expect(fs.existsSync(joinPath(dir, "out.mp4"))).toBe(true);
  } finally {
    Object.assign(media.PACE, was);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(!has)("a join with one recording's piece missing encodes that one piece, never the whole case again", async () => {
  const { app, cleanup } = fixtureHome("preview-one-piece");
  try {
    const data = store.dataDir(app.store.home);
    const id = "0bad-cafe-0002";
    const dir = store.scriptDir(data, id);
    const now = Date.now();
    const script = { id, title: "Three", sourceKind: "drive", sourceUrl: "", originalPath: "", status: "processing", stage: "downloading", progress: 5, error: null, durationMs: 0, words: [], clips: [], overview: [], parts: [], notes: [], kind: "interrogation", revision: 1, createdAt: now, updatedAt: now, proxyPath: null } as unknown as Script;
    const folder = joinPath(dir, "drive");
    fs.mkdirSync(joinPath(dir, "pieces"), { recursive: true });
    fs.mkdirSync(folder, { recursive: true });
    const files = ["a", "b", "c"].map((name) => joinPath(folder, `${name}.mp4`));
    for (const file of files) make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest"], file);
    store.write(dir, script);
    // a's and c's pieces were made as they came down; b's was stopped (the lid closed under it).
    for (const index of [0, 2]) await media.join([{ path: files[index]!, streams: await media.streams(files[index]!) }], joinPath(dir, "pieces", `${["a", "b", "c"][index]}.mp4`));
    const joins: number[] = [];
    const join = media.join;
    const spy = spyOn(media, "join").mockImplementation((parts, dest, onPercent, signal) => {
      joins.push(parts.length);
      return join(parts, dest, onPercent, signal);
    });
    restores.push(() => spy.mockRestore());
    const items: imports.JoinItem[] = files.map((path, n) => ({ title: `CH0${n + 1}`, path, url: null, id: `f${n}` }));
    const build = await imports.joinPreview(dir, script, items, "recordings");
    expect(build).not.toBeNull();
    await build!(() => {});
    // One piece encoded (b's alone), then the three copied together.
    expect(joins).toEqual([1]);
    const joined = await media.streams(store.proxyPath(dir));
    expect(joined.durationMs).toBeGreaterThanOrEqual(5_800);
  } finally {
    cleanup();
  }
}, 120_000);
