import { expect, test } from "bun:test";

import * as storage from "../src/storage.ts";
import { localBudgetBytes } from "../src/storage.ts";

test("the cache's budget is a quarter of the disk's room, 400 MB to 50 GB, leaving 1 GB free", () => {
  const GB = 1e9;
  // This M1 on Nov 2: 15 GB free, a 6.7 GB cache.
  expect(localBudgetBytes({ freeBytes: 15 * GB, cacheBytes: 6.7 * GB })).toBe(Math.floor(21.7 * GB * 0.25));
  expect(localBudgetBytes({ freeBytes: 0.2 * GB, cacheBytes: 0 })).toBe(400_000_000);
  expect(localBudgetBytes({ freeBytes: 1000 * GB, cacheBytes: 0 })).toBe(50 * GB);
  expect(localBudgetBytes()).toBe(400_000_000);
});

test("the disk's room: what's free less every write's claim and a new one's need, over its floor; the cleaner asked at most every few minutes", () => {
  const realFree = storage.diskHooks.free;
  const realRoom = storage.diskHooks.makeRoom;
  storage.resetRoom();
  try {
    const GB = 1e9;
    storage.diskHooks.free = () => 3 * GB;
    expect(storage.spare("/x", 1 * GB)).toBe(1 * GB);
    const one = storage.claim(0.5 * GB);
    expect(storage.spare("/x", 1 * GB)).toBe(0.5 * GB);
    // Its own claim isn't counted against it, and it shrinks as it writes.
    expect(storage.spare("/x", 1 * GB, storage.FREE_FLOOR_BYTES, one)).toBe(1 * GB);
    one.bytes = 0.1 * GB;
    expect(storage.claimedBytes()).toBe(0.1 * GB);
    one.release();
    expect(storage.claimedBytes()).toBe(0);
    // Work that fills the disk as it goes leaves room for macOS's swap files too, and copies kept only to play
    // sooner a gigabyte more again, for work that can't stream (kenobi, Nov 17: a swap file took 0.9 GB at once).
    expect(storage.WORK_FLOOR_BYTES).toBe(storage.FREE_FLOOR_BYTES + storage.SWAP_ROOM_BYTES);
    expect(storage.CACHE_FLOOR_BYTES).toBe(storage.WORK_FLOOR_BYTES + 1 * GB);
    expect(storage.SWAP_ROOM_BYTES).toBeGreaterThanOrEqual(1 * GB);
    expect(storage.spare("/x", 1 * GB, storage.CACHE_FLOOR_BYTES)).toBe(3 * GB - 1 * GB - storage.CACHE_FLOOR_BYTES);
    const asked: number[] = [];
    storage.diskHooks.makeRoom = (wanted) => {
      asked.push(wanted);
      return 7;
    };
    expect(storage.askForRoom(4 * GB, 1_000_000)).toBe(7);
    expect(storage.askForRoom(4 * GB, 1_060_000)).toBe(0);
    expect(storage.askForRoom(4 * GB, 1_000_000 + 5 * 60_000)).toBe(7);
    expect(asked).toEqual([4 * GB, 4 * GB]);
  } finally {
    storage.diskHooks.free = realFree;
    storage.diskHooks.makeRoom = realRoom;
    storage.resetRoom();
  }
});
