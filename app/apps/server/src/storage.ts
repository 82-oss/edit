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
/** The least Edit keeps free on a disk however small it is. */
export const KEEP_FREE_LEAST_BYTES = 15_000_000_000;
/** The share of a disk Edit keeps free when that is more. */
export const KEEP_FREE_SHARE = 0.1;

/**
 * What Edit keeps free on the disk holding `dir`: the larger of 15 GB or a tenth of the disk (a 245 GB M4: 24.5 GB;
 * a 128 GB Mac: 15 GB). The cleaner evicts projects that aren't in work to keep it, copies kept only to play sooner
 * stop at it (`cacheFloor`), and work asked for evicts down to it before it starts (`admit`). A disk whose size is
 * unknown keeps the 15 GB.
 */
export function keepFreeBytes(dir: string): number {
  const total = diskHooks.total(dir);
  return Math.max(KEEP_FREE_LEAST_BYTES, Number.isFinite(total) && total > 0 ? Math.floor(total * KEEP_FREE_SHARE) : 0);
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
export const SWAP_ROOM_BYTES = os.totalmem() <= 8 * 2 ** 30 ? 2_000_000_000 : 1_000_000_000;

/** What the work that fills the disk as it goes (blocks read for a play, an effect's render) leaves free: the floor and the swap's room. */
export const WORK_FLOOR_BYTES = FREE_FLOOR_BYTES + SWAP_ROOM_BYTES;

/**
 * The least that copies kept only to play sooner leave free: the work's floor and a gigabyte more, for the work that
 * can't stream (an effect's render, an export). They keep to `cacheFloor`, which is never less.
 */
export const CACHE_FLOOR_BYTES = WORK_FLOOR_BYTES + 1_000_000_000;

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

/** For tests. */
export function resetRoom(): void {
  claims.clear();
  roomAsked = 0;
}
