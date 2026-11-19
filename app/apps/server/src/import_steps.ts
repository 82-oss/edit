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

import * as diag from "./diag.ts";
import * as encoder from "./encoder.ts";

/** How long each step may take before it's taken as stuck (ms). */
export const LIMITS = {
  /** ffprobe of a file or a presigned URL: its length, its keyframes (a few range reads). */
  probe: 2 * 60_000,
  /** Cutting an excerpt (picture copied, sound encoded) over the network: a base plus a second per second cut. */
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

/** The pauses before Edit tries a passing failure again by itself (tests make them instant). */
export const RETRY_WAITS = { value: [60_000, 5 * 60_000] };
/**
 * After those, a file whose failure passes (a dropped connection, a busy Google, a step past its time) waits by itself
 * this long before the import is woken to try it again, and again, until it comes in: never handed to the person.
 */
export const PASSING_RETRY_MS = { value: 10 * 60_000 };
/** A file waiting on the transcription plan's credit is tried again this often. */
export const QUOTA_RETRY_MS = { value: 30 * 60_000 };
/** A file at Google Drive's download limit is tried again this long after, when Google gives no time of its own. */
export const LIMIT_RETRY_MS = { value: 24 * 60 * 60_000 };
/** After a daily allowance's reset, a moment for the relay's day to turn. */
const AFTER_RESET_MS = 60_000;

export type Why = "passing" | "person" | "quota" | "encoder" | "limit";

/** A failure only the person can fix: another link, or go on without it. */
export class NeedsPerson extends Error {
  override readonly name = "NeedsPerson";
}

/** Google Drive's download limit for a file is used up for the day; `retryAfterMs` when Google said when it's back. */
export class DriveLimit extends Error {
  override readonly name = "DriveLimit";
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** A step past its time; `shared` when the hardware encoder was someone else's too when it ran out. */
export class StepTimedOut extends Error {
  override readonly name = "StepTimedOut";
  constructor(
    readonly what: string,
    readonly afterMs: number,
    readonly shared: boolean,
  ) {
    super(`${what} took more than ${minutes(afterMs)} and was stopped${shared ? " (the hardware encoder was busy with other work)" : ""}`);
  }
}

function minutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

/** The transcription plan or the relay's allowance, in its own words (ElevenLabs' 401: "exceeds your quota … credits remaining"). */
const QUOTA = /exceeds your quota|credits remaining|quota_exceeded|insufficient.credits|out of credit|transcription failed \(429\)|\ballowance\b|transcription budget[^.]*used up|hearing footage again[^.]*used up|rate.limit/i;
/** A plan's credit spent, in ElevenLabs' words (or Edit's own line for it). */
const CREDIT = /exceeds your quota|credits remaining|quota_exceeded|insufficient.credits|out of credit/i;
/** A daily allowance's words: it comes back at midnight UTC. */
const DAILY = /for today|today's|resets at midnight/i;
/** Google Drive's download limit for one file (its page, Edit's own line for it, the API's reason). */
const DRIVE_LIMIT = /download limit for this file|Too many users|downloadQuotaExceeded/i;
/** Text from outside Edit that only the person can answer (Drive's pages; posts; older builds' words kept in a job). */
const PERSON = /isn't shared|can't find this file|deleted, or in the trash|Private video|This video is private|confirm your age|age.restricted|members.only|Join this channel|not available in your country|blocked it in your country|Video unavailable|has been removed|has been terminated|no longer available|isn't a Drive file|isn't a YouTube video|has no bytes|A shared folder master|is not uploaded yet|pictures only, with no video|only shown to someone signed in/i;

function tagOf(error: unknown): string | null {
  const tag = (error as { _tag?: unknown } | null)?._tag;
  return typeof tag === "string" ? tag : null;
}

/** What a failure means for the import (see the module notes); a job's saved words are read the same way. */
export function whyOf(error: unknown): Why {
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    if (at instanceof NeedsPerson) return "person";
    if (at instanceof DriveLimit) return "limit";
    if (at instanceof StepTimedOut) return at.shared ? "encoder" : "passing";
    const tag = tagOf(at);
    if (tag === "AllowanceUsedUp") return "quota";
    if (tag === "DownloadFailed") {
      const reason = (at as { reason?: unknown }).reason;
      if (reason === "VideoGone" || reason === "NeedsSignIn") return "person";
    }
  }
  const words = typeof error === "string" ? error : diag.messageOf(error);
  if (DRIVE_LIMIT.test(words)) return "limit";
  if (QUOTA.test(words)) return "quota";
  if (PERSON.test(words)) return "person";
  return "passing";
}

/** Whether Edit may try it again by itself, or Retry may help: anything but the person's. */
export function passing(error: unknown): boolean {
  return whyOf(error) !== "person";
}

/**
 * When a failure of this kind is tried again by itself (ms since the epoch),
 * or null (the person's, or at once). Given the failure, a daily allowance
 * waits for its reset and Drive's limit for Google's own time when it gave one.
 */
export function retryAt(why: Why, now: number, error?: unknown): number | null {
  if (why === "limit") {
    const hint = findHint(error);
    return now + (hint !== null && hint > 0 ? hint : LIMIT_RETRY_MS.value);
  }
  if (why !== "quota") return null;
  const words = error === undefined ? "" : typeof error === "string" ? error : diag.messageOf(error);
  if (!CREDIT.test(words) && DAILY.test(words)) return nextMidnightUtc(now) + AFTER_RESET_MS;
  return now + QUOTA_RETRY_MS.value;
}

/** Google's own wait, carried by a `DriveLimit` (or its cause). */
function findHint(error: unknown): number | null {
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    if (at instanceof DriveLimit) return at.retryAfterMs;
  }
  return null;
}

/** The next midnight UTC after `now` (ms). */
export function nextMidnightUtc(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
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

/** An encode from here: held on the encoder while it runs and bounded by `ms`, contention said if it runs out. */
export async function encoding<T>(what: string, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const hold = encoder.hold(what);
  try {
    return await bounded(what, ms, work, hold.token);
  } finally {
    hold.release();
  }
}
