// How much of this disk Edit's local data may take (cache_cleanup.ts and
// Script mode's storage.ts keep to it).

import * as fs from "node:fs";
import * as os from "node:os";

/**
 * The smallest local cache, and what it was until Nov 2. Sized for a Mac that
 * did its heavy work on Modal; once Edit moved back onto the Macs (Sphe,
 * Nov 2), 400 MB meant the previews a project plays and the footage its
 * exports read were evicted and fetched from R2 again all day.
 */
export const DEFAULT_LOCAL_BUDGET_BYTES = 400_000_000;
/** The disk's free space Edit never takes the cache below. */
export const FREE_FLOOR_BYTES = 1_000_000_000;
/** The share of the room (free space plus the cache itself) the cache may hold. */
const SHARE = 0.25;
/** However big the disk, no more than this. */
const MOST = 50_000_000_000;

/**
 * The local-data budget: with the disk known, a quarter of the room it has (its free space and what
 * the cache already holds, so the budget doesn't shrink as the cache fills),
 * between 400 MB and 50 GB and always leaving FREE_FLOOR_BYTES free: an M1
 * with 15 GB free and a 6.7 GB cache, 5.4 GB. Unknown, the old 400 MB.
 */
export function localBudgetBytes(disk?: { freeBytes: number; cacheBytes: number }): number {
  if (disk === undefined || !Number.isFinite(disk.freeBytes)) return DEFAULT_LOCAL_BUDGET_BYTES;
  const room = Math.max(disk.freeBytes, 0) + Math.max(disk.cacheBytes, 0);
  return Math.floor(Math.max(DEFAULT_LOCAL_BUDGET_BYTES, Math.min(room * SHARE, room - FREE_FLOOR_BYTES, MOST)));
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
 * What copies kept only to play sooner (whole previews, a long video's pieces) leave free: the work's floor and a
 * gigabyte more, for the work that can't stream (an effect's render, an export).
 */
export const CACHE_FLOOR_BYTES = WORK_FLOOR_BYTES + 1_000_000_000;

/** Seams for tests: the disk's free space, and the cleaner asked to make room (cache_cleanup.ts `makeRoom`, set at the server's start). */
export const diskHooks = {
  free: (dir: string): number => {
    // A folder not made yet is on its nearest parent's disk.
    for (let at = dir; ; ) {
      try {
        const stat = fs.statfsSync(at);
        return stat.bavail * stat.bsize;
      } catch {
        const up = at.lastIndexOf("/") > 0 ? at.slice(0, at.lastIndexOf("/")) : "/";
        if (up === at || at === "") return Number.POSITIVE_INFINITY;
        at = up;
      }
    }
  },
  makeRoom: (_wanted: number): number => 0,
};

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

/** For tests. */
export function resetRoom(): void {
  claims.clear();
  roomAsked = 0;
}
