// How fast this computer does each part of an export, measured as it does
// them, so the Export dialog's times come from this machine and not a guess
// (Sphe, Nov 17): a graphic's render in frames a second (a map's apart: its
// tiles make it much slower), the export in seconds a frame, the review copy
// in seconds a second of video, and the upload in bytes a second. Each new
// measurement moves its figure part of the way (a run that went oddly doesn't
// throw it); kept in `<home>/speeds.json` across restarts. Nothing here is
// guessed: a figure never measured is null, and the time that needs it isn't
// shown until it is.

import * as fs from "node:fs";

import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

export interface Speeds {
  /** Frames a second a graphic's render draws (and joins), a page's and a map's. */
  graphic_fps?: number;
  map_fps?: number;
  /** Seconds an export takes a frame of the edit, reused chunks and all, as exports here go. */
  export_spf?: number;
  /** Seconds the review copy and its check take a second of video. */
  copy_spv?: number;
  /** Bytes a second an upload goes at. */
  upload_bps?: number;
  /** Seconds a share's page details (words, waveform) and its publish take a second of video, once its upload is up. */
  publish_spv?: number;
  /** Bytes a second footage comes down from the cloud at (footage_ready.ts). */
  download_bps?: number;
}

/** How far each new measurement moves its figure. */
const PULL = 0.4;

const kept = new Map<string, Speeds>();

function file(home: string): string {
  return join(home, "speeds.json");
}

export function read(home: string): Speeds {
  const known = kept.get(home);
  if (known !== undefined) return known;
  let given: Speeds = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file(home), "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object") given = parsed as Speeds;
  } catch {
    // None measured yet.
  }
  kept.set(home, given);
  return given;
}

function note(home: string, key: keyof Speeds, value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const now = { ...read(home) };
  const before = now[key];
  now[key] = before === undefined ? value : before + (value - before) * PULL;
  kept.set(home, now);
  try {
    writeAtomic(file(home), JSON.stringify(now));
  } catch {
    // Kept for this run.
  }
}

/** A graphic's render: `frames` drawn in `seconds`. Short runs (a resumed render's last few frames) say little and aren't counted. */
export function noteGraphic(home: string, map: boolean, frames: number, seconds: number): void {
  if (frames < 10 || seconds < 2) return;
  note(home, map ? "map_fps" : "graphic_fps", frames / seconds);
}

/** A whole export of `frames` that took `seconds`. */
export function noteExport(home: string, frames: number, seconds: number): void {
  if (frames < 30 || seconds < 1) return;
  note(home, "export_spf", seconds / frames);
}

/** A review copy of `videoSeconds` made and checked in `seconds`. */
export function noteCopy(home: string, videoSeconds: number, seconds: number): void {
  if (videoSeconds < 5 || seconds < 0.5) return;
  note(home, "copy_spv", seconds / videoSeconds);
}

/** A share's page details and publish, for `videoSeconds` of video, done in `seconds` after its upload. */
export function notePublish(home: string, videoSeconds: number, seconds: number): void {
  if (videoSeconds < 5 || seconds < 0.2) return;
  note(home, "publish_spv", seconds / videoSeconds);
}

/** Footage coming down: `bytes` in `seconds` (a few seconds of a project being got ready here). */
export function noteDownload(home: string, bytes: number, seconds: number): void {
  if (bytes < 8_000_000 || seconds < 2) return;
  note(home, "download_bps", bytes / seconds);
}

/** An upload under way, by project: its first moment and bytes, and where it is now. */
interface Upload {
  first: [number, number];
  done: number;
  total: number;
  at: number;
}
const uploads = new Map<string, Upload>();

/** The clock (tests move it). */
export const clock = { now: () => Date.now() };

/** An upload's progress, as it goes: `done` of `total` bytes (handed to the network: ahead of what has arrived). */
export function uploadTick(_home: string, project: string, done: number, total: number): void {
  const now = clock.now();
  const was = uploads.get(project);
  // A new upload (the poster after the video, a retry): measured from here.
  const upload = was === undefined || done < was.done || total !== was.total ? { first: [now, done] as [number, number], done, total, at: now } : was;
  upload.done = done;
  upload.at = now;
  uploads.set(project, upload);
}

/**
 * The upload under way for `project` is up (the cloud has said so): it teaches the upload speed, from its first bytes
 * to now. Taught as its count reached its size, the speed was about twice the line's (Nov 22, a MacBook Air: the
 * upload guessed at about half its real time), since the count is of bytes handed to the network, several MB and a
 * part or more ahead of what has arrived, and the last parts were still on their way.
 */
export function uploadFinished(home: string, project: string): void {
  const upload = uploads.get(project);
  if (upload === undefined || upload.total <= 0) return;
  const seconds = (clock.now() - upload.first[0]) / 1000;
  const bytes = upload.total - upload.first[1];
  if (bytes > 1_000_000 && seconds >= 1) note(home, "upload_bps", bytes / seconds);
}

/** The upload under way for a project: its bytes and its own speed once it has gone a few seconds (null before). */
export function uploadOf(project: string): { done: number; total: number; bps: number | null } | null {
  const upload = uploads.get(project);
  if (upload === undefined) return null;
  const seconds = (upload.at - upload.first[0]) / 1000;
  const bytes = upload.done - upload.first[1];
  return { done: upload.done, total: upload.total, bps: seconds >= 3 && bytes > 0 ? bytes / seconds : null };
}

export function uploadEnds(project: string): void {
  uploads.delete(project);
}

/** For tests: forget what was measured. */
export function reset(): void {
  kept.clear();
  uploads.clear();
}
