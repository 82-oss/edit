// @vitest-environment happy-dom
// New edit on a channel: what it offers comes from the channel's add-ons (Sphe, Nov 21: "when you create a project
// in this channel because of the add-on it literally changes the ui and allows you two paths, short form or long
// form"). Long form and Short form show only where the channel's `short-form` says "both" (the server's
// channels.ts `withMade` gives the row its `forms`); a channel making Shorts alone, or nothing set, shows nothing. The
// page sends the form picked and never a frame: the server sets it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const mocks = vi.hoisted(() => ({
  writerScripts: vi.fn(),
  createProject: vi.fn(),
  importWriter: vi.fn(),
  firstPrompt: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      writerScripts: (...args: unknown[]) => mocks.writerScripts(...args),
      createProject: (...args: unknown[]) => mocks.createProject(...args),
      importWriter: (...args: unknown[]) => mocks.importWriter(...args),
      firstPrompt: (...args: unknown[]) => mocks.firstPrompt(...args),
    },
  };
});

vi.mock("../lib/route", () => ({ navigate: (...args: unknown[]) => mocks.navigate(...args) }));

// Edit V2 on: every edit is made for a channel.
vi.mock("../lib/beta", () => ({
  loadBeta: vi.fn(async () => {}),
  useBeta: (select: (state: { v2: boolean }) => unknown) => select({ v2: true }),
}));

vi.mock("../lib/account", () => ({
  useAccount: (select: (state: { account: null }) => unknown) => select({ account: null }),
  editStyles: () => null,
  makesVideos: () => true,
  writesScripts: () => true,
}));

vi.mock("../writer/can", () => ({
  CAN: { commentary: "writer.commentary" },
  useGrants: () => ({ singleKinds: ["foia", "interrogation", "courtroom"], compilationKinds: ["foia", "interrogation", "courtroom"], has: () => true }),
}));

const channel = (key: string, title: string, forms?: ("long" | "short")[]) => ({
  key, title, youtubeId: `UC${key.padEnd(22, "x")}`, handle: key, description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0,
  narration: { kind: "voice", id: "v1", name: "Andrew" }, compilation: false, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, archived: false, addedBy: null, at: 0,
  ...(forms === undefined ? {} : { forms }),
});
const CHANNELS = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../lib/channels", async () => ({
  ...(await vi.importActual<typeof import("../lib/channels")>("../lib/channels")),
  loadChannels: vi.fn(async () => {}),
  useChannels: (select: (state: { channels: unknown[]; groups: []; failed: null; teacher: false }) => unknown) => select({ channels: CHANNELS.list, groups: [], failed: null, teacher: false }),
}));

import { useEditor } from "../lib/store";
import { NewProject } from "./Home";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function findButton(label: string | RegExp): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const found = buttons.find((button) => {
    const text = (button.textContent ?? "").trim();
    return typeof label === "string" ? text === label : label.test(text);
  });
  if (!found) throw new Error(`Button not found: ${String(label)}. Have: ${buttons.map((b) => JSON.stringify(b.textContent?.trim())).join(", ")}`);
  return found;
}
const has = (label: string) => Array.from(document.querySelectorAll("button")).some((button) => (button.textContent ?? "").trim() === label);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** New edit opened on `key`, titled. */
async function newEdit(key: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<NewProject work="edit" open onClose={vi.fn()} start={{ title: "Suspect Chase", text: "", style: "bodycam", channel: key }} />);
  });
  await flush();
}

const create = async () => {
  await act(async () => {
    findButton("Create").click();
  });
  await flush();
};

beforeEach(() => {
  vi.clearAllMocks();
  CHANNELS.list = [channel("ch-ted", "Inspector Ted"), channel("ch-shorts", "Shorts Placeholder", ["short"]), channel("ch-both", "Snax Dirt", ["long", "short"])];
  useEditor.setState({ toast: mocks.toast } as never);
  mocks.writerScripts.mockResolvedValue({ scripts: [] });
  mocks.createProject.mockResolvedValue({ rev: 1, project: { id: "p-new" } });
  mocks.importWriter.mockResolvedValue({ project: "p-from-script" });
  mocks.firstPrompt.mockResolvedValue({});
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

describe("New edit on a channel: long form or short form", () => {
  it("a channel with nothing set shows no choice, and sends no frame and no form", async () => {
    await newEdit("ch-ted");
    expect([has("Long form"), has("Short form")]).toEqual([false, false]);
    await create();
    expect(mocks.createProject).toHaveBeenCalledWith({ name: "Suspect Chase", style: "bodycam", channel: "ch-ted" });
  });

  it("a channel making Shorts alone shows no choice either: the server makes the Short", async () => {
    await newEdit("ch-shorts");
    expect([has("Long form"), has("Short form")]).toEqual([false, false]);
    await create();
    expect(mocks.createProject).toHaveBeenCalledWith({ name: "Suspect Chase", style: "bodycam", channel: "ch-shorts" });
  });

  it('a channel set to "both" shows the two, long form first, and sends the one picked', async () => {
    await newEdit("ch-both");
    expect(findButton("Long form").className).toContain("bg-raised");
    expect(findButton("Short form").className).not.toContain("bg-raised");
    await create();
    expect(mocks.createProject).toHaveBeenLastCalledWith({ name: "Suspect Chase", style: "bodycam", channel: "ch-both", form: "long" });
    act(() => root?.unmount());
    document.body.innerHTML = "";
    await newEdit("ch-both");
    await act(async () => {
      findButton("Short form").click();
    });
    expect(findButton("Short form").className).toContain("bg-raised");
    await create();
    expect(mocks.createProject).toHaveBeenLastCalledWith({ name: "Suspect Chase", style: "bodycam", channel: "ch-both", form: "short" });
  });

  it("goes when another channel is picked, and the choice starts over at long form", async () => {
    await newEdit("ch-both");
    await act(async () => {
      findButton("Short form").click();
    });
    await act(async () => {
      findButton(/Inspector Ted/).click();
    });
    expect(has("Short form")).toBe(false);
    await act(async () => {
      findButton(/Snax Dirt/).click();
    });
    expect(findButton("Long form").className).toContain("bg-raised");
  });

  it("an edit from a script on that channel sends the form too", async () => {
    mocks.writerScripts.mockResolvedValue({ scripts: [{ id: "s-1", title: "The Chase", built: true, channel: "ch-both", project: null, style: null, compilation: false, durationMs: 60_000, updatedAt: 1, createdBy: null, handoff: null }] });
    await newEdit("ch-both");
    await flush();
    await act(async () => {
      findButton(/The Chase/).click();
    });
    await act(async () => {
      findButton("Short form").click();
    });
    await act(async () => {
      findButton("Start the edit").click();
    });
    await flush();
    expect(mocks.importWriter).toHaveBeenCalledWith("s-1", { channel: "ch-both", form: "short" });
  });
});
