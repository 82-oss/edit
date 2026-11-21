// Script mode's lessons: a revision answers once with no tools, so its
// structured answer carries an optional `lesson`, a lasting preference or
// correction the producer or a reviewer gave, and the server keeps it in the
// script's channel's Script lane (lanes.ts). Nothing else keeps one: the
// team's lessons inbox it once went to is gone (Sphe, Nov 21: "completely
// remove the lessons inbox system… we'll be using v2's cloud for lessons and
// v1 will soon be deprecated").

import type { Script } from "@edit/types/writer";

import * as beta from "../beta.ts";
import * as diag from "../diag.ts";
import { parent } from "../paths.ts";
import * as teachingConflicts from "../teaching_conflicts.ts";
import * as lanes from "../lanes.ts";
import * as v2cloud from "../v2_cloud.ts";

/** The answer's optional `lesson` property (left out: nothing that should outlast this script). */
export const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    lesson: { type: "string" },
    quote: { type: "string" },
    from: { type: "string" },
    scope: { type: "string", enum: ["house", "style", "person", "channel"] },
    name: { type: "string" },
    /** A grouped channel's lesson: its group's (the default) or this channel's alone (teaching.ts `groupRule`). */
    for: { type: "string", enum: ["group", "channel"] },
  },
  required: ["lesson", "quote", "scope"],
};

/** What the model is told about it. */
export const LESSON_RULE =
  "LESSONS: when the producer or a reviewer says a preference or correction holds for every later script, not just this one (\"we never…\", \"always…\", \"from now on\", a rule of the guide it shows wrong), or says yes when you asked whether it should, also send lesson {lesson: the rule in general terms for any script, never naming this one's clips or times; quote: their words verbatim; from: who said it when it's a review note's author; scope: house (every script), style (this kind of script) or person (one person's or channel's taste)}, once, beside the edits that fix this script. Otherwise leave lesson out. Never mention a lesson you send in the reply: the app adds a line. One that could hold for every script but doesn't say so (\"throughout the script\" means this one): send no lesson; end the reply with one short question, naming it, whether to do it on every script from now on (several: one question for all). Send it only when their next message says yes; left unanswered, it stays this script's and you don't ask again.";

/** The answer's lesson, if it carries one. */
export function lessonOf(plan: Record<string, unknown> | null): Record<string, unknown> | null {
  const lesson = plan?.lesson;
  return typeof lesson === "object" && lesson !== null ? (lesson as Record<string, unknown>) : null;
}

/** A lesson's name as the library keeps it: lower-case words joined by hyphens. */
const slug = (text: string): string => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");

/**
 * Keeps `lesson` with the script it was said on; the line to add to the reply, or "" when there was none. `data` is
 * Writer's data folder, in Edit's home: with Edit V2 on there (Sphe, Nov 16: "once you've enabled Edit V2, things don't
 * go into a Teams lessons inbox"), every lesson of a channel's script is kept in that channel's Script lane, whatever its
 * scope; without it, only one of how that channel does its scripts (scope "channel"). Anything else is kept nowhere.
 */
export async function keep(script: Script, lesson: Record<string, unknown> | null, data?: string): Promise<string> {
  if (lesson === null) return "";
  const v2 = data !== undefined && beta.read(parent(data) ?? data).v2;
  // A channel's script: a lesson of how that channel does its scripts is kept in its Script lane at once (lanes.ts).
  if ((lesson.scope === "channel" || v2) && script.channel) {
    const named = typeof lesson.name === "string" && lesson.name.trim() !== "" ? lesson.name : typeof lesson.lesson === "string" ? lesson.lesson.split(/\s+/u).slice(0, 5).join(" ") : "";
    const name = slug(named);
    try {
      if (typeof lesson.lesson !== "string" || lesson.lesson.trim() === "" || name === "") throw new Error("the lesson came back without its words or a name");
      const kept = await lanes.keepLesson({ channel: script.channel, lane: "script" }, name, lesson.lesson.trim(), typeof lesson.quote === "string" && lesson.quote.trim() !== "" ? lesson.quote.trim() : "said in a revision", lesson.for === "channel" ? "channel" : undefined);
      diag.info("lessons", `${script.title}: ${kept}`);
      return `\n\n${kept.replace(/: its agents have it.*$/u, ".")} This channel's next scripts have it.`;
    } catch (error) {
      // It contradicts what the channel's scripts are taught: said, and kept only once the person says which holds.
      if (error instanceof teachingConflicts.Clash) {
        diag.info("lessons", `${script.title}: a lesson not kept: it contradicts ${error.conflicts.map((one) => one.skill).join(", ")}`);
        return `\n\nI haven't kept that for later scripts: it goes against what this channel's scripts are taught already: ${teachingConflicts.plainly(error.conflicts)}. Say which holds, and change the other on the channel's page if it's the new one.`;
      }
      diag.warn("lessons", `${script.title}: the channel's lesson wasn't kept: ${diag.messageOf(error)}`);
      // The agent's words for why (a teacher's to do, too long) are its own: the person reads a plain line.
      return v2cloud.teacher() ? "\n\nThat sounds like a lesson for this channel's scripts, but it couldn't be kept just now: say it again in a moment." : "";
    }
  }
  // A script without a channel, or a V1 lesson for every script: nowhere keeps it since the inbox went (Nov 21), and the
  // reply says so, as the model is told the app adds the line.
  diag.info("lessons", `${script.title}: a lesson not kept: ${script.channel ? "it isn't one of how this channel does its scripts" : "this script isn't a channel's"}`);
  return script.channel ? "\n\nOnly a lesson of how this channel does its scripts is kept for later ones, so that stays this script's." : "\n\nThis script isn't a channel's, so nothing is kept from it for later scripts.";
}
