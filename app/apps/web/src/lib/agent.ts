// The agent chat: the user's Claude Code, through Edit's server (apps/server/src/agent.ts). Edit picks the model.

import { create } from "zustand";

import { fetchRetrying } from "./api";
import type { ChatFile, FileKind } from "./chatFiles";
import { perFrame } from "./frame";
import { dropSent, holdSent, sending } from "./sentNow";
import type { ProjectFile } from "./upload";
import { readSetting, writeSetting } from "./storage";

export interface AgentEntry {
  id: string;
  /** "subagent": a sub-agent's card (its chat key in `detail`), opened to view its own chat. */
  /** "thinking": a reasoning block. `status` "running" while it is still being written. */
  /** "compact": Claude Code compacting the conversation; `detail` its sizes, {pre, post} tokens, once done. */
  kind: "user" | "assistant" | "tool" | "error" | "subagent" | "thinking" | "compact";
  text: string;
  tool?: string;
  status?: "running" | "done" | "failed" | "stopped";
  /** Tool arguments (JSON) for the expanded view. */
  detail?: string;
  at?: number;
  updated?: number;
  /** A person's message: the files attached to it (the server's chat_attachments.ts), shown above it. */
  attachments?: { name: string; kind: FileKind; media?: string; file?: string; url?: string | null }[];
  /** A person's message: the id this page sent it with (`sendToAgent`). */
  send_id?: string;
}

/** A message sent while an Edit V2 turn runs, waiting on the server for it to end (the server's agent.ts `Queued`): Steer or Cancel. */
export interface QueuedMessage {
  id: string;
  text: string;
  at: number;
  playhead: number | null;
  attachments?: AgentEntry["attachments"];
  send_id?: string;
}

export type AgentProvider = "claude";

export interface AgentStatus {
  ready: boolean;
  /** Where the agent runs: the user's Claude Code. */
  provider?: AgentProvider;
  /** The Claude account signed in, and its plan ("Claude Max", "API key"). */
  email?: string;
  plan?: string;
  /** "missing" (not installed), "logged_out" or "ready". */
  state?: "missing" | "logged_out" | "ready" | ClaudeSupport["phase"];
  error?: string;
  path?: string;
  version?: string | null;
}

export interface ClaudeSupport {
  phase: "idle" | "updating" | "checking" | "signing_in" | "ready" | "needs_login" | "error";
  message: string;
  error: string | null;
  url: string | null;
  path: string | null;
  version: string | null;
  checkedAt: number | null;
  checks: { name: string; ok: boolean; detail: string }[];
}
export const useClaudeSupport = create<{ status: ClaudeSupport | null; error: string | null }>(() => ({ status: null, error: null }));
export const claudeBusy = (status: ClaudeSupport | null) => Boolean(status && ["updating", "checking", "signing_in"].includes(status.phase));

let supportWatchers = 0;
let supportTimer: ReturnType<typeof setTimeout> | undefined;
let supportFlight: Promise<void> | null = null;

export function refreshClaudeSupport(): Promise<void> {
  if (supportFlight) return supportFlight;
  const flight = (async () => {
    const before = useClaudeSupport.getState().status?.phase;
    const wasReady = useAgent.getState().status?.ready;
    const status = await json<ClaudeSupport>(await fetchRetrying("/api/agent/claude"));
    useClaudeSupport.setState({ status, error: null });
    const agent = await json<AgentStatus>(await fetchRetrying("/api/agent"));
    useAgent.setState({ status: agent });
    if (before !== status.phase || !wasReady) {
      if (status.phase === "ready") {
        const project = useAgent.getState().project;
        if (project) await openAgent(project);
      }
    }
  })().catch((error: unknown) => useClaudeSupport.setState({ error: error instanceof Error ? error.message : String(error) })).finally(() => {
    if (supportFlight === flight) supportFlight = null;
  });
  supportFlight = flight;
  return flight;
}

/** All setup cards share one poll; GET observes state and never runs a diagnosis. */
export function watchClaudeSupport() {
  supportWatchers++;
  if (supportWatchers === 1) void pollClaudeSupport();
  return () => { supportWatchers--; if (!supportWatchers) clearTimeout(supportTimer); };
}

async function pollClaudeSupport() {
  await refreshClaudeSupport();
  clearTimeout(supportTimer);
  if (supportWatchers) supportTimer = setTimeout(() => void pollClaudeSupport(), claudeBusy(useClaudeSupport.getState().status) ? 1000 : 15_000);
}

export async function setupClaude(action: "diagnose" | "repair" | "login" | "cancel") {
  try {
    const status = await json<ClaudeSupport>(await fetchRetrying("/api/agent/claude", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
    }));
    useClaudeSupport.setState({ status, error: null });
    await refreshClaudeSupport();
    clearTimeout(supportTimer);
    if (supportWatchers) supportTimer = setTimeout(() => void pollClaudeSupport(), 1000);
  } catch (error) {
    useClaudeSupport.setState({ error: error instanceof Error ? error.message : String(error) });
  }
}

interface AgentState {
  status: AgentStatus | null;
  project: string | null;
  /** This project's chat has been fetched (until then show nothing, not the empty state). */
  loaded: boolean;
  entries: AgentEntry[];
  running: boolean;
  /** Last streamed or changed moment, so "Thinking" only shows after a quiet spell. */
  activityAt: number;
  /** The model Edit runs the agent on ("Opus 5.5"), shown in the composer; it isn't chosen there. */
  modelName: string | null;
  /** Who answers this project's next turn: Opus while the edit is built, then the model menu's pick for its revisions (the server's `model_name`). */
  chatModel: string | null;
  /** The next turn is a revision, so the model menu offers the pick (the server's `revising`). */
  revising: boolean;
  /** A sub-agent's chat being viewed in place of the main one (the fresh-eyes pass): Back returns. */
  sub: SubChat | null;
  /** Edit V2: the messages waiting on the server for the running turn to end, in order (empty elsewhere). */
  queue: QueuedMessage[];
  /** Why this project's chat couldn't be read (null once it is): the panel says so, with Try again. */
  failed: unknown;
}

/** A sub-agent's chat: its key (`<project>~<name>`), title and conversation. */
export interface SubChat {
  key: string;
  name: string;
  title: string;
  entries: AgentEntry[];
  running: boolean;
  loaded: boolean;
}

export const useAgent = create<AgentState>(() => ({
  status: null,
  project: null,
  loaded: false,
  entries: [],
  running: false,
  activityAt: 0,
  modelName: readSetting("edit.agent.modelName"),
  chatModel: null,
  revising: false,
  sub: null,
  queue: [],
  failed: null,
}));

/** Opens a sub-agent's chat from its card in the main chat. */
export async function openSub(card: AgentEntry) {
  const project = useAgent.getState().project;
  const key = card.detail ?? "";
  const name = key.split("~")[1] ?? "";
  if (!project || !key.startsWith(`${project}~`) || !/^[a-z]+$/.test(name)) return;
  useAgent.setState({ sub: { key, name, title: card.text, entries: [], running: card.status === "running", loaded: false } });
  try {
    const chat = await json<{ entries: AgentEntry[]; running: boolean }>(await fetchRetrying(`/api/projects/${project}/agent?chat=${name}`));
    if (useAgent.getState().sub?.key !== key) return;
    useAgent.setState((state) => ({ sub: state.sub && { ...state.sub, entries: chat.entries, running: chat.running, loaded: true } }));
  } catch (error) {
    useAgent.setState((state) => ({ sub: state.sub && { ...state.sub, loaded: true, entries: [{ id: "load", kind: "error", text: (error as Error).message }] } }));
  }
}

/** Back to the main chat. */
export const closeSub = () => useAgent.setState({ sub: null });

/**
 * Asks the server to stop a turn and waits for its answer, then reads the
 * chat again either way, so what shows is whether it stopped, not that Stop
 * was pressed. A refusal (or no answer) is thrown for the panel to say.
 */
async function stopTurn(project: string, chat?: string): Promise<void> {
  let refused: unknown = null;
  try {
    await json(await fetchRetrying(`/api/projects/${project}/agent/stop${chat === undefined ? "" : `?chat=${chat}`}`, { method: "POST" }));
  } catch (error) {
    refused = error;
  }
  if (useAgent.getState().project === project) {
    if (chat === undefined) await openAgent(project);
    else {
      const key = useAgent.getState().sub?.key;
      const read = await fetchRetrying(`/api/projects/${project}/agent?chat=${chat}`)
        .then((response) => json<{ entries: AgentEntry[]; running: boolean }>(response))
        .catch(() => null);
      if (read !== null && key !== undefined) useAgent.setState((state) => (state.sub?.key === key ? { sub: { ...state.sub, entries: read.entries, running: read.running } } : {}));
    }
  }
  if (refused !== null) throw refused;
}

/** Stops the sub-agent being viewed. */
export const stopSub = async () => {
  const { project, sub } = useAgent.getState();
  if (project && sub) await stopTurn(project, sub.name);
};

/** The name of the model Edit runs turns on (the server's default: the panel sends none). */
async function loadModelName() {
  const { models } = await json<{ models: { name: string; is_default: boolean }[] }>(await fetchRetrying("/api/agent/models"));
  const name = models.find((model) => model.is_default)?.name ?? null;
  if (name === null) return;
  writeSetting("edit.agent.modelName", name);
  useAgent.setState({ modelName: name });
}

/** Chats already seen this session, so reopening the panel or a project is instant. */
const chats = new Map<string, { entries: AgentEntry[]; running: boolean; chatModel?: string | null; revising?: boolean; queue?: QueuedMessage[] }>();
let openedSerial = 0;

const json = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body as T;
};

/** Shows this project's chat (instantly if seen before), then refreshes it quietly. */
export async function openAgent(project: string) {
  const serial = ++openedSerial;
  events.flush();
  const state = useAgent.getState();
  if (state.project !== project) {
    const cached = chats.get(project);
    useAgent.setState({ project, loaded: Boolean(cached), entries: cached?.entries ?? [], running: cached?.running ?? false, chatModel: cached?.chatModel ?? null, revising: cached?.revising ?? false, sub: null, queue: cached?.queue ?? [], failed: null });
  } else if (state.failed !== null) {
    // Tried again: the chat's wait shows, not the failure.
    useAgent.setState({ failed: null, loaded: state.entries.length > 0 });
  }
  let failure: unknown = null;
  const [status, chat] = await Promise.all([
    fetchRetrying("/api/agent").then((response) => json<AgentStatus>(response)),
    fetchRetrying(`/api/projects/${project}/agent`).then((response) =>
      json<{ entries: AgentEntry[]; running: boolean; model_name?: string; revising?: boolean; queue?: QueuedMessage[] }>(response),
    ),
  ]).catch((error: unknown) => {
    failure = error;
    return [null, null] as const;
  });
  if (useAgent.getState().project !== project || serial !== openedSerial) return;
  if (!status || !chat) {
    useAgent.setState({ loaded: true, failed: failure ?? new Error("Can't reach Edit's server") });
    return;
  }
  events.flush();
  useAgent.setState({
    status,
    loaded: true,
    entries: chat.entries,
    // A message still on its way (sentNow.ts) is a turn about to start.
    running: chat.running || sending(project, chat.entries),
    chatModel: chat.model_name ?? null,
    revising: chat.revising === true,
    queue: chat.queue ?? [],
    failed: null,
  });
  if (status.ready) loadModelName().catch(() => {});
}

/**
 * The ids of messages whose send got no answer, by project and words: the
 * words go back in the composer, and sent again they go with the same id, so
 * the server takes them once even if the first send did reach it.
 */
const unanswered = new Map<string, string>();

/**
 * Whether the message sent with `sendId` is in the project's chat after all
 * (its answer lost to the connection, not the server refusing it): the chat
 * read again, once the server answers (a restart waited out), and shown.
 * Null when the server still doesn't answer.
 */
async function landed(project: string, sendId: string): Promise<boolean | null> {
  const chat = await fetchRetrying(`/api/projects/${project}/agent`)
    .then((response) => json<{ entries: AgentEntry[]; queue?: QueuedMessage[] }>(response))
    .catch(() => null);
  if (chat === null) return null;
  const queued = (chat.queue ?? []).some((one) => one.send_id === sendId);
  if (!queued && !chat.entries.some((one) => one.send_id === sendId)) return false;
  if (useAgent.getState().project === project) {
    // Queued: shown in the queue, not the conversation.
    if (queued) dropSent(project);
    await openAgent(project);
  }
  return true;
}

/**
 * `playhead`: the editor's frame when the message was written, so the agent
 * starts there. `files`: what's attached, already in the project (the chat's
 * uploader); pictures reach the model as pictures. `queues`: an Edit V2 chat,
 * where a message sent while the turn runs waits in the server's queue (shown
 * above the composer, not in the conversation) until it ends. Answers whether
 * it went: false puts the words and files back in the composer (ChatComposer).
 */
export async function sendToAgent(text: string, playhead?: number, files: ChatFile[] = [], queues = false): Promise<boolean> {
  const state = useAgent.getState();
  if (!state.project) return false;
  const project = state.project;
  const attachments = files.map((one) => {
    const landed = (one.landed ?? {}) as ProjectFile;
    return { name: one.name, kind: one.kind, ...(landed.media === undefined ? {} : { media: landed.media }), ...(landed.file === undefined ? {} : { file: landed.file }) };
  });
  events.flush();
  const shown = files.map((one, index) => ({ ...attachments[index]!, url: one.kind === "image" ? one.preview : null }));
  const queueing = queues && useAgent.getState().running;
  const words = `${project}\n${text}`;
  const sendId = unanswered.get(words) ?? Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  unanswered.delete(words);
  // Show the message now (sentNow.ts); the server's copy takes its place when it arrives. A queued one shows in the queue instead.
  if (!queueing) {
    holdSent(project, useAgent.getState().entries, text, shown);
    useAgent.setState({ running: true, activityAt: Date.now() });
  }
  try {
    const response = await fetchRetrying(`/api/projects/${project}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        ...(playhead === undefined ? {} : { playhead: String(Math.round(playhead)) }),
        ...(attachments.length === 0 ? {} : { attachments: JSON.stringify(attachments) }),
        send_id: sendId,
      }),
    }).catch(async () => {
      // No answer: the server may have taken it before the connection went. The chat says.
      const there = await landed(project, sendId);
      if (there === true) return null;
      unanswered.set(words, sendId);
      throw new Error(there === null ? "Can't reach Edit's server. Send your message again once it's back." : "Your message didn't reach Edit's server. Send it again.");
    });
    if (response === null) return true;
    const answer = await json<{ queued?: QueuedMessage }>(response);
    const queued = answer.queued;
    // Queued after all (the turn was still running), or before its event: shown in the queue, never twice.
    if (queued !== undefined) {
      dropSent(project);
      useAgent.setState((current) => (current.project !== project || current.queue.some((one) => one.id === queued.id) ? {} : { queue: [...current.queue, queued], running: true }));
    }
    return true;
  } catch (error) {
    // Refused or the server down: the words go back in the composer (the caller's), and the chat says why (a turn
    // still running goes on). Never a copy of the message only this page holds: reading the chat again would lose it.
    const now = Date.now();
    dropSent(project);
    useAgent.setState((current) =>
      current.project !== project ? {} : { running: queueing && current.running, entries: [...current.entries, { id: `local-${now}`, kind: "error", text: (error as Error).message }] },
    );
    return false;
  }
}

/** Stops this project's turn (awaited: a refusal throws, the chat read again either way). */
export const stopAgent = async () => {
  const project = useAgent.getState().project;
  if (project) await stopTurn(project);
};

/** Takes a queued message out (shown gone at once, back if the server refuses). */
export async function cancelQueued(id: string): Promise<void> {
  await leaveQueue(id, "cancel");
}

/** Steer: the running turn stops and this queued message goes in its place, in the same conversation; the rest wait. */
export async function steerQueued(id: string): Promise<void> {
  await leaveQueue(id, "steer");
}

async function leaveQueue(id: string, how: "cancel" | "steer"): Promise<void> {
  const { project, queue } = useAgent.getState();
  if (!project) return;
  useAgent.setState({ queue: queue.filter((one) => one.id !== id) });
  try {
    await json(await fetchRetrying(`/api/projects/${project}/agent/queue/${encodeURIComponent(id)}/${how}`, { method: "POST" }));
  } catch (error) {
    // The server's queue as it is: the event said so already, or the chat is read again.
    if (useAgent.getState().project === project) void openAgent(project);
    throw error;
  }
}

type AgentEvent = { project: string; event: string; [key: string]: unknown };

/** The chat with one event from the server applied (nothing when it isn't this chat's). */
function reduce(state: AgentState, event: AgentEvent, now: number): AgentState {
  // The sub-agent being viewed has its own chat (the main one's card follows its own events).
  if (state.sub !== null && event.project === state.sub.key) {
    const sub = state.sub;
    if (event.event === "entry") {
      const entry = event.entry as AgentEntry;
      const entries = sub.entries.some((existing) => existing.id === entry.id) ? sub.entries.map((existing) => (existing.id === entry.id ? { ...entry, text: entry.text || existing.text } : existing)) : [...sub.entries, entry];
      return { ...state, sub: { ...sub, entries }, activityAt: now };
    }
    if (event.event === "delta") return { ...state, sub: { ...sub, entries: sub.entries.map((entry) => (entry.id === event.id ? { ...entry, text: entry.text + String(event.text) } : entry)) }, activityAt: now };
    if (event.event === "status") return { ...state, sub: { ...sub, running: Boolean(event.running) }, activityAt: now };
    if (event.event === "reset") return { ...state, sub: { ...sub, entries: [], running: false } };
    return state;
  }
  if (event.project !== state.project) return state;
  switch (event.event) {
    case "entry": {
      const entry = event.entry as AgentEntry;
      const entries = state.entries.some((existing) => existing.id === entry.id)
        ? state.entries.map((existing) => (existing.id === entry.id ? { ...entry, text: entry.text || existing.text } : existing))
        : [...state.entries, entry];
      return { ...state, entries, activityAt: now };
    }
    case "delta":
      return { ...state, activityAt: now, entries: state.entries.map((entry) => (entry.id === event.id ? { ...entry, text: entry.text + String(event.text) } : entry)) };
    case "status":
      return { ...state, running: Boolean(event.running), activityAt: now };
    case "reset":
      return { ...state, entries: [], running: false, queue: [] };
    case "queue":
      return { ...state, queue: Array.isArray(event.queue) ? (event.queue as QueuedMessage[]) : [] };
    case "model":
      return { ...state, chatModel: typeof event.model_name === "string" ? event.model_name : null, revising: event.revising === true };
  }
  return state;
}

/** Events heard since the last frame, applied together. */
let heard: AgentEvent[] = [];
const events = perFrame(() => {
  const batch = heard;
  heard = [];
  if (batch.length === 0) return;
  const before = useAgent.getState();
  const now = Date.now();
  const after = batch.reduce((state, event) => reduce(state, event, now), before);
  if (after === before) return;
  useAgent.setState(after, true);
  if (after.project !== null) chats.set(after.project, { entries: after.entries, running: after.running, chatModel: after.chatModel, revising: after.revising, queue: after.queue });
});

/**
 * Live events from the server (see store.ts connectEvents), applied once a
 * frame: a turn's words stream in as hundreds of messages, and a store update
 * for each re-rendered the chat for each, back to back, until React took it
 * for a loop and gave up (#185 as turns ended: 71 on Marc's Mac, Nov 6-8).
 */
export function applyAgentEvent(event: AgentEvent) {
  if (event.event === "claude") {
    useClaudeSupport.setState({ status: event.support as ClaudeSupport, error: null });
    void refreshClaudeSupport();
    return;
  }
  heard.push(event);
  events.schedule();
}

/** Applies the events heard so far now (tests, and anything about to read the chat). */
export const flushAgentEvents = () => events.flush();

// Remember every loaded chat (including optimistic sends) for instant reopening.
useAgent.subscribe((state) => {
  if (state.project && state.loaded) chats.set(state.project, { entries: state.entries, running: state.running, chatModel: state.chatModel, revising: state.revising, queue: state.queue });
});
