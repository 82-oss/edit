// @vitest-environment happy-dom
// Clips marked in the script and asked about in the chat (JJ, Nov 18: "we need to add a feature where we can mark clips
// inside of a script and say, 'Cut this down,' or 'Remove this'… It's pretty frustrating that you have to describe where
// you want a clip changed").
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Focus } from "@edit/types/writer";
import type { Script } from "../types";

// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const startRevision = vi.fn<(id: string, request: string, focus: Focus) => Promise<{ startedAt: number }>>();
const saveClips = vi.fn<(id: string, revision: number, clips: Script["clips"]) => Promise<Script>>();

// Every read the page makes answers nothing; a revision and a save are what each case looks at.
vi.mock("../api", async (original) => {
  const real = await original<typeof import("../api")>();
  const quiet = Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => new Promise(() => {}) : value]));
  return {
    ...quiet,
    message: real.message,
    previewSrc: real.previewSrc,
    onReviews: () => () => {},
    startRevision: (id: string, request: string, focus: Focus) => startRevision(id, request, focus),
    saveClips: (id: string, revision: number, clips: Script["clips"]) => saveClips(id, revision, clips),
  };
});

const { Editor } = await import("../editor");
const { ContextMenuHost } = await import("../../components/ContextMenu");

const said = ["Hi,", "I'm", "Detective", "Smith.", "Where", "were", "you?", "Home.", "All", "night."];
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
  durationMs: 10_000,
  words: said.map((text, index) => ({ id: `w${index}`, text, startMs: index * 1_000, endMs: index * 1_000 + 500 })),
  clips: [
    { id: "c1", startMs: 0, endMs: 3_900 },
    { id: "n1", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He said he was home." },
    { id: "c2", startMs: 3_850, endMs: 9_900 },
    { id: "n2", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He was not." },
  ],
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
  act(() =>
    root.render(
      <>
        <Editor script={script} onChange={() => {}} onBack={() => {}} />
        <ContextMenuHost />
      </>,
    ),
  );
  return container;
}

const box = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="textbox"][aria-label="Message the agent"]')!;
const timestamp = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-range="${id}"] button`)!;
const narration = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-cue="${id}"] .grow-read`)!;
const marked = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-selected]")].map((node) => node.dataset.range ?? node.dataset.cue);
const placeholder = (container: HTMLElement) => box(container).parentElement!.textContent;

function click(node: HTMLElement, keys: MouseEventInit = {}) {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...keys }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, ...keys }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...keys }));
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

function menu(node: HTMLElement, item: string) {
  act(() => {
    node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  const button = [...document.querySelectorAll<HTMLElement>("button")].find((one) => one.textContent?.trim() === item);
  if (!button) throw new Error(`No "${item}" in the menu: ${[...document.querySelectorAll('[role="menu"]')].map((one) => one.textContent).join(" | ")}`);
  act(() => button.click());
}

describe("Marked clips", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem("writer.view.footage", "script");
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    startRevision.mockReset();
    startRevision.mockResolvedValue({ startedAt: Date.now() });
    saveClips.mockReset();
    saveClips.mockImplementation(async (_id, revision, clips) => ({ ...script, clips, revision: revision + 1 }));
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("a click marks a clip, ⇧ or ⌘ marks more, and the message is about exactly those", async () => {
    const container = mount();
    click(timestamp(container, "c1"));
    expect(marked(container)).toEqual(["c1"]);
    expect(placeholder(container)).toContain("What should we do with this clip?");
    // A narration too, with ⌘, without starting to type in it.
    click(narration(container, "n2"), { metaKey: true });
    click(timestamp(container, "c2"), { shiftKey: true });
    expect(marked(container)).toEqual(["c1", "c2", "n2"]);
    expect(container.querySelector(`[data-cue="n2"] textarea`)).toBeNull();
    expect(placeholder(container)).toContain("What should we do with these 3 clips?");
    // ⌘ again lets one go.
    click(timestamp(container, "c2"), { metaKey: true });
    expect(marked(container)).toEqual(["c1", "n2"]);

    type(box(container), "cut this down");
    await send(box(container));
    expect(startRevision).toHaveBeenCalledOnce();
    const [, request, focus] = startRevision.mock.calls[0]!;
    // The chat shows what it was about as a chip; Claude gets the clips by id, marked as the message's subject.
    expect(request).toMatch(/^\[Quoted from the marked clips: “.+, Narration 2”\] cut this down$/u);
    expect(focus).toMatchObject({ selected: ["c1", "n2"], pointed: true });
    // Asked about: nothing is marked for the next one.
    expect(marked(container)).toEqual([]);
  });

  it("a message with nothing marked points at nothing", async () => {
    const container = mount();
    type(box(container), "tighten the intro");
    await send(box(container));
    const [, request, focus] = startRevision.mock.calls[0]!;
    expect(request).toBe("tighten the intro");
    expect(focus.selected).toEqual([]);
    expect(focus.pointed).toBeUndefined();
  });

  it("a click on the page away from the clips lets them go", () => {
    const container = mount();
    click(timestamp(container, "c1"));
    click(container.querySelector<HTMLElement>(".canvas")!);
    expect(marked(container)).toEqual([]);
  });

  it("a clip's menu asks Claude to cut it down at once", async () => {
    const container = mount();
    menu(container.querySelector<HTMLElement>('[data-range="c2"]')!, "Cut down");
    await act(async () => new Promise((done) => setTimeout(done, 0)));
    const [, request, focus] = startRevision.mock.calls[0]!;
    expect(request).toMatch(/\] Cut this down\.$/u);
    expect(focus).toMatchObject({ selected: ["c2"], pointed: true });
  });

  it("a clip's menu removes it here, as ⌫ does on the timeline, with no turn of Claude's", async () => {
    const container = mount();
    menu(container.querySelector<HTMLElement>('[data-cue="n1"]')!, "Remove");
    await act(async () => new Promise((done) => setTimeout(done, 0)));
    expect(saveClips).toHaveBeenCalledOnce();
    expect(saveClips.mock.calls[0]![2].map((clip) => clip.id)).toEqual(["c1", "c2", "n2"]);
    expect(startRevision).not.toHaveBeenCalled();
  });
});
