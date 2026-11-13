// The agent's conversations Claude Code keeps on this computer, kept to the
// ones a chat can go on with (Sphe, Nov 13: storage cleaned up). Claude Code
// writes each session to `<config>/projects/<its folder, as a name>/<id>.jsonl`,
// with a folder beside it for the sub-agents' and the tool results it put
// aside (every picture a tool showed, again), and keeps them for a month.
// Edit's chats go on with one session each (agent.ts `thread`); a chat
// started again, a one-off question asked in the agent's workspace, and
// every session before a reset are never read again: the Cops 3 Bodies
// trial's folder held 2.2 GB, 1.65 GB of it two sessions it had left.
//
// So, a few minutes after the start and then hourly: in the agent's own
// folders (its workspace, and each Bodycam HQ project's effects folder,
// which only Edit's agent works in), every session no chat goes on with that
// nothing has written to for two hours goes, and a deleted project's folder
// with it. Nothing outside those folders is touched: the person's own Claude
// Code sessions are theirs. A chat whose session went anyway starts a new
// one (agent.ts SESSION_GONE).

import fs from "node:fs";
import os from "node:os";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { join } from "./paths.ts";

/** A session nothing wrote to for this long isn't one a turn is in. */
export const IDLE_MS = 2 * 3600_000;
const FIRST_MS = 5 * 60_000;
const EVERY_MS = 3600_000;

/** Where Claude Code keeps its sessions, by folder. */
export function sessionsRoot(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(os.homedir(), ".claude"), "projects");
}

/** The name Claude Code gives a working folder's sessions folder (every character but a letter or a digit a dash). */
export function folderName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The session every chat goes on with (`<home>/projects/*.chat.json`'s thread). */
export function threads(home: string): Set<string> {
  const out = new Set<string>();
  const dir = join(home, "projects");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".chat.json")) continue;
    try {
      const thread = (JSON.parse(fs.readFileSync(join(dir, name), "utf8")) as { thread?: unknown }).thread;
      if (typeof thread === "string" && thread !== "") out.add(thread);
    } catch {
      // A chat being written: its session is kept by its own recent writes.
    }
  }
  return out;
}

const SESSION = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.jsonl)?$/;

function sizeOf(path: string): number {
  let total = 0;
  const stack = [path];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(at);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      total += stat.size;
      continue;
    }
    try {
      for (const name of fs.readdirSync(at)) stack.push(join(at, name));
    } catch {
      // Unreadable: not counted.
    }
  }
  return total;
}

/** The newest write in a session (its .jsonl and its folder's sub-agents). */
function lastWrite(paths: string[]): number {
  let newest = 0;
  for (const path of paths) {
    const stack = [path];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(at);
      } catch {
        continue;
      }
      newest = Math.max(newest, stat.mtimeMs);
      if (stat.isDirectory()) {
        try {
          for (const name of fs.readdirSync(at)) stack.push(join(at, name));
        } catch {
          // Its own time counts.
        }
      }
    }
  }
  return newest;
}

export interface Swept {
  sessions: number;
  bytes: number;
}

/**
 * Removes, from each of `folders` (Claude Code's sessions folders of the
 * agent's working folders), every session not in `keep` that nothing has
 * written to since `IDLE_MS` before `now`.
 */
export function sweepFolders(folders: string[], keep: Set<string>, now = Date.now(), dryRun = false): Swept {
  const out: Swept = { sessions: 0, bytes: 0 };
  for (const folder of folders) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    const ids = new Set(names.flatMap((name) => SESSION.exec(name)?.[1] ?? []));
    for (const id of ids) {
      if (keep.has(id)) continue;
      const paths = [join(folder, `${id}.jsonl`), join(folder, id)].filter((path) => fs.existsSync(path));
      if (now - lastWrite(paths) < IDLE_MS) continue;
      const bytes = paths.reduce((sum, path) => sum + sizeOf(path), 0);
      if (!dryRun) for (const path of paths) fs.rmSync(path, { recursive: true, force: true });
      out.sessions += 1;
      out.bytes += bytes;
    }
  }
  return out;
}

/** The sessions folders of Edit's agent here: its workspace's, and every Bodycam HQ project's effects folder's (a deleted one's too). */
export function agentFolders(app: App, root = sessionsRoot()): { live: string[]; gone: string[] } {
  const home = app.store.home;
  const live = [join(root, folderName(join(home, "agent", "workspace")))];
  // By the name its folder is given (an id with a character other than a letter, digit or dash reads as a dash there).
  const projects = new Set(app.store.list().map((summary) => folderName(summary.id)));
  // Each HQ project works in <home>/media/<id>/effects (effects.ts workshop), named by its real path.
  let media = join(home, "media");
  try {
    media = fs.realpathSync(media);
  } catch {
    // No media yet: no HQ folders.
  }
  const prefix = `${folderName(media)}-`;
  const gone: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { live, gone };
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith("-effects")) continue;
    const id = name.slice(prefix.length, -"-effects".length);
    if (projects.has(id)) live.push(join(root, name));
    else gone.push(join(root, name));
  }
  return { live, gone };
}

/** One pass: the sessions no chat goes on with, and a deleted HQ project's folder once nothing has written to it a while. */
export function sweep(app: App, now = Date.now(), dryRun = false): Swept {
  const { live, gone } = agentFolders(app);
  const out = sweepFolders(live, threads(app.store.home), now, dryRun);
  for (const folder of gone) {
    if (now - lastWrite([folder]) < IDLE_MS) continue;
    out.bytes += sizeOf(folder);
    out.sessions += 1;
    if (!dryRun) fs.rmSync(folder, { recursive: true, force: true });
  }
  return out;
}

/** Sweeps a few minutes after the start, then hourly. */
export function start(app: App): () => void {
  const run = () => {
    try {
      const swept = sweep(app);
      if (swept.sessions > 0) diag.info("agent", `${swept.sessions} of the agent's old sessions removed (${Math.round(swept.bytes / 1e6)} MB)`);
    } catch (error) {
      diag.warn("agent", `the agent's old sessions: ${diag.messageOf(error)}`);
    }
  };
  const first = setTimeout(run, FIRST_MS);
  const hourly = setInterval(run, EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(hourly);
  };
}
