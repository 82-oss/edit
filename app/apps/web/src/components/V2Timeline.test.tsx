// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const player = vi.hoisted(() => ({ seeks: [] as number[] }));
vi.mock("../lib/playback", () => {
  const preview = { onStatus: () => () => {}, sections: null, speed: 1, seek: (frame: number) => player.seeks.push(frame), hint: () => {}, toggle: () => {}, pause: () => {} };
  const playhead = { frame: 0, playing: false, subscribe: () => () => {} };
  return { preview, playhead };
});

import { useEditor } from "../lib/store";
import { hooks as loaderHooks, timelineMedia } from "../lib/timelineMedia";
import { bigProject, media, projectOf, text, track, video } from "../lib/timelineFixture";
import { layoutOf } from "../lib/timelineRows";
import { drawLanes, placeRows, type Scene } from "../lib/timelineV2";
import { useView } from "../lib/timelineView";
import type { Project } from "../lib/types";
import { useWatching } from "../lib/watching";
import { V2Timeline } from "./V2Timeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A 2D context that draws nothing and notes the words it was asked to write. */
function fakeContext(written: string[]): CanvasRenderingContext2D {
  const target = {
    written,
    measureText: (words: string) => ({ width: words.length * 6 }),
    fillText: (words: string) => void written.push(words),
  };
  return new Proxy(target, {
    get: (own, key) => (key in own ? own[key as keyof typeof own] : () => {}),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
}

const written: string[] = [];
let root: Root | null = null;
const realLoader = { ...loaderHooks };
beforeEach(() => {
  written.length = 0;
  player.seeks.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext(written) as never);
  for (const [name, value] of [["clientWidth", 1200], ["clientHeight", 320]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
  HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 320, width: 1200, height: 320, x: 0, y: 0, toJSON: () => ({}) });
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() {
      this.callback([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // At once (and no frame left pending: the timeline asks again only once its last frame is drawn).
  globalThis.requestAnimationFrame = (step: FrameRequestCallback) => {
    step(0);
    return 0;
  };
  loaderHooks.fetch = vi.fn(async () => new Response("not here", { status: 404 }));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  Object.assign(loaderHooks, realLoader);
  useWatching.setState({ pinned: null });
  timelineMedia.clear();
});

const show = (project: Project, rev = 7) => {
  act(() => useEditor.setState({ project, rev }));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<V2Timeline />));
  return container;
};

function small(name: string, id = "p1"): Project {
  const tracks = [track("v1", "video"), track("subs", "video", true), track("a1", "audio")];
  return projectOf({
    id,
    tracks,
    media: [media("f1")],
    clips: [video("c1", "v1", 0, 900, "f1", { name }), text("c2", "subs", 0, 60, "Hello there", { opacity: 0 })],
  });
}

describe("the V2 timeline", () => {
  it("can't change the edit: a click, a drag, the wheel and V1's editing keys leave the project and its revision as they were, and only move the playhead", () => {
    const project = small("A shot");
    const container = show(project);
    const canvas = container.querySelector("canvas")!;
    const pointer = (type: string, x: number, y: number) =>
      act(() => void canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, pointerId: 1 })));
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    pointer("pointerdown", 300, 80);
    pointer("pointermove", 500, 80);
    pointer("pointerup", 500, 80);
    act(() => void canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120, ctrlKey: true })));
    act(() => void canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    for (const key of ["s", "Backspace", "Delete", "c", "v", "m", "t", "d", "=", "-", "\\"]) {
      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    }
    expect(useEditor.getState().project).toBe(project);
    expect(useEditor.getState().rev).toBe(7);
    expect(useEditor.getState().selection).toEqual([]);
    // The playhead went where it was clicked and dragged.
    expect(player.seeks.length).toBeGreaterThanOrEqual(2);
  });

  it("draws the version on screen while the agent works, not the edit as it is now", () => {
    const live = small("Live shot");
    const pinned = small("Pinned shot");
    act(() => useWatching.setState({ pinned: { project: pinned, rev: 3, playback: { state: "ready", rev: 3, url: "/x" } as never } }));
    show(live);
    expect(written).toContain("Pinned shot");
    expect(written).not.toContain("Live shot");
    // Once the turn's over and the pin's let go, the edit as it is.
    written.length = 0;
    act(() => useWatching.setState({ pinned: null }));
    expect(written).toContain("Live shot");
  });

  it("shows a subtitle's words even when its text is at opacity 0 (an effect draws them)", () => {
    show(small("A shot"));
    expect(written).toContain("Hello there");
  });
});

describe("drawing a 3,173-clip, 2-hour edit", () => {
  it("draws the whole edit and a close-up in a few milliseconds each (only what's in view)", () => {
    const project = bigProject();
    const layout = layoutOf(project);
    const rows = placeRows(layout);
    const end = layout.end;
    const width = 1400;
    const scene = (ppf: number, scrollX: number): Scene => ({ project, layout, rows, width, height: 360, ppf, scrollX, scrollY: 0, dpr: 2, stale: new Set(), media: timelineMedia });
    const ctx = fakeContext([]);
    const time = (ppf: number, scrollX: number) => {
      drawLanes(ctx, scene(ppf, scrollX));
      const started = performance.now();
      for (let at = 0; at < 5; at++) drawLanes(ctx, scene(ppf, scrollX));
      return (performance.now() - started) / 5;
    };
    const whole = time(width / end, 0);
    const close = time(2, end * 2 * 0.5);
    console.info(`3,173 clips: the whole 2 h edit drawn in ${whole.toFixed(1)} ms, a close-up in ${close.toFixed(1)} ms (no rasterising here)`);
    expect(whole).toBeLessThan(40);
    expect(close).toBeLessThan(15);
    useView.setState({ ppf: 4, scrollX: 0 });
  });
});
