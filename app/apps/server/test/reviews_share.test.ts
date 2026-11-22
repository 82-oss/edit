// A share is one job with steps (export → review copy → copy check → upload →
// publish), each written before the next starts, so a share a restart cut short
// carries on from its last finished step without doing one twice (the Nov 8
// audit, item B: a restart mid-share after its export resumed nothing, and the
// Share dialog said "Up on the link" on the export's end, before the copy, the
// upload and the publish).

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as cloud from "../src/cloud.ts";
import * as jobs from "../src/jobs.ts";
import * as remote from "../src/remote_actions.ts";
import * as reviews from "../src/reviews.ts";
import * as seams from "../src/seams.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";

const spies: { mockRestore(): void }[] = [];
afterEach(async () => {
  await Bun.sleep(20);
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** The cloud as a share sees it: R2 by key, Repack's versions (with their meta), every call kept. */
function fakeCloud(refuse: () => boolean = () => false) {
  const r2 = new Map<string, number>();
  const versions: { n: number; meta: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  /** Each upload by its file's name: whether a share had the line out then, and whether it was sent behind one. */
  const line: Record<string, { taken: boolean; behind: boolean }> = {};
  spies.push(
    spyOn(cloud, "enabled").mockReturnValue(true),
    spyOn(cloud, "uploadFile").mockImplementation(async (from: string, key: string, _progress?: unknown, _signal?: unknown, behind = false) => {
      calls.push(`upload ${key.split("/").pop()}`);
      line[key.split("/").pop()!] = { taken: cloud.lineTaken(), behind };
      r2.set(key, fs.statSync(from).size);
    }),
    spyOn(cloud, "head").mockImplementation(async (key: string) => (r2.has(key) ? { size: r2.get(key)!, etag: null, contentType: null } : null)),
    spyOn(cloud, "query").mockImplementation(async (name: string) => {
      calls.push(name);
      return (name === "reviews:get" ? { reviewId: "r1", url: "https://review.test/r1", versions } : null) as never;
    }),
    spyOn(cloud, "mutation").mockImplementation(async (name: string, args: unknown) => {
      if (name === "reviews:setMeta") return null as never;
      calls.push(name);
      if (name === "reviews:publish") {
        if (refuse()) throw new Error("Repack didn't answer");
        const n = versions.length + 1;
        versions.push({ n, meta: (args as { meta: Record<string, unknown> }).meta });
        return { reviewId: "r1", url: "https://review.test/r1", version: n } as never;
      }
      return null as never;
    }),
  );
  // The steps' own calls: the copy, the poster, the publish (describe's JSON beside the video and the full-quality file behind aren't steps).
  const steps = () => calls.filter((one) => ["upload video.mp4", "upload poster.jpg", "reviews:publish", "reviews:compress"].includes(one));
  return { r2, versions, calls, steps, line };
}

const ffmpeg = (...args: string[]) => tools.run([tools.ffmpeg(), "-v", "error", "-nostdin", "-y", ...args]);

/** A project with a whole export on record (6 s, picture and sound), and where its review copy goes. */
async function exported(name: string) {
  const fixture = fixtureHome(name);
  const { app, home, dir } = fixture;
  const id = app.store.createAs("Cops Realize", "bodycam", { width: 160, height: 120, fps: 30 }).project.id;
  const path = nodePath.join(dir, "Cops Realize.mp4");
  await ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-f", "lavfi", "-i", "sine=r=48000", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path);
  const record = { path, name: "Cops Realize.mp4", finished_ms: Date.now(), seconds: 1, bytes: fs.statSync(path).size, frames: 180, whole: true, start: 0, format: "h264", timeline: "t1" };
  fs.writeFileSync(nodePath.join(home, "exports.json"), JSON.stringify({ [id]: [record] }));
  const work = nodePath.join(home, "cache", "reviews", id);
  // Nothing else running on this Mac.
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false };
  (app as unknown as { agents: unknown }).agents = { hasRunningTurns: () => false, chat: () => ({ running: false }) };
  return { ...fixture, id, path, copy: nodePath.join(work, "t1.mp4"), poster: nodePath.join(work, "t1.jpg"), work };
}

/** The share's job as a restart left it: after `step`, with what the steps before it made. */
function cutShort(home: string, id: string, step: string, args: Record<string, unknown>, attempts = 0): void {
  const now = Date.now();
  fs.writeFileSync(nodePath.join(home, "jobs.json"), JSON.stringify([{ key: `share:${id}`, kind: "share", project: id, args: { id: "s1", path: null, ...args }, state: "running", step, attempts, started_ms: now - 60_000, updated_ms: now }]));
}

/** Carries the listed share on, as serve.ts's resumer does after a restart, and waits for it to end. */
async function carryOn(app: Parameters<typeof reviews.resumeShareJob>[0], home: string, id: string): Promise<void> {
  await jobs.resume(home, { share: (job) => reviews.resumeShareJob(app, job) }, ["share"]);
  // Up to 20 s: the whole suite at once on every core took the share past 4 s (Nov 13), never a real hang.
  for (let tries = 0; tries < 2000 && jobs.live(jobs.get(home, `share:${id}`)!); tries++) await Bun.sleep(10);
}

test("a share runs its steps in order, says each where the dialog reads it, and is up on the link only once published", async () => {
  const { app, home, id, cleanup } = await exported("share-steps");
  const { calls, versions, steps: made, line } = fakeCloud();
  const steps: string[] = [];
  const step = jobs.step;
  spies.push(spyOn(jobs, "step").mockImplementation((...given: Parameters<typeof jobs.step>) => {
    steps.push(given[2]);
    step(...given);
  }));
  try {
    const shared = reviews.share(app, id, null);
    // Listed at once, and what the dialog reads says it's going, not up.
    expect(reviews.shareNow(home, id).share?.state).toBe("running");
    expect(reviews.shareNow(home, id).line).not.toBeNull();
    expect(remote.busyWith(app)).toContain("a share");
    expect(await shared).toEqual({ url: "https://review.test/r1", version: 1 });
    expect(steps.filter((one, at) => one !== steps[at - 1])).toEqual(["review copy", "copy check", "uploading", "publishing"]);
    expect(made()).toEqual(["upload video.mp4", "upload poster.jpg", "reviews:publish"]);
    // Its version is named by this share, so a publish carried on after a restart is never made twice.
    expect(typeof versions[0]!.meta.share).toBe("string");
    expect(reviews.shareNow(home, id)).toEqual({ line: null, share: expect.objectContaining({ state: "done", version: 1, url: "https://review.test/r1" }) });
    // Done in the same write that listed its full-quality upload, which goes on behind, after the publish.
    expect(calls.indexOf("upload full.mp4")).toBeGreaterThan(calls.indexOf("reviews:publish"));
    // The line out was the share's while its copy went up (what's waited for), and the full-quality file is sent
    // behind any share: on a home line the two had gone up together and the link took twice as long (JJ, Nov 9).
    expect(line["video.mp4"]).toEqual({ taken: true, behind: false });
    expect(line["full.mp4"]!.behind).toBe(true);
    expect(cloud.lineTaken()).toBe(false);
    expect(remote.busyWith(app)).not.toContain("a share");
  } finally {
    cleanup();
  }
});

test("cut short after the review copy was made and checked: carried on from the upload, the copy not made again", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-after-copy");
  const { steps } = fakeCloud();
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    const made = fs.statSync(copy).mtimeMs;
    cutShort(home, id, "uploading", { checked: true });
    // A restart cut it short: listed and going, so an update waits for it.
    expect(remote.busyWith(app)).toContain("a share");
    await carryOn(app, home, id);
    expect(steps()).toEqual(["upload video.mp4", "upload poster.jpg", "reviews:publish"]);
    expect(fs.existsSync(copy) ? fs.statSync(copy).mtimeMs : made).toBe(made);
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done", version: 1 });
  } finally {
    cleanup();
  }
});

test("cut short mid-upload with the copy already up on R2: it isn't sent again", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-mid-upload");
  const { r2, steps } = fakeCloud();
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    r2.set(`edit/reviews/${id}/t1/video.mp4`, fs.statSync(copy).size);
    cutShort(home, id, "uploading", { checked: true });
    await carryOn(app, home, id);
    expect(steps()).toEqual(["upload poster.jpg", "reviews:publish"]);
  } finally {
    cleanup();
  }
});

test("cut short after the upload: carried on from the publish, nothing sent again", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-after-upload");
  const { steps } = fakeCloud();
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    cutShort(home, id, "publishing", { checked: true, uploaded: true });
    await carryOn(app, home, id);
    expect(steps()).toEqual(["reviews:publish"]);
    expect(reviews.read(home).shared[id]?.versions.map((one) => one.n)).toEqual([1]);
  } finally {
    cleanup();
  }
});

test("cut short between Repack taking the version and this Mac noting it: the version is found by the share's id, never published twice", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-after-publish");
  const { calls, versions } = fakeCloud();
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    versions.push({ n: 1, meta: { share: "s1" } });
    cutShort(home, id, "publishing", { checked: true, uploaded: true });
    await carryOn(app, home, id);
    expect(calls).not.toContain("reviews:publish");
    expect(reviews.read(home).shared[id]).toMatchObject({ reviewId: "r1", url: "https://review.test/r1", versions: [expect.objectContaining({ n: 1 })] });
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done", version: 1 });
  } finally {
    cleanup();
  }
});

test("cut short as its export finished (the export listed, the share not told): that export is shared, not exported again", async () => {
  const { app, home, id, store, cleanup } = await exported("share-after-export");
  const { calls } = fakeCloud();
  let exports = 0;
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, start: async () => void exports++ };
  try {
    const project = store.get(id)!.project;
    const snapshot = nodePath.join(home, "jobs", `share-${id}.json`);
    fs.mkdirSync(nodePath.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, JSON.stringify(project));
    // The export on record is of this edit, finished after the share began.
    const records = JSON.parse(fs.readFileSync(nodePath.join(home, "exports.json"), "utf8")) as Record<string, Record<string, unknown>[]>;
    records[id]![0]!.timeline = (await import("../src/exports.ts")).timelineHash(project);
    fs.writeFileSync(nodePath.join(home, "exports.json"), JSON.stringify(records));
    const now = Date.now();
    fs.writeFileSync(nodePath.join(home, "jobs.json"), JSON.stringify([{ key: `share:${id}`, kind: "share", project: id, args: { id: "s1", export: { options: {} }, snapshot }, state: "running", step: "exporting", attempts: 0, started_ms: now - 60_000, updated_ms: now }]));
    await carryOn(app, home, id);
    expect(exports).toBe(0);
    expect(calls).toContain("reviews:publish");
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done" });
    // Its kept edit goes once it's shared.
    expect(fs.existsSync(snapshot)).toBe(false);
  } finally {
    cleanup();
  }
});

test("a share that meets trouble that passes waits and says the link comes by itself, never \"Sharing stopped\"; it carries on from that step", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-fails");
  let refuse = true;
  const { steps } = fakeCloud(() => refuse);
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    cutShort(home, id, "publishing", { checked: true, uploaded: true });
    await jobs.resume(home, { share: (job) => reviews.resumeShareJob(app, job) }, ["share"]);
    for (let tries = 0; tries < 2000 && jobs.get(home, `share:${id}`)?.state === "running"; tries++) await Bun.sleep(10);
    // Repack not answering passes: the share waits in the job table, still going, its step saying so, no error.
    const waiting = reviews.shareNow(home, id).share!;
    expect(waiting).toMatchObject({ state: "running", step: "Waiting for the connection. The link comes by itself." });
    expect(waiting.error).toBeUndefined();
    expect(jobs.get(home, jobs.keyOf("share", id))).toMatchObject({ state: "waiting" });
    refuse = false;
    expect(await reviews.retryShare(app, id)).toEqual({ url: "https://review.test/r1", version: 1 });
    // The copy and poster aren't sent again: only the publish, which failed, then went.
    expect(steps()).toEqual(["reviews:publish", "reviews:publish"]);
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done" });
  } finally {
    cleanup();
  }
});

test("a share cancelled before a restart carried it on is crossed off, not left blocking the next", async () => {
  const { app, home, id, cleanup } = await exported("share-cancel-listed");
  fakeCloud();
  try {
    cutShort(home, id, "uploading", { checked: true });
    expect(reviews.cancelShare(app, id)).toBe(true);
    expect(jobs.get(home, `share:${id}`)).toBeUndefined();
    expect(remote.busyWith(app)).not.toContain("a share");
  } finally {
    cleanup();
  }
});

/** The review copy's FFmpeg as one that never ends by itself (a VideoToolbox session dead under it): only its signal ends it. */
function hangingCopy(): { entered: () => number } {
  const real = tools.run;
  let entered = 0;
  spies.push(spyOn(tools, "run").mockImplementation((command: string[], options?: { signal?: AbortSignal }) => {
    if (!command.some((arg) => arg.endsWith(".partial.mp4"))) return real(command, options);
    entered += 1;
    return new Promise<Uint8Array>((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("killed")), { once: true }));
  }));
  return { entered: () => entered };
}

test("Cancel ends a share whose review copy never ends by itself, at once", async () => {
  // Nov 20: the share's FFmpeg runs had no Cancel and four hours each; "cancelling" sat on the dialog all that time.
  const { app, home, id, cleanup } = await exported("share-cancel-copy");
  fakeCloud();
  const copy = hangingCopy();
  try {
    const shared = reviews.share(app, id, null);
    shared.catch(() => {});
    for (let tries = 0; copy.entered() === 0 && tries < 500; tries++) await Bun.sleep(10);
    expect(copy.entered()).toBe(1);
    const asked = Date.now();
    expect(reviews.cancelShare(app, id)).toBe(true);
    await expect(shared).rejects.toThrow("the share was cancelled");
    expect(Date.now() - asked).toBeLessThan(5000);
    // Not tried again on libx264 after the Cancel, and crossed off.
    expect(copy.entered()).toBe(1);
    expect(jobs.get(home, `share:${id}`)).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("a review copy that stands still is stopped, and the share waits and goes on by itself, never \"Sharing stopped\"", async () => {
  const { app, home, id, cleanup } = await exported("share-still-copy");
  fakeCloud();
  const copy = hangingCopy();
  const still = reviews.shareTools.stillMs;
  reviews.shareTools.stillMs = 300;
  try {
    const shared = reviews.share(app, id, null);
    await expect(shared).rejects.toBeInstanceOf(reviews.ShareWaits);
    // The hardware's, then libx264's: both stood still.
    expect(copy.entered()).toBeGreaterThanOrEqual(1);
    expect(jobs.get(home, jobs.keyOf("share", id))).toMatchObject({ state: "waiting" });
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "running", step: expect.stringMatching(/^Making the review copy made no progress .* The link comes by itself\.$/) });
    // A longer video has longer; none has less than ten minutes.
    expect(reviews.shareTools.ms(3600)).toBeGreaterThan(reviews.shareTools.ms(60));
    expect(reviews.shareTools.ms(0)).toBe(10 * 60_000);
  } finally {
    reviews.shareTools.stillMs = still;
    cleanup();
  }
});

test("a share's review copy says how far it is, from FFmpeg's own report, and never 100% before it's whole", async () => {
  // Nov 21: a share's review copy took 2 min 14 s on a MacBook Air with no percent at all ("making the review copy").
  const { app, home, id, cleanup } = await exported("share-copy-percent");
  fakeCloud();
  const looks = reviews.copyLooks.everyMs;
  reviews.copyLooks.everyMs = 20;
  const real = tools.run;
  let entered = 0;
  // The copy's FFmpeg reports a second of the 6 s video every 60 ms into its `-progress` file, then stands until stopped.
  spies.push(spyOn(tools, "run").mockImplementation((command: string[], options?: { signal?: AbortSignal }) => {
    if (!command.some((arg) => arg.endsWith(".partial.mp4"))) return real(command, options);
    entered += 1;
    const at = command.indexOf("-progress");
    const report = at < 0 ? null : command[at + 1]!;
    let second = 0;
    const timer = setInterval(() => {
      if (report === null || second >= 5) return;
      second += 1;
      fs.appendFileSync(report, `frame=${second * 30}\nout_time_us=${second * 1_000_000}\nout_time_ms=${second * 1_000_000}\nprogress=continue\n`);
    }, 60);
    return new Promise<Uint8Array>((_, reject) =>
      options?.signal?.addEventListener("abort", () => {
        clearInterval(timer);
        reject(new Error("killed"));
      }, { once: true }),
    );
  }));
  try {
    const shared = reviews.share(app, id, null);
    shared.catch(() => {});
    const lines: string[] = [];
    const end = Date.now() + 8_000;
    while (Date.now() < end && !lines.includes("making the review copy 83%")) {
      const line = reviews.shareNow(home, id).line;
      if (line !== null && line !== lines.at(-1)) lines.push(line);
      await Bun.sleep(5);
    }
    expect(entered).toBe(1);
    const percents = lines.map((line) => /^making the review copy (\d+)%$/.exec(line)?.[1]).filter((one) => one !== undefined).map(Number);
    expect(percents.length).toBeGreaterThanOrEqual(2);
    expect(percents.at(-1)).toBe(83);
    for (let at = 1; at < percents.length; at++) expect(percents[at]!).toBeGreaterThan(percents[at - 1]!);
    reviews.cancelShare(app, id);
    await expect(shared).rejects.toThrow("the share was cancelled");
  } finally {
    reviews.copyLooks.everyMs = looks;
    cleanup();
  }
}, 30_000);

// Audit E7 (Nov 21): a share's waits for its graphics (effect renders, map shots, then slowed shots) took no Cancel:
// 20 minutes each, up to three times, the share's stop looked at only after; and an export fetched back from the cloud
// ran its whole download. "Stopping…" sat on the dialog all that time, and no new share could start.
/** `wait` as one that never ends by itself (a render that takes its 20 minutes): the test lets it go at the end. */
function hangingWait(name: "waitForMaps" | "waitForSmoothing"): { entered: () => number; release: () => void } {
  let entered = 0;
  const waiting: (() => void)[] = [];
  spies.push(spyOn(seams.broll, name).mockImplementation((async () => {
    entered += 1;
    await new Promise<void>((resolve) => waiting.push(resolve));
    return true;
  }) as never));
  return { entered: () => entered, release: () => waiting.splice(0).forEach((resolve) => resolve()) };
}

/** Settled within `ms`, or "still going". */
const within = <T>(work: Promise<T>, ms: number) => Promise.race([work.then(() => "ended", (error: unknown) => (error as Error).message), Bun.sleep(ms).then(() => "still going")]);

for (const [name, line] of [["waitForMaps", "waiting for map shots"], ["waitForSmoothing", "waiting for slowed shots"]] as const) {
  test(`Cancel while a share's export ${line}: it stops at once, and a new share can start`, async () => {
    const { app, home, id, cleanup } = await exported(`share-cancel-${name}`);
    fakeCloud();
    if (name === "waitForSmoothing") spies.push(spyOn(seams.broll, "waitForMaps").mockImplementation(async () => {}));
    const wait = hangingWait(name);
    try {
      const shared = reviews.exportAndShare(app, id, {});
      shared.catch(() => {});
      for (let tries = 0; wait.entered() === 0 && tries < 500; tries++) await Bun.sleep(10);
      expect(reviews.shareNow(home, id).line).toBe(line);
      expect(reviews.cancelShare(app, id)).toBe(true);
      // Generous for CI's slow Mac: at once here.
      expect(await within(shared, 3_000)).toBe("the share was cancelled");
      expect(jobs.get(home, jobs.keyOf("share", id))).toBeUndefined();
      // The next share isn't refused as one under way.
      const again = reviews.exportAndShare(app, id, {});
      again.catch(() => {});
      for (let tries = 0; wait.entered() < 2 && tries < 500; tries++) await Bun.sleep(10);
      expect(wait.entered()).toBe(2);
      reviews.cancelShare(app, id);
      expect(await within(again, 3_000)).toBe("the share was cancelled");
    } finally {
      wait.release();
      cleanup();
    }
  }, 30_000);
}

test("Cancel while a share fetches its export back from the cloud: the download is stopped, and the share with it", async () => {
  const { app, home, id, path, cleanup } = await exported("share-cancel-fetch");
  fakeCloud();
  // Archived and gone from here (the disk short).
  const records = JSON.parse(fs.readFileSync(nodePath.join(home, "exports.json"), "utf8")) as Record<string, Record<string, unknown>[]>;
  records[id]![0]!.cloudKey = `edit/exports/${id}/Cops Realize.mp4`;
  fs.writeFileSync(nodePath.join(home, "exports.json"), JSON.stringify(records));
  fs.rmSync(path);
  let fetching = 0;
  let stopped = false;
  const ends: (() => void)[] = [];
  spies.push(spyOn(cloud, "download").mockImplementation((_key: string, _dest: string, _progress?: unknown, signal?: AbortSignal) => {
    fetching += 1;
    // A multi-GB fetch: ends only when it's stopped (or the test lets it go).
    return new Promise<void>((resolve, reject) => {
      ends.push(resolve);
      signal?.addEventListener("abort", () => {
        stopped = true;
        reject(new Error("download was cancelled"));
      }, { once: true });
    });
  }));
  try {
    const shared = reviews.share(app, id, null);
    shared.catch(() => {});
    for (let tries = 0; fetching === 0 && tries < 500; tries++) await Bun.sleep(10);
    expect(reviews.shareNow(home, id).line).toBe("fetching the export back from the cloud");
    expect(reviews.cancelShare(app, id)).toBe(true);
    expect(await within(shared, 3_000)).toBe("the share was cancelled");
    expect(stopped).toBe(true);
    expect(jobs.get(home, jobs.keyOf("share", id))).toBeUndefined();
  } finally {
    ends.splice(0).forEach((end) => end());
    cleanup();
  }
}, 30_000);

test("a review copy made from the export's chunks says how far each piece being made is, not only as each one ends", async () => {
  // Nov 22, a MacBook Air: 0% until it jumped to 95%, its own pace never heard and the share's percent held through it.
  const dir = fs.mkdtempSync(nodePath.join(process.env.HOME ?? "/tmp", ".cache", "review-pieces-"));
  try {
    const source = nodePath.join(dir, "export.mp4");
    fs.writeFileSync(source, "an export");
    const folder = nodePath.join(dir, "export-chunks", "p1");
    fs.mkdirSync(folder, { recursive: true });
    // Two chunks of 300 frames: a 20 s video at 30 fps.
    fs.writeFileSync(nodePath.join(folder, "manifest-v1.json"), JSON.stringify({ output: source, size: fs.statSync(source).size, fps: 30, chunks: [{ key: "a", at: 0, frames: 300 }, { key: "b", at: 300, frames: 300 }] }));
    const real = nodePath.join(dir, "real.mp4");
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=30", "-t", "0.2", "-c:v", "libx264", "-preset", "ultrafast", real]);
    const told: number[] = [];
    // Each piece's FFmpeg reports a quarter of its 10 s made, then half, as a share of the whole 20 s, then ends.
    const run = async (command: string[], output?: string, tell?: (share: number) => void): Promise<Uint8Array> => {
      if (command.includes("concat")) {
        fs.writeFileSync(output!, "joined");
        return new Uint8Array();
      }
      if (output !== undefined) {
        tell?.(2.5 / 20);
        tell?.(5 / 20);
        fs.copyFileSync(real, output);
      }
      return new Uint8Array();
    };
    expect(await reviews.reviewCopyFromChunks(dir, "p1", source, nodePath.join(dir, "copy.mp4"), run, undefined, (share) => told.push(share))).toBe(true);
    // Heard between the start and the first piece's end: a piece's own frames as they're made.
    expect(told.some((share) => share > 0 && share < 0.95 / 2)).toBe(true);
    for (let at = 1; at < told.length; at++) expect(told[at]!).toBeGreaterThanOrEqual(told[at - 1]! - 1e-9);
    expect(told.at(-1)).toBeCloseTo(0.95);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
