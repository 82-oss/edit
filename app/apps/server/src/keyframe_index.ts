// Where an MP4's or MOV's keyframes are, read from its index (the moov box's
// sample tables), not from its pictures. An excerpt has to start on a keyframe
// to be cut without re-encoding, and that was found by ffprobe reading every
// packet from 20 s (then 2 min, then 10 min) before the excerpt to it: over a
// cloud original's presigned URL that is 40 MB or more of footage for each
// excerpt, and on JJ's line beside three other excerpts it passed its two
// minutes (Nov 18–19, an Axon bodycam's 6.3 GB, 52-minute
// MartyBlank_202604201718_BWL7148938-1.mp4, its index at the end, a keyframe
// every 8.3 s: "Finding the excerpt's keyframe took more than 2 min and was
// stopped", twice, then handed to him as a file that couldn't be downloaded).
// The index is a few ranged reads (its header, the box after the footage, the
// index itself: 5 MB for that file) read once a file and kept, and its
// keyframes are the very ones FFmpeg's seek lands on (its sync samples).
//
// The index is parsed as playback's own is (mp4_index.ts). A file whose
// index this doesn't read (not an MP4 or MOV, a fragmented one) is null, and
// the caller asks ffprobe as before.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import * as steps from "./import_steps.ts";
import * as mp4Index from "./mp4_index.ts";
import * as tools from "./tools.ts";

/** An index bigger than this isn't read (a 52-minute bodycam's is 5 MB). */
const MOST_INDEX_BYTES = 256 * 1024 * 1024;
/** What's read first: a file's opening boxes are usually all in it. */
const FIRST_READ = 64 * 1024;
/** Files whose keyframes are kept (a script's few dozen originals). */
const KEPT = 64;

/** Keyframe times by file (a URL by its object, never its signature), read once each. */
const kept = new Map<string, Promise<number[] | null>>();

/** For tests: what's been read from where, by file. */
export const reads = { count: 0, bytes: 0 };

/**
 * The presentation times (seconds, ascending, as ffprobe prints a frame's
 * `pts_time`) of the sync samples of `path`'s first video track; [] for a
 * file with no picture; null when its index can't be read this way.
 * Throws when the file can't be read at all (a dropped connection), and
 * `StepTimedOut` past `steps.LIMITS.probe`.
 */
export function keyframeTimes(path: string): Promise<number[] | null> {
  const key = identity(path);
  if (key === null) return Promise.resolve(null);
  const known = kept.get(key);
  if (known !== undefined) return known;
  const reading = read(path).catch((error: unknown) => {
    kept.delete(key);
    throw error;
  });
  kept.set(key, reading);
  while (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  return reading;
}

/** For tests: nothing kept. */
export function forget(): void {
  kept.clear();
  reads.count = 0;
  reads.bytes = 0;
}

/** What a file is known by: a URL's object (its query is a signature that changes), a file's path with its size and time. */
function identity(path: string): string | null {
  if (tools.isUrl(path)) return path.split("?")[0]!;
  try {
    const stat = fs.statSync(path);
    return `${path}\u0000${stat.size}\u0000${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

interface Reader {
  size: number;
  at(offset: number, length: number): Promise<Uint8Array>;
}

async function read(path: string): Promise<number[] | null> {
  const ms = steps.LIMITS.probe;
  const signal = AbortSignal.timeout(ms);
  try {
    const reader = tools.isUrl(path) ? await urlReader(path, signal) : fileReader(path);
    if (reader === null) return null;
    const moov = await findMoov(reader);
    if (moov === null) return null;
    const index = mp4Index.fromMoov(moov);
    // As ffprobe prints a frame's time (so an excerpt's start, and its name, are what they were).
    return typeof index === "string" ? null : mp4Index.keyframes(index).map((t) => Math.round(t * 1e6) / 1e6).filter((t) => t >= 0);
  } catch (error) {
    if (signal.aborted) throw new steps.StepTimedOut("Reading the footage's index", ms, false);
    throw error;
  }
}

function fileReader(path: string): Reader | null {
  let size: number;
  try {
    size = fs.statSync(path).size;
  } catch {
    return null;
  }
  return {
    size,
    async at(offset, length) {
      const out = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      const fd = fs.openSync(path, "r");
      try {
        let done = 0;
        while (done < out.length) {
          const got = fs.readSync(fd, out, done, out.length - done, offset + done);
          if (got <= 0) break;
          done += got;
        }
        reads.count++;
        reads.bytes += done;
        return out.subarray(0, done);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/** A presigned URL read by ranges; its size from the first answer's Content-Range. */
async function urlReader(url: string, signal: AbortSignal): Promise<Reader | null> {
  const get = async (from: number, to: number): Promise<{ bytes: Uint8Array; total: number | null }> => {
    let answer: Response;
    try {
      answer = await fetch(url, { headers: { range: `bytes=${from}-${to}` }, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`couldn't read the footage in the cloud: ${diag.scrub(diag.messageOf(error))}`);
    }
    if (answer.status !== 206 && !(answer.status === 200 && from === 0)) {
      await answer.body?.cancel().catch(() => {});
      throw new Error(`couldn't read the footage in the cloud (${answer.status})`);
    }
    const total = /\/(\d+)$/u.exec(answer.headers.get("content-range") ?? "")?.[1];
    const bytes = new Uint8Array(await answer.arrayBuffer());
    reads.count++;
    reads.bytes += bytes.length;
    // A server that ignored the range sent the whole file: only what was asked is kept.
    return { bytes: answer.status === 200 ? bytes.subarray(0, to + 1) : bytes, total: total === undefined ? (answer.status === 200 ? bytes.length : null) : Number(total) };
  };
  const first = await get(0, FIRST_READ - 1);
  if (first.total === null) return null;
  const size = first.total;
  return {
    size,
    async at(offset, length) {
      const end = Math.min(offset + length, size);
      if (end <= offset) return new Uint8Array(0);
      if (end <= first.bytes.length) return first.bytes.subarray(offset, end);
      return (await get(offset, end - 1)).bytes;
    },
  };
}

/** The moov box (its header first), found by walking the top-level boxes (the footage's mdat skipped by its size); null when there's none to read. */
async function findMoov(reader: Reader): Promise<Uint8Array | null> {
  let offset = 0;
  for (let boxes = 0; boxes < 64 && offset + 8 <= reader.size; boxes++) {
    const head = await reader.at(offset, 16);
    if (head.length < 8) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = fourcc(view, 4);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = Number(view.getBigUint64(8));
      header = 16;
    } else if (size === 0) size = reader.size - offset;
    if (size < header) return null;
    // Only ISO media: a file that doesn't open with one of its boxes is another kind (MKV, AVI, TS).
    if (boxes === 0 && !["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].includes(type)) return null;
    if (type === "moof") return null;
    if (type === "moov") {
      if (size > MOST_INDEX_BYTES) return null;
      const box = await reader.at(offset, size);
      return box.length < size ? null : box;
    }
    offset += size;
  }
  return null;
}

function fourcc(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}
