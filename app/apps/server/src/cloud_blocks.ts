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
import { outOfSpace } from "./export_prep.ts";
import { nextFileId } from "./files.ts";
import * as mp4 from "./mp4_index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import { WORK_FLOOR_BYTES, freeBytes } from "./storage.ts";

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
type Waiter = { go: () => void; priority: Priority; filling?: boolean; key?: string };
const lanes: Record<Priority, Waiter[]> = { asked: [], ahead: [], fill: [] };
/** The block reads still waiting for a slot, by id: one someone now waits on moves up. */
const queued = new Map<string, Waiter>();

let fillsInFlight = 0;

/**
 * How many whole copies' fills may read at once while a play is shown, by the line's measured speed down (bits a
 * second; null: not measured). Until Nov 20 a play (or a play held on its spinner) gave the fills no slot at all, so
 * nothing but the play's own next seconds came down until someone paused for 10–30 minutes ("only working after we
 * have waited a substantial amount of time", Sphe). A play gives way to the CPU and disk work (playing.ts `whenIdle`:
 * subtitle reads, censor checks, renders), not to the line: the fills sit behind every read asked and read ahead in
 * the lanes, and a fill read takes one 2 MiB block. A proxy plays at 2–4.4 Mbit/s (0.25–0.55 MB/s), a page's play
 * reads 2–3 files at once:
 * - an 8 Mbit/s home line: one fill beside the play (a block every ~2 s), the play keeping the rest;
 * - 20 Mbit/s and up (a 50 Mbit/s line): two, each read ~2–3× faster than the play's own blocks are needed;
 * - under 8 Mbit/s, or not measured yet: none, but for the files the timeline plays in the next minute (`soon`),
 *   which the play is about to need and stalls without.
 * Nothing here takes the CPU or the disk an 8 GB M1 plays with: a fill is a network read written as it lands (the
 * joins off the server's thread, `fetchWhole`).
 */
export function fillsWhilePlaying(bps: number | null): number {
  if (bps === null || !(bps > 0)) return 0;
  if (bps >= 20_000_000) return 2;
  if (bps >= 8_000_000) return 1;
  return 0;
}

/** Seams: the line's measured speed down (export_speeds.ts `download_bps`, in bytes a second: set at the server's start). */
export const laneHooks = {
  downloadBytesPerSecond: (): number | null => null,
  /** `bytes` of blocks landed in `seconds` with reads in flight throughout: the line's speed, as measured here (`measure`). */
  measured: (_bytes: number, _seconds: number): void => {},
};

/**
 * The line's speed, from the blocks themselves (Nov 21): only the footage dialog measured it, so a Mac that never showed
 * the dialog counted as unmeasured and brought down nothing but the next minute's files during a play. While reads are
 * in flight without a break, what lands in five seconds or more (8 MB at least) is the line's speed, or a little
 * under it; a break in the reads starts the clock again, so quiet time between a play's own reads is never counted as
 * a slow line.
 */
let meter: { from: number; bytes: number } | null = null;
function measure(bytes: number): void {
  const now = performance.now();
  if (meter === null) {
    // The first block starts the clock: how long it took itself isn't known here.
    meter = { from: now, bytes: 0 };
    return;
  }
  meter.bytes += bytes;
  const seconds = (now - meter.from) / 1000;
  if (seconds < 5 || meter.bytes < 8_000_000) return;
  laneHooks.measured(meter.bytes, seconds);
  meter = { from: now, bytes: 0 };
}

/**
 * Keys whose whole copies the play needs next (the timeline's next minute from the playhead, or a jump's file being read
 * now: local_previews.ts), so their fills go during a play however slow the line (one at a time on a line too slow for
 * any other). Set again as the playhead moves.
 */
let soon: ReadonlySet<string> = new Set();
export function setSoon(keys: ReadonlySet<string>): void {
  soon = keys;
  pump();
}
export function isSoon(key: string): boolean {
  return soon.has(key);
}

/** How many whole copies' fills may read at once now, of copies the play doesn't need next (local_previews.ts starts none of those while it's 0). */
export function fillsAllowed(): number {
  return fillLimit(undefined);
}

/** The fills that may read at once now (`key`: the copy asking), by whether a play is shown (playing.ts `showing`: a play held on its spinner shows nothing, so the fills run as at rest). */
function fillLimit(key: string | undefined): number {
  if (!playing.showing()) return FILLS_AT_ONCE;
  const bps = laneHooks.downloadBytesPerSecond();
  const most = fillsWhilePlaying(bps === null ? null : bps * 8);
  return key !== undefined && soon.has(key) ? Math.max(1, most) : most;
}

/**
 * Whether a read in `priority` waits: every slot taken, or (a fill) the fills' share taken. Until Nov 20 a fill got no
 * slot at all while anything played or held (kenobi, Nov 17: a cold play on an M1 passed over 515 frames in 23 s with
 * every whole copy coming down beside it; the CPU work beside it is what's gated now, the fills only thinned).
 */
const full = (priority: Priority, key?: string) => inFlight >= AT_ONCE || (priority === "fill" && fillsInFlight >= fillLimit(key));

/** A read given its slot: counted as what it is now (one moved up while it waited counts as what it was moved to). */
function take(waiter: Waiter): void {
  inFlight++;
  waiter.filling = waiter.priority === "fill";
  if (waiter.filling) fillsInFlight++;
}

/** Waiting reads let go into the slots free, the most wanted lane first (a fill of a file the play needs next ahead of other fills). */
function pump(): void {
  for (;;) {
    if (inFlight >= AT_ONCE) return;
    let waiter: Waiter | undefined;
    for (const lane of ORDER) {
      const at = lanes[lane].findIndex((one) => !full(lane, one.key));
      if (at < 0) continue;
      // A fill of a file the play needs next goes before the other fills.
      const first = lane === "fill" ? lanes.fill.findIndex((one) => one.key !== undefined && soon.has(one.key) && !full(lane, one.key)) : -1;
      waiter = lanes[lane].splice(first >= 0 ? first : at, 1)[0];
      break;
    }
    if (waiter === undefined) return;
    take(waiter);
    waiter.go();
  }
}

// A play's start, hold or stop changes the fills' share.
playing.onShowChange(() => pump());

async function slot<T>(id: string, priority: Priority, work: () => Promise<T>, key?: string): Promise<T> {
  const waiter: Waiter = { go: () => {}, priority, key };
  if (full(priority, key)) {
    await new Promise<void>((resolve) => {
      waiter.go = resolve;
      queued.set(id, waiter);
      lanes[priority].push(waiter);
    });
    queued.delete(id);
  } else take(waiter);
  try {
    return await work();
  } finally {
    inFlight--;
    if (waiter.filling === true) fillsInFlight--;
    pump();
    // Nothing reading: what lands next isn't measured against the quiet before it.
    if (inFlight === 0) meter = null;
  }
}

/** A block read waiting in a lane below `priority` that's now wanted sooner: up to it. */
function hurryBlock(id: string, priority: Priority): void {
  // Still being signed: it takes its slot as the sooner one.
  const want = signing.get(id);
  if (want !== undefined && ORDER.indexOf(want.priority) > ORDER.indexOf(priority)) want.priority = priority;
  const waiter = queued.get(id);
  if (waiter === undefined || ORDER.indexOf(waiter.priority) <= ORDER.indexOf(priority)) return;
  const at = lanes[waiter.priority].indexOf(waiter);
  if (at < 0) return;
  lanes[waiter.priority].splice(at, 1);
  waiter.priority = priority;
  lanes[priority].push(waiter);
  // A slot held back from the fills (a play under way) may be free for it now.
  pump();
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
 * Blocks are kept only while the disk keeps the work's floor free after them (storage.ts `WORK_FLOOR_BYTES`): below it a
 * block read is answered from memory and not kept (kenobi, Nov 17: blocks and whole copies wrote until ENOSPC).
 */
function keepable(root: string): boolean {
  return freeBytes(root) - BLOCK >= WORK_FLOOR_BYTES;
}

/** How much over the floor the disk must have for the page to be told blocks are kept (a play's next seconds of every file). */
const KEEPING_MARGIN = 256 * 1024 * 1024;

/**
 * Whether blocks are being kept on this disk: false at its floor, where nothing read is kept and a play waiting for
 * blocks to land waits for nothing (playback_ready.ts `keeping`: the page plays from the stream instead).
 */
export function keeping(root: string): boolean {
  return freeBytes(root) >= WORK_FLOOR_BYTES + KEEPING_MARGIN;
}

/**
 * Blocks read but not kept on disk (its floor, or ENOSPC), held in memory a while, the least lately used let go
 * first: at the floor Edit.app's window reads a stretch ahead of its play (preroll.rs, through `serve`) and its
 * decoder then reads the same stretch, which went to R2 twice. 64 MiB is two to four minutes of a proxy (0.25–0.55
 * MB/s on dev's), well past the window's 10–20 s ahead in several files at once, and little to an 8 GB M1.
 */
export const HELD_BYTES = 64 * 1024 * 1024;
const held = new Map<string, Uint8Array>();
let heldBytes = 0;

function hold(id: string, bytes: Uint8Array): void {
  unhold(id);
  if (bytes.byteLength > HELD_BYTES) return;
  held.set(id, bytes);
  heldBytes += bytes.byteLength;
  for (const [oldest, one] of held) {
    if (heldBytes <= HELD_BYTES) break;
    held.delete(oldest);
    heldBytes -= one.byteLength;
  }
}

function unhold(id: string): void {
  const known = held.get(id);
  if (known === undefined) return;
  heldBytes -= known.byteLength;
  held.delete(id);
}

/** A block held in memory, now the most lately used; or null. */
function heldBlock(id: string): Uint8Array | null {
  const bytes = held.get(id);
  if (bytes === undefined) return null;
  held.delete(id);
  held.set(id, bytes);
  return bytes;
}

/** How much the blocks held in memory take (for tests: it never passes `HELD_BYTES`). */
export function heldInMemory(): { blocks: number; bytes: number } {
  return { blocks: held.size, bytes: heldBytes };
}

/** Writes a small file (a block's meta) whole; false when the disk refused it (ENOSPC). A few bytes: written on the thread. */
function keepSmall(path: string, text: string): boolean {
  const tmp = `${path}.${process.pid}-${nextFileId()}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path);
    return true;
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    if (outOfSpace(error)) return false;
    throw error;
  }
}

/**
 * Writes a block's file whole (to the side, synced, then renamed: a block is there whole or not at all); false when the
 * disk refused it (ENOSPC): the read is answered from memory. Off the server's thread (Nov 20: written, synced and read
 * back synchronously, a block's 2 MiB held every answer, timer and websocket behind it; see `fetchWhole`).
 */
async function keep(path: string, bytes: Uint8Array): Promise<boolean> {
  const tmp = `${path}.${process.pid}-${nextFileId()}.tmp`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tmp, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmp, path);
    return true;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    if (outOfSpace(error)) return false;
    throw error;
  }
}

/** A block kept on disk, read off the server's thread and touched (so the cleaner keeps what's being played longest); null when it isn't there. */
async function readKept(path: string): Promise<Uint8Array | null> {
  // A look first (a stat, microseconds): most asks of a block not here never open it.
  if (!fs.existsSync(path)) return null;
  try {
    const bytes = await fs.promises.readFile(path);
    const now = new Date();
    void fs.promises.utimes(path, now, now).catch(() => {});
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    // Gone between the look and the read (the cleaner took it).
    return null;
  }
}

/**
 * Whole copies being joined (a key's file so far and how many of its blocks are in it), and joined: a block let go
 * once it's in its whole copy is read from there by a read still under way from the blocks.
 */
const joining = new Map<string, { path: string; blocks: number }>();
const joined = new Map<string, string>();

/** Block `index` of `key` from its whole copy here (being joined, or joined), or null; read off the server's thread. */
async function fromCopy(key: string, index: number): Promise<Uint8Array | null> {
  const under = joining.get(key);
  const path = under !== undefined && index < under.blocks ? under.path : joined.get(key);
  if (path === undefined) return null;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(path, "r");
    const out = new Uint8Array(BLOCK);
    const { bytesRead } = await handle.read(out, 0, BLOCK, index * BLOCK);
    return bytesRead > 0 ? out.subarray(0, bytesRead) : null;
  } catch {
    // The copy gone (the cleaner took it, or a join that failed): read again.
    if (joined.get(key) === path) joined.delete(key);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Whether block `index` of `key` is here to read without R2 (on disk, held in memory, or in its whole copy): read-ahead
 * and warming skip those, and only look (a block on disk read and thrown away was 10 MiB of synchronous reads on the
 * event loop for each 2 MiB FFmpeg pulled). A block the cleaner takes after this said yes is read again by `block`.
 */
function isHere(root: string, key: string, index: number): boolean {
  if (held.has(`${key}#${index}`)) return true;
  const under = joining.get(key);
  if ((under !== undefined && index < under.blocks) || joined.has(key)) return true;
  return fs.existsSync(join(folderOf(root, key), `${index}`));
}

/** Block `index` of `key` if it's here (disk, memory, whole copy) without reading R2; null if not. */
async function blockHere(root: string, key: string, index: number): Promise<Uint8Array | null> {
  return (await readKept(join(folderOf(root, key), `${index}`))) ?? heldBlock(`${key}#${index}`) ?? (await fromCopy(key, index));
}

/** Block reads being signed (before they take a slot), by id: one hurried meanwhile takes its slot as the sooner one. */
const signing = new Map<string, { priority: Priority }>();

/**
 * One block of the object, from disk or R2 (once, however many ask), read as soon as `priority` says (`slot`).
 * One someone waits on ("asked": a page's range, the window's FFmpeg) that misses marks the viewer busy; a hit never does.
 * Every read of the disk is off the server's thread, so a loop over blocks (a join, a read to the end) gives the
 * other work a turn between them (Nov 20: a 1.26 GB join held a 50 ms timer for 1.86 s).
 */
async function block(root: string, key: string, index: number, url: BlockSource, priority: Priority = "ahead", hedge = priority === "asked"): Promise<Uint8Array> {
  const id = `${key}#${index}`;
  // Being read now (from R2): not on disk yet, so not looked for there.
  const reading0 = reading.get(id);
  if (reading0 !== undefined) {
    hurryBlock(id, priority);
    return reading0;
  }
  const folder = folderOf(root, key);
  const path = join(folder, `${index}`);
  const kept = await readKept(path);
  if (kept !== null) return kept;
  const inMemory = heldBlock(id);
  if (inMemory !== null) {
    // Room on the disk again: kept there, and let go from memory.
    if (keepable(root) && fs.existsSync(folder)) void keep(path, inMemory).then((done) => done && unhold(id), () => {});
    return inMemory;
  }
  const copied = await fromCopy(key, index);
  if (copied !== null) return copied;
  // Another ask may have started its read while this one looked.
  const known = reading.get(id);
  if (known !== undefined) {
    hurryBlock(id, priority);
    return known;
  }
  if (priority === "asked") noteViewerMiss();
  const read = (async () => {
    // Signed before it takes a slot: the slot is for R2's read, and a relay slow to sign (or a sign-in being
    // renewed, up to 120 s) held all six while reads of keys already signed waited behind them.
    const want = { priority };
    signing.set(id, want);
    let edge: string;
    try {
      edge = await signed(url, priority === "asked");
    } finally {
      signing.delete(id);
    }
    return slot(
      id,
      want.priority,
      async () => {
        const start = index * BLOCK;
        const { answer, bytes } = await fetchBlock(edge, url.direct, start, hedge);
        const total = Number(/\/(\d+)$/.exec(answer.headers.get("content-range") ?? "")?.[1] ?? NaN);
        await fs.promises.mkdir(folder, { recursive: true });
        // Its size is a few bytes, kept even at the floor: a read answered from memory still knows how big the object is.
        if (Number.isFinite(total) && metaOf(folder) === null) keepSmall(join(folder, "meta.json"), JSON.stringify({ size: total, type: answer.headers.get("content-type") ?? "video/mp4", key }));
        if (!keepable(root) || !(await keep(path, bytes))) hold(id, bytes);
        return bytes;
      },
      key,
    );
  })().finally(() => reading.delete(id));
  reading.set(id, read);
  return read;
}

/**
 * How long a read someone waits on lets its URL be signed (ms): past it the read fails in passing (a whole copy is
 * asked again shortly: local_previews.ts), where the relay's own wait is 120 s (cloud.ts). A signing is one round trip
 * to the relay (0.2–0.5 s from South Africa) and kept 5 h after (cloud_media.ts `streamingUrl`), so 10 s is a relay
 * that isn't answering, on an 8 Mbit/s line or a 50 Mbit/s one alike.
 */
export const signHooks = { askedMs: 10_000 };

/** `source` signed; bounded by `signHooks.askedMs` when someone waits on it. */
async function signed(source: () => Promise<string>, asked: boolean): Promise<string> {
  if (!asked) return source();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the relay took more than ${diag.human(signHooks.askedMs)} to sign a read`)), signHooks.askedMs);
  });
  try {
    return await Promise.race([source(), late]);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * From the edge, and for someone waiting, from R2's own URL too once the edge is slow: the first answer wins, the
 * other's dropped. R2's own URL is signed only then, and the edge's read never waits on that signing.
 */
async function readHedged(edgeUrl: string, direct: (() => Promise<string>) | undefined, start: number, hedge: boolean): Promise<{ answer: Response; bytes: Uint8Array }> {
  const stop = new AbortController();
  const edge = readOnce(edgeUrl, start, stop.signal);
  if (!hedge || direct === undefined) return edge;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), hedgeHooks.ms)));
  const early = await Promise.race([edge.then((value) => ({ value }), (error: unknown) => ({ error })), late]);
  clearTimeout(timer);
  if (early !== "late" && "value" in early) return early.value;
  const other = signed(direct, true).then((url) => readOnce(url, start, stop.signal));
  try {
    // The edge failing outright: R2's alone.
    return early !== "late" ? await other : await Promise.any([edge, other]);
  } catch (error) {
    throw error instanceof AggregateError ? error.errors[0] : error;
  } finally {
    stop.abort();
  }
}

/** Bytes of blocks read from the cloud since the server started: how fast footage is coming, whatever lands how (footage_ready.ts). */
let received = 0;
export function receivedBytes(): number {
  return received;
}

/**
 * A block's bytes, tried again on a passing failure (the network's, a timeout, R2's 5xx or 429): a read to the
 * end that failed one block ended its answer short, which FFmpeg reads as "Input/output error".
 */
async function fetchBlock(edge: string, direct: (() => Promise<string>) | undefined, start: number, hedge: boolean): Promise<{ answer: Response; bytes: Uint8Array }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const read = await readHedged(edge, direct, start, hedge);
      received += read.bytes.length;
      measure(read.bytes.length);
      return read;
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
  // Held in memory (read where none could be kept): here too, while they're held.
  const last = Math.floor((meta.size - 1) / BLOCK);
  if (held.size > 0) for (let index = 0; index <= last; index++) if (held.has(`${key}#${index}`)) here.add(index);
  // Let go into the whole copy being joined: still here to read.
  for (let index = 0; index < (joining.get(key)?.blocks ?? 0); index++) here.add(index);
  return { size: meta.size, here };
}

/** The object's size, once its first block has said it (null: not read yet). */
export function sizeOf(root: string, key: string): number | null {
  return metaOf(folderOf(root, key))?.size ?? null;
}

/** About how many of the object's bytes are kept here in blocks (0: none, or not read yet). */
export function bytesHere(root: string, key: string): number {
  const blocks = blocksHere(root, key);
  return blocks === null ? 0 : Math.min(blocks.size, blocks.here.size * BLOCK);
}

/**
 * Indexes (mp4_index.ts) read lately, by key, the least lately used let go first past `INDEX_BYTES` (a 9-minute
 * proxy's is about 1.1 MB): null for an object with none to read (not a faststart MP4), which is laid out evenly.
 * 96 MB since Nov 21: the team's largest edit (389 media, 4.8 hours of footage) has about 35 MB of indexes, past the
 * 32 MB this was, so every ask of whether it's ready to play read and parsed every file's index again (341 of them,
 * 0.35 s each ask, asked every 0.7 s while playing). 96 MB holds about 13 hours of footage's indexes.
 */
const INDEX_BYTES = 96 * 1024 * 1024;
const INDEX_COUNT = 1024;
const indexes = new Map<string, { size: number; index: mp4.Mp4Index | null }>();
let indexBytes = 0;

function remember(key: string, size: number, index: mp4.Mp4Index | null): void {
  const known = indexes.get(key);
  if (known !== undefined) {
    indexBytes -= known.index?.bytes ?? 0;
    indexes.delete(key);
  }
  indexes.set(key, { size, index });
  indexBytes += index?.bytes ?? 0;
  for (const [oldest, one] of indexes) {
    if ((indexBytes <= INDEX_BYTES && indexes.size <= INDEX_COUNT) || oldest === key) break;
    indexes.delete(oldest);
    indexBytes -= one.index?.bytes ?? 0;
  }
}

/**
 * The object's index from its first blocks: those here only (`url` absent: undefined while they aren't), or read
 * as `priority` says. Null: it has none (not a faststart MP4, or one that doesn't parse).
 */
async function indexFrom(root: string, key: string, url?: BlockSource, priority: Priority = "ahead"): Promise<mp4.Mp4Index | null | undefined> {
  const size = metaOf(folderOf(root, key))?.size;
  if (size === undefined) return undefined;
  const known = indexes.get(key);
  if (known !== undefined && known.size === size) {
    remember(key, size, known.index);
    return known.index;
  }
  const read = async (index: number) => (url === undefined ? await blockHere(root, key, index) : await block(root, key, index, url, priority));
  const first = await read(0);
  if (first === null) return undefined;
  let parsed = mp4.parse(first, size);
  if ("need" in parsed) {
    // Its index passes the first block (a long file's): the blocks it reaches, then once more.
    const need = Math.min(parsed.need, size);
    const all = new Uint8Array(need);
    all.set(first.subarray(0, need));
    for (let index = 1; index * BLOCK < need; index++) {
      const bytes = await read(index);
      if (bytes === null) return undefined;
      all.set(bytes.subarray(0, Math.min(bytes.length, need - index * BLOCK)), index * BLOCK);
    }
    parsed = mp4.parse(all, size);
  }
  const index = "index" in parsed ? parsed.index : null;
  if (index === null) diag.info("cloud", `${key}: no index to read (${"none" in parsed ? parsed.none : "it runs past its end"}): its seconds laid out evenly`);
  remember(key, size, index);
  return index;
}

/** The object's index from blocks here (undefined: not here yet; null: it has none). For `playback_ready.ts`. */
export async function indexHere(root: string, key: string): Promise<mp4.Mp4Index | null | undefined> {
  return indexFrom(root, key);
}

/**
 * Seconds `from..to` of the object (`duration` long) read into blocks: exactly the blocks a reader needs for them,
 * from its index (mp4_index.ts: every sample of every track there, from the keyframe before `from`, and the index
 * itself); an object with none, the bytes as if laid out evenly and a block either side. Behind what anyone waits
 * on, or as one (`priority` "asked": the seconds a held play waits for). Resolves once they're here; how many were read.
 */
export async function warm(root: string, key: string, from: number, to: number, duration: number, url: BlockSource, priority: "asked" | "ahead" = "ahead"): Promise<number> {
  await block(root, key, 0, url, priority);
  const meta = metaOf(folderOf(root, key));
  if (meta === null) return 0;
  const last = Math.floor((meta.size - 1) / BLOCK);
  const index = await indexFrom(root, key, url, priority);
  let wanted: number[];
  if (index) wanted = mp4.blocksFor(index, from, to, BLOCK).filter((one) => one <= last);
  else {
    const fraction = (seconds: number) => (duration > 0 ? Math.max(0, Math.min(1, seconds / duration)) : 0);
    const first = Math.max(0, Math.min(last, Math.floor((fraction(from) * meta.size) / BLOCK) - 1));
    const end = Math.max(first, Math.min(last, Math.floor((fraction(to) * meta.size) / BLOCK) + 1));
    wanted = Array.from({ length: end - first + 1 }, (_, n) => first + n);
  }
  const reads: Promise<Uint8Array>[] = [];
  for (const one of wanted) if (!isHere(root, key, one)) reads.push(block(root, key, one, url, priority));
  await Promise.all(reads);
  return reads.length;
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
  if (open && known !== undefined) {
    for (let n = 1; n <= STREAM_AHEAD && (first + n) * BLOCK < known; n++) if (!isHere(root, key, first + n)) void block(root, key, first + n, url, "ahead", true).catch(() => {});
  }
  // Not here: its first bytes straight from R2's own URL while its block lands (kept for the next read), so the
  // reader starts on one round trip, not on a whole 2 MiB block (a cold open-and-seek took 1.1–2.7 s that way).
  const cold = !isHere(root, key, first);
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
      if (next * BLOCK < total && !isHere(root, key, next)) void block(root, key, next, url, "ahead", open).catch((error: unknown) => diag.warn("cloud", `reading ahead in ${key}: ${diag.messageOf(error)}`));
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
  const answer = await fetch(await signed(direct, true), { headers: { range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(30_000) });
  const size = Number(/\/(\d+)$/.exec(answer.headers.get("content-range") ?? "")?.[1] ?? NaN);
  if (answer.status !== 206 || answer.body === null || !Number.isFinite(size)) {
    void answer.body?.cancel();
    throw new Error(`R2 answered ${answer.status} to a first read`);
  }
  return { reader: answer.body.getReader() as ReadableStreamDefaultReader<Uint8Array>, size, type: answer.headers.get("content-type") ?? "video/mp4" };
}

/** Whole copies' fills at once, each this many of its blocks in flight (the slots are shared: `slot`). */
const FILL_EACH = 3;

/**
 * Whether block `index` (`bytes`, as `block` gave it) is on disk now, written there if it was held in memory and the
 * disk has room again: `block` only starts that write, and a whole copy looking for the file before it landed stopped
 * as "no room" with room back (Nov 21 audit).
 */
async function keptOnDisk(root: string, folder: string, key: string, index: number, bytes: Uint8Array): Promise<boolean> {
  const path = join(folder, `${index}`);
  if (fs.existsSync(path)) return true;
  if (!keepable(root)) return false;
  await fs.promises.mkdir(folder, { recursive: true });
  if (!(await keep(path, bytes))) return false;
  unhold(`${key}#${index}`);
  return true;
}

/** A whole copy stopped for want of room: its blocks would take the disk under its floor (storage.ts). */
export class NoRoom extends Error {
  constructor(message = "the disk too full to keep it whole") {
    super(message);
  }
}

/**
 * `key` whole into `local`, through its blocks: each read in the fill's lane, behind every read a person waits on
 * and every read ahead of the playhead, so a copy coming down never holds up the picture (see `Priority`), and fewer
 * beside a play that's shown (`fillsWhilePlaying`); then joined into `local` (whole or not at all, off the server's
 * thread), each block let go as it goes in, so a copy
 * takes its own size on the disk, not twice it (until Nov 17 its blocks stayed a minute beside it). Its stretches
 * are ready to play as their blocks land (playback_ready.ts), not only once the whole copy is in.
 *
 * `room` is told the bytes still to write once the first block says the object's size, and again as blocks land;
 * false from it (no room for that) stops the copy with `NoRoom`, as does a block the disk's floor won't let be kept.
 */
export async function fetchWhole(root: string, key: string, local: string, url: BlockSource, room: (left: number, size: number) => boolean = () => true): Promise<void> {
  if (!keepable(root) && !fs.existsSync(join(folderOf(root, key), "0"))) throw new NoRoom();
  await block(root, key, 0, url, "fill");
  const folder = folderOf(root, key);
  const meta = metaOf(folder);
  if (meta === null) throw new Error(`${key}: no size known after its first block`);
  const last = Math.floor((meta.size - 1) / BLOCK);
  const missing = new Set<number>();
  for (let index = 0; index <= last; index++) if (!fs.existsSync(join(folder, `${index}`))) missing.add(index);
  const left = () => Math.min(meta.size, missing.size * BLOCK);
  if (!room(left(), meta.size)) throw new NoRoom();
  let next = 1;
  const worker = async () => {
    while (next <= last) {
      const index = next++;
      if (!missing.has(index)) continue;
      if (!keepable(root)) throw new NoRoom();
      if (!(await keptOnDisk(root, folder, key, index, await block(root, key, index, url, "fill")))) throw new NoRoom();
      missing.delete(index);
      room(left(), meta.size);
    }
  };
  await Promise.all(Array.from({ length: FILL_EACH }, worker));
  // Joined through a file handle, each block read and written off the server's thread: until Nov 20 the join was one
  // synchronous stretch (a block on disk read with readFileSync, written with writeSync, unlinked, the next at once),
  // and nothing else in Edit ran for its length: 1.26 GB held a 50 ms timer for 1.86 s on mandalorian's SSD, warm,
  // and a cold open joins every file's copy exactly while the person is trying to play.
  const part = `${local}.${process.pid}.part`;
  await fs.promises.mkdir(local.slice(0, local.lastIndexOf("/")), { recursive: true });
  const handle = await fs.promises.open(part, "w");
  const into = { path: part, blocks: 0 };
  joining.set(key, into);
  let written = 0;
  try {
    for (let index = 0; index <= last; index++) {
      // From disk (a block the cleaner took meanwhile is read again).
      const bytes = await block(root, key, index, url, "fill");
      await writeAll(handle, bytes, index * BLOCK);
      written += bytes.length;
      // Readable from the copy from here on, so the block can go.
      into.blocks = index + 1;
      await fs.promises.rm(join(folder, `${index}`), { force: true });
    }
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    joining.delete(key);
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw outOfSpace(error) ? new NoRoom() : error;
  }
  if (written !== meta.size) {
    joining.delete(key);
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw new Error(`${key}: ${written} bytes joined of ${meta.size}`);
  }
  await fs.promises.rename(part, local);
  joined.set(key, local);
  joining.delete(key);
  await fs.promises.rm(folder, { recursive: true, force: true });
}

/** `bytes` written whole at `at` (a write may take fewer than it's given). */
async function writeAll(handle: fs.promises.FileHandle, bytes: Uint8Array, at: number): Promise<void> {
  for (let done = 0; done < bytes.length; ) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, at + done);
    if (bytesWritten <= 0) throw new Error("the disk took nothing of a block");
    done += bytesWritten;
  }
}

/** For tests: nothing queued or in flight. */
export function resetForTests(): void {
  meter = null;
  reading.clear();
  held.clear();
  heldBytes = 0;
  indexes.clear();
  indexBytes = 0;
  joining.clear();
  joined.clear();
  queued.clear();
  signing.clear();
  soon = new Set();
  for (const lane of ORDER) lanes[lane].length = 0;
  inFlight = 0;
  fillsInFlight = 0;
}
