// A recording Script mode brought onto this Mac stays here as its original once it's in the cloud and its piece is
// made, so Start the edit cuts from it at once; it's given up only when the disk needs the room, oldest-unused first,
// never while it's cut from, and never before the cloud has it (Nov 21: 113 of the team's 126 scripts lost their
// copies the moment they were up, and Start the edit read every recording back over an 8 Mbit/s line; the Nov 19
// change 8b had said "kept as the local original while there is room"). R2 and the relay are the tests' mock; the
// disk's free space is a stand-in that counts each kept copy at the size its record says (a few GB), the files
// themselves a few bytes.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { cleanCache, makeRoom } from "../../src/cache_cleanup.ts";
import * as editCloud from "../../src/cloud.ts";
import { rootsOf, walkSync } from "../../src/ledger.ts";
import * as room from "../../src/storage.ts";
import * as store from "../../src/writer/store.ts";
import * as streamed from "../../src/writer/streamed.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer, type Recorded } from "../mocks/server.ts";

const GB = 1e9;
let mock: MockServer;
let restore: () => void;
const disk = { ...room.diskHooks };
/** While set, every PUT of an original waits for it (an upload still going on). */
let gate: Promise<void> | null = null;
let open: () => void = () => {};

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  mock.on("PUT", /^\/r2\/edit\/originals\//, async (request: Recorded) => {
    if (gate !== null) await gate;
    return (mock.cloud as unknown as { r2Put(request: Recorded): Response }).r2Put(request);
  });
});

beforeEach(() => {
  streamed.reset();
  room.resetRoom();
  mock.cloud.objects.clear();
  mock.cloud.convex.media.clear();
  gate = null;
});

afterEach(() => {
  open();
  Object.assign(room.diskHooks, disk);
  streamed.reset();
});

afterAll(() => {
  restore();
  mock.stop();
});

interface Copy {
  source: string;
  key: string;
  path: string;
  /** What the stand-in disk counts it as. */
  size: number;
}

/** A script folder (`status` its import's state). */
function scriptAt(home: string, id: string, status = "ready"): string {
  const dir = store.scriptDir(store.dataDir(home), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "script.json"), JSON.stringify({ status }));
  return dir;
}

/**
 * A recording's whole copy in the script's `.originals/`, as Script mode leaves it: landed, `up` (the registry has it;
 * R2 holds the same bytes unless `inR2` is false), its piece made or not. Last touched `at` (ms).
 */
function landed(dir: string, n: string, options: { size?: number; up?: boolean; piece?: boolean; inR2?: boolean; at?: number } = {}): Copy {
  const id = `1KeepsCopy${n.padStart(16, "0")}`;
  const name = `REC-${n}.mp4`;
  const source = `drive:${id}`;
  const key = `edit/originals/drive/${id}/${name}`;
  const path = join(dir, ".originals", id, name);
  const bytes = new TextEncoder().encode(`recording ${n} `.repeat(40));
  fs.mkdirSync(join(dir, ".originals", id), { recursive: true });
  fs.writeFileSync(path, bytes);
  if (options.at !== undefined) fs.utimesSync(path, options.at / 1000, options.at / 1000);
  if (options.inR2 !== false && options.up !== false) mock.cloud.put(key, bytes);
  const heldPath = join(dir, ".originals", "held.json");
  const list = fs.existsSync(heldPath) ? (JSON.parse(fs.readFileSync(heldPath, "utf8")) as unknown[]) : [];
  const size = options.size ?? bytes.length;
  list.push({ source, drive: id, key, name, size, path: `.originals/${id}/${name}`, landed: true, up: options.up ?? true, piece: options.piece ?? true });
  fs.writeFileSync(heldPath, JSON.stringify(list));
  return { source, key, path, size };
}

/** The import is done with `copy` (its piece made): what Script mode's import says once it's made. */
function pieceMade(dir: string, copy: Copy): void {
  streamed.done(dir, { source: copy.source, key: copy.key, name: copy.path.split("/").pop()!, size: copy.size, url: "https://r2.invalid/x", here: copy.path });
}

const held = (dir: string): { source: string }[] => {
  try {
    return JSON.parse(fs.readFileSync(join(dir, ".originals", "held.json"), "utf8")) as { source: string }[];
  } catch {
    return [];
  }
};

/** The stand-in disk: `free` bytes free less every copy kept here at the size its record says. */
function standInDisk(home: string, free: number): void {
  room.diskHooks.free = () => {
    const data = store.dataDir(home);
    let kept = 0;
    for (const id of store.ids(data)) {
      const dir = store.scriptDir(data, id);
      for (const one of held(dir) as unknown as { path: string; size: number }[]) if (fs.existsSync(join(dir, one.path))) kept += one.size;
    }
    return free - kept;
  };
  room.diskHooks.total = () => 494 * GB;
}

test("a copy that's in the cloud and has its piece stays here with room to keep it, and Start the edit finds it; short of what Edit keeps free, it goes as before", async () => {
  const { app, home, cleanup } = fixtureHome("keeps-copy-settle");
  try {
    room.diskHooks.free = () => 45 * GB;
    const dir = scriptAt(home, "0c0ffee0-0000-4000-8000-0000000000a1", "processing");
    const copy = landed(dir, "1", { piece: false });
    streamed.start(app);
    pieceMade(dir, copy);
    await streamed.settled();
    // Still here, and its record says so.
    expect(fs.existsSync(copy.path)).toBe(true);
    expect(held(dir).map((one) => one.source)).toEqual([copy.source]);
    // Start the edit cuts from it (script.ts `scriptModeCopy` asks `copiesHere.find`).
    const found = streamed.copyHere(copy.source);
    expect(found !== null && "copy" in found ? found.copy.path : null).toBe(copy.path);
    if (found !== null && "copy" in found) found.copy.release();
    // Under what Edit keeps free (15 GB), nothing is kept at the cost of the floor: once the next one is done with, the
    // cleaner is asked for the room and gives up what may go (both, these being a few bytes each).
    room.diskHooks.free = () => 14 * GB;
    room.diskHooks.makeRoom = (wanted) => makeRoom(app, wanted);
    fs.writeFileSync(join(dir, "script.json"), JSON.stringify({ status: "ready" }));
    const other = landed(dir, "2", { piece: false });
    pieceMade(dir, other);
    await streamed.settled();
    expect(fs.existsSync(other.path)).toBe(false);
    expect(fs.existsSync(copy.path)).toBe(false);
    expect(held(dir)).toEqual([]);
    expect(streamed.copyHere(copy.source)).toBeNull();
  } finally {
    cleanup();
  }
}, 30_000);

test("short of room, the cleaner gives up the oldest-unused copy the cloud has, its record going with it; one being cut from, one not up yet and one R2 doesn't hold stay", async () => {
  const { app, home, store: projects, cleanup } = fixtureHome("keeps-copy-pressure");
  try {
    const day = 24 * 3600 * 1000;
    const now = Date.now();
    const a = scriptAt(home, "0c0ffee0-0000-4000-8000-0000000000b1");
    const b = scriptAt(home, "0c0ffee0-0000-4000-8000-0000000000b2");
    const oldest = landed(a, "1", { size: 4 * GB, at: now - 5 * day });
    const newer = landed(b, "2", { size: 4 * GB, at: now - 1 * day });
    const cutting = landed(a, "3", { size: 4 * GB, at: now - 9 * day });
    // Its upload still going on (held back), the oldest of all.
    gate = new Promise((resolve) => (open = resolve));
    const notUp = landed(b, "4", { size: 4 * GB, up: false, at: now - 10 * day });
    await editCloud.mutation("edit:putMedia", { source: notUp.source, name: "REC-4.mp4", originalKey: notUp.key, size: fs.statSync(notUp.path).size });
    // The registry says it's up, but R2 hasn't the bytes (yet): not given up on the registry's word alone.
    const unconfirmed = landed(a, "5", { size: 4 * GB, inR2: false, at: now - 11 * day });
    standInDisk(home, 30 * GB);
    streamed.start(app);
    await Promise.race([streamed.settled(), Bun.sleep(2_000)]);
    // Room enough (30 GB free less 20 kept: 10, under 15): the hourly pass alone gives one up, as the floor needs.
    const counted = walkSync(rootsOf(home, projects.cacheDir())).filter((entry) => entry.path.includes("/.originals/") && entry.kind === "original");
    expect(counted.length).toBe(5);
    // Edit mode cutting from this one now.
    const using = streamed.copyHere(cutting.source);
    expect(using !== null && "copy" in using).toBe(true);
    // A dry run says what would go and takes nothing.
    const dry = cleanCache(app, true, now, { freeBytes: room.keepFreeBytes(home) });
    expect(dry.removed.some((path) => oldest.path.startsWith(`${path}/`) || path === oldest.path)).toBe(true);
    expect(fs.existsSync(oldest.path)).toBe(true);
    // The pass: 10 GB free, 15 kept free: one copy (4 GB) isn't enough, two are; the two oldest-unused that may go.
    const report = cleanCache(app, false, now, { freeBytes: room.keepFreeBytes(home) });
    expect(fs.existsSync(oldest.path)).toBe(false);
    expect(fs.existsSync(newer.path)).toBe(false);
    expect(report.bytes).toBeGreaterThan(0);
    expect(held(a).map((one) => one.source).sort()).toEqual([cutting.source, unconfirmed.source].sort());
    expect(held(b).map((one) => one.source)).toEqual([notUp.source]);
    expect(fs.existsSync(cutting.path)).toBe(true);
    expect(fs.existsSync(notUp.path)).toBe(true);
    expect(fs.existsSync(unconfirmed.path)).toBe(true);
    // Nothing believes the ones given up are still here.
    expect(streamed.copyHere(oldest.source)).toBeNull();
    // Asked for far more than there is (an export of 100 GB), it still never takes those three.
    makeRoom(app, 1000 * GB);
    expect([cutting, notUp, unconfirmed].map((one) => fs.existsSync(one.path))).toEqual([true, true, true]);
    // Let go of, the one cut from may go too.
    if (using !== null && "copy" in using) using.copy.release();
    makeRoom(app, 1000 * GB);
    expect(fs.existsSync(cutting.path)).toBe(false);
    expect(held(a).map((one) => one.source)).toEqual([unconfirmed.source]);
  } finally {
    open();
    cleanup();
  }
}, 30_000);

test("a copy an import's join read lately stays, however short the disk; one the import reads again (its piece not made) too", async () => {
  const { app, home, cleanup } = fixtureHome("keeps-copy-importing");
  try {
    // An import under way: its first recording's piece made, its second not yet.
    const dir = scriptAt(home, "0c0ffee0-0000-4000-8000-0000000000c1", "processing");
    const joined = landed(dir, "1", { size: 4 * GB, at: Date.now() - 9 * 24 * 3600 * 1000 });
    const again = landed(dir, "2", { size: 4 * GB, piece: false, at: Date.now() - 9 * 24 * 3600 * 1000 });
    // Another script's, which nothing reads: what the room is taken from.
    const other = scriptAt(home, "0c0ffee0-0000-4000-8000-0000000000c2");
    const idle = landed(other, "3", { size: 4 * GB, at: Date.now() - 1 * 24 * 3600 * 1000 });
    standInDisk(home, 30 * GB);
    streamed.start(app);
    // A first ask for room has R2 looked at for each (none may go before it says it holds them).
    makeRoom(app, 1000 * GB);
    await Promise.race([streamed.settled(), Bun.sleep(2_000)]);
    // The import's join asks for this Mac's copy of the first by its cloud address (imports.ts `joinPreview`).
    expect(streamed.localOf(dir, `https://r2.invalid/${joined.key}?X-Amz-Signature=x`)).toBe(joined.path);
    makeRoom(app, 1000 * GB);
    expect(fs.existsSync(idle.path)).toBe(false);
    expect(fs.existsSync(joined.path)).toBe(true);
    expect(fs.existsSync(again.path)).toBe(true);
  } finally {
    cleanup();
  }
}, 30_000);

// ---------------------------------------------------------------------------
// The team's Macs (their reports, Nov 21): what Script mode keeps of two scripts of long recordings, one after the
// other, and what an export then gives up. JJ's recordings are several GB each (4 here).

const MACS = [
  { who: "JJ's MacBook Pro", disk: 494, free: 45 },
  { who: "Sphe's M4 Air at its usual", disk: 245, free: 14 },
  { who: "Sphe's M4 Air at its highest", disk: 245, free: 18 },
  { who: "the MacBook Air", disk: 245, free: 6 },
];
const RECORDING = 4 * GB;
const EACH = 6;

interface Day {
  /** Copies kept of the first script and of the second once both are in, and bytes kept. */
  first: number;
  second: number;
  kept: number;
  free: number;
  /** Of them, given up for a 10 GB export. */
  forExport: number;
}

/**
 * Two scripts imported on a Mac with `free` GB free: each recording comes down here only with room for it beside what
 * Edit keeps free (imports.ts asks `room.roomFor`), the cleaner asked for room first; its copy stays once it's up and
 * its piece made while the disk has what Edit keeps free. Then a 10 GB export is admitted.
 */
async function aDay(app: ReturnType<typeof fixtureHome>["app"], home: string, free: number, at: { now: number }): Promise<Day> {
  fs.rmSync(store.scriptsRoot(store.dataDir(home)), { recursive: true, force: true });
  streamed.reset();
  room.resetRoom();
  mock.cloud.objects.clear();
  standInDisk(home, free);
  room.diskHooks.makeRoom = (wanted) => makeRoom(app, wanted);
  streamed.start(app);
  const dirs: string[] = [];
  for (const [s, id] of ["0c0ffee0-0000-4000-8000-0000000000d1", "0c0ffee0-0000-4000-8000-0000000000d2"].entries()) {
    const dir = scriptAt(home, id, "processing");
    dirs.push(dir);
    for (let n = 0; n < EACH; n++) {
      if (!room.roomFor(dir, RECORDING)) continue;
      // Each one a minute after the last, as they come down.
      at.now += 60_000;
      const copy = landed(dir, `${s}${n}`, { size: RECORDING, piece: false, at: at.now });
      pieceMade(dir, copy);
      await streamed.settled();
    }
    fs.writeFileSync(join(dir, "script.json"), JSON.stringify({ status: "ready" }));
  }
  const count = (dir: string) => held(dir).length;
  const first = count(dirs[0]!);
  const second = count(dirs[1]!);
  const freeAfter = room.diskHooks.free(home);
  room.admit(home, 10 * GB, "This export");
  return { first, second, kept: (first + second) * RECORDING, free: freeAfter, forExport: first + second - count(dirs[0]!) - count(dirs[1]!) };
}

test("on the team's Macs: what Script mode keeps of two scripts of 4 GB recordings and what an export gives up, said in plain words; more free room never keeps less, and nothing is kept at the cost of the floor", async () => {
  const { app, home, cleanup } = fixtureHome("keeps-copy-macs");
  const at = { now: Date.now() - 30 * 24 * 3600 * 1000 };
  try {
    const lines: string[] = [];
    for (const mac of MACS) {
      const day = await aDay(app, home, mac.free * GB, at);
      const kept = day.first + day.second;
      lines.push(
        `${mac.who} (${mac.disk} GB disk, ${mac.free} GB free), two scripts of ${EACH} recordings of ${RECORDING / GB} GB a day apart: ` +
          (kept === 0
            ? "keeps none here (each read from the cloud at Start the edit), nothing given up"
            : `keeps ${day.first} of the first and ${day.second} of the second here (${day.kept / GB} GB, ${(day.free / GB).toFixed(0)} GB left free)` +
              `${EACH - day.first > 0 && day.second > 0 ? `, the first's oldest given up as the second came down` : ""}; a 10 GB export gives up ${day.forExport} more`),
      );
      // Nothing kept at the cost of what Edit keeps free.
      if (kept > 0) expect([mac.who, day.free >= room.keepFreeBytes(home)]).toEqual([mac.who, true]);
    }
    // JJ keeps the second script whole and some of the first; the M4 under 15 GB and the 6 GB Air keep none.
    expect(lines[0]).toContain(`keeps 1 of the first and ${EACH} of the second`);
    expect(lines[1]).toContain("keeps none");
    expect(lines[3]).toContain("keeps none");
    console.log(lines.join("\n"));
    // Rules of scale: more free room never keeps less, and whatever is kept leaves what Edit keeps free.
    let before = -1;
    for (let free = 0; free <= 120; free += 6) {
      const day = await aDay(app, home, free * GB, at);
      expect([free, day.kept >= before]).toEqual([free, true]);
      if (day.kept > 0) expect([free, day.free >= room.keepFreeBytes(home)]).toEqual([free, true]);
      before = day.kept;
    }
  } finally {
    cleanup();
  }
}, 180_000);
