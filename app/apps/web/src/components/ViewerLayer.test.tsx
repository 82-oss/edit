// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const placed = vi.hoisted(() => [] as { width: number; visible: boolean }[]);
vi.mock("../lib/playback", () => ({ preview: { onStatus: () => () => {} }, playhead: { frame: 0, playing: false, subscribe: () => () => {} } }));
vi.mock("../lib/nativePreview", () => ({
  nativePreview: { place: async (rect: { width: number }, _radius: number, visible: boolean) => { placed.push({ width: rect.width, visible }); } },
  nativeAvailable: () => true,
}));

import { useWindowLayer } from "./Viewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Layer({ native, shown }: { native: boolean; shown: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  useWindowLayer(wrap, native, shown);
  return <div ref={wrap} />;
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  placed.length = 0;
  vi.useRealTimers();
});

describe("the window's layer under the viewer", () => {
  it("is moved, never taken down, when its first frame shows: a hidden placement rests the window's player and stopped a play pressed at once on a cold open (the MacBook Air, Nov 21)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Layer native shown={false} />));
    act(() => { vi.advanceTimersByTime(300); });
    const before = placed.length;
    expect(placed.every((one) => !one.visible)).toBe(true);
    // The first frame shows, a play under way: shown, with nothing hidden in between.
    act(() => root!.render(<Layer native shown />));
    act(() => { vi.advanceTimersByTime(100); });
    const after = placed.slice(before);
    expect(after.some((one) => one.visible)).toBe(true);
    expect(after.filter((one) => !one.visible)).toEqual([]);
    // Leaving the window's drawing still takes it down.
    act(() => root!.render(<Layer native={false} shown={false} />));
    expect(placed.at(-1)).toEqual({ width: 1, visible: false });
  });
});
