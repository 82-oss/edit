// @vitest-environment happy-dom
// A channel's watermark on its page (Sphe, Nov 16), and the voice picker's "In use" row.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { channelApi, type Channel } from "../lib/channels";
import { ChannelWatermark } from "./ChannelWatermark";
import { VoicePicker } from "./VoicePicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const settle = () => act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); });
const lanes = { ideas: "", thumbnails: "", script: "", edit: "" };
const channel = (more: Partial<Channel> = {}): Channel => ({ key: "ch-0123456789", youtubeId: null, handle: null, title: "Cuffed & Caught", description: "", avatar: null, banner: null, subscribers: null, videos: null, views: null, narration: null, compilation: true, lanes, at: 0, ...more });

function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

describe("a channel's watermark on its page", () => {
  it("none: only the picker, which offers the folder's pictures and an upload", async () => {
    vi.spyOn(api, "watermarks").mockResolvedValue({ channel: null, channels: [{ id: "pic-si", code: "SI", name: "SI" }], usual: null });
    const page = render(<ChannelWatermark channel={channel()} />);
    await settle();
    expect(page.textContent).toContain("None");
    expect(page.querySelector('[role="slider"]')).toBeNull();
    expect(page.querySelector('input[type="file"]')?.getAttribute("accept")).toBe("image/png,image/jpeg,image/webp");
  });

  it("an uploaded one: its picture on a still, and its look's sliders, saved once let go", async () => {
    vi.spyOn(api, "watermarks").mockResolvedValue({ channel: null, channels: [], usual: null });
    const set = vi.spyOn(channelApi, "set").mockImplementation(async (_key, change) => channel({ ...change } as Partial<Channel>));
    const shown = channel({ watermarkUpload: { sha256: "a".repeat(64), ext: "png" }, watermarkLook: { opacity: 0.2, size: 0.1, speed: 0.04, motion: true } });
    const page = render(<ChannelWatermark channel={shown} still="p1" />);
    await settle();
    expect(page.textContent).toContain("Uploaded picture");
    const pictures = [...page.querySelectorAll("img")].map((one) => one.getAttribute("src"));
    expect(pictures).toContain(`/api/channels/ch-0123456789/watermark?p=${"a".repeat(64)}`);
    // A placeholder: a frame of one of its edits stands in for a still.
    expect(pictures).toContain("/api/projects/p1/frame/300.png?max=640");
    const sliders = [...page.querySelectorAll<HTMLElement>('[role="slider"]')];
    expect(sliders.map((one) => one.getAttribute("aria-label"))).toEqual(["Opacity", "Size", "Speed"]);
    expect(page.textContent).toContain("20%");
    act(() => {
      sliders[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(set).toHaveBeenCalledWith("ch-0123456789", { watermarkLook: { opacity: 0.22, size: 0.1, speed: 0.04, motion: true } });
    // Still: no speed to set.
    act(() => page.querySelector<HTMLElement>('[role="switch"]')!.click());
    expect(set).toHaveBeenLastCalledWith("ch-0123456789", { watermarkLook: { opacity: 0.22, size: 0.1, speed: 0.04, motion: false } });
    expect([...page.querySelectorAll('[role="slider"]')].map((one) => one.getAttribute("aria-label"))).toEqual(["Opacity", "Size"]);
  });
});

describe("the voice picker's In use row", () => {
  it("always shows the voice's name; its channels give way to one and +N", async () => {
    const voices = [{ voice_id: "v1", name: "Brian - Warm, Smooth, Confident" }] as never;
    const used = [{ voice: "v1", label: "Bodycam" }, { voice: "v1", label: "Sam's Interrogations", channel: "ch-a" }, { voice: "v1", label: "Sam's Compilations", channel: "ch-b" }];
    render(<VoicePicker value={null} voices={voices} used={used} onChange={() => {}} />);
    act(() => document.querySelector<HTMLButtonElement>("button")!.click());
    await settle();
    const row = document.querySelector('[data-row="0"]')!;
    expect(row.textContent).toContain("Brian");
    expect(row.textContent).toContain("Bodycam");
    expect(row.textContent).toContain("+2");
    expect(row.textContent).not.toContain("Sam's Compilations");
    expect(row.querySelector('span[title]')?.getAttribute("title")).toBe("Bodycam, Sam's Interrogations, Sam's Compilations");
  });
});
