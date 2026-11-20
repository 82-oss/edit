// failure.ts: what a failure means and when Edit tries again, the one table both imports read (honest council
// change 6, Nov 19). Every error class and outside phrase the two old readers knew gives its kind; anything unknown
// is passing; each kind's next try is what the table says.

import { afterEach, expect, test } from "bun:test";

import * as service from "../src/effect/service.ts";
import * as failure from "../src/failure.ts";
import * as steps from "../src/import_steps.ts";
import { DownloadFailed } from "../src/youtube.ts";
import { AllowanceUsedUp } from "../src/transcribe.ts";
import { DriveNotShared, DownloadShort } from "../src/writer/drive.ts";
import { FootageMissing, FootageUnusable, ImportStopped } from "../src/writer/imports.ts";

afterEach(() => {
  delete process.env.EDIT_BAD_DAY_SPEED;
});

test("each error class and outside phrase has one kind; anything unknown is passing", () => {
  const cases: [unknown, failure.Kind][] = [
    [new failure.NeedsPerson("Google Drive can't find this file"), "person"],
    [new failure.DriveLimit("download limit for this file", 3_600_000), "limit"],
    [new failure.StepTimedOut("Cutting an excerpt", 60_000, false), "passing"],
    [new failure.StepTimedOut("An encode", 60_000, true), "encoder"],
    [new failure.StoodStill("Cutting an excerpt", 300_000), "passing"],
    [new failure.NoRoom(5.5e9), "room"],
    [new failure.SignedOut(), "signin"],
    [Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }), "room"],
    [new AllowanceUsedUp({ message: "Today's transcription allowance is used up" }), "quota"],
    [new DownloadFailed({ reason: "VideoGone", message: "Video unavailable" }), "person"],
    [new DownloadFailed({ reason: "Blocked", message: "Sign in to confirm you're not a bot" }), "passing"],
    [new DriveNotShared({ message: "This file isn't shared with Edit" }), "person"],
    [new FootageMissing({ message: "The footage isn't where it was" }), "person"],
    [new FootageUnusable({ message: "Longer than an import takes" }), "broken"],
    [new DownloadShort({ message: "came down short" }), "passing"],
    [new ImportStopped({ message: "413 Payload Too Large", kind: "permanent" }), "broken"],
    [new ImportStopped({ message: "could not reach Edit's relay: The socket connection was closed unexpectedly", kind: "later" }), "passing"],
    [new service.ServiceUnreachable({ service: "Edit's relay", message: "could not reach Edit's relay: the sign-in is being renewed" }), "passing"],
    [new service.ServiceTimedOut({ service: "R2", afterMs: 120_000, message: "it didn't answer within 120 s" }), "passing"],
    [new service.ServiceRefused({ service: "Edit's relay", status: 401, retryAfterMs: null, message: "Sign in to Edit" }), "passing"],
    [new service.ServiceRefused({ service: "Edit's relay", status: 402, retryAfterMs: null, message: "Payment required" }), "quota"],
    [new service.ServiceRefused({ service: "Drive", status: 403, retryAfterMs: null, message: "forbidden" }), "person"],
    [new service.ServiceRefused({ service: "Edit's relay", status: 413, retryAfterMs: null, message: "too large" }), "broken"],
    [new service.ServiceRefused({ service: "Edit's relay", status: 503, retryAfterMs: null, message: "busy" }), "passing"],
    [new TypeError("cannot read properties of undefined"), "broken"],
    // Words kept in a job by this build and older ones.
    ["could not reach Edit's relay: The socket connection was closed unexpectedly", "passing"],
    ["Finding the excerpt's keyframe took more than 2 min and was stopped", "passing"],
    ["The transcription plan is out of credit (exceeds your quota, 0 credits remaining)", "quota"],
    ["You have reached the download limit for this file", "limit"],
    ["This video is private", "person"],
    ["Google Drive can't find this file: it was deleted, or in the trash.", "person"],
    ["There isn't room on this Mac for MartyBlank.mp4 (5.5 GB)", "room"],
    ["Sign in to Edit to go on.", "signin"],
    // SignedOut's words kept as a string (writer/missing.ts reads the try's error so: bad-day signin-ended, Nov 20).
    ["The sound library and Google Drive need you signed in to Edit.", "signin"],
    ["something nobody has seen before", "passing"],
    [new Error("something nobody has seen before"), "passing"],
  ];
  for (const [error, kind] of cases) expect([String((error as Error).message ?? error), failure.kindOf(error)]).toEqual([String((error as Error).message ?? error), kind]);
  // The editor's import reads the same answer.
  for (const [error] of cases) expect(steps.whyOf(error)).toBe(failure.kindOf(error));
});

test("each kind's next try: passing after 1, 5, 15 min then every 30, room 5 min, credit 30 min or the day's reset, Drive at Google's time, the person's looked at again in 30, broken never", () => {
  const now = Date.UTC(2026, 10, 19, 14, 0, 0);
  const min = 60_000;
  expect([0, 1, 2, 3, 9].map((tries) => (failure.nextTry("passing", tries, now) ?? 0) - now)).toEqual([1 * min, 5 * min, 15 * min, 30 * min, 30 * min]);
  expect(failure.nextTry("room", 0, now)! - now).toBe(5 * min);
  expect(failure.nextTry("quota", 0, now, "exceeds your quota")! - now).toBe(30 * min);
  expect(failure.nextTry("quota", 0, now, "Today's allowance is used up; it resets at midnight UTC")).toBe(Date.UTC(2026, 10, 20) + 60_000);
  expect(failure.nextTry("limit", 0, now, new failure.DriveLimit("limit", 2 * 3600_000))! - now).toBe(2 * 3600_000);
  expect(failure.nextTry("limit", 0, now, "download limit for this file")! - now).toBe(24 * 3600_000);
  expect(failure.nextTry("person", 0, now)! - now).toBe(30 * min);
  expect(failure.nextTry("broken", 0, now)).toBeNull();
  expect(failure.waitsByItself("passing") && failure.waitsByItself("room") && !failure.waitsByItself("person") && !failure.waitsByItself("broken")).toBe(true);
});

test("the bad-day switch divides every wait", () => {
  const now = 1_000_000;
  process.env.EDIT_BAD_DAY_SPEED = "60";
  expect(failure.nextTry("passing", 0, now)! - now).toBe(1000);
  expect(failure.nextTry("passing", 5, now)! - now).toBe(30_000);
  expect(failure.nextTry("room", 0, now)! - now).toBe(5000);
});

test("surely: what's known to pass, or null for Edit's own plain refusals (a share waits only on the first)", () => {
  expect(failure.surely("Repack didn't answer")).toBe("passing");
  expect(failure.surely("could not reach Edit's relay: The socket connection was closed unexpectedly")).toBe("passing");
  expect(failure.surely(new failure.NoRoom(1e9))).toBe("room");
  expect(failure.surely(new Error("export the whole edit first: a review shares an export"))).toBeNull();
  expect(failure.surely("that isn't one of this project's whole exports")).toBeNull();
  // kindOf still takes what nothing recognises as passing (an import waits it out).
  expect(failure.kindOf("that isn't one of this project's whole exports")).toBe("passing");
});

test("real network errors are passing by their code and by FFmpeg's, curl's and Bun's words; Edit's own room lines are room (verify.md findings 4 and 5)", () => {
  for (const words of [
    "Server returned 5XX Server Error reply",
    "Input/output error",
    "No route to host",
    "Failed to resolve hostname r2.example",
    "Stream ends prematurely at 81234, should be 912345",
    "Unable to connect. Is the computer able to access the url?",
    "curl: (6) Could not resolve host: example",
    "curl: (7) Failed to connect to example port 443",
    "curl: (18) transfer closed with 1234 bytes remaining to read",
    "curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL",
    "curl: (92) HTTP/2 stream 1 was not closed cleanly",
  ]) expect([words, failure.surely(words)]).toEqual([words, "passing"]);
  expect(failure.surely(Object.assign(new Error("fetch failed"), { code: "ConnectionRefused" }))).toBe("passing");
  expect(failure.surely(Object.assign(new Error("whatever"), { code: "ECONNRESET" }))).toBe("passing");
  for (const words of ["This import needs about 12 GB free and this Mac has 6 GB. Free some space, then import it again.", "Needs 12 MB free on this computer to cut the footage's excerpts", "This computer is out of room to cut the footage's excerpts"]) expect([words, failure.surely(words)]).toEqual([words, "room"]);
  expect(failure.surely(new failure.SignedOut("The sound library and Google Drive need you signed in to Edit."))).toBe("signin");
});

test("the editor's import keeps the most room its files said they need, so the table looks at the disk before cutting again (Fable's last look, bug 3)", async () => {
  const { roomFor } = await import("../src/script.ts");
  expect(roomFor([new failure.NoRoom(2e9), new Error("could not reach Edit's relay"), Object.assign(new Error("wrapped"), { cause: new failure.NoRoom(5.5e9) }), undefined])).toBe(5.5e9);
  expect(roomFor([new Error("could not reach Edit's relay")])).toBe(0);
});

test("Edit's own import queue is passing, known (never counted as the same failure), and tried again in a minute (Nov 20)", () => {
  for (const words of ["3 imports are already running. Try again when one finishes.", "Wait for this project's current job to finish before retrying its import."]) {
    expect(failure.surely(new Error(words))).toBe("passing");
    expect(failure.ourQueue(words)).toBe(true);
    expect(failure.nextTry("passing", 7, 1_000_000, new Error(words))).toBe(1_060_000);
  }
  expect(failure.ourQueue("could not reach Edit's relay")).toBe(false);
});

test("a dead line in macOS yt-dlp's words, and a YouTube download that stopped part-way or stood still, are passing, never the person's (Nov 20)", async () => {
  const { DownloadFailed } = await import("../src/youtube.ts");
  for (const words of [
    "ERROR: unable to download video data: <urlopen error [Errno 8] nodename nor servname provided, or not known>",
    "[Errno -3] Temporary failure in name resolution",
    "[Errno -2] Name or service not known",
    "ERROR: The download stood still (nothing for 10 minutes).",
  ]) {
    expect(failure.surely(words)).toBe("passing");
  }
  for (const reason of ["StoppedPartWay", "StoodStill", "RouteRefused"]) {
    expect(failure.surely(new DownloadFailed({ reason, message: "YouTube video abcdefghijk couldn't be downloaded: something new" }))).toBe("passing");
  }
  expect(failure.surely(new DownloadFailed({ reason: "VideoGone", message: "YouTube video abcdefghijk couldn't be downloaded: Video unavailable" }))).toBe("person");
});
