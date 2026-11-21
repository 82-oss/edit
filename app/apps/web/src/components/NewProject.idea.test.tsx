// @vitest-environment happy-dom
// New script opened from an idea's "Write the script" (ideas/page.tsx startScript): the script is the idea's
// channel's. Nov 21 (docs/v1-to-v2.md, step 1): the dialog was handed only the title, footage and kind and started
// on no channel, so an idea made for a channel became a script with none unless the person picked it again.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const mocks = vi.hoisted(() => ({
  writerScripts: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  checkVideos: vi.fn(),
  importYoutube: vi.fn(),
  importDrive: vi.fn(),
  importCompilation: vi.fn(),
  createCommentary: vi.fn(),
  trelloCard: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { ...actual.api, writerScripts: (...args: unknown[]) => mocks.writerScripts(...args) } };
});

vi.mock("../writer/api", () => ({
  checkVideos: (...args: unknown[]) => mocks.checkVideos(...args),
  importYoutube: (...args: unknown[]) => mocks.importYoutube(...args),
  importDrive: (...args: unknown[]) => mocks.importDrive(...args),
  importCompilation: (...args: unknown[]) => mocks.importCompilation(...args),
  createCommentary: (...args: unknown[]) => mocks.createCommentary(...args),
  trelloCard: (...args: unknown[]) => mocks.trelloCard(...args),
}));

vi.mock("../lib/route", () => ({ navigate: (...args: unknown[]) => mocks.navigate(...args) }));

// Edit V2 on: every script is made for a channel.
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

const channel = (key: string, title: string) => ({
  key, title, youtubeId: `UC${key.padEnd(22, "x")}`, handle: key, description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0,
  narration: { kind: "voice", id: "v1", name: "Andrew" }, compilation: false, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, archived: false, addedBy: null, at: 0,
});
const CHANNELS = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../lib/channels", async () => ({
  ...(await vi.importActual<typeof import("../lib/channels")>("../lib/channels")),
  loadChannels: vi.fn(async () => {}),
  useChannels: (select: (state: { channels: unknown[]; groups: []; failed: null; teacher: boolean }) => unknown) => select({ channels: CHANNELS.list, groups: [], failed: null, teacher: false }),
}));

import { useEditor } from "../lib/store";
import { NewProject, type NewProjectStart } from "./Home";

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

/** The channels the picker shows as chosen. */
const chosen = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')).map((one) => one.textContent?.trim() ?? "");

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The dialog as an approved idea opens it, its footage read. */
async function fromIdea(start: NewProjectStart) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<NewProject work="script" open onClose={vi.fn()} start={start} />);
  });
  await flush();
  await act(async () => {
    vi.advanceTimersByTime(550);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  CHANNELS.list = [channel("ch-ted", "Inspector Ted"), channel("ch-snax", "Snax Dirt")];
  useEditor.setState({ toast: mocks.toast } as never);
  mocks.writerScripts.mockResolvedValue({ scripts: [] });
  mocks.checkVideos.mockResolvedValue([{ url: "https://youtu.be/abc123", title: "Suspect Chase", durationMs: 600_000, reuse: false, problem: null, warning: null }]);
  mocks.importYoutube.mockResolvedValue({ id: "yt-1" });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("New script from an idea", () => {
  it("starts on the idea's channel, and the script is made for it", async () => {
    await fromIdea({ title: "Suspect Chase", text: "https://youtu.be/abc123", style: "bodycam", channel: "ch-ted" });
    expect(chosen()).toEqual([expect.stringContaining("Inspector Ted")]);
    await act(async () => {
      findButton("Write the script").click();
    });
    await flush();
    expect(mocks.importYoutube).toHaveBeenCalledWith("https://youtu.be/abc123", undefined, "Suspect Chase", undefined, "", "ch-ted");
  });

  it("can still be changed to another channel", async () => {
    await fromIdea({ title: "Suspect Chase", text: "https://youtu.be/abc123", style: "bodycam", channel: "ch-ted" });
    await act(async () => {
      findButton(/Snax Dirt/).click();
    });
    expect(chosen()).toEqual([expect.stringContaining("Snax Dirt")]);
    await act(async () => {
      findButton("Write the script").click();
    });
    await flush();
    expect(mocks.importYoutube).toHaveBeenCalledWith("https://youtu.be/abc123", undefined, "Suspect Chase", undefined, "", "ch-snax");
  });

  it("an idea with no channel starts on none, as before", async () => {
    await fromIdea({ title: "Suspect Chase", text: "https://youtu.be/abc123", style: "bodycam" });
    expect(chosen()).toEqual([]);
  });
});

// Nov 21: commentary's home is the InternetJanitor channel. With Edit V2 on, a channel's script had to be its
// footage's ("a commentary is V1's alone"); now the channel picked offers Footage or Commentary.
describe("New script on a channel: a commentary", () => {
  it("is offered only once a channel is picked, and footage is what it starts as", async () => {
    await fromIdea({ title: "Why He's Hated", text: "", style: "bodycam" });
    expect(() => findButton("Commentary")).toThrow("Button not found");
    await act(async () => {
      findButton(/Inspector Ted/).click();
    });
    expect(findButton("Commentary")).toBeDefined();
    expect(document.querySelector("textarea")?.placeholder).toContain("Paste the footage");
  });

  it("is made on the channel picked, from its sources", async () => {
    mocks.createCommentary.mockResolvedValue({ id: "c-1" });
    await fromIdea({ title: "Why He's Hated", text: "https://example.com/the-brief", style: "bodycam", channel: "ch-ted" });
    await act(async () => {
      findButton("Commentary").click();
    });
    await flush();
    expect(document.querySelector("textarea")?.placeholder).toContain("The first is the brief");
    await act(async () => {
      findButton("Create").click();
    });
    await flush();
    expect(mocks.createCommentary).toHaveBeenCalledWith("Why He's Hated", ["https://example.com/the-brief"], "ch-ted");
    expect(mocks.importYoutube).not.toHaveBeenCalled();
  });
});
