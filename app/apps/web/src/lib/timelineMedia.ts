// The timelines' pictures and waveforms, fetched as they're drawn (the
// server's timeline_media.ts makes and keeps them). Why it's built this way
// (Nov 21, "like on v1 but have them work reliably this time"): V1's page
// asked for a media's sheet or waveform once and remembered a failed answer
// until a reload, so one slow answer blanked a clip for the session.
//
// Here what a draw pass asks for (`frame`, `peaks`) is what's wanted; `flush`
// after the pass fetches what's wanted and missing, a clip's frames in one
// request (a few requests at a time, on the media host beside the viewer's
// reads), and cancels requests for what's no longer wanted (scrolled away). A
// miss or an error is never remembered as missing: it's asked again by itself
// after a pause that grows with each miss in a row (1 s, 2 s, 4 s… 30 s), and
// at once when the page's socket connects again. Until it's in, a block is its
// flat colour. Decoded pictures are kept by their media's version and moment,
// in a budget (lib/decoded-cache.ts).

import { DecodedCache } from "./decoded-cache";
import { mediaHost } from "./api";
import type { Media } from "./types";

/** The height pictures are asked for at (px): the server's ladder (36, 72, 108, 144), for this screen's density. */
export function frameHeight(cssHeight: number, dpr: number): number {
  const want = cssHeight * Math.min(2, Math.max(1, dpr));
  return want <= 36 ? 36 : want <= 72 ? 72 : want <= 108 ? 108 : 144;
}

/** Most times asked for in one request (the server's `MOST_TIMES` is 32). */
const PER_REQUEST = 16;
/** Requests in flight at once: the media host's six connections are the viewer's too. */
const AT_ONCE = 3;
/** Pauses before a miss is asked again (ms), the last for every miss after. */
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export const hooks = {
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
  /** Pictures from their JPEG bytes (a stand-in in tests: jsdom has no createImageBitmap). */
  decode: (bytes: Blob): Promise<CanvasImageSource & { width: number; height: number; close?: () => void }> => createImageBitmap(bytes),
  now: () => Date.now(),
};

type Picture = CanvasImageSource & { width: number; height: number; close?: () => void };

/** A version of a media's file: its render for a graphic, else its path (a media id whose file is replaced is a new version). */
export function versionOf(media: Media): string {
  const text = `${media.effect_key ?? ""}|${media.stacked_alpha === true ? 1 : 0}|${media.path}`;
  let hash = 5381;
  for (let at = 0; at < text.length; at++) hash = ((hash * 33) ^ text.charCodeAt(at)) >>> 0;
  return hash.toString(36);
}

/** `seconds` snapped to the grid a cell `spacing` seconds wide asks on: a power of two of 1/32 s, so neighbouring zooms share frames. */
export function snapTime(seconds: number, spacing: number): number {
  const step = 2 ** Math.max(0, Math.floor(Math.log2(Math.max(spacing, 1 / 32) * 32))) / 32;
  return Math.max(0, Math.round(seconds / step) * step);
}

const millis = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

interface Ask {
  project: string;
  media: string;
  version: string;
  h: number;
  ms: number;
}

interface Miss {
  tries: number;
  at: number;
}

/** Frames and waveforms for one page (one per page in the app; tests make their own). */
export class TimelineMedia {
  readonly frames = new DecodedCache<Picture>(96 * 1024 * 1024, (picture) => picture.close?.());
  readonly peaksCache = new DecodedCache<Uint8Array>(16 * 1024 * 1024, () => {});
  private wanted = new Map<string, Ask>();
  private wantedPeaks = new Map<string, { project: string; media: string }>();
  private flying = new Map<string, { keys: string[]; abort: AbortController }>();
  private misses = new Map<string, Miss>();
  private listeners = new Set<() => void>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumps as pictures and waveforms land: part of what a view's cached layer is drawn from. */
  rev = 0;

  constructor() {
    if (typeof window !== "undefined") window.addEventListener("edit:connected", this.reconnected);
  }

  /** Told each time something lands (or a miss is due again): the view draws again. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A draw pass begins: what it asks for is what's wanted. */
  begin(): void {
    this.wanted.clear();
    this.wantedPeaks.clear();
  }

  /** The frame of `media` at `seconds` of it at height `h`, or null until it's in (asked for at the pass's `flush`). */
  frame(project: string, media: Media, seconds: number, h: number): Picture | null {
    const version = versionOf(media);
    const ms = media.kind === "image" ? 0 : millis(seconds);
    const key = `f|${project}|${media.id}|${version}|${h}|${ms}`;
    const have = this.frames.get(key);
    if (have !== undefined) return have;
    this.wanted.set(key, { project, media: media.id, version, h, ms });
    return null;
  }

  /** The waveform of `media` (100 a second, the server's peaks), or null until it's in. */
  peaks(project: string, media: Media): Uint8Array | null {
    const key = `p|${project}|${media.id}|${versionOf(media)}`;
    const have = this.peaksCache.get(key);
    if (have !== undefined) return have;
    this.wantedPeaks.set(key, { project, media: media.id });
    return null;
  }

  /** After a draw pass: fetches what it wanted and hasn't, and stops fetching what it no longer wants. */
  flush(): void {
    // Scrolled away: what's no longer wanted isn't waited for.
    for (const [id, flight] of this.flying) {
      if (!flight.keys.some((key) => this.wanted.has(key) || this.wantedPeaks.has(key))) {
        flight.abort.abort();
        this.flying.delete(id);
      }
    }
    const now = hooks.now();
    const busy = new Set([...this.flying.values()].flatMap((flight) => flight.keys));
    // (A request that just ended flushes with the pass's asks: what it brought is in now.)
    const due = (key: string) => !busy.has(key) && !this.frames.has(key) && !this.peaksCache.has(key) && (this.misses.get(key)?.at ?? 0) <= now;
    // Waveforms first (one small file each), then each clip's frames, in the order the pass asked.
    for (const [key, ask] of this.wantedPeaks) {
      if (this.flying.size >= AT_ONCE) break;
      if (due(key)) this.fetchPeaks(key, ask.project, ask.media);
    }
    const groups: { ask: Ask; keys: string[]; ms: number[] }[] = [];
    const open = new Map<string, { ask: Ask; keys: string[]; ms: number[] }>();
    for (const [key, ask] of this.wanted) {
      if (!due(key)) continue;
      const id = `${ask.project}|${ask.media}|${ask.version}|${ask.h}`;
      let group = open.get(id);
      if (group === undefined || group.keys.length >= PER_REQUEST) {
        group = { ask, keys: [], ms: [] };
        open.set(id, group);
        groups.push(group);
      }
      group.keys.push(key);
      group.ms.push(ask.ms);
    }
    for (const group of groups) {
      if (this.flying.size >= AT_ONCE) break;
      this.fetchFrames(group.ask, group.keys, group.ms);
    }
    this.scheduleRetry();
  }

  private fetchFrames(ask: Ask, keys: string[], ms: number[]): void {
    const abort = new AbortController();
    const id = `frames|${keys[0]}`;
    this.flying.set(id, { keys, abort });
    const times = ms.map((one) => (one / 1000).toFixed(3)).join(",");
    const url = mediaHost(`/api/projects/${ask.project}/media/${ask.media}/frames?t=${times}&h=${ask.h}&v=${ask.version}`);
    void hooks
      .fetch(url, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`frames: ${response.status}`);
        const pictures = await unpack(new Uint8Array(await response.arrayBuffer()));
        if (abort.signal.aborted) return;
        let landed = false;
        keys.forEach((key, index) => {
          const picture = pictures[index] ?? null;
          if (picture === null) this.missed(key);
          else {
            this.misses.delete(key);
            this.frames.set(key, picture, picture.width * picture.height * 4);
            landed = true;
          }
        });
        if (landed) this.changed();
      })
      .catch(() => {
        if (!abort.signal.aborted) for (const key of keys) this.missed(key);
      })
      .finally(() => {
        if (this.flying.get(id)?.abort === abort) this.flying.delete(id);
        if (!abort.signal.aborted) this.flush();
      });
  }

  private fetchPeaks(key: string, project: string, media: string): void {
    const abort = new AbortController();
    this.flying.set(key, { keys: [key], abort });
    void hooks
      .fetch(mediaHost(`/api/projects/${project}/media/${media}/peaks`), { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`peaks: ${response.status}`);
        const data = new Uint8Array(await response.arrayBuffer());
        if (abort.signal.aborted) return;
        this.misses.delete(key);
        this.peaksCache.set(key, data, data.byteLength);
        this.changed();
      })
      .catch(() => {
        if (!abort.signal.aborted) this.missed(key);
      })
      .finally(() => {
        if (this.flying.get(key)?.abort === abort) this.flying.delete(key);
        if (!abort.signal.aborted) this.flush();
      });
  }

  /** Asked again after its pause, never marked missing for good. */
  private missed(key: string): void {
    const tries = (this.misses.get(key)?.tries ?? 0) + 1;
    this.misses.set(key, { tries, at: hooks.now() + RETRY_MS[Math.min(tries, RETRY_MS.length) - 1]! });
  }

  /** The soonest miss due again draws the view again then (its pass asks for it). */
  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    let soonest = Number.POSITIVE_INFINITY;
    for (const [key, miss] of this.misses) {
      if (this.wanted.has(key) || this.wantedPeaks.has(key)) soonest = Math.min(soonest, miss.at);
    }
    if (!Number.isFinite(soonest)) return;
    this.retryTimer = setTimeout(() => this.changed(), Math.max(50, soonest - hooks.now()));
  }

  /** The socket's back (Edit restarted, the line's back): every miss is asked again now. */
  private reconnected = () => {
    if (this.misses.size === 0) return;
    this.misses.clear();
    this.changed();
  };

  private changed(): void {
    this.rev++;
    for (const listener of this.listeners) listener();
  }

  /** What the last pass drew without (not in yet): 0 once everything in view is pictured. */
  waiting(): number {
    let count = 0;
    for (const key of this.wanted.keys()) if (!this.frames.has(key)) count++;
    for (const key of this.wantedPeaks.keys()) if (!this.peaksCache.has(key)) count++;
    return count;
  }

  /** Another project opened: its pictures and fetches go. */
  clear(): void {
    for (const flight of this.flying.values()) flight.abort.abort();
    this.flying.clear();
    this.frames.clear();
    this.peaksCache.clear();
    this.misses.clear();
    this.wanted.clear();
    this.wantedPeaks.clear();
    clearTimeout(this.retryTimer);
  }
}

/** The frames in a body packed by the server (timeline_media.ts `packFrames`), decoded; null for one it couldn't make. */
async function unpack(body: Uint8Array): Promise<(Picture | null)[]> {
  if (body.byteLength < 4) return [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getUint32(0, true);
  let at = 4 + count * 4;
  const slices: (Uint8Array | null)[] = [];
  for (let index = 0; index < count; index++) {
    const length = view.getUint32(4 + index * 4, true);
    slices.push(length === 0 || at + length > body.byteLength ? null : body.subarray(at, at + length));
    at += length;
  }
  return Promise.all(slices.map((slice) => (slice === null ? Promise.resolve(null) : hooks.decode(new Blob([slice as BlobPart], { type: "image/jpeg" })).catch(() => null))));
}

/** The page's one loader. */
export const timelineMedia = new TimelineMedia();
