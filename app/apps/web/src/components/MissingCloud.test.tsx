// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { MissingCloud, missingTiming, missingWords, useEditMissing } from "./MissingCloud";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
const real = { ...missingTiming };
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  Object.assign(missingTiming, real);
  vi.restoreAllMocks();
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const buttonNamed = (name: string) => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));

describe("the note's words", () => {
  it("names what didn't come in, plainly", () => {
    expect(missingWords([{ id: "a", name: "CH03-0112.avi" }])).toBe("1 recording didn't come in: CH03-0112.avi");
    expect(missingWords([{ id: "a", name: "a.mp4" }, { id: "b", name: "b.mp4" }, { id: "c", name: "c.mp4" }], "file")).toBe("3 files didn't come in: a.mp4, b.mp4 and c.mp4");
  });
});

const writeWithout = (it: "it" | "them") => `Write without ${it}`;
const writeOutcome = (it: "it" | "them") => `the script is written without ${it} for now.`;

describe("MissingCloud", () => {
  it("shows the cloud with a dot and the note under it; for trouble that passes only its one answer, named for what it does, and no Retry", () => {
    mount(<MissingCloud items={[{ id: "r2", name: "CH03-0112.avi" }]} onRetry={async () => {}} onWithout={async () => {}} without={writeWithout} outcome={writeOutcome} />);
    expect(document.querySelector("[data-testid=missing-dot]")).not.toBeNull();
    const note = document.querySelector("[role=status]")!;
    expect(note.textContent).toContain("1 recording didn't come in: CH03-0112.avi");
    expect(note.textContent).toContain("Edit keeps trying to bring it in.");
    expect([...note.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["Write without it"]);
  });

  it("Retry now is there only where the person can put it right (a file not shared, deleted)", () => {
    mount(<MissingCloud items={[{ id: "r2", name: "CH03.avi", asked: true }]} onRetry={async () => {}} onWithout={async () => {}} without={writeWithout} outcome={writeOutcome} />);
    const note = document.querySelector("[role=status]")!;
    expect([...note.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["Write without it", "Retry now"]);
  });

  it("Retry now asks again; a click away hides the note and the cloud brings it back", async () => {
    const onRetry = vi.fn(async () => {});
    mount(<MissingCloud items={[{ id: "r2", name: "CH03.avi", asked: true }]} onRetry={onRetry} onWithout={async () => {}} without={writeWithout} outcome={writeOutcome} />);
    await act(async () => buttonNamed("Retry now")!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    const cloud = () => document.querySelector("button[aria-haspopup=dialog]") as HTMLButtonElement;
    act(() => void document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(cloud().getAttribute("aria-expanded")).toBe("false");
    act(() => cloud().click());
    expect(cloud().getAttribute("aria-expanded")).toBe("true");
  });

  it("its answer is confirmed first, saying what it does, then applies to every one named", async () => {
    const onWithout = vi.fn(async (_ids: string[]) => {});
    mount(<MissingCloud items={[{ id: "1", name: "a.mp4" }, { id: "2", name: "b.mp4" }]} noun="video" onRetry={async () => {}} onWithout={onWithout} without={writeWithout} outcome={writeOutcome} />);
    act(() => buttonNamed("Write without them")!.click());
    expect(onWithout).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Write without them?");
    expect(document.body.textContent).toContain("These 2 videos: the script is written without them for now.");
    const confirms = [...document.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Write without them");
    await act(async () => confirms.at(-1)!.click());
    await settle();
    expect(onWithout).toHaveBeenCalledWith(["1", "2"]);
  });
});

describe("useEditMissing", () => {
  function Harness() {
    const missing = useEditMissing("p1", 3, null);
    return missing.items.length > 0 ? <MissingCloud items={missing.items} noun="file" onRetry={missing.retry} onWithout={missing.without} without={(it) => `Export with ${it === "it" ? "its" : "their"} parts black`} outcome={() => "its clips stay black and silent."} /> : <p>All here</p>;
  }

  it("asks while footage is missing, and the note goes once a try brings it in", async () => {
    missingTiming.pollMs = 80;
    let answers = [
      { used: 4, missing: [{ id: "m1", name: "Bodycam.mp4", path: "/gone/Bodycam.mp4" }] },
      { used: 4, missing: [] },
    ];
    const ask = vi.spyOn(api, "missingFootage").mockImplementation(async () => answers.shift() ?? { used: 4, missing: [] });
    mount(<Harness />);
    await settle();
    expect(document.body.textContent).toContain("1 file didn't come in: Bodycam.mp4");
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 150)));
    expect(document.body.textContent).toContain("All here");
    expect(ask.mock.calls.length).toBeGreaterThanOrEqual(2);
    answers = [];
  });

  it("Export with its parts black tells the server for each file and the note goes", async () => {
    vi.spyOn(api, "missingFootage").mockResolvedValue({ used: 4, missing: [{ id: "m1", name: "Bodycam.mp4", path: "/gone" }] });
    const without = vi.spyOn(api, "goWithoutFootage").mockResolvedValue({ used: 4, missing: [] });
    mount(<Harness />);
    await settle();
    act(() => buttonNamed("Export with its parts black")!.click());
    const confirms = [...document.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Export with its parts black");
    await act(async () => confirms.at(-1)!.click());
    await settle();
    expect(without).toHaveBeenCalledWith("p1", "m1");
    expect(document.body.textContent).toContain("All here");
  });
});
