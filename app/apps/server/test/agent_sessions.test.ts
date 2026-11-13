// The agent's Claude Code sessions kept to the ones a chat goes on with
// (agent_sessions.ts).

import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import * as agentSessions from "../src/agent_sessions.ts";

const ID = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

test("a sessions folder is named as Claude Code names it", () => {
  expect(agentSessions.folderName("/home/spheg/.edit-v2/media/p1794436996566-38/effects")).toBe("-home-spheg--edit-v2-media-p1794436996566-38-effects");
  expect(agentSessions.folderName("/Users/jj/Library/Application Support/Edit/agent/workspace")).toBe("-Users-jj-Library-Application-Support-Edit-agent-workspace");
  expect(agentSessions.sessionsRoot({ CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/projects");
});

test("sessions no chat goes on with go once idle; a chat's, and one being written, stay", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-sessions-"));
  try {
    const home = join(dir, "home");
    fs.mkdirSync(join(home, "projects"), { recursive: true });
    fs.writeFileSync(join(home, "projects", "p1.chat.json"), JSON.stringify({ thread: ID(1), entries: [] }));
    fs.writeFileSync(join(home, "projects", "p2~review.chat.json"), JSON.stringify({ thread: ID(2) }));
    fs.writeFileSync(join(home, "projects", "p3.chat.json"), "{");
    expect([...agentSessions.threads(home)].sort()).toEqual([ID(1), ID(2)]);
    const folder = join(dir, "sessions");
    const old = (Date.now() - 3 * 3600_000) / 1000;
    const session = (n: number, idle: boolean) => {
      fs.mkdirSync(join(folder, ID(n), "tool-results"), { recursive: true });
      fs.writeFileSync(join(folder, `${ID(n)}.jsonl`), "x".repeat(100));
      fs.writeFileSync(join(folder, ID(n), "tool-results", "a.png"), "y".repeat(50));
      if (idle) for (const path of [join(folder, `${ID(n)}.jsonl`), join(folder, ID(n)), join(folder, ID(n), "tool-results"), join(folder, ID(n), "tool-results", "a.png")]) fs.utimesSync(path, old, old);
    };
    session(1, true);
    session(2, true);
    // Left by a reset, idle: goes. Being written (a turn in it): stays.
    session(3, true);
    session(4, false);
    fs.writeFileSync(join(folder, "memory.md"), "not a session");
    const keep = agentSessions.threads(home);
    expect(agentSessions.sweepFolders([folder], keep, Date.now(), true)).toEqual({ sessions: 1, bytes: 150 });
    expect(fs.existsSync(join(folder, `${ID(3)}.jsonl`))).toBe(true);
    expect(agentSessions.sweepFolders([folder, join(dir, "none")], keep)).toEqual({ sessions: 1, bytes: 150 });
    expect(fs.existsSync(join(folder, `${ID(3)}.jsonl`))).toBe(false);
    expect(fs.existsSync(join(folder, ID(3)))).toBe(false);
    for (const n of [1, 2, 4]) expect(fs.existsSync(join(folder, `${ID(n)}.jsonl`))).toBe(true);
    expect(fs.existsSync(join(folder, "memory.md"))).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only the agent's own folders are looked in: its workspace, the projects' effects folders, a deleted project's", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-sessions-"));
  try {
    const home = join(dir, "home");
    fs.mkdirSync(join(home, "media"), { recursive: true });
    const root = join(dir, "claude", "projects");
    const media = agentSessions.folderName(fs.realpathSync(join(home, "media")));
    for (const name of [`${media}-p1-effects`, `${media}-p9-effects`, "-home-someone-code-edit", agentSessions.folderName(join(home, "agent", "workspace"))]) fs.mkdirSync(join(root, name), { recursive: true });
    const app = { store: { home, list: () => [{ id: "p1" }] } } as never;
    const { live, gone } = agentSessions.agentFolders(app, root);
    expect(live.sort()).toEqual([join(root, agentSessions.folderName(join(home, "agent", "workspace"))), join(root, `${media}-p1-effects`)].sort());
    expect(gone).toEqual([join(root, `${media}-p9-effects`)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
