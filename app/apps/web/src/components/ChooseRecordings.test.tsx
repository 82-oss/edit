// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChooseRecordings, type TooMuch } from "./ChooseRecordings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const HOUR = 3_600_000;
/** JJ's folder, Nov 18, as an Edit with a case's limits stopped it: 48 recordings, 23.4 h in all, the third one 11 h. */
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

describe("choosing a folder's recordings (an import an older Edit stopped as too_much)", () => {
  it("starts on every recording, past the old limits, and Import brings the whole folder in", async () => {
    const onChoose = vi.fn(async (_ids: string[]) => true);
    const { boxes, count, button } = open(folder(), onChoose);
    expect(boxes).toHaveLength(48);
    expect(boxes.every((box) => box.checked && !box.disabled)).toBe(true);
    expect(count()).toBe("48 of 48 recordings · 23.4 h");
    expect(button().textContent).toBe("Import 48");
    act(() => button().click());
    await settle();
    expect(onChoose.mock.calls[0]![0]).toEqual(folder().files.map((file) => file.id));
  });

  it("leaves out what's unticked, in the folder's order", async () => {
    const onChoose = vi.fn(async (_ids: string[]) => true);
    const { boxes, count, button } = open(folder(), onChoose);
    act(() => boxes[2]!.click());
    act(() => boxes[5]!.click());
    expect(count()).toBe("46 of 48 recordings · 12.1 h");
    act(() => button().click());
    await settle();
    const sent = onChoose.mock.calls[0]![0];
    expect(sent).toHaveLength(46);
    expect(sent).not.toContain("r2");
    expect(sent).not.toContain("r5");
    expect(sent.slice(0, 3)).toEqual(["r0", "r1", "r3"]);
  });

  it("can't import none", () => {
    const { boxes, count, button } = open(folder(), async () => true);
    act(() => boxes.forEach((box) => box.click()));
    expect(count()).toBe("0 of 48 recordings · 0 h");
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
