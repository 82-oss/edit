// Edit's cloud: footage originals and preview proxies on Cloudflare
// R2, project files in Convex, all through the relay (apps/relay/src/cloud.ts),
// which holds the R2 keys and Convex's service token. Edit only ever sees
// short-lived presigned URLs and the answers of `edit:` Convex functions.
//
// The Rust side ran curl subprocesses; here it's fetch, with the relay token
// only ever in a request header (never an argument, never a log line).
// Errors are thrown Errors whose text is fit to show (agents and the UI read
// it). Cloud calls carry the signed-in person's token (accounts.ts; or
// `EDIT_RELAY_TOKEN` for tests and a local relay); [`enabled`] says whether
// there's a sign-in.
//
// Keys are R2 object keys, always under `edit/` ([`validKey`]); the bucket is
// shared with Repack, and the relay refuses anything else. An upload may also
// go to Script mode's `writer/` keys (writer/cloud.ts's footage), through the
// relay's writer routes, so both resume the same way.
//
// Big uploads are multipart: fixed-size parts (R2 wants every part but the
// last the same size), a few in flight at once, each retried with a fresh
// URL, and the upload aborted if one gives up. [`uploadStream`] takes any
// source (a Drive download piped straight through) and holds only the parts
// in flight in memory, never a temp file.

import * as fs from "node:fs";

import { Effect, Option, Predicate, Schedule, Schema } from "effect";

import * as cloudBlocks from "./cloud_blocks.ts";
import * as diag from "./diag.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import * as service from "./effect/service.ts";
import { ioMessage, writeAtomic } from "./files.ts";
import { isBug } from "./guard.ts";
import * as jobs from "./jobs.ts";
import * as outages from "./outages.ts";
import { extension, join, parent } from "./paths.ts";
import * as playing from "./playing.ts";
import * as relay from "./relay.ts";
import { byteLength, debugStr, takeChars } from "./rust.ts";
import { stableStringify } from "./stable.ts";
import { validId } from "./store.ts";

const MIB = 1024 * 1024;
/**
 * A file's parts: 16 MiB, at most eight in flight (≤ 144 MiB in memory); how
 * many of the eight go follows the line (`partsFor`). A part has to finish well
 * inside a minute: from Sphe's Mac each connection to R2 carried ~0.5 MB/s on
 * Nov 7, and every 64 MiB part was cut at ~60 s ("The socket connection was
 * closed unexpectedly"), so a 0.7 GB review copy never got up.
 */
export const FILE_PART = 16 * MIB;
export const FILE_PARALLEL = 8;
/** A stream's parts: 32 MiB, two in flight plus the one being read (≤ 96 MiB). */
export const STREAM_PART = 32 * MIB;
const STREAM_PARALLEL = 2;
/** S3's (and R2's) limit on parts per upload. */
export const MAX_PARTS = 10_000;
/** Tries per part, per single PUT and per download. */
const ATTEMPTS = 4;
/** Keys per relay delete request (the relay's limit). */
const DELETE_BATCH = 40;
/** A transfer slower than 1 KB/s for a minute is given up on (curl's --speed-limit 1024 --speed-time 60). */
const STALL_BYTES_PER_SECOND = 1024;
const STALL_WINDOW_MS = 60_000;
/** How long a download may take to answer at all (curl's --connect-timeout 30). */
const CONNECT_MS = 30_000;

/**
 * A file this big or more uploads resumably (its parts kept in a journal): a
 * review copy (a few hundred MB) began again from nothing after every failure
 * when only 512 MiB and up were (Nov 16 audit). Two parts at the least.
 */
export const RESUMABLE_FROM = 2 * FILE_PART;

/** What tests change: the waits between retries, and part sizes (so a multipart upload needn't be 64 MiB). */
export const timing = {
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  filePart: FILE_PART,
  streamPart: STREAM_PART,
  /** A transfer is given up on after this long below STALL_BYTES_PER_SECOND. */
  stallMs: STALL_WINDOW_MS,
  /** A download may take this long to answer at all. */
  connectMs: CONNECT_MS,
  /** A file this big or more uploads resumably (`RESUMABLE_FROM`). */
  resumableFrom: RESUMABLE_FROM,
  /** How long an upload that must get there (a share's) keeps at a network that comes and goes, its waits in all. */
  keptAtMs: 10 * 60_000,
  /** How much of a request's body is handed over at a time (its progress, and the line's meter: `pulled`). */
  putChunk: MIB,
  /** Whether a request to `url` goes through a proxy (`throughProxy`), which takes its whole body at once. */
  proxied: (url: string): boolean => throughProxy(url, process.env),
};

/**
 * How far what a direct request has handed its connection can lead what the receiver has taken: the socket's send
 * buffer (Bun's fetch takes the next piece of a body only as the socket drains; 1 to 2 MB on a Mac, at most 4 MiB on
 * Linux, measured Nov 22). An upload's progress counts only what's this far behind.
 */
const HANDED_AHEAD = 4 * MIB;

/**
 * Whether Bun's fetch sends a request to `url` through a proxy, as it decides (read once at its start: `HTTPS_PROXY`
 * or `https_proxy` for https, `HTTP_PROXY` or `http_proxy` for http, unless `NO_PROXY`/`no_proxy` names the host, a
 * domain above it, or `*`). Through one (a line proxy on the MacBook Air, Nov 22, and some VPNs), Bun takes a part's
 * whole body at once into the tunnel, so what it has taken says nothing of what has got there.
 */
export function throughProxy(url: string, env: Record<string, string | undefined>): boolean {
  let host: string;
  let https: boolean;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    https = parsed.protocol === "https:";
  } catch {
    return false;
  }
  const proxy = https ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
  if (proxy === undefined || proxy.trim() === "") return false;
  const skip = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, "").replace(/^\*?\./, ""))
    .filter((entry) => entry !== "");
  return !skip.some((entry) => entry === "*" || host === entry || host.endsWith(`.${entry}`));
}

/** Whether cloud calls can work: someone is signed in (or `EDIT_RELAY_TOKEN` is set). Cloud is always on then. */
export function enabled(): boolean {
  return relay.cloudEnabled();
}

/** POSTs `body` to the relay's `/v1/cloud/<path>` and returns its JSON answer. */
export function relayJson(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return relay.json<Record<string, unknown>>("POST", `/v1/cloud/${path}`, body, "cloud storage", 120, signal);
}

const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f-\u009f\\]/u;

/**
 * A key Edit may use: under `edit/`, no empty, `.` or `..` segments, no
 * control characters or backslashes (the relay's rule, checked early).
 */
export function validKey(key: string): boolean {
  return (
    byteLength(key) <= 1024 &&
    key.startsWith("edit/") &&
    !CONTROL_OR_BACKSLASH.test(key) &&
    key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function checkKey(key: string): void {
  if (!validKey(key)) throw new Error(`not a cloud key Edit may use: ${debugStr(key)}`);
}

/** A key an upload may go to: Edit's (`edit/`), or Script mode's (`writer/`, through the relay's writer routes), by the same rule. */
function checkUploadKey(key: string): void {
  if (!validKey(key) && !(key.startsWith("writer/") && validKey(`edit/${key.slice("writer/".length)}`))) throw new Error(`not a cloud key Edit may use: ${debugStr(key)}`);
}

/** The relay's R2 route for `key`: Script mode's keys go through its writer routes (apps/relay/src/writer_cloud.ts), which answer alike. */
const r2 = (key: string, route: string): string => `${key.startsWith("writer/") ? "writer/" : ""}r2/${route}`;

/** What a presigned URL lets its holder do. */
export type Method = "GET" | "PUT" | "HEAD";

/**
 * A presigned URL for `key`. `expires` (seconds) defaults to an hour; the
 * relay caps it there, or at 6 h for a GET of footage (originals, proxies,
 * excerpts, sounds), which FFmpeg reads through one URL for a whole excerpt
 * or export.
 */
export async function presign(key: string, method: Method, expires: number | null = null, edge = false, signal?: AbortSignal): Promise<string> {
  // Writer's script files are read for the handoff (the relay allows that too), never written.
  if (!(method !== "PUT" && key.startsWith("writer/scripts/") && validKey(`edit/${key.slice("writer/".length)}`))) checkKey(key);
  const body: Record<string, unknown> = { key, method, ...(edge ? { edge: true } : {}) };
  if (expires !== null) body.expires = Math.max(Math.floor(expires), 1);
  const answer = await relayJson("r2/url", body, signal);
  if (typeof answer.url !== "string") throw lacking("the relay gave no URL");
  return answer.url;
}

/** An object's size and identity. */
export interface Head {
  size: number;
  etag: string | null;
  contentType: string | null;
}

/** `Value::as_u64`: a non-negative whole number, else null. */
function asU64(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The object at `key`, or null when there isn't one. */
export function head(key: string, signal?: AbortSignal): Promise<Head | null> {
  checkKey(key);
  return diag.timeOnAsync("cloud", "cloud: head", key, async () => parseHead(await relayJson("r2/head", { key }, signal)));
}

export function parseHead(answer: Record<string, unknown>): Head | null {
  if (answer.exists !== true) return null;
  return {
    size: asU64(answer.size) ?? 0,
    etag: typeof answer.etag === "string" ? answer.etag : null,
    contentType: typeof answer.contentType === "string" ? answer.contentType : null,
  };
}

/** One listed object. */
export interface CloudObject {
  key: string;
  size: number;
}

/** Every object whose key starts with `prefix` (which must start with `edit/`). */
export function list(prefix: string): Promise<CloudObject[]> {
  if (!prefix.startsWith("edit/")) {
    return Promise.reject(new Error(`not a cloud prefix Edit may use: ${debugStr(prefix)}`));
  }
  return diag.timeOnAsync("cloud", "cloud: list", prefix, async () => {
    const objects: CloudObject[] = [];
    let cursor: string | null = null;
    for (;;) {
      const body: Record<string, unknown> = cursor === null ? { prefix } : { prefix, cursor };
      const answer = await relayJson("r2/list", body);
      for (const object of Array.isArray(answer.objects) ? answer.objects : []) {
        const record = object as Record<string, unknown> | null;
        if (record !== null && typeof record === "object" && typeof record.key === "string") {
          objects.push({ key: record.key, size: asU64(record.size) ?? 0 });
        }
      }
      if (typeof answer.cursor === "string" && answer.cursor !== "") cursor = answer.cursor;
      else return objects;
    }
  });
}

/** Deletes `keys` (missing ones are fine). */
export async function remove(keys: string[]): Promise<void> {
  for (const key of keys) checkKey(key);
  await diag.timeOnAsync("cloud", "cloud: delete", `${keys.length} keys`, async () => {
    for (let at = 0; at < keys.length; at += DELETE_BATCH) {
      await relayJson("r2/delete", { keys: keys.slice(at, at + DELETE_BATCH) });
    }
  });
}

/**
 * `from` copied to `to` inside the cloud (the relay's `r2/copy`: one project's exports and review files, within it),
 * nothing sent from here: its size. Null when the relay can't (one older than Nov 22 doesn't know the route, or
 * refused it), so the caller sends the file itself as before; a failure on the way (offline) throws, as an upload's.
 */
export async function copy(from: string, to: string): Promise<number | null> {
  checkKey(from);
  checkKey(to);
  let answer: Record<string, unknown>;
  try {
    // A server-side copy of a few GB takes R2 a while; the relay answers once it's whole.
    answer = await relay.json<Record<string, unknown>>("POST", "/v1/cloud/r2/copy", { from, to }, "cloud storage", 600);
  } catch (error) {
    if (error instanceof service.ServiceRefused && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) return null;
    throw error;
  }
  const size = asU64(answer.size);
  if (answer.ok !== true || size === null) throw lacking("the relay's copy said no size");
  return size;
}

// ---------------------------------------------------------------------------
// Uploads

/** `progress(sent, total)` as bytes go (from every part in flight). */
export type Report = (sent: number, total: number) => void;

/** Something to upload from, read a part at a time (`Read`): a file, a download, stdin. */
export interface Source {
  /** Up to `max` bytes (any amount above zero), or null at the end. */
  read(max: number): Promise<Uint8Array | null>;
}

/** A source over bytes in memory. */
export function bytesSource(data: Uint8Array): Source {
  let at = 0;
  return {
    async read(max) {
      if (at >= data.length) return null;
      const end = Math.min(at + max, data.length);
      const out = data.subarray(at, end);
      at = end;
      return out;
    },
  };
}

/** A source over a stream's chunks (a fetch body, stdin), keeping what a read didn't take. */
export function streamSource(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): Source {
  const iterator = (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  let left: Uint8Array | null = null;
  let done = false;
  return {
    async read(max) {
      while (left === null || left.length === 0) {
        if (done) return null;
        const next = await iterator.next();
        if (next.done === true) {
          done = true;
          return null;
        }
        left = next.value;
      }
      const out = left.subarray(0, Math.min(max, left.length));
      left = left.subarray(out.length);
      return out;
    },
  };
}

/** A source over an open file, from its start. */
function fileSource(handle: fs.promises.FileHandle): Source {
  // Read off the server's thread (Nov 21 audit: `fs.readSync` held every other request for each 4 MiB read), and a
  // few pieces ahead, so a part's bytes are here when its turn comes: read only as each was asked, the parts of a fast
  // upload started one after another instead of together.
  const CHUNK = 4 * MIB;
  const AHEAD = 4;
  let next = 0;
  let ended = false;
  const queue: Promise<Buffer>[] = [];
  let left: Buffer | null = null;
  const fill = () => {
    while (!ended && queue.length < AHEAD) {
      const at = next;
      next += CHUNK;
      const reading = handle.read(Buffer.allocUnsafe(CHUNK), 0, CHUNK, at).then(({ bytesRead, buffer }) => buffer.subarray(0, bytesRead));
      // One read ahead past where the upload stops is never asked for: its failure isn't anyone's.
      reading.catch(() => {});
      queue.push(reading);
    }
  };
  return {
    async read(max) {
      if (left === null || left.length === 0) {
        fill();
        const coming = queue.shift();
        if (coming === undefined) return null;
        const got = await coming;
        // A short read is the file's end (one that changed meanwhile is caught by its size: `uploadFile`).
        if (got.length < CHUNK) {
          ended = true;
          queue.length = 0;
        } else fill();
        if (got.length === 0) return null;
        left = got;
      }
      const out = left.subarray(0, Math.min(max, left.length));
      left = left.subarray(out.length);
      return out;
    },
  };
}

// Whose turn the line out is. A Mac has one, and a home's is small. JJ's,
// Nov 9 (about 8 Mbit/s): a share's review copy (0.55 GB, what he and the
// reviewers wait for) went up beside its export's own copy for the cloud (a
// few GB nobody waits for, started the moment the export ended), and the link
// took 19 min 35 s from an export that took 24 s. So what someone waits on
// goes `first`, and an upload sent `behind` (a finished export's cloud copy, a
// review's full-quality file) holds its next part until nothing is.
let waitedOn = 0;
const lineWaiters = new Set<() => void>();

/** Runs `work`, which someone is waiting on (a share, from its export to its link), with the line out to itself. */
export async function first<T>(work: () => Promise<T>): Promise<T> {
  waitedOn += 1;
  try {
    return await work();
  } finally {
    waitedOn -= 1;
    if (waitedOn === 0) for (const wake of [...lineWaiters]) wake();
  }
}

/** Whether something a person waits on has the line out now. */
export function lineTaken(): boolean {
  return waitedOn > 0;
}

/**
 * Waits until nothing a person waits on has the line (at once when nothing has), or `signal` stops the wait. What
 * ends it: the `first` work ending (a share's link out). `beat` is called every `pace.beatMs` while it waits: a share
 * on JJ's line takes 20 minutes, and an archive held behind it said nothing for all of them, which read as still
 * (jobs.ts `still`, 15 min) though it was only waiting its turn (Nov 21).
 */
async function lineFree(signal?: AbortSignal, beat: () => void = () => {}): Promise<void> {
  while (waitedOn > 0 && signal?.aborted !== true) {
    const woken = await new Promise<boolean>((resolve) => {
      const done = (woke: boolean) => {
        lineWaiters.delete(wake);
        signal?.removeEventListener("abort", wake);
        clearTimeout(timer);
        resolve(woke);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), pace.beatMs);
      unref(timer);
      lineWaiters.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
    if (!woken) beat();
  }
}

// ---------------------------------------------------------------------------
// The line's pace (Nov 21, JJ: an 8 Mbit/s uplink). Eight parts went at once
// whatever the line; on his they filled it, and a full line out chokes every
// download on the same line too (their acknowledgements queue behind the
// upload), so an import's footage and a cold play's reads crawled while a share
// or an export's cloud copy went up, and he saw imports and playback freeze.
// Now how many parts go follows the line out's own measured speed, by a rule of
// scale (a faster line is never worse off, only a slower one gentler):
// - `partsFor`: one part for each 4 Mbit/s of the line, one at the least and
//   eight at the most, as today;
// - an upload nobody waits on (`behind`) goes with half as many, one at the least;
// - while something on this Mac downloads for a person (a play, footage someone
//   waits on, a page's read from the cloud, an import bringing footage in:
//   `forPerson`), a `behind` upload sends one part at a time at half the line's
//   speed, which leaves the other half to the download; it carries on at its
//   own count by itself once that ends (looked at again each part and each
//   `pollMs`). It never waits for it: it only goes slower.

/**
 * A part's share of the line. At 4 Mbit/s a 16 MiB part is up in ~34 s, well inside the minute a part was cut at
 * (Nov 7); a line that gives every part at least that is one more parts can't fill, so it keeps all eight. Parts
 * beyond what fills the line add no speed: they only make each part slower and the line's queue longer, which is
 * what every download on it waits in. What it means on a line:
 * - JJ's 8 Mbit/s: 2 parts (a part ~34 s), 1 for an upload nobody waits on;
 * - a 40 Mbit/s line: 8 (a part ~27 s), 4 behind;
 * - a 300 Mbit/s line: 8 (a part ~4 s), 4 behind;
 * - not measured yet (the first ~13 s of the first upload since Edit started): 8, 4 behind, as before.
 */
export const PART_SHARE_BPS = 4_000_000;

/** How many parts go at once on a line out of `bps` bits a second (null: not measured), for an upload someone waits on or (`behind`) nobody does. */
export function partsFor(bps: number | null, behind = false): number {
  const waited = bps === null || !(bps > 0) ? FILE_PARALLEL : Math.min(FILE_PARALLEL, Math.max(1, Math.floor(bps / PART_SHARE_BPS)));
  return behind ? halved(waited) : waited;
}

const halved = (parts: number): number => Math.max(1, Math.floor(parts / 2));

/** How fast a `behind` upload goes while a person's download runs (bits a second): half the line, or half JJ's when it isn't measured yet. */
export function givenWayBps(bps: number | null): number {
  return Math.max(256_000, (bps === null || !(bps > 0) ? 8_000_000 : bps) / 2);
}

/** What tests change: the meter's windows, how often a held part looks again, and what downloads for a person. */
export const pace = {
  /** A window's first stretch isn't counted: each connection's buffer fills at memory speed, not the line's. */
  warmMs: 3_000,
  /** A window counts at least this long and this many bytes, parts in flight all through it. */
  spanMs: 10_000,
  spanBytes: 4 * MIB,
  /** A count measured this long ago is forgotten (a line shown not to be full at more parts is believed this long). */
  forgetMs: 30 * 60_000,
  /** How often an upload waiting for a slot looks again at its count (a play stopped: it carries on within this). */
  pollMs: 1_000,
  /** How often an upload waiting its turn says it's still there (its progress again: its job row's beat). */
  beatMs: 20_000,
  /** A real wait (tests make `timing.sleep` instant; a pace can't be). */
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  /** What downloads for a person on this Mac now, in words, or null (`forPerson`). */
  forPerson: (): string | null => forPerson(),
};

/** Import rows that bring footage down while they run (jobs.ts): a Drive link, a Writer case, an edit's missing footage. */
const IMPORTS: readonly jobs.Kind[] = ["footage", "case", "media"];
let personSeen: { at: number; what: string | null } | null = null;

/**
 * What downloads for a person on this Mac now, or null: a play (shown, or held on its spinner for its footage), footage
 * someone waits on to open (footage_ready.ts), a page's read that had to go to the cloud in the last 5 s
 * (cloud_blocks.ts `viewerBusy`), or an import bringing footage in (its row running in jobs.json). Looked at at most
 * once a second: the job table is a file.
 */
function forPerson(): string | null {
  const now = performance.now();
  if (personSeen !== null && now - personSeen.at < 1_000) return personSeen.what;
  let what: string | null = null;
  if (playing.isPlaying()) what = "a play";
  else if (playing.linkHeld()) what = "footage someone waits on";
  else if (cloudBlocks.viewerBusy()) what = "a read the page waits on";
  else {
    // The journals are kept in `<home>/uploads` (serve.ts), so their parent is the home whose job table this is.
    const home = journals === null ? null : parent(journals);
    if (home !== null && home !== "") {
      try {
        const row = jobs.list(home).find((job) => job.state === "running" && IMPORTS.includes(job.kind));
        if (row !== undefined) what = `an import (${row.key})`;
      } catch (error) {
        if (isBug(error)) throw error;
      }
    }
  }
  personSeen = { at: now, what };
  return what;
}

/** The line out as measured: its speed (bits a second, null until measured), its recent windows, and a count shown not to fill it. */
const line = {
  bps: null as number | null,
  windows: [] as { parts: number; bps: number; at: number }[],
  floor: { parts: 1, until: 0 },
  /** What the log last said, so it says only changes. */
  said: "",
  gaveWay: null as string | null,
};

/** The line out's speed as measured here (bits a second), or null before any upload measured it. */
export function lineBps(): number | null {
  return line.bps;
}

/** How many parts an upload sends at once now (`behind`: one nobody waits on), for the log and the tests. */
export function partsAtOnce(behind = false): number {
  return partsNow(behind);
}

/** Forgets what was measured (tests), or sets the line's speed as if measured (`bps`). */
export function resetPace(bps: number | null = null): void {
  line.bps = bps;
  line.windows = [];
  line.floor = { parts: 1, until: 0 };
  line.said = "";
  line.gaveWay = null;
  meter = null;
  requestsOut = 0;
  emptyAt = 0;
  pacedNext = 0;
  personSeen = null;
}

/** What a person's download asks of a `behind` upload now: the words for it, or null; said in the log as it begins and ends. */
function givingWay(): string | null {
  const what = pace.forPerson();
  if (what !== line.gaveWay) {
    line.gaveWay = what;
    if (what !== null) diag.info("cloud", `uploads nobody waits for give way to ${what}: one part at a time, at ${(givenWayBps(line.bps) / 1e6).toFixed(1)} Mbit/s`);
    else diag.info("cloud", `nothing downloads for a person now: uploads nobody waits for carry on at ${partsNow(true)} part${partsNow(true) === 1 ? "" : "s"} at once`);
  }
  return what;
}

/** `partsNow`, looked at again (a person's download begun or ended), within `most`. */
function partsAllowed(behind: boolean, most: number): number {
  if (behind) givingWay();
  return Math.min(most, partsNow(behind));
}

/** How many parts an upload sends at once now: `partsFor` the measured line (never fewer than a count shown not to fill it), one for `behind` while a person's download runs. */
function partsNow(behind: boolean): number {
  const floor = line.floor.until > performance.now() ? line.floor.parts : 1;
  const waited = Math.max(floor, partsFor(line.bps));
  if (!behind) return waited;
  return line.gaveWay !== null ? 1 : halved(waited);
}

/** Waits until fewer than `most()` of `inFlight` go: one finishing, or the count looked at again every `pace.pollMs` (a play stopped). */
async function slot(inFlight: Set<Promise<void>>, most: () => number): Promise<void> {
  while (inFlight.size >= Math.max(1, most())) await Promise.race([...inFlight, pace.sleep(pace.pollMs)]);
}

// The meter: the bytes every upload's requests take, over windows of `spanMs` with requests in flight. A request's
// body is pulled as its connection sends it (put: a MiB at a time; Bun's fetch takes the next only as the socket
// drains, measured here Nov 21), so once the connections' buffers have filled (`warmMs`), what is pulled is what the
// line carries. How many parts went is the window's average in flight, by time (a part ending and the next one
// asking the relay for its URL dips it for a moment). The clock starts again after a second with nothing in flight
// (the time between uploads isn't a slow line), and a paced request's bytes are never counted (`givingWay`: their
// speed is ours, not the line's).
let requestsOut = 0;
/** When the last request in flight ended (0: one is in flight, or none yet). */
let emptyAt = 0;
let meter: { opened: number; from: number | null; bytes: number; partMs: number; at: number } | null = null;

/** Counts the time since the meter last moved at the requests in flight through it. */
function advance(now: number): void {
  if (meter === null) return;
  if (meter.from !== null) meter.partMs += requestsOut * (now - meter.at);
  meter.at = now;
}

function sendStarted(): void {
  const now = performance.now();
  if (meter !== null && emptyAt > 0 && now - emptyAt > 1_000) meter = null;
  advance(now);
  requestsOut += 1;
  emptyAt = 0;
  meter ??= { opened: now, from: null, bytes: 0, partMs: 0, at: now };
}

function sendEnded(): void {
  advance(performance.now());
  requestsOut = Math.max(0, requestsOut - 1);
  if (requestsOut === 0) emptyAt = performance.now();
}

function pulled(bytes: number, paced: boolean): void {
  if (paced) {
    meter = null;
    return;
  }
  const now = performance.now();
  if (meter === null) {
    meter = { opened: now, from: null, bytes: 0, partMs: 0, at: now };
    return;
  }
  advance(now);
  if (meter.from === null) {
    if (now - meter.opened < pace.warmMs) return;
    meter.from = now;
    return;
  }
  meter.bytes += bytes;
  const ms = now - meter.from;
  if (ms < pace.spanMs || meter.bytes < pace.spanBytes) return;
  measured(meter.partMs / ms, (meter.bytes * 8 * 1000) / ms);
  meter = { opened: meter.opened, from: now, bytes: 0, partMs: 0, at: now };
}

/**
 * A window's speed (`bps`) with `parts` in flight on average. Clearly fewer parts (under 70% as many) going clearly
 * slower (under 70%) than a window before means the line wasn't full at the more: each connection was what held it,
 * not the line (R2's pace per connection, as on Sphe's Mac on Nov 7). That count is then kept for `forgetMs`, the
 * line's speed staying as the more measured it, so a line like that is never stepped down below today's eight and
 * made slower. A full line goes about as fast with fewer, and is stepped down.
 */
function measured(parts: number, bps: number): void {
  const now = performance.now();
  line.windows = line.windows.filter((seen) => now - seen.at < pace.forgetMs);
  let fuller: { parts: number; bps: number } | null = null;
  for (const seen of line.windows) {
    if (parts < 0.7 * seen.parts && bps < 0.7 * seen.bps && (fuller === null || seen.parts > fuller.parts)) fuller = seen;
  }
  line.windows = [...line.windows.slice(-31), { parts, bps, at: now }];
  if (fuller !== null) {
    const kept = Math.min(FILE_PARALLEL, Math.max(1, Math.round(fuller.parts)));
    line.floor = { parts: Math.max(kept, line.floor.until > now ? line.floor.parts : 1), until: now + pace.forgetMs };
    line.bps = Math.max(line.bps ?? 0, fuller.bps);
  } else {
    line.bps = bps;
  }
  const said = `${partsNow(false)}/${partsNow(true)}`;
  if (said !== line.said) {
    line.said = said;
    const going = parts.toFixed(1);
    diag.info("cloud", `the line out measures ${(bps / 1e6).toFixed(1)} Mbit/s with ${going} parts going: uploads send ${partsNow(false)} at once, ${partsNow(true)} for one nobody waits for${fuller === null ? "" : ` (fewer went slower: the line isn't full at ${Math.round(fuller.parts)})`}`);
  }
}

/** A paced request's turn: every paced byte is spaced out at `bitsPerSecond`, all paced requests together. */
let pacedNext = 0;
async function pacedTurn(bytes: number, bitsPerSecond: number): Promise<void> {
  const now = performance.now();
  const at = Math.max(now, pacedNext);
  pacedNext = at + ((bytes * 8) / bitsPerSecond) * 1000;
  if (at > now) await pace.sleep(at - now);
}

/** A paced request's step: small, so each burst into the line is short (64 KiB is ~65 ms of JJ's line). */
const PACED_CHUNK = 64 * 1024;

/**
 * Uploads the file at `path` to `key`: one PUT under a part, else multipart, as many parts at once as the line takes
 * (`partsFor`). `signal` stops it (a share the person cancelled). `behind`: nobody waits for it, so it gives the line
 * to what someone does (`first`), goes with half the parts, and gives way to a person's download (`givingWay`).
 */
export async function uploadFile(path: string, key: string, progress: Report = () => {}, signal?: AbortSignal, behind = false): Promise<void> {
  checkUploadKey(key);
  if (signal?.aborted) throw new Error("the share was cancelled");
  await diag.timeOnAsync("cloud", "cloud: upload file", `${path} → ${key}`, async () => {
    let handle: fs.promises.FileHandle;
    let stat: fs.Stats;
    try {
      handle = await fs.promises.open(path, "r");
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    const fd = handle.fd;
    try {
      stat = await handle.stat();
    } catch (error) {
      await handle.close().catch(() => {});
      throw new Error(ioMessage(error));
    }
    try {
      const size = stat.size;
      const journal = size >= timing.resumableFrom ? journalPath(key) : null;
      if (journal !== null) {
        await resumable(fd, journal, { key, size, mtimeMs: stat.mtimeMs, part: partSize(timing.filePart, size) }, progress, signal, behind);
        const now = fs.statSync(path);
        if (now.size !== size || now.mtimeMs !== stat.mtimeMs) throw new TransferMismatch({ message: `${path} changed while uploading` });
        return;
      }
      const sent = await upload(fileSource(handle), key, size, partSize(timing.filePart, size), FILE_PARALLEL, progress, signal, behind);
      if (sent !== size) throw new TransferMismatch({ message: `${path} changed while uploading (${size} bytes, sent ${sent})` });
    } finally {
      await handle.close().catch(() => {});
    }
  });
}

/**
 * `uploadFile`, kept at through a network that comes and goes (a share's
 * review copy, Nov 16 audit: each part had 4 tries over ~14 s, then the
 * share failed for good): a temporary failure is tried again after 15 s,
 * 30 s, 60 s, then every 2 minutes, for `timing.keptAtMs` of waits in all,
 * each try carrying on from the parts already up (the journal). Anything
 * else, or a cancel, is said at once.
 */
export async function uploadFileKeptAt(path: string, key: string, progress: Report = () => {}, signal?: AbortSignal): Promise<void> {
  let waited = 0;
  for (let tries = 1; ; tries++) {
    try {
      await uploadFile(path, key, progress, signal);
      return;
    } catch (error) {
      const wait = Math.min(120_000, 15_000 * 2 ** (tries - 1));
      if (signal?.aborted || isBug(error) || diag.messageOf(error).includes("was cancelled") || !service.isTemporary(error) || waited + wait > timing.keptAtMs) throw error;
      diag.warn("cloud", `uploading ${key} failed (${diag.messageOf(error)}); trying again in ${Math.round(wait / 1000)} s, from the parts already up`);
      waited += wait;
      // A cancel isn't kept waiting for the next try.
      await Promise.race([timing.sleep(wait), new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      if (signal?.aborted) throw new Error("the share was cancelled");
    }
  }
}

// ---------------------------------------------------------------------------
// Resumable uploads: a big file's finished parts are kept in a journal, so
// after a restart only the rest go up (the 10-hour trial, Nov 4: a 58 GB
// original took 3 h to go up and began again from nothing after every
// restart). R2 keeps an upload's parts until it's completed, or for 7 days.

let journals: string | null = null;

/** Where resumable uploads keep their journals (the server's home); null (tests, the CLI): a big upload that stops begins again. Those older than R2 keeps an upload are let go. */
export function keepUploadJournalsIn(dir: string | null): void {
  journals = dir;
  if (dir === null) return;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > 7 * 86_400_000) fs.rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}

/** An upload under way: which file it is, R2's upload id, and the parts R2 holds (their ETags). */
interface Journal {
  key: string;
  size: number;
  mtimeMs: number;
  part: number;
  uploadId: string;
  parts: Record<string, string>;
}

function journalPath(key: string): string | null {
  return journals === null ? null : join(journals, `${new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 32)}.json`);
}

function readJournal(file: string): Journal | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
    return typeof value.uploadId === "string" && typeof value.parts === "object" && value.parts !== null ? value : null;
  } catch {
    return null;
  }
}

/** The resumable uploads under way or stopped on this Mac: their key, size and how much of it is up. */
export function uploadJournals(): { key: string; size: number; up: number; parts: number }[] {
  if (journals === null) return [];
  let names: string[];
  try {
    names = fs.readdirSync(journals);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const saved = readJournal(join(journals!, name));
    if (saved === null) return [];
    const done = Object.keys(saved.parts).length;
    return [{ key: saved.key, size: saved.size, up: Math.min(saved.size, done * saved.part), parts: done }];
  });
}

/**
 * Originals not in R2 yet whose upload from here is on its way (going now, waiting its turn, or put off), by key, with
 * the projects waiting for each to land and what each calls it. A local-first import names its original's key in the
 * project from its answer, before a byte is up (local_first.ts), so whatever reads R2 for it (RunPod: remover_cloud.ts
 * `keyOf`) finds nothing until it lands. Kept by whatever sends originals up (cloud_media `uploadLater` and the job
 * table at a start, Script mode's copies: writer/streamed.ts); each `whenUp` is told once one lands, with who waits.
 */
const notUpYet = new Map<string, Map<string, string>>();
export const whenUp: ((key: string, waiting: string[]) => void)[] = [];
/** Whether `key`'s original is still on its way up from here. */
export const notUp = (key: string): boolean => notUpYet.has(key);
/** `key`'s original is on its way up (or will be, at its next try). */
export function goingUp(key: string): void {
  if (!notUpYet.has(key)) notUpYet.set(key, new Map());
}
/** Project `project` waits for `key`'s original (`name`) to land, when it's still on its way; whether it is. */
export function waitFor(key: string, project: string, name: string): boolean {
  const waiting = notUpYet.get(key);
  waiting?.set(project, name);
  return waiting !== undefined;
}
/** `project` waits for nothing to land (a Stop): an export of it no longer waits on uploads. */
export function stopWaiting(project: string): void {
  for (const waiting of notUpYet.values()) waiting.delete(project);
}
/** `project` waits only for the originals `still` says it needs. */
export function keepWaiting(project: string, still: (key: string) => boolean): void {
  for (const [key, waiting] of notUpYet) if (!still(key)) waiting.delete(project);
}
/** What `project` waits for to land: each original's name. */
export function waitedFor(project: string): string[] {
  return [...notUpYet.values()].flatMap((waiting) => (waiting.has(project) ? [waiting.get(project)!] : []));
}
/** `key`'s original landed (`up`), or will never go from here (its file gone): no longer on its way. */
export function upEnded(key: string, up: boolean): void {
  const waiting = notUpYet.get(key);
  if (waiting === undefined) return;
  notUpYet.delete(key);
  if (up) for (const tell of whenUp) tell(key, [...waiting.keys()]);
}

/** Lets go of a resumable upload of `key` begun here (the object got there another way): its parts in R2 and its journal. */
export function forgetUpload(key: string): void {
  const file = journalPath(key);
  if (file === null) return;
  const saved = readJournal(file);
  if (saved !== null) abortUpload(saved.key, saved.uploadId);
  fs.rmSync(file, { force: true });
}

function abortUpload(key: string, uploadId: string): void {
  void relayJson(r2(key, "multipart/abort"), { key, uploadId }).catch((error: unknown) => diag.warn("cloud", `couldn't abort the upload of ${key}: ${diag.messageOf(error)}`));
}

/**
 * Uploads open file `fd` (`file`: its key, size, time and part size) to its
 * key, picking up the upload `journal` holds when it's this file's. One that
 * fails is kept to resume on the next try, unless it was cancelled; one R2
 * no longer has is begun again, once.
 */
async function resumable(fd: number, journal: string, file: Omit<Journal, "uploadId" | "parts">, report: Report, signal?: AbortSignal, behind = false): Promise<void> {
  let saved = readJournal(journal);
  if (saved !== null && (saved.key !== file.key || saved.size !== file.size || saved.mtimeMs !== file.mtimeMs || saved.part !== file.part)) {
    abortUpload(saved.key, saved.uploadId);
    saved = null;
  }
  for (;;) {
    const resumed = saved !== null;
    let state: Journal;
    if (saved !== null) {
      state = saved;
      diag.info("cloud", `resuming the upload of ${file.key}: ${Object.keys(state.parts).length} of ${Math.ceil(file.size / file.part)} parts are up`);
    } else {
      const created = await relayJson(r2(file.key, "multipart/create"), { key: file.key, contentType: contentType(file.key) });
      if (typeof created.uploadId !== "string") throw lacking("the relay gave no upload id");
      state = { ...file, uploadId: created.uploadId, parts: {} };
      fs.mkdirSync(parent(journal)!, { recursive: true });
      writeAtomic(journal, JSON.stringify(state));
    }
    try {
      await sendParts(fd, journal, state, report, signal, behind);
      fs.rmSync(journal, { force: true });
      return;
    } catch (error) {
      if (error instanceof TransferMismatch) {
        abortUpload(state.key, state.uploadId);
        fs.rmSync(journal, { force: true });
        throw error;
      }
      // A Cancel keeps the parts already up and their journal: the next share of the same file carries on from them
      // (Nov 22: a cancelled share's next one sent it all again). One of another file, or none within R2's 7 days, lets
      // them go (`keepUploadJournalsIn`, and the mismatch above).
      if (signal?.aborted) throw error;
      // A refusal of one picked up (R2 let it go): begun again; anything temporary stays kept for the next try.
      if (resumed && !service.isTemporary(error)) {
        diag.warn("cloud", `the upload of ${file.key} couldn't be picked up (${diag.messageOf(error)}); beginning it again`);
        fs.rmSync(journal, { force: true });
        saved = null;
        continue;
      }
      throw error;
    }
  }
}

/**
 * Sends the parts R2 doesn't hold yet, as many at once as the line takes now (`partsAllowed`, looked at again before
 * each part), each noted in the journal as it's up; then completes the upload.
 */
async function sendParts(fd: number, journal: string, state: Journal, report: Report, signal?: AbortSignal, behind = false): Promise<void> {
  const count = Math.max(1, Math.ceil(state.size / state.part));
  if (count > MAX_PARTS) throw new Error(`${state.key} needs more than ${MAX_PARTS} parts`);
  const lengthOf = (n: number) => Math.min(state.part, state.size - (n - 1) * state.part);
  const progress = new Progress(state.size, report);
  const missing: number[] = [];
  let up = 0;
  for (let n = 1; n <= count; n++) {
    if (state.parts[n] !== undefined) up += lengthOf(n);
    else missing.push(n);
  }
  if (up > 0) progress.add(up);
  let failure: unknown = null;
  const inFlight = new Set<Promise<void>>();
  for (const n of missing) {
    if (behind) await lineFree(signal, () => progress.again());
    if (signal?.aborted) {
      failure ??= new Error("the share was cancelled");
      break;
    }
    await slot(inFlight, () => partsAllowed(behind, FILE_PARALLEL));
    if (failure !== null) break;
    const data = Buffer.allocUnsafe(lengthOf(n));
    try {
      for (let got = 0; got < data.length; ) {
        const read = await new Promise<number>((resolve, reject) => fs.read(fd, data, got, data.length - got, (n - 1) * state.part + got, (error, bytes) => (error ? reject(error) : resolve(bytes))));
        if (read === 0) throw new TransferMismatch({ message: `${state.key}'s file ended before ${state.size} bytes` });
        got += read;
      }
    } catch (error) {
      failure ??= error;
      break;
    }
    const job: Promise<void> = putPart(state.key, state.uploadId, n, data, progress, signal, behind)
      .then((etag) => {
        state.parts[n] = etag;
        writeAtomic(journal, JSON.stringify(state));
      })
      .catch((error: unknown) => {
        failure ??= error;
      })
      .finally(() => inFlight.delete(job));
    inFlight.add(job);
  }
  await Promise.all(inFlight);
  if (failure !== null) throw failure;
  const parts = Object.entries(state.parts)
    .map(([n, etag]) => ({ partNumber: Number(n), etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
  const done = await relayJson(r2(state.key, "multipart/complete"), { key: state.key, uploadId: state.uploadId, parts });
  const stored = asU64(done.size);
  if (stored !== null && stored !== state.size) throw new TransferMismatch({ message: `${state.key} came out ${stored} bytes in the cloud, not ${state.size}` });
}

/**
 * Uploads everything `source` gives to `key`, without a temp file: parts of
 * 32 MiB, two in flight (≤ 96 MiB in memory); one PUT if it all fits in the
 * first part. `sizeHint` is the expected size (for progress and part size; 0
 * total when unknown). Returns the bytes uploaded.
 */
export function uploadStream(source: Source, key: string, sizeHint: number | null, progress: Report = () => {}): Promise<number> {
  checkKey(key);
  return diag.timeOnAsync("cloud", "cloud: upload stream", key, () =>
    upload(source, key, sizeHint, partSize(timing.streamPart, sizeHint), STREAM_PARALLEL, progress),
  );
}

/** `base`, or bigger (whole MiB) when the size would need over 10,000 parts. */
export function partSize(base: number, size: number | null): number {
  const needed = Math.ceil(Math.ceil((size ?? 0) / MAX_PARTS) / MIB) * MIB;
  return Math.max(base, needed);
}

/**
 * Progress over parts in flight: never goes backwards (a retried part's bytes
 * count again only once they pass what was already reported).
 */
export class Progress {
  private sent = 0;
  private reported = 0;

  constructor(
    readonly total: number,
    private readonly report: Report,
  ) {}

  add(bytes: number): void {
    this.sent += bytes;
    if (this.reported < this.sent) {
      this.reported = this.sent;
      this.report(this.sent, this.total);
    }
  }

  takeBack(bytes: number): void {
    this.sent -= bytes;
  }

  /** What was last said, said again: an upload waiting its turn is still there (its job row beats by its progress). */
  again(): void {
    this.report(this.reported, this.total);
  }
}

/** Reads up to `size` bytes (fewer only at the end of the source). */
export async function readPart(source: Source, size: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < size) {
      const chunk = await source.read(size - length);
      if (chunk === null) break;
      if (chunk.length === 0) continue;
      chunks.push(chunk);
      length += chunk.length;
    }
  } catch (error) {
    if (isBug(error)) throw error;
    throw new Error(`reading the upload: ${diag.messageOf(error)}`);
  }
  if (chunks.length === 1) return Uint8Array.from(chunks[0]!);
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** mime_guess's `first_or_octet_stream` for the extensions Edit stores. */
const CONTENT_TYPES: Record<string, string> = {
  "3gp": "video/3gpp",
  aac: "audio/aac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  avi: "video/x-msvideo",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  caf: "audio/x-caf",
  flac: "audio/flac",
  gif: "image/gif",
  heic: "image/heic",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m2ts: "video/vnd.dlna.mpeg-tts",
  m4a: "audio/m4a",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  mts: "video/vnd.dlna.mpeg-tts",
  mxf: "application/mxf",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "video/vnd.dlna.mpeg-tts",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  wma: "audio/x-ms-wma",
};

export function contentType(key: string): string {
  const ext = extension(key)?.toLowerCase();
  return (ext === undefined ? undefined : CONTENT_TYPES[ext]) ?? "application/octet-stream";
}

async function upload(
  source: Source,
  key: string,
  total: number | null,
  part: number,
  parallel: number,
  report: Report,
  signal?: AbortSignal,
  behind = false,
): Promise<number> {
  if (signal?.aborted) throw new Error("the share was cancelled");
  const progress = new Progress(total ?? 0, report);
  const kind = contentType(key);
  const first = await readPart(source, part);
  if (behind) await lineFree(signal, () => progress.again());
  if (first.length < part) {
    // It all fits in one request.
    await retry(`upload of ${key}`, async () => {
      const answer = key.startsWith("writer/") ? await relayJson(r2(key, "url"), { key, method: "PUT" }) : { url: await presign(key, "PUT") };
      if (typeof answer.url !== "string") throw lacking("the relay gave no URL");
      await put(answer.url, first, kind, progress, signal, behind);
    });
    const size = first.length;
    report(size, total ?? size);
    return size;
  }
  if (signal?.aborted) throw new Error("the share was cancelled");
  const created = await relayJson(r2(key, "multipart/create"), { key, contentType: kind });
  if (typeof created.uploadId !== "string") throw lacking("the relay gave no upload id");
  const uploadId = created.uploadId;
  try {
    const size = await multipart(source, key, uploadId, first, part, parallel, progress, signal, behind);
    report(size, total ?? size);
    return size;
  } catch (error) {
    try {
      await relayJson(r2(key, "multipart/abort"), { key, uploadId });
    } catch (abort) {
      diag.warn("cloud", `couldn't abort the upload of ${key}: ${diag.messageOf(abort)}`);
    }
    throw error;
  }
}

/**
 * Sends the parts (the first already read), at most `parallel` at once and no
 * more than the line takes now (`partsAllowed`), and completes the upload; the
 * total size. A part is read only once a slot is free for it, so at most
 * `parallel` parts are in flight plus the one read.
 */
async function multipart(
  source: Source,
  key: string,
  uploadId: string,
  first: Uint8Array,
  part: number,
  parallel: number,
  progress: Progress,
  signal?: AbortSignal,
  behind = false,
): Promise<number> {
  let failed = false;
  let error: unknown = null;
  const fail = (why: unknown) => {
    failed = true;
    error ??= why;
  };
  const etags: [number, string][] = [];
  const inFlight = new Set<Promise<void>>();
  let size = 0;
  let number = 1;
  let data = first;
  for (;;) {
    if (behind) await lineFree(signal, () => progress.again());
    if (signal?.aborted) {
      fail(new Error("the share was cancelled"));
      break;
    }
    const length = data.length;
    size += length;
    await slot(inFlight, () => partsAllowed(behind, Math.max(parallel, 1)));
    if (!failed) {
      const sending = number;
      const bytes = data;
      const job: Promise<void> = putPart(key, uploadId, sending, bytes, progress, signal, behind)
        .then((etag) => {
          etags.push([sending, etag]);
        }, fail)
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    }
    if (length < part || failed) break;
    let next: Uint8Array;
    try {
      next = await readPart(source, part);
    } catch (why) {
      fail(why);
      break;
    }
    if (next.length === 0) break;
    data = next;
    number += 1;
    if (number > MAX_PARTS) {
      fail(new Error(`${key} needs more than ${MAX_PARTS} parts`));
      break;
    }
  }
  await Promise.all(inFlight);
  if (error !== null) throw error;
  etags.sort((a, b) => a[0] - b[0]);
  const parts = etags.map(([partNumber, etag]) => ({ partNumber, etag }));
  const done = await relayJson(r2(key, "multipart/complete"), { key, uploadId, parts });
  const stored = asU64(done.size);
  if (stored !== null && stored !== size) throw new TransferMismatch({ message: `${key} came out ${stored} bytes in the cloud, not ${size}` });
  return size;
}

/** One part, retried with a fresh URL; its ETag. `behind`: paced while a person's download runs (`put`). */
function putPart(key: string, uploadId: string, number: number, data: Uint8Array, progress: Progress, signal?: AbortSignal, behind = false): Promise<string> {
  return retry(`part ${number} of ${key}`, async () => {
    const answer = await relayJson(r2(key, "multipart/urls"), { key, uploadId, parts: [number] });
    const urls = answer.urls as Record<string, unknown> | undefined;
    const url = urls !== undefined && urls !== null && typeof urls === "object" ? urls[String(number)] : undefined;
    if (typeof url !== "string") throw lacking("the relay gave no part URL");
    const etag = await put(url, data, null, progress, signal, behind);
    if (etag === null) throw new service.AnswerInvalid({ service: "R2", message: "R2 gave no ETag for the part" });
    return etag;
  });
}

/**
 * Runs `attempt` up to ATTEMPTS times, waiting 2, 4, 8 s between, but asks
 * again only after a temporary failure (effect/service.ts `kindOf`: R2 or
 * the relay unreachable, a stall, a 5xx or 429, a connection closed early).
 * A refusal (a 403, a 400), an answer missing what it should hold, or a bug
 * is said at once: the old loop asked again after anything but a bug, so a
 * refused upload took four tries and 14 s to say so. The waits go through
 * `timing.sleep`, which tests make instant.
 */
export function retry<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  let tries = 0;
  const once = Effect.tryPromise({ try: () => ((tries += 1), attempt()), catch: (error) => error as Error });
  return runPromise(
    once.pipe(
      Effect.retry(
        Schedule.recurs(ATTEMPTS - 1).pipe(
          Schedule.setInputType<Error>(),
          Schedule.while(({ input }) => !isBug(input) && !diag.messageOf(input).includes("was cancelled") && service.isTemporary(input)),
          Schedule.tap(({ input }) =>
            Effect.logWarning(`${what} failed (try ${tries}): ${diag.messageOf(input)}`).pipe(Effect.andThen(Effect.promise(() => timing.sleep((1 << tries) * 1000)))),
          ),
        ),
      ),
      inArea("cloud"),
    ),
  );
}

/** R2 couldn't be reached, or a transfer stalled (said as a timeout). */
function unreached(message: string, stalled: boolean): service.ServiceUnreachable | service.ServiceTimedOut {
  return stalled ? new service.ServiceTimedOut({ service: "R2", afterMs: timing.stallMs, message }) : new service.ServiceUnreachable({ service: "R2", message });
}

/** The relay's answer lacked what it always holds. */
const lacking = (message: string) => new service.AnswerInvalid({ service: "Edit's relay", message });

/** A file changed under an upload, or R2 stored a different size: uploading it again can fix it. */
export class TransferMismatch extends Schema.TaggedError<TransferMismatch>()("TransferMismatch", { message: Schema.String }) {}

service.kinds({ TransferMismatch: "temporary" });

/**
 * Gives up on a transfer that moves less than 1 KB/s for a minute (curl's
 * --speed-limit 1024 --speed-time 60): `moved` counts bytes, `signal` aborts.
 */
export class Stall {
  private readonly controller = new AbortController();
  private moved_ = 0;
  private timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  private connect: ReturnType<typeof setTimeout> | null = null;
  reason: string | null = null;

  constructor(connectMs: number | null = null) {
    const window = timing.stallMs;
    this.timer = setInterval(() => {
      if (this.moved_ < STALL_BYTES_PER_SECOND * (window / 1000)) {
        this.abort(`Operation too slow. Less than ${STALL_BYTES_PER_SECOND} bytes/sec transferred the last ${window / 1000} seconds`);
      }
      this.moved_ = 0;
    }, window);
    unref(this.timer);
    if (connectMs !== null) {
      this.connect = setTimeout(() => this.abort(`Connection timed out after ${connectMs} milliseconds`), connectMs);
      unref(this.connect);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The answer has started: the connect timeout no longer applies. */
  connected(): void {
    if (this.connect !== null) clearTimeout(this.connect);
    this.connect = null;
  }

  moved(bytes: number): void {
    this.moved_ += bytes;
  }

  /**
   * Everything is handed over and `waiting` bytes of it may not have got there yet: nothing more moves that this
   * side can see until the answer, so a minute of nothing isn't a stall. Given up on only once those bytes would
   * have gone slower than STALL_BYTES_PER_SECOND all along (a minute more for the answer): through a proxy that
   * took a whole part at once, a 2 Mbit/s line's 16 MiB part takes over a minute, and was ended as "too slow"
   * (the MacBook Air, Nov 22: a 53 MB share failed after 8 minutes).
   */
  handedOver(waiting: number): void {
    if (this.reason !== null) return;
    clearInterval(this.timer);
    const ms = timing.stallMs + (waiting / STALL_BYTES_PER_SECOND) * 1000;
    this.timer = setTimeout(() => this.abort(`Operation too slow. Less than ${STALL_BYTES_PER_SECOND} bytes/sec transferred the last ${Math.round(ms / 1000)} seconds`), ms);
    unref(this.timer);
  }

  private abort(reason: string): void {
    this.reason ??= reason;
    this.controller.abort(new Error(reason));
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.timer);
    if (this.connect !== null) clearTimeout(this.connect);
  }

  /** Why the transfer failed: the stall's reason when it gave up, else `error`'s message. */
  why(error: unknown): string {
    return this.reason ?? diag.messageOf(error);
  }
}

function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * PUTs `data` to a presigned URL with an exact Content-Length (S3 wants it,
 * never chunked), a MiB at a time as the request takes it (the line's meter);
 * the ETag R2 answered with. Its progress is what has surely got there: what
 * was handed over less what the connection may still hold (`HANDED_AHEAD`),
 * the rest once R2 answers; through a proxy (`timing.proxied`), which takes
 * the whole body at once, nothing until the answer. `behind`: while a person's
 * download runs, its bytes go at `givenWayBps`, in small steps.
 */
async function put(url: string, data: Uint8Array, kind: string | null, progress: Progress, signal?: AbortSignal, behind = false): Promise<string | null> {
  if (signal?.aborted) throw new Error("the share was cancelled");
  let written = 0;
  const buffered = timing.proxied(url);
  const ahead = buffered ? data.length : HANDED_AHEAD;
  let counted = 0;
  let pacedAny = false;
  const count = (upTo: number) => {
    const now = Math.min(data.length, Math.max(counted, upTo));
    if (now > counted) progress.add(now - counted);
    counted = now;
  };
  const stall = new Stall();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (signal?.aborted) throw new Error("the share was cancelled");
        if (written >= data.length) {
          controller.close();
          return;
        }
        const paced = behind && givingWay() !== null;
        const end = Math.min(written + (paced ? Math.min(PACED_CHUNK, timing.putChunk) : timing.putChunk), data.length);
        if (paced) await pacedTurn(end - written, givenWayBps(line.bps));
        if (signal?.aborted) throw new Error("the share was cancelled");
        const chunk = data.subarray(written, end);
        controller.enqueue(chunk);
        written = end;
        stall.moved(chunk.length);
        count(written - ahead);
        // Through a proxy the body goes at memory speed, not the line's: it's metered as it gets there (below).
        pacedAny ||= paced;
        if (!buffered) pulled(chunk.length, paced);
        if (written >= data.length) stall.handedOver(Math.min(data.length, ahead));
      },
    },
    { highWaterMark: 0 },
  );
  const headers: Record<string, string> = { "content-length": String(data.length) };
  if (kind !== null) headers["content-type"] = kind;
  const stop = signal === undefined ? stall.signal : AbortSignal.any([stall.signal, signal]);
  sendStarted();
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: "PUT", body, headers, signal: stop, duplex: "half" } as RequestInit);
    } catch (error) {
      if (signal?.aborted || diag.messageOf(error).includes("was cancelled")) throw new Error("the share was cancelled");
      const said = `could not reach R2: ${diag.scrub(stall.why(error))}`;
      // A part that stalled on a slow line isn't R2 gone: only one that never got through counts (outages.ts).
      if (stall.reason === null) outages.failed("r2", said);
      throw unreached(said, stall.reason !== null);
    }
    outages.answered("r2");
    const text = await response.text().catch(() => "");
    if (response.status !== 200) {
      throw new service.ServiceRefused({ service: "R2", status: response.status, retryAfterMs: service.retryAfterOf(response.headers), message: `R2 refused the upload (${response.status}): ${r2Message(text)}` });
    }
    count(data.length);
    if (buffered) pulled(data.length, pacedAny);
    const etag = (response.headers.get("etag") ?? "").trim();
    return etag === "" ? null : etag;
  } catch (error) {
    progress.takeBack(counted);
    throw error;
  } finally {
    sendEnded();
    stall.stop();
  }
}

/** The `<Message>` of an S3 error body, else its start. */
export function r2Message(body: string): string {
  const between = (tag: string): string | null => {
    const open = `<${tag}>`;
    const start = body.indexOf(open);
    if (start < 0) return null;
    const rest = body.slice(start + open.length);
    const end = rest.indexOf(`</${tag}>`);
    return end < 0 ? null : rest.slice(0, end);
  };
  const code = between("Code");
  const message = between("Message");
  if (code !== null && message !== null) return `${code}: ${message}`;
  return takeChars(body.trim(), 300);
}

// ---------------------------------------------------------------------------
// Downloads

/**
 * Downloads `key` to `dest`, through `dest.partial` (a later call carries on
 * from it while the object is unchanged: `dest.partial.etag` says which
 * version it holds). `progress(received, total)`.
 */
/** Whether `key` is in the cloud: a lookup that may well find nothing (a shared transcript nobody made yet), never a failure. */
export async function has(key: string): Promise<boolean> {
  checkKey(key);
  return (await head(key)) !== null;
}

const NOT_THERE = " isn't in the cloud";
/** Whether `error` is `download` saying the object was looked for and isn't there: the same on every try, never a failure that passes. */
export const notThere = (error: unknown): boolean => error instanceof Error && error.message.endsWith(NOT_THERE);

export function download(key: string, dest: string, progress: Report = () => {}, signal?: AbortSignal): Promise<void> {
  checkKey(key);
  if (signal?.aborted) return Promise.reject(new Error("download was cancelled"));
  return diag.timeOnAsync("cloud", "cloud: download", key, async () => {
    const object = await head(key, signal);
    if (signal?.aborted) throw new Error("download was cancelled");
    if (object === null) throw new Error(`${key}${NOT_THERE}`);
    const dir = parent(dest);
    try {
      if (dir !== null && dir !== "") fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    const partial = partialPath(dest);
    const version = `${partial}.etag`;
    const etag = object.etag ?? "";
    let held: string | null = null;
    try {
      held = fs.readFileSync(version, "utf8");
    } catch {
      held = null;
    }
    try {
      if (held !== etag) {
        // Bytes of another version (or of unknown origin): start over.
        fs.rmSync(partial, { force: true });
        fs.writeFileSync(version, etag);
      }
      // An empty body writes no file.
      if (object.size === 0) fs.writeFileSync(partial, "");
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    await retry(`download of ${key}`, () => fetchRest(key, object, partial, progress, signal));
    if (signal?.aborted) throw new Error("download was cancelled");
    const got = sizeOf(partial);
    if (got !== object.size) {
      fs.rmSync(partial, { force: true });
      throw new TransferMismatch({ message: `${key}: got ${got} bytes of ${object.size}` });
    }
    try {
      fs.renameSync(partial, dest);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    fs.rmSync(version, { force: true });
    progress(object.size, object.size);
  });
}

export function partialPath(dest: string): string {
  return `${dest}.partial`;
}

function sizeOf(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function exists(path: string): boolean {
  try {
    fs.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * An ETag without its weak mark: R2 gzips a small JSON on the way (an
 * analysis file) and answers `W/"…"` for the same object, which read as
 * "changed while downloading" on every try, so no machine ever fetched
 * another's transcripts and paid to transcribe them again.
 */
export function strongEtag(etag: string): string {
  const trimmed = etag.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

/** One try at getting the rest of `object` into `partial`. */
async function fetchRest(key: string, object: Head, partial: string, progress: Report, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("download was cancelled");
  let have = sizeOf(partial);
  if (have > object.size) {
    fs.rmSync(partial, { force: true });
    have = 0;
  }
  if (have === object.size && exists(partial)) return;
  const url = await presign(key, "GET", 3600, false, signal);
  if (signal?.aborted) throw new Error("download was cancelled");
  const headers: Record<string, string> = {};
  if (have > 0) {
    headers.range = `bytes=${have}-`;
    // S3 sends the whole (changed) object instead; R2 ignores If-Range, so
    // the ETag it answers with is checked below too.
    if (object.etag !== null) headers["if-range"] = object.etag;
  }
  const stall = new Stall(timing.connectMs);
  const stop = signal === undefined ? stall.signal : AbortSignal.any([stall.signal, signal]);
  try {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: stop });
    } catch (error) {
      if (signal?.aborted) throw new Error("download was cancelled");
      const said = `downloading ${key} (000): ${diag.scrub(stall.why(error))}`;
      outages.failed("r2", said);
      throw unreached(said, stall.reason !== null);
    }
    outages.answered("r2");
    stall.connected();
    const code = String(response.status);
    const etag = (response.headers.get("etag") ?? "").trim();
    if (object.etag !== null && etag !== "" && strongEtag(etag) !== strongEtag(object.etag)) {
      await response.body?.cancel().catch(() => {});
      fs.rmSync(partial, { force: true });
      throw new TransferMismatch({ message: `${key} changed while downloading; download it again` });
    }
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => {});
      // 416: nothing past what we have; start again from nothing, on the next try.
      if (code === "416") {
        fs.rmSync(partial, { force: true });
        throw new TransferMismatch({ message: `downloading ${key} (416): The requested range was past the object; starting again` });
      }
      throw new service.ServiceRefused({ service: "R2", status: response.status, retryAfterMs: service.retryAfterOf(response.headers), message: `downloading ${key} (${code}): The requested URL returned error: ${code}` });
    }
    if (have > 0 && response.status !== 206) {
      // The server ignored the range: start again from nothing.
      await response.body?.cancel().catch(() => {});
      fs.rmSync(partial, { force: true });
      // Started again from nothing on the next try (the partial file is gone).
      throw new TransferMismatch({ message: `downloading ${key} (${code}): HTTP server doesn't seem to support byte ranges. Cannot resume.` });
    }
    const fd = fs.openSync(partial, have > 0 ? "a" : "w");
    let reported = 0;
    try {
      if (response.body !== null) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (signal?.aborted) throw new Error("download was cancelled");
          fs.writeSync(fd, chunk);
          stall.moved(chunk.length);
          const now = performance.now();
          if (now - reported >= 250) {
            reported = now;
            progress(sizeOf(partial), object.size);
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new Error("download was cancelled");
      if (isBug(error)) throw error;
      throw unreached(`downloading ${key} (${code}): ${diag.scrub(stall.why(error))}`, stall.reason !== null);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    stall.stop();
  }
}

// ---------------------------------------------------------------------------
// Convex

export type ConvexKind = "unreachable" | "relay" | "function";

/**
 * A failure's words as a person reads them (Sphe, Nov 15: "remove the convex
 * prefix"): without the relay's "Convex: ", Convex's request id, "Server
 * Error", "Uncaught Error:" and the stack under it.
 */
export function readable(said: string): string {
  const words = said
    .replace(/^Convex:\s*/u, "")
    .replace(/^\[Request ID: [^\]]*\]\s*/u, "")
    .replace(/^Server Error\s*/u, "")
    .replace(/^Uncaught (?:Convex)?Error:\s*/u, "")
    .split(/\n\s+at /u)[0]!
    .trim();
  // Nothing but Convex's own words (prod hides a function's message as "[Request ID: …] Server Error"): said plainly,
  // the raw text kept in `said` for the log.
  return words === "" ? "Edit's cloud had a problem. Try again in a moment." : words;
}

/**
 * Why a Convex call failed: the relay couldn't be reached (offline), the
 * relay refused it (a bad token, a bad request), or the function threw; then
 * `code` is its `errorData.code` (Edit's functions use `conflict`, `locked`,
 * `missing_body` and `invalid`) and `data` the whole `errorData`. Its
 * message is what Rust's Display said.
 */
export class ConvexFailure extends Error {
  /** Its tag, for `kindOf` (effect/service.ts). */
  readonly _tag = "ConvexFailure";
  constructor(
    readonly kind: ConvexKind,
    /** The function's own message (unprefixed); the relay's text otherwise. */
    readonly said: string,
    readonly code: string | null = null,
    readonly data: unknown = null,
    /** The relay's status, when it refused. */
    readonly status: number | null = null,
    /** The relay is pausing the database while it moves: offline for minutes, not asked again by the call. */
    readonly paused = false,
  ) {
    super(readable(said));
  }

  static unreachable(message: string, paused = false): ConvexFailure {
    return new ConvexFailure("unreachable", message, null, null, null, paused);
  }

  static relay(message: string, status: number | null = null): ConvexFailure {
    return new ConvexFailure("relay", message, null, null, status);
  }

  static function(message: string, code: string | null, data: unknown): ConvexFailure {
    return new ConvexFailure("function", message, code, data);
  }
}

/**
 * Calls a Convex function in Edit's `edit` module through the relay (which
 * adds the service token). `kind` is "query", "mutation" or "action"; `path`
 * like "edit:getProject"; the function's value, or its error.
 */
export function convex(kind: string, path: string, args: unknown): Promise<unknown> {
  return convexCall(kind, path, args, kind === "query" ? convexWaits.querySeconds : convexWaits.otherSeconds);
}

/**
 * How long one call to the cloud's records waits for its answer (seconds). A query is a small answer (a record, a
 * page of notes: well under a second at JJ's 8 Mbit/s) and is tried three times: at 120 s each, a relay that hung
 * instead of refusing held the work behind `getRecord` for six minutes (Nov 22). A mutation or an action is tried
 * once and may do real work (a publish with its 512 KB of details, a long action), so it keeps its two minutes.
 */
export const convexWaits = { querySeconds: 30, otherSeconds: 120 };

// ── Convex as an Effect (since Nov 1) ──
//
// A call's failures are `ConvexFailure`s, as before, now with kinds
// (effect/service.ts): the relay unreachable or slow is temporary, a
// conflict or a lock someone holds is the sync's to settle ("later"), any
// other refusal or function error is permanent. A query, which changes
// nothing, is asked again after a temporary failure; a mutation is not (its
// answer may have been lost after it landed: the sync loops look before they
// save again, 8f67a6cf).

service.kinds({
  ConvexFailure: (error) => {
    const failure = error as ConvexFailure;
    if (failure.kind === "unreachable") return failure.paused ? "later" : "temporary";
    if (failure.kind === "relay") return failure.status === null ? "permanent" : service.kindOfStatus(failure.status);
    return failure.code === "conflict" || failure.code === "locked" ? "later" : "permanent";
  },
});

/** Convex's answer: a value, or its error with `errorData` (a ConvexError's code and message). */
export const ConvexAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ status: Schema.Literal("error"), errorMessage: Schema.optional(Schema.String), errorData: Schema.optional(Schema.Unknown) }),
]);

/** How long a query waits before it's asked again after a temporary failure (tests make it short). */
export const convexRetry = { baseMs: 500 };

/** A relay failure as the Convex call says it. */
function asConvexFailure(error: service.ServiceError): ConvexFailure {
  switch (error._tag) {
    case "ServiceUnreachable":
    case "ServiceTimedOut":
      return ConvexFailure.unreachable(error.message);
    case "ServiceRefused":
      // The relay pausing the database while it moves reads as offline: work waits here and is saved after.
      return error.message.includes("cloud is moving to its new home") ? ConvexFailure.unreachable(error.message, true) : ConvexFailure.relay(error.message, error.status);
    case "AnswerInvalid":
      return ConvexFailure.relay(error.message);
  }
}

/** One Convex function call through the relay; `timeoutMs` for each request. */
export const convexEffect = Effect.fn("cloud.convex")(function* (kind: string, path: string, args: unknown, timeoutMs: number) {
  if (kind !== "query" && kind !== "mutation" && kind !== "action") return yield* Effect.fail(ConvexFailure.relay(`not a Convex function kind: ${kind}`));
  if (typeof args !== "object" || args === null || Array.isArray(args)) return yield* Effect.fail(ConvexFailure.relay("Convex args must be an object"));
  const asked = relay.askJson("POST", "/v1/cloud/convex", { kind, path, args }, "cloud storage", timeoutMs).pipe(Effect.mapError(asConvexFailure));
  const answer = yield* kind === "query" ? asked.pipe(Effect.retry(service.temporaryRetries(`Convex ${path}`, { times: 2, base: convexRetry.baseMs }))) : asked;
  return yield* Effect.try({ try: () => convexValue(answer), catch: (error) => (error instanceof ConvexFailure ? error : ConvexFailure.relay(diag.messageOf(error))) });
});

/** [`convex`] with the failure kept apart ([`ConvexFailure`]) and a timeout in seconds. */
export async function convexCall(kind: string, path: string, args: unknown, timeout: number): Promise<unknown> {
  return diag.timeOnAsync("cloud", `cloud: convex ${kind}`, path, () => runPromise(convexEffect(kind, path, args, timeout * 1000).pipe(inArea("cloud"))));
}

/** A Convex query (see [`convex`]). */
export function query(path: string, args: unknown): Promise<unknown> {
  return convex("query", path, args);
}

/** A Convex mutation (see [`convex`]). */
export function mutation(path: string, args: unknown): Promise<unknown> {
  return convex("mutation", path, args);
}

/**
 * Convex's `{status: "success", value}` / `{status: "error", errorMessage,
 * errorData}`. A ConvexError's own message (`errorData.message`) is
 * preferred: `errorMessage` wraps it in Convex's "Uncaught ConvexError: …".
 */
export function convexValue(answer: unknown): unknown {
  const read = Schema.decodeUnknownOption(ConvexAnswer)(answer);
  if (Option.isNone(read)) throw ConvexFailure.relay(`unexpected answer from Convex: ${takeChars(stableStringify(answer), 300)}`);
  const said = read.value;
  if (said.status === "success") return said.value === undefined ? null : said.value;
  const data = said.errorData === undefined ? null : said.errorData;
  const dataFields = Predicate.isObject(data) && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const message = (dataFields !== null && typeof dataFields.message === "string" ? dataFields.message : null) ?? said.errorMessage ?? "unknown error";
  const code = dataFields !== null && typeof dataFields.code === "string" ? dataFields.code : null;
  throw ConvexFailure.function(message, code, data);
}

// ---------------------------------------------------------------------------
// `edit cloud …`

export const CLI_HELP = `edit cloud — Edit's cloud storage and Convex, through the relay

  edit cloud url KEY [GET|PUT|HEAD] [--expires SECS]   a presigned URL
  edit cloud put FILE KEY                              upload a file
  edit cloud put - KEY [--size BYTES]                  upload stdin (no temp file)
  edit cloud get KEY FILE                              download (resumes)
  edit cloud head KEY | ls PREFIX | rm KEY…
  edit cloud convex query|mutation|action edit:NAME ['{"args":1}']

Keys start with edit/. Needs EDIT_RELAY_TOKEN (the relay's CLOUD_TOKEN);
EDIT_RELAY_URL picks another relay (e.g. http://localhost:8787 for wrangler dev).
`;

/** Where `runCli` writes (the terminal, or a test's buffers). */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  stdin(): ReadableStream<Uint8Array>;
}

const TERMINAL: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  stdin: () => Bun.stdin.stream(),
};

/**
 * `edit cloud …`: try the cloud by hand (EDIT_RELAY_URL / EDIT_RELAY_TOKEN).
 * A failure is thrown with the text `edit: <text>` shows (the CLI exits 2).
 */
export async function runCli(args: string[], io: CliIo = TERMINAL): Promise<void> {
  const arg = (index: number) => args[index];
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const need = (index: number, what: string): string => {
    const value = arg(index);
    if (value === undefined) throw new Error(`give ${what}\n\n${CLI_HELP}`);
    return value;
  };
  if (!enabled()) throw new Error("`edit cloud` needs EDIT_RELAY_TOKEN (a local relay's token): against the team's relay, use the running Edit (it's signed in)");
  const show: Report = (sent, total) => {
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
    io.err(total > 0 ? `\r${mb(sent)} / ${mb(total)} MB   ` : `\r${mb(sent)} MB   `);
  };
  let result: unknown;
  switch (arg(0)) {
    case "url": {
      const given = arg(2) ?? "GET";
      if (given !== "GET" && given !== "PUT" && given !== "HEAD") throw new Error(`unknown method ${given}`);
      const seconds = flag("--expires");
      let expires: number | null = null;
      if (seconds !== undefined) {
        if (!/^\+?\d+$/.test(seconds)) throw new Error("--expires takes seconds");
        expires = Number(seconds);
      }
      result = await presign(need(1, "a key"), given, expires);
      break;
    }
    case "put": {
      const source = need(1, "a file (or - for stdin)");
      const key = need(2, "a key");
      const given = flag("--size");
      let size: number | null = null;
      if (given !== undefined) {
        if (!/^\+?\d+$/.test(given)) throw new Error("--size takes bytes");
        size = Number(given);
      }
      try {
        if (source === "-") {
          const sent = await uploadStream(streamSource(io.stdin()), key, size, show);
          result = { key, size: sent };
        } else {
          await uploadFile(source, key, show);
          result = { key };
        }
      } finally {
        io.err("\n");
      }
      break;
    }
    case "get": {
      const key = need(1, "a key");
      const dest = need(2, "a destination file");
      try {
        await download(key, dest, show);
      } finally {
        io.err("\n");
      }
      result = { saved: dest };
      break;
    }
    case "head": {
      const found = await head(need(1, "a key"));
      result = found === null ? null : { size: found.size, etag: found.etag, contentType: found.contentType };
      break;
    }
    case "ls":
      result = (await list(need(1, "a prefix"))).map((object) => ({ key: object.key, size: object.size }));
      break;
    case "rm": {
      const keys = args.slice(1);
      await remove(keys);
      result = { deleted: keys.length };
      break;
    }
    case "convex": {
      const kind = need(1, "query, mutation or action");
      const path = need(2, "a path (edit:…)");
      let given: unknown = {};
      const text = arg(3);
      if (text !== undefined) {
        try {
          given = JSON.parse(text);
        } catch (error) {
          throw new Error(`args: ${diag.messageOf(error)}`);
        }
      }
      result = kind === "query" ? await query(path, given) : kind === "mutation" ? await mutation(path, given) : await convex(kind, path, given);
      break;
    }
    default:
      io.out(CLI_HELP);
      return;
  }
  io.out(`${stableStringify(result, 2)}\n`);
}

/**
 * `edit cloud backfill <project id> [--port N]`: asks
 * the running Edit to put every media of a cloud project that isn't in the
 * cloud yet there now, and prints its answer. The exit code: 0, or 1 when
 * Edit refused; not reaching Edit is thrown (`edit: …`, exit 2).
 */
export async function backfillCli(id: string | undefined, port: number, io: Pick<CliIo, "out" | "err"> = TERMINAL): Promise<number> {
  if (id === undefined || !validId(id)) throw new Error("usage: edit cloud backfill <project id> [--port N]");
  io.err(`backfilling ${id} through the Edit on port ${port} (big files take a while)…\n`);
  let response: Response;
  let body: string;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/projects/${id}/cloud/backfill`, { method: "POST" });
    body = await response.text();
  } catch (error) {
    throw new Error(`couldn't reach Edit on port ${port} (is it running?): ${diag.messageOf(error)}`);
  }
  io.out(`${body}\n`);
  return response.status >= 200 && response.status < 300 ? 0 : 1;
}
