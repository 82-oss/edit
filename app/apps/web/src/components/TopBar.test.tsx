// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

import { useEditor } from "../lib/store";
import { ExportWords } from "./TopBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  useEditor.setState({ exportState: null });
});

// The MacBook Air, Nov 21: "67%" for 58 s while it cut the footage, and no words in the top bar.
it("the top bar says what the export is on beside its percent, and nothing once it's only the percent", () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => useEditor.setState({ exportState: { state: "running", progress: 0.67, path: "/x.mp4", phase: "cutting the footage, 12 of 225" } as never }));
  act(() => root!.render(<ExportWords />));
  expect(container.textContent).toBe("Cutting the footage, 12 of 225");
  act(() => useEditor.setState({ exportState: { state: "queued", progress: 0, path: "/x.mp4", waiting: "waiting for the encoder" } as never }));
  expect(container.textContent).toBe("Waiting for the encoder");
  act(() => useEditor.setState({ exportState: { state: "running", progress: 0.7, path: "/x.mp4" } as never }));
  expect(container.textContent).toBe("");
});
