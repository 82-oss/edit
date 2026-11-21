// What the signed-in person may do in Script mode: the kinds of script an
// admin granted them at accounts.spheceo.com (Edit's relay manifest lists
// them, with the ids Writer gave them), read from the token's `perms` as
// kinds.ts reads Edit's. A script of a kind someone can't write is hidden from
// them: not listed, not opened, not used as a source, no agent work on it.
// Sharing for review (links, approving, fixing notes, Doc exports) is anyone's
// who's signed in, on the scripts they may see (Sphe, Nov 6); teaching from
// feedback needs `review.lessons`.
//
// A channel's script (Edit V2), a commentary included, is the channel's alone
// (Sphe, Nov 21: "a channel I've given a person access to should be all they
// need"): the channel given is all it takes to make, see and write it, whatever
// kinds of script they write. It had needed some script kind of its shape
// (`scripts.interrogation` for one case, a compilation kind for several) and a
// commentary `scripts.commentary` beside the channel.

import type { Kind, Script, Summary } from "@edit/types/writer";

import { granted, mayChannel, onChannel } from "../kinds.ts";

export const INTERROGATION = "scripts.interrogation";
export const INTERROGATION_COMPILATION = "scripts.interrogation-compilation";
export const FOIA = "scripts.foia";
/** Bodycam (FOIA) compilations: Repack's compilation guide with its FOIA guide. */
export const FOIA_COMPILATION = "scripts.foia-compilation";
export const COURTROOM = "scripts.courtroom";
export const COURTROOM_COMPILATION = "scripts.courtroom-compilation";
export const COMMENTARY = "scripts.commentary";
export const LESSONS = "review.lessons";

/** Whether the signed-in person has `id` (everything for an admin, or no one signed in, as kinds.ts says). */
export function has(id: string, given: Set<string> | null = granted()): boolean {
  return given === null || given.has(id);
}

/** The kind of work a script is. */
export function workOf(script: Pick<Script | Summary, "sourceKind" | "compilation" | "kind">): string {
  if (script.sourceKind === "commentary") return COMMENTARY;
  const kind = script.kind ?? "interrogation";
  if (script.compilation) return kind === "courtroom" ? COURTROOM_COMPILATION : kind === "foia" ? FOIA_COMPILATION : INTERROGATION_COMPILATION;
  return kind === "foia" ? FOIA : kind === "courtroom" ? COURTROOM : INTERROGATION;
}

/** A channel's script, footage or commentary: who was given the channel may see and write it (Nov 21). */
export const isChannelScript = (script: Pick<Script | Summary, "channel">): boolean => onChannel(script.channel);

/** May see and write this script. */
export const sees = (script: Pick<Script | Summary, "sourceKind" | "compilation" | "kind" | "channel">, given: Set<string> | null = granted()): boolean =>
  isChannelScript(script) ? mayChannel(script.channel, given) : has(workOf(script), given);

/**
 * Making a channel's footage script: nothing more to ask (Nov 21). The channel
 * is checked where the script is asked for (writer/routes.ts `madeOf`: the
 * channel shown to them, carried by their token), and that is all it takes.
 * Kept for writer/imports.ts `start`, which calls it.
 */
export function requireShape(_compilation: boolean | undefined): void {}

/** Making a commentary: on a channel, the channel is all it takes (checked by `madeOf`, as above); with none, `scripts.commentary`. */
export function requireCommentary(channel: string | undefined): void {
  if (!onChannel(channel)) require(COMMENTARY);
}

/** The one-case formats this person may write, in the editor's order. */
export function singleKinds(given: Set<string> | null = granted()): Kind[] {
  return ([["interrogation", INTERROGATION], ["foia", FOIA], ["courtroom", COURTROOM]] as const).filter(([, id]) => has(id, given)).map(([kind]) => kind);
}

/** The compilation formats this person may write. */
export function compilationKinds(given: Set<string> | null = granted()): Kind[] {
  return ([["interrogation", INTERROGATION_COMPILATION], ["foia", FOIA_COMPILATION], ["courtroom", COURTROOM_COMPILATION]] as const).filter(([, id]) => has(id, given)).map(([kind]) => kind);
}

const DOING: Record<string, string> = {
  [INTERROGATION]: "write interrogation scripts",
  [INTERROGATION_COMPILATION]: "write interrogation compilations",
  [FOIA]: "write bodycam (FOIA) scripts",
  [FOIA_COMPILATION]: "write bodycam compilations",
  [COURTROOM]: "write courtroom scripts",
  [COURTROOM_COMPILATION]: "write courtroom compilations",
  [COMMENTARY]: "write commentary scripts",
  [LESSONS]: "teach Script mode from feedback",
};

export function refusal(id: string): string {
  return `Your account can't ${DOING[id] ?? "do that"} yet. Ask an admin at accounts.spheceo.com.`;
}

export const NOT_AVAILABLE = "This script isn't available to your account.";

export function require(id: string): void {
  if (!has(id)) throw new Error(refusal(id));
}

export function requireScript(script: Pick<Script, "sourceKind" | "compilation" | "kind" | "channel">): void {
  if (!sees(script)) throw new Error(NOT_AVAILABLE);
}

/** Building as `kind`: refused when the person can't write that kind; a channel's script has no kind of theirs to ask for (Nov 21). */
export function requireKind(script: Pick<Script, "sourceKind" | "compilation"> & Partial<Pick<Script, "channel">>, kind: Kind): void {
  if (isChannelScript(script)) return requireScript({ ...script, kind, channel: script.channel });
  require(workOf({ ...script, kind }));
}

/** The format a new one-case import starts as: the first this person may write. */
export function firstSingleKind(): Kind {
  const kind = singleKinds()[0];
  if (kind === undefined) throw new Error(refusal(INTERROGATION));
  return kind;
}

export function firstCompilationKind(): Kind {
  const kind = compilationKinds()[0];
  if (kind === undefined) throw new Error(refusal(INTERROGATION_COMPILATION));
  return kind;
}
