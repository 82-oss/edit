// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePinChat } from "./chatScroll";

vi.mock("./playback", () => ({ playhead: { frame: 0 } }));
vi.mock("./upload", () => ({ projectUploader: () => async () => ({}) }));

// happy-dom lays nothing out: the scroller is given a height, the content the height each test says, and the browser's
// size notices are sent when the content's height changes, as a ResizeObserver's are after layout.
const VIEW = 300;
let height = 0;
const observers = new Set<() => void>();
class FakeResizeObserver {
  callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {
    observers.add(this.callback);
  }
  disconnect() {
    observers.delete(this.callback);
  }
}

function scrollable(node: HTMLElement) {
  let top = 0;
  const smooth: number[] = [];
  Object.defineProperty(node, "clientHeight", { get: () => VIEW });
  Object.defineProperty(node, "scrollHeight", { get: () => Math.max(VIEW, height) });
  Object.defineProperty(node, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, Math.max(VIEW, height) - VIEW));
    },
  });
  // A glide lands where it's headed (the test doesn't wait for frames); what was asked to glide is kept.
  node.scrollTo = ((options: ScrollToOptions) => {
    if (options.behavior === "smooth") smooth.push(options.top ?? 0);
    node.scrollTop = options.top ?? 0;
  }) as typeof node.scrollTo;
  return { smooth, bottom: () => Math.max(VIEW, height) - VIEW };
}

describe("a chat's scroll keeps to what follows your message", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    height = 1_000;
    observers.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  /** The shell with a "send" button standing in for the composer (it pins the chat the same way). */
  async function open() {
    const { ChatShell } = await import("../components/AgentPanel");
    let say: (rows: string[]) => void = () => {};
    function Send() {
      const pin = usePinChat();
      return <button onClick={() => pin?.()}>Send</button>;
    }
    function Chat() {
      const [rows, setRows] = useState<string[]>(["hi"]);
      say = setRows;
      return (
        <ChatShell label="Claude" footer={<Send />}>
          {rows.map((row, index) => (
            <p key={index}>{row}</p>
          ))}
        </ChatShell>
      );
    }
    act(() => root.render(<Chat />));
    const scroller = host.querySelector("section")!.firstElementChild as HTMLDivElement;
    const view = scrollable(scroller);
    const grow = (to: number) =>
      act(() => {
        height = to;
        for (const notice of [...observers]) notice();
      });
    const scrollTo = (top: number) =>
      act(() => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    const send = () => act(() => host.querySelector("button")!.click());
    // Opening lands at the bottom (the first size notice, as a ResizeObserver sends when it starts watching).
    grow(1_000);
    return { scroller, view, grow, scrollTo, send, say: (rows: string[]) => act(() => say(rows)) };
  }

  it("opens at the bottom", async () => {
    const chat = await open();
    expect(chat.scroller.scrollTop).toBe(chat.view.bottom());
  });

  it("sending glides to the bottom and stays there as the thinking line and the reply arrive and grow", async () => {
    const chat = await open();
    // Read back a little, then send: the view goes to the bottom, gliding.
    chat.scrollTo(200);
    chat.send();
    chat.grow(1_060); // your message
    expect(chat.scroller.scrollTop).toBe(chat.view.bottom());
    expect(chat.view.smooth.length).toBeGreaterThan(0);
    // The "Thinking…" row appears without the shell drawing again, then tool rows and the streamed reply grow.
    chat.grow(1_088);
    expect(chat.scroller.scrollTop).toBe(chat.view.bottom());
    for (const to of [1_120, 1_180, 1_400, 1_900]) {
      chat.grow(to);
      expect(chat.scroller.scrollTop).toBe(chat.view.bottom());
    }
  });

  it("the shell drawing new rows keeps it at the bottom too", async () => {
    const chat = await open();
    chat.say(["hi", "Change the grade"]);
    chat.grow(1_200);
    expect(chat.scroller.scrollTop).toBe(chat.view.bottom());
  });

  it("scrolling up stops following, and coming back near the bottom follows again", async () => {
    const chat = await open();
    chat.scrollTo(chat.view.bottom() - 250);
    const reading = chat.scroller.scrollTop;
    chat.grow(1_300);
    chat.grow(1_500);
    expect(chat.scroller.scrollTop).toBe(reading);
    // Back down to within the threshold: the next growth takes it to the bottom.
    chat.scrollTo(chat.view.bottom() - 30);
    chat.grow(1_600);
    expect(chat.scroller.scrollTop).toBe(chat.view.bottom());
  });

  it("a wheel turned up lets go before the next growth", async () => {
    const chat = await open();
    act(() => {
      chat.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    });
    const at = chat.scroller.scrollTop;
    chat.grow(1_400);
    expect(chat.scroller.scrollTop).toBe(at);
  });

  it("with reduced motion, sending goes to the bottom at once", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    const chat = await open();
    chat.scrollTo(100);
    chat.send();
    chat.grow(1_100);
    expect(chat.scroller.scrollTop).toBe(chat.view.bottom());
    expect(chat.view.smooth).toEqual([]);
  });
});
