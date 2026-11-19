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
});
