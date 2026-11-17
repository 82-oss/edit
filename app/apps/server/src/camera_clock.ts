// A time on the camera's own clock, as the footage's seconds (Sphe, Nov 17:
// "could i give the agent a bodycam timestamp on the top right and tell it to
// cut from there?"). Bodycam, dashcam and interview-room footage carries its
// clock burned into the picture ("2023-05-14 T14:32:05 Z AXON BODY 3
// X81234567", "Room 1 05/04/22 12:03:42"); before this the agent could only
// read it by eye with look_at_media's zoom, and guess.
//
// `find_camera_time` reads the clock with the words-on-screen reader Edit
// already has (screen_text.rs: Vision on a Mac, PaddleOCR elsewhere):
//   1. where it is: a few frames' words (screen_text's 960-wide reads, kept and
//      shared with the audit's), the lines that read as a clock; nothing new
//      read where those are already kept;
//   2. a coarse pass over the file, only that corner, at the file's own size
//      (`screenTextAt`): clock = source + offset, one offset per continuous
//      stretch, a jump in the offset being a cut (compilations and excerpts);
//   3. the asked time's stretch, then the frame where that second begins,
//      narrowed 7 frames a round around it.
// Every read is kept with the media (`camera-clock-v1.json` in its cache dir),
// so a second ask of the same file reads only around its answer. The agent
// waits on it, so it never stops for a play; its threads run below the player
// (`util::background_thread`).

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import type { Media, Project } from "./model.ts";
import { isReal, native, type Box, type ScreenText } from "./native/index.ts";
import { join } from "./paths.ts";
import { round } from "./rust.ts";
import * as tools from "./tools.ts";

/** The file in the media's cache dir; a new method is a new file. */
const FILE = "camera-clock-v1.json";
/** Seconds of a file looked at to find its clock (shares of its length). */
const LOCATE_AT = [0.1, 0.3, 0.5, 0.7, 0.9];
/** Where a clock the 960-wide read missed is looked for: the picture's top and bottom. */
const BANDS: Box[] = [
  [0, 0, 1, 0.2],
  [0, 0.8, 1, 1],
];
/** The coarse pass: at most this many frames, at least this many seconds apart. */
const COARSE_MOST = 60;
const COARSE_LEAST_STEP = 3;
/** Two reads are the same stretch when their offsets (clock − source) differ by at most this (a read is ±0.5 s, plus drift). */
const SAME = 1.5;
/** Frames read at once while narrowing to the frame a second begins. */
const NARROW = 7;
/** Rounds of filling in gaps where a stretch nobody has read could hide, and the frames a round. */
const FILL_ROUNDS = 3;
const FILL_MOST = 60;
/** The most frames one ask reads, over every file. */
const READ_MOST = 600;

/** A clock as shown: the day of its date (days since 1970-01-01; null when it shows none) and the second of the day. */
export interface Clock {
  day: number | null;
  second: number;
  /** The second was given (a clock always shows it; an asked time may stop at the minute). */
  seconds: boolean;
}

/** What reads a file: media.ts's Processor (`app.media`). */
export interface Reader {
  analysisInput(source: string): Promise<string>;
}

/** The engine's reads, for tests to stand in for. */
export const hooks = {
  /** The words in `region` of the frames at `times` (seconds), at the file's own size (screen_text.rs `read_at`). */
  readAt: (input: string, size: [number, number], fps: number, region: Box, times: number[]): Promise<ScreenText[][]> => {
    const at = native().screenTextAt;
    if (at === undefined) throw new Error("Edit's engine here is older than find_camera_time: it reads camera clocks once Edit restarts on its new build");
    return at(input, size, fps, region, times);
  },
  /** screen_text's 960-wide words at whole seconds (kept with the file, shared with the audit). */
  detect: (input: string, size: [number, number], seconds: number[]): Promise<Record<number, ScreenText[]>> => native().screenTextDetect(input, size, seconds),
  cached: (input: string): Record<number, ScreenText[]> | null => native().screenTextCached(input),
};

// ---------------------------------------------------------------------------
// Reading a clock

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** OCR's usual slips in numbers: O for 0, l, I or | for 1, ; for :. */
function cleaned(text: string): string {
  let out = text.toUpperCase().replaceAll(";", ":");
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/(?<=[\d:])O|O(?=[\d:])/gu, "0").replace(/(?<=[\d:])[LI|]|(?<=\d[.'’])[LI|](?=\d)|[LI|](?=[\d:]\d)/gu, "1");
  }
  return out;
}

function dayOf(year: number, month: number, day: number): number | null {
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  return back.getUTCDate() === day && back.getUTCMonth() === month - 1 ? Math.round(at / 86_400_000) : null;
}

/** The date in `text` (already cleaned), as a day number, or null. */
function dateIn(text: string): number | null {
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3)) + 1;
  let m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u.exec(text);
  if (m !== null) return dayOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/u.exec(text);
  if (m !== null) {
    let [a, b] = [Number(m[1]), Number(m[3])];
    // Dots are day first (14.05.2023); slashes and dashes month first, as US cameras show it, unless that can't be.
    if (m[2] === "." || (a > 12 && b <= 12)) [a, b] = [b, a];
    return dayOf(Number(m[4]), a, b);
  }
  const names = MONTHS.join("|");
  m = new RegExp(`(\\d{1,2})(?:ST|ND|RD|TH)?[\\s.,-]*(${names})[A-Z]*\\.?[\\s.,-]*(\\d{4})`, "u").exec(text);
  if (m !== null) return dayOf(Number(m[3]), month(m[2]!), Number(m[1]));
  m = new RegExp(`(${names})[A-Z]*\\.?[\\s.,-]*(\\d{1,2})(?:ST|ND|RD|TH)?[\\s.,-]*(\\d{4})`, "u").exec(text);
  if (m !== null) return dayOf(Number(m[3]), month(m[1]!), Number(m[2]));
  return null;
}

/**
 * The clock in `text`: its time (12 or 24 hour, "T14:32:05", "2:32:05 PM"),
 * with the date beside it when there is one ("2023-05-14", "05/14/2023",
 * "14 MAY 2023"); a zone after it ("Z", "-0500") is left as written, as the
 * person reads it off the screen. A time without seconds only when
 * `minutes` (an asked time, never a clock read off a frame).
 */
export function parseClock(text: string, minutes = false): Clock | null {
  const clean = cleaned(text);
  // Colons first (a date glued to the time, "2019-07-3000:23:33", still reads); then what Vision makes of a clock
  // with no colon read as one ("T14..32..02", "T14'.32.'00", "T14.'40:.1.2").
  const strict = /(\d{1,2})\s?:\s?(\d{2})(?:\s?:\s?(\d{2}))?(?:\s*([AP])\.?\s?M\b\.?)?/u.exec(clean);
  const time = strict === null ? looseTime(clean) : { at: strict.index, length: strict[0].length, parts: [strict[1], strict[2], strict[3], strict[4]] };
  if (time === null) return null;
  const [hours, minutes_, seconds_, half] = time.parts;
  if (seconds_ === undefined && !minutes) return null;
  let hour = Number(hours);
  const minute = Number(minutes_);
  const second = seconds_ === undefined ? 0 : Number(seconds_);
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "P" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  const rest = clean.slice(0, time.at) + " " + clean.slice(time.at + time.length);
  return { day: dateIn(rest), second: hour * 3600 + minute * 60 + second, seconds: seconds_ !== undefined };
}

/**
 * A clock whose colons the reader didn't see as colons: a run of digits and the marks it read in their place
 * (. ' , :), two or more of them, holding five or six digits (H:MM:SS, HH:MM:SS). A dotted date
 * ("2023.05.14", eight digits) or a serial ("X81.234567") isn't one.
 */
function looseTime(clean: string): { at: number; length: number; parts: (string | undefined)[] } | null {
  for (const run of clean.matchAll(/[\d.'’,:]+/gu)) {
    const trimmed = run[0].replace(/^\D+/u, "");
    const body = trimmed.replace(/\D+$/u, "");
    const digits = body.replace(/\D/gu, "");
    const marks = body.split(/\d+/u).filter((mark) => mark !== "").length;
    if (marks < 2 || (digits.length !== 5 && digits.length !== 6)) continue;
    const at = run.index + run[0].length - trimmed.length;
    const half = /^\s*([AP])\.?\s?M\b\.?/u.exec(clean.slice(at + body.length));
    const split = digits.length - 4;
    return {
      at,
      length: body.length + (half?.[0].length ?? 0),
      parts: [digits.slice(0, split), digits.slice(split, split + 2), digits.slice(split + 2), half?.[1]],
    };
  }
  return null;
}

/** A clock as the agent reads it: "2023-05-14 14:32:05", or "14:32:05" with no date. */
export function clockText(clock: Clock): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(Math.floor(clock.second / 3600))}:${pad(Math.floor(clock.second / 60) % 60)}:${pad(clock.second % 60)}`;
  return clock.day === null ? time : `${new Date(clock.day * 86_400_000).toISOString().slice(0, 10)} ${time}`;
}

/** Seconds from `from` to `to`: by the date when both show one, else by the time of day, the nearer way round. */
export function between(from: Clock, to: Clock): number {
  if (from.day !== null && to.day !== null) return (to.day - from.day) * 86_400 + to.second - from.second;
  const apart = (((to.second - from.second) % 86_400) + 86_400) % 86_400;
  return apart >= 43_200 ? apart - 86_400 : apart;
}

// ---------------------------------------------------------------------------
// Where the clock is

interface Anchor {
  box: Box;
  dated: boolean;
}

const centre = (box: Box): [number, number] => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

/** A line beside another: the line above or below it, or next to it on the same line. */
function besides(a: Box, b: Box): boolean {
  const [[ax, ay], [bx, by]] = [centre(a), centre(b)];
  return Math.abs(ay - by) < 0.08 && Math.abs(ax - bx) < 0.3;
}

/** The clock's places in a few frames' words: lines that read as a clock, grouped by where they sit (a dated one over an undated timer). */
export function anchorsOf(frames: ScreenText[][]): Anchor[] {
  const groups: { boxes: Box[]; dated: number }[] = [];
  for (const lines of frames) {
    for (const line of lines) {
      const clock = parseClock(line.t);
      if (clock === null) continue;
      const [x, y] = centre(line.b);
      const near = groups.find((group) => {
        const [gx, gy] = centre(group.boxes[0]!);
        return Math.abs(gx - x) < 0.06 && Math.abs(gy - y) < 0.04;
      });
      // A date in a box of its own beside the time (Vision reads "2023-05-14" and "T14..32..04" apart): read with it.
      const date = clock.day === null ? lines.find((other) => other !== line && besides(other.b, line.b) && dateIn(cleaned(other.t)) !== null) : undefined;
      const dated = clock.day !== null || date !== undefined;
      const boxes = date === undefined ? [line.b] : [line.b, date.b];
      if (near === undefined) groups.push({ boxes, dated: dated ? 1 : 0 });
      else {
        near.boxes.push(...boxes);
        near.dated += dated ? 1 : 0;
      }
    }
  }
  const anchors = groups.map((group) => ({
    box: [Math.min(...group.boxes.map((b) => b[0])), Math.min(...group.boxes.map((b) => b[1])), Math.max(...group.boxes.map((b) => b[2])), Math.max(...group.boxes.map((b) => b[3]))] as Box,
    dated: group.dated > 0,
    count: group.boxes.length,
  }));
  const dated = anchors.filter((anchor) => anchor.dated);
  return (dated.length > 0 ? dated : anchors).sort((a, b) => b.count - a.count).map(({ box, dated }) => ({ box, dated }));
}

/** What to read: the anchors grown to take a date line beside them and a wider time, as one box. */
export function regionOf(anchors: Anchor[]): Box {
  const grown = anchors.map(({ box }) => {
    const [w, h] = [box[2] - box[0], box[3] - box[1]];
    const across = Math.max(w * 0.4, 0.03);
    const down = Math.max(h * 1.5, 0.03);
    return [box[0] - across, box[1] - down, box[2] + across, box[3] + down] as Box;
  });
  const clamp = (value: number) => round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return [
    clamp(Math.min(...grown.map((b) => b[0]))),
    clamp(Math.min(...grown.map((b) => b[1]))),
    clamp(Math.max(...grown.map((b) => b[2]))),
    clamp(Math.max(...grown.map((b) => b[3]))),
  ];
}

/** The clock in one frame's words: the time line nearest an anchor (a dated one first), its date from a line beside it when it shows none. */
export function clockIn(lines: ScreenText[], anchors: Anchor[]): { clock: Clock; text: string } | null {
  let best: { clock: Clock; text: string; score: number } | null = null;
  for (const line of lines) {
    const clock = parseClock(line.t);
    if (clock === null) continue;
    const [x, y] = centre(line.b);
    const distance = Math.min(...anchors.map(({ box }) => Math.hypot(centre(box)[0] - x, centre(box)[1] - y)));
    if (distance > 0.15) continue;
    let text = line.t.trim();
    if (clock.day === null) {
      const beside = lines.find((other) => other !== line && besides(other.b, line.b) && dateIn(cleaned(other.t)) !== null);
      if (beside !== undefined) {
        clock.day = dateIn(cleaned(beside.t));
        text = `${beside.t.trim()} ${text}`;
      }
    }
    const score = distance - (clock.day !== null ? 1 : 0);
    if (best === null || score < best.score) best = { clock, text, score };
  }
  return best === null ? null : { clock: best.clock, text: best.text };
}

// ---------------------------------------------------------------------------
// Stretches

/** A frame's clock as read. */
export interface Read {
  frame: number;
  clock: Clock;
  text: string;
}

/**
 * Two reads are one stretch when their clocks are as far apart as the frames are (a read is ±0.5 s, and a little
 * drift). By the date when both show one, else by the time of day: a date the reader missed on one frame (Vision
 * reads it as a box of its own, now and then not at all) doesn't split a stretch.
 */
export function sameStretch(a: Read, b: Read, fps: number): boolean {
  return Math.abs(between(a.clock, b.clock) - (b.frame - a.frame) / fps) <= SAME;
}

/** The reads (in frame order) as continuous stretches of the clock; a lone read out of step with both neighbours that agree is a misread, dropped. */
export function stretchesOf(reads: Read[], fps: number): Read[][] {
  const sorted = [...reads].sort((a, b) => a.frame - b.frame);
  const kept = sorted.filter((read, index) => {
    const before = sorted[index - 1];
    const after = sorted[index + 1];
    if (before === undefined || after === undefined) return true;
    return sameStretch(before, read, fps) || sameStretch(read, after, fps) || !sameStretch(before, after, fps);
  });
  const out: Read[][] = [];
  for (const read of kept) {
    const last = out[out.length - 1];
    if (last !== undefined && sameStretch(last[last.length - 1]!, read, fps)) last.push(read);
    else out.push([read]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// One file

interface State {
  /** The rate its frames are numbered at. */
  fps: number;
  /** Where its clock is (null: it shows none), once looked for. */
  anchors: Anchor[] | null;
  region: Box | null;
  /** Frame → the words read in `region` there. */
  reads: Record<number, ScreenText[]>;
  /** The coarse pass is done. */
  coarse: boolean;
}

/** What a file needs: a probed media will do. */
export type Footage = Pick<Media, "id" | "name" | "path" | "kind" | "duration" | "width" | "height" | "fps">;

const known = new Map<string, State>();
/** One ask of a file at a time. */
const busy = new Map<string, Promise<unknown>>();

function stateFile(path: string): string | null {
  if (!isReal()) return null;
  const dir = tools.mediaCache(path);
  return dir === null ? null : join(dir, FILE);
}

function load(media: Footage): State | null {
  const hit = known.get(media.path);
  if (hit !== undefined && hit.fps === media.fps) return hit;
  const file = stateFile(media.path);
  if (file === null) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as State;
    if (state.fps !== media.fps || typeof state.reads !== "object") return null;
    known.set(media.path, state);
    return state;
  } catch {
    return null;
  }
}

function save(media: Footage, state: State): void {
  known.set(media.path, state);
  const file = stateFile(media.path);
  if (file === null) return;
  try {
    fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch (error) {
    diag.warn("media", `keeping camera clock reads of ${diag.scrub(media.path)}: ${diag.messageOf(error)}`);
  }
}

/** For tests: forget what's kept in memory. */
export function reset(): void {
  known.clear();
  busy.clear();
}

/** One ask's work on a file: its reads, kept as they come. */
class File {
  readonly fps: number;
  readonly frames: number;
  readonly size: [number, number];
  constructor(
    readonly media: Footage,
    readonly input: string,
    readonly state: State,
    readonly budget: { left: number },
  ) {
    this.fps = media.fps > 0 ? media.fps : 30;
    this.frames = Math.max(1, Math.floor((media.duration ?? 0) * this.fps));
    this.size = [media.width || 1920, media.height || 1080];
  }

  clockAt(frame: number): Read | null | undefined {
    const lines = this.state.reads[frame];
    if (lines === undefined) return undefined;
    const found = clockIn(lines, this.state.anchors ?? []);
    return found === null ? null : { frame, ...found };
  }

  /** Reads `frames` not read yet (within the ask's budget). */
  async read(frames: number[]): Promise<void> {
    const wanted = [...new Set(frames.map((frame) => Math.min(this.frames - 1, Math.max(0, Math.round(frame)))))].filter((frame) => this.state.reads[frame] === undefined);
    const now = wanted.slice(0, Math.max(0, this.budget.left));
    if (now.length === 0 || this.state.region === null) return;
    this.budget.left -= now.length;
    // A quarter into each frame, so a time on its edge can't land on its neighbour.
    const lines = await hooks.readAt(this.input, this.size, this.fps, this.state.region, now.map((frame) => (frame + 0.25) / this.fps));
    now.forEach((frame, index) => (this.state.reads[frame] = lines[index] ?? []));
    save(this.media, this.state);
  }

  reads(): Read[] {
    return Object.keys(this.state.reads)
      .map(Number)
      .sort((a, b) => a - b)
      .flatMap((frame) => {
        const read = this.clockAt(frame);
        return read === null || read === undefined ? [] : [read];
      });
  }
}

/** Finds where `media`'s clock is: from screen_text's words kept with it, else a few frames read now. */
async function locate(file: File): Promise<void> {
  const { state, media } = file;
  if (state.anchors !== null || state.region !== null) return;
  const duration = media.duration ?? 0;
  const kept = hooks.cached(file.input) ?? {};
  let frames = Object.values(kept).filter((lines) => lines.some((line) => parseClock(line.t) !== null));
  if (frames.length < 2) {
    const seconds = [...new Set(LOCATE_AT.map((share) => Math.floor(duration * share)))].filter((second) => second >= 0 && second < duration);
    const read = await hooks.detect(file.input, file.size, seconds);
    frames = [...frames, ...Object.values(read)];
  }
  let anchors = anchorsOf(frames);
  if (anchors.length === 0 && duration > 0) {
    // Too small for the 960-wide read (a stamp a dozen pixels high there, under Vision's least text height, a
    // 32nd of the picture's): the picture's top and bottom bands, where cameras put their clocks, at the file's own size.
    const times = [0.2, 0.5, 0.8].map((share) => Math.floor(duration * share * file.fps) / file.fps);
    const bands = await Promise.all(BANDS.map((band) => hooks.readAt(file.input, file.size, file.fps, band, times)));
    anchors = anchorsOf(times.map((_, index) => bands.flatMap((band) => band[index] ?? [])));
  }
  state.anchors = anchors;
  state.region = anchors.length === 0 ? null : regionOf(anchors);
  save(media, state);
  diag.info("media", `${media.name}: camera clock ${state.region === null ? "none" : `at ${state.region.join(" ")}`}`);
}

/** The coarse pass: frames spread over the file. */
async function coarse(file: File): Promise<void> {
  if (file.state.coarse || file.state.region === null) return;
  const duration = file.media.duration ?? 0;
  const step = Math.max(COARSE_LEAST_STEP, duration / COARSE_MOST);
  const frames: number[] = [];
  for (let at = step / 2; at < duration; at += step) frames.push(Math.floor(at * file.fps));
  await diag.timeOnAsync("media", "media: camera clock (coarse)", file.media.path, () => file.read(frames));
  // Done only once it's all read (an ask out of reads leaves the rest to the next).
  file.state.coarse = frames.every((frame) => file.state.reads[Math.min(file.frames - 1, frame)] !== undefined);
  save(file.media, file.state);
}

/** Where an asked time is in a file. */
export interface Hit {
  media: string;
  name: string;
  /** Source seconds of the first frame showing it, and of the first showing the next second (null: the shot ends or can't be read). */
  at: number;
  until: number | null;
  /** The clock read there, written plainly ("2023-05-14 14:32:05"; the reader's own text has Vision's dots for colons). */
  clock: string;
  /** Frames either side the answer may be off by (0: exact). */
  within: number;
}

/** A stretch of a file's clock, for saying what it does have. */
export interface Span {
  media: string;
  name: string;
  from: number;
  to: number;
  clock_from: string;
  clock_to: string;
  /** Seconds of clock from the asked time to the stretch (negative: before it). */
  away: number;
}

/** Before the asked second, at or past it, another stretch's clock, no clock read there (a title card, a graphic), or not read. */
type Side = "before" | "at" | "other" | "none" | "unknown";

/** Narrows (lo, hi] to the first frame where `side` says "at": lo is "before", hi "at", frames read NARROW at a time; what it can't read is skipped. */
async function narrow(file: File, lo: number, hi: number, side: (frame: number) => Side): Promise<[number, number]> {
  while (hi - lo > 1) {
    const count = Math.min(NARROW, hi - lo - 1);
    const inside = [...new Set(Array.from({ length: count }, (_, index) => Math.round(lo + ((index + 1) * (hi - lo)) / (count + 1))))];
    await file.read(inside);
    let [newLo, newHi] = [lo, hi];
    for (const frame of inside) {
      const now = side(frame);
      if (now === "before") newLo = Math.max(newLo, frame);
      if (now === "at") {
        newHi = frame;
        break;
      }
    }
    if (newLo === lo && newHi === hi) break;
    [lo, hi] = [newLo, newHi];
  }
  return [lo, hi];
}

/** How `frame` stands to `asked` in `stretch`'s clock. */
function sideOf(file: File, stretch: Read, asked: Clock, frame: number): Side {
  const read = file.clockAt(frame);
  if (read === undefined) return "unknown";
  if (read === null) return "none";
  if (!sameStretch(stretch, read, file.fps)) return "other";
  return between(asked, read.clock) >= 0 ? "at" : "before";
}

/** The first frame showing `asked` in the stretch `stretch` belongs to, near `estimate` (source seconds), or null when the stretch doesn't hold it. */
async function firstShowing(file: File, stretch: Read, asked: Clock, estimate: number): Promise<{ frame: number; within: number } | null> {
  const { fps } = file;
  const side = (frame: number) => sideOf(file, stretch, asked, frame);
  // Within the stretch: another's frames, or a frame whose clock didn't read, are no help either way.
  const within = (frame: number): Side => {
    const now = side(frame);
    return now === "other" || now === "none" ? "unknown" : now;
  };
  // Where the stretch starts or ends: no clock, or another's.
  const away = (now: Side) => now === "other" || now === "none";
  // A window either side of the estimate (the clock's phase is known to a second).
  let from = Math.floor((estimate - 1.2) * fps);
  let to = Math.ceil((estimate + 1.2) * fps);
  // What's read already may hold it (an ask again, a time read around before): narrowed from there, reading nothing new when it's settled.
  const read = Object.keys(file.state.reads)
    .map(Number)
    .filter((frame) => frame >= from - fps && frame <= to + fps)
    .sort((a, b) => a - b);
  const knownAt = read.find((frame) => side(frame) === "at");
  const knownBefore = knownAt === undefined ? undefined : read.filter((frame) => frame < knownAt && side(frame) === "before").at(-1);
  if (knownAt !== undefined && knownBefore !== undefined && !read.some((frame) => frame > knownBefore && frame < knownAt && away(side(frame)))) {
    const [lo, hi] = await narrow(file, knownBefore, knownAt, within);
    return { frame: hi, within: hi - lo - 1 };
  }
  for (let tries = 0; tries < 3; tries++) {
    const points = [...new Set(Array.from({ length: NARROW }, (_, index) => Math.round(from + (index * (to - from)) / (NARROW - 1))))].filter((frame) => frame >= 0 && frame < file.frames);
    await file.read(points);
    const sides = points.map((frame) => [frame, side(frame)] as const);
    const firstAt = sides.find(([, now]) => now === "at");
    const lastBefore = [...sides].reverse().find(([frame, now]) => now === "before" && (firstAt === undefined || frame < firstAt[0]));
    if (firstAt !== undefined && lastBefore !== undefined) {
      const [lo, hi] = await narrow(file, lastBefore[0], firstAt[0], within);
      return { frame: hi, within: hi - lo - 1 };
    }
    if (firstAt !== undefined) {
      const otherBefore = [...sides].reverse().find(([frame, now]) => away(now) && frame < firstAt[0]);
      if (otherBefore === undefined && firstAt[0] > 0) {
        // The second began before the window.
        from -= Math.round(fps);
        to = firstAt[0];
        continue;
      }
      // A cut into the stretch before it: where the stretch starts.
      let start = firstAt[0];
      if (otherBefore !== undefined) {
        [, start] = await narrow(file, otherBefore[0], firstAt[0], (frame) => {
          const now = side(frame);
          return away(now) ? "before" : now === "unknown" ? "unknown" : "at";
        });
      }
      const opening = side(start);
      if (opening === "before") {
        const [lo, hi] = await narrow(file, start, firstAt[0], within);
        return { frame: hi, within: hi - lo - 1 };
      }
      const read = file.clockAt(start);
      // The stretch opens past the asked second: it was cut out.
      if (read === null || read === undefined || between(asked, read.clock) > 0) return null;
      return { frame: start, within: 0 };
    }
    if (lastBefore !== undefined) {
      // All before it: it's later, unless the stretch ends in the window (the second cut out).
      if (sides.some(([frame, now]) => away(now) && frame > lastBefore[0])) return null;
      from = lastBefore[0];
      to += Math.round(fps);
      continue;
    }
    return null;
  }
  return null;
}

/** Every place `asked` shows in `file`, and its stretches (for saying what it has when it doesn't). */
async function search(file: File, asked: Clock): Promise<{ hits: Hit[]; spans: Span[] }> {
  const { fps, media } = file;
  const tried = new Set<string>();
  const hits: Hit[] = [];
  for (let pass = 0; ; pass++) {
    const all = file.reads();
    const stretches = stretchesOf(all, fps);
    for (const [index, stretch] of stretches.entries()) {
      // The read in it nearest the asked time, and the source second that time would begin at (its phase in the middle).
      const nearest = stretch.reduce((best, read) => (Math.abs(between(read.clock, asked)) < Math.abs(between(best.clock, asked)) ? read : best));
      const estimate = nearest.frame / fps + between(nearest.clock, asked) - 0.5;
      // Up to the stretches either side: what's between, unread, could be it.
      const lo = stretches[index - 1]?.at(-1)?.frame ?? -1;
      const hi = stretches[index + 1]?.[0]?.frame ?? file.frames;
      if (estimate * fps < lo - fps || estimate * fps > hi + fps) continue;
      const key = `${stretch[0]!.frame}:${Math.round(estimate)}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const found = await firstShowing(file, nearest, asked, estimate);
      if (found === null || hits.some((hit) => Math.abs(hit.at * fps - found.frame) < fps)) continue;
      const read = file.clockAt(found.frame)!;
      const end = await untilNext(file, read, asked, found.frame);
      hits.push({ media: media.id, name: media.name, at: round3(found.frame / fps), until: end === null ? null : round3(end / fps), clock: clockText(read.clock), within: found.within });
    }
    const spans = () => stretchesOf(file.reads(), fps).map((stretch) => spanOf(file, stretch, asked));
    if (hits.length > 0 || pass >= FILL_ROUNDS || file.budget.left <= 0) return { hits, spans: spans() };
    // Not in a stretch read so far: fill in the gaps an unread one could be in (between reads of different stretches, or of none).
    const frames = Object.keys(file.state.reads)
      .map(Number)
      .sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let index = 1; index < frames.length; index++) {
      const [a, b] = [frames[index - 1]!, frames[index]!];
      if (b - a <= 2 * fps) continue;
      const [x, y] = [file.clockAt(a), file.clockAt(b)];
      // Not between two frames with no clock (a title card, a graphic): nothing to find there.
      if ((x === null || x === undefined) && (y === null || y === undefined)) continue;
      if (x === null || x === undefined || y === null || y === undefined || !sameStretch(x, y, fps)) gaps.push(Math.round((a + b) / 2));
    }
    if (gaps.length === 0) return { hits, spans: spans() };
    await file.read(gaps.slice(0, FILL_MOST));
  }
}

/** Where the asked second ends after `from`: the first frame of the next second, or where its shot ends (a cut away); null when it can't be read. */
async function untilNext(file: File, at: Read, asked: Clock, from: number): Promise<number | null> {
  const next: Clock = { day: asked.day === null ? null : asked.day + (asked.second === 86_399 ? 1 : 0), second: (asked.second + 1) % 86_400, seconds: true };
  const found = await firstShowing(file, at, next, from / file.fps + 1);
  if (found !== null && found.frame > from) return found.frame;
  const other = Object.keys(file.state.reads)
    .map(Number)
    .filter((frame) => frame > from && frame <= from + 1.5 * file.fps)
    .sort((a, b) => a - b)
    .find((frame) => ["other", "none"].includes(sideOf(file, at, next, frame)));
  if (other === undefined) return null;
  const [, cut] = await narrow(file, from, other, (frame) => {
    const now = sideOf(file, at, next, frame);
    return now === "other" || now === "none" ? "at" : now === "unknown" ? "unknown" : "before";
  });
  return cut;
}

function spanOf(file: File, stretch: Read[], asked: Clock): Span {
  const first = stretch[0]!;
  const last = stretch[stretch.length - 1]!;
  const before = between(asked, last.clock);
  const after = between(asked, first.clock);
  return {
    media: file.media.id,
    name: file.media.name,
    from: round3(first.frame / file.fps),
    to: round3(last.frame / file.fps),
    clock_from: clockText(first.clock),
    clock_to: clockText(last.clock),
    away: before < 0 ? before : after > 0 ? after : 0,
  };
}

function round3(value: number): number {
  return round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// The tool

export interface Answer {
  results: { time: string; found: Hit[]; nearest?: Span[]; note?: string }[];
  /** Files with no clock to read. */
  no_clock: string[];
  /** Files left unsearched when the ask ran out of reads. */
  not_searched?: string[];
}

/**
 * Where each of `times` (as the person wrote them) shows on the clocks of
 * `media` (each video in order: the ones on the timeline first): the first
 * frame of that second, exact to the frame.
 */
export async function find(reader: Reader, media: Footage[], times: string[]): Promise<Answer> {
  const asked = times.map((text) => ({ text, clock: parseClock(text, true) }));
  const bad = asked.find((one) => one.clock === null);
  if (bad !== undefined) throw new Error(`"${bad.text}" isn't a time: give it as the clock shows it ("14:32:05", "2:32:05 PM", "2023-05-14 14:32:05")`);
  const budget = { left: READ_MOST };
  const videos = media.filter((one) => one.kind === "video" && (one.duration ?? 0) > 0);
  const files: File[] = [];
  const noClock: string[] = [];
  const notSearched: string[] = [];
  for (const one of videos) {
    if (budget.left <= 0) {
      notSearched.push(one.name);
      continue;
    }
    try {
      const file = await opened(reader, one, budget);
      if (file.state.region === null) noClock.push(one.name);
      else files.push(file);
    } catch (error) {
      diag.warn("media", `reading ${one.name}'s camera clock: ${diag.messageOf(error)}`);
      noClock.push(`${one.name} (couldn't be read: ${diag.messageOf(error)})`);
    }
  }
  const results: Answer["results"] = [];
  for (const { text, clock } of asked) {
    const found: Hit[] = [];
    const spans: Span[] = [];
    for (const file of files) {
      const done = await withFile(file.media.path, () => search(file, clock!));
      found.push(...done.hits);
      spans.push(...done.spans);
    }
    const result: Answer["results"][number] = { time: text, found };
    if (found.length === 0 && files.length === 0) result.note = "none of the footage searched shows a clock Edit can read";
    if (found.length === 0 && files.length > 0) {
      result.nearest = spans.sort((a, b) => Math.abs(a.away) - Math.abs(b.away)).slice(0, 3);
      result.note = `${text} isn't on the clock of the footage read: the nearest stretches it shows are in nearest (source seconds from–to, the clock there)`;
    }
    if (!clock!.seconds) result.note = [result.note, "to the minute: the frame its :00 begins"].filter(Boolean).join("; ");
    results.push(result);
  }
  const answer: Answer = { results, no_clock: noClock };
  if (notSearched.length > 0) answer.not_searched = notSearched;
  return answer;
}

/**
 * Where `media`'s clock shows (shares of the picture, the date and a wider
 * time taken in: `regionOf`), found once and kept with it; null when it shows
 * none (subtitle_removal.ts keeps the camera's own stamp as it was).
 */
export async function clockRegion(reader: Reader, media: Footage): Promise<Box | null> {
  return withFile(media.path, async () => {
    const state: State = load(media) ?? { fps: media.fps, anchors: null, region: null, reads: {}, coarse: false };
    if (state.anchors === null && state.region === null) await locate(new File(media, await reader.analysisInput(media.path), state, { left: READ_MOST }));
    return state.region;
  });
}

/** `media`'s state, its clock found and its coarse pass read. */
async function opened(reader: Reader, media: Footage, budget: { left: number }): Promise<File> {
  return withFile(media.path, async () => {
    const state: State = load(media) ?? { fps: media.fps, anchors: null, region: null, reads: {}, coarse: false };
    const input = await reader.analysisInput(media.path);
    const file = new File(media, input, state, budget);
    await locate(file);
    await coarse(file);
    return file;
  });
}

async function withFile<T>(path: string, work: () => Promise<T>): Promise<T> {
  const before = busy.get(path) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(work);
  busy.set(path, mine);
  try {
    return await mine;
  } finally {
    if (busy.get(path) === mine) busy.delete(path);
  }
}

/** The videos to search in `project`: `ids` when given, else every video, the ones on the timeline first. */
export function footageOf(project: Project, ids: string[] | null): Footage[] {
  if (ids !== null) {
    return ids.map((id) => {
      const media = project.media.find((one) => one.id === id);
      if (media === undefined) throw new Error(`no media ${id}`);
      if (media.kind !== "video") throw new Error(`${media.name} isn't a video`);
      return media;
    });
  }
  const used = new Set(project.clips.flatMap((clip) => ("media" in clip && typeof clip.media === "string" ? [clip.media] : [])));
  const videos = project.media.filter((media) => media.kind === "video");
  return [...videos.filter((media) => used.has(media.id)), ...videos.filter((media) => !used.has(media.id))];
}
