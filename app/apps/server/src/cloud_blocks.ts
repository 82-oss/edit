// Cloud previews read in big blocks and kept a while. Measured Oct 29 from
// this Mac (South Africa): every read of R2 waits ~0.25 s for its first byte
// whatever its size, and the page reads 256 KiB at a time, its picture and
// sound workers each reading the same file. Mom & Teen played at 21 fps with a
// 4.8 s freeze, cold seeks took up to 3 s or more, and a scrub showed one
// picture in five. The bytes weren't slow; the round trips were.
//
// So a range the page asks for is served from 2 MiB blocks of the object:
// each block read from R2 once (two asks for it share the read), kept on disk
// under `<cache>/cloud/blocks/`, and the next two read ahead as the reads move
// on. The cleaner drops blocks past the cache's budget after a few hours, as
// every other copy of an R2 object (cache_cleanup.ts, CLOUD_EVICTABLE).

import * as fs from "node:fs";
import { createHash } from "node:crypto";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

export const BLOCK = 2 * 1024 * 1024;
/** Blocks read ahead past the last one asked for: a bounded read's (the page's), and a read to the end's (FFmpeg reading on: Edit.app's window, its sound, the censor check). */
const AHEAD = 2;
const STREAM_AHEAD = 4;
/** R2 reads at once across every object; a read someone waits on goes ahead of read-ahead and warming (`slot`). */
const AT_ONCE = 6;

interface Meta {
  size: number;
  type: string;
  /** The object's key, so the cleaner knows whose it is (absent in folders from before Nov 2). */
  key?: string;
}

/**
 * The viewer comes first on this Mac's link (nightly-50: a smooth-playback
 * render's cell cuts, the proxy prefetch and a whole cloud render's download
 * together saturated it, so every page read queued behind media reads and
 * the preview sat stuck while every server handler was fast). One signal:
 * a page read that had to go to R2 marks the viewer busy; background R2
 * work (prefetch, a playback render's cell cuts, the cloud render's
 * download) pauses while it is set and resumes once the viewer has rested
 * `restMs` with no miss. Cache hits never mark it, so playing from cache
 * never blocks background work.
 */
export const viewerHooks = { restMs: 5_000, pollMs: 50 };
let lastViewerMiss = 0;

/** Notes that a viewer read just had to wait on R2 (`at`: ms since 1970, for tests). */
export function noteViewerMiss(at: number = Date.now()): void {
  lastViewerMiss = at;
}

/** Whether a viewer read missed on R2 within the rest window. */
export function viewerBusy(now: number = Date.now()): boolean {
  return lastViewerMiss > 0 && now - lastViewerMiss < viewerHooks.restMs;
}

/**
 * Waits until no viewer read has missed for the rest window; false when
 * `stop()` gave up first. With `maxMs`, it gives up waiting then and
 * proceeds anyway (true): for small background reads a person may be
 * blocked on, which must not stall for a whole viewing session.
 */
export async function waitForViewerRest(stop: () => boolean = () => false, maxMs?: number): Promise<boolean> {
  const began = Date.now();
  while (viewerBusy() && !stop() && (maxMs === undefined || Date.now() - began < maxMs)) await new Promise((resolve) => setTimeout(resolve, viewerHooks.pollMs));
  return !stop();
}

const reading = new Map<string, Promise<Uint8Array>>();
let inFlight = 0;
/**
 * Reads waiting for a slot: the ones someone waits on (a page's range, the window's FFmpeg) first, then read-ahead
 * and warming. One line for both, first come first served, put a jump's block behind the read-ahead of the stretch
 * it left and the warming of a whole project's starts (a cold open on the M4, Nov 16: a jump froze, then played).
 */
type Waiter = { go: () => void; urgent: boolean };
const asked: Waiter[] = [];
const behind: Waiter[] = [];
/** The block reads still waiting for a slot, by id: one someone now waits on moves to the front. */
const queued = new Map<string, Waiter>();

async function slot<T>(id: string, urgent: boolean, work: () => Promise<T>): Promise<T> {
  if (inFlight >= AT_ONCE) {
    await new Promise<void>((resolve) => {
      const waiter: Waiter = { go: resolve, urgent };
      queued.set(id, waiter);
      (urgent ? asked : behind).push(waiter);
    });
    queued.delete(id);
  }
  inFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
    (asked.shift() ?? behind.shift())?.go();
  }
}

/** A block read waiting behind read-ahead that someone now waits on: to the front. */
function hurryBlock(id: string): void {
  const waiter = queued.get(id);
  if (waiter === undefined || waiter.urgent) return;
  const at = behind.indexOf(waiter);
  if (at < 0) return;
  behind.splice(at, 1);
  waiter.urgent = true;
  asked.push(waiter);
}

const folderOf = (root: string, key: string) => join(root, createHash("sha1").update(key).digest("hex"));

function metaOf(folder: string): Meta | null {
  try {
    return JSON.parse(fs.readFileSync(join(folder, "meta.json"), "utf8")) as Meta;
  } catch {
    return null;
  }
}

/**
 * One block of the object, from disk or R2 (once, however many ask). `viewer`: someone waits on it (a page's
 * range, the window's FFmpeg): a miss marks the viewer busy and goes ahead of read-ahead; a hit never does.
 */
function block(root: string, key: string, index: number, url: () => Promise<string>, viewer = false): Promise<Uint8Array> {
  const folder = folderOf(root, key);
  const path = join(folder, `${index}`);
  try {
    const bytes = fs.readFileSync(path);
    // Touched, so the cleaner keeps what's being played longest.
    const now = new Date();
    fs.utimesSync(path, now, now);
    return Promise.resolve(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    // Not here yet.
  }
  if (viewer) noteViewerMiss();
  const id = `${key}#${index}`;
  const known = reading.get(id);
  if (known !== undefined) {
    if (viewer) hurryBlock(id);
    return known;
  }
  const read = slot(id, viewer, async () => {
    const start = index * BLOCK;
    const { answer, bytes } = await fetchBlock(url, start);
    const total = Number(/\/(\d+)$/.exec(answer.headers.get("content-range") ?? "")?.[1] ?? NaN);
    fs.mkdirSync(folder, { recursive: true });
    if (Number.isFinite(total) && metaOf(folder) === null) writeAtomic(join(folder, "meta.json"), JSON.stringify({ size: total, type: answer.headers.get("content-type") ?? "video/mp4", key }));
    writeAtomic(path, bytes);
    return bytes;
  }).finally(() => reading.delete(id));
  reading.set(id, read);
  return read;
}

/** Waits before a block read is tried again (ms): a passing failure is tried twice more, then it fails its read. */
export const retryHooks = { waits: [500, 2_000] };

/**
 * A block's bytes from R2, tried again on a passing failure (the network's, a timeout, R2's 5xx or 429): a
 * read to the end that failed one block ended its answer short, which FFmpeg reads as "Input/output error".
 */
async function fetchBlock(url: () => Promise<string>, start: number): Promise<{ answer: Response; bytes: Uint8Array }> {
  for (let attempt = 0; ; attempt++) {
    let problem: unknown;
    try {
      const answer = await fetch(await url(), { headers: { range: `bytes=${start}-${start + BLOCK - 1}` }, signal: AbortSignal.timeout(30_000) });
      if (answer.status === 206) return { answer, bytes: new Uint8Array(await answer.arrayBuffer()) };
      void answer.body?.cancel();
      problem = new Error(`R2 answered ${answer.status} to a block read`);
      // Not there, or past its end: asking again won't change it.
      if (answer.status < 500 && answer.status !== 429) throw problem;
    } catch (error) {
      if (error === problem) throw error;
      problem = error;
    }
    const wait = retryHooks.waits[attempt];
    if (wait === undefined) throw problem;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** The object's size and which of its blocks are here (null: none read yet). */
export function blocksHere(root: string, key: string): { size: number; here: Set<number> } | null {
  const folder = folderOf(root, key);
  const meta = metaOf(folder);
  if (meta === null) return null;
  const here = new Set<number>();
  try {
    for (const name of fs.readdirSync(folder)) if (/^\d+$/.test(name)) here.add(Number(name));
  } catch {
    return null;
  }
  return { size: meta.size, here };
}

/**
 * Bytes `from..to` (a fraction of the object each, 0 to 1, as a time over its length maps onto a proxy whose
 * index is at its start) read into blocks behind what anyone waits on, the first block too (it holds the index).
 * Resolves once they're here; how many were read.
 */
export async function warm(root: string, key: string, from: number, to: number, url: () => Promise<string>): Promise<number> {
  await block(root, key, 0, url);
  const meta = metaOf(folderOf(root, key));
  if (meta === null) return 0;
  const last = Math.floor((meta.size - 1) / BLOCK);
  const first = Math.max(0, Math.min(last, Math.floor((from * meta.size) / BLOCK) - 1));
  const end = Math.max(first, Math.min(last, Math.floor((to * meta.size) / BLOCK) + 1));
  const reads: Promise<Uint8Array>[] = [];
  let read = 0;
  for (let index = first; index <= end; index++) {
    if (fs.existsSync(join(folderOf(root, key), `${index}`))) continue;
    read++;
    reads.push(block(root, key, index, url));
  }
  await Promise.all(reads);
  return read;
}

/**
 * A range of a cloud object from its blocks: bounded (`bytes=a-b`, the page's reads), to the end (`bytes=a-`,
 * FFmpeg's after a seek) or whole (no range, FFmpeg's first open). Null for any other kind of ask, which goes
 * straight to R2. Until Nov 16 only bounded ranges came from here: Edit.app's window (and the censor check)
 * read every stretch of a streamed preview straight from R2, each seek a new request paying R2's first byte,
 * its picture and its sound read twice, none of it kept, and the window's sound ran short 735 times in an
 * 18 s play from a jump on a first open.
 */
export async function serve(root: string, key: string, range: string | null, url: () => Promise<string>): Promise<Response | null> {
  const asked = range === null ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
  if (range !== null && asked === null) return null;
  const from = asked === null ? 0 : Number(asked[1]);
  const open = asked === null || asked[2] === "";
  let to = open ? Number.POSITIVE_INFINITY : Number(asked![2]);
  if (!(to >= from)) return null;
  const first = Math.floor(from / BLOCK);
  // The first block says how big the object is.
  const opening = await block(root, key, first, url, true).catch(async (error: unknown) => {
    // A start past the end of an object we haven't the size of yet: the first block says it.
    if (first === 0) throw error;
    await block(root, key, 0, url, true);
    return null;
  });
  const meta = metaOf(folderOf(root, key));
  if (meta === null) return null;
  if (from >= meta.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${meta.size}` } });
  to = Math.min(to, meta.size - 1);
  const last = Math.floor(to / BLOCK);
  const size = meta.size;
  const end = to;
  const reach = open ? STREAM_AHEAD : AHEAD;
  // What's next, read while this plays.
  const ahead = (after: number) => {
    for (let n = 1; n <= reach; n++) {
      const next = after + n;
      if (next * BLOCK < size) void block(root, key, next, url).catch((error: unknown) => diag.warn("cloud", `reading ahead in ${key}: ${diag.messageOf(error)}`));
    }
  };
  // Answered as it's read, a block at a time: a player asks a long preview
  // for a range to its end (AVFoundation and FFmpeg do), and held whole it was
  // gigabytes, refused as "Out of memory" every time (JJ's Mac, Nov 10:
  // a script's preview that wouldn't play). A reader that stops early
  // (FFmpeg seeking elsewhere closes its connection) stops the reads.
  let index = first;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (index > last) {
          controller.close();
          return;
        }
        const bytes = index === first && opening !== null ? opening : await block(root, key, index, url, true);
        const base = index * BLOCK;
        controller.enqueue(bytes.subarray(Math.max(from - base, 0), Math.min(end - base + 1, bytes.length)));
        ahead(index);
        index++;
      },
    },
    { highWaterMark: 0 },
  );
  // Bun sends a stream chunked, without its length: the size is in `content-range`, which FFmpeg reads on a 200 too
  // (it opens with `bytes=0-`; a reader asking for no range at all still learns the size, and that it can seek).
  const headers = { "content-type": meta.type, "content-range": `bytes ${from}-${to}/${meta.size}`, "accept-ranges": "bytes", "cache-control": "no-cache" };
  return new Response(body, { status: asked === null ? 200 : 206, headers });
}

/** For tests: nothing queued or in flight. */
export function resetForTests(): void {
  reading.clear();
  queued.clear();
  asked.length = 0;
  behind.length = 0;
  inFlight = 0;
}
