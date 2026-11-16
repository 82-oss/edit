import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchRetrying = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ fetchRetrying }));

describe("the chat's live events", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  it("applies a burst of streamed words as one store update", async () => {
    const { applyAgentEvent, flushAgentEvents, useAgent } = await import("./agent");
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [{ id: "a", kind: "assistant", text: "" }, { id: "b", kind: "tool", text: "Read", status: "done" }] });
    const tool = useAgent.getState().entries[1];
    let updates = 0;
    const off = useAgent.subscribe(() => updates++);
    for (let index = 0; index < 200; index++) applyAgentEvent({ project: "p1", event: "delta", id: "a", text: `${index} ` });
    applyAgentEvent({ project: "other", event: "delta", id: "a", text: "not this chat" });
    applyAgentEvent({ project: "p1", event: "status", running: false });
    expect(updates).toBe(0);
    flushAgentEvents();
    off();
    expect(updates).toBe(1);
    const state = useAgent.getState();
    expect(state.entries[0]!.text.endsWith("198 199 ")).toBe(true);
    expect(state.entries[1]).toBe(tool);
    expect(state.running).toBe(false);
  });

  it("goes on its own within a frame, or a tenth of a second where frames stop (a hidden tab)", async () => {
    const { applyAgentEvent, useAgent } = await import("./agent");
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [] });
    applyAgentEvent({ project: "p1", event: "status", running: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(useAgent.getState().running).toBe(false);
  });

  it("shows a message as it's sent until the chat has it, and says why when it's refused (its words go back in the composer)", async () => {
    const { sendToAgent, applyAgentEvent, flushAgentEvents, useAgent } = await import("./agent");
    const { sending } = await import("./sentNow");
    fetchRetrying.mockReset();
    let refuse = false;
    fetchRetrying.mockImplementation(async () => (refuse ? new Response(JSON.stringify({ error: "the agent is still working" }), { status: 409 }) : new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })));
    useAgent.setState({ project: "p1", loaded: true, running: false, entries: [] });
    expect(await sendToAgent("make it shorter")).toBe(true);
    expect(sending("p1", useAgent.getState().entries)).toBe(true);
    expect(useAgent.getState().running).toBe(true);
    applyAgentEvent({ project: "p1", event: "entry", entry: { id: "user-1", kind: "user", text: "make it shorter", at: Date.now() } });
    flushAgentEvents();
    expect(sending("p1", useAgent.getState().entries)).toBe(false);
    refuse = true;
    expect(await sendToAgent("and louder")).toBe(false);
    expect(sending("p1", useAgent.getState().entries)).toBe(false);
    expect(useAgent.getState().entries.map((entry) => [entry.kind, entry.text])).toEqual([["user", "make it shorter"], ["error", "the agent is still working"]]);
    expect(useAgent.getState().running).toBe(false);
  });
});

describe("a chat that can't be read", () => {
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    vi.resetModules();
    fetchRetrying.mockReset();
  });

  it("says so until it's read, and Stop waits for the server's answer, throws a refusal and reads the chat again", async () => {
    const { openAgent, stopAgent, useAgent } = await import("./agent");
    let down = true;
    let stopRefused = false;
    fetchRetrying.mockImplementation(async (url: string) => {
      if (down) throw new Error("Can't reach Edit's server");
      if (url.endsWith("/stop")) return stopRefused ? response({ error: "nothing is running" }, 409) : response({ ok: true });
      if (url === "/api/agent") return response({ ready: true, provider: "claude" });
      if (url === "/api/agent/models") return response({ models: [] });
      return response({ entries: [{ id: "u", kind: "user", text: "hi" }], running: false, queue: [] });
    });
    await openAgent("p1");
    expect(useAgent.getState().loaded).toBe(true);
    expect(useAgent.getState().status).toBeNull();
    expect((useAgent.getState().failed as Error).message).toBe("Can't reach Edit's server");
    down = false;
    await openAgent("p1");
    expect(useAgent.getState().failed).toBeNull();
    expect(useAgent.getState().entries.map((entry) => entry.text)).toEqual(["hi"]);
    stopRefused = true;
    const reads = fetchRetrying.mock.calls.length;
    await expect(stopAgent()).rejects.toThrow("nothing is running");
    expect(fetchRetrying.mock.calls.slice(reads).map(([url]) => url)).toContain("/api/projects/p1/agent");
  });
});

describe("an Edit V2 chat's queue, kept on the server", () => {
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const waiting = { id: "queued-1", text: "make it red", at: 1, playhead: 120 };

  beforeEach(() => {
    vi.resetModules();
    fetchRetrying.mockReset();
  });

  it("a message sent while the turn runs shows in the queue, not the conversation, and the turn goes on", async () => {
    const { sendToAgent, useAgent } = await import("./agent");
    const { sending } = await import("./sentNow");
    fetchRetrying.mockImplementation(async () => response({ ok: true, queued: waiting }));
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [{ id: "u", kind: "user", text: "make the board" }], queue: [] });
    await sendToAgent("make it red", 120, [], true);
    expect(JSON.parse(String(fetchRetrying.mock.calls[0]![1]!.body))).toEqual({ text: "make it red", playhead: "120" });
    expect(sending("p1", useAgent.getState().entries)).toBe(false);
    expect(useAgent.getState().entries.map((entry) => entry.text)).toEqual(["make the board"]);
    expect(useAgent.getState().queue).toEqual([waiting]);
    expect(useAgent.getState().running).toBe(true);
  });

  it("follows the server's queue events, and a new chat clears it", async () => {
    const { applyAgentEvent, flushAgentEvents, useAgent } = await import("./agent");
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [], queue: [] });
    applyAgentEvent({ project: "p1", event: "queue", queue: [waiting] });
    applyAgentEvent({ project: "other", event: "queue", queue: [] });
    flushAgentEvents();
    expect(useAgent.getState().queue).toEqual([waiting]);
    applyAgentEvent({ project: "p1", event: "reset" });
    flushAgentEvents();
    expect(useAgent.getState().queue).toEqual([]);
  });

  it("cancel and steer take the message out at once and ask the server", async () => {
    const { cancelQueued, steerQueued, useAgent } = await import("./agent");
    fetchRetrying.mockImplementation(async () => response({ ok: true }));
    const second = { ...waiting, id: "queued-2", text: "then a stamp" };
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [], queue: [waiting, second] });
    await cancelQueued("queued-1");
    expect(fetchRetrying.mock.calls.at(-1)).toEqual(["/api/projects/p1/agent/queue/queued-1/cancel", { method: "POST" }]);
    expect(useAgent.getState().queue).toEqual([second]);
    await steerQueued("queued-2");
    expect(fetchRetrying.mock.calls.at(-1)).toEqual(["/api/projects/p1/agent/queue/queued-2/steer", { method: "POST" }]);
    expect(useAgent.getState().queue).toEqual([]);
  });

  it("a refused steer says why and reads the chat again", async () => {
    const { steerQueued, useAgent } = await import("./agent");
    fetchRetrying.mockImplementation(async (url: string) => {
      if (url.endsWith("/steer")) return response({ error: "that message isn't queued any more" }, 400);
      if (url === "/api/agent") return response({ ready: true, provider: "claude" });
      if (url === "/api/agent/models") return response({ models: [] });
      return response({ entries: [], running: true, queue: [] });
    });
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [], queue: [waiting] });
    await expect(steerQueued("queued-1")).rejects.toThrow("that message isn't queued any more");
    expect(fetchRetrying.mock.calls.some(([url]) => url === "/api/projects/p1/agent")).toBe(true);
  });
});
