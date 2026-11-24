// A re-uploader's see-through watermark out of the footage (Sphe, Nov 17:
// "daily dose of crime" over all of Tulsa's bodycam), by arithmetic on this
// computer: the engine's watermark.rs, nothing sent anywhere, nothing paid.
// A mark is the SOURCE's, not the channel's (Sphe, Nov 17: a compilation pulls
// footage from many re-uploaders, only some with a see-through mark, each its
// own): for a channel taught to take watermarks out, every footage file on
// the timeline is looked at once (`learn`: a mark that stays put, found with
// no example; the camera's stamp never one) and what's found kept by its
// source on R2 (`edit/cleaned/watermarks/<file>.json`: its matte, white and
// blend curve, or "none"), so the same footage in any project reuses it.
//
// Then, for each file with a mark, as soon as it's on the timeline and in
// the background beside the agent's other work: the seconds
// the timeline shows, with a second's handle, in fixed 30 s cells of each
// file (so extending a clip later only does the new cells, and another
// project reusing the case does none), each cell's mark found frame by frame
// and taken out into a stacked strip of the box it touched. Strips are kept
// on R2 beside text_removal.ts's pieces (`edit/cleaned/<file>/`), never made
// twice, and laid by clean_strips.ts under any text strip of the same frames.
// The camera's own stamp is never touched (text_removal.ts `stampOf`).
//
// Each piece says how much of the mark is still found in what came out
// (`left`: 0 gone, 1 untouched) and how much of it was rebuilt from
// neighbouring frames (`filled`), so a check of the piece needs no eyes;
// `GET /api/projects/{id}/watermark` lists them.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { ApiError, json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import { probe } from "./media.ts";
import type { Media, Probe, Project } from "./model.ts";
import { native, type Box, type WatermarkPiece, type WatermarkRemoved } from "./native/index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import * as removerCloud from "./remover_cloud.ts";
import { freshId } from "./project.ts";
import * as seams from "./seams.ts";
import { folderOf, PREFIX, shownSeconds, sourceOf, stampOf } from "./text_removal.ts";

/** Seconds of a file each strip covers (its cells start at 0, 30, 60…). */
export const CELL = 30;
/** Seconds either side of what the timeline shows that are cleaned too. */
export const HANDLE = 1;
/** Where each source's mark (or its "none") is kept. */
const MODELS = `${PREFIX}/watermarks`;

/** The engine's two calls (the addon's; a stand-in in tests). */
export interface Engine {
  learn(source: string, size: [number, number], duration: number, hint: Box | null, avoid: Box[], onProgress: (progress: number) => void): Promise<string>;
  /** `stopped`: the person stopped it (a rented machine's job is called off; this computer's runs to its end). */
  remove(piece: WatermarkPiece, onProgress: (progress: number) => void, stopped?: () => boolean): Promise<WatermarkRemoved | null>;
}

let engineOverride: Engine | null = null;
/** For tests: an engine in place of the addon's. */
export function useEngine(engine: Engine | null): void {
  engineOverride = engine;
}

function engine(): Engine | null {
  if (engineOverride !== null) return engineOverride;
  const addon = native();
  if (addon.watermarkLearn === undefined || addon.watermarkRemove === undefined) return null;
  return { learn: addon.watermarkLearn.bind(addon), remove: (piece, onProgress) => addon.watermarkRemove!(piece, onProgress) };
}

/**
 * The engine for one file: rented CPU machines when the relay does removal there and the file is on R2
 * (remover_cloud.ts: the same engine, many cells at once), else this computer's.
 */
function engineFor(media: Media): Engine | null {
  if (engineOverride !== null) return engineOverride;
  const key = removerCloud.keyOf(media);
  if (key !== undefined && removerCloud.now()) return removerCloud.watermarkEngine(key);
  return engine();
}

/** Cells and looks at once: this computer's few, or many on rented machines (each a machine's few cores there). */
const CLOUD_CELLS = 24;
const CLOUD_LOOKS = 8;
const cellsAtOnce = () => (engineOverride === null && removerCloud.now() ? CLOUD_CELLS : limits.cells);
const looksAtOnce = () => (engineOverride === null && removerCloud.now() ? CLOUD_LOOKS : 1);

// ---------------------------------------------------------------------------
// Each source's mark

/** A file's learned mark: the engine's model (JSON) and a short hash naming what it makes. */
export interface Model {
  json: string;
  hash: string;
}

/** What a source has: its mark, or none (looked at: nothing see-through stays put in it; `hint` where it was looked for, when a lesson's example showed where). */
export type Mark = Model | { none: true; hint: Box | null };

const noneOf = (hint: Box | null) => JSON.stringify({ none: true, hint });
/**
 * The engine's answers that mean the file has no mark to learn (anything else is tried again later). "Too little of
 * the footage could be read" is a short clip's every time (Nov 20: SMART Cops' and Boyfriends' ~0.80x excerpts, a few
 * seconds each, failed the same way after every restart, and the cleaning waited on their looks each time).
 */
const NO_MARK = /no see-through watermark|too thin to learn|too small to find a watermark|too little of the footage could be read/u;

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 10);
const modelFile = (app: App, source: string) => join(app.store.cacheDir(), "watermarks", `${folderOf(source)}.json`);
const modelKey = (source: string) => `${MODELS}/${folderOf(source)}.json`;
const marks = new Map<string, { at: number; mark: Mark | null }>();
function markOfText(text: string): Mark {
  try {
    const read = JSON.parse(text) as { none?: unknown; hint?: unknown };
    if (read.none === true) return { none: true, hint: Array.isArray(read.hint) && read.hint.length === 4 ? (read.hint as Box) : null };
  } catch {
    /* A model the engine reads (or refuses) itself. */
  }
  return { json: text, hash: hashOf(text) };
}

/** Whether a source's mark is none. */
export const isNone = (mark: Mark | null): mark is { none: true; hint: Box | null } => mark !== null && "none" in mark;

/**
 * The source's mark as learned (by any Mac: kept on R2 by the file, so the
 * same footage in another project, or another channel's, is never looked at
 * twice), or null while it isn't learned yet.
 */
export async function markOf(app: App, source: string): Promise<Mark | null> {
  const kept = marks.get(source);
  if (kept !== undefined && (kept.mark !== null || Date.now() - kept.at < 60_000)) return kept.mark;
  const file = modelFile(app, source);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    if (cloud.enabled() && (await cloud.has(modelKey(source)).catch(() => false))) {
      fs.mkdirSync(join(app.store.cacheDir(), "watermarks"), { recursive: true });
      await cloud.download(modelKey(source), file).catch((error: unknown) => diag.warn("watermark", `${source}'s mark: ${diag.messageOf(error)}`));
      text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    }
  }
  const mark = text === null ? null : markOfText(text);
  marks.set(source, { at: Date.now(), mark });
  return mark;
}

async function keepMark(app: App, source: string, text: string): Promise<Mark> {
  const file = modelFile(app, source);
  fs.mkdirSync(join(app.store.cacheDir(), "watermarks"), { recursive: true });
  writeAtomic(file, text);
  if (cloud.enabled()) await cloud.uploadFile(file, modelKey(source));
  const mark = markOfText(text);
  marks.set(source, { at: Date.now(), mark });
  return mark;
}

/**
 * Looks for a see-through mark in `media` (the whole file, a mark that stays
 * put; `hint` the shares where the team showed it, when they did) and keeps
 * what's found with its source: its mark, or "none". The camera's stamp and
 * what the lesson keeps are never taken for a mark (`keep`).
 */
export async function learn(app: App, media: Media, hint: Box | null = null, keep: Box[] = []): Promise<Mark> {
  const run = engineFor(media);
  if (run === null) throw new ApiError(409, "This Edit can't take watermarks out yet: update it.");
  const source = await sourceOf(media);
  const input = await cloudMedia.originalInput(app.store.cacheDir(), media);
  const avoid = [...(await stampOf(app, media, input).catch(() => [])), ...keep];
  await playing.whenIdle();
  let text: string;
  try {
    text = await run.learn(input, [media.width || 1280, media.height || 720], media.duration ?? 0, hint, avoid, () => {});
  } catch (error) {
    if (!NO_MARK.test(diag.messageOf(error))) throw error;
    diag.info("watermark", `${media.name}: no see-through mark (${diag.messageOf(error)})`);
    return keepMark(app, source, noneOf(hint));
  }
  diag.info("watermark", `${media.name}: its mark learned`);
  return keepMark(app, source, text);
}

// ---------------------------------------------------------------------------
// Cells and their strips

/** The cells [from, to) of a file `duration` long that cover `shown` (its seconds on the timeline) and their handles. */
export function cellsFor(shown: [number, number][], duration: number): [number, number][] {
  const out = new Set<number>();
  for (const [a, b] of shown) {
    const from = Math.max(0, a - HANDLE);
    const to = Math.min(duration > 0 ? duration : Infinity, b + HANDLE);
    for (let k = Math.floor(from / CELL); k * CELL < to; k++) out.add(k);
  }
  return [...out].sort((x, y) => x - y).map((k): [number, number] => [k * CELL, duration > 0 ? Math.min((k + 1) * CELL, duration) : (k + 1) * CELL]).filter(([a, b]) => b - a > 0.05);
}

/** A cell done: its strip and box, or nothing (the mark isn't in it). */
export interface Done {
  from: number;
  to: number;
  /** The strip's key on R2 (or its file here with the cloud off); null when there was no mark. */
  key: string | null;
  box: Box | null;
}

const boxPart = (box: Box) => box.map((value) => String(Math.round(value * 1e4))).join("-");
const cellName = (from: number, to: number, hash: string, box: Box | null) => `${Math.round(from * 1000)}-${Math.round(to * 1000)}.watermark-${hash}-${box === null ? "none.json" : `${boxPart(box)}.mp4`}`;

/** A kept cell's name read back (null when it isn't one of this mark's). */
export function parseCell(name: string, hash: string): Omit<Done, "key"> | null {
  const match = /(\d+)-(\d+)\.watermark-([0-9a-f]+)-(?:none\.json|(\d+)-(\d+)-(\d+)-(\d+)\.mp4)$/u.exec(name);
  if (match === null || match[3] !== hash) return null;
  const box = match[4] === undefined ? null : ([match[4], match[5], match[6], match[7]].map((value) => Number(value) / 1e4) as Box);
  return { from: Number(match[1]) / 1000, to: Number(match[2]) / 1000, box };
}

/** Where a file's cells are kept: R2 (shared by every Mac) with a copy here; here alone with the cloud off. */
export interface Shelf {
  list(source: string, hash: string): Promise<Done[]>;
  bring(source: string, done: Done): Promise<string>;
  keep(source: string, file: string | null, done: Omit<Done, "key">, hash: string): Promise<Done>;
  /** A kept cell that wasn't clean: gone here and on R2, so it's done again. */
  forget(source: string, done: Omit<Done, "key">, hash: string): Promise<void>;
}

export function shelfIn(dir: string, useCloud: () => boolean = () => cloud.enabled()): Shelf {
  const here = (source: string, name: string) => join(dir, folderOf(source), name);
  return {
    async list(source, hash) {
      const names = new Set<string>();
      try {
        for (const name of fs.readdirSync(join(dir, folderOf(source)))) names.add(name);
      } catch {
        /* Nothing here yet. */
      }
      if (useCloud()) {
        for (const object of await cloud.list(`${PREFIX}/${folderOf(source)}/`).catch(() => [])) names.add(object.key.slice(object.key.lastIndexOf("/") + 1));
      }
      return [...names].flatMap((name) => {
        const done = parseCell(name, hash);
        return done === null ? [] : [{ ...done, key: `${PREFIX}/${folderOf(source)}/${name}` }];
      });
    },
    async bring(source, done) {
      const file = here(source, done.key!.slice(done.key!.lastIndexOf("/") + 1));
      if (!fs.existsSync(file)) {
        fs.mkdirSync(join(dir, folderOf(source)), { recursive: true });
        await cloud.download(done.key!, file);
      }
      return file;
    },
    async keep(source, file, done, hash) {
      const name = cellName(done.from, done.to, hash, done.box);
      const key = `${PREFIX}/${folderOf(source)}/${name}`;
      const local = here(source, name);
      fs.mkdirSync(join(dir, folderOf(source)), { recursive: true });
      if (file === null) writeAtomic(local, "{}");
      else if (file !== local) fs.renameSync(file, local);
      if (useCloud()) await cloud.uploadFile(local, key).catch((error: unknown) => diag.warn("watermark", `keeping ${name} in the cloud: ${diag.messageOf(error)}`));
      return { ...done, key: done.box === null ? null : key };
    },
    async forget(source, done, hash) {
      const name = cellName(done.from, done.to, hash, done.box);
      fs.rmSync(here(source, name), { force: true });
      if (useCloud()) await cloud.remove([`${PREFIX}/${folderOf(source)}/${name}`]).catch((error: unknown) => diag.warn("watermark", `forgetting ${name}: ${diag.messageOf(error)}`));
    },
  };
}

let shelfOverride: Shelf | null = null;
/** For tests: a shelf in place of R2's. */
export function useShelf(shelf: Shelf | null): void {
  shelfOverride = shelf;
}
const shelfOf = (app: App) => shelfOverride ?? shelfIn(join(app.store.cacheDir(), "cleaned"));

// ---------------------------------------------------------------------------
// Each project's cells, one at a time in the background

/** What a cleaned piece came to, for its check. */
export interface Piece {
  media: string;
  name: string;
  from: number;
  to: number;
  /** done: its strip is laid; none: the mark isn't there; failed: it stays as it was (said in `error`). */
  state: "queued" | "running" | "done" | "none" | "failed";
  left?: number;
  filled?: number;
  seconds?: number;
  error?: string;
  /** Times it was done (a second after it wasn't clean). */
  tries?: number;
  /** Given up on after its second try: never queued again here. */
  gaveUp?: boolean;
}

/** A piece with more of the mark than this still found isn't clean: done once more, then left. */
export const LEFT_MAX = 0.35;
/**
 * At least this much of the mark still found: it wasn't found in the cell at all (a mark learned wrong, or one that isn't
 * there then), so nothing is laid and nothing is done again (Nov 19, the Boyfriends intro: 649TcIBMrOQ's "mark" learned
 * from the re-uploader's picture-in-picture card came back 100% left in every cell, each done twice for nothing).
 */
export const NOT_FOUND = 0.9;

interface Job {
  project: string;
  media: Media;
  source: string;
  from: number;
  to: number;
  model: Model;
  /** The person's Stop came while it was under way (`stop`). */
  stopped?: boolean;
}

/** A source to look at for its mark first (its project's cells queued once it's known). */
interface Look {
  project: string;
  media: Media;
  source: string;
  hint: Box | null;
  keep: Box[];
}

const pieces = new Map<string, Map<string, Piece>>();
const queue: Job[] = [];
/** The cells being cleaned now. */
const underWay = new Set<Job>();
/** Each project's Stops so far: a plan begun before a later Stop queues nothing. */
const stops = new Map<string, number>();
/** Each cell's own work file (a cell stopped and asked again runs twice for a while, neither removing the other's). */
let workFiles = 0;
const looks: Look[] = [];
/** Sources being looked at for their mark now or queued to be, and the projects waiting on each. */
const looking = new Map<string, Set<string>>();
/** When looking at a source last failed (tried again after LOOK_AGAIN_AFTER_MS). */
const lookFailed = new Map<string, number>();
/**
 * How long a file whose look failed is left before it's looked at again. Not 30 minutes (Nov 20, Sphe's Boyfriends
 * edit: ~50 sped-up excerpts each failed in ~40 s, "too little of the footage could be read", so the first were due
 * again before the last was reached; the queue never emptied, and the project's cleaning, which waits on its files'
 * looks, never started).
 */
const LOOK_AGAIN_AFTER_MS = 12 * 3600_000;
/** Cells being cleaned now, and files being looked at for their mark (one at a time here, several on rented machines). */
let running = 0;
let lookingNow = 0;

/**
 * Cells at once: each takes about 1.7 GB, so one on a Mac under 12 GB, up to
 * three with room for the rest of Edit and the person's apps (Sphe, Nov 17:
 * "8 GB Macs 1, ≥16 GB up to 3"). Every cell's work is at background
 * priority (the engine's threads: utility QoS and nice 10; its FFmpeg niced).
 */
export function cellsAtOnceFor(totalBytes: number): number {
  const gb = totalBytes / 2 ** 30;
  // 1.7 GB a cell, with headroom: 12 GB two, 16 GB and up three.
  return gb < 12 ? 1 : Math.max(1, Math.min(3, Math.floor((gb - 6) / 2.5)));
}

export const limits = { cells: cellsAtOnceFor(os.totalmem()) };
const pieceKey = (media: string, from: number) => `${media}@${Math.round(from * 1000)}`;

function note(project: string, piece: Piece): void {
  let mine = pieces.get(project);
  if (mine === undefined) pieces.set(project, (mine = new Map()));
  mine.set(pieceKey(piece.media, piece.from), piece);
}

/** What the team showed of a source's mark (the lesson's examples), and what's never one. */
export interface Hints {
  /** Where a source's mark is, when an example of it showed it. */
  hint(source: string): Box | null;
  /** Boxes kept as the original's (the lesson's keep examples): never taken for a mark. */
  keep: Box[];
  /** Of what the timeline shows of a footage file, the seconds to clean (none: the file isn't looked at); all of them when not given. */
  scope?(media: string, shown: [number, number][]): [number, number][];
}

const NO_HINTS: Hints = { hint: () => null, keep: [] };

/** A project's hints (removal_schedule.ts: its lesson's examples, and what it covers: by itself, or what was asked for); none in tests. */
export const hintsFor = { project: (_app: App, _id: string): Hints => NO_HINTS };

export interface Cell {
  media: Media;
  source: string;
  from: number;
  to: number;
  model: Model;
  done: Done | null;
}

/**
 * What `project`'s timeline needs: the cells still to clean of each footage
 * file with a mark (by its own mark), and the files not looked at yet. A file
 * with no mark needs nothing.
 */
export async function plan(app: App, project: Project, hints: Hints = NO_HINTS): Promise<{ cells: Cell[]; unknown: { media: Media; source: string }[] }> {
  const cells: Cell[] = [];
  const unknown: { media: Media; source: string }[] = [];
  for (const [id, all] of shownSeconds(project)) {
    const shown = hints.scope === undefined ? all : hints.scope(id, all);
    if (shown.length === 0) continue;
    const media = project.media.find((one) => one.id === id);
    if (media === undefined || !(media.duration! > 0)) continue;
    const laid = project.media.filter((one) => one.cleans?.media === id && one.cleans.what === "watermark");
    const needed = cellsFor(shown, media.duration ?? 0).filter(([a]) => !laid.some((strip) => Math.abs(strip.cleans!.from - a) < 0.01));
    if (needed.length === 0) continue;
    const source = await sourceOf(media);
    const mark = await markOf(app, source);
    // Not looked at yet, or looked at with no mark found and the team has since shown where it is: looked at (again).
    const showed = hints.hint(source);
    if (mark === null || (isNone(mark) && showed !== null && JSON.stringify(mark.hint) !== JSON.stringify(showed))) {
      unknown.push({ media, source });
      continue;
    }
    if (isNone(mark)) continue;
    const kept = await shelfOf(app).list(source, mark.hash);
    for (const [from, to] of needed) cells.push({ media, source, from, to, model: mark, done: kept.find((one) => Math.abs(one.from - from) < 0.01) ?? null });
  }
  return { cells, unknown };
}

/**
 * Brings `id`'s cleaning up to date: every footage file on its timeline
 * looked at for a mark once (one at a time, in the background), kept cells
 * laid at once, the rest queued; a file with no mark left alone. Free. The
 * caller decides it's wanted (removal_schedule.ts: a lesson that takes
 * watermarks out).
 */
export async function ensure(app: App, id: string, hints: Hints = hintsFor.project(app, id)): Promise<void> {
  const live = app.store.get(id);
  if (live === null || engine() === null) return;
  const stopsBefore = stops.get(id) ?? 0;
  const { cells, unknown } = await plan(app, live.project, hints);
  // Stopped while it planned: nothing queued from it.
  if ((stops.get(id) ?? 0) !== stopsBefore) return;
  for (const { media, source } of unknown) {
    lookedFor.set(`${id}|${media.id}`, source);
    const waiting = looking.get(source);
    if (waiting !== undefined) {
      waiting.add(id);
      continue;
    }
    if (Date.now() - (lookFailed.get(source) ?? 0) < LOOK_AGAIN_AFTER_MS) continue;
    looking.set(source, new Set([id]));
    looks.push({ project: id, media, source, hint: hints.hint(source), keep: hints.keep });
  }
  for (const cell of cells) {
    const key = pieceKey(cell.media.id, cell.from);
    const known = pieces.get(id)?.get(key);
    if (known?.gaveUp === true) continue;
    if (known !== undefined && known.state !== "failed") {
      if (known.state === "done" && cell.done === null) continue;
      if (known.state === "queued" || known.state === "running" || known.state === "none") continue;
    }
    if (cell.done !== null) {
      note(id, { media: cell.media.id, name: cell.media.name, from: cell.from, to: cell.to, state: cell.done.box === null ? "none" : "done" });
      if (cell.done.box !== null) {
        const file = await shelfOf(app).bring(cell.source, cell.done);
        await place(app, id, cell.media, cell.from, cell.done.box, file);
      }
      continue;
    }
    note(id, { media: cell.media.id, name: cell.media.name, from: cell.from, to: cell.to, state: "queued", tries: known?.tries ?? 0 });
    queue.push({ project: id, media: cell.media, source: cell.source, from: cell.from, to: cell.to, model: cell.model });
  }
  drain(app);
}

/** Files of `id` being looked at for their mark now or queued to be (an export waits for them as for pieces). */
/** Each project's files queued or being looked at for their mark, by `project|media`: their source. */
const lookedFor = new Map<string, string>();

/** Whether project `id`'s file `media` is still being looked at for its mark (a stretch of it the model cleans waits). */
export function lookingAtMedia(id: string, media: string): boolean {
  const source = lookedFor.get(`${id}|${media}`);
  return source !== undefined && looking.get(source)?.has(id) === true;
}

export function lookingAt(id: string): number {
  let count = 0;
  for (const waiting of looking.values()) if (waiting.has(id)) count += 1;
  return count;
}

/** The queue: up to `limits.cells` at once, a file's cells first (its mark known), the next file to look at beside them (one at a time). */
function drain(app: App): void {
  while (running < cellsAtOnce()) {
    const job = queue.shift();
    if (job !== undefined) {
      running += 1;
      underWay.add(job);
      void work(app, job).finally(() => {
        underWay.delete(job);
        running -= 1;
        drain(app);
      });
      continue;
    }
    if (lookingNow >= looksAtOnce()) break;
    const look = looks.shift();
    if (look === undefined) break;
    running += 1;
    lookingNow += 1;
    void lookAt(app, look).finally(() => {
      running -= 1;
      lookingNow -= 1;
      drain(app);
    });
  }
}

/** Looks at one file for its mark; then every project waiting on it brought up to date (its cells queued, or nothing). */
async function lookAt(app: App, look: Look): Promise<void> {
  const waiting = looking.get(look.source) ?? new Set([look.project]);
  try {
    const mark = await markOf(app, look.source);
    if (mark === null || (isNone(mark) && look.hint !== null)) await learn(app, look.media, look.hint, look.keep);
  } catch (error) {
    lookFailed.set(look.source, Date.now());
    diag.warn("watermark", `${look.media.name}: looking for its mark: ${diag.messageOf(error)}`);
  } finally {
    looking.delete(look.source);
  }
  for (const project of waiting) {
    await ensure(app, project).catch((error: unknown) => diag.warn("watermark", `${project}: ${diag.messageOf(error)}`));
    await looked.then(app, project).catch((error: unknown) => diag.warn("watermark", `${project}: ${diag.messageOf(error)}`));
  }
}

/**
 * The rest of a project waiting on a file's look, brought up to date after its cells (removal_schedule.ts: its
 * cleaning, whose stretches wait on the look). Nov 20: after a restart SMART Cops' 106 stretches
 * waited on their files' looks and nothing asked again once they were done; a project's saves had always asked
 * (its blurs laid again and again), until those stopped.
 */
export const looked = { then: async (_app: App, _id: string): Promise<void> => {} };

async function work(app: App, job: Job): Promise<void> {
  const run = engineFor(job.media);
  const label = `${job.media.name} ${job.from}–${job.to} s`;
  const tries = (pieces.get(job.project)?.get(pieceKey(job.media.id, job.from))?.tries ?? 0) + 1;
  const piece: Piece = { media: job.media.id, name: job.media.name, from: job.from, to: job.to, state: "running", tries };
  note(job.project, piece);
  const stopped = () => job.stopped === true;
  const dir = join(app.store.cacheDir(), "cleaned", "work");
  fs.mkdirSync(dir, { recursive: true });
  const out = join(dir, `${job.project}-${job.media.id}-${Math.round(job.from * 1000)}-${++workFiles}.watermark.mp4`);
  try {
    if (run === null) throw new Error("this Edit's engine can't take watermarks out");
    const input = await cloudMedia.originalInput(app.store.cacheDir(), job.media);
    const keep = await stampOf(app, job.media, input).catch(() => []);
    if (!(await playing.whenIdle(stopped))) return;
    const started = Date.now();
    const removed = await run.remove(
      { source: input, size: [job.media.width || 1280, job.media.height || 720], fps: job.media.fps || 30, from: job.from, to: job.to, model: job.model.json, keep, out },
      () => {},
      stopped,
    );
    piece.seconds = Math.round((Date.now() - started) / 100) / 10;
    // Its mark not found in the cell at all: kept as none there.
    const found = removed !== null && removed.left < NOT_FOUND ? removed : null;
    if (removed !== null && found === null) diag.info("watermark", `${job.project}: ${label}: its mark wasn't found there (${Math.round(removed.left * 100)}% left), nothing laid`);
    // The automatic look: too much of the mark still found is no clean piece, never kept or laid (a Stop meanwhile
    // can't leave it on the shelf for another run to lay); done once more unless the person stopped it.
    if (found !== null && found.left > LEFT_MAX) {
      if (stopped()) return;
      piece.left = Math.round(found.left * 1000) / 1000;
      piece.filled = Math.round(found.filled * 1000) / 1000;
      await reject(app, job.project, `watermark:${job.media.id}@${Math.round(job.from * 1000)}`, `${Math.round(found.left * 100)}% of the mark still found`);
      return;
    }
    const done = await shelfOf(app).keep(job.source, found === null ? null : out, { from: job.from, to: job.to, box: found?.region ?? null }, job.model.hash);
    if (found === null || done.box === null) {
      piece.state = "none";
      return;
    }
    piece.left = Math.round(found.left * 1000) / 1000;
    piece.filled = Math.round(found.filled * 1000) / 1000;
    const file = await shelfOf(app).bring(job.source, done);
    await place(app, job.project, job.media, job.from, done.box, file);
    piece.state = "done";
    diag.info("watermark", `${job.project}: ${label} in ${piece.seconds} s (${Math.round(found.filled * 100)}% rebuilt from its neighbours, ${Math.round(found.left * 100)}% of the mark left)`);
  } catch (error) {
    if (stopped()) return;
    piece.state = "failed";
    piece.error = diag.messageOf(error);
    diag.warn("watermark", `${job.project}: ${label} wasn't cleaned (its watermark stays): ${piece.error}`);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Puts a cell's strip in the project (clean_strips.ts lays it over the clips, under a text strip of the same frames). */
async function place(app: App, id: string, footage: Media, from: number, box: Box, file: string): Promise<void> {
  const probed: Probe = await probe(file);
  await playing.whenIdle();
  const to = from + probed.duration;
  await app.store.update(id, "watermark removal", (project) => {
    if (!project.media.some((one) => one.id === footage.id)) return;
    project.media = project.media.filter((one) => !(one.cleans?.media === footage.id && one.cleans.what === "watermark" && Math.abs(one.cleans.from - from) < 0.01));
    const strip: Media = {
      id: freshId(project, "m"),
      name: `${footage.name} · their watermark out ${Math.round(from)}–${Math.round(to)} s`,
      path: file,
      kind: "video",
      duration: probed.duration,
      width: probed.width,
      height: Math.round(probed.height / 2),
      fps: probed.fps,
      has_audio: false,
      stacked_alpha: true,
      cleans: { media: footage.id, from, to, box: box.map((value) => Math.round(value * 1e4) / 1e4) as Box, what: "watermark" },
    };
    project.media.push(strip);
  });
  app.media.ensure(file, probed, true);
  try {
    if (cloud.enabled()) seams.cloudMedia.backfillSoon(app, id);
  } catch (error) {
    diag.warn("cloud", `backfill ${id}: ${diag.messageOf(error)}`);
  }
}

/** Takes the watermark strip of footage `media`'s cell at `from` out of project `id`. */
async function unlay(app: App, id: string, media: string, from: number): Promise<void> {
  await app.store.update(id, "watermark removal", (project) => {
    project.media = project.media.filter((one) => !(one.cleans?.media === media && one.cleans.what === "watermark" && Math.abs(one.cleans.from - from) < 0.01));
  });
}

/**
 * A piece that isn't clean (the automatic look, or the agent's: removal_schedule.ts
 * `check_removal`): its strip out of the project and its kept cell forgotten;
 * done once more, else given up on, the watermark left there, said in `error`.
 */
export async function reject(app: App, id: string, key: string, why: string): Promise<string> {
  const match = /^watermark:(.+)@(\d+)$/u.exec(key);
  const piece = match === null ? undefined : pieces.get(id)?.get(pieceKey(match[1]!, Number(match[2]) / 1000));
  if (piece === undefined) throw new Error(`no piece ${key}`);
  const live = app.store.get(id);
  const media = live?.project.media.find((one) => one.id === piece.media);
  const source = media === undefined ? null : await sourceOf(media);
  const model = source === null ? null : await markOf(app, source);
  if (source !== null && model !== null && !isNone(model)) {
    for (const kept of (await shelfOf(app).list(source, model.hash)).filter((one) => Math.abs(one.from - piece.from) < 0.01)) await shelfOf(app).forget(source, kept, model.hash);
  }
  await unlay(app, id, piece.media, piece.from);
  const again = (piece.tries ?? 1) < 2;
  note(id, { ...piece, state: "failed", error: why, ...(again ? {} : { gaveUp: true }) });
  diag.warn("watermark", `${id}: ${piece.name} ${piece.from}–${piece.to} s not clean (${why}): ${again ? "done again" : "left as it was"}`);
  if (again) void ensure(app, id);
  return again ? "done once more" : "given up on: their watermark stays there";
}

/** The project's cleaned pieces and how each came out (a check reads `left`: what of the mark is still found). */
export function piecesOf(id: string): Piece[] {
  return [...(pieces.get(id)?.values() ?? [])].sort((a, b) => a.media.localeCompare(b.media) || a.from - b.from);
}

/**
 * The person's Stop: nothing more of `id` is done; cleaned cells stay. A cell under way is let go at once (Nov 24, the
 * Trooper edit: 22 cells on rented machines stayed "running" after its Stop until Edit restarted, and held its export
 * and every restart behind them): a rented machine's job is called off, and one here finishes and is kept when clean.
 */
export function stop(id: string): void {
  stops.set(id, (stops.get(id) ?? 0) + 1);
  for (let at = queue.length - 1; at >= 0; at--) if (queue[at]!.project === id) queue.splice(at, 1);
  for (let at = looks.length - 1; at >= 0; at--) if (looks[at]!.project === id) looks.splice(at, 1);
  for (const [source, waiting] of looking) {
    waiting.delete(id);
    if (waiting.size === 0 && !looks.some((one) => one.source === source)) looking.delete(source);
  }
  for (const job of underWay) if (job.project === id) job.stopped = true;
  const mine = pieces.get(id);
  for (const [key, piece] of mine ?? []) if (piece.state === "queued" || piece.state === "running") mine!.delete(key);
}

/** For tests: every queued piece done. */
export async function settled(): Promise<void> {
  while (running > 0 || queue.length > 0 || looks.length > 0) await Bun.sleep(20);
}

/** For tests: nothing remembered. */
export function reset(): void {
  pieces.clear();
  marks.clear();
  queue.length = 0;
  looks.length = 0;
  looking.clear();
  lookFailed.clear();
  // A fresh server's queue: what was under way is gone with the one that stopped.
  underWay.clear();
  stops.clear();
  running = 0;
  lookingNow = 0;
  lookedFor.clear();
}

export function routes(router: Router<App>): void {
  // The project's cleaned pieces and how each came out (a check reads `left`: what of the mark is still found).
  router.get("/api/projects/{id}/watermark", ({ app, params }) => {
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    return json({ pieces: piecesOf(id) });
  });
}
