// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type RemovalPiece, type TextRemoval } from "../lib/api";
import { eventLine, leftLine, pieceRows, runLine } from "../lib/removal";
import { RemovalRow } from "./RemovalRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const settle = () =>
  act(async () => {
    for (let n = 0; n < 5; n++) await Promise.resolve();
  });

const RUN: TextRemoval = { line: null, action: null, running: { done: 12, total: 25 }, background: { label: "Removing their text and watermarks", done: 12, total: 25, started_at: Date.now() - 92_000, left_s: 300 } };
const PIECES: RemovalPiece[] = [
  { key: "watermark:m1@0", what: "watermark", media: "m1", name: "Routine Check", from: 0, to: 30, state: "done" },
  { key: "watermark:m1@330000", what: "watermark", media: "m1", name: "Routine Check", from: 330, to: 360, state: "failed", why: "ffmpeg failed" },
  { key: "text:m2@0", what: "text", media: "m2", name: "Tulsa", from: 0, to: 280, state: "running" },
  { key: "text:m2@300", what: "text", media: "m2", name: "Tulsa", from: 300, to: 580, state: "queued" },
];

function mount(running: boolean): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RemovalRow projectId="p1" marked running={running} />));
  return container;
}

describe("the chat's waiting row for a removal in the background", () => {
  it("says what, how far, how long and about how long left; Details lists the pieces; Stop stops it and the row goes", async () => {
    vi.spyOn(api, "textRemoval").mockResolvedValue(RUN);
    vi.spyOn(api, "removal").mockResolvedValue({ pieces: PIECES, background: RUN.background!, stopped: false });
    const stop = vi.spyOn(api, "stopRemoval").mockResolvedValue({ line: null, action: null, running: null });
    const container = mount(false);
    await settle();
    const row = container.querySelector("[data-testid=removal-row]")!;
    expect(row.textContent).toContain("Waiting · Removing their text and watermarks · 12 of 25 pieces");
    expect(row.textContent).toContain("1m 32s");
    expect(row.textContent).toContain("about 5 min left");
    const details = [...row.querySelectorAll("button")].find((one) => one.textContent === "Details")!;
    await act(async () => details.click());
    await settle();
    const listed = [...container.querySelectorAll("li")].map((one) => one.textContent ?? "");
    expect(listed[0]).toContain("Tulsa · 0–280 s");
    expect(listed.some((one) => one.includes("Routine Check · 330–360 s") && one.includes("watermark · left: ffmpeg failed") && one.includes("not clean"))).toBe(true);
    const stopButton = [...row.querySelectorAll("button")].find((one) => one.textContent === "Stop")!;
    await act(async () => stopButton.click());
    await settle();
    expect(stop).toHaveBeenCalledWith("p1");
    // Its fade out, then gone.
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 400))));
    expect(container.querySelector("[data-testid=removal-row]")).toBeNull();
  });

  it("shows only between turns: hidden while the agent's turn runs", async () => {
    vi.spyOn(api, "textRemoval").mockResolvedValue(RUN);
    const container = mount(true);
    await settle();
    expect(container.querySelector("[data-testid=removal-row]")).toBeNull();
  });

  it("nothing under way: no row", async () => {
    vi.spyOn(api, "textRemoval").mockResolvedValue({ line: "Taking their text out is off: the team's Vmake account is signed out.", action: "retry", running: null });
    const container = mount(false);
    await settle();
    expect(container.querySelector("[data-testid=removal-row]")).toBeNull();
  });

  it("its words, and a turn of Edit's own read as Edit's line", () => {
    expect(runLine(RUN.background!)).toBe("Removing their text and watermarks · 12 of 25 pieces");
    expect([leftLine(null), leftLine(40), leftLine(600), leftLine(3 * 3600)]).toEqual([null, "under a minute left", "about 10 min left", "about 3 h left"]);
    expect(pieceRows(PIECES).map((row) => [row.state, row.right])).toEqual([
      ["current", "being cleaned"],
      ["done", "cleaned, checked"],
      ["done", "not clean"],
      ["waiting", "waiting"],
    ]);
    expect(eventLine("(Edit, background) Taking their watermarks out of the footage is done: 23 pieces cleaned.\n\nCleaned:\n- tape")).toBe("Taking their watermarks out of the footage is done: 23 pieces cleaned.");
  });
});
