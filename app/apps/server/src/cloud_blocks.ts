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
/** Of those, whole copies' fills take at most this many: a read someone waits on never waits for one to finish. */
const FILLS_AT_ONCE = 4;

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
 * How soon a block read gets a slot: one someone waits on (a page's range, the window's FFmpeg), then read-ahead
 * and warming (the next seconds from a jump), then a whole copy's fill (local_previews.ts). One line, first come
 * first served, put a jump's block behind everything asked before it; and whole copies fetched as one long read
 * each, four to six at once, filled the link, so every read a person waited on shared it with them (a cold open on
 * the M4, Nov 16: a jump froze 10 s, then passed over 199 frames; on mandalorian a cold block took 3–11 s while a
 * project's whole copies came down, against 0.5–1 s alone).
 */
export type Priority = "asked" | "ahead" | "fill";
const ORDER: Priority[] = ["asked", "ahead", "fill"];
type Waiter = { go: () => void; priority: Priority };
const lanes: Record<Priority, Waiter[]> = { asked: [], ahead: [], fill: [] };
/** The block reads still waiting for a slot, by id: one someone now waits on moves up. */
const queued = new Map<string, Waiter>();

let fillsInFlight = 0;
const full = (priority: Priority) => inFlight >= AT_ONCE || (priority === "fill" && fillsInFlight >= FILLS_AT_ONCE);

async function slot<T>(id: string, priority: Priority, work: () => Promise<T>): Promise<T> {
  const waiter: Waiter = { go: () => {}, priority };
  if (full(priority)) {
    await new Promise<void>((resolve) => {
      waiter.go = resolve;
      queued.set(id, waiter);
      lanes[priority].push(waiter);
    });
    queued.delete(id);
  }
  // Moved up while it waited, it's counted as what it is now.
  const filling = waiter.priority === "fill";
  inFlight++;
  if (filling) fillsInFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
    if (filling) fillsInFlight--;
    for (const lane of ORDER) {
      if (lanes[lane].length === 0 || full(lane)) continue;
      lanes[lane].shift()!.go();
      break;
    }
  }
}

/** A block read waiting in a lane below `priority` that's now wanted sooner: up to it. */
function hurryBlock(id: string, priority: Priority): void {
  const waiter = queued.get(id);
  if (waiter === undefined || ORDER.indexOf(waiter.priority) <= ORDER.indexOf(priority)) return;
  const at = lanes[waiter.priority].indexOf(waiter);
  if (at < 0) return;
  lanes[waiter.priority].splice(at, 1);
  waiter.priority = priority;
  lanes[priority].push(waiter);
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
 * One block of the object, from disk or R2 (once, however many ask), read as soon as `priority` says (`slot`).
 * One someone waits on ("asked": a page's range, the window's FFmpeg) that misses marks the viewer busy; a hit never does.
 */
function block(root: string, key: string, index: number, url: BlockSource, priority: Priority = "ahead", hedge = priority === "asked"): Promise<Uint8Array> {
  const viewer = priority === "asked";
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
    hurryBlock(id, priority);
    return known;
  }
  const read = slot(id, priority, async () => {
    const start = index * BLOCK;
    const { answer, bytes } = await fetchBlock(url, start, hedge);
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
 * Where a block is read from: the relay's edge (cached there for every Mac), and optionally R2's own URL, which a
 * read someone waits on also tries when the edge is slow to answer (`hedgeHooks`).
 */
export type BlockSource = (() => Promise<string>) & { direct?: () => Promise<string> };

/**
 * A read someone waits on goes to R2's own URL too when the edge hasn't answered in this long (a block it has
 * answers in 55–92 ms), and takes whichever comes first. Measured on mandalorian (Nov 16): a block the edge hadn't seen took it 1.8–2.8 s, a cold open's
 * first picture through it 1.5–3 s, where R2's own answered a whole open-and-seek in 0.7–1 s.
 */
export const hedgeHooks = { ms: 150 };

/** One read of a block's range; rejects with the answer's status when it isn't 206. */
async function readOnce(url: string, start: number, signal: AbortSignal): Promise<{ answer: Response; bytes: Uint8Array }> {
  const answer = await fetch(url, { headers: { range: `bytes=${start}-${start + BLOCK - 1}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (answer.status === 206) return { answer, bytes: new Uint8Array(await answer.arrayBuffer()) };
  void answer.body?.cancel();
  throw Object.assign(new Error(`R2 answered ${answer.status} to a block read`), { status: answer.status });
}

/** From the edge, and for someone waiting, from R2's own URL too once the edge is slow: the first answer wins, the other's dropped. */
async function readHedged(source: BlockSource, start: number, hedge: boolean): Promise<{ answer: Response; bytes: Uint8Array }> {
  const stop = new AbortController();
  const edge = readOnce(await source(), start, stop.signal);
  if (!hedge || source.direct === undefined) return edge;
  const direct = source.direct;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), hedgeHooks.ms)));
  const early = await Promise.race([edge.then((value) => ({ value }), (error: unknown) => ({ error })), late]);
  clearTimeout(timer);
  if (early !== "late" && "value" in early) return early.value;
  const other = readOnce(await direct(), start, stop.signal);
  try {
    // The edge failing outright: R2's alone.
    return early !== "late" ? await other : await Promise.any([edge, other]);
  } catch (error) {
    throw error instanceof AggregateError ? error.errors[0] : error;
  } finally {
    stop.abort();
  }
}

/**
 * A block's bytes, tried again on a passing failure (the network's, a timeout, R2's 5xx or 429): a read to the
 * end that failed one block ended its answer short, which FFmpeg reads as "Input/output error".
 */
async function fetchBlock(source: BlockSource, start: number, hedge: boolean): Promise<{ answer: Response; bytes: Uint8Array }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readHedged(source, start, hedge);
    } catch (error) {
      const status = (error as { status?: number }).status;
      // Not there, or past its end: asking again won't change it.
      if (status !== undefined && status < 500 && status !== 429) throw error;
      const wait = retryHooks.waits[attempt];
      if (wait === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
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
 * index is at its start) read into blocks, the first block too (it holds the index): behind what anyone waits on,
 * or as one (`priority` "asked": the seconds a held play waits for).
 * Resolves once they're here; how many were read.
 */
export async function warm(root: string, key: string, from: number, to: number, url: BlockSource, priority: "asked" | "ahead" = "ahead"): Promise<number> {
  await block(root, key, 0, url, priority);
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
    reads.push(block(root, key, index, url, priority));
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
export async function serve(root: string, key: string, range: string | null, url: BlockSource): Promise<Response | null> {
  const asked = range === null ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
  if (range !== null && asked === null) return null;
  const from = asked === null ? 0 : Number(asked[1]);
  const open = asked === null || asked[2] === "";
  let to = open ? Number.POSITIVE_INFINITY : Number(asked![2]);
  if (!(to >= from)) return null;
  const folder = folderOf(root, key);
  const first = Math.floor(from / BLOCK);
  // A read to the end (FFmpeg's) reads on from where it starts: the blocks after it are asked for with it, not one
  // after another once each lands (a cold open waited on two blocks in turn, 1.5–2.2 s to its first picture).
  const known = metaOf(folder)?.size;
  if (open && known !== undefined) for (let n = 1; n <= STREAM_AHEAD && (first + n) * BLOCK < known; n++) void block(root, key, first + n, url, "ahead", true).catch(() => {});
  // Not here: its first bytes straight from R2's own URL while its block lands (kept for the next read), so the
  // reader starts on one round trip, not on a whole 2 MiB block (a cold open-and-seek took 1.1–2.7 s that way).
  const cold = !fs.existsSync(join(folder, `${first}`));
  const opening = block(root, key, first, url, "asked");
  opening.catch(() => {});
  let peek = cold && url.direct !== undefined ? await peekAt(url.direct, from, open ? from + PEEK - 1 : Math.min(to, from + PEEK - 1)).catch(() => null) : null;
  let size = peek?.size ?? known;
  let type = peek?.type ?? metaOf(folder)?.type ?? "video/mp4";
  if (peek === null) {
    // The first block says how big the object is.
    await opening.catch(async (error: unknown) => {
      // A start past the end of an object we haven't the size of yet: the first block says it.
      if (first === 0) throw error;
      await block(root, key, 0, url, "asked");
    });
    const meta = metaOf(folder);
    if (meta === null) return null;
    size = meta.size;
    type = meta.type;
  }
  if (size === undefined) return null;
  if (from >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  to = Math.min(to, size - 1);
  const last = Math.floor(to / BLOCK);
  const end = to;
  const total = size;
  const reach = open ? STREAM_AHEAD : AHEAD;
  // What's next, read while this plays.
  const ahead = (after: number) => {
    for (let n = 1; n <= reach; n++) {
      const next = after + n;
      // A read to the end wants these within seconds: R2's own URL too where the edge is slow, as for the block it reads.
      if (next * BLOCK < total) void block(root, key, next, url, "ahead", open).catch((error: unknown) => diag.warn("cloud", `reading ahead in ${key}: ${diag.messageOf(error)}`));
    }
  };
  // Answered as it's read, a block at a time: a player asks a long preview
  // for a range to its end (AVFoundation and FFmpeg do), and held whole it was
  // gigabytes, refused as "Out of memory" every time (JJ's Mac, Nov 10:
  // a script's preview that wouldn't play). A reader that stops early
  // (FFmpeg seeking elsewhere closes its connection) stops the reads.
  let at = from;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (peek !== null) {
          const read = await peek.reader.read().catch(() => ({ done: true, value: undefined }));
          if (!read.done && read.value !== undefined && read.value.length > 0) {
            const bytes = read.value.subarray(0, Math.max(0, end - at + 1));
            at += bytes.length;
            controller.enqueue(bytes);
            if (at > end) {
              void peek.reader.cancel().catch(() => {});
              peek = null;
              controller.close();
            }
            return;
          }
          // Its first bytes sent (or the read gave out): on from the blocks.
          void peek.reader.cancel().catch(() => {});
          peek = null;
        }
        const index = Math.floor(at / BLOCK);
        if (at > end || index > last) {
          controller.close();
          return;
        }
        // What's after it asked for before it's waited on.
        ahead(index);
        const bytes = await block(root, key, index, url, "asked");
        const base = index * BLOCK;
        const piece = bytes.subarray(at - base, Math.min(end - base + 1, bytes.length));
        if (piece.length === 0) {
          controller.close();
          return;
        }
        at += piece.length;
        controller.enqueue(piece);
      },
      cancel() {
        void peek?.reader.cancel().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  // Bun sends a stream chunked, without its length: the size is in `content-range`, which FFmpeg reads on a 200 too
  // (it opens with `bytes=0-`; a reader asking for no range at all still learns the size, and that it can seek).
  const headers = { "content-type": type, "content-range": `bytes ${from}-${to}/${total}`, "accept-ranges": "bytes", "cache-control": "no-cache" };
  return new Response(body, { status: asked === null ? 200 : 206, headers });
}

/** How much of a cold read is sent straight from R2's own URL while its block lands. */
const PEEK = 512 * 1024;

/** Bytes `from..to` of the object from `direct`, as they arrive, and its size and type; rejects unless R2 answers 206. */
async function peekAt(direct: () => Promise<string>, from: number, to: number): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; size: number; type: string }> {
  const answer = await fetch(await direct(), { headers: { range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(30_000) });
  const size = Number(/\/(\d+)$/.exec(answer.headers.get("content-range") ?? "")?.[1] ?? NaN);
  if (answer.status !== 206 || answer.body === null || !Number.isFinite(size)) {
    void answer.body?.cancel();
    throw new Error(`R2 answered ${answer.status} to a first read`);
  }
  return { reader: answer.body.getReader() as ReadableStreamDefaultReader<Uint8Array>, size, type: answer.headers.get("content-type") ?? "video/mp4" };
}

/** Whole copies' fills at once, each this many of its blocks in flight (the slots are shared: `slot`). */
const FILL_EACH = 3;
/** A whole copy's blocks are let go this long after it's made (a read under way from them finishes from them). */
export const fillHooks = { dropAfterMs: 60_000 };

/**
 * `key` whole into `local`, through its blocks: each read in the fill's lane, behind every read a person waits on
 * and every read ahead of the playhead, so a copy coming down never holds up the picture (see `Priority`), then
 * joined into `local` (whole or not at all) and its blocks let go a minute later. Its stretches are ready to play
 * as their blocks land (playback_ready.ts), not only once the whole copy is in.
 */
export async function fetchWhole(root: string, key: string, local: string, url: BlockSource): Promise<void> {
  await block(root, key, 0, url, "fill");
  const folder = folderOf(root, key);
  const meta = metaOf(folder);
  if (meta === null) throw new Error(`${key}: no size known after its first block`);
  const last = Math.floor((meta.size - 1) / BLOCK);
  let next = 1;
  const worker = async () => {
    while (next <= last) {
      const index = next++;
      if (!fs.existsSync(join(folder, `${index}`))) await block(root, key, index, url, "fill");
    }
  };
  await Promise.all(Array.from({ length: FILL_EACH }, worker));
  const part = `${local}.${process.pid}.part`;
  fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
  const fd = fs.openSync(part, "w");
  let written = 0;
  try {
    for (let index = 0; index <= last; index++) {
      // From disk (a block the cleaner took meanwhile is read again).
      const bytes = await block(root, key, index, url, "fill");
      fs.writeSync(fd, bytes);
      written += bytes.length;
    }
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(part, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  if (written !== meta.size) {
    fs.rmSync(part, { force: true });
    throw new Error(`${key}: ${written} bytes joined of ${meta.size}`);
  }
  fs.renameSync(part, local);
  setTimeout(() => {
    if (fs.existsSync(local)) fs.rmSync(folder, { recursive: true, force: true });
  }, fillHooks.dropAfterMs).unref?.();
}

/** For tests: nothing queued or in flight. */
export function resetForTests(): void {
  reading.clear();
  queued.clear();
  for (const lane of ORDER) lanes[lane].length = 0;
  inFlight = 0;
  fillsInFlight = 0;
}
