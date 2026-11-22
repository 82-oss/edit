// What Edit.app's native preview decodes each picture from (its window draws
// the viewer's picture with the engine: crates/edit-window/src/preview.rs).
// The engine reads files on this Mac
// with the video decoder and anything else with FFmpeg, which opens a stream
// again on every jump: a cloud preview streamed took 3–8.6 s a frame to scrub
// to (the 16-Year-Old, Nov 6), and 0.5–1.7 s on Cops Realize (Nov 8). So:
//
// - Every cloud preview that's one file comes down whole, four at a time,
//   into the copy Edit already serves from (`cloud_media.localPath`): a made
//   proxy (`edit/proxies/…`), and footage that's its own proxy (an original
//   of 256 MB or less, `cloud_media.OWN_FILE_MAX`: maps, interview cuts,
//   pictures). Until Nov 8 only made proxies did, so 147 of Cops Realize's
//   242 pictures streamed for good. They come down in playhead order (the
//   media the timeline plays first, first), and they're the one footage form
//   the window reads: asking here marks the project as the window's
//   (player.ts), so the page player's block prefetch, scrub pieces and
//   smooth-playback render stay off for it on this Mac (audit, Nov 8: the
//   same proxy bytes were kept in four forms).
// - A pieced proxy (proxy_pieces.ts, a video of 20 minutes or more) is no
//   file to fetch: its pieces come down or are made behind the viewer
//   (`cloud_media.fillPieces`, started here), and each piece here that the
//   timeline plays is cut into a file of its own (its picture copied, time 0
//   the piece's start) that the window reads instead of the stream where it
//   reaches (the engine's excerpts, crates/edit-engine/src/excerpts.rs).
//
// Playing, the window mixes the edit's sound itself (crates/edit-engine/src/player.rs),
// so each heard media's sound file is named too: a made preview's sound
// (`preview.m4a`), a cloud preview's whole copy here (its sound is in it; a
// sound file's own copy, fetched whole like a picture's), else the footage or
// the loopback stream, which FFmpeg reads.
//
// Until then a picture is the server's loopback stream: a jump to one moves
// its whole copy to the front (`local_previews.hurry`), and as each lands the
// page hears it and asks again, as it does when a piece it plays is cut (it also asks every 15 s while one the timeline
// plays is, or a piece it plays isn't cut yet: `coming`; never for media it doesn't play, or a pieced proxy, which stay
// streamed). And when the cache's cleaner takes a copy handed
// out here (cache_cleanup.ts), the project's pages hear it (`native-sources`)
// and ask again, rather than a jump failing on the missing file.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloudMedia from "./cloud_media.ts";
import { PLAYBACK_ROUTE } from "./cloud_playback.ts";
import * as diag from "./diag.ts";
import { TO_THE_END } from "./export_excerpts.ts";
import { json } from "./http/errors.ts";
import { pinned } from "./file_pins.ts";
import { fetchWhole, onLanded, previewBytes } from "./local_previews.ts";
import type { Project } from "./model.ts";
import { isFile } from "./paths.ts";
import * as player from "./player.ts";
import { playedStretches } from "./project.ts";
import * as localFirst from "./local_first.ts";
import * as pieces from "./proxy_pieces.ts";
import * as storage from "./storage.ts";
import * as tools from "./tools.ts";

/** Seconds `from..to` of a streamed source in a file here: the window reads it instead of the stream. */
export interface NativeExcerpt {
  from: number;
  to: number;
  path: string;
}

/** The local files each project's window was last told to read (`evicted` looks here). */
const handed = new Map<string, Set<string>>();

/**
 * The cloud previews each project's window was last told to stream, while
 * their whole copies come down. As one lands its pages hear it
 * (`native-sources`, at most once in `LANDED_GAP_MS`) and ask again, so the
 * window reads it from here from then on: they asked every 15 s, and a cold
 * Cops Realize streamed jumps to files already here for up to that long.
 */
const streaming = new Map<string, Set<string>>();
const LANDED_GAP_MS = 300;
const telling = new Map<string, ReturnType<typeof setTimeout>>();
let landedApp: App | null = null;
onLanded((key) => {
  for (const [id, keys] of streaming) if (keys.delete(key)) tell(id);
});
// A local-first working copy made here replaced its stand-in: each window handed the original reads the copy instead.
localFirst.hooks.landed = (_cache, original) => {
  if (landedApp !== null) evicted(landedApp, original);
};

/** Project `id`'s pages hear that something the window reads landed (`native-sources`), at most once in `LANDED_GAP_MS`. */
function tell(id: string): void {
  const app = landedApp;
  if (app === null || telling.has(id)) return;
  telling.set(
    id,
    setTimeout(() => {
      telling.delete(id);
      app.store.emit({ type: "native-sources", id });
    }, LANDED_GAP_MS),
  );
}

type Cut = { context: pieces.Context; base: string; n: number; out: string; headBytes: number };

/**
 * The pieces each window plays and has no copy of yet, by the copy's path, with the projects asking: one is cut the
 * moment its picture lands (`pieces.onPicture`), and those projects' pages hear it once it's cut, so the window reads
 * it from then on. Until Nov 18 a piece landing waited for the page's next ask to be cut, and the cut for the one
 * after that to be read (every 15 s each), so a minute about to play could still be the stream.
 */
const awaited = new Map<string, { cut: Cut; projects: Set<string> }>();
pieces.onPicture((base, n) => {
  for (const { cut } of awaited.values()) if (cut.base === base && cut.n === n) queueCut(cut);
});

function queueCut(cut: Cut): void {
  if (!cutting.has(cut.out) && !cutsWaiting.some((one) => one.out === cut.out)) cutsWaiting.push(cut);
  cutNext();
}

/** Piece copy `out` is cut: the projects waiting on it are told. */
function cutLanded(out: string): void {
  const waiting = awaited.get(out);
  awaited.delete(out);
  for (const id of waiting?.projects ?? []) tell(id);
}

/** Piece cuts at once, and the ones waiting or failed lately (tried again after `RETRY_MS`). */
const CUTS_AT_ONCE = 2;
const RETRY_MS = 10 * 60_000;
const cutsWaiting: Cut[] = [];
const cutting = new Set<string>();
const cutFailed = new Map<string, number>();
/** Cuts left to the stream for want of room (said once each), looked at again at the page's next ask. */
const cutShort = new Set<string>();

/**
 * The folder of a pieced proxy's cut pieces, by the way they're cut. `native/` holds the cuts made until Nov 18
 * from the loopback stream (every frame from the video's start: 955 MB for a minute), so a cut there is never read
 * again, only taken away (`oldCuts`); `native2/` holds the cuts from this Mac's own files of the piece.
 */
const CUTS = "native2";
const OLD_CUTS = ["native"];

/** Where piece `n` of pieced proxy `base` is cut to, in this cache. */
export function cutPath(cache: string, base: string, n: number): string {
  return cloudMedia.localPath(cache, `${base}/${CUTS}/${n}.mp4`);
}

/** A pieced proxy's folder of cuts made the old way, under `<cache>/cloud/` (`pieces/[v3/]<scheme>/<id>/native`). */
const OLD_CUTS_FOLDER = new RegExp(`^pieces/(?:v\\d+/)?(?:drive|youtube|sha256)/[A-Za-z0-9._-]+/(?:${OLD_CUTS.join("|")})$`);

/** Whether a window was told to read `path` (or something in it) since this server started. */
function inHand(path: string): boolean {
  for (const files of handed.values()) for (const file of files) if (file === path || file.startsWith(`${path}/`)) return true;
  return false;
}

/**
 * Every piece cut the old way in `cache` (nothing reads them: `CUTS`), each folder's files and then the folder, but
 * a folder a window was told to read, for the cache's cleaner to take one by one (cache_cleanup.ts, which leaves a
 * pinned one). Only those: never a piece's head, picture, sound or join beside them, nor anything else of the
 * pieced proxy.
 */
export function oldCuts(cache: string): string[] {
  const root = cloudMedia.localPath(cache, "edit/pieces");
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = `${dir}/${name}`;
      const relative = `pieces/${path.slice(root.length + 1)}`;
      if (OLD_CUTS_FOLDER.test(relative)) {
        if (!inHand(path)) found.push(...safeList(path).map((file) => `${path}/${file}`), path);
        continue;
      }
      // pieces/<v3>/<scheme>/<id>/native: four folders down at most.
      if (depth < 3) {
        try {
          if (fs.statSync(path).isDirectory()) walk(path, depth + 1);
        } catch {
          // Gone.
        }
      }
    }
  };
  walk(root, 0);
  return found;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Takes away pieced proxy `base`'s old cuts in `cache` as its pieces are asked for, the cleaner taking every other one. */
function reclaimOldCuts(cache: string, base: string): void {
  for (const name of OLD_CUTS) {
    const dir = cloudMedia.localPath(cache, `${base}/${name}`);
    if (inHand(dir)) continue;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let freed = 0;
    for (const file of fs.readdirSync(dir)) {
      if (pinned(`${dir}/${file}`)) continue;
      try {
        freed += fs.statSync(`${dir}/${file}`).size;
        fs.rmSync(`${dir}/${file}`, { recursive: true, force: true });
      } catch {
        // Gone, or taken next time.
      }
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty yet: the rest next time.
    }
    if (freed > 0) diag.info("preview", `${base}: the window's old piece copies taken away (${(freed / 1e9).toFixed(2)} GB)`);
  }
}

/**
 * What a cut of a piece writes: the piece's picture fragment and a head, and the pieced proxy's head as well when
 * it's not here yet (`pictureFiles` fetches it first). Unknown (its fragment unreadable): null, and nothing is cut.
 */
function cutBytes(context: pieces.Context, base: string, n: number, headBytes: number): number | null {
  try {
    const video = fs.statSync(context.local(`${base}/video/${n}.m4s`)).size;
    return video + headBytes + (isFile(context.local(`${base}/head.mp4`)) ? 0 : headBytes);
  } catch {
    return null;
  }
}

/**
 * Cuts piece `n` into `out`, whole or not at all: into a file beside it, moved
 * into place once FFmpeg is done, so a cut Edit quits during never leaves half
 * a piece the window would read. The pieces' folder is made here: nothing
 * else makes it, and until Nov 10 nothing did, so no piece was ever cut (JJ's
 * Mac, 104 times in six hours: "Error opening output files: No such file or
 * directory") and a long video's picture came through the stream for good.
 *
 * Its picture is copied from this Mac's own files of the piece (the head and
 * its fragment), its first frame at time 0. Until Nov 18 it was cut from the
 * loopback stream with -ss/-t, which FFmpeg can't seek, so it copied every
 * frame from the video's start: on Sphe's M4 piece 36 of a 40-minute video
 * held 53,244 frames (955 MB for a minute), and the window's copies filled
 * the disk three times in a night (12.5 GB, then 16 GB in a quarter of an hour).
 */
async function cutWhole(head: string, video: string, out: string): Promise<void> {
  const part = out.replace(/\.mp4$/, ".part.mp4");
  try {
    fs.mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
    await tools.run(
      [tools.ffmpeg(), "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,concat", "-i", `concat:${head}|${video}`, "-map", "0:v:0", "-c:v", "copy", "-an", "-sn", "-dn", part],
      { timeoutMs: 5 * 60_000 },
    );
    fs.renameSync(part, out);
  } finally {
    fs.rmSync(part, { force: true });
  }
}

/** Seams for tests. */
export const hooks = { cut: cutWhole };

/**
 * Starts the cuts waiting, two at a time, each only with room for it: a cut is a copy kept only to play sooner, so
 * it claims what it writes (storage.ts) and starts only while the disk keeps its floor beside every other write under
 * way (storage.ts `footageFloor`: an open project's footage down to the work's floor, else the cache's), its claim let
 * go however it ends. With no room, or the disk's free space
 * not measurable, the piece streams on and is looked at again at the page's next ask; the cleaner is asked for room.
 * Until Nov 18 cuts claimed nothing, and two of 955 MB could start together on a nearly full disk.
 */
function cutNext(): void {
  let wanted = 0;
  let dir = "";
  while (cutting.size < CUTS_AT_ONCE) {
    const next = cutsWaiting.shift();
    if (next === undefined) break;
    if (cutting.has(next.out) || isFile(next.out)) continue;
    const need = cutBytes(next.context, next.base, next.n, next.headBytes);
    if (need === null) continue;
    dir = next.out.slice(0, next.out.lastIndexOf("/"));
    const free = storage.freeBytes(dir);
    const room = Number.isFinite(free) ? storage.spare(dir, need, storage.footageFloor(dir, next.base)) : -1;
    if (room < 0) {
      if (!cutShort.has(next.out)) {
        cutShort.add(next.out);
        diag.info("preview", `a piece for the window (${next.out}) streams on, ${Number.isFinite(free) ? `the disk too full to keep a copy (${(free / 1e9).toFixed(2)} GB free, ${(storage.claimedBytes() / 1e9).toFixed(2)} GB still coming)` : "the disk's free space unknown"}`);
      }
      if (Number.isFinite(free)) wanted = Math.max(wanted, -room);
      continue;
    }
    cutShort.delete(next.out);
    cutting.add(next.out);
    const claim = storage.claim(need);
    void pieces
      .pictureFiles(next.context, next.base, next.n)
      .then(({ head, video }) => hooks.cut(head, video, next.out))
      .then(() => cutLanded(next.out))
      .catch((error: unknown) => {
        awaited.delete(next.out);
        cutFailed.set(next.out, Date.now());
        diag.warn("preview", `a piece for the window (${next.out}) wasn't cut: ${diag.messageOf(error)}`);
      })
      .finally(() => {
        claim.release();
        cutting.delete(next.out);
        cutNext();
      });
  }
  // The cleaner asked for the room (a few minutes apart at most, never what an open project plays).
  if (wanted > 0) {
    setTimeout(() => {
      storage.askForRoom(storage.freeBytes(dir) + wanted);
    }, 0).unref?.();
  }
}

/**
 * The pieces of pieced proxy `base` on this Mac as files the window reads
 * (cut from `url`, the loopback stream, which answers them from the pieces
 * here); of those the timeline plays (`played`: stretches of the video, in
 * seconds), the ones here but not cut yet are cut behind this, in its order.
 * Only those: a cut piece is a second copy of its minute of the preview (a
 * two-hour interview's, 3.6 GB), and an edit plays a part of it.
 */
async function pieceExcerpts(id: string, cache: string, base: string, played: [number, number][]): Promise<{ here: NativeExcerpt[]; coming: boolean }> {
  const context = cloudMedia.piecesHere(cache);
  let layout: pieces.Layout;
  try {
    layout = await pieces.layoutOf(context, base);
  } catch {
    return { here: [], coming: false };
  }
  const wanted: number[] = [];
  for (const [from, to] of played) {
    for (let n = pieces.pieceAt(layout, from); n <= pieces.pieceAt(layout, to); n++) if (!wanted.includes(n)) wanted.push(n);
  }
  // The cuts made the old way are never read, and go as soon as their pieces are asked for.
  reclaimOldCuts(cache, base);
  const out: NativeExcerpt[] = [];
  const file = (n: number) => cutPath(cache, base, n);
  const span = (n: number): [number, number] => {
    const [first, end] = pieces.framesOf(layout, n);
    return [first / layout.fps, end / layout.fps];
  };
  // Every piece cut already is read from its file, played now or not.
  for (let n = 0; n < layout.pieces; n++) {
    if (!isFile(file(n))) continue;
    const [from, to] = span(n);
    out.push({ from, to: n === layout.pieces - 1 ? TO_THE_END : to, path: file(n) });
  }
  // A piece played and not cut yet is coming (made or brought here by `fillPieces`, then cut), unless its cut failed lately.
  let coming = false;
  for (const n of wanted) {
    const path = file(n);
    if (isFile(path) || Date.now() - (cutFailed.get(path) ?? 0) < RETRY_MS) continue;
    coming = true;
    const cut: Cut = { context, base, n, out: path, headBytes: layout.head };
    const waiting = awaited.get(path) ?? { cut, projects: new Set<string>() };
    waiting.projects.add(id);
    awaited.set(path, waiting);
    if (!pieces.pictureHere(context, base, n) || cutting.has(path) || cutsWaiting.some((one) => one.out === path)) continue;
    cutsWaiting.push(cut);
  }
  cutNext();
  return { here: out, coming };
}

/**
 * A streamed media's sound on this Mac: its original here (`localOriginal`, the file it was imported from, or one an
 * export fetched), else the original's sound copy an export or smooth playback fetched (`soundKey`). Both are on the
 * original's clock, as the proxy is. A long video's pieced proxy has no file, so its sound was always read through
 * the loopback stream, opened again at each play and jump, with the original on the Mac (Nov 21: 20 minutes of sound
 * read over HTTP for four).
 */
function soundHere(cache: string, original: string | undefined): string | null {
  if (original === undefined || original === "") return null;
  const here = cloudMedia.localOriginal(cache, original);
  if (here !== null) return here;
  const copy = cloudMedia.localPath(cache, cloudMedia.soundKey(original));
  return isFile(copy) ? copy : null;
}

/**
 * Each picture media's file for the native preview: its made preview, else
 * its footage; a cloud one's whole preview here, else its footage when that's
 * here, else this server's loopback stream of the preview (and the whole file
 * fetched behind it, or a pieced one's pieces here as excerpts). With the
 * media cache, where waveforms' levels are.
 */
export async function nativeSources(app: App, project: Project): Promise<Response> {
  const cache = app.store.cacheDir();
  const sources: Record<string, string> = {};
  const sounds: Record<string, string> = {};
  const excerpts: Record<string, NativeExcerpt[]> = {};
  // What each media named here is in the edit these were made from (its kind and file): the page's own edit can be
  // behind this one, and a source it hasn't the media for yet is left out there (playback.ts `nativeSourcesFor`).
  const of: Record<string, string> = {};
  player.markNative(project.id);
  landedApp = app;
  // A pieced proxy's pieces the timeline plays come down behind the viewer, in its order (one fill a project).
  cloudMedia.fillPieces(app, project.id);
  // Only what the timeline shows comes down (Cops Realize lists 169 own-file videos, 1.5 GB; its clips show 66, 0.7 GB),
  // in playhead order: the media first played first.
  const shown = new Set(project.clips.flatMap((clip) => (clip.type === "video" ? [clip.media] : [])));
  const heard = new Set(project.clips.flatMap((clip) => (clip.type === "audio" ? [clip.media] : [])));
  const streamed = new Set<string>();
  let piecesComing = false;
  const firstUse = new Map<string, number>();
  for (const clip of project.clips) {
    if (clip.type !== "video" && clip.type !== "audio") continue;
    firstUse.set(clip.media, Math.min(firstUse.get(clip.media) ?? Infinity, clip.start));
  }
  // The stretches of each video the timeline shows (seconds of it), in the timeline's order.
  const played = playedStretches(project);
  const inPlayheadOrder = [...project.media].sort((a, b) => (firstUse.get(a.id) ?? Infinity) - (firstUse.get(b.id) ?? Infinity));
  for (const media of inPlayheadOrder) {
    const sound = media.kind === "audio" || (media.kind === "video" && media.has_audio);
    if (media.kind !== "video" && media.kind !== "image" && !sound) continue;
    of[media.id] = `${media.kind}:${media.path}`;
    const key = cloudMedia.streamKey(media.cloud, "proxy");
    if (key !== null) {
      const local = cloudMedia.localPath(cache, key);
      const base = pieces.baseOf(key);
      // A local-first working copy not made yet: the original's own path, so the made copy is read once it lands (local_first.ts).
      const standing = localFirst.windowReads(cache, media);
      let source: string;
      if (standing !== null) source = standing;
      else if (base === null && isFile(local)) source = local;
      else if (isFile(media.path)) source = media.path;
      else {
        const url = `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(key)}`;
        source = url;
        if (shown.has(media.id) || heard.has(media.id)) {
          if (base === null) {
            // Its size guessed from the media, so the queue counts it as it starts (checked again once its first block says).
            fetchWhole(key, local, previewBytes(media, key));
            streamed.add(key);
          }
          else if (shown.has(media.id)) {
            const { here, coming } = await pieceExcerpts(project.id, cache, base, played.get(media.id) ?? []);
            if (here.length > 0) excerpts[media.id] = here;
            if (coming) piecesComing = true;
          }
        }
      }
      if (media.kind !== "audio") sources[media.id] = source;
      if (sound) sounds[media.id] = source.startsWith("http") ? (soundHere(cache, media.cloud?.original) ?? source) : source;
      continue;
    }
    const paths = app.media.paths(media.path);
    const made = isFile(paths.proxyDone);
    if (media.kind !== "audio") sources[media.id] = media.kind === "video" && made && isFile(paths.proxy) ? paths.proxy : media.path;
    if (sound) sounds[media.id] = made && isFile(paths.audio) ? paths.audio : media.path;
  }
  const files = new Set<string>([...Object.values(sources), ...Object.values(sounds)].filter((source) => !source.startsWith("http")).concat(Object.values(excerpts).flatMap((list) => list.map((one) => one.path))));
  handed.set(project.id, files);
  if (streamed.size > 0) streaming.set(project.id, streamed);
  else streaming.delete(project.id);
  // Whether a file named here comes down or is cut yet: the page asks again in 15 s while one is (`coming`).
  return json({ cache, sources, sounds, excerpts, of, coming: streamed.size > 0 || piecesComing });
}

/**
 * The cache's cleaner took `path` (a file or a folder): each project whose
 * window was told to read something there hears it (`native-sources`), and
 * its page asks for its sources again.
 */
export function evicted(app: App, path: string): void {
  for (const [id, files] of handed) {
    if ([...files].some((file) => file === path || file.startsWith(`${path}/`))) {
      handed.delete(id);
      app.store.emit({ type: "native-sources", id });
    }
  }
}

/** For tests. */
export function reset(): void {
  player.reset();
  handed.clear();
  streaming.clear();
  for (const timer of telling.values()) clearTimeout(timer);
  telling.clear();
  cutsWaiting.length = 0;
  awaited.clear();
  cutting.clear();
  cutFailed.clear();
  cutShort.clear();
}
