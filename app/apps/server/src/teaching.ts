// When an agent keeps what it's taught, one rule for all of them (Sphe, Nov
// 14): "if the agent is able to infer that, 'Okay, I need to remember this,'
// it does"; where it can't tell ("throughout the entire video" doesn't
// necessarily mean always), it asks at the end of its turn whether to do it
// for every video from now on, and keeps it only when the person says yes:
// "If we ignore it, it shouldn't then assume". From 802 of the team's review
// notes (Oct 22–Nov 10): ~4% said always/never outright; "throughout the
// entire video" mostly meant this one, now and then a one-case exception.

/**
 * Where a lesson goes in a channel that's in a group (Sphe, Nov 15: "if we
 * want teaching specific to a certain channel… we should be able to have
 * that separation even though they're grouped"): the group's by default, the
 * channel's alone only when the feedback says it's for this one. Every
 * lane's agent is told this, whatever its way of keeping one (`for` on its
 * tools, or on Script mode's lesson).
 */
export function groupRule(): string {
  return (
    `This channel is in a group, so a lesson is the group's by default (for: "group"): every channel in it has it. ` +
    `It's this channel's alone (for: "channel") only when the feedback says it's for this one ("for this channel", "just here", "because it's a compilation", or names this channel).`
  );
}

/**
 * The rule, for an agent working on a `word` ("video", "script", "idea",
 * "thumbnail"): `how` is the way it keeps one ("keep it with remember").
 * `asks`: whether it can ask (a turn whose reply the person reads); a turn
 * that only answers once keeps only what's said outright. `grouped`: the
 * channel is in a group (`groupRule`).
 */
/**
 * A lesson changed in place, as a diff (Sphe, Nov 20: "agents can't change one
 * line… almost like a git diff… across the board for any sort of V2 cloud
 * teaching"): each change's `old` words, found exactly once in what's taught
 * now, become its `new` ("" takes them out), in order; everything else stays
 * word for word, however long the lesson is. What comes back: the whole new
 * text, and the words put in (what a clash is checked on).
 */
export function changeLesson(name: string, text: string, given: unknown): { text: string; added: string } {
  if (!Array.isArray(given) || given.length === 0 || given.length > 20) throw new Error(`change is a list of 1 to 20 {old, new}: the exact words in ${name} as it is now, and what they become`);
  let out = text;
  const added: string[] = [];
  for (const [at, one] of given.entries()) {
    const { old, new: next } = (typeof one === "object" && one !== null ? one : {}) as { old?: unknown; new?: unknown };
    if (typeof old !== "string" || old === "" || typeof next !== "string") throw new Error(`change ${at + 1} is {old: words in ${name}, new: what they become ("" takes them out)}`);
    const found = out.split(old).length - 1;
    if (found !== 1) throw new Error(`change ${at + 1}: ${found === 0 ? `${name} doesn't have those words as written` : `those words are in ${name} ${found} times`}: copy them exactly from your instructions${found > 1 ? ", with enough around them to be found once" : ""}. Nothing was changed.`);
    out = out.replace(old, () => next);
    if (next.trim() !== "") added.push(next.trim());
  }
  if (out.trim() === "") throw new Error(`that would leave ${name} empty: put it away instead`);
  return { text: out.trim(), added: added.join("\n") };
}

/** How long a changed lesson may be: its kind's most, or for one already past it (a guide brought over whole), a little more than it was. */
export const changedMost = (most: number, before: number): number => (before > most ? before + 400 : most);

/** A memory, always in mind: a line or two. */
export const MEMORY_MOST = 400;

/**
 * A part read when needed (it has a note), by lane: up to a whole guide of
 * that lane, so one can be kept through the app (Nov 21: the courtroom script
 * guides had to be saved from a script, past 2,400). The house's longest of
 * each, with room: the cut-in script guide 35.6k, the thumbnail guide 20.6k,
 * the bodycam ideas guide 14.7k, the edit's cut-ins skill 10.7k.
 */
export const PART_MOST: Record<"ideas" | "script" | "thumbnails" | "edit", number> = { script: 40_000, thumbnails: 24_000, ideas: 16_000, edit: 12_000 };

/** Past this a part is a guide: refused when it reads as a transcript, and never written over by a short lesson. */
export const GUIDE_FROM = 2_400;

const STAMP = /^\s*[[(]?\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?[\])]?(\s|-->|$)/u;
const SPEAKER = /^\s*[A-Z][A-Za-z .'-]{0,30}:\s+\S/u;

/**
 * Why `text` can't be kept as a lesson of `lane` (null when it can): too long
 * for its kind, or a guide-length text that reads as a transcript or a
 * subtitle file (most of its lines times, or a speaker and their words) rather
 * than rules. The house's guides have at most 2% of such lines.
 */
export function lessonRefusal(text: string, lane: keyof typeof PART_MOST, part: boolean, most: number): string | null {
  if (text.length > most) return `at most ${most.toLocaleString("en-US")} characters (this is ${text.length.toLocaleString("en-US")}): ${part ? "keep the part to its rules, not their history" : "a line or two, in the person's words (a longer part, read when needed, takes a note)"}`;
  if (!part || text.length <= GUIDE_FROM) return null;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const stamped = lines.filter((line) => STAMP.test(line)).length;
  const spoken = lines.filter((line) => SPEAKER.test(line)).length;
  if (lines.length >= 20 && (stamped >= lines.length / 4 || spoken >= (lines.length * 2) / 5)) return `that reads as a transcript, not a ${lane === "edit" ? "part of the edit" : "guide"}: keep the rules it teaches, in a few lines each, never the words said in a video`;
  return null;
}

/** The `change` argument every remember takes, as its schema says it. */
export const CHANGE_ARG = {
  type: "array",
  maxItems: 20,
  description: 'Instead of text, to change part of a lesson that\'s there (any length, a guide brought over whole too; read a part with read_skill first): [{old: its exact words now, found once; new: what they become, "" takes them out}]. The rest stays word for word.',
  items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] },
};

/**
 * A round of feedback applied, kept whole when asked (Sphe, Nov 20: "you've
 * just applied all these changes. Please remember this for the future"; many
 * lessons, or whole skills where they belong together). Every area's agent
 * has it, in keepRule.
 */
export const ROUND_RULE = (word: string): string =>
  `A ROUND OF FEEDBACK KEPT WHOLE: when they ask you to remember feedback you've applied ("remember all of this for the future", "keep these for next time"), that's their yes to every note of it. Read it back first if it isn't all in front of you (pull_feedback with done: true, where you have it). Then go through every note: each lasting point is its own lesson (one remember each, the rule in general terms, the reviewer's words as reason); where several notes are one part of the work (how a section opens, how pictures are found and placed), keep them as one longer part with a note on when to read it, its rules whole. A note only about this ${word} is kept as the rule behind it, or left when there's none. One that repeats or changes what's taught changes that lesson (the same name): its changed lines with change, never by writing a long one out again. End with the list of what you kept, by name, and what you left and why.`;

export function keepRule(word: string, how: string, asks = true, grouped = false): string {
  const line = grouped ? `"I'll remember this for the group: …", or "I'll remember this for this channel only: …"` : `"I'll remember this for future ${word}s: …"`;
  const sure =
    `KEEPING WHAT YOU'RE TAUGHT: when feedback says it holds beyond this ${word} ("always", "never", "every ${word}", "from now on", "make this a rule", "we don't do that for any…"), ${how} at once, the rule in general terms with their words, ` +
    `and end your reply with a line saying so (${line}). A fix for this ${word} only (this clip, this name, this moment) is never kept.` +
    (grouped ? ` ${groupRule()}` : "") +
    ` ${ROUND_RULE(word)}`;
  if (!asks) return `${sure} Anything less sure than that, leave.`;
  return (
    `${sure} When it could hold beyond this ${word} but doesn't say so (a taste that sounds general; "throughout the entire ${word}" or "everywhere", which mean this ${word}), don't keep it: ` +
    `end your reply with one short question naming it in a few words, whether to do it on every ${word} from now on (several such notes: one question for all of them, never one each). ` +
    `Keep it only when their next words say yes (to all, or to the ones they name). If they go on without answering, it stays this ${word}'s: don't keep it, and don't ask about it again.`
  );
}
