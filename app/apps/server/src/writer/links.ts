// Footage a message to a script brings (Sphe, Nov 11: "we want to now,
// afterwards, add the YouTube link to the script and have the agent add it
// there"; Nov 18: "if there's a clip that I'm like, 'Okay, I just want to
// quickly add that' … when I paste in my Google Drive link or YouTube link and
// I say, 'We need to add this to the script somehow,' that needs to be
// possible"). A YouTube video, a Drive file, every recording of a Drive folder,
// the video on any other page, or a file attached to the message (uploaded to
// the script first, `receiveUpload`) comes down the way an import's does
// (YouTube checked on its Data API first, Drive with the team's sign-in), is
// joined after the script's footage as a recording of its own (as a
// compilation's reused case is, reuse.ts), heard whole by Scribe at once (no
// free first hearing: it's one piece, wanted now), and its voices named. The
// footage already there keeps every time. Then Claude revises the script on
// the message, told which recordings are new, so the footage goes where and
// how the producer asked (or writes the first draft, on a script not built
// yet). The job is one, so the chat says each step as it goes and the script
// is never edited twice at once; a restart carries it on without adding
// anything twice.

import * as fs from "node:fs";

import type { Focus, Part, Word } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as editCloud from "../cloud.ts";
import * as diag from "../diag.ts";
import { bytesSaid, fetchLink, linkOf, type Link } from "../links.ts";
import { fileName, isFile, join, parent } from "../paths.ts";
import { driveFileId, footageFile } from "../script.ts";
import * as room from "../storage.ts";
import type { Transcript } from "../transcribe.ts";
import * as uploads from "../uploads.ts";
import { videoId } from "../youtube.ts";
import * as chat from "./chat.ts";
import * as drive from "./drive.ts";
import { keepShared, originalKey, sha256Of } from "./handoff.ts";
import * as hearing from "./hearing.ts";
import { previewRoom } from "./imports.ts";
import { checkStopped, type Job, type Outcome } from "./jobs.ts";
import * as media from "./media.ts";
import { caseNames } from "./names.ts";
import { nameNewVoices } from "./reuse.ts";
import { buildAndReview, reviseWith, scriptFreshEyes } from "./scripting.ts";
import * as storage from "./storage.ts";
import * as store from "./store.ts";
import { keepPeaks, readPeaks } from "./tidy.ts";
import { onClock } from "./transcription.ts";
import * as ytw from "./youtube.ts";
import { THIS_MACHINE } from "../machine.ts";

const URL_IN_TEXT = /https?:\/\/[^\s<>"'\]]+/gu;

/** Where this job keeps what it's working on, in the script's folder: a dot folder, so never synced and never taken for a recording. */
const WORK = ".added";
/** Files attached to a chat message wait here, a folder each, until the message adds them. */
const UPLOADS = `${WORK}/uploads`;
/** Recordings at once: each downloaded, made ready to join and heard in its own lane, as an import's three. */
const LANES = 3;
/** A 1080p H.264 download's bytes a millisecond (~2 GB an hour), for a YouTube video's room before it's down. */
const YOUTUBE_BYTES_PER_MS = 560;
/** An attached file not sent with a message after this long is let go. */
const UPLOAD_KEPT_MS = 2 * 24 * 3_600_000;

/**
 * The footage links in a message, each once: what it adds before it's
 * revised. A Drive folder is all its recordings; a Doc isn't footage, nor are
 * Writer's own links (a script, a review). Any other page may have a video on
 * it, and is left as words when it hasn't (`notFootage`).
 */
export function footageLinks(text: string): string[] {
  const out: string[] = [];
  for (const raw of ytw.secure(text).match(URL_IN_TEXT) ?? []) {
    const trimmed = raw.replace(/[.,;:!?)\]]+$/u, "");
    let url: string;
    if (folderLink(trimmed)) url = trimmed;
    else {
      let link: Link;
      try {
        link = linkOf(trimmed);
      } catch {
        continue;
      }
      url = link.url;
    }
    const host = new URL(url).hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".ts.net") || host === "127.0.0.1" || host.endsWith("spheceo.com") || host.endsWith("trello.com")) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

const folderLink = (url: string): boolean => {
  try {
    return drive.parse(url).kind === "folder";
  } catch {
    return false;
  }
};

/** What a recording is known by in the script, so the same one is never added twice: its registry name for YouTube and Drive, its link for any other page, its upload for a file. */
function keyOf(given: { url?: string | undefined; upload?: string | undefined }): string | null {
  if (given.upload !== undefined) return `upload:${given.upload}`;
  if (given.url === undefined) return null;
  const video = videoId(given.url);
  if (video !== null) return `youtube:${video}`;
  const file = driveFileId(given.url);
  return file !== null ? `drive:${file}` : given.url;
}

/** A recording's title from the file it came down as: "Bodycam 4 [abc].mp4" is "Bodycam 4". */
const titleOf = (name: string): string => name.replace(/\.[A-Za-z0-9]{2,4}$/u, "").replace(/\s*\[[^\]]+\]$/u, "").trim() || "Added footage";

/** One recording to add: how it's known, what it's called until it's down, what it takes here, and how it comes down. */
interface Piece {
  key: string;
  /** Its link, kept as the part's: what its timestamps link to and where Start the edit finds it. */
  url?: string;
  /** An attached file's upload id. */
  upload?: string;
  title: string;
  /** Its bytes still to come down, and its length, when known: what the room check counts before it comes. */
  size: number;
  ms: number | null;
  /** Any other page: one with no video on it is an article, left as the message's words. */
  page?: boolean;
  /** Brings it here: its file and the name it came as. */
  get(say: (line: string) => void, signal: AbortSignal): Promise<{ path: string; name: string }>;
  /** What of it this Mac lets go once it's in (with the cloud on: the cloud's copy or its link is what's kept). */
  letGo(path: string): void;
}

const keepWithoutCloud = (remove: () => void) => () => {
  if (editCloud.enabled()) remove();
};

/** What's known of a YouTube video already (the footage search read it on the Data API, finder.ts): it isn't checked again. */
export interface Known {
  title: string;
  ms: number;
}

/** A link's recordings: one for a video, every one for a Drive folder. Throws why one can't be added before anything comes down. */
async function piecesOf(app: App, dir: string, url: string, known?: Known): Promise<Piece[]> {
  if (drive.isDrive(url)) {
    const link = drive.parse(url);
    let token: string;
    let listed: drive.Recording[];
    try {
      token = await drive.hooks.accessToken();
      [, listed] = await drive.recordings(token, link);
    } catch (error) {
      // A file not shared with the team's account may still be shared by its link: downloaded as Edit mode does.
      if (link.kind === "folder") throw error;
      diag.info("writer", `${url}: not read with the team's Drive sign-in (${diag.messageOf(error)}); downloading it by its link`);
      return [byLink(app, linkOf(url))];
    }
    return listed.map((recording): Piece => {
      const title = drive.stem(recording.name) || "Drive recording";
      const ext = recording.name.includes(".") ? recording.name.split(".").pop()!.toLowerCase() : "";
      const dest = join(dir, WORK, "drive", `${recording.id}.${/^[a-z0-9]{1,5}$/u.test(ext) ? ext : "mp4"}`);
      const done = () => isFile(dest) && recording.size > 0 && fs.statSync(dest).size === recording.size;
      return {
        key: `drive:${recording.id}`,
        // Its own file's link, a shortcut's target's: what Start the edit fetches, and what a restart finds it in by.
        url: drive.fileLink(recording.id),
        title,
        size: done() ? 0 : recording.size,
        ms: recording.claimedMs ?? null,
        get: async (say, signal) => {
          if (!done()) {
            fs.mkdirSync(join(dir, WORK, "drive"), { recursive: true });
            // Asked each time: a folder's last recordings come down after the first hour's token ran out.
            await drive.download(await drive.hooks.accessToken(), recording, dest, (bytes) => say(`Downloading “${title}” · ${bytesSaid(bytes, recording.size || null)}`), signal);
          }
          return { path: dest, name: recording.name };
        },
        letGo: keepWithoutCloud(() => fs.rmSync(dest, { force: true })),
      };
    });
  }
  const link = linkOf(url);
  if (link.kind !== "youtube") return [byLink(app, link)];
  if (known !== undefined) return [{ ...byLink(app, link), title: known.title || "Linked video", size: known.ms * YOUTUBE_BYTES_PER_MS, ms: known.ms }];
  // Checked on YouTube's Data API first, as New script checks a video: a private, removed or live one is said before any download.
  const probe = await ytw.probe(app, link.url).catch(() => null);
  // A video's length is no reason (Nov 18: a script takes all its footage).
  const tooLong = probe?.durationMs != null && probe.durationMs > 10 * 3_600_000;
  if (probe?.problem && !tooLong) throw new Error(probe.problem);
  const ms = probe?.durationMs ?? null;
  return [{ ...byLink(app, link), title: probe?.title || "Linked video", size: ms === null ? 0 : ms * YOUTUBE_BYTES_PER_MS, ms }];
}

/** A video by its link, through Edit's own download (YouTube's, Drive's public link, yt-dlp on any page), into Edit's footage folder where Edit mode finds it too. */
function byLink(app: App, link: Link): Piece {
  return {
    key: keyOf({ url: link.url })!,
    url: link.url,
    title: link.kind === "page" ? new URL(link.url).hostname.replace(/^www\./u, "") : "Linked video",
    size: 0,
    ms: null,
    ...(link.kind === "page" ? { page: true } : {}),
    get: async (say) => fetchLink(app, link, (bytes, total, name) => say(`Downloading “${titleOf(name)}” · ${bytesSaid(bytes, total)}`)),
    letGo: (path) => keepWithoutCloud(() => fs.rmSync(parent(path) ?? path, { recursive: true, force: true }))(),
  };
}

/** A file attached to the message, as it waits in the script's folder; null when it isn't there. */
function attached(dir: string, upload: string): Piece | null {
  const folder = uploadFolder(dir, upload);
  const name = folder === null ? undefined : listed(folder).find((one) => !one.endsWith(".uploading"));
  if (folder === null || name === undefined) return null;
  const path = join(folder, name);
  return {
    key: `upload:${upload}`,
    upload,
    title: titleOf(name),
    size: 0,
    ms: null,
    get: async () => ({ path, name }),
    letGo: keepWithoutCloud(() => fs.rmSync(folder, { recursive: true, force: true })),
  };
}

const listed = (folder: string): string[] => {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
};

/** An upload's folder, refusing an id that isn't one. */
function uploadFolder(dir: string, upload: string): string | null {
  return /^[0-9a-f-]{36}$/u.test(upload) ? join(dir, UPLOADS, upload) : null;
}

/** The names of the attached files, as the chat shows them on the message. */
export function attachedNames(dir: string, files: readonly string[]): string[] {
  return files.flatMap((upload) => {
    const folder = uploadFolder(dir, upload);
    const name = folder === null ? undefined : listed(folder).find((one) => !one.endsWith(".uploading"));
    return name === undefined ? [] : [name];
  });
}

/** Refuses a message whose attached file isn't here (sent twice, or let go): attach it again. */
export function checkAttached(dir: string, files: readonly string[]): void {
  for (const upload of files) if (attached(dir, upload) === null) throw new Error("An attached file isn't on this computer any more. Attach it again.");
}

/**
 * A file attached to a message in the script's chat, streamed into the
 * script's folder (never held in memory: footage runs to many GB) until the
 * message adds it. Refused when it isn't video or sound, or there's no room
 * for it. Its upload id, which the message names it by.
 */
export async function receiveUpload(dir: string, request: Request, given: string, size: number | null): Promise<{ upload: string; name: string }> {
  const name = fileName(given)?.trim() ?? "";
  if (name === "" || name.startsWith(".")) throw new Error("That file has no name.");
  if (size === 0) throw new Error(`${name} is empty.`);
  sweepUploads(dir);
  const short = room.admit(dir, size ?? 0, `Attaching ${name}`, "attach it again");
  if (short !== null) throw new Error(short);
  const upload = crypto.randomUUID();
  const folder = join(dir, UPLOADS, upload);
  fs.mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  try {
    // No size limit: the room is the limit (Nov 18, a script takes all its footage).
    await uploads.receive(request, `${path}.uploading`, size, Number.MAX_SAFE_INTEGER);
    const found = await media.streams(path).catch(() => null);
    if (found === null || found.durationMs <= 0 || (!found.video && !found.audio)) throw new Error(`${name} isn't video or sound, so it can't be added to the footage.`);
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  return { upload, name };
}

/** Attached files no message took (the message was never sent), let go after two days. */
function sweepUploads(dir: string): void {
  for (const upload of listed(join(dir, UPLOADS))) {
    const folder = join(dir, UPLOADS, upload);
    try {
      if (Date.now() - fs.statSync(folder).mtimeMs > UPLOAD_KEPT_MS) fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }
}

/** Refuses a recording this Mac has no room to add: `size` still to come down, its preview piece and the preview copied with it on the end. */
function checkRoom(dir: string, size: number, ms: number | null): void {
  let base = 0;
  try {
    base = fs.statSync(store.proxyPath(dir)).size;
  } catch {
    // Brought back from the cloud first, counted then.
  }
  const short = room.admit(dir, size + previewRoom([{ size, claimedMs: ms }]) + base + 1_000_000_000, "Adding this footage", "try again");
  if (short !== null) throw new Error(short);
}

/** A page whose link yt-dlp has no video for: an article, not footage. */
const notFootage = (message: string): boolean => /unsupported url|no video formats|no video could be found|no media found/iu.test(message);

/** A recording down, made ready to join and heard: everything but its place in the script. */
interface Ready {
  piece: Piece;
  title: string;
  path: string;
  name: string;
  segment: string;
  lengthMs: number;
  video: boolean;
  heard: Transcript | null;
  work: string;
  shared: Pick<Part, "mediaSource" | "originalKey">;
  peaks: Float32Array;
}

/** What a message that brings footage asks for (jobs.ts `link`). */
export interface Adding {
  urls: string[];
  files?: string[];
  build?: boolean;
  request: string;
  focus: Focus;
}

/**
 * Adds the footage `adding` brings to the script, then revises it on the
 * message's words (or builds it, `adding.build`). A recording already added
 * (a restart after it went in) isn't added again; one that can't be had is
 * said in the chat, and the rest go on.
 */
export async function addFootage(app: App, data: string, id: string, adding: Adding, job: Job): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  const files = adding.files ?? [];
  // Said as the build says it, so the build it hands on to doesn't say it again.
  const said = adding.build ? (adding.request.trim() === "" ? "Build the script." : `Build the script. ${adding.request.trim()}`) : adding.request;
  chat.asked(dir, said, job.resumed, attachedNames(dir, files));
  const failed: string[] = [];
  let brought: Piece[];
  try {
    brought = await addAll(app, dir, adding.urls, files, failed, job);
  } catch (error) {
    // The message's answer, as a revision's failure is: nothing was revised.
    if (!job.signal.aborted) chat.add(dir, "editor", diag.messageOf(error), null, true);
    throw error;
  }
  // What's new, named for Claude by its recording; what couldn't come is said in the chat in a line of its own.
  const now = store.read(dir);
  const parts = now.parts ?? [];
  const unit = now.compilation ? "Video" : "Recording";
  const named = brought.flatMap((piece) => {
    const at = parts.findIndex((part) => part.reuse === undefined && keyOf(part) === piece.key);
    if (at < 0) return [];
    const from = piece.upload !== undefined ? "the file attached to this message" : `the footage from ${piece.url}`;
    return [`${unit} ${at + 1} ("${parts[at]!.title}") is ${from}`];
  });
  if (failed.length > 0) chat.add(dir, "editor", `${failed.join(". ")}.`, null, true);
  const notes = [
    ...(named.length > 0 ? [`The footage this message brings is in the script now, its words heard: ${named.join("; ")}. Use it as asked.`] : []),
    ...(failed.length > 0 ? [`Footage that couldn't be added (the producer has been told): ${failed.join("; ")}. Do what the rest of the message asks with the footage there is.`] : []),
  ];
  const told = notes.length === 0 ? adding.request : `${adding.request}\n\n(${notes.join(" ")})`;
  // Carried on as the step it hands on to, which doesn't say the message again (Claude's turn says so as a revision's does).
  if (adding.build) {
    job.stage("Starting");
    return await buildAndReview(app, data, id, adding.request, undefined, scriptFreshEyes(undefined), { ...job, resumed: true });
  }
  job.stage("Editing the script");
  return await reviseWith(data, id, told, adding.request, adding.focus, false, { ...job, resumed: true });
}

/**
 * YouTube videos the footage search chose (finder.ts), added as a message's
 * links are but with no revision after: each with what the Data API said of
 * it. What couldn't be is put in `failed`. Each one in, by its link: the
 * recording it is (1 for Recording 1) and its part.
 */
export async function addVideos(app: App, dir: string, videos: (Known & { url: string })[], failed: string[], job: Job): Promise<Map<string, { number: number; part: Part }>> {
  await addAll(app, dir, videos.map((one) => one.url), [], failed, job, new Map(videos.map((one) => [one.url, one])));
  const parts = store.read(dir).parts ?? [];
  const out = new Map<string, { number: number; part: Part }>();
  for (const one of videos) {
    const key = keyOf({ url: one.url });
    const at = parts.findIndex((part) => part.reuse === undefined && keyOf(part) === key);
    if (at >= 0) out.set(one.url, { number: at + 1, part: parts[at]! });
  }
  return out;
}

/** What a script has already, each by its key (`youtube:<id>`, `drive:<id>`…): what the footage search never adds again. */
export function keysIn(script: { parts?: Part[] | undefined; sourceUrl?: string | null | undefined }): Set<string> {
  const keys = new Set((script.parts ?? []).flatMap((part) => keyOf(part) ?? []));
  const own = script.sourceUrl ? keyOf({ url: script.sourceUrl }) : null;
  if (own !== null) keys.add(own);
  return keys;
}

/** Every recording `urls` and `files` bring, added to the footage but those already in; what couldn't be is put in `failed`. The recordings asked for. */
async function addAll(app: App, dir: string, urls: string[], files: string[], failed: string[], job: Job, known = new Map<string, Known>()): Promise<Piece[]> {
  const script = store.read(dir);
  if (script.commentary) throw new Error("A commentary takes its videos as sources: add them under Sources.");
  const pieces: Piece[] = [];
  for (const url of urls) {
    checkStopped(job);
    try {
      pieces.push(...(await piecesOf(app, dir, url, known.get(url))));
    } catch (error) {
      if (job.signal.aborted) throw error;
      failed.push(`${url} couldn't be added (${diag.messageOf(error)})`);
    }
  }
  const inScript = new Set((script.parts ?? []).flatMap((part) => keyOf(part) ?? []));
  for (const upload of files) {
    const piece = attached(dir, upload);
    if (piece !== null) pieces.push(piece);
    else if (inScript.has(`upload:${upload}`)) pieces.push({ key: `upload:${upload}`, upload, title: "", size: 0, ms: null, get: () => Promise.reject(new Error("in already")), letGo: () => {} });
    else failed.push("An attached file isn't on this computer any more, so it wasn't added (attach it again)");
  }
  const wanted = pieces.filter((piece, at) => !inScript.has(piece.key) && pieces.findIndex((one) => one.key === piece.key) === at);
  if (wanted.length === 0) return pieces;
  // Every request listens for the case's names, as an import's hearing does.
  const keyterms = await caseNames(dir, script).catch(() => []);
  const ready = await prepareAll(app, dir, wanted, keyterms, failed, job);
  if (ready.length > 0) diag.info("writer", `${script.id}: added ${(await joinOn(dir, ready, keyterms, job)).join(", ")}`);
  return pieces;
}

/** `work` over `items`, `count` at a time, each in its own order. */
async function lanes<T>(items: T[], count: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    for (let at = next++; at < items.length; at = next++) await work(items[at]!, at);
  };
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, lane));
}

/** Each recording brought here, made ready to join and heard, three at a time; the ones that came, in the order given. */
async function prepareAll(app: App, dir: string, pieces: Piece[], keyterms: string[], failed: string[], job: Job): Promise<Ready[]> {
  const script = store.read(dir);
  // Joining onto the preview needs the file itself: back from the cloud if it was left there.
  if (!isFile(store.proxyPath(dir))) await storage.bringBack(app, store.dataDir(app.store.home), script.id, job, true);
  if (!isFile(store.proxyPath(dir))) throw new Error(`The preview isn't on ${THIS_MACHINE} or in the cloud. Restore the footage first.`);
  const out: (Ready | null)[] = pieces.map(() => null);
  const lost: (string | null)[] = pieces.map(() => null);
  let done = 0;
  const of = () => (pieces.length > 1 ? ` · ${done} of ${pieces.length} in` : "");
  await lanes(pieces, LANES, async (piece, index) => {
    try {
      out[index] = await prepare(dir, piece, keyterms, (line) => job.stage(`${line}${of()}`), job);
      done++;
    } catch (error) {
      if (job.signal.aborted) throw error;
      const why = diag.messageOf(error);
      diag.warn("writer", `${script.id}: ${piece.url ?? piece.title} wasn't added: ${why}`);
      // A page with no video on it was an article: it stays the message's words, as it was.
      if (!(piece.page && notFootage(why))) lost[index] = `${piece.url ?? piece.title} couldn't be added (${why})`;
    }
  });
  checkStopped(job);
  failed.push(...lost.flatMap((line) => line ?? []));
  return out.flatMap((one) => one ?? []);
}

/** One recording down, encoded as the preview is, heard by Scribe, its peaks read and its original shared with Edit. */
async function prepare(dir: string, piece: Piece, keyterms: string[], say: (line: string) => void, job: Job): Promise<Ready> {
  checkRoom(dir, piece.size, piece.ms);
  say(`Downloading “${piece.title}”`);
  const got = await piece.get(say, job.signal);
  checkStopped(job);
  const title = piece.upload !== undefined || piece.page || piece.title === "Linked video" ? titleOf(got.name) : piece.title;
  const found = await media.streams(got.path).catch(() => {
    throw new Error(`${title} couldn't be read as video or sound`);
  });
  const held = await media.playableMs(got.path, found.durationMs);
  // Its length known now: room for its piece and the preview it's copied onto.
  if (piece.ms === null) checkRoom(dir, 0, held);
  const slot = Bun.hash(piece.key).toString(16);
  const segment = join(dir, WORK, "segments", `${slot}.mp4`);
  if (!(await media.readable(segment))) {
    fs.mkdirSync(join(dir, WORK, "segments"), { recursive: true });
    const making = join(dir, WORK, "segments", `${slot}.making.mp4`);
    await media.joinLike([{ path: got.path, streams: { ...found, durationMs: held } }], making, store.proxyPath(dir), (percent) => say(`Preparing “${title}” · ${percent}%`), job.signal);
    fs.renameSync(making, segment);
  }
  // Heard whole by Scribe from the file itself (full quality), kept until its recording's place is known; its sound's
  // peaks read and its original shared with Edit meanwhile (after the hearing, these held "Transcribing" for minutes).
  say(`Transcribing “${title}”`);
  const work = join(dir, "transcript", `added-${slot}`);
  const [heard, shared, peaks] = await Promise.all([
    found.audio ? hearing.hear(got.path, null, work, keyterms, job.signal) : Promise.resolve(null),
    shareOriginal(dir, piece.url ?? null, got.path, got.name),
    media.peaks(segment, job.signal).catch(() => new Float32Array()),
  ]);
  checkStopped(job);
  return { piece, title, path: got.path, name: got.name, segment, lengthMs: (await media.streams(segment)).durationMs, video: found.video, heard, work, shared, peaks };
}

/**
 * The recordings joined after the footage, in one copy of the preview, and
 * saved into the script with their words on its clock, after everything
 * already there, and their voices named. What each went in as.
 */
async function joinOn(dir: string, ready: Ready[], keyterms: string[], job: Job): Promise<string[]> {
  const script = store.read(dir);
  const base = store.proxyPath(dir);
  const joined = join(dir, WORK, "footage.mp4");
  const what = ready.length === 1 ? `“${ready[0]!.title}”` : `${ready.length} recordings`;
  job.stage(`Adding ${what} to the footage`);
  await media.append(base, ready.map((one) => one.segment), joined, (percent) => job.stage(`Adding ${what} to the footage · ${percent}%`), job.signal);
  // Their places among the recordings: after Recording 1 when the script had one recording and no parts yet.
  const first = Math.max((script.parts ?? []).length, 1);
  const parts: Part[] = [];
  const words: Word[] = [];
  const heardSpans: [number, number][] = [];
  let startMs = script.durationMs;
  for (const [step, one] of ready.entries()) {
    const number = first + step + 1;
    parts.push({ title: one.title, startMs, durationMs: one.lengthMs, audio: !one.video, ...(one.piece.url !== undefined ? { url: one.piece.url } : {}), ...(one.piece.upload !== undefined ? { upload: one.piece.upload } : {}), ...one.shared });
    // Each recording's voices are its own ("3:speaker_0"), named below.
    if (one.heard !== null) {
      words.push(...onClock(one.heard, startMs, one.lengthMs, String(number)).map((word) => ({ ...word, id: `w-${crypto.randomUUID()}` })));
      heardSpans.push([startMs, startMs + one.lengthMs]);
    }
    startMs += one.lengthMs;
  }
  // The sound, extended: each 20 ms of the new footage after the old. One array, never `push(...more)`: a spread of a
  // long video's peaks (2 M past ~11 h) overflows the stack.
  const before = readPeaks(dir) ?? (await media.peaks(base, job.signal).catch(() => new Float32Array()));
  const head = Math.floor(script.durationMs / 20);
  const peaks = Array.from({ length: head }, (_, at) => before[at] ?? 0);
  for (const one of ready) for (let at = 0; at < Math.floor(one.lengthMs / 20); at++) peaks.push(one.peaks[at] ?? 0);
  // Into the script as it is now: only the footage, its words and sound are this job's to write.
  const now = store.read(dir);
  if (now.durationMs !== script.durationMs || (now.parts ?? []).length !== (script.parts ?? []).length || now.words.length !== script.words.length || now.revision !== script.revision) {
    throw new Error("The script changed while the footage was coming in, so it wasn't added. Ask again (the downloads and their words are kept).");
  }
  if ((now.parts ?? []).length === 0) now.parts = [{ title: now.title, startMs: 0, durationMs: now.durationMs, audio: !(await media.streams(base)).video, ...(now.sourceUrl ? { url: now.sourceUrl } : {}) }];
  if ((now.parts ?? []).length === 1) {
    // Its one recording heard as the whole file is kept under the name the first of several has, so it isn't heard again.
    const whole = join(dir, "transcript", "whole");
    const firstKey = join(dir, "transcript", "part-01");
    if (fs.existsSync(whole) && !fs.existsSync(firstKey)) fs.cpSync(whole, firstKey, { recursive: true });
  }
  // Each hearing kept under its recording's name (transcription.ts `recordings`), so neither Start the edit nor the exact pass hears it again.
  ready.forEach((one, step) => {
    const key = join(dir, "transcript", `part-${String(first + step + 1).padStart(2, "0")}`);
    if (one.heard !== null && fs.existsSync(one.work) && !fs.existsSync(key)) fs.cpSync(one.work, key, { recursive: true });
  });
  now.words.push(...words);
  now.parts = [...(now.parts ?? []), ...parts];
  now.durationMs = Math.max((await media.streams(joined)).durationMs, startMs);
  now.originalPath = base;
  now.overview = media.overview(peaks, 800);
  // Heard exactly already: the exact pass doesn't hear it again.
  if (heardSpans.length > 0) {
    if ((now.exact ?? []).length === 0) now.exactKeyterms = [...keyterms];
    now.exact = [...(now.exact ?? []), ...heardSpans];
  }
  if (words.length > 0) {
    job.stage(ready.length === 1 ? `Reading who speaks in “${ready[0]!.title}”` : "Reading who speaks in the new footage");
    await nameNewVoices(now, dir, words.length, String(first + 1), job.signal);
  }
  checkStopped(job);
  if (store.read(dir).revision !== now.revision) throw new Error("The script changed while the footage was being heard. Ask again (the downloads and their words are kept).");
  fs.renameSync(joined, base);
  keepPeaks(dir, peaks);
  now.revision++;
  now.updatedAt = Date.now();
  store.write(dir, now);
  // In now: what was kept to get here goes (with the cloud on, the download too: the script plays its preview, and
  // Edit fetches the link, or the original shared above, when the edit starts, so hours of footage never sit here).
  for (const one of ready) {
    one.piece.letGo(one.path);
    fs.rmSync(one.segment, { force: true });
    fs.rmSync(one.work, { recursive: true, force: true });
  }
  return parts.map((part, step) => `${part.title} as Recording ${first + step + 1} (${Math.round(part.durationMs / 1000)} s)`);
}

/** Where Edit finds an added recording: nothing more for a link it fetches itself (YouTube, Drive, a post); else its original in Edit's originals, by its content. */
async function shareOriginal(dir: string, url: string | null, path: string, name: string): Promise<Pick<Part, "mediaSource" | "originalKey">> {
  if ((url !== null && footageFile(url) !== null) || !editCloud.enabled()) return {};
  const source = `sha256:${await sha256Of(path)}`;
  const size = fs.statSync(path).size;
  let record = (await editCloud.query("edit:getMedia", { source })) as Record<string, unknown> | null;
  const key = typeof record?.originalKey === "string" ? record.originalKey : originalKey(source, name);
  if (record?.originalReady !== true) {
    if (record === null) await editCloud.mutation("edit:putMedia", { source, name, originalKey: key, size });
    await editCloud.uploadFile(path, key);
    record = (await editCloud.mutation("edit:putMedia", { source, originalReady: true, size })) as Record<string, unknown> | null;
  }
  keepShared(dir, null, source, key);
  return { mediaSource: source, originalKey: key };
}
