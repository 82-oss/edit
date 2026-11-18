// @vitest-environment happy-dom
// A reopened import's clock counts from when it really began (Astra, Nov 18), and what it's doing is said once.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportScreen } from "../import-screen";
import type { ImportProgress } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function show(item: ImportProgress) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<ImportScreen item={item} onLeave={() => {}} />));
}

const item = (extra: Partial<ImportProgress>): ImportProgress => ({ id: "s1", title: "A case", stage: "transcribing", percent: 60, detail: "Transcribing 3 of 9 recordings", ...extra });

describe("ImportScreen", () => {
  it("opened twelve minutes into an import: Running for counts from its start, and the detail shows once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    show(item({ startedAt: Date.now() - 12 * 60_000 - 5_000 }));
    expect(document.body.textContent).toContain("Running for 12 min 05 s");
    expect(document.body.textContent?.split("Transcribing 3 of 9 recordings").length).toBe(2);
  });

  it("no start known: no clock at all", () => {
    show(item({}));
    expect(document.body.textContent).not.toContain("Running for");
  });
});
