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
 * A round of feedback applied, kept whole when asked (Sphe, Nov 20: "you've
 * just applied all these changes. Please remember this for the future"; many
 * lessons, or whole skills where they belong together). Every area's agent
 * has it, in keepRule.
 */
export const ROUND_RULE = (word: string): string =>
  `A ROUND OF FEEDBACK KEPT WHOLE: when they ask you to remember feedback you've applied ("remember all of this for the future", "keep these for next time"), that's their yes to every note of it. Read it back first if it isn't all in front of you (pull_feedback with done: true, where you have it). Then go through every note: each lasting point is its own lesson (one remember each, the rule in general terms, the reviewer's words as reason); where several notes are one part of the work (how a section opens, how pictures are found and placed), keep them as one longer part with a note on when to read it, its rules whole. A note only about this ${word} is kept as the rule behind it, or left when there's none. One that repeats what's taught changes that lesson (the same name). End with the list of what you kept, by name, and what you left and why.`;

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
