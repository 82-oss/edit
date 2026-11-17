// Edit V2's effect renders in the cloud, kept to what an edit can use (Sphe,
// Nov 13: "we really need to have huge improvements here"). Each settled
// version of an effect's code is rendered to a video (effects.ts), and until
// now each went up as footage does (`edit/originals/sha256/…`, with a proxy
// for one over 256 MB), stayed there for good, and came back down into the
// cache beside the file it was made from: the Cops 3 Bodies trial left about
// 143 renders (≈ 73 minutes of 1080p at ~17 Mbit/s) in R2 in two days, and
// each one on its Mac twice.
//
// Now a render is the project's own file, not footage: `edit/exports/<project>/
// effect-<name>-<key>.mp4`, under the project's exports, which whoever may
// work on the project may delete (the relay's ownExports) and nobody else
// reads. It's its own preview whatever its size (no proxy), and the cache's
// copy is the render itself, linked there (no second copy, no download back);
// the render's own file goes once that's done, so what's on disk is the
// cache's to keep within its budget. An effect keeps two renders in the
// cloud, the one in use and the one before it (an undo of the swap); older
// ones are deleted as each new one goes up, from this computer's list of the
// ones it knows of (`<home>/cloud/effect-renders.json`) and the render each
// new one replaced (said by effects.ts, whichever computer made it). A
// deleted project's go with it.

import fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { pinned } from "./file_pins.ts";
import { writeAtomic } from "./files.ts";
import { join, parent } from "./paths.ts";

/** Renders an effect keeps in the cloud: the one in use and the one before it. */
export const KEPT = 2;

type Known = Record<string, Record<string, string[]>>;

/** Seams for tests. */
export const hooks = { remove: (keys: string[]): Promise<void> => cloud.remove(keys) };

const fileOf = (home: string) => join(home, "cloud", "effect-renders.json");

/** Where a project's render `file` (`<name>-<key>.mp4`) is kept in R2. */
export function keyOf(project: string, file: string): string {
  return `edit/exports/${project}/effect-${file}`;
}

/** Whether `key` is one of `project`'s effect renders (one put up the way this file does). */
export function isRender(project: string, key: string | null | undefined): key is string {
  return typeof key === "string" && key.startsWith(`edit/exports/${project}/effect-`) && !key.slice(`edit/exports/${project}/`.length).includes("/");
}

/** The effect a render key is of, by its file's name (`effect-<name>-<12 hex>.mp4`). */
export function effectOf(key: string): string | null {
  return /\/effect-(.+)-[0-9a-f]{12}\.mp4$/.exec(key)?.[1] ?? null;
}

function read(home: string): Known {
  try {
    const value = JSON.parse(fs.readFileSync(fileOf(home), "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Known) : {};
  } catch {
    return {};
  }
}

function write(home: string, known: Known): void {
  fs.mkdirSync(join(home, "cloud"), { recursive: true });
  writeAtomic(fileOf(home), JSON.stringify(known));
}

/** Adds `key` as `name`'s newest render (once). */
function remember(known: Known, project: string, name: string, key: string): string[] {
  const list = ((known[project] ??= {})[name] ??= []).filter((one) => one !== key);
  list.push(key);
  known[project]![name] = list;
  return list;
}

/** Says that the render `key` was in use for effect `name` until a new render replaced it (effects.ts, at the swap). */
export function replaced(home: string, project: string, name: string, key: string): void {
  if (!isRender(project, key)) return;
  const known = read(home);
  const list = ((known[project] ??= {})[name] ??= []);
  // Known already: it stays where it is in the order. Else it was made on another computer, just before this one's.
  if (!list.includes(key)) list.push(key);
  write(home, known);
}

/** Serialises the list's changes and the deletes behind them. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Effect `name`'s render `key` is now in use (it went up and the project
 * says so): its older renders but the one before it are deleted, from the
 * cloud and from this computer's cache.
 */
export function inUse(app: App, project: string, name: string, key: string): Promise<void> {
  const work = chain.then(async () => {
    const home = app.store.home;
    const known = read(home);
    const list = remember(known, project, name, key);
    write(home, known);
    const old = list.slice(0, Math.max(0, list.length - KEPT));
    if (old.length === 0) return;
    await retire(app, project, old);
  });
  chain = work.catch(() => undefined);
  return work;
}

/** Deletes `keys` (a project's renders) from the cloud and the cache, and from the list once gone. */
async function retire(app: App, project: string, keys: string[]): Promise<void> {
  const ours = keys.filter((key) => isRender(project, key));
  if (ours.length === 0) return;
  try {
    await hooks.remove(ours);
  } catch (error) {
    // Kept on the list: tried again with the effect's next render.
    diag.warn("effects", `${project}: ${ours.length} old render(s) left in the cloud: ${diag.messageOf(error)}`);
    return;
  }
  const cache = app.store.cacheDir();
  // One an export is reading stays here (file_pins.ts); the cache's cleaner takes it once nobody uses it.
  for (const key of ours) if (!pinned(cachePath(cache, key))) fs.rmSync(cachePath(cache, key), { force: true });
  const known = read(app.store.home);
  for (const [name, list] of Object.entries(known[project] ?? {})) {
    const left = list.filter((key) => !ours.includes(key));
    if (left.length > 0) known[project]![name] = left;
    else delete known[project]![name];
  }
  if (known[project] !== undefined && Object.keys(known[project]!).length === 0) delete known[project];
  write(app.store.home, known);
  diag.info("effects", `${project}: ${ours.length} old render(s) deleted from the cloud`);
}

/** This computer's copy of a cloud key (cloud_media.localPath, without importing it). */
export function cachePath(cache: string, key: string): string {
  return join(cache, "cloud", key.startsWith("edit/") ? key.slice("edit/".length) : key);
}

/**
 * Puts the render at `path` where this computer's copy of `key` is read from
 * (the viewer, Edit.app's player, exports), as the same file: a hard link,
 * so it costs nothing more on the disk. False when it can't be linked
 * (another disk): the copy then comes from the cloud when it's needed.
 */
export function linkInto(path: string, cache: string, key: string): boolean {
  const target = cachePath(cache, key);
  try {
    if (fs.existsSync(target)) return true;
    fs.mkdirSync(parent(target)!, { recursive: true });
    fs.linkSync(path, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The render `file` of `project`, already up or in this computer's cache: the
 * cache's copy, linked back to `out` so it needn't be drawn again (an undo
 * back to it, the same code saved again). False when there's none here.
 */
export function bringBack(cache: string, project: string, file: string, out: string): boolean {
  const here = cachePath(cache, keyOf(project, file));
  try {
    if (!fs.statSync(here).isFile()) return false;
    fs.mkdirSync(parent(out)!, { recursive: true });
    fs.linkSync(here, out);
    return true;
  } catch {
    return false;
  }
}

/** A deleted project's renders: every one it used and every one this computer knows of, gone from the cloud. */
export async function forgetProject(app: App, project: string, used: (string | null | undefined)[]): Promise<void> {
  const known = read(app.store.home);
  const keys = [...new Set([...Object.values(known[project] ?? {}).flat(), ...used.filter((key): key is string => isRender(project, key))])];
  if (keys.length === 0) return;
  await (chain = chain.then(() => retire(app, project, keys)).catch(() => undefined));
}

/** A render file of effect `<name>`: `<name>-<12 hex>.mp4`. */
const RENDER_FILE = /^(.+)-[0-9a-f]{12}\.mp4$/;
/** What a render leaves while it's under way: its frames' folder and the video being joined from them. */
const RENDER_WORK = /^.+-[0-9a-f]{12}\.(frames|partial\.mp4)$/;
/** Work of a render that stopped (a failure, Edit quit) untouched this long goes, unless a render is on it again. */
const WORK_LEFT_MS = 3600_000;

/** Whether a render is under way or waiting to go on with `file` of `project`'s renders (effects.ts says, as it renders). */
export const renderingNow = { is: (_project: string, _file: string): boolean => false };
/** A render placed this recently may not be in its project's file yet. */
const SETTLED_MS = 3600_000;

/**
 * This computer's render files (`<home>/media/<project>/effect-renders/`) no
 * edit plays from: a render replaced by one that's in the cloud (its own
 * there, or kept there before this file did that), or of an effect no
 * longer on the timeline, or of a deleted project. Kept: the render a
 * project plays from this file (not up yet: signed out, a project that isn't
 * the cloud's) and, for one of those, the render before it (prune's). Also
 * what a render that stopped left (its frames, a join cut short), an hour on
 * and with no render going on from it.
 */
export function sweepRenders(home: string, now = Date.now(), dryRun = false): { files: number; bytes: number } {
  const out = { files: 0, bytes: 0 };
  const media = join(home, "media");
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(media);
  } catch {
    return out;
  }
  for (const id of projects) {
    const dir = join(media, id, "effect-renders");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    type Saved = { media?: { path?: unknown; effect?: unknown; cloud?: unknown }[] };
    let saved = null as Saved | null;
    try {
      saved = JSON.parse(fs.readFileSync(join(home, "projects", `${id}.json`), "utf8")) as Saved;
    } catch (error) {
      // Being written, or unreadable: nothing of it goes. Only a project with no file at all is a deleted one.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    const items = saved?.media ?? [];
    const playing = new Set(items.map((one) => one.path).filter((path): path is string => typeof path === "string"));
    for (const name of names) {
      // A failed render's frames (a PNG each, gigabytes of them) and a join cut short: nothing goes on from them.
      if (RENDER_WORK.test(name)) {
        const path = join(dir, name);
        try {
          const stat = fs.statSync(path);
          if (now - stat.mtimeMs < WORK_LEFT_MS || renderingNow.is(id, name)) continue;
          const bytes = stat.isDirectory() ? fs.readdirSync(path).reduce((sum, one) => { try { return sum + fs.statSync(join(path, one)).size; } catch { return sum; } }, 0) : stat.size;
          if (!dryRun) fs.rmSync(path, { recursive: true, force: true });
          out.files += 1;
          out.bytes += bytes;
        } catch {
          // Gone already.
        }
        continue;
      }
      const effect = RENDER_FILE.exec(name)?.[1];
      if (effect === undefined) continue;
      const path = join(dir, name);
      // Played from, or read by an export under way (planned from the edit before its render went up: file_pins.ts).
      if (playing.has(path) || pinned(path)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < SETTLED_MS) continue;
      const own = items.find((one) => one.effect === effect);
      // Its effect's render in use is in the cloud, or there's no such effect any more (or no such project): this one's done.
      if (own !== undefined && (own.cloud === undefined || own.cloud === null)) continue;
      if (!dryRun) fs.rmSync(path, { force: true });
      out.files += 1;
      out.bytes += stat.size;
    }
  }
  return out;
}

/** Sweeps the render files a few minutes after the start, then hourly. */
export function start(app: App): () => void {
  const run = () => {
    try {
      const swept = sweepRenders(app.store.home);
      if (swept.files > 0) diag.info("effects", `${swept.files} render file(s) no edit plays from removed (${Math.round(swept.bytes / 1e6)} MB)`);
    } catch (error) {
      diag.warn("effects", `old render files: ${diag.messageOf(error)}`);
    }
  };
  const first = setTimeout(run, 4 * 60_000);
  const hourly = setInterval(run, 3600_000);
  return () => {
    clearTimeout(first);
    clearInterval(hourly);
  };
}
