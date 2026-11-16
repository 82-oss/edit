// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useEditor } from "../lib/store";
import { ImportProblems } from "./MissingBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("ImportProblems", () => {
  it("says what followed an import that didn't go (a reused case not found), and stays gone once dismissed (Nov 16)", () => {
    const missed = 'Case 2 of "Old video" wasn\'t found: no such case. The whole video plays there; trim it to the case on the timeline.';
    useEditor.setState({ project: { id: "p1" } as never, scriptJob: { state: "done", files: [], after: [{ step: "words", state: "waiting", note: "still hearing" }, { step: "reuse", state: "failed", note: missed }] } as never });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<ImportProblems />));
    expect(document.body.textContent).toContain(missed);
    expect(document.body.textContent).not.toContain("still hearing");
    act(() => (document.querySelector("button[aria-label=Dismiss]") as HTMLButtonElement).click());
    expect(document.body.textContent).not.toContain(missed);
    act(() => root!.unmount());
    root = createRoot(container);
    act(() => root!.render(<ImportProblems />));
    expect(document.body.textContent).not.toContain(missed);
  });
});
