// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";

import { useEditor } from "./store";
import { cutsAfter, liveFrame, mapFrame, onViewed, pinFor, useWatching, viewedFrame, type Pinned } from "./watching";
import type { Project } from "./types";

const project = (clips: { id: string; start: number; duration: number; source_in: number; track?: string }[]): Project =>
  ({ settings: { width: 1920, height: 1080, fps: 30 }, tracks: [{ id: "v1" }, { id: "v2" }], clips: clips.map((one) => ({ type: "video", media: `m-${one.id}`, speed: 1, track: one.track ?? "v1", ...one })) }) as unknown as Project;

describe("moving to the agent's new version", () => {
  test("the same moment of the same shot, wherever the edit moved it", () => {
    const before = project([{ id: "a", start: 0, duration: 300, source_in: 0 }, { id: "b", start: 300, duration: 300, source_in: 10 }]);
    // A 90-frame cut-in put in before b: b starts 90 frames later.
    const after = project([{ id: "a", start: 0, duration: 300, source_in: 0 }, { id: "x", start: 300, duration: 90, source_in: 0 }, { id: "b", start: 390, duration: 300, source_in: 10 }]);
    expect(mapFrame(before, after, 450)).toBe(540);
    expect(mapFrame(before, after, 100)).toBe(100);
  });

  test("a shot trimmed so the moment's gone, or gone itself: the same frame, inside the new edit", () => {
    const before = project([{ id: "a", start: 0, duration: 600, source_in: 0 }]);
    const after = project([{ id: "c", start: 0, duration: 200, source_in: 0 }]);
    expect(mapFrame(before, after, 500)).toBe(199);
    expect(mapFrame(before, after, 100)).toBe(100);
  });

  test("a pin counts only for the project it was made in", () => {
    const pin = { project: { ...project([]), id: "p1" }, rev: 3, playback: {} } as unknown as Pinned;
    expect(pinFor(pin, "p1")).toBe(pin);
    expect(pinFor(pin, "p2")).toBeNull();
    expect(pinFor(null, "p1")).toBeNull();
  });

  test("the cuts ahead, where a swap shows least", () => {
    const one = project([{ id: "a", start: 0, duration: 300, source_in: 0 }, { id: "b", start: 300, duration: 300, source_in: 0 }, { id: "c", start: 300, duration: 60, source_in: 0, track: "v2" }]);
    expect(cutsAfter(one, 120)).toEqual([300]);
  });
});

describe("what's marked while a version is pinned", () => {
  const before = { ...project([{ id: "a", start: 0, duration: 300, source_in: 0 }, { id: "b", start: 300, duration: 300, source_in: 10 }]), id: "p1" };
  // The agent put a 90-frame cut-in before b since the pin.
  const now = { ...project([{ id: "a", start: 0, duration: 300, source_in: 0 }, { id: "x", start: 300, duration: 90, source_in: 0 }, { id: "b", start: 390, duration: 300, source_in: 10 }]), id: "p1" };

  test("I, O, a note or a comment at the pinned playhead land on the edit as it is now", () => {
    useEditor.setState({ project: now });
    useWatching.setState({ pinned: { project: before, rev: 3, playback: {} } as unknown as Pinned });
    expect(liveFrame(450)).toBe(540);
    // And back: a comment's moment gone to on the pinned version.
    expect(viewedFrame(540)).toBe(450);
    // Nothing pinned: the playhead is the edit's own.
    useWatching.setState({ pinned: null });
    expect(liveFrame(450)).toBe(450);
    useEditor.setState({ project: null });
  });

  test("the edit's frames (an out point, a comment, the agent's place) shown on the pinned version", () => {
    expect(onViewed(now, before, 540)).toBe(450);
    expect(onViewed(now, now, 540)).toBe(540);
  });
});
