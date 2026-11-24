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
/** Files scanned in parallel when the finder runs on RunPod (local GPU stays 1 at a time). */
const CLOUD_AT_ONCE = 6;
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
/** Whether this machine has the local Linux NVIDIA finder installed. */
function localAvailable(): boolean {
  if (availableHere !== null) return availableHere;
  availableHere = process.env.NODE_ENV !== "test" && process.platform === "linux" && fs.existsSync(join(INSTALLED, "venv", "bin", "python")) && fs.existsSync("/dev/nvidiactl");
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
    const read = JSON.parse(fs.readFileSync(fileOf(app, source), "utf8")) as Found;
    if (read.version !== VERSION || !Array.isArray(read.masks)) return null;
    kept.set(source, read);
    return read;
  } catch {
    return null;
  }
}

/** Stretches of still footage cleaned at once: a CPU core each, at background priority, and no GPU; half the cores at most, so the machine stays responsive. */
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
export async function stillClean(app: App, source: string, media: Media[], request: StillRequest): Promise<{ ok: true; box: Box | null; inferred: 0 } | null> {
  const addon = native();
  if (addon.stillClean === undefined || standIn !== null || foundOf(app, source) === null) return null;
  const key = source.split("#")[0]!;
  const others = media.filter((one) => one.kind === "video" && one.cloud?.source !== undefined && one.cloud.source !== source && one.cloud.source.split("#")[0] === key && foundOf(app, one.cloud.source) !== null);
  const also = await Promise.all(
    others.map(async (one) => {
      const input = await cloudMedia.originalInput(app.store.cacheDir(), one).catch(() => null);
      return input === null ? null : { input, input_args: tools.urlArgs(input), found: fileOf(app, one.cloud!.source!) };
    }),
  );
  const job = JSON.stringify({ ...request, found: fileOf(app, source), plates: join(app.store.cacheDir(), "cleaned", "plates"), key, also: also.filter((one) => one !== null) });
  try {
    await plating.get(key);
    const going = stillSlots.with(() => addon.stillClean!(job));
    if (!plating.has(key)) {
      const settled = going.catch(() => {}).finally(() => plating.delete(key));
      plating.set(key, settled);
    }
    const answer = await going;
    if (answer.still !== true) {
      diag.info("removal", `${source} from ${Math.round(request.from)} s: not a still shot (${answer.why ?? "?"}), the model takes it`);
      return null;
    }
    return { ok: true, box: answer.box ?? null, inferred: 0 };
  } catch (error) {
    diag.warn("removal", `${source} from ${Math.round(request.from)} s: the still clean stopped, the model takes it: ${diag.messageOf(error)}`);
    return null;
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
}

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
  return {
    found: { version: 1, width: bundle.width, height: bundle.height, fps: bundle.fps, covered: bundle.covered, masks: out },
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

/** Serializes local GPU `find.py` invocations to 1 at a time even when RunPod is on and 6 cloud slots are open. */
let localChain: Promise<void> = Promise.resolve();
async function withLocalGpu<T>(fn: () => Promise<T>): Promise<T> {
  const prev = localChain;
  let release!: () => void;
  localChain = new Promise<void>((resolve) => (release = resolve));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
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
  const limit = standIn === null && removerCloud.now() ? CLOUD_AT_ONCE : 1;
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

/** Shared finder boxes from R2 (so no two machines scan the same footage twice). */
async function fetchCloudFound(source: string): Promise<CloudFoundRecord | null> {
  if (standIn !== null || !cloud.enabled()) return null;
  try {
    const answer = await fetch(await cloud.presign(cloudKeyOf(source), "GET"), { signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) return null;
    const raw = (await answer.json()) as Partial<CloudFoundRecord> & Partial<Found>;
    // Accept either { found, parentState } or a bare Found record; validate coverage tuples so malformed records miss cleanly.
    if (raw.found !== undefined && raw.found.version === VERSION && Array.isArray(raw.found.masks) && isValidCovered(raw.found.covered)) {
      return { found: raw.found, parentState: raw.parentState };
    }
    if (raw.version === VERSION && Array.isArray(raw.masks) && isValidCovered(raw.covered)) {
      return { found: raw as Found };
    }
    return null;
  } catch {
    return null;
  }
}

async function saveCloudFound(source: string, found: Found, parentState: ParentState | null): Promise<void> {
  if (standIn !== null || !cloud.enabled()) return;
  try {
    const body = JSON.stringify(parentState === null ? { found } : { found, parentState });
    const put = await fetch(await cloud.presign(cloudKeyOf(source), "PUT"), { method: "PUT", body, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (!put.ok) diag.warn("removal", `found cache couldn't go up (${put.status})`);
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
  const remote = await fetchCloudFound(parent.source);
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
  writeLocalFound(app, parent.source, parentFound, pstate);
  await saveCloudFound(parent.source, parentFound, pstate);
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

async function python(app: App, args: string[]): Promise<unknown> {
  const child = Bun.spawn([join(INSTALLED, "venv", "bin", "python"), join(scriptsDir(app), "find.py"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PROCS: "2" } });
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

  if (standIn !== null) {
    const asked = await standIn.find({ mid, video: want.media.path, spans: want.shown, parent });
    found = await standIn.finish({ mid, parent, verdicts: await judgeHooks.judge(join(root, "judge"), asked.ask, asked.sheets) });
  } else {
    // Check shared R2 cache first: if another machine already scanned all of these spans, reuse it immediately.
    const remote = await fetchCloudFound(want.source);
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
        // Always serialize local GPU runs to 1 at a time even when RunPod is enabled with 6 cloud slots.
        const localResult = await withLocalGpu(async () => {
          if (stopped()) throw new Error("stopped");
          if (want.parent !== null) await syncLocalParentScanFiles(app, want.parent.source);
          const { file, fetched } = await localFile(app, want.media);
          try {
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
          } finally {
            if (fetched) fs.rmSync(file, { force: true });
          }
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
  if (!fromCloudCache && standIn === null) await saveCloudFound(want.source, found, parentState);
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
    if (standIn === null && !localAvailable() && (removerCloud.keyOf(want.media) === undefined || parentWaitingUpload)) continue;
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

/** A project's want for each footage file it shows (text_removal.ts gives the sources and what's a slowed copy of what). */
export type { Want };

/** For tests: nothing remembered. */
export function reset(): void {
  pieces.clear();
  kept.clear();
  reading.clear();
  inFlight.clear();
  lastError.clear();
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

