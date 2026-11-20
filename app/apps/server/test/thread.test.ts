import { afterEach, expect, test } from "bun:test";

import * as thread from "../src/thread.ts";
import * as wake from "../src/wake.ts";

afterEach(() => {
  wake.stopForTests();
  thread.resetForTests();
});

/** The thread kept for `ms` by work (a loop that never lets go). */
function keep(ms: number): void {
  const until = performance.now() + ms;
  let x = 0;
  while (performance.now() < until) x += Math.sqrt(x + 1);
}

test("a loop of awaits on what's already settled never lets anything else run, and a breather does", async () => {
  const beats = (work: () => Promise<void>) =>
    new Promise<number>((resolve) => {
      let most = 0;
      let last = performance.now();
      const beat = setInterval(() => {
        const now = performance.now();
        most = Math.max(most, now - last - 5);
        last = now;
      }, 5);
      void work().then(() => {
        clearInterval(beat);
        // The stretch still running as the work ended counts too (with no turn at all, the beat never fired).
        resolve(Math.max(most, performance.now() - last - 5));
      });
    });
  const step = async () => keep(2);
  // 150 steps of 2 ms, each awaited: one unbroken 300 ms for everything else in Edit.
  const without = await beats(async () => {
    for (let i = 0; i < 150; i++) await step();
  });
  expect(without).toBeGreaterThan(200);
  const with_ = await beats(async () => {
    const breathe = thread.breather();
    for (let i = 0; i < 150; i++) {
      await step();
      await breathe();
    }
  });
  expect(with_).toBeLessThan(60);
});

test("a hold of the thread is said with what last started on it and kept for the report; a quiet gap isn't one", async () => {
  expect(thread.report()).toBeNull();
  thread.note("Script mode's cloud round");
  const hold = thread.held(4200, 4100);
  expect(hold.during).toBe("Script mode's cloud round");
  expect(thread.recentHolds().length).toBe(1);
  expect(thread.report()).toContain("answered nothing 1 time in the last hour");
  expect(thread.report()).toContain("last started: Script mode's cloud round");
});

test("the beat hands a busy gap to the thread's holds, and a sleep to the wake's listeners", async () => {
  wake.GAP_MS.value = 10_000;
  let woke = 0;
  wake.onWake(() => woke++);
  await Bun.sleep(1100);
  thread.note("a test's long loop");
  keep(3300);
  await Bun.sleep(1200);
  expect(woke).toBe(0);
  const holds = thread.recentHolds();
  expect(holds.length).toBe(1);
  expect(holds[0]!.ms).toBeGreaterThan(2000);
  expect(holds[0]!.during).toBe("a test's long loop");
}, 15_000);
