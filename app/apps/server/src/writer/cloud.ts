// Every script in the cloud, as Writer kept them (and still does, beside
// Edit): each script's body (script.json) and files (the preview, transcript
// pieces, sources, research) on R2 under `writer/scripts/<id>/`, and an index
// in Convex (Repack's deployment, the `writer` module) naming each script's
// current rev and files, reached through Edit's relay.
//
// Saves land on disk as always. A loop pushes what changed a few seconds
// later (the changed files, then a new body, then a commit naming the rev it
// began from) and pulls what other Macs pushed. Footage goes up beside the
// loop, never inside it, and is named once it's there ("Footage, beside the
// rounds" below). A file the cloud already
// holds and this Mac doesn't (the preview, once it was left to the cloud) is
// named again: leaving it out of the commit deletes it for every Mac. A
// commit another Mac overtook is refused; then the cloud's is taken and this
// Mac's version kept in the script's versions ("Not synced"), never an
// overwrite (a "(conflicted copy)" script of its own until Nov 15). Since Nov 8
// a script has the same cloud lock as an edit (locks.ts, sync_core.ts): held
// by presence, a save to one another computer holds refused, so two Macs no
// longer both change one; a push goes only with the lock (or where the cloud
// keeps none). A commit is written down before it goes (the ledger's
// `attempts`), so one whose answer was lost is known as this Mac's own and
// never counted as overtaken. Scripts importing or being written wait until they're
// done (and hold the lock meanwhile). Deleting a script deletes it
// everywhere. Footage isn't downloaded: a script another Mac made plays its
// preview from the cloud.

import * as fs from "node:fs";

import { Effect, Option, Predicate, Schema } from "effect";
import { createHash } from "node:crypto";

import type { Script } from "@edit/types/writer";

import * as diag from "../diag.ts";
import { idle, inArea, runtime } from "../effect/runtime.ts";
import * as service from "../effect/service.ts";
import * as editCloud from "../cloud.ts";
import { ConvexAnswer, readable } from "../cloud.ts";
import * as cloudBlocks from "../cloud_blocks.ts";
import * as archive from "./archive.ts";
import * as storage from "./storage.ts";
import { writeAtomic } from "../files.ts";
import { breather, note as noteThread } from "../thread.ts";
import { isFile, join, parent } from "../paths.ts";
import * as machine from "../machine.ts";
import { displayName } from "../sync_core.ts";
import * as locks from "./locks.ts";
import * as relay from "../relay.ts";
import { importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import { changeShelf, hooks as lessonHooks, merge, readShelf, type Shelf } from "./lessons.ts";
import * as store from "./store.ts";
import * as versions from "./versions.ts";
import { ANOTHER_MACHINE, THIS_MACHINE } from "../machine.ts";

const TICK_MS = 3_000;
const PULL_EVERY_MS = 30_000;
/** A save is pushed once the script has been still this long. */
const SETTLE_MS = 2_000;
let settleMs = SETTLE_MS;
/** How long a save waits to be pushed (tests, which wait it out between saves); null puts it back. */
export const settleForTests = (ms: number | null): void => {
  settleMs = ms ?? SETTLE_MS;
};
const PREFIX = "writer/scripts";
/** The least a slow line moves (bytes a millisecond, 400 kbit/s): what a script.json is given to go up or come down. */
const SLOW_BYTES_PER_MS = 50;
const BACKOFF_FIRST = 30_000;
const BACKOFF_MAX = 3_600_000;
const LESSONS_KEY = "writer/lessons.json";
/** Whether a script body has its cut written: any cut-in (an unbuilt script is its recordings whole). */
function builtIn(body: Uint8Array): boolean {
  try {
    const script = JSON.parse(new TextDecoder().decode(body)) as { clips?: { kind?: string }[] };
    return (script.clips ?? []).some((clip) => clip.kind === "cut-in");
  } catch {
    return false;
  }
}

/** Whether a script body is an import that never finished here (still processing, or failed before any recording came in): nothing of this Mac's to keep. */
function unfinished(body: Uint8Array): boolean {
  try {
    const script = JSON.parse(new TextDecoder().decode(body)) as { status?: string; clips?: unknown[] };
    return script.status === "processing" || (script.status === "error" && (script.clips ?? []).length === 0);
  } catch {
    return false;
  }
}

/** The library row's shape: 1 added `kind`, 2 `runFailed` (Oct 30). A script whose cloud row is older is pushed again. */
const SUMMARY_VERSION = 2;

/** What the page shows: off, syncing, synced, offline or a problem. */
export interface Status {
  enabled: boolean;
  state: string;
  pending: number;
  transfer: { script: string; name: string; up: boolean; done: number; total: number } | null;
  lastSync: number | null;
  error: string | null;
  scripts: number;
}

const status: Status = { enabled: false, state: "off", pending: 0, transfer: null, lastSync: null, error: null, scripts: 0 };
/** A file going up now (a round's, or the footage lane's, which runs beside the rounds): shown while no round is bringing one down. */
let sending: Status["transfer"] = null;
export const statusNow = (): Status => ({ ...status, transfer: status.transfer ?? sending });
/** The scripts the cloud last listed as not deleted (null until it has listed them since Edit started). */
let live: ReadonlySet<string> | null = null;
export const liveInCloud = (): ReadonlySet<string> | null => live;
export const liveForTests = (ids: ReadonlySet<string> | null): void => {
  live = ids;
};

let pullNow = true;
/** Scripts whose push the cloud refused: when to try again, how long it waited last, and what it said. */
const backoff = new Map<string, { until: number; wait: number }>();
const refusals = new Map<string, string>();

/** Why the cloud refused this script's last save, while it still does. */
export const refused = (id: string): string | null => refusals.get(id) ?? null;

/** Syncs on the next tick rather than waiting for the next pull. */
export function syncSoon(): void {
  pullNow = true;
}

/** Every script waiting after a refusal is tried again on the next tick (remote support's unstick): how many were. */
export function tryAllAgain(): number {
  const waiting = backoff.size;
  backoff.clear();
  syncSoon();
  return waiting;
}

/** Tries this script again on the next tick, however long it was waiting after a refusal. */
export function tryAgain(id: string): void {
  backoff.delete(id);
  syncSoon();
}

class Problem extends Error {
  constructor(
    message: string,
    /** The connection, not the cloud: waits quietly and tries again. */
    readonly offline = false,
    /** The cloud there but failing for a moment (a 5xx, 429): this script waits a little and goes again, never kept as a refusal. */
    readonly temporary = offline,
  ) {
    super(message);
  }
}

/** A file a revision names that isn't in the cloud (deleted by a push that lost, before each push had its own keys). */
class Gone extends Problem {}

// ---- What this Mac knows of each script in the cloud ----

interface Kept {
  key: string;
  size: number;
  /** This Mac's modified time, in ms: a file whose size and time match is unchanged. */
  mtime: number;
}

interface Known {
  rev: number;
  /** The script.json this rev was, by its hash. */
  body: string;
  files: Record<string, Kept>;
  summary?: number;
}

/** A commit sent and not yet answered, written down before it went (`ownCommit`). */
interface Attempt {
  base: number;
  bodyKey: string;
  /** What the ledger keeps once it's known to have landed. */
  known: Known;
}

/**
 * `copied`: the rev a script's overtaken version was kept for (as a copy, before Nov 15), until that rev has come down. Read, no longer written.
 * `attempts`: commits sent whose answer hasn't come (`ownCommit`).
 */
type Ledger = { scripts: Record<string, Known>; copied?: Record<string, number>; attempts?: Record<string, Attempt> };

const ledgerPath = (data: string) => join(data, "cloud", "ledger.json");
const deletingPath = (data: string) => join(data, "cloud", "deleted.json");

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  fs.mkdirSync(parent(path) ?? ".", { recursive: true });
  writeAtomic(path, JSON.stringify(value, null, 2));
}

const loadLedger = (data: string): Ledger => readJson<Ledger>(ledgerPath(data), { scripts: {} });

/** The ledger file as it is now (inode, size, mtime in ns), or "none". */
function ledgerStamp(path: string): string {
  try {
    const stats = fs.statSync(path, { bigint: true });
    return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
  } catch {
    return "none";
  }
}

/**
 * The ledger, parsed again only when its file has changed (inode, size,
 * mtime in ns). Each lookup parsed the whole file (Nov 7, Sphe's Mac: 2.6 MB,
 * looked up per script by Home's routes), and with Edit's other state it held
 * the server 7–20 s at a time. The rounds work on this same one too (Nov 20:
 * each round read and parsed all 3.9 MB of it again, every three seconds):
 * whoever changes it saves it (`saveLedger`), and a round that throws lets it
 * go (`tick`), so what's kept here is never ahead of the file for long.
 */
let seen: { path: string; stamp: string; ledger: Ledger } | null = null;
function ledgerNow(data: string): Ledger {
  const path = ledgerPath(data);
  const stamp = ledgerStamp(path);
  if (stamp === "none") return { scripts: {} };
  if (seen !== null && seen.path === path && seen.stamp === stamp) return seen.ledger;
  const ledger = loadLedger(data);
  seen = { path, stamp, ledger };
  return ledger;
}

/** How many times the ledger's file has been written (tests: a round that changes nothing writes nothing). */
export const ledgerWrites = { count: 0 };

/** Writes the ledger, and keeps it as the one in hand: the next look doesn't parse the file it just wrote. */
function saveLedger(data: string, ledger: Ledger): void {
  const path = ledgerPath(data);
  writeJson(path, ledger);
  ledgerWrites.count++;
  seen = { path, stamp: ledgerStamp(path), ledger };
}

/** What the ledger holds of one script, as text: whether a step changed it. */
const entryOf = (ledger: Ledger, id: string): string => JSON.stringify([ledger.scripts[id] ?? null, ledger.copied?.[id] ?? null, ledger.attempts?.[id] ?? null]);

/** Footage cleared from this Mac once the cloud held it, or left there by a pull, by script: still the script's files in the cloud. */
const storagePath = (data: string) => join(data, "cloud", "storage.json");
export const purgedNames = (data: string, id: string): string[] => readJson<Record<string, string[]>>(storagePath(data), {})[id] ?? [];

export function leftInCloud(data: string, id: string, names: string[]): void {
  if (names.length === 0) return;
  const map = readJson<Record<string, string[]>>(storagePath(data), {});
  map[id] = [...new Set([...(map[id] ?? []), ...names])];
  writeJson(storagePath(data), map);
}

/** A file back on this Mac (a restore): no longer only in the cloud. */
export function forgetPurged(data: string, id: string, name: string): void {
  const map = readJson<Record<string, string[]>>(storagePath(data), {});
  if (!(map[id] ?? []).includes(name)) return;
  map[id] = map[id]!.filter((other) => other !== name);
  writeJson(storagePath(data), map);
}
const deleting = (data: string): string[] => readJson<string[]>(deletingPath(data), []);
/** Scripts deleted on this Mac whose delete hasn't reached the cloud yet: lists of the cloud's scripts leave them out (Home showed one until the next sync). */
export const beingDeleted = (data: string): Set<string> => new Set(deleting(data));

/** A script deleted on this Mac: deleted from the cloud, and so from every other Mac, by the next round. */
export function deleted(data: string, id: string): void {
  const list = deleting(data);
  if (!list.includes(id)) writeJson(deletingPath(data), [...list, id]);
  syncSoon();
}

/** The cloud's rev of this script, as this Mac last saw it; null if it never reached the cloud. */
export const revOf = (data: string, id: string): number | null => ledgerNow(data).scripts[id]?.rev ?? null;

/** Whether the cloud's copy of a script's file is this Mac's: no file here, or one whose size and time are as last synced (a new one may still be going up). */
export function sameAsHere(data: string, id: string, name: string): boolean {
  const kept = fileKey(data, id, name);
  const path = inside(store.scriptDir(data, id), name);
  if (path === null || !isFile(path)) return kept !== null;
  return kept !== null && kept.key !== "" && kept.size === fs.statSync(path).size && kept.mtime === mtime(path);
}

/** A script file's key and size in the cloud, as this Mac last synced it. */
export const fileKey = (data: string, id: string, name: string): Kept | null => ledgerNow(data).scripts[id]?.files[name] ?? null;

// ---- The relay ----

async function call(route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await relay.json<Record<string, unknown>>("POST", `/v1/cloud/writer/${route}`, body, "Script mode's cloud", 120);
  } catch (error) {
    const message = diag.messageOf(error);
    throw new Problem(readable(message), message.startsWith(relay.UNREACHABLE), service.isTemporary(error));
  }
}

/** A `writer:`, `reviews:` or `edit:` function's value; its refusal's code and data. */
export async function convex(kind: string, path: string, args: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; code: string; data: Record<string, unknown> }> {
  const read = Schema.decodeUnknownOption(ConvexAnswer)(await call("convex", { kind, path, args }));
  // Not Convex's answer at all: said, never read as an empty value.
  if (Option.isNone(read)) throw new Problem(`The cloud's answer to ${path} wasn't Convex's.`);
  const answer = read.value;
  if (answer.status === "success") return { ok: true, value: answer.value ?? null };
  const data = (Predicate.isObject(answer.errorData) ? answer.errorData : {}) as Record<string, unknown>;
  const code = typeof data.code === "string" ? data.code : "";
  // The function's own words, as a person reads them (Sphe, Nov 15).
  if (code === "") throw new Problem(readable(String(data.message ?? answer.errorMessage ?? "unknown error").split("Uncaught ConvexError: ").pop()!));
  return { ok: false, code, data };
}

/** A presigned address for `key` (good for an hour). */
export async function presign(key: string, method: "GET" | "PUT" | "HEAD"): Promise<string> {
  const answer = await call("r2/url", { key, method });
  if (typeof answer.url !== "string") throw new Problem("The cloud gave no address for a file.");
  return answer.url;
}

async function remove(keys: string[]): Promise<void> {
  for (let at = 0; at < keys.length; at += 40) await call("r2/delete", { keys: keys.slice(at, at + 40) }).catch(() => undefined);
}

/**
 * Deletes `keys` (Script mode's own, under `writer/`) and everything under
 * `prefix`: the files a deleted review link named, and any it left beside
 * them. Says how many it deleted; one the relay refused (deleting needs
 * script work) is left to Repack's cleanup, which the review's delete queued.
 */
export async function removeUnder(prefix: string, keys: string[]): Promise<number> {
  if (!prefix.startsWith("writer/") || !prefix.endsWith("/")) throw new Error(`not a prefix Script mode deletes under: ${prefix}`);
  const found = new Set(keys.filter((key) => key.startsWith("writer/")));
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const answer = await call("r2/list", cursor === undefined ? { prefix } : { prefix, cursor });
    for (const object of Array.isArray(answer.objects) ? (answer.objects as { key?: unknown }[]) : []) if (typeof object.key === "string" && object.key.startsWith(prefix)) found.add(object.key);
    cursor = typeof answer.cursor === "string" && answer.cursor !== "" ? answer.cursor : undefined;
    if (cursor === undefined) break;
  }
  let deleted = 0;
  const all = [...found];
  for (let at = 0; at < all.length; at += 40) {
    const batch = all.slice(at, at + 40);
    const answer = await call("r2/delete", { keys: batch }).catch((error: unknown) => {
      diag.info("writer", `deleting ${batch.length} review files under ${prefix}: ${diag.messageOf(error)}; Repack's cleanup deletes them`);
      return null;
    });
    if (answer !== null) deleted += batch.length;
  }
  return deleted;
}

const transferProblem = (error: unknown, name: string): Problem => new Problem(`${name} didn't get through (${diag.messageOf(error)}).`, true);

/**
 * A file as a PUT body that reports bytes as the request takes them, a MiB at
 * a time (S3 wants a Content-Length, never chunked). The handle closes when
 * the body finishes or the request drops it.
 */
function fileBody(path: string, size: number, onProgress: (done: number) => void): ReadableStream<Uint8Array> {
  const handle = fs.openSync(path, "r");
  let done = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fs.closeSync(handle);
  };
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        try {
          if (done >= size) {
            onProgress(size);
            close();
            controller.close();
            return;
          }
          const piece = Buffer.alloc(Math.min(1024 * 1024, size - done));
          const got = fs.readSync(handle, piece, 0, piece.length, done);
          if (got <= 0) {
            onProgress(size);
            close();
            controller.close();
            return;
          }
          done += got;
          onProgress(done);
          controller.enqueue(new Uint8Array(piece.buffer, piece.byteOffset, got));
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        close();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Uploads a file, its progress shown as it goes. One past cloud.ts's
 * resumable size goes up as Edit's own footage does (`editCloud.uploadFile`):
 * in parts, eight at a time, each part's link asked for just before it goes,
 * and each part kept in a journal as it's up, so a line that drops or an Edit
 * that restarts carries on from the parts already sent (JJ, Nov 18: a 2.6 GB
 * preview at 0.47 GB when his line dropped began again from nothing, 44
 * minutes on his 8 Mbit/s line). `onProgress` is told bytes as they go.
 * `behind`: nobody waits on it, so a share's upload has the line first.
 */
async function upload(script: string, name: string, path: string, key: string, onProgress?: (done: number, total: number) => void, behind = false): Promise<number> {
  const size = fs.statSync(path).size;
  const shown = (done: number) => {
    sending = { script, name, up: true, done: Math.min(done, size), total: size };
    onProgress?.(Math.min(done, size), size);
  };
  try {
    if (size < editCloud.timing.resumableFrom) {
      const answer = await fetch(await presign(key, "PUT"), { method: "PUT", body: onProgress ? fileBody(path, size, shown) : Bun.file(path), headers: { "content-length": String(size) }, signal: AbortSignal.timeout(600_000), ...(onProgress ? { duplex: "half" } : {}) } as RequestInit).catch((error: unknown) => {
        throw transferProblem(error, name);
      });
      if (!answer.ok) throw new Problem(`The cloud refused ${name} (${answer.status}).`);
    } else {
      await editCloud.uploadFile(path, key, (done) => shown(done), undefined, behind).catch((error: unknown) => {
        const temporary = service.isTemporary(error);
        throw new Problem(`${name} didn't get through (${diag.messageOf(error)}).`, temporary, temporary);
      });
    }
    shown(size);
    return size;
  } finally {
    sending = null;
  }
}

async function uploadBytes(key: string, bytes: Uint8Array | string): Promise<void> {
  // A 26-hour case is ~22 MB of words: a minute, or the time a slow line takes, whichever is longer.
  const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length;
  const answer = await fetch(await presign(key, "PUT"), { method: "PUT", body: bytes, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(Math.max(60_000, size / SLOW_BYTES_PER_MS)) }).catch((error: unknown) => {
    throw transferProblem(error, "script.json");
  });
  if (!answer.ok) throw new Problem(`The cloud refused script.json (${answer.status}).`);
}

/** What's at a key, or null when nothing is: a minute to answer, then a minute for each chunk, so a big script.json on a slow line isn't cut off whole. */
async function fetchBytes(key: string): Promise<Uint8Array | null> {
  const name = key.split("/").pop() ?? "file";
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new Error("no data for a minute")), 60_000);
    timer.unref?.();
  };
  arm();
  try {
    const answer = await fetch(await presign(key, "GET"), { signal: stall.signal }).catch((error: unknown) => {
      throw transferProblem(error, name);
    });
    if (answer.status === 404) return null;
    if (!answer.ok || answer.body === null) throw new Problem(`The cloud refused ${name} (${answer.status}).`);
    const chunks: Uint8Array[] = [];
    try {
      for await (const chunk of answer.body) {
        arm();
        chunks.push(chunk);
      }
    } catch (error) {
      throw transferProblem(error, name);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads a file beside its place, then moves it in whole. */
async function download(script: string, name: string, key: string, size: number, path: string): Promise<void> {
  // A body that stops arriving must not wedge the sync forever: 60 s
  // without a chunk aborts it (a total deadline would kill slow big files).
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new Error("no data for a minute")), 60_000);
    timer.unref?.();
  };
  arm();
  const answer = await fetch(await presign(key, "GET"), { signal: stall.signal }).catch((error: unknown) => {
    clearTimeout(timer);
    throw transferProblem(error, name);
  });
  if (answer.status === 404) {
    clearTimeout(timer);
    throw new Gone(`${name} isn't in the cloud.`);
  }
  if (!answer.ok || answer.body === null) {
    clearTimeout(timer);
    throw new Problem(`The cloud refused ${name} (${answer.status}).`);
  }
  fs.mkdirSync(parent(path) ?? ".", { recursive: true });
  const partial = `${path}.partial`;
  const out = fs.openSync(partial, "w");
  let done = 0;
  try {
    for await (const chunk of answer.body) {
      arm();
      fs.writeSync(out, chunk);
      done += chunk.length;
      status.transfer = { script, name, up: false, done, total: size };
    }
  } catch (error) {
    throw new Problem(`${name} stopped coming down (${diag.messageOf(error)}).`, true);
  } finally {
    clearTimeout(timer);
    fs.closeSync(out);
  }
  fs.renameSync(partial, path);
}

/** Puts bytes at a key Script mode may write (its own, or Edit's shared prefixes). */
export async function putBytes(key: string, bytes: Uint8Array | string, contentType = "application/json"): Promise<void> {
  const answer = await fetch(await presign(key, "PUT"), { method: "PUT", body: bytes, headers: { "content-type": contentType }, signal: AbortSignal.timeout(60_000) }).catch((error: unknown) => {
    throw transferProblem(error, key.split("/").pop() ?? "file");
  });
  if (!answer.ok) throw new Problem(`The cloud refused ${key.split("/").pop()} (${answer.status}).`);
}

/** Uploads a file to a key, its progress shown under `script` as the sync's is. `onProgress` hears bytes as they go. */
export const putFile = (script: string, key: string, path: string, onProgress?: (done: number, total: number) => void): Promise<number> => upload(script, path.split("/").pop() ?? "file", path, key, onProgress);

/** The size of what's at a key, or null when nothing is there. */
export async function head(key: string): Promise<number | null> {
  const answer = await call("r2/head", { key });
  return answer.exists === true ? Number(answer.size ?? 0) : null;
}

/** What's at a key, or null when nothing is. */
export const getBytes = (key: string): Promise<Uint8Array | null> => fetchBytes(key);

/**
 * A script's file (by its path in the folder) on this Mac, brought down from
 * the cloud first when it was cleared from here or made on another Mac.
 */
export async function fetchFile(data: string, id: string, name: string): Promise<string> {
  const path = inside(store.scriptDir(data, id), name);
  if (path === null) throw new Error(`${name} isn't a script's file.`);
  if (isFile(path)) return path;
  const kept = fileKey(data, id, name);
  if (kept === null || kept.key === "") throw new Error(`This script's ${name} isn't on ${THIS_MACHINE} or in the cloud.`);
  await download(id, name, kept.key, kept.size, path);
  // Its time as kept here now, so the next push sees it unchanged.
  const ledger = ledgerNow(data);
  const known = ledger.scripts[id]?.files[name];
  if (known !== undefined && known.mtime !== mtime(path)) {
    known.mtime = mtime(path);
    saveLedger(data, ledger);
  }
  forgetPurged(data, id, name);
  return path;
}

/** The script's preview on this Mac, brought down from the cloud first when it was cleared from here or made on another Mac. */
export const fetchPreview = (data: string, id: string): Promise<string> => fetchFile(data, id, "proxy.mp4");

/** Presigned read addresses, kept until they near their hour: a block read costs R2's round trip, not the relay's too. */
const signedReads = new Map<string, { url: string; until: number }>();

/** The address `key`'s bytes are read from, presigned once an hour. */
async function streamUrl(key: string): Promise<string> {
  const known = signedReads.get(key);
  if (known !== undefined && Date.now() < known.until) return known.url;
  const url = await presign(key, "GET");
  signedReads.set(key, { url, until: Date.now() + 50 * 60_000 });
  return url;
}

/** The address a script's preview in the cloud is read from (an hour's presign), or null when the cloud has none: FFmpeg reads the stretches it needs from it, a range at a time. */
export async function previewUrl(data: string, id: string): Promise<string | null> {
  const kept = fileKey(data, id, "proxy.mp4");
  return kept === null || kept.key === "" ? null : await streamUrl(kept.key);
}

/**
 * A script's preview that's only in the cloud (another Mac made it), played
 * from there a range at a time; null when the cloud has none. Bounded ranges
 * come from the shared block cache (cloud_blocks.ts, as Edit's previews):
 * each 2 MiB block is fetched once and the next two read ahead, so a seek is
 * a look at disk, not two round trips a block.
 */
export async function stream(request: Request, data: string, id: string, blocks?: string): Promise<Response | null> {
  const kept = fileKey(data, id, "proxy.mp4");
  if (kept === null) return null;
  const range = request.headers.get("range");
  if (blocks !== undefined) {
    const served = await cloudBlocks.serve(blocks, kept.key, range, () => streamUrl(kept.key)).catch((error: unknown) => {
      diag.warn("writer", `reading ${id.slice(0, 8)}'s preview in blocks: ${diag.messageOf(error)}`);
      return null;
    });
    if (served !== null) return served;
  }
  const answer = await fetch(await streamUrl(kept.key), { headers: range ? { range } : {} });
  const headers = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" });
  for (const name of ["content-length", "content-range", "etag"]) {
    const value = answer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(answer.body, { status: answer.status, headers });
}

// ---- The loop ----

/** Who holds a script's lock from here (the same as an edit's: cloud_projects' holder, with this data folder's id); set by `start`. */
let lockHolder = machine.name().slice(0, 120);
/** Who this Mac is, as commits name it (the name teammates see). */
const holder = (): string => displayName(lockHolder).slice(0, 120);

/**
 * The sync, one fiber for as long as Edit runs (round 3): a round every
 * TICK_MS, pulling every PULL_EVERY_MS or when asked (`syncSoon`); a round
 * never overlaps the last, and a round that throws, or a bug in one, is said
 * and the next round goes on (a loop that died silently was 81aa84cb's).
 * Offline and errors are said once each, when they change.
 */
const syncing = (data: string) =>
  Effect.gen(function* () {
    let lastPull = 0;
    for (;;) {
      yield* idle(TICK_MS);
      if (!relay.cloudEnabled()) {
        Object.assign(status, { enabled: false, state: "off", error: null, transfer: null });
        continue;
      }
      status.enabled = true;
      const pull = pullNow || Date.now() - lastPull >= PULL_EVERY_MS;
      const was = status.state;
      const ran = yield* Effect.tryPromise(() => tick(data, pull)).pipe(Effect.result);
      if (ran._tag === "Success") {
        if (was === "offline" || was === "error") yield* Effect.logInfo("the cloud: back in sync");
        Object.assign(status, { pending: ran.success, state: ran.success > 0 ? "syncing" : "synced", error: null, transfer: null, lastSync: Date.now() });
      } else {
        const cause = ran.failure.cause;
        const problem = cause instanceof Problem ? cause : new Problem(diag.messageOf(cause));
        if (status.error !== problem.message) yield* (problem.offline ? Effect.logWarning : Effect.logError)(`the cloud: ${problem.offline ? "offline" : "sync stopped"}: ${problem.message}`);
        Object.assign(status, { state: problem.offline ? "offline" : "error", error: problem.message, transfer: null });
      }
      if (pull) {
        lastPull = Date.now();
        pullNow = false;
      }
    }
  }).pipe(inArea("writer"));

/** Starts syncing in the background, for as long as Edit runs; `holderLabel` holds the scripts' locks (cloud_projects' holder). */
export function start(data: string, holderLabel?: string): void {
  lessonHooks.changed = syncSoon;
  if (holderLabel !== undefined) lockHolder = holderLabel;
  locks.start(data, busy);
  store.hooks.mayWrite = locks.mayWrite;
  runtime.runFork(syncing(data));
}

/** Who holds the scripts' locks from here. */
export const lockHolderNow = (): string => lockHolder;

/** Sets who holds the scripts' locks from here (tests). */
export function useHolderForTests(label: string): void {
  lockHolder = label;
}

/** A script Edit is working on now: importing or being written. */
const busy = (id: string): boolean => importing(id) || jobs.running(id);

const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function mtime(path: string): number {
  try {
    return Math.floor(fs.statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

/** A file's place inside a script's folder, refusing anything that would leave it. */
function inside(dir: string, name: string): string | null {
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) return null;
  return join(dir, ...parts);
}

/**
 * Every file of a script but its body, by its path inside the folder. A
 * joined case's recordings, and any original in Edit's originals
 * (`edit-shared.json`), are left out (the preview is what another Mac
 * plays), as is a build's state and a commentary's clip footage (each Mac's own).
 */
function localFiles(dir: string, script: Pick<Script, "originalPath">): Record<string, Kept> {
  const shared = new Set(readJson<{ file?: unknown }[]>(join(dir, "edit-shared.json"), []).flatMap((entry) => (typeof entry?.file === "string" ? [entry.file] : [])));
  const found: Record<string, Kept> = {};
  const stack = [dir];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (store.inTheMaking(entry.name)) continue;
      if (entry.isDirectory()) {
        // A recording's preview pieces, joined into the preview and deleted: the preview is what's kept.
        if (at === dir && entry.name === "pieces") continue;
        stack.push(path);
        continue;
      }
      const relative = path.slice(dir.length + 1);
      if (relative === "script.json" || relative === "build.json" || relative.startsWith("footage/")) continue;
      const recording = (relative.startsWith("drive/") || relative.startsWith("compilation/")) && !relative.endsWith(".json");
      if (recording && path !== script.originalPath) continue;
      // In Edit's originals now (the handoff's edit-shared.json): found there, not kept twice.
      if (shared.has(relative)) continue;
      found[relative] = { key: "", size: fs.statSync(path).size, mtime: mtime(path) };
    }
  }
  return found;
}

const sameFiles = (known: Record<string, Kept>, here: Record<string, Kept>): boolean =>
  Object.keys(known).length === Object.keys(here).length && Object.entries(here).every(([name, file]) => known[name]?.size === file.size && known[name]?.mtime === file.mtime);


/** Scripts deleted on another Mac whose version here couldn't be kept yet (`keepDeleted`): left as they are, not pushed, until it is. */
const unkeptDeletes = new Set<string>();

/**
 * A script deleted on another Mac after it changed here: the delete stands
 * (someone meant it), and this Mac's script and versions are kept in the data
 * folder's `kept/`, out of every list (a "(restored copy)" until Nov 15).
 * Thrown when it can't be: then the script isn't deleted here.
 */
function keepDeleted(data: string, id: string, dir: string): void {
  const kept = join(data, "kept", `${id}-${Date.now()}`);
  try {
    fs.mkdirSync(kept, { recursive: true });
    for (const name of ["script.json", "versions"]) {
      if (fs.existsSync(join(dir, name))) fs.cpSync(join(dir, name), join(kept, name), { recursive: true });
    }
  } catch (error) {
    // Not kept, not deleted: the delete is taken next round, the script here as it was meanwhile.
    try {
      fs.rmSync(kept, { recursive: true, force: true });
    } catch {
      // What was copied of it stays in kept/ too.
    }
    throw new Error(`deleted on ${ANOTHER_MACHINE}, but ${THIS_MACHINE}'s changes couldn't be kept first, so it isn't deleted here yet: ${diag.messageOf(error)}`);
  }
}

/** Parses a script body; null when it can't be read. */
/**
 * What a round needs to know of a script's body here, kept for as long as the file is the one it was (inode, size,
 * mtime in ns): its hash, and the few fields the rounds read. Nov 20, Sphe's Linux Edit: every round, every three
 * seconds, read, parsed and hashed every script's body to find the ones that changed, and every pull read each twice
 * and parsed it twice more: 126 scripts, 381 MB of JSON (the largest 12.9 MB), 5.3 GB read a minute and 38% of the
 * server's one thread, for good, on every Mac that has the team's scripts. Now a script that hasn't been saved since
 * the last look costs one stat.
 */
interface BodyFacts {
  stamp: string;
  hash: string;
  /** Whether it reads as JSON (one that doesn't is passed over by a round, and is neither built nor unfinished). */
  readable: boolean;
  status: string;
  updatedAt: number;
  originalPath: string;
  built: boolean;
  unfinished: boolean;
}
const bodies = new Map<string, BodyFacts>();
/** How many times a script's body was read for its facts (tests: one not saved since isn't read again). */
export const bodyReads = { count: 0 };

/** The facts of the script body at `path` as it is now; null when there's none. */
function bodyFacts(path: string): BodyFacts | null {
  const stamp = ledgerStamp(path);
  if (stamp === "none") {
    bodies.delete(path);
    return null;
  }
  const known = bodies.get(path);
  if (known !== undefined && known.stamp === stamp) return known;
  let body: Uint8Array;
  try {
    body = fs.readFileSync(path);
    bodyReads.count++;
  } catch {
    bodies.delete(path);
    return null;
  }
  const facts: BodyFacts = { stamp, hash: hash(body), readable: false, status: "", updatedAt: 0, originalPath: "", built: builtIn(body), unfinished: unfinished(body) };
  const script = parsed(body);
  if (script !== null && typeof script === "object") {
    facts.readable = true;
    facts.status = typeof script.status === "string" ? script.status : "";
    facts.updatedAt = typeof script.updatedAt === "number" ? script.updatedAt : 0;
    facts.originalPath = typeof script.originalPath === "string" ? script.originalPath : "";
  }
  // Kept only for the file it was read from: one saved while it was being read is read again next time.
  if (ledgerStamp(path) === stamp) bodies.set(path, facts);
  return facts;
}

function parsed(body: Uint8Array | null): Script | null {
  if (body === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body)) as Script;
  } catch {
    return null;
  }
}

// ---- Footage, beside the rounds ----
//
// A script's words reach the cloud, and so the other Macs, before its footage
// does (Sphe, Nov 18: JJ's 2.6 GB preview took 44 minutes or more on his
// 8 Mbit/s line, and a round sent a script's files before its body and the
// next script waited behind it). A round commits a script naming the footage
// the cloud already has: the file its last revision named, or none yet (a new
// script, a recording just added). Its new footage goes up here meanwhile, one
// file at a time, to a key kept on disk (`footage.json`) with its size and
// time, so a cut line or a restart carries on from the parts already up
// (cloud.ts's journal); once it's all there the next round commits it.
// Nothing here commits, so no revision is ever made or lost here; a key no
// commit names is deleted when its file changes, goes or is taken over.

/** A footage file on its way up: the key it goes to, the file it is (size, time in ms), and whether it's all there. */
interface Sending {
  key: string;
  size: number;
  mtime: number;
  done: boolean;
}

const footagePath = (data: string) => join(data, "cloud", "footage.json");
let footageIn: { data: string; slots: Record<string, Sending> } | null = null;

/** The footage on its way up from this data folder, by `<script id>/<name>`. */
function footageOf(data: string): Record<string, Sending> {
  if (footageIn?.data !== data) footageIn = { data, slots: readJson<Record<string, Sending>>(footagePath(data), {}) };
  return footageIn.slots;
}

const saveFootage = (data: string) => writeJson(footagePath(data), footageOf(data));

const slotOf = (id: string, name: string) => `${id}/${name}`;
const nameOf = (slot: string): [string, string] => [slot.slice(0, slot.indexOf("/")), slot.slice(slot.indexOf("/") + 1)];

/** What goes up beside the rounds rather than in one: footage, and any file big enough to hold a round up. */
const goesBeside = (name: string, size: number): boolean => storage.isFootage(name) || size >= editCloud.timing.resumableFrom;

/** Waits after a failure, by slot. */
const footageWait = new Map<string, { until: number; wait: number }>();
/** The slot going up now. */
let footageNow: string | null = null;
let footageLane: Promise<void> | null = null;

/** Footage still to go up from here: how many files. */
const footageLeft = (data: string): number => Object.values(footageOf(data)).filter((entry) => !entry.done).length;

/** Whether `key` is named by a revision this Mac committed, or one it sent whose answer hasn't come: then it's the script's, never deleted from here. */
function committed(data: string, id: string, key: string): boolean {
  const ledger = ledgerNow(data);
  const named = (files: Record<string, Kept> | undefined) => Object.values(files ?? {}).some((file) => file.key === key);
  return named(ledger.scripts[id]?.files) || named(ledger.attempts?.[id]?.known.files);
}

/** Lets go of a slot: its parts or its object in the cloud too, unless a commit names it. */
function retire(data: string, slot: string): void {
  const slots = footageOf(data);
  const entry = slots[slot];
  if (entry === undefined) return;
  delete slots[slot];
  saveFootage(data);
  footageWait.delete(slot);
  const [id] = nameOf(slot);
  if (committed(data, id, entry.key)) return;
  if (entry.done) void remove([entry.key]);
  else editCloud.forgetUpload(entry.key);
}

/**
 * A script's files as a round commits them now: its footage that changed here
 * and isn't all up yet is queued to go up beside the rounds, and named as the
 * cloud has it meanwhile (its last revision's, or not at all); footage that's
 * up is named at its key. `files` is changed in place.
 */
function footageFirst(data: string, id: string, files: Record<string, Kept>, known: Known | undefined): void {
  const slots = footageOf(data);
  let changed = false;
  const here = new Set<string>();
  for (const [name, local] of Object.entries(files)) {
    if (local.key !== "" || !goesBeside(name, local.size)) continue;
    const slot = slotOf(id, name);
    here.add(slot);
    const previous = known?.files[name];
    let entry = slots[slot];
    // Unchanged since the cloud's revision: nothing to send.
    if (previous !== undefined && previous.key !== "" && previous.size === local.size && previous.mtime === local.mtime) {
      if (entry !== undefined && slot !== footageNow) retire(data, slot);
      continue;
    }
    const same = entry !== undefined && entry.size === local.size && entry.mtime === local.mtime;
    if (entry !== undefined && !same && slot !== footageNow) {
      retire(data, slot);
      entry = undefined;
    }
    if (entry !== undefined && same && entry.done) {
      files[name] = { key: entry.key, size: local.size, mtime: local.mtime };
      continue;
    }
    if (entry === undefined) {
      slots[slot] = { key: `${PREFIX}/${id}/files/u-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}/${name}`, size: local.size, mtime: local.mtime, done: false };
      changed = true;
    }
    if (previous !== undefined && previous.key !== "") files[name] = previous;
    else delete files[name];
  }
  // A file no longer here (deleted, or replaced by a pull) has nothing to go up.
  for (const slot of Object.keys(slots)) if (slot.startsWith(`${id}/`) && !here.has(slot) && slot !== footageNow) retire(data, slot);
  if (changed) saveFootage(data);
}

/** A slot's file as it is now, or null when it's gone. */
function fileNow(data: string, slot: string): { path: string; size: number; mtime: number } | null {
  const [id, name] = nameOf(slot);
  const path = inside(store.scriptDir(data, id), name);
  if (path === null || !isFile(path)) return null;
  return { path, size: fs.statSync(path).size, mtime: mtime(path) };
}

/** Starts the footage lane when it isn't running and something is ready to go. */
function sendFootage(data: string): void {
  if (footageLane !== null) return;
  footageLane = footageRun(data).finally(() => {
    footageLane = null;
  });
}

/** The footage lane's run: each file ready to go, one at a time, until none is. */
async function footageRun(data: string): Promise<void> {
  for (;;) {
    if (!relay.cloudEnabled()) return;
    const slots = footageOf(data);
    const slot = Object.keys(slots).find((one) => !slots[one]!.done && (footageWait.get(one)?.until ?? 0) <= Date.now());
    if (slot === undefined) return;
    await footageOne(data, slot, slots[slot]!);
  }
}

/** Sends one slot's file: done, waiting after a failure, or let go when the file changed or went. */
async function footageOne(data: string, slot: string, entry: Sending): Promise<void> {
  const [id, name] = nameOf(slot);
  const file = fileNow(data, slot);
  if (file === null || file.size !== entry.size || file.mtime !== entry.mtime || !store.idOk(id) || archive.archived(data, id)) {
    retire(data, slot);
    return;
  }
  const failed = (problem: string, temporary: boolean) => {
    const first = temporary ? BACKOFF_FIRST : BACKOFF_FIRST * 4;
    const wait = Math.min(footageWait.has(slot) ? footageWait.get(slot)!.wait * 2 : first, temporary ? 600_000 : BACKOFF_MAX);
    footageWait.set(slot, { until: Date.now() + wait, wait });
    diag.warn("writer", `${jobs.named(id, "")}: ${name} didn't get to the cloud (${problem}); trying again in ${Math.round(wait / 1000)} s, from the parts already up`);
  };
  // Someone else's (another computer holds its lock): its footage waits with its words.
  const allowed = await locks.mayPush(id, lockHolder).catch(() => false);
  if (!allowed) {
    footageWait.set(slot, { until: Date.now() + BACKOFF_FIRST, wait: BACKOFF_FIRST });
    return;
  }
  footageNow = slot;
  const began = Date.now();
  try {
    await upload(id, name, file.path, entry.key, undefined, true);
  } catch (error) {
    const problem = error instanceof Problem ? error : new Problem(diag.messageOf(error));
    if (footageOf(data)[slot] === entry) failed(problem.message, problem.temporary);
    return;
  } finally {
    footageNow = null;
  }
  const after = fileNow(data, slot);
  // Let go while it went up, or changed under it: what went up isn't this file.
  if (footageOf(data)[slot] !== entry || after === null || after.size !== entry.size || after.mtime !== entry.mtime) {
    if (footageOf(data)[slot] === entry) retire(data, slot);
    else if (!committed(data, id, entry.key)) void remove([entry.key]);
    return;
  }
  entry.done = true;
  footageWait.delete(slot);
  saveFootage(data);
  diag.info("writer", `${jobs.named(id, "")}: ${name} (${Math.round(entry.size / 1e6)} MB) is in the cloud in ${Math.round((Date.now() - began) / 1000)} s; its next save names it`);
  syncSoon();
}

/** A commit landed: the footage it names is the script's now, no longer on its way. */
function footageCommitted(data: string, id: string, files: Record<string, Kept>): void {
  const slots = footageOf(data);
  let changed = false;
  for (const [name, file] of Object.entries(files)) {
    const slot = slotOf(id, name);
    if (slots[slot]?.done === true && slots[slot]!.key === file.key) {
      delete slots[slot];
      changed = true;
    }
  }
  if (changed) saveFootage(data);
}

/** The footage lane's run to its end (tests: a round queues it, this sends it). */
export async function footageForTests(data: string): Promise<void> {
  sendFootage(data);
  while (footageLane !== null) await footageLane;
}

/** Forgets the lane's waits and what it read (tests, between data folders). */
export function resetFootageForTests(): void {
  footageIn = null;
  footageWait.clear();
}

/**
 * One round: deletions, then what came from other Macs, then what changed here. Answers how many scripts still wait.
 * A round that throws lets go of the ledger in hand: what it changed and hadn't saved is dropped, as when each round
 * read the file afresh.
 */
async function tick(data: string, pull: boolean): Promise<number> {
  try {
    return await round(data, pull);
  } catch (error) {
    seen = null;
    throw error;
  }
}

async function round(data: string, pull: boolean): Promise<number> {
  noteThread(`Script mode's cloud round${pull ? " (with a pull)" : ""}`);
  const ledger = ledgerNow(data);
  const save = () => saveLedger(data, ledger);
  // The rest of Edit gets its turn between scripts: a round is hundreds of them, each a few file reads on the server's one thread.
  const breathe = breather();
  let waiting = 0;
  for (const id of deleting(data)) {
    let answer: Awaited<ReturnType<typeof convex>>;
    try {
      answer = await convex("mutation", "writer:deleteScript", { scriptId: id, holder: holder() });
    } catch (error) {
      // Offline, everything waits; refused, this delete waits and the rest of the round goes on.
      if (error instanceof Problem && error.offline) throw error;
      waiting++;
      continue;
    }
    if (!answer.ok) continue;
    const keys = (((answer.value as { keys?: unknown } | null)?.keys ?? []) as unknown[]).filter((key): key is string => typeof key === "string");
    await remove(keys);
    if (ledger.scripts[id] !== undefined) {
      delete ledger.scripts[id];
      save();
    }
    writeJson(deletingPath(data), deleting(data).filter((other) => other !== id));
  }
  const gone = deleting(data);
  if (pull) {
    const listed = await convex("query", "writer:listScripts", {});
    if (!listed.ok) throw new Problem(`The cloud refused to list scripts (${listed.code}).`);
    const rows = (Array.isArray(listed.value) ? listed.value : []) as Record<string, unknown>[];
    const listedLive = rows.filter((row) => row.deletedAt == null);
    status.scripts = listedLive.length;
    live = new Set(listedLive.map((row) => String(row.scriptId)));
    // Archived from Repack's page, or asked back: archive.ts acts on it.
    archive.keepStates(data, rows);
    for (const row of rows) {
      const id = String(row.scriptId);
      if (gone.includes(id)) continue;
      // Saved only when this row changed what the ledger holds (Nov 20, Sphe's Linux Edit: the whole ledger, 3.9 MB
      // by then, was written and synced to disk after every row of the cloud's list, changed or not, hundreds of
      // times a round, every 30 seconds: 20 to 30 seconds each minute in which Edit answered nothing, no page, no
      // play, no progress; `GET /api/health` took 27.6 s. So since Oct 29, on every Mac, worse with every script).
      const before = entryOf(ledger, id);
      try {
        await pullOne(data, ledger, row);
      } catch (error) {
        if (error instanceof Problem && error.offline) throw error;
        diag.warn("writer", `the cloud: ${String(row.title ?? row.scriptId)} didn't come down: ${diag.messageOf(error)}`);
        waiting++;
      }
      if (entryOf(ledger, id) !== before) save();
      await breathe();
    }
  }
  // What changed here, found first so the count of what's left can be shown.
  const changed: [string, string, Script, Uint8Array, Known | undefined, Record<string, Kept>][] = [];
  const ids = store.ids(data).sort();
  // Footage of a script no longer here has nothing to go up.
  const present = new Set(ids);
  for (const slot of Object.keys(footageOf(data))) if (!present.has(nameOf(slot)[0]) && slot !== footageNow) retire(data, slot);
  // What was cleared from here, read once a round (it was read and parsed again for every script).
  const cleared = readJson<Record<string, string[]>>(storagePath(data), {});
  for (const id of ids) {
    await breathe();
    const until = backoff.get(id)?.until ?? 0;
    // Worked on here: its lock is taken and kept meanwhile; pushed once done.
    if (busy(id)) locks.touch(id);
    if (busy(id) || until > Date.now() || archive.archived(data, id) || unkeptDeletes.has(id)) continue;
    const dir = store.scriptDir(data, id);
    // Its body as last read, for as long as the file is the one it was (`bodyFacts`): read again only once it's saved.
    const facts = bodyFacts(join(dir, "script.json"));
    if (facts === null || !facts.readable) continue;
    if (facts.status === "processing" || Date.now() - facts.updatedAt < settleMs) {
      waiting++;
      continue;
    }
    const known = ledger.scripts[id];
    const files = localFiles(dir, facts);
    // What this Mac's ledger already recorded as the cloud's. The row itself is
    // read again at the push: a ledger from an older Edit can be at the cloud's
    // rev and still be missing the preview (Nov 3, Predator Dad).
    carryCloudFiles(dir, files, known?.files ?? {}, new Set(cleared[id] ?? []));
    // Its words go now; footage that changed goes up beside the rounds and is named once it's there.
    footageFirst(data, id, files, known);
    if (known !== undefined && known.body === facts.hash && sameFiles(known.files, files) && (known.summary ?? 0) >= SUMMARY_VERSION) continue;
    // Changed: its body is read now, as it is (one saved again since the look is the newer, and is what goes).
    let body: Uint8Array;
    let script: Script;
    try {
      body = fs.readFileSync(join(dir, "script.json"));
      script = JSON.parse(new TextDecoder().decode(body)) as Script;
    } catch {
      continue;
    }
    if (script.status === "processing") {
      waiting++;
      continue;
    }
    changed.push([id, dir, script, body, known, files]);
  }
  let left = changed.length;
  let refusal: Problem | null = null;
  const unpushed = new Set(changed.map(([id]) => id));
  for (const [id, dir, script, body, known, files] of changed) {
    Object.assign(status, { state: "syncing", pending: left + waiting });
    try {
      // Someone else's (another computer holds the lock): left, and their version comes down.
      if (!(await locks.mayPush(id, lockHolder))) {
        waiting++;
        left--;
        continue;
      }
      const pushed = await push(data, id, dir, script, body, known, files, ledger, save);
      if (pushed === "overtaken") {
        // Another Mac saved it first: theirs comes down, then this waits a
        // little longer each time, so a newer copy that can't come down (its
        // body not in the cloud) isn't asked for every few seconds (Oct 30:
        // Predator Tutor, 167 times in 20 minutes).
        const wait = Math.min((backoff.get(id)?.wait ?? BACKOFF_FIRST / 4) * 2, BACKOFF_MAX);
        backoff.set(id, { until: Date.now() + wait, wait });
        waiting++;
        syncSoon();
      } else {
        backoff.delete(id);
        refusals.delete(id);
        ledger.scripts[id] = pushed;
        save();
        footageCommitted(data, id, pushed.files);
        unpushed.delete(id);
        locks.pushed(id);
      }
    } catch (error) {
      const problem = error instanceof Problem ? error : new Problem(diag.messageOf(error));
      if (problem.offline) throw problem;
      // The cloud failing for a moment (a 5xx, 429): this one waits its first backoff and goes again, not kept as a refusal.
      if (problem.temporary) {
        backoff.set(id, { until: Date.now() + BACKOFF_FIRST / 2, wait: BACKOFF_FIRST / 2 });
        diag.warn("writer", `${jobs.named(id, script.title)}: the cloud failed for a moment (${problem.message}); trying again soon`);
        waiting++;
        left--;
        continue;
      }
      // Refused: this one waits, longer each time, and the rest go on.
      const wait = Math.min((backoff.get(id)?.wait ?? BACKOFF_FIRST / 2) * 2, BACKOFF_MAX);
      backoff.set(id, { until: Date.now() + wait, wait });
      refusals.set(id, problem.message);
      diag.warn("writer", `${jobs.named(id, script.title)}: couldn't save to the cloud (${problem.message}); trying again in ${Math.round(wait / 1000)} s`);
      waiting++;
      refusal ??= new Problem(`${script.title} couldn't be saved to the cloud: ${problem.message}`);
    }
    left--;
  }
  if (pull) await syncLessons(data);
  // Footage still going up keeps the sync "syncing"; its lane runs beside the rounds, never inside one.
  waiting += footageLeft(data);
  sendFootage(data);
  // The locks: taken for what's open or worked on here, renewed, let go once nobody here needs them.
  // Footage on its way up is a change not pushed yet: the lock is kept until it's named.
  const coming = new Set(Object.keys(footageOf(data)).map((slot) => nameOf(slot)[0]));
  await locks.round(lockHolder, (id) => unpushed.has(id) || coming.has(id));
  if (refusal !== null) throw refusal;
  return waiting;
}

/** One round with a pull, for tests. */
export const syncOnceForTests = (data: string): Promise<number> => tick(data, true);

/** Merges the kept lessons both ways: this Mac's and the cloud's, each lesson by its id, and one forgotten anywhere gone everywhere. */
async function syncLessons(data: string): Promise<void> {
  const remote = await fetchBytes(LESSONS_KEY);
  let theirs: Shelf | null = null;
  try {
    theirs = remote === null ? null : (JSON.parse(new TextDecoder().decode(remote)) as Shelf);
  } catch {
    theirs = null;
  }
  const here = readShelf(data);
  const merged = merge(here, { lessons: theirs?.lessons ?? [], forgotten: theirs?.forgotten ?? [] });
  if (JSON.stringify(merged) !== JSON.stringify(here)) changeShelf(data, (shelf) => Object.assign(shelf, merged));
  if (theirs === null || JSON.stringify(merged) !== JSON.stringify({ lessons: theirs.lessons ?? [], forgotten: theirs.forgotten ?? [] })) {
    try {
      await uploadBytes(LESSONS_KEY, JSON.stringify(merged, null, 2));
    } catch (error) {
      // Only someone who may teach writes the shared lessons: the rest keep the merge here.
      if (!/can't|403/.test(diag.messageOf(error))) throw error;
    }
  }
}

/** A pulled body with the cloud's `createdBy` in it, when the cloud has one and the body says otherwise. */
export function withCreator(body: Uint8Array, createdBy: unknown): Uint8Array {
  if (typeof createdBy !== "object" || createdBy === null || typeof (createdBy as { sub?: unknown }).sub !== "string") return body;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return body;
  }
  const mine = value.createdBy as { sub?: unknown } | undefined;
  if (mine?.sub === (createdBy as { sub: string }).sub && JSON.stringify(mine) === JSON.stringify(createdBy)) return body;
  value.createdBy = createdBy;
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

// ── Which copy wins (in Effect since Nov 1) ──
//
// The rules a pull follows were fixed five times in three days (02c455de,
// 352e9d0a, 83e97e64, 0385252c and the body that went missing), each one a
// case nobody had thought of. They're one pure function now, `decidePull`,
// so its promises are tested over every case at once (test/writer/merge.test.ts):
// work changed here is never lost, a built script is never replaced by an
// unbuilt one, this Mac's overtaken version is kept at most once per revision
// (in the script's versions), an older or equal revision is never taken, and a
// script deleted elsewhere after it changed here is kept in the data folder.

/** What a pull knows before it acts: the cloud's row, this Mac's ledger and body, and (once fetched) the cloud's body. */
export interface PullSeen {
  /** Deleted on another Mac. */
  readonly deleted: boolean;
  /** The rev this Mac last synced, or null when it never did. */
  readonly knownRev: number | null;
  /** The cloud's rev. */
  readonly rev: number;
  /** This Mac's body, or null when there's none. `same`: it's the cloud's body; `changed`: it changed here since the last sync. */
  readonly here: { readonly same: boolean; readonly changed: boolean; readonly built: boolean; readonly unfinished: boolean } | null;
  /** The cloud's body: not fetched yet (undefined), missing from the cloud (null), or what it is. */
  readonly theirs: { readonly built: boolean } | null | undefined;
  /** The rev this Mac's overtaken version was already kept for (an older Edit's ledger). */
  readonly copiedRev: number | null;
}

export type PullDecision =
  | { readonly do: "delete"; readonly keepOurs: boolean }
  | { readonly do: "skip" }
  | { readonly do: "fetch" }
  | { readonly do: "keep-ours"; readonly why: "theirs-missing" | "ours-built" }
  | { readonly do: "fail"; readonly why: "theirs-missing" }
  | { readonly do: "take"; readonly keepOurs: boolean; readonly why: "plain" | "ours-unfinished" | "copy-kept-already" | "conflict" };

/** What a pull does with what it knows. */
export function decidePull(seen: PullSeen): PullDecision {
  if (seen.deleted) return { do: "delete", keepOurs: seen.here !== null && seen.here.changed };
  if (seen.knownRev !== null && seen.knownRev >= seen.rev) return { do: "skip" };
  if (seen.theirs === undefined) return { do: "fetch" };
  if (seen.theirs === null) return seen.here !== null ? { do: "keep-ours", why: "theirs-missing" } : { do: "fail", why: "theirs-missing" };
  const here = seen.here;
  if (here === null || here.same || !here.changed) return { do: "take", keepOurs: false, why: "plain" };
  if (here.built && !seen.theirs.built) return { do: "keep-ours", why: "ours-built" };
  if (here.unfinished) return { do: "take", keepOurs: false, why: "ours-unfinished" };
  if (seen.copiedRev === seen.rev) return { do: "take", keepOurs: false, why: "copy-kept-already" };
  return { do: "take", keepOurs: true, why: "conflict" };
}

/** How many times one round follows a script to a newer revision saved while it was coming down; after that the next round takes it. */
const CHASES = 2;

/**
 * The cloud's row of `id` as it is now, when the script was saved again since
 * `row` was listed (or deleted): null when `row` is still the newest. A save
 * removes the files only the revision before it named, so to a pull still
 * holding that revision's row its body or a file "isn't in the cloud".
 */
async function savedSince(id: string, row: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const listed = await convex("query", "writer:getScript", { scriptId: id }).catch((error: unknown) => {
    if (error instanceof Problem && error.offline) throw error;
    return null;
  });
  if (listed?.ok !== true || listed.value === null || typeof listed.value !== "object") return null;
  const now = listed.value as Record<string, unknown>;
  if (Number(now.rev ?? 0) <= Number(row.rev ?? 0) && now.deletedAt == null) return null;
  // Over the listed row: what the one-script answer doesn't say (who made it, its archive state) stays as listed.
  return { ...row, ...now, scriptId: id };
}

/** Brings one script from the cloud when it's newer than this Mac's, as `decidePull` says. */
async function pullOne(data: string, ledger: Ledger, row: Record<string, unknown>, chased = 0): Promise<void> {
  const id = String(row.scriptId ?? "");
  if (!store.idOk(id) || busy(id) || deleting(data).includes(id)) return;
  const rev = Number(row.rev ?? 0);
  const dir = store.scriptDir(data, id);
  const known = ledger.scripts[id];
  const title = String(row.title ?? "");
  const bodyPath = join(dir, "script.json");
  // This Mac's body by its facts (`bodyFacts`: a stat unless it was saved since the last look); its bytes are read
  // only once the cloud's revision is being taken (below).
  const ours = bodyFacts(bodyPath);
  const seen = (theirs: Uint8Array | null | undefined): PullSeen => ({
    deleted: row.deletedAt != null,
    knownRev: known === undefined ? null : known.rev,
    rev,
    // A folder with no body (a pull cut short) has no version here to keep (Nov 4, JJ's Mac: 12,032 copies of one).
    here: ours === null ? null : { same: theirs != null && ours.hash === hash(theirs), changed: known === undefined || known.body !== ours.hash, built: ours.built, unfinished: ours.unfinished },
    theirs: theirs === undefined ? undefined : theirs === null ? null : { built: builtIn(theirs) },
    copiedRev: ledger.copied?.[id] ?? null,
  });
  let decision = decidePull(seen(undefined));
  if (decision.do === "delete") {
    // Deleted on another Mac: gone here too. Changed here since, this Mac's version is kept in the data folder first.
    if (fs.existsSync(dir)) {
      if (decision.keepOurs) {
        try {
          keepDeleted(data, id, dir);
        } catch (error) {
          // Never pushed meanwhile: that would bring back what someone deleted.
          unkeptDeletes.add(id);
          throw error;
        }
        diag.info("writer", `${jobs.named(id, title)}: deleted on ${ANOTHER_MACHINE} after it changed here, so here too; ${THIS_MACHINE}'s version is kept in kept/`);
      } else diag.info("writer", `${jobs.named(id, title)}: deleted on ${ANOTHER_MACHINE}, so here too`);
      fs.rmSync(dir, { recursive: true, force: true });
      store.libraryChanged();
    }
    unkeptDeletes.delete(id);
    delete ledger.scripts[id];
    return;
  }
  if (decision.do === "skip") return;
  // This Mac's own commit, whose answer was lost: taken as pushed, never counted as overtaken.
  if (ownCommit(ledger, id, row)) return;
  const body = await fetchBytes(String(row.bodyKey ?? ""));
  // Saved again while this was at it: that revision is the one to take. Taking the missing body for a lost one saved
  // this Mac's older copy "as the next revision", refused, and then kept it as a "(conflicted copy)" of a script
  // nobody here had touched (Nov 9: Marc writing a script a save a minute, and ten such copies of his scripts from
  // the idle Macs following him).
  if (body === null) {
    const newer = await savedSince(id, row);
    if (newer !== null) {
      if (chased < CHASES) await pullOne(data, ledger, newer, chased + 1);
      return;
    }
  }
  decision = decidePull(seen(body));
  if (decision.do === "fail") throw new Problem("Its body isn't in the cloud.");
  if (decision.do === "keep-ours") {
    // theirs-missing: the newest revision lost its body (two Macs once pushed the same body under one key, and the
    // loser's clean-up deleted it): no Mac can take it, so a Mac holding the script saves its copy as the next revision
    // rather than asking for the missing one for ever. ours-built: a built script is never replaced by an unbuilt copy
    // of it (Oct 31, M's CORRUPT Cops: his build came back unbuilt from another Mac's older copy, the build only in a
    // "conflicted copy", so Start the edit stayed greyed out).
    diag.warn(
      "writer",
      decision.why === "theirs-missing"
        ? `${jobs.named(id, title)}: rev ${rev}'s body isn't in the cloud, so ${THIS_MACHINE}'s copy is saved as the next revision`
        : `${jobs.named(id, title)}: rev ${rev} from ${ANOTHER_MACHINE} isn't built and ${THIS_MACHINE}'s is, so ${THIS_MACHINE}'s is saved as the next revision`,
    );
    // The cloud rev's files come too. This Mac then saves its own body as the
    // next rev, and a file list made only of what it holds would delete the
    // preview the cloud rev had (Nov 3, Predator Dad, once a Mac's ledger
    // predated the rev it was saving over).
    const files = { ...(known?.files ?? {}) };
    for (const [name, file] of Object.entries(rowFiles(row))) if (!files[name]?.key) files[name] = file;
    ledger.scripts[id] = { rev, body: "", files, summary: 0 };
    syncSoon();
    return;
  }
  if (body === null || decision.do !== "take") return;
  const oursNow = isFile(bodyPath) ? fs.readFileSync(bodyPath) : null;
  const atStart = oursNow === null ? null : hash(oursNow);
  // An import that never finished here (or Writer's copy of one, brought in by Edit) has nothing to keep: theirs
  // replaces it (Oct 31, M's Mac: four stale imports became conflicted copies that showed as stopped imports). This
  // Mac's version is kept once, when the pull is through: a pull that failed after keeping a copy and was tried again
  // kept another every minute (Oct 31, Predator Tutor: 294 copies from Mathias's Mac).
  if (decision.why === "ours-unfinished") diag.warn("writer", `${jobs.named(id, title)}: ${THIS_MACHINE}'s copy is an import that never finished, so rev ${rev} replaces it`);
  // This Mac's version, overtaken: kept in the script's versions once the cloud's is in (below), not as a script of its own.
  let overtaken = decision.keepOurs ? parsed(oursNow) : null;
  // This Mac's "Not synced" versions not pushed yet: the cloud's index coming down doesn't drop them.
  const keptHere = versions.list(dir).filter((version) => version.author === "kept");
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, Kept> = {};
  const left: string[] = [];
  for (const file of (Array.isArray(row.files) ? row.files : []) as Record<string, unknown>[]) {
    const [name, key, size] = [String(file.name ?? ""), String(file.key ?? ""), Number(file.size ?? 0)];
    const path = inside(dir, name);
    if (name === "" || key === "" || path === null) continue;
    // A small JSON file (the chat, versions, research) can change and keep its size, so on a newer script it's always fetched again.
    const smallJson = name.endsWith(".json") && size < 2_000_000;
    const present = !smallJson && isFile(path) && fs.statSync(path).size === size;
    // Footage isn't downloaded: the page plays it from the cloud (`stream`), so a first sync brings the scripts at once.
    // Nor are a transcription's pieces, needed only to finish one cut short (a new Mac fetched thousands, Oct 30).
    if ((storage.isFootage(name) || /(^|\/)pieces\//u.test(name)) && !present) {
      if (isFile(path)) fs.rmSync(path);
      files[name] = { key, size, mtime: known?.files[name]?.mtime ?? 0 };
      left.push(name);
      continue;
    }
    if (row.archived != null && storage.isFootage(name)) continue;
    if (!present) {
      try {
        await download(id, name, key, size, path);
      } catch (error) {
        if (!(error instanceof Gone)) throw error;
        // Saved again while its files came down (the newer save removed this one): the newer revision is taken
        // instead, nothing of this one written down. This Mac's version is still as it was, so that pull keeps it.
        const newer = await savedSince(id, row);
        if (newer !== null) {
          if (chased < CHASES) await pullOne(data, ledger, newer, chased + 1);
          return;
        }
        // Left out rather than asked for for ever: a copy here goes up again with the next push, healing the cloud's.
        diag.warn("writer", `${jobs.named(id, title)}: rev ${rev}'s ${name} isn't in the cloud, so it's left out${isFile(path) ? ` and ${THIS_MACHINE}'s goes up again` : ""}`);
        continue;
      }
    }
    files[name] = { key, size, mtime: mtime(path) };
  }
  leftInCloud(data, id, left);
  versions.carryKept(dir, keptHere);
  // Saved here while the files came down: that version is the one kept, not lost.
  const now = isFile(bodyPath) ? fs.readFileSync(bodyPath) : null;
  if ((now === null ? null : hash(now)) !== atStart) {
    diag.warn("writer", `${jobs.named(id, title)}: changed here while rev ${rev} came down; ${THIS_MACHINE}'s version is kept in its versions`);
    overtaken = parsed(now) ?? overtaken;
  }
  // This Mac's version is kept before the cloud's is written over it: not kept, nothing is taken (the pull goes
  // again next round, this Mac's script as it was). The versions changed here go up with the next push (the
  // script's lock allowing): the ledger names the index as it came down.
  if (overtaken !== null) {
    if (!versions.keepOvertaken(dir, overtaken, `${machine.name()}'s changes, which didn't reach the cloud in time`)) {
      throw new Error(`rev ${rev} from ${ANOTHER_MACHINE} would overtake ${THIS_MACHINE}'s changes, which couldn't be kept in its versions, so it isn't taken yet`);
    }
    diag.warn("writer", `${jobs.named(id, title)}: rev ${rev} from ${ANOTHER_MACHINE} overtook ${THIS_MACHINE}'s changes; they're kept in its versions`);
  }
  // Who started it, as the cloud recorded it from their verified sign-in, wins over the body's.
  const given = withCreator(body, row.createdBy);
  writeAtomic(bodyPath, Buffer.from(given));
  diag.info("writer", `${jobs.named(id, title)}: rev ${rev} came from ${String(row.updatedBy ?? `${ANOTHER_MACHINE}`)}`);
  // Taken as current whichever version of Edit saved it: a row from a Mac on
  // an older Edit (no runFailed) pushed again here was overtaken there, round
  // and round, while the team's Macs were on mixed versions (Oct 30).
  const summary = row.summary as { kind?: unknown } | undefined;
  ledger.scripts[id] = { rev, body: hash(given), files, summary: typeof summary?.kind === "string" ? SUMMARY_VERSION : 0 };
  if (ledger.copied !== undefined) delete ledger.copied[id];
  store.libraryChanged();
}

/** The cloud row's files, as this Mac would keep them. */
function rowFiles(row: Record<string, unknown>): Record<string, Kept> {
  const files: Record<string, Kept> = {};
  for (const file of (Array.isArray(row.files) ? row.files : []) as Record<string, unknown>[]) {
    const name = String(file.name ?? "");
    const key = String(file.key ?? "");
    if (name === "" || key === "") continue;
    files[name] = { key, size: Number(file.size ?? 0), mtime: 0 };
  }
  return files;
}

/**
 * A cloud file a push must still name when this Mac doesn't have it. Leaving
 * it out is the commit that deletes it from R2. Footage and a transcription's
 * pieces play from the cloud; a recording now in Edit's originals is named
 * there, not here. Anything else removed on this Mac (a cleared chat) stays
 * removed.
 */
function heldInCloud(name: string, purged: ReadonlySet<string>, shared: ReadonlySet<string>): boolean {
  if (purged.has(name)) return true;
  return (storage.isFootage(name) || /(^|\/)pieces\//u.test(name)) && !shared.has(name);
}

/** Copies cloud files this Mac doesn't have into `files`, so the commit still names them. */
function carryCloudFiles(dir: string, files: Record<string, Kept>, cloud: Record<string, Kept>, purged: ReadonlySet<string>): void {
  const shared = new Set(readJson<{ file?: unknown }[]>(join(dir, "edit-shared.json"), []).flatMap((entry) => (typeof entry?.file === "string" ? [entry.file] : [])));
  for (const [name, kept] of Object.entries(cloud)) {
    if (name in files || kept.key === "") continue;
    const path = inside(dir, name);
    if (path !== null && isFile(path)) continue;
    if (!heldInCloud(name, purged, shared)) continue;
    files[name] = kept;
  }
}

/** The cloud's current files, folded into a push that would otherwise replace them. A ledger at the same rev can be missing one. */
async function keepCloudFiles(data: string, id: string, dir: string, base: number, files: Record<string, Kept>): Promise<void> {
  let listed: Awaited<ReturnType<typeof convex>>;
  try {
    listed = await convex("query", "writer:getScript", { scriptId: id });
  } catch (error) {
    if (error instanceof Problem && error.offline) throw error;
    return;
  }
  if (!listed.ok || listed.value === null || typeof listed.value !== "object") return;
  const row = listed.value as Record<string, unknown>;
  if (Number(row.rev ?? 0) !== base) return;
  carryCloudFiles(dir, files, rowFiles(row), new Set(purgedNames(data, id)));
}

/** Sends a script's changed files and its body, then commits them. */
/**
 * Whether the cloud's row of `id` is this Mac's own commit whose answer was
 * lost (the rev after the one it was sent on, naming its body): then the
 * ledger takes it as pushed. A copy kept for it would be a "(conflicted
 * copy)" of a script nobody else changed.
 */
function ownCommit(ledger: Ledger, id: string, row: Record<string, unknown>): boolean {
  const attempt = ledger.attempts?.[id];
  if (attempt === undefined) return false;
  if (Number(row.rev ?? 0) !== attempt.base + 1 || String(row.bodyKey ?? "") !== attempt.bodyKey) return false;
  ledger.scripts[id] = { ...attempt.known, rev: attempt.base + 1 };
  delete ledger.attempts![id];
  diag.info("writer", `${jobs.named(id, String(row.title ?? ""))}: the cloud's rev ${attempt.base + 1} is this Mac's own save (its answer was lost): taken as saved, no copy`);
  return true;
}

async function push(data: string, id: string, dir: string, script: Script, body: Uint8Array, known: Known | undefined, files: Record<string, Kept>, ledger?: Ledger, save?: () => void): Promise<Known | "overtaken"> {
  // A commit sent before whose answer never came (Edit quit, the connection dropped): landed, it's this Mac's, and nothing more is sent for it.
  if (ledger?.attempts?.[id] !== undefined) {
    const listed = await convex("query", "writer:getScript", { scriptId: id }).catch((error: unknown) => {
      if (error instanceof Problem && error.offline) throw error;
      return null;
    });
    if (listed?.ok === true && listed.value !== null && typeof listed.value === "object" && ownCommit(ledger, id, listed.value as Record<string, unknown>)) return ledger.scripts[id]!;
    delete ledger.attempts[id];
  }
  const base = known?.rev ?? 0;
  await keepCloudFiles(data, id, dir, base, files);
  const kept: Record<string, Kept> = {};
  const began = Date.now();
  let [sent, sentBytes] = [0, 0];
  // Each push's files go under keys no committed revision uses, so a push that loses to another Mac's never overwrites the winner's files.
  const pushId = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const uploaded: string[] = [];
  for (const [name, local] of Object.entries(files)) {
    const previous = known?.files[name];
    if (previous !== undefined && previous.size === local.size && previous.mtime === local.mtime) {
      kept[name] = previous;
      continue;
    }
    const path = inside(dir, name);
    // Carried from the cloud's list (no copy here), or footage already up
    // beside the rounds (`footageFirst`). Naming that key is what keeps it;
    // there is nothing to upload in its place.
    if (local.key !== "") {
      kept[name] = local;
      continue;
    }
    if (path === null) continue;
    const key = `${PREFIX}/${id}/files/r${base + 1}-${pushId}/${name}`;
    try {
      const size = await upload(id, name, path, key);
      sent++;
      sentBytes += size;
      uploaded.push(key);
      kept[name] = { key, size, mtime: local.mtime };
    } catch (error) {
      if (error instanceof Problem && error.offline) throw error;
      // Gone before it went up. A temp piece is left out. A file the cloud
      // already holds stays: a purge while the push reads it must not delete
      // that copy for every Mac.
      if (!fs.existsSync(path)) {
        if (previous !== undefined && previous.key !== "") kept[name] = previous;
        continue;
      }
      await remove(uploaded);
      throw error;
    }
  }
  const digest = hash(body);
  // Unique to this push, as its files are: two Macs pushing the same body on the same revision named it alike, and the loser's
  // clean-up deleted the winner's body (Oct 30, Predator Tutor's rev 5: "Its body isn't in the cloud" on every Mac).
  const bodyKey = `${PREFIX}/${id}/body/${base + 1}-${digest.slice(0, 12)}-${pushId}.json`;
  await uploadBytes(bodyKey, body);
  // Written down before it goes: an answer lost on the way back is known as this Mac's (`ownCommit`).
  if (ledger !== undefined) {
    ledger.attempts = { ...ledger.attempts, [id]: { base, bodyKey, known: { rev: base + 1, body: digest, files: kept, summary: SUMMARY_VERSION } } };
    save?.();
  }
  const answer = await convex("mutation", "writer:commitScript", {
    scriptId: id,
    baseRev: base,
    title: script.title,
    bodyKey,
    bodySize: body.length,
    files: Object.entries(kept).map(([name, file]) => ({ name, key: file.key, size: file.size })),
    summary: store.summary(script, dir),
    holder: holder(),
  });
  if (answer.ok) {
    if (ledger?.attempts !== undefined) delete ledger.attempts[id];
    const value = (answer.value ?? {}) as { stale?: unknown; rev?: unknown };
    await remove((Array.isArray(value.stale) ? value.stale : []).filter((key): key is string => typeof key === "string"));
    const rev = typeof value.rev === "number" ? value.rev : base + 1;
    diag.info("writer", `${jobs.named(id, script.title)}: saved to the cloud as rev ${rev}${sent > 0 ? ` with ${sent} ${sent === 1 ? "file" : "files"} (${Math.round(sentBytes / 1e6)} MB)` : ""} in ${Math.round((Date.now() - began) / 1000)} s`);
    return { rev, body: digest, files: kept, summary: SUMMARY_VERSION };
  }
  if (ledger?.attempts !== undefined) delete ledger.attempts[id];
  await remove([...uploaded, bodyKey]);
  if (answer.code === "conflict") {
    diag.warn("writer", `${jobs.named(id, script.title)}: ${ANOTHER_MACHINE} saved it first (rev ${base} is behind); taking theirs and keeping ${THIS_MACHINE}'s in its versions`);
    return "overtaken";
  }
  throw new Problem(`The cloud refused ${script.title}: ${String(answer.data.message ?? answer.code)}`);
}
