// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type Review } from "../lib/api";
import { useEditor } from "../lib/store";
import type { Project } from "../lib/types";
import { ShareDialog } from "./ShareDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); });
const project = (channel?: string): Project =>
  ({ version: 1, id: "p1", name: "Case", style: "bodycam", next_id: 1, settings: { width: 1920, height: 1080, fps: 30 }, clips: [], media: [], tracks: [], ...(channel === undefined ? {} : { channel }) }) as Project;
const PICTURES = [
  { id: "pic-ted", code: "InspectorTed", name: "Inspector Ted" },
  { id: "pic-si", code: "SI", name: "Sam's Interrogations" },
];

/** The dialog open on `given`, the server offering `offer`; its watermark row, if any. */
async function open(given: Project, offer: Awaited<ReturnType<typeof api.watermarks>>, watermark: string | null = null) {
  useEditor.setState({ project: given, exportState: null });
  const offered = vi.spyOn(api, "watermarks").mockResolvedValue(offer);
  vi.spyOn(api, "review").mockResolvedValue({ sharing: null, share: null, watermark, review: null, next: null, notes: [] } as unknown as Review);
  vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me" } as never);
  vi.spyOn(api, "rangesExport").mockResolvedValue(null);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<ShareDialog open onClose={() => {}} />));
  await settle();
  expect(offered).toHaveBeenCalledWith("p1");
  const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  return { box, row: box?.closest("div") ?? null };
}

describe("ShareDialog's watermark (Sphe, Nov 16: only when the channel has one)", () => {
  it("a channel with a watermark: one checkbox for its logo, by its name, and no channel to pick", async () => {
    const { box, row } = await open(project("ch-6efba6498c"), { channel: { key: "ch-6efba6498c", name: "Sam's Interrogations" }, channels: [PICTURES[1]!] });
    expect(box).not.toBeNull();
    expect(box!.disabled).toBe(false);
    expect(row!.textContent).toContain("Sam's Interrogations’ logo at 10%");
    expect(row!.querySelector("button")).toBeNull();
  });

  it("a channel without one: no watermark option at all, whatever was kept before", async () => {
    const { box } = await open(project("ch-bcbfe704b8"), { channel: { key: "ch-bcbfe704b8", name: "GTA 6 Channel" }, channels: [] }, "pic-si");
    expect(box).toBeNull();
    expect(document.body.textContent).not.toContain("Watermark");
  });

  it("a project of no channel (V1) keeps the checkbox and the folder's pictures to pick from, starting on the usual one", async () => {
    const { box, row } = await open(project(), { channel: null, channels: PICTURES, usual: "pic-si" });
    expect(box).not.toBeNull();
    expect(row!.textContent).toContain("The channel’s logo at 10%");
    // The picker, on the one picked most here.
    expect(row!.querySelector("button")?.textContent).toContain("Sam's Interrogations");
  });
});

describe("ShareDialog's steps while it runs (Sphe, Nov 17: design B)", () => {
  const STEPS = {
    where: "here" as const,
    queued: false,
    elapsed_s: 60,
    left_s: 240,
    progress: 0.2,
    steps: [
      { kind: "graphic" as const, state: "done" as const, label: "0:12", progress: null, left_s: 0 },
      { kind: "graphic" as const, state: "done" as const, label: "5:40", progress: null, left_s: 0 },
      { kind: "graphic" as const, state: "current" as const, label: "41:12", what: "map" as const, progress: 0.92, left_s: 4 },
      { kind: "graphic" as const, state: "waiting" as const, label: "50:02", progress: null, left_s: 15 },
      { kind: "graphic" as const, state: "waiting" as const, label: "1:02:10", progress: null, left_s: 25 },
      { kind: "video" as const, state: "waiting" as const, label: "1:48:29", progress: null, left_s: 180 },
      { kind: "save" as const, state: "waiting" as const, label: "~/Downloads/Edit", progress: null, left_s: 0 },
    ],
  };
  const buttons = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim());

  it("waiting on graphics: the steps under the options, the time left, Cancel export and Close, no Export", async () => {
    vi.spyOn(api, "exportActivity").mockResolvedValue([{ id: "p1", name: "Case", path: "/x.mp4", state: "running", progress: 0, updated_ms: 1, waiting: "rendering the cutfx-21 effect", steps: STEPS }]);
    await open(project(), { channel: null, channels: PICTURES });
    act(() => useEditor.setState({ exportState: { state: "queued", progress: 0, path: "/x.mp4", waiting: "rendering the cutfx-21 effect · 405 of 439 frames" } as never }));
    await settle();
    const rows = [...document.querySelectorAll('ol[aria-label="Export steps"] > li')].map((row) => row.textContent);
    expect(rows).toEqual(["Graphics 1–2done", "Graphic 3 of 5 · the map at 41:1292%", "Graphics 4–5~40 s", "Video · 1:48:29~3 min", "Save to ~/Downloads/Edita moment"]);
    expect(document.querySelector('[data-state="current"]')).not.toBeNull();
    expect(document.body.textContent).toContain("About 4 min left");
    expect(document.body.textContent).not.toContain("cutfx");
    expect(buttons()).toContain("Cancel export");
    expect(buttons()).toContain("Close");
    expect(buttons()).not.toContain("Export");
  });

  it("exporting the video, then done: the steps go, the file is said, and Export is back", async () => {
    const video = { ...STEPS, left_s: 100, steps: [{ ...STEPS.steps[0]!, label: "0:12" }, { kind: "video" as const, state: "current" as const, label: "1:48:29", progress: 0.4, left_s: 100 }, STEPS.steps[6]!] };
    const rows = vi.spyOn(api, "exportActivity").mockResolvedValue([{ id: "p1", name: "Case", path: "/home/me/Downloads/Edit/Case.mp4", state: "running", progress: 0.4, updated_ms: 1, steps: video }]);
    await open(project(), { channel: null, channels: PICTURES });
    act(() => useEditor.setState({ exportState: { state: "running", progress: 0.4, path: "/home/me/Downloads/Edit/Case.mp4" } as never }));
    await settle();
    expect(document.body.textContent).toContain("Video · 1:48:2940%");
    expect(document.body.textContent).toContain("About 2 min left");
    rows.mockResolvedValue([]);
    act(() => useEditor.setState({ exportState: { state: "done", progress: 1, path: "/home/me/Downloads/Edit/Case.mp4" } as never }));
    await settle();
    expect(document.querySelector('ol[aria-label="Export steps"]')).toBeNull();
    expect(buttons()).toContain("Export");
  });
});

describe("ShareDialog's marked parts (Sphe, Nov 17: three cards, each a picture of what comes out)", () => {
  const FPS = 30;
  const EDIT = 6509; // 1:48:29
  // 31 + 44 + 52 + 25 + 40 + 30 + 30 = 252 s, 4:12.
  const LENGTHS = [31, 44, 52, 25, 40, 30, 30];
  const marked = (lengths: number[]): Project => {
    let at = 60;
    const ranges = lengths.map((length, index) => {
      const range = { start: at * FPS, end: (at + length) * FPS, name: `Part ${index + 1}` };
      at += length + 600;
      return range;
    });
    return { ...project(), clips: [{ id: "c1", track: "v1", start: 0, duration: EDIT * FPS }], ranges } as unknown as Project;
  };
  const cards = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="What it exports"] [role="radio"]')];
  const said = () => cards().map((card) => card.textContent);
  const checked = () => cards().map((card) => card.getAttribute("aria-checked"));
  const press = (card: number, key: string) => {
    act(() => {
      cards()[card]!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };

  it("seven parts: the whole edit, each on its own, the parts as one, with their counts and lengths, and never “stretch”", async () => {
    await open(marked(LENGTHS), { channel: null, channels: PICTURES });
    expect(said()).toEqual(["The whole edit1 video · 1:48:29", "Each part on its own7 videos · one per marked part", "The parts as one1 video · 7 parts back to back · 4:12"]);
    expect(checked()).toEqual(["true", "false", "false"]);
    // The pictures: one bar, seven blocks apart, seven blocks butted.
    expect(cards().map((card) => card.querySelectorAll("i").length)).toEqual([1, 7, 7]);
    expect(document.body.textContent?.toLowerCase()).not.toContain("stretch");
  });

  it("picked by a click or the arrow keys, and the pick is what Export sends", async () => {
    await open(marked(LENGTHS), { channel: null, channels: PICTURES });
    act(() => cards()[1]!.click());
    expect(checked()).toEqual(["false", "true", "false"]);
    expect(cards().map((card) => card.tabIndex)).toEqual([-1, 0, -1]);
    press(1, "ArrowRight");
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(document.activeElement).toBe(cards()[2]);
    press(2, "ArrowRight");
    expect(checked()).toEqual(["true", "false", "false"]);
    press(0, "ArrowLeft");
    expect(checked()).toEqual(["false", "false", "true"]);

    vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: true } as never);
    const sent = vi.spyOn(api, "exportRanges").mockResolvedValue({ mode: "joined", total: 1, done: 0, current: null, finished: false, outputs: [] } as never);
    const exportButton = [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Export")!;
    act(() => exportButton.click());
    await settle();
    expect(sent).toHaveBeenCalledWith("p1", "joined", expect.anything(), null);
  });

  it("one part: the whole edit and the marked part, a video of its length, nothing to join", async () => {
    localStorage.setItem("edit.export.what", "joined");
    await open(marked([95]), { channel: null, channels: PICTURES });
    expect(said()).toEqual(["The whole edit1 video · 1:48:29", "The marked part1 video · 1:35"]);
    // Joined was kept from before: with one part it's that part's video.
    expect(checked()).toEqual(["false", "true"]);
    expect(document.body.textContent?.toLowerCase()).not.toContain("stretch");
  });

  it("sending for feedback: no cards, the link is the whole edit's", async () => {
    localStorage.setItem("edit.export.where", "feedback");
    await open(marked(LENGTHS), { channel: null, channels: PICTURES });
    expect(cards()).toEqual([]);
  });
});

describe("ShareDialog once an export has ended (Astra, Nov 18: one obvious next action)", () => {
  const labels = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim());
  const primary = () => [...document.querySelectorAll("button")].filter((one) => ["Retry", "Export", "Export again"].includes(one.textContent?.trim() ?? "")).map((one) => one.textContent?.trim());

  it("a failed export: Retry alone, and it retries; picking another destination makes it Export", async () => {
    await open(project(), { channel: null, channels: [] });
    act(() => useEditor.setState({ exportState: { state: "failed", progress: 0, path: "/x.mp4", error: "disk full" } as never }));
    await settle();
    expect(primary()).toEqual(["Retry"]);
    const retried = vi.spyOn(api, "retryExport").mockResolvedValue({ started: true });
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Retry")!.click());
    await settle();
    expect(retried).toHaveBeenCalledWith("p1");

    act(() => document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]')!.click());
    expect(primary()).toEqual(["Export"]);
    // Back to what failed: Retry again.
    act(() => document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]')!.click());
    expect(primary()).toEqual(["Retry"]);
  });

  // A Save-to-computer export that failed while it waited on its graphics has nothing on the server to retry (the
  // wait's failure is only said), and Retry fell back to sharing: the cut went up as a new version on the review link,
  // one a client may have, when only a file was asked for (audit E10c, Nov 21). Retry does what the dialog says.
  it("Retry with nothing to retry does what was picked: a Save-to-computer export saves, it never shares", async () => {
    await open(project(), { channel: null, channels: [] });
    act(() => useEditor.setState({ exportState: { state: "failed", progress: 0, path: "/x.mp4", error: "not enough room" } as never }));
    await settle();
    expect(primary()).toEqual(["Retry"]);
    vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: true } as never);
    vi.spyOn(api, "retryExport").mockRejectedValue(new Error("nothing to retry"));
    const shared = vi.spyOn(api, "shareProject").mockResolvedValue({} as never);
    const saved = vi.spyOn(api, "exportHere").mockResolvedValue({} as never);
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Retry")!.click());
    await settle();
    expect(shared).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledWith("p1", expect.anything(), null);
  });

  it("Retry with nothing to retry, sending for feedback: it shares, as picked", async () => {
    localStorage.setItem("edit.export.where", "feedback");
    await open(project(), { channel: null, channels: [] });
    act(() => useEditor.setState({ exportState: { state: "failed", progress: 0, path: "/x.mp4", error: "not enough room" } as never }));
    await settle();
    vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: true } as never);
    vi.spyOn(api, "retryExport").mockRejectedValue(new Error("nothing to retry"));
    const shared = vi.spyOn(api, "shareProject").mockResolvedValue({} as never);
    const saved = vi.spyOn(api, "exportHere").mockResolvedValue({} as never);
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Retry")!.click());
    await settle();
    expect(saved).not.toHaveBeenCalled();
    expect(shared).toHaveBeenCalledWith("p1", expect.anything(), false, true, null);
  });

  it("a cancelled export: Export again, no Retry", async () => {
    await open(project(), { channel: null, channels: [] });
    act(() => useEditor.setState({ exportState: { state: "cancelled", progress: 0, path: "/x.mp4" } as never }));
    await settle();
    expect(primary()).toEqual(["Export again"]);
    expect(labels()).not.toContain("Retry");
  });
});
