import { afterEach, expect, test } from "vitest";

import { bounded, nativePreview, NativeTimeout, nativeTiming, sourcesRetryMs } from "./nativePreview";

const realTiming = { ...nativeTiming };
const globals = globalThis as unknown as { window?: unknown };
const hadWindow = "window" in globals;
const realWindow = globals.window;
afterEach(() => {
  Object.assign(nativeTiming, realTiming);
  if (hadWindow) globals.window = realWindow;
  else delete globals.window;
});

/** A window whose every command waits on `answer` (never answering by default), each one counted. */
function windowAnswering(answer: (command: string) => Promise<unknown> = () => new Promise(() => {})) {
  const asked: string[] = [];
  globals.window = { __TAURI_INTERNALS__: { invoke: (command: string) => (asked.push(command), answer(command)) } };
  return asked;
}

test("an ask of the window that isn't answered in its time is a failure (NativeTimeout), so five of them send the page back to its own player (Nov 20: Position, Pause and Frame queued for ever behind a stuck read)", async () => {
  nativeTiming.quickMs = 20;
  nativeTiming.slowMs = 60;
  const asked = windowAnswering();
  const began = performance.now();
  const where = await nativePreview.position().then(() => null, (error: unknown) => error);
  expect(where).toBeInstanceOf(NativeTimeout);
  expect(performance.now() - began).toBeLessThan(200);
  // A frame may decode first: given longer, still bounded.
  const frameBegan = performance.now();
  expect(await nativePreview.frame(10).then(() => null, (error: unknown) => error)).toBeInstanceOf(NativeTimeout);
  expect(performance.now() - frameBegan).toBeGreaterThanOrEqual(50);
  expect(asked).toEqual(["preview_position", "preview_frame"]);
  // One that answers in time is the window's answer, and one it refuses is its refusal, not a timeout.
  windowAnswering((command) => (command === "preview_pause" ? Promise.resolve(42) : Promise.reject(new Error("at the end"))));
  expect(await nativePreview.pause()).toBe(42);
  const refused = await nativePreview.play(0).then(() => null, (error: unknown) => error);
  expect(String(refused)).toContain("at the end");
  expect(refused).not.toBeInstanceOf(NativeTimeout);
});

test("a hung ask is given up after its bound and the one waiting on it goes on (the grey's `/playback/ready`: it stayed asking for good)", async () => {
  let asking = true;
  const hung = bounded(new Promise<number>(() => {}), 20, () => new Error("not in time")).finally(() => (asking = false));
  expect(await hung.then(() => "answered", (error: unknown) => String(error))).toContain("not in time");
  expect(asking).toBe(false);
  expect(await bounded(Promise.resolve(7), 20, () => new Error("late"))).toBe(7);
});

test("the window's sources are asked again after a failed ask, a little later each time, at most every 15 s (they were never asked again)", () => {
  expect([0, 1, 2, 3, 4, 5, 9].map(sourcesRetryMs)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
});
