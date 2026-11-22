// The script import as a job in the job table (Nov 8 audit, item F): its
// files' states survive a restart, what was fetched isn't fetched again,
// every step is bounded, the plan's credit and the shared encoder are waits
// rather than errors, and what follows the layout never fails the import.

import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { createApp } from "../src/app.ts";
import * as encoder from "../src/encoder.ts";
import * as failure from "../src/failure.ts";
import * as steps from "../src/import_steps.ts";
import * as jobs from "../src/jobs.ts";
import * as missingMedia from "../src/missing_media.ts";
import * as notices from "../src/notices.ts";
import { Processor } from "../src/media.ts";
import type { MediaStatus, Probe, ScriptJob } from "../src/model.ts";
import * as relay from "../src/relay.ts";
import { waitingByItself } from "../src/remote_actions.ts";
import { carryOn, copiesHere, Jobs, keyframeBefore, replaceFootage, skipFootage, start, timing, wakeWhatPasses } from "../src/script.ts";
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

// Only when no footage at all came is there nothing to lay out: the import waits on the person.
test("an import waiting on the person survives a restart with its files' states, and carries on when one comes", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-waits", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    let shared = false;
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" || !shared ? new steps.NeedsPerson("This Drive file isn't shared. Set it so anyone with the link can view.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const before = await settled(scripts, id);
    expect(before.state).toBe("waiting");
    expect(before.files.map((file) => [file.state, file.why ?? null])).toEqual([["failed", "person"], ["failed", "person"]]);
    // Not tried again at once: only the person can answer these (they're looked at again in half an hour, Nov 21).
    expect(fetched).toEqual(["FILEcase0001", "FILEcase0002"]);
    // In the job table, waiting on the person and its next look: never cut short by a restart, never given up.
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", step: "waiting for the person", retry_at: before.files[1]!.retry_at });
    expect(jobs.takeOver(fixture.home, ["case"])).toEqual([]);

    // A restart: a new process reads the same Downloads panel back.
    const after = new Jobs(fixture.home);
    expect(after.get(id)).toEqual(before);
    expect(after.working(id)).toBe(false);
    const restarted = createApp({ store: fixture.store, services: { scripts: after } });
    // The first file shared since: tried again, it comes, and the edit is laid out without the one still not shared.
    shared = true;
    expect(carryOn(restarted, id)).toBe("started");
    const done = await settled(after, id);
    expect(done.state).toBe("done");
    expect(fetched).toEqual(["FILEcase0001", "FILEcase0002", "FILEcase0001", "FILEcase0002"]);
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
    expect(failure.waitsByItself(failure.kindOf(job.files[1]!.error!))).toBe(true);
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
    expect(failure.kindOf(dropped)).toBe("passing");
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
// 2:44 edit of a 25-minute one. Now its ranges hold their place as black cards and the rest is laid out as written; and
// (Nov 22) the import does it by itself, never stopped on the file with the rest of the footage unused.
test("a file that's really gone never stops the import: the rest is laid out, its ranges black cards in place, said once at the cloud, and the agent is told", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-gone-without", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new steps.NeedsPerson("Google Drive can't find this file: it was deleted, or in the trash.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
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
    // Nothing for the export to wait on; the editor's cloud says it, with why, for another link or Retry now.
    expect(await missingMedia.held(fixture.home, project)).toBeNull();
    expect((await missingMedia.state(fixture.app, id, false)).missing).toEqual([{ id: "file:FILEcase0002", name: "Case 2", path: "FILEcase0002", asked: true, link: true, why: "Google Drive can't find this file: it was deleted, or in the trash." }]);
    expect(await missingMedia.forAgent(fixture.home, project)).toContain("Case 2 couldn't be downloaded, so the import went on without it: its range holds its place as black cards");
    // Kept trying by itself from the job table, page open or not.
    expect(jobs.get(fixture.home, jobs.keyOf("media", id))).toMatchObject({ state: "waiting" });
    // "Keep its parts black": the question goes, the cards stay.
    await missingMedia.goWithout(fixture.app, id, "file:FILEcase0002");
    expect((await missingMedia.state(fixture.app, id, false)).missing).toEqual([]);
    expect(fixture.store.get(id)!.project.clips.find((clip) => clip.id === gone.clip)).toMatchObject({ type: "solid" });
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
  expect(failure.kindOf(passing)).toBe("passing");
  // Another background encode beside it (an export it would wait for first: encoder.ts's turn).
  const other = encoder.hold("another proxy");
  try {
    const shared = await steps.encoding("a proxy", 20, () => new Promise(() => {})).catch((error: unknown) => error);
    expect(failure.kindOf(shared)).toBe("encoder");
    expect((shared as Error).message).toContain("the hardware encoder was busy");
  } finally {
    other.release();
  }
  expect(encoder.busy()).toBe(false);
});

test("a proxy's encode takes its turn after an export: it starts once the export ends, never beside it (Nov 22)", async () => {
  let exporting = true;
  const export_ = encoder.register(() => (exporting ? "an export" : null));
  const was = encoder.hooks.pollMs;
  encoder.hooks.pollMs = 20;
  let began = false;
  try {
    const made = steps.encoding("a proxy", 10_000, async () => {
      began = true;
      return "made";
    });
    await Bun.sleep(100);
    expect(began).toBe(false);
    exporting = false;
    expect(await made).toBe("made");
  } finally {
    encoder.hooks.pollMs = was;
    export_();
  }
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
  const every = failure.QUOTA_EVERY_MS.value;
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
    failure.QUOTA_EVERY_MS.value = every;
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
  expect(failure.kindOf(new steps.NeedsPerson("This Drive file isn't shared."))).toBe("person");
  expect(failure.kindOf(new Error("Download stopped ((28) Google Drive sent nothing for 60 s)."))).toBe("passing");
  expect(failure.kindOf("transcription failed (401): exceeds your quota … 15 credits remaining")).toBe("quota");
  expect(failure.kindOf({ _tag: "AllowanceUsedUp", message: "transcription failed (429): allowance" })).toBe("quota");
  expect(failure.kindOf({ _tag: "DownloadFailed", reason: "VideoGone", message: "gone" })).toBe("person");
  expect(failure.kindOf(new steps.StepTimedOut("a proxy", 1000, true))).toBe("encoder");
  // Words kept from an older build still read the same way.
  expect(failure.kindOf("YouTube video abcdefghijk couldn't be downloaded: Private video")).toBe("person");
  // Drive's download limit waits by itself (it said "try later" and Edit never did).
  expect(failure.kindOf("Google Drive's download limit for this file is used up for today. Try later, or upload a copy.")).toBe("limit");
  expect(failure.kindOf(new steps.DriveLimit("Google Drive's download limit for this file is used up for today."))).toBe("limit");
  // The relay's daily refusals are the plan's kind, never the person's.
  expect(failure.kindOf("transcription failed (429): Edit's shared transcription budget for today is used up; it resets at midnight UTC.")).toBe("quota");
  // A used-up Claude plan isn't the transcription plan.
  expect(failure.kindOf("Your Claude plan is used up until 11:51 PM.")).toBe("passing");
});

test("each wait has its own time: credit every half hour, a daily allowance at its reset, Drive's limit a day on or at Google's word", () => {
  const now = Date.UTC(2026, 10, 16, 21, 30);
  expect(steps.retryAt("quota", now, "This request exceeds your quota of 0. You have 0 credits remaining.")).toBe(now + failure.QUOTA_EVERY_MS.value);
  expect(steps.retryAt("quota", now, "transcription failed (429): Edit's shared transcription budget for today is used up; it resets at midnight UTC.")).toBe(Date.UTC(2026, 10, 17) + 60_000);
  expect(steps.retryAt("limit", now, new steps.DriveLimit("limit"))).toBe(now + failure.LIMIT_WAIT_MS.value);
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

// Fable's check of the work (verify.md finding 2): each wake started the job afresh and the file's tries went with it.
test("a file on a dropped line is tried again after 1 minute, then 5; failing a third time, the rest is laid out without it and it's tried on from there", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-tries", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly";
    let down = true;
    cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" && down ? new Error(dropped) : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    const seen: [number, number][] = [];
    const note = (job: ScriptJob) => seen.push([job.files[1]!.tries ?? 0, Math.round((job.files[1]!.retry_at! - Date.now()) / 60_000)]);
    await start(fixture.app, id, false);
    note(await settled(scripts, id));
    // What serve.ts' case resumer does when the table wakes it.
    expect(carryOn(fixture.app, id)).toBe("started");
    note(await settled(scripts, id));
    expect(seen).toEqual([[1, 1], [2, 5]]);
    // The third failure in a row: it no longer holds the edit.
    expect(carryOn(fixture.app, id)).toBe("started");
    expect((await settled(scripts, id)).state).toBe("done");
    const project = fixture.store.get(id)!.project;
    const blocks = project.script!.blocks.filter((block) => block.kind === "footage");
    expect(blocks.map((block) => typeof block.media === "string")).toEqual([true, false]);
    expect(project.clips.find((clip) => clip.id === blocks[1]!.clip)).toMatchObject({ type: "solid", name: "Case 2 · didn't come in" });
    expect((await missingMedia.state(fixture.app, id, false)).missing).toMatchObject([{ id: "file:FILEcase0002", link: true, why: dropped }]);
    // Tried on by itself from the editor's row: the line back, its cards fill where they are.
    expect(jobs.get(fixture.home, jobs.keyOf("media", id))).toMatchObject({ state: "waiting" });
    down = false;
    const card = project.clips.find((clip) => clip.id === blocks[1]!.clip)!;
    await missingMedia.tryAgain(fixture.app, id);
    const filled = fixture.store.get(id)!.project;
    expect(filled.clips.find((clip) => clip.id === card.id)).toMatchObject({ type: "video", start: card.start, duration: card.duration });
    expect((await missingMedia.state(fixture.app, id, false)).missing).toEqual([]);
    expect(jobs.get(fixture.home, jobs.keyOf("media", id))).toBeUndefined();
  } finally {
    fixture.cleanup();
  }
});

// Nov 20: nothing told the table an import got further, so each quit or crash added a try, and from the third the
// import was put off as crashy (1, 5, 15, then 30 minutes) while its page still read "Downloading…".
test("an import cut short three times, each after another file came in, is never put off; one put off reads back as waiting with its time", () => {
  const fixture = fixtureHome("import-gets-further");
  try {
    const id = "p-further";
    const key = jobs.keyOf("case", id);
    const files = ["a", "b", "c", "d"].map((file) => ({ file, bytes: 0, state: "queued" as const }));
    for (let run = 0; run < 3; run++) {
      // A new process each time: its import claimed again, one more file in, then Edit quits mid-way.
      const scripts = new Jobs(fixture.home);
      const prior = scripts.get(id);
      expect(scripts.claim(fixture.app, id, prior ?? { state: "downloading", files })).toBe(true);
      scripts.set(fixture.app, id, (job) => {
        job.files[run]!.state = "downloading";
        job.files[run]!.bytes = 10;
      });
      scripts.set(fixture.app, id, (job) => void (job.files[run]!.state = "done"));
      expect(scripts.get(id) as ScriptJob & { moved_ms?: number }).toHaveProperty("moved_ms");
      // The next start takes it over as cut short.
      expect(jobs.takeOver(fixture.home, ["case"]).map((job) => job.key)).toEqual([key]);
    }
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "running" });
    expect(caseJob(fixture.home, id)!.put_off).toBeUndefined();

    // Cut short with nothing further, it's put off: read back, it says it waits and when it goes again.
    jobs.wait(fixture.home, key, "cut short by 3 restarts in a row");
    const at = caseJob(fixture.home, id)!.retry_at!;
    const shown = new Jobs(fixture.home).get(id)!;
    expect(shown.state).toBe("waiting");
    expect(shown.retry_at).toBe(at);
    expect(shown.files.map((file) => [file.state, file.retry_at ?? null])).toEqual([["done", null], ["done", null], ["done", null], ["waiting", at]]);
  } finally {
    fixture.cleanup();
  }
});

// Nov 20: the editor's import waited, unbounded and silent, on Script mode's upload of a recording whose whole copy was
// on this Mac all along (looked at only after the wait): "downloading 0 B" for hours on an 8 Mbit/s line.
test("a recording Script mode keeps on this Mac is cut from that copy at once, its upload still going: never waited on", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-script-mode-copy", { services: { scripts } });
  const find = copiesHere.find;
  try {
    const id = await twoFiles(fixture);
    // The upload behind Script mode's import never finishes: asking the cloud for this original waits for good.
    const asked: string[] = [];
    mocked(
      spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async (file: string) => {
        asked.push(file);
        if (file === "FILEcase0002") return new Promise(() => {});
        return { file, source: `drive:${file}`, key: `edit/originals/drive/${file}/a.mp4`, name: `${file}.mp4`, size: 100 };
      }),
    );
    const inputs: (string | null | undefined)[] = [];
    mocked(
      spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache: string, original, _ranges, input) => {
        inputs.push(input);
        const proxy = `edit/proxies/drive/${original.file}.mp4`;
        const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
        return [{ path, from: 0, to: SOUNDLESS.duration, cloud: { path, name: original.name, probe: SOUNDLESS, cloud: { source: original.source, original: original.key, proxy, size: 100 } } }];
      }),
    );
    let released = 0;
    copiesHere.find = (source) =>
      source === "drive:FILEcase0002" ? { copy: { path: "/scripts/s1/.originals/FILEcase0002/b.mp4", key: "edit/originals/drive/FILEcase0002/b.mp4", name: "b.mp4", size: 5_000_000_000, release: () => void released++ } } : null;
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("done");
    expect(asked).toEqual(["FILEcase0001"]);
    expect(inputs).toContain("/scripts/s1/.originals/FILEcase0002/b.mp4");
    // Held while it was cut from, let go after: Script mode removes it once its upload is done.
    expect(released).toBe(1);
  } finally {
    copiesHere.find = find;
    fixture.cleanup();
  }
});

// Nov 20: one lane for every project's cuts, held through a whole file's cuts and uploads, and the files waiting for it
// kept their download slots: one slow file held every project's import on "cutting" and stopped every download.
test("one project's cut standing still holds no other project's import, and its waiting files let go of their download slots", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-cut-lanes", { services: { scripts } });
  try {
    const a = await twoFiles(fixture);
    await fixture.store.update(a, "test", (p) => {
      // Four files, so a held slot would show: three slots in all.
      p.script!.blocks.push(
        { kind: "footage", file: "FILEcase0003", url: "https://drive.google.com/file/d/FILEcase0003/view", start: 0, end: 4, label: "00:00–00:04", words: ["where", "you"], notes: ["Case 3: link"] },
        { kind: "footage", file: "FILEcase0004", url: "https://drive.google.com/file/d/FILEcase0004/view", start: 0, end: 4, label: "00:00–00:04", words: ["where", "you"], notes: ["Case 4: link"] },
      );
    });
    const b = await twoFiles(fixture);
    await fixture.store.update(b, "test", (p) => {
      for (const block of p.script!.blocks) if (block.kind === "footage") block.file = block.file.replace("FILEcase", "FILEbbbb");
    });
    const { fetched } = cloudFootage(SOUNDLESS);
    mocked(
      spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache: string, original) => {
        // Project A's cuts never end (its line gone mid-upload).
        if (original.file.startsWith("FILEcase")) return new Promise(() => {});
        const proxy = `edit/proxies/drive/${original.file}.mp4`;
        const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
        return [{ path, from: 0, to: SOUNDLESS.duration, cloud: { path, name: original.name, probe: SOUNDLESS, cloud: { source: original.source, original: original.key, proxy, size: 100 } } }];
      }),
    );
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    void start(fixture.app, a, false);
    await Bun.sleep(20);
    await start(fixture.app, b, false);
    expect((await settled(scripts, b)).state).toBe("done");
    // Every one of A's files came down (no slot held by a file waiting for its cut); one is cut, the rest wait their turn.
    expect(fetched.filter((file) => file.startsWith("FILEcase")).sort()).toEqual(["FILEcase0001", "FILEcase0002", "FILEcase0003", "FILEcase0004"]);
    expect(scripts.get(a)!.files.map((file) => file.state).sort()).toEqual(["cutting", "queued", "queued", "queued"]);
  } finally {
    fixture.cleanup();
  }
});

// Nov 20: past its half hour `bounded` gave up on the voice-over but couldn't stop it, and the retry started a second
// paid voice-over beside the first.
test("a voice-over past its time is waited on by the next try, never started a second time beside it", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-one-voiceover", { services: { scripts } });
  const limit = steps.LIMITS.voiceover;
  try {
    const id = await twoFiles(fixture);
    cloudFootage(SOUNDLESS);
    let running = 0;
    let most = 0;
    let calls = 0;
    mocked(
      spyOn(seams.voiceover, "generate").mockImplementation(async () => {
        calls++;
        running++;
        most = Math.max(most, running);
        await Bun.sleep(150);
        running--;
        return {};
      }),
    );
    steps.LIMITS.voiceover = 40;
    timing.retryWaits = [0, 0, 0, 0, 0];
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(most).toBe(1);
    expect(calls).toBe(1);
    expect(job.after?.find((line) => line.step === "voiceover")?.state).toBe("done");
  } finally {
    steps.LIMITS.voiceover = limit;
    fixture.cleanup();
  }
});

// Nov 20: ffprobe failing read as "no keyframe", so the excerpt was cut from the file's start and the long wrong
// excerpt sent up.
test("a keyframe that can't be read is a failure tried again, never the file's start", async () => {
  const fixture = fixtureHome("import-keyframe-unread");
  try {
    const path = `${fixture.home}/noise.mp4`;
    fs.writeFileSync(path, new Uint8Array(200_000).map((_, at) => (at * 31) % 256));
    const failed = await keyframeBefore(path, 30).then(() => null, (error: unknown) => error as Error);
    expect(failed?.message).toStartWith("Finding the excerpt's keyframe: the footage couldn't be read");
    expect(failure.kindOf(failed)).toBe("passing");
  } finally {
    fixture.cleanup();
  }
});

// Nov 21: a file the person was asked about (a Drive link never shared) was never looked at again, though the rule of
// Nov 19 said every 30 minutes: shared in Drive since, the import still waited for Try again. Now it's looked at again
// by itself, quietly: its question stays as it was while it's looked at, and goes only once the file comes in.
test("a file not shared is looked at again by itself in 30 minutes: shared since, the import finishes with nothing pressed", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-person-looks", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    let shared = false;
    // Neither shared: nothing to lay out, so the import waits on the person.
    const { fetched } = cloudFootage(SOUNDLESS, () => (!shared ? new steps.NeedsPerson("This Drive file isn't shared. Set it so anyone with the link can view.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const asked = await settled(scripts, id);
    // Its question as before: the person's file failed, what the page asks about.
    expect(asked.state).toBe("waiting");
    expect(asked.files[1]).toMatchObject({ state: "failed", why: "person", tries: 1 });
    // And its next look, half an hour on, the import's too: the job table wakes it.
    const at = asked.files[1]!.retry_at!;
    expect(at - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(at - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", step: "waiting for the person", retry_at: at });
    expect(caseJob(fixture.home, id)!.until).toBeUndefined();

    // Shared in Drive meanwhile; nobody presses anything. At its time the table wakes it.
    shared = true;
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    setSystemTime(new Date(at + 1_000));
    await jobs.wake(fixture.home, ["case"]);
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(done.files.every((file) => file.state === "done")).toBe(true);
    expect(fetched.filter((file) => file === "FILEcase0002").length).toBe(2);
    expect(fixture.store.get(id)!.project.script!.blocks.filter((block) => block.kind === "footage").every((block) => typeof block.media === "string")).toBe(true);
  } finally {
    setSystemTime();
    fixture.cleanup();
  }
});

test("a file still not shared keeps its question through each quiet look, looked at again every 30 minutes for good: no notice, no tries spent", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-person-still", { services: { scripts } });
  const told = mocked(spyOn(notices, "notify"));
  try {
    const id = await twoFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, () => new steps.NeedsPerson("This Drive file isn't shared. Set it so anyone with the link can view."));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const first = await settled(scripts, id);
    const row = () => caseJob(fixture.home, id)!;
    const counts = () => [row().attempts, row().put_off ?? null, row().args.same_count ?? null];
    const before = counts();
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    // What the page is told while each look runs: the import waiting, the file asked about, never "Downloading".
    const heard: ScriptJob[] = [];
    fixture.store.subscribe((event) => {
      if (event.type === "script" && event.id === id) heard.push(event.job as ScriptJob);
    });
    let at = first.files[1]!.retry_at!;
    for (let look = 1; look <= 3; look++) {
      setSystemTime(new Date(at + 1_000));
      await jobs.wake(fixture.home, ["case"]);
      const after = await settled(scripts, id);
      expect(after.state).toBe("waiting");
      expect(after.files[1]).toMatchObject({ state: "failed", why: "person", tries: 1, error: first.files[1]!.error });
      expect(after.error).toBe(first.error);
      // Its next look half an hour after this one, for good.
      expect(after.files[1]!.retry_at! - (at + 1_000)).toBeGreaterThan(29 * 60_000);
      expect(row()).toMatchObject({ state: "waiting", step: "waiting for the person", retry_at: after.files[1]!.retry_at });
      at = after.files[1]!.retry_at!;
    }
    expect(fetched.filter((file) => file === "FILEcase0002").length).toBe(4);
    expect(heard.length).toBeGreaterThan(0);
    for (const job of heard) {
      expect(job.state).toBe("waiting");
      expect(job.files[1]).toMatchObject({ state: "failed", why: "person" });
    }
    // Nothing counted against it, and nobody told anything.
    expect(counts()).toEqual(before);
    expect(told).not.toHaveBeenCalled();
  } finally {
    setSystemTime();
    fixture.cleanup();
  }
});

test("an answer given while a quiet look is under way waits for it, never refused as still working", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-person-answer", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    let gate: Promise<void> | null = null;
    let open = () => {};
    cloudFootage(SOUNDLESS, () => null);
    mocked(
      spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async (file: string) => {
        if (file === "FILEcase0002") {
          if (gate !== null) await gate;
          throw new steps.NeedsPerson("This Drive file isn't shared. Set it so anyone with the link can view.");
        }
        // Neither shared (nothing to lay out: the import waits on the person, and its looks are quiet).
        throw new steps.NeedsPerson("This Drive file isn't shared. Set it so anyone with the link can view.");
      }),
    );
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const asked = await settled(scripts, id);
    gate = new Promise<void>((resolve) => (open = resolve));
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    setSystemTime(new Date(asked.files[1]!.retry_at! + 1_000));
    await jobs.wake(fixture.home, ["case"]);
    // The look is under way: working, its question still on the page.
    expect(scripts.working(id)).toBe(true);
    expect(scripts.get(id)).toMatchObject({ state: "waiting", files: [{ state: "failed", why: "person" }, { state: "failed", why: "person" }] });
    const answer = skipFootage(fixture.app, id, "FILEcase0002");
    setTimeout(open, 300);
    await answer;
    await settled(scripts, id);
    const notes = fixture.store.get(id)!.project.script!.blocks.flatMap((block) => (block.kind === "footage" && block.file === "FILEcase0002" ? (block.notes ?? []) : []));
    expect(notes.some((note) => note.startsWith("Gone without"))).toBe(true);
  } finally {
    setSystemTime();
    fixture.cleanup();
  }
});

// Nov 21 audit: "Make the edit with their parts black" ("*") blacked a file waiting for room as well as the one that
// was the person's; a file waiting for room, credit or Drive's limit comes in by itself.
test("going on without them all blacks only the person's files, never one waiting for room", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-skip-all-waiting", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new steps.NeedsPerson("Google Drive can't find this file: it was deleted, or in the trash.") : new failure.NoRoom(1e9)));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const asked = await settled(scripts, id);
    expect(asked.files.map((file) => [file.state, file.why ?? null])).toEqual([["waiting", "room"], ["failed", "person"]]);
    await skipFootage(fixture.app, id, "*");
    await settled(scripts, id);
    const notes = (file: string) => fixture.store.get(id)!.project.script!.blocks.flatMap((block) => (block.kind === "footage" && block.file === file ? (block.notes ?? []) : []));
    expect(notes("FILEcase0002").some((note) => note.startsWith("Gone without"))).toBe(true);
    expect(notes("FILEcase0001").some((note) => note.startsWith("Gone without"))).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

/** A project with a script of five footage files, one range each, a cut-in after the first. */
async function fiveFiles(fixture: Fixture): Promise<string> {
  const id = fixture.store.create("import", { width: 640, height: 360, fps: 30 }).project.id;
  await fixture.store.update(id, "test", (p) => {
    p.style = "courtroom";
    const footage = (n: number) => ({ kind: "footage" as const, file: `FILEcase000${n}`, url: `https://drive.google.com/file/d/FILEcase000${n}/view`, start: 0, end: 4, label: "00:00–00:04", words: ["where", "you"] as [string, string], notes: [`Case ${n}: link`] });
    p.script = { blocks: [footage(1), { kind: "narration", text: "Then it happened." }, footage(2), footage(3), footage(4), footage(5)] };
  });
  return id;
}

// Nov 22 (TODO: the editor's import stopped for a file that's really gone, the rest of the footage unused).
test("one of five files gone: the other four are laid out at once, the gone one's range a black card in its place", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-one-of-five", { services: { scripts } });
  try {
    const id = await fiveFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0003" ? new steps.NeedsPerson("Video unavailable: this video has been removed by the uploader.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("done");
    // Each fetched once: the gone one isn't asked again and again.
    expect(fetched.sort()).toEqual(["FILEcase0001", "FILEcase0002", "FILEcase0003", "FILEcase0004", "FILEcase0005"]);
    const project = fixture.store.get(id)!.project;
    const footage = project.script!.blocks.filter((block) => block.kind === "footage");
    expect(footage.map((block) => typeof block.media === "string")).toEqual([true, true, false, true, true]);
    // In script order, butted: the black card holds the gone range's 4 s between its neighbours.
    const clips = project.script!.blocks.map((block) => project.clips.find((clip) => clip.id === block.clip)!);
    for (let n = 1; n < clips.length; n++) expect(clips[n]!.start).toBe(clips[n - 1]!.start + clips[n - 1]!.duration);
    expect(clips[3]).toMatchObject({ type: "solid", duration: 120, name: "Case 3 · didn't come in" });
    // Said once, plainly, with what to do: the cloud's line (another link or keep it black).
    const said = (await missingMedia.state(fixture.app, id, false)).missing;
    expect(said).toEqual([{ id: "file:FILEcase0003", name: "Case 3", path: "FILEcase0003", asked: true, link: true, why: "Video unavailable: this video has been removed by the uploader." }]);
    expect(await missingMedia.held(fixture.home, project)).toBeNull();
  } finally {
    fixture.cleanup();
  }
});

test("another link given after the layout fills the black card where it is, sound and all, and nothing else moves", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-link-after", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new steps.NeedsPerson("Google Drive can't find this file: it was deleted, or in the trash.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    expect((await settled(scripts, id)).state).toBe("done");
    const before = fixture.store.get(id)!.project;
    const gone = before.script!.blocks[2]!;
    const card = before.clips.find((clip) => clip.id === gone.clip)!;
    const others = before.clips.filter((clip) => clip.id !== card.id);

    // The copy has sound.
    const copy = cloudFootage(HEARD);
    await replaceFootage(fixture.app, id, "FILEcase0002", "https://drive.google.com/file/d/FILEcopy00002/view");
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(copy.fetched).toEqual(["FILEcopy00002"]);
    expect(fetched).not.toContain("FILEcopy00002");
    const after = fixture.store.get(id)!.project;
    const block = after.script!.blocks[2]!;
    expect(block).toMatchObject({ kind: "footage", file: "FILEcopy00002", url: "https://drive.google.com/file/d/FILEcopy00002/view" });
    expect(typeof (block.kind === "footage" && block.media)).toBe("string");
    expect((block.notes ?? []).some((note) => note.startsWith("Gone without") || note.startsWith("Laid out without"))).toBe(false);
    // The same clip id, place and length, now the footage; its sound linked beneath it.
    const picture = after.clips.find((clip) => clip.id === card.id)!;
    expect(picture).toMatchObject({ type: "video", start: card.start, duration: card.duration, source_in: 0 });
    const sound = after.clips.find((clip) => clip.type === "audio" && clip.link === picture.link && clip.link !== undefined);
    expect(sound).toMatchObject({ start: card.start, duration: card.duration });
    for (const clip of others) expect(after.clips.find((one) => one.id === clip.id)).toEqual(clip);
    expect((await missingMedia.state(fixture.app, id, false)).missing).toEqual([]);
    // A bad link is refused in plain words, and nothing changes.
    await expect(replaceFootage(fixture.app, id, "FILEcopy00002", "https://docs.google.com/document/d/x")).rejects.toThrow("isn't missing from this edit");
  } finally {
    fixture.cleanup();
  }
});
