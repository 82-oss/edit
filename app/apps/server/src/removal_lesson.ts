// What a channel takes out of its footage's picture (Sphe, Nov 17): one
// general removal, its parts chosen by the channel's teaching, with examples,
// never a fixed setting. "We only want subtitles removed, here's an example",
// "only watermarks", "subtitles and the 'Actual case footage' labels, keep the
// camera stamp". The camera's own stamp is always kept, whatever is taught.
//
// A part taught means "theirs out wherever the footage actually has it": a
// compilation pulls footage from many re-uploaders, so each file is looked at
// for itself (their subtitles and text read off it, a watermark of its own
// looked for: watermark_removal.ts) and nothing is done to a file with none.
// Examples only help (a hint for that file, words to match); none is needed.
//
// It's a lesson like any other of the channel's edit style (Edit V2's cloud,
// the group's by default, a channel's own when the person says it's for that
// one; nearest wins), named `removal`, kept by the agent's `teach_removal`: a
// line the person can read, then its data:
//   - what's taken out: subtitles (theirs, burned in), watermarks (see-through
//     marks), text (labels and other text laid over the picture); each on or off;
//   - examples: a frame of footage (a file's second) or a picture from the
//     chat, with what to take out or keep there, its box and its words, the
//     frame's crop kept in Edit's cloud under the channel.
//
// What it decides (`kinds`): an untaught channel takes nothing out (theirs
// left, ours off there, today's default; "cover" still blurs for a channel
// taught so). Subtitles and text go to Vmake (text_removal.ts, only the
// seconds that show them, its strip pasted back only where taught);
// watermarks go to the engine here alone (watermark_removal.ts), so a channel
// taught only watermarks never pays Vmake.

import * as channels from "./channels.ts";
import type { Project } from "./model.ts";
import type { Box } from "./native/index.ts";
import * as v2cloud from "./v2_cloud.ts";

export const SKILL = "removal";
export const NOTE = "What Edit takes out of the footage's picture for this channel (teach_removal keeps it; never by hand)";

export type Kind = "subtitles" | "watermarks" | "text";
export const KINDS: readonly Kind[] = ["subtitles", "watermarks", "text"];

/** One example: a frame (or picture) and what's there to take out or keep. */
export interface Example {
  /** What it shows: theirs to take out, or (keep) the camera's stamp or anything else to leave. */
  kind: Kind | "stamp";
  action: "remove" | "keep";
  /** Its words as read (or told): what's matched in other footage. */
  text?: string;
  /** Where on the picture: shares from the top left (x0, y0, x1, y1). */
  box?: Box;
  /** The frame's crop in Edit's cloud (`edit/channels/<channel>/removal/<sha256>.jpg`). */
  picture?: string;
  /** The footage it came from (its cloud source) and the second. */
  from?: { source: string; at: number };
  note?: string;
}

export interface Lesson {
  remove: Record<Kind, boolean>;
  examples: Example[];
}

const OPEN = "<removal>";
const CLOSE = "</removal>";

const WORDS: Record<Kind, string> = { subtitles: "their subtitles", watermarks: "their watermarks", text: "their labels and other text" };

/** The line the person reads: what's taken out, and that the camera's stamp stays. */
export function summary(lesson: Lesson): string {
  const out = KINDS.filter((kind) => lesson.remove[kind]).map((kind) => WORDS[kind]);
  const said = out.length === 0 ? "Nothing is taken out of the footage's picture" : `Take ${out.length === 1 ? out[0] : `${out.slice(0, -1).join(", ")} and ${out.at(-1)}`} out of the footage's picture wherever a file has them`;
  const kept = lesson.examples.filter((one) => one.action === "keep" && one.text).map((one) => `"${one.text}"`);
  return `${said}; the camera's stamp${kept.length > 0 ? ` and ${kept.join(", ")}` : ""} always kept.`;
}

/** The lesson's text as kept: its line, then its data. */
export function write(lesson: Lesson): string {
  return `${summary(lesson)}\n${OPEN}${JSON.stringify({ remove: lesson.remove, examples: lesson.examples })}${CLOSE}`;
}

const isBox = (value: unknown): value is Box => Array.isArray(value) && value.length === 4 && value.every((one) => typeof one === "number" && one >= 0 && one <= 1) && value[0] < value[2] && value[1] < value[3];

/** The lesson in a kept text, or null when it isn't one (a hand-written one is read as nothing). */
export function parse(text: string): Lesson | null {
  const start = text.indexOf(OPEN);
  const end = text.indexOf(CLOSE, start + OPEN.length);
  if (start < 0 || end < 0) return null;
  let given: { remove?: Record<string, unknown>; examples?: unknown[] };
  try {
    given = JSON.parse(text.slice(start + OPEN.length, end)) as typeof given;
  } catch {
    return null;
  }
  const remove = Object.fromEntries(KINDS.map((kind) => [kind, given.remove?.[kind] === true])) as Record<Kind, boolean>;
  const examples = (Array.isArray(given.examples) ? given.examples : []).flatMap((raw): Example[] => {
    const one = raw as Record<string, unknown>;
    const kind = one.kind;
    if (kind !== "stamp" && !KINDS.includes(kind as Kind)) return [];
    if (one.action !== "remove" && one.action !== "keep") return [];
    const from = one.from as { source?: unknown; at?: unknown } | undefined;
    return [
      {
        kind: kind as Example["kind"],
        action: one.action,
        ...(typeof one.text === "string" && one.text.trim() !== "" ? { text: one.text.trim() } : {}),
        ...(isBox(one.box) ? { box: one.box } : {}),
        ...(typeof one.picture === "string" ? { picture: one.picture } : {}),
        ...(from !== undefined && typeof from.source === "string" && typeof from.at === "number" ? { from: { source: from.source, at: from.at } } : {}),
        ...(typeof one.note === "string" ? { note: one.note } : {}),
      },
    ];
  });
  return { remove, examples };
}

/**
 * Where each taught part goes: `vmake` the parts Vmake takes out (and only
 * those are pasted back), `local` the parts done here. Nothing at all for an
 * untaught channel.
 */
export function kinds(lesson: Lesson | null): { vmake: Kind[]; local: Kind[] } {
  if (lesson === null) return { vmake: [], local: [] };
  return {
    vmake: (["subtitles", "text"] as const).filter((kind) => lesson.remove[kind]),
    local: lesson.remove.watermarks ? ["watermarks"] : [],
  };
}

/** What a project's channel (or its group) is taught to take out, as last read (v2cloud's skills); null untaught or no channel. */
export function lessonOf(project: Pick<Project, "channel">): Lesson | null {
  const places = channels.placesOfProject(project);
  if (places === null) return null;
  const kept = v2cloud.skill(SKILL, places);
  return kept === undefined ? null : parse(kept.text);
}

/** Whether `lesson` takes anything out. */
export const takesOut = (lesson: Lesson | null): boolean => lesson !== null && KINDS.some((kind) => lesson.remove[kind]);

/** The words of its examples: theirs to find in other footage (remove), and to never count as theirs (keep). */
export function exampleWords(lesson: Lesson | null): { remove: string[]; keep: string[] } {
  const of = (action: Example["action"]) => (lesson?.examples ?? []).filter((one) => one.action === action && one.kind !== "watermarks" && one.text !== undefined).map((one) => one.text!);
  return { remove: of("remove"), keep: of("keep") };
}

/** The boxes its keep examples name: kept as the original's, as the camera's stamp is. */
export function keepBoxes(lesson: Lesson | null): Box[] {
  return (lesson?.examples ?? []).filter((one) => one.action === "keep" && one.box !== undefined).map((one) => one.box!);
}

/**
 * A lesson changed by the agent's call: the parts given (others as they
 * were), the examples given added to the ones there (the same frame and kind
 * replaced), or all of them cleared with `clear_examples`.
 */
export function changed(before: Lesson | null, remove: Partial<Record<Kind, boolean>>, examples: Example[], clear = false): Lesson {
  const was = before ?? { remove: { subtitles: false, watermarks: false, text: false }, examples: [] };
  const kept = clear ? [] : was.examples.filter((old) => !examples.some((one) => one.kind === old.kind && one.action === old.action && sameFrame(one, old)));
  return { remove: { ...was.remove, ...Object.fromEntries(Object.entries(remove).filter(([, value]) => typeof value === "boolean")) }, examples: [...kept, ...examples].slice(-12) };
}

function sameFrame(a: Example, b: Example): boolean {
  if (a.picture !== undefined && a.picture === b.picture) return true;
  return a.from !== undefined && b.from !== undefined && a.from.source === b.from.source && Math.abs(a.from.at - b.from.at) < 0.5 && JSON.stringify(a.box) === JSON.stringify(b.box);
}
