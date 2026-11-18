// @vitest-environment happy-dom
// Home's Exports (ExportsView.tsx): the sidebar card's words, what the view
// lists as Exporting and Exported, and opening it marking what finished
// before as seen (Home's "Exported" goes) while still listing it this time.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type ExportActivity as Activity, type Exported } from "../lib/api";
import { cardWords, exportedSince, exporting, ExportsView, useExports } from "./ExportsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

const file = (name: string, finished_ms: number): Exported => ({ project: `p-${name}`, name, path: `/Videos/Edit/${name}.mp4`, shown: `~/Videos/Edit/${name}.mp4`, finished_ms, seconds: 2069, whole: true, bytes: 2.4e9, channel: null, on_review: finished_ms === 300 });
const steps = (progress: number, left_s: number, queued = false) => ({ where: "here" as const, queued, elapsed_s: 60, left_s, progress, steps: [{ kind: "video" as const, state: queued ? ("waiting" as const) : ("current" as const), label: "2:05:58", progress, left_s }] });
const running: Activity = { id: "p1", name: "When SMART Cops REFUSE To Leave", path: "", state: "running", progress: 0.62, updated_ms: 10, started_ms: 10, steps: steps(0.62, 240) };
const next: Activity = { id: "p2", name: "When Cops Rescue Boyfriends", path: "", state: "queued", progress: 0, updated_ms: 20, started_ms: 20, waiting: "waiting for the encoder", steps: steps(0, 600, true) };

describe("the card and the lists", () => {
  it("exporting: the one under way, how far, about how long and how many more wait", () => {
    expect(cardWords([next, running], null, null)).toEqual({ live: true, count: "62%", name: running.name, detail: "about 4 min · 1 more waiting", progress: 0.62 });
  });

  it("idle: how many finished since the view was opened, and the last one's name", () => {
    const files = [file("Cops Found 3 Bodies", 300), file("Real Crimes", 200), file("Killer Pastor", 100)];
    expect(cardWords([], files, 150)).toEqual({ live: false, count: "2", name: "Last: Cops Found 3 Bodies", detail: null, progress: null });
    expect(cardWords([], files, 400)).toMatchObject({ count: null, name: "Last: Cops Found 3 Bodies" });
    expect(cardWords([], [], 0)).toMatchObject({ count: null, name: "Nothing exported yet" });
    expect(exportedSince(files, 150).map((one) => one.name)).toEqual(["Cops Found 3 Bodies", "Real Crimes"]);
    expect(exportedSince(files, null)).toEqual([]);
  });

  it("Exporting: under way first, then in line, then what failed; one done or cancelled isn't there", () => {
    const failed: Activity = { id: "p3", name: "Failed", path: "", state: "failed", progress: 0.2, updated_ms: 5, error: "the encoder stopped" };
    const done: Activity = { id: "p4", name: "Done", path: "/x.mp4", state: "done", progress: 1, updated_ms: 30 };
    const cancelled: Activity = { id: "p5", name: "Cancelled", path: "", state: "cancelled", progress: 0.4, updated_ms: 40 };
    expect(exporting([failed, done, next, cancelled, running]).map((job) => job.id)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("the view", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    useExports.setState({ jobs: [], files: null, viewed: null });
  });

  it("lists what finished since it was last opened, and marks it seen as it opens and as it's left", async () => {
    vi.spyOn(api, "exportFolder").mockResolvedValue({ path: "/home/me/Videos/Edit", shown: "~/Videos/Edit", chosen: true, suggested: "", suggestedShown: "", home: "/home/me" });
    vi.spyOn(api, "exportsHere").mockResolvedValue({ viewed_ms: 150, exports: [file("Cops Found 3 Bodies", 300), file("Real Crimes", 200), file("Killer Pastor", 100)] });
    const viewed = vi.spyOn(api, "exportsViewed").mockResolvedValue({ viewed_ms: 500 });
    useExports.setState({ jobs: [running, next] });
    const onViewed = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<ExportsView channelOf={() => null} onViewed={onViewed} />));
    await act(async () => {
      for (let n = 0; n < 5; n++) await Promise.resolve();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Saved to ~/Videos/Edit");
    expect(text).toContain("Exporting 2");
    expect(text).toContain("62% · Video · 2:05:58 · about 4 min left");
    expect(text).toContain("Next · waiting for the encoder");
    // Since the last opening only: the older one is in All exports.
    expect(text).toContain("Exported 2");
    expect(text).toContain("Cops Found 3 Bodies");
    expect(text).toContain("on its review link");
    expect(text).not.toContain("Killer Pastor");
    expect(viewed).toHaveBeenCalledTimes(1);
    expect(onViewed).toHaveBeenCalled();
    // Still listed after it's marked (this visit's), and marked again as it's left.
    expect(container.textContent).toContain("Real Crimes");
    act(() => root!.unmount());
    root = null;
    expect(viewed).toHaveBeenCalledTimes(2);
  });
});
