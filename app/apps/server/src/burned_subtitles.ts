// Subtitles already burned into a footage file's picture: another channel's
// finished video used as footage (Lauana's Cuffed & Caught compilation, Nov 16:
// yeNu3j_K6D8's white "That house is horrible." with the agent's own blue
// subtitles stacked over it, two sets on screen).
//
// Found once per file, when the agent first needs it (get_edit_context, or a
// subtitling tool: never on opening or importing, where 73 reads of Cops Found 3
// Bodies' footage ran beside a cold play on kenobi, Nov 17), from the words on
// screen Edit reads anyway (screen_text.rs: Vision on a Mac, PaddleOCR elsewhere), sampled, never
// every frame: PROBES frames spread over the file first, and only a file where
// those show subtitle-like lines is read on a grid (at most MOST frames). A
// subtitle line is low in the picture, centred, mostly letters, its words
// changing from sample to sample (a credit or a camera's stamp doesn't), and,
// when the file has a transcript, what's said at that moment. Kept as spans of
// the file's own seconds with the band of the picture they sit in
// (`subtitles-burned-v1.json` in its cache dir); worked out again from the
// cached reads, no new OCR, once a transcript comes.
//
// What uses it: get_edit_context's media list (the agent is told which files
// show them and where), add_subtitles and repack_subtitles (ours are left off
// there by themselves: the default with nothing taught, decided Nov 16; a
// channel taught to cover theirs passes burned_in "cover", a blur over their
// band stuck to each clip with ours on it), the store (an agent's save that
// lays a subtitle of ours over theirs is refused in one line), the intro
// captions (they keep off the band) and the audit's `burned_subtitles`.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { fillsFrame } from "./frames_fill.ts";
import { strippedFrames } from "./clean_strips.ts";
import * as markBlurs from "./mark_blurs.ts";
import { mediaHooks } from "./media.ts";
import * as playing from "./playing.ts";
import type { AdjustmentClip, Keyframe, Media, Project, VideoClip } from "./model.ts";
import { isReal, native, type ScreenText } from "./native/index.ts";
import { join } from "./paths.ts";
import { clipEnd, fps as fpsOf, freshId, mediaOf, reusedMedia, sample, trackOf } from "./project.ts";
import { round } from "./rust.ts";
import { agentRules } from "./store.ts";
import * as tools from "./tools.ts";

/** The file in the media's cache dir; a new method is a new file. */
const FILE = "subtitles-burned-v1.json";
/** Frames looked at first, spread over the file. */
const PROBES = 24;
/** Probes with a subtitle-like line before the file is read on its grid. */
const PROBE_HITS = 2;
/** Frames on the grid at most, and the least seconds between them. */
const MOST = 200;
const LEAST_STEP = 4;
/** A subtitle line's top is below this share of the height (one the transcript says may sit higher, to LOW_HEARD)… */
const LOW = 0.72;
const LOW_HEARD = 0.58;
/** …its middle within this share of the centre… */
const CENTRE = 0.2;
/** Samples with a subtitle line, and different lines among them, before a file counts as subtitled. */
const LEAST_HITS = 3;
/** The most one set of words may be of them: a line up for good is a credit or a sign. */
const SAME = 0.4;
/** Two reads are the same words when they share this much (Jaccard). */
const ALIKE = 0.6;

function alike(a: Set<string>, b: Set<string>): boolean {
  const both = [...a].filter((one) => b.has(one)).length;
  return both >= ALIKE * Math.max(1, a.size + b.size - both);
}

/** With a transcript: the share of lines it must say near when they're up (OCR misreads some), once this many lines had speech near. */
const HEARD = 0.25;
const HEARD_FROM = 3;
/** Seconds either side of a sample a line's words are looked for in the transcript. */
const NEAR = 5;
/** Share of a line's words the transcript says for the line to count as heard. */
const SAID = 0.5;
/**
 * What to do with ours where footage has its own: none over theirs (the
 * default), theirs blurred and ours on it, or theirs taken out of the picture
 * and ours on it ("remove", subtitle_removal.ts: blurred like "cover" until
 * it's done, and where it can't be). Either of the last two only when taught.
 */
export type BurnedIn = "leave_off" | "cover" | "remove";
/** How long a subtitling tool waits for the footage it subtitles to be read (ms). */
export const WAIT_MS = 60_000;
/** How long the agent's first get_edit_context of a project waits for the footage on its timeline to be read (ms). */
export const CONTEXT_WAIT_MS = 8_000;
/** Frames read at a time by a read nobody waits on: between them it gives way to a play. */
const STEP = 25;
/** The name of every blur `cover` lays; a re-run replaces them. */
export const COVER = "Burned-in cover";
/** A cover laid for "remove": standing in until their subtitles are taken out (subtitle_removal.ts finds what's wanted by it). */
export const UNTIL_REMOVED = `${COVER} · until removed`;

/** A box as shares of the picture from its top left: x0, y0, x1, y1. */
export type Band = [number, number, number, number];

/** A file's burned-in subtitles: where (source seconds) and the band they sit in. */
export interface Burned {
  /** Source seconds [from, to) where its subtitles show. */
  spans: [number, number][];
  band: Band;
  /** A few lines read, as written. */
  lines: string[];
  /** Share of the lines its transcript says when they're up; null when it has none. */
  heard: number | null;
}

interface State {
  /** The seconds read (indexes of screen_text's samples). */
  read: number[];
  /** What was read from: the file, or its whole copy here. */
  input: string;
  /** Whether a transcript was there when the reads were judged. */
  transcript: boolean;
  found: Burned | null;
}

/** What reads a file: media.ts's Processor (`app.media`). */
export interface Reader {
  analysisInput(source: string): Promise<string>;
  paths(source: string): { transcript: string };
}

/** What finding them needs of a media (a probed file will do). */
export type Footage = Pick<Media, "path" | "name" | "kind" | "duration" | "width" | "height">;

const known = new Map<string, State>();
const reading = new Map<string, Promise<void>>();
/** A file whose reading failed is tried again after this. */
const RETRY_MS = 10 * 60_000;
const failedAt = new Map<string, number>();

// One file read at a time: each is OCR on up to MOST frames, beside the edit's
// own work. A file someone waits on (a subtitling tool, the first
// get_edit_context) goes first and never stops for a play; one nobody waits
// on starts only while nothing plays here, and stops between its steps while
// something does (playing.ts).

/** Files someone waits on now, and how many wait. */
const waited = new Map<string, number>();
/** Files waiting their turn, in the order asked. */
const line: { path: string; go: () => void }[] = [];
let busy = false;

function urgent(path: string): boolean {
  return (waited.get(path) ?? 0) > 0;
}

/** Whether `path`'s read, or one in line behind it, is waited on. */
function wanted(path: string): boolean {
  return urgent(path) || line.some((one) => urgent(one.path));
}

/** `path`'s turn to be read; call what it resolves to when the read is over. */
function turn(path: string): Promise<() => void> {
  return new Promise((resolve) => {
    line.push({
      path,
      go: () => {
        let over = false;
        resolve(() => {
          if (over) return;
          over = true;
          busy = false;
          next();
        });
      },
    });
    next();
  });
}

function next(): void {
  if (busy) return;
  let at = line.findIndex((one) => urgent(one.path));
  if (at < 0) {
    // A read nobody waits on: after a play, and after footage someone waits on to open a project (playing.ts).
    if (line.length === 0 || !playing.isIdle()) return;
    at = 0;
  }
  busy = true;
  line.splice(at, 1)[0]!.go();
}

playing.onIdle(next);

/** Between two steps of a read nobody waits on: until nothing plays (or someone waits on it, or on one behind it). */
async function giveWay(path: string): Promise<void> {
  if (!wanted(path)) await playing.whenIdle(() => wanted(path));
}

function stateFile(path: string): string | null {
  if (!isReal()) return null;
  const dir = tools.mediaCache(path);
  return dir === null ? null : join(dir, FILE);
}

/** Files with nothing kept yet, and when that was seen: looked for again after a few seconds (every save asks). */
const missing = new Map<string, number>();

function load(path: string): State | null {
  const hit = known.get(path);
  if (hit !== undefined) return hit;
  if (Date.now() - (missing.get(path) ?? 0) < 5_000) return null;
  const file = stateFile(path);
  if (file === null) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as State;
    if (!Array.isArray(state.read)) throw new Error("not a state");
    known.set(path, state);
    missing.delete(path);
    return state;
  } catch {
    missing.set(path, Date.now());
    return null;
  }
}

function save(path: string, state: State): void {
  known.set(path, state);
  missing.delete(path);
  const file = stateFile(path);
  if (file === null) return;
  try {
    fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch (error) {
    diag.warn("media", `keeping burned-in subtitles of ${diag.scrub(path)}: ${diag.messageOf(error)}`);
  }
}

/** A transcript's words (text, start, end), or null when it has none yet. */
function wordsOf(file: string): { text: string; start: number; end: number }[] | null {
  try {
    const given = JSON.parse(fs.readFileSync(file, "utf8")) as { words?: unknown };
    if (!Array.isArray(given.words)) return null;
    return (given.words as { text?: unknown; start?: unknown; end?: unknown }[]).flatMap((word) =>
      typeof word.text === "string" && typeof word.start === "number" && typeof word.end === "number" ? [{ text: word.text, start: word.start, end: word.end }] : [],
    );
  } catch {
    return null;
  }
}

/** Words, not a camera's stamp: mostly letters, two words or more. */
function subtitleLike(text: string): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters >= 6 && letters >= text.replace(/\s/gu, "").length * 0.6 && text.trim().split(/\s+/u).length >= 2;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((one) => one.replace(/'/gu, ""))
    .filter((one) => one.length >= 2);
}

/** The seconds to read first: PROBES spread over the file, clear of its very ends. */
export function probes(duration: number): number[] {
  const out = new Set<number>();
  for (let index = 0; index < PROBES; index++) out.add(Math.floor((duration * (index + 0.5)) / PROBES));
  return [...out].filter((second) => second >= 0 && second < duration).sort((a, b) => a - b);
}

/** The grid's seconds and its step. */
export function grid(duration: number): { seconds: number[]; step: number } {
  const step = Math.max(LEAST_STEP, duration / MOST);
  const out = new Set<number>();
  for (let at = step / 2; at < duration; at += step) out.add(Math.floor(at));
  return { seconds: [...out].sort((a, b) => a - b), step };
}

/** The lines low and centred at one sample that read as words. */
function candidates(lines: ScreenText[]): ScreenText[] {
  return lines.filter(({ t, b }) => b[1] >= LOW_HEARD && Math.abs((b[0] + b[2]) / 2 - 0.5) <= CENTRE && subtitleLike(t));
}

/**
 * The verdict on a file's reads (`texts`, second → lines) at `seconds`: its
 * burned-in subtitles, or null when it shows none. `words` is its transcript
 * (null with none).
 */
export function judge(
  texts: Record<number, ScreenText[]>,
  seconds: number[],
  duration: number,
  words: { text: string; start: number; end: number }[] | null,
): Burned | null {
  const sorted = [...new Set(seconds)].filter((second) => Object.hasOwn(texts, second)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const said = (second: number): Set<string> | null => {
    if (words === null) return null;
    const near = words.filter((word) => word.end >= second - NEAR && word.start <= second + NEAR);
    return near.length === 0 ? null : new Set(near.flatMap((word) => tokens(word.text)));
  };
  type Hit = { second: number; lines: ScreenText[]; heard: boolean | null };
  const hits: Hit[] = [];
  for (const second of sorted) {
    const near = said(second);
    const heardLine = (line: ScreenText) => {
      if (near === null) return null;
      const own = tokens(line.t);
      return own.length > 0 && own.filter((one) => near.has(one)).length >= own.length * SAID;
    };
    const lines = candidates(texts[second] ?? []).filter((line) => line.b[1] >= LOW || heardLine(line) === true);
    if (lines.length === 0) continue;
    const heard = near === null ? null : lines.some((line) => heardLine(line) === true);
    hits.push({ second, lines, heard });
  }
  if (hits.length < LEAST_HITS) return null;
  // Changing: a credit, a lower third or a sign stays the same (read a little differently now and then).
  const groups: { words: Set<string>; count: number }[] = [];
  for (const hit of hits) {
    const words = new Set(tokens(hit.lines.map((line) => line.t).join(" ")));
    const same = groups.find((group) => alike(group.words, words));
    if (same !== undefined) same.count += 1;
    else groups.push({ words, count: 1 });
  }
  if (groups.length < LEAST_HITS || Math.max(...groups.map((group) => group.count)) > hits.length * SAME) return null;
  // Said: with speech near, the transcript says enough of them.
  const judged = hits.filter((hit) => hit.heard !== null);
  const heardShare = judged.length === 0 ? null : judged.filter((hit) => hit.heard === true).length / judged.length;
  if (heardShare !== null && judged.length >= HEARD_FROM && heardShare < HEARD) return null;
  // Spans: runs of hits, a few samples' gap bridged, padded by half the spacing.
  const spacing = Math.max(LEAST_STEP, ...sorted.slice(1).map((second, index) => second - sorted[index]!).sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(sorted.length / 2))));
  const bridge = 3 * spacing;
  const pad = spacing / 2 + 1;
  const spans: [number, number][] = [];
  for (const { second } of hits) {
    const last = spans[spans.length - 1];
    if (last !== undefined && second - pad - last[1] <= bridge) last[1] = Math.min(duration, second + pad);
    else spans.push([Math.max(0, second - pad), Math.min(duration, second + pad)]);
  }
  const all = hits.flatMap((hit) => hit.lines);
  const band: Band = [
    Math.max(0, Math.min(...all.map((line) => line.b[0])) - 0.01),
    Math.max(0, Math.min(...all.map((line) => line.b[1])) - 0.01),
    Math.min(1, Math.max(...all.map((line) => line.b[2])) + 0.01),
    Math.min(1, Math.max(...all.map((line) => line.b[3])) + 0.01),
  ].map((value) => round(value * 1000) / 1000) as Band;
  const lines = [...new Set(all.map((line) => line.t.trim()))].slice(0, 3);
  return {
    spans: spans.map(([a, b]) => [round(a * 10) / 10, round(b * 10) / 10]),
    band,
    lines,
    heard: heardShare === null ? null : round(heardShare * 100) / 100,
  };
}

/** What to read for `path`: a streamed preview's whole copy here (as the censor check), a pieced proxy's original, else itself. */
async function inputOf(reader: Reader, path: string): Promise<string> {
  const whole = mediaHooks.censorInput?.(path) ?? null;
  if (whole !== null) {
    const here = await whole.catch(() => null);
    if (here !== null) return here;
  }
  return reader.analysisInput(path);
}

/** Reads `media` for burned-in subtitles in the background unless it's read or being read. */
export function warm(reader: Reader, media: Footage): Promise<void> {
  const busy = reading.get(media.path);
  if (busy !== undefined) return busy;
  if (!isReal() || media.kind !== "video" || (media.duration ?? 0) < 2 || (media as { cleans?: unknown }).cleans != null) return Promise.resolve();
  const state = load(media.path);
  if (state !== null) {
    // Judged again from what's read once a transcript comes (no new OCR).
    if (!state.transcript) rejudge(reader, media, state);
    return Promise.resolve();
  }
  if (Date.now() - (failedAt.get(media.path) ?? 0) < RETRY_MS) return Promise.resolve();
  const work = (async () => {
    const input = await inputOf(reader, media.path);
    const done = await turn(media.path);
    try {
      await read(reader, media, input);
    } finally {
      done();
    }
  })()
    .catch((error: unknown) => {
      failedAt.set(media.path, Date.now());
      diag.warn("media", `reading ${media.name} for burned-in subtitles: ${diag.messageOf(error)}`);
    })
    .finally(() => reading.delete(media.path));
  reading.set(media.path, work);
  return work;
}

/** The words on screen at `seconds`: at once for a file someone waits on, else STEP frames at a time, giving way to a play between them (each kept by the engine as it's read). */
async function look(path: string, input: string, size: [number, number], seconds: number[]): Promise<Record<number, ScreenText[]>> {
  const out: Record<number, ScreenText[]> = {};
  for (let at = 0; at < seconds.length; ) {
    if (at > 0) await giveWay(path);
    const step = urgent(path) ? seconds.length - at : STEP;
    Object.assign(out, await native().screenTextDetect(input, size, seconds.slice(at, at + step)));
    at += step;
  }
  return out;
}

async function read(reader: Reader, media: Footage, input: string): Promise<void> {
  const duration = media.duration ?? 0;
  const size: [number, number] = [media.width ?? 1920, media.height ?? 1080];
  const first = probes(duration);
  const texts = await diag.timeOnAsync("media", "media: burned-in subtitles (probe)", media.path, () => look(media.path, input, size, first));
  let seconds = first;
  let all: Record<number, ScreenText[]> = texts;
  if (first.filter((second) => candidates(texts[second] ?? []).length > 0).length >= PROBE_HITS) {
    await giveWay(media.path);
    const more = grid(duration).seconds.filter((second) => !first.includes(second));
    const rest = await diag.timeOnAsync("media", "media: burned-in subtitles (grid)", media.path, () => look(media.path, input, size, more));
    all = { ...texts, ...rest };
    seconds = [...first, ...more];
  }
  const words = wordsOf(reader.paths(media.path).transcript);
  const found = judge(all, seconds, duration, words);
  save(media.path, { read: seconds.sort((a, b) => a - b), input, transcript: words !== null, found });
  if (found !== null) diag.info("media", `${media.name}: burned-in subtitles at ${found.spans.map(([a, b]) => `${a}–${b}s`).join(", ")} (band ${found.band.join(" ")})`);
}

function rejudge(reader: Reader, media: Footage, state: State): void {
  const words = wordsOf(reader.paths(media.path).transcript);
  if (words === null) return;
  const texts = native().screenTextCached(state.input) ?? {};
  save(media.path, { ...state, transcript: true, found: judge(texts, state.read, media.duration ?? 0, words) });
}

/** The words read off a file's frames to find its subtitles (second → lines), once it's read: what subtitle_removal.ts looks for other burned-in text in. */
export function readsOf(media: Pick<Media, "path">): { seconds: number[]; texts: Record<number, ScreenText[]> } | null {
  const state = load(media.path);
  if (state === null || !isReal()) return null;
  return { seconds: state.read, texts: native().screenTextCached(state.input) ?? {} };
}

/** A file's burned-in subtitles: what was found (null: none), or undefined while it isn't read yet. */
export function of(media: Pick<Media, "path">): Burned | null | undefined {
  const state = load(media.path);
  return state === null ? undefined : state.found;
}

/**
 * Waits up to `ms` for each of `media` to be read (started if it isn't, ahead
 * of the reads nobody waits on, a play or not): the ones still unread. Read
 * before, it's at once.
 */
export async function ready<T extends Footage>(reader: Reader, media: T[], ms: number): Promise<T[]> {
  const unread = media.filter((one) => of(one) === undefined && (one as { cleans?: unknown }).cleans == null);
  for (const one of unread) waited.set(one.path, (waited.get(one.path) ?? 0) + 1);
  try {
    next();
    const waits = unread.map((one) => warm(reader, one));
    if (waits.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(waits), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
      clearTimeout(timer);
    }
  } finally {
    for (const one of unread) {
      const left = (waited.get(one.path) ?? 1) - 1;
      if (left > 0) waited.set(one.path, left);
      else waited.delete(one.path);
    }
  }
  return media.filter((one) => one.kind === "video" && (one.duration ?? 0) >= 2 && of(one) === undefined && (one as { cleans?: unknown }).cleans == null && isReal());
}

/** "12–340s, 400–800s": the spans as the agent reads them. */
export function spansText(spans: [number, number][]): string {
  return spans.map(([a, b]) => `${round(a)}–${round(b)}s`).join(", ");
}

/** The band as the agent reads it: "bottom 80–92% of the picture, 22–78% across". */
export function bandText(band: Band): string {
  const pct = (value: number) => round(value * 100);
  return `${pct(band[1])}–${pct(band[3])}% down, ${pct(band[0])}–${pct(band[2])}% across`;
}

// ---------------------------------------------------------------------------
// On the timeline

/** Where on the timeline a file's burned-in subtitles show: one stretch of one clip. */
export interface Shown {
  clip: string;
  media: string;
  /** Timeline frames [start, end). */
  start: number;
  end: number;
  band: Band;
}

/** Frames [start, end) of `spans` minus `holes`. */
function minus(spans: [number, number][], holes: [number, number][]): [number, number][] {
  let out = spans;
  for (const [a, b] of holes) {
    out = out.flatMap(([x, y]): [number, number][] => (b <= x || a >= y ? [[x, y]] : ([[x, Math.min(y, a)], [Math.max(x, b), y]] as [number, number][]).filter(([p, q]) => q > p)));
  }
  return out;
}

/** The band of `clip`'s picture in project pixels from the frame's centre (x, y, width, height) at a frame of the clip. */
export function bandBox(project: Project, clip: VideoClip, media: Media, band: Band, frame: number): [number, number, number, number] {
  const { width, height } = project.settings;
  const [mw, mh] = [media.width || width, media.height || height];
  const scale = (clip.keyframes?.scale !== undefined && clip.keyframes.scale.length > 0 ? sample(clip.keyframes.scale, frame) : null) ?? clip.transform.scale ?? 1;
  const x = (clip.keyframes?.x !== undefined && clip.keyframes.x.length > 0 ? sample(clip.keyframes.x, frame) : null) ?? clip.transform.x ?? 0;
  const y = (clip.keyframes?.y !== undefined && clip.keyframes.y.length > 0 ? sample(clip.keyframes.y, frame) : null) ?? clip.transform.y ?? 0;
  const fit = Math.min(width / mw, height / mh) * scale;
  const [x0, y0, x1, y1] = band;
  return [((x0 + x1) / 2 - 0.5) * mw * fit + x, ((y0 + y1) / 2 - 0.5) * mh * fit + y, (x1 - x0) * mw * fit, (y1 - y0) * mh * fit];
}

/** Whether a blur covers `box` (centre and size) at timeline frame `frame`. */
function blurredAt(project: Project, box: [number, number, number, number], frame: number): boolean {
  const [x, y, w, h] = box;
  return project.clips.some((clip) => {
    if (clip.type !== "adjustment" || trackOf(project, clip.track)?.hidden === true) return false;
    if (clip.start > frame || clipEnd(clip) <= frame) return false;
    const blur = clip.blur;
    if (blur === undefined || blur === null || (blur.radius ?? 0) < 15) return false;
    if (blur.width === undefined || blur.width === null || blur.width <= 0) return true;
    const into = frame - clip.start;
    const at = (param: string, still: number) => {
      const keys = clip.keyframes?.[param];
      return (keys !== undefined && keys.length > 0 ? sample(keys, into) : null) ?? still;
    };
    const [bx, by, bw, bh] = [at("blur.x", blur.x ?? 0), at("blur.y", blur.y ?? 0), at("blur.width", blur.width), at("blur.height", blur.height ?? 0)];
    return Math.abs(x - bx) + w / 2 <= bw / 2 + 8 && Math.abs(y - by) + h / 2 <= bh / 2 + 8;
  });
}

/** Whether the band is off the frame where the clip sits (scaled or cropped off). */
function offFrame(project: Project, clip: VideoClip, media: Media, band: Band, frame: number): boolean {
  if ((clip.crop?.bottom ?? 0) >= 1 - band[1]) return true;
  const [, y, , h] = bandBox(project, clip, media, band, frame);
  return y - h / 2 >= project.settings.height / 2 - 2;
}

/**
 * Where on the timeline (within frames [from, to)) footage shows its own
 * burned-in subtitles: each visible clip's stretch of a file that has them,
 * less where a picture filling the frame above hides it and where they're
 * blurred, cleaned (clean_strips.ts) or framed off. `reading`: files used
 * there not read yet. `evenCovered`: blurred and cleaned stretches count as
 * shown (what subtitle_removal.ts cleans).
 */
export function onTimeline(project: Project, from = 0, to = Number.MAX_SAFE_INTEGER, evenCovered = false): { shown: Shown[]; reading: Media[] } {
  const fps = fpsOf(project);
  const stripped = evenCovered ? new Map<string, [number, number][]>() : strippedFrames(project);
  const ours = reusedMedia(project);
  const index = (track: string) => project.tracks.findIndex((one) => one.id === track);
  const shown: Shown[] = [];
  const reading = new Map<string, Media>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || trackOf(project, clip.track)?.hidden === true) continue;
    if (clip.start >= to || clipEnd(clip) <= from) continue;
    const media = mediaOf(project, clip.media);
    // A finished video of ours has our own subtitles burned in: never doubled (they're skipped already). A cleaned strip has none.
    if (media === undefined || media.kind !== "video" || ours.has(media.id) || media.cleans != null) continue;
    const found = of(media);
    if (found === undefined) {
      if (isReal() && (media.duration ?? 0) >= 2) reading.set(media.id, media);
      continue;
    }
    if (found === null) continue;
    const at = (seconds: number) => clip.start + Math.round(((seconds - clip.source_in) / clip.speed) * fps);
    let pieces: [number, number][] = found.spans
      .map(([a, b]): [number, number] => [Math.max(at(a), clip.start, from), Math.min(at(b), clipEnd(clip), to)])
      .filter(([a, b]) => b > a);
    // Hidden under a picture that fills the frame on a track above.
    const above = project.clips
      .filter((other) => other.id !== clip.id && index(other.track) > index(clip.track) && trackOf(project, other.track)?.hidden !== true && fillsFrame(project, other) && other.start < clipEnd(clip) && clipEnd(other) > clip.start)
      .map((other): [number, number] => [other.start, clipEnd(other)]);
    pieces = minus(minus(pieces, above), stripped.get(clip.id) ?? []);
    for (const [start, end] of pieces) {
      const frames = [start, Math.floor((start + end) / 2), end - 1];
      const hidden = frames.every((frame) => offFrame(project, clip, media, found.band, frame - clip.start) || (!evenCovered && blurredAt(project, bandBox(project, clip, media, found.band, frame - clip.start), frame)));
      if (!hidden) shown.push({ clip: clip.id, media: media.name, start, end, band: found.band });
    }
  }
  return { shown: shown.sort((a, b) => a.start - b.start), reading: [...reading.values()] };
}

/** Whether frames [start, end) overlap any of `shown` by at least half of the shorter. */
export function over(shown: Shown[], start: number, end: number): boolean {
  return shown.some((one) => Math.min(end, one.end) - Math.max(start, one.start) >= 0.5 * Math.max(1, Math.min(end - start, one.end - one.start)));
}

agentRules.subtitlesOver = (before, after) => refusal(before, after);

/** The one line a save of ours over theirs is refused with. */
export function conflict(project: Project, shown: Shown[]): string {
  const fps = fpsOf(project);
  const byMedia = new Map<string, [number, number][]>();
  for (const one of shown) byMedia.set(one.media, [...(byMedia.get(one.media) ?? []), [one.start / fps, one.end / fps]]);
  const where = [...byMedia.entries()].map(([name, spans]) => `"${name}" at ${spansText(spans)}`).join("; ");
  return `The footage already has subtitles burned in there (${where} on the timeline), so ours stay off it.`;
}

/**
 * An agent's save that lays a subtitle of ours (new, moved or longer) over
 * subtitles burned into the footage: the line it's refused with, else null.
 * Subtitles already there before it are left to the audit.
 */
export function refusal(before: Project, after: Project): string | null {
  const isOurs = (project: Project, clip: Project["clips"][number]) =>
    clip.type === "text" && ((clip.name ?? "").startsWith("Subtitle") || trackOf(project, clip.track)?.subtitles === true);
  const was = new Map(before.clips.filter((clip) => isOurs(before, clip)).map((clip) => [clip.id, clip]));
  const placed = after.clips.filter((clip) => {
    if (!isOurs(after, clip) || trackOf(after, clip.track)?.hidden === true) return false;
    const old = was.get(clip.id);
    return old === undefined || old.start !== clip.start || old.duration !== clip.duration || old.track !== clip.track;
  });
  if (placed.length === 0) return null;
  // Each stretch whole: cut to the subtitles' span, an edge's sliver read as all of it.
  const { shown } = onTimeline(after);
  if (shown.length === 0) return null;
  // One already over theirs before this save (laid before they were found) and carried along by it (a ripple) is the audit's.
  const already = onTimeline(before).shown;
  const newly = placed.filter((clip) => {
    if (!shown.some((one) => over([one], clip.start, clipEnd(clip)))) return false;
    const old = was.get(clip.id);
    return old === undefined || !over(already, old.start, clipEnd(old));
  });
  const under = shown.filter((one) => newly.some((clip) => over([one], clip.start, clipEnd(clip))));
  return under.length === 0 ? null : conflict(after, under);
}

/** Trims keyframes (frames into a clip) to [cut, cut + length) of it, a key at each new end. */
function trimmed(keys: Keyframe[], cut: number, length: number): Keyframe[] {
  const value = (frame: number) => sample(keys, frame) ?? keys[0]!.value;
  const inside = keys.filter((key) => key.frame > cut && key.frame < cut + length - 1).map((key) => ({ ...key, frame: key.frame - cut }));
  return [{ frame: 0, value: value(cut), ease: "linear" as const }, ...inside, { frame: length - 1, value: value(cut + length - 1), ease: "linear" as const }];
}

/**
 * Covers each of `shown` with a blur over the band, stuck to its clip (it
 * follows a push-in and fades with a dissolve: mark_blurs' way), named
 * COVER (UNTIL_REMOVED for "remove"). The covers laid before over the same
 * frames go first. Returns how many.
 */
export function cover(project: Project, shown: Shown[], removing = false): number {
  project.clips = project.clips.filter((clip) => !((clip.name ?? "").startsWith(COVER) && shown.some((one) => clip.start < one.end && one.start < clipEnd(clip))));
  const made: AdjustmentClip[] = [];
  for (const one of shown) {
    const clip = project.clips.find((own): own is VideoClip => own.id === one.clip && own.type === "video");
    const media = clip === undefined ? undefined : mediaOf(project, clip.media);
    if (clip === undefined || media === undefined) continue;
    for (const blur of markBlurs.blursFor(project, clip, media, { text: "burned-in subtitles", box: one.band })) {
      const start = Math.max(blur.start, one.start);
      const end = Math.min(clipEnd(blur), one.end);
      if (end - start < 2) continue;
      const cut = start - blur.start;
      const keyframes: Record<string, Keyframe[]> = {};
      for (const [param, keys] of Object.entries(blur.keyframes ?? {})) if (keys.length > 0) keyframes[param] = trimmed(keys, cut, end - start);
      made.push({ ...blur, start, duration: end - start, name: `${removing ? UNTIL_REMOVED : COVER} · ${clip.id}`, ...(Object.keys(keyframes).length > 0 ? { keyframes } : { keyframes: undefined }) } as AdjustmentClip);
    }
  }
  for (const blur of made) {
    if (blur.keyframes === undefined) delete blur.keyframes;
    blur.id = freshId(project, "c");
    blur.track = markBlurs.laneFor(project, blur.start, clipEnd(blur), COVER);
    project.clips.push(blur);
  }
  return made.length;
}

/** The band of `media` as a face-like box on the frame for a caption to keep off, while it shows in source seconds [from, to); null when it doesn't. */
export function obstacle(media: Media, from: number, to: number): Band | null {
  const found = of(media);
  if (found === undefined || found === null) return null;
  return found.spans.some(([a, b]) => a < to && from < b) ? found.band : null;
}

