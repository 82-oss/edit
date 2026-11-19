// The script import as a job in the job table (Nov 8 audit, item F): its
// files' states survive a restart, what was fetched isn't fetched again,
// every step is bounded, the plan's credit and the shared encoder are waits
// rather than errors, and what follows the layout never fails the import.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { createApp } from "../src/app.ts";
import * as encoder from "../src/encoder.ts";
import * as failure from "../src/failure.ts";
import * as steps from "../src/import_steps.ts";
import * as jobs from "../src/jobs.ts";
import * as missingMedia from "../src/missing_media.ts";
import { Processor } from "../src/media.ts";
import type { MediaStatus, Probe, ScriptJob } from "../src/model.ts";
import * as relay from "../src/relay.ts";
import { waitingByItself } from "../src/remote_actions.ts";
import { carryOn, Jobs, skipFootage, start, timing, wakeWhatPasses } from "../src/script.ts";
import * as seams from "../src/seams.ts";
import type { Excerpt } from "../src/seams.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";

const SOUNDLESS: Probe = { kind: "video", duration: 60, width: 640, height: 360, fps: 30, has_audio: false };
const HEARD: Probe = { ...SOUNDLESS, has_audio: true };

let restores: (() => void)[] = [];
const waits = timing.retryWaits;
const sleep = timing.sleep;

beforeEach(() => {
  timing.retryWaits = [0];
  timing.sleep = async () => {};
  const cloud = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const articles = spyOn(seams.research, "articles").mockReturnValue([{ id: "a", title: "A", url: "https://example.test", outlet: "A", text: "", summary: "" }]);
  const names = spyOn(seams.research, "caseNames").mockResolvedValue([]);
  // These are the job table's tests, not media's: no thumbnails or waveforms
  // made for the footage. Its addresses are a server that isn't there, and
  // each of them held media's one background slot for 11 s after these tests
  // had ended, so the next file's media test (CI's order, Nov 8) timed out.
  const analysis = spyOn(Processor.prototype, "ensure").mockImplementation(() => {});
  restores = [() => cloud.mockRestore(), () => articles.mockRestore(), () => names.mockRestore(), () => analysis.mockRestore()];
});

afterEach(() => {
  for (const undo of restores) undo();
  timing.retryWaits = waits;
  timing.sleep = sleep;
});

function mocked<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

/** A project with a script of two footage files (two Drive ids). */
async function twoFiles(fixture: Fixture): Promise<string> {
  const id = fixture.store.create("import", { width: 640, height: 360, fps: 30 }).project.id;
  await fixture.store.update(id, "test", (p) => {
    p.style = "courtroom";
    p.script = {
      blocks: [
        { kind: "footage", file: "FILEcase0001", url: "https://drive.google.com/file/d/FILEcase0001/view", start: 0, end: 4, label: "00:00–00:04", words: ["where", "you"], notes: ["Case 1: link"] },
        { kind: "narration", text: "Then it happened." },
        { kind: "footage", file: "FILEcase0002", url: "https://drive.google.com/file/d/FILEcase0002/view", start: 0, end: 4, label: "00:00–00:04", words: ["where", "you"], notes: ["Case 2: link"] },
      ],
    };
  });
  return id;
}

/** Drive files on R2 as the registry would have them, each a whole-file excerpt. */
function cloudFootage(probe: Probe, fail: (file: string) => Error | null = () => null): { fetched: string[] } {
  const fetched: string[] = [];
  mocked(
    spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async (file: string) => {
      fetched.push(file);
      const why = fail(file);
      if (why !== null) throw why;
      return { file, source: `drive:${file}`, key: `edit/originals/drive/${file}/a.mp4`, name: `${file}.mp4`, size: 100 };
    }),
  );
  mocked(
    spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache: string, original) => {
      const proxy = `edit/proxies/drive/${original.file}.mp4`;
      const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
      const excerpt: Excerpt = { path, from: 0, to: probe.duration, cloud: { path, name: original.name, probe, cloud: { source: original.source, original: original.key, proxy, size: 100 } } };
      return [excerpt];
    }),
  );
  return { fetched };
}

/** Waits until the import isn't working any more. */
async function settled(scripts: Jobs, id: string): Promise<ScriptJob> {
  for (let i = 0; i < 1000 && scripts.working(id); i++) await Bun.sleep(2);
  return scripts.get(id)!;
}

function caseJob(home: string, id: string): jobs.Job | undefined {
  return jobs.get(home, jobs.keyOf("case", id));
}

test("an import waiting on the person survives a restart with its files' states, and carries on without fetching what it had", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-waits", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new steps.NeedsPerson("This Drive file isn't shared. Set it so anyone with the link can view.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const before = await settled(scripts, id);
    expect(before.state).toBe("waiting");
    expect(before.files.map((file) => [file.state, file.why ?? null])).toEqual([["done", null], ["failed", "person"]]);
    // Not tried again by itself: only the person can answer that one.
    expect(fetched).toEqual(["FILEcase0001", "FILEcase0002"]);
    // In the job table, waiting on the person: never cut short by a restart, never given up.
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", until: "person" });
    expect(jobs.takeOver(fixture.home, ["case"])).toEqual([]);

    // A restart: a new process reads the same Downloads panel back.
    const after = new Jobs(fixture.home);
    expect(after.get(id)).toEqual(before);
    expect(after.working(id)).toBe(false);
    const restarted = createApp({ store: fixture.store, services: { scripts: after } });
    // Going on without the file nobody shared: the one fetched before is laid out from what the job kept.
    await skipFootage(restarted, id, "FILEcase0002");
    const done = await settled(after, id);
    expect(done.state).toBe("done");
    expect(fetched).toEqual(["FILEcase0001", "FILEcase0002"]);
    expect(fixture.store.get(id)!.project.clips.length).toBeGreaterThan(0);
    // Done: kept to show, its excerpts let go.
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "done" });
    expect(caseJob(fixture.home, id)!.args.made).toEqual({});
  } finally {
    fixture.cleanup();
  }
});

test("a step past its time lands its file with a passing reason and the import waits in the table at once, its next try a minute on: never the person's, never asleep inside the import", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-timeout", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new steps.StepTimedOut("Cutting an excerpt", 600_000, false) : null));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    // Not tried again inside the import (it slept there, counted as working, every answer refused): waiting in the table.
    expect(fetched.filter((file) => file === "FILEcase0002").length).toBe(1);
    expect(job.state).toBe("waiting");
    expect(job.files[1]).toMatchObject({ state: "waiting", why: "passing", tries: 1 });
    expect(job.files[1]!.retry_at! - Date.now()).toBeGreaterThan(55_000);
    expect(job.files[1]!.error).toContain("took more than 10 min");
    expect(job.retry_at).toBeGreaterThan(Date.now());
    expect(scripts.working(id)).toBe(false);
    expect(steps.passing(job.files[1]!.error!)).toBe(true);
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", args: { waiting_on: "passing" } });
    expect(caseJob(fixture.home, id)!.until).toBeUndefined();
  } finally {
    fixture.cleanup();
  }
});

// Nov 18, JJ's School Bookkeeper on nightly-87: the interview's file failed on "could not reach Edit's relay: The socket
// connection was closed unexpectedly" (his Wi-Fi dropped), was tried after 1 and 5 minutes, then handed to him as
// "Waiting for you: one file couldn't be downloaded" with "Edit couldn't reach the internet". His Wi-Fi was back.
test("JJ's dropped connection: the file waits and is tried again by itself until it comes in, never asking the person", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-dropped", { services: { scripts } });
  const passingWaits = failure.PASSING_WAITS.value;
  try {
    const id = await twoFiles(fixture);
    let down = true;
    const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" && down ? new Error(dropped) : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    failure.PASSING_WAITS.value = [0, 0, 0, 0, 0, 0, 0, 0];
    await start(fixture.app, id, false);
    const waiting = await settled(scripts, id);
    expect(steps.whyOf(dropped)).toBe("passing");
    expect(waiting.state).toBe("waiting");
    // Nothing for the person: no file failed (what the page asks about), one waiting with its next try.
    expect(waiting.files.map((file) => [file.state, file.why ?? null])).toEqual([["done", null], ["waiting", "passing"]]);
    expect(waiting.files.filter((file) => file.state === "failed")).toEqual([]);
    expect(waiting.error).toStartWith("Trying a file again at ");
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", step: "trying again by itself", args: { waiting_on: "passing" } });
    // Going on without it isn't offered for a file still being tried, all at once or by name (the agent's tool).
    const before = JSON.stringify(fixture.store.get(id)!.project.script!.blocks);
    await expect(skipFootage(fixture.app, id, "*")).rejects.toThrow("Nothing is waiting to be skipped.");
    await expect(skipFootage(fixture.app, id, "FILEcase0002")).rejects.toThrow("Edit is still bringing this in by itself");
    expect(JSON.stringify(fixture.store.get(id)!.project.script!.blocks)).toBe(before);
    // The job table wakes it; still down, it waits again by itself.
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    await Bun.sleep(5);
    await jobs.wake(fixture.home, ["case"]);
    expect((await settled(scripts, id)).files[1]).toMatchObject({ state: "waiting", why: "passing" });
    // The connection back: the next wake brings the file in and the edit is laid out whole.
    down = false;
    await Bun.sleep(5);
    await jobs.wake(fixture.home, ["case"]);
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(done.files.every((file) => file.state === "done")).toBe(true);
    // Once at the start, once woken still down, once woken with the line back: no tries slept through inside the import.
    expect(fetched.filter((file) => file === "FILEcase0002").length).toBe(3);
    const project = fixture.store.get(id)!.project;
    expect(project.script!.blocks.filter((block) => block.kind === "footage").every((block) => typeof block.clip === "string" && typeof block.media === "string")).toBe(true);
  } finally {
    failure.PASSING_WAITS.value = passingWaits;
    fixture.cleanup();
  }
});

// The rest of JJ's path: "Go on without it" on a file that's really gone took its 19 ranges out of the script and left a
// 2:44 edit of a 25-minute one. Now its ranges hold their place as black cards and the rest is laid out as written.
test("going on without a file that's really gone keeps its ranges in place as black cards: the edit is whole, and the agent is told", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-gone-without", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new steps.NeedsPerson("Google Drive can't find this file: it was deleted, or in the trash.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const asked = await settled(scripts, id);
    expect(asked.files[1]).toMatchObject({ state: "failed", why: "person" });
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", until: "person" });

    await skipFootage(fixture.app, id, "FILEcase0002");
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    // Not fetched again: it's gone without.
    expect(fetched.filter((file) => file === "FILEcase0002").length).toBe(1);
    const project = fixture.store.get(id)!.project;
    const blocks = project.script!.blocks;
    // Every block still in the script, in order, each placed.
    expect(blocks.map((block) => block.kind)).toEqual(["footage", "narration", "footage"]);
    expect(blocks.every((block) => typeof block.clip === "string")).toBe(true);
    const gone = blocks[2]!;
    expect(gone.kind === "footage" && gone.media).toBeFalsy();
    // Named as the person knows it (its case; a file that started downloading, by its file name).
    expect(gone.notes).toContain("Gone without (it couldn't be downloaded): Case 2");
    const card = project.clips.find((clip) => clip.id === gone.clip)!;
    // Its range's length (4 s at 30 fps), black, after the cut-in, with no media to read.
    expect(card).toMatchObject({ type: "solid", fill: [0, 0, 0, 1], opacity: 1, duration: 120, name: "Case 2 · didn't come in" });
    const first = project.clips.find((clip) => clip.id === blocks[0]!.clip)!;
    const cutIn = project.clips.find((clip) => clip.id === blocks[1]!.clip)!;
    expect(cutIn.start).toBe(first.start + first.duration);
    expect(card.start).toBe(cutIn.start + cutIn.duration);
    // A file nothing in the edit lacks: nothing for the editor's cloud to ask, nothing for the export to wait on.
    expect(await missingMedia.held(fixture.home, project)).toBeNull();
    expect(await missingMedia.forAgent(fixture.home, project)).toContain("went on without Case 2, which couldn't be downloaded: its range holds its place as black cards");
    // A Re-cut lays it out again the same way.
    await start(fixture.app, id, true);
    const recut = fixture.store.get(id)!.project;
    expect(recut.clips.filter((clip) => clip.type === "solid" && clip.name === "Case 2 · didn't come in")).toHaveLength(1);
  } finally {
    fixture.cleanup();
  }
});

test("steps are bounded: past its time a step fails as passing, or as the encoder's when an export holds it", async () => {
  await expect(steps.bounded("Reading the footage's length", 20, () => new Promise(() => {}))).rejects.toBeInstanceOf(steps.StepTimedOut);
  const passing = await steps.bounded("a probe", 20, () => new Promise(() => {})).catch((error: unknown) => error);
  expect(steps.whyOf(passing)).toBe("passing");
  const export_ = encoder.register(() => "an export");
  try {
    const shared = await steps.encoding("a proxy", 20, () => new Promise(() => {})).catch((error: unknown) => error);
    expect(steps.whyOf(shared)).toBe("encoder");
    expect((shared as Error).message).toContain("the hardware encoder was busy");
  } finally {
    export_();
  }
  expect(encoder.busy()).toBe(false);
});

test("an encode that ran out of time beside an export waits for the encoder, and carries on when the export ends", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-encoder", { services: { scripts } });
  let exporting = true;
  const export_ = encoder.register(() => (exporting ? "an export" : null));
  try {
    const id = await twoFiles(fixture);
    // Past its time while the export held the encoder; the try after the export gets it.
    let shared = true;
    cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" && shared ? new steps.StepTimedOut("Making the footage's proxy", 900_000, true) : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("waiting");
    expect(job.files[1]).toMatchObject({ state: "waiting", why: "encoder" });
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", until: "encoder", args: { waiting_on: "encoder" } });
    expect(waitingByItself(fixture.home)).toEqual(["1 import waiting for the hardware encoder (an export holds it): they carry on when it's free."]);
    // The job table's one resumer wakes it, but not while the export runs.
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    await jobs.wake(fixture.home, ["case"]);
    expect(scripts.working(id)).toBe(false);
    exporting = false;
    shared = false;
    await jobs.wake(fixture.home, ["case"]);
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(done.files.every((file) => file.state === "done")).toBe(true);
  } finally {
    export_();
    fixture.cleanup();
  }
});

test("the transcription plan out of credit: the import waits, said once in Needs attention, and is tried again later", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-credit", { services: { scripts } });
  const every = steps.QUOTA_RETRY_MS.value;
  try {
    const id = await twoFiles(fixture);
    cloudFootage(HEARD);
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    let refusal: MediaStatus["transcript_error"] = "transcription failed (401): This request exceeds your quota of 10000. You have 15 credits remaining.";
    mocked(spyOn(fixture.app.media, "transcribe").mockImplementation(() => fixture.app.media.status("x")));
    mocked(
      spyOn(fixture.app.media, "status").mockImplementation(() => ({ proxy: "ready", proxy_progress: 1, light: "skipped", thumbs: "ready", thumb_count: 1, peaks: "ready", transcript: "failed", ...(refusal === undefined ? {} : { transcript_error: refusal }) })),
    );
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("waiting");
    expect(job.error).toContain("The transcription plan is out of credit");
    expect(job.retry_at).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect(fixture.store.get(id)!.project.clips).toEqual([]);
    const durable = caseJob(fixture.home, id)!;
    expect(durable).toMatchObject({ state: "waiting", args: { waiting_on: "quota" } });
    expect(waitingByItself(fixture.home)[0]).toStartWith("The transcription plan is out of credit: 1 import waiting");
    // Not yet due: the wake leaves it.
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    await jobs.wake(fixture.home, ["case"]);
    expect(scripts.working(id)).toBe(false);
    // Due, and the credit's back (a refusal of another kind lays it out without those words).
    const listed = JSON.parse(fs.readFileSync(`${fixture.home}/jobs.json`, "utf8")) as jobs.Job[];
    for (const one of listed) if (one.key === durable.key) one.retry_at = Date.now() - 1;
    fs.writeFileSync(`${fixture.home}/jobs.json`, JSON.stringify(listed));
    refusal = undefined;
    await jobs.wake(fixture.home, ["case"]);
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(fixture.store.get(id)!.project.clips.length).toBeGreaterThan(0);
    expect(waitingByItself(fixture.home)).toEqual([]);
  } finally {
    steps.QUOTA_RETRY_MS.value = every;
    fixture.cleanup();
  }
});

test("a voice-over that fails leaves the import done, laid out, with the voice-over's own line failed", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-voice", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    cloudFootage(SOUNDLESS);
    timing.retryWaits = [];
    mocked(spyOn(seams.voiceover, "generate").mockRejectedValue(new Error("the voice service didn't answer")));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("done");
    expect(job.error).toBeUndefined();
    expect(job.after).toEqual([{ step: "voiceover", state: "failed", note: "The voice-over couldn't be made: the voice service didn't answer" }]);
    expect(fixture.store.get(id)!.project.clips.length).toBeGreaterThan(0);
  } finally {
    fixture.cleanup();
  }
});

test("a transcription still running when its wait runs out is said: laid out without those words", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-late-words", { services: { scripts } });
  const wait = steps.LIMITS.transcript;
  try {
    const id = await twoFiles(fixture);
    cloudFootage(HEARD);
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    mocked(spyOn(fixture.app.media, "transcribe").mockImplementation(() => fixture.app.media.status("x")));
    mocked(spyOn(fixture.app.media, "status").mockImplementation(() => ({ proxy: "ready", proxy_progress: 1, light: "skipped", thumbs: "ready", thumb_count: 1, peaks: "ready", transcript: "working" })));
    steps.LIMITS.transcript = -1;
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("done");
    const words = job.after?.find((one) => one.step === "words");
    expect(words?.state).toBe("waiting");
    expect(words?.note).toContain("Laid out without words for 2 files");
    expect(words?.note).toContain("Transcription is still running");
  } finally {
    steps.LIMITS.transcript = wait;
    fixture.cleanup();
  }
});

test("failures read as one vocabulary: the person's, passing, the plan's credit, the encoder's", () => {
  expect(steps.whyOf(new steps.NeedsPerson("This Drive file isn't shared."))).toBe("person");
  expect(steps.whyOf(new Error("Download stopped ((28) Google Drive sent nothing for 60 s)."))).toBe("passing");
  expect(steps.whyOf("transcription failed (401): exceeds your quota … 15 credits remaining")).toBe("quota");
  expect(steps.whyOf({ _tag: "AllowanceUsedUp", message: "transcription failed (429): allowance" })).toBe("quota");
  expect(steps.whyOf({ _tag: "DownloadFailed", reason: "VideoGone", message: "gone" })).toBe("person");
  expect(steps.whyOf(new steps.StepTimedOut("a proxy", 1000, true))).toBe("encoder");
  // Words kept from an older build still read the same way.
  expect(steps.whyOf("YouTube video abcdefghijk couldn't be downloaded: Private video")).toBe("person");
  // Drive's download limit waits by itself (it said "try later" and Edit never did).
  expect(steps.whyOf("Google Drive's download limit for this file is used up for today. Try later, or upload a copy.")).toBe("limit");
  expect(steps.whyOf(new steps.DriveLimit("Google Drive's download limit for this file is used up for today."))).toBe("limit");
  // The relay's daily refusals are the plan's kind, never the person's.
  expect(steps.whyOf("transcription failed (429): Edit's shared transcription budget for today is used up; it resets at midnight UTC.")).toBe("quota");
  // A used-up Claude plan isn't the transcription plan.
  expect(steps.whyOf("Your Claude plan is used up until 11:51 PM.")).toBe("passing");
});

test("each wait has its own time: credit every half hour, a daily allowance at its reset, Drive's limit a day on or at Google's word", () => {
  const now = Date.UTC(2026, 10, 16, 21, 30);
  expect(steps.retryAt("quota", now, "This request exceeds your quota of 0. You have 0 credits remaining.")).toBe(now + steps.QUOTA_RETRY_MS.value);
  expect(steps.retryAt("quota", now, "transcription failed (429): Edit's shared transcription budget for today is used up; it resets at midnight UTC.")).toBe(Date.UTC(2026, 10, 17) + 60_000);
  expect(steps.retryAt("limit", now, new steps.DriveLimit("limit"))).toBe(now + steps.LIMIT_RETRY_MS.value);
  expect(steps.retryAt("limit", now, new Error("wrapped", { cause: new steps.DriveLimit("limit", 3_600_000) }))).toBe(now + 3_600_000);
  // The person's is looked at again in half an hour, in case it was put right (failure.ts).
  expect(steps.retryAt("person", now)).toBe(now + 30 * 60_000);
  expect(steps.retryAt("broken", now)).toBeNull();
  expect(steps.hearingWaits("transcription failed (429): Edit's shared transcription budget for today is used up", now)).toStartWith("Today's transcription allowance is used up; Edit tries again by itself at");
});

test("Google Drive's download limit: the import waits by itself for a day, says a copy's link goes sooner, and carries on when woken", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-drive-limit", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    let limited = true;
    cloudFootage(SOUNDLESS, (file) => (limited && file === "FILEcase0002" ? new steps.DriveLimit("Google Drive's download limit for this file is used up for today.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("waiting");
    expect(job.files.map((file) => [file.state, file.why ?? null])).toEqual([["done", null], ["waiting", "limit"]]);
    expect(job.error).toContain("Google Drive's download limit is used up for today");
    expect(job.error).toContain("copy's link");
    expect(job.retry_at).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // Waiting on a time, not on the person: the job table wakes it.
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", step: "waiting for Google Drive", args: { waiting_on: "drive" } });
    expect(caseJob(fixture.home, id)?.until).toBeUndefined();
    // Due, and Google shares it again: woken, it carries on to the layout.
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    const listed = JSON.parse(fs.readFileSync(`${fixture.home}/jobs.json`, "utf8")) as jobs.Job[];
    for (const one of listed) if (one.key === jobs.keyOf("case", id)) one.retry_at = Date.now() - 1;
    fs.writeFileSync(`${fixture.home}/jobs.json`, JSON.stringify(listed));
    limited = false;
    await jobs.wake(fixture.home, ["case"]);
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(fixture.store.get(id)!.project.clips.length).toBeGreaterThan(0);
  } finally {
    fixture.cleanup();
  }
});

test("ElevenLabs out of credit: the voice-over waits for it, the import kept waiting in the table, and it's voiced when woken", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-voice-credit", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    cloudFootage(SOUNDLESS);
    const voice = mocked(
      spyOn(seams.voiceover, "generate")
        .mockRejectedValueOnce(new Error("ElevenLabs: This request exceeds your quota of 1334160. You have 15 credits remaining, while 1048 credits are required for this request. (quota_exceeded) (401)"))
        .mockResolvedValue({}),
    );
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("waiting");
    expect(job.error).toStartWith("ElevenLabs is out of credit: an admin adds credit");
    expect(job.retry_at).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect(job.after?.find((line) => line.step === "voiceover")?.state).toBe("waiting");
    // Asked once, not again minutes later; the layout stands.
    expect(voice).toHaveBeenCalledTimes(1);
    expect(fixture.store.get(id)!.project.clips.length).toBeGreaterThan(0);
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", step: "waiting for voice credit", args: { waiting_on: "voice" } });
    // The cut-in still unvoiced, the wait due: woken, only the voice-over is made (missing lines only), and the import ends done.
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    const listed = JSON.parse(fs.readFileSync(`${fixture.home}/jobs.json`, "utf8")) as jobs.Job[];
    for (const one of listed) if (one.key === jobs.keyOf("case", id)) one.retry_at = Date.now() - 1;
    fs.writeFileSync(`${fixture.home}/jobs.json`, JSON.stringify(listed));
    await jobs.wake(fixture.home, ["case"]);
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(voice).toHaveBeenCalledTimes(2);
    expect(voice.mock.calls[1]).toEqual([fixture.app, id, true]);
  } finally {
    fixture.cleanup();
  }
});

// Nov 19: nightly-89 handed JJ's Scissors Attack import to him ("Waiting for you: one file couldn't be downloaded",
// "Finding the excerpt's keyframe took more than 2 min and was stopped"). The build after it wakes such an import as it
// starts, to carry on by itself; one over a file that's really gone still waits for the person.
test("an import an older build left waiting for the person over a file that passes is woken at start; a file really gone still waits", () => {
  const fixture = fixtureHome("import-wake-what-passes");
  try {
    const asked = (project: string, error: string) => {
      const job: ScriptJob = {
        state: "waiting",
        error: "1 of 2 footage files couldn't be downloaded",
        files: [
          { file: "FILEcase0001", bytes: 10, state: "done" },
          { file: "FILEcase0002", name: "MartyBlank_202604201718_BWL7148938-1.mp4", bytes: 0, state: "failed", error, why: "person" },
        ],
      };
      const key = jobs.begin(fixture.home, "case", project, { import: job, made: {} });
      jobs.settle(fixture.home, key, "waiting", { step: "waiting for the person", until: "person" });
      return key;
    };
    const stuck = asked("p-scissors", "Finding the excerpt's keyframe took more than 2 min and was stopped");
    const wrong = asked("p-wrong", "The excerpt cut from the footage came out wrong (it runs 29.8 s, not 29.2 s).");
    const gone = asked("p-gone", "This file isn't shared with Edit's Google account, or was deleted, or in the trash.");
    expect(wakeWhatPasses(fixture.home).sort()).toEqual(["p-scissors", "p-wrong"]);
    for (const key of [stuck, wrong]) {
      const job = jobs.get(fixture.home, key)!;
      expect(job.state).toBe("waiting");
      expect(job.until).toBeUndefined();
      expect(job.retry_at).toBeLessThanOrEqual(Date.now());
      const shown = (job.args as { import: ScriptJob }).import;
      expect(shown.files[1]).toMatchObject({ state: "waiting", why: "passing" });
      expect(shown.error).toBeUndefined();
    }
    // Due now: the job table starts it at its next look.
    expect(jobs.dueNow(fixture.home, ["case"]).map((job) => job.project).sort()).toEqual(["p-scissors", "p-wrong"]);
    expect(jobs.get(fixture.home, gone)).toMatchObject({ state: "waiting", until: "person" });
    // Started again, nothing more to wake.
    expect(wakeWhatPasses(fixture.home)).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

// Honest council change 8a, Nov 19: a file this Mac already has (Script mode brought it down, an earlier import here)
// is cut from here, in seconds; reading it back over the network is where JJ's three time limits tripped.
test("a footage file whose original is on this Mac is cut from that copy, never read back from the cloud's address", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-local-original", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    cloudFootage(SOUNDLESS);
    const inputs: (string | null | undefined)[] = [];
    mocked(
      spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache: string, original, _ranges, input) => {
        inputs.push(input);
        const proxy = `edit/proxies/drive/${original.file}.mp4`;
        const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
        return [{ path, from: 0, to: SOUNDLESS.duration, cloud: { path, name: original.name, probe: SOUNDLESS, cloud: { source: original.source, original: original.key, proxy, size: 100 } } }];
      }),
    );
    mocked(spyOn(seams.cloudMedia, "localOriginal").mockImplementation((_cache: string, key: string) => (key.includes("FILEcase0002") ? "/here/FILEcase0002.mp4" : null)));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    await settled(scripts, id);
    expect(inputs.sort()).toEqual(["/here/FILEcase0002.mp4", null]);
  } finally {
    fixture.cleanup();
  }
});
