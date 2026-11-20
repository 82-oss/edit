// Footage that goes to the cloud without landing on this Mac (the user, Oct
// 30: "we still use the mac but we dont need to reserve the space for
// imports"). Each recording's original goes straight to Edit's originals (R2
// and the registry, as the handoff would have put it): a Drive file copied by
// the relay's cloud job or streamed through this Mac (cloud_media.driveOriginal),
// a YouTube video downloaded by yt-dlp, uploaded and deleted here. Only
// the recording's 480p piece of the preview is made here, read back from the
// cloud copy; the words are heard from the preview (transcription.recordings
// does that for a recording with no file of its own) and the speakers watched
// in it. `edit-shared.json` says what's in the cloud, so the handoff shares
// the words and never uploads the footage again.

//
// Local-first (Nov 18, nightly-88; the local-first media plan's step 3): JJ's
// "Mom Of 4" (48 Drive recordings, 53 GB) made its pieces at 0.2–2.4× real
// time, each read back from the cloud copy, while the AVIs read here made
// theirs at 11–17×. With room for them (`room.roomFor`), each recording now
// comes down here first, at the line's full speed, its piece is made from
// that copy, and the original reaches the cloud behind the import: the
// relay's copy (Drive straight to R2, nothing sent from this Mac) or, where
// the relay can't, this Mac's own upload (cloud_media `uploadLater`: one at a
// time, resumable, noted in jobs.json). Neither holds the import, its words,
// its speakers or its build. The copy is kept in the script's `.originals/`
// (a dot folder: the script's sync, its recordings and the room rounds leave
// it alone) until its piece is made and the cloud has it, then removed; a
// restart carries both on from `.originals/held.json`. Short of room, a
// recording goes to the cloud first and is read back from there, as before.
// Edit mode on this Mac waits for an original still on its way
// (cloud_media `goingUpBehind`) instead of copying it again.

import * as fs from "node:fs";

import type { App } from "../app.ts";
import * as cloud from "../cloud.ts";
import * as cloudMedia from "../cloud_media.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import * as room from "../storage.ts";
import * as youtube from "../youtube.ts";
import { title as titleOf } from "./youtube.ts";
import * as driveFiles from "./drive.ts";
import type { Recording } from "./drive.ts";
import { keepShared, originalKey, segment, sending, sharedHere } from "./handoff.ts";
import { readable, streams } from "./media.ts";
import { copiesHere, type CopyHere } from "../script.ts";
import * as store from "./store.ts";
import { THIS_MACHINE } from "../machine.ts";

/** Whether imports stream their footage to the cloud: always, once Edit's cloud is on. */
export function on(): boolean {
  return cloud.enabled();
}

/** How long a cloud original's address works for the FFmpeg that reads it (a long recording's piece takes a while). */
const READ_SECONDS = 6 * 3600;

/** Where a recording's original is in the cloud, and an address FFmpeg reads it from. */
export interface InCloud {
  source: string;
  key: string;
  name: string;
  size: number;
  url: string;
  /** This Mac's whole copy, read in place of `url` (it may not be in the cloud yet); `done` once the import has its piece. Null: read `url`. */
  here: string | null;
}

/**
 * A Drive recording's original put in the cloud (unless it's there already)
 * and noted beside the script. `here`: there's room to keep it on this Mac
 * until it's up (`room.roomFor`), so it comes down here first and goes up
 * behind the import (`InCloud.here`); an original the cloud has already is
 * read from there, or brought here by the caller (`readHere`).
 */
export async function drive(dir: string, recording: Recording, onBytes: (bytes: number) => void, here = false): Promise<InCloud> {
  if (here && cloud.enabled()) return driveHere(dir, recording, onBytes);
  const scratch = join(dir, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const put = await cloudMedia.driveOriginal(recording.id, scratch, (bytes) => onBytes(bytes));
  keepShared(dir, null, put.source, put.key);
  return { source: put.source, key: put.key, name: put.name, size: put.size, url: await cloud.presign(put.key, "GET", READ_SECONDS), here: null };
}

/** `drive` with room here: the recording downloaded into `.originals/`, its original going up behind the import. */
async function driveHere(dir: string, recording: Recording, onBytes: (bytes: number) => void): Promise<InCloud> {
  const source = `drive:${recording.id}`;
  const record = await cloudMedia.getRecord(source);
  const ready = cloudMedia.readyOriginal(record);
  const known = readHeld(dir).find((one) => one.source === source);
  if (record !== null && ready !== null) {
    keepShared(dir, null, source, ready);
    onBytes(recording.size);
    // A whole copy here from before is read rather than fetched again; a partial one isn't needed now.
    const landed = known !== undefined && known.landed && isFile(join(dir, known.path)) ? join(dir, known.path) : null;
    if (known !== undefined) {
      if (landed === null) drop(dir, known);
      else settle(dir, source, (one) => Object.assign(one, { piece: false, up: true }));
    }
    return { source, key: ready, name: record.name, size: Math.max(Math.trunc(record.size), 0), url: await cloud.presign(ready, "GET", READ_SECONDS), here: landed };
  }
  const name = segment(recording.name);
  const key = record !== null && cloud.validKey(record.originalKey) ? record.originalKey : originalKey(source, name);
  if (record === null) await cloud.mutation("edit:putMedia", { source, name, originalKey: key, size: recording.size });
  const one: Held = known !== undefined && known.key === key ? { ...known, piece: false } : { source, drive: recording.id, key, name, size: recording.size, path: join(HERE, folderName(recording.id), name), landed: false, up: false, piece: false };
  if (known !== undefined && known.key !== key) drop(dir, known);
  keep(dir, one);
  const path = join(dir, one.path);
  let landed: (path: string) => void = () => {};
  let failed: (error: unknown) => void = () => {};
  const local = new Promise<string>((resolve, reject) => {
    landed = resolve;
    failed = reject;
  });
  // Nobody may wait on it (its upload already going from an earlier call): never an unhandled rejection.
  local.catch(() => {});
  // Edit mode here waits on this download (growing on this disk) rather than on the upload behind it (`copyHere`).
  landing.set(source, { dir, path, size: recording.size, name, done: local });
  local.then(
    () => landing.delete(source),
    () => landing.delete(source),
  );
  goUp(dir, one, local);
  try {
    if (!(await whole(path, recording))) {
      fs.mkdirSync(join(dir, HERE, folderName(recording.id)), { recursive: true });
      const token = await driveFiles.hooks.accessToken();
      // One that comes down short is fetched again once, from where it stopped, as the import's own downloads are.
      await driveFiles.download(token, recording, path, onBytes).catch((error: unknown) => {
        if (!(error instanceof driveFiles.DownloadShort)) throw error;
        return driveFiles.download(token, recording, path, onBytes);
      });
    }
  } catch (error) {
    failed(error);
    throw error;
  }
  settle(dir, source, (kept) => void (kept.landed = true));
  landed(path);
  onBytes(recording.size);
  keepShared(dir, null, source, key);
  return { source, key, name, size: recording.size, url: await cloud.presign(key, "GET", READ_SECONDS), here: path };
}

/** Whether `path` is already the whole recording, as Drive holds it (its size and MD5, proven once). */
async function whole(path: string, recording: Recording): Promise<boolean> {
  if (!isFile(path)) return false;
  try {
    return await driveFiles.intact(await driveFiles.hooks.accessToken(), recording, path);
  } catch {
    return recording.size > 0 && fs.statSync(path).size === recording.size;
  }
}

/** The import is done with a copy here (its piece made, or it didn't read): it goes once the cloud has the original. */
export function done(dir: string, put: InCloud): void {
  if (put.here === null) return;
  settle(dir, put.source, (one) => void (one.piece = true));
}

/** This Mac's whole copy of the original at `url` (a cloud address `drive` or `fromYoutube` gave), while it's kept: null when there's none. */
export function localOf(dir: string, url: string): string | null {
  let named: string;
  try {
    named = new URL(url).pathname.split("/").slice(-2).map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  const one = readHeld(dir).find((kept) => kept.landed && kept.key.split("/").slice(-2).join("/") === named);
  return one !== undefined && isFile(join(dir, one.path)) ? join(dir, one.path) : null;
}

// ---------------------------------------------------------------------------
// The copies kept here until their originals are up.

/** The script's folder for them: a dot folder, which the script's sync, its recordings and the room rounds leave alone. */
const HERE = ".originals";

/** One original kept here: where it goes, its copy (by its path in the script's folder), and how far it's got. */
interface Held {
  source: string;
  /** Its Drive file, which the relay can copy to the cloud itself. */
  drive?: string;
  key: string;
  name: string;
  size: number;
  path: string;
  /** The whole file is here. */
  landed: boolean;
  /** The registry has the original ready. */
  up: boolean;
  /** The import is done with the copy. */
  piece: boolean;
}

const heldPath = (dir: string) => join(dir, HERE, "held.json");
const folderName = (id: string) => id.replace(/[^\w-]+/g, "_");

function readHeld(dir: string): Held[] {
  try {
    const found = JSON.parse(fs.readFileSync(heldPath(dir), "utf8")) as Held[];
    return Array.isArray(found) ? found.filter((one) => typeof one?.source === "string" && typeof one.key === "string" && typeof one.path === "string" && !one.path.split("/").includes("..")) : [];
  } catch {
    return [];
  }
}

function writeHeld(dir: string, list: Held[]): void {
  // A script deleted meanwhile isn't made again by its last copy's news.
  if (!fs.existsSync(join(dir, "script.json"))) return;
  fs.mkdirSync(join(dir, HERE), { recursive: true });
  writeAtomic(heldPath(dir), JSON.stringify(list, null, 2));
}

function keep(dir: string, one: Held): void {
  writeHeld(dir, [...readHeld(dir).filter((kept) => kept.source !== one.source), one]);
}

/** Its copy and its line gone. */
function drop(dir: string, one: Held): void {
  fs.rmSync(join(dir, one.path.split("/").slice(0, 2).join("/")), { recursive: true, force: true });
  const rest = readHeld(dir).filter((kept) => kept.source !== one.source);
  if (rest.length > 0) writeHeld(dir, rest);
  else fs.rmSync(heldPath(dir), { force: true });
}

/** `change` applied to `source`'s line; the copy goes once the cloud has it and the import is done with it. */
function settle(dir: string, source: string, change: (one: Held) => void): void {
  const list = readHeld(dir);
  const one = list.find((kept) => kept.source === source);
  if (one === undefined) return;
  change(one);
  // Edit mode cutting from it (`copyHere`): kept until it lets go, then looked at again.
  if (one.up && one.piece && !(inUse.get(source) ?? 0)) {
    drop(dir, one);
    diag.info("writer", `${source}: in the cloud and its piece made, so its copy here (${Math.round(one.size / 1e6)} MB) is removed`);
    return;
  }
  writeHeld(dir, list);
}

// ---------------------------------------------------------------------------
// Edit mode's import cutting from a copy here (Nov 20).

/** Downloads into `.originals/` under way, by source: where the file grows, and when it's whole. */
const landing = new Map<string, { dir: string; path: string; size: number; name: string; done: Promise<string> }>();
/** Copies Edit mode is cutting from now, by source: never removed under it. */
const inUse = new Map<string, number>();

/**
 * This Mac's whole copy of `source`'s original that a script keeps (Script mode brought it down; its upload may still
 * be going), held for the caller until it lets go; else the download of it under way here; else null. Edit mode's
 * import cuts from the copy at once, the upload going on behind it (honest council change 8a's intent): it waited,
 * unbounded and silent, on the upload (Nov 20: "downloading 0 B" for hours on an 8 Mbit/s line, the copy on disk
 * looked at only after the upload).
 */
export function copyHere(source: string): CopyHere | null {
  if (home === null) return null;
  const going = landing.get(source);
  const data = store.dataDir(home);
  for (const id of store.ids(data)) {
    const dir = store.scriptDir(data, id);
    const one = readHeld(dir).find((kept) => kept.source === source && kept.landed);
    if (one === undefined || !isFile(join(dir, one.path))) continue;
    inUse.set(source, (inUse.get(source) ?? 0) + 1);
    let gone = false;
    const release = () => {
      if (gone) return;
      gone = true;
      const left = (inUse.get(source) ?? 1) - 1;
      if (left > 0) inUse.set(source, left);
      else inUse.delete(source);
      // Its upload may have finished meanwhile: it goes now if the import is done with it too.
      settle(dir, source, () => {});
    };
    return { copy: { path: join(dir, one.path), key: one.key, name: one.name, size: one.size, release } };
  }
  if (going !== undefined) return { landing: { path: going.path, size: going.size, name: going.name, done: going.done } };
  // A folder case's joined master (or a file the script was made from), named in Edit's originals as going up from
  // here (handoff.ts `nameShared`): the script's own file, never removed under the cut.
  for (const id of store.ids(data)) {
    const found = sharedHere(store.scriptDir(data, id), source);
    if (found === null) continue;
    const name = found.key.split("/").pop() ?? "footage.mp4";
    return { copy: { path: found.path, key: found.key, name, size: fs.statSync(found.path).size, release: () => {} } };
  }
  return null;
}
copiesHere.find = copyHere;

/** Whether `source`'s original is on its way up from this Mac behind an import (its copy here not up yet). */
function goingUpFrom(source: string): boolean {
  if (home === null) return false;
  if (landing.has(source)) return true;
  const data = store.dataDir(home);
  return store.ids(data).some((id) => readHeld(store.scriptDir(data, id)).some((one) => one.source === source && !one.up));
}
sending.goingUp = goingUpFrom;

/** Edit's home, where this Mac's uploads are noted (`start`). */
let home: string | null = null;

/** Edit's home once Script mode has started here (imports.ts `progress` reads the job table there), else null. */
export const homeNow = (): string | null => home;

/** The uploads going on, by script folder and source. */
const going = new Map<string, Promise<void>>();

/**
 * `one`'s original to the cloud behind the import: the relay's copy for a
 * Drive file (nothing sent from here), else this Mac's upload of `local`
 * once it's whole. Edit mode here waits for it (`goingUpBehind`). Done, the
 * copy goes if the import is done with it; failed, it stays for the next
 * start to try again.
 */
function goUp(dir: string, one: Held, local: Promise<string>): void {
  const id = `${dir}\n${one.source}`;
  if (going.has(id)) return;
  // How far it's got, for Edit mode waiting on it here (cloud_media `waitGoingUp`): the relay's count while it copies,
  // then this Mac's upload's bytes (and the slot's: the upload ahead of it moving is this one moving towards its turn).
  let relaySent = 0;
  let file: string | null = null;
  const watch: cloudMedia.GoingUp = {
    sent: () => (file === null ? relaySent : cloudMedia.sentOf(file)),
    moved: () => relaySent + (file === null ? 0 : cloudMedia.upMoving(file)),
    total: one.size,
    name: one.name,
  };
  const up = (async (): Promise<cloudMedia.Original> => {
    const sent = one.drive !== undefined ? await cloudMedia.copyInTheCloud(one.drive, one.key, one.size, (bytes) => (relaySent = bytes)) : null;
    if (sent !== null) {
      const path = await local.catch(() => null);
      const duration = await streams(path ?? (await cloud.presign(one.key, "GET", READ_SECONDS))).then((found) => found.durationMs / 1000, () => null);
      // The relay's status may not say the bytes: Drive's size is the file's.
      const size = sent > 0 ? sent : one.size;
      await cloudMedia.originalIsReady(one.source, size, duration);
      return { file: one.drive ?? one.source, source: one.source, key: one.key, name: one.name, size };
    }
    file = await local;
    return upFromHere(one, file);
  })();
  cloudMedia.goingUpBehind(one.source, up, watch);
  const began = Date.now();
  const run = up
    .then(
      () => {
        diag.info("writer", `${one.source}: its original is in the cloud, ${Math.round((Date.now() - began) / 1000)} s after it started going up behind the import`);
        settle(dir, one.source, (kept) => void (kept.up = true));
      },
      (error: unknown) => diag.warn("writer", `${one.source}: its original didn't go up yet (${diag.messageOf(error)}); its copy stays here and it's tried again`),
    )
    .finally(() => going.delete(id));
  going.set(id, run);
}

/**
 * `one` uploaded from this Mac (cloud_media `uploadLater`: one at a time, resumable, carried on after a restart), until
 * the registry has it. What ends the wait is the job table's upload landing, at whichever try (Nov 21): a try that
 * fails is put off and started again by the table's own waits (jobs.ts `putOff`: a minute, 5, 15, then every half
 * hour, sooner when the line comes back), never by a loop here (it asked every ten minutes for ever, outside the
 * table, and sent it again). Its copy gone, or Edit's restart (`reset`), ends it too.
 */
async function upFromHere(one: Held, path: string): Promise<cloudMedia.Original> {
  const size = fs.statSync(path).size;
  const duration = await streams(path).then((found) => found.durationMs / 1000, () => 0);
  const upload = { file: path, source: one.source, size, duration, originalKey: one.key, uploadOriginal: true, proxy: null, local: null };
  if (home === null) {
    await cloud.uploadFile(path, one.key, () => {}, undefined, true);
    await cloudMedia.originalIsReady(one.source, size, duration);
  } else {
    diag.info("writer", `${one.source}: the relay can't copy it, so ${THIS_MACHINE} uploads its original (${Math.round(size / 1e6)} MB) behind the import`);
    const landed = cloudMedia.landed(path);
    landed.catch(() => {});
    cloudMedia.uploadLater(home, upload);
    let stop: (error: Error) => void = () => {};
    const stopped = new Promise<never>((_, reject) => (stop = reject));
    stopped.catch(() => {});
    stops.add(stop);
    try {
      await Promise.race([landed, stopped]);
    } finally {
      stops.delete(stop);
    }
  }
  // Landed means the registry was told it's ready (cloud_media `runUpload` does that before its upload ends).
  return { file: one.drive ?? one.source, source: one.source, key: one.key, name: one.name, size };
}

/** What ends the waits of `upFromHere` from before a `reset` (tests' restarts). */
const stops = new Set<(error: Error) => void>();

/** Every script's uploads a restart cut off, carried on; copies an import stopped for good no longer needs, let go. */
export function start(app: App): void {
  home = app.store.home;
  const data = store.dataDir(home);
  for (const id of store.ids(data)) {
    const dir = store.scriptDir(data, id);
    const list = readHeld(dir);
    if (list.length === 0) continue;
    let importing = false;
    try {
      importing = store.read(dir).status === "processing";
    } catch {
      importing = false;
    }
    for (const one of list) {
      const path = join(dir, one.path);
      if (!one.landed || !isFile(path)) {
        // A download cut off: an import carrying on picks it up; one that won't, never needs it.
        if (!importing) drop(dir, one);
        continue;
      }
      if (!importing) settle(dir, one.source, (kept) => void (kept.piece = true));
      if (!one.up) goUp(dir, one, Promise.resolve(path));
    }
  }
}

/** For tests: the uploads going on now, done. */
export async function settled(): Promise<void> {
  while (going.size > 0) await Promise.all([...going.values()]);
}

/** For tests. */
export function reset(): void {
  home = null;
  going.clear();
  for (const stop of stops) stop(new Error("stopped"));
  stops.clear();
}

/**
 * A cloud original read on this Mac instead of from its address: an AVI (a
 * DVR's is read faster whole, once, than by the two openings a piece reads
 * from a link, each jumping about the file: `media.isAvi`), or one whose
 * address didn't read, so nothing readable is dropped for how the cloud
 * serves it. Downloaded once into the script's scratch folder, picking up a
 * partial a stopped run left; the caller removes it once its piece is made.
 */
export async function readHere(dir: string, put: InCloud, onBytes: (bytes: number) => void = () => {}): Promise<string> {
  // In the dot folder, which the script's sync leaves alone (in scratch/ a sync round could have sent it up as the script's own).
  fs.rmSync(join(dir, "scratch", "read-here"), { recursive: true, force: true });
  const into = join(dir, HERE, "read-here");
  fs.mkdirSync(into, { recursive: true });
  const dest = join(into, put.key.split("/").slice(-2).join("-"));
  await cloud.download(put.key, dest, (received) => onBytes(received));
  return dest;
}

/**
 * A YouTube video's original put in the cloud: downloaded by yt-dlp's own
 * downloader into this script's scratch folder (by the same routes, resuming
 * a stopped try, its bytes retried piece by piece), uploaded, and deleted
 * here. It was streamed through FFmpeg (`--downloader ffmpeg` to stdout,
 * Oct 30): one connection read at about the video's own speed, which nothing
 * could resume, so a single drop anywhere in a 25-minute video stopped the
 * whole import from the start (Oct 31, Kroger: "yt-dlp stopped part-way
 * (exit 1)" at 5%, on three Macs). The file is kept in `.originals/`
 * until its piece is made and it's up: behind the import when there's room
 * to keep it (`room.roomFor`), else before the import goes on, as it was.
 */
export async function fromYoutube(app: App, dir: string, url: string, onBytes: (bytes: number) => void): Promise<InCloud> {
  const id = youtube.videoId(url);
  if (id === null) throw new Error(`${url} isn't a YouTube video link.`);
  const source = `${youtube.PREFIX}${id}`;
  const record = (await cloud.query("edit:getMedia", { source })) as { originalReady?: boolean; originalKey?: string; name?: string; size?: number } | null;
  // Downloaded by a run a restart cut off: read from that copy, its upload carried on.
  const known = readHeld(dir).find((one) => one.source === source && one.landed && isFile(join(dir, one.path)));
  if (known !== undefined && (record?.originalKey === undefined || record.originalKey === known.key)) {
    // Read again now: kept until this run is done with it too.
    settle(dir, source, (one) => Object.assign(one, { piece: false, up: one.up || record?.originalReady === true }));
    if (record?.originalReady !== true) goUp(dir, known, Promise.resolve(join(dir, known.path)));
    keepShared(dir, null, source, known.key);
    onBytes(known.size);
    return { source, key: known.key, name: known.name, size: known.size, url: await cloud.presign(known.key, "GET", READ_SECONDS), here: join(dir, known.path) };
  }
  if (record?.originalReady === true && typeof record.originalKey === "string") {
    const url = await cloud.presign(record.originalKey, "GET", READ_SECONDS);
    // An original the stream put up (Oct 30–31) is a fragmented MP4: whole,
    // but FFmpeg reads all of it over the network to find its length, past the
    // check's minute, and the import dropped it as "Couldn't be read as video"
    // (Oct 31, Kroger, after the download was fixed). One that doesn't read is
    // downloaded again over it, which takes seconds.
    if (await readable(url)) {
      keepShared(dir, null, source, record.originalKey);
      const size = Math.max(Math.trunc(record.size ?? 0), 0);
      onBytes(size);
      return { source, key: record.originalKey, name: record.name ?? `${id}.mp4`, size, url, here: null };
    }
    diag.warn("writer", `YouTube ${id}: its original in the cloud doesn't read as video, so it's downloaded again over it`);
  }
  const title = await titleOf(app, url).catch(() => id);
  const name = segment(`${title} [${id}].mp4`);
  const key = record !== null && typeof record.originalKey === "string" ? record.originalKey : originalKey(source, name);
  if (record === null) await cloud.mutation("edit:putMedia", { source, name, originalKey: key, size: 0 });
  const into = join(dir, HERE, folderName(`youtube-${id}`));
  fs.rmSync(join(dir, "scratch", "youtube", id), { recursive: true, force: true });
  let got: { path: string; size: number };
  try {
    got = await youtube.download(app.store.home, id, into, (bytes) => onBytes(bytes));
  } catch (error) {
    // Half a video is never left as the original: none is ready until this one is.
    await cloud.mutation("edit:putMedia", { source, originalReady: false }).catch(() => {});
    await cloud.remove([key]).catch(() => {});
    fs.rmSync(into, { recursive: true, force: true });
    throw error;
  }
  const size = got.size;
  const one: Held = { source, key, name, size, path: got.path.slice(dir.length + 1), landed: true, up: false, piece: false };
  keep(dir, one);
  const address = await cloud.presign(key, "GET", READ_SECONDS);
  // Room to keep it until it's up: its piece is made from it now, and it goes up behind the import.
  if (got.path.startsWith(`${dir}/`) && room.roomFor(dir, 0)) {
    goUp(dir, one, Promise.resolve(got.path));
    keepShared(dir, null, source, key);
    diag.info("writer", `YouTube ${id} downloaded (${Math.round(size / 1e6)} MB): its piece is made from the copy on ${THIS_MACHINE} while it goes up behind the import`);
    return { source, key, name, size, url: address, here: got.path };
  }
  // Short of room: up first, as before (its piece still made from the copy here, removed once it is).
  try {
    await cloud.uploadFile(got.path, key, (sent) => onBytes(sent));
  } catch (error) {
    await cloud.mutation("edit:putMedia", { source, originalReady: false }).catch(() => {});
    await cloud.remove([key]).catch(() => {});
    drop(dir, one);
    throw error;
  }
  await cloud.mutation("edit:putMedia", { source, originalReady: true, size });
  settle(dir, source, (kept) => void (kept.up = true));
  keepShared(dir, null, source, key);
  diag.info("writer", `YouTube ${id} downloaded and put in Edit's originals (${Math.round(size / 1e6)} MB); its copy on ${THIS_MACHINE} goes once its piece is made`);
  return { source, key, name, size, url: address, here: got.path };
}
