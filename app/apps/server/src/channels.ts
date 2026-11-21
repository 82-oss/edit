// Channels (Nov 14; Sphe: "I do think we need to categorize things by
// channel"): the team's YouTube channels, each its own record in mamagi
// (accounts' convex/channels.ts), added by pasting any link to it (the relay
// reads it with YouTube's API: channels.ts there). A channel has lanes, one per
// part of the work (ideas, thumbnails, script, edit), each with its own style:
// a description, and what its agent has been taught, in V2's library under the
// lane's key (`laneKey`). How its videos are made is set up once, after it's
// added: who narrates (a voice, or the editor's recording) and whether it's a
// compilation channel. Channels are V2's (the beta). A placeholder (Sphe,
// Nov 15) is a channel by its name alone, before it's on YouTube: linked to
// its YouTube channel once it's made, its key stays, so its teaching does.
// Who sees which is mamagi's (Sphe, Nov 15): an admin every channel, anyone
// else those given on accounts.spheceo.com, in full or by its label alone
// ("Bodycam Channel 1": `masked`, nothing YouTube says, a placeholder's look),
// so this server and its agents only ever have what its person may see.
// A group (Nov 15, mamagi's groups.ts; Sphe: "it should apply a shared system
// instead of duplicating the learning across the channels") is channels that
// share one style: each lane is taught once to the group (`laneKey(group,
// lane)`), and a channel in it reads the group's and its own, its own winning
// by name ("for this specific channel, we want things done like this"). Work
// always belongs to one channel; the group only says what its agents read and
// where a lesson is kept (`keptIn`).
//
//   GET    /api/channels                {channels, teacher}
//   GET    /api/channels/resolve?url=   {channel}: what YouTube says, not saved
//   POST   /api/channels                {url} or {title} → {channel}: added, or a placeholder by its name (a teacher's)
//   POST   /api/channels/{key}/link     {url} → {channel}: a placeholder linked to its YouTube channel
//   GET    /api/channels/{key}          {channel, taught: {<lane>: [what its agent knows]}, teacher}
//   PUT    /api/channels/{key}          {narration?, compilation?, lanes?, label?, watermark?, watermarkLook?} → {channel}
//   GET    /api/channels/{key}/watermark   its watermark's picture (channel_marks.ts)
//   POST   /api/channels/{key}/watermark   a picture's bytes → {channel}: uploaded as its watermark (a teacher's)
//   DELETE /api/channels/{key}          put away (its teaching kept)
//   POST   /api/channels/{key}/restore  brought back (an admin, or who sees it in full)
//   GET    /api/channels/voices         {voices, used}: who could narrate, and who narrates for whom already
//   GET    /api/channels/{key}/videos?order=top|recent   {channel, videos}: its most viewed or newest, with their numbers
//   POST   /api/channels/{key}/projects/{id}   an edit project moved onto the channel (its Edit lane from its next turn); today's kind of edit made its Edit V2 project (channel_move.ts)
//   GET    /api/groups/{key}            {group, taught, teacher}
//   POST   /api/groups                  {channels, from} → {group}: made, `from`'s teaching moved into it
//   PUT    /api/groups/{key}            {lanes} → {group}
//   DELETE /api/groups/{key}            put away: every channel taken out with a copy of its teaching
//   POST   /api/groups/{key}/channels   {channel}: added, its own teaching kept as its exceptions
//   DELETE /api/groups/{key}/channels/{channel}   taken out, with a copy of the group's teaching
//   POST   /api/groups/{key}/move       {item}: a channel's own item moved into the group

import { HOUSE_LOOK, LOOK_RANGE, markOf, type WatermarkLook } from "@edit/types/watermark";

import type { App } from "./app.ts";
import * as beta from "./beta.ts";
import * as accounts from "./accounts.ts";
import * as cloud from "./cloud.ts";
import * as kinds from "./kinds.ts";
import * as diag from "./diag.ts";
import { STYLES, type Style } from "./model.ts";
import { voiceFor } from "./styles.ts";
import { HOUSE_VOICE } from "./voice.ts";
import { ApiError, bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";
import * as relay from "./relay.ts";
import { agentPanel } from "./seams.ts";
import * as v2cloud from "./v2_cloud.ts";

export const LANES = v2cloud.LANES;
export type Lane = v2cloud.Lane;
export const laneKey = v2cloud.laneKey;
export const laneOf = v2cloud.laneOf;

export type Narration = { kind: "voice"; id: string; name: string } | { kind: "recorded" };

export interface Channel {
  key: string;
  /** null: a placeholder, not on YouTube yet. */
  youtubeId: string | null;
  handle: string | null;
  title: string;
  /** What someone allowed only its label sees for its name ("Channel 2" unless set; missing from a mamagi before labels). */
  label?: string;
  /** Seen by its label alone: `title` is the label, and nothing YouTube says of it is here. */
  masked?: boolean;
  description: string;
  avatar: string | null;
  banner: string | null;
  uploads: string | null;
  subscribers: number | null;
  videos: number | null;
  views: number | null;
  country: string | null;
  publishedAt: string | null;
  fetchedAt: number;
  /** Who narrates its videos; null until it's set up. */
  narration: Narration | null;
  compilation: boolean;
  /**
   * Its watermark (Sphe, Nov 16: "show watermarks when available for that
   * specific channel"): its picture's Drive id in the Watermarks folder
   * (channel_marks.ts), linked to the channel, never its name. null: none, so
   * its exports offer none (seen by its label alone too); missing from a
   * mamagi before watermarks.
   */
  watermark?: string | null;
  /** Its watermark uploaded on its page instead ({sha256, ext}: on Edit's cloud under its key, channel_marks.ts); null or missing: none. */
  watermarkUpload?: { sha256: string; ext: "png" | "jpg" | "webp" } | null;
  /** How its watermark looks and moves on its exports, set on its page; null or missing: the house look. */
  watermarkLook?: WatermarkLook | null;
  /** Its ideas' Trello board, pasted on its page (Sphe, Nov 18): its ideas use it, not a niche's; null or missing: none (or seen by its label alone). */
  trello?: Trello | null;
  /** Its competitors as the team wrote them (links, names, a Google Doc), read by its ideas; null or missing: none. */
  competitors?: string | null;
  lanes: Record<Lane, string>;
  archived: boolean;
  /** Its group's key (missing from a mamagi before groups). */
  group?: string | null;
  addedBy: { name: string } | null;
  at: number;
}

/** A channel's ideas board, as the relay read it from a pasted link: the lists its ideas are sent to are its `lanes`. */
export interface Trello {
  boardId: string;
  name: string;
  url: string;
  lanes: { id: string; name: string }[];
}

const TRELLO_ID = /^[a-f0-9]{24}$/;

/** A board as the page sends it back to be kept, or null for none. */
function trelloOf(given: unknown): Trello | null {
  if (given === null) return null;
  const value = given as Partial<Trello> | undefined;
  const lanes = Array.isArray(value?.lanes) ? value.lanes : null;
  if (typeof value?.boardId !== "string" || !TRELLO_ID.test(value.boardId) || typeof value.name !== "string" || typeof value.url !== "string" || lanes === null || !lanes.every((lane) => typeof lane?.id === "string" && TRELLO_ID.test(lane.id) && typeof lane.name === "string")) {
    throw bad("trello is the board read from its link ({boardId, name, url, lanes}), or null for none");
  }
  return { boardId: value.boardId, name: value.name, url: value.url, lanes: lanes.map((lane) => ({ id: lane.id, name: lane.name })) };
}

/** Channels sharing one style, as this person may see it: only the channels they see. It has no name: it's its channels together (`groupName`). */
export interface Group {
  key: string;
  lanes: Record<Lane, string>;
  channels: string[];
}

/** A placeholder: not on YouTube yet, so none of YouTube's numbers. */
export const placeholder = (channel: Channel) => channel.youtubeId === null && channel.masked !== true;

/** What an agent calls it: "Dr Insanity (@drinsanity), on YouTube", or a placeholder's name. */
export function channelName(channel: Channel): string {
  if (channel.masked === true) return `${channel.title}, on YouTube`;
  return channel.youtubeId === null ? `${channel.title} (a new channel, not on YouTube yet)` : `${channel.title}${channel.handle ? ` (@${channel.handle})` : ""}, on YouTube`;
}

/** Whether it's set up: its narration chosen (onboarding's step). */
export const setUp = (channel: Channel) => channel.narration !== null;

function needCloud(): void {
  if (!v2cloud.enabled()) throw bad("Channels need this computer signed in to Edit.");
}

export function needTeacher(): void {
  needCloud();
  if (!v2cloud.teacher()) throw new ApiError(403, "Adding a channel or changing one is a teacher's: an admin can make you one at accounts.spheceo.com.");
}

/**
 * The channels, newest change first (what's put away only with `archived`).
 * Read with those put away every time, and kept so: a put-away channel's
 * projects are still its own, and still in its group (Nov 16 audit: its
 * projects lost the group's teaching), but it's never in a list or a picker.
 */
export async function list(archived = false): Promise<Channel[]> {
  const [found, groups] = await Promise.all([cloud.query("channels:listChannels", { archived: true }) as Promise<Channel[]>, listGroups(true)]);
  known = found;
  knownGroupList = groups;
  readAt = Date.now();
  return archived ? found : found.filter((one) => !one.archived);
}

/** The groups this person sees, with their put-away channels when `archived` ([] from a mamagi or a relay before groups: every channel then stands alone). */
async function listGroups(archived = false): Promise<Group[]> {
  try {
    return (await cloud.query("groups:listGroups", archived ? { archived: true } : {})) as Group[];
  } catch (error) {
    diag.warn("channels", `the channel groups from the cloud: ${diag.messageOf(error)}`);
    return [];
  }
}

/** The channels as last read, put-away ones too (to find a project's): an agent's instructions are written from them without waiting (`refresh` at a turn's start). */
let known: Channel[] = [];
/** The groups as last read, with their put-away channels. */
let knownGroupList: Group[] = [];
let readAt = 0;
const FRESH_MS = 30_000;

/** Every channel as last read, those put away too: for finding work's channel, never for a list. */
export function knownChannels(): Channel[] {
  return known;
}

/** Whether a channel was put away, as last read. */
const putAway = (key: string) => known.find((one) => one.key === key)?.archived === true;

/** A group as it's shown: its channels that aren't put away; null when none is left. */
function shownGroup(group: Group): Group | null {
  const channels = group.channels.filter((key) => !putAway(key));
  return channels.length === 0 ? null : { ...group, channels };
}

/** The groups as they're shown (their put-away channels left out), as last read. */
export function knownGroups(): Group[] {
  return knownGroupList.map(shownGroup).filter((one): one is Group => one !== null);
}

/** A channel's group, as last read; null when it's in none. */
export function groupOf(channel: string): Group | null {
  const key = known.find((one) => one.key === channel)?.group ?? knownGroupList.find((one) => one.channels.includes(channel))?.key ?? null;
  if (key === null) return null;
  return knownGroupList.find((one) => one.key === key) ?? { key, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, channels: [channel] };
}

/** "A & B", "A, B & C". */
export const joined = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`);

/** A group as it's called: its channels' names together (labels for one seen by its label alone; those put away left out unless that's all), as last read. */
export function groupName(group: Group): string {
  const named = (shownGroup(group) ?? group).channels;
  return joined(named.map((key) => known.find((one) => one.key === key)?.title).filter((one): one is string => one !== undefined));
}

/** Where a channel's lane is taught, nearest first: its own place, then its group's when it's in one. */
export function placesOf(channel: string, lane: Lane): string[] {
  const group = groupOf(channel);
  return group === null ? [laneKey(channel, lane)] : [laneKey(channel, lane), laneKey(group.key, lane)];
}

/** A V2 project's places (its channel's edit lane, then its group's); null for one made without a channel. */
export function placesOfProject(project: { channel?: string | null }): string[] | null {
  return typeof project.channel === "string" && project.channel !== "" ? placesOf(project.channel, "edit") : null;
}

/**
 * Where a lesson of a channel's lane is kept, and how it's said ("" in no group): its group's
 * unless it's for this channel alone (`given` "channel"; the agent's tools
 * take `for`), a channel in no group its own.
 */
export function keptIn(channel: string, lane: Lane, given: unknown): { place: string; words: string } {
  if (given !== undefined && given !== null && given !== "group" && given !== "channel") throw new Error('for is "group" or "channel"');
  const group = groupOf(channel);
  // Said only for a grouped channel: an ungrouped one's words stay as they were.
  if (group === null) return { place: laneKey(channel, lane), words: "" };
  return given === "channel" ? { place: laneKey(channel, lane), words: "for this channel only" } : { place: laneKey(group.key, lane), words: `for the group (${groupName(group)})` };
}

/**
 * What a grouped channel's agent is told of its group: the other channels in
 * it it may see (by their labels when that's all it's given), which are
 * compilations, and that they share one style. "" for a channel in none.
 */
export function groupText(channel: string, word: string): string {
  const group = groupOf(channel);
  if (group === null) return "";
  const others = group.channels.filter((key) => key !== channel).map((key) => known.find((one) => one.key === key)).filter((one): one is Channel => one !== undefined && !one.archived);
  const named = others.map((one) => `${one.title}${one.compilation ? " (compilations)" : ""}`);
  const mine = known.find((one) => one.key === channel);
  return (
    `It's in a group${named.length === 0 ? "" : ` with ${joined(named)}`}: they share one ${word} style, the group's, taught once for all of them${mine?.compilation ? "; this channel's videos are compilations" : ""}. ` +
    `What's taught for this channel alone is its exceptions, and wins over the group's where they differ.`
  );
}

/** A project's channel, as last read (null: none, or not read yet). */
export function channelOf(project: { channel?: string | null }): Channel | null {
  return typeof project.channel === "string" && project.channel !== "" ? (known.find((one) => one.key === project.channel) ?? null) : null;
}

/**
 * The voice a project's voice-overs are made in: its channel's narrator when the channel narrates with a voice, else
 * its style's (styles.ts `voiceFor`, null for the house voice). Nov 21: every voice-over took its style's voice, so a
 * channel set up with its own narrator was voiced by the courtroom's or the house's. Only the voice's id: the channel
 * keeps no settings of its own (model, speed), so they're the house's, as a style's voice has them. A channel's
 * project whose channel isn't read yet is read first (bounded, `refresh`); one still not found keeps its style's.
 */
export async function voiceOf(project: { style: Style; channel?: string | null }): Promise<string | null> {
  if (typeof project.channel === "string" && project.channel !== "") {
    await refresh();
    const channel = channelOf(project);
    if (channel?.narration?.kind === "voice") return channel.narration.id;
    if (channel === null) diag.warn("channels", `channel ${project.channel} isn't known here: its voice-over is made in its style's voice`);
  }
  return voiceFor(project.style);
}

/** A channel's watermark as its exports carry it (channel_marks.ts' mark: its picture, uploaded or Drive's, and its look); undefined: it has none. */
export function markFor(channel: Channel): string | undefined {
  const upload = channel.watermarkUpload;
  if (upload !== null && upload !== undefined) return markOf({ kind: "upload", channel: channel.key, sha256: upload.sha256, ext: upload.ext }, channel.watermarkLook);
  return typeof channel.watermark === "string" && channel.watermark !== "" ? markOf({ kind: "drive", id: channel.watermark }, channel.watermarkLook) : undefined;
}

/**
 * The watermark a project's exports carry, from the one picked (a mark, or
 * a picture's Drive id; undefined: none): a channel's project its channel's
 * own, at its look, when one is picked and the channel has one, else none (a
 * GTA 6 project was offered Sams Interrogations', Nov 16); a project of no
 * channel, or one whose channel isn't read, the one picked.
 */
export function watermarkFor(project: { channel?: string | null }, picked: string | undefined): string | undefined {
  const channel = channelOf(project);
  if (channel === null || picked === undefined) return picked;
  return markFor(channel);
}

/** `watermarkFor` with the channels read again first when they're older than 30 s (an export about to start). */
export async function watermarkOf(project: { channel?: string | null }, picked: string | undefined): Promise<string | undefined> {
  if (picked !== undefined && typeof project.channel === "string" && project.channel !== "") await refresh();
  return watermarkFor(project, picked);
}

/** The read under way, which every caller shares (a turn starting while another's read was out got no channels, so no group). */
let reading: Promise<void> | null = null;

/** Reads the channels again, at most every 30 s (a turn's start asks), waiting at most v2cloud.SKILLS_WAIT_MS: a failure keeps what was read before, and is tried again in 5 s. */
export async function refresh(): Promise<void> {
  if (!v2cloud.enabled()) return;
  if (reading === null && Date.now() - readAt < FRESH_MS) return;
  reading ??= (async () => {
    try {
      await list();
      readAt = Date.now();
    } catch (error) {
      readAt = Date.now() - FRESH_MS + 5_000;
      diag.warn("channels", `the channels from the cloud: ${diag.messageOf(error)}`);
    } finally {
      reading = null;
    }
  })();
  const now = reading;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([now, new Promise<void>((resolve) => (timer = setTimeout(resolve, v2cloud.SKILLS_WAIT_MS)))]);
  clearTimeout(timer);
}

/** Read again at the next ask (one was just added or changed here). */
function forget(): void {
  readAt = 0;
}

/** Tests: the channels as given. */
export function useChannelsForTests(given: Channel[], groups: Group[] = []): void {
  known = given;
  knownGroupList = groups;
  readAt = Date.now();
}

/**
 * The channel a new edit, script, idea or thumbnail is made for, as asked:
 * null when none is; refused unless V2 is on here (channels are V2's), this
 * computer is signed in, and the channel is there.
 */
export async function channelFor(given: unknown, home: string): Promise<Channel | null> {
  if (given === undefined || given === null || given === "") return null;
  if (typeof given !== "string") throw bad("channel is a channel's key");
  if (!beta.read(home).v2) throw bad("Channels are Edit V2's: turn it on in Settings → Beta.");
  needCloud();
  const channel = await asked(() => get(given));
  // Said in words, never by its key (a key means nothing to the person).
  if (channel === null) throw bad("That channel isn't in Edit, or isn't shown to your account: pick another, or ask an admin to give it to you.");
  if (channel.archived) throw bad(`${channel.title} was put away: an admin can bring it back (add it again), or pick another channel.`);
  return channel;
}

/** Who reads a channel's scripts, as Edit's tools take it: a voice (the house's voice-over pipeline, bodycam's) or the editor's recording (interrogation's). */
export const styleOf = (channel: Channel): "bodycam" | "interrogation" => (channel.narration?.kind === "recorded" ? "interrogation" : "bodycam");

export async function get(key: string): Promise<Channel | null> {
  return (await cloud.query("channels:getChannel", { key })) as Channel | null;
}

/** A channel as this person sees it, for a route: 404 when it isn't there for them. */
export async function read(key: string): Promise<Channel> {
  needCloud();
  const channel = await asked(() => get(key));
  if (channel === null) throw new ApiError(404, `no channel ${key}`);
  return channel;
}

/** A channel's watermark changed (its picture, or its look; null: none, or the house look): the channel back. */
export async function setWatermark(key: string, change: { watermark?: string | { sha256: string; ext: string } | null; watermarkLook?: WatermarkLook | null }): Promise<Channel> {
  needTeacher();
  const channel = await asked(async () => (await cloud.mutation("channels:setChannel", { key, ...change })) as Channel);
  forget();
  return channel;
}

/** A look as the channel page sends it: in range, and null when it's the house's (so the channel keeps none). */
export function lookOf(given: unknown): WatermarkLook | null {
  if (given === null) return null;
  const value = given as Partial<Record<keyof WatermarkLook, unknown>> | undefined;
  if (typeof value !== "object" || typeof value.motion !== "boolean") throw bad("watermarkLook is {opacity, size, speed, motion}, or null for the house look");
  const look = { motion: value.motion } as WatermarkLook;
  for (const [name, [low, high]] of Object.entries(LOOK_RANGE) as [keyof typeof LOOK_RANGE, readonly [number, number]][]) {
    const number = value[name];
    if (typeof number !== "number" || !Number.isFinite(number) || number < low || number > high) throw bad(`watermarkLook.${name} is between ${low} and ${high}`);
    look[name] = Math.round(number * 1000) / 1000;
  }
  return (Object.keys(HOUSE_LOOK) as (keyof WatermarkLook)[]).every((one) => look[one] === HOUSE_LOOK[one]) ? null : look;
}

/** What YouTube says of the channel a link is to, as the relay reads it. */
export async function resolve(url: string): Promise<Record<string, unknown>> {
  const found = await relay.json<{ channel: Record<string, unknown> }>("GET", `/v1/channels/resolve?url=${encodeURIComponent(url)}`, null, "YouTube's channels", 30);
  return found.channel;
}

/** One of a channel's videos, as YouTube counts it. */
export interface Video {
  id: string;
  title: string;
  publishedAt?: string;
  seconds?: number;
  views?: number;
  likes?: number;
  comments?: number;
  thumbnail?: string;
}

const VIDEOS_FRESH_MS = 6 * 3600_000;
const videoCache = new Map<string, { at: number; found: { channel: { youtubeId: string; title: string }; videos: Video[] } }>();

/**
 * A channel's most viewed or newest videos (any link to it: one of ours, or
 * another's), read at most every six hours: YouTube's quota is a day's, and
 * the most viewed costs a hundred of it.
 */
export async function videosOf(link: string, order: "top" | "recent", count = 25): Promise<{ channel: { youtubeId: string; title: string }; videos: Video[] }> {
  const key = `${order} ${count} ${link.trim()}`;
  const kept = videoCache.get(key);
  if (kept !== undefined && Date.now() - kept.at < VIDEOS_FRESH_MS) return kept.found;
  const found = await relay.json<{ channel: { youtubeId: string; title: string }; videos: Video[] }>("GET", `/v1/channels/videos?${new URLSearchParams({ url: link.trim(), order, count: String(count) })}`, null, "YouTube's channels", 30);
  videoCache.set(key, { at: Date.now(), found });
  return found;
}

/** "1.2M views · 14:03 · 3 weeks ago": a video in a line, for an agent. */
export function videoLine(video: Video, now = Date.now()): string {
  const views = video.views === undefined ? null : `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(video.views)} views`;
  const length = video.seconds === undefined ? null : video.seconds <= 180 ? `a short (${video.seconds} s)` : `${Math.floor(video.seconds / 60)}:${String(video.seconds % 60).padStart(2, "0")}`;
  const days = video.publishedAt === undefined ? null : Math.max(0, Math.round((now - Date.parse(video.publishedAt)) / 86_400_000));
  const age = days === null || Number.isNaN(days) ? null : days < 14 ? `${days} days ago` : days < 60 ? `${Math.round(days / 7)} weeks ago` : days < 730 ? `${Math.round(days / 30)} months ago` : `${Math.round(days / 365)} years ago`;
  return `"${video.title}" (${[views, length, age].filter(Boolean).join(" · ")}) https://youtu.be/${video.id}`;
}

/** What one taught thing is, on a channel's page. */
export interface Taught {
  kind: "skill" | "template" | "sound";
  key: string;
  name: string;
  note: string | null;
  category: string | null;
}

/** What each of a channel's (or a group's) lanes has been taught: its own lessons, effects and sounds, each kind read once. */
export async function taughtOf(channel: string): Promise<Record<Lane, Taught[]>> {
  const kinds = ["skill", "template", "sound"] as const;
  const all = (await Promise.all(kinds.map((kind) => v2cloud.list(kind)))).flat();
  const out = Object.fromEntries(LANES.map((lane) => [lane, [] as Taught[]])) as Record<Lane, Taught[]>;
  for (const item of all) {
    const place = v2cloud.laneOf(v2cloud.ownPlaceOf(item.key) ?? "");
    if (place === null || place.channel !== channel) continue;
    out[place.lane].push({ kind: item.kind as Taught["kind"], key: item.key, name: item.name, note: item.note, category: item.category });
  }
  return out;
}

/** When this Edit last asked for a fresh token because a channel it lists isn't in the one held. */
let renewedAt = 0;

/**
 * Whether this person's token carries `keys` (a channel given since it was issued, or one they just added, is in
 * mamagi's grants at once but in Edit's token only when it's renewed, up to an hour later: Nov 16 audit, it showed in
 * New edit and was refused). Asks for a fresh token once a minute at most when one is missing, and waits for it.
 */
export async function tokenCarries(keys: string[], home: string): Promise<boolean> {
  const missing = () => keys.filter((key) => !kinds.mayChannel(key));
  if (missing().length === 0) return true;
  if (Date.now() - renewedAt > 60_000) {
    renewedAt = Date.now();
    await accounts.renew(home).catch((error: unknown) => diag.warn("channels", `a fresh token for a channel given since: ${diag.messageOf(error)}`));
  }
  return missing().length === 0;
}

/** Thrown by the relay or mamagi, said as a 400 in their words (a 403 stays one). */
async function asked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = cloud.readable(diag.messageOf(error));
    // Not reached at all (offline, the relay slow): said plainly, with what to do; the raw words are in the log.
    if (/could not reach|didn't answer within|ETIMEDOUT|ECONNREFUSED|getaddrinfo|socket connection was closed|offline/iu.test(message)) {
      diag.warn("channels", message);
      throw new ApiError(503, "Couldn't reach Edit's cloud: check the connection, then try again in a moment.");
    }
    throw /teacher|forbidden|403/i.test(message) ? new ApiError(403, message) : bad(message);
  }
}

function narrationOf(given: unknown): Narration | undefined {
  if (given === undefined) return undefined;
  const value = given as { kind?: unknown; id?: unknown; name?: unknown } | null;
  if (value?.kind === "recorded") return { kind: "recorded" };
  if (value?.kind === "voice" && typeof value.id === "string" && value.id.trim() !== "") return { kind: "voice", id: value.id.trim(), name: typeof value.name === "string" ? value.name : value.id };
  throw bad('narration is {kind: "voice", id, name} or {kind: "recorded"}');
}

/** A voice that narrates for a niche or a channel already: the picker shows these first. */
export interface Used {
  voice: string;
  /** The niche's name or the channel's title. */
  label: string;
  /** The channel's key, when it's a channel's. */
  channel?: string;
}

/** Who narrates for whom: each niche with a narrator of its own (bodycam's is the house voice), then each channel's voice. */
export function usedVoices(given: Channel[]): Used[] {
  const used: Used[] = [];
  for (const style of STYLES) {
    const voice = voiceFor(style.value) ?? (style.value === "bodycam" ? HOUSE_VOICE : null);
    if (voice !== null) used.push({ voice, label: style.label });
  }
  for (const channel of given) if (channel.narration?.kind === "voice") used.push({ voice: channel.narration.id, label: channel.title, channel: channel.key });
  return used;
}

export function routes(router: Router<App>): void {
  router
    .get("/api/channels/voices", async ({ app }: RouteContext<App>) => {
      const listing = (await asked(() => app.voices.voices(false))) as { voices?: unknown[] };
      const given = v2cloud.enabled() ? await list().catch(() => knownChannels().filter((one) => !one.archived)) : [];
      return json({ voices: listing.voices ?? [], used: usedVoices(given) });
    })
    .get("/api/channels", async ({ app }: RouteContext<App>) => {
      if (!v2cloud.enabled()) return json({ channels: [], groups: [], teacher: false });
      const listed = await asked(() => list());
      // One given since this token was issued: a fresh token, so its work isn't refused meanwhile.
      void tokenCarries(listed.map((one) => one.key), app.store.home);
      return json({ channels: listed, groups: knownGroups(), teacher: v2cloud.teacher() });
    })
    // A Trello board from a link pasted on a channel's page: its name, and the lists its ideas would be sent to.
    .get("/api/channels/board", async ({ url }: RouteContext<App>) => {
      needTeacher();
      const link = (url.searchParams.get("url") ?? "").trim();
      if (link === "") throw bad("url: a link to the Trello board.");
      const board = await asked(() => relay.json<{ id: string; name: string; url: string; lanes: { id: string; name: string }[] }>("GET", `/v1/ideas/trello/board?url=${encodeURIComponent(link)}`, null, "the Trello board", 30));
      return json({ trello: { boardId: board.id, name: board.name, url: board.url, lanes: board.lanes } satisfies Trello });
    })
    .get("/api/channels/resolve", async ({ url }: RouteContext<App>) => {
      needCloud();
      return json({ channel: await asked(() => resolve(url.searchParams.get("url") ?? "")) });
    })
    .post("/api/channels", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ url?: unknown; title?: unknown }>(context);
      if (typeof given.title === "string" && given.url === undefined) {
        if (given.title.trim() === "") throw bad("title: the placeholder's name.");
        const channel = await asked(async () => (await cloud.mutation("channels:addPlaceholder", { title: given.title })) as Channel);
        diag.info("channels", `${channel.title} (${channel.key}) added as a placeholder`);
        forget();
        await tokenCarries([channel.key], context.app.store.home);
        return json({ channel });
      }
      if (typeof given.url !== "string" || given.url.trim() === "") throw bad("url: a link to the channel.");
      const youtube = await asked(() => resolve(given.url as string));
      const channel = await asked(async () => (await cloud.mutation("channels:saveChannel", { youtube })) as Channel);
      diag.info("channels", `${channel.title} (${channel.key}) added`);
      forget();
      await tokenCarries([channel.key], context.app.store.home);
      return json({ channel });
    })
    .post("/api/channels/{key}/link", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ url?: unknown }>(context);
      if (typeof given.url !== "string" || given.url.trim() === "") throw bad("url: a link to the YouTube channel.");
      const youtube = await asked(() => resolve(given.url as string));
      const channel = await asked(async () => (await cloud.mutation("channels:linkChannel", { key: context.params.key!, youtube })) as Channel);
      diag.info("channels", `${channel.key} linked to ${channel.title} on YouTube`);
      forget();
      return json({ channel });
    })
    .get("/api/channels/{key}/videos", async ({ params, url }: RouteContext<App>) => {
      needCloud();
      const channel = await asked(() => get(params.key!));
      if (channel === null) throw new ApiError(404, `no channel ${params.key}`);
      if (channel.youtubeId === null) throw bad(channel.masked === true ? `${channel.title}'s videos aren't shown to your account.` : `${channel.title} isn't on YouTube yet.`);
      return json(await asked(() => videosOf(channel.youtubeId!, url.searchParams.get("order") === "recent" ? "recent" : "top")));
    })
    .post("/api/channels/{key}/projects/{id}", async ({ app, params }: RouteContext<App>) => {
      // Today's kind of edit made the channel's Edit V2 project (channel_move.ts, Nov 21), with Edit V2 on here only. By
      // whoever may work on it and has been given the channel, as New edit lets them make a project on it: unlike
      // moving a V2 project between channels (a teacher's, below), it changes nothing of what any channel is taught.
      const found = app.store.get(params.id!);
      if (found === undefined || found === null) throw new ApiError(404, "This edit isn't on this computer: open it here once, then move it.");
      if (!found.project.hq) {
        const channel = await channelFor(params.key!, app.store.home);
        if (channel === null) throw bad("channel is a channel's key");
        if (!(await tokenCarries([channel.key], app.store.home))) throw new ApiError(403, `${channel.title} isn't given to your account yet: ask an admin to give it to you on accounts.spheceo.com.`);
        // Read when asked: it reaches the job table and the agents, which reach the channels again as they load.
        const moved = await (await import("./channel_move.ts")).convert(app, found.project.id, channel);
        return json({ project: moved });
      }
      needTeacher();
      const channel = await asked(() => get(params.key!));
      if (channel === null || channel.archived) throw new ApiError(404, `no channel ${params.key}`);
      // Not under a turn: what its agent is taught changes with the channel.
      if (agentPanel(app).turn?.(found.project.id).running) throw new ApiError(409, "Its agent is working: move it once the turn is done.");
      const [moved] = await app.store.update(found.project.id, "channel", (project) => {
        project.channel = channel.key;
      });
      forget();
      diag.info("channels", `${moved.project.name} moved onto ${channel.title}`);
      return json({ project: { id: moved.project.id, channel: moved.project.channel } });
    })
    .get("/api/channels/{key}", async ({ params }: RouteContext<App>) => {
      needCloud();
      const channel = await asked(() => get(params.key!));
      if (channel === null) throw new ApiError(404, `no channel ${params.key}`);
      // What each lane's agent has been taught: its own lessons, effects and sounds (the global skill is Edit's, not a style), and its group's.
      // Found with its put-away channels (this one may be), shown without them.
      const found = typeof channel.group === "string" ? ((await listGroups(true)).find((one) => one.key === channel.group) ?? null) : null;
      const group = found === null ? null : { ...found, channels: found.channels.filter((key) => key === channel.key || !putAway(key)) };
      const [taught, shared] = await asked(() => Promise.all([taughtOf(channel.key), group === null ? null : taughtOf(group.key)]));
      return json({ channel, taught, group: group === null ? null : { ...group, taught: shared }, teacher: v2cloud.teacher() });
    })
    .put("/api/channels/{key}", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ narration?: unknown; compilation?: unknown; lanes?: unknown; label?: unknown; watermark?: unknown; watermarkLook?: unknown; trello?: unknown; competitors?: unknown }>(context);
      const trello = given.trello === undefined ? undefined : trelloOf(given.trello);
      if (given.competitors !== undefined && typeof given.competitors !== "string") throw bad("competitors is the team's list, as text");
      const look = given.watermarkLook === undefined ? undefined : lookOf(given.watermarkLook);
      if (given.label !== undefined && typeof given.label !== "string") throw bad("label is what someone allowed only its label sees");
      // Its picture in the Watermarks folder (the channel page's picker lists them), or null for none.
      if (given.watermark !== undefined && given.watermark !== null && (typeof given.watermark !== "string" || given.watermark === "")) throw bad("watermark is its picture's Drive id in the Watermarks folder, or null for none");
      const narration = narrationOf(given.narration);
      if (given.compilation !== undefined && typeof given.compilation !== "boolean") throw bad("compilation is true or false");
      const lanes: Partial<Record<Lane, string>> = {};
      if (given.lanes !== undefined) {
        if (typeof given.lanes !== "object" || given.lanes === null) throw bad("lanes is {ideas?, thumbnails?, script?, edit?}");
        for (const lane of LANES) {
          const text = (given.lanes as Record<string, unknown>)[lane];
          if (text === undefined) continue;
          if (typeof text !== "string") throw bad(`lanes.${lane} is its description`);
          lanes[lane] = text;
        }
      }
      const channel = await asked(async () => (await cloud.mutation("channels:setChannel", { key: context.params.key!, ...(narration !== undefined ? { narration } : {}), ...(given.compilation !== undefined ? { compilation: given.compilation } : {}), ...(given.lanes !== undefined ? { lanes } : {}), ...(typeof given.label === "string" ? { label: given.label } : {}), ...(given.watermark !== undefined ? { watermark: given.watermark } : {}), ...(look !== undefined ? { watermarkLook: look } : {}), ...(trello !== undefined ? { trello } : {}), ...(typeof given.competitors === "string" ? { competitors: given.competitors } : {}) })) as Channel);
      forget();
      return json({ channel });
    })
    .delete("/api/channels/{key}", async ({ params }: RouteContext<App>) => {
      needTeacher();
      await asked(() => cloud.mutation("channels:archiveChannel", { key: params.key!, archived: true }));
      forget();
      return json({ ok: true });
    })
    .post("/api/channels/{key}/restore", async ({ params }: RouteContext<App>) => {
      needCloud();
      const channel = await asked(() => get(params.key!));
      if (channel === null) throw new ApiError(404, "That channel isn't in Edit, or isn't shown to your account: ask an admin to give it to you.");
      if (!channel.archived) return json({ channel });
      if (channel.masked === true) throw new ApiError(403, `Only someone who sees ${channel.title} in full can bring it back: ask an admin.`);
      await asked(() => cloud.mutation("channels:archiveChannel", { key: channel.key, archived: false }));
      forget();
      diag.info("channels", `${channel.title} (${channel.key}) brought back`);
      return json({ channel: { ...channel, archived: false } });
    })
    .get("/api/groups/{key}", async ({ params }: RouteContext<App>) => {
      needCloud();
      const group = (await asked(async () => (await cloud.query("groups:listGroups", {})) as Group[])).find((one) => one.key === params.key);
      if (group === undefined) throw new ApiError(404, `no group ${params.key}`);
      return json({ group, taught: await asked(() => taughtOf(group.key)), teacher: v2cloud.teacher() });
    })
    .post("/api/groups", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ name?: unknown; channels?: unknown; from?: unknown }>(context);
      if (!Array.isArray(given.channels) || !given.channels.every((one) => typeof one === "string") || typeof given.from !== "string") throw bad("{channels: [keys], from: the channel whose style it starts from}");
      const group = await asked(async () => (await cloud.mutation("groups:makeGroup", { channels: given.channels, from: given.from })) as Group);
      diag.info("channels", `group ${group.key} made of ${group.channels.join(", ")}, from ${String(given.from)}'s style`);
      return json({ group: changed(group) });
    })
    .put("/api/groups/{key}", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ lanes?: unknown }>(context);
      if (given.lanes !== undefined && (typeof given.lanes !== "object" || given.lanes === null || !Object.values(given.lanes).every((one) => typeof one === "string"))) throw bad("lanes is {ideas?, thumbnails?, script?, edit?}");
      const group = await asked(async () => (await cloud.mutation("groups:setGroup", { key: context.params.key!, ...(given.lanes !== undefined ? { lanes: given.lanes } : {}) })) as Group);
      return json({ group: changed(group) });
    })
    .delete("/api/groups/{key}", async ({ params }: RouteContext<App>) => {
      needTeacher();
      await asked(() => cloud.mutation("groups:archiveGroup", { key: params.key! }));
      diag.info("channels", `group ${params.key} put away, its channels each with a copy of its teaching`);
      changed();
      return json({ ok: true });
    })
    .post("/api/groups/{key}/channels", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ channel?: unknown }>(context);
      if (typeof given.channel !== "string") throw bad("channel is a channel's key");
      const group = await asked(async () => (await cloud.mutation("groups:addChannel", { key: context.params.key!, channel: given.channel })) as Group);
      return json({ group: changed(group) });
    })
    .delete("/api/groups/{key}/channels/{channel}", async ({ params }: RouteContext<App>) => {
      needTeacher();
      const left = await asked(() => cloud.mutation("groups:removeChannel", { key: params.key!, channel: params.channel! }));
      diag.info("channels", `${params.channel} taken out of group ${params.key} with a copy of its teaching`);
      changed();
      return json(left);
    })
    .post("/api/groups/{key}/move", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ item?: unknown }>(context);
      if (typeof given.item !== "string") throw bad("item is a channel's own item's key");
      const moved = await asked(() => cloud.mutation("groups:moveIntoGroup", { item: given.item }));
      changed();
      return json(moved);
    });
}

/** A group changed: the channels and what their agents know read again at the next ask. */
function changed<T>(given?: T): T | undefined {
  forget();
  v2cloud.forgetSkills();
  return given;
}
