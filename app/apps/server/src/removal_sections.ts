// The sections of an edit, for what's asked of removal by place (Sphe and
// JJ, Nov 18): the intro (the opening before the first case: edit_core's
// sections, the teasers up to the "On <date>" cut-in) and each case after it.
// "Take their subtitles out of case 3", "the intro too" is one start_removal
// with the case or the intro (removal_schedule.ts); every section's text
// comes out the same way, a blur tracked tight over their words (text_blur.ts),
// and only where the agent marked it (removal_asks.ts `marked`: its in and
// out points, from what burned_subtitles.ts proposes and what it saw itself).
// Their see-through watermarks (the engine's, free) come out of the whole
// video whatever the section.
//
// The cases are what the project records: a footage block's "Case N" note (a
// compilation's pasted sources, a case inserted later), else the reused
// script it came from, else the recording it plays (Writer's compilations: a
// case a recording). A video that isn't a compilation (the project's or its
// channel's `compilation`) is its intro and one case. A case starts where its
// footage first shows after the intro and runs to where the next one's does.

import * as channels from "./channels.ts";
import type { Project, VideoClip } from "./model.ts";
import { native } from "./native/index.ts";
import { clipEnd, duration, fps as fpsOf, REUSED_SCRIPT_NOTE } from "./project.ts";
import { jsonForSerde } from "./rust.ts";

export type Spans = [number, number][];

/** One part of the edit, timeline frames [start, end). */
export interface Part {
  /** "the intro", "case 2", or "the case" in a video of one. */
  name: string;
  /** Its case's number from 1; null for the intro. */
  case: number | null;
  start: number;
  end: number;
}

export function merged(spans: Spans): Spans {
  const out: Spans = [];
  for (const [a, b] of [...spans].filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export const intersect = (a: Spans, b: Spans): Spans => merged(a.flatMap(([x, y]) => b.flatMap(([u, v]): Spans => (Math.min(y, v) > Math.max(x, u) ? [[Math.max(x, u), Math.min(y, v)]] : []))));

export function minus(spans: Spans, holes: Spans): Spans {
  let out = merged(spans);
  for (const [a, b] of holes) out = out.flatMap(([x, y]): Spans => (b <= x || a >= y ? [[x, y]] : ([[x, Math.min(y, a)], [Math.max(x, b), y]] as Spans).filter(([p, q]) => q > p)));
  return out;
}

/** Whether `project` is a compilation (several cases): its own say, else its channel's. */
export function isCompilation(project: Pick<Project, "channel" | "compilation">): boolean {
  return project.compilation ?? channels.channelOf(project)?.compilation ?? false;
}

/** Where the intro ends (frames; 0 when the edit has none it can tell: no script, or its blocks off the timeline). */
function introEnd(project: Project): number {
  if (project.script == null) return 0;
  try {
    return native().sections({ json: jsonForSerde(project) }).intro?.[1] ?? 0;
  } catch {
    return 0;
  }
}

const CASE_NOTE = /^(?:compilation\s+)?case\s*#?\s*(\d+)\s*:/iu;
/** A chapter title naming a case ("Case 2: Stephen Clancy Hill", script.ts's CHAPTER_NOTE). */
const CASE_CHAPTER = /^chapter title \(on screen, not voiced\):\s*case\s*#?\s*(\d+)\b/iu;

/** Each footage media's case, as the script records it (see the top). */
export function caseKeys(project: Pick<Project, "script">): Map<string, string> {
  const out = new Map<string, string>();
  let chapter: string | null = null;
  for (const block of project.script?.blocks ?? []) {
    const notes = block.notes ?? [];
    const titled = notes.map((note) => CASE_CHAPTER.exec(note)?.[1]).find((one) => one !== undefined);
    if (titled !== undefined) chapter = `case ${Number(titled)}`;
    if (block.kind !== "footage" || typeof block.media !== "string" || out.has(block.media)) continue;
    const said = notes.map((note) => CASE_NOTE.exec(note)?.[1]).find((one) => one !== undefined);
    const reused = notes.find((note) => note.startsWith(REUSED_SCRIPT_NOTE));
    out.set(block.media, said !== undefined ? `case ${Number(said)}` : (reused ?? chapter ?? `file ${block.file || block.media}`));
  }
  return out;
}

/** The edit's intro and cases, back to back to its end. */
export function parts(project: Project): Part[] {
  const end = duration(project);
  const intro = Math.min(introEnd(project), end);
  const starts = [intro];
  const compilation = isCompilation(project);
  if (compilation) {
    const keys = caseKeys(project);
    const seen = new Set<string>();
    const shown = project.clips.filter((clip): clip is VideoClip => clip.type === "video" && keys.has(clip.media) && clipEnd(clip) > intro).sort((a, b) => a.start - b.start);
    for (const clip of shown) {
      const key = keys.get(clip.media)!;
      if (seen.has(key)) continue;
      if (seen.size > 0 && clip.start > starts.at(-1)!) starts.push(clip.start);
      seen.add(key);
    }
  }
  const out: Part[] = intro > 0 ? [{ name: "the intro", case: null, start: 0, end: intro }] : [];
  starts.forEach((start, index) => {
    const stop = starts[index + 1] ?? end;
    if (stop <= start) return;
    const number = index + 1;
    out.push({ name: compilation ? `case ${number}` : "the case", case: number, start, end: stop });
  });
  return out;
}

/** The timeline seconds of the intro, or of case `number` (from 1); null when the edit has none. */
export function stretchOf(project: Project, which: "intro" | number): [number, number] | null {
  const fps = fpsOf(project);
  const part = parts(project).find((one) => (which === "intro" ? one.case === null : one.case === which));
  return part === undefined ? null : [part.start / fps, part.end / fps];
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** One stretch of the timeline detection says shows their text (text_removal.ts `proposed`), and whether the agent marked it. */
export interface Proposed {
  from: number;
  to: number;
  media: string;
  marked: boolean;
}

const at2 = (seconds: number) => `${clock(seconds)}${(seconds % 1).toFixed(1).slice(1)}`;

/**
 * What the agent reads of removal (get_edit_context's removal): how their
 * text comes out, the edit's sections (for an ask by case or intro), how to
 * mark, and what detection proposes for the agent to mark (its in and out
 * points: only marked stretches are blurred).
 */
export function outline(project: Project, proposed: Proposed[] = []): Record<string, string> {
  const fps = fpsOf(project);
  const at = (part: Part) => `${clock(part.start / fps)}–${clock(part.end / fps)}`;
  const unmarked = proposed.filter((one) => !one.marked);
  const marked = proposed.filter((one) => one.marked);
  const list = (some: Proposed[]) =>
    some
      .slice(0, 60)
      .map((one) => `${at2(one.from)}–${at2(one.to)} ${one.media}`)
      .join("; ") + (some.length > 60 ? `; and ${some.length - 60} more` : "");
  const all = parts(project);
  return {
    how: "Their subtitles and text get a tight blur tracked over their words, in every section, only where you mark them; their watermarks come out of the whole video here, free.",
    ...(all.length > 0 ? { sections: `${all.map((part) => `${part.name} (${at(part)})`).join(", ")}. An ask by place is one start_removal: {case: 3}, {intro: true}, or media, from/to.` } : {}),
    marks:
      "Only stretches you mark are blurred, never whole clips. Look at the proposed stretches (render_frame or contact_sheet), " +
      'then mark the in and out points where their text truly shows, tight to it, in one call: start_removal {marks: [{from: 12.4, to: 15.0}, …]} (timeline seconds; several short stretches, not one long one). ' +
      "Add text detection missed the same way; take back a wrong one with start_removal {unmark: [{from, to}]}.",
    ...(unmarked.length > 0 ? { proposed: `Detection proposes (timeline seconds, not marked yet): ${list(unmarked)}.` } : {}),
    ...(marked.length > 0 ? { marked: `Marked: ${list(marked)}.` } : {}),
  };
}
