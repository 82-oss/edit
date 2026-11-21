// Add-ons (Sphe's idea, Nov 21): V1 has a third thing besides words (skills,
// lessons) and drawings (effects) that V2 had no home for: code that checks
// and fixes an edit, and code that shapes what a project is, each tied to a
// kind of video by `project.style`. An add-on is one of those, by name, with
// when it runs (a project made, an import done, after each change, the turn's
// end, or inside a tool) and its settings, so a channel holds a list of them
// beside its lessons and effects instead of a kind welded into Edit.
//
// Built in this order: first Edit's own (here, `CATALOGUE`), switched on per
// channel; then ones the agent writes that only report; last, ones the agent
// writes that change the edit, which need a sandbox and an undo first.
//
// A project made without a channel (every V1 project) has its style's
// add-ons, exactly what the code did by style (`v1`). A channel's project
// starts from the same list, its style being what its channel's narration
// gave it when it was made (bodycam's, or interrogation's when the team
// records it: `channels.ts` `styleOf`) or a moved V1 edit's own; then what's
// set on the channel or its group; then only those that fit its frame
// (`form`). Nothing is set anywhere yet: reading a channel's add-ons from its
// library is `itemsAt`'s.

import * as channels from "./channels.ts";
import type { Project, Style } from "./model.ts";

export type Name =
  | "bodycam-intro"
  | "windows-screens"
  | "intro-captions"
  | "held-broll"
  | "interrogation-music"
  | "interrogation-structure"
  | "courtroom-text"
  | "essay-checks"
  | "horror-look"
  | "no-competitor-footage"
  | "post-details"
  | "reverb-out"
  | "case-research"
  | "youtube-excerpts"
  | "muted-words"
  | "short-form"
  | "court-script";

/** Which projects an add-on holds on: a long (16:9) one, a Short (taller than wide), or either. */
export type Form = "long" | "short" | "any";

/**
 * When it runs. `made`: a project (or, in the script lane, a script) is made in
 * the channel; `import`: footage comes in; `change`: after each change the agent
 * makes, its answer carrying what's found; `turn-end`: the agent's turn is over;
 * `tool`: inside the agent's own tools, or tools it's given.
 */
export type Trigger = "made" | "import" | "change" | "turn-end" | "tool";

/** What it does when it runs (any of them). */
export interface Does {
  /** Tells the agent what it found (an issue in the plan's answer, or a refusal). */
  reports?: true;
  /** Changes the project itself. */
  fixes?: true;
  /** Runs on in the background, with its own line under the chat. */
  background?: true;
  /** Gives the agent tools (`tools`). */
  tool?: true;
  /** Shapes what New project makes. */
  shapes?: true;
  /** Starts a turn of the agent's with work for it. */
  asks?: true;
}

export interface Setting {
  default: unknown;
  /** What it takes, said to whoever sets it. */
  words: string;
  check: (value: unknown) => boolean;
}

export interface BuiltIn {
  /** Its name and line, as the agent and one day the person read them. */
  title: string;
  description: string;
  lane: "edit" | "script";
  trigger: Trigger;
  does: Does;
  form: Form;
  settings: Record<string, Setting>;
  /** The tools it gives a V2 agent (they're in `mcp/registry.ts` `NOT_IN_HQ`; a V1 agent has every tool). */
  tools?: readonly string[];
  /** The V1 styles that have it: the V1 table, here and nowhere else. */
  v1: readonly Style[];
  /** Its settings for a V1 style, where they aren't the defaults. */
  v1Settings?: Partial<Record<Style, Record<string, unknown>>>;
}

/** The settings each add-on takes, for `setting`'s types. */
export interface Settings {
  "courtroom-text": { smallest: number };
  "muted-words": { list: "commentary" | "horror"; words: string[] };
  "short-form": { forms: "short" | "both" };
}

const words = (value: unknown) => Array.isArray(value) && value.every((one) => typeof one === "string" && one.trim() !== "");

export const CATALOGUE: Record<Name, BuiltIn> = {
  // edit_tools.ts introLong, introWithoutArrest.
  "bodycam-intro": {
    title: "Bodycam intro checks",
    description: "Says when the intro's teasers run past 40 seconds, or the intro doesn't end on the arrest (only for an edit not cut from a script).",
    lane: "edit", trigger: "change", does: { reports: true }, form: "long", settings: {},
    v1: ["bodycam"],
  },
  // edit_tools.ts windowsUnderused, desktopsSparse: they count V1's `Desktop · …` clips.
  "windows-screens": {
    title: "Windows screen checks",
    description: "Says when the cut-ins have too few Windows screens (one for every six), or a screen has fewer than three windows on it.",
    lane: "edit", trigger: "change", does: { reports: true }, form: "long", settings: {},
    v1: ["bodycam"],
  },
  // edit_tools.ts introUncaptioned.
  "intro-captions": {
    title: "Intro captions check",
    description: "Says when the intro's lines are plain subtitles instead of the speakers' captions.",
    lane: "edit", trigger: "change", does: { reports: true }, form: "long", settings: {},
    v1: ["bodycam", "interrogation"],
  },
  // edit_plan.ts audit (no long_broll_shot), onscreen.ts issues (broll_recut).
  "held-broll": {
    title: "Held B-roll",
    description: "A fixed camera (a hearing, an interview room) is held and pushed in on, not cut up: says when its footage is cut up, and doesn't ask for long shots to be broken up.",
    lane: "edit", trigger: "change", does: { reports: true }, form: "long", settings: {},
    v1: ["courtroom", "interrogation"],
  },
  // edit_plan.ts audit (longest bed, music_repeated), footage_levels.ts issues (music_mood).
  "interrogation-music": {
    title: "Interrogation music",
    description: "Music beds may run up to 90 seconds over a section and the same song carry across bridges (said only from six uses, not three); says when a drone or pulsing bed plays under a bridge's narration.",
    lane: "edit", trigger: "change", does: { reports: true }, form: "long", settings: {},
    v1: ["interrogation"],
  },
  // edit_plan.ts audit (the tape's start, the end), framing.ts interrogationIssues.
  "interrogation-structure": {
    title: "Interrogation structure checks",
    description: "Says when the tape's start isn't felt (a riser, a hit, the music cut), the countdown is late, the video ends on a new picture after the last page, the teasers or the room are held too wide, the first hook comes in unmarked, the person questioned isn't introduced by name, or a bridge shows only the room.",
    lane: "edit", trigger: "change", does: { reports: true }, form: "long", settings: {},
    v1: ["interrogation"],
  },
  // edit_plan.ts audit (small_text, subtitle_coloured), people.ts oneColourPerPerson (keeps them white).
  "courtroom-text": {
    title: "Courtroom text",
    description: "Words on screen big enough to read on a phone, and subtitles white whoever speaks: says when they aren't, and keeps unlabelled subtitles white.",
    lane: "edit", trigger: "change", does: { reports: true, fixes: true }, form: "long",
    settings: { smallest: { default: 60, words: "the smallest text on screen, in pixels at 1080p (a whole number from 20 to 200)", check: (value) => Number.isInteger(value) && (value as number) >= 20 && (value as number) <= 200 } },
    v1: ["courtroom"],
  },
  // edit_plan.ts audit, edit_tools.ts audited and editContext, edit_review.ts narrationInFootage.
  "essay-checks": {
    title: "Narrated essay checks",
    description: "One narrator over chosen footage: the essay's checks (narration left uncovered, still sources, sameness, sounds without pictures) instead of the police edit's, and the video's chapters in the agent's overview.",
    lane: "edit", trigger: "change", does: { reports: true }, form: "long", settings: {},
    v1: ["commentary", "horror"],
  },
  // horror_look.ts fillReels, mosaicCensors, textOnTop, soundEdges, groundsWithCards; commentary_audit.ts pacing; commentary_sources.ts capture_evidence.
  "horror-look": {
    title: "Analog horror",
    description: "Tall videos shown whole over a blurred copy of themselves, censors as mosaics, sound edges softened, horror's checks, and pages captured whole around the words.",
    lane: "edit", trigger: "change", does: { reports: true, fixes: true }, form: "any", settings: {},
    v1: ["horror"],
  },
  // commentary_sources.ts search_broll, import_broll.
  "no-competitor-footage": {
    title: "No competitor footage",
    description: "Never another channel's coverage of the story as footage: left out of the agent's searches, and refused when it's imported.",
    lane: "edit", trigger: "tool", does: { reports: true }, form: "any", settings: {},
    v1: ["horror"],
  },
  // The two tools, off NOT_IN_HQ for this channel.
  "post-details": {
    title: "Video and post details",
    description: "Brings in a YouTube video's or an X post's details (title, views, picture) for a graphic to show.",
    lane: "edit", trigger: "tool", does: { tool: true }, form: "any", settings: {},
    tools: ["youtube_reference", "tweet_reference"],
    v1: ["commentary", "horror"],
  },
  "reverb-out": {
    title: "Reverb out",
    description: "A clip's last words fade out in reverb over a fade to black.",
    lane: "edit", trigger: "tool", does: { tool: true }, form: "any", settings: {},
    tools: ["commentary_reverb_out"],
    v1: ["commentary", "horror"],
  },
  // script.ts followOn.
  "case-research": {
    title: "Research the case after import",
    description: "When the footage is in, the agent researches the case (articles, photos) before editing.",
    lane: "edit", trigger: "import", does: { asks: true }, form: "long", settings: {},
    v1: ["bodycam", "interrogation", "courtroom"],
  },
  // script.ts footageToCloud.
  "youtube-excerpts": {
    title: "Only the parts of YouTube videos used",
    description: "YouTube footage comes in as the stretches the edit uses, never the whole video.",
    lane: "edit", trigger: "import", does: { fixes: true }, form: "any", settings: {},
    v1: ["commentary", "horror"],
  },
  // subtitles.ts styleTerms, in houseWords, muteHouseWords and house_words_pass.ts.
  "muted-words": {
    title: "Extra muted words",
    description: "More words muted in the sound and starred on screen than the house's own list.",
    lane: "edit", trigger: "turn-end", does: { fixes: true }, form: "any",
    settings: {
      list: { default: "commentary", words: '"commentary" (Internet Janitor\'s words) or "horror" (those and their other forms)', check: (value) => value === "commentary" || value === "horror" },
      words: { default: [], words: "more words of the channel's own, a list", check: words },
    },
    v1: ["commentary", "horror"],
    v1Settings: { commentary: { list: "commentary" }, horror: { list: "horror" } },
  },
  // edit_tools.ts bigCut, edit_plan.ts audit (shortsAudit), edit_review.ts narrationInFootage, script.ts followOn; the frame at New project.
  "short-form": {
    title: "Shorts",
    description: "9:16 Shorts: the whole source cut to a minute, reframed on the subject, with a Short's checks.",
    lane: "edit", trigger: "made", does: { shapes: true, reports: true, tool: true }, form: "short",
    settings: { forms: { default: "short", words: '"short" (every project is a Short) or "both" (New project offers long or Short)', check: (value) => value === "short" || value === "both" } },
    tools: ["reframe"],
    v1: ["shorts"],
    v1Settings: { shorts: { forms: "short" } },
  },
  // The script's kind: writer/formats.ts and everything that reads `kind`.
  "court-script": {
    title: "Courtroom script",
    description: "A script made in this channel is a courtroom case: the Doc's running time and total clip length, and court clip names.",
    lane: "script", trigger: "made", does: { shapes: true }, form: "any", settings: {},
    v1: ["courtroom"],
  },
};

export const NAMES = Object.keys(CATALOGUE) as Name[];

/** Each V1 style's add-ons, read off the catalogue. */
export function v1Of(style: Style): Name[] {
  return NAMES.filter((name) => CATALOGUE[name].v1.includes(style));
}

/** What an add-on is asked of: a project (or a script, with no frame). */
export type Of = Pick<Project, "style" | "channel"> & { settings?: Pick<Project["settings"], "width" | "height"> };

/** A project is a Short when it's taller than wide; one without a frame (a script) is long. */
export const formOf = (project: Of): "long" | "short" => (project.settings !== undefined && project.settings.height > project.settings.width ? "short" : "long");

/** Whether an add-on made for `form` holds on a project of this frame. */
export const fits = (form: Form, project: Of): boolean => form === "any" || form === formOf(project);

/** An add-on as it stands on a channel: on or off, where that comes from, and its settings. */
export interface Effective {
  name: Name;
  on: boolean;
  /** `default`: its style's list (for a project made now, the channel's narration's); `group`/`channel`: set there. */
  from: "default" | "group" | "channel";
  settings: Record<string, unknown>;
}

/** What's set on a channel's place for an add-on. */
interface Item {
  on: boolean;
  settings: Record<string, unknown>;
  from: "group" | "channel";
}

/**
 * What's set for a channel's lane, by name, the channel's own over its
 * group's. None yet: they come from the channel's library (its places,
 * `channels.placesOf`), read from what's cached, never waited for here.
 */
function itemsAt(_channel: string, _lane: BuiltIn["lane"]): Map<Name, Item> {
  return new Map();
}

/** A channel's narration's style, as a project made in it now gets it (`channels.styleOf`); bodycam until it's read. */
function narrationStyle(channel: string): "bodycam" | "interrogation" {
  const found = channels.channelOf({ channel });
  return found === null ? "bodycam" : channels.styleOf(found);
}

function defaults(name: Name, style: Style): Record<string, unknown> {
  const own = CATALOGUE[name];
  const given = Object.fromEntries(Object.entries(own.settings).map(([key, one]) => [key, one.default]));
  return { ...given, ...own.v1Settings?.[style] };
}

/** A channel's lane, its defaults those of `style`. */
function lane(channel: string, which: BuiltIn["lane"], style: Style): Effective[] {
  const items = itemsAt(channel, which);
  return NAMES.filter((name) => CATALOGUE[name].lane === which).map((name) => {
    const item = items.get(name);
    const settings = defaults(name, style);
    if (item === undefined) return { name, on: CATALOGUE[name].v1.includes(style), from: "default", settings };
    return { name, on: item.on, from: item.from, settings: { ...settings, ...item.settings } };
  });
}

/** Every add-on of a channel's lane as a project made in it now has them, on or off, frame or not: for the agent's list, the channel's page and New project. */
export function ofChannel(channel: string, which: BuiltIn["lane"]): Effective[] {
  return lane(channel, which, narrationStyle(channel));
}

const hasChannel = (project: Of): project is Of & { channel: string } => typeof project.channel === "string" && project.channel !== "";

/** The add-on as it holds on this project; null when it doesn't. */
function holding(project: Of, name: Name): Effective | null {
  const own = CATALOGUE[name];
  if (!hasChannel(project)) {
    return own.v1.includes(project.style) ? { name, on: true, from: "default", settings: defaults(name, project.style) } : null;
  }
  // Its defaults are the style it was made with, never the narration read now: a channel's own project got it from
  // the narration then (`styleOf`), a V1 edit moved onto the channel keeps its own (channel_move.ts), and the
  // narration changed since changes neither, so each runs what it ran.
  const found = lane(project.channel, own.lane, project.style).find((one) => one.name === name);
  if (found?.on !== true) return null;
  // The frame decides only on a channel that makes Shorts on purpose (it has `short-form` set): there a long edit's
  // add-ons don't run on a Short, nor a Short's on a long edit. Anywhere else a project runs what its style ran
  // whatever its frame, as every V1 project does (Nov 21: three of the slices that moved the sites onto `has` found
  // a V1 edit with an odd frame, moved onto a channel, would have lost its own checks and its research turn).
  if (makesShorts(project.channel) && !fits(own.form, project)) return null;
  return found;
}

/** Whether a channel has set `short-form` itself: the one case where a project's frame says which add-ons are its. */
const makesShorts = (channel: string): boolean => itemsAt(channel, "edit").get("short-form")?.on === true;

/** Whether a project has an add-on: by its style without a channel, by its channel's with one. Sync, from what's cached. */
export function has(project: Of, name: Name): boolean {
  return holding(project, name) !== null;
}

/** An add-on's setting on this project; undefined when it doesn't have the add-on. */
export function setting<N extends keyof Settings, K extends keyof Settings[N]>(project: Of, name: N, key: K): Settings[N][K] | undefined {
  return holding(project, name)?.settings[key as string] as Settings[N][K] | undefined;
}

/** Before a trigger outside the agent's turn asks (a project made, an import, the turn's end): the channels read again when they're old, bounded. */
export async function ready(): Promise<void> {
  await channels.refresh();
}
