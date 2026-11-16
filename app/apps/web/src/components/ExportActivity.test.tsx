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
});
