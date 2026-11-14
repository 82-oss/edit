// When an agent keeps what it's taught, one rule for all of them (Sphe, Nov
// 14): "if the agent is able to infer that, 'Okay, I need to remember this,'
// it does"; where it can't tell ("throughout the entire video" doesn't
// necessarily mean always), it asks at the end of its turn whether to do it
// for every video from now on, and keeps it only when the person says yes:
// "If we ignore it, it shouldn't then assume". From 802 of the team's review
// notes (Oct 22–Nov 10): ~4% said always/never outright; "throughout the
// entire video" mostly meant this one, now and then a one-case exception.

/**
 * The rule, for an agent working on a `word` ("video", "script", "idea",
 * "thumbnail"): `how` is the way it keeps one ("keep it with remember").
 * `asks`: whether it can ask (a turn whose reply the person reads); a turn
 * that only answers once keeps only what's said outright.
 */
export function keepRule(word: string, how: string, asks = true): string {
  const sure =
    `KEEPING WHAT YOU'RE TAUGHT: when feedback says it holds beyond this ${word} ("always", "never", "every ${word}", "from now on", "make this a rule", "we don't do that for any…"), ${how} at once, the rule in general terms with their words, ` +
    `and end your reply with a line saying so ("I'll remember this for future ${word}s: …"). A fix for this ${word} only (this clip, this name, this moment) is never kept.`;
  if (!asks) return `${sure} Anything less sure than that, leave.`;
  return (
    `${sure} When it could hold beyond this ${word} but doesn't say so (a taste that sounds general; "throughout the entire ${word}" or "everywhere", which mean this ${word}), don't keep it: ` +
    `end your reply with one short question naming it in a few words, whether to do it on every ${word} from now on (several such notes: one question for all of them, never one each). ` +
    `Keep it only when their next words say yes (to all, or to the ones they name). If they go on without answering, it stays this ${word}'s: don't keep it, and don't ask about it again.`
  );
}
