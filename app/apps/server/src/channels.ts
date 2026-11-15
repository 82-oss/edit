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
//
//   GET    /api/channels                {channels, teacher}
//   GET    /api/channels/resolve?url=   {channel}: what YouTube says, not saved
//   POST   /api/channels                {url} or {title} → {channel}: added, or a placeholder by its name (a teacher's)
//   POST   /api/channels/{key}/link     {url} → {channel}: a placeholder linked to its YouTube channel
//   GET    /api/channels/{key}          {channel, taught: {<lane>: [what its agent knows]}, teacher}
//   PUT    /api/channels/{key}          {narration?, compilation?, lanes?, label?} → {channel}
//   DELETE /api/channels/{key}          put away (its teaching kept)
//   GET    /api/channels/voices         {voices, used}: who could narrate, and who narrates for whom already
//   GET    /api/channels/{key}/videos?order=top|recent   {channel, videos}: its most viewed or newest, with their numbers
//   POST   /api/channels/{key}/projects/{id}   an edit project moved onto the channel (its Edit lane from its next turn)

import type { App } from "./app.ts";
import * as beta from "./beta.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { STYLES } from "./model.ts";
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
  lanes: Record<Lane, string>;
  archived: boolean;
  addedBy: { name: string } | null;
  at: number;
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

function needTeacher(): void {
  needCloud();
  if (!v2cloud.teacher()) throw new ApiError(403, "Adding a channel or changing one is a teacher's: an admin can make you one at accounts.spheceo.com.");
}

/** The channels, newest change first (what's put away only with `archived`). */
export async function list(archived = false): Promise<Channel[]> {
  const found = (await cloud.query("channels:listChannels", archived ? { archived: true } : {})) as Channel[];
  if (!archived) {
    known = found;
    readAt = Date.now();
  }
  return found;
}

/** The channels as last read: an agent's instructions are written from them without waiting (`refresh` at a turn's start). */
let known: Channel[] = [];
let readAt = 0;
const FRESH_MS = 30_000;

export function knownChannels(): Channel[] {
  return known;
}

/** A project's channel, as last read (null: none, or not read yet). */
export function channelOf(project: { channel?: string | null }): Channel | null {
  return typeof project.channel === "string" && project.channel !== "" ? (known.find((one) => one.key === project.channel) ?? null) : null;
}

/** Reads the channels again, at most every 30 s (a turn's start asks): a failure keeps what was read before. */
export async function refresh(): Promise<void> {
  if (!v2cloud.enabled() || Date.now() - readAt < FRESH_MS) return;
  readAt = Date.now();
  try {
    await list();
  } catch (error) {
    diag.warn("channels", `the channels from the cloud: ${diag.messageOf(error)}`);
  }
}

/** Read again at the next ask (one was just added or changed here). */
function forget(): void {
  readAt = 0;
}

/** Tests: the channels as given. */
export function useChannelsForTests(given: Channel[]): void {
  known = given;
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
  if (channel === null || channel.archived) throw bad(`There's no channel ${given}.`);
  return channel;
}

/** Who reads a channel's scripts, as Edit's tools take it: a voice (the house's voice-over pipeline, bodycam's) or the editor's recording (interrogation's). */
export const styleOf = (channel: Channel): "bodycam" | "interrogation" => (channel.narration?.kind === "recorded" ? "interrogation" : "bodycam");

export async function get(key: string): Promise<Channel | null> {
  return (await cloud.query("channels:getChannel", { key })) as Channel | null;
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

/** What each of a channel's lanes has been taught: its own lessons, effects and sounds, each kind read once. */
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

/** Thrown by the relay or mamagi, said as a 400 in their words (a 403 stays one). */
async function asked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = diag.messageOf(error);
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
      const given = v2cloud.enabled() ? await list().catch(() => knownChannels()) : [];
      return json({ voices: listing.voices ?? [], used: usedVoices(given) });
    })
    .get("/api/channels", async () => {
      if (!v2cloud.enabled()) return json({ channels: [], teacher: false });
      return json({ channels: await asked(() => list()), teacher: v2cloud.teacher() });
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
        return json({ channel });
      }
      if (typeof given.url !== "string" || given.url.trim() === "") throw bad("url: a link to the channel.");
      const youtube = await asked(() => resolve(given.url as string));
      const channel = await asked(async () => (await cloud.mutation("channels:saveChannel", { youtube })) as Channel);
      diag.info("channels", `${channel.title} (${channel.key}) added`);
      forget();
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
      needTeacher();
      const channel = await asked(() => get(params.key!));
      if (channel === null || channel.archived) throw new ApiError(404, `no channel ${params.key}`);
      const live = app.store.get(params.id!);
      if (live === undefined || live === null) throw new ApiError(404, `no project ${params.id} on this computer`);
      if (!live.project.hq) throw bad("Only an Edit V2 project can be a channel's: this one is today's kind of edit.");
      // Not under a turn: what its agent is taught changes with the channel.
      if (agentPanel(app).turn?.(live.project.id).running) throw new ApiError(409, "Its agent is working: move it once the turn is done.");
      const [moved] = await app.store.update(live.project.id, "channel", (project) => {
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
      // What each lane's agent has been taught: its own lessons, effects and sounds (the global skill is Edit's, not a style).
      const taught = await asked(() => taughtOf(channel.key));
      return json({ channel, taught, teacher: v2cloud.teacher() });
    })
    .put("/api/channels/{key}", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ narration?: unknown; compilation?: unknown; lanes?: unknown; label?: unknown }>(context);
      if (given.label !== undefined && typeof given.label !== "string") throw bad("label is what someone allowed only its label sees");
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
      const channel = await asked(async () => (await cloud.mutation("channels:setChannel", { key: context.params.key!, ...(narration !== undefined ? { narration } : {}), ...(given.compilation !== undefined ? { compilation: given.compilation } : {}), ...(given.lanes !== undefined ? { lanes } : {}), ...(typeof given.label === "string" ? { label: given.label } : {}) })) as Channel);
      forget();
      return json({ channel });
    })
    .delete("/api/channels/{key}", async ({ params }: RouteContext<App>) => {
      needTeacher();
      await asked(() => cloud.mutation("channels:archiveChannel", { key: params.key!, archived: true }));
      forget();
      return json({ ok: true });
    });
}
