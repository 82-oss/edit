// Google's map tiles kept on this computer for as long as Google's own answer
// allows (Nov 17). Each tile says `cache-control: private, max-age=14400`:
// this person's own copy, four hours. Every look at a map opens a Chrome with
// a fresh profile and every render two more, so each fetched every tile of
// its city again, a round trip through Edit, the relay and Google a level of
// the tree at a time. On a busy Mac (Sphe's M4 that day) a map date title's
// first look then took longer than it was given. A second look at the same
// place is now read off the disk.
//
// Kept in `<cache>/map-tiles/`, one file a tile (a line of JSON, then the
// tile's bytes), named by the tile's path and query without the key and the
// session (the same tile in another session is the same file). A tile is
// dropped once its max-age has passed (Google says must-revalidate), and the
// least lately used go first past `limits.mostBytes`. Nothing is kept where the disk
// is short (the floor for copies kept only to go faster). The tileset's root
// is never kept here: relay.ts holds it in memory (a session).

import fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as diag from "./diag.ts";
import * as storage from "./storage.ts";

/** At most this much is kept (`mostBytes`): a place's tiles are some tens of MB. */
export const limits = { mostBytes: 512 * 1024 * 1024 };
/** No tile is kept longer than this, whatever it says. */
const LONGEST_S = 24 * 60 * 60;

export interface Tile {
  body: Uint8Array;
  type: string;
  etag: string | null;
  /** Seconds it's good for still. */
  left: number;
}

/** The seconds a tile may be kept (its `max-age`), or null when it may not be (none, no-store, no-cache). */
export function maxAgeOf(cacheControl: string | null): number | null {
  if (cacheControl === null) return null;
  const said = cacheControl.toLowerCase();
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/.test(said)) return null;
  const age = /(?:^|,)\s*max-age=(\d+)/.exec(said);
  if (age === null) return null;
  const seconds = Math.min(Number(age[1]), LONGEST_S);
  return seconds > 0 ? seconds : null;
}

/** The file a tile is kept in: its path and query, less what changes from one asking to the next. */
export function nameOf(from: URL): string {
  const params = new URLSearchParams(from.search);
  params.delete("key");
  params.delete("session");
  params.sort();
  return createHash("sha256").update(`${from.pathname}?${params.toString()}`).digest("hex");
}

/** Where a home keeps its tiles; none for a home that isn't one (EDIT_HOME=""), whose cache would be "/cache". */
export function folderOf(store: { home: string; cacheDir(): string }): string | null {
  return store.home === "" ? null : join(store.cacheDir(), "map-tiles");
}

/** What's kept in each folder now (bytes), worked out on its first use. */
const sizes = new Map<string, number>();

/** A kept tile still good, else null (one past its time removed). */
export function read(dir: string, from: URL, now = Date.now()): Tile | null {
  const path = join(dir, nameOf(from));
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path);
  } catch {
    return null;
  }
  const end = bytes.indexOf(10);
  let head: { type?: unknown; etag?: unknown; expires?: unknown };
  try {
    head = JSON.parse(bytes.subarray(0, end).toString("utf8")) as typeof head;
  } catch {
    head = {};
  }
  const expires = typeof head.expires === "number" ? head.expires : 0;
  if (end < 0 || expires <= now) {
    forget(dir, path);
    return null;
  }
  // Used now: the last to go.
  try {
    const at = new Date(now);
    fs.utimesSync(path, at, at);
  } catch {
    // Gone meanwhile: what was read still answers.
  }
  return {
    body: new Uint8Array(bytes.buffer, bytes.byteOffset + end + 1, bytes.length - end - 1),
    type: typeof head.type === "string" ? head.type : "application/octet-stream",
    etag: typeof head.etag === "string" ? head.etag : null,
    left: Math.max(1, Math.floor((expires - now) / 1000)),
  };
}

/** Keeps a tile Google answered (200) for as long as its cache-control says, where the disk has room. */
export function keep(dir: string, from: URL, headers: Headers, body: Uint8Array, now = Date.now()): void {
  const age = maxAgeOf(headers.get("cache-control"));
  if (age === null || body.length === 0) return;
  try {
    if (storage.spare(dir, body.length, storage.CACHE_FLOOR_BYTES) < 0) return;
    fs.mkdirSync(dir, { recursive: true });
    const used = sizeOf(dir, now);
    const head = Buffer.from(`${JSON.stringify({ type: headers.get("content-type") ?? "application/octet-stream", etag: headers.get("etag"), expires: now + age * 1000 })}\n`);
    const path = join(dir, nameOf(from));
    const before = fileSize(path);
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
    fs.writeFileSync(temp, Buffer.concat([head, body]));
    // Used at `now`, the time a read stamps too: what the least lately used is told by, on the cache's own clock.
    // Left at the write's own time, a tile kept at `now` sorted after one read later on a disk slower than the clock
    // (CI's Macs, Nov 17: a tile read after four were kept went before them).
    const at = new Date(now);
    fs.utimesSync(temp, at, at);
    fs.renameSync(temp, path);
    sizes.set(dir, used - before + head.length + body.length);
    if (sizes.get(dir)! > limits.mostBytes) trim(dir, now, limits.mostBytes * 0.8);
  } catch (error) {
    diag.warn("maps", `couldn't keep a map tile: ${diag.messageOf(error)}`);
  }
}

function fileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function forget(dir: string, path: string): void {
  const size = fileSize(path);
  fs.rmSync(path, { force: true });
  if (sizes.has(dir)) sizes.set(dir, Math.max(0, sizes.get(dir)! - size));
}

/** What the folder holds, worked out once (past-time tiles and pieces of writes cut short removed on the way). */
function sizeOf(dir: string, now: number): number {
  const known = sizes.get(dir);
  if (known !== undefined) return known;
  sizes.set(dir, 0);
  trim(dir, now, limits.mostBytes);
  return sizes.get(dir)!;
}

/** Removes tiles past their time, writes cut short, then the least lately used until no more than `most` is kept. */
function trim(dir: string, now: number, most: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    sizes.set(dir, 0);
    return;
  }
  const files: { path: string; size: number; used: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path);
    } catch {
      continue;
    }
    // A tile is kept four hours at most, so one unused for a day is past it; a write cut short is gone after an hour.
    if ((name.endsWith(".partial") && now - stat.mtimeMs > 60 * 60_000) || now - stat.mtimeMs > LONGEST_S * 1000) {
      fs.rmSync(path, { force: true });
      continue;
    }
    if (!name.endsWith(".partial")) files.push({ path, size: stat.size, used: stat.mtimeMs });
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  files.sort((a, b) => a.used - b.used);
  for (const file of files) {
    if (total <= most) break;
    fs.rmSync(file.path, { force: true });
    total -= file.size;
  }
  sizes.set(dir, total);
}

/** Forgets what it knew of every folder's size (tests). */
export function forgetSizes(): void {
  sizes.clear();
}
