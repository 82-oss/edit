// The encoder's one lease with tiers (Nov 22): a person's Export first, a share's review copy next, smooth playback's
// render after, proxies and other background encodes last, each of those giving way at its next piece; and an export
// one fewer at once while a play is watched. Driven by fake users: nothing here encodes.

import { afterEach, beforeEach, expect, test } from "bun:test";

import * as encoder from "../src/encoder.ts";
import * as playing from "../src/playing.ts";

const { pollMs, longestWaitMs } = encoder.hooks;

beforeEach(() => {
  encoder.reset();
  encoder.hooks.pollMs = 20;
});

afterEach(() => {
  encoder.reset();
  encoder.hooks.pollMs = pollMs;
  encoder.hooks.longestWaitMs = longestWaitMs;
  playing.note("p1", false);
});

/** A background user encoding `pieces` pieces, taking its turn before each: the order things happened in `log`. */
async function background(name: string, pieces: number, log: string[], pieceMs = 30): Promise<void> {
  for (let piece = 1; piece <= pieces; piece++) {
    const lease = await encoder.turn(`${name} ${piece}`);
    log.push(`${name} ${piece} starts`);
    await Bun.sleep(pieceMs);
    log.push(`${name} ${piece} ends`);
    lease.release();
  }
}

test("a background encode gives way at its next piece while an export holds the encoder, and carries on after", async () => {
  const log: string[] = [];
  let exporting = false;
  const off = encoder.register(() => (exporting ? "an export" : null));
  const proxies = background("proxy", 3, log, 60);
  await Bun.sleep(20);
  // The Export pressed mid-piece: that piece finishes, the next waits.
  exporting = true;
  log.push("export starts");
  await Bun.sleep(200);
  expect(log).toEqual(["proxy 1 starts", "export starts", "proxy 1 ends"]);
  exporting = false;
  log.push("export ends");
  await proxies;
  expect(log.slice(3)).toEqual(["export ends", "proxy 2 starts", "proxy 2 ends", "proxy 3 starts", "proxy 3 ends"]);
  off();
});

test("tiers go first to last: an export, a share's review copy, smooth playback, then background", async () => {
  const copy = encoder.hold("a share's review copy", "share");
  expect(encoder.above("export")).toEqual([]);
  expect(encoder.above("share")).toEqual([]);
  expect(encoder.above("playback")).toEqual(["a share's review copy"]);
  expect(encoder.above("background")).toEqual(["a share's review copy"]);
  const render = encoder.hold("smooth playback's render", "playback");
  expect(encoder.above("background")).toEqual(["a share's review copy", "smooth playback's render"]);
  // Background waits for both; smooth playback's own turn waits only for the copy.
  const order: string[] = [];
  const proxy = encoder.turn("a proxy").then((lease) => (order.push("proxy"), lease));
  const next = encoder.turn("the next render", "playback").then((lease) => (order.push("render"), lease));
  await Bun.sleep(60);
  expect(order).toEqual([]);
  copy.release();
  await next;
  expect(order).toEqual(["render"]);
  render.release();
  await Bun.sleep(60);
  expect(order).toEqual(["render"]);
  (await next).release();
  (await proxy).release();
  expect(order).toEqual(["render", "proxy"]);
  // Background never waits for background.
  const one = encoder.hold("a proxy");
  const two = await encoder.turn("another proxy");
  expect(encoder.shared(two.token)).toBe(true);
  one.release();
  two.release();
  expect(encoder.busy()).toBe(false);
});

test("a hold that says how it gives way is asked to once when work above takes the encoder, never by work below", () => {
  let asked = 0;
  const render = encoder.hold("smooth playback's render", "playback", () => asked++);
  encoder.hold("a proxy").release();
  expect(asked).toBe(0);
  const copy = encoder.hold("a share's review copy", "share");
  const export_ = encoder.hold("an export", "export");
  expect(asked).toBe(1);
  copy.release();
  export_.release();
  render.release();
});

test("a turn stopped while it waits throws, and one held up for good goes after the longest wait", async () => {
  const forever = encoder.register(() => "an export that never ends");
  const stop = new AbortController();
  const waited = encoder.turn("a proxy", "background", stop.signal);
  stop.abort(new Error("the import was cancelled"));
  await expect(waited).rejects.toThrow("the import was cancelled");
  encoder.hooks.longestWaitMs = 80;
  const began = Date.now();
  const lease = await encoder.turn("a proxy");
  expect(Date.now() - began).toBeGreaterThanOrEqual(80);
  lease.release();
  forever();
});

test("an export runs one fewer at once while a play is watched, never none", () => {
  expect(encoder.exportsAtOnce(3)).toBe(3);
  expect(encoder.exportsAtOnce(1)).toBe(1);
  playing.note("p1", true);
  expect(encoder.exportsAtOnce(3)).toBe(2);
  expect(encoder.exportsAtOnce(2)).toBe(1);
  expect(encoder.exportsAtOnce(1)).toBe(1);
  playing.note("p1", false);
  expect(encoder.exportsAtOnce(3)).toBe(3);
});
