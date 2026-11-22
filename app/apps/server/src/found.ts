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
// The finder runs on this machine where it's installed (Linux, an NVIDIA GPU,
// `~/.local/share/edit-finder/venv`); elsewhere `available()` is false and
// removal goes on as before, by the agent's marks.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as claudeAi from "./ai_claude.ts";
import type { App } from "./app.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import type { Media } from "./model.ts";
import type { Box } from "./native/index.ts";
import { join } from "./paths.ts";
import { merged } from "./removal_sections.ts";
import type { Sample } from "./text_track.ts";
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
/** Whether this machine finds what's theirs itself: Linux, an NVIDIA GPU, the finder's Python installed. */
export function available(): boolean {
  if (standIn !== null) return true;
  if (availableHere !== null) return availableHere;
  availableHere = process.env.NODE_ENV !== "test" && process.platform === "linux" && fs.existsSync(join(INSTALLED, "venv", "bin", "python")) && fs.existsSync("/dev/nvidiactl");
  return availableHere;
}

// ---------------------------------------------------------------------------
// The store

const slug = (source: string) => source.replace(/[^a-z0-9]+/giu, "-").slice(0, 80);
const fileOf = (app: App, source: string) => join(app.store.cacheDir(), "cleaned", "found", `${slug(source)}.v${VERSION}.json`);
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
export async function judge(scratchDir: string, ask: Asked[], sheets: string[]): Promise<Record<string, Verdict>> {
  const out: Record<string, Verdict> = {};
  if (ask.length === 0) return out;
  const PER = 4;
  for (let at = 0; at < sheets.length; at += PER) {
    const pictures = sheets.slice(at, at + PER);
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
          content: [{ type: "text", text: `${JUDGE}\n\n${list}` }, ...pictures.map((file) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}` } }))],
        },
      ],
    };
    const scratch = join(scratchDir, `judge-${process.pid}-${Date.now()}-${at}.request`);
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

const pieces = new Map<string, Map<string, FindPiece>>();
/** Files being read or waiting, by source: one read a file, whichever projects want it. */
const reading = new Map<string, Promise<void>>();
const queue: (() => Promise<void>)[] = [];
let busy: Promise<void> | null = null;

/** Called with a file's source when its boxes are written (text_blur.ts lets go of the tracks it made from the old ones). */
export const whenRead: ((source: string) => void)[] = [];

/** Called when a file a project shows has been read (text_removal.ts plans it then). */
export const whenFound: ((app: App, id: string) => void)[] = [];

export const piecesOf = (id: string): FindPiece[] => [...(pieces.get(id)?.values() ?? [])];
/** How many of the project's files are still being read. */
export const outOf = (id: string): number => piecesOf(id).filter((one) => one.state === "queued" || one.state === "running").length;

function drain(): void {
  if (busy !== null) return;
  // One file at a time: the reads are the GPU's, and the picture's decoding takes the cores.
  busy = (async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await next();
  })().finally(() => {
    busy = null;
    if (queue.length > 0) drain();
  });
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
  const child = Bun.spawn([join(INSTALLED, "venv", "bin", "python"), join(scriptsDir(app), "find.py"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PROCS: "4" } });
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

async function find(app: App, want: Want): Promise<void> {
  const root = join(app.store.cacheDir(), "cleaned", "finder");
  const mid = slug(want.source);
  const parent = want.parent === null ? null : slug(want.parent.source);
  const started = Date.now();
  let found: Found;
  if (standIn !== null) {
    const asked = await standIn.find({ mid, video: want.media.path, spans: want.shown, parent });
    found = await standIn.finish({ mid, parent, verdicts: await judge(join(root, "judge"), asked.ask, asked.sheets) });
  } else {
    const { file, fetched } = await localFile(app, want.media);
    try {
      fs.mkdirSync(root, { recursive: true });
      const spans = join(root, `${mid}.spans.json`);
      fs.writeFileSync(spans, JSON.stringify(want.shown));
      const asked = (await python(app, ["survey", root, mid, file, spans, ...(parent === null ? [] : ["--parent", parent])])) as { ask: Asked[]; sheets: string[] };
      // A judge that can't be reached leaves every answer "unclear": a label stays theirs, a one-off stays in.
      const verdicts = await judge(join(root, "judge"), asked.ask, asked.sheets).catch((error: unknown) => {
        diag.warn("removal", `${want.media.name}: the judge couldn't be asked (${diag.messageOf(error)}); what it would have settled is left as found`);
        return {} as Record<string, Verdict>;
      });
      const answers = join(root, `${mid}.verdicts.json`);
      fs.writeFileSync(answers, JSON.stringify(verdicts));
      const done = (await python(app, ["finish", root, mid, answers, ...(parent === null ? [] : ["--parent", parent])])) as { found: string };
      found = JSON.parse(fs.readFileSync(done.found, "utf8")) as Found;
      fs.rmSync(spans, { force: true });
    } finally {
      if (fetched) fs.rmSync(file, { force: true });
    }
  }
  const file = fileOf(app, want.source);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(found));
  fs.renameSync(`${file}.tmp`, file);
  kept.set(want.source, found);
  for (const listener of whenRead) listener(want.source);
  const kinds = new Map<string, number>();
  for (const mask of found.masks) kinds.set(mask[6], (kinds.get(mask[6]) ?? 0) + 1);
  diag.info("removal", `${want.media.name}: read for what's laid over it in ${Math.round((Date.now() - started) / 1000)} s (${[...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ") || "nothing of theirs"})`);
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
    const had = was?.get(key);
    if (had !== undefined && had.state === "failed") {
      mine.set(key, had);
      continue;
    }
    const piece: FindPiece = had !== undefined && had.state !== "done" ? had : { key, media: want.media.id, name: want.media.name, state: "queued" };
    mine.set(key, piece);
    let run = reading.get(want.source);
    if (run === undefined) {
      // Everything of the file any project showed before is looked at again with what's shown now (one file of boxes a source).
      const shown = merged([...(found?.covered ?? []), ...want.shown]);
      let settle!: () => void;
      run = new Promise<void>((resolve) => (settle = resolve));
      reading.set(want.source, run);
      queue.push(async () => {
        try {
          // Its parent's read, when that's under way.
          if (want.parent !== null) await reading.get(want.parent.source);
          if (want.parent !== null && foundOf(app, want.parent.source) === null) throw new Error("the file it was slowed from couldn't be read");
          await find(app, { ...want, shown });
        } finally {
          reading.delete(want.source);
          settle();
        }
      });
    }
    void run.then(() => {
      const now = foundOf(app, want.source);
      piece.state = now !== null && covers(now, want.shown) ? "done" : "failed";
      if (piece.state === "failed") piece.why ??= "the file couldn't be read for what's laid over it";
      for (const listener of whenFound) listener(app, id);
    });
  }
  pieces.set(id, mine);
  drain();
}

/** A project's want for each footage file it shows (text_removal.ts gives the sources and what's a slowed copy of what). */
export type { Want };

/** For tests: nothing remembered. */
export function reset(): void {
  pieces.clear();
  kept.clear();
  reading.clear();
  queue.length = 0;
}

/** Resolves once nothing is being read (tests). */
export async function settled(): Promise<void> {
  while (busy !== null || reading.size > 0) await (busy ?? Promise.all(reading.values()));
}

