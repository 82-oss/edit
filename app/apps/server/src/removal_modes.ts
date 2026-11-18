// Which of Vmake's modes each stretch of an edit is cleaned in (Sphe and JJ,
// Nov 18), for a channel taught to take theirs out (removal_lesson.ts):
//
//   - the intro (the opening before the first case: edit_core's sections, the
//     teasers up to the "On <date>" cut-in) gets Smart Pro;
//   - the first two cases get Smart, only where their footage has their text
//     (each file is read for it, text_removal.ts; nothing goes for a file with
//     none);
//   - every case after the second gets nothing from Vmake.
//
// Their see-through watermarks (the engine's, free and here) are taken out of
// the whole video whatever the section: this is Vmake's alone.
//
// The cases are what the project records: a footage block's "Case N" note (a
// compilation's pasted sources, a case inserted later), else the reused
// script it came from, else the recording it plays (Writer's compilations: a
// case a recording). A video that isn't a compilation (the project's or its
// channel's `compilation`) is its intro and one case. A case starts where its
// footage first shows after the intro and runs to where the next one's does.
// A piece's mode is by where its seconds show on the timeline: footage shown
// in the intro and again in a case gets the better of the two.
//
// Exceptions are said in the chat and kept as asks (removal_asks.ts `mode`):
// "use Smart on case 3 too", "Smart Pro on case 1" is one start_removal with
// the case (the intro, files or a stretch) and the mode; the later ask wins
// over the default and any earlier ask for the same seconds. A channel taught
// nothing keeps Smart Pro on whatever is asked there, as before.

import * as channels from "./channels.ts";
import type { Project, VideoClip } from "./model.ts";
import { native } from "./native/index.ts";
import { clipEnd, duration, fps as fpsOf, REUSED_SCRIPT_NOTE } from "./project.ts";
import * as asks from "./removal_asks.ts";
import * as removal from "./removal_lesson.ts";
import { jsonForSerde } from "./rust.ts";
import type { Mode } from "./vmake_web.ts";

export type { Mode };
export type Spans = [number, number][];

/** The cases cleaned by default after the intro (Smart). */
export const SMART_CASES = 2;
export const WORDS: Record<Mode, string> = { pro: "Smart Pro", smart: "Smart" };
/** How the agent names a mode in start_removal, and back. */
export const ASKED: Record<Mode, string> = { pro: "smart_pro", smart: "smart" };
export const modeOfAsked = (value: unknown): Mode | null => (value === "smart_pro" ? "pro" : value === "smart" ? "smart" : null);

const RANK: Record<Mode, number> = { smart: 1, pro: 2 };
/** The better of two modes (Smart Pro over Smart over none). */
export const better = (a: Mode | null, b: Mode | null): Mode | null => (a === null ? b : b === null ? a : RANK[a] >= RANK[b] ? a : b);

/** One part of the edit, timeline frames [start, end), and its default mode (null: nothing from Vmake). */
export interface Part {
  /** "the intro", "case 2", or "the case" in a video of one. */
  name: string;
  /** Its case's number from 1; null for the intro. */
  case: number | null;
  start: number;
  end: number;
  mode: Mode | null;
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

const length = (spans: Spans) => spans.reduce((sum, [a, b]) => sum + b - a, 0);

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

/** The edit's intro and cases, back to back to its end, each with its default mode. */
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
  const out: Part[] = intro > 0 ? [{ name: "the intro", case: null, start: 0, end: intro, mode: "pro" }] : [];
  starts.forEach((start, index) => {
    const stop = starts[index + 1] ?? end;
    if (stop <= start) return;
    const number = index + 1;
    out.push({ name: compilation ? `case ${number}` : "the case", case: number, start, end: stop, mode: number <= SMART_CASES ? "smart" : null });
  });
  return out;
}

/** The timeline seconds of the intro, or of case `number` (from 1); null when the edit has none. */
export function stretchOf(project: Project, which: "intro" | number): [number, number] | null {
  const fps = fpsOf(project);
  const part = parts(project).find((one) => (which === "intro" ? one.case === null : one.case === which));
  return part === undefined ? null : [part.start / fps, part.end / fps];
}

/** Source seconds of each footage file the timeline shows between two timeline seconds (text_removal.ts `shownBetween`). */
export type ShownIn = (from: number, to: number) => Map<string, Spans>;

/** Each footage file's source seconds, by the mode they're cleaned in (what's in neither isn't sent to Vmake). */
export type ByMode = Map<string, Record<Mode, Spans>>;

/**
 * The mode of every second of footage the timeline shows: the parts'
 * defaults for a channel taught removal (Smart Pro everywhere for one taught
 * nothing: what's asked there), then each ask since the person's Stop in
 * order: one with a mode sets its seconds to it; one without, on files or a
 * stretch the person pointed to, gives Smart to seconds the defaults leave
 * out (asked for, so never nothing).
 */
export function byMode(project: Project, home: string, shownIn: ShownIn): ByMode {
  const out: ByMode = new Map();
  const of = (id: string) => {
    let one = out.get(id);
    if (one === undefined) out.set(id, (one = { pro: [], smart: [] }));
    return one;
  };
  const set = (id: string, mode: Mode, spans: Spans) => {
    const one = of(id);
    for (const other of ["pro", "smart"] as const) one[other] = minus(one[other], spans);
    one[mode] = merged([...one[mode], ...spans]);
  };
  const taught = removal.takesOut(removal.lessonOf(project));
  const fps = fpsOf(project);
  const all = shownIn(0, Number.MAX_SAFE_INTEGER / 1e6);
  if (taught) {
    // The better mode wins where footage shows in two parts: Smart first, Smart Pro over it.
    const defaults = parts(project).filter((part) => part.mode !== null).sort((a, b) => RANK[a.mode!] - RANK[b.mode!]);
    for (const part of defaults) for (const [id, spans] of shownIn(part.start / fps, part.end / fps)) set(id, part.mode!, spans);
  } else for (const [id, spans] of all) set(id, "pro", spans);
  for (const ask of asks.liveAsks(home, project.id)) {
    if (!ask.kinds.some((kind) => kind !== "watermarks")) continue;
    const pointed = new Map<string, Spans>(ask.media === "all" ? all : Object.entries(ask.media).map(([id, given]): [string, Spans] => [id, given === "all" ? (all.get(id) ?? []) : intersect(all.get(id) ?? [], given)]));
    for (const [id, spans] of pointed) {
      if (ask.mode !== undefined) set(id, ask.mode, spans);
      else if (ask.media !== "all") set(id, "smart", minus(spans, [...of(id).pro, ...of(id).smart]));
    }
  }
  for (const one of out.values()) one.smart = minus(one.smart, one.pro);
  return out;
}

/** "cases 1 and 2", "the intro and case 3": names joined, cases after one "cases". */
function named(names: string[]): string {
  const cases = names.filter((name) => name.startsWith("case ")).map((name) => name.slice(5));
  const rest = names.filter((name) => !name.startsWith("case "));
  const words = [...rest, ...(cases.length === 0 ? [] : [`${cases.length === 1 ? "case" : "cases"} ${cases.length === 1 ? cases[0] : `${cases.slice(0, -1).join(", ")} and ${cases.at(-1)}`}`])];
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The split in words, of what's being sent (`sent`: each file's source
 * seconds by mode): "Smart Pro on the intro, Smart on cases 1 and 2". Each
 * part sent anything is named under the mode most of its footage has, when
 * most of it has one (a later case isn't named for an intro teaser's seconds
 * it shows too); "" when nothing is sent.
 */
export function describe(project: Project, modes: ByMode, sent: ByMode, shownIn: ShownIn): string {
  const fps = fpsOf(project);
  const under: Record<Mode, string[]> = { pro: [], smart: [] };
  for (const part of parts(project)) {
    const shown = shownIn(part.start / fps, part.end / fps);
    const share = { pro: 0, smart: 0 };
    let any = false;
    let all = 0;
    for (const [id, spans] of shown) {
      all += length(spans);
      const going = sent.get(id);
      if (going !== undefined && intersect(spans, [...going.pro, ...going.smart]).length > 0) any = true;
      const mine = modes.get(id);
      for (const mode of ["pro", "smart"] as const) share[mode] += length(intersect(spans, mine?.[mode] ?? []));
    }
    if (any && share.pro + share.smart > all / 2) under[share.pro >= share.smart ? "pro" : "smart"].push(part.name);
  }
  return (["pro", "smart"] as const)
    .filter((mode) => under[mode].length > 0)
    .map((mode) => `${WORDS[mode]} on ${named(under[mode])}`)
    .join(", ");
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * What the agent reads of the split (get_edit_context's removal): each part's
 * default and its stretch of the timeline, the exceptions asked for, and how
 * to make one.
 */
export function outline(project: Project, home: string): string {
  const fps = fpsOf(project);
  const all = parts(project);
  const at = (part: Part) => `${clock(part.start / fps)}–${clock(part.end / fps)}`;
  const byDefault = (["pro", "smart"] as const)
    .map((mode) => {
      const mine = all.filter((part) => part.mode === mode);
      return mine.length === 0 ? "" : `${WORDS[mode]} on ${mine.map((part) => `${part.name} (${at(part)})`).join(" and ")}`;
    })
    .filter(Boolean);
  const none = all.filter((part) => part.mode === null);
  const exceptions = asks
    .liveAsks(home, project.id)
    .filter((ask) => ask.mode !== undefined && ask.said !== undefined)
    .map((ask) => `${WORDS[ask.mode!]} on ${ask.said}`);
  return (
    `Their subtitles and text go to Vmake by section: ${byDefault.join("; ") || "nothing"}${none.length > 0 ? `; nothing from ${none[0]!.name} on (${clock(none[0]!.start / fps)}–)` : ""}. ` +
    `Their watermarks come out of the whole video here, free. ${exceptions.length > 0 ? `Asked here: ${exceptions.join("; ")}. ` : ""}` +
    `An exception the person asks for is one start_removal with the mode: {case: 3, mode: "smart"} ("Smart on case 3 too"), {case: 1, mode: "smart_pro"}, or intro, media, from/to.`
  );
}
