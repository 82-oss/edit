// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type BackgroundLine } from "../lib/api";
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

const RUN: BackgroundLine = { key: "removal", label: "Removing their text and watermarks", done: 12, total: 25, started_at: Date.now() - 1_084_000 };
/** A channel's end-of-turn check (the server's end_check.ts), from the same registry: nothing to count. */
const CHECK: BackgroundLine = { key: "end-check", label: "Checking the edit", done: 0, total: 0, started_at: Date.now() - 12_000, unit: "files read" };

function mount(running: boolean): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RemovalRow projectId="p1" marked running={running} />));
  return container;
}

describe("the chat's waiting row for a removal in the background", () => {
  it("a dashed ring, what, how far and how long, never cut (it wraps), a thin line of how far; one button, Stop, and the row goes", async () => {
    vi.spyOn(api, "background").mockResolvedValue({ lines: [RUN] });
    const stop = vi.spyOn(api, "stopBackground").mockResolvedValue({ lines: [] });
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
    expect(stop).toHaveBeenCalledWith("p1", "removal");
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 400))));
    expect(container.querySelector("[data-testid=removal-row]")).toBeNull();
  });

  it("shows only between turns: hidden while the agent's turn runs", async () => {
    vi.spyOn(api, "background").mockResolvedValue({ lines: [RUN] });
    const container = mount(true);
    await settle();
    expect(container.querySelector("[data-testid=removal-row]")).toBeNull();
  });

  it("nothing under way: no row", async () => {
    vi.spyOn(api, "background").mockResolvedValue({ lines: [] });
    const container = mount(false);
    await settle();
    expect(container.querySelector("[data-testid=removal-row]")).toBeNull();
  });

  it("its words", () => {
    expect(runLine(RUN)).toBe("Removing their text and watermarks · 12 of 25 pieces");
  });
});

describe("the same row for a channel's end-of-turn check (Nov 21)", () => {
  it("the same ring, words and Stop, with nothing to count: no count, no line of how far; Stop stops the check", async () => {
    vi.spyOn(api, "background").mockResolvedValue({ lines: [CHECK] });
    const stop = vi.spyOn(api, "stopBackground").mockResolvedValue({ lines: [] });
    const container = mount(false);
    await settle();
    const row = container.querySelector("[data-testid=removal-row]")!;
    expect(row.textContent).toBe("Waiting · Checking the edit · 12sStop");
    expect(row.querySelector(".wait-ring")).not.toBeNull();
    expect(row.querySelector(".bg-primary")).toBeNull();
    expect([...row.querySelectorAll("button")].map((one) => one.textContent)).toEqual(["Stop"]);
    await act(async () => row.querySelector("button")!.click());
    await settle();
    expect(stop).toHaveBeenCalledWith("p1", "end-check");
  });

  it("files its checks are still reading are counted as removal's pieces are", () => {
    expect(runLine({ ...CHECK, done: 2, total: 5 })).toBe("Checking the edit · 2 of 5 files read");
  });

  it("with removal under way too, one line each, the older first, each its own Stop", async () => {
    vi.spyOn(api, "background").mockResolvedValue({ lines: [RUN, CHECK] });
    const stop = vi.spyOn(api, "stopBackground").mockResolvedValue({ lines: [RUN] });
    const container = mount(false);
    await settle();
    const rows = [...container.querySelectorAll("[data-testid=removal-row]")];
    expect(rows.map((one) => one.textContent!.split(" · ")[1])).toEqual(["Removing their text and watermarks", "Checking the edit"]);
    await act(async () => rows[1]!.querySelector("button")!.click());
    await settle();
    expect(stop).toHaveBeenCalledWith("p1", "end-check");
  });

  it("looks again as a turn ends, when a check starts", async () => {
    const asked = vi.spyOn(api, "background").mockResolvedValue({ lines: [] });
    mount(true);
    await settle();
    expect(asked).toHaveBeenCalledTimes(1);
    asked.mockResolvedValue({ lines: [CHECK] });
    act(() => root!.render(<RemovalRow projectId="p1" marked running={false} />));
    await settle();
    expect(asked).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-testid=removal-row]")?.textContent).toContain("Checking the edit");
  });
});
