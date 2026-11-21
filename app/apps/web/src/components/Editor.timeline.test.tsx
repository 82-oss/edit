// @vitest-environment happy-dom
// The V2 timeline in the editor (Sphe, Nov 21: "if you never toggle it, you never see it and if you do toggle it you
// do see it until you un toggle"): off for a V2 project until it's turned on, nothing of it asked of the server
// meanwhile; on, it stays on across a reopening; V1 projects keep their timeline as it always was.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => ({ project: null as unknown }));
vi.mock("../lib/playback", () => {
  const preview = { onStatus: () => () => {}, sections: null, speed: 1, seek: () => {}, hint: () => {}, toggle: () => {}, pause: () => {}, play: () => {}, setSpeed: () => {} };
  const playhead = { frame: 0, playing: false, subscribe: () => () => {} };
  return { preview, playhead };
});
vi.mock("../lib/api", async (original) => {
  const real = await original<typeof import("../lib/api")>();
  return {
    ...real,
    api: {
      ...real.api,
      project: async () => ({ rev: 1, project: opened.project }),
      resetAsked: async () => ({ pending: null }),
      mediaStatus: async () => ({ media: {} }),
    },
  };
});
vi.mock("../lib/cloud", async (original) => ({ ...(await original<typeof import("../lib/cloud")>()), cloudApi: { open: async () => null, close: async () => {} } }));
vi.mock("../lib/store", async (original) => ({ ...(await original<typeof import("../lib/store")>()), connectEvents: () => {}, settled: async () => {}, leave: async () => {}, syncScriptJob: async () => {} }));
vi.mock("../lib/notes", async (original) => ({ ...(await original<typeof import("../lib/notes")>()), followNotes: () => {} }));
vi.mock("../lib/effects", async (original) => ({ ...(await original<typeof import("../lib/effects")>()), loadEffects: async () => {} }));
vi.mock("./Viewer", () => ({ Viewer: () => <div data-viewer />, toggleFullscreen: () => {} }));
vi.mock("./TopBar", () => ({ TopBar: () => null }));
vi.mock("./AgentPanel", () => ({ AgentPanel: () => null }));
vi.mock("./ChatDock", () => ({ ChatDock: () => null }));
vi.mock("./CloudBanner", () => ({ CloudBanner: () => null }));
vi.mock("./MissingBanner", () => ({ ImportProblems: () => null }));
vi.mock("./FootageBack", () => ({ FootageBack: () => null }));
vi.mock("./FileBrowser", () => ({ FileBrowser: () => null }));
vi.mock("./ShareDialog", () => ({ ShareDialog: () => null }));
vi.mock("./FootageReady", () => ({ useFootage: () => ({ phase: "ready", card: null, answer: null, openNow: () => {} }), FootageDialog: () => null }));
vi.mock("./Timeline", () => ({ Timeline: () => <div data-v1-timeline />, ZoomBar: () => null }));

import { useEditor } from "../lib/store";
import { hooks as loaderHooks, timelineMedia } from "../lib/timelineMedia";
import { audio, media, projectOf, text, track, video } from "../lib/timelineFixture";
import { toggleTimeline, useTimelineShown } from "../lib/timelineShown";
import type { Project } from "../lib/types";
import { Editor } from "./Editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noContext = new Proxy({ measureText: (words: string) => ({ width: words.length * 6 }) }, { get: (own, key) => (key in own ? own[key as keyof typeof own] : () => {}), set: () => true });

let root: Root | null = null;
const realLoader = { ...loaderHooks };
const fetched: string[] = [];
beforeEach(() => {
  localStorage.clear();
  useTimelineShown.setState({ open: false });
  fetched.length = 0;
  loaderHooks.fetch = async (url: string) => {
    fetched.push(url);
    return new Response("not here", { status: 404 });
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => noContext as never);
  for (const [name, value] of [["clientWidth", 1000], ["clientHeight", 300]] as const) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() {
      this.callback([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (step: FrameRequestCallback) => {
    step(0);
    return 0;
  };
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  Object.assign(loaderHooks, realLoader);
  timelineMedia.clear();
});

function edit(hq: boolean): Project {
  return {
    ...projectOf({
      tracks: [track("v1", "video"), track("subs", "video", true), track("a1", "audio")],
      media: [media("f1")],
      clips: [video("c1", "v1", 0, 900, "f1"), audio("c2", "a1", 0, 900, "f1"), text("c3", "subs", 0, 60, "Hello")],
    }),
    hq,
  } as Project;
}

async function open(project: Project) {
  opened.project = project;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Editor id={project.id} />));
  // The project's ask, then its load.
  await act(async () => {
    for (let at = 0; at < 20; at++) await Promise.resolve();
  });
  return container;
}

async function reopen(project: Project) {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  return open(project);
}

const key = (key: string) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

describe("the V2 timeline in the editor", () => {
  it("is off until it's turned on: a V2 project opens as before, asking the server for no pictures or waveforms", async () => {
    const container = await open(edit(true));
    expect(container.querySelector("[data-viewer]")).not.toBeNull();
    expect(container.querySelector("[data-v2-timeline]")).toBeNull();
    expect(container.querySelector("[data-v1-timeline]")).toBeNull();
    expect(fetched.filter((url) => url.includes("/frames") || url.includes("/peaks"))).toEqual([]);
  });

  it("turned on (the player's button, or T) it shows and asks for its pictures; it stays on after a reopening; turned off it's gone", async () => {
    let container = await open(edit(true));
    act(() => toggleTimeline());
    expect(container.querySelector("[data-v2-timeline]")).not.toBeNull();
    expect(fetched.some((url) => url.includes("/media/f1/frames?"))).toBe(true);
    expect(fetched.some((url) => url.includes("/media/f1/peaks"))).toBe(true);
    // Remembered: reopened, and read again from this computer's storage.
    expect(localStorage.getItem("edit.v2.timeline")).toBe("open");
    container = await reopen(edit(true));
    expect(container.querySelector("[data-v2-timeline]")).not.toBeNull();
    vi.resetModules();
    expect((await import("../lib/timelineShown")).useTimelineShown.getState().open).toBe(true);
    // T, the button's key, turns it off again, and that's remembered too.
    key("t");
    expect(container.querySelector("[data-v2-timeline]")).toBeNull();
    expect(localStorage.getItem("edit.v2.timeline")).toBeNull();
    container = await reopen(edit(true));
    expect(container.querySelector("[data-v2-timeline]")).toBeNull();
  });

  it("V1's editing keys still do nothing in a V2 project with its timeline open", async () => {
    await open(edit(true));
    act(() => toggleTimeline());
    const before = useEditor.getState().project;
    for (const one of ["s", "Backspace", "Delete", "c", "v", "m", "n", "g"]) key(one);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, bubbles: true })));
    expect(useEditor.getState().project).toBe(before);
    expect(useEditor.getState().rev).toBe(1);
  });

  it("leaves V1 projects as they were: their timeline is always there, whatever the V2 choice", async () => {
    let container = await open(edit(false));
    expect(container.querySelector("[data-v1-timeline]")).not.toBeNull();
    expect(container.querySelector("[data-v2-timeline]")).toBeNull();
    act(() => toggleTimeline());
    container = await reopen(edit(false));
    expect(container.querySelector("[data-v1-timeline]")).not.toBeNull();
    expect(container.querySelector("[data-v2-timeline]")).toBeNull();
  });
});
