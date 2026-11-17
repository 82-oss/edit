// A re-uploader's see-through watermark out of the footage (Sphe, Nov 17:
// "daily dose of crime" over all of Tulsa's bodycam), by arithmetic on this
// computer: the engine's watermark.rs, nothing sent anywhere, nothing paid. A
// channel taught to take their watermark out has its mark learned once (its
// matte, white and blend curve, from footage carrying it: `learn`) and kept
// on R2 with the channel's other cleaned work (`edit/cleaned/watermarks/`).
//
// Then, for every project of that channel, as soon as footage is on the
// timeline and in the background beside the agent's other work: the seconds
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

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { ApiError, json } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import { probe } from "./media.ts";
import type { Media, Probe, Project } from "./model.ts";
import { native, type Box, type WatermarkPiece, type WatermarkRemoved } from "./native/index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import { freshId } from "./project.ts";
import * as seams from "./seams.ts";
import { folderOf, PREFIX, shownSeconds, sourceOf, stampOf } from "./text_removal.ts";

/** Seconds of a file each strip covers (its cells start at 0, 30, 60…). */
export const CELL = 30;
/** Seconds either side of what the timeline shows that are cleaned too. */
export const HANDLE = 1;
/** Where each channel's mark is kept. */
const MODELS = `${PREFIX}/watermarks`;

/** The engine's two calls (the addon's; a stand-in in tests). */
export interface Engine {
  learn(source: string, size: [number, number], duration: number, hint: Box | null, avoid: Box[], onProgress: (progress: number) => void): Promise<string>;
  remove(piece: WatermarkPiece, onProgress: (progress: number) => void): Promise<WatermarkRemoved | null>;
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
  return { learn: addon.watermarkLearn.bind(addon), remove: addon.watermarkRemove.bind(addon) };
}

// ---------------------------------------------------------------------------
// A channel's mark

/** A channel's learned mark: the engine's model (JSON) and a short hash naming what it makes. */
export interface Model {
  json: string;
  hash: string;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 10);
const modelFile = (app: App, channel: string) => join(app.store.cacheDir(), "watermarks", `${channel}.json`);
const modelKey = (channel: string) => `${MODELS}/${channel}.json`;
const models = new Map<string, { at: number; model: Model | null }>();

/** The channel's mark, or null when it's taught none: from here, else R2 (looked at again after a minute). */
export async function modelOf(app: App, channel: string): Promise<Model | null> {
  const kept = models.get(channel);
  if (kept !== undefined && (kept.model !== null || Date.now() - kept.at < 60_000)) return kept.model;
  const file = modelFile(app, channel);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    if (cloud.enabled() && (await cloud.has(modelKey(channel)).catch(() => false))) {
      fs.mkdirSync(join(app.store.cacheDir(), "watermarks"), { recursive: true });
      await cloud.download(modelKey(channel), file).catch((error: unknown) => diag.warn("watermark", `${channel}'s mark: ${diag.messageOf(error)}`));
      text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    }
  }
  const model = text === null ? null : { json: text, hash: hashOf(text) };
  models.set(channel, { at: Date.now(), model });
  return model;
}

/**
 * Learns `channel`'s mark from `media` (footage carrying it), in `hint`
 * (shares) when the team showed where, and keeps it with the channel: from
 * now on its projects' footage has it taken out.
 */
export async function learn(app: App, channel: string, media: Media, hint: Box | null = null): Promise<Model> {
  const run = engine();
  if (run === null) throw new ApiError(409, "This Edit can't take watermarks out yet: update it.");
  const input = await cloudMedia.originalInput(app.store.cacheDir(), media);
  const avoid = await stampOf(app, media, input).catch(() => []);
  await playing.whenIdle();
  const text = await run.learn(input, [media.width || 1280, media.height || 720], media.duration ?? 0, hint, avoid, () => {});
  const file = modelFile(app, channel);
  fs.mkdirSync(join(app.store.cacheDir(), "watermarks"), { recursive: true });
  writeAtomic(file, text);
  if (cloud.enabled()) await cloud.uploadFile(file, modelKey(channel));
  const model = { json: text, hash: hashOf(text) };
  models.set(channel, { at: Date.now(), model });
  diag.info("watermark", `${channel}: its mark learned from ${media.name}`);
  return model;
}

/** Forgets `channel`'s mark: its footage keeps its watermark from now on (strips already laid stay). */
export async function forget(app: App, channel: string): Promise<void> {
  fs.rmSync(modelFile(app, channel), { force: true });
  if (cloud.enabled()) await cloud.remove([modelKey(channel)]).catch((error: unknown) => diag.warn("watermark", `forgetting ${channel}'s mark: ${diag.messageOf(error)}`));
  models.set(channel, { at: Date.now(), model: null });
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

interface Job {
  project: string;
  media: Media;
  source: string;
  from: number;
  to: number;
  model: Model;
}

const pieces = new Map<string, Map<string, Piece>>();
const queue: Job[] = [];
let busy = false;
const pieceKey = (media: string, from: number) => `${media}@${Math.round(from * 1000)}`;

function note(project: string, piece: Piece): void {
  let mine = pieces.get(project);
  if (mine === undefined) pieces.set(project, (mine = new Map()));
  mine.set(pieceKey(piece.media, piece.from), piece);
}

/** The cells of `project` still to clean, given its channel's mark (none when it's taught none). */
export async function plan(app: App, project: Project, model: Model): Promise<{ media: Media; source: string; from: number; to: number; done: Done | null }[]> {
  const out: { media: Media; source: string; from: number; to: number; done: Done | null }[] = [];
  for (const [id, shown] of shownSeconds(project)) {
    const media = project.media.find((one) => one.id === id);
    if (media === undefined || !(media.duration! > 0)) continue;
    const laid = project.media.filter((one) => one.cleans?.media === id && one.cleans.what === "watermark");
    const cells = cellsFor(shown, media.duration ?? 0).filter(([a]) => !laid.some((strip) => Math.abs(strip.cleans!.from - a) < 0.01));
    if (cells.length === 0) continue;
    const source = await sourceOf(media);
    const kept = await shelfOf(app).list(source, model.hash);
    for (const [from, to] of cells) out.push({ media, source, from, to, done: kept.find((one) => Math.abs(one.from - from) < 0.01) ?? null });
  }
  return out;
}

/** Brings `id`'s cleaning up to date: kept cells laid at once, the rest queued. Free; never during nothing to do. */
export async function ensure(app: App, id: string): Promise<void> {
  const live = app.store.get(id);
  if (live === null || !live.project.channel || engine() === null) return;
  const model = await modelOf(app, live.project.channel);
  if (model === null) return;
  for (const cell of await plan(app, live.project, model)) {
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
    queue.push({ project: id, media: cell.media, source: cell.source, from: cell.from, to: cell.to, model });
  }
  void drain(app);
}

async function drain(app: App): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) await work(app, job);
  } finally {
    busy = false;
  }
}

async function work(app: App, job: Job): Promise<void> {
  const run = engine();
  const label = `${job.media.name} ${job.from}–${job.to} s`;
  const tries = (pieces.get(job.project)?.get(pieceKey(job.media.id, job.from))?.tries ?? 0) + 1;
  const piece: Piece = { media: job.media.id, name: job.media.name, from: job.from, to: job.to, state: "running", tries };
  note(job.project, piece);
  const dir = join(app.store.cacheDir(), "cleaned", "work");
  fs.mkdirSync(dir, { recursive: true });
  const out = join(dir, `${job.project}-${job.media.id}-${Math.round(job.from * 1000)}.watermark.mp4`);
  try {
    if (run === null) throw new Error("this Edit's engine can't take watermarks out");
    const input = await cloudMedia.originalInput(app.store.cacheDir(), job.media);
    const keep = await stampOf(app, job.media, input).catch(() => []);
    await playing.whenIdle();
    const started = Date.now();
    const removed = await run.remove(
      { source: input, size: [job.media.width || 1280, job.media.height || 720], fps: job.media.fps || 30, from: job.from, to: job.to, model: job.model.json, keep, out },
      () => {},
    );
    piece.seconds = Math.round((Date.now() - started) / 100) / 10;
    const done = await shelfOf(app).keep(job.source, removed === null ? null : out, { from: job.from, to: job.to, box: removed?.region ?? null }, job.model.hash);
    if (removed === null || done.box === null) {
      piece.state = "none";
      return;
    }
    piece.left = Math.round(removed.left * 1000) / 1000;
    piece.filled = Math.round(removed.filled * 1000) / 1000;
    const file = await shelfOf(app).bring(job.source, done);
    await place(app, job.project, job.media, job.from, done.box, file);
    piece.state = "done";
    // The automatic look: too much of the mark still found is no clean piece.
    if (removed.left > LEFT_MAX) await reject(app, job.project, `watermark:${job.media.id}@${Math.round(job.from * 1000)}`, `${Math.round(removed.left * 100)}% of the mark still found`);
    diag.info("watermark", `${job.project}: ${label} in ${piece.seconds} s (${Math.round(removed.filled * 100)}% rebuilt from its neighbours, ${Math.round(removed.left * 100)}% of the mark left)`);
  } catch (error) {
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
  const model = live?.project.channel ? await modelOf(app, live.project.channel) : null;
  if (media !== undefined && model !== null) {
    const source = await sourceOf(media);
    for (const kept of (await shelfOf(app).list(source, model.hash)).filter((one) => Math.abs(one.from - piece.from) < 0.01)) await shelfOf(app).forget(source, kept, model.hash);
  }
  await app.store.update(id, "watermark removal", (project) => {
    project.media = project.media.filter((one) => !(one.cleans?.media === piece.media && one.cleans.what === "watermark" && Math.abs(one.cleans.from - piece.from) < 0.01));
  });
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

/** For tests: every queued piece done. */
export async function settled(): Promise<void> {
  while (busy || queue.length > 0) await Bun.sleep(20);
}

/** For tests: nothing remembered. */
export function reset(): void {
  pieces.clear();
  models.clear();
  queue.length = 0;
}

export function routes(router: Router<App>): void {
  // The project's cleaned pieces and how each came out (a check reads `left`: what of the mark is still found).
  router.get("/api/projects/{id}/watermark", ({ app, params }) => {
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    return json({ pieces: piecesOf(id) });
  });
  // A channel's mark learned from a project's footage ({project, media, box?}: box the shares the team showed), or forgotten.
  router.post("/api/channels/{key}/footage-watermark", async (context) => {
    const body = (await readJson(context)) as { project?: unknown; media?: unknown; box?: unknown };
    const live = typeof body.project === "string" ? context.app.store.get(body.project) : null;
    const media = live?.project.media.find((one) => one.id === body.media);
    if (media === undefined) throw new ApiError(400, "project and media");
    const box = Array.isArray(body.box) && body.box.length === 4 && body.box.every((value) => typeof value === "number") ? (body.box as Box) : null;
    const model = await learn(context.app, context.params.key ?? "", media, box);
    for (const project of context.app.store.list()) if (project.channel === context.params.key) void ensure(context.app, project.id);
    return json({ learned: model.hash });
  });
  router.delete("/api/channels/{key}/footage-watermark", async ({ app, params }) => {
    await forget(app, params.key ?? "");
    return json({ forgotten: true });
  });
}
