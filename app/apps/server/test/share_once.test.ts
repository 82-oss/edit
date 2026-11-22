// A share's export goes up to the cloud once (Nov 21): before, it went up twice
// in full, as the export's archive (`edit/exports/…`) and as the review's
// `full.mp4`, and one was deleted only afterwards; on JJ's 8 Mbit/s uplink a
// 5 GB export is about 85 minutes a copy. Now its archive waits behind the
// share and goes only when the share ends with no full-quality file on its way.
// The cloud here is a stand-in that counts every byte sent.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import * as cloud from "../src/cloud.ts";
import { archiveJob, behindShare, beingRead, exportCloud, ExportRegistry, listExports, resetBehindShare, wakeBehindShare, type ExportRecord } from "../src/exports.ts";
import * as jobs from "../src/jobs.ts";
import { fullBehind, resumeFull } from "../src/reviews.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

/** The export's size: small, the bytes counted are what matter. */
const BYTES = 4096;

/** What the stand-in cloud holds and was sent: each upload's key and bytes, and the most going at once. */
interface StandIn {
  objects: Map<string, number>;
  sent: { key: string; bytes: number }[];
  going: number;
  most: number;
  /** The relay refuses to tell a version its full-quality file is up. */
  refuseTell: boolean;
  /** The relay copies inside the cloud (from Nov 22); each copy made, from and to. */
  copies: boolean;
  copied: { from: string; to: string }[];
  /** Each file fetched back from the cloud, by key. */
  fetched: string[];
  /** Each upload waits for this before it ends, when set. */
  gate: Promise<void> | null;
}

const spies: { mockRestore(): void }[] = [];
let fixture: Fixture | null = null;
const { everyMs, backstopMs } = behindShare;

beforeEach(() => {
  resetBehindShare();
  // The watch looks often here; the real one every 30 s.
  behindShare.everyMs = 50;
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  resetBehindShare();
  behindShare.everyMs = everyMs;
  behindShare.backstopMs = backstopMs;
  fixture?.cleanup();
  fixture = null;
});

function standIn(): StandIn {
  const it: StandIn = { objects: new Map(), sent: [], going: 0, most: 0, refuseTell: false, copies: false, copied: [], fetched: [], gate: null };
  const send = async (path: string, key: string) => {
    it.going += 1;
    it.most = Math.max(it.most, it.going);
    try {
      await Bun.sleep(5);
      await it.gate;
      const bytes = fs.statSync(path).size;
      it.sent.push({ key, bytes });
      it.objects.set(key, bytes);
    } finally {
      it.going -= 1;
    }
  };
  const head = async (key: string) => (it.objects.has(key) ? { size: it.objects.get(key)! } : null);
  spies.push(
    spyOn(exportCloud, "enabled").mockReturnValue(true),
    spyOn(exportCloud, "upload").mockImplementation((path, key) => send(path, key)),
    spyOn(exportCloud, "head").mockImplementation(head),
    spyOn(cloud, "uploadFile").mockImplementation(async (path: string, key: string, progress?: (done: number, total: number) => void) => {
      await send(path, key);
      progress?.(BYTES, BYTES);
    }),
    spyOn(cloud, "head").mockImplementation(head as never),
    spyOn(cloud, "mutation").mockImplementation(async (_name: string, args: unknown) => {
      if (it.refuseTell && "fullKey" in ((args as { meta?: Record<string, unknown> }).meta ?? {})) throw new Error("Server Error");
      return null as never;
    }),
    spyOn(cloud, "remove").mockImplementation(async (keys: string[]) => void keys.forEach((key) => it.objects.delete(key))),
    spyOn(cloud, "download").mockImplementation(async (key: string, dest: string) => {
      if (!it.objects.has(key)) throw new Error("nothing there");
      it.fetched.push(key);
      fs.writeFileSync(dest, Buffer.alloc(it.objects.get(key)!));
    }),
    spyOn(cloud, "copy").mockImplementation(async (from: string, to: string) => {
      if (!it.copies || !it.objects.has(from)) return null;
      it.copied.push({ from, to });
      it.objects.set(to, it.objects.get(from)!);
      return it.objects.get(from)!;
    }),
  );
  return it;
}

/** A registry over a fresh home whose engine writes `BYTES`, with the job table's resumers as serve.ts has them. */
function setUp(): { t: Fixture; registry: ExportRegistry } {
  const t = fixtureHome("share-once");
  fixture = t;
  const registry = new ExportRegistry(t.home);
  t.app.exports = registry;
  spies.push(
    spyOn(t.native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 }),
    spyOn(t.native.ExportJob, "start").mockImplementation((job) => ({ cancel: () => {}, wait: async () => { fs.writeFileSync(job.output, Buffer.alloc(BYTES)); return { seconds: 1, bytes: BYTES }; } })),
  );
  useServeResumers(t.home, registry);
  return { t, registry };
}

/** serve.ts's resumers for `archive` (a read-only copy of it) and `full`. */
function useServeResumers(home: string, registry: ExportRegistry): jobs.Resumers {
  const resumers: jobs.Resumers = {
    archive: async (job) => {
      const { output, key, record } = job.args as { output: string; key: string; record: ExportRecord };
      await archiveJob(home, job.key, () => registry.sendUp(home, job.project, output, key, record));
    },
    // serve.ts's own (it settles a failure as well).
    full: (job) => void resumeFull(home, job).catch(() => {}),
  };
  jobs.useResumers(home, resumers);
  return resumers;
}

async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Exports a fresh project (as a share's export when `share`), to its end. */
async function exported(t: Fixture, registry: ExportRegistry, name: string, share: boolean, before?: (id: string) => void): Promise<{ id: string; output: string }> {
  const id = t.store.create(name, { width: 64, height: 36, fps: 30 }).project.id;
  await t.store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
  before?.(id);
  const output = `${t.dir}/${name}.mp4`;
  await registry.start(t.store, t.app.library, t.store.get(id)!.project, t.native.exportDefaults(), output, { drive: false, ...(share ? { share: true } : {}) });
  await until("the export to finish", () => registry.activity().find((one) => one.id === id)?.state === "done");
  return { id, output };
}

/** The share's row as runShare lists it while its export runs. */
const shareBegun = (home: string, id: string) => jobs.begin(home, "share", id, { id: `share-${id}`, export: { options: {} } }, "", "exporting");

/** The share published: its row done and its full-quality upload listed in the same write (reviews.ts `published`). */
function published(home: string, id: string, output: string): string {
  const fullKey = `edit/reviews/${id}/t1/full.mp4`;
  jobs.step(home, jobs.keyOf("share", id), "review copy", { path: output });
  jobs.handOff(home, jobs.keyOf("share", id), { kind: "full", project: id, args: { name: id, path: output, key: fullKey, version: 1 }, part: fullKey, step: "uploading" }, { state: "done", step: "published", args: { published: { version: 1, url: "https://review" } } });
  return fullKey;
}

const archives = (home: string) => jobs.list(home, "archive");
const live = (home: string, kind: jobs.Kind) => jobs.list(home, kind).filter(jobs.live);

/** Until project `id`'s archive waits behind its share, or something went up instead (then the checks after say what). */
const behind = (home: string, up: StandIn, id: string) =>
  until("its archive to wait behind the share", () => up.sent.length > 0 || archives(home).some((job) => job.project === id && job.state === "waiting"));

test("a share's export goes up once, as the review's full-quality file, and its record names that copy", async () => {
  const up = standIn();
  const { t, registry } = setUp();
  const { id, output } = await exported(t, registry, "Shared", true, (one) => shareBegun(t.home, one));
  // Its archive waits behind the share: nothing sent, the file kept from the cleaners, nothing counted as running.
  await behind(t.home, up, id);
  await Bun.sleep(200);
  expect(up.sent).toEqual([]);
  expect(beingRead(output)).toBe(true);
  expect(registry.archiving()).toBe(false);
  const fullKey = published(t.home, id, output);
  await fullBehind(t.home, id, id, output, fullKey, 1);
  await until("its archive to be crossed off", () => archives(t.home).length === 0);
  expect(up.sent).toEqual([{ key: fullKey, bytes: BYTES }]);
  expect(up.sent.reduce((sum, one) => sum + one.bytes, 0)).toBe(BYTES);
  expect(listExports(t.home, id)).toEqual([expect.objectContaining({ path: output, cloudKey: fullKey, missing: false })]);
  expect(up.objects.has(`edit/exports/${id}/Shared.mp4`)).toBe(false);
}, 30_000);

test("a share that fails or is cancelled before its full-quality file goes up archives its export, once", async () => {
  const up = standIn();
  const { t, registry } = setUp();
  // Failed: runShare's end says so (wakeBehindShare).
  const failed = await exported(t, registry, "Failed", true, (one) => shareBegun(t.home, one));
  await behind(t.home, up, failed.id);
  await Bun.sleep(200);
  expect(up.sent).toEqual([]);
  jobs.settle(t.home, jobs.keyOf("share", failed.id), "failed", { error: "the review copy came out wrong" });
  wakeBehindShare(t.home, failed.id);
  await until("its archive to go up", () => !archives(t.home).some((job) => job.project === failed.id));
  const failedKey = `edit/exports/${failed.id}/Failed.mp4`;
  expect(up.sent).toEqual([{ key: failedKey, bytes: BYTES }]);
  expect(listExports(t.home, failed.id)).toEqual([expect.objectContaining({ cloudKey: failedKey })]);
  // Cancelled with nobody saying so (its row crossed off by something else): the watch finds it.
  const cancelled = await exported(t, registry, "Cancelled", true, (one) => shareBegun(t.home, one));
  await behind(t.home, up, cancelled.id);
  jobs.end(t.home, jobs.keyOf("share", cancelled.id));
  await until("its archive to go up", () => !archives(t.home).some((job) => job.project === cancelled.id));
  expect(up.sent.map((one) => one.key)).toEqual([failedKey, `edit/exports/${cancelled.id}/Cancelled.mp4`]);
}, 30_000);

test("a plain export is archived at once, as before, even with a share of its project under way", async () => {
  const up = standIn();
  const { t, registry } = setUp();
  const { id } = await exported(t, registry, "Plain", false, (one) => shareBegun(t.home, one));
  await until("its archive to go up", () => archives(t.home).length === 0);
  expect(up.sent).toEqual([{ key: `edit/exports/${id}/Plain.mp4`, bytes: BYTES }]);
  expect(listExports(t.home, id)).toEqual([expect.objectContaining({ cloudKey: `edit/exports/${id}/Plain.mp4` })]);
}, 30_000);

test("a share waiting on a dropped line, or its full-quality file put off, keeps its export's archive waiting: no second upload", async () => {
  const up = standIn();
  const { t, registry } = setUp();
  const { id, output } = await exported(t, registry, "Dropped", true, (one) => shareBegun(t.home, one));
  await behind(t.home, up, id);
  // The share waits for the connection (runShare's ShareWaits), and the watch looks many times.
  jobs.wait(t.home, jobs.keyOf("share", id), new Error("fetch failed: ECONNRESET"));
  wakeBehindShare(t.home, id);
  await Bun.sleep(500);
  expect(up.sent).toEqual([]);
  // Published, and its full-quality file put off (out of tries offline): still the one upload to come.
  const fullKey = published(t.home, id, output);
  jobs.wait(t.home, jobs.keyOf("full", id, fullKey), "the full-quality file didn't go up after 20 tries: fetch failed");
  wakeBehindShare(t.home, id);
  await Bun.sleep(500);
  expect(up.sent).toEqual([]);
  expect(archives(t.home)).toEqual([expect.objectContaining({ state: "waiting" })]);
  // Its next try goes up: the archive is crossed off, never sent.
  await fullBehind(t.home, id, id, output, fullKey, 1);
  await until("its archive to be crossed off", () => archives(t.home).length === 0);
  expect(up.sent).toEqual([{ key: fullKey, bytes: BYTES }]);
}, 30_000);

/** jobs.json as a kill left it, `rows` with what each row's args need. */
function killedWith(home: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(`${home}/jobs.json`, JSON.stringify(rows.map((row) => ({ attempts: 0, started_ms: 1, updated_ms: 1, ...row }))));
}

function finishedRecord(home: string, id: string, output: string): ExportRecord {
  const record: ExportRecord = { path: output, name: "Killed.mp4", finished_ms: 1, seconds: 1, bytes: BYTES, frames: 30, whole: true, format: "h264", cloudKey: `edit/exports/${id}/Killed.mp4` };
  // Listed as the export ended (no cloud copy yet).
  const { cloudKey: _none, ...listed } = record;
  fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ [id]: [listed] }));
  return record;
}

test("Edit killed while a share's full-quality file goes up: started again, exactly one upload goes", async () => {
  const up = standIn();
  const t = fixtureHome("share-once-restart");
  fixture = t;
  const id = "p1";
  const output = `${t.dir}/Killed.mp4`;
  fs.writeFileSync(output, Buffer.alloc(BYTES));
  const record = finishedRecord(t.home, id, output);
  const fullKey = `edit/reviews/${id}/t1/full.mp4`;
  // The archive cut short before its first look, the full-quality upload part way, the share published.
  killedWith(t.home, [
    { key: `share:${id}`, kind: "share", project: id, args: { id: "s1", export: { options: {} }, path: output, published: { version: 1, url: "u" } }, state: "done", step: "published" },
    { key: `archive:${id}:${output}`, kind: "archive", project: id, args: { output, key: record.cloudKey, record, share: true }, state: "running", step: "uploading" },
    { key: `full:${id}:${fullKey}`, kind: "full", project: id, args: { name: id, path: output, key: fullKey, version: 1 }, state: "running", step: "uploading" },
  ]);
  // The new run.
  const registry = new ExportRegistry(t.home);
  const resumers = useServeResumers(t.home, registry);
  await jobs.resume(t.home, resumers, ["archive", "full"]);
  await until("the uploads to end", () => live(t.home, "archive").length === 0 && live(t.home, "full").length === 0);
  expect(up.sent).toEqual([{ key: fullKey, bytes: BYTES }]);
  expect(up.most).toBe(1);
  expect(listExports(t.home, id)).toEqual([expect.objectContaining({ cloudKey: fullKey })]);
}, 30_000);

test("Edit killed after a share failed with its export's archive waiting behind it: the next run sends the archive", async () => {
  const up = standIn();
  const t = fixtureHome("share-once-after");
  fixture = t;
  const id = "p2";
  const output = `${t.dir}/Killed.mp4`;
  fs.writeFileSync(output, Buffer.alloc(BYTES));
  const record = finishedRecord(t.home, id, output);
  // Its table's own wake is an hour on: only the watch of the new run can send it within the test.
  killedWith(t.home, [
    { key: `share:${id}`, kind: "share", project: id, args: { id: "s2", export: { options: {} }, path: output }, state: "failed", error: "the review copy came out wrong" },
    { key: `archive:${id}:${output}`, kind: "archive", project: id, args: { output, key: record.cloudKey, record, share: true }, state: "waiting", step: "waiting for its share's full-quality file", retry_at: Date.now() + 3_600_000 },
  ]);
  expect(beingRead(output)).toBe(false);
  const registry = new ExportRegistry(t.home);
  const resumers = useServeResumers(t.home, registry);
  await jobs.resume(t.home, resumers, ["archive", "full"]);
  // Until it's up, the cleaners leave its only copy alone.
  expect(beingRead(output)).toBe(true);
  await until("the archive to go up", () => archives(t.home).length === 0);
  expect(up.sent).toEqual([{ key: record.cloudKey!, bytes: BYTES }]);
  expect(listExports(t.home, id)).toEqual([expect.objectContaining({ cloudKey: record.cloudKey })]);
}, 30_000);

// Nov 22: only a share's export was kept from the cleaners while its cloud copy was owed; a plain one put off wasn't.
test("a plain export whose cloud copy is put off is left alone by the cleaners until it's up", () => {
  const t = fixtureHome("share-once-plain-owed");
  fixture = t;
  const id = "p3";
  const output = `${t.dir}/Plain.mp4`;
  fs.writeFileSync(output, Buffer.alloc(BYTES));
  const record = finishedRecord(t.home, id, output);
  killedWith(t.home, [{ key: `archive:${id}`, kind: "archive", project: id, args: { output, key: record.cloudKey, record }, state: "waiting", step: "uploading", retry_at: Date.now() + 3_600_000 }]);
  resetBehindShare();
  new ExportRegistry(t.home);
  expect(beingRead(output)).toBe(true);
});

test("the full-quality file up but its version not told: the export's record still names it, and no archive goes", async () => {
  const up = standIn();
  const { t, registry } = setUp();
  const { id, output } = await exported(t, registry, "Untold", true, (one) => shareBegun(t.home, one));
  await behind(t.home, up, id);
  const fullKey = published(t.home, id, output);
  up.refuseTell = true;
  await fullBehind(t.home, id, id, output, fullKey, 1);
  await until("its archive to be crossed off", () => archives(t.home).length === 0);
  expect(up.sent).toEqual([{ key: fullKey, bytes: BYTES }]);
  expect(listExports(t.home, id)).toEqual([expect.objectContaining({ cloudKey: fullKey })]);
}, 30_000);

// Nov 22: a share of an export archived earlier, or one that followed a plain export still going up, sent the same
// bytes up a second time; the relay now copies inside the cloud.
test("a share of an export archived earlier copies its archive inside the cloud: nothing sent a second time", async () => {
  const up = standIn();
  up.copies = true;
  const { t, registry } = setUp();
  const { id, output } = await exported(t, registry, "Earlier", false);
  await until("its archive to go up", () => archives(t.home).length === 0);
  const archive = `edit/exports/${id}/Earlier.mp4`;
  const fullKey = `edit/reviews/${id}/t1/full.mp4`;
  await fullBehind(t.home, id, id, output, fullKey, 1);
  expect(up.sent).toEqual([{ key: archive, bytes: BYTES }]);
  expect(up.copied).toEqual([{ from: archive, to: fullKey }]);
  // Kept once in the cloud, as the review's copy, as when it went up as that.
  expect(listExports(t.home, id)).toEqual([expect.objectContaining({ cloudKey: fullKey })]);
  expect([...up.objects.keys()]).toEqual([fullKey]);
}, 30_000);

test("a share of an archived export no longer on this computer is copied in the cloud, not fetched back and sent", async () => {
  const up = standIn();
  up.copies = true;
  const { t, registry } = setUp();
  const { id, output } = await exported(t, registry, "Away", false);
  await until("its archive to go up", () => archives(t.home).length === 0);
  // Gone from here (the disk short, or deleted).
  fs.rmSync(output, { force: true });
  const fullKey = `edit/reviews/${id}/t1/full.mp4`;
  await fullBehind(t.home, id, id, output, fullKey, 1);
  expect(up.fetched).toEqual([]);
  expect(up.sent.map((one) => one.key)).toEqual([`edit/exports/${id}/Away.mp4`]);
  expect(up.objects.get(fullKey)).toBe(BYTES);
}, 30_000);

test("a relay that can't copy (older than Nov 22): the share sends its file as before", async () => {
  const up = standIn();
  const { t, registry } = setUp();
  const { id, output } = await exported(t, registry, "Older", false);
  await until("its archive to go up", () => archives(t.home).length === 0);
  const fullKey = `edit/reviews/${id}/t1/full.mp4`;
  await fullBehind(t.home, id, id, output, fullKey, 1);
  expect(up.sent).toEqual([{ key: `edit/exports/${id}/Older.mp4`, bytes: BYTES }, { key: fullKey, bytes: BYTES }]);
  expect(listExports(t.home, id)).toEqual([expect.objectContaining({ cloudKey: fullKey })]);
}, 30_000);

test("a share that follows a plain export still going up waits for that upload, then copies it: one upload", async () => {
  const up = standIn();
  up.copies = true;
  let open = () => {};
  up.gate = new Promise((resolve) => (open = resolve));
  const { t, registry } = setUp();
  const { id, output } = await exported(t, registry, "Riding", false);
  await until("its archive to be going up", () => up.going === 1);
  const fullKey = `edit/reviews/${id}/t1/full.mp4`;
  const full = fullBehind(t.home, id, id, output, fullKey, 1);
  await Bun.sleep(200);
  // Nothing beside the archive's upload while it goes.
  expect(up.most).toBe(1);
  expect(up.copied).toEqual([]);
  open();
  await full;
  expect(up.sent).toEqual([{ key: `edit/exports/${id}/Riding.mp4`, bytes: BYTES }]);
  expect(up.copied).toEqual([{ from: `edit/exports/${id}/Riding.mp4`, to: fullKey }]);
  expect(listExports(t.home, id)).toEqual([expect.objectContaining({ cloudKey: fullKey })]);
}, 30_000);
