// Cloud previews read from their whole copy on this Mac (Nov 6, JJ's four
// reviews on Sphe's Mac): their footage was imported on Mathias's, so every
// frame the agent looked at was read in blocks through this server's loopback
// stream from R2, behind the Mac's other cloud traffic. Pictures took 1–3
// minutes a look (a contact sheet 3 min 32 s, a render_frame 3 min 06 s, a
// plan's review frames 3 min 31 s) and ~90% of the turns' tool time; the
// compositing took under half a second. A preview is small (a 7-minute one
// ~26 MB, a whole project's ~0.5–1 GB), so the whole file is fetched once,
// into the copy Edit already serves from (`cloud_media.localPath`), and
// frames read it with the Mac's video decoder.
//
// Fetched when a turn starts on a project (and when the native preview asks),
// a few at a time; until a file is here its frames stream as before. The
// renders take the project with those paths swapped for the files here
// (`localized`), never the saved project: its paths are the cloud's, the same
// on every Mac.

import * as cloudBlocks from "./cloud_blocks.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { objectOf } from "./export_excerpts.ts";
import type { Media, Project } from "./model.ts";
import * as outages from "./outages.ts";
import { isFile, parent } from "./paths.ts";
import * as playing from "./playing.ts";
import * as pieces from "./proxy_pieces.ts";
import * as storage from "./storage.ts";
import * as thread from "./thread.ts";

/** Whole previews fetched at once, and how many more may start for ones read now (`hurry`). */
const AT_ONCE = 4;
const HURRIED_AT_ONCE = 2;
/** A whole preview waiting to start: its key, where it goes, and about how big it is (0: not known yet). */
type Waiting = { key: string; local: string; bytes: number; sized?: boolean };
const waiting: Waiting[] = [];
const fetching = new Set<string>();
/**
 * When a fetch last failed for good (R2 said the object isn't there, or refused it: a 4xx), so it isn't asked again on
 * every frame (again after `RETRY_MS`). A failure in passing (the network's: a reset, a timeout, a name not found, a
 * read cut off; R2's 5xx) is no such thing: `passing`.
 */
const failed = new Map<string, number>();
const RETRY_MS = 10 * 60_000;
/**
 * Copies whose fetch failed in passing, asked again after a short wait that grows with each failure in a row
 * (`retryHooks`), or at once when the cloud answers again (outages.ts `onBack`). Until Nov 20 every failure was one
 * for 10 minutes: a 3 s Wi-Fi drop threw every copy under way (a block is tried only 0.5 s and 2 s later), and for
 * 10 minutes they streamed and the footage dialog counted them as never coming.
 */
const passing = new Map<string, { one: Waiting; tries: number; timer: ReturnType<typeof setTimeout> | undefined }>();
/**
 * Waits before a copy that failed in passing is asked again (ms), the last for every failure after: a Wi-Fi drop of
 * seconds costs a copy 2–5 s, an outage of minutes is tried once a minute (and at once when it's over). The same on an
 * 8 Mbit/s line or a 50 Mbit/s one: what's waited for is the line coming back, not the bytes.
 */
export const retryHooks = { waits: [2_000, 5_000, 15_000, 30_000, 60_000] };
/** Each object's exact size, once its first block has said it (a copy stopped for room keeps it). */
const sizes = new Map<string, number>();
/** Files waiting that the disk has no room for now, already said in the log (said again once they've come). */
const short = new Set<string>();

/**
 * Whether `local`'s whole copy won't come for now: no room for it on the disk (it streams on), or its fetch failed
 * lately. What the footage's readiness counts as not coming (footage_ready.ts).
 */
export function wontCome(local: string): boolean {
  return short.has(local) || failedLately(local);
}

/** Whether `local`'s fetch failed for good lately (a 4xx), so it isn't asked again yet: nothing will bring it whole for now. */
export function failedLately(local: string): boolean {
  return Date.now() - (failed.get(local) ?? 0) < RETRY_MS;
}

/** Whether `local`'s fetch failed in passing and waits to be asked again (it's queued then by itself). */
function backingOff(local: string): boolean {
  return passing.get(local)?.timer !== undefined;
}

/** Whether `local`'s whole copy is coming down now, or waits its turn with room for it: what Home counts as footage coming (footage_ready.ts `coming`). */
export function coming(local: string): boolean {
  return fetching.has(local) || backingOff(local) || (!short.has(local) && waiting.some((one) => one.local === local));
}

/** Seams for tests. */
export const hooks = {
  // In 2 MiB blocks behind every read a person waits on (cloud_blocks.ts `fetchWhole`); `room` is told what's left to write.
  fetch: (key: string, local: string, room?: (left: number, size: number) => boolean): Promise<void> => cloudMedia.fetchWholeCopy(key, local, room),
};

/**
 * About how big `media`'s preview `key` is: footage that's its own proxy is
 * the original, its size known; a made proxy is at most the cloud proxy's
 * bitrate (media.rs `cloud_proxy_bitrate`) and its sound for the duration.
 */
export function previewBytes(media: Media, key: string): number {
  const original = media.cloud?.size;
  const known = typeof original === "number" && original > 0 ? original : Number.POSITIVE_INFINITY;
  if (key === media.cloud?.original) return Number.isFinite(known) ? known : 0;
  const made = (Math.max(media.duration, 0) * (pieces.bitrateFor(media.width || 1920, media.height || 1080) + 160_000)) / 8;
  return Math.min(known, made);
}

/** Told each time a whole preview lands here (its key). */
const landedListeners = new Set<(key: string) => void>();

export function onLanded(listener: (key: string) => void): () => void {
  landedListeners.add(listener);
  return () => landedListeners.delete(listener);
}

/** About how big `one` is: its exact size once a first block has said it (read once), else its guess. */
function sizeOf(one: Waiting): number {
  const exact = sizes.get(one.key);
  if (exact !== undefined) return exact;
  if (one.sized !== true) {
    one.sized = true;
    const root = cloudMedia.blocksRoot();
    const read = root === null ? null : cloudBlocks.sizeOf(root, one.key);
    if (read !== null) sizes.set(one.key, read);
    if (read !== null) return read;
  }
  return one.bytes;
}

/**
 * Starts what's waiting, in its order, while slots are free (`most`) and the disk has room for each: one check,
 * here, of the disk's free space less what every copy under way still has to write (storage.ts claims) less this
 * file's own size, kept over its floor (storage.ts `footageFloor`: the open project's footage down to the work's floor,
 * every other copy over the cache's, never under what Edit keeps free); checked again with what's left
 * to write exactly once its first block says its size (`start`). Until Nov 17 the check was made when the files
 * were queued, counting nothing under way or queued, made again at every warm, and the window's own queue had
 * none: on kenobi 3.3 GB came down in a minute, to ENOSPC. A file with no room waits (it streams on) and is
 * looked at again as the queue moves: a copy ending, a new ask, the cleaner freeing room.
 *
 * While a play is shown, copies keep starting as the line allows them reads (cloud_blocks.ts `fillsWhilePlaying`);
 * a file the play needs next (`soon`: the timeline's next minute, a jump's file) always starts, with a slot or two of
 * its own beside the others. Until Nov 20 nothing started while anything played or held, so a jump's copy waited for a
 * pause, and nothing but the play's next seconds came down for the whole of a long watch.
 */
function fetchNext(most = AT_ONCE, only?: Waiting): void {
  if (waiting.length === 0) return;
  const dir = parent(waiting[0]!.local) ?? waiting[0]!.local;
  // Free less every claim: each file's own floor is taken off it below.
  let room = storage.spare(dir, 0, 0);
  const others = cloudBlocks.fillsAllowed() > 0;
  let newlyShort = 0;
  let wanted = 0;
  for (let at = 0; at < waiting.length && fetching.size < Math.max(most, AT_ONCE + HURRIED_AT_ONCE); ) {
    const one = waiting[at]!;
    if (only !== undefined && one !== only) {
      at++;
      continue;
    }
    if (isFile(one.local) || fetching.has(one.local)) {
      waiting.splice(at, 1);
      continue;
    }
    // What the play needs next has slots of its own; the rest wait for a free one, and for the line to allow them reads.
    const soon = cloudBlocks.isSoon(one.key);
    if (!soon && (fetching.size >= most || !others)) {
      at++;
      continue;
    }
    // Its size not known yet (the window queues by key): its first block at least, where the exact size is said.
    const need = Math.max(sizeOf(one), cloudBlocks.BLOCK);
    const floor = storage.footageFloor(dir, one.key);
    if (need > room - floor) {
      if (!short.has(one.local)) {
        short.add(one.local);
        newlyShort++;
        for (const listener of failedListeners) listener(one.key, NO_ROOM);
      }
      wanted = Math.max(wanted, need - (room - floor));
      at++;
      continue;
    }
    waiting.splice(at, 1);
    room -= need;
    start(one, need);
  }
  if (newlyShort > 0) {
    diag.info("preview", `${newlyShort} files stream on, the disk too full to keep them whole (${(storage.freeBytes(dir) / 1e9).toFixed(2)} GB free, ${(storage.claimedBytes() / 1e9).toFixed(2)} GB still coming)`);
  }
  // The cleaner asked for the room the next one needs (a few minutes apart, never what an open project plays): what it frees may take it.
  if (wanted > 0) {
    setTimeout(() => {
      // The cleaner's pass runs here, on the thread, when it's asked (cache_cleanup.ts `makeRoom`): said, so a hold
      // names it rather than whatever page ask came last (Nov 21).
      thread.note("whole copies: asking the cache cleaner for room (cache_cleanup.ts makeRoom)");
      const freed = storage.askForRoom(storage.freeBytes(dir) + wanted);
      thread.note("whole copies: starting what's waiting (local_previews.ts fetchNext)");
      if (freed > 0) fetchNext();
    }, 0).unref?.();
  }
}

const NO_ROOM = "the disk too full to keep it whole";

function start(next: Waiting, need: number): void {
  fetching.add(next.local);
  short.delete(next.local);
  const claim = storage.claim(need);
  const dir = parent(next.local) ?? next.local;
  const started = performance.now();
  // Told the exact bytes left once the first block says the size: refused there (a guess too small) it waits again.
  let checked = false;
  const room = (left: number, size: number): boolean => {
    sizes.set(next.key, size);
    claim.bytes = left;
    if (checked) return true;
    checked = true;
    return storage.spare(dir, left, storage.footageFloor(dir, next.key), claim) >= 0;
  };
  void hooks
    .fetch(next.key, next.local, room)
    .then(() => {
      passing.delete(next.local);
      diag.info("preview", `${next.key}: whole preview here in ${diag.human(performance.now() - started)}`);
      storage.ledger.note(next.local);
      for (const listener of landedListeners) listener(next.key);
    })
    .catch((error: unknown) => {
      if (error instanceof cloudBlocks.NoRoom) {
        // Not a failure: it streams on, and comes down when there's room.
        waiting.push({ ...next, bytes: sizes.get(next.key) ?? next.bytes });
        if (!short.has(next.local)) {
          short.add(next.local);
          diag.info("preview", `${next.key}: streams on, ${NO_ROOM}`);
          for (const listener of failedListeners) listener(next.key, NO_ROOM);
        }
        return;
      }
      // What waits on it now (the censor check) reads the stream; the copy itself comes once the line's back.
      for (const listener of failedListeners) listener(next.key, diag.messageOf(error));
      if (!lasting(error)) {
        askAgain(next, error);
        return;
      }
      passing.delete(next.local);
      failed.set(next.local, Date.now());
      diag.warn("preview", `${next.key}: whole preview not fetched: ${diag.messageOf(error)}`);
    })
    .finally(() => {
      claim.release();
      fetching.delete(next.local);
      fetchNext();
    });
}

/** Whether a fetch's failure is for good: R2 said the object isn't there or refused it (a 4xx but a timeout's or too-many's). Anything without a status is the network's. */
function lasting(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A copy that failed in passing, asked again after its wait (`retryHooks`): never counted as one that won't come. */
function askAgain(one: Waiting, error: unknown): void {
  const tries = (passing.get(one.local)?.tries ?? 0) + 1;
  const waits = retryHooks.waits;
  const wait = waits[Math.min(tries, waits.length) - 1] ?? 60_000;
  // Said once, and every tenth after (an outage of an hour says it six times, not sixty).
  if (tries === 1 || tries % 10 === 0) diag.info("preview", `${one.key}: whole preview interrupted (${diag.messageOf(error)}): asked again in ${Math.round(wait / 1000)} s${tries > 1 ? ` (${tries} in a row)` : ""}`);
  const entry = { one, tries, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  entry.timer = setTimeout(() => queueAgain(entry), wait);
  (entry.timer as { unref?: () => void }).unref?.();
  passing.set(one.local, entry);
}

/** A copy that failed in passing back in the queue, at its front (it had started before what waits). */
function queueAgain(entry: { one: Waiting; timer: ReturnType<typeof setTimeout> | undefined }): void {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  const { one } = entry;
  if (isFile(one.local) || fetching.has(one.local) || waiting.some((other) => other.local === one.local)) return;
  waiting.unshift({ ...one, bytes: sizes.get(one.key) ?? one.bytes });
  fetchNext();
}

// The cloud answering again (an outage over): every copy that failed in passing is asked again now, not at its next try.
outages.onBack(() => {
  for (const entry of passing.values()) if (entry.timer !== undefined) queueAgain(entry);
});

// A play's start, hold or stop changes what may start (`fetchNext`).
playing.onShowChange(() => fetchNext());

/** Queues `key`'s whole preview into `local`, once (`bytes`: about how big it is, when known). */
export function fetchWhole(key: string, local: string, bytes = 0): void {
  if (failedLately(local) || backingOff(local) || fetching.has(local) || waiting.some((one) => one.local === local) || isFile(local)) return;
  waiting.push({ key, local, bytes });
  fetchNext();
}

/**
 * `key`'s whole preview in `local`, fetched like the players' (queued at the back, once), resolved with its path
 * once it's here; rejected when the fetch fails, or after `waitMs`.
 */
export function whenHere(key: string, local: string, waitMs = 15 * 60_000): Promise<string> {
  if (isFile(local)) return Promise.resolve(local);
  return new Promise<string>((resolve, reject) => {
    const done = (error: Error | null) => {
      clearTimeout(timer);
      off();
      offFailed();
      if (error === null) resolve(local);
      else reject(error);
    };
    const timer = setTimeout(() => done(new Error(`not here after ${Math.round(waitMs / 60_000)} min`)), waitMs);
    const off = onLanded((landed) => {
      if (landed === key && isFile(local)) done(null);
    });
    const offFailed = onFailed((failedKey, error) => {
      if (failedKey === key) done(new Error(error));
    });
    if (failedLately(local)) {
      done(new Error("its fetch failed lately"));
      return;
    }
    // No room for it now: what waits reads the stream, not the minutes until there is.
    if (short.has(local)) {
      done(new Error(NO_ROOM));
      return;
    }
    fetchWhole(key, local);
    // Landed between the check and the listener.
    if (isFile(local)) done(null);
  });
}

/** Told each time a whole preview fails to come down (its key, and why). */
const failedListeners = new Set<(key: string, error: string) => void>();

function onFailed(listener: (key: string, error: string) => void): () => void {
  failedListeners.add(listener);
  return () => failedListeners.delete(listener);
}

/** A file the page's player is reading from R2 this moment (a jump past what's here) comes down whole at once, as a jump in the window's does (`hurry`). */
export function fetchNow(key: string, local: string): void {
  if (pieces.baseOf(key) !== null || isFile(local) || fetching.has(local) || failedLately(local) || backingOff(local)) return;
  if (!waiting.some((one) => one.local === local)) waiting.push({ key, local, bytes: 0 });
  hurry(key);
}

/** Seconds after the playhead whose files come first, and seconds of the edit's start and of each part's start next. */
const NEXT_SECONDS = 30;
/**
 * Seconds after the playhead whose files come down during a play however slow the line (cloud_blocks.ts `setSoon`):
 * what the play is about to need, and stalls without. A minute of a proxy is 15–33 MB: on an 8 Mbit/s line about
 * 15–35 s to bring whole beside the play, on a 50 Mbit/s one 3–6 s.
 */
const SOON_SECONDS = 60;
/** The files each project's playhead plays next, and files read now from a jump (`hurry`), by when (kept `SOON_SECONDS`). */
const soonByProject = new Map<string, Set<string>>();
const hurried = new Map<string, number>();

/** Tells the block reads which copies the play needs next (cloud_blocks.ts `setSoon`). */
function tellSoon(): void {
  const keys = new Set<string>();
  for (const one of soonByProject.values()) for (const key of one) keys.add(key);
  const now = Date.now();
  for (const [key, at] of hurried) {
    if (now - at < SOON_SECONDS * 1000) keys.add(key);
    else hurried.delete(key);
  }
  cloudBlocks.setSoon(keys);
}
const START_SECONDS = 30;
const PART_SECONDS = 15;

/**
 * Every picture and sound file `project`'s timeline plays, whole, onto this
 * machine, ahead of anything already waiting, in the order a person is likely
 * to watch from frame `from`: what plays in the next half minute, then the
 * edit's start, then the start of each of its parts (`starts`: frames, the
 * intro, cut-ins, story and outro, where people jump), then the rest after
 * the playhead and what's before it. The one footage form of both players:
 * the page's and Edit.app's window's (native_preview.ts). Until Nov 15 the
 * page read ahead 2 MiB blocks of ten minutes of the timeline and nothing
 * else, so every jump past them waited on R2; until Nov 16 the order was the
 * timeline's from the playhead alone, and a jump to a part waited behind
 * everything between. A pieced proxy is no file (its pieces come instead:
 * `fillPieces`). Asked again from another frame (a jump), the files from there
 * move to the front. The files of the next minute from `from` are the play's
 * `soon` (see `fetchNext`).
 */
export function fetchInPlayheadOrder(cache: string, project: Project, from: number, starts: number[] = [], head?: number): number {
  const fps = project.settings.fps > 0 ? project.settings.fps : 30;
  const overlaps = (clip: { start: number; duration: number }, at: number, seconds: number) => clip.start < at + seconds * fps && clip.start + clip.duration > at;
  const ranked: { media: string; rank: number; start: number }[] = [];
  const graphic = new Set(project.media.filter((media) => typeof media.effect === "string" && media.effect !== "").map((media) => media.id));
  for (const clip of project.clips) {
    if (clip.type !== "video" && clip.type !== "audio") continue;
    // Getting a project ready to open (footage_ready.ts, `head` frames): what its first minutes play, in the
    // timeline's order, then the rest of the footage, then the graphics.
    if (head !== undefined) {
      ranked.push({ media: clip.media, rank: clip.start < head ? 0 : graphic.has(clip.media) ? 2 : 1, start: clip.start });
      continue;
    }
    const rank = overlaps(clip, from, NEXT_SECONDS)
      ? 0
      : overlaps(clip, 0, START_SECONDS)
        ? 1
        : starts.some((at) => overlaps(clip, at, PART_SECONDS))
          ? 2
          : clip.start + clip.duration > from
            ? 3
            : 4;
    ranked.push({ media: clip.media, rank, start: clip.start });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.start - b.start);
  const byId = new Map(project.media.map((media) => [media.id, media]));
  // What plays in the next minute from the playhead: its copies come during a play however slow the line.
  if (head === undefined) {
    const next = new Set<string>();
    for (const clip of project.clips) {
      if ((clip.type !== "video" && clip.type !== "audio") || !overlaps(clip, from, SOON_SECONDS)) continue;
      const key = cloudMedia.streamKey(byId.get(clip.media)?.cloud, "proxy");
      if (key !== null && pieces.baseOf(key) === null) next.add(key);
    }
    soonByProject.set(project.id, next);
    tellSoon();
  }
  const wanted: Waiting[] = [];
  const seen = new Set<string>();
  for (const { media: id } of ranked) {
    const media = byId.get(id);
    const key = media === undefined ? null : cloudMedia.streamKey(media.cloud, "proxy");
    if (media === undefined || key === null || pieces.baseOf(key) !== null || isFile(media.path) || seen.has(key)) continue;
    seen.add(key);
    const local = cloudMedia.localPath(cache, key);
    if (isFile(local) || fetching.has(local) || failedLately(local) || backingOff(local)) continue;
    const queued = waiting.find((one) => one.local === local);
    wanted.push(queued ?? { key, local, bytes: previewBytes(media, key) });
  }
  // Whether each has room is asked as it starts (`fetchNext`), counting what's under way.
  const first = new Set(wanted.map((one) => one.local));
  const rest = waiting.filter((one) => !first.has(one.local));
  waiting.length = 0;
  waiting.push(...wanted, ...rest);
  fetchNext();
  return wanted.length;
}

/**
 * `key`'s preview is being read now through the stream (a jump in Edit.app's
 * window to footage not here yet): its whole copy, if it's waiting, is fetched
 * next, beside the ones under way. In playhead order a jump elsewhere waited
 * behind the whole queue, each frame streamed meanwhile (0.7–7 s a jump for
 * the first 50 s of a cold Cops Realize, Nov 15).
 */
export function hurry(key: string): void {
  const at = waiting.findIndex((one) => one.key === key);
  if (at < 0) return;
  // What a play is reading now: it comes down during a play however slow the line.
  hurried.set(key, Date.now());
  tellSoon();
  const [one] = waiting.splice(at, 1);
  waiting.unshift(one!);
  fetchNext(AT_ONCE + HURRIED_AT_ONCE, one);
}

/**
 * A cloud media's preview key, when its whole file can be kept here: a made
 * proxy, or footage that's its own proxy (256 MB at most); not a pieced
 * proxy, which is no file (proxy_pieces.ts).
 */
function previewKey(media: Media): string | null {
  if (media.kind !== "video") return null;
  const key = cloudMedia.streamKey(media.cloud, "proxy");
  return key !== null && pieces.baseOf(key) === null ? key : null;
}

/** Queues every cloud preview `project` reads that isn't here yet. */
export function fetchAll(cache: string, project: Project): void {
  for (const media of project.media) {
    const key = previewKey(media);
    if (key !== null && !isFile(media.path)) fetchWhole(key, cloudMedia.localPath(cache, key), previewBytes(media, key));
  }
}

/**
 * `project` with each cloud preview it streams read from its whole file here
 * instead, or null when none is here (the rest are fetched behind it). Only a
 * path that streams that very preview is swapped, so what's drawn is the same.
 */
export function localized(cache: string, project: Project): Project | null {
  let out: Project | null = null;
  project.media.forEach((media, index) => {
    const key = previewKey(media);
    if (key === null || isFile(media.path) || objectOf(media.path) !== `cloud:${key}`) return;
    const local = cloudMedia.localPath(cache, key);
    if (!isFile(local)) {
      fetchWhole(key, local, previewBytes(media, key));
      return;
    }
    out ??= { ...project, media: [...project.media] };
    out.media[index] = { ...media, path: local };
  });
  return out;
}

/** The file a media's frames and sound are read from: its whole preview here, else its path. */
export function pathOf(cache: string, media: Media): string {
  const key = previewKey(media);
  if (key === null || isFile(media.path) || objectOf(media.path) !== `cloud:${key}`) return media.path;
  const local = cloudMedia.localPath(cache, key);
  return isFile(local) ? local : media.path;
}

/** For tests. */
export function reset(): void {
  waiting.length = 0;
  fetching.clear();
  failed.clear();
  for (const entry of passing.values()) clearTimeout(entry.timer);
  passing.clear();
  soonByProject.clear();
  hurried.clear();
  cloudBlocks.setSoon(new Set());
  sizes.clear();
  short.clear();
}
