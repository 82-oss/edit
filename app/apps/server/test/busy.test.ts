// Nov 8 audit (2b): five answers to "is this busy / who may write" had grown
// apart. They read one module now (busy.ts); these check they agree.

import { expect, test } from "bun:test";

import * as busy from "../src/busy.ts";
import { Entry } from "../src/cloud_projects.ts";
import { busyWith } from "../src/remote_actions.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { App } from "../src/app.ts";
import { busyHere } from "../src/reviews.ts";

test("what's busy here is one answer: the lock, a restart, Ready for changes and the page all agree", () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), "edit-busy-"));
  const app = { store: { home: root, get: () => null, list: () => [], cloud: () => null }, scripts: { get: () => null, running: () => false }, agents: { runningProjects: () => [] }, exports: { running: () => false } } as unknown as App;
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    const lockKept = (id: string) => {
      const entry = new Entry({ rev: 1, dirty: false, token: "t" });
      entry.renewedAt = performance.now();
      return entry.step(performance.now(), busy.workingOn(app, id)) !== "Release";
    };
    // Nothing running: nothing holds a lock, a restart cuts nothing off, the computer isn't busy.
    expect(busy.workingOn(app, "p1")).toBe(false);
    expect(lockKept("p1")).toBe(false);
    expect(busyWith(app)).toEqual([]);
    expect(busyHere(app)).toBe(false);
    // An agent turn on p1: its lock is kept, a restart would cut it off, the computer is busy; p2 is free.
    Object.assign(app, { agents: { ...app.agents, hasRunningTurns: () => true, runningProjects: () => ["p1"] } });
    expect(busy.workingOn(app, "p1")).toBe(true);
    expect(lockKept("p1")).toBe(true);
    expect(busy.workingOn(app, "p2")).toBe(false);
    expect(busyWith(app)).toEqual(["an agent turn"]);
    expect(busyHere(app)).toBe(true);
    Object.assign(app, { agents: { ...app.agents, hasRunningTurns: () => false, runningProjects: () => [] } });
    // A script import on p2: the same.
    Object.assign(app.scripts, { get: (id: string) => (id === "p2" ? { state: "downloading" } : null), running: () => true });
    expect(busy.workingOn(app, "p2")).toBe(true);
    expect(lockKept("p2")).toBe(true);
    expect(busyWith(app)).toEqual(["a footage import"]);
    // Waiting on the person (a file it couldn't fetch) holds nothing.
    Object.assign(app.scripts, { get: () => ({ state: "waiting" }), running: () => false });
    expect(busy.workingOn(app, "p2")).toBe(false);
    expect(busyWith(app)).toEqual([]);
    // Work only its own module knows (a fix) is in the same list.
    const undo = busy.register(() => "a Ready for changes fix");
    expect(busyWith(app)).toEqual(["a Ready for changes fix"]);
    expect(busyHere(app)).toBe(true);
    undo();
    expect(busyHere(app)).toBe(false);
  } finally {
    cleanup();
  }
});

test("what runs now is one list: an effect's render or a removal on any edit keeps the Mac awake and holds a restart; a share waiting for its next try does neither (honest council 7i)", () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), "edit-running-"));
  const app = { store: { home: root, get: () => null, list: () => [{ id: "p1" }, { id: "p2" }], cloud: () => null }, scripts: { get: () => null, running: () => false }, agents: { runningProjects: () => [] }, exports: { running: () => false } } as unknown as App;
  try {
    expect(busy.runningNow(app)).toEqual([]);
    const undo = busy.registerProjectWork((id) => id === "p2");
    expect(busy.runningNow(app)).toEqual(["an effect's render or footage being cleaned"]);
    expect(busyWith(app)).toEqual(busy.runningNow(app));
    undo();
    // A share waiting in the job table isn't running.
    fs.writeFileSync(join(root, "jobs.json"), JSON.stringify([{ key: "share:p1", kind: "share", project: "p1", args: {}, state: "waiting", attempts: 0, started_ms: 1, updated_ms: 1, retry_at: Date.now() + 60_000 }]));
    expect(busy.runningNow(app)).toEqual([]);
    fs.writeFileSync(join(root, "jobs.json"), JSON.stringify([{ key: "share:p1", kind: "share", project: "p1", args: {}, state: "running", attempts: 0, started_ms: 1, updated_ms: 1 }]));
    expect(busy.runningNow(app)).toEqual(["a share"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
