// @vitest-environment happy-dom
// Writer's chat keeps what was typed when the message can't go (the server restarting or out of reach).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Script } from "../types";

// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const startBuild = vi.fn<(id: string, note: string) => Promise<{ startedAt: number }>>();

// Every read the page makes answers nothing; starting a build is what each case decides.
vi.mock("../api", async (original) => {
  const real = await original<typeof import("../api")>();
  const quiet = Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => new Promise(() => {}) : value]));
  return { ...quiet, message: real.message, previewSrc: real.previewSrc, onReviews: () => () => {}, startBuild: (id: string, note: string) => startBuild(id, note) };
});

const { Editor } = await import("../editor");

const script = {
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

let root: Root;

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Editor script={script} onChange={() => {}} onBack={() => {}} />));
  return container;
}

const box = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="textbox"]')!;

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

describe("Writer's chat", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    // Nothing else the page asks Edit's server answers.
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    startBuild.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("puts the words back in the box when the build couldn't start", async () => {
    startBuild.mockRejectedValue(new Error("fetch failed"));
    const container = mount();
    type(box(container), "aim for 30 minutes");
    await send(box(container));
    expect(startBuild).toHaveBeenCalledWith(script.id, "aim for 30 minutes");
    expect(box(container).textContent).toBe("aim for 30 minutes");
    expect(localStorage.getItem(`writer.chat-draft.${script.id}`)).toBe("aim for 30 minutes");
  });

  it("clears them once it starts", async () => {
    startBuild.mockResolvedValue({ startedAt: Date.now() });
    const container = mount();
    type(box(container), "aim for 30 minutes");
    await send(box(container));
    expect(startBuild).toHaveBeenCalledOnce();
    expect(box(container).textContent).toBe("");
    expect(localStorage.getItem(`writer.chat-draft.${script.id}`)).toBeNull();
  });
});
