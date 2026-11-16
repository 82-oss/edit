// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The player as the bar reads it: where it is, and what's here to play on (playback.ts `bufferedFrames`).
const player = vi.hoisted(() => ({ ready: [] as [number, number][] }));
vi.mock("../lib/playback", () => {
  const listeners = new Set<() => void>();
  const preview = { onStatus: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, range: null, sections: null, stopped: null, speed: 1,
    bufferedFrames: () => player.ready, seek: vi.fn(), toggle: vi.fn() };
  const playhead = { frame: 0, playing: false, subscribe: () => () => {} };
  return { preview, playhead };
});
vi.mock("../lib/nativePreview", () => ({ nativePreview: {}, nativeAvailable: () => false }));

import { ScrubBar } from "./Viewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const show = (element: React.ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
};

describe("the V2 player's progress bar", () => {
  it("always shows the playhead as a dot of its own size, however long the edit (Sphe, Nov 16: at 0:07 of 96 minutes nothing showed)", () => {
    const fps = 30;
    const long = 96 * 60 * fps;
    show(<ScrubBar frame={7 * fps} duration={long} thin />);
    const dot = document.querySelector<HTMLElement>("[data-playhead]")!;
    expect(dot).not.toBeNull();
    // Shown at rest, not only when hovered.
    expect(dot.className).not.toMatch(/opacity-0/);
    expect(dot.className).toContain("size-[10px]");
    expect(parseFloat(dot.style.left)).toBeCloseTo(((7 * fps) / long) * 100, 5);
    // The same dot on a short edit.
    act(() => root!.render(<ScrubBar frame={7 * fps} duration={60 * fps} thin />));
    expect(document.querySelector<HTMLElement>("[data-playhead]")!.className).toBe(dot.className);
  });

  it("shows what's here to play on in a quiet grey, from the player's ready stretches", () => {
    vi.useFakeTimers();
    try {
      player.ready = [];
      show(<ScrubBar frame={0} duration={1000} thin />);
      expect(document.querySelectorAll("[data-ready]")).toHaveLength(0);
      player.ready = [[0, 250], [500, 600]];
      act(() => { vi.advanceTimersByTime(600); });
      const grey = [...document.querySelectorAll<HTMLElement>("[data-ready]")];
      expect(grey.map((one) => [Math.round(parseFloat(one.style.left)), Math.round(parseFloat(one.style.width))])).toEqual([[0, 25], [50, 10]]);
      expect(grey[0]!.className).toContain("bg-white/30");
    } finally {
      vi.useRealTimers();
      player.ready = [];
    }
  });
});
