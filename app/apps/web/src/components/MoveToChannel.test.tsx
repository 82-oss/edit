// @vitest-environment happy-dom
// Home's ⋯ on a V1 edit with Edit V2 on: "Move to a channel…", the channel
// picked as New edit picks one, the server asked, and the row's Channel
// column then the channel's (MoveToChannel.tsx; the server's channel_move.ts).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, request: (...args: unknown[]) => mocks.request(...args) };
});

import { useBeta } from "../lib/beta";
import { useChannels, type Channel } from "../lib/channels";
import type { ProjectSummary } from "../lib/types";
import { Category } from "./HomeTable";
import { moveItem, MoveToChannel } from "./MoveToChannel";

const CHANNEL = { key: "ch-cuffed", youtubeId: "UC1", handle: "cuffed", title: "Cuffed & Caught", description: "", avatar: null, banner: null, subscribers: 1, videos: 1, views: 1, narration: null, compilation: true, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, at: 0 } as Channel;
const V1 = { id: "p1", name: "Mom Sentenced", style: "courtroom", modified_ms: 0, duration_frames: 300, fps: 30, clips: 12 } as unknown as ProjectSummary;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((one) => (one.textContent ?? "").trim() === text || (one.textContent ?? "").includes(text));
  if (!found) throw new Error(`no button ${text}: ${Array.from(document.querySelectorAll("button")).map((one) => one.textContent).join(" | ")}`);
  return found;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.request.mockReset();
  useBeta.setState({ v2: true });
  useChannels.setState({ channels: [CHANNEL], groups: [], teacher: false, failed: null });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("Move to a channel", () => {
  it("is offered for a V1 edit with Edit V2 on, and never with it off, for a V2 project or one that can't open", () => {
    const open = vi.fn();
    expect(moveItem(V1, true, open).map((one) => ("label" in one ? one.label : ""))).toEqual(["Move to a channel…"]);
    expect(moveItem(V1, false, open)).toEqual([]);
    expect(moveItem({ ...V1, hq: true, channel: "ch-cuffed" }, true, open)).toEqual([]);
    expect(moveItem({ ...V1, problem: "unreadable" }, true, open)).toEqual([]);
    const [item] = moveItem(V1, true, open);
    (item as { onSelect: () => void }).onSelect();
    expect(open).toHaveBeenCalledOnce();
  });

  it("picks a channel as New edit does, asks the server, and the row then shows the channel", async () => {
    mocks.request.mockResolvedValue({ project: { id: "p1", channel: "ch-cuffed", hq: true, rev: 4 } });
    const onMoved = vi.fn();
    const onClose = vi.fn();
    render(<MoveToChannel project={V1} open onClose={onClose} onMoved={onMoved} />);
    expect(button("Move").disabled).toBe(true);
    act(() => button("Cuffed & Caught").click());
    expect(button("Move").disabled).toBe(false);
    await act(async () => button("Move").click());
    await flush();
    expect(mocks.request).toHaveBeenCalledWith("POST", "/api/channels/ch-cuffed/projects/p1");
    expect(onMoved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    // The row's Channel column: the niche before, the channel after (its summary as Home reads it again).
    act(() => root!.render(<Category style="courtroom" />));
    expect(container!.textContent).toBe("Courtroom");
    act(() => root!.render(<Category style="courtroom" channel="ch-cuffed" />));
    expect(container!.querySelector('[role="cell"]')!.getAttribute("title")).toBe("Cuffed & Caught");
  });

  it("says why when the server refuses, and leaves it as it was", async () => {
    mocks.request.mockRejectedValue(new Error("An export is under way on this edit: move it once it's done."));
    const onMoved = vi.fn();
    render(<MoveToChannel project={V1} open onClose={() => {}} onMoved={onMoved} />);
    act(() => button("Cuffed & Caught").click());
    await act(async () => button("Move").click());
    await flush();
    expect(document.body.textContent).toContain("An export is under way on this edit: move it once it's done.");
    expect(onMoved).not.toHaveBeenCalled();
  });
});
