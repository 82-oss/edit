// What a failure means, and when Edit tries again: the one place that says it
// (honest council change 6, Nov 19). Before, two readers disagreed on anything
// they didn't know: effect/service.ts's `kindOf` called it "later", so Script
// mode stopped and waited for a person, and import_steps.ts's `whyOf` called it
// "passing", so the editor's import waited by itself. The same dropped line
// stopped one import and not the other.
//
// Eight kinds:
// - passing: a dropped line, a timeout, a busy service, the sign-in being
//   renewed, a step that stood still, and anything Edit doesn't recognise.
//   Tried again after 1, 5 and 15 minutes, then every 30, for as long as it
//   takes, and woken at once when the trouble is seen to be over.
// - quota: a paid plan out of credit, a day's allowance used. Every 30
//   minutes, or at the reset.
// - limit: Google Drive's download limit for a file. At Google's time, else a day.
// - encoder: the hardware encoder is busy. When it's free.
// - room: not enough room on this machine. Looked at every 5 minutes.
// - signin: no sign-in is kept at all. When someone signs in.
// - person: only a person can put it right (a file deleted, private, never
//   shared, not a video). Looked at again every 30 minutes in case it was
//   put right; the one kind Edit asks about.
// - broken: Edit's own bug, or a refusal that is the same every time. It
//   stops; a new build tries it once.
//
// The kind is read from the error's type first, and from its words only for
// text from outside Edit (Drive's pages, yt-dlp) and older builds' words kept
// in a job.

import * as diag from "./diag.ts";
import * as service from "./effect/service.ts";
import * as encoder from "./encoder.ts";
import { isBug } from "./guard.ts";
import { RELEASE } from "./version.ts";

export type Kind = "passing" | "quota" | "limit" | "encoder" | "room" | "signin" | "person" | "broken";

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

/** A step that made no progress (no bytes) for `afterMs`: passing, tried again by itself. */
export class StoodStill extends Error {
  override readonly name = "StoodStill";
  constructor(
    readonly what: string,
    readonly afterMs: number,
  ) {
    super(`${what} made no progress for ${minutes(afterMs)} and was stopped; Edit tries again by itself`);
  }
}

/** Not enough room on this machine for `needBytes`: waits until there is. */
export class NoRoom extends Error {
  override readonly name = "NoRoom";
  constructor(
    readonly needBytes: number,
    message = `Needs ${gigabytes(needBytes)} free on this computer`,
  ) {
    super(message);
  }
}

/** No sign-in is kept at all: waits until someone signs in. */
export class SignedOut extends Error {
  override readonly name = "SignedOut";
  constructor(message = "Sign in to Edit to go on.") {
    super(message);
  }
}

function minutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`;
}

/** The transcription plan or the relay's allowance, in its own words (ElevenLabs' 401: "exceeds your quota … credits remaining"). */
const QUOTA = /exceeds your quota|credits remaining|quota_exceeded|insufficient.credits|out of credit|transcription failed \(429\)|\ballowance\b|transcription budget[^.]*used up|hearing footage again[^.]*used up|rate.limit/i;
/** A plan's credit spent, in ElevenLabs' words (or Edit's own line for it). */
export const CREDIT = /exceeds your quota|credits remaining|quota_exceeded|insufficient.credits|out of credit/i;
/** A daily allowance's words: it comes back at midnight UTC. */
export const DAILY = /for today|today's|resets at midnight/i;
/** Google Drive's download limit for one file (its page, Edit's own line for it, the API's reason). */
const DRIVE_LIMIT = /download limit for this file|Too many users|downloadQuotaExceeded/i;
/** Text from outside Edit that only the person can answer (Drive's pages; posts; older builds' words kept in a job). */
const PERSON = /isn't shared|can't find this file|deleted, or in the trash|Private video|This video is private|confirm your age|age.restricted|members.only|Join this channel|not available in your country|blocked it in your country|Video unavailable|has been removed|has been terminated|no longer available|isn't a Drive file|isn't a Google Drive|isn't a YouTube video|has no bytes|A shared folder master|is not uploaded yet|pictures only, with no video|only shown to someone signed in|couldn't be read as video/i;
/** The disk full, in the system's words or Edit's own (older builds' "There isn't room on this Mac for …"). */
const ROOM = /no space left on device|ENOSPC|There isn't room on this|needs? (about )?[\d.]+ ?[MG]B free|out of room/i;
/** A connection, a timeout or a busy service, in the words a job keeps (Edit's own, FFmpeg's, Bun's fetch; macOS yt-dlp's for a dead line, Nov 20). */
// "failed to fill whole buffer" of a URL: the engine's read of footage in the cloud ended short (the line dropped under an
// export, Nov 21). Of a file on this disk the same words are a damaged file, and aren't here.
const PASSING = /(?:<url>|https?:\/\/\S+).*failed to fill whole buffer|Empty reply from server|could not reach|unreachable|socket connection was closed|connection (reset|refused|timed out)|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|timed out|didn't answer|took more than|made no progress|being renewed|network|Server returned 5(\d\d|XX)|\(5\d\d\)|busy|Input\/output error|No route to host|Failed to resolve hostname|Could not resolve host|Failed to connect|Stream ends prematurely|Invalid data found when processing input|Unable to connect|transfer closed with|SSL_ERROR_SYSCALL|was not closed cleanly|Broken pipe|nodename nor servname provided|\[Errno 8\]|Temporary failure in name resolution|Name or service not known|urlopen error|stood still|too slow/i;
/** The codes Bun, Node and curl give a connection that failed or dropped: passing, whatever the words say. */
const PASSING_CODES = new Set(["ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
/** No sign-in at all, in an older build's words kept in a job. */
const SIGNIN = /Sign in to Edit to go on|needs? you signed in to Edit/i;

/**
 * Edit's own queue, in writer/imports.ts `busy`'s words: three imports already running, or the project's job not
 * finished. Not trouble: passing, never counted as the same failure in a row, tried again in a minute (Nov 20: a
 * fourth Script import woken four times behind three others was failed for good, Home showing "Importing" for ever).
 */
const OUR_QUEUE = /imports are already running|Wait for this project's current job/i;
/** How soon work refused by Edit's own queue is tried again: about when one of the three running may have finished its step. */
const QUEUE_WAIT_MS = 60_000;

/** Whether `error` is Edit's own queue saying not yet (`OUR_QUEUE`). */
export function ourQueue(error: unknown): boolean {
  return OUR_QUEUE.test(typeof error === "string" ? error : diag.messageOf(error));
}

/** Tagged errors only the person can answer: a Drive file not shared with Edit, footage no longer where it was. */
const PERSON_TAGS = new Set(["DriveNotShared", "FootageMissing"]);

function tagOf(error: unknown): string | null {
  const tag = (error as { _tag?: unknown } | null)?._tag;
  return typeof tag === "string" ? tag : null;
}

/** The kind of any failure, an error or its words (a job keeps only the words); one nothing recognises is passing. */
export function kindOf(error: unknown): Kind {
  return surely(error) ?? "passing";
}

/**
 * The kind a failure is known to be, or null when nothing recognises it (`kindOf` then takes it as passing). For work
 * whose own refusals are plain errors (a share's "export the whole edit first"), which must not wait for ever: it
 * waits only on what's surely passing.
 */
export function surely(error: unknown): Kind | null {
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    if (at instanceof NeedsPerson) return "person";
    if (at instanceof DriveLimit) return "limit";
    if (at instanceof NoRoom) return "room";
    if (at instanceof SignedOut) return "signin";
    if (at instanceof StoodStill) return "passing";
    if (at instanceof StepTimedOut) return at.shared ? "encoder" : "passing";
    const code = (at as { code?: unknown }).code;
    if (code === "ENOSPC") return "room";
    if (typeof code === "string" && PASSING_CODES.has(code)) return "passing";
    const tag = tagOf(at);
    if (tag === "AllowanceUsedUp") return "quota";
    if (tag === "DownloadFailed") {
      const reason = (at as { reason?: unknown }).reason;
      if (reason === "VideoGone" || reason === "NeedsSignIn") return "person";
    }
    if (tag === "ImportStopped") {
      const kind = (at as { kind?: unknown }).kind;
      if (kind === "permanent") return "broken";
    }
    if (tag !== null && tag !== "ImportStopped") {
      // An area's own errors, by the table each gives effect/service.ts: a refusal the same every time is broken,
      // temporary is passing; a file not shared or footage moved is the person's; a 401 is a sign-in being renewed
      // (a real sign-out is SignedOut), a 402 credit, a 403 the person's. The rest ("later": a lock, a paused
      // connection) is read by its words.
      // A refusal by its status (the relay's, transcription's): 402 credit, 403 the person's, a 401 a sign-in being renewed.
      const status = (at as { status?: unknown }).status;
      if (typeof status === "number") {
        if (status === 402) return "quota";
        if (status === 403) return "person";
        if (status === 401 && tag === "ServiceRefused") return "passing";
      }
      if (PERSON_TAGS.has(tag)) return "person";
      const kind = service.kindOf(at);
      if (kind === "permanent") return "broken";
      if (kind === "temporary") return "passing";
    }
  }
  if (typeof error !== "string" && isBug(error)) return "broken";
  const words = typeof error === "string" ? error : diag.messageOf(error);
  if (OUR_QUEUE.test(words)) return "passing";
  if (ROOM.test(words)) return "room";
  if (DRIVE_LIMIT.test(words)) return "limit";
  if (QUOTA.test(words)) return "quota";
  if (PERSON.test(words)) return "person";
  if (SIGNIN.test(words)) return "signin";
  if (PASSING.test(words)) return "passing";
  return null;
}

/** Whether Edit waits it out by itself: anything but the person's and Edit's own bug. */
export function waitsByItself(kind: Kind): boolean {
  return kind !== "person" && kind !== "broken";
}

/**
 * How much faster every wait here runs, for the bad-day tests (`EDIT_BAD_DAY_SPEED=60`: an hour's wait in a
 * minute). Read here only, and never in a release build.
 */
export function speed(): number {
  if (RELEASE) return 1;
  const value = Number(process.env.EDIT_BAD_DAY_SPEED ?? "");
  return Number.isFinite(value) && value > 1 ? value : 1;
}

/** A wait of `ms`, at the tests' speed. */
export const scaled = (ms: number): number => Math.max(Math.round(ms / speed()), 0);

/** Passing failures are tried again after these, then every `PASSING_EVERY_MS` for as long as it takes (tests set them). */
export const PASSING_WAITS = { value: [60_000, 5 * 60_000, 15 * 60_000] };
export const PASSING_EVERY_MS = { value: 30 * 60_000 };
/** Credit, the room on the disk, a person's file looked at again: how often. */
export const QUOTA_EVERY_MS = { value: 30 * 60_000 };
export const ROOM_EVERY_MS = { value: 5 * 60_000 };
export const PERSON_EVERY_MS = { value: 30 * 60_000 };
/** Google Drive's download limit, when Google gives no time of its own. */
export const LIMIT_WAIT_MS = { value: 24 * 60 * 60_000 };
/** After a daily allowance's reset, a moment for the relay's day to turn. */
const AFTER_RESET_MS = 60_000;

/**
 * When a failure of this kind is tried again by itself (ms since the epoch), its `tries` so far counted (0: it
 * just failed the first time), or null: the encoder's while it's busy (when it's free), Edit's own bug (a new
 * build). Given the failure, a daily allowance waits for its reset and Drive's limit for Google's time.
 */
export function nextTry(kind: Kind, tries: number, now: number, error?: unknown): number | null {
  switch (kind) {
    case "passing": {
      if (error !== undefined && ourQueue(error)) return now + scaled(QUEUE_WAIT_MS);
      const waits = PASSING_WAITS.value;
      return now + scaled(waits[Math.max(tries, 0)] ?? PASSING_EVERY_MS.value);
    }
    case "quota": {
      const words = error === undefined ? "" : typeof error === "string" ? error : diag.messageOf(error);
      if (!CREDIT.test(words) && DAILY.test(words)) return nextMidnightUtc(now) + AFTER_RESET_MS;
      return now + scaled(QUOTA_EVERY_MS.value);
    }
    case "limit": {
      const hint = limitHint(error);
      return now + (hint !== null && hint > 0 ? hint : scaled(LIMIT_WAIT_MS.value));
    }
    case "room":
      return now + scaled(ROOM_EVERY_MS.value);
    case "person":
      return now + scaled(PERSON_EVERY_MS.value);
    case "encoder":
      return encoder.busy() ? null : now + scaled(60_000);
    case "signin":
      // Woken as someone signs in; looked at again meanwhile, as a person's is.
      return now + scaled(PERSON_EVERY_MS.value);
    case "broken":
      return null;
  }
}

/** Google's own wait, carried by a `DriveLimit` (or its cause). */
function limitHint(error: unknown): number | null {
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

/** The one line work waiting by itself shows: what it waits on, and when Edit tries again (`at`), in plain words. */
export function waitLine(kind: Kind, error: unknown, at: number | null): string {
  const clock = (ms: number) => {
    const day = new Date(ms);
    return `${String(day.getHours()).padStart(2, "0")}:${String(day.getMinutes()).padStart(2, "0")}`;
  };
  const when = at === null ? "" : ` at ${clock(at)}`;
  const words = typeof error === "string" ? error : diag.messageOf(error);
  if (kind === "quota") return `The plan is out of credit or today's allowance is used up: Edit tries again by itself${when}.`;
  if (kind === "limit") return `Google Drive's download limit is used up for today: Edit tries again by itself${when}.`;
  if (kind === "room") return `${words.replace(/[,;]?\s*(Retry|then press Retry|Free some space)[^.]*\.?\s*$/u, "").replace(/\.?\s*$/u, ".")} Edit goes on by itself once there's room${when === "" ? "" : ` (it looks again${when})`}.`;
  if (kind === "encoder") return "The hardware encoder is busy with an export: it goes on once it's free.";
  if (kind === "signin") return "Sign in to Edit, and it goes on by itself.";
  return `Waiting for the connection: Edit tries again by itself${when}.`;
}
