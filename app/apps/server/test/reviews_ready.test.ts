// "Ready for changes" asked of this computer: Edit checks in (saying whether
// it's busy) and answers each request asked of it with what to do in Edit,
// starting nothing (Sphe, Nov 21: "When feedback comes in, it shouldn't
// automatically get queued up to get fixed"): wherever the project is and
// however busy the computer. A fix the team pulls sends back the notes its
// turn left unanswered; a share's export follows one already running.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import * as fs from "node:fs";

import { readOnly } from "../src/cloud_projects.ts";
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
  reviews.resetCheckInForTests();
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

const request = (sourceId: string, extra: Record<string, unknown> = {}) => ({ reviewId: "r1", sourceId, title: "Judge", version: 1, by: "JJ", requestedAt: 1, ...extra });

test("with nothing asked of it, it only checks in, saying it isn't busy", async () => {
  const { app, cleanup } = fixtureHome("ready-not-asked");
  idle(app);
  try {
    const calls = convex({ "reviews:checkIn": () => ({ chosen: false, requests: [] }) });
    expect(await reviews.checkIn(app)).toEqual([]);
    expect(reviews.askedHere()).toBe(false);
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

/** The answers a check-in's requests are taken and ended with. */
const answering = {
  "reviews:changes": () => ({ notes: [], cursor: 0, more: false }),
  "reviews:open": () => [],
  "reviews:takeFix": () => ({ ok: true, noteIds: ["n1"] }),
  "reviews:fixProgress": () => ({ ok: true }),
};
const answers = (calls: Call[]) => calls.filter((call) => call.path === "reviews:fixProgress").map((call) => call.args);
const told = (reviewId = "r1") => ({ machine: machine.id(), reviewId, state: "failed", error: reviews.ASK_IN_EDIT });

// Before Nov 21 a request for a project not here came down from the cloud (or was declined, with the cloud off) and
// its fix started at the next check-in. Nothing starts now, so nothing comes down: the answer is the same everywhere.
test("a request for a project that isn't here is answered with what to do in Edit, once; nothing comes down for it", async () => {
  const { app, cleanup } = fixtureHome("ready-decline-missing");
  idle(app);
  try {
    let asked = [request("p-elsewhere")];
    const calls = convex({ "reviews:checkIn": () => ({ chosen: true, requests: asked }), ...answering });
    expect(await reviews.checkIn(app)).toEqual(["p-elsewhere"]);
    expect(reviews.askedHere()).toBe(true);
    expect(answers(calls)).toEqual([told()]);
    expect(calls.some((call) => call.path === "reviews:declineFix" || call.path === "reviews:claim")).toBe(false);
    // Still listed (the database hadn't moved it yet): not answered again.
    await reviews.checkIn(app);
    expect(answers(calls)).toHaveLength(1);
    // Asked again later: a new request, answered again.
    asked = [request("p-elsewhere", { requestedAt: 2 })];
    await reviews.checkIn(app);
    expect(answers(calls)).toHaveLength(2);
  } finally {
    cleanup();
  }
});

// It was declined naming the computer that held it ("Pick another computer"); that steered the reviewer to a Mac
// that might run an older build, which would fix and publish by itself. Now it gets the same answer, and the
// project's hold isn't even asked about: nothing here would write to it.
test("a request for a project another computer holds gets the same answer, without asking for the project", async () => {
  const { app, cleanup } = fixtureHome("ready-decline-held");
  idle(app);
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  let asks = 0;
  (app.store as unknown as { mayWrite: unknown }).mayWrite = async () => {
    asks++;
    throw new Error(readOnly("Sphe's MacBook Air"));
  };
  try {
    const calls = convex({ "reviews:checkIn": () => ({ chosen: true, requests: [request(live.project.id)] }), ...answering });
    expect(await reviews.checkIn(app)).toEqual([live.project.id]);
    expect(answers(calls)).toEqual([told()]);
    expect(asks).toBe(0);
    expect(calls.some((call) => call.path === "reviews:declineFix")).toBe(false);
  } finally {
    cleanup();
  }
});

// A busy project's request used to wait for a later check-in. It starts nothing now, so there's nothing to wait for.
test("a request whose project is busy here is answered all the same, the check-in still saying busy", async () => {
  const { app, cleanup } = fixtureHome("ready-busy-waits");
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  const sent: string[] = [];
  idle(app, { hasRunningTurns: () => true, chat: () => ({ running: true }), send: async (_project: string, text: string) => void sent.push(text) });
  try {
    const calls = convex({ "reviews:checkIn": () => ({ chosen: true, requests: [request(live.project.id)] }), ...answering });
    expect(await reviews.checkIn(app)).toEqual([live.project.id]);
    expect(await reviews.checkIn(app)).toEqual([]);
    expect(calls.filter((call) => call.path === "reviews:checkIn").map((call) => call.args.busy)).toEqual([true, true]);
    expect(answers(calls)).toEqual([told()]);
    expect(sent).toEqual([]);
  } finally {
    cleanup();
  }
});

// "Share v2 again" on the page (Nov 2, JJ's Mom Secretly: every note done in v2, then sharing v2 failed) took the
// request straight to exporting and sharing. Nothing is shared by itself now: it's answered as any request is, with
// notes to fix or none, and whoever's in Edit shares it.
test("Share again, with nothing to fix or with a new note, is answered with what to do in Edit: nothing exported, nothing sent to the agent", async () => {
  const { app, home, cleanup } = fixtureHome("ready-reshare");
  const live = app.store.createAs("Mom Secretly", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const sent: string[] = [];
  idle(app, { send: async (_project: string, text: string) => void sent.push(text) });
  let exports = 0;
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, exported: () => false, start: async (_s: unknown, _l: unknown, _p: unknown, _o: unknown, path: string) => (exports++, path) };
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "u", versions: [{ n: 1, timeline: "older", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }] } } }));
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: [request(id, { title: "Mom Secretly" }), request(id, { reviewId: "r2", requestedAt: 2 })] }),
      ...answering,
      "reviews:takeFix": (args) => ({ ok: true, sourceId: id, title: "Mom Secretly", version: 1, noteIds: args.reviewId === "r1" ? [] : ["n2"], reshare: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([id, id]);
    await Bun.sleep(100);
    expect(answers(calls)).toEqual([told("r1"), told("r2")]);
    expect(exports).toBe(0);
    expect(sent).toEqual([]);
    expect(calls.some((call) => call.path === "reviews:claim" || call.path === "reviews:publish")).toBe(false);
  } finally {
    cleanup();
  }
});

// The page didn't hear the answer (the line dropped): the request is taken, so the next check-in doesn't list it, and
// it's said again then rather than left reading "Starting" on the page.
test("an answer the page didn't hear is said again at the next check-in", async () => {
  const { app, cleanup } = fixtureHome("ready-answer-again");
  idle(app);
  try {
    let listed = [request("p-elsewhere")];
    let heard = false;
    const answer: Record<string, () => unknown> = { "reviews:checkIn": () => ({ chosen: listed.length > 0, requests: listed }), ...answering };
    const calls: Call[] = [];
    mock.on("POST", "/v1/cloud/convex", (given) => {
      const { path, args } = given.json<{ path: string; args: Record<string, unknown> }>();
      calls.push({ path, args });
      // The first answer doesn't reach the page.
      if (path === "reviews:fixProgress" && !heard) {
        heard = true;
        return Response.json({ status: "error", errorMessage: "Uncaught Error: the line dropped" });
      }
      return Response.json({ status: "success", value: answer[path]?.() ?? null });
    });
    expect(await reviews.checkIn(app)).toEqual([]);
    listed = [];
    expect(await reviews.checkIn(app)).toEqual(["p-elsewhere"]);
    expect(answers(calls)).toEqual([told(), told()]);
    expect(calls.filter((call) => call.path === "reviews:takeFix")).toHaveLength(1);
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
