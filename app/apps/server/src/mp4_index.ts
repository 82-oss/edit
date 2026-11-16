// Where each second of an MP4 lies in its bytes, from its own sample tables.
//
// A streamed proxy's blocks (cloud_blocks.ts) were mapped to seconds as if its
// bytes were spread evenly over its length, and proxies aren't (H.264 + AAC,
// faststart, half-second keyframes, a bitrate that follows the picture): on
// kenobi (Nov 17) "ready" said the next seconds were here while the window's
// decoder waited 0.8–1.25 s on blocks that weren't. The `moov` at a faststart
// file's start says, for every sample of every track, its time and its bytes:
// read once, it answers which bytes a stretch needs and which seconds the bytes
// here hold. A file that isn't a faststart MP4, or whose index doesn't parse,
// has none (`parse` says so) and its reader falls back on the even spread.

/** One track's samples, in decode order: when each is shown (seconds, edit list applied) and where its bytes are. */
interface Track {
  kind: "video" | "audio";
  count: number;
  /** Presentation time of each sample, seconds. */
  start: Float64Array;
  /** Where its bytes start in the file, and how many. */
  offset: Float64Array;
  size: Uint32Array;
  /** Decode indices of the sync samples (keyframes), ascending; null: every sample is one. */
  sync: Uint32Array | null;
  /** Decode indices in presentation order, when the two differ (B-frames); null: the same. */
  order: Uint32Array | null;
  /** Where the track's last sample ends, seconds. */
  end: number;
}

export interface Mp4Index {
  /** Bytes from the file's start through its `moov`: what a reader needs before any sample. */
  head: number;
  tracks: Track[];
  /** About how much memory it takes (for the cache that keeps it). */
  bytes: number;
}

export type Parsed = { index: Mp4Index } | { need: number } | { none: string };

/** A `moov` past this is no proxy of ours: not read. */
const MOOV_MAX = 64 * 1024 * 1024;

type Box = { type: string; start: number; body: number; end: number };

function boxes(view: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7));
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(view.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) throw new Error(`a ${type} box runs past its parent`);
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

const child = (view: DataView, parent: Box, type: string) => boxes(view, parent.body, parent.end).find((one) => one.type === type);

/**
 * The index of an MP4 whose first `bytes` are given (`total`: the file's size): `{ need }` when its `moov` runs past
 * them (read that many and ask again), `{ none }` when it has no index at its start to read.
 */
export function parse(bytes: Uint8Array, total: number): Parsed {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 8 <= Math.min(bytes.length, total)) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size === 1) {
      if (at + 16 > bytes.length) return { need: at + 16 };
      size = Number(view.getBigUint64(at + 8));
    } else if (size === 0) size = total - at;
    if (size < 8 || !/^[\x20-\x7e]{4}$/.test(type)) return { none: "not an MP4" };
    if (type === "mdat") return { none: "its index isn't at its start" };
    if (type === "moov") {
      if (size > MOOV_MAX) return { none: `its index is ${size} bytes` };
      if (at + size > bytes.length) return { need: at + size };
      try {
        return { index: moov(view, { type, start: at, body: at + 8, end: at + size }) };
      } catch (error) {
        return { none: error instanceof Error ? error.message : String(error) };
      }
    }
    at += size;
  }
  return at >= total ? { none: "no index" } : { need: at + 16 };
}

function moov(view: DataView, box: Box): Mp4Index {
  const mvhd = child(view, box, "mvhd");
  const movieScale = mvhd === undefined ? 0 : view.getUint32(mvhd.body + (view.getUint8(mvhd.body) === 1 ? 20 : 12));
  const tracks: Track[] = [];
  for (const trak of boxes(view, box.body, box.end)) {
    if (trak.type !== "trak") continue;
    const track = trackOf(view, trak, movieScale);
    if (track !== null) tracks.push(track);
  }
  if (tracks.length === 0) throw new Error("no picture or sound in its index");
  const bytes = tracks.reduce((sum, one) => sum + one.count * 21 + (one.sync?.length ?? 0) * 4 + (one.order?.length ?? 0) * 4, 0);
  return { head: box.end, tracks, bytes };
}

function trackOf(view: DataView, trak: Box, movieScale: number): Track | null {
  const mdia = child(view, trak, "mdia");
  const hdlr = mdia && child(view, mdia, "hdlr");
  const mdhd = mdia && child(view, mdia, "mdhd");
  const stbl = mdia && child(view, mdia, "minf") && child(view, child(view, mdia, "minf")!, "stbl");
  if (hdlr === undefined || mdhd === undefined || stbl === undefined) return null;
  const handler = String.fromCharCode(view.getUint8(hdlr.body + 8), view.getUint8(hdlr.body + 9), view.getUint8(hdlr.body + 10), view.getUint8(hdlr.body + 11));
  const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : null;
  if (kind === null) return null;
  const scale = view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12));
  if (!(scale > 0)) throw new Error("a track with no timescale");
  const table = (type: string) => child(view, stbl, type);

  // Sizes.
  let sizes: Uint32Array;
  const stsz = table("stsz");
  const stz2 = table("stz2");
  if (stsz !== undefined) {
    const fixed = view.getUint32(stsz.body + 4);
    const count = view.getUint32(stsz.body + 8);
    sizes = new Uint32Array(count);
    if (fixed !== 0) sizes.fill(fixed);
    else for (let n = 0; n < count; n++) sizes[n] = view.getUint32(stsz.body + 12 + n * 4);
  } else if (stz2 !== undefined) {
    const field = view.getUint8(stz2.body + 7);
    const count = view.getUint32(stz2.body + 8);
    sizes = new Uint32Array(count);
    for (let n = 0; n < count; n++) {
      const at = stz2.body + 12;
      sizes[n] = field === 4 ? (view.getUint8(at + (n >> 1)) >> (n & 1 ? 0 : 4)) & 15 : field === 8 ? view.getUint8(at + n) : view.getUint16(at + n * 2);
    }
  } else throw new Error("a track with no sample sizes");
  const count = sizes.length;
  if (count === 0) return null;

  // Offsets: each chunk's start, its samples one after another (stsc says how many each chunk holds).
  const stco = table("stco");
  const co64 = table("co64");
  const chunkBox = stco ?? co64;
  const stsc = table("stsc");
  if (chunkBox === undefined || stsc === undefined) throw new Error("a track with no chunk offsets");
  const chunks = view.getUint32(chunkBox.body + 4);
  const chunkAt = (n: number) => (stco !== undefined ? view.getUint32(chunkBox.body + 8 + n * 4) : Number(view.getBigUint64(chunkBox.body + 8 + n * 8)));
  const runs = view.getUint32(stsc.body + 4);
  const offset = new Float64Array(count);
  let sample = 0;
  for (let run = 0; run < runs && sample < count; run++) {
    const first = view.getUint32(stsc.body + 8 + run * 12) - 1;
    const each = view.getUint32(stsc.body + 8 + run * 12 + 4);
    const next = run + 1 < runs ? view.getUint32(stsc.body + 8 + (run + 1) * 12) - 1 : chunks;
    for (let chunk = first; chunk < next && chunk < chunks && sample < count; chunk++) {
      let at = chunkAt(chunk);
      for (let n = 0; n < each && sample < count; n++) {
        offset[sample] = at;
        at += sizes[sample]!;
        sample++;
      }
    }
  }
  if (sample < count) throw new Error("a track's chunks hold fewer samples than it has");

  // Times: decode deltas (stts), composition offsets (ctts), less the edit list's start.
  const stts = table("stts");
  if (stts === undefined) throw new Error("a track with no sample times");
  const ticks = new Float64Array(count);
  let dts = 0;
  sample = 0;
  const entries = view.getUint32(stts.body + 4);
  let lastDelta = 0;
  for (let entry = 0; entry < entries && sample < count; entry++) {
    const many = view.getUint32(stts.body + 8 + entry * 8);
    lastDelta = view.getUint32(stts.body + 8 + entry * 8 + 4);
    for (let n = 0; n < many && sample < count; n++) {
      ticks[sample++] = dts;
      dts += lastDelta;
    }
  }
  for (; sample < count; sample++) {
    ticks[sample] = dts;
    dts += lastDelta;
  }
  const ctts = table("ctts");
  let reordered = false;
  if (ctts !== undefined) {
    const many = view.getUint32(ctts.body + 4);
    sample = 0;
    for (let entry = 0; entry < many && sample < count; entry++) {
      const run = view.getUint32(ctts.body + 8 + entry * 8);
      const shift = view.getInt32(ctts.body + 8 + entry * 8 + 4);
      for (let n = 0; n < run && sample < count; n++) {
        ticks[sample] = ticks[sample]! + shift;
        sample++;
      }
    }
  }
  let mediaTime = 0;
  let delay = 0;
  const elst = (() => {
    const edts = child(view, trak, "edts");
    return edts && child(view, edts, "elst");
  })();
  if (elst !== undefined) {
    const wide = view.getUint8(elst.body) === 1;
    const many = view.getUint32(elst.body + 4);
    for (let entry = 0; entry < many; entry++) {
      const at = elst.body + 8 + entry * (wide ? 20 : 12);
      const duration = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
      const time = wide ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
      // An empty edit first holds the track back; the first real one says where its media starts.
      if (time === -1) {
        if (movieScale > 0) delay += duration / movieScale;
        continue;
      }
      mediaTime = time;
      break;
    }
  }
  const start = new Float64Array(count);
  for (let n = 0; n < count; n++) {
    start[n] = (ticks[n]! - mediaTime) / scale + delay;
    if (n > 0 && start[n]! < start[n - 1]!) reordered = true;
  }
  const end = Math.max(...(reordered ? [...start.slice(-8)] : [start[count - 1]!])) + lastDelta / scale;
  let order: Uint32Array | null = null;
  if (reordered) order = Uint32Array.from({ length: count }, (_, n) => n).sort((a, b) => start[a]! - start[b]!);

  // Keyframes (none listed: every sample is one).
  const stss = table("stss");
  let sync: Uint32Array | null = null;
  if (stss !== undefined) {
    const many = view.getUint32(stss.body + 4);
    sync = new Uint32Array(many);
    for (let n = 0; n < many; n++) sync[n] = view.getUint32(stss.body + 8 + n * 4) - 1;
    sync.sort();
  }
  return { kind, count, start, offset, size: sizes, sync, order, end };
}

/** The first `n` in [0, length) for which `pass(n)` holds (`pass` false then true), or `length`. */
function search(length: number, pass: (n: number) => boolean): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pass(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The decode indices [first, last] of `track` a reader reads to play `from..to` (seconds): from the keyframe before it. */
function samplesFor(track: Track, from: number, to: number): [number, number] | null {
  if (from >= track.end) return null;
  let first: number;
  let last: number;
  if (track.order === null) {
    // Shown in decode order: the sample showing at `from` (the last starting at or before it) through the last starting before `to`.
    first = Math.max(0, search(track.count, (n) => track.start[n]! > from) - 1);
    last = search(track.count, (n) => track.start[n]! >= to) - 1;
    // Wholly before the track starts: nothing of it.
    if (last < first) return null;
  } else {
    first = track.count;
    last = -1;
    for (let p = 0; p < track.count; p++) {
      const n = track.order[p]!;
      const next = p + 1 < track.count ? track.start[track.order[p + 1]!]! : track.end;
      if (track.start[n]! < to && next > from) {
        first = Math.min(first, n);
        last = Math.max(last, n);
      }
    }
    if (last < 0) return null;
  }
  if (track.sync !== null) {
    const at = search(track.sync.length, (n) => track.sync![n]! > first) - 1;
    first = at >= 0 ? track.sync[at]! : 0;
  } else if (track.kind === "audio") {
    // A sound decoder primes on the sample before.
    first = Math.max(0, first - 1);
  }
  return [first, last];
}

/**
 * The byte ranges ([start, end), sorted, apart) a reader needs to play `from..to` (seconds) of every track: the file's
 * head (its index), and each track's samples from the keyframe before `from` through `to`.
 */
export function rangesFor(index: Mp4Index, from: number, to: number): [number, number][] {
  const ranges: [number, number][] = [[0, index.head]];
  for (const track of index.tracks) {
    const span = samplesFor(track, from, Math.max(to, from));
    if (span === null) continue;
    let open: [number, number] | null = null;
    for (let n = span[0]; n <= span[1]; n++) {
      const a = track.offset[n]!;
      const b = a + track.size[n]!;
      if (open !== null && a === open[1]) open[1] = b;
      else {
        if (open !== null) ranges.push(open);
        open = [a, b];
      }
    }
    if (open !== null) ranges.push(open);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const range of ranges) {
    const last = out.at(-1);
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([range[0], range[1]]);
  }
  return out;
}

/** The blocks (of `block` bytes each, ascending) a reader needs to play `from..to` seconds. */
export function blocksFor(index: Mp4Index, from: number, to: number, block: number): number[] {
  const out: number[] = [];
  for (const [a, b] of rangesFor(index, from, to)) {
    for (let n = Math.max(Math.floor(a / block), (out.at(-1) ?? -1) + 1); n <= Math.floor((b - 1) / block); n++) out.push(n);
  }
  return out;
}

type Spans = [number, number][];

/** `a` and `b` (each sorted, apart) both: the stretches in each. */
function both(a: Spans, b: Spans): Spans {
  const out: Spans = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const from = Math.max(a[i]![0], b[j]![0]);
    const to = Math.min(a[i]![1], b[j]![1]);
    if (to > from) out.push([from, to]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

/**
 * The seconds (sorted, apart) whose every track can be played from the blocks `here` (`block` bytes each): for a
 * picture, each frame here with every frame since its keyframe (what decoding it needs); for sound, each sample
 * here. Before a track starts and after it ends it holds nothing back; the head (the index) must be here.
 */
export function secondsHere(index: Mp4Index, here: (block: number) => boolean, block: number): Spans {
  for (let n = 0; n <= Math.floor((index.head - 1) / block); n++) if (!here(n)) return [];
  let out: Spans = [[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]];
  for (const track of index.tracks) {
    const ok = new Uint8Array(track.count);
    let chain = false;
    let isSync = 0;
    for (let n = 0; n < track.count; n++) {
      const a = track.offset[n]!;
      const b = a + Math.max(1, track.size[n]!);
      let has = true;
      for (let k = Math.floor(a / block); k <= Math.floor((b - 1) / block) && has; k++) has = here(k);
      if (track.sync === null) chain = has;
      else {
        while (isSync < track.sync.length && track.sync[isSync]! < n) isSync++;
        chain = (isSync < track.sync.length && track.sync[isSync] === n) || n === 0 ? has : chain && has;
      }
      ok[n] = chain ? 1 : 0;
    }
    const first = track.order === null ? 0 : track.order[0]!;
    const spans: Spans = [[Number.NEGATIVE_INFINITY, track.start[first]!]];
    for (let p = 0; p < track.count; p++) {
      const n = track.order === null ? p : track.order[p]!;
      if (ok[n] !== 1) continue;
      const from = track.start[n]!;
      const to = p + 1 < track.count ? track.start[track.order === null ? p + 1 : track.order[p + 1]!]! : track.end;
      if (!(to > from)) continue;
      const last = spans.at(-1);
      if (last !== undefined && from <= last[1] + 1e-9) last[1] = Math.max(last[1], to);
      else spans.push([from, to]);
    }
    const last = spans.at(-1);
    if (last !== undefined && last[1] >= track.end - 1e-9) last[1] = Number.POSITIVE_INFINITY;
    else spans.push([track.end, Number.POSITIVE_INFINITY]);
    out = both(out, spans);
  }
  return out;
}
