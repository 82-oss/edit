// import_steps.whileMoving: a step read over the network is stopped only after it stands still, never by a clock
// (honest council change 5, Nov 19: JJ's "Genius" Killer file, cut five times and each stopped at 15–18 minutes).

import { expect, test } from "bun:test";

import { StoodStill } from "../src/failure.ts";
import { whileMoving } from "../src/import_steps.ts";

test("slow but moving runs to the end, however long; standing still is stopped and said as passing", async () => {
  let bytes = 0;
  const slow = whileMoving(
    "Cutting an excerpt",
    () => bytes,
    (signal) =>
      new Promise<string>((resolve, reject) => {
        // Ten times longer than it may stand still, a little at a time.
        const grow = setInterval(() => (bytes += 1), 40);
        setTimeout(() => (clearInterval(grow), resolve("cut")), 2_000);
        signal.addEventListener("abort", () => (clearInterval(grow), reject(new Error("aborted"))));
      }),
    200,
  );
  expect(await slow).toBe("cut");

  let aborted = false;
  const stuck = whileMoving(
    "Cutting an excerpt",
    () => 7,
    (signal) =>
      new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => ((aborted = true), reject(new Error("aborted"))));
      }),
    200,
  );
  const error = await stuck.then(() => null, (failed: unknown) => failed);
  expect(error).toBeInstanceOf(StoodStill);
  expect(String(error)).toContain("made no progress");
  expect(aborted).toBe(true);

  const stop = new AbortController();
  let cleaned = false;
  const cancelled = whileMoving(
    "Copying the sound",
    () => 0,
    (signal) =>
      new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            cleaned = true;
            reject(new Error("aborted"));
          }, 20);
        });
      }),
    5_000,
    stop.signal,
  );
  setTimeout(() => stop.abort(), 30);
  await expect(cancelled).rejects.toThrow("cancelled");
  expect(cleaned).toBe(true);
});

// Nov 20: work that never ends on its signal (a wait on another's download) held whileMoving for good.
test("work that ignores its stop is left behind once it stands still, never waited on for ever", async () => {
  const began = Date.now();
  const deaf = whileMoving("Script mode's download of a.mp4", () => 0, () => new Promise<string>(() => {}), 200);
  const error = await deaf.then(() => null, (failed: unknown) => failed);
  expect(error).toBeInstanceOf(StoodStill);
  expect(Date.now() - began).toBeLessThan(5_000);
});

// Nov 20: `bounded` was a plain timer, so a lid closed mid-step ended a step that was fine.
test("a bounded step gets back the time the machine was away", async () => {
  const { bounded } = await import("../src/import_steps.ts");
  const wake = await import("../src/wake.ts");
  let woken = false;
  const step = bounded("Finding the excerpt's keyframe", 400, async () => {
    // 300 ms in, the machine is said to have been away for 250 of them; the step's own work takes 600 ms in all.
    await Bun.sleep(300);
    wake.woke(250);
    woken = true;
    await Bun.sleep(300);
    return "found";
  });
  expect(await step).toBe("found");
  expect(woken).toBe(true);
  // Without a wake the same work is stopped at its time.
  const late = bounded("Finding the excerpt's keyframe", 400, async () => {
    await Bun.sleep(600);
    return "found";
  });
  await expect(late).rejects.toThrow("took more than");
  wake.stopForTests();
});
