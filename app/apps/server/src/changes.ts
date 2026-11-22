// Every change to a project, kept so the agent can undo any of them (Sphe,
// Nov 11: "an overall ability for the agent to undo changes"; "it must be able
// to"). The editor's ⌘Z is the person's, in their browser; this is the
// server's: each saved revision with when, who made it (the agent and which
// tool, the person, Edit by itself) and the patch that takes it back
// (patch.ts: only what changed). Undoing is a new revision, so an undo is
// itself undone the same way. Kept for the last MOST changes of a project, on
// disk beside it, so a restart forgets nothing.

import fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import type { Clip, Project } from "./model.ts";
import * as patches from "./patch.ts";
import { join } from "./paths.ts";
import { registerTool, text, handlerFor } from "./mcp/registry.ts";
import { agentCalls } from "./store.ts";
import * as thread from "./thread.ts";

/** Changes kept a project. */
const MOST = 300;

/** What says which kind of project it is, whose channel, that its removal waits to be asked (set with them by a move onto a channel), and where its footage lives: never changed by undo_changes. */
const IDENTITY = ["hq", "channel", "removal_held", "local_media"] as const;

export interface Change {
  rev: number;
  at: number;
  /** Who: "agent" (with its tool), "person", or Edit's own name for what it did ("effects", "cloud"…). */
  by: string;
  tool?: string;
  /** What changed, in a line. */
  what: string;
  /** Takes this change back. */
  undo: patches.Patch;
  /** What it changed (the patch's ids and fields), to tell when a later change touched the same things. */
  touched: string[];
}

const kept = new Map<string, Change[]>();
/**
 * Changes saved this run to a project whose kept changes aren't read yet: added to the end of its file, and to its list
 * once that's read. Read on the first change after a start, a big project's file held the server's thread (Nov 22, the
 * Linux prod Edit: 185 and 168 MB, 0.8 s each, at every start); now it's read when something asks for its changes, or
 * a line at a time off to the side once LOAD_AFTER have been saved, to cut it to the last MOST.
 */
const unread = new Map<string, Change[]>();
const LOAD_AFTER = 50;
const loading = new Set<string>();

function file(app: App, id: string): string {
  return join(app.store.home, "projects", "changes", `${id}.jsonl`);
}

/** The changes in a file's text, a line each; a line cut short by a crash is passed over. */
function parsed(text: string): Change[] {
  const list: Change[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      list.push(JSON.parse(line) as Change);
    } catch {
      // A line cut short by a crash: the rest are kept.
    }
  }
  return list;
}

/** What was read, with what this run saved that it may not have had yet (by rev, once each), the last MOST. */
function settle(id: string, read: Change[]): Change[] {
  const revs = new Set(read.map((one) => one.rev));
  const list = [...read, ...(unread.get(id) ?? []).filter((one) => !revs.has(one.rev))].sort((a, b) => a.rev - b.rev).slice(-MOST);
  unread.delete(id);
  kept.set(id, list);
  return list;
}

/** A project's changes, oldest first (read from disk once). */
function changesOf(app: App, id: string): Change[] {
  const list = kept.get(id);
  if (list !== undefined) return list;
  let text = "";
  try {
    text = fs.readFileSync(file(app, id), "utf8");
  } catch {
    // None kept yet.
  }
  return settle(id, parsed(text));
}

/** Reads a project's changes off to the side: the file read without waiting on it, each line parsed with a breath. */
async function loadAside(app: App, id: string): Promise<void> {
  if (loading.has(id) || kept.has(id)) return;
  loading.add(id);
  try {
    let text = "";
    try {
      text = await Bun.file(file(app, id)).text();
    } catch {
      // None kept yet.
    }
    const breathe = thread.breather();
    const read: Change[] = [];
    for (const line of text.split("\n")) {
      await breathe();
      if (line.trim() === "") continue;
      try {
        read.push(JSON.parse(line) as Change);
      } catch {
        // A line cut short by a crash.
      }
    }
    if (!kept.has(id)) settle(id, read);
  } finally {
    loading.delete(id);
  }
}

/** Whether the person or an agent changed `id` here (its kept changes: since Nov 11, the last MOST). */
export function workedIn(app: App, id: string): boolean {
  return changesOf(app, id).some((one) => one.by === "person" || one.by === "agent");
}

/** A change's patch as a line: what it added, changed and removed. */
function summary(forward: patches.Patch): string {
  const parts: string[] = [];
  for (const [name, list] of Object.entries(forward.lists)) {
    const bits = [list.put.length > 0 ? `${list.put.length} added or changed` : "", list.remove.length > 0 ? `${list.remove.length} removed` : "", list.order !== undefined && list.put.length === 0 && list.remove.length === 0 ? "reordered" : ""].filter(Boolean);
    if (bits.length > 0) parts.push(`${name}: ${bits.join(", ")}${list.put.length > 0 && list.put.length <= 3 ? ` (${list.put.map((item) => (item as { id?: string }).id).join(", ")})` : ""}`);
  }
  const fields = [...Object.keys(forward.set), ...forward.unset];
  if (fields.length > 0) parts.push(fields.join(", "));
  return parts.join("; ") || "nothing visible";
}

function record(app: App, id: string, before: Project, after: Project, rev: number, origin: string): void {
  const forward = patches.diff(before, after);
  if (patches.empty(forward)) return;
  const call = agentCalls.getStore();
  const agent = call?.active === true;
  const change: Change = {
    rev,
    at: Date.now(),
    // The editor's saves come as its connection ("ui-…"); Edit's own work as a word (effects, cloud, script…).
    by: agent ? "agent" : origin.startsWith("ui-") || origin === "" ? "person" : origin,
    ...(agent && call?.tool !== undefined ? { tool: call.tool } : {}),
    what: summary(forward),
    undo: patches.diff(after, before),
    touched: [...patches.touched(forward)],
  };
  const list = kept.get(id);
  if (list === undefined) {
    // Not read yet: added to the file's end, read when it's asked for (see `unread`).
    const waiting = unread.get(id) ?? [];
    waiting.push(change);
    unread.set(id, waiting);
    try {
      fs.mkdirSync(join(app.store.home, "projects", "changes"), { recursive: true });
      fs.appendFileSync(file(app, id), `${JSON.stringify(change)}\n`);
    } catch (error) {
      diag.warn("changes", `${id}: keeping a change: ${diag.messageOf(error)}`);
    }
    if (waiting.length >= LOAD_AFTER) void loadAside(app, id).catch((error: unknown) => diag.warn("changes", `${id}: reading its changes: ${diag.messageOf(error)}`));
    return;
  }
  list.push(change);
  if (list.length > MOST) list.splice(0, list.length - MOST);
  try {
    fs.mkdirSync(join(app.store.home, "projects", "changes"), { recursive: true });
    // Rewritten now and then to its last MOST, else one line added.
    if (list.length === MOST && rev % 50 === 0) fs.writeFileSync(file(app, id), list.map((one) => JSON.stringify(one)).join("\n") + "\n");
    else fs.appendFileSync(file(app, id), `${JSON.stringify(change)}\n`);
  } catch (error) {
    diag.warn("changes", `${id}: keeping a change: ${diag.messageOf(error)}`);
  }
}

/** The stores whose changes are kept (one, the server's; each test's its own). */
const started = new WeakSet<object>();

/** Keeps every project's changes from now on, and gives the agent its tools for them (once). */
export function start(app: App): void {
  if (handlerFor("edit_history") === undefined) {
    registerTool("edit_history", ({ app, args, projectId }) => {
      const count = typeof args.count === "number" && Number.isInteger(args.count) ? Math.min(100, Math.max(1, args.count)) : 15;
      return text(history(app, projectId, count));
    });
    registerTool("undo_changes", async ({ app, args, projectId }) => {
      const revs = Array.isArray(args.revs) ? (args.revs as unknown[]).filter((one): one is number => typeof one === "number" && Number.isInteger(one)) : undefined;
      const backTo = typeof args.back_to === "number" && Number.isInteger(args.back_to) ? args.back_to : undefined;
      if (typeof args.kept === "string") {
        if (revs !== undefined || backTo !== undefined) throw new Error("give kept alone, not with revs or back_to");
        return text(await bringBack(app, projectId, args.kept));
      }
      return text(await undo(app, projectId, { ...(revs !== undefined ? { revs } : {}), ...(backTo !== undefined ? { backTo } : {}) }));
    });
  }
  if (started.has(app.store)) return;
  started.add(app.store);
  app.store.subscribe((event) => {
    if (event.type !== "project" || typeof event.id !== "string") return;
    const before = (event as unknown as { before?: { rev: number; project: Project } }).before;
    const project = (event as unknown as { project?: Project }).project;
    if (before === undefined || project === undefined) return;
    record(app, event.id, before.project, project, (event as unknown as { rev: number }).rev, String((event as unknown as { origin?: string }).origin ?? ""));
  });
}

function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

function when(at: number): string {
  return `${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${clock(at)}`;
}

/** The newest `count` changes, newest first, as the agent reads them; then the versions kept aside, if any. */
export function history(app: App, id: string, count: number): string {
  const list = changesOf(app, id);
  const lines = list
    .slice(-count)
    .reverse()
    .map((one) => `- rev ${one.rev}, ${clock(one.at)}, ${one.by === "agent" ? `you (${one.tool ?? "a tool"})` : one.by === "person" ? "the person" : `Edit (${one.by})`}: ${one.what}`);
  const changed = list.length === 0 ? "No changes kept yet for this project." : `The newest changes (undo_changes takes their revs):\n${lines.join("\n")}`;
  const kept = keptLines(app, id);
  return kept === "" ? changed : `${changed}\n\n${kept}`;
}

/**
 * The project's versions kept aside (`Store.keepAside`: this computer's edit
 * the cloud overtook, an old "(conflicted copy)" folded in), newest first,
 * for undo_changes' `kept`.
 */
function keptLines(app: App, id: string): string {
  const kept = app.store.kept(id).reverse();
  if (kept.length === 0) return "";
  const lines = kept.map((one) => {
    let what = "";
    try {
      const project = app.store.keptVersion(id, one.name);
      what = ` (“${project.name}”, ${project.clips.length} clips)`;
    } catch {
      // Listed all the same: its name is what bringing it back reports on.
    }
    return `- ${one.name}, ${when(one.at)}: ${one.why === "copy" ? "an old “(conflicted copy)” of it, folded in" : "this computer's version, which another computer's overtook"}${what}`;
  });
  return `Versions kept aside (undo_changes kept: <name> brings one back as the edit; the person asks for it):\n${lines.join("\n")}`;
}

/**
 * Brings a version kept aside back as the edit, as one new change (undone
 * like any other). The project stays itself: its id, name, and what says
 * who it is and where it lives (Drive, its channel, its creator, its test
 * mark, its note, V2) are the current ones; the edit is the kept version's.
 */
export async function bringBack(app: App, id: string, name: string): Promise<string> {
  if (app.store.get(id) === null) throw new Error("no such project");
  const kept = app.store.keptVersion(id, name);
  const own = ["id", "name", "drive", "created_by", "origin", "shown", "note", "hq", "channel", "removal_held", "local_media"] as const;
  await app.store.update(id, "agent", (project) => {
    const restored = structuredClone(kept) as unknown as Record<string, unknown>;
    const current = project as unknown as Record<string, unknown>;
    for (const key of own) {
      if (key in current) restored[key] = current[key];
      else delete restored[key];
    }
    for (const key of Object.keys(current)) if (!(key in restored)) delete current[key];
    Object.assign(current, restored);
  }, app.store.get(id) ?? undefined);
  return `Brought back kept version ${name} (${kept.clips.length} clips) as the edit. It's one new change: undo_changes takes it back too.`;
}

/**
 * Takes changes back, as one new revision: `revs` those changes alone (newest
 * first; refused where a later change, not being undone, touched the same
 * thing, so nothing done since is lost), or `backTo` everything after that
 * revision. Answers what was undone.
 */
export async function undo(app: App, id: string, given: { revs?: number[]; backTo?: number }): Promise<string> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const list = changesOf(app, id);
  let chosen: Change[];
  if (given.backTo !== undefined) {
    chosen = list.filter((one) => one.rev > given.backTo!);
    if (chosen.length === 0) throw new Error(`nothing changed after rev ${given.backTo}`);
    const oldest = list[0];
    if (oldest !== undefined && oldest.rev > given.backTo + 1) throw new Error(`changes before rev ${oldest.rev} aren't kept: the furthest back is ${oldest.rev - 1}`);
  } else {
    const wanted = new Set(given.revs ?? []);
    if (wanted.size === 0) throw new Error("give revs (the changes to undo) or back_to (a revision to go back to)");
    chosen = list.filter((one) => wanted.has(one.rev));
    const missing = [...wanted].filter((rev) => !chosen.some((one) => one.rev === rev));
    if (missing.length > 0) throw new Error(`no change kept at rev ${missing.join(", ")}: edit_history lists them`);
    // Each against what came after it and stays: undone over a later change to the same thing, that change would be lost.
    for (const one of chosen) {
      const later = list.filter((other) => other.rev > one.rev && !wanted.has(other.rev) && other.touched.some((name) => one.touched.includes(name)));
      if (later.length > 0) {
        throw new Error(`rev ${one.rev} can't be undone alone: rev ${later.map((other) => `${other.rev} (${other.by === "agent" ? "you" : other.by})`).join(", ")} changed the same ${later[0]!.touched.filter((name) => one.touched.includes(name)).slice(0, 4).join(", ")} since. Undo those with it, or go back_to ${one.rev - 1}`);
      }
    }
  }
  // Which kind of project it is and whose channel isn't an edit (Nov 21, channel_move.ts: an edit moved onto a channel
  // from Home): undone, the project would go back to today's kind under the very turn undoing it, with V2's tools and
  // conversation. Never undone here, as a kept version brought back keeps them (`bringBack`).
  const moves = chosen.filter((one) => one.touched.length > 0 && one.touched.every((name) => (IDENTITY as readonly string[]).includes(name)));
  if (moves.length === chosen.length) {
    throw new Error(`rev ${moves.map((one) => one.rev).join(", ")} moved this project onto its channel, which isn't an edit and isn't undone: the person moves a project from Home. Undo the edits around it instead.`);
  }
  const newestFirst = [...chosen].sort((a, b) => b.rev - a.rev);
  await app.store.update(id, "agent", (project) => {
    let restored: Project = project;
    for (const one of newestFirst) restored = patches.apply(restored, one.undo);
    for (const key of IDENTITY) {
      if (key in project) (restored as unknown as Record<string, unknown>)[key] = project[key];
      else delete (restored as unknown as Record<string, unknown>)[key];
    }
    for (const key of Object.keys(project) as (keyof Project)[]) if (!(key in restored)) delete project[key];
    Object.assign(project, restored);
  }, app.store.get(id) ?? undefined);
  return `Undone: ${newestFirst.map((one) => `rev ${one.rev} (${one.what})`).join("; ")}. It's one new change: undo_changes takes it back too.`;
}

/** A clip the person changed by hand, as it was before and after (null: not there). */
export interface HandEdit {
  before: Clip | null;
  after: Clip | null;
}

/**
 * The person's own changes to the clips `pick` takes, newest first, read from the changes kept (the last MOST): each
 * of the person's changes is seen as the project was either side of it by taking every change after it back from
 * `now`, so a clip they deleted, moved or lengthened is told from one an agent's re-run replaced since. What a
 * re-run keeps of their hand fixes (repack_subtitles, Nov 22: lines deleted and holds lengthened came back).
 */
export function byHand(app: App, id: string, now: Project, pick: (clip: Clip) => boolean): HandEdit[] {
  const list = changesOf(app, id);
  const clips = new Map(now.clips.map((clip) => [clip.id, clip]));
  const out: HandEdit[] = [];
  for (let index = list.length - 1; index >= 0; index--) {
    const change = list[index]!;
    const undo = change.undo.lists.clips;
    if (undo === undefined) continue;
    const touched = [...undo.remove, ...undo.put.map((item) => (item as { id: string }).id)];
    const after = new Map(touched.map((one) => [one, clips.get(one) ?? null]));
    for (const one of undo.remove) clips.delete(one);
    for (const item of undo.put) clips.set((item as Clip).id, item as Clip);
    if (change.by !== "person") continue;
    for (const one of new Set(touched)) {
      const [was, is] = [clips.get(one) ?? null, after.get(one) ?? null];
      if ((was !== null && pick(was)) || (is !== null && pick(is))) out.push({ before: was, after: is });
    }
  }
  return out;
}

/** Tests: forget what's kept in memory (the files stay). */
export function forgetForTests(): void {
  kept.clear();
  unread.clear();
}
