// How much of this disk Edit's local data may take (cache_cleanup.ts and
// Script mode's storage.ts keep to it).

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
