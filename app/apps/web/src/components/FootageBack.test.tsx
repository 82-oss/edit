// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { useEditor } from "../lib/store";
import { FootageBack } from "./FootageBack";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const settle = () => act(async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); });
const button = (words: string) => [...document.querySelectorAll("button")].find((one) => one.textContent === words);

describe("FootageBack", () => {
  it("says the footage was cleared, names what can't be fetched, and brings the rest back with the links given", async () => {
    useEditor.setState({ project: { id: "p1" } as never, cloud: null, scriptJob: null });
    vi.spyOn(api, "footageCleared").mockResolvedValue({ cleared: { at: 1, media: [] }, job: null });
    vi.spyOn(api, "unfetchableFootage").mockResolvedValue({ missing: [
      { source: "sha256:aa", name: "Interview.mov", why: "It came from someone's disk, so it can't be downloaded again." },
      { source: "drive:GONE", name: "Bodycam 2.mp4", why: "Google Drive can't find this file (deleted, or in the trash)." },
    ] });
    const back = vi.spyOn(api, "bringFootageBack").mockResolvedValue({ started: true });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<FootageBack />));
    await settle();
    expect(document.body.textContent).toContain("This project’s footage was cleared to save space after it was done and untouched for 30 days.");
    await act(async () => button("Bring the footage back")!.click());
    await settle();
    expect(document.body.textContent).toContain("2 files can’t be fetched");
    expect(document.body.textContent).toContain("Interview.mov");
    // A link for one; the other goes without.
    const [first] = [...document.querySelectorAll("input")];
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(first, "https://drive.google.com/file/d/NEW/view");
      first!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Go on without them")!.click());
    await settle();
    expect(back).toHaveBeenCalledWith("p1", { "sha256:aa": "https://drive.google.com/file/d/NEW/view" }, ["drive:GONE"]);
  });

  it("says nothing for a project whose footage is there", async () => {
    useEditor.setState({ project: { id: "p2" } as never, cloud: null, scriptJob: null });
    vi.spyOn(api, "footageCleared").mockResolvedValue({ cleared: null, job: null });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<FootageBack />));
    await settle();
    expect(document.body.textContent).toBe("");
  });
});
