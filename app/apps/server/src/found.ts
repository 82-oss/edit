// What's laid over a footage file by whoever uploaded it before us, found once a
// file by the finder (finder/find.py: their captions exact to the frame, their
// labels and channel marks, their notes), and kept as boxes by frame. Sphe, Nov
// 22: the marks an agent made and the words a track read left too much behind
// (a one-word subtitle between two reads, a channel's mark nobody read, a slowed
// copy too short to learn from), so nothing here waits on an agent's marks and
// no model is asked where text is.
//
// A file's boxes are kept by its source (`<cache>/cleaned/found/`), so a re-cut,
// a second project of the same case or a restart reads nothing again; a file is
// read again only when the timeline shows seconds of it the finder never looked
// at. The finder reads the file whole (a survey three times a second, then every
// second frame of where its captions are), classes what it found by how it
// behaves (a label holds its place through a change of scene, what's filmed
// never does), and hands the few things no rule settles (a one-off line, a
// label that could be the camera's own read-out) to a judge with a picture of
// each: Opus, asked "laid over, the camera's, or filmed?".
//
// text_blur.ts reads a stretch's track from here before anything else
// (`samplesFor`), and text_removal.ts plans the seconds to take out from here
// (`spansOf`), so the tracked blur and the model's clean both follow these
// boxes. Captions and notes are slots `c…`, labels `l…`, marks `m…`: the model
// cleans the captions' band, the blur keeps the rest (a label at the top and a
// caption at the bottom would be one band the height of the picture).
//
// The finder runs on RunPod's GPU pool when RunPod removal is on (remover_cloud.ts:
// every Mac gets the new finder, files scan side by side, and finished boxes are
// shared on R2 by source so nothing is scanned twice). When RunPod is off it runs
// locally where installed (Linux, an NVIDIA GPU, `~/.local/share/edit-finder/venv`);
// elsewhere `available()` is false and removal goes on as before, by the agent's marks.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as claudeAi from "./ai_claude.ts";
import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import type { Media } from "./model.ts";
import { native, type Box } from "./native/index.ts";
import { join } from "./paths.ts";
import { merged } from "./removal_sections.ts";
import * as removerCloud from "./remover_cloud.ts";
import { Semaphore } from "./semaphore.ts";
import type { Sample } from "./text_track.ts";
import * as tools from "./tools.ts";
import * as claude from "./writer/claude.ts";

import assembleSource from "./finder/assemble.py" with { type: "text" };
import candsSource from "./finder/cands.py" with { type: "text" };
import captionsSource from "./finder/captions.py" with { type: "text" };
import denseSource from "./finder/dense.py" with { type: "text" };
import eventsSource from "./finder/events.py" with { type: "text" };
import findSource from "./finder/find.py" with { type: "text" };
import glideSource from "./finder/glide.py" with { type: "text" };
import marksSource from "./finder/marks.py" with { type: "text" };
import masksSource from "./finder/masks.py" with { type: "text" };
import notesSource from "./finder/notes.py" with { type: "text" };
import ocrSource from "./finder/ocr.py" with { type: "text" };
import roamtrackSource from "./finder/roamtrack.py" with { type: "text" };
import scanSource from "./finder/scan.py" with { type: "text" };
import slowcopySource from "./finder/slowcopy.py" with { type: "text" };
import thumbsSource from "./finder/thumbs.py" with { type: "text" };
import zoneSource from "./finder/zone.py" with { type: "text" };
import minimaxSource from "./minimax_worker.py" with { type: "text" };

const SCRIPTS: Record<string, string> = {
  "assemble.py": assembleSource,
  "cands.py": candsSource,
  "captions.py": captionsSource,
  "dense.py": denseSource,
  "events.py": eventsSource,
  "find.py": findSource,
  "glide.py": glideSource,
  "marks.py": marksSource,
  "masks.py": masksSource,
  "notes.py": notesSource,
  "ocr.py": ocrSource,
  "roamtrack.py": roamtrackSource,
  "scan.py": scanSource,
  "slowcopy.py": slowcopySource,
  "minimax_worker.py": minimaxSource,
  "thumbs.py": thumbsSource,
  "zone.py": zoneSource,
};

/** One box of theirs over frames [first, last] of the file, in its own pixels: [first, last, x0, y0, x1, y1, kind]. */
export type Mask = [number, number, number, number, number, number, string];

/** A file's boxes (finder/find.py `finish`). `covered`: the source seconds the finder looked at. */
export interface Found {
  version: 1;
  width: number;
  height: number;
  fps: number;
  covered: [number, number][];
  masks: Mask[];
}

export const VERSION = 1;
/** The finder looks a second past each shown stretch (scan.py `PAD`). */
const LOOKED_PAST_S = 1;
/** Stretches of theirs closer than this are one; each is taken out from a little before to a little after. */
const JOIN_S = 1;
const AROUND_S = 0.25;
/** No stretch longer than this: each is one piece for the model (a piece that fails is that much blurred, no more). */
export const LONGEST_S = 30;

const INSTALLED = join(os.homedir(), ".local", "share", "edit-finder");
/** Files scanned in parallel when the finder runs on RunPod. */
const CLOUD_AT_ONCE = 6;
/**
 * Files scanned in parallel on this computer's own card: two, as the finder reads a file through FFmpeg and leaves the
 * card mostly idle (Nov 26, mandalorian's 4060: 30% busy, 4.5 of 8 GB used, one file at a time, 12 to 45 min a file,
 * about 21 files for four compilations); not more, as a card past its memory hung NVIDIA's driver there on Nov 22.
 */
const LOCAL_AT_ONCE = 2;
let scriptsJsonCache: string | null = null;
const scriptsJson = (): string => (scriptsJsonCache ??= JSON.stringify(SCRIPTS));

// ---------------------------------------------------------------------------
// Where it runs

/** For tests: a stand-in for the finder's two steps and the judge. */
export interface StandIn {
  find(job: { mid: string; video: string; spans: [number, number][]; parent: string | null }): Promise<{ ask: Asked[]; sheets: string[] }>;
  finish(job: { mid: string; parent: string | null; verdicts: Record<string, Verdict> }): Promise<Found>;
}
let standIn: StandIn | null = null;
export const useFinderForTests = (given: StandIn | null): void => {
  standIn = given;
  availableHere = null;
};

let availableHere: boolean | null = null;
/** Whether this machine has the local finder installed, on an NVIDIA card (natively or under WSL: remover_cloud.ts `finderHere`). */
function localAvailable(): boolean {
  if (availableHere !== null) return availableHere;
  availableHere = process.env.NODE_ENV !== "test" && removerCloud.finderHere();
  return availableHere;
}

/** Whether Edit finds what's theirs with the finder: via RunPod (every OS) or locally (Linux + NVIDIA). */
export function available(): boolean {
  if (standIn !== null) return true;
  if (removerCloud.now()) return true;
  return localAvailable();
}

// ---------------------------------------------------------------------------
// The store

const slug = (source: string) => source.replace(/[^a-z0-9]+/giu, "-").slice(0, 80);
const fileOf = (app: App, source: string) => join(app.store.cacheDir(), "cleaned", "found", `${slug(source)}.v${VERSION}.json`);
const parentFileOf = (app: App, source: string) => join(app.store.cacheDir(), "cleaned", "found", `${slug(source)}.v${VERSION}.parent.json`);
const cloudKeyOf = (source: string) => `edit/cleaned/found/${createHash("sha256").update(source).digest("hex").slice(0, 32)}.v${VERSION}.json`;
const kept = new Map<string, Found | null>();

/** A file's boxes, when the finder has read it. */
export function foundOf(app: App, source: string): Found | null {
  const hit = kept.get(source);
  if (hit !== undefined && hit !== null) return hit;
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(app, source), "utf8")) as Found;
    if (raw.version !== VERSION || !Array.isArray(raw.masks)) return null;
    const read = asNow(raw);
    kept.set(source, read);
    void shareKept(app, source, read);
    return read;
  } catch {
    return null;
  }
}

/**
 * Stretches cleaned from the room's picture at once: each holds about 0.8 GB with its FFmpegs at its peak (an M1 Air,
 * Nov 24: 0.5 GB the engine, 0.3 GB FFmpeg), so one on an 8 GB Mac, more with room for the rest of Edit and the
 * person's apps, at most half the cores (each is one core) and eight.
 */
export function stillAtOnceFor(totalBytes: number, cores: number): number {
  const gb = totalBytes / 2 ** 30;
  return Math.max(1, Math.min(8, Math.floor(cores / 2), Math.floor((gb - 6) / 1.5)));
}
const stillSlots = new Semaphore(stillAtOnceFor(os.totalmem(), os.cpus().length));
/** A video's first stretch makes its room plate; the rest of that video wait for it and read it. */
const plating = new Map<string, Promise<unknown>>();

export interface StillRequest {
  input: string;
  input_args: string[];
  from: number;
  fps: number;
  width: number;
  height: number;
  matrix: string;
  masks: number[][][];
  out: string;
  beneath: unknown[];
}

/**
 * Their captions out of a stretch filmed by a camera that doesn't move, from the room itself (the engine's still.rs,
 * wherever the addon is, a Mac included): free, on this machine, and the picture is the real one, where the model
 * doubled a notepad and melted hands (Nov 23, the Hitman video). Null when the stretch isn't a still shot or this
 * machine can't: the model takes it as before. The engine stops a stretch that takes over 20 minutes (still.rs `LONGEST`).
 */
export async function stillClean(app: App, source: string, media: Media[], request: StillRequest, wanted: () => boolean = () => true): Promise<{ ok: true; box: Box | null; inferred: 0 } | null> {
  const addon = native();
  if (addon.stillClean === undefined || standIn !== null || foundOf(app, source) === null) return null;
  const key = source.split("#")[0]!;
  // Taken before anything is awaited: stretches of a video asked for together all found no plate being made and made
  // it at once, each (Nov 24: five at a time on a 16 GB Mac; an 8 GB Mac's one still-clean turn hid it).
  const before = plating.get(key);
  let made = (): void => {};
  if (before === undefined) {
    const gate = new Promise<void>((resolve) => (made = resolve));
    plating.set(key, gate);
    void gate.then(() => {
      if (plating.get(key) === gate) plating.delete(key);
    });
  }
  const others = media.filter((one) => one.kind === "video" && one.cloud?.source !== undefined && one.cloud.source !== source && one.cloud.source.split("#")[0] === key && foundOf(app, one.cloud.source) !== null);
  const also = await Promise.all(
    others.map(async (one) => {
      const input = await cloudMedia.originalInput(app.store.cacheDir(), one).catch(() => null);
      return input === null ? null : { input, input_args: tools.urlArgs(input), found: fileOf(app, one.cloud!.source!) };
    }),
  );
  const job = JSON.stringify({ ...request, found: fileOf(app, source), plates: join(app.store.cacheDir(), "cleaned", "plates"), key, also: also.filter((one) => one !== null) });
  try {
    await before;
    // Still wanted once its turn comes: a stretch the person stopped while it waited (an 8 GB Mac has one turn) is
    // never started (Nov 24, the M1 Air: two of Trooper's stopped stretches took that turn for minutes, one twice).
    const going = stillSlots.with(async () => (wanted() ? await addon.stillClean!(job) : null));
    const answer = await going;
    if (answer === null) return null;
    if (answer.still !== true) {
      diag.info("removal", `${source} from ${Math.round(request.from)} s: not a still shot (${answer.why ?? "?"}), the model takes it`);
      return null;
    }
    return { ok: true, box: answer.box ?? null, inferred: 0 };
  } catch (error) {
    diag.warn("removal", `${source} from ${Math.round(request.from)} s: the still clean stopped, the model takes it: ${diag.messageOf(error)}`);
    return null;
  } finally {
    // The rest of the video go once the first's plate is made (or it failed: the next makes it then).
    made();
  }
}

/** Whether anything the model takes out (a caption or a note) is on between source seconds `from` and `to`. */
export function captionsIn(found: Found, from: number, to: number): boolean {
  const fps = found.fps > 0 ? found.fps : 30;
  const [first, last] = [Math.floor(from * fps), Math.ceil(to * fps)];
  return found.masks.some((mask) => (mask[6] === "subtitle" || mask[6] === "note") && mask[0] <= last && mask[1] >= first);
}

/** Whether the finder looked at all of `spans` (source seconds). */
export function covers(found: Found, spans: [number, number][]): boolean {
  const looked = merged(found.covered.map(([a, b]): [number, number] => [a - LOOKED_PAST_S, b + LOOKED_PAST_S]));
  return spans.every(([a, b]) => looked.some(([x, y]) => x <= a + 1e-3 && y >= b - 1e-3));
}

/**
 * The seconds of `shown` (a file's seconds on the timeline) that have something of theirs: stretches a second apart or
 * less joined, each a quarter second wider, none longer than LONGEST_S.
 */
export function spansOf(found: Found, shown: [number, number][]): [number, number][] {
  const fps = found.fps > 0 ? found.fps : 30;
  const theirs = merged(found.masks.map((mask): [number, number] => [mask[0] / fps - AROUND_S, (mask[1] + 1) / fps + AROUND_S]));
  const joined: [number, number][] = [];
  for (const [a, b] of theirs) {
    const last = joined.at(-1);
    if (last !== undefined && a - last[1] <= JOIN_S) last[1] = Math.max(last[1], b);
    else joined.push([a, b]);
  }
  const out: [number, number][] = [];
  for (const [x, y] of shown) {
    for (const [a, b] of joined) {
      const [from, to] = [Math.max(a, x), Math.min(b, y)];
      if (to - from <= 1e-3) continue;
      const pieces = Math.ceil((to - from) / LONGEST_S);
      for (let k = 0; k < pieces; k++) out.push([round3(from + ((to - from) * k) / pieces), round3(from + ((to - from) * (k + 1)) / pieces)]);
    }
  }
  return out;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

// ---------------------------------------------------------------------------
// A stretch's track from a file's boxes

const PREFIX: Record<string, string> = { subtitle: "c", note: "c", label: "l", mark: "m" };
/** Whether a slot is a caption's or a note's (what the model cleans). */
export const isCaption = (slot: string): boolean => slot.startsWith("c");

interface Segment {
  slot: string;
  first: number;
  last: number;
  box: [number, number, number, number];
}

/**
 * A file's boxes over frames [first, last] as runs, each in a slot of its kind: a caption read a few pixels wider or
 * narrower from one frame to the next is one run with one box (the blur holds still on it); a mark that glides keeps
 * each of its steps (the track moves between them).
 */
export function segmentsOf(found: Found, first: number, last: number): Segment[] {
  const near = 0.012 * Math.max(found.width, found.height);
  const out: Segment[] = [];
  const open = new Map<string, Segment>();
  const masks = found.masks.filter((mask) => mask[1] >= first && mask[0] <= last).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [f0, f1, x0, y0, x1, y1, kind] of masks) {
    const prefix = PREFIX[kind] ?? "c";
    const [a, b] = [Math.max(first, f0), Math.min(last, f1)];
    const box: Segment["box"] = [x0, y0, x1, y1];
    let placed = false;
    if (prefix !== "m") {
      // The same thing a moment on (or still there): its run goes on, its box the wider of the two.
      for (const run of open.values()) {
        if (!run.slot.startsWith(prefix) || a > run.last + 2) continue;
        if (run.box.every((value, at) => Math.abs(value - box[at]!) <= near)) {
          run.last = Math.max(run.last, b);
          run.box = [Math.min(run.box[0], x0), Math.min(run.box[1], y0), Math.max(run.box[2], x1), Math.max(run.box[3], y1)];
          placed = true;
          break;
        }
      }
    }
    if (placed) continue;
    // The first slot of its kind with nothing in it at this frame.
    let n = 0;
    while (open.has(`${prefix}${n}`) && open.get(`${prefix}${n}`)!.last >= a) n++;
    const run: Segment = { slot: `${prefix}${n}`, first: a, last: b, box };
    open.set(run.slot, run);
    out.push(run);
  }
  return out;
}

/**
 * The track text_blur.ts and the model's masks read (`boxAt`), from a file's boxes over source seconds [from, to): a
 * read at each frame a run starts and ends, and one a frame before and after (`boxAt` covers a gap between two reads
 * with the box at either end, so a run's ends are pinned to the frame). Every read says every slot's box then.
 */
export function samplesOf(found: Found, from: number, to: number): Sample[] {
  const fps = found.fps > 0 ? found.fps : 30;
  const [first, last] = [Math.max(0, Math.floor(from * fps) - 1), Math.ceil(to * fps) + 1];
  const runs = segmentsOf(found, first, last);
  const at = new Set<number>([first]);
  for (const run of runs) for (const frame of [run.first - 1, run.first, run.last, run.last + 1]) if (frame >= first && frame <= last + 1) at.add(frame);
  const share = (run: Segment): Box => [run.box[0] / found.width, run.box[1] / found.height, run.box[2] / found.width, run.box[3] / found.height];
  // Runs by start, and those under way as the frames go by.
  const starts = [...runs].sort((a, b) => a.first - b.first);
  let next = 0;
  let live: Segment[] = [];
  const out: Sample[] = [];
  for (const frame of [...at].sort((a, b) => a - b)) {
    while (next < starts.length && starts[next]!.first <= frame) live.push(starts[next++]!);
    live = live.filter((run) => run.last >= frame);
    const parts = live.map((run) => ({ slot: run.slot, box: share(run), words: "" }));
    const box = parts.length === 0 ? null : parts.reduce<Box>((all, part) => [Math.min(all[0], part.box[0]), Math.min(all[1], part.box[1]), Math.max(all[2], part.box[2]), Math.max(all[3], part.box[3])], [1, 1, 0, 0]);
    out.push({ t: frame / fps, box, words: "", parts });
  }
  return out;
}

/** Tracks made from a file's boxes (text_blur.ts tells them from its own reads: only these keep a blur beside a clean). */
const made = new WeakSet<Sample[]>();
export const isFound = (samples: Sample[]): boolean => made.has(samples);

/** A stretch's track when the finder has read the file and looked at all of it, else null. */
export function samplesFor(app: App, source: string, from: number, to: number): Sample[] | null {
  if (!available()) return null;
  const found = foundOf(app, source);
  if (found === null || !covers(found, [[from, to]])) return null;
  const samples = samplesOf(found, from, to);
  made.add(samples);
  return samples;
}

// ---------------------------------------------------------------------------
// The judge

export type Verdict = "overlay" | "camera" | "scene" | "unclear";
export interface Asked {
  kind: string;
  text: string;
  n: number;
}

const JUDGE = `These pictures are tiles cut from police body-camera or security footage that another channel re-uploaded with its own additions burned in. Each tile is numbered "#i" in its top-left corner and has words inside a GREEN rectangle. For each tile say what the words in the green rectangle are:

- "overlay": added on top of the footage by a video editor. Flat and crisp, often outlined, shadowed or on a coloured plate, level, untouched by the scene's light, perspective, lens curve or motion blur. Captions, lines with a speaker's name in front, floating notes, labels like "ACTUAL CASE FOOTAGE" or "CAM 1", a channel's name or logo (faint and see-through too), "Subscribe" badges, text cards, a viewfinder frame an editor drew, an inserted document.
- "camera": burned in by the camera that filmed it: date and time, AXON or Getac and a serial number, GPS coordinates, speed, altitude, a security camera maker's logo. Small, plain, in a corner, there for the whole clip.
- "scene": part of what was filmed: a sign, a poster, a shirt, a vest, a name tag, a vehicle's lettering, a paper or a screen in the room.
- "unclear": you can't tell at this size.

The list below gives each tile's words as a reader read them (often garbled) and what kind of thing it is: "label" or "roamer" keeps its place or drifts through the whole file, "one-off" shows once, "unsure" stayed put in a shot that never changed.

Answer with one JSON object and nothing else, every tile's number to its word: {"0": "overlay", "1": "scene", ...}`;

/** The judge's word on each thing asked (Opus, 64 tiles a question); anything it gave no word on is "unclear". */
export async function judge(scratchDir: string, ask: Asked[], sheets: string[], sheetsB64?: string[]): Promise<Record<string, Verdict>> {
  const out: Record<string, Verdict> = {};
  if (ask.length === 0) return out;
  const images = sheetsB64 ?? sheets.map((file) => fs.readFileSync(file).toString("base64"));
  const PER = 4;
  for (let at = 0; at < images.length; at += PER) {
    const pictures = images.slice(at, at + PER);
    const list = ask
      .map((one, index) => ({ one, index }))
      .slice(at * 16, (at + PER) * 16)
      .map(({ one, index }) => `#${index}: ${one.kind}, read ${one.n} times: ${JSON.stringify(one.text)}`)
      .join("\n");
    const request = {
      model: claude.OPUS,
      reasoning: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `${JUDGE}\n\n${list}` }, ...pictures.map((b64) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }))],
        },
      ],
    };
    const scratch = join(scratchDir, `judge-${process.pid}-${Date.now()}-${at}-${randomUUID()}.request`);
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(scratch, JSON.stringify(request));
    try {
      const response = await claudeAi.post(scratch, claude.OPUS, "Claude opus judging what's laid over footage");
      const content = (response as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
      Object.assign(out, readVerdicts(typeof content === "string" ? content : ""));
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  }
  return out;
}

/** Seams for tests (replacing the Opus judge call). */
export const judgeHooks = { judge };

// ---------------------------------------------------------------------------
// Cloud survey bundle → Found (pure TypeScript mirror of find.py finish + assemble.py build)

export interface SurveyAsk extends Asked {
  f: number;
  masks?: Mask[];
  note?: [number, number, number, number, number, number];
}

export interface ParentVerdicts {
  yes: [string, string, number][];
  labels: string[];
}

export interface ParentState {
  zone: unknown;
  marks: unknown;
  notes: unknown;
  cands: unknown;
  roamExt?: unknown;
  verdicts?: ParentVerdicts;
}

/** Everything `find.py survey --pack` writes on RunPod so Edit finishes on any OS with no Python. */
export interface SurveyBundle {
  version: 1;
  width: number;
  height: number;
  fps: number;
  frames: number;
  covered: [number, number][];
  baseMasks: Mask[];
  baseNotes: [number, number, number, number, number, number][];
  roamMasks: Mask[];
  ask: SurveyAsk[];
  sheetsB64: string[];
  parentState?: ParentState;
  /** What the survey read, each with its frame (find.py `finish` reads them for `off_titles` and `off_caption_labels`). */
  reads?: Read[];
}

/** One line the survey read: [x0, y0, x1, y1, words, frame]. */
export type Read = [number, number, number, number, string, number];

/** numpy's `percentile` (linear between the two nearest). */
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = ((sorted.length - 1) * q) / 100;
  const [lo, hi] = [Math.floor(at), Math.ceil(at)];
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** assemble.py `off_titles`, as it is: a channel's title across the top is a label cut to its band, not a caption. */
export function offTitles(masks: Mask[], height: number, reads: Read[]): Mask[] {
  const last = masks.reduce((most, m) => Math.max(most, m[1]), 0);
  if (last <= 0) return masks;
  const tops = masks.filter((m) => m[6] === "label" && m[3] < 0.12 * height && m[5] < 0.35 * height);
  // The frames a top label is up (numpy's `on[a:b+1]`), as half-open stretches.
  const on = merged(tops.map((m): [number, number] => [Math.max(0, m[0]), Math.min(last, m[1]) + 1])).reduce((sum, [a, b]) => sum + b - a, 0);
  if (on < 0.25 * (last + 1)) return masks;
  const band = Math.trunc(percentile(tops.map((m) => m[5]), 90));
  const words = reads.filter((r) => (r[1] + r[3]) / 2 < 0.35 * height);
  const fitted = (m: Mask): number => {
    const inside = words.filter((r) => m[2] <= (r[0] + r[2]) / 2 && (r[0] + r[2]) / 2 <= m[4] && m[3] <= (r[1] + r[3]) / 2 && (r[1] + r[3]) / 2 <= m[5]).map((r) => r[3]);
    if (inside.length < 5) return m[5];
    const bottom = Math.trunc(percentile(inside, 90)) + 8;
    return m[5] - m[3] > 1.25 * (bottom - m[3]) ? bottom : m[5];
  };
  const out: Mask[] = [];
  const memo = new Map<string, number>();
  for (let m of masks) {
    if (m[6] === "subtitle" || m[6] === "note") {
      if (m[3] < Math.min(band, 0.12 * height)) m = [m[0], m[1], m[2], m[3], m[4], Math.min(m[5], band), "label"];
      else if (m[3] < 0.35 * height && m[1] - m[0] <= 6 && tops.some((t) => t[0] <= m[1] && m[0] <= t[1] && t[2] < m[4] && m[2] < t[4])) continue;
    }
    if (m[6] === "label" && m[3] < 0.12 * height && m[5] < 0.35 * height) {
      const key = m.slice(2, 6).join(",");
      if (!memo.has(key)) memo.set(key, fitted(m));
      m = [m[0], m[1], m[2], m[3], m[4], memo.get(key)!, "label"];
    }
    out.push(m);
  }
  return out;
}

/**
 * assemble.py `off_caption_labels`, as it is: a label in the captions' place that is them (its words keep changing, or
 * it's up only while a caption covers it) goes. `reads` null: a record made before its reads were kept (Nov 24), whose
 * finish had them; only `worn`, which needs none, is asked again (it's the same answer on a record that had it).
 */
export function offCaptionLabels(masks: Mask[], reads: Read[] | null): Mask[] {
  const caps = masks.filter((m) => m[6] === "subtitle" || m[6] === "note");
  if (caps.length < 20 || (reads !== null && reads.length === 0)) return masks;
  const [x0, y0] = [percentile(caps.map((m) => m[2]), 5) - 10, percentile(caps.map((m) => m[3]), 5) - 10];
  const [x1, y1] = [percentile(caps.map((m) => m[4]), 95) + 10, percentile(caps.map((m) => m[5]), 95) + 10];
  const here = (reads ?? [])
    .map((r) => ({ cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, text: String(r[4]).trim().toLowerCase(), f: r[5] }))
    .filter((r) => x0 <= r.cx && r.cx <= x1 && y0 <= r.cy && r.cy <= y1);
  const changing = (m: Mask): boolean => {
    const said = here.filter((r) => m[2] <= r.cx && r.cx <= m[4] && m[3] <= r.cy && r.cy <= m[5] && m[0] <= r.f && r.f <= m[1]).map((r) => r.text);
    if (said.length < 10) return false;
    const counts = new Map<string, number>();
    for (const text of said) counts.set(text, (counts.get(text) ?? 0) + 1);
    return [...counts.values()].reduce((most, n) => Math.max(most, n), 0) <= 0.2 * said.length;
  };
  const worn = (m: Mask): boolean => {
    const area = Math.max(1, (m[4] - m[2]) * (m[5] - m[3]));
    const spans: [number, number][] = [];
    for (const c of caps) {
      if (c[0] <= m[1] && m[0] <= c[1] && Math.max(0, Math.min(c[4], m[4]) - Math.max(c[2], m[2])) * Math.max(0, Math.min(c[5], m[5]) - Math.max(c[3], m[3])) >= 0.5 * area) {
        spans.push([Math.max(c[0], m[0]), Math.min(c[1], m[1])]);
      }
    }
    let [held, end, gap] = [0, m[0] - 1, 0];
    for (const [a0, a1] of spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      if (a0 > end + 1) gap = Math.max(gap, a0 - end - 1);
      if (a1 > end) {
        held += a1 - Math.max(a0, end + 1) + 1;
        end = a1;
      }
    }
    gap = Math.max(gap, m[1] - end);
    return held >= 0.95 * (m[1] - m[0] + 1) && gap <= 8;
  };
  return masks.filter((m) => !(m[6] === "label" && m[2] >= x0 && m[3] >= y0 && m[4] <= x1 && m[5] <= y1 && (changing(m) || worn(m))));
}

/** A record as the rules read it now (one made before Nov 24 may still hold a label that was a caption). */
const asNow = (found: Found): Found => {
  const masks = offCaptionLabels(found.masks, null);
  return masks.length === found.masks.length ? found : { ...found, masks };
};

function padBox(b: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const h = b[3] - b[1];
  const py = Math.max(6, 0.12 * h);
  const px = 0.3 * h;
  return [Math.max(0, Math.trunc(b[0] - px)), Math.max(0, Math.trunc(b[1] - py)), Math.min(width, Math.trunc(b[2] + px)), Math.min(height, Math.trunc(b[3] + py))];
}

/**
 * Turns a RunPod `SurveyBundle` and the judge's verdicts into `Found`, matching `find.py finish` + `assemble.py build`
 * identically so Macs and Linux machines without Python need no second pod round-trip.
 */
export function finishSurvey(bundle: SurveyBundle, verdicts: Record<string, Verdict>): { found: Found; parentVerdicts: ParentVerdicts } {
  const yes: [string, string, number][] = [];
  const labels: string[] = [];
  const masks: Mask[] = [...bundle.baseMasks];
  const one: [number, number, number, number, number, number][] = bundle.baseNotes.map((n) => [...n] as [number, number, number, number, number, number]);
  let includeRoam = false;

  for (let i = 0; i < bundle.ask.length; i++) {
    const item = bundle.ask[i]!;
    const v: Verdict = verdicts[String(i)] ?? "unclear";
    if (item.kind === "label" || item.kind === "roamer") {
      // A label the judge couldn't make out stays theirs (it held its place through scene changes); the camera's goes.
      if (v === "overlay" || v === "unclear") {
        labels.push(item.text);
        if (item.kind === "label" && item.masks !== undefined) masks.push(...item.masks);
        if (item.kind === "roamer") includeRoam = true;
      }
    } else if (v === "overlay") {
      yes.push([item.kind, item.text, item.f]);
      if (item.masks !== undefined) masks.push(...item.masks);
      if (item.note !== undefined) one.push([...item.note] as [number, number, number, number, number, number]);
    }
  }
  if (includeRoam) masks.push(...bundle.roamMasks);

  // Merge notes & approved one-off lines on screen together into one block (assemble.py lines 115–124).
  one.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4] || a[5] - b[5]);
  const blocks: [number, number, number, number, number, number][] = [];
  for (const o of one) {
    let mergedInto = false;
    for (const b of blocks) {
      const h = Math.max(o[5] - o[3], b[5] - b[3]);
      if (o[0] <= b[1] + 60 && Math.min(o[5], b[5]) - Math.max(o[3], b[3]) > -1.5 * h && Math.min(o[4], b[4]) - Math.max(o[2], b[2]) > -6 * h) {
        b[1] = Math.max(b[1], o[1]);
        b[2] = Math.min(b[2], o[2]);
        b[3] = Math.min(b[3], o[3]);
        b[4] = Math.max(b[4], o[4]);
        b[5] = Math.max(b[5], o[5]);
        mergedInto = true;
        break;
      }
    }
    if (!mergedInto) blocks.push([...o] as [number, number, number, number, number, number]);
  }
  for (const b of blocks) {
    const box = padBox([b[2], b[3], b[4], b[5]], bundle.width, bundle.height);
    const ex = Math.trunc(0.5 * (b[5] - b[3]));
    masks.push([b[0] - 10, b[1] + 10, Math.max(0, box[0] - ex), box[1], Math.min(bundle.width, box[2] + ex), box[3], "note"]);
  }

  const last = Math.max(0, Math.trunc(bundle.frames) - 1);
  const out: Mask[] = [];
  for (const m of masks) {
    if (m[1] >= 0 && m[0] <= last && m[4] > m[2] && m[5] > m[3]) {
      out.push([Math.max(0, Math.trunc(m[0])), Math.min(last, Math.trunc(m[1])), Math.trunc(m[2]), Math.trunc(m[3]), Math.trunc(m[4]), Math.trunc(m[5]), m[6] === "note" ? "note" : m[6]]);
    }
  }
  // find.py `finish` last: a title along the top made a label, and the labels that were captions gone (Nov 24: the pod
  // sends its reads; a bundle without them, from before, has its labels asked again only by what needs none).
  const reads = Array.isArray(bundle.reads) ? bundle.reads : null;
  const finished = offCaptionLabels(offTitles(out, bundle.height, reads ?? []), reads);
  return {
    found: { version: 1, width: bundle.width, height: bundle.height, fps: bundle.fps, covered: bundle.covered, masks: finished },
    parentVerdicts: { yes, labels },
  };
}

/** The judge's answer read: the first JSON object in it, each known word kept. */
export function readVerdicts(answer: string): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  const [open, close] = [answer.indexOf("{"), answer.lastIndexOf("}")];
  if (open < 0 || close <= open) return out;
  let read: unknown;
  try {
    read = JSON.parse(answer.slice(open, close + 1));
  } catch {
    return out;
  }
  if (read === null || typeof read !== "object") return out;
  for (const [key, value] of Object.entries(read as Record<string, unknown>)) if (value === "overlay" || value === "camera" || value === "scene" || value === "unclear") out[String(Number(key))] = value;
  return out;
}

// ---------------------------------------------------------------------------
// Finding

export interface FindPiece {
  key: string;
  media: string;
  name: string;
  state: "queued" | "running" | "done" | "failed";
  why?: string;
}

interface ActiveRun {
  source: string;
  promise: Promise<void>;
  watchers: Set<string>;
  cancelled: boolean;
}

const pieces = new Map<string, Map<string, FindPiece>>();
/** Non-cancelled runs currently queued or in progress, by source. */
const reading = new Map<string, ActiveRun>();
/** All unsettled runs (including cancelled ones still finishing cleanup/DELETE). */
const inFlight = new Set<Promise<void>>();
const queue: { parentSource: string | null; cancelled: () => boolean; run: () => Promise<void> }[] = [];
let running = 0;

/** `find.py` on this computer's card, LOCAL_AT_ONCE at a time, even when RunPod is on and 6 cloud slots are open. */
const localGpu = new Semaphore(LOCAL_AT_ONCE);
function withLocalGpu<T>(fn: () => Promise<T>): Promise<T> {
  return localGpu.with(fn);
}

/** Called with a file's source when its boxes are written (text_blur.ts lets go of the tracks it made from the old ones). */
export const whenRead: ((source: string) => void)[] = [];

/** Called when a file a project shows has been read (text_removal.ts plans it then). */
export const whenFound: ((app: App, id: string) => void)[] = [];

export const piecesOf = (id: string): FindPiece[] => [...(pieces.get(id)?.values() ?? [])];
/** How many of the project's files are still being read. */
export const outOf = (id: string): number => piecesOf(id).filter((one) => one.state === "queued" || one.state === "running").length;

/** Stops finder work for project `id`: cancels queued/running RunPod jobs nobody else waits on. */
export function stop(id: string): void {
  pieces.delete(id);
  for (const [source, active] of reading) {
    active.watchers.delete(id);
    if (active.watchers.size === 0) {
      active.cancelled = true;
      // Detach immediately so any new `ensure` for this source starts a fresh run instead of joining the dying one.
      reading.delete(source);
    }
  }
  drain();
}

function drain(): void {
  // Settle queued items that were cancelled before starting so they don't occupy slots or linger in flight.
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.cancelled()) {
      const [dead] = queue.splice(i, 1);
      void dead!.run().catch(() => {});
    }
  }
  const limit = standIn !== null ? 1 : removerCloud.now() ? CLOUD_AT_ONCE : LOCAL_AT_ONCE;
  while (running < limit && queue.length > 0) {
    // Never give a drain slot to a slowed copy while its parent run is still queued or running (prevents single-slot deadlocks).
    const idx = queue.findIndex((item) => item.parentSource === null || !reading.has(item.parentSource));
    if (idx === -1) break;
    const [item] = queue.splice(idx, 1);
    running += 1;
    void item!
      .run()
      .catch(() => {})
      .finally(() => {
        running -= 1;
        drain();
      });
  }
}

interface CloudFoundRecord {
  found: Found;
  parentState?: ParentState;
}

const isValidCovered = (covered: unknown): covered is [number, number][] =>
  Array.isArray(covered) &&
  covered.every(
    (pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "number" && Number.isFinite(pair[0]) && typeof pair[1] === "number" && Number.isFinite(pair[1]),
  );

/** What R2 holds for a source: its record (null when unreadable) and its ETag, the condition a write over it is made on. */
interface CloudEntry {
  record: CloudFoundRecord | null;
  etag: string | null;
}

/** Shared finder boxes from R2 (so no two machines scan the same footage twice). Null: nothing there, or R2 unreachable. */
async function fetchCloudEntry(source: string): Promise<CloudEntry | null> {
  if (standIn !== null || !cloud.enabled()) return null;
  try {
    const answer = await fetch(await cloud.presign(cloudKeyOf(source), "GET"), { signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) return null;
    const etag = answer.headers.get("etag");
    const raw = (await answer.json().catch(() => null)) as (Partial<CloudFoundRecord> & Partial<Found>) | null;
    // Accept either { found, parentState } or a bare Found record; validate coverage tuples so malformed records miss cleanly.
    let record: CloudFoundRecord | null = null;
    if (raw !== null && raw.found !== undefined && raw.found.version === VERSION && Array.isArray(raw.found.masks) && isValidCovered(raw.found.covered)) {
      record = { found: asNow(raw.found), parentState: raw.parentState };
    } else if (raw !== null && raw.version === VERSION && Array.isArray(raw.masks) && isValidCovered(raw.covered)) {
      record = { found: asNow(raw as Found) };
    }
    return { record, etag };
  } catch {
    return null;
  }
}

async function fetchCloudFound(source: string): Promise<CloudFoundRecord | null> {
  return (await fetchCloudEntry(source))?.record ?? null;
}

/**
 * A file's boxes read here before they were shared (the finder ran on this machine only, until Nov 24) go up the first
 * time they're loaded, so a Mac opening the same edit doesn't pay RunPod to read the same footage again.
 */
async function shareKept(app: App, source: string, found: Found): Promise<void> {
  if (standIn !== null || !cloud.enabled()) return;
  const there = await fetchCloudEntry(source);
  if (there?.record != null) return;
  await saveCloudFound(source, found, readLocalParentSidecar(app, source), there);
}

/**
 * A file's boxes up on R2 over `seen` (what this machine read there before; null: nothing), made on that condition:
 * another machine's write in between is read and decided on again, and a record reaching seconds these never looked at
 * stays (Nov 24, the review of PR #5: a [0, 10] backfill or scan landing after another's [0, 60] replaced it).
 */
async function saveCloudFound(source: string, found: Found, parentState: ParentState | null, seen: CloudEntry | null): Promise<void> {
  if (standIn !== null || !cloud.enabled()) return;
  const body = JSON.stringify(parentState === null ? { found } : { found, parentState });
  let plain = false;
  try {
    for (let tries = 0; tries < 3; tries++) {
      if (seen?.record != null && !covers(found, seen.record.found.covered)) return;
      const condition: Record<string, string> = plain ? {} : seen === null ? { "if-none-match": "*" } : seen.etag === null ? {} : { "if-match": seen.etag };
      const put = await fetch(await cloud.presign(cloudKeyOf(source), "PUT"), { method: "PUT", body, headers: { "content-type": "application/json", ...condition }, signal: AbortSignal.timeout(60_000) });
      if (put.ok) return;
      if (put.status === 412) {
        seen = await fetchCloudEntry(source);
        continue;
      }
      // Refused for something else: once more as before, without the condition (a write that can't go up costs a rescan).
      if (Object.keys(condition).length === 0) {
        diag.warn("removal", `found cache couldn't go up (${put.status})`);
        return;
      }
      plain = true;
    }
  } catch (error) {
    diag.warn("removal", `found cache couldn't go up: ${diag.messageOf(error)}`);
  }
}

function writeLocalParentSidecar(app: App, source: string, parentState: ParentState): void {
  const pfile = parentFileOf(app, source);
  fs.mkdirSync(path.dirname(pfile), { recursive: true });
  fs.writeFileSync(`${pfile}.tmp`, JSON.stringify(parentState));
  fs.renameSync(`${pfile}.tmp`, pfile);
}

function writeLocalFound(app: App, source: string, found: Found, parentState: ParentState | null): void {
  const file = fileOf(app, source);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(found));
  fs.renameSync(`${file}.tmp`, file);
  if (parentState !== null) writeLocalParentSidecar(app, source, parentState);
  kept.set(source, found);
  for (const listener of whenRead) listener(source);
}

/**
 * Materializes `<cache>/cleaned/finder/f/scan/<mid>.*` and `f/verdicts.json` from a saved `ParentState`
 * so a local `find.py survey --parent` run can use a parent that was scanned on RunPod.
 */
export function writeLocalParentScanFiles(app: App, source: string, state: ParentState): void {
  const root = join(app.store.cacheDir(), "cleaned", "finder", "f");
  const scanDir = join(root, "scan");
  const mid = slug(source);
  fs.mkdirSync(scanDir, { recursive: true });
  const writeJson = (file: string, value: unknown) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
    fs.renameSync(`${file}.tmp`, file);
  };
  writeJson(join(scanDir, `${mid}.zone.json`), state.zone);
  writeJson(join(scanDir, `${mid}.marks.json`), state.marks);
  writeJson(join(scanDir, `${mid}.notes.json`), state.notes);
  writeJson(join(scanDir, `${mid}.cands.json`), state.cands);
  const roamExtFile = join(scanDir, `${mid}.roam.ext.json`);
  if (state.roamExt !== undefined && state.roamExt !== null) writeJson(roamExtFile, state.roamExt);
  else fs.rmSync(roamExtFile, { force: true });
  const verdictsFile = join(root, "verdicts.json");
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(fs.readFileSync(verdictsFile, "utf8")) as Record<string, unknown>;
  } catch {
    all = {};
  }
  all[mid] = state.verdicts?.yes ?? [];
  all[`${mid}:labels`] = state.verdicts?.labels ?? [];
  writeJson(verdictsFile, all);
}

function readLocalParentSidecar(app: App, source: string): ParentState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(parentFileOf(app, source), "utf8")) as ParentState;
    if (raw !== null && typeof raw === "object" && raw.zone !== undefined) return raw;
  } catch {
    // Missing or unreadable sidecar.
  }
  return null;
}

function readLocalScanParentState(app: App, source: string): ParentState | null {
  try {
    const root = join(app.store.cacheDir(), "cleaned", "finder", "f");
    const mid = slug(source);
    const zone = JSON.parse(fs.readFileSync(join(root, "scan", `${mid}.zone.json`), "utf8")) as unknown;
    const marks = JSON.parse(fs.readFileSync(join(root, "scan", `${mid}.marks.json`), "utf8")) as unknown;
    const notes = JSON.parse(fs.readFileSync(join(root, "scan", `${mid}.notes.json`), "utf8")) as unknown;
    const cands = JSON.parse(fs.readFileSync(join(root, "scan", `${mid}.cands.json`), "utf8")) as unknown;
    let roamExt: unknown = null;
    try {
      roamExt = JSON.parse(fs.readFileSync(join(root, "scan", `${mid}.roam.ext.json`), "utf8")) as unknown;
    } catch {
      roamExt = null;
    }
    let verdicts: ParentVerdicts = { yes: [], labels: [] };
    try {
      const all = JSON.parse(fs.readFileSync(join(root, "verdicts.json"), "utf8")) as Record<string, unknown>;
      verdicts = {
        yes: Array.isArray(all[mid]) ? (all[mid] as [string, string, number][]) : [],
        labels: Array.isArray(all[`${mid}:labels`]) ? (all[`${mid}:labels`] as string[]) : [],
      };
    } catch {
      // No verdicts saved.
    }
    return { zone, marks, notes, cands, roamExt, verdicts };
  } catch {
    return null;
  }
}

const fileMtimeMs = (file: string): number => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
};

/** Ensures `<cache>/cleaned/finder/f/scan/<parent>.*` holds the newest available parent state for local `slowcopy.py`. */
export async function syncLocalParentScanFiles(app: App, source: string): Promise<void> {
  const root = join(app.store.cacheDir(), "cleaned", "finder");
  const zoneFile = join(root, "f", "scan", `${slug(source)}.zone.json`);
  const zoneMtime = fileMtimeMs(zoneFile);
  const sidecarMtime = fileMtimeMs(parentFileOf(app, source));
  if (zoneMtime < 0 || sidecarMtime > zoneMtime) {
    const pstate = readLocalParentSidecar(app, source) ?? (zoneMtime < 0 ? ((await fetchCloudFound(source))?.parentState ?? null) : null);
    if (pstate !== null) writeLocalParentScanFiles(app, source, pstate);
  }
}

function readLocalParentState(app: App, source: string): ParentState | null {
  const sidecarMtime = fileMtimeMs(parentFileOf(app, source));
  const zoneMtime = fileMtimeMs(join(app.store.cacheDir(), "cleaned", "finder", "f", "scan", `${slug(source)}.zone.json`));
  if (zoneMtime > sidecarMtime) {
    return readLocalScanParentState(app, source) ?? readLocalParentSidecar(app, source);
  }
  return readLocalParentSidecar(app, source) ?? readLocalScanParentState(app, source);
}

async function resolveParentState(app: App, parent: { media: Media; source: string }, stopped: () => boolean): Promise<ParentState> {
  const local = readLocalParentState(app, parent.source);
  if (local !== null) return local;
  const there = await fetchCloudEntry(parent.source);
  // Stopped while R2 answered: nothing of it written, no one told (Nov 24, the review of PR #5).
  if (stopped()) throw new Error("stopped");
  const remote = there?.record ?? null;
  if (remote?.parentState !== undefined) {
    // Never overwrite a wider local Found record with a narrower remote one.
    const existing = foundOf(app, parent.source);
    if (existing !== null && !covers(remote.found, existing.covered)) writeLocalParentSidecar(app, parent.source, remote.parentState);
    else writeLocalFound(app, parent.source, remote.found, remote.parentState);
    return remote.parentState;
  }
  if (stopped()) throw new Error("stopped");
  // Parent was read earlier without saved parent state (e.g., an older local build): scan parent on RunPod now.
  const key = removerCloud.keyOf(parent.media);
  if (key === undefined) throw new Error("the file it was slowed from isn't in the cloud yet");
  const existing = foundOf(app, parent.source);
  const spans: [number, number][] = existing !== null && existing.covered.length > 0 ? existing.covered : [[0, parent.media.duration ?? 0]];
  const bundle = await removerCloud.find<SurveyBundle>(key, spans, scriptsJson(), null, stopped);
  if (stopped()) throw new Error("stopped");
  const verdicts = await judgeHooks
    .judge(join(app.store.cacheDir(), "cleaned", "finder", "judge"), bundle.ask, [], bundle.sheetsB64)
    .catch((error: unknown) => {
      diag.warn("removal", `${parent.media.name}: the judge couldn't be asked (${diag.messageOf(error)}); what it would have settled is left as found`);
      return {} as Record<string, Verdict>;
    });
  if (stopped()) throw new Error("stopped");
  const { found: parentFound, parentVerdicts } = finishSurvey(bundle, verdicts);
  const pstate: ParentState | null = bundle.parentState === undefined ? null : { ...bundle.parentState, verdicts: parentVerdicts };
  // A project's own read of the parent may have finished while this one ran (it isn't one of `reading`'s): its state is
  // the one kept, and a wider record of it is never replaced by this narrower one (Nov 24, the review of PR #5).
  const since = readLocalParentState(app, parent.source);
  if (since !== null) return since;
  const now = foundOf(app, parent.source);
  if (now === null || covers(parentFound, now.covered)) writeLocalFound(app, parent.source, parentFound, pstate);
  else if (pstate !== null) writeLocalParentSidecar(app, parent.source, pstate);
  await saveCloudFound(parent.source, parentFound, pstate, there);
  if (pstate === null) throw new Error("the file it was slowed from produced no parent state");
  return pstate;
}

/** The finder's scripts, written where its Python runs them (the same words every start, so only once). */
function scriptsDir(app: App): string {
  const dir = join(app.store.cacheDir(), "cleaned", "finder", "src");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(SCRIPTS)) {
    const file = join(dir, name);
    let same = false;
    try {
      same = fs.readFileSync(file, "utf8") === source;
    } catch {
      same = false;
    }
    if (!same) fs.writeFileSync(file, source);
  }
  return dir;
}

/**
 * The finders this Edit started that are still reading: leaving stops them, and everything they started (Nov 26,
 * mandalorian: a restart left one reading a whole file on the card for nobody). On Linux each runs in a process group
 * of its own, so the scan.py it runs and that one's workers go with it (Nov 27: only find.py was stopped, and its
 * scan of a 40-minute file and two workers went on at 95% for 26 minutes beside the new server's read of the same file).
 */
const finders = new Set<ReturnType<typeof Bun.spawn>>();
const GROUPED = process.platform === "linux";
process.on("exit", () => {
  for (const child of finders) stopFinder(child);
});

/** `child` and, where it leads a group of its own, everything it started. */
function stopFinder(child: ReturnType<typeof Bun.spawn>): void {
  if (GROUPED) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Gone already, or not a group leader: the child alone.
    }
  }
  child.kill();
}

async function python(app: App, args: string[]): Promise<unknown> {
  const command = [join(INSTALLED, "venv", "bin", "python"), join(scriptsDir(app), "find.py"), ...args];
  // setsid: a group of its own (its pid is the group's), so leaving stops its scans and their workers too. nice: reading a
  // file for their text waits behind what someone is waiting on now (Nov 27, mandalorian: two scans took 28 of 32 cores
  // and the LaMa clean, watermark cells and exports of four edits stood still for 40 minutes).
  const child = Bun.spawn(GROUPED ? ["setsid", "nice", "-n", "19", ...command] : command, { stdout: "pipe", stderr: "pipe", env: { ...process.env, PROCS: "2" } });
  finders.add(child);
  void child.exited.then(() => finders.delete(child));
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error((err.trim().split("\n").at(-1) ?? out.trim().split("\n").at(-1) ?? `the finder stopped (${code})`).slice(0, 300));
  const last = out.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last);
}

/** The file's full picture as a file on this machine (its original here, else fetched once for the read and let go after). */
async function localFile(app: App, media: Media): Promise<{ file: string; fetched: boolean }> {
  const input = await cloudMedia.originalInput(app.store.cacheDir(), media);
  if (!/^https?:/u.test(input)) return { file: input, fetched: false };
  const key = media.cloud!.original!;
  const file = join(app.store.cacheDir(), "cleaned", "finder", "fetched", `${slug(key)}${path.extname(media.name) || ".mp4"}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await cloudMedia.fetchKey(key, file);
  return { file, fetched: true };
}

interface Want {
  media: Media;
  source: string;
  shown: [number, number][];
  /** The file a slowed copy was made from (read first: the copy reads as it). */
  parent: { media: Media; source: string } | null;
}

async function find(app: App, want: Want, stopped: () => boolean): Promise<void> {
  const root = join(app.store.cacheDir(), "cleaned", "finder");
  const mid = slug(want.source);
  const parent = want.parent === null ? null : slug(want.parent.source);
  const started = Date.now();
  let found: Found;
  let parentState: ParentState | null = null;
  let fromCloudCache = false;
  let viaRunPod = false;
  let seen: CloudEntry | null = null;

  if (standIn !== null) {
    const asked = await standIn.find({ mid, video: want.media.path, spans: want.shown, parent });
    found = await standIn.finish({ mid, parent, verdicts: await judgeHooks.judge(join(root, "judge"), asked.ask, asked.sheets) });
  } else {
    // Check shared R2 cache first: if another machine already scanned all of these spans, reuse it immediately.
    const there = await fetchCloudEntry(want.source);
    seen = there;
    const remote = there?.record ?? null;
    if (remote !== null && covers(remote.found, want.shown)) {
      found = remote.found;
      parentState = remote.parentState ?? null;
      fromCloudCache = true;
    } else {
      const spansToScan = remote !== null ? merged([...remote.found.covered, ...want.shown]) : want.shown;
      const key = removerCloud.keyOf(want.media);
      const useRunPod = key !== undefined && (await removerCloud.on());
      if (useRunPod) {
        viaRunPod = true;
        let parentKey: string | null = null;
        if (want.parent !== null) {
          const pstate = await resolveParentState(app, want.parent, stopped);
          if (stopped()) throw new Error("stopped");
          parentKey = await removerCloud.parentStateKey(JSON.stringify(pstate));
        }
        if (stopped()) throw new Error("stopped");
        const bundle = await removerCloud.find<SurveyBundle>(key, spansToScan, scriptsJson(), parentKey, stopped);
        if (stopped()) throw new Error("stopped");
        const verdicts = await judgeHooks.judge(join(root, "judge"), bundle.ask, [], bundle.sheetsB64).catch((error: unknown) => {
          diag.warn("removal", `${want.media.name}: the judge couldn't be asked (${diag.messageOf(error)}); what it would have settled is left as found`);
          return {} as Record<string, Verdict>;
        });
        if (stopped()) throw new Error("stopped");
        const finished = finishSurvey(bundle, verdicts);
        found = finished.found;
        parentState = bundle.parentState === undefined ? null : { ...bundle.parentState, verdicts: finished.parentVerdicts };
      } else if (localAvailable()) {
        // The file comes down before it takes the card (a 700 MB original held it for minutes, the card idle), then
        // LOCAL_AT_ONCE runs on the card at a time even when RunPod is enabled with 6 cloud slots.
        if (stopped()) throw new Error("stopped");
        const { file, fetched } = await localFile(app, want.media);
        const localResult = await withLocalGpu(async () => {
          if (stopped()) throw new Error("stopped");
          if (want.parent !== null) await syncLocalParentScanFiles(app, want.parent.source);
          {
            fs.mkdirSync(root, { recursive: true });
            const spans = join(root, `${mid}.spans.json`);
            fs.writeFileSync(spans, JSON.stringify(spansToScan));
            const asked = (await python(app, ["survey", root, mid, file, spans, ...(parent === null ? [] : ["--parent", parent])])) as { ask: Asked[]; sheets: string[] };
            if (stopped()) throw new Error("stopped");
            // A judge that can't be reached leaves every answer "unclear": a label stays theirs, a one-off stays in.
            const verdicts = await judgeHooks.judge(join(root, "judge"), asked.ask, asked.sheets).catch((error: unknown) => {
              diag.warn("removal", `${want.media.name}: the judge couldn't be asked (${diag.messageOf(error)}); what it would have settled is left as found`);
              return {} as Record<string, Verdict>;
            });
            if (stopped()) throw new Error("stopped");
            const answers = join(root, `${mid}.verdicts.json`);
            fs.writeFileSync(answers, JSON.stringify(verdicts));
            const done = (await python(app, ["finish", root, mid, answers, ...(parent === null ? [] : ["--parent", parent])])) as { found: string };
            const parsed = JSON.parse(fs.readFileSync(done.found, "utf8")) as Found;
            const pstate = parent === null ? readLocalScanParentState(app, want.source) : null;
            fs.rmSync(spans, { force: true });
            return { found: parsed, parentState: pstate };
          }
        }).finally(() => {
          if (fetched) fs.rmSync(file, { force: true });
        });
        found = localResult.found;
        parentState = localResult.parentState;
      } else {
        throw new Error("the file isn't in the cloud yet");
      }
    }
  }
  if (stopped()) throw new Error("stopped");
  writeLocalFound(app, want.source, found, parentState);
  if (!fromCloudCache && standIn === null) await saveCloudFound(want.source, found, parentState, seen);
  const kinds = new Map<string, number>();
  for (const mask of found.masks) kinds.set(mask[6], (kinds.get(mask[6]) ?? 0) + 1);
  const where = fromCloudCache ? "from the cloud cache" : viaRunPod ? "on RunPod" : "here";
  diag.info("removal", `${want.media.name}: read for what's laid over it ${where} in ${Math.round((Date.now() - started) / 1000)} s (${[...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ") || "nothing of theirs"})`);
}

/**
 * Has every footage file `project` shows read by the finder (those not read yet, or shown beyond what it looked at), in
 * the background, a slowed copy after the file it was made from. `wants`: each file, its source and its shown seconds.
 */
export function ensure(app: App, id: string, wants: Want[]): void {
  const mine = new Map<string, FindPiece>();
  const was = pieces.get(id);
  // Parents first.
  for (const want of [...wants].sort((a, b) => Number(a.parent !== null) - Number(b.parent !== null))) {
    const key = `find:${want.media.id}`;
    const found = foundOf(app, want.source);
    if (found !== null && covers(found, want.shown)) {
      mine.set(key, { key, media: want.media.id, name: want.media.name, state: "done" });
      continue;
    }
    // On a machine without a local finder (e.g. a Mac), wait quietly if this file or its un-scanned parent isn't on R2 yet.
    const parentWaitingUpload = want.parent !== null && foundOf(app, want.parent.source) === null && removerCloud.keyOf(want.parent.media) === undefined;
    if (standIn === null && !localAvailable() && (removerCloud.keyOf(want.media) === undefined || parentWaitingUpload)) {
      // Going up from here: read once it's up (the upload's landing wakes the project, removal_schedule.ts), and an
      // export waits for it meanwhile, its name in its step.
      for (const one of [want.media, ...(parentWaitingUpload ? [want.parent!.media] : [])]) if (one.cloud?.original !== undefined) cloud.waitFor(one.cloud.original, id, one.name);
      // Another machine may have read it already: its boxes need no upload from here (Nov 24, the review of PR #5).
      lookShared(app, id, want);
      continue;
    }
    const had = was?.get(key);
    if (had !== undefined && had.state === "failed") {
      mine.set(key, had);
      continue;
    }
    const piece: FindPiece = had !== undefined && had.state !== "done" ? had : { key, media: want.media.id, name: want.media.name, state: "queued" };
    mine.set(key, piece);
    let active = reading.get(want.source);
    if (active !== undefined) {
      active.watchers.add(id);
    } else {
      // Everything of the file any project showed before is looked at again with what's shown now (one file of boxes a source).
      const shown = merged([...(found?.covered ?? []), ...want.shown]);
      let settle!: () => void;
      const promise = new Promise<void>((resolve) => (settle = resolve));
      const run: ActiveRun = { source: want.source, promise, watchers: new Set([id]), cancelled: false };
      active = run;
      reading.set(want.source, run);
      inFlight.add(promise);
      let failWhy: string | undefined;
      queue.push({
        parentSource: want.parent?.source ?? null,
        cancelled: () => run.cancelled,
        run: async () => {
          const isStopped = () => run.cancelled;
          try {
            if (isStopped()) return;
            for (const projPieces of pieces.values()) {
              for (const p of projPieces.values()) if (p.media === want.media.id && p.state === "queued") p.state = "running";
            }
            if (want.parent !== null && foundOf(app, want.parent.source) === null) throw new Error("the file it was slowed from couldn't be read");
            await find(app, { ...want, shown }, isStopped);
          } catch (error) {
            failWhy = diag.messageOf(error);
            if (!isStopped()) diag.warn("removal", `${want.media.name}: finder failed: ${failWhy}`);
          } finally {
            if (reading.get(want.source) === run) reading.delete(want.source);
            inFlight.delete(promise);
            if (!isStopped()) {
              if (failWhy !== undefined) lastError.set(want.source, failWhy);
              else lastError.delete(want.source);
            }
            settle();
          }
        },
      });
    }
    const joined = active;
    void joined.promise.then(() => {
      if (joined.cancelled || !pieces.has(id)) return;
      const now = foundOf(app, want.source);
      piece.state = now !== null && covers(now, want.shown) ? "done" : "failed";
      if (piece.state === "failed") piece.why = lastError.get(want.source) ?? "the file couldn't be read for what's laid over it";
      for (const listener of whenFound) listener(app, id);
    });
  }
  pieces.set(id, mine);
  drain();
}

const lastError = new Map<string, string>();

/** When each file waiting for its upload was last looked for on R2 (once a minute at most: a project plans often). */
const lookedShared = new Map<string, number>();
const LOOK_SHARED_MS = 60_000;

/** A file this machine can't read yet (not uploaded): R2's boxes for it, when they cover what `id` shows. */
function lookShared(app: App, id: string, want: Want): void {
  if (!cloud.enabled()) return;
  const at = lookedShared.get(want.source);
  if (at !== undefined && Date.now() - at < LOOK_SHARED_MS) return;
  lookedShared.set(want.source, Date.now());
  const look = fetchCloudFound(want.source)
    .then((remote) => {
      if (remote === null || !covers(remote.found, want.shown) || !pieces.has(id)) return;
      const here = foundOf(app, want.source);
      if (here !== null && (covers(here, want.shown) || !covers(remote.found, here.covered))) return;
      writeLocalFound(app, want.source, remote.found, remote.parentState ?? null);
      for (const listener of whenFound) listener(app, id);
    })
    .catch(() => {})
    .finally(() => inFlight.delete(look));
  inFlight.add(look);
}

/** A project's want for each footage file it shows (text_removal.ts gives the sources and what's a slowed copy of what). */
export type { Want };

/** For tests: nothing remembered. */
export function reset(): void {
  pieces.clear();
  kept.clear();
  reading.clear();
  inFlight.clear();
  lastError.clear();
  lookedShared.clear();
  queue.length = 0;
  availableHere = null;
}

/** Resolves once nothing is being read (tests). */
export async function settled(): Promise<void> {
  while (running > 0 || queue.length > 0 || reading.size > 0 || inFlight.size > 0) {
    if (inFlight.size > 0) await Promise.all([...inFlight]);
    else await Bun.sleep(5);
  }
}

