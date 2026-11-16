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
