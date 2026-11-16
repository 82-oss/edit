import { describe, expect, it, vi } from "vitest";
import { leadOf, SmoothStream, soundAt, soundSync } from "./smoothStream";

vi.mock("./api", () => ({ mediaHost: (path: string) => `http://edit${path}`, request: vi.fn(() => new Promise(() => {})) }));

describe("the render's sound kept with its picture", () => {
  it("drifts back at a slightly off rate instead of seeking, and only seeks when far out", () => {
    // In step: played as it is.
    expect(soundSync(0)).toEqual({ seek: false, rate: 1 });
    expect(soundSync(0.03)).toEqual({ seek: false, rate: 1 });
    // A little behind the picture: hurried, not moved (a move is a bump).
    expect(soundSync(-0.2)).toEqual({ seek: false, rate: 1.06 });
    // A little ahead: held back.
    expect(soundSync(0.2)).toEqual({ seek: false, rate: 0.94 });
    // Far out either way (a seek, a chunk landing late): moved, at its own rate.
    expect(soundSync(-2)).toEqual({ seek: true, rate: 1 });
    expect(soundSync(2)).toEqual({ seek: true, rate: 1 });
  });
});

// Nov 10: the smooth render showed every picture two frames late (the cut at frame 90 at 92) and never its last frames.
describe("where a chunk's pictures land", () => {
  it("is measured from the first append, so each chunk goes in that much early", () => {
    // A Mac's encoder reorders two frames: a chunk appended at 3 s holds pictures from 3.0667 s.
    expect(leadOf([[3 + 2 / 30, 5 + 2 / 30]], 3)).toBeCloseTo(2 / 30, 6);
    expect(leadOf([[2 / 30, 9 + 2 / 30]], 0)).toBeCloseTo(2 / 30, 6);
    // An encoder that doesn't reorder: nothing to make up.
    expect(leadOf([[3, 5]], 3)).toBe(0);
    // Nothing landed near it (or nothing at all): no guess.
    expect(leadOf([], 3)).toBe(0);
    expect(leadOf([[40, 42]], 3)).toBe(0);
  });
});

describe("the render's sound ready to start with its picture (Nov 13: after a jump, the words there came late or never)", () => {
  const ranges = (...spans: [number, number][]) => ({ length: spans.length, start: (i: number) => spans[i]![0], end: (i: number) => spans[i]![1] }) as unknown as TimeRanges;
  const sound = (over: Partial<{ seeking: boolean; readyState: number; currentTime: number; buffered: TimeRanges; duration: number }>) =>
    ({ seeking: false, readyState: 4, currentTime: 600, buffered: ranges([598, 620]), duration: 1800, ...over });
  it("is moved to the playhead's place when it's elsewhere, and waited for while it gets there", () => {
    expect(soundAt(sound({ currentTime: 12 }), 600)).toBe("move");
    expect(soundAt(sound({ seeking: true }), 600)).toBe("wait");
    expect(soundAt(sound({ readyState: 1 }), 600)).toBe("wait");
  });
  it("starts only with half a second of it in from there", () => {
    expect(soundAt(sound({ buffered: ranges([0, 40]) }), 600)).toBe("wait");
    expect(soundAt(sound({ buffered: ranges([0, 40], [600, 600.2]) }), 600)).toBe("wait");
    expect(soundAt(sound({}), 600)).toBe("ready");
    // One that couldn't load, or ends before the picture does, holds nothing up.
    expect(soundAt({ ...sound({ readyState: 0 }), error: { code: 4 } as MediaError }, 600)).toBe("ready");
    expect(soundAt(sound({ currentTime: 0, duration: 1800 }), 1799.99)).toBe("ready");
    // Its very end: what's left of it is enough.
    expect(soundAt(sound({ currentTime: 1799.8, buffered: ranges([1790, 1800]) }), 1799.8)).toBe("ready");
  });
});

describe("the render's chunks kept on disk", () => {
  it("says a look at what's kept changed something only when it found chunks not known kept (each look said so, and the resting playhead looked again at once, for good)", async () => {
    vi.stubGlobal("MediaSource", class { addEventListener() {} });
    const created = URL.createObjectURL;
    URL.createObjectURL = () => "blob:render";
    const kept = ["http://edit/api/projects/p1/playback/segment/a"];
    vi.stubGlobal("caches", { open: async () => ({ keys: async () => kept.map((url) => ({ url })) }) });
    try {
      let said = 0;
      const stream = new SmoothStream("p1", 1, 30, 90, () => 0, {} as HTMLAudioElement, () => { said++; });
      const stock = () => (stream as unknown as { stock: () => Promise<void> }).stock();
      await stock();
      expect(said).toBe(1);
      expect(stream.loaded()).toEqual([]);
      await stock();
      expect(said).toBe(1);
      kept.push("http://edit/api/projects/p1/playback/segment/b");
      await stock();
      expect(said).toBe(2);
    } finally {
      URL.createObjectURL = created;
      vi.unstubAllGlobals();
    }
  });
});
