// A channel's lanes for the agents beside the edit's (Nov 14; Sphe: "with
// ideas, scripts… we'll still have the tool calls but have the teaching
// system"): an idea, a script or a thumbnail made for a channel is made by an
// agent taught that channel's lane alone (its Ideas, Script or Thumbnails
// style), which starts empty and is built up in the app the way the edit's is.
// One module for the three agents: what their instructions say of the lane,
// and the tools each serves in its own way (remember, read_skill,
// other_channels, channel_videos). The lessons are V2's library's skills,
// kept under the lane's place (`<channel>--<lane>`), and for a channel in a
// group the group's lane's too, the group's by default (channels.ts `keptIn`);
// the edit's lane has its own tools (effect_tools.ts, channel_tools.ts), which
// share other_channels' reach into another channel from here.

import * as channels from "./channels.ts";
import * as diag from "./diag.ts";
import * as styles from "./script_styles.ts";
import { CHANGE_ARG, changeLesson, changedMost, GUIDE_FROM, groupRule, keepRule, lessonRefusal, MEMORY_MOST, PART_MOST } from "./teaching.ts";
import * as teachingConflicts from "./teaching_conflicts.ts";
import * as v2cloud from "./v2_cloud.ts";

/** The lanes this module serves; the edit's is effect_tools'. */
export type WorkLane = "ideas" | "script" | "thumbnails";

const WORD: Record<WorkLane | "edit", string> = { ideas: "ideas", script: "script", thumbnails: "thumbnail", edit: "edit" };
/** The lane's work, many of it ("this channel's ideas", "its scripts"). */
const MANY: Record<WorkLane | "edit", string> = { ideas: "ideas", script: "scripts", thumbnails: "thumbnails", edit: "edits" };

/** What a lane's agent is working for: the channel's key, and which of its lanes. */
export interface Place {
  channel: string;
  lane: WorkLane;
}

/**
 * What a lane's agent knows, as last read: its channel's own lessons and its
 * group's, the channel's winning by name (none of the edit's house, not even
 * the global skill: that's the edit's).
 */
export function lessonsOf(place: Place): v2cloud.Skill[] {
  const places = channels.placesOf(place.channel, place.lane);
  return v2cloud.memories(places).filter((one) => places.includes(v2cloud.ownPlaceOf(one.key ?? "") ?? ""));
}

/** Whether a lesson is the channel's own (not its group's). */
const ownLesson = (one: v2cloud.Skill, place: Place) => v2cloud.ownPlaceOf(one.key ?? "") === v2cloud.laneKey(place.channel, place.lane);

/**
 * Whether a channel's lane has been taught anything, read fresh: "unknown"
 * when its lessons can't be read now, never taken for untaught (as the edit's
 * teaching_gate.ts). Script mode builds nothing for an untaught channel
 * unless it's told what to write (writer/scripting.ts `needsTeaching`).
 */
export async function teachingOf(channel: string, lane: WorkLane): Promise<"taught" | "untaught" | "unknown"> {
  await refresh();
  if (!v2cloud.enabled() || !v2cloud.teachingKnown()) return "unknown";
  return v2cloud.taughtAnything(channels.placesOf(channel, lane)) ? "taught" : "untaught";
}

/** Read fresh at a turn's start (at most every 30 s each). */
export async function refresh(): Promise<void> {
  if (!v2cloud.enabled()) return;
  await Promise.all([v2cloud.refreshSkills(), channels.refresh()]);
}

/** Whether there's a channel: a script, an idea or a thumbnail may have none (made before channels, or of a kind of video without one). */
export function placeOf(channel: string | null | undefined, lane: WorkLane): Place | null {
  return typeof channel === "string" && channel !== "" ? { channel, lane } : null;
}

/** The channel's name as the agent reads it. */
function nameOf(key: string): string {
  const found = channels.knownChannels().find((one) => one.key === key);
  return found === undefined ? key : `${found.title}${found.handle ? ` (@${found.handle})` : ""}`;
}

/** As it's introduced: on YouTube, or a placeholder not on it yet. */
function introOf(key: string): string {
  const found = channels.knownChannels().find((one) => one.key === key);
  return found === undefined ? `${key}, on YouTube` : channels.channelName(found);
}

/**
 * What the lane's agent is told: whose work it is, the lane's style in the
 * team's words, what it's been taught (a lesson always in mind, a part read
 * when it fits), and how to keep what it's taught.
 */
/** How the agent keeps what it's taught: its tools, a lesson in its answer (Script mode's revisions), or not at all (a build only reads). */
export type Teach = "tools" | "lesson" | "none";

/** Said instead of the rule when this computer's account can't teach. */
const NOT_TEACHER = "This person isn't a teacher, so nothing is kept from their feedback: don't offer to keep it.";

export function laneText(place: Place, teach: Teach = "tools", picked: string | null = null): string {
  const channel = channels.knownChannels().find((one) => one.key === place.channel) ?? null;
  const word = WORD[place.lane];
  // One of them, for the rule's "this idea", "every idea".
  const single = place.lane === "ideas" ? "idea" : word;
  // One of them, for the rule's "this idea", "every idea".
  const style = channel?.lanes[place.lane]?.trim() ?? "";
  const group = channels.groupOf(place.channel);
  const shared = group?.lanes[place.lane]?.trim() ?? "";
  const taught = lessonsOf(place);
  // A script's styles (script_styles.ts) are said apart: only the one it's written in, whole.
  const lessons = place.lane === "script" ? taught.filter((one) => !styles.isStyle(one.name)) : taught;
  const always = lessons.filter((one) => one.note === undefined);
  const parts = lessons.filter((one) => one.note !== undefined);
  const said = (text: string) => text.replace(/\.$/u, "");
  const lines = [
    group === null
      ? `THIS CHANNEL: ${introOf(place.channel)}. You're working on its ${word} style, its own${style === "" ? "" : `, which the team puts as: ${said(style)}`}. You're never given another channel's styles, nor this channel's other lanes.`
      : `THIS CHANNEL: ${introOf(place.channel)}. ${channels.groupText(place.channel, word)} You're working on its ${word} style: the group's${shared === "" ? "" : `, which the team puts as: ${said(shared)}`}${style === "" ? "" : `; for this channel alone: ${said(style)}`}. You're never given another channel's styles outside the group, nor this channel's other lanes.`,
  ];
  const mineOnly = (one: v2cloud.Skill) => (group !== null && ownLesson(one, place) ? " (this channel only)" : "");
  if (group === null) {
    if (always.length > 0) lines.push(`What the team has taught you for ${channel?.title ?? place.channel}'s ${MANY[place.lane]} (always):\n${always.map((one) => `- ${one.name}: ${one.text}`).join("\n")}`);
  } else {
    const groupWide = always.filter((one) => !ownLesson(one, place));
    const own = always.filter((one) => ownLesson(one, place));
    if (groupWide.length > 0) lines.push(`What the team has taught you for the group's ${MANY[place.lane]} (always):\n${groupWide.map((one) => `- ${one.name}: ${one.text}`).join("\n")}`);
    if (own.length > 0) lines.push(`For ${channel?.title ?? "this channel"} alone, its exceptions (always; they win over the group's):\n${own.map((one) => `- ${one.name}: ${one.text}`).join("\n")}`);
  }
  // Script mode's agents have no tools to read a part with (writer/build.ts, revise.ts): theirs come whole.
  if (parts.length > 0 && place.lane === "script") lines.push(`Its longer parts, each whole; use one where it fits:\n\n${parts.map((one) => `## ${one.name}${mineOnly(one)} (${one.note})\n${one.text}`).join("\n\n")}`);
  else if (parts.length > 0) lines.push(`Read one with read_skill when it fits, once per conversation:\n${parts.map((one) => `- ${one.name}${mineOnly(one)}: ${one.note}`).join("\n")}`);
  if (place.lane === "script") {
    const all = styles.stylesIn(taught);
    const used = chosenStyle(place, picked);
    const said = styles.prompt(used, all, used !== null && used.name === defaultStyle(place));
    if (said !== "") lines.push(said);
  }
  if (!v2cloud.teachingKnown()) lines.push(`THIS CHANNEL'S ${word.toUpperCase()} STYLE COULDN'T BE READ from Edit's cloud just now: do what's asked plainly, tell the person once that its style didn't load and to ask again in a moment, and keep nothing this time.`);
  else if (!v2cloud.taughtAnything(channels.placesOf(place.channel, place.lane))) lines.push(`THIS CHANNEL'S ${word.toUpperCase()} STYLE ISN'T TAUGHT YET: do what's asked plainly, and build the style with the person as they say what it should be.`);
  if (teach === "none") return lines.join("\n\n");
  if (teach === "lesson") {
    // Script mode's revisions answer once with no tools: a lesson comes back in the answer (writer/lesson_note.ts) and is kept here.
    lines.push(
      // When to is LESSONS' (lesson_note.ts, beside this in the prompt); only where it goes is the lane's.
      v2cloud.teacher()
        ? `A lesson of how this channel does its ${MANY[place.lane]} goes with scope "channel" and a name (lower-case words joined by hyphens; one of the names above changes that lesson): it's kept in this channel's ${word} style at once, so its next ${single} has it.${group === null ? "" : ` ${groupRule()}`}`
        : NOT_TEACHER,
    );
    return lines.join("\n\n");
  }
  lines.push(
    `${v2cloud.teacher() ? keepRule(single, "keep it with remember, so the next of this channel's has it", true, group !== null) : NOT_TEACHER} ` +
      `When they point you at another channel's way, or ask to start from another channel's style, find it with other_channels and bring it in as this channel's own, to change here.` +
      (place.lane === "script"
        ? ""
        : channel !== null && channel.youtubeId === null
          ? " channel_videos shows what any channel's videos (by its link) get on YouTube: their titles, views, length and thumbnails. This one has none yet."
          : " channel_videos shows what this channel's videos (or any channel's, by its link) get on YouTube: their titles, views, length and thumbnails."),
  );
  return lines.join("\n\n");
}

/**
 * The lane's part of an agent's system prompt, after the house's guide: ""
 * for work that isn't a channel's.
 */
export function section(channel: string | null | undefined, lane: WorkLane, teach: Teach = "tools", guide = true, style: string | null = null): string {
  const place = placeOf(channel, lane);
  if (place === null) return "";
  // `guide`: a house guide comes before it, which the lane outranks; without one (a channel's script, writer/formats.ts `taught`), the lane is all there is.
  const lead = guide ? "What follows is this channel's own, taught by the team: where it differs from the guide above, it wins." : `What follows is everything this channel's ${MANY[lane]} are made from, taught by the team.`;
  return `\n\n# This channel's ${MANY[lane]}\n${lead}\n\n${laneText(place, teach, style)}`;
}

/** A lesson kept in a lane's style (its group's unless `given` "channel"): a teacher's (refused otherwise, in words for the person). */
export async function keepLesson(place: Place, name: string, text: string, reason: string, given?: unknown): Promise<string> {
  needCloud();
  await refresh();
  return remember({ skill: name, text, reason, ...(given !== undefined ? { for: given } : {}) }, place);
}

/** Whether the channel's scripts are taught in words beside its lessons: its Script lane's style on its page, or its group's. */
function laneWords(place: Place): boolean {
  const channel = channels.knownChannels().find((one) => one.key === place.channel) ?? null;
  return (channel?.lanes[place.lane]?.trim() ?? "") !== "" || (channels.groupOf(place.channel)?.lanes[place.lane]?.trim() ?? "") !== "";
}

/** The channel's default script style's name, or null (script_styles.ts `defaultIn`). */
export const defaultStyle = (place: Place): string | null => styles.defaultIn(lessonsOf(place), laneWords(place));

/** The style a script that names `picked` is written in, or null (script_styles.ts `chosen`). */
export const chosenStyle = (place: Place, picked: string | null | undefined): styles.Style | null => styles.chosen(lessonsOf(place), picked, laneWords(place));

/** The key a style of that name kept now would have (`given`, as keepStyle takes it). */
export const styleKey = (channel: string, name: string, given?: unknown): string => v2cloud.ownKey("skill", channels.keptIn(channel, "script", given).place, name);

/** The style of that name kept where a style kept now would go (`given`, as keepStyle takes it), or undefined: never one kept elsewhere (a channel's own, for its group). */
export function styleAt(channel: string, name: string, given?: unknown): v2cloud.Skill | undefined {
  const key = styleKey(channel, name, given);
  return lessonsOf({ channel, lane: "script" }).find((one) => one.name === name && one.key === key);
}

/** Where a style the channel has is kept: "channel" when it's this channel's own in a group, else undefined (its group's, or an ungrouped channel's). */
export function styleScope(channel: string, name: string): "channel" | undefined {
  const place: Place = { channel, lane: "script" };
  const found = lessonsOf(place).find((one) => one.name === name);
  return found !== undefined && channels.groupOf(channel) !== null && ownLesson(found, place) ? "channel" : undefined;
}

/**
 * Where making `name` the channel's default is kept so it takes: this channel's alone when the style is its own, or
 * when the channel already has a default of its own (one kept for its group would stay behind that).
 */
export function defaultScope(channel: string, name: string): "channel" | undefined {
  const place: Place = { channel, lane: "script" };
  const ownDefault = channels.groupOf(channel) !== null && lessonsOf(place).some((one) => one.name === styles.DEFAULT && ownLesson(one, place));
  return styleScope(channel, name) ?? (ownDefault ? "channel" : undefined);
}

/**
 * A script style kept whole (writer/style_learn.ts): a teacher's, in the channel's Script lane (its group's unless
 * `given` says this channel's). Never checked against the lessons: a style is meant to differ from them, and wins only
 * for the scripts written in it (script_styles.ts).
 */
export async function keepStyle(channel: string, name: string, text: string, reason: string, note: string, given?: unknown, read: { latest: number | null; key: string } | null = null): Promise<string> {
  needCloud();
  await refresh();
  teacherOnly("Keeping a script style");
  await channels.refresh();
  if (!styles.isStyle(name) || name === styles.DEFAULT) throw new Error(`${name} isn't a style's name`);
  if (text.length > styles.MOST) throw new Error(`a style is at most ${styles.MOST.toLocaleString("en-US")} characters`);
  const place: Place = { channel, lane: "script" };
  const kept = channels.keptIn(channel, "script", given);
  const key = v2cloud.ownKey("skill", kept.place, name);
  const before = lessonsOf(place).find((one) => one.name === name && one.key === key);
  // Saved over the version its learner read (`read`), never a newer one another teacher kept meanwhile, nor where it goes changed meanwhile (the channel moved group): said, and learned again.
  if (read !== null && read.key !== key) throw new Error("This channel's group changed while the style was learned, so it wasn't kept: ask again.");
  if (read !== null && read.latest === null && before !== undefined) throw new Error(`Someone else kept a ${name.slice(styles.PREFIX.length)} style while this was learned: ask again to add to theirs.`);
  const latest = read !== null ? read.latest : (before?.latest ?? null);
  const saved = await v2cloud.saveSkill(name, text, reason, note, { key, ...(latest !== null ? { latest } : {}) });
  v2cloud.forgetSkills();
  return `Kept the style ${name} (version ${saved.n}) in ${nameOf(channel)}'s script style${kept.words === "" ? "" : `, ${kept.words}`}.`;
}

/** Makes `name` the channel's default script style (`style-default`), where `keepStyle` would keep it. */
export async function keepDefaultStyle(channel: string, name: string, reason: string, given?: unknown): Promise<void> {
  needCloud();
  await refresh();
  teacherOnly("Choosing the channel's default script style");
  await channels.refresh();
  const place: Place = { channel, lane: "script" };
  const kept = channels.keptIn(channel, "script", given);
  const key = v2cloud.ownKey("skill", kept.place, styles.DEFAULT);
  const before = lessonsOf(place).find((one) => one.name === styles.DEFAULT && one.key === key);
  if (before?.text.trim() === name) return;
  await v2cloud.saveSkill(styles.DEFAULT, name, reason, "Which script style this channel's scripts are written in when none is asked for", { key, ...(before?.latest !== undefined ? { latest: before.latest } : {}) });
  v2cloud.forgetSkills();
}

/** The `for` a lane's keeping tools take. */
export const FOR_ARG = { type: "string", enum: ["group", "channel"], description: 'In a grouped channel: "group" (the default) keeps it for every channel in the group; "channel" for this channel alone, when the person says it\'s for this one.' };

// ---------------------------------------------------------------- the tools

/** The tools a lane's agent has, as MCP lists them (each agent serves them its own way). */
export function toolsFor(lane: WorkLane): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  const word = WORD[lane];
  const tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
    {
      name: "remember",
      description: `Keep a lesson for this channel's ${MANY[lane]}: what the person said holds beyond this one, or said yes to keeping when you asked (never what they let pass unanswered), in their words. A lesson is a line or two, always in your instructions from the next turn; a longer part with a note (when to read it), up to a whole guide (at most ${PART_MOST[lane].toLocaleString("en-US")} characters), is read with read_skill when it fits. The same name changes the lesson: with change, just the lines that change (any lesson, however long). A teacher's to do.`,
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Its name: lower-case letters, digits and hyphens (titles, hooks, pacing…)" },
          text: { type: "string", description: "The lesson, whole: in the person's words, general (never about this one only). Leave it out with change" },
          change: CHANGE_ARG,
          note: { type: "string", description: "Only for a longer part read when needed: when to read it (at most 160 characters)" },
          reason: { type: "string", description: "What the person said, quoted" },
          settled: { type: "string", description: "Only after a remember was refused for contradicting what's taught: the person's answer on which holds, quoted" },
          for: FOR_ARG,
        },
        required: ["skill", "reason"],
      },
    },
    {
      name: "forget",
      description: `Put one of this channel's ${word} lessons away: what the person means by forgetting or dropping something taught ("forget that", "that was for this video only"), a lesson you kept by mistake too. It leaves every one of this channel's agents from their next turn, its versions kept. To drop one line of a longer lesson, remember it with change instead; a script style is chosen with use_style, never put away here. A teacher's to do.`,
      inputSchema: { type: "object", properties: { skill: { type: "string", description: "The lesson's name, as your instructions list it" }, reason: { type: "string", description: "What the person said, quoted" } }, required: ["skill", "reason"] },
    },
    {
      name: "read_skill",
      description: `Read one of this channel's ${word} parts your instructions list, once per conversation, when it fits.`,
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "other_channels",
      description: `Another channel's ${word} style, only when the person points you at it or asks to start from it. No arguments: the other channels. channel: one channel's ${word} lessons. bring (with channel): a lesson's name, or "all" for the whole style as this channel's base, copied into this channel's own to change here (its group's, when it's in one, unless for says this channel alone; what's there already stays; a lesson that contradicts this channel's is left until the person says which holds).`,
      inputSchema: { type: "object", properties: { channel: { type: "string", description: "Its title, @handle or key" }, bring: { type: "string" }, for: FOR_ARG, settled: { type: "string", description: "Only after a bring left lessons for contradicting this channel's: the person's answer on which holds, quoted" } } },
    },
  ];
  if (lane !== "script") {
    tools.push({
      name: "channel_videos",
      description: "What a channel's videos get on YouTube: this channel's by default, or any channel's (one of the team's by name, or a link to any channel or one of its videos). top: its most viewed; recent: its newest. Each with its views, length, age, link and thumbnail.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Leave out for this channel; else a team channel's name or any YouTube link" },
          order: { type: "string", enum: ["top", "recent"] },
          count: { type: "number", description: "1 to 50 (25)" },
        },
      },
    });
  }
  return tools;
}

export const TOOL_NAMES = ["remember", "forget", "read_skill", "other_channels", "channel_videos"] as const;

function needCloud(): void {
  if (!v2cloud.enabled()) throw new Error("A channel's lessons need this computer signed in to Edit.");
}

function teacherOnly(what: string): void {
  if (!v2cloud.teacher()) throw new Error(`${what} is a teacher's to do (agent.teach; admins have it): this computer's account isn't one. Say so to the person: an admin can make them a teacher at accounts.spheceo.com.`);
  // Not read yet, a lesson kept now could replace one the team has, unseen (Nov 16 audit).
  if (!v2cloud.teachingKnown()) throw new Error(`What's taught couldn't be read from Edit's cloud yet, so nothing is kept now. Say so to the person, and keep it in a moment, once it reads.`);
}

function nameArg(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(value)) throw new Error(`${what} is lower-case letters, digits and hyphens: "${String(value)}" isn't`);
  return value;
}

/** One of the lane tools, answered in words; throws what the agent should be told. */
export async function call(name: string, args: Record<string, unknown>, place: Place): Promise<string> {
  needCloud();
  await refresh();
  if (name === "remember") return remember(args, place);
  if (name === "forget") return forget(args, place);
  if (name === "read_skill") {
    const wanted = nameArg(args.name, "name");
    const found = lessonsOf(place).find((one) => one.name === wanted);
    if (found === undefined) throw new Error(`no lesson ${wanted}: the ones there are in your instructions`);
    return found.text;
  }
  if (name === "other_channels") return otherChannels(place.channel, place.lane, args);
  if (name === "channel_videos") return channelVideos(args, place);
  throw new Error(`no tool ${name}`);
}

async function remember(args: Record<string, unknown>, place: Place): Promise<string> {
  teacherOnly(`Keeping a lesson for this channel's ${MANY[place.lane]}`);
  // Its group as it is now, not as it was when the turn began (a group made since: kept for it).
  await channels.refresh();
  const skill = nameArg(args.skill, "skill");
  // A channel's add-ons are kept by their own tool, never written over by hand.
  const reserved = v2cloud.reservedName(skill, place.lane);
  if (reserved !== null) throw new Error(reserved);
  if (args.change === undefined && (typeof args.text !== "string" || args.text.trim() === "")) throw new Error("text is required (or change, for part of a lesson that's there)");
  // A script style is learned whole from its references (writer/style_learn.ts) and its default chosen with use_style: remember only changes a style's lines.
  if (skill === styles.DEFAULT) throw new Error("The channel's default script style is chosen with use_style (default: true), never kept as a lesson.");
  if (styles.isStyle(skill) && args.change === undefined) throw new Error(`${skill} is a script style, learned whole from its references: change its lines with change, or learn it again from a reference (the producer pastes links and asks to learn the style).`);
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the person said");
  const note = typeof args.note === "string" && args.note.trim() !== "" ? args.note.trim() : undefined;
  if (note !== undefined && note.length > 160) throw new Error("note is at most 160 characters: when to read it");
  const kept = channels.keptIn(place.channel, place.lane, args.for);
  const key = v2cloud.ownKey("skill", kept.place, skill);
  const before = lessonsOf(place).find((one) => one.name === skill && one.key === key) ?? lessonsOf(place).find((one) => one.name === skill);
  // Part of one that's there, changed in place (any length): the rest stays word for word.
  const changing = args.change !== undefined;
  if (changing && before === undefined) throw new Error(`there's no ${skill} to change: give its text to keep it as a new lesson`);
  const changed = changing ? changeLesson(skill, before!.text, args.change) : { text: String(args.text).trim(), added: String(args.text).trim() };
  // A guide is never written over by a short lesson: its lines are changed with change, or what's new is a lesson of its own, which wins where they differ. Kept whole again (its next version, as long), it's the guide.
  if (!changing && before !== undefined && before.text.length > GUIDE_FROM && changed.text.length < before.text.length / 2) throw new Error(`${skill} is a guide (${before.text.length} characters): change its lines with change, or keep this as a lesson of its own`);
  const part = note !== undefined || before?.note !== undefined || (before?.text.length ?? 0) > MEMORY_MOST;
  const lane = PART_MOST[place.lane];
  const most = changing ? changedMost(part ? lane : MEMORY_MOST, before!.text.length) : part ? lane : MEMORY_MOST;
  // A style's examples are scripts with their times: it's held to its own length, never read as a transcript.
  const refused = styles.isStyle(skill) ? (changed.text.length > styles.MOST ? `a style is at most ${styles.MOST.toLocaleString("en-US")} characters` : null) : lessonRefusal(changed.text, place.lane, part, most);
  if (refused !== null) throw new Error(refused);
  // What it contradicts is said first, and kept only once the person says which holds (teaching_conflicts.ts): for a change, the words it puts in.
  const settled = typeof args.settled === "string" && args.settled.trim() !== "";
  const clashes = settled || changed.added === "" || styles.isStyle(skill) ? [] : await teachingConflicts.conflicts(skill, changed.added, lessonsOf(place).filter((one) => !styles.isStyle(one.name)));
  if (clashes !== null && clashes.length > 0) throw new teachingConflicts.Clash(clashes);
  const reason = settled ? `${args.reason.trim()} (settled against what was taught: ${String(args.settled).trim()})` : args.reason.trim();
  const saved = await v2cloud.saveSkill(skill, changed.text, reason, note ?? before?.note, { key, ...(before?.key === key && before.latest !== undefined ? { latest: before.latest } : {}) });
  // Kept for the group while this channel has its own of that name: the channel's still wins here.
  const shadowed = kept.place !== v2cloud.laneKey(place.channel, place.lane) && lessonsOf(place).some((one) => one.name === skill && ownLesson(one, place));
  v2cloud.forgetSkills();
  return `${changing ? "Changed" : "Kept as"} ${skill} (version ${saved.n}) in ${nameOf(place.channel)}'s ${WORD[place.lane]} style${kept.words === "" ? "" : `, ${kept.words}`}: its agents have it from their next turn.${shadowed ? ` This channel's own ${skill} still wins here: change that one (for: "channel") to change it for this channel.` : ""}${clashes === null ? teachingConflicts.UNCHECKED : ""}`;
}

/**
 * A lesson put away (Nov 25: told the watermark zoom JJ asked for on the 1957 murder script was "this video only",
 * the script's agent couldn't drop the lesson it had just kept: "I have no tool that does that"). Its versions stay.
 */
async function forget(args: Record<string, unknown>, place: Place): Promise<string> {
  teacherOnly(`Putting away a lesson of this channel's ${MANY[place.lane]}`);
  const skill = nameArg(args.skill, "skill");
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the person said");
  const reserved = v2cloud.reservedName(skill, place.lane);
  if (reserved !== null) throw new Error(reserved);
  if (skill === styles.DEFAULT || styles.isStyle(skill)) throw new Error(`${skill} is a script style: use_style chooses which one a script is written in, and its lines change with remember's change.`);
  const found = lessonsOf(place).find((one) => one.name === skill);
  if (found?.key === undefined) throw new Error(`no lesson ${skill} in ${nameOf(place.channel)}'s ${WORD[place.lane]} style: the ones there are in your instructions`);
  await v2cloud.archive(found.key, true);
  v2cloud.forgetSkills();
  diag.info("lanes", `${place.channel} ${place.lane}: put away ${found.key} (${args.reason.trim()})`);
  const group = ownLesson(found, place) ? "" : ", its group's, so every channel in the group";
  return `Put away ${skill} from ${nameOf(place.channel)}'s ${WORD[place.lane]} style${group}: its agents don't have it from their next turn (its versions are kept).`;
}

// ---------------------------------------------------------------- another channel's style

const STYLE_KINDS = ["skill", "template", "sound"] as const;
const KIND_WORD: Record<(typeof STYLE_KINDS)[number], string> = { skill: "lesson", template: "graphic", sound: "sound" };

/** A channel's lane: its own lessons and its group's (and, for the edit and thumbnails, the effects and sounds kept) in V2's library, its own winning by name. */
async function styleOf(channel: string, lane: v2cloud.Lane): Promise<v2cloud.Item[]> {
  const places = channels.placesOf(channel, lane);
  const all = (await Promise.all(STYLE_KINDS.map((kind) => v2cloud.list(kind)))).flat();
  return STYLE_KINDS.flatMap((kind) => v2cloud.forPlace(all.filter((item) => item.kind === kind && places.includes(v2cloud.ownPlaceOf(item.key) ?? "")), places));
}

/**
 * The other channel whose style a message asks to start from ("start from Female Felons' script style"), or null:
 * another channel named by its title or @handle, beside the word "style". A first build's note may ask it, before
 * the script's chat (and its other_channels) exists (Sphe, Nov 25: Daily Interrogation's first script, from Female
 * Felons' style).
 */
export function styleAskedFrom(mine: string, note: string): channels.Channel | null {
  if (!/\bstyles?\b/i.test(note)) return null;
  const words = note.toLowerCase().replace(/[’‘]/g, "'");
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const others = channels.knownChannels().filter((one) => one.key !== mine && one.archived !== true);
  // The longest title first, so a channel whose title holds another's ("Sam's Interrogations" and "Interrogations") is the one meant.
  const byLength = [...others].sort((a, b) => b.title.length - a.title.length);
  return (
    byLength.find((one) => {
      const title = one.title.trim().toLowerCase().replace(/[’‘]/g, "'");
      if (title !== "" && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(title)}($|[^\\p{L}\\p{N}])`, "u").test(words)) return true;
      return typeof one.handle === "string" && one.handle !== "" && new RegExp(`@${escape(one.handle.toLowerCase())}($|[^\\p{L}\\p{N}_.-])`, "u").test(words);
    }) ?? null
  );
}

/** The channel the words name: its key, its @handle or its title. */
function named(all: channels.Channel[], given: string): channels.Channel {
  const words = given.trim().replace(/^@/, "").toLowerCase();
  const found = all.find((one) => one.key === words || one.handle?.toLowerCase() === words || one.title.toLowerCase() === words) ?? all.find((one) => one.title.toLowerCase().includes(words));
  if (found === undefined) throw new Error(`no channel "${given}": the channels are ${all.map((one) => one.title).join(", ") || "none yet"}`);
  return found;
}

/**
 * Another channel's style in one lane (Sphe, Nov 14: "Other channels' editing
 * styles shouldn't be easily accessible to the agent. It has to make the
 * decision to go out and find it"): the other channels, one's style, or a
 * piece of it (or all of it, as a base) brought into this channel's own.
 */
export async function otherChannels(mine: string, lane: v2cloud.Lane, args: Record<string, unknown>): Promise<string> {
  const word = WORD[lane];
  const kindWord = (kind: string) => (lane === "edit" && kind === "template" ? "effect" : (KIND_WORD[kind as (typeof STYLE_KINDS)[number]] ?? kind));
  // A channel's add-ons (addons.ts) are no lesson: never listed or counted as one, and brought with the whole style
  // (a channel started from another runs what it ran), said as what they are.
  const shown = (style: v2cloud.Item[]) => style.filter((one) => !(one.kind === "skill" && v2cloud.isAddon(one.name)));
  const itemWords = (item: v2cloud.Item) => (item.kind === "skill" && v2cloud.isAddon(item.name) ? `add-on ${item.name.slice(v2cloud.ADDON_PREFIX.length)}` : `${kindWord(item.kind)} ${item.name}`);
  const others = (await channels.list()).filter((one) => one.key !== mine);
  if (typeof args.channel !== "string" || args.channel.trim() === "") {
    if (others.length === 0) return "There are no other channels.";
    const counts = await Promise.all(others.map(async (one) => shown(await styleOf(one.key, lane)).length));
    return others.map((one, at) => `- ${one.title}${one.handle ? ` (@${one.handle})` : ""}: ${counts[at] === 0 ? "nothing taught yet" : `${counts[at]} ${lane === "edit" ? "lessons, effects and sounds" : lane === "thumbnails" ? "lessons and graphics" : "lessons"}`}${one.lanes[lane] ? `. Its ${word} style: ${one.lanes[lane]}` : ""}`).join("\n") + "\nother_channels with channel shows one's; bring copies a piece of it here.";
  }
  const from = named(others, args.channel);
  const style = await styleOf(from.key, lane);
  if (args.bring === undefined) {
    if (shown(style).length === 0) return `${from.title}'s ${word} style has nothing taught yet.`;
    return `${from.title}'s ${word} style${from.lanes[lane] ? ` ("${from.lanes[lane]}")` : ""}:\n${shown(style).map((one) => `- ${kindWord(one.kind)} ${one.name}${one.category ? ` [${one.category}]` : ""}: ${one.note ?? ""}`).join("\n")}\nbring: a name, or "all" for the whole style as this channel's base.`;
  }
  if (typeof args.bring !== "string" || args.bring.trim() === "") throw new Error(`bring is a name from that channel's style, or "all"`);
  const wanted = args.bring.trim() === "all" ? style : style.filter((one) => one.name === args.bring);
  if (wanted.length === 0) throw new Error(`${from.title}'s ${word} style has no ${args.bring}: other_channels with channel lists it`);
  teacherOnly(`Bringing another channel's ${word} style in`);
  const { place, words } = channels.keptIn(mine, lane, args.for);
  const mineNow = new Set((await styleOf(mine, lane)).map((one) => `${one.kind}:${one.name}`));
  const brought: string[] = [];
  const kept: string[] = [];
  // A lesson brought in that contradicts this channel's is said first, as a kept one is (teaching_conflicts.ts).
  // An answer on which holds settles the one lesson it was about, so it counts only when one is brought by its name:
  // a whole style brought again is checked again, and the person is asked about each that clashes.
  const settled = typeof args.settled === "string" && args.settled.trim() !== "" && args.bring.trim() !== "all";
  // What's taught here, and each lesson as it comes in, so two brought together that clash are caught too.
  const here = [...v2cloud.memories(channels.placesOf(mine, lane))];
  const clashing: teachingConflicts.Conflict[] = [];
  const unchecked: string[] = [];
  for (const item of wanted) {
    // What this channel has of its own already stays: bringing never writes over it.
    if (mineNow.has(`${item.kind}:${item.name}`)) {
      kept.push(item.name);
      continue;
    }
    // An add-on is never checked against the lessons: it's no lesson.
    const text = item.kind === "skill" && !v2cloud.isAddon(item.name) ? (await v2cloud.version(item.key))?.version.text : undefined;
    if (typeof text === "string" && !settled) {
      const found = await teachingConflicts.conflicts(item.name, text, here);
      if (found === null) unchecked.push(item.name);
      else if (found.length > 0) {
        clashing.push(...found.map((one) => ({ ...one, why: `${item.name}: ${one.why}` })));
        continue;
      }
    }
    if (await v2cloud.copyItem(item, v2cloud.ownKey(item.kind as (typeof STYLE_KINDS)[number], place, item.name), `brought from ${from.title}'s ${word} style`)) {
      brought.push(itemWords(item));
      if (typeof text === "string") here.push({ name: item.name, text, ...(item.note ? { note: item.note } : {}) });
    }
  }
  v2cloud.forgetSkills();
  return (
    (brought.length === 0 ? "Nothing new brought." : `Brought into this channel's own ${word} style${words === "" ? "" : ` (${words})`}, to change here: ${brought.join(", ")}.`) +
    (kept.length > 0 ? ` This channel has its own ${kept.join(", ")} already, kept as they are.` : "") +
    (unchecked.length > 0 ? `\n${unchecked.join(", ")} couldn't be checked against what's taught here just now: if one might clash with a lesson here, say so to the person.` : "") +
    (clashing.length > 0 ? `\n${teachingConflicts.refusal(clashing)} (Here: bring each again by its name with settled.)` : "")
  );
}

// ---------------------------------------------------------------- YouTube's numbers

async function channelVideos(args: Record<string, unknown>, place: Place): Promise<string> {
  const order = args.order === "recent" ? "recent" : "top";
  const count = typeof args.count === "number" ? Math.max(1, Math.min(50, Math.round(args.count))) : 25;
  let link: string;
  if (typeof args.channel === "string" && args.channel.trim() !== "") {
    const words = args.channel.trim();
    const ours = channels.knownChannels().find((one) => [one.key, one.handle?.toLowerCase(), one.title.toLowerCase()].includes(words.replace(/^@/, "").toLowerCase()));
    if (ours !== undefined && ours.youtubeId === null) return ours.masked === true ? `${ours.title}'s videos aren't shown to this account.` : `${ours.title} isn't on YouTube yet: it has no videos to read.`;
    link = ours?.youtubeId ?? words;
  } else {
    const mine = channels.knownChannels().find((one) => one.key === place.channel);
    if (mine === undefined) throw new Error("This channel isn't among the ones this account sees now (put away, or no longer given), so its videos can't be read: say so to the person; read another channel's with channel.");
    if (mine.youtubeId === null) return mine.masked === true ? `${mine.title}'s own videos aren't shown to this account. Read another channel's with channel.` : `${mine.title} isn't on YouTube yet: it has no videos of its own. Read another channel's with channel.`;
    link = mine.youtubeId;
  }
  const found = await channels.videosOf(link, order, count);
  if (found.videos.length === 0) return `${found.channel.title} has no videos on YouTube.`;
  return (
    `${found.channel.title}'s ${order === "top" ? "most viewed" : "newest"} videos:\n` +
    found.videos.map((video, at) => `${at + 1}. ${channels.videoLine(video)}${place.lane === "thumbnails" && video.thumbnail ? `\n   thumbnail: ${video.thumbnail}` : ""}`).join("\n")
  );
}
