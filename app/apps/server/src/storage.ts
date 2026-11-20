// How much of this disk Edit's local data may take, and the room work claims
// as it writes (cache_cleanup.ts, Script mode's writer/storage.ts and every
// writer that fills the disk keep to it).
//
// A floor, not a share (the local-first plan, Sphe, Nov 18): Edit keeps the
// larger of 15 GB or a tenth of the disk free (`keepFreeBytes`) and may use
// the rest. Until then the cache's budget was a quarter of the room, at most
// 50 GB, with 1 GB kept free: JJ's Mac could have held three times what it
// was allowed, and Sphe's M4 couldn't hold what it was given (12-18 GB free
// of 245, ~150 GB not Edit's, disk full at 22:03 on Nov 17). A cache on
// another volume keeps to that volume's numbers. What Edit holds is the
// ledger's (ledger.ts), by project and kind.

import * as fs from "node:fs";
import * as os from "node:os";

import { ledger } from "./ledger.ts";
import { THIS_MACHINE } from "./machine.ts";

export { ledger };

/** The disk's free space Edit's writes never take it below (the last gigabyte: macOS's own). */
export const FREE_FLOOR_BYTES = 1_000_000_000;
/** What Edit keeps free on any disk (`keepFreeBytes`). */
export const KEEP_FREE_LEAST_BYTES = 15_000_000_000;
/**
 * What Edit keeps free on the disk holding `dir`: 15 GB, whatever the disk's size. A share of the disk counted JJ's
 * 494 GB Mac with 41 GB free as full (a tenth: 49 GB kept), so his long videos streamed instead of being saved and the
 * "getting footage ready" dialog waited for ever (nightly-90, Nov 19); and any share, capped or not, breaks a rule of
 * scale: a bigger disk with the same free room would keep less work (a 5.5 GB file kept on a 128 GB Mac and refused on
 * a 494 GB one). The cleaner evicts projects that aren't in work to keep it, copies kept only to play sooner stop at it
 * (`cacheFloor`), and work asked for evicts down to it before it starts (`admit`). Held against every disk and free
 * space, and the team's Macs, in test/storage_machines.test.ts.
 */
export function keepFreeBytes(_dir: string): number {
  return KEEP_FREE_LEAST_BYTES;
}

/** `keepFreeBytes` for a disk of `total` bytes: the same 15 GB (kept as a function so the rules of scale test it). */
export function keepFreeFor(_total: number): number {
  return KEEP_FREE_LEAST_BYTES;
}

// ---------------------------------------------------------------------------
// The disk's room, shared by everything that fills it in the background
// (kenobi, Nov 17: an M1 with little disk opened Cops Found 3 Bodies, 7.85 GB
// in R2; whole copies queued with no check counted 3.3 GB in about a minute,
// went on past "the disk too full to keep them whole" to ENOSPC at 233 MB free,
// and every effect render after was refused). Each writer claims what it still
// has to write before it starts (`claim`), and a new one starts only while the
// free space less every claim and its own need stays over its floor (`spare`).

/**
 * Room left for macOS's own swap files over the floor: it adds one a gigabyte at a time, and an 8 GB Mac swaps
 * hard while Edit plays (kenobi, Nov 17: free space fell from 1.94 GB to 1.02 GB in 40 s, none of it Edit's, as
 * `swapfile4` came; 4.1 of 5.1 GB of swap in use). Two gigabytes on a Mac of 8 GB or less, one above.
 */
export function swapRoomFor(memory: number): number {
  return memory <= 8 * 2 ** 30 ? 2_000_000_000 : 1_000_000_000;
}
export const SWAP_ROOM_BYTES = swapRoomFor(os.totalmem());

/** What the work that fills the disk as it goes (blocks read for a play, an effect's render) leaves free: the floor and the swap's room. */
export const WORK_FLOOR_BYTES = FREE_FLOOR_BYTES + SWAP_ROOM_BYTES;

/**
 * The least that copies kept only to play sooner leave free: the work's floor and a gigabyte more, for the work that
 * can't stream (an effect's render, an export). They keep to `cacheFloor`, which is never less.
 */
export const CACHE_FLOOR_BYTES = WORK_FLOOR_BYTES + 1_000_000_000;

/** `CACHE_FLOOR_BYTES` on a Mac with `memory` bytes of memory (the team's Macs held in test/storage_machines.test.ts). */
export function cacheFloorBytesFor(memory: number): number {
  return FREE_FLOOR_BYTES + swapRoomFor(memory) + 1_000_000_000;
}

/** The nearest folder of `dir` that's there (a folder not made yet is on its parent's disk), or null. */
function statfsOf(dir: string): fs.StatsFs | null {
  for (let at = dir; ; ) {
    try {
      return fs.statfsSync(at);
    } catch {
      const up = at.lastIndexOf("/") > 0 ? at.slice(0, at.lastIndexOf("/")) : "/";
      if (up === at || at === "") return null;
      at = up;
    }
  }
}

/** Seams for tests: the disk's free space and size, and the cleaner asked to make room (cache_cleanup.ts `makeRoom`, set at the server's start). */
export const diskHooks = {
  free: (dir: string): number => {
    const stat = statfsOf(dir);
    return stat === null ? Number.POSITIVE_INFINITY : stat.bavail * stat.bsize;
  },
  /** The disk's size (unknown: NaN). */
  total: (dir: string): number => {
    const stat = statfsOf(dir);
    return stat === null ? Number.NaN : stat.blocks * stat.bsize;
  },
  makeRoom: (_wanted: number): number => 0,
};

/**
 * What copies kept only to play sooner (whole previews, a long video's pieces, map tiles) leave free on the disk
 * holding `dir`: the cache's floor, and never less than what Edit keeps free there (`keepFreeBytes`), so they never
 * fill what the cleaner keeps; past it they stream.
 */
export function cacheFloor(dir: string): number {
  return Math.max(CACHE_FLOOR_BYTES, keepFreeBytes(dir));
}

// ---------------------------------------------------------------------------
// The open project's footage is work (Sphe, Nov 20)
//
// Whole copies, a long video's pieces and their joins kept only to play sooner keep the cache's floor (15 GB): Sphe's
// M4 at 12–18 GB free kept none of an open project's footage, so it streamed for the whole session, every jump and
// cold stretch waiting on R2. The footage of a project open here and being watched is the work at hand, as an import or
// an export is: it is kept down to the floor work keeps (`CACHE_FLOOR_BYTES`: macOS's last gigabyte, its swap's room,
// and a gigabyte for the work that can't stream, an effect's render or an export), and the cleaner lets go of the
// projects that aren't open first (cache_cleanup.ts `makeRoom`, asked through `askForRoom` where it's short). Every
// other copy keeps the cache's floor as before.

/** A project is open here while its page warms its footage, or the editor said it's open, within this long (cache_cleanup.ts keeps it as long). */
const OPEN_MS = 10 * 60_000;
/** Each open project's footage (stream keys and long videos' bases), and when its page last asked for it. */
const openFootage = new Map<string, { keys: Set<string>; at: number }>();
/** Seams: whether the editor says project `id` is open now (opened.ts, set at the server's start), and the clock. */
export const openHooks = { isOpen: (_id: string): boolean => false, now: () => Date.now() };

/** Project `id` is being watched here, and plays `keys` (its stream keys and long videos' bases): kept as work while it's open. */
export function noteOpenFootage(id: string, keys: Iterable<string>): void {
  openFootage.set(id, { keys: new Set(keys), at: openHooks.now() });
}

/** Whether `key` (a stream key or a long video's base) is the footage of a project open here now. */
export function isOpenFootage(key: string): boolean {
  const now = openHooks.now();
  for (const [id, one] of openFootage) {
    const open = now - one.at < OPEN_MS || openHooks.isOpen(id);
    if (!open && now - one.at > 24 * 3_600_000) openFootage.delete(id);
    else if (open && one.keys.has(key)) return true;
  }
  return false;
}

/**
 * What a copy of `key` kept to play sooner leaves free on the disk holding `dir`: the open project's footage the
 * work's floor and a gigabyte (`CACHE_FLOOR_BYTES`: 3 GB on a Mac of more than 8 GB, 4 GB on an 8 GB M1), anything else
 * the cache's (`cacheFloor`: 15 GB). Never more than the cache's floor, so the open project is never worse off.
 */
export function footageFloor(dir: string, key: string | null | undefined): number {
  return key !== null && key !== undefined && isOpenFootage(key) ? CACHE_FLOOR_BYTES : cacheFloor(dir);
}

/** Bytes free on the disk holding `dir` (unknown: as good as endless). */
export function freeBytes(dir: string): number {
  return diskHooks.free(dir);
}

/** Room a write under way has promised itself: what it still has to write (set as it writes), until released. */
export interface Claim {
  bytes: number;
  release(): void;
}

const claims = new Set<Claim>();

/** Claims `bytes` of the disk for a write about to start. */
export function claim(bytes: number): Claim {
  const one: Claim = {
    bytes: Math.max(0, bytes),
    release: () => {
      claims.delete(one);
    },
  };
  claims.add(one);
  return one;
}

/** What every write under way still has to write, but `except`'s. */
export function claimedBytes(except?: Claim): number {
  let total = 0;
  for (const one of claims) if (one !== except) total += Math.max(0, one.bytes);
  return total;
}

/**
 * Bytes over `floor` the disk holding `dir` keeps once `bytes` more are written beside every claim but `except`'s
 * (below zero: short by that much).
 */
export function spare(dir: string, bytes: number, floor = FREE_FLOOR_BYTES, except?: Claim): number {
  return freeBytes(dir) - claimedBytes(except) - Math.max(0, bytes) - floor;
}

/** The cleaner is asked for room at most this often (a pass walks the whole cache). */
const ROOM_EVERY_MS = 5 * 60_000;
let roomAsked = 0;

/**
 * The cleaner asked to free the disk until `wanted` bytes are free (cache_cleanup.ts `makeRoom`: the least recently
 * used copies, never a project open in the last ten minutes nor any copy touched in the last hours), at most once
 * every few minutes; what it freed.
 */
export function askForRoom(wanted: number, now = Date.now()): number {
  if (now - roomAsked < ROOM_EVERY_MS) return 0;
  roomAsked = now;
  try {
    return diskHooks.makeRoom(wanted);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Admission (the plan's step 1, Nov 18): an import, an export, a project's
// footage coming down each add up what they will write before they start,
// the cleaner evicts projects that aren't in work to make room, and if it is
// still short the work is refused at once in one plain line with the numbers,
// never ENOSPC part-way (Nov 17: the M4's disk filled mid-export; kenobi's
// mid-open).

const GB = 1e9;
const gb = (bytes: number) => (bytes < 10 * GB ? (Math.max(bytes, 0) / GB).toFixed(1) : String(Math.round(bytes / GB)));

/** "This import needs about 12 GB free and this Mac has 6 GB. Free some space, then try again." */
export function roomLine(what: string, need: number, has: number, then = "try again"): string {
  return `${what} needs about ${gb(need)} GB free and ${THIS_MACHINE} has ${gb(Math.max(has, 0))} GB. Free some space, then ${then}.`;
}

/** Room asked for straight from the cleaner (a person's action: not held to `askForRoom`'s every few minutes). */
function makeRoomNow(wanted: number): number {
  try {
    return diskHooks.makeRoom(wanted);
  } catch {
    return 0;
  }
}

/**
 * Whether work about to write `bytes` to the disk holding `dir` may start: null when it may, else why not, in one
 * line with the numbers (`what`: "This import", "This export"). Short of what Edit keeps free after it, the cleaner
 * evicts projects that aren't in work first (oldest first, whole). Refused only when, even then, the work would take
 * the disk under the floor writes keep (`WORK_FLOOR_BYTES`, macOS's swap included): a Mac with 12 GB free does a
 * 5 GB export, as it did before the floor was 15 GB, and the cleaner frees what it can around it.
 */
export function admit(dir: string, bytes: number, what: string, then?: string): string | null {
  if (!(bytes > 0)) return null;
  const free = () => freeBytes(dir) - claimedBytes();
  if (!Number.isFinite(freeBytes(dir))) return null;
  const target = bytes + keepFreeBytes(dir);
  if (free() < target) makeRoomNow(freeBytes(dir) + target - free());
  const has = free();
  if (has - bytes >= WORK_FLOOR_BYTES) return null;
  return roomLine(what, bytes + WORK_FLOOR_BYTES, has, then);
}

/**
 * Whether `bytes` more fit on the disk holding `dir` with what Edit keeps free still free after them (`keepFreeBytes`),
 * the cleaner asked first as `admit` asks it. For work that can do without the room and is only faster with it (an
 * import's originals kept here until they're in the cloud, writer/streamed.ts): short, it does without, never refused.
 */
export function roomFor(dir: string, bytes: number): boolean {
  if (!Number.isFinite(freeBytes(dir))) return true;
  const free = () => freeBytes(dir) - claimedBytes();
  const target = Math.max(0, bytes) + keepFreeBytes(dir);
  if (free() < target) makeRoomNow(freeBytes(dir) + target - free());
  return free() >= target;
}

/** For tests. */
export function resetRoom(): void {
  claims.clear();
  roomAsked = 0;
  openFootage.clear();
}
