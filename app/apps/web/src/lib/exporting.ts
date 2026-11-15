// The export's model: options (as apps/server/src/exports.ts reads them),
// the house defaults, chapters from the script, and what an export will make.

import type { Project, Sections } from "./types";

export type Format = "h264" | "hevc" | "prores" | "gif" | "wav" | "mp3" | "png";
export type Shape = "original" | "vertical" | "square" | "portrait";
export type Fill = "blur" | "crop" | "black";
export type Quality = "high" | "balanced" | "small";

export interface Chapter {
  /** Frame on the timeline. */
  start: number;
  title: string;
}

export interface ExportOptions {
  format: Format;
  /** Frames `[start, end)`; the whole edit when absent. */
  range?: [number, number];
  shape: Shape;
  fill: Fill;
  /** Short side in px; the project's when null. */
  size: number | null;
  /** Output frame rate; the project's when null. */
  fps: number | null;
  quality: Quality;
  /** Aim for about this many MB instead of a quality (MP4 only). */
  target_mb: number | null;
  hardware: boolean;
  audio: boolean;
  /** Integrated loudness to normalise to (LUFS), or null to leave the mix alone. */
  loudness: number | null;
  chapters: Chapter[];
  /** YouTube's upload settings (crates/edit-engine/src/export.rs `Preset`). A share always sends `youtube`. */
  preset?: "house" | "youtube";
}

/** What an export is unless you change it: YouTube at 1080p. */
export const DEFAULTS: Omit<ExportOptions, "range" | "chapters"> = {
  format: "h264",
  shape: "original",
  fill: "blur",
  size: 1080,
  fps: null,
  quality: "high",
  target_mb: null,
  hardware: true,
  audio: true,
  loudness: -14,
};

/** A cut-in's words cut down to a chapter title. */
function chapterTitle(text: string) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const head = words.slice(0, 7).join(" ").replace(/[\s,;:.–—-]+$/, "");
  return words.length > 7 ? `${head}…` : head;
}

/**
 * Chapters from the script: the intro, then a chapter at each cut-in of the
 * story named by its words, then the outro.
 */
export function scriptChapters(project: Project, sections: Sections | null): Chapter[] {
  if (!sections?.parts.length) return [];
  const words = new Map<number, string>();
  for (const block of project.script?.blocks ?? []) {
    if (block.kind !== "narration" || !block.clip) continue;
    const clip = project.clips.find((candidate) => candidate.id === block.clip);
    if (clip) words.set(clip.start, block.text);
  }
  const chapters: Chapter[] = [];
  if (sections.intro) chapters.push({ start: 0, title: "Intro" });
  for (const part of sections.parts) {
    const inStory = !sections.intro || part.start >= sections.intro[1];
    if (part.kind === "broll" && inStory) chapters.push({ start: part.start, title: chapterTitle(words.get(part.start) ?? "Story") });
    if (part.kind === "outro") chapters.push({ start: part.start, title: "Outro" });
  }
  return chapters;
}

/** YouTube's rule: chapters at least this far apart (seconds). */
const LEAST_CHAPTER = 10;

/**
 * The chapters that fall in `span`, the first moved to its start and none
 * closer than 10 s to the one before (YouTube ignores lists that break that).
 * Starts stay timeline frames.
 */
export function chaptersInSpan(chapters: Chapter[], span: [number, number], fps: number): Chapter[] {
  const [start, end] = span;
  // Too-close chapters merge into the one before them, the same for every span.
  const merged = spaced(chapters, fps);
  // The one already running at the span's start opens it.
  const opening = merged.filter((chapter) => chapter.start <= start).at(-1);
  const list = [...(opening ? [{ ...opening, start }] : []), ...merged.filter((chapter) => chapter.start > start && chapter.start < end)];
  return spaced(list, fps).filter((chapter, index) => index === 0 || (end - chapter.start) / fps >= LEAST_CHAPTER);
}

/** Drops chapters starting less than 10 s after the one kept before them. */
function spaced(chapters: Chapter[], fps: number) {
  const kept: Chapter[] = [];
  for (const chapter of [...chapters].sort((a, b) => a.start - b.start)) {
    const last = kept.at(-1);
    if (!last || (chapter.start - last.start) / fps >= LEAST_CHAPTER) kept.push(chapter);
  }
  return kept;
}
