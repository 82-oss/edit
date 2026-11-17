// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type ExportActivity as Activity } from "../lib/api";
import { useAccount } from "../lib/account";
import { ExportActivity } from "./ExportActivity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); });
const fill = () => document.querySelector("button[aria-haspopup] > span[aria-hidden]");

describe("ExportActivity", () => {
  it("a finished export's card is red until its queue is looked at, then grey until something new comes in (Sphe, Nov 16)", async () => {
    useAccount.setState({ account: null } as never);
    const done: Activity = { id: "p1", name: "Test Motion Graphics", path: "/Movies/Edit/t.mp4", state: "done", progress: 1, updated_ms: 100 };
    const rows = vi.spyOn(api, "exportActivity").mockResolvedValue([done]);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<ExportActivity />));
    await settle();
    expect(fill()?.className).toContain("bg-primary");
    await act(async () => (document.querySelector("button[aria-haspopup]") as HTMLButtonElement).click());
    expect(fill()?.className).toContain("bg-active");
    // Seen survives a reload of the page.
    act(() => root!.unmount());
    root = createRoot(container);
    act(() => root!.render(<ExportActivity />));
    await settle();
    expect(fill()?.className).toContain("bg-active");
    // Another export finishing: red again.
    rows.mockResolvedValue([{ ...done, updated_ms: 200 }]);
    act(() => root!.unmount());
    root = createRoot(container);
    act(() => root!.render(<ExportActivity />));
    await settle();
    expect(fill()?.className).toContain("bg-primary");
  });

  it("an export still waiting on its graphics is in the queue: the card says its step and the queue's time, the dialog its steps (Sphe, Nov 17)", async () => {
    useAccount.setState({ account: null } as never);
    const graphic = (state: "done" | "current" | "waiting", label: string, left: number) => ({ kind: "graphic" as const, state, label, progress: state === "current" ? 0.61 : null, left_s: left });
    const waiting: Activity = {
      id: "p1",
      name: "Officers Traumatized",
      path: "/home/me/Downloads/Edit/Officers.mp4",
      state: "running",
      progress: 0,
      updated_ms: 100,
      started_ms: 100,
      waiting: "rendering the cutfx-31 effect (then 26 more)",
      steps: {
        where: "here",
        queued: false,
        elapsed_s: 120,
        left_s: 540,
        progress: 120 / 660,
        steps: [graphic("done", "0:12", 0), graphic("current", "42:25", 20), graphic("waiting", "50:00", 340), { kind: "video", state: "waiting", label: "1:48:29", progress: null, left_s: 180 }, { kind: "save", state: "waiting", label: "~/Downloads/Edit", progress: null, left_s: 0 }],
      },
    };
    const next: Activity = {
      id: "p2",
      name: "Cops Found 3 Bodies",
      path: "",
      state: "queued",
      progress: 0,
      updated_ms: 200,
      started_ms: 200,
      waiting: "waiting for the encoder (this Mac has one)",
      steps: { where: "feedback", queued: true, elapsed_s: 0, left_s: 360, progress: 0, steps: [{ kind: "video", state: "waiting", label: "12:04", progress: null, left_s: 300 }, { kind: "copy", state: "waiting", label: "", progress: null, left_s: 20 }, { kind: "upload", state: "waiting", label: "", progress: null, left_s: 40 }] },
    };
    // Listed newest first, as the server sends them: the one in line is still shown after the one under way.
    vi.spyOn(api, "exportActivity").mockResolvedValue([next, waiting]);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<ExportActivity />));
    await settle();
    const card = document.querySelector("button[aria-haspopup]")!;
    // 120 s done of 660 + 360.
    expect(card.textContent).toBe(`Exports${Math.round((120 / 1020) * 100)}%2 exports · Graphics 2 of 3 · ~15 min left`);
    expect(fill()?.className).toContain("fill-shimmer");
    expect(card.textContent).not.toContain("cutfx");
    await act(async () => (card as HTMLButtonElement).click());
    const jobs = [...document.querySelectorAll('[role="dialog"] .border-b')];
    // The one under way first, unfolded to its steps, with Open project and Cancel export under them.
    expect(jobs[0]!.textContent).toContain("Officers Traumatized");
    expect(jobs[0]!.querySelectorAll('ol[aria-label="Export steps"] > li')).toHaveLength(5);
    expect(jobs[0]!.textContent).toContain("Graphic 2 of 3 · at 42:25");
    expect([...jobs[0]!.querySelectorAll("button")].map((one) => one.textContent)).toEqual(expect.arrayContaining(["Open project", "Cancel export"]));
    // The next in line: its pill, and when it starts.
    expect(jobs[1]!.textContent).toContain("Next");
    expect(jobs[1]!.textContent).toContain("Send for feedback · starts after the one above · ~6 min once it does");
    expect(jobs[1]!.querySelector("ol")).toBeNull();
    // Folded by its arrow.
    await act(async () => (jobs[0]!.querySelector("button[aria-expanded]") as HTMLButtonElement).click());
    expect(jobs[0]!.querySelector("ol")).toBeNull();
  });
});
