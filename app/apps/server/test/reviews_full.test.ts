// A review version's full-quality file (the Download button) is noted as a job
// while it goes up, so a restart carries on with it: Nov 7, Predator Teacher,
// Edit restarted on JJ's Mac with 0.7 of v3's 4.9 GB up and nothing sent the rest.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as cloud from "../src/cloud.ts";
import * as jobs from "../src/jobs.ts";
import { fullBehind, fullUpload, resumeFull } from "../src/reviews.ts";

const spies: { mockRestore(): void }[] = [];
// Nothing up yet (fullBehind asks the cloud first).
beforeEach(() => {
  spies.push(spyOn(cloud, "head").mockImplementation(async () => null));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const listed = (home: string) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "jobs.json"), "utf8")) as { kind: string; project: string; args: Record<string, unknown> }[];
  } catch {
    return [];
  }
};

test("the full-quality upload is listed in jobs.json while it goes, with what a restart needs, and crossed off once it's up", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-"));
  const file = path.join(home, "Predator Teacher.mp4");
  fs.writeFileSync(file, "export");
  let finish = () => {};
  const sent: string[] = [];
  spies.push(
    spyOn(cloud, "uploadFile").mockImplementation(async (from: string, key: string, progress?: (done: number, total: number) => void) => {
      sent.push(`${from} -> ${key}`);
      progress?.(1, 6);
      await new Promise<void>((resolve) => (finish = resolve));
    }),
  );
  const going = fullBehind(home, "p1", "Predator Teacher", file, "edit/reviews/p1/t/full.mp4");
  await Bun.sleep(10);
  expect(listed(home)).toEqual([expect.objectContaining({ kind: "full", project: "p1", args: { name: "Predator Teacher", path: file, key: "edit/reviews/p1/t/full.mp4" } })]);
  finish();
  await going;
  expect(sent).toEqual([`${file} -> edit/reviews/p1/t/full.mp4`]);
  expect(listed(home)).toEqual([]);
});

// Nov 8, Killer Pastor's v3: named at the publish, the page's Download button saved "media.json" (the 404) for the hours its
// export took to go up. Sphe: "we need a way to see progress of when we'll get the full quality download".
test("the review page is told how the full-quality upload goes, and the version names the file only once it's up", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-"));
  const file = path.join(home, "Killer Pastor.mp4");
  fs.writeFileSync(file, "export");
  const told: { meta: Record<string, unknown> }[] = [];
  let up = false;
  spies.push(
    spyOn(cloud, "uploadFile").mockImplementation(async (_from: string, _key: string, progress?: (done: number, total: number) => void) => {
      progress?.(2, 6);
      progress?.(4, 6);
      up = true;
    }),
    spyOn(cloud, "mutation").mockImplementation(async (name: string, args: unknown) => {
      expect(name).toBe("reviews:setMeta");
      const given = args as { sourceId: string; version: number; meta: Record<string, unknown> };
      expect([given.sourceId, given.version]).toEqual(["p2", 3]);
      // The file named only once it's up.
      if ("fullKey" in given.meta) expect(up).toBe(true);
      told.push(given);
      return null as never;
    }),
  );
  await fullBehind(home, "p2", "Killer Pastor", file, "edit/reviews/p2/t/full.mp4", 3);
  // Said at the start, at its first part (4 of 6 within 20 s of that isn't said), then the file.
  expect(told.map((one) => one.meta.fullUpload && (one.meta.fullUpload as { sent: number }).sent)).toEqual([0, 2, null]);
  expect(told[1]!.meta.fullUpload).toEqual({ sent: 2, total: 6, at: expect.any(Number), since: expect.any(Number), from: 2 });
  expect(told.at(-1)!.meta).toEqual({ fullKey: "edit/reviews/p2/t/full.mp4", fullUpload: null });
  expect(listed(home)).toEqual([]);
});

// Nov 21, the bad-day run on Sphe's MacBook Air (7 GB free): after a restart the export's cloud copy carried on first
// and, the disk short, removed the file from here; the full-quality upload then tried a file that wasn't there twenty
// times over an hour and a half and gave up with a line in the log: a review with no Download and nothing said.
test("an export gone from here is fetched back from its cloud copy and sent, once; with no cloud copy it's said once, not tried twenty times", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-gone-"));
  const file = path.join(home, "Killer Pastor.mp4");
  fs.writeFileSync(path.join(home, "exports.json"), JSON.stringify({ p3: [{ path: file, name: "Killer Pastor.mp4", frames: 1, whole: true, finished_ms: 1, bytes: 6, cloudKey: "edit/exports/p3/Killer Pastor.mp4" }] }));
  const fetched: string[] = [];
  const sent: string[] = [];
  spies.push(
    spyOn(cloud, "download").mockImplementation(async (key: string, dest: string) => {
      fetched.push(key);
      fs.writeFileSync(dest, "export");
    }),
    spyOn(cloud, "uploadFile").mockImplementation(async (from: string, key: string) => {
      sent.push(`${fs.readFileSync(from, "utf8")} -> ${key}`);
    }),
    spyOn(cloud, "mutation").mockImplementation(async () => null as never),
  );
  await fullBehind(home, "p3", "Killer Pastor", file, "edit/reviews/p3/t/full.mp4", 2);
  expect(fetched).toEqual(["edit/exports/p3/Killer Pastor.mp4"]);
  expect(sent).toEqual(["export -> edit/reviews/p3/t/full.mp4"]);
  expect(listed(home)).toEqual([]);

  // Nowhere any more: one line to the review, nothing sent, and it ends at once.
  const gone = path.join(home, "Never Archived.mp4");
  const told: Record<string, unknown>[] = [];
  spies.push(spyOn(cloud, "mutation").mockImplementation(async (_name: string, args: unknown) => {
    told.push((args as { meta: Record<string, unknown> }).meta);
    return null as never;
  }));
  const began = Date.now();
  await fullBehind(home, "p3", "Never Archived", gone, "edit/reviews/p3/u/full.mp4", 3);
  expect(Date.now() - began).toBeLessThan(2_000);
  expect(sent.length).toBe(1);
  expect((told.at(-1)!.fullUpload as { failed?: string }).failed).toContain("Share again");
  expect(listed(home)).toEqual([]);
}, 20_000);

// Audit E6 (Nov 21): serve.ts's `full` resumer crossed the row off when the export wasn't on this computer, before
// fullBehind could fetch it back from its cloud copy; that resumer is also how a waiting row is woken, so a share's
// full-quality upload put off by a dropped line, its export deleted meanwhile (archived, the disk short), never came:
// no Download on the review and one line in the log. Out of tries with the file gone, it was ended, not put off.
const RESUMED = { key: "edit/reviews/p4/t/full.mp4", name: "Bodycam 12" };
function waitingFull(home: string, file: string, archived: boolean): string {
  fs.writeFileSync(path.join(home, "exports.json"), JSON.stringify({ p4: [{ path: file, name: "Bodycam 12.mp4", frames: 1, whole: true, finished_ms: 1, bytes: 6, ...(archived ? { cloudKey: "edit/exports/p4/Bodycam 12.mp4" } : {}) }] }));
  const key = jobs.keyOf("full", "p4", RESUMED.key);
  fs.writeFileSync(path.join(home, "jobs.json"), JSON.stringify([{ key, kind: "full", project: "p4", args: { name: RESUMED.name, path: file, key: RESUMED.key, version: 2 }, part: RESUMED.key, state: "waiting", retry_at: 1, put_off: 1, attempts: 0, started_ms: 1, updated_ms: 1 }]));
  return key;
}
const fullResumer = (home: string): jobs.Resumers => ({ full: (job) => void resumeFull(home, job).catch(() => {}) });

async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test("a waiting full-quality upload whose export was deleted here is woken, fetched back from its cloud copy and sent", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-wake-"));
  const file = path.join(home, "Bodycam 12.mp4");
  waitingFull(home, file, true);
  const fetched: string[] = [];
  const sent: string[] = [];
  const told: Record<string, unknown>[] = [];
  spies.push(
    spyOn(cloud, "download").mockImplementation(async (key: string, dest: string) => {
      fetched.push(key);
      fs.writeFileSync(dest, "export");
    }),
    spyOn(cloud, "uploadFile").mockImplementation(async (from: string, key: string) => void sent.push(`${fs.readFileSync(from, "utf8")} -> ${key}`)),
    spyOn(cloud, "remove").mockImplementation(async () => {}),
    spyOn(cloud, "mutation").mockImplementation(async (_name: string, args: unknown) => {
      told.push((args as { meta: Record<string, unknown> }).meta);
      return null as never;
    }),
  );
  jobs.useResumers(home, fullResumer(home));
  await jobs.wake(home, ["full"]);
  await until("the upload to end", () => listed(home).length === 0);
  expect(fetched).toEqual(["edit/exports/p4/Bodycam 12.mp4"]);
  expect(sent).toEqual([`export -> ${RESUMED.key}`]);
  expect(told.at(-1)).toEqual({ fullKey: RESUMED.key, fullUpload: null });
}, 20_000);

test("a woken full-quality upload with its export nowhere, here or in the cloud, ends with its words to the review", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-wake-"));
  waitingFull(home, path.join(home, "Bodycam 12.mp4"), false);
  const told: Record<string, unknown>[] = [];
  spies.push(
    spyOn(cloud, "uploadFile").mockImplementation(async () => {
      throw new Error("nothing should go up");
    }),
    spyOn(cloud, "mutation").mockImplementation(async (_name: string, args: unknown) => {
      told.push((args as { meta: Record<string, unknown> }).meta);
      return null as never;
    }),
  );
  jobs.useResumers(home, fullResumer(home));
  await jobs.wake(home, ["full"]);
  await until("the row to end", () => listed(home).length === 0);
  await until("the review to be told", () => told.some((meta) => typeof (meta.fullUpload as { failed?: string } | null)?.failed === "string"));
  expect((told.at(-1)!.fullUpload as { failed: string }).failed).toContain("Share again");
}, 20_000);

test("fetching the export back failing on a dropped line, out of tries: the row waits to be tried again, never ended", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-wake-"));
  const file = path.join(home, "Bodycam 12.mp4");
  const key = waitingFull(home, file, true);
  const { waitMs, tries } = fullUpload;
  fullUpload.waitMs = () => 0;
  fullUpload.tries = 2;
  let asked = 0;
  spies.push(
    spyOn(cloud, "download").mockImplementation(async () => {
      asked += 1;
      throw new Error("fetch failed: ECONNRESET");
    }),
    spyOn(cloud, "uploadFile").mockImplementation(async () => {
      throw new Error("nothing should go up");
    }),
    spyOn(cloud, "mutation").mockImplementation(async () => null as never),
  );
  try {
    await fullBehind(home, "p4", RESUMED.name, file, RESUMED.key, 2);
  } finally {
    fullUpload.waitMs = waitMs;
    fullUpload.tries = tries;
  }
  expect(asked).toBe(2);
  expect(jobs.get(home, key)).toEqual(expect.objectContaining({ state: "waiting", retry_at: expect.any(Number) }));
}, 20_000);

test("its cloud copy on record but not there any more: said once on the review and ended, not waited on for good", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-wake-"));
  const file = path.join(home, "Bodycam 12.mp4");
  waitingFull(home, file, true);
  const told: Record<string, unknown>[] = [];
  let asked = 0;
  spies.push(
    spyOn(cloud, "download").mockImplementation(async (key: string) => {
      asked += 1;
      throw new Error(`${key} isn't in the cloud`);
    }),
    spyOn(cloud, "uploadFile").mockImplementation(async () => {
      throw new Error("nothing should go up");
    }),
    spyOn(cloud, "mutation").mockImplementation(async (_name: string, args: unknown) => {
      told.push((args as { meta: Record<string, unknown> }).meta);
      return null as never;
    }),
  );
  await fullBehind(home, "p4", RESUMED.name, file, RESUMED.key, 2);
  expect(asked).toBe(1);
  expect((told.at(-1)!.fullUpload as { failed: string }).failed).toContain("Share again");
  expect(listed(home)).toEqual([]);
}, 20_000);
