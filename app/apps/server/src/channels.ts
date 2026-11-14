// Channels (Nov 14; Sphe: "I do think we need to categorize things by
// channel"): the team's YouTube channels, each its own record in mamagi
// (accounts' convex/channels.ts), added by pasting any link to it (the relay
// reads it with YouTube's API: channels.ts there). A channel has lanes, one per
// part of the work (ideas, thumbnails, script, edit), each with its own style:
// a description, and what its agent has been taught, in V2's library under the
// lane's key (`laneKey`). How its videos are made is set up once, after it's
// added: who narrates (a voice, or the editor's recording) and whether it's a
// compilation channel. Channels are V2's (the beta).
//
//   GET    /api/channels                {channels, teacher}
//   GET    /api/channels/resolve?url=   {channel}: what YouTube says, not saved
//   POST   /api/channels                {url} → {channel}: added (a teacher's)
//   GET    /api/channels/{key}          {channel, teacher}
//   PUT    /api/channels/{key}          {narration?, compilation?, lanes?} → {channel}
//   DELETE /api/channels/{key}          put away (its teaching kept)

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { ApiError, bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";
import * as relay from "./relay.ts";
import * as v2cloud from "./v2_cloud.ts";

export const LANES = ["ideas", "thumbnails", "script", "edit"] as const;
export type Lane = (typeof LANES)[number];

export type Narration = { kind: "voice"; id: string; name: string } | { kind: "recorded" };

export interface Channel {
  key: string;
  youtubeId: string;
  handle: string | null;
  title: string;
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

/** A lane's place in V2's library: its own lessons and effects are `<kind>:@<laneKey>/<name>` (a channel key has no "--"). */
export const laneKey = (channel: string, lane: Lane) => `${channel}--${lane}`;

/** The channel and lane of a library place, or null when it's a niche's. */
export function laneOf(place: string): { channel: string; lane: Lane } | null {
  const at = place.lastIndexOf("--");
  if (at <= 0) return null;
  const lane = place.slice(at + 2);
  return (LANES as readonly string[]).includes(lane) ? { channel: place.slice(0, at), lane: lane as Lane } : null;
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
  return (await cloud.query("channels:listChannels", archived ? { archived: true } : {})) as Channel[];
}

export async function get(key: string): Promise<Channel | null> {
  return (await cloud.query("channels:getChannel", { key })) as Channel | null;
}

/** What YouTube says of the channel a link is to, as the relay reads it. */
export async function resolve(url: string): Promise<Record<string, unknown>> {
  const found = await relay.json<{ channel: Record<string, unknown> }>("GET", `/v1/channels/resolve?url=${encodeURIComponent(url)}`, null, "YouTube's channels", 30);
  return found.channel;
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

export function routes(router: Router<App>): void {
  router
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
      const given = await readJson<{ url?: unknown }>(context);
      if (typeof given.url !== "string" || given.url.trim() === "") throw bad("url: a link to the channel.");
      const youtube = await asked(() => resolve(given.url as string));
      const channel = await asked(async () => (await cloud.mutation("channels:saveChannel", { youtube })) as Channel);
      diag.info("channels", `${channel.title} (${channel.key}) added`);
      return json({ channel });
    })
    .get("/api/channels/{key}", async ({ params }: RouteContext<App>) => {
      needCloud();
      const channel = await asked(() => get(params.key!));
      if (channel === null) throw new ApiError(404, `no channel ${params.key}`);
      return json({ channel, teacher: v2cloud.teacher() });
    })
    .put("/api/channels/{key}", async (context: RouteContext<App>) => {
      needTeacher();
      const given = await readJson<{ narration?: unknown; compilation?: unknown; lanes?: unknown }>(context);
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
      const channel = await asked(async () => (await cloud.mutation("channels:setChannel", { key: context.params.key!, ...(narration !== undefined ? { narration } : {}), ...(given.compilation !== undefined ? { compilation: given.compilation } : {}), ...(given.lanes !== undefined ? { lanes } : {}) })) as Channel);
      return json({ channel });
    })
    .delete("/api/channels/{key}", async ({ params }: RouteContext<App>) => {
      needTeacher();
      await asked(() => cloud.mutation("channels:archiveChannel", { key: params.key!, archived: true }));
      return json({ ok: true });
    });
}
