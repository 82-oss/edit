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
