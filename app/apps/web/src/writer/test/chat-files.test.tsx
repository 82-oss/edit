// @vitest-environment happy-dom
// Script mode's composer takes footage as Edit V2's does (Sphe, Nov 18: "you can't upload files. If there's a clip
// that I'm like, 'Okay, I just want to quickly add that'"): + (or a paste, or a drop) uploads it to the script, and
// the message carries it, so the server adds it to the footage before revising or building.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Script } from "../types";

// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const startBuild = vi.fn<(id: string, note: string, kind?: string, files?: string[]) => Promise<{ startedAt: number }>>();
const startRevision = vi.fn<(id: string, request: string, focus: unknown, files?: string[]) => Promise<{ startedAt: number }>>();
const uploaded: string[] = [];

// Every read the page makes answers nothing; an upload lands as the server answers one.
vi.mock("../api", async (original) => {
  const real = await original<typeof import("../api")>();
  const quiet = Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => new Promise(() => {}) : value]));
  return {
    ...quiet,
    message: real.message,
    previewSrc: real.previewSrc,
    onReviews: () => () => {},
    footageOnly: real.footageOnly,
    uploadsOf: real.uploadsOf,
    footageUploader: (id: string) => async (file: File, progress: (loaded: number) => void) => {
      uploaded.push(`${id}/${file.name}`);
      progress(file.size);
      return { upload: `up-${file.name}`, name: file.name };
    },
    startBuild: (...args: Parameters<typeof startBuild>) => startBuild(...args),
    startRevision: (...args: Parameters<typeof startRevision>) => startRevision(...args),
  };
});

const { Editor } = await import("../editor");

const base = {
  id: "11111111-2222-3333-4444-555555555555",
  title: "A case",
  sourceKind: "file",
  sourceUrl: "",
  originalPath: "",
  status: "ready",
  stage: "",
  progress: 1,
  error: null,
  durationMs: 1000,
  words: [{ id: "w1", startMs: 0, endMs: 500, text: "Hello" }],
  clips: [],
  overview: [],
  revision: 1,
  updatedAt: 1,
  createdAt: 1,
} as unknown as Script;
const built = { ...base, clips: [{ id: "c0", kind: "cut-in", startMs: 0, endMs: 0, narration: "It began." }, { id: "c1", startMs: 0, endMs: 500 }] } as unknown as Script;

let root: Root;

function mount(script: Script) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Editor script={script} onChange={() => {}} onBack={() => {}} />));
  return container;
}

const box = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="textbox"]')!;

async function attach(container: HTMLElement, file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 0));
  });
}

function type(field: HTMLElement, words: string) {
  act(() => {
    field.append(words);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function send(field: HTMLElement) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  Object.defineProperty(event, "keyCode", { value: 13 });
  await act(async () => {
    field.dispatchEvent(event);
    await new Promise((done) => setTimeout(done, 0));
  });
}

describe("Script mode's composer", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    startBuild.mockReset().mockResolvedValue({ startedAt: Date.now() });
    startRevision.mockReset().mockResolvedValue({ startedAt: Date.now() });
    uploaded.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("offers + for files, uploads a clip to the script, and the revision carries it", async () => {
    const container = mount(built);
    expect(container.querySelector('[aria-label="Attach files"]')).not.toBeNull();
    await attach(container, new File(["clip"], "bodycam.mp4", { type: "video/mp4" }));
    expect(uploaded).toEqual([`${built.id}/bodycam.mp4`]);
    type(box(container), "Add this after the intro");
    await send(box(container));
    expect(startRevision).toHaveBeenCalledOnce();
    expect(startRevision.mock.calls[0]![1]).toBe("Add this after the intro");
    expect(startRevision.mock.calls[0]![3]).toEqual(["up-bodycam.mp4"]);
    // Taken off the composer with the message.
    expect(container.querySelector('[aria-label="Attached files"]')).toBeNull();
  });

  it("takes a clip into a script not built yet with the build's note", async () => {
    const container = mount(base);
    await attach(container, new File(["call"], "911 call.m4a", { type: "audio/mp4" }));
    type(box(container), "aim for 30 minutes");
    await send(box(container));
    expect(startBuild).toHaveBeenCalledWith(base.id, "aim for 30 minutes", undefined, ["up-911 call.m4a"]);
  });

  it("refuses a picture: it isn't footage", async () => {
    const container = mount(built);
    await attach(container, new File(["png"], "still.png", { type: "image/png" }));
    expect(uploaded).toEqual([]);
  });

  it("sends a message with no file as before", async () => {
    const container = mount(built);
    type(box(container), "Tighten the intro");
    await send(box(container));
    expect(startRevision.mock.calls[0]).toHaveLength(3);
  });
});
