// When this person last opened each edit, script and idea (the server's
// seen.ts, mamagi's editSeen; Home's New and Changed, lib/seen-status.ts).
// Marked as one is opened, every minute while it stays open and on screen,
// and as it's left (closing the window too), so what changes while it's open
// is the person's and never comes back to them as Changed. Theirs on every
// computer, never a teammate's. A mark that doesn't go through is dropped
// quietly: Home then shows a little more, never an error.

import { create } from "zustand";

import { onPath } from "./route";

/** What Home knows of the marks: `on` false while they can't be read (signed out, or a cloud without them yet). */
export const useSeen = create<{ on: boolean; seen: Record<string, number> }>(() => ({ on: false, seen: {} }));

/** An open thing's mark is kept this fresh while it's on screen. */
const AGAIN_MS = 60_000;

/** Reads the marks again (Home's refresh); one that doesn't answer leaves the last. */
export async function loadSeen(): Promise<void> {
  try {
    const response = await fetch("/api/seen");
    if (!response.ok) return;
    const answer = (await response.json()) as { on?: unknown; seen?: unknown };
    const seen = typeof answer.seen === "object" && answer.seen !== null ? (answer.seen as Record<string, number>) : {};
    // Marks made here since the list was read stay (the cloud has them a moment later).
    useSeen.setState((state) => ({ on: answer.on === true, seen: { ...seen, ...Object.fromEntries(Object.entries(state.seen).filter(([key, at]) => at > (seen[key] ?? 0))) } }));
  } catch {
    // The server not answering: Home says so elsewhere.
  }
}

/** Marks `key` seen now, here at once and in the cloud; `leaving`: the window may close before it's sent. */
export function markSeen(key: string, leaving = false): void {
  const at = Date.now();
  useSeen.setState((state) => ({ seen: { ...state.seen, [key]: Math.max(at, state.seen[key] ?? 0) } }));
  void fetch("/api/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, at }), keepalive: leaving }).catch(() => {});
}

/** The mark an address opens: an edit's, a script's or an idea's (null: none). */
export function seenKeyOf(path: string): string | null {
  const edit = /^\/p\/([\w-]+)/u.exec(path)?.[1];
  if (edit !== undefined) return `edit:${edit}`;
  const script = /^\/scripts\/([0-9a-f-]+)$/iu.exec(path)?.[1];
  if (script !== undefined) return `script:${script}`;
  const idea = /^\/ideas\/([\w-]+)/u.exec(path)?.[1];
  return idea !== undefined ? `idea:${idea}` : null;
}

/** Marks what's open as it's opened, while it stays open, and as it's left (App, on every screen); returns how to stop. */
export function watchSeen(): () => void {
  let open = seenKeyOf(location.pathname);
  if (open !== null) markSeen(open);
  const stop = onPath(() => {
    const now = seenKeyOf(location.pathname);
    if (now === open) return;
    if (open !== null) markSeen(open);
    open = now;
    if (open !== null) markSeen(open);
  });
  const timer = setInterval(() => {
    if (open !== null && !document.hidden) markSeen(open);
  }, AGAIN_MS);
  // Hidden (another window over it, the lid closed) or closed: as left.
  const away = () => {
    if (open !== null && document.visibilityState === "hidden") markSeen(open, true);
  };
  const closing = () => {
    if (open !== null) markSeen(open, true);
  };
  document.addEventListener("visibilitychange", away);
  window.addEventListener("pagehide", closing);
  return () => {
    stop();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", away);
    window.removeEventListener("pagehide", closing);
  };
}
