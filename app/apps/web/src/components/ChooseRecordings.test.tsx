// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChooseRecordings, preselect, type TooMuch } from "./ChooseRecordings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const HOUR = 3_600_000;
/** JJ's folder, Nov 18: 48 recordings, 23.4 h in all, over a case's 20 h; the third one too long to import at all. */
const folder = (): TooMuch => ({
  kind: "too_much",
  summary: "This folder holds more footage than one import takes. A case takes at most twenty hours of footage. Choose the recordings to bring in.",
  files: Array.from({ length: 48 }, (_, n) => ({ id: `r${n}`, title: `Recording ${n + 1}.mp4`, size: 2e9, durationMs: n === 2 ? 11 * HOUR : (12.4 * HOUR) / 47, audio: true, tooLong: n === 2 })),
  maxFiles: 60,
  maxMs: 20 * HOUR,
});

const settle = () => act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); });

function open(decision: TooMuch, onChoose: (ids: string[]) => Promise<boolean>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<ChooseRecordings decision={decision} onClose={() => {}} onChoose={onChoose} />));
  const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const count = () => container.querySelector("p")!.textContent;
  const button = () => [...container.querySelectorAll("button")].find((one) => one.textContent?.startsWith("Import"))!;
  return { boxes, count, button };
}

describe("choosing a folder's recordings (a too_much import)", () => {
  it("starts on what fits, in order, skipping one too long, within the files and hours", () => {
    expect(preselect(folder())).toEqual(folder().files.filter((file) => !file.tooLong).map((file) => file.id));
    // Capped by count: the first two of three.
    expect(preselect({ ...folder(), files: folder().files.slice(3, 6), maxFiles: 2 })).toEqual(["r3", "r4"]);
    // Capped by hours: one that would go over is passed by, a later short one still taken.
    const files = [
      { id: "a", title: "a", size: 1, durationMs: 15 * HOUR, audio: true, tooLong: false },
      { id: "b", title: "b", size: 1, durationMs: 6 * HOUR, audio: true, tooLong: false },
      { id: "c", title: "c", size: 1, durationMs: 4 * HOUR, audio: true, tooLong: false },
    ];
    expect(preselect({ ...folder(), files })).toEqual(["a", "c"]);
  });

  it("lists every recording with a box, counts against the limits, and sends the chosen ones once under them", async () => {
    const onChoose = vi.fn(async (_ids: string[]) => true);
    const { boxes, count, button } = open(folder(), onChoose);
    expect(boxes).toHaveLength(48);
    expect(boxes[2]!.disabled).toBe(true);
    expect(boxes.filter((box) => box.checked)).toHaveLength(47);
    expect(count()).toBe("47 of at most 60 recordings · 12.4 h of at most 20 h");
    expect(button().disabled).toBe(false);

    act(() => boxes[5]!.click());
    expect(count()).toBe("46 of at most 60 recordings · 12.1 h of at most 20 h");
    act(() => button().click());
    await settle();
    expect(onChoose).toHaveBeenCalledTimes(1);
    const sent = onChoose.mock.calls[0]![0];
    expect(sent).toHaveLength(46);
    expect(sent).not.toContain("r2");
    expect(sent).not.toContain("r5");
    expect(sent.slice(0, 3)).toEqual(["r0", "r1", "r3"]);
  });

  it("can't bring in more than a case takes", () => {
    const files = ["a", "b", "c"].map((id) => ({ id, title: id, size: 1, durationMs: 8 * HOUR, audio: true, tooLong: false }));
    const { boxes, count, button } = open({ ...folder(), files }, async () => true);
    expect(count()).toBe("2 of at most 60 recordings · 16 h of at most 20 h");
    act(() => boxes[2]!.click());
    expect(count()).toBe("3 of at most 60 recordings · 24 h of at most 20 h");
    expect(button().disabled).toBe(true);
    act(() => boxes[0]!.click());
    expect(button().disabled).toBe(false);
    act(() => boxes.forEach((box) => box.checked && box.click()));
    expect(button().disabled).toBe(true);
  });

  it("is pressed once until the import carries on, and pressable again if refused", async () => {
    const onChoose = vi.fn(async (_ids: string[]) => false);
    const { button } = open(folder(), onChoose);
    act(() => button().click());
    expect(button().getAttribute("aria-busy")).toBe("true");
    await settle();
    expect(button().getAttribute("aria-busy")).toBeNull();
  });
});
