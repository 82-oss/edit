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
import { groupRule, keepRule } from "./teaching.ts";
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

export function laneText(place: Place, teach: Teach = "tools"): string {
  const channel = channels.knownChannels().find((one) => one.key === place.channel) ?? null;
  const word = WORD[place.lane];
  // One of them, for the rule's "this idea", "every idea".
  const single = place.lane === "ideas" ? "idea" : word;
  // One of them, for the rule's "this idea", "every idea".
  const style = channel?.lanes[place.lane]?.trim() ?? "";
  const group = channels.groupOf(place.channel);
  const shared = group?.lanes[place.lane]?.trim() ?? "";
  const lessons = lessonsOf(place);
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
  if (parts.length > 0) lines.push(`Read one with read_skill when it fits, once per conversation:\n${parts.map((one) => `- ${one.name}${mineOnly(one)}: ${one.note}`).join("\n")}`);
  if (!v2cloud.taughtAnything(channels.placesOf(place.channel, place.lane))) lines.push(`THIS CHANNEL'S ${word.toUpperCase()} STYLE ISN'T TAUGHT YET: do what's asked plainly, and build the style with the person as they say what it should be.`);
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
export function section(channel: string | null | undefined, lane: WorkLane, teach: Teach = "tools"): string {
  const place = placeOf(channel, lane);
  if (place === null) return "";
  return `\n\n# This channel's ${MANY[lane]}\nWhat follows is this channel's own, taught by the team: where it differs from the guide above, it wins.\n\n${laneText(place, teach)}`;
}

/** A lesson kept in a lane's style (its group's unless `given` "channel"): a teacher's (refused otherwise, in words for the person). */
export async function keepLesson(place: Place, name: string, text: string, reason: string, given?: unknown): Promise<string> {
  needCloud();
  await refresh();
  return remember({ skill: name, text, reason, ...(given !== undefined ? { for: given } : {}) }, place);
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
      description: `Keep a lesson for this channel's ${MANY[lane]}: what the person said holds beyond this one, or said yes to keeping when you asked (never what they let pass unanswered), in their words. A lesson is a line or two, always in your instructions from the next turn; a longer part (at most 2,400 characters) with a note (when to read it) is read with read_skill when it fits. The same name changes the lesson. A teacher's to do.`,
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Its name: lower-case letters, digits and hyphens (titles, hooks, pacing…)" },
          text: { type: "string", description: "The lesson, whole: in the person's words, general (never about this one only)" },
          note: { type: "string", description: "Only for a longer part read when needed: when to read it (at most 160 characters)" },
          reason: { type: "string", description: "What the person said, quoted" },
          for: FOR_ARG,
        },
        required: ["skill", "text", "reason"],
      },
    },
    {
      name: "read_skill",
      description: `Read one of this channel's ${word} parts your instructions list, once per conversation, when it fits.`,
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "other_channels",
      description: `Another channel's ${word} style, only when the person points you at it or asks to start from it. No arguments: the other channels. channel: one channel's ${word} lessons. bring (with channel): a lesson's name, or "all" for the whole style as this channel's base, copied into this channel's own to change here (its group's, when it's in one, unless for says this channel alone; what's there already stays).`,
      inputSchema: { type: "object", properties: { channel: { type: "string", description: "Its title, @handle or key" }, bring: { type: "string" }, for: FOR_ARG } },
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

export const TOOL_NAMES = ["remember", "read_skill", "other_channels", "channel_videos"] as const;

/** A lesson is a line or two; a part (with a note) is longer, and still short. */
const MEMORY_MOST = 400;
const PART_MOST = 2_400;

function needCloud(): void {
  if (!v2cloud.enabled()) throw new Error("A channel's lessons need this computer signed in to Edit.");
}

function teacherOnly(what: string): void {
  if (!v2cloud.teacher()) throw new Error(`${what} is a teacher's to do (agent.teach; admins have it): this computer's account isn't one. Say so to the person: an admin can make them a teacher at accounts.spheceo.com.`);
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
  const skill = nameArg(args.skill, "skill");
  if (typeof args.text !== "string" || args.text.trim() === "") throw new Error("text is required");
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the person said");
  const note = typeof args.note === "string" && args.note.trim() !== "" ? args.note.trim() : undefined;
  if (note !== undefined && note.length > 160) throw new Error("note is at most 160 characters: when to read it");
  const kept = channels.keptIn(place.channel, place.lane, args.for);
  const key = v2cloud.ownKey("skill", kept.place, skill);
  const before = lessonsOf(place).find((one) => one.name === skill && one.key === key) ?? lessonsOf(place).find((one) => one.name === skill);
  const part = note !== undefined || before?.note !== undefined || (before?.text.length ?? 0) > MEMORY_MOST;
  const most = part ? PART_MOST : MEMORY_MOST;
  if (args.text.length > most) throw new Error(`at most ${most} characters (this is ${args.text.length}): ${part ? "keep the part short: its rules, not their history" : "a line or two, in the person's words"}`);
  const saved = await v2cloud.saveSkill(skill, args.text.trim(), args.reason.trim(), note ?? before?.note, { key });
  // Kept for the group while this channel has its own of that name: the channel's still wins here.
  const shadowed = kept.place !== v2cloud.laneKey(place.channel, place.lane) && lessonsOf(place).some((one) => one.name === skill && ownLesson(one, place));
  v2cloud.forgetSkills();
  return `Kept as ${skill} (version ${saved.n}) in ${nameOf(place.channel)}'s ${WORD[place.lane]} style${kept.words === "" ? "" : `, ${kept.words}`}: its agents have it from their next turn.${shadowed ? ` This channel's own ${skill} still wins here: change that one (for: "channel") to change it for this channel.` : ""}`;
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
  const others = (await channels.list()).filter((one) => one.key !== mine);
  if (typeof args.channel !== "string" || args.channel.trim() === "") {
    if (others.length === 0) return "There are no other channels.";
    const counts = await Promise.all(others.map(async (one) => (await styleOf(one.key, lane)).length));
    return others.map((one, at) => `- ${one.title}${one.handle ? ` (@${one.handle})` : ""}: ${counts[at] === 0 ? "nothing taught yet" : `${counts[at]} ${lane === "edit" ? "lessons, effects and sounds" : lane === "thumbnails" ? "lessons and graphics" : "lessons"}`}${one.lanes[lane] ? `. Its ${word} style: ${one.lanes[lane]}` : ""}`).join("\n") + "\nother_channels with channel shows one's; bring copies a piece of it here.";
  }
  const from = named(others, args.channel);
  const style = await styleOf(from.key, lane);
  if (args.bring === undefined) {
    if (style.length === 0) return `${from.title}'s ${word} style has nothing taught yet.`;
    return `${from.title}'s ${word} style${from.lanes[lane] ? ` ("${from.lanes[lane]}")` : ""}:\n${style.map((one) => `- ${kindWord(one.kind)} ${one.name}${one.category ? ` [${one.category}]` : ""}: ${one.note ?? ""}`).join("\n")}\nbring: a name, or "all" for the whole style as this channel's base.`;
  }
  if (typeof args.bring !== "string" || args.bring.trim() === "") throw new Error(`bring is a name from that channel's style, or "all"`);
  const wanted = args.bring.trim() === "all" ? style : style.filter((one) => one.name === args.bring);
  if (wanted.length === 0) throw new Error(`${from.title}'s ${word} style has no ${args.bring}: other_channels with channel lists it`);
  teacherOnly(`Bringing another channel's ${word} style in`);
  const { place, words } = channels.keptIn(mine, lane, args.for);
  const mineNow = new Set((await styleOf(mine, lane)).map((one) => `${one.kind}:${one.name}`));
  const brought: string[] = [];
  const kept: string[] = [];
  for (const item of wanted) {
    // What this channel has of its own already stays: bringing never writes over it.
    if (mineNow.has(`${item.kind}:${item.name}`)) {
      kept.push(item.name);
      continue;
    }
    if (await v2cloud.copyItem(item, v2cloud.ownKey(item.kind as (typeof STYLE_KINDS)[number], place, item.name), `brought from ${from.title}'s ${word} style`)) brought.push(`${kindWord(item.kind)} ${item.name}`);
  }
  v2cloud.forgetSkills();
  return (
    (brought.length === 0 ? "Nothing new brought." : `Brought into this channel's own ${word} style${words === "" ? "" : ` (${words})`}, to change here: ${brought.join(", ")}.`) +
    (kept.length > 0 ? ` This channel has its own ${kept.join(", ")} already, kept as they are.` : "")
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
    if (mine === undefined) throw new Error("this channel isn't read yet: try again in a moment");
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
