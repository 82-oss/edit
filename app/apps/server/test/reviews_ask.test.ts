// Feedback is pulled and put up only when someone in Edit asks (Sphe, Nov 21:
// "When feedback comes in, it shouldn't automatically get queued up to get
// fixed. We must go into the edits app and ask the agents to pull the
// feedback… Once the agent fixes things, it shouldn't just automatically
// publish as V2"). Ready for changes on the review page starts nothing here
// and is answered with what to do; the agent fixes what it's asked to pull and
// shares nothing; a note fixed in the edit reads as fixed on the review only
// once a version carrying the fix is up; and a share, from the dialog or the
// agent, replaces the latest version when it has no notes and comes as the next
// when it has.

import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as cloud from "../src/cloud.ts";
import * as exportSteps from "../src/export_steps.ts";
import { timelineHash } from "../src/exports.ts";
import * as jobs from "../src/jobs.ts";
import * as machine from "../src/machine.ts";
import { handlerFor } from "../src/mcp/registry.ts";
import * as reviewGuard from "../src/review_guard.ts";
import * as reviews from "../src/reviews.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";

const spies: { mockRestore(): void }[] = [];

beforeAll(() => reviews.followEveryForTests(20));
beforeEach(async () => {
  await reviews.settledForTests();
  reviews.resetCheckInForTests();
});
afterEach(async () => {
  await Bun.sleep(20);
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(() => {
  reviews.followEveryForTests(5_000);
  reviewGuard.resetForTests();
});

type Call = { path: string; args: Record<string, unknown> };

/** Repack's functions and R2 as Edit sees them, every call kept; `answers` by function. */
function fakeCloud(answers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const r2 = new Map<string, number>();
  const answer = (path: string, args: unknown) => {
    calls.push({ path, args: (args ?? {}) as Record<string, unknown> });
    const given = answers[path];
    return (given ? given((args ?? {}) as Record<string, unknown>) : null) as never;
  };
  spies.push(
    spyOn(cloud, "enabled").mockReturnValue(true),
    spyOn(cloud, "query").mockImplementation(async (path: string, args: unknown) => answer(path, args)),
    spyOn(cloud, "mutation").mockImplementation(async (path: string, args: unknown) => answer(path, args)),
    spyOn(cloud, "uploadFile").mockImplementation(async (from: string, key: string) => {
      calls.push({ path: `upload ${key.split("/").pop()}`, args: {} });
      r2.set(key, fs.statSync(from).size);
    }),
    spyOn(cloud, "head").mockImplementation(async (key: string) => (r2.has(key) ? { size: r2.get(key)!, etag: null, contentType: null } : null)),
  );
  const named = (path: string) => calls.filter((call) => call.path === path).map((call) => call.args);
  return { calls, named };
}

const shared = (_id: string, versions: number[]) => ({ reviewId: "r1", url: "https://review.test/r1", versions: versions.map((n) => ({ n, timeline: `t${n}`, path: "/nowhere.mp4", fps: 30, durationMs: 6_000, clips: [] })) });
/** A reviewer's note as Repack sends it. */
const heardNote = (id: string, noteId: string, version = 1, text = "Cut the music here") => ({ noteId, reviewId: "r1", sourceId: id, parentId: null, anchor: { kind: "time", ms: 1000 }, status: "open", fromApp: false, version, author: "Marc", text, createdAt: 1, updatedAt: 1 });
/** A note as reviews.json keeps it. */
const keptNote = (id: string, noteId: string, version: number, extra: Record<string, unknown> = {}) => ({ id: noteId, reviewId: "r1", project: id, version, ms: 1000, endMs: null, text: "Cut the music here", author: "Marc", status: "open", parentId: null, createdAt: 1, updatedAt: 1, ...extra });

/** The agent panel: no turn running unless `state.running`; what's sent to it kept. */
function panel(app: unknown, state: { running: boolean } = { running: false }) {
  const sent: string[] = [];
  (app as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false };
  (app as { agents: unknown }).agents = { hasRunningTurns: () => state.running, chat: () => ({ running: state.running }), send: async (_project: string, text: string) => void sent.push(text) };
  return sent;
}

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await Bun.sleep(20);
}

test("Ready for changes asked of this computer starts no turn: the request is answered with what to do in Edit, once", async () => {
  const { app, home, cleanup } = fixtureHome("ask-ready");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  const sent = panel(app);
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: shared(id, [1]) } }));
    const asked = [
      { reviewId: "r1", sourceId: id, title: "Judge", version: 1, by: "Marc", requestedAt: 1 },
      // One for a project that isn't on this computer gets the same answer: nothing comes down for it.
      { reviewId: "r2", sourceId: "p-elsewhere", title: "Elsewhere", version: 1, by: "Marc", requestedAt: 1 },
    ];
    const { calls, named } = fakeCloud({
      "reviews:checkIn": () => ({ chosen: true, requests: asked }),
      "reviews:changes": () => ({ notes: [heardNote(id, "n1")], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:takeFix": (args) => ({ ok: true, sourceId: args.reviewId === "r1" ? id : "p-elsewhere", title: "Judge", version: 1, noteIds: ["n1"] }),
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
      "reviews:fixProgress": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([id, "p-elsewhere"]);
    await Bun.sleep(200);
    // No turn, no note claimed, nothing exported or shared.
    expect(sent).toEqual([]);
    expect(named("reviews:claim")).toEqual([]);
    expect(calls.some((call) => call.path === "reviews:publish" || call.path === "reviews:declineFix")).toBe(false);
    // Each request ends on the review page with the words, never "Pick another computer" (every Edit says the same).
    expect(named("reviews:fixProgress")).toEqual([
      { machine: machine.id(), reviewId: "r1", state: "failed", error: reviews.ASK_IN_EDIT },
      { machine: machine.id(), reviewId: "r2", state: "failed", error: reviews.ASK_IN_EDIT },
    ]);
    expect(reviews.ASK_IN_EDIT).toBe("Changes are made in Edit now, not from this page: open the project in Edit and ask its agent to pull the feedback. The new version comes here once someone shares it from Edit.");
    // The note came in all the same: Home's count has it.
    expect(reviews.openCounts(home)[id]).toBe(1);
    // Still listed at the next check-in (the database hadn't moved it yet): not answered twice.
    await reviews.checkIn(app);
    expect(named("reviews:takeFix")).toHaveLength(2);
    expect(named("reviews:fixProgress")).toHaveLength(2);
  } finally {
    cleanup();
  }
});

test("pull_feedback asked in the chat brings the open notes to the agent, who's told nothing goes up by itself", async () => {
  const { app, home, cleanup } = fixtureHome("ask-pull");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  const state = { running: true };
  panel(app, state);
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: shared(id, [1]) } }));
    const { named } = fakeCloud({
      "reviews:changes": () => ({ notes: [heardNote(id, "n1")], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
    });
    const message = await reviews.pullFeedback(app, id);
    expect(message).toContain("[n1]");
    expect(message).toContain("Cut the music here");
    expect(message).toContain("Nothing goes up on the review by itself");
    expect(message).toContain("ask you to put it up, or from Export → Send for feedback");
    expect(named("reviews:claim")[0]).toMatchObject({ noteIds: ["n1"], manual: true });
    await reviews.unfixed(app, id, "n1", "a question: answered in the chat");
    state.running = false;
    await reviews.settledForTests();
  } finally {
    cleanup();
  }
});

test("a fix the agent finishes shares nothing, and its notes stay open on the review until a version with the fix is up", async () => {
  const { app, home, cleanup } = fixtureHome("ask-done");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  const state = { running: true };
  const sent = panel(app, state);
  let exported = 0;
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, start: async () => void exported++ };
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: shared(id, [1]) } }));
    const { calls } = fakeCloud({
      "reviews:changes": () => ({ notes: [heardNote(id, "n1")], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
    });
    await reviews.pullFeedback(app, id);
    await app.store.update(id, "test", (project) => void (project.name = "Judge, the music cut"));
    const fix = await reviews.done(app, id, "n1", "cut the music at 0:01");
    expect(fix?.summary).toBe("cut the music at 0:01");
    state.running = false;
    await reviews.settledForTests();
    // The turn ended: nothing exported, nothing shared, nothing sent after it.
    expect(exported).toBe(0);
    expect(calls.some((call) => ["reviews:publish", "reviews:resolve", "reviews:fixProgress"].includes(call.path) || call.path.startsWith("upload"))).toBe(false);
    expect(sent).toEqual([]);
    expect(jobs.list(home, "share")).toEqual([]);
    // Fixed here (the timeline shows it), open on the review, and gone from Home's count of what's still to fix.
    const note = reviews.read(home).notes.n1!;
    expect(note).toMatchObject({ status: "open", fix: { summary: "cut the music at 0:01" }, pending: { version: null } });
    expect(reviews.openCounts(home)[id]).toBeUndefined();
    // Heard again from the review (a reply under it moves it there): still fixed here, not taken for reopened.
    await reviews.poll(app);
    expect(reviews.read(home).notes.n1?.fix?.summary).toBe("cut the music at 0:01");
    // Pulled again, it isn't handed to the agent a second time.
    expect(await reviews.pullFeedback(app, id)).toContain("No open notes to fix");
  } finally {
    cleanup();
  }
});

const ffmpeg = (...args: string[]) => tools.run([tools.ffmpeg(), "-v", "error", "-nostdin", "-y", ...args]);

/** A project with a whole export of the edit as it is now on record (6 s, picture and sound), shared as `versions`, with `notes`. */
async function exported(name: string, versions: number[], notes: Record<string, unknown>) {
  const fixture = fixtureHome(name);
  const { app, home, dir } = fixture;
  const live = app.store.createAs("Cops Realize", "bodycam", { width: 160, height: 120, fps: 30 });
  const id = live.project.id;
  const path = nodePath.join(dir, "Cops Realize.mp4");
  await ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-f", "lavfi", "-i", "sine=r=48000", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path);
  const record = { path, name: "Cops Realize.mp4", finished_ms: Date.now(), seconds: 1, bytes: fs.statSync(path).size, frames: 180, whole: true, start: 0, format: "h264", timeline: timelineHash(live.project) };
  fs.writeFileSync(nodePath.join(home, "exports.json"), JSON.stringify({ [id]: [record] }));
  fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: Object.fromEntries(Object.entries(notes).map(([key, note]) => [key, { ...(note as object), project: id }])), shared: { [id]: shared(id, versions) } }));
  panel(app);
  return { ...fixture, id, path, record };
}

/** n1 fixed in the edit before its export, n2 fixed after it (not in the video that goes up). */
const fixedNotes = (version: number) => ({
  n1: keptNote("", "n1", version, { fix: { clips: [], ranges: [[0, 30]], summary: "cut the music", at: Date.now() - 60_000 }, pending: { version: null } }),
  n2: keptNote("", "n2", version, { text: "louder", fix: { clips: [], ranges: [], summary: "louder", at: Date.now() + 60 * 60_000 }, pending: { version: null } }),
});

test("a share after the fix marks the notes it carries as fixed in that version: with notes on the latest, it goes up as the next", async () => {
  const { app, home, id, cleanup } = await exported("ask-share-next", [1], fixedNotes(1));
  const { named } = fakeCloud({ "reviews:publish": () => ({ reviewId: "r1", url: "https://review.test/r1", version: 2 }) });
  try {
    expect(reviews.nextShare(home, id)).toEqual({ version: 2, replace: false });
    const { replace } = reviews.nextShare(home, id);
    expect(await reviews.share(app, id, null, replace)).toEqual({ url: "https://review.test/r1", version: 2 });
    await until(() => named("reviews:resolve").length > 0);
    // n1's fix is in v2; n2's came after the video was taken, so it waits for the next share.
    expect(named("reviews:resolve")).toEqual([{ noteId: "n1", version: 2, changedRanges: [{ startMs: 0, endMs: 1000 }], fixSummary: "cut the music" }]);
    expect(named("reviews:publish")).toHaveLength(1);
    const notes = reviews.read(home).notes;
    expect(notes.n1).toMatchObject({ status: "done" });
    expect(notes.n1?.pending).toBeUndefined();
    expect(notes.n2).toMatchObject({ status: "open", pending: { version: null } });
  } finally {
    cleanup();
  }
}, 30_000);

test("a share of an edit unchanged since the latest version, which has notes: promised as that version again, and said so once the cloud hands it back", async () => {
  // Nov 22, the MacBook Air: "Share as v2" ended "v1 is up", the cloud giving v1 back for the same files.
  const { app, home, id, cleanup } = await exported("ask-share-unchanged", [1], { n7: keptNote("", "n7", 1) });
  const state = JSON.parse(fs.readFileSync(`${home}/reviews.json`, "utf8")) as { shared: Record<string, { versions: { timeline: string }[] }> };
  state.shared[id]!.versions[0]!.timeline = timelineHash(app.store.get(id)!.project);
  fs.writeFileSync(`${home}/reviews.json`, JSON.stringify(state));
  const { named } = fakeCloud({ "reviews:publish": () => ({ reviewId: "r1", url: "https://review.test/r1", version: 1 }) });
  try {
    expect((reviews.view(app, id) as { next: unknown }).next).toEqual({ version: 1, replace: false, unchanged: true });
    expect(await reviews.share(app, id, null, false)).toEqual({ url: "https://review.test/r1", version: 1 });
    expect(named("reviews:publish")).toHaveLength(1);
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done", version: 1, target: { version: 1, replace: false, unchanged: true } });
    // Changed since: the next share is a new version, promised as one.
    const live = app.store.get(id)!.project;
    await app.store.replace(id, null, { ...live, clips: [...live.clips, { id: "c-new", type: "solid", track: live.tracks[0]?.id ?? "v1", start: 0, duration: 30, color: "#000000" }] } as never, "test");
    expect((reviews.view(app, id) as { next: unknown }).next).toEqual({ version: 2, replace: false });
  } finally {
    cleanup();
  }
}, 30_000);

test("with no notes on the latest version, a share replaces it, and the fixes it carries are marked as in it", async () => {
  // Notes on v1, fixed; v2 went up after with no one's notes on it.
  const { app, home, id, cleanup } = await exported("ask-share-replace", [1, 2], { n1: fixedNotes(1).n1 });
  const { named } = fakeCloud();
  try {
    expect(reviews.nextShare(home, id)).toEqual({ version: 2, replace: true });
    expect(await reviews.share(app, id, null, reviews.nextShare(home, id).replace)).toEqual({ url: "https://review.test/r1", version: 2 });
    await until(() => named("reviews:resolve").length > 0);
    expect(named("reviews:publish")).toEqual([]);
    expect(named("reviews:resolve")).toEqual([expect.objectContaining({ noteId: "n1", version: 2 })]);
    expect(reviews.read(home).notes.n1).toMatchObject({ status: "done" });
    // The page's details of v2 are the new video's (Nov 22, a MacBook Air: a replace left the old length and clips on
    // the page, so new notes were pinned to the wrong footage): its length, rate and clips, said to the cloud for v2.
    const told = named("reviews:setMeta").filter((one) => typeof (one.meta as { durationMs?: unknown }).durationMs === "number");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ sourceId: id, version: 2, meta: { fps: expect.any(Number), durationMs: expect.any(Number), timeline: expect.anything() } });
  } finally {
    cleanup();
  }
}, 30_000);

test("a note left on the latest version while its replace was on its way: it goes up as the next version instead", async () => {
  const { app, home, id, cleanup } = await exported("ask-share-late-note", [1], {});
  const { named } = fakeCloud({
    // Heard only when the share looks again, just before it would go over v1.
    "reviews:changes": () => ({ notes: [heardNote(id, "n9", 1, "the end is too long")], cursor: 1, more: false }),
    "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
    "reviews:publish": () => ({ reviewId: "r1", url: "https://review.test/r1", version: 2 }),
  });
  try {
    expect(reviews.nextShare(home, id)).toEqual({ version: 1, replace: true });
    expect(await reviews.share(app, id, null, true)).toEqual({ url: "https://review.test/r1", version: 2 });
    expect(named("reviews:publish")).toHaveLength(1);
  } finally {
    cleanup();
  }
}, 30_000);

test("share_for_review by the agent follows the same rule, says which it did, and is on the Exports list while it runs", async () => {
  const { app, home, id, path, cleanup } = await exported("ask-agent-share", [1], {});
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  (app as unknown as { exports: unknown }).exports = {
    running: () => false,
    runningFor: () => null,
    cancel: () => false,
    activity: () => [],
    // The export the share asks for: its file once the test lets it end.
    start: async (_store: unknown, _library: unknown, _project: unknown, _options: unknown, output: string) => {
      void held.then(() => app.store.emit({ type: "export", id, state: "done", progress: 1, path }));
      return output;
    },
  };
  const { named } = fakeCloud({ "reviews:publish": () => ({ reviewId: "r1", url: "https://review.test/r1", version: 2 }) });
  const tool = handlerFor("share_for_review")!.handler;
  const said = async () => ((await tool({ app, args: {}, projectId: id, scope: null })) as { text: string }[])[0]!.text;
  try {
    // No notes on v1: it's replaced.
    const replacing = said();
    await until(() => reviews.sharesGoing().includes(id));
    const row = exportSteps.activity(app, new Set([id])).find((one) => one.id === id);
    expect(row).toMatchObject({ id, state: "running", share: true });
    expect(String(row?.phase)).toStartWith("Sharing: ");
    release();
    expect(await replacing).toStartWith("Replaced v1 on the review link: https://review.test/r1");
    expect(named("reviews:publish")).toEqual([]);
    // A note on v1 now: the next share is v2.
    await until(() => !reviews.sharesGoing().includes(id));
    const state = JSON.parse(fs.readFileSync(`${home}/reviews.json`, "utf8")) as { notes: Record<string, unknown> };
    state.notes.n5 = keptNote(id, "n5", 1);
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify(state));
    expect(reviews.nextShare(home, id)).toEqual({ version: 2, replace: false });
    expect(await said()).toStartWith("Shared as v2 on the review link: https://review.test/r1");
    expect(named("reviews:publish")).toHaveLength(1);
  } finally {
    release();
    cleanup();
  }
}, 30_000);

test("a fix a restart cut short is followed to its end and shares nothing; one from an older build's Ready for changes ends on the page saying so", async () => {
  const { app, home, cleanup } = fixtureHome("ask-resume-fix");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  const sent = panel(app);
  let exported = 0;
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, start: async () => void exported++ };
  try {
    const before = timelineHash(app.store.get(id)!.project);
    // The agent fixed n1 before the restart; the edit changed.
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: { n1: keptNote(id, "n1", 1, { status: "done", fix: { clips: [], ranges: [], summary: "cut", at: Date.now() } }) }, shared: { [id]: shared(id, [1]) } }));
    await app.store.update(id, "test", (project) => void (project.name = "Judge, fixed"));
    const { calls, named } = fakeCloud({ "reviews:fixProgress": () => ({ ok: true }) });
    jobs.begin(home, "fix", id, { reviewId: "r1", noteIds: ["n1"], before, at: Date.now() }, "", "fixing");
    reviews.resumeFix(app, jobs.get(home, jobs.keyOf("fix", id))!);
    await until(() => jobs.get(home, jobs.keyOf("fix", id)) === undefined);
    await reviews.settledForTests();
    expect(jobs.get(home, jobs.keyOf("fix", id))).toBeUndefined();
    expect(exported).toBe(0);
    expect(jobs.list(home, "share")).toEqual([]);
    expect(calls.some((call) => call.path === "reviews:publish" || call.path.startsWith("upload"))).toBe(false);
    expect(sent).toEqual([]);
    expect(named("reviews:fixProgress").at(-1)).toEqual({ machine: machine.id(), reviewId: "r1", state: "done", stage: reviews.FIXED_NOT_UP });
    expect(reviews.FIXED_NOT_UP.length).toBeLessThanOrEqual(120);
  } finally {
    cleanup();
  }
});

test("an older build's share of its fixes, carried over to this one, doesn't go up by itself", async () => {
  const { app, home, cleanup } = fixtureHome("ask-resume-fix-share");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  panel(app);
  let exported = 0;
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, start: async () => void exported++ };
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: shared(id, [1]) } }));
    const { calls, named } = fakeCloud({ "reviews:fixProgress": () => ({ ok: true }) });
    jobs.begin(home, "share", id, { id: "s1", export: { options: {} }, fixes: { reviewId: "r1", next: 2 } }, "", "waiting");
    reviews.resumeShareJob(app, jobs.get(home, reviews.shareKey(id))!);
    await Bun.sleep(200);
    expect(exported).toBe(0);
    expect(calls.some((call) => call.path === "reviews:publish" || call.path.startsWith("upload"))).toBe(false);
    expect(jobs.get(home, reviews.shareKey(id))).toBeUndefined();
    expect(named("reviews:fixProgress")).toEqual([{ machine: machine.id(), reviewId: "r1", state: "done", stage: reviews.FIXED_NOT_UP }]);
  } finally {
    cleanup();
  }
});
