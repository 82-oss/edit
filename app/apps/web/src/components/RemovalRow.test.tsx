// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type TextRemoval } from "../lib/api";
import { runLine } from "../lib/removal";
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

const RUN: TextRemoval = { line: null, action: null, running: { done: 12, total: 81 }, background: { label: "Removing their text and watermarks", done: 12, total: 25, started_at: Date.now() - 1_084_000 } };

function mount(running: boolean): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RemovalRow projectId="p1" marked running={running} />));
  return container;
}

describe("the chat's waiting row for a removal in the background", () => {
  it("a dashed ring, what, how far and how long, never cut (it wraps), a thin line of how far; one button, Stop, and the row goes", async () => {
    vi.spyOn(api, "textRemoval").mockResolvedValue(RUN);
    const stop = vi.spyOn(api, "stopRemoval").mockResolvedValue({ line: null, action: null, running: null });
    const container = mount(false);
    await settle();
    const row = container.querySelector("[data-testid=removal-row]")!;
    expect(row.textContent).toContain("Waiting · Removing their text and watermarks · 12 of 25 pieces · 18m 4s");
    expect(row.querySelector(".wait-ring")).not.toBeNull();
    // How far: 12 of 25.
    expect((row.querySelector(".bg-primary") as HTMLElement).style.width).toBe("48%");
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

  it("its words, and the day's free files only when few are left", () => {
    expect(runLine(RUN.background!)).toBe("Removing their text and watermarks · 12 of 25 pieces");
    expect(runLine({ ...RUN.background!, free_left: 3 })).toBe("Removing their text and watermarks · 12 of 25 pieces · 3 free files left today");
  });
});
