// A big file from Google Drive in parts at once (Nov 4: one connection from
// Drive got 12-16 MB/s here, four 44 MB/s, eight 70 MB/s; an 83-minute
// recording's 5 GB took 5 min 38 s one at a time). Each part is a range of
// the file, written where it belongs and checked to start there; the parts
// done are noted beside it (`<dest>.parts`), so a download stopped by a
// dropped connection, a stall or a restart carries on with the parts left.
// A part that fails is asked again (a few times, waiting longer each time).
// A part is noted done only once its bytes are on the disk (fsync), so a
// crash or a power cut can't leave a noted part that never landed; and the
// whole is checked against Drive's own MD5 when Drive has one for it.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";

export const ranged = {
  /** Files this big or more come in parts; under it, one connection does (a part's start-up would cost more than it saves). */
  from: 64 << 20,
  /** Bytes a part asks for. */
  part: 32 << 20,
  /** Parts asked for at once. */
  parallel: 8,
  /** A part that gets nothing for this long is dropped and asked again. */
  stallMs: 60_000,
  /** Tries per part. */
  tries: 5,
  /** Waits between a part's tries (tests make them nothing). */
  sleep: (ms: number) => Bun.sleep(ms),
};

interface Journal {
  size: number;
  part: number;
  done: number[];
}

const journalOf = (dest: string) => `${dest}.parts`;

function readJournal(dest: string, size: number): Journal | null {
  try {
    const value = JSON.parse(fs.readFileSync(journalOf(dest), "utf8")) as Journal;
    return value.size === size && value.part === ranged.part && Array.isArray(value.done) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a download of `dest` in parts was begun and not finished (its parts noted beside it). */
export function partlyDone(dest: string): boolean {
  return fs.existsSync(journalOf(dest));
}

/** "bytes 100-199/1000" → 100; null when it doesn't say. */
function rangeStart(header: string | null): number | null {
  const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(header?.trim() ?? "");
  return match === null ? null : Number(match[1]);
}

/** A part that failed in a way asking again can't fix (Drive refused it). */
export class Refused extends Error {}

/**
 * Downloads `size` bytes from `url` to `dest` in parts at once, carrying on
 * from the parts a stopped download noted. `fetch` makes each request (with
 * its sign-in); `onBytes` gets the bytes down so far. Throws when a part
 * fails after its tries (what's done stays noted, for the next try).
 */
export async function download(options: {
  url: string;
  size: number;
  dest: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  onBytes?: (bytes: number) => void;
  signal?: AbortSignal;
  /** Drive's md5Checksum of the file, when the caller has it; else asked of Drive beside the parts (a Drive file's `alt=media` address). */
  md5?: string | null;
}): Promise<void> {
  const { url, size, dest } = options;
  // Asked beside the parts, so it costs no time; a file Drive has no checksum for (a Google Doc, a shortcut) isn't checked.
  const checksum: Promise<string | null> = options.md5 !== undefined ? Promise.resolve(options.md5) : driveMd5(url, options.fetch).catch(() => null);
  const count = Math.ceil(size / ranged.part);
  // Parts noted for a file that's gone (removed as damaged) are no parts.
  const journal = (fs.existsSync(dest) ? readJournal(dest, size) : null) ?? { size, part: ranged.part, done: [] };
  if (journal.done.length === 0) fs.rmSync(dest, { force: true });
  const done = new Set(journal.done);
  const fd = fs.openSync(dest, fs.existsSync(dest) ? "r+" : "w");
  const lengthOf = (n: number) => Math.min(ranged.part, size - n * ranged.part);
  let down = [...done].reduce((sum, n) => sum + lengthOf(n), 0);
  const flowing = new Map<number, number>();
  const report = () => options.onBytes?.(down + [...flowing.values()].reduce((sum, bytes) => sum + bytes, 0));
  report();
  const left = Array.from({ length: count }, (_, n) => n).filter((n) => !done.has(n));
  let failure: unknown = null;

  const fetchPart = async (n: number): Promise<void> => {
    const from = n * ranged.part;
    const to = from + lengthOf(n) - 1;
    const stall = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
    let idle = setTimeout(() => stall.abort(), ranged.stallMs);
    let at = from;
    try {
      const answer = await options.fetch(url, { headers: { range: `bytes=${from}-${to}` }, signal });
      if ([401, 403, 404].includes(answer.status)) throw new Refused(`Google Drive answered ${answer.status}`);
      if (answer.status !== 206 || answer.body === null) throw new Error(`Google Drive answered ${answer.status} to a part`);
      // A part from anywhere but where it was asked would land in the wrong place (Nov 1's damaged 5.3 GB copy).
      if (rangeStart(answer.headers.get("content-range")) !== from) throw new Error(`Google Drive answered part ${n} from ${answer.headers.get("content-range") ?? "nowhere said"}`);
      for await (const chunk of answer.body) {
        clearTimeout(idle);
        idle = setTimeout(() => stall.abort(), ranged.stallMs);
        if (at + chunk.length > to + 1) throw new Error(`part ${n} came down longer than asked`);
        fs.writeSync(fd, chunk, 0, chunk.length, at);
        at += chunk.length;
        flowing.set(n, at - from);
        report();
      }
      if (at !== to + 1) throw new Error(`part ${n} ended at ${at - from} of ${to + 1 - from} bytes`);
    } catch (error) {
      if (stall.signal.aborted && !options.signal?.aborted) throw new Error(`nothing came from Google Drive for ${Math.round(ranged.stallMs / 1000)} s`);
      throw error;
    } finally {
      clearTimeout(idle);
      flowing.delete(n);
    }
  };

  const worker = async () => {
    for (let n = left.shift(); n !== undefined && failure === null; n = left.shift()) {
      for (let attempt = 1; ; attempt++) {
        if (options.signal?.aborted) throw new Error("Stopped.");
        try {
          await fetchPart(n);
          // On the disk before it's noted done: a journal that names a part the disk never got would never fetch it again.
          await new Promise<void>((resolve, reject) => fs.fsync(fd, (error) => (error ? reject(error) : resolve())));
          break;
        } catch (error) {
          if (error instanceof Refused || options.signal?.aborted || attempt >= ranged.tries) throw error;
          diag.warn("drive", `part ${n + 1} of ${count} of ${dest.slice(dest.lastIndexOf("/") + 1)} failed (try ${attempt}): ${diag.messageOf(error)}; asking again`);
          await ranged.sleep(1000 * 2 ** attempt);
        }
      }
      done.add(n);
      down += lengthOf(n);
      report();
      writeAtomic(journalOf(dest), JSON.stringify({ size, part: ranged.part, done: [...done] }));
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(ranged.parallel, Math.max(left.length, 1)) }, () =>
        worker().catch((error: unknown) => {
          failure ??= error;
        }),
      ),
    );
  } finally {
    fs.closeSync(fd);
  }
  if (failure !== null) throw failure;
  const expected = await checksum;
  if (typeof expected === "string" && /^[0-9a-f]{32}$/i.test(expected)) {
    const got = await md5Of(dest);
    if (got !== expected.toLowerCase()) {
      // Damaged on the way: none of it is kept, so the next try fetches it all again.
      fs.rmSync(dest, { force: true });
      fs.rmSync(journalOf(dest), { force: true });
      throw new Error("the file came down damaged (it doesn't match Drive's checksum), so it's fetched again from the start");
    }
  }
  fs.rmSync(journalOf(dest), { force: true });
}

/** Drive's MD5 of the file a `…/drive/v3/files/<id>?alt=media…` address downloads (its metadata, by the same sign-in), or null. */
async function driveMd5(url: string, fetch: (url: string, init: RequestInit) => Promise<Response>): Promise<string | null> {
  if (!/\/drive\/v3\/files\/[^/?]+\?/.test(url) || !/[?&]alt=media(&|$)/.test(url)) return null;
  const answer = await fetch(url.replace(/([?&])alt=media(&|$)/, "$1fields=md5Checksum$2"), {});
  if (!answer.ok) return null;
  const value = (await answer.json()) as { md5Checksum?: unknown };
  return typeof value.md5Checksum === "string" ? value.md5Checksum : null;
}

/** A file's MD5, read through once. */
async function md5Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("md5");
  for await (const chunk of fs.createReadStream(path, { highWaterMark: 4 << 20 })) hasher.update(chunk as Buffer);
  return hasher.digest("hex");
}

/** How long `fetchFile` waits for its next bytes before giving up on a connection (tests make it short). */
export const whole = { stallMs: 60_000 };

/**
 * One file from `url` to `dest` on one connection, written as it comes into
 * `<dest>.part` and renamed in once whole: never `Bun.write(dest, response)`,
 * which on Bun 1.4.0 holds every byte in memory and, from vmake.ai's CDN
 * (Nov 18 live test: an 82 MB result, streamed here in 50 s), never wrote a
 * byte or came back, so a piece vmake.ai showed done was waited on for good.
 * Nothing for `whole.stallMs` ends it, as does `signal`; a body shorter than
 * its Content-Length is refused. Asked again `tries` times, waiting longer each.
 */
export async function fetchFile(url: string, dest: string, options: { signal?: AbortSignal; tries?: number; what?: string } = {}): Promise<void> {
  const partial = `${dest}.part`;
  const what = options.what ?? "the download";
  const tries = options.tries ?? 3;
  for (let attempt = 1; ; attempt++) {
    const stall = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
    let idle = setTimeout(() => stall.abort(), whole.stallMs);
    let fd: number | null = null;
    try {
      const response = await fetch(url, { signal });
      if (response.status !== 200 || response.body === null) throw new Error(`status ${response.status}`);
      const length = Number(response.headers.get("content-length") ?? NaN);
      fd = fs.openSync(partial, "w");
      let at = 0;
      for await (const chunk of response.body) {
        clearTimeout(idle);
        idle = setTimeout(() => stall.abort(), whole.stallMs);
        fs.writeSync(fd, chunk, 0, chunk.length, at);
        at += chunk.length;
      }
      if (Number.isFinite(length) && at !== length) throw new Error(`it ended at ${at} of ${length} bytes`);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(partial, dest);
      return;
    } catch (error) {
      const why = stall.signal.aborted && !options.signal?.aborted ? `nothing came for ${Math.round(whole.stallMs / 1000)} s` : diag.messageOf(error);
      if (fd !== null) fs.closeSync(fd);
      fs.rmSync(partial, { force: true });
      if (options.signal?.aborted || attempt >= tries) throw new Error(`${what}: ${why}`);
      await ranged.sleep(2000 * attempt);
    } finally {
      clearTimeout(idle);
    }
  }
}
