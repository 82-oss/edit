// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hooks, RETRY_MS, snapTime, TimelineMedia } from "./timelineMedia";
import { media } from "./timelineFixture";

/** A body as the server packs it (timeline_media.ts `packFrames`): count, lengths, bytes. */
function packed(frames: (number[] | null)[]): ArrayBuffer {
  const total = frames.reduce((sum, frame) => sum + (frame?.length ?? 0), 0);
  const out = new Uint8Array(4 + frames.length * 4 + total);
  const view = new DataView(out.buffer);
  view.setUint32(0, frames.length, true);
  let at = 4 + frames.length * 4;
  frames.forEach((frame, index) => {
    view.setUint32(4 + index * 4, frame?.length ?? 0, true);
    if (frame !== null) {
      out.set(frame, at);
      at += frame.length;
    }
  });
  return out.buffer;
}

const real = { ...hooks };
let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
  hooks.now = () => clock;
  hooks.decode = async () => ({ width: 128, height: 72 }) as unknown as ImageBitmap;
});
afterEach(() => {
  Object.assign(hooks, real);
  vi.useRealTimers();
});

const settle = async () => {
  for (let at = 0; at < 10; at++) await Promise.resolve();
};

describe("the timelines' loader", () => {
  it("asks again by itself after a miss, and the picture appears without a reload", async () => {
    const answers = [new Response("busy", { status: 503 }), new Response(packed([[1, 2, 3]]))];
    const fetch = vi.fn(async (_url: string) => answers.shift()!);
    hooks.fetch = fetch;
    const loader = new TimelineMedia();
    const drew = vi.fn();
    loader.onChange(drew);
    const shot = media("m1");
    const pass = () => {
      loader.begin();
      const picture = loader.frame("p1", shot, 2.5, 72);
      loader.flush();
      return picture;
    };
    expect(pass()).toBeNull();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain("/api/projects/p1/media/m1/frames?t=2.500&h=72");
    // The miss isn't asked again at once (each draw would hammer the server)…
    expect(pass()).toBeNull();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    // …but once its pause is over the view is told to draw again, and that pass asks.
    clock += RETRY_MS[0]!;
    vi.advanceTimersByTime(RETRY_MS[0]!);
    expect(drew).toHaveBeenCalled();
    expect(pass()).toBeNull();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pass()).not.toBeNull();
  });

  it("a miss is asked again at once when the socket connects again, never remembered as missing", async () => {
    const answers = [new Response("gone", { status: 404 }), new Response(new Uint8Array([7, 7]))];
    const fetch = vi.fn(async () => answers.shift()!);
    hooks.fetch = fetch;
    const loader = new TimelineMedia();
    const sound = media("m2", { kind: "audio" });
    const pass = () => {
      loader.begin();
      const peaks = loader.peaks("p1", sound);
      loader.flush();
      return peaks;
    };
    pass();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("edit:connected"));
    pass();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect([...pass()!]).toEqual([7, 7]);
  });

  it("asks for a clip's frames in one request, and stops waiting for what's scrolled away", async () => {
    let aborted = 0;
    hooks.fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => {
      aborted++;
      reject(new Error("aborted"));
    })));
    const loader = new TimelineMedia();
    const shot = media("m3");
    loader.begin();
    for (const t of [1, 2, 3, 4]) loader.frame("p1", shot, t, 72);
    loader.flush();
    expect(hooks.fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(hooks.fetch).mock.calls[0]![0])).toContain("t=1.000,2.000,3.000,4.000");
    // Scrolled away: the next pass wants none of them.
    loader.begin();
    loader.flush();
    expect(aborted).toBe(1);
  });

  it("snaps a cell's moment to a grid of powers of two, so neighbouring zooms share frames", () => {
    expect(snapTime(10.3, 2.5)).toBe(10);
    expect(snapTime(10.3, 1.2)).toBe(10);
    expect(snapTime(10.6, 1.2)).toBe(11);
    // The grid at one zoom is part of the grid at the next zoom in.
    expect(snapTime(snapTime(37.9, 4.1), 2.05) % 2).toBe(0);
    // Never finer than 1/32 s.
    expect(snapTime(1.01, 0.001)).toBeCloseTo(1, 5);
  });
});
