// Home's Done (Oct 31 2026): what someone marked done by hand, the team's
// (the server's later.ts, mamagi's editLater): it leaves its list for Done
// until someone moves it back. Approved edits and ideas are in Done by
// themselves. Later's setting aside, which shared these rows, went on Nov 18
// (Sphe).

import type { LaterEntry, LaterKey } from "@edit/types/later";
import { useCallback, useEffect } from "react";

import { useAccount } from "./account";
import { useKept } from "./kept";
import { useEditor } from "./store";

export type DoneEntry = LaterEntry;
export type DoneKey = LaterKey;

const KEY = /^(edit|script|idea|card):[A-Za-z0-9_-]{1,120}$/;

/** `kind:id` as Done names it, or null for an id it can't take. */
export function doneKey(kind: "edit" | "script" | "idea" | "card", id: string): DoneKey | null {
  const key = `${kind}:${id}`;
  return KEY.test(key) ? (key as DoneKey) : null;
}

async function call(body?: unknown): Promise<unknown> {
  const response = await fetch("/api/later", body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `HTTP ${response.status}`);
  return answer;
}

export interface Done {
  /** What's marked done, by key. */
  entries: Map<string, DoneEntry>;
  /** Done can be used (signed in: it's the team's, in the cloud). */
  on: boolean;
  /** Marks `key` done (`title` names it in the toast), with Undo. */
  mark: (key: DoneKey, title: string) => void;
  /** Moves `key` back out of Done, with Undo. */
  moveBack: (key: DoneKey, title: string) => void;
}

/** Done, polled now and then (another computer marks something), changed here at once. */
export function useDone(): Done {
  const [entries, setEntries] = useKept<DoneEntry[]>("home.done", []);
  const account = useAccount((state) => state.account);
  const on = account?.signed_in === true || account?.required === false;
  const refresh = useCallback(() => {
    void call()
      .then((answer) => setEntries((answer as { entries: DoneEntry[] }).entries.filter((entry) => entry.done === true)))
      .catch(() => {});
  }, [setEntries]);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const change = (key: DoneKey, entry: DoneEntry | null) => setEntries((all) => [...all.filter((one) => one.key !== key), ...(entry ? [entry] : [])]);
  const save = (key: DoneKey, entry: DoneEntry | null, before: DoneEntry | null, doing: string) => {
    change(key, entry);
    void call(entry === null ? { key, back: true } : { key, done: true })
      .then(refresh)
      .catch((error: unknown) => {
        change(key, before);
        useEditor.getState().toastError(error, doing);
      });
  };
  const mark = (key: DoneKey, title: string) => {
    const person = useAccount.getState().account?.person ?? null;
    const entry: DoneEntry = { key, until: null, done: true, at: Date.now(), by: person === null ? null : { sub: person.sub ?? "", name: person.name || person.email, picture: person.image } };
    save(key, entry, null, `mark “${title}” done`);
    useEditor.getState().toast(`“${title}” is in Done`, "info", { label: "Undo", run: () => save(key, null, entry, `move “${title}” back`) });
  };
  const moveBack = (key: DoneKey, title: string) => {
    const before = entries.find((one) => one.key === key) ?? null;
    if (before === null) return;
    save(key, null, before, `move “${title}” back`);
    useEditor.getState().toast(`“${title}” is back in its list`, "info", { label: "Undo", run: () => save(key, before, null, `mark “${title}” done`) });
  };
  return { entries: new Map(entries.map((entry) => [entry.key, entry])), on, mark, moveBack };
}
