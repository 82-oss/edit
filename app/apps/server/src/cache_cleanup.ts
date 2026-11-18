// The cache kept to what's used (Oct 18): an 8 GB Mac's disk filled
// with previews of footage no project uses any more, and a half-written
// 1.6 GB preview an interrupted run left behind.
//
// Media folders (`<cache>/<media key>/`) of media no saved project uses lose
// what's made again cheaply (previews, thumbnails, waveforms, loudness and
// censor analysis); what cost money to make (transcripts, watch answers,
// seats, faces) stays, so a project that brings the footage back pays
// nothing again. Half-written files a day old go wherever they are. Nothing
// touched in the last two days is removed.
//
// Footage projects still used kept its previews forever, though (Oct 21: a
// Mac's disk full with 36 GB of cache). Until Nov 18 the cache was kept
// under a budget (a quarter of the room, 400 MB to 50 GB) by the least
// recently used copy. Now (the local-first plan, Sphe, Nov 18: "storage
// follows the project's state, automatically, with no settings") it follows
// each project's state, from the ledger of every file here by project and
// kind (ledger.ts):
//
// - In work: open now, or anything running for it (busy.ts `workingFor`: a
//   turn, an export, a removal, an effect's render, a job), or any of its
//   files not yet in R2 (an upload pending or under way, media Edit made
//   that hasn't gone up); else, unless it's done, opened here in the last 3
//   days (or saved: an agent's turn with the editor closed). Everything of
//   it stays, its export made ahead among it: until Nov 18 only the one made
//   last on a Mac was kept, so a second project's took the first one's, and
//   its share rendered all 117 chunks again (JJ's Mac, Nov 17).
// - Idle: its derived copies go first when room is needed (exports made
//   ahead, export chunks, pieces, excerpts, sound and scrub copies, smooth
//   playback renders), then its proxies. Whole projects, the one worked on
//   longest ago first, before any project in work is touched.
// - Done on Home, or idle 7 days: its local footage goes at each pass, room
//   needed or not, its originals only once R2 has said it holds them at their
//   size (`confirmOriginals`), never a file from someone's disk (only Edit's
//   own copies are ever taken: ledger.ts `evictable`). Opened again, it comes
//   back as any cloud footage does (footage_ready.ts: "Getting the footage
//   ready", with its progress).
//
// The disk is kept with what Edit keeps free on it (storage.ts
// `keepFreeBytes`: 15 GB or a tenth of the disk); only with it under the
// cache's hard floor does a project in work give up copies, never one open in
// the last ten minutes nor one with work running. Whole proxy copies are the
// footage this Mac plays and renders from: they go only this way, never
// because R2 has them too. Pinned files (file_pins.ts), uploads not landed
// and anything written in the last hours always stay.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import { playbackPath } from "./cloud_playback.ts";
import { Semaphore } from "./media.ts";
import * as diag from "./diag.ts";
import * as drive from "./drive.ts";
import { aheadFile, beingRead } from "./exports.ts";
import * as retention from "./export_retention.ts";
import * as later from "./later.ts";
import { exportRoots } from "./export_folder.ts";
import * as reviews from "./reviews.ts";
import { carryAnalysis, localPath, readLocalOriginals, uploadingNow, uploadsNow, writeLocalOriginals } from "./cloud_media.ts";
import { createHash } from "node:crypto";

import * as busy from "./busy.ts";
import { pinned } from "./file_pins.ts";
import * as ledgerOf from "./ledger.ts";
import type { Entry } from "./ledger.ts";
import { evicted as nativeEvicted, oldCuts } from "./native_preview.ts";
import { openedTimes } from "./opened.ts";
import { join } from "./paths.ts";
import * as folderAccess from "./folder_access.ts";
import * as research from "./research.ts";
import * as writerStore from "./writer/store.ts";
import { CACHE_FLOOR_BYTES, FREE_FLOOR_BYTES, diskHooks, keepFreeBytes, ledger } from "./storage.ts";

/** Made again cheaply from the source. */
const REBUILT = /^(preview|thumbs|peaks|loudness|censor|light)/;
/** A write that never finished. */
const PARTIAL = /\.partial([.-]|$)|\.sb-[0-9a-f]+-/;
const DAY = 24 * 3600 * 1000;
/** Recently touched: maybe in use right now. */
const RECENT = 2 * DAY;
/** A cloud copy this new may be uploading or playing. */
const COPY_RECENT = 6 * 3600 * 1000;
/** A Drive download (its original in the cloud) not read by an export for this long goes. */
const DOWNLOADED = 3 * DAY;
/** A project worked on here this lately is in work: all of it stays. */
export const IN_WORK_MS = 3 * DAY;
/** A project not worked on here for this long is let go as a done one is: its footage too, its originals once R2 has them. */
export const LET_GO_MS = 7 * DAY;
/** With the disk under the cache's hard floor, only a project open this lately (or with work running) keeps its copies. */
const OPEN_NOW = 10 * 60 * 1000;

/** What a pass keeps the disk to: `freeBytes` free once it's done (`free` overrides the disk's free space now). */
export interface Limits {
  freeBytes: number;
  free?: number;
  /** Every file under the cache and the media, when the caller has just walked them (ledger.ts): not walked again. */
  entries?: Entry[];
  /** Originals R2 has said it holds at their size (`confirmOriginals`): only these of a done project's go. */
  confirmed?: Set<string>;
}

export interface CleanReport {
  folders: number;
  files: number;
  bytes: number;
  removed: string[];
}

/**
 * Remove the legacy previews (`preview*.mp4/m4a` in media-key folders) of
 * footage whose proxy R2 acknowledges. Originals, paid analysis, directly
 * referenced local media, and unfinished uploads are never candidates. HEAD
 * is required, not just project metadata.
 *
 * A whole proxy copy here (`cloud/proxies/…`) is never one: it's the footage
 * this Mac plays and renders from (the native player, the agent's renders:
 * local_previews.ts), kept until the cache is past its budget (`cleanCache`).
 * Until Nov 8 this removed every copy R2 also had (the Oct 29 "everything on
 * the cloud" policy): on Sphe's Mac `cache/cloud/proxies` was empty, the same
 * whole preview was fetched up to 8 times, and every frame streamed.
 */
export async function cleanCloudPreviews(
  app: App,
  dryRun: boolean,
  head: (key: string) => Promise<{ size: number } | null> = (key) => cloud.head(key),
): Promise<CleanReport> {
  const report: CleanReport = { folders: 0, files: 0, bytes: 0, removed: [] };
  const cache = app.store.cacheDir();
  const paths = new Set<string>();
  const sources = new Map<string, Set<string>>();
  const add = (key: string, alias: string) => {
    let aliases = sources.get(key);
    if (aliases === undefined) sources.set(key, aliases = new Set());
    aliases.add(alias);
  };
  // Read the saved locations before store.get normalises them for playback.
  // An unreadable project makes the reference set incomplete: keep everything.
  for (const name of safeList(join(app.store.home, "projects")).filter((name) => name.endsWith(".json"))) {
    try {
      const project = JSON.parse(fs.readFileSync(join(app.store.home, "projects", name), "utf8")) as {
        media?: { path: string; kind: string; cloud?: { proxy?: string } | null }[];
      };
      for (const media of project.media ?? []) {
        if (typeof media.path !== "string") return report;
        if (media.cloud?.proxy === undefined || !cloud.validKey(media.cloud.proxy)) {
          paths.add(media.path);
          continue;
        }
        if (media.kind === "image") continue;
        const key = media.cloud.proxy;
        add(key, app.native.mediaKey(media.path));
        add(key, app.native.mediaKey(localPath(cache, key)));
        add(key, app.native.mediaKey(playbackPath(key, app.port)));
        // Carry paid analysis before the old proxy's metadata (and key) goes.
        if (!dryRun) carryAnalysis(cache, media.path, playbackPath(key, app.port));
      }
    } catch { return report; }
  }
  // Analysis carried from an original records its older media keys. Follow
  // those aliases so migrating a project doesn't strand its old previews.
  for (const aliases of sources.values()) {
    for (const alias of aliases) {
      try {
        const value = JSON.parse(fs.readFileSync(join(cache, alias, "watch", "keys.json"), "utf8")) as { keys?: unknown };
        if (Array.isArray(value.keys)) for (const key of value.keys) if (typeof key === "string" && /^[0-9a-f]{16}$/.test(key)) aliases.add(key);
      } catch { /* no older analysis */ }
    }
  }
  const pending = pendingUploads(app.store.home);
  if (pending === null) return report;
  const removed = new Set<string>();
  const slots = new Semaphore(3);
  const candidatesWithFiles = [...sources].filter(([, aliases]) =>
    [...aliases].some((alias) => safeList(join(cache, alias)).some((name) => /^preview(?:-light)?\.(?:mp4|m4a)$/.test(name))),
  );
  const confirmedKeys = new Map(await Promise.all(candidatesWithFiles.map(([key]) => slots.with(async () => {
    try { return [key, await head(key)] as const; } catch { return [key, null] as const; }
  }))));
  for (const [key, aliases] of sources) {
    const confirmed = confirmedKeys.get(key) ?? null;
    if (confirmed === null || confirmed.size <= 0) continue;
    const candidates = new Set<string>();
    for (const alias of aliases) {
      const dir = join(cache, alias);
      for (const name of safeList(dir)) if (/^preview(?:-light)?\.(?:mp4|m4a|done)$/.test(name)) candidates.add(join(dir, name));
    }
    for (const path of candidates) {
      if (removed.has(path) || paths.has(path) || pending.has(path) || uploadingNow(path)) continue;
      try {
        const stat = fs.lstatSync(path);
        if (!stat.isFile()) continue;
        if (!dryRun) fs.rmSync(path);
        removed.add(path);
        report.files += 1;
        report.bytes += stat.size;
        if (report.removed.length < 50) report.removed.push(path);
      } catch { /* a concurrent job finished or removed it */ }
    }
  }
  report.folders = new Set([...removed].map((path) => path.slice(0, path.lastIndexOf("/")))).size;
  return report;
}

/**
 * The files whose uploads are noted in `<home>/jobs.json` and not done yet (each the only copy until it lands: a
 * proxy made here, an original Edit downloaded) and the keys they go to; null when the file won't read (then any
 * might be one).
 */
function pendingUploads(home: string): Set<string> | null {
  const pending = new Set<string>();
  try {
    const jobs = JSON.parse(fs.readFileSync(join(home, "jobs.json"), "utf8")) as { kind: string; state?: string; args?: { local?: unknown; file?: unknown; originalKey?: unknown; proxy?: unknown } }[];
    for (const job of jobs) {
      if (job.kind !== "upload" || job.state === "done") continue;
      for (const one of [job.args?.local, job.args?.file, job.args?.originalKey, job.args?.proxy]) if (typeof one === "string") pending.add(one);
    }
  } catch {
    if (fs.existsSync(join(home, "jobs.json"))) return null;
  }
  return pending;
}

/** Bytes under `path`, each file once however many hard links it has (a proxy and its preview are one file). */
function size(path: string, seen = new Set<string>()): number {
  try {
    const stat = fs.statSync(path);
    if (!stat.isDirectory()) {
      const inode = `${stat.dev}:${stat.ino}`;
      if (seen.has(inode)) return 0;
      seen.add(inode);
      return stat.size;
    }
    return fs.readdirSync(path).reduce((total, name) => total + size(join(path, name), seen), 0);
  } catch {
    return 0;
  }
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function age(path: string, now: number): number {
  try {
    return now - fs.statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Every saved project's media paths and their media keys (`mediaKey`), read
 * from the project files (not loaded as live projects: no memory kept, no
 * media work started). Null when a project file won't read: then nothing it
 * might use is known, so everything counts as used.
 */
function used(app: App, pending: Set<string> | null): Used | null {
  const paths = new Set<string>();
  // Files a project uses that aren't here: their key can't be known.
  let missing = 0;
  const keys = new Set<string>();
  // Each key's latest save of a project using it.
  const saved = new Map<string, number>();
  const projects = new Map<string, UsedProject>();
  const keyProjects = new Map<string, Set<string>>();
  const pathProjects = new Map<string, Set<string>>();
  const home = app.store.home;
  const goingUp = new Set(uploadsNow().flatMap((one) => [one.file, one.originalKey, ...(one.proxy === null ? [] : [one.proxy])]));
  const notUp = (one: unknown) => typeof one === "string" && (pending === null || pending.has(one) || goingUp.has(one) || uploadingNow(one));
  const dir = join(home, "projects");
  for (const name of safeList(dir).filter((name) => name.endsWith(".json"))) {
    let media: { path?: unknown; kind?: unknown; cloud?: { source?: unknown; original?: unknown; proxy?: unknown } | null }[] = [];
    let at = 0;
    try {
      at = fs.statSync(join(dir, name)).mtimeMs;
      const value = JSON.parse(fs.readFileSync(join(dir, name), "utf8")) as { media?: typeof media };
      media = Array.isArray(value.media) ? value.media : [];
    } catch (error) {
      diag.warn("cache", `${name} won't read, so nothing it might use is cleaned (${diag.messageOf(error)})`);
      return null;
    }
    const id = name.slice(0, -".json".length);
    const project: UsedProject = { saved: at, tokens: new Set(), blocks: new Set(), unconfirmed: false };
    projects.set(id, project);
    for (const item of media) {
      const cloudMedia = item.cloud;
      if (cloudMedia !== null && typeof cloudMedia === "object") {
        for (const key of [cloudMedia.original, cloudMedia.proxy]) {
          if (typeof key !== "string") continue;
          const token = ownerToken(key);
          if (token !== null) project.tokens.add(token);
          project.blocks.add(blockFolder(key));
        }
        if (typeof cloudMedia.source === "string") {
          const token = sourceToken(cloudMedia.source);
          if (token !== null) project.tokens.add(token);
        }
        // Not in R2 yet: its upload pending or under way (the only copy may be here).
        if (typeof cloudMedia.original !== "string" || notUp(cloudMedia.original) || notUp(cloudMedia.proxy) || notUp(item.path)) project.unconfirmed = true;
      } else if (typeof item.path === "string" && item.path.startsWith(`${home}/`) && fs.existsSync(item.path)) {
        // A file Edit made or keeps for it (a smoothed shot, a map, an upload) that hasn't gone up.
        project.unconfirmed = true;
      }
      if (typeof item.path !== "string") continue;
      paths.add(item.path);
      let users = pathProjects.get(item.path);
      if (users === undefined) pathProjects.set(item.path, users = new Set());
      users.add(id);
      // A missing file keys differently (no size or time): its folder would look unused.
      if (!fs.existsSync(item.path)) {
        if (typeof item.cloud?.proxy !== "string" || !cloud.validKey(item.cloud.proxy)) missing += 1;
        continue;
      }
      try {
        const key = app.native.mediaKey(item.path);
        keys.add(key);
        saved.set(key, Math.max(saved.get(key) ?? 0, at));
        let users = keyProjects.get(key);
        if (users === undefined) keyProjects.set(key, users = new Set());
        users.add(id);
      } catch {
        // A path the addon can't key: nothing of it is touched either way.
      }
    }
  }
  return { paths, keys, saved, missing, projects, keyProjects, pathProjects };
}

interface UsedProject {
  /** When its file was last written here. */
  saved: number;
  /** Its cloud footage's places in keys (`ownerToken`): `drive/<id>`, `sha256/<hex>`, `youtube/<id>`. */
  tokens: Set<string>;
  /** Its proxies' and originals' block folders (cloud_blocks.ts). */
  blocks: Set<string>;
  /** Something of it isn't in R2 yet (an upload pending or under way, a file Edit made that hasn't gone up): in work. */
  unconfirmed: boolean;
}

interface Used {
  paths: Set<string>;
  keys: Set<string>;
  saved: Map<string, number>;
  missing: number;
  projects: Map<string, UsedProject>;
  /** The projects using each media key. */
  keyProjects: Map<string, Set<string>>;
  /** The projects using each media path. */
  pathProjects: Map<string, Set<string>>;
}

/** Folders under `edit/` whose keys name a source's place next (`edit/<folder>/<place>…`); a sound copy's is its original's key again. */
const KEYED = ["originals/", "excerpts/", "proxies/", "sound/", "analysis/", "scrub/", "pieces/"];

/** The footage `key` (an R2 key, `edit/…`) is of, as `<kind>/<id>` (`drive/1AbC…`), or the project's for a playback render or an effect's (`playback:<project>`); null for anything else. */
export function ownerToken(key: string): string | null {
  let rest = key.startsWith("edit/") ? key.slice("edit/".length) : key;
  if (rest.startsWith("exports/playback/")) rest = rest.slice("exports/".length);
  // An effect's render (effect_cloud.ts) is its project's, as a playback render is.
  const render = /^exports\/([^/]+)\/effect-[^/]+$/.exec(rest);
  if (render !== null) return `playback:${render[1]}`;
  if (rest.startsWith("playback/")) {
    const project = rest.slice("playback/".length).split("/")[0];
    return project ? `playback:${project}` : null;
  }
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const folder of KEYED) {
      if (rest.startsWith(folder)) {
        rest = rest.slice(folder.length);
        stripped = true;
      }
    }
  }
  // A pieced proxy's layout version (proxy_pieces.ts `baseKey`).
  rest = rest.replace(/^v\d+\//, "");
  const match = /^(drive|youtube|sha256)\/([A-Za-z0-9_-]+)/.exec(rest);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** A registry source's place (`drive:<id>#<range>` → `drive/<id>`). */
function sourceToken(source: string): string | null {
  const match = /^(drive|youtube|sha256):([A-Za-z0-9_-]+)/.exec(source);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** A key's folder under `cloud/blocks` (cloud_blocks.ts names them so). */
function blockFolder(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

/** Where a project stands, for what of it is kept here (see the top). */
export type State = "work" | "idle" | "done";

export interface Standing {
  state: State;
  /** When it was last worked on here: the later of its last open in the editor and its last save. */
  last: number;
  /** Opened in the editor in the last minutes, or with work running: kept even with the disk all but full. */
  active: boolean;
}

/** Each project's state on this computer (see the top). */
function standings(app: App, inUse: Used, done: Set<string>, now: number): Map<string, Standing> {
  const opened = openedTimes(app.store.home);
  let archived: Record<string, unknown> = {};
  try {
    archived = JSON.parse(fs.readFileSync(join(app.store.home, "cloud", "archived.json"), "utf8")) as Record<string, unknown>;
  } catch {
    // None archived here.
  }
  const out = new Map<string, Standing>();
  const workingFor = busy.workingNow(app);
  for (const [id, project] of inUse.projects) {
    // Worked on: the later of its last open in the editor and its last save (an agent's turn saves it, with the editor
    // closed). By the open alone, a project opened in the morning and edited by the agent all afternoon lost its
    // footage copies by evening, and came down again when it was opened to be watched (JJ's Mac, Nov 10: 110 files).
    const last = Math.max(opened[id] ?? 0, project.saved);
    const working = workingFor(id);
    const active = working || now - (opened[id] ?? 0) < OPEN_NOW;
    // Marked done on Home (or archived) is let go once it's closed, though it was opened in the last days to look at;
    // open now, with work running or with something not up yet, it's in work whatever it's marked.
    const state: State = active || working || project.unconfirmed ? "work" : done.has(id) || archived[id] !== undefined || now - last >= LET_GO_MS ? "done" : now - last < IN_WORK_MS ? "work" : "idle";
    out.set(id, { state, last, active });
  }
  return out;
}

/** Whose each file is (`Entry.owners`), from the projects' media: its folder's project, its footage's place in keys, its block folder, its media key. */
function attribute(entries: Entry[], cache: string, home: string, inUse: Used): void {
  const cloudDir = `${join(cache, "cloud")}/`;
  const mediaDir = `${join(home, "media")}/`;
  const byToken = new Map<string, Set<string>>();
  const byBlock = new Map<string, Set<string>>();
  const put = (map: Map<string, Set<string>>, key: string, id: string) => {
    let ids = map.get(key);
    if (ids === undefined) map.set(key, ids = new Set());
    ids.add(id);
  };
  for (const [id, project] of inUse.projects) {
    for (const token of project.tokens) put(byToken, token, id);
    for (const folder of project.blocks) put(byBlock, folder, id);
    put(byToken, `playback:${id}`, id);
  }
  // Drive downloads by their path: what original each is (cloud_media `localOriginal`).
  const downloads = new Map<string, string>();
  for (const [key, entry] of Object.entries(readLocalOriginals(cache))) if (typeof entry.path === "string") downloads.set(entry.path, key);
  const blockTokens = new Map<string, string | null>();
  const blockToken = (folder: string): string | null => {
    if (!blockTokens.has(folder)) {
      let token: string | null = null;
      try {
        const meta = JSON.parse(fs.readFileSync(join(cloudDir, "blocks", folder, "meta.json"), "utf8")) as { key?: unknown };
        if (typeof meta.key === "string") token = ownerToken(meta.key);
      } catch {
        // A folder from before keys were kept: known by its name alone.
      }
      blockTokens.set(folder, token);
    }
    return blockTokens.get(folder) ?? null;
  };
  for (const entry of entries) {
    const owners = new Set<string>(entry.project === null ? [] : [entry.project]);
    const add = (ids: Set<string> | undefined) => {
      for (const id of ids ?? []) owners.add(id);
    };
    if (entry.path.startsWith(cloudDir)) {
      const relative = entry.path.slice(cloudDir.length);
      if (relative.startsWith("blocks/")) {
        const folder = relative.slice("blocks/".length).split("/")[0] ?? "";
        add(byBlock.get(folder));
        const token = blockToken(folder);
        if (token !== null) add(byToken.get(token));
      } else {
        const token = ownerToken(`edit/${relative}`);
        if (token !== null) add(byToken.get(token));
      }
    } else if (entry.path.startsWith(mediaDir)) {
      add(inUse.pathProjects.get(entry.path));
      const key = downloads.get(entry.path);
      const token = key === undefined ? null : ownerToken(key);
      if (token !== null) add(byToken.get(token));
    } else {
      const folder = /^([0-9a-f]{16})\//.exec(entry.path.slice(cache.length + 1))?.[1];
      if (folder !== undefined) add(inUse.keyProjects.get(folder));
    }
    entry.owners = [...owners];
  }
}

/** A project's files of one state, as one: what's evicted together (half a project is neither playable nor freed). */
interface Group {
  /** The project ("" for files no project here uses). */
  id: string;
  state: State | "nobody's";
  last: number;
  active: boolean;
  files: Entry[];
}

interface Survey {
  inUse: Used | null;
  groups: Group[];
}

/**
 * The files the cleaner may take by project state, grouped by project: each file with the project using it that
 * was worked on last (a file two projects use goes with the later one, and only once neither is in work), and
 * never one that's pinned, on its way up, written lately, half-written, a block folder's note, the export being made
 * ahead, a script's original, or not Edit's own copy.
 */
function survey(app: App, entries: Entry[], now: number, done: Set<string>, known?: Used | null): Survey {
  const cache = app.store.cacheDir();
  const home = app.store.home;
  const pending = pendingUploads(home);
  const inUse = known === undefined ? used(app, pending) : known;
  if (inUse === null) return { inUse, groups: [] };
  attribute(entries, cache, home, inUse);
  const standing = standings(app, inUse, done, now);
  let exporting = true;
  try {
    exporting = app.exports.running();
  } catch {
    // No exports here to ask (tests): kept as if one ran.
  }
  // Files from the last few hours stay (one may be uploading or playing), and while an export runs (it mixes from
  // the sound copies) the last two days'.
  const fresh = exporting ? RECENT : COPY_RECENT;
  const making = makingAhead(app);
  const ahead = making === null ? null : aheadFile(cache, making);
  const scripts = writerStore.originals(writerStore.dataDir(home));
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    if (!entry.evictable || ledgerOf.tierOf(entry.kind) === null) continue;
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    if (PARTIAL.test(name) || (name === "meta.json" && entry.path.includes("/cloud/blocks/"))) continue;
    if (now - entry.at < fresh || pinned(entry.path) || scripts.has(entry.path)) continue;
    if (ahead !== null && (entry.path === ahead || entry.path === `${ahead}.json`)) continue;
    if (pending === null || pending.has(entry.path) || uploadingNow(entry.path)) continue;
    let group: Group;
    if (entry.owners.length === 0) {
      group = groups.get("") ?? { id: "", state: "nobody's", last: Number.NEGATIVE_INFINITY, active: false, files: [] };
      groups.set("", group);
    } else {
      // A project deleted here (its folder's name is all that's left of it) is let go.
      const of = entry.owners.map((id) => ({ id, ...(standing.get(id) ?? { state: "done" as const, last: 0, active: false }) }));
      const state: State = of.some((one) => one.state === "work") ? "work" : of.every((one) => one.state === "done") ? "done" : "idle";
      const newest = of.reduce((a, b) => (b.last > a.last ? b : a));
      const key = `${state}\n${newest.id}`;
      group = groups.get(key) ?? { id: newest.id, state, last: newest.last, active: of.some((one) => one.active), files: [] };
      group.active ||= of.some((one) => one.active);
      groups.set(key, group);
    }
    group.files.push(entry);
  }
  return { inUse, groups: [...groups.values()] };
}

/** R2's own key for an original here: a cache copy's (`<cache>/cloud/<key less edit/>`), or a Drive download's (cloud_media `localOriginal`). */
function originalKeyOf(cache: string, path: string, downloads: Map<string, string>): string | null {
  const cloudDir = `${join(cache, "cloud")}/`;
  if (path.startsWith(`${cloudDir}originals/`)) return `edit/${path.slice(cloudDir.length)}`;
  return downloads.get(path) ?? null;
}

/** HEADs asked of R2 in one pass at most (the rest wait for the next). */
const CONFIRM_MOST = 200;

/**
 * The originals here of projects let go (done on Home, or idle a week) and of nobody's that R2 says it holds at their
 * very size: only these go (`Limits.confirmed`). Never a file from someone's disk (they're never Edit's to take).
 */
export async function confirmOriginals(
  app: App,
  entries: Entry[],
  done: Set<string>,
  now = Date.now(),
  head: (key: string) => Promise<{ size: number } | null> = (key) => cloud.head(key),
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  const cache = app.store.cacheDir();
  const downloads = new Map<string, string>();
  for (const [key, entry] of Object.entries(readLocalOriginals(cache))) if (typeof entry.path === "string") downloads.set(entry.path, key);
  const asks: [Entry, string][] = [];
  // Nobody's originals go only for room: asked about only while the disk is short of what Edit keeps free.
  const short = diskHooks.free(cache) < keepFreeBytes(cache);
  for (const group of survey(app, entries, now, done).groups) {
    if (group.state !== "done" && !(group.state === "nobody's" && short)) continue;
    for (const entry of group.files) {
      if (ledgerOf.tierOf(entry.kind) !== 2) continue;
      const key = originalKeyOf(cache, entry.path, downloads);
      if (key !== null && cloud.validKey(key)) asks.push([entry, key]);
    }
  }
  const slots = new Semaphore(3);
  await Promise.all(asks.slice(0, CONFIRM_MOST).map(([entry, key]) => slots.with(async () => {
    try {
      const there = await head(key);
      if (there !== null && there.size === entry.bytes && entry.bytes > 0) confirmed.add(entry.path);
    } catch {
      // Not known: it stays.
    }
  })));
  return confirmed;
}

/** Cleans the cache as the module notes say; with `dryRun`, only says what would go. */
export function cleanCache(
  app: App,
  dryRun: boolean,
  now = Date.now(),
  given?: Limits,
  done: Set<string> = new Set(),
): CleanReport {
  // A home that isn't one (EDIT_HOME="") cleans nothing: its cache would be "/cache".
  if (app.store.home.trim() === "" || app.store.home === "/") return { folders: 0, files: 0, bytes: 0, removed: [] };
  const cache = app.store.cacheDir();
  // The cache and the media are walked once a pass (the ledger's, off the thread, when the server's pass asks), and
  // what's taken off is counted from it (Astra's audit, Nov 18: four walks a pass on the server's thread).
  const entries = given?.entries ?? ledgerOf.walkSync(ledgerOf.rootsOf(app.store.home, cache));
  const limits: Limits = given ?? { freeBytes: keepFreeBytes(cache) };
  const confirmed = limits.confirmed ?? new Set<string>();
  const report: CleanReport = { folders: 0, files: 0, bytes: 0, removed: [] };
  const gone = new Set<string>();
  const seen = new Set<string>();
  const remove = (path: string) => {
    // An export reading it, or about to (its footage, an effect's render, the export made ahead it copies its chunks
    // from: file_pins.ts): left for the next pass.
    if (pinned(path) || gone.has(path)) return;
    // Gone since the ledger counted it (another pass, the export that made it): nothing to take.
    if (!fs.existsSync(path)) {
      if (!dryRun) ledger.forget(path);
      return;
    }
    const bytes = size(path, seen);
    if (!dryRun) {
      try {
        fs.rmSync(path, { recursive: true, force: true });
      } catch (error) {
        diag.warn("cache", `couldn't remove ${path}: ${diag.messageOf(error)}`);
        return;
      }
      ledger.forget(path);
      // A copy Edit.app's window reads: its page asks where to read from again (native_preview.ts).
      nativeEvicted(app, path);
    }
    gone.add(path);
    report.files += 1;
    report.bytes += bytes;
    if (report.removed.length < 50) report.removed.push(path);
  };
  let names: string[];
  try {
    names = fs.readdirSync(cache);
  } catch {
    return report;
  }
  const inUse = used(app, pendingUploads(app.store.home));
  // The window's copies of a long video's pieces cut the old way (native_preview.ts `oldCuts`: every frame from the
  // video's start, up to 955 MB a minute, never read since Nov 18), whatever their age: cut again small if wanted.
  for (const path of oldCuts(cache)) {
    // A folder goes once its files have (one pinned stays, and so does its folder).
    if (safeList(path).length > 0) continue;
    remove(path);
  }
  // Footage Edit downloaded from Drive (drive_import.ts) whose original is in
  // the cloud: the copy only speeds exports up, so it goes once unused a while.
  const known = readLocalOriginals(cache);
  let dropped = false;
  // Only Edit's own Drive downloads (<media root>/media/[<project>/]drive/<file id>/<file>),
  // never a file of the user's whose path happens to say "drive" or "uploads".
  const roots = new Set<string>([join(app.store.home, "media")]);
  for (const [key, entry] of Object.entries(known)) {
    const root = [...roots].find((one) => entry.path.startsWith(`${one}/`));
    if (root === undefined || !/^(?:[A-Za-z0-9_-]+\/)?drive\/[A-Za-z0-9_-]{10,}\/[^/]+$/.test(entry.path.slice(root.length + 1))) continue;
    // Not while its upload to the cloud is still going.
    if (uploadingNow(entry.path)) continue;
    if (inUse === null || inUse.paths.has(entry.path) || now - (entry.used_ms ?? entry.mtime_ms) < DOWNLOADED) continue;
    remove(entry.path);
    if (!dryRun) {
      delete known[key];
      dropped = true;
    }
  }
  if (dropped) writeLocalOriginals(cache, known);
  // What Edit made or fetched that no project uses any more (Oct 29, the user:
  // "things shouldn't take up storage on the local devices… everything on the
  // cloud!"): smoothed shots a project moved to the cloud or made again
  // (404 of them, 2.85 GB on this Mac), YouTube videos downloaded for a script
  // (the registry has the original), and the team library's sounds (Drive has
  // them; a cloud project's sound is its cloud copy). Each comes back when
  // it's asked for again.
  if (inUse !== null) {
    // A script's original can be one of these when it couldn't be hard-linked (another disk).
    const scripts = writerStore.originals(writerStore.dataDir(app.store.home));
    const generated = (relative: string) => /(?:^|\/)smooth\/[^/]+$/.test(relative) || /^(?:[A-Za-z0-9_-]+\/)?drive\/youtube\/[A-Za-z0-9_-]{6,}\/[^/]+$/.test(relative);
    const places: [string, (relative: string) => boolean][] = [...[...roots].map((root): [string, (relative: string) => boolean] => [root, generated]), [join(app.store.home, "library"), () => true]];
    for (const [root, wanted] of places) {
      const stack = [root];
      for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
        for (const name of safeList(at)) {
          const path = join(at, name);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(path);
          } catch {
            continue;
          }
          if (stat.isDirectory()) stack.push(path);
          else if (wanted(path.slice(root.length + 1)) && !inUse.paths.has(path) && !scripts.has(path) && !uploadingNow(path) && now - stat.mtimeMs >= (PARTIAL.test(name) ? DAY : RECENT)) remove(path);
        }
      }
    }
  }
  // Chunks an export left when it stopped part-way (the engine's chunks.rs):
  // a run again soon carries on from them; after a few days they go.
  const chunksDir = join(cache, "export-chunks");
  for (const project of safeList(chunksDir)) {
    for (const entry of safeList(join(chunksDir, project))) {
      if (!entry.endsWith(".mp4")) continue;
      const path = join(chunksDir, project, entry);
      if (age(path, now) >= DOWNLOADED) remove(path);
    }
    // Its sound kept a minute at a time (smooth playback's, the engine's mix.rs render_kept), the same way.
    for (const entry of safeList(join(chunksDir, project, "sound"))) {
      const path = join(chunksDir, project, "sound", entry);
      if (age(path, now) >= DOWNLOADED) remove(path);
    }
    // A share's review pieces of its chunks (reviews.ts `reviewCopyFromChunks`, 1.1-1.5 GB a project on mandalorian,
    // never taken before Nov 18): the next share's copy is made from them, so they go a few days after.
    for (const entry of safeList(join(chunksDir, project, "review"))) {
      const path = join(chunksDir, project, "review", entry);
      if (age(path, now) >= DOWNLOADED) remove(path);
    }
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}$/.test(name)) continue;
    const dir = join(cache, name);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    // With a used file missing, no folder can be known unused (its key is unknown).
    const unused = inUse !== null && inUse.missing === 0 && !inUse.keys.has(name);
    let touched = false;
    for (const entry of entries) {
      const path = join(dir, entry);
      if (age(path, now) < (PARTIAL.test(entry) ? DAY : RECENT)) continue;
      if (PARTIAL.test(entry) || (unused && REBUILT.test(entry))) {
        remove(path);
        touched = true;
      }
    }
    if (touched) report.folders += 1;
  }
  // A review copy is removed once its share is published; one a share that
  // failed left (Oct 29: a 669 MB one, two days old) goes after a few days.
  const reviewsDir = join(cache, "reviews");
  for (const project of safeList(reviewsDir)) {
    for (const entry of safeList(join(reviewsDir, project))) {
      if (!entry.endsWith(".mp4")) continue;
      const path = join(reviewsDir, project, entry);
      if (age(path, now) >= DOWNLOADED) remove(path);
    }
  }
  // Research images no project links any more (research.ts's pool).
  const pooled = research.prunePool(app.store.home, dryRun);
  if (pooled > 0) {
    report.bytes += pooled;
    report.files += 1;
    if (report.removed.length < 50) report.removed.push(research.poolDir(app.store.home));
  }
  // By project state (see the top).
  if (inUse !== null) {
    const { groups } = survey(app, entries, now, done, inUse);
    const take = (entry: Entry) => {
      const before = report.files;
      remove(entry.path);
      // A legacy preview of local footage: the media's own note of it goes too (made again when it's opened).
      const folder = /^([0-9a-f]{16})\/preview/.exec(entry.path.slice(cache.length + 1))?.[1];
      if (folder !== undefined && report.files > before && !dryRun) app.media.forgetKey(folder);
    };
    const tierOf = (entry: Entry) => ledgerOf.tierOf(entry.kind);
    // Let go (done on Home, or idle a week, or deleted): all of its copies at each pass, its originals once R2 has them.
    for (const group of groups.filter((one) => one.state === "done")) {
      for (const entry of group.files) if (tierOf(entry) !== 2 || confirmed.has(entry.path)) take(entry);
    }
    const free = () => (limits.free !== undefined ? limits.free + report.bytes : diskHooks.free(cache) + (dryRun ? report.bytes : 0));
    const short = () => limits.freeBytes - free();
    // Short of what's to be kept free: nobody's copies, the oldest first; then the projects not in work, whole, the
    // one worked on longest ago first, each its derived copies and then its proxies.
    if (short() > 0) {
      const nobody = groups.find((one) => one.state === "nobody's");
      for (const entry of [...(nobody?.files ?? [])].sort((a, b) => a.at - b.at)) {
        if (short() <= 0) break;
        if (tierOf(entry) !== 2 || confirmed.has(entry.path)) take(entry);
      }
    }
    const wholeTier = (group: Group, tier: 0 | 1) => {
      for (const entry of group.files) if (tierOf(entry) === tier) take(entry);
    };
    for (const group of groups.filter((one) => one.state === "idle").sort((a, b) => a.last - b.last)) {
      if (short() <= 0) break;
      wholeTier(group, 0);
      if (short() <= 0) break;
      wholeTier(group, 1);
    }
    // Under the cache's hard floor with nothing else left: projects in work give their copies up too, the oldest
    // first, but never one open in the last minutes or with work running.
    if (short() > 0 && free() < CACHE_FLOOR_BYTES) {
      for (const group of groups.filter((one) => one.state === "work" && !one.active).sort((a, b) => a.last - b.last)) {
        if (short() <= 0 || free() >= CACHE_FLOOR_BYTES) break;
        wholeTier(group, 0);
        if (short() <= 0 || free() >= CACHE_FLOOR_BYTES) break;
        wholeTier(group, 1);
      }
    }
  }
  // A Drive download taken: no longer noted as its original's copy here (cloud_media `localOriginal`).
  if (!dryRun && gone.size > 0) {
    const known = readLocalOriginals(cache);
    const left = Object.fromEntries(Object.entries(known).filter(([, entry]) => !gone.has(entry.path)));
    if (Object.keys(left).length < Object.keys(known).length) writeLocalOriginals(cache, left);
  }
  if (!dryRun) {
    // What's left, for the ledger: neither a file taken nor one in a folder taken.
    const taken = (path: string) => {
      for (let at = path; at.length > cache.length; at = at.slice(0, at.lastIndexOf("/"))) if (gone.has(at)) return true;
      return gone.has(path);
    };
    ledger.replace(entries.filter((entry) => !taken(entry.path)), now);
  }
  // Project history is metadata, but unbounded it fills a disk alone: past
  // HISTORY_BYTES, the oldest saves go, across every project's
  // (`projects/history/<id>/<ms>.json`), each project keeping its newest few
  // (a reset's "edit before" among them). It took whole projects' folders
  // until Nov 16, all 30 saves of one at a time, past a fixed 100 MB.
  {
    const history = join(app.store.home, "projects", "history");
    let over = size(history) - HISTORY_BYTES;
    if (over > 0) {
      const saves: { path: string; at: number }[] = [];
      for (const id of safeList(history)) {
        const dir = join(history, id);
        const own = safeList(dir)
          .filter((name) => /^\d+\.json$/.test(name))
          .map((name) => {
            const path = join(dir, name);
            try {
              return { path, at: fs.statSync(path).mtimeMs };
            } catch {
              return null;
            }
          })
          .filter((one): one is { path: string; at: number } => one !== null)
          .sort((a, b) => b.at - a.at);
        saves.push(...own.slice(HISTORY_KEPT_EACH));
      }
      saves.sort((a, b) => a.at - b.at);
      for (const save of saves) {
        if (over <= 0) break;
        const before = report.bytes;
        remove(save.path);
        over -= report.bytes - before;
      }
    }
  }
  return report;
}

/** The saves of each project's history the cleaner never takes: the newest, the one before it and the one before that. */
const HISTORY_KEPT_EACH = 3;

/** How much project history may take before its oldest saves go (it was a quarter of the cache's budget until Nov 18). */
export const HISTORY_BYTES = 1_000_000_000;

/** The project whose export is being made ahead now (exports.ts `aheadFor`); none where there are no exports (tests). */
function makingAhead(app: App): string | null {
  try {
    return (app.exports as { aheadFor?: () => string | null }).aheadFor?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Older exports of each project that are no longer wanted (export_retention.ts):
 * with `dryRun` only logged ("would delete …").
 */
export function cleanExports(app: App, dryRun: boolean, now = Date.now()): { files: number; bytes: number; decisions: retention.Decision[] } {
  const home = app.store.home;
  let records: Record<string, retention.Kept[]> = {};
  try {
    records = JSON.parse(fs.readFileSync(join(home, "exports.json"), "utf8")) as Record<string, retention.Kept[]>;
  } catch {
    return { files: 0, bytes: 0, decisions: [] };
  }
  const roots = new Set(exportRoots(home));
  const shared = reviews.read(home).shared;
  const free = diskHooks.free(app.store.cacheDir());
  const decisions = retention.decide(records, {
    now,
    roots: [...roots],
    reviewed: (id, path) => shared[id]?.versions.find((version) => version.path === path)?.n ?? null,
    onDrive: (id) => app.store.get(id)?.project.drive?.uploaded_ms ?? null,
    busy: (id, path) => {
      let exporting = false;
      try {
        exporting = app.exports.runningFor?.(id)?.output === path;
      } catch {
        // No exports here (tests).
      }
      return exporting || beingRead(path) || reviews.sharingNow(id) || drive.uploading(id);
    },
    short: Number.isFinite(free) ? FREE_FLOOR_BYTES - free : 0,
  });
  return { ...retention.apply(home, decisions, dryRun), decisions };
}

/** The edits marked done on Home at the last pass (later.ts): room-making between passes knows them too. */
let doneLately = new Set<string>();

/**
 * Room for work that needs `wanted` bytes free on the cache's disk and hasn't
 * them (an import or an export about to be refused: storage.ts `admit`; a
 * whole copy or an effect's render with no room: `askForRoom`): what the
 * pass would take for it (see the top), from the ledger, with no walk of the
 * disk: nobody's copies, then projects not in work, whole and oldest first,
 * and only with the disk under its hard floor a project in work that isn't
 * open now. What was freed (bytes).
 */
export function makeRoom(app: App, wanted: number): number {
  const cache = app.store.cacheDir();
  const entries = ledger.covers(cache) ? ledger.all() : undefined;
  const report = cleanCache(app, false, Date.now(), { freeBytes: wanted, ...(entries === undefined ? {} : { entries }) }, doneLately);
  if (report.bytes > 0) diag.info("cache", `freed ${(report.bytes / 1e9).toFixed(2)} GB for work that needs ${(wanted / 1e9).toFixed(1)} GB free`);
  return report.bytes;
}

/** The edits marked done on Home (none when Later can't be reached: ordered by when they were worked on alone). */
async function doneOnHome(): Promise<Set<string>> {
  const done = new Set<string>();
  try {
    for (const entry of await later.list()) if (entry.done === true && entry.key.startsWith("edit:")) done.add(entry.key.slice("edit:".length));
  } catch {
    // Later unreachable.
  }
  return done;
}

/**
 * One pass, as the server runs it: the ledger built again off the thread, the originals of projects let go asked of
 * R2, then the cache cleaned to keep what Edit keeps free (`head`: tests stand in for R2).
 */
export async function cleanPass(app: App, now = Date.now(), head?: (key: string) => Promise<{ size: number } | null>): Promise<CleanReport> {
  const cache = app.store.cacheDir();
  const previews = await cleanCloudPreviews(app, false, head);
  const done = await doneOnHome();
  doneLately = done;
  ledger.useRoots(ledgerOf.rootsOf(app.store.home, cache));
  const entries = await ledger.rebuild();
  const confirmed = await confirmOriginals(app, entries, done, now, head);
  const report = cleanCache(app, false, now, { freeBytes: keepFreeBytes(cache), entries, confirmed }, done);
  const old = cleanExports(app, false, now);
  report.bytes += old.bytes + previews.bytes;
  report.files += old.files + previews.files;
  return report;
}

/** Cleans now and then: a few minutes after the start, then hourly (a day of imports and exports filled the disk). */
export function startCleaning(app: App): () => void {
  // Work with no room asks the cleaner for it (storage.ts `askForRoom`, `admit`).
  diskHooks.makeRoom = (wanted) => makeRoom(app, wanted);
  ledger.useRoots(ledgerOf.rootsOf(app.store.home, app.store.cacheDir()));
  let running = false;
  const run = async (clean: boolean) => {
    if (running) return;
    // A cache on a drive macOS hasn't answered about yet (plugged in after the start): asked off the event loop, cleaned next time.
    const open = folderAccess.unanswered([app.store.cacheDir()]);
    if (open.length > 0) {
      void folderAccess.reachRoots(open);
      return;
    }
    running = true;
    try {
      if (!clean) {
        // The first count, soon after the start: room-making has it before the first pass.
        await ledger.rebuild();
        diag.info("cache", `this computer holds ${ledger.summary()} of Edit's`);
        return;
      }
      const report = await cleanPass(app);
      if (report.files > 0) diag.info("cache", `freed ${(report.bytes / 1e9).toFixed(2)} GB: ${report.files} files (no project uses them, half-written, of projects let go, or of projects not in work to keep ${(keepFreeBytes(app.store.cacheDir()) / 1e9).toFixed(0)} GB free)`);
      diag.info("cache", `this computer holds ${ledger.summary()} of Edit's`);
    } catch (error) {
      diag.warn("cache", `cleaning the cache: ${diag.messageOf(error)}`);
    } finally { running = false; }
  };
  const count = setTimeout(() => void run(false), 30 * 1000);
  const first = setTimeout(() => void run(true), 10 * 60 * 1000);
  const hourly = setInterval(() => void run(true), 3600 * 1000);
  return () => {
    clearTimeout(count);
    clearTimeout(first);
    clearInterval(hourly);
  };
}
