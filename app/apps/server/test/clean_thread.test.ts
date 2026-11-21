// The cache's hourly pass never keeps the server's one thread (Nov 21): on Sphe's Linux Edit, a home of about 14,000
// cached files, it held it 3 to 4.4 s every hour ("last started: the hourly cache clean (the cache)"), mostly reading
// and parsing every script.json twice a pass (126 scripts, 381 MB); on a MacBook Air one native `mediaKey` of it kept
// the thread 2 s. A timer beats every 50 ms through the pass, and the longest gap between beats is the longest hold;
// the files left must be exactly those the pass run at once on the thread leaves, on an identical home.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { cleanCache, cleanPass, makeRoom, makeRoomAsync } from "../src/cache_cleanup.ts";
import * as ledgerOf from "../src/ledger.ts";
import { forget } from "../src/opened.ts";
import * as storage from "../src/storage.ts";
import { bigHome, shapeOf, tree } from "./helpers/big_home.ts";
import { fixtureHome } from "./helpers/home.ts";

/** The native `mediaKey` here costs what a pass's keying of a working home cost on the Air: 2 s over ~1,100 files. */
const KEY_MS = 1.75;
/** The disk the stand-in free space says is short of what Edit keeps free by this much, before anything goes. */
const SHORT = 800_000;

const disk = { ...storage.diskHooks };
let freed = 0;
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  // The disk's free space grows by what's removed (every removal goes through one of these).
  freed = 0;
  const count = (path: unknown) => {
    try {
      if (typeof path === "string") freed += du(path);
    } catch {
      // Gone: nothing freed.
    }
  };
  const realRm = fs.promises.rm;
  const realRmSync = fs.rmSync;
  spies = [
    spyOn(fs.promises, "rm").mockImplementation(async (path, options) => (count(path), realRm(path, options))),
    spyOn(fs, "rmSync").mockImplementation((path, options) => (count(path), realRmSync(path, options))),
  ];
  storage.diskHooks.free = () => storage.keepFreeBytes("") - SHORT + freed;
  storage.diskHooks.total = () => 500e9;
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  Object.assign(storage.diskHooks, disk);
});

function du(path: string): number {
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(path).reduce((sum, name) => sum + du(join(path, name)), 0);
}

/** A home of about 14,000 files, its native addon keying at the Air's cost. */
async function home(name: string, now: number) {
  const fixture = fixtureHome(name);
  const made = await bigHome(fixture.store, join(fixture.dir, "footage"), shapeOf(1), now);
  const key = fixture.app.native.mediaKey;
  fixture.app.native.mediaKey = (path: string) => {
    // A playback address is keyed by its name alone; anything else is a stat of the file first.
    if (!path.startsWith("http://127.0.0.1:")) for (const until = performance.now() + KEY_MS; performance.now() < until;);
    return key(path);
  };
  return { ...fixture, ...made };
}

/**
 * What a pass left of a home, but the project the builder made through the store (its id is the clock's) and the
 * revisions the store writes as it loads a project (old exports ask whether a project's are on Drive).
 */
const left = (fixture: Awaited<ReturnType<typeof home>>) => tree(fixture.dir, fixture.labels).filter((path) => !path.includes(fixture.template) && !path.startsWith("home/projects/revs/"));

/** The longest gap between 50 ms beats while `work` runs, less the beat itself: the longest hold of the thread. */
async function longestHold<T>(work: () => Promise<T>): Promise<{ value: T; holdMs: number; tookMs: number }> {
  let last = performance.now();
  let longest = 0;
  const beat = setInterval(() => {
    const at = performance.now();
    longest = Math.max(longest, at - last - 50);
    last = at;
  }, 50);
  const began = performance.now();
  try {
    const value = await work();
    const tookMs = performance.now() - began;
    // The last beat's gap, had the work held the thread to its end.
    longest = Math.max(longest, performance.now() - last - 50);
    return { value, holdMs: longest, tookMs };
  } finally {
    clearInterval(beat);
  }
}

test("the hourly pass on a home of 14,000 files gives the thread back every few milliseconds, and leaves the files a pass at once leaves", async () => {
  const now = Date.now();
  const gentle = await home("clean-thread-gentle", now);
  const atOnce = await home("clean-thread-at-once", now);
  try {
    expect(gentle.files).toBeGreaterThan(14_000);
    const { value: report, holdMs, tookMs } = await longestHold(() => cleanPass(gentle.app, now, async () => null));
    console.log(`the hourly pass: ${Math.round(tookMs)} ms, the thread held ${Math.round(holdMs)} ms at most, ${report.files} files taken`);
    // Until Nov 21 the pass held it for all its length (here 2 to 3 s; 4.4 s on mandalorian). A breath is due every
    // 8 ms; the longest steps left are one project's or script's JSON parsed after it changed (10 MB here).
    expect(holdMs).toBeLessThan(400);
    expect(report.files).toBeGreaterThan(4_000);

    // The same home, the pass run at once on the thread (the cache's part as `makeRoom` and the tests run it).
    storage.ledger.useRoots(ledgerOf.rootsOf(atOnce.store.home, atOnce.store.cacheDir()));
    const entries = await storage.ledger.rebuild();
    freed = 0;
    const same = cleanCache(atOnce.app, false, now, { freeBytes: storage.keepFreeBytes(""), entries, confirmed: new Set() }, new Set());
    expect(left(gentle).filter((path) => !path.startsWith("home/exports/"))).toEqual(left(atOnce).filter((path) => !path.startsWith("home/exports/")));
    // The cache's part of it took as many files (the hourly pass also took its old exports, two of each of five
    // projects, and the legacy previews R2 has: none here).
    expect(report.files).toBe(same.files + 10);
    // Neither touched what a script plays from, a project's footage, or paid analysis.
    for (const fixture of [gentle, atOnce]) {
      expect(fs.existsSync(join(fixture.home, "media", "drive", "youtube", "video0xx", "video.mp4"))).toBe(true);
      expect(fs.existsSync(join(fixture.home, "media", "drive", "youtube", "unusedVideo", "video.mp4"))).toBe(false);
    }
  } finally {
    for (const fixture of [gentle, atOnce]) {
      forget(fixture.store.home);
      fixture.cleanup();
    }
  }
}, 120_000);

test("room asked for gently takes what room asked for at once takes, and asks that come while one waits join it", async () => {
  const now = Date.now();
  const gentle = await home("room-gentle", now);
  const atOnce = await home("room-at-once", now);
  try {
    const wanted = storage.keepFreeBytes("");
    storage.ledger.useRoots(ledgerOf.rootsOf(gentle.store.home, gentle.store.cacheDir()));
    await storage.ledger.rebuild();
    const { value: freedGently, holdMs } = await longestHold(() => Promise.all([makeRoomAsync(gentle.app, wanted), makeRoomAsync(gentle.app, wanted - 1)]));
    console.log(`room made gently: the thread held ${Math.round(holdMs)} ms at most`);
    expect(holdMs).toBeLessThan(400);
    // One pass for both: the second joined the first.
    expect(freedGently[0]).toBe(freedGently[1]);
    storage.ledger.useRoots(ledgerOf.rootsOf(atOnce.store.home, atOnce.store.cacheDir()));
    await storage.ledger.rebuild();
    freed = 0;
    const freedAtOnce = makeRoom(atOnce.app, wanted);
    expect(freedGently[0]).toBe(freedAtOnce);
    expect(left(gentle)).toEqual(left(atOnce));
  } finally {
    for (const fixture of [gentle, atOnce]) {
      forget(fixture.store.home);
      fixture.cleanup();
    }
  }
}, 120_000);
