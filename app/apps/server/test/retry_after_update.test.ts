// What failed on the old build, tried again once on the new one, when the Mac
// is idle (the user, Nov 2: "could we make changes so that these failed stuff
// can restart when a new nightly comes on").

import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";

import * as fs from "node:fs";

import { readOnly } from "../src/cloud_projects.ts";
import { chunkFolder, ExportRegistry, failedExports, timelineHash, type ExportFailure } from "../src/exports.ts";
import * as jobs from "../src/jobs.ts";
import * as reviews from "../src/reviews.ts";
import * as retry from "../src/retry_after_update.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";
import { MockServer } from "./mocks/server.ts";
import { THIS_MACHINE } from "../src/machine.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  mock.on("POST", "/v1/cloud/convex", () => Response.json({ status: "success", value: { chosen: false, requests: [] } }));
});

afterAll(() => {
  restore();
  mock.stop();
});

beforeEach(() => reviews.resetCheckInForTests());

/** Nothing running on this Mac, unless a test says so. */
function idle(app: unknown, busy = false): void {
  (app as { exports: unknown }).exports = { running: () => busy, runningFor: () => null };
  (app as { agents: unknown }).agents = { hasRunningTurns: () => false, chat: () => ({ running: false }) };
}

/** What the retries did, in place of exporting and sharing. */
function recorder(): { done: string[]; actions: retry.Actions } {
  const done: string[] = [];
  return {
    done,
    actions: {
      carryOnShare: async (_app, item) => void done.push(`carry on ${item.project}`),
      export: async (_app, failure) => void done.push(`export ${failure.project} ${failure.output}`),
    },
  };
}

const failure = (project: string, extra: Partial<ExportFailure> = {}): ExportFailure => ({
  project, name: project, options: { format: "h264" } as ExportFailure["options"], output: `/out/${project}.mp4`, error: "Native encoder stalled", at: 1, build: "nightly-47", ...extra,
});

/**
 * A home where `mom`'s share, asked for by someone, failed at its upload after its export was made (its export of
 * the edit as it is now on record), `cops`'s export failed, and `fixes`'s share, one an older build started by itself
 * after a Ready for changes, failed (never tried again: Sphe, Nov 21, nothing goes up unless someone asks); `old`
 * the build that ran last.
 */
function setUp(name: string, old: string | null) {
  const fixture = fixtureHome(name);
  const { app, home } = fixture;
  const mom = app.store.createAs("Mom Secretly", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
  const cops = app.store.createAs("Cops Surprise", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
  const fixes = app.store.createAs("Fixed By Itself", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
  const version = { n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] };
  fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [mom]: { reviewId: "r1", url: "u", versions: [version] }, [fixes]: { reviewId: "r2", url: "u2", versions: [version] } } }));
  const path = `${home}/mom.mp4`;
  fs.writeFileSync(path, "video");
  fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ [mom]: [{ path, whole: true, timeline: timelineHash(app.store.get(mom)!.project), bytes: 5, frames: 300 }] }));
  jobs.settle(home, jobs.begin(home, "share", mom, { id: "asked", export: { options: {} }, path }, "", "uploading"), "failed", { error: "R2 part 813 failed" });
  jobs.settle(home, jobs.begin(home, "share", fixes, { id: "by-itself", fixes: { reviewId: null, next: 2 } }, "", "exporting"), "failed", { error: "sharing the fixes failed on an earlier build" });
  // A share's own export failing too: that's the share's to try again, not the export's.
  for (const { project, error, at: _at, build, ...args } of [failure(cops), failure(mom, { share: true })]) {
    jobs.settle(home, jobs.begin(home, "export", project, args), "failed", { error, build });
  }
  if (old !== null) fs.writeFileSync(`${home}/last-build.json`, JSON.stringify({ build: old }));
  idle(app);
  return { ...fixture, mom, cops, fixes };
}

test("a new build tries again, once and one at a time, the share someone asked for that failed after its export and the export that failed; never an older build's share of its fixes", async () => {
  const { app, home, mom, cops, cleanup } = setUp("retry-new-build", "nightly-47");
  try {
    // `fixes`'s share isn't queued: an older build started it by itself, and nothing goes up unless someone asks.
    expect(retry.noteBuild(app, "nightly-48").map((one) => `${one.kind} ${one.project}`)).toEqual([`share ${mom}`, `export ${cops}`]);
    // A stale chunk cache goes before it's tried, so it renders fresh.
    // A Vertical export's (its own folder, render.rs chunk_name) goes too; smooth playback's stays.
    const vertical = chunkFolder(app.store.cacheDir(), `${cops}.1080x1920-Blur`);
    const playback = chunkFolder(app.store.cacheDir(), `${cops}.playback`);
    for (const folder of [chunkFolder(app.store.cacheDir(), cops), vertical, playback]) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(`${folder}/manifest-v1.json`, "{}");
    }
    const { done, actions } = recorder();
    expect(await retry.step(app, actions)).toBe("shared from its step");
    expect(await retry.step(app, actions)).toBe("exported");
    expect(fs.existsSync(chunkFolder(app.store.cacheDir(), cops))).toBe(false);
    expect(fs.existsSync(vertical)).toBe(false);
    expect(fs.existsSync(playback)).toBe(true);
    expect(done).toEqual([`carry on ${mom}`, `export ${cops} /out/${cops}.mp4`]);
    // Each was taken once: nothing's left, and starting again on the same build queues nothing.
    expect(await retry.step(app, actions)).toBeNull();
    expect(retry.noteBuild(app, "nightly-48")).toEqual([]);
    expect(retry.pending(home)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("what failed only after its render keeps what it rendered: a share whose export was made goes on from its step, an export stopped by the line exports again from its chunks", async () => {
  const { app, home, mom, cops, cleanup } = setUp("retry-keeps-chunks", "nightly-47");
  try {
    // Mom's share failed at its upload, its export made (setUp); Cops' export failed on the relay, not on its picture.
    jobs.settle(home, jobs.begin(home, "export", cops, failure(cops) as unknown as Record<string, unknown>), "failed", { error: "could not reach Edit's relay: The socket connection was closed unexpectedly", build: "nightly-47" });
    retry.noteBuild(app, "nightly-48");
    for (const project of [mom, cops]) {
      fs.mkdirSync(chunkFolder(app.store.cacheDir(), project), { recursive: true });
      fs.writeFileSync(`${chunkFolder(app.store.cacheDir(), project)}/manifest-v1.json`, "{}");
    }
    const { done, actions } = recorder();
    expect(await retry.step(app, actions)).toBe("shared from its step");
    expect(done).toEqual([`carry on ${mom}`]);
    expect(fs.existsSync(chunkFolder(app.store.cacheDir(), mom))).toBe(true);
    expect(failedExports(home)[cops]?.error).toContain("could not reach Edit's relay");
    expect(await retry.step(app, actions)).toBe("exported");
    expect(fs.existsSync(chunkFolder(app.store.cacheDir(), cops))).toBe(true);
  } finally {
    cleanup();
  }
});

test("a plain share (not an older build's of its fixes) that failed after its export was made is carried on by a new build, once; one still to export, one whose edit changed since and one weeks old aren't", async () => {
  const { app, home, mom, cops, cleanup } = setUp("retry-plain-share", "nightly-47");
  try {
    const exported = app.store.createAs("First Share", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
    const unexported = app.store.createAs("Never Exported", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
    const changed = app.store.createAs("Changed Since", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
    const old = app.store.createAs("Weeks Old", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
    // Each export's file and record; Changed Since's was made from another edit.
    const records = JSON.parse(fs.readFileSync(`${home}/exports.json`, "utf8")) as Record<string, unknown[]>;
    for (const [project, timeline] of [[exported, timelineHash(app.store.get(exported)!.project)], [changed, "an-older-edit"], [old, timelineHash(app.store.get(old)!.project)]] as const) {
      const path = `${home}/${project}.mp4`;
      fs.writeFileSync(path, "video");
      records[project] = [{ path, whole: true, timeline, bytes: 5 }];
      jobs.settle(home, jobs.begin(home, "share", project, { id: project, export: { options: {} }, path }, "", "uploading"), "failed", { error: "R2 refused the upload (403)" });
    }
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify(records));
    const rows = JSON.parse(fs.readFileSync(`${home}/jobs.json`, "utf8")) as jobs.Job[];
    for (const row of rows) if (row.project === old) row.updated_ms = Date.now() - 30 * 86_400_000;
    fs.writeFileSync(`${home}/jobs.json`, JSON.stringify(rows));
    jobs.settle(home, jobs.begin(home, "share", unexported, { id: "second", export: { options: {} } }, "", "exporting"), "failed", { error: "Native encoder stalled" });
    const queued = retry.noteBuild(app, "nightly-48").map((one) => `${one.kind} ${one.project}`);
    expect(queued).toContain(`share ${exported}`);
    expect(queued).not.toContain(`share ${unexported}`);
    expect(queued).not.toContain(`share ${old}`);
    const { done, actions } = recorder();
    while ((await retry.step(app, actions)) !== null);
    expect(done).toContain(`carry on ${exported}`);
    expect(done).not.toContain(`carry on ${changed}`);
    expect(done).toContain(`export ${cops} /out/${cops}.mp4`);
    // Mom's (setUp's) and First Share's, each once.
    expect(done.filter((one) => one.startsWith("carry on ")).sort()).toEqual([`carry on ${exported}`, `carry on ${mom}`].sort());
    expect(retry.noteBuild(app, "nightly-48")).toEqual([]);
  } finally {
    cleanup();
  }
});

test("the build that ran before was never noted (older builds didn't): it counts as new", () => {
  const { app, cleanup } = setUp("retry-first-noted", null);
  try {
    expect(retry.noteBuild(app, "nightly-48")).toHaveLength(2);
  } finally {
    cleanup();
  }
});

test("the same build tries nothing again", () => {
  const { app, home, cleanup } = setUp("retry-same-build", "nightly-48");
  try {
    expect(retry.noteBuild(app, "nightly-48")).toEqual([]);
    expect(retry.pending(home)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("a busy Mac (an export, an agent turn) waits, and the queue is kept for when it's idle", async () => {
  const { app, home, cleanup } = setUp("retry-busy", "nightly-47");
  try {
    retry.noteBuild(app, "nightly-48");
    const { done, actions } = recorder();
    idle(app, true);
    expect(await retry.step(app, actions)).toBeNull();
    idle(app);
    (app as unknown as { agents: unknown }).agents = { hasRunningTurns: () => true, chat: () => ({ running: true }) };
    expect(await retry.step(app, actions)).toBeNull();
    expect(done).toEqual([]);
    expect(retry.pending(home)).toHaveLength(2);
    idle(app);
    expect(await retry.step(app, actions)).toBe("shared from its step");
  } finally {
    cleanup();
  }
});

// A reviewer's Ready for changes asked of this Mac used to stand in for the retry ("that request does it"); a request
// starts nothing now (Sphe, Nov 21), so it no longer keeps the share someone asked for from being carried on.
test(`never on a project another computer holds, nor a share on an approved review; a Ready for changes asked of ${THIS_MACHINE} doesn't stop it`, async () => {
  const { app, home, mom, cops, cleanup } = setUp("retry-skipped", "nightly-47");
  try {
    retry.noteBuild(app, "nightly-48");
    const { done, actions } = recorder();
    // Mom's review approved meanwhile; Cops open on Sphe's MacBook Air.
    const state = JSON.parse(fs.readFileSync(`${home}/reviews.json`, "utf8")) as { shared: Record<string, Record<string, unknown>> };
    state.shared[mom]!.approved = { version: 1, by: "JJ", at: 2 };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify(state));
    (app.store as unknown as { mayWrite: unknown }).mayWrite = async (id: string) => {
      if (id === cops) throw new Error(readOnly("Sphe's MacBook Air"));
    };
    expect(await retry.step(app, actions)).toBe("skipped: v1 of its review was approved");
    expect(await retry.step(app, actions)).toBe("skipped: the project is open on Sphe's MacBook Air");
    expect(done).toEqual([]);
    expect(retry.pending(home)).toEqual([]);
    // Asked again of this Mac: the request is answered and starts nothing, and the retry goes on.
    delete state.shared[mom]!.approved;
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify(state));
    retry.noteBuild(app, "nightly-49");
    mock.on("POST", "/v1/cloud/convex", (request) => {
      const { path } = request.json<{ path: string }>();
      return Response.json({ status: "success", value: path === "reviews:checkIn" ? { chosen: true, requests: [{ reviewId: "r1", sourceId: mom, title: "Mom Secretly", requestedAt: 3 }] } : path === "reviews:changes" ? { notes: [], cursor: 0, more: false } : path === "reviews:open" ? [{ sourceId: mom, reviewId: "r1", approved: null }] : { ok: false, reason: "gone" } });
    });
    await reviews.checkIn(app);
    expect(await retry.step(app, actions)).toBe("shared from its step");
    expect(done).toEqual([`carry on ${mom}`]);
  } finally {
    mock.on("POST", "/v1/cloud/convex", () => Response.json({ status: "success", value: { chosen: false, requests: [] } }));
    cleanup();
  }
});

test("a retry that fails again is a normal failure, not tried again until the next build", async () => {
  const { app, home, cops, cleanup } = setUp("retry-fails-again", "nightly-47");
  try {
    retry.noteBuild(app, "nightly-48");
    let tries = 0;
    const actions: retry.Actions = {
      carryOnShare: async () => {
        tries++;
        throw new Error("sharing v2 failed");
      },
      export: async () => {
        tries++;
      },
    };
    expect(await retry.step(app, actions)).toBe("failed: sharing v2 failed");
    expect(await retry.step(app, actions)).toBe("exported");
    expect(await retry.step(app, actions)).toBeNull();
    expect(retry.noteBuild(app, "nightly-48")).toEqual([]);
    expect(tries).toBe(2);
    // The export failed again (still noted): the next build tries it again.
    expect(failedExports(home)[cops]).toBeDefined();
    expect(retry.noteBuild(app, "nightly-49").map((one) => one.kind)).toEqual(["share", "export"]);
  } finally {
    cleanup();
  }
});

test("an export that fails is noted with its settings and build, a share's as a share's, and forgotten once the project exports; the panel says a retry's note", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("retry-noted-failures");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  let fail = true;
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => ({
    cancel: () => {},
    wait: async () => {
      if (fail) throw new Error("Native encoder stalled");
      fs.writeFileSync(job.output, "export");
      return { seconds: 1, bytes: 6 };
    },
  }));
  const settle = async () => {
    for (let tries = 0; registry.running() && tries < 200; tries++) await Bun.sleep(5);
  };
  try {
    const project = store.create("one", { width: 64, height: 36, fps: 30 }).project;
    await store.update(project.id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    const options = native.exportDefaults();
    await registry.start(store, app.library, store.get(project.id)!.project, options, `${dir}/one.mp4`, { share: true });
    await settle();
    const noted = failedExports(home)[project.id];
    expect(noted).toMatchObject({ project: project.id, error: expect.stringContaining("Native encoder stalled"), share: true, options: { format: options.format } });
    expect(typeof noted?.build).toBe("string");
    // The retry: its note in the panel; succeeding, the failure is forgotten.
    fail = false;
    await registry.start(store, app.library, store.get(project.id)!.project, options, `${dir}/one.mp4`, { note: retry.NOTE });
    expect(registry.activity()[0]?.note).toBe(retry.NOTE);
    await settle();
    expect(registry.activity()[0]).toMatchObject({ state: "done", note: retry.NOTE });
    expect(failedExports(home)[project.id]).toBeUndefined();
  } finally {
    render.mockRestore(); plan.mockRestore(); cleanup();
  }
});

test("the real retry of a share carries it on from its step with the export it has, and a failure leaves it for the next build", async () => {
  const { app, home, mom, fixes, cleanup } = setUp("retry-real-share", "nightly-47");
  const started: Record<string, unknown>[] = [];
  (app as unknown as { exports: unknown }).exports = {
    running: () => false,
    runningFor: () => null,
    cancel: () => false,
    exported: () => false,
    start: async (_store: unknown, _library: unknown, _project: unknown, _options: unknown, path: string, extra: Record<string, unknown>) => {
      started.push(extra);
      return path;
    },
  };
  try {
    retry.noteBuild(app, "nightly-48");
    // Carried on from its upload's step (the review copy is made again first: it isn't here)…
    expect(await retry.step(app)).toStartWith("failed: ");
    // …nothing exported again: its export is made. The fixture's export isn't a video, so the share stops at its
    // review copy: failed again, it's still one to carry on, for the next build.
    expect(started).toEqual([]);
    expect(jobs.get(home, reviews.shareKey(mom))?.state).toBe("failed");
    expect(reviews.carriedOn(home, mom)).toBe(true);
    const next = retry.noteBuild(app, "nightly-49");
    expect(next.some((one) => one.kind === "share" && one.project === mom)).toBe(true);
    // The older build's share of its fixes is never queued, on this build or the next.
    expect(next.some((one) => one.project === fixes)).toBe(false);
  } finally {
    cleanup();
  }
});
