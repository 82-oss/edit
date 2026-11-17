// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type TextRemoval } from "../lib/api";
import { eventLine, leftLine, runLine } from "../lib/removal";
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

const RUN: TextRemoval = { line: null, action: null, running: { done: 12, total: 81 }, background: { label: "Removing their text", done: 12, total: 81, started_at: Date.now() - 92_000, left_s: 300 } };

function mount(running: boolean): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RemovalRow projectId="p1" marked running={running} />));
  return container;
}

describe("the chat's waiting row for a removal in the background", () => {
  it("says what, how far, how long and about how long left, never cut (it wraps); one button, Stop, and the row goes", async () => {
    vi.spyOn(api, "textRemoval").mockResolvedValue(RUN);
    const stop = vi.spyOn(api, "stopRemoval").mockResolvedValue({ line: null, action: null, running: null });
    const container = mount(false);
    await settle();
    const row = container.querySelector("[data-testid=removal-row]")!;
    expect(row.textContent).toContain("Removing their text · 12 of 81 · 1m 32s · about 5 min left");
    // Nothing truncates its words.
    expect(row.querySelector(".truncate")).toBeNull();
    expect([...row.querySelectorAll("button")].map((one) => one.textContent)).toEqual(["Stop"]);
    await act(async () => row.querySelector("button")!.click());
    await settle();
    expect(stop).toHaveBeenCalledWith("p1");
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
    expect(runLine(RUN.background!)).toBe("Removing their text · 12 of 81");
    expect([leftLine(null), leftLine(40), leftLine(600), leftLine(3 * 3600)]).toEqual([null, "under a minute left", "about 10 min left", "about 3 h left"]);
    expect(eventLine("(Edit, background) Taking their watermarks out of the footage is done: 23 pieces cleaned.\n\nCleaned:\n- tape")).toBe("Taking their watermarks out of the footage is done: 23 pieces cleaned.");
  });
});
