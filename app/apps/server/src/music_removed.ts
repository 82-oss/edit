// Footage sound with the music taken out (music_removal.ts): one audio file per
// source, on the source's own clock, with only the stretches the edit plays
// cleaned and silence elsewhere. A marker on the file says which source it is
// and what's cleaned, so it travels with the project to every Mac. No model or
// engine change: the clip simply plays another file at the same `source_in`.

import type { Clip, Marker, Media, Project } from "./model.ts";

/** The marker on a cleaned file. */
export const MARK = "music removed";
/** A stretch of the source, in seconds. */
export type Stretch = [number, number];
export type AudioClip = Extract<Clip, { type: "audio" }>;

export interface Cleaned {
  /** The media it was cleaned from. */
  of: string;
  /** What's cleaned, in order, none overlapping. */
  stretches: Stretch[];
}

const isStretch = (value: unknown): value is Stretch =>
  Array.isArray(value) && value.length === 2 && value.every((one) => typeof one === "number" && Number.isFinite(one)) && value[0] < value[1];

/** What a media's marker says it is, or null for any other file. */
export function cleanedInfo(media: Pick<Media, "markers">): Cleaned | null {
  const note = media.markers?.find((marker) => marker.name === MARK)?.note;
  if (note === undefined) return null;
  try {
    const parsed = JSON.parse(note) as { of?: unknown; stretches?: unknown };
    if (typeof parsed.of !== "string" || !Array.isArray(parsed.stretches) || !parsed.stretches.every(isStretch)) return null;
    return { of: parsed.of, stretches: parsed.stretches };
  } catch {
    return null;
  }
}

export function cleanedMarker(info: Cleaned): Marker {
  return { time: 0, name: MARK, note: JSON.stringify(info) };
}

/** The project's cleaned file of `original`, if it has one. */
export function cleanedOf(project: Project, original: string): Media | undefined {
  return project.media.find((media) => cleanedInfo(media)?.of === original);
}

/** The media a sound really plays: a cleaned file's original, or the media itself. */
export function soundSource(project: Project, media: Media): Media {
  const of = cleanedInfo(media)?.of;
  return (of === undefined ? undefined : project.media.find((one) => one.id === of)) ?? media;
}

/** The id of the media a sound really plays (soundSource). */
export function soundSourceId(project: Project, id: string): string {
  const media = project.media.find((one) => one.id === id);
  return media === undefined ? id : soundSource(project, media).id;
}

/** Stretches joined where they touch or overlap, in order. */
export function merged(stretches: readonly Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  for (const [from, to] of [...stretches].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last !== undefined && from <= last[1] + 0.001) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** What of `wanted` isn't in `have`, however short. */
function gaps(wanted: readonly Stretch[], have: readonly Stretch[]): Stretch[] {
  const held = merged(have);
  const out: Stretch[] = [];
  for (const [from, to] of merged(wanted)) {
    let at = from;
    for (const [start, end] of held) {
      if (end <= at) continue;
      if (start >= to) break;
      if (start > at) out.push([at, start]);
      at = Math.max(at, end);
    }
    if (at < to) out.push([at, to]);
  }
  return out;
}

/** What of `wanted` isn't in `have`: the only part that's paid for (a sliver under 20 ms isn't worth a request). */
export function missing(wanted: readonly Stretch[], have: readonly Stretch[]): Stretch[] {
  return gaps(wanted, have).filter(([from, to]) => to - from >= 0.02);
}

/** Whether `have` holds all of from–to: any gap a frame could fall in means no, whatever it would cost to fill. */
export function covers(have: readonly Stretch[], from: number, to: number): boolean {
  return gaps([[from, to]], have).every(([start, end]) => end - start <= 0.001);
}

const rateOf = (project: Project) => (project.settings.ntsc === true ? (project.settings.fps * 1000) / 1001 : project.settings.fps);

/** The seconds of its source a sound plays. */
export function sourceRange(project: Project, clip: AudioClip): Stretch {
  return [clip.source_in, clip.source_in + (clip.duration / rateOf(project)) * clip.speed];
}

/**
 * Every save: a sound trimmed or extended past what's cleaned goes back to
 * its original, so the worst case is hearing the music again, never silence
 * where someone is talking. remove_music cleans the new part. Returns how many.
 */
export function enforceCleanedSound(project: Project): number {
  const cleaned = new Map<string, Cleaned>();
  for (const media of project.media) {
    const info = cleanedInfo(media);
    if (info !== null && project.media.some((one) => one.id === info.of)) cleaned.set(media.id, info);
  }
  if (cleaned.size === 0) return 0;
  let changed = 0;
  for (const clip of project.clips) {
    if (clip.type !== "audio") continue;
    const info = cleaned.get(clip.media);
    if (info === undefined) continue;
    const [from, to] = sourceRange(project, clip);
    if (covers(info.stretches, from + 0.005, to - 0.005)) continue;
    clip.media = info.of;
    changed++;
  }
  return changed;
}
