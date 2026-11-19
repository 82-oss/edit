// The script import's footage pipeline rules, in one place (Nov 8 audit,
// item F): how long each step may take, what a failure means, and when Edit
// tries again by itself. The disk import and the cloud import differ only by
// where the original is (script.ts `footageToDisk` / `footageToCloud`); both
// read these.
//
// Every step is bounded. A hung FFmpeg, an addon encode that never answered
// or a relay copy polled for ever used to keep the import RUNNING with nothing
// moving, which is exactly what blocked Retry, another link and skip. Now a
// step past its time lands its file in `failed` with a passing reason, so the
// person's Retry works and Edit tries it again by itself.
//
// What a failure is, in four words (`whyOf`), read from the error's class
// first and its words only for text from outside Edit (Drive's pages, yt-dlp):
// - passing: may go if tried again (a dropped connection, a busy Google, a
//   step past its time). Edit tries again by itself (`RETRY_WAITS`), then
//   waits by itself and tries every `PASSING_RETRY_MS` until it comes in: the
//   person is never asked about it.
// - person: only the person can fix it (a file nobody shared, a private
//   video): another link, or go on without it.
// - quota: the transcription plan is out of credit, or the relay's allowance
//   is used up. Not an error to retry by hand: the file waits, tried again
//   every `QUOTA_RETRY_MS`, and the report's "Needs attention" says so once.
// - encoder: an encode ran out of time while an export or another encode held
//   the hardware encoder (encoder.ts). It waits until the encoder is free.
// - limit: Google Drive's download limit for the file is used up for the day.
//   It waits (Google's own hint, else `LIMIT_RETRY_MS`) and is tried again by
//   itself; a copy's link carries it on sooner.
//
// A daily allowance (the relay's: "… for today is used up; it resets at
// midnight UTC") waits for its reset, not half an hour: asking before then
// only hears the same refusal.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import * as encoder from "./encoder.ts";
import * as failure from "./failure.ts";
import { CREDIT, DAILY, StepTimedOut } from "./failure.ts";

/** How long each step may take before it's taken as stuck (ms). */
export const LIMITS = {
  /** ffprobe of a file or a presigned URL: its length, its keyframes (a few range reads). */
  probe: 2 * 60_000,
  /** Cutting an excerpt (picture copied, sound encoded) from a file here: a base plus a second per second cut. Over the network a cut runs for as long as it moves (`whileMoving`). */
  cut: (seconds: number) => 10 * 60_000 + Math.max(seconds, 0) * 1000,
  /** A proxy encode (~200 fps at 1080p on the M1; slower from R2, slower still beside an export): a base plus two seconds per second of footage. */
  proxy: (seconds: number) => 15 * 60_000 + Math.max(seconds, 0) * 2000,
  /** The relay's Drive-to-R2 copy in all: a base plus the file at 2 MB/s (its own stall rule ends a copy standing still sooner). */
  relayCopy: (bytes: number | null) => 30 * 60_000 + Math.max(bytes ?? 0, 0) / 2_000,
  /** The relay not answering about its copy for this long counts as the copy standing still. */
  relayUnreachable: 10 * 60_000,
  /** The voice-over: every cut-in spoken and split across them. */
  voiceover: 30 * 60_000,
  /** The wait for the footage's words before the edit is laid out without them (transcription carries on). */
  transcript: 30 * 60_000,
};

/** A file waiting on the transcription plan's credit is tried again this often (failure.ts's own). */
export const QUOTA_RETRY_MS = failure.QUOTA_EVERY_MS;
/** A file at Google Drive's download limit is tried again this long after, when Google gives no time of its own (failure.ts's own). */
export const LIMIT_RETRY_MS = failure.LIMIT_WAIT_MS;
/** What a failure is: failure.ts's kinds, the one rule both imports read. */
export type Why = failure.Kind;

export { DriveLimit, NeedsPerson, nextMidnightUtc, StepTimedOut } from "./failure.ts";

/** What a failure is (failure.ts `kindOf`): the editor's import and Script mode's read the same answer. */
export const whyOf = (error: unknown): Why => failure.kindOf(error);

/** Whether Edit may try it again by itself, or Retry may help: anything but the person's and Edit's own bug. */
export const passing = (error: unknown): boolean => failure.waitsByItself(failure.kindOf(error));

/** Whether a failure of this kind waits by itself (everything but the person's and Edit's own bug). */
export const waitsByItself = failure.waitsByItself;

/**
 * When a failure of this kind is tried again by itself (ms since the epoch), or null: the encoder's while it's busy,
 * Edit's own bug, or a passing one (the import's own retry loop times those). Read from failure.ts `nextTry`.
 */
export function retryAt(why: Why, now: number, error?: unknown): number | null {
  if (why === "passing") return null;
  return failure.nextTry(why, 0, now, error);
}

/** "14:30": a time of day on this computer. */
export function clock(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * What Edit says while hearing waits on something outside it, plainly: the
 * service, that an admin adds credit (or the day's reset), and when Edit
 * tries again by itself. For a person and the agent alike.
 */
export function hearingWaits(error: unknown, at: number): string {
  const words = typeof error === "string" ? error : diag.messageOf(error);
  if (CREDIT.test(words)) return `The transcription plan (ElevenLabs) is out of credit: an admin adds credit, and Edit tries again by itself at ${clock(at)}.`;
  if (DAILY.test(words)) return `Today's transcription allowance is used up; Edit tries again by itself at ${clock(at)}, when it resets.`;
  return `Transcription is busy right now; Edit tries again by itself at ${clock(at)}.`;
}

/**
 * Runs `work` within `ms`: past it, `work`'s signal is aborted (an FFmpeg
 * given it is ended) and the step fails with `StepTimedOut`, saying whether
 * the encoder was someone else's at the time (`self`: the step's own hold).
 * Work that can't be stopped (the addon's encode) is left to finish, its
 * answer ignored.
 */
export async function bounded<T>(what: string, ms: number, work: (signal: AbortSignal) => Promise<T>, self?: number): Promise<T> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const shared = encoder.shared(self);
      stop.abort();
      reject(new StepTimedOut(what, ms, shared));
    }, ms);
  });
  try {
    return await Promise.race([work(stop.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a step over the network may stand still (no new bytes) before it's stopped and tried again (tests set it). */
export const STILL_MS = { value: 5 * 60_000 };

/**
 * Runs `work`, read over the network, for as long as it moves: stopped (its signal aborted, an FFmpeg given it
 * ended) only once `progress()` (bytes: the cut's file growing, a copy's count rising) has stood still for
 * `stillMs`, failing with `StoodStill`, passing. A line slower than any fixed limit assumed is never "stuck"
 * (honest council change 5, Nov 19: JJ's "Genius" Killer's first file, cut five times on nightly-90 and each
 * stopped at 15 to 18 minutes on "Cutting an excerpt took more than 16 min", about 85 minutes of his line thrown
 * away). A pause longer than a beat (the machine asleep, the process frozen) starts its clock again: a step isn't
 * stuck for the time the lid was shut.
 */
export async function whileMoving<T>(what: string, progress: () => number, work: (signal: AbortSignal) => Promise<T>, stillMs = STILL_MS.value): Promise<T> {
  const stop = new AbortController();
  const still = failure.scaled(stillMs);
  const beat = Math.max(Math.min(5_000, Math.floor(still / 10)), 20);
  let seen = progress();
  let movedAt = Date.now();
  let tickedAt = movedAt;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stood = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      const now = Date.now();
      // Asleep or frozen between beats: the clock starts again.
      if (now - tickedAt > Math.max(10_000, beat * 3)) movedAt = now;
      tickedAt = now;
      const at = progress();
      if (at !== seen) {
        seen = at;
        movedAt = now;
        return;
      }
      if (now - movedAt >= still) {
        clearInterval(timer);
        // Said first, so the race ends on why it stopped, not on the work's own "aborted".
        reject(new failure.StoodStill(what, still));
        stop.abort();
      }
    }, beat);
  });
  try {
    return await Promise.race([work(stop.signal), stood]);
  } finally {
    clearInterval(timer);
  }
}

/** The size of `path` now, 0 while it isn't there: a cut's or a download's progress. */
export function sizeOf(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

/** An encode from here: held on the encoder while it runs and bounded by `ms`, contention said if it runs out. */
export async function encoding<T>(what: string, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const hold = encoder.hold(what);
  try {
    return await bounded(what, ms, work, hold.token);
  } finally {
    hold.release();
  }
}
