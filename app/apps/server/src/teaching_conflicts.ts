// A lesson that contradicts what's taught already is said before it's kept
// (Sphe, Nov 18: "I don't remember the agents pointing out contradictions when
// I was saving, I think they should"). Cuffed & Caught's group had kept both
// `subtitles` ("white words in a black box, the label above in the speaker's
// colour") and `in-video-subtitles` ("all white, no speaker labels or colours,
// no box"), and two overnight edits did neither well. So `remember` asks here
// first: the rules the new one can't stand beside, each with the line it
// clashes with. Found, nothing is kept until the person says which holds
// (`settled`), and the agent changes the other so the two never stand together.

import * as diag from "./diag.ts";
import type { Skill } from "./v2_cloud.ts";

/** One rule taught already that the new lesson can't stand beside. */
export interface Conflict {
  skill: string;
  /** The line of it that clashes, as it's written. */
  line: string;
  /** In a few words, why both can't hold. */
  why: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    conflicts: {
      type: "array",
      items: {
        type: "object",
        properties: { skill: { type: "string" }, line: { type: "string" }, why: { type: "string" } },
        required: ["skill", "line", "why"],
      },
    },
  },
  required: ["conflicts"],
};

const SYSTEM =
  "A teacher is keeping a new lesson for a video team's AI editor, beside the lessons it has already. " +
  "List each existing lesson line the new one contradicts: where doing both is impossible or they tell the editor opposite things about the same thing " +
  '(e.g. "white words in a black box, with speaker labels" against "all white, no box, no labels"; "music under the footage" against "no music under the footage"). ' +
  "Not a contradiction: a lesson that adds to another, narrows it with a clear scope (\"only in the intro\", \"for this channel\"), or covers something else; " +
  "a lesson about one part of the edit (the intro and its teasers, the outro, a title card, a 911 call, one effect) governs that part, so a general rule it departs from there is its exception, not a clash. " +
  "Flag only what an editor couldn't follow both of in the same place. " +
  "Quote the clashing line exactly as the existing lesson has it, name that lesson, and say why in a few words. None: an empty list.";

/** The model's ask, which tests replace. */
export const hooks = {
  ask: async (prompt: string): Promise<Record<string, unknown>> => {
    const claude = await import("./writer/claude.ts");
    return claude.structured("sonnet", SYSTEM, SCHEMA, prompt, undefined, "Claude sonnet checking a lesson against what's taught");
  },
};

/**
 * The lessons taught already (`known`) that `text`, kept as `name`, contradicts.
 * The one it replaces (same name) isn't asked about. Null when it couldn't be
 * checked (no model now): the lesson is kept, and the agent says it wasn't.
 */
export async function conflicts(name: string, text: string, known: readonly Skill[]): Promise<Conflict[] | null> {
  const others = known.filter((one) => one.name !== name && one.text.trim() !== "");
  if (others.length === 0) return [];
  const prompt = `The new lesson, "${name}":\n${text}\n\nThe lessons it joins:\n${others.map((one) => `--- ${one.name}${one.note ? ` (${one.note})` : ""}\n${one.text}`).join("\n\n")}`;
  try {
    const answer = await hooks.ask(prompt);
    const listed = Array.isArray(answer.conflicts) ? (answer.conflicts as Record<string, unknown>[]) : [];
    const byName = new Map(others.map((one) => [one.name, one.text]));
    const found = listed.flatMap((one) =>
      typeof one.skill === "string" && byName.has(one.skill) && typeof one.line === "string" && one.line.trim() !== ""
        ? [{ skill: one.skill, line: one.line.trim(), why: typeof one.why === "string" ? one.why.trim() : "" }]
        : [],
    );
    // A clash is only said with the line it clashes with as that lesson has it: one the
    // model wrote itself (or put in the wrong lesson) isn't shown to the person as quoted.
    const quoted = found.filter((one) => quotes(byName.get(one.skill) ?? "", one.line));
    if (quoted.length < found.length) diag.warn("teaching", `checking ${name}: ${found.length - quoted.length} clash(es) quoted a line its lesson doesn't have`);
    // Every clash it named misquoted: what it saw can't be shown, so it counts as unchecked.
    if (found.length > 0 && quoted.length === 0) return null;
    return quoted;
  } catch (error) {
    diag.warn("teaching", `checking ${name} against what's taught: ${diag.messageOf(error)}`);
    return null;
  }
}

/** Whether `line` is in `text` as it's written, give or take case, spacing, quote marks and markdown, and an elision ("…") between its parts. */
export function quotes(text: string, line: string): boolean {
  const plain = (words: string) => words.toLowerCase().replace(/[*_`"'\u2018\u2019\u201c\u201d]/g, "").replace(/\s+/g, " ").trim();
  const whole = plain(text);
  const parts = line.split(/\.\.\.|\u2026/).map(plain).filter((part) => part !== "");
  if (parts.length === 0) return false;
  let from = 0;
  for (const part of parts) {
    const at = whole.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** A lesson not kept for what it contradicts: its message is what the agent is told (`refusal`). */
export class Clash extends Error {
  constructor(readonly conflicts: readonly Conflict[]) {
    super(refusal(conflicts));
  }
}

/** The clashes in a line or two each, for a person to read (Script mode, which keeps a lesson without asking back). */
export function plainly(found: readonly Conflict[]): string {
  return found.map((one) => `"${one.line}" (${one.skill})`).join("; ");
}

/** What the agent is told when the lesson isn't kept for its conflicts: what clashes, and what to do. */
export function refusal(found: readonly Conflict[]): string {
  return (
    `Not kept yet: it contradicts what's taught already:\n${found.map((one) => `- ${one.skill}: "${one.line}"${one.why ? ` (${one.why})` : ""}`).join("\n")}\n` +
    "Tell the person, quoting both in a line each, and ask which holds, in one short question. " +
    "Keep it only once they answer: remember it again with settled (their words), then change the other to match (remember it again without that line, or archive_in_library if it all goes), so the two never stand together. " +
    "If they say the old one holds, don't keep the new one."
  );
}

/** The line a kept lesson's answer ends with when it couldn't be checked. */
export const UNCHECKED = " It couldn't be checked against what's taught just now: if it might clash with a lesson there, say so to the person.";
