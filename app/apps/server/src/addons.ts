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
// (`form`).
//
// What's set on a channel is kept in V2's library beside its lessons, as
// removal is (removal_lesson.ts): a skill item named `addon-<name>` at the
// channel's lane's place, or its group's (`<channel>--edit`, `<group>--edit`;
// `--script` for the script lane's), its text a line the person can read and
// then its data:
//
//     Analog horror is on here: Tall videos shown whole over a blurred copy …
//     <addon>{"v":1,"on":true,"settings":{}}</addon>
//
// `on: false` switches off its style's default, or its group's for this
// channel alone; `settings` are only those set, each over its default. One
// item per add-on, so a channel's own wins over its group's by name and it can
// differ from its group in one add-on alone. They're read with the lessons
// (v2_cloud.ts `refreshSkills`) and never shown, kept or counted as lessons.

import type * as channelsModule from "./channels.ts";
import * as diag from "./diag.ts";
import type { Project, Style } from "./model.ts";
import type * as v2cloudModule from "./v2_cloud.ts";

/** What an add-on's item in the library is named: `addon-<name>` (v2_cloud.ts keeps these apart from lessons). */
export const ADDON_PREFIX = "addon-";

/**
 * What this module reads of the channels and of the library, handed to it by those modules as they load
 * (channels.ts, v2_cloud.ts) instead of imported here. The places that ask `has` are small files the whole server
 * leans on (framing.ts, onscreen.ts, people.ts, footage_levels.ts: media.ts imports the first), and importing
 * channels.ts from here closed a ring of imports through them (media -> framing -> addons -> channels -> ... ->
 * cloud_media -> media): a file in the ring that used another's export as it loaded met it before it existed
 * whenever the ring was entered at the wrong file (Nov 21: "Cannot access 'mediaHooks' before initialization" on
 * importing channels.ts first; the server's own start happened to enter at a safe one). Until they load, no channel
 * is known and nothing is set, which is every project running its style's own list.
 */
export const from = {
  placesOf: ((_channel, _lane) => []) as typeof channelsModule.placesOf,
  /** A channel's narration's style, as a project made in it now gets it; bodycam until it's read. */
  narrationStyle: (_channel: string): "bodycam" | "interrogation" => "bodycam",
  refreshChannels: (): Promise<unknown> => Promise.resolve(),
  addonItems: (() => []) as typeof v2cloudModule.addonItems,
  skillKey: ((name) => name) as typeof v2cloudModule.skillKey,
  ownPlaceOf: ((_key) => null) as typeof v2cloudModule.ownPlaceOf,
  laneOf: ((_place) => null) as typeof v2cloudModule.laneOf,
  enabled: (): boolean => false,
  refreshSkills: (): Promise<unknown> => Promise.resolve(),
};

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
export interface Item {
  on: boolean;
  /** Only those set; each over its default. */
  settings: Record<string, unknown>;
  from: "group" | "channel";
  /** Its item in the library, and its newest version when read (a save over a newer one is refused: `v2cloud.saveSkill`'s `latest`). */
  key: string;
  latest?: number;
}

/** An add-on's item's name in the library. */
export const skillOf = (name: Name): string => `${ADDON_PREFIX}${name}`;

/** Its note in the library: what anyone listing it reads. */
export const noteOf = (name: Name): string => `Add-on (Edit's code): ${CATALOGUE[name].description}`;

const OPEN = "<addon>";
const CLOSE = "</addon>";

/**
 * `given` as an add-on's settings, or why not, in a line naming what it takes:
 * each one it takes, of the kind it takes (`Setting.check`).
 */
export function checked(name: Name, given: unknown): { settings: Record<string, unknown> } | { error: string } {
  const own = CATALOGUE[name].settings;
  const takes = Object.keys(own);
  const says = takes.length === 0 ? `${name} takes no settings` : `${name} takes ${takes.map((key) => `${key}: ${own[key]!.words}`).join("; ")}`;
  if (given === undefined || given === null) return { settings: {} };
  if (typeof given !== "object" || Array.isArray(given)) return { error: `settings is an object: ${says}` };
  for (const [key, value] of Object.entries(given)) {
    const one = own[key];
    if (one === undefined) return { error: `${key} isn't one of its settings: ${says}` };
    if (!one.check(value)) return { error: `${key} is ${one.words}, not ${JSON.stringify(value)}` };
  }
  return { settings: { ...(given as Record<string, unknown>) } };
}

/** The line the person reads: whether it's on here, what it does, and what's set. */
export function summary(name: Name, on: boolean, settings: Record<string, unknown>): string {
  const own = CATALOGUE[name];
  const set = Object.entries(settings).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(", ") || "none" : String(value)}`);
  return `${own.title} is ${on ? "on" : "off"} here${set.length > 0 ? ` (${set.join("; ")})` : ""}: ${own.description}`;
}

/** An add-on's item's text as kept: its line, then its data. `settings` as `checked` gave them. */
export function write(name: Name, on: boolean, settings: Record<string, unknown>): string {
  return `${summary(name, on, settings)}\n${OPEN}${JSON.stringify({ v: 1, on, settings })}${CLOSE}`;
}

/** An item's text read: what it sets, or why it's read as nothing. */
export function parse(name: Name, text: string): { on: boolean; settings: Record<string, unknown> } | { error: string } {
  const start = text.indexOf(OPEN);
  const end = text.indexOf(CLOSE, start + OPEN.length);
  if (start < 0 || end < 0) return { error: `no ${OPEN}…${CLOSE} in it` };
  let given: unknown;
  try {
    given = JSON.parse(text.slice(start + OPEN.length, end));
  } catch (error) {
    return { error: `its data isn't JSON (${diag.messageOf(error)})` };
  }
  if (typeof given !== "object" || given === null || Array.isArray(given)) return { error: "its data isn't an object" };
  const data = given as { v?: unknown; on?: unknown; settings?: unknown };
  if (data.v !== 1) return { error: `it's version ${JSON.stringify(data.v)} of an add-on, and this Edit reads 1` };
  if (typeof data.on !== "boolean") return { error: "on isn't true or false" };
  const settings = checked(name, data.settings);
  if ("error" in settings) return settings;
  return { on: data.on, settings: settings.settings };
}

/** The items as last read, each parsed once: by place, then name. Rebuilt only when the library's read again (a new array). */
let index: { from: readonly v2cloudModule.Skill[]; at: Map<string, Map<Name, Omit<Item, "from">>> } = { from: [], at: new Map() };
/** The items already said to be unreadable (by key and text), so each is said once. */
const warned = new Set<string>();

function indexed(): Map<string, Map<Name, Omit<Item, "from">>> {
  const read = from.addonItems();
  if (index.from === read) return index.at;
  const at = new Map<string, Map<Name, Omit<Item, "from">>>();
  for (const one of read) {
    const key = one.key ?? from.skillKey(one.name);
    const place = from.ownPlaceOf(key);
    const lane = place === null ? null : from.laneOf(place);
    const name = one.name.slice(ADDON_PREFIX.length) as Name;
    const parsed: { error: string } | { on: boolean; settings: Record<string, unknown> } =
      !(name in CATALOGUE) ? { error: "Edit has no add-on of that name" }
      : place === null || lane === null ? { error: "it isn't kept at a channel's or a group's lane" }
      : lane.lane !== CATALOGUE[name].lane ? { error: `it's the ${CATALOGUE[name].lane} lane's, kept in the ${lane.lane} lane` }
      : parse(name, one.text);
    if ("error" in parsed) {
      const said = `${key}\n${one.text}`;
      if (!warned.has(said)) diag.warn("addons", `${key} is read as nothing, so what it would set doesn't hold: ${parsed.error}`);
      warned.add(said);
      continue;
    }
    if (!at.has(place!)) at.set(place!, new Map());
    at.get(place!)!.set(name, { ...parsed, key, ...(one.latest !== undefined ? { latest: one.latest } : {}) });
  }
  index = { from: read, at };
  return at;
}

/**
 * What's set for a channel's lane, by name, the channel's own over its
 * group's (its places, `channels.placesOf`, nearest first). Sync, from what's
 * cached: the library's last read and the channels' (for its group), never
 * waited for here (`ready` is what waits, before a trigger outside a turn).
 */
export function itemsAt(channel: string, which: BuiltIn["lane"]): Map<Name, Item> {
  const at = indexed();
  const out = new Map<Name, Item>();
  const places = from.placesOf(channel, which);
  for (const [near, place] of places.entries()) {
    for (const [name, item] of at.get(place) ?? []) {
      if (!out.has(name)) out.set(name, { ...item, from: near === 0 ? "channel" : "group" });
    }
  }
  return out;
}

/** What's set for one add-on of a channel (the channel's own, else its group's), or null: for the tool that sets them. */
export function itemOf(channel: string, name: Name): Item | null {
  return itemsAt(channel, CATALOGUE[name].lane).get(name) ?? null;
}

/** A channel's narration's style, as a project made in it now gets it (`channels.styleOf`); bodycam until it's read. */
function narrationStyle(channel: string): "bodycam" | "interrogation" {
  return from.narrationStyle(channel);
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

/**
 * The form a project made in a channel now takes, for New project: a Short on
 * a channel whose `short-form` is "short", the form asked on one offering
 * "both" (long unless a Short is asked), long anywhere else. Made once: a
 * project already there keeps its frame.
 */
export function formMade(channel: string, asked?: "long" | "short"): "long" | "short" {
  const set = itemsAt(channel, "edit").get("short-form");
  if (set?.on !== true) return "long";
  const forms = set.settings.forms ?? CATALOGUE["short-form"].settings.forms!.default;
  return forms === "short" || asked === "short" ? "short" : "long";
}

/** Whether a project has an add-on: by its style without a channel, by its channel's with one. Sync, from what's cached. */
export function has(project: Of, name: Name): boolean {
  return holding(project, name) !== null;
}

/** An add-on's setting on this project; undefined when it doesn't have the add-on. */
export function setting<N extends keyof Settings, K extends keyof Settings[N]>(project: Of, name: N, key: K): Settings[N][K] | undefined {
  return holding(project, name)?.settings[key as string] as Settings[N][K] | undefined;
}

/**
 * How long a trigger outside a turn waits for a channel's add-ons to be read
 * (an import's research turn, the end-of-turn pass). What's cached is good
 * enough: the read goes on behind and the next ask has it, and a turn's own
 * start waits longer anyway (`v2cloud.SKILLS_WAIT_MS`). A healthy read of the
 * channels and the library is well under a second; three seconds lets a slow
 * line finish without letting a hung cloud hold the passes queued behind.
 */
export const READY_MS = 3_000;

/**
 * Before a trigger outside the agent's turn asks (a project made, an import,
 * the turn's end): the channels and the library read again when they're old,
 * waited on at most READY_MS, and only for a project with a channel (`project`
 * left out: a channel's, as New project in one asks). Never throws: when the
 * cloud can't be reached or doesn't answer in time, what was read before
 * answers (its style's defaults when nothing was), with one line in the log.
 */
export async function ready(project?: Of | null, who = "a channel's project"): Promise<void> {
  if (project !== undefined && (project === null || !hasChannel(project))) return;
  if (!from.enabled()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Each read logs its own failure and keeps what it had (v2_cloud.ts, channels.ts).
    const read = Promise.all([from.refreshSkills(), from.refreshChannels()]).then(
      () => "read" as const,
      () => "failed" as const,
    );
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), READY_MS)));
    if ((await Promise.race([read, late])) === "late") diag.warn("addons", `${who}: the channel's add-ons weren't read in ${READY_MS / 1000} s, so what was read before is used (its style's own until something is)`);
  } catch (error) {
    diag.warn("addons", `${who}: the channel's add-ons weren't read, so what was read before is used: ${diag.messageOf(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
