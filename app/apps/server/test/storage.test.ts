import { expect, test } from "bun:test";

import { localBudgetBytes } from "../src/storage.ts";

test("the cache's budget is a quarter of the disk's room, 400 MB to 50 GB, leaving 1 GB free", () => {
  const GB = 1e9;
  // This M1 on Nov 2: 15 GB free, a 6.7 GB cache.
  expect(localBudgetBytes({ freeBytes: 15 * GB, cacheBytes: 6.7 * GB })).toBe(Math.floor(21.7 * GB * 0.25));
  expect(localBudgetBytes({ freeBytes: 0.2 * GB, cacheBytes: 0 })).toBe(400_000_000);
  expect(localBudgetBytes({ freeBytes: 1000 * GB, cacheBytes: 0 })).toBe(50 * GB);
  expect(localBudgetBytes()).toBe(400_000_000);
});
