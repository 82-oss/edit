// This computer's check-in (saying whether it's busy, for accounts' Computers
// page; the review page's "Ready for changes" that it also answered is gone,
// Nov 22). A fix the team pulls sends back the notes its turn left
// unanswered; a share's export follows one already running.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import * as fs from "node:fs";

import { optionsKey, timelineHash } from "../src/exports.ts";
import * as machine from "../src/machine.ts";
import { native } from "../src/native/index.ts";
import * as reviews from "../src/reviews.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  reviews.followEveryForTests(20);
});

beforeEach(async () => {
  await reviews.settledForTests();
});

afterAll(() => {
  reviews.followEveryForTests(5_000);
  restore();
  mock.stop();
});

type Call = { path: string; args: Record<string, unknown> };

/** Repack's reviews functions as the relay answers them; every call kept. */
function convex(answers: Record<string, (args: Record<string, unknown>) => unknown>): Call[] {
  const calls: Call[] = [];
  mock.on("POST", "/v1/cloud/convex", (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    calls.push({ path, args });
    const answer = answers[path];
    return Response.json({ status: "success", value: answer ? answer(args) : null });
  });
  return calls;
}

/** The services a check-in reads to tell whether this computer is busy: nothing running, unless a test says so. */
function idle(app: unknown, agents: Record<string, unknown> = {}): void {
  (app as { exports: unknown }).exports = { running: () => false };
  (app as { agents: unknown }).agents = { hasRunningTurns: () => false, chat: () => ({ running: false }), ...agents };
}

test("a check-in says this computer is open and isn't busy, for accounts' Computers page, and nothing else", async () => {
  const { app, cleanup } = fixtureHome("ready-not-asked");
  idle(app);
  try {
    const calls = convex({ "reviews:checkIn": () => ({ chosen: false, requests: [] }) });
    await reviews.checkIn(app);
    expect(calls.map((call) => call.path)).toEqual(["reviews:checkIn"]);
    expect(calls[0]!.args).toMatchObject({ machine: machine.id(), name: machine.name(), busy: false });
  } finally {
    cleanup();
  }
});

test("a check-in says busy while an agent turn runs on any project here", async () => {
  const { app, cleanup } = fixtureHome("ready-busy-flag");
  idle(app, { hasRunningTurns: () => true });
  try {
    const calls = convex({ "reviews:checkIn": () => ({ chosen: false, requests: [] }) });
    await reviews.checkIn(app);
    expect(calls[0]!.args.busy).toBe(true);
    // An export alone is busy too.
    idle(app);
    (app as unknown as { exports: unknown }).exports = { running: () => true };
    await reviews.checkIn(app);
    expect(calls[1]!.args.busy).toBe(true);
  } finally {
    cleanup();
  }
});

test("a share goes up in place of the latest version unless it has a reviewer's comment", () => {
  const { home, cleanup } = fixtureHome("ready-versions");
  try {
    const note = (id: string, version: number, extra: Record<string, unknown> = {}) => ({ id, reviewId: "r1", project: "p", version, ms: 0, endMs: null, text: "x", author: "Marc", status: "open", parentId: null, createdAt: 1, updatedAt: 1, ...extra });
    const versions = [1, 2].map((n) => ({ n, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }));
    const notes = { a: note("a", 1), b: note("b", 2, { parentId: "a" }), c: note("c", 2, { fromApp: true }) };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes, shared: { p: { reviewId: "r1", url: "u", versions } } }));
    // Notes on v1, a reply and the agent's own words on v2: v2 is replaced.
    expect(reviews.onLatest(home, "p")).toEqual([]);
    expect(reviews.shareReplacesLatest(versions.length, reviews.onLatest(home, "p").length)).toBe(true);
    expect(reviews.nextShare(home, "p")).toEqual({ version: 2, replace: true });
    expect(reviews.nextShare(home, "nothing shared")).toEqual({ version: 1, replace: false });
    // A comment on v2: the fix is v3. Nothing shared yet is a first version, not a replace.
    expect(reviews.shareReplacesLatest(0, 0)).toBe(false);
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: { ...notes, d: note("d", 2) }, shared: { p: { reviewId: "r1", url: "u", versions } } }));
    expect(reviews.onLatest(home, "p").map((one) => one.id)).toEqual(["d"]);
    expect(reviews.shareReplacesLatest(versions.length, reviews.onLatest(home, "p").length)).toBe(false);
    expect(reviews.nextShare(home, "p")).toEqual({ version: 3, replace: false });
  } finally {
    cleanup();
  }
});

// Oct 31, the "Helpful" Son: a restart carried the share's export on by
// itself, then the followed fix asked for its own and was refused ("this
// project already has an export running"); the export finished 90 s later and
// v3 was never shared.
test("a share follows the export already running for the same picture, and waits out a different one", async () => {
  const { app, cleanup } = fixtureHome("ready-busy-export");
  const live = app.store.createAs("Helpful Son", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const house = native().exportDefaults();
  // A share always asks for YouTube, even with no options (Sphe, Nov 3). The export it follows has those settings.
  const shareOptions = { ...house, preset: "youtube" as const };
  let busy: { output: string; timeline: string; options: string } | null = null;
  const started: string[] = [];
  (app as unknown as { exports: unknown }).exports = {
    runningFor: () => busy,
    running: () => busy !== null,
    cancel: () => false,
    exported: () => false,
    start: async (_store: unknown, _library: unknown, _project: unknown, _options: unknown, path: string) => {
      if (busy !== null) throw new Error("this project already has an export running");
      started.push(path);
      busy = { output: path, timeline: timelineHash(live.project), options: optionsKey(shareOptions) };
      setTimeout(() => {
        busy = null;
        app.store.emit({ type: "export", id, state: "done", progress: 1, path });
      }, 30);
      return path;
    },
  };
  const finish = (path: string) => {
    busy = null;
    app.store.emit({ type: "export", id, state: "done", progress: 1, path });
  };
  try {
    // The same picture and the YouTube settings a share asks for: followed to its file, no second export.
    busy = { output: "/out/resumed.mp4", timeline: timelineHash(live.project), options: optionsKey(shareOptions) };
    const same = reviews.exportAndShare(app, id, {});
    setTimeout(() => finish("/out/resumed.mp4"), 50);
    // No such export on record in the fixture, so the share itself stops after: past the export is what's tested.
    expect(await same.catch((error: Error) => error.message)).toContain("isn't one of this project's whole exports");
    expect(started).toEqual([]);
    // A different export (another format): waited out, then this one starts.
    busy = { output: "/out/agent.mov", timeline: timelineHash(live.project), options: optionsKey({ ...house, format: "prores" }) };
    const other = reviews.exportAndShare(app, id, {});
    setTimeout(() => finish("/out/agent.mov"), 50);
    expect(await other.catch((error: Error) => error.message)).toContain("isn't one of this project's whole exports");
    expect(started).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("a share whose export goes without a word (its process died, the event lost) exports again once, then says so, never waiting for ever", async () => {
  const { app, cleanup } = fixtureHome("ready-silent-export");
  const live = app.store.createAs("Helpful Son", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const house = native().exportDefaults();
  let busy: { output: string; timeline: string; options: string } | null = null;
  const started: string[] = [];
  (app as unknown as { exports: unknown }).exports = {
    runningFor: () => busy,
    running: () => busy !== null,
    cancel: () => false,
    exported: () => false,
    start: async (_store: unknown, _library: unknown, _project: unknown, _options: unknown, path: string) => {
      started.push(path);
      busy = { output: path, timeline: timelineHash(live.project), options: optionsKey(house) };
      // Gone 30 ms later, with no end said.
      setTimeout(() => (busy = null), 30);
      return path;
    },
  };
  const before = { ...reviews.exportWatch };
  reviews.exportWatch.everyMs = 20;
  try {
    const shared = await reviews.exportAndShare(app, id, {}).catch((error: Error) => error.message);
    expect(shared).toContain("the export stopped without saying how, twice");
    expect(started).toHaveLength(2);
    // Not left "being shared": another share can start.
    const again = await reviews.exportAndShare(app, id, {}).catch((error: Error) => error.message);
    expect(again).not.toContain("already being shared");
  } finally {
    Object.assign(reviews.exportWatch, before);
    cleanup();
  }
}, 30_000);

// Nov 6, JJ's Cops Realize: the turn fixed 7 of 31 notes, ended saying "this
// round is not finished", and v2 was shared with the other 22 untouched. Asked
// through Ready for changes then; through pull_feedback now, the only way the
// agent is set on the notes (Nov 21), and nothing is shared at the end.
test("a pulled fix whose turn ends with notes unanswered sends them back; one never answered is left saying so; nothing is shared", async () => {
  const { app, home, cleanup } = fixtureHome("ready-unanswered");
  const live = app.store.createAs("Cops", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  // The turn that called pull_feedback is running.
  let running = true;
  const sent: string[] = [];
  let exports = 0;
  idle(app, {
    chat: () => ({ running }),
    send: async (project: string, text: string) => {
      sent.push(text);
      running = true;
      setTimeout(() => {
        // The first send back answers n2; the next answers nothing.
        const which = sent.length === 1 ? ["n2"] : [];
        void Promise.all(which.map((one) => reviews.unfixed(app, project, one, "answered"))).then(() => (running = false));
      }, 30);
    },
  });
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, start: async () => void exports++ };
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "u", versions: [{ n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }] } } }));
    const note = (n: string, text: string) => ({ noteId: n, reviewId: "r1", sourceId: id, parentId: null, anchor: { kind: "time", ms: 1000 }, status: "open", fromApp: false, version: 1, author: "JJ", text, createdAt: 1, updatedAt: 1 });
    const calls = convex({
      "reviews:changes": () => ({ notes: [note("n1", "one"), note("n2", "two"), note("n3", "three")], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
    });
    await reviews.pullFeedback(app, id);
    // The turn answers n1 and ends.
    await reviews.unfixed(app, id, "n1", "answered");
    running = false;
    const end = Date.now() + 15_000;
    while (!calls.some((call) => call.path === "reviews:status" && call.args.noteId === "n3") && Date.now() < end) await Bun.sleep(20);
    await reviews.settledForTests();
    // Sent back twice: n2 and n3, then n3 alone; a send that answered nothing ends it.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("Your turn ended with 2 of the 3 notes unanswered");
    expect(sent[0]).toContain("[n2]");
    expect(sent[0]).not.toContain("[n1]");
    expect(sent[1]).toContain("[n3]");
    expect(sent[1]).not.toContain("[n2]");
    const left = calls.filter((call) => call.path === "reviews:status" && call.args.noteId === "n3");
    expect(left).toHaveLength(1);
    expect(String(left[0]!.args.details)).toContain("didn't get to this note");
    expect(String(left[0]!.args.details)).toContain("when the team pulls the feedback in Edit");
    expect(exports).toBe(0);
    expect(calls.some((call) => call.path === "reviews:publish" || call.path === "reviews:fixProgress")).toBe(false);
  } finally {
    cleanup();
  }
});
