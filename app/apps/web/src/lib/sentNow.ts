// A message shows the moment it's sent, and stays (Sphe, Nov 4: "when you send
// a prompt it should show up instantly"; Nov 17: "optimistic updates", never
// vanishing or doubling). One rule for every chat: the editor's, an idea's, a
// thumbnail's. Each message sent has its own client id; it shows (in the
// conversation, or in the queue when it waits for the turn) until the chat has
// it, by that id where the chat keeps ids (the editor's `send_id`), else by
// its words in a message newer than any there when it was sent. A send that
// fails leaves the message where it was, saying so, with Retry and Edit; one
// that got no answer goes again by itself once Edit's server is back, with
// the same id, so the server takes it once.

import { useEffect, useMemo } from "react";
import { create } from "zustand";

import type { AgentEntry } from "./agent";
import type { ChatFile } from "./chatFiles";
import type { ChatQuote } from "./chatQuotes";
import { parseQuoted } from "./chatQuotes";

/** No answer from Edit's server (not a refusal): the message goes again once it's back. */
export class Unanswered extends Error {}

/** A send's answer: `queued`, it waits in the chat's queue for the running turn (Edit V2). */
export type Delivered = { queued?: boolean } | void;

export interface Pending {
  /** The client id: the editor's `send_id`. */
  id: string;
  /** The chat it shows in (the conversation's key: a project's id, `idea:<id>`, `thumbnail:<id>`). */
  chat: string;
  /** The composer its words go back to on Edit (its own `chat`). */
  composer: string;
  text: string;
  at: number;
  attachments?: AgentEntry["attachments"];
  files: ChatFile[];
  quotes: ChatQuote[];
  /** Shown in the queue above the composer, not the conversation. */
  queued: boolean;
  /** "sent": the server answered; it shows until the chat has it. */
  state: "sending" | "sent" | "failed";
  /** Why it didn't go, in plain words. */
  failure?: string;
  /** It got no answer: it goes again by itself once the server's back (`resends`). */
  offline: boolean;
  /** Taken out while still on its way (a queued one's ×): taken out on the server too once it's there. */
  cancelled: boolean;
  /** The newest of the person's messages when it was sent (the chat's clock), for chats without ids. */
  newest: number;
  /** The server takes the same id once, so sending it again is safe. */
  resends: boolean;
  deliver: (id: string) => Promise<Delivered>;
  /** Taken out on the server (a queued one cancelled while on its way). */
  cancel?: (id: string) => void;
}

const usePending = create<Record<string, Pending[] | undefined>>(() => ({}));
const NONE: Pending[] = [];

/** Words sent back to a composer (Edit on a message that didn't go), taken by the composer showing that chat. */
export interface Returned {
  words: string;
  files: ChatFile[];
  quotes: ChatQuote[];
}
const useReturned = create<Record<string, Returned[] | undefined>>(() => ({}));
export const useReturnedOf = (composer: string) => useReturned((state) => state[composer]);
export function takeReturned(composer: string): Returned[] {
  const given = useReturned.getState()[composer] ?? [];
  if (given.length > 0) useReturned.setState({ [composer]: undefined });
  return given;
}
export function returnToComposer(composer: string, given: Returned): void {
  useReturned.setState((state) => ({ [composer]: [...(state[composer] ?? []), given] }));
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");

const find = (id: string): Pending | undefined => Object.values(usePending.getState()).flatMap((list) => list ?? []).find((one) => one.id === id);

function change(id: string, patch: Partial<Pending>): Pending | undefined {
  const now = find(id);
  if (now === undefined) return undefined;
  const next = { ...now, ...patch };
  usePending.setState((state) => ({ [now.chat]: (state[now.chat] ?? []).map((one) => (one.id === id ? next : one)) }));
  return next;
}

function remove(id: string): Pending | undefined {
  const now = find(id);
  if (now !== undefined) usePending.setState((state) => ({ [now.chat]: (state[now.chat] ?? []).filter((one) => one.id !== id) }));
  return now;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Sends (or sends again) message `id`: it shows as sending, then sent, or failed with why. */
async function deliver(id: string): Promise<void> {
  const one = change(id, { state: "sending", failure: undefined, offline: false });
  if (one === undefined) return;
  try {
    const answer = await one.deliver(id);
    const queued = answer?.queued ?? one.queued;
    const now = change(id, { state: "sent", queued });
    // Taken out while on its way: out of the server's queue too, now that it's there.
    if (now?.cancelled && queued) {
      remove(id);
      now.cancel?.(id);
    }
  } catch (error) {
    if (find(id)?.cancelled) {
      remove(id);
      return;
    }
    change(id, { state: "failed", failure: messageOf(error), offline: error instanceof Unanswered });
  }
}

/** Shows a message in `chat` now and sends it; `entries` is the chat as it is, so its landing can be told. */
export function sendNow(
  chat: string,
  entries: AgentEntry[],
  given: {
    text: string;
    composer?: string;
    attachments?: AgentEntry["attachments"];
    files?: ChatFile[];
    quotes?: ChatQuote[];
    queued?: boolean;
    resends?: boolean;
    deliver: Pending["deliver"];
    cancel?: Pending["cancel"];
  },
): Pending {
  const one: Pending = {
    id: newId(),
    chat,
    composer: given.composer ?? chat,
    text: given.text,
    at: Date.now(),
    ...(given.attachments !== undefined && given.attachments.length > 0 ? { attachments: given.attachments } : {}),
    files: given.files ?? [],
    quotes: given.quotes ?? [],
    queued: given.queued === true,
    state: "sending",
    offline: false,
    cancelled: false,
    newest: newestAsked(entries),
    resends: given.resends === true,
    deliver: given.deliver,
    ...(given.cancel === undefined ? {} : { cancel: given.cancel }),
  };
  usePending.setState((state) => ({ [chat]: [...(state[chat] ?? []), one] }));
  void deliver(one.id);
  return one;
}

/** Retry: sent again, with the same id. */
export function retrySent(id: string): void {
  if (find(id)?.state === "failed") void deliver(id);
}

/** Edit: out of the chat (one still on its way taken out of the server's queue once there), its words, files and quotes back in its composer. */
export function editSent(id: string): void {
  const one = find(id);
  if (one === undefined) return;
  if (one.state === "sending") change(id, { cancelled: true });
  else remove(id);
  returnToComposer(one.composer, { words: parseQuoted(one.text).words, files: one.files, quotes: one.quotes });
}

/** One the server took whose copy the chat, read again, still doesn't show: the server's chat is what's so. */
export function forgetSent(id: string): void {
  if (find(id)?.state === "sent") remove(id);
}

/** A queued one's ×: gone now; one still on its way is taken out of the server's queue once it's there. */
export function cancelSent(id: string): void {
  const one = find(id);
  if (one === undefined) return;
  if (one.state === "sending") change(id, { cancelled: true });
  else remove(id);
}

/** The messages shown in `chat` that it doesn't have yet, in the order sent. */
export const usePendingOf = (chat: string) => usePending((state) => state[chat] ?? NONE);
export const pendingOf = (chat: string) => usePending.getState()[chat] ?? NONE;

/** The newest of the person's messages a chat holds (by its own clock). */
function newestAsked(entries: AgentEntry[]): number {
  return entries.reduce((latest, entry) => (entry.kind === "user" ? Math.max(latest, entry.at ?? 0) : latest), 0);
}

/**
 * The ids of `pending` the chat now has: its `send_id` in the conversation or
 * the queue; where the chat keeps no ids, a message of the person's newer than
 * any there when it was sent, with its words (or any such message, once the
 * server has answered), each claimed once.
 */
export function landedIds(pending: readonly Pending[], entries: readonly AgentEntry[], queue: readonly { send_id?: string }[] = []): Set<string> {
  const landed = new Set<string>();
  if (pending.length === 0) return landed;
  const ids = new Set<string>();
  for (const entry of entries) if (entry.send_id !== undefined) ids.add(entry.send_id);
  for (const one of queue) if (one.send_id !== undefined) ids.add(one.send_id);
  const loose = entries.filter((entry) => entry.kind === "user" && entry.send_id === undefined);
  const claimed = new Set<AgentEntry>();
  for (const one of pending) {
    if (ids.has(one.id)) {
      landed.add(one.id);
      continue;
    }
    if (one.resends) continue;
    const words = one.text.trim();
    const newer = loose.filter((entry) => !claimed.has(entry) && (entry.at ?? 0) > one.newest);
    const match = newer.find((entry) => entry.text.trim() === words) ?? (one.state === "sent" ? newer[0] : undefined);
    if (match !== undefined) {
      claimed.add(match);
      landed.add(one.id);
    }
  }
  return landed;
}

/** Drops what `chat` now has. */
export function settleSent(chat: string, entries: readonly AgentEntry[], queue?: readonly { send_id?: string }[]): void {
  const list = pendingOf(chat);
  if (list.length === 0) return;
  const landed = landedIds(list, entries, queue);
  if (landed.size > 0) usePending.setState((state) => ({ [chat]: (state[chat] ?? []).filter((one) => !landed.has(one.id)) }));
}

/** Whether `chat` has a message on screen in its conversation, on its way, it doesn't have yet (a turn about to start). */
export function sending(chat: string, entries: readonly AgentEntry[]): boolean {
  const list = pendingOf(chat).filter((one) => !one.queued && one.state !== "failed");
  if (list.length === 0) return false;
  const landed = landedIds(pendingOf(chat), entries);
  return list.some((one) => !landed.has(one.id));
}

/** A message on screen before its chat has it, as an entry: the same object while it doesn't change (TurnView skips it). */
const asEntries = new WeakMap<Pending, AgentEntry>();
function entryOf(one: Pending): AgentEntry {
  const made = asEntries.get(one);
  if (made !== undefined) return made;
  const entry: AgentEntry = {
    id: `sent-${one.id}`,
    kind: "user",
    text: one.text,
    at: one.at,
    updated: one.at,
    send_id: one.id,
    ...(one.attachments === undefined ? {} : { attachments: one.attachments }),
    ...(one.state === "sent" ? {} : { pending: one.state }),
    ...(one.failure === undefined ? {} : { failure: one.failure }),
    ...(one.offline ? { offline: true } : {}),
  };
  asEntries.set(one, entry);
  return entry;
}

/**
 * The chat's entries with what was sent and it doesn't have yet, at its end;
 * `queued`, those waiting in the queue (not yet in `queue`, the server's).
 * What lands is dropped. `send` shows a message and sends it.
 */
export function useSentNow(chat: string, entries: AgentEntry[], queue?: readonly { send_id?: string }[]) {
  const list = usePendingOf(chat);
  const landed = useMemo(() => landedIds(list, entries, queue), [list, entries, queue]);
  useEffect(() => {
    if (landed.size > 0) settleSent(chat, entries, queue);
  }, [chat, landed, entries, queue]);
  const waiting = useMemo(() => list.filter((one) => !landed.has(one.id) && !one.cancelled), [list, landed]);
  const shown = useMemo(() => {
    const extra = waiting.filter((one) => !one.queued);
    return extra.length === 0 ? entries : [...entries, ...extra.map(entryOf)];
  }, [entries, waiting]);
  return {
    entries: shown,
    sending: waiting.some((one) => !one.queued && one.state !== "failed"),
    queued: useMemo(() => waiting.filter((one) => one.queued), [waiting]),
    send: (given: Parameters<typeof sendNow>[2]) => sendNow(chat, entries, given),
  };
}

// Back from a restart or a dropped connection: what got no answer goes again, by itself (the server takes each id once).
if (typeof window !== "undefined") {
  window.addEventListener("edit:connected", () => {
    for (const list of Object.values(usePending.getState())) for (const one of list ?? []) if (one.state === "failed" && one.offline && one.resends) void deliver(one.id);
  });
}

/** Tests: every chat's messages forgotten. */
export function resetSent(): void {
  usePending.setState(() => ({}), true);
  useReturned.setState(() => ({}), true);
}
