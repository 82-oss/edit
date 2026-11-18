// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/playback", () => ({ playhead: { frame: 0 } }));
vi.mock("../lib/upload", () => ({ projectUploader: () => async () => ({}) }));

// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/** A chat a few turns long, the last one live with an answer streaming in. */
function chat(turns: number) {
  const entries = [];
  let at = 1_000;
  for (let turn = 0; turn < turns; turn++) {
    entries.push({ id: `u${turn}`, kind: "user", text: `Change ${turn}`, at, updated: at });
    entries.push({ id: `t${turn}`, kind: "tool", tool: "update_clip", text: "Updated a clip", status: "done", at: at + 1, updated: at + 2 });
    entries.push({ id: `a${turn}`, kind: "assistant", text: `Done ${turn}.`, at: at + 3, updated: at + 4 });
    at += 10;
  }
  entries[entries.length - 1] = { id: "live", kind: "assistant", text: "", at, updated: at };
  return entries;
}

describe("the editor's chat as a turn ends", () => {
  let root: Root;
  const errors: unknown[] = [];

  beforeEach(() => {
    vi.resetModules();
    errors.length = 0;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/agent") return response({ ready: true, provider: "claude" });
      if (url === "/api/agent/models") return response({ models: [] });
      if (url.endsWith("/agent")) return new Promise(() => {}); // the chat as the page already has it
      return response({});
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  it("a turn Edit started on a background event shows only the agent's work and answer, never as the person's message", async () => {
    const { useAgent } = await import("../lib/agent");
    const { useEditor } = await import("../lib/store");
    const { AgentPanel } = await import("./AgentPanel");
    useEditor.setState({ project: { id: "p1", clips: [], media: [], tracks: [], settings: { fps: 30 } } as never });
    const entries = [
      { id: "u0", kind: "user", text: "Cut the case", at: 1_000, updated: 1_000 },
      { id: "a0", kind: "assistant", text: "Cut.", at: 1_001, updated: 1_001 },
      { id: "u1", kind: "user", by: "edit", text: "(Edit, background) Their text and watermarks are out of the footage (24 pieces, 1 blurred).\n\nCleaned:\n- tape: watermark 0–30 s", at: 2_000, updated: 2_000 },
      { id: "a1", kind: "assistant", text: "Their watermarks are out of all 23 pieces.", at: 2_001, updated: 2_001 },
    ];
    useAgent.setState({ project: "p1", loaded: true, running: false, entries: entries as never, status: { ready: true }, activityAt: Date.now() - 5_000 });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container, { onUncaughtError: (error) => errors.push(error) });
    act(() => root.render(<AgentPanel />));
    await act(async () => void (await new Promise((done) => setTimeout(done, 50))));
    expect(container.textContent).not.toContain("(Edit, background)");
    expect(container.textContent).not.toContain("out of the footage (24 pieces");
    expect(container.textContent).toContain("Their watermarks are out of all 23 pieces.");
    expect(container.querySelector('[data-quote="my earlier message"]')?.textContent).toBe("Cut the case");
    expect(container.querySelectorAll('[data-quote="my earlier message"]').length).toBe(1);
    expect(errors).toEqual([]);
  });

  it("takes a backlog of streamed words and the turn's end without React giving up (#185)", async () => {
    const { useAgent, applyAgentEvent } = await import("../lib/agent");
    const { useEditor } = await import("../lib/store");
    const { AgentPanel } = await import("./AgentPanel");
    useEditor.setState({ project: { id: "p1", clips: [], media: [], tracks: [], settings: { fps: 30 } } as never });
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: chat(12) as never, status: { ready: true }, activityAt: Date.now() - 5_000 });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container, { onUncaughtError: (error) => errors.push(error) });
    act(() => root.render(<AgentPanel />));
    // Let the older turns' "quiet" timers settle, as they have by a turn's end.
    await new Promise((done) => setTimeout(done, 600));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    // A websocket backlog: each message its own task, all queued before React's own work gets a turn.
    const events = [
      ...Array.from({ length: 80 }, (_, index) => ({ project: "p1", event: "delta", id: "live", text: `word${index} ` })),
      { project: "p1", event: "entry", entry: { id: "live", kind: "assistant", text: "", at: 2_000, updated: 2_100 } },
      { project: "p1", event: "status", running: false },
    ];
    await new Promise<void>((done) => {
      events.forEach((event, index) =>
        setImmediate(() => {
          try {
            applyAgentEvent(event);
          } catch (error) {
            errors.push(error);
          }
          if (index === events.length - 1) setTimeout(done, 50);
        }),
      );
    });
    await new Promise((done) => setTimeout(done, 100));
    expect(errors.map(String)).toEqual([]);
    expect(container.textContent).toContain("word79");
    expect(useAgent.getState().running).toBe(false);
  });
});

describe("times in a chat", () => {
  let root: Root;
  beforeEach(() => {
    vi.resetModules();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", async () => response({}));
  });
  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  const reply = [
    { id: "u", kind: "user", text: "Where?", at: 1, updated: 1 },
    { id: "a", kind: "assistant", text: "At 1:44:00 in the source, 4:25 in the edit, and 9:50 to 12:00.", at: 2, updated: 2 },
  ];

  async function render(node: () => Promise<React.ReactNode>) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const element = await node();
    act(() => root.render(element));
    return container;
  }

  it("are links in the editor's chat only while they're in the edit", async () => {
    const { useAgent } = await import("../lib/agent");
    const { useEditor } = await import("../lib/store");
    const { AgentPanel } = await import("./AgentPanel");
    // Ten minutes at 30 fps.
    useEditor.setState({ project: { id: "p1", clips: [{ start: 0, duration: 18_000 }], media: [], tracks: [], settings: { fps: 30 } } as never });
    useAgent.setState({ project: "p1", loaded: true, running: false, entries: reply as never, status: { ready: true } });
    const container = await render(async () => <AgentPanel />);
    expect([...container.querySelectorAll("button")].map((button) => button.textContent).filter((text) => /\d:\d/.test(text ?? ""))).toEqual(["4:25", "9:50 - 12:00"]);
  });

  it("stay text in a chat with no edit to jump in (a script's, an idea's, a thumbnail's)", async () => {
    const { ChatTurns } = await import("./AgentPanel");
    const { buildTurns } = await import("../lib/agentTurns");
    const container = await render(async () => <ChatTurns turns={buildTurns(reply as never, false)} known={new Set()} />);
    expect(container.textContent).toContain("4:25 in the edit");
    expect([...container.querySelectorAll("button")].some((button) => /\d:\d/.test(button.textContent ?? ""))).toBe(false);
  });

  /** A chat on AgentChat with its times as given, its quotes into `idea:i1`. */
  async function idea(times: import("./AgentPanel").ChatTimes) {
    const { AgentChat } = await import("./AgentPanel");
    return render(async () => (
      <AgentChat adapter={{ key: "idea:i1", composer: "idea:i1", source: { entries: reply as never, running: false, loaded: true }, deliver: async () => {}, stop: () => {}, times, model: { name: "Opus 5.5" }, placeholder: "Ask" }} />
    ));
  }

  it("are marked but go nowhere in a chat whose times are inert (an idea's, a thumbnail's)", async () => {
    const container = await idea("inert");
    expect([...container.querySelectorAll("span.text-playhead")].map((span) => span.textContent)).toEqual(["1:44:00", "4:25", "9:50 - 12:00"]);
    expect([...container.querySelectorAll("button")].some((button) => /\d:\d/.test(button.textContent ?? ""))).toBe(false);
  });

  it("go where the chat says, up to its length (a script's footage)", async () => {
    const went: [number, number | null][] = [];
    const container = await idea({ length: 700, go: (start, end) => void went.push([start, end]) });
    const links = [...container.querySelectorAll("button")].filter((button) => /\d:\d/.test(button.textContent ?? ""));
    expect(links.map((button) => button.textContent)).toEqual(["4:25", "9:50 - 12:00"]);
    act(() => links[1]!.click());
    // As written: the chat's own go holds an end to its length (goToTime's inEdit).
    expect(went).toEqual([[590, 720]]);
  });

  it("quote into the chat's own composer, not the editor's", async () => {
    const { ContextMenuHost } = await import("./ContextMenu");
    const { useQuotesOf } = await import("../lib/chatQuotes");
    const container = await idea("inert");
    const menu = document.createElement("div");
    document.body.append(menu);
    const host = createRoot(menu);
    act(() => host.render(<ContextMenuHost />));
    const answer = container.querySelector('[data-quote="your earlier reply"]')!;
    act(() => void answer.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    const quote = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Quote message")!;
    act(() => quote.click());
    let quotes: unknown[] = [];
    function Read() {
      quotes = useQuotesOf("idea:i1");
      return null;
    }
    act(() => host.render(<Read />));
    expect(quotes).toEqual([expect.objectContaining({ from: "your earlier reply", text: reply[1]!.text })]);
    act(() => host.unmount());
  });
});

describe("a picture in a reply", () => {
  let root: Root;
  const written: ClipboardItem[] = [];
  beforeEach(() => {
    vi.resetModules();
    written.length = 0;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/chat-pictures/")) return new Response(new Blob(["png"], { type: "image/png" }));
      if (url.endsWith("/agent")) return new Promise(() => {}); // the chat as the page already has it
      return response({});
    });
    vi.stubGlobal("ClipboardItem", class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async (items: ClipboardItem[]) => void written.push(...items), writeText: async () => {} } });
  });
  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  const reply = [
    { id: "u", kind: "user", text: "Show me", at: 1, updated: 1 },
    { id: "a", kind: "assistant", text: "Here it is:\n\n![The opening frame](/api/projects/p1/chat-pictures/0123456789abcdef.png)", at: 2, updated: 2 },
  ];

  const labels = () => [...document.querySelectorAll("[role=menu] button, .fixed.z-\\[70\\] button")].map((button) => button.textContent?.trim());
  const rightClick = (node: Element) => act(() => void node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));

  it("offers the image's own actions, then the message's, and the big view only the image's", async () => {
    const { useAgent } = await import("../lib/agent");
    const { useEditor } = await import("../lib/store");
    const { AgentPanel } = await import("./AgentPanel");
    const { ContextMenuHost } = await import("./ContextMenu");
    useEditor.setState({ project: { id: "p1", clips: [], media: [], tracks: [], settings: { fps: 30 } } as never });
    useAgent.setState({ project: "p1", loaded: true, running: false, entries: reply as never, status: { ready: true } });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <>
          <AgentPanel />
          <ContextMenuHost />
        </>,
      ),
    );
    const picture = container.querySelector('img[alt="The opening frame"]')!;
    rightClick(picture);
    expect(labels()).toEqual(["Copy image", "Save image", "Copy message", "Quote message"]);

    act(() => (document.querySelector(".fixed.z-\\[70\\] button") as HTMLButtonElement).click());
    await new Promise((done) => setTimeout(done, 0));
    expect(written).toHaveLength(1);
    expect(Object.keys((written[0] as unknown as { items: object }).items)).toEqual(["image/png"]);

    act(() => (picture.closest("button") as HTMLButtonElement).click());
    const big = [...document.querySelectorAll('img[alt="The opening frame"]')].find((image) => !container.contains(image))!;
    rightClick(big);
    expect(labels()).toEqual(["Copy image", "Save image"]);
  });
});

describe("a message as it's sent (Sphe, Nov 17: optimistic, never vanishing or doubling)", () => {
  let root: Root;
  /** The POSTs of messages, each answered when the test says. */
  let posts: { body: { text: string; send_id: string }; answer: (value: Response) => void }[];

  beforeEach(() => {
    vi.resetModules();
    posts = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url === "/api/projects/p1/agent") return new Promise<Response>((answer) => posts.push({ body: JSON.parse(String(init.body)), answer }));
      if (url === "/api/agent") return response({ ready: true, provider: "claude" });
      if (url === "/api/agent/models") return response({ models: [] });
      if (url.endsWith("/agent")) return new Promise(() => {}); // the chat as the page already has it
      return response({});
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  const done = [
    { id: "u0", kind: "user", text: "Make the board", at: 1, updated: 1 },
    { id: "a0", kind: "assistant", text: "Done.", at: 2, updated: 2 },
  ];

  async function open(hq = false, running = false) {
    const { useAgent, applyAgentEvent, flushAgentEvents, sendToAgent } = await import("../lib/agent");
    const { useEditor } = await import("../lib/store");
    const { AgentPanel } = await import("./AgentPanel");
    useEditor.setState({ project: { id: "p1", hq, clips: [], media: [], tracks: [], settings: { fps: 30 } } as never });
    useAgent.setState({ project: "p1", loaded: true, running, entries: done as never, status: { ready: true }, queue: [] });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<AgentPanel />));
    const event = (value: Record<string, unknown>) =>
      act(() => {
        applyAgentEvent({ project: "p1", ...value } as never);
        flushAgentEvents();
      });
    const bubbles = (text: string) => [...container.querySelectorAll('[data-quote="my earlier message"]')].filter((node) => node.textContent === text).length;
    const queued = () => [...container.querySelectorAll('[aria-label="Queued messages"] [role="listitem"]')].map((row) => row.textContent);
    const send = (text: string) => act(() => void sendToAgent(text, 0, [], hq));
    return { container, event, bubbles, queued, send, useAgent };
  }

  const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

  it("shows at once, says Sending… only when it takes a while, and is replaced in place by the server's copy, never twice", async () => {
    const { container, event, bubbles, send } = await open();
    send("make it brighter");
    expect(bubbles("make it brighter")).toBe(1);
    expect(container.textContent).not.toContain("Sending…");
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 1100)));
    expect(container.textContent).toContain("Sending…");
    const [post] = posts;
    // The server's copy by its event, then the answer: the one message, in its place.
    event({ event: "entry", entry: { id: "user-1", kind: "user", text: "make it brighter", at: 3, updated: 3, send_id: post!.body.send_id } });
    expect(bubbles("make it brighter")).toBe(1);
    await act(async () => post!.answer(response({ ok: true })));
    await settle();
    expect(bubbles("make it brighter")).toBe(1);
    expect(container.textContent).not.toContain("Sending…");
    expect(posts).toHaveLength(1);
  });

  it("queued while an Edit V2 turn runs, shows in the queue at once and stays one row as the server's queue comes", async () => {
    const { event, bubbles, queued, send } = await open(true, true);
    send("make it red");
    expect(queued()).toEqual([expect.stringContaining("make it red")]);
    expect(bubbles("make it red")).toBe(0);
    const [post] = posts;
    const item = { id: "queued-1", text: "make it red", at: 3, playhead: 0, send_id: post!.body.send_id };
    // The queue's event before the answer, then the answer: one row throughout.
    event({ event: "queue", queue: [item] });
    expect(queued()).toHaveLength(1);
    await act(async () => post!.answer(response({ ok: true, queued: item })));
    await settle();
    expect(queued()).toHaveLength(1);
    expect(bubbles("make it red")).toBe(0);
  });

  it("that's refused stays where it was saying why, and Retry sends it again with the same id", async () => {
    const { container, event, bubbles, send } = await open();
    send("make it brighter");
    await act(async () => posts[0]!.answer(new Response(JSON.stringify({ error: "Marc is editing this project" }), { status: 423 })));
    await settle();
    expect(bubbles("make it brighter")).toBe(1);
    expect(container.textContent).toContain("Didn't send");
    expect(container.textContent).toContain("Marc is editing this project");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    act(() => retry.click());
    expect(container.textContent).not.toContain("Didn't send");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body.send_id).toBe(posts[0]!.body.send_id);
    event({ event: "entry", entry: { id: "user-1", kind: "user", text: "make it brighter", at: 3, updated: 3, send_id: posts[1]!.body.send_id } });
    await act(async () => posts[1]!.answer(response({ ok: true })));
    await settle();
    expect(bubbles("make it brighter")).toBe(1);
    expect(container.textContent).not.toContain("Didn't send");
  });

  it("that's refused goes back in the box on Edit, out of the chat", async () => {
    const { container, bubbles, send } = await open();
    send("make it brighter");
    await act(async () => posts[0]!.answer(new Response(JSON.stringify({ error: "the agent is still working; stop it or wait" }), { status: 409 })));
    await settle();
    const edit = [...container.querySelectorAll("button")].find((button) => button.textContent === "Edit")!;
    act(() => edit.click());
    await settle();
    expect(bubbles("make it brighter")).toBe(0);
    expect(container.querySelector('[role="textbox"]')!.textContent).toBe("make it brighter");
  });
});
