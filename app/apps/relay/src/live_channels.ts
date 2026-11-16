// One channel list for dev and prod (Nov 16, Sphe: "channels lists are shared
// across dev and prod, there shouldn't be a separate list"): prod's is the
// list. The dev relay (CHANNELS_UPSTREAM, the live relay's address, reached
// through the LIVE_RELAY service binding) sends every call on channels and
// groups (mamagi's `channels:*` and `groups:*`) and every channel's own file
// (R2 under `edit/channels/`, its watermark) to the live relay, with the
// caller's own sign-in, which checks it as it does for any of the team's
// Edits. Nothing else of dev's goes there: its projects, its library's
// teaching and its R2 stay dev's.
//
// A group change moves teaching in the library (groups.ts), and prod's
// function moves prod's. So once it went through there, the same move is made
// in dev's own library (`groups:followLibrary`, called here with dev's
// service token), so dev's teaching follows its channels.

import type { Caller } from "./auth";
import { actorOf, isObject, type CloudEnv } from "./cloud";

export interface LiveChannelsEnv {
  /** The dev relay: the live relay's address, which holds the one channel list. */
  CHANNELS_UPSTREAM?: string;
  /** The live relay itself, bound (Cloudflare refuses a Worker fetching another of the account's by its address: error 1042). */
  LIVE_RELAY?: { fetch(request: Request): Promise<Response> };
}

const CHANNEL_CALL = /^(channels|groups):[A-Za-z]+$/;
const CHANNEL_FILE = "edit/channels/";
/** The group changes that move teaching, and so are followed in this library. */
const FOLLOWED = new Set(["groups:makeGroup", "groups:removeChannel", "groups:archiveGroup", "groups:moveIntoGroup"]);

/** Whether this relay sends channels to the live one (the dev relay). */
export const channelsLive = (env: LiveChannelsEnv): boolean => typeof env.CHANNELS_UPSTREAM === "string" && env.CHANNELS_UPSTREAM.startsWith("https://");

/** Whether a cloud call (its route under /v1/cloud/ and its body) is a channel's: a call on channels or groups, or a channel's file. */
export function channelCall(route: string, body: Record<string, unknown>): boolean {
  if (route === "convex") return typeof body.path === "string" && CHANNEL_CALL.test(body.path);
  if (!route.startsWith("r2/")) return false;
  if (typeof body.key === "string") return body.key.startsWith(CHANNEL_FILE);
  return false;
}

/** One call to the live relay with the caller's own sign-in: its answer as it came. */
async function live(env: LiveChannelsEnv, route: string, body: unknown, authorization: string): Promise<Response> {
  const asked = new Request(`${env.CHANNELS_UPSTREAM!.replace(/\/+$/, "")}/v1/cloud/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
  return env.LIVE_RELAY !== undefined ? env.LIVE_RELAY.fetch(asked) : fetch(asked);
}

type GroupRow = { key: string; channels: string[] };

/** What dev's library does after a group change went through on prod (null: nothing). */
export function followOf(path: string, args: Record<string, unknown>, value: unknown, before: GroupRow[]): Record<string, unknown> | null {
  const text = (name: string) => (typeof args[name] === "string" ? (args[name] as string) : null);
  const answer = isObject(value) ? value : {};
  if (path === "groups:makeGroup" && typeof answer.key === "string" && text("from") !== null) return { moves: [{ from: text("from"), to: answer.key }] };
  if (path === "groups:removeChannel" && text("key") !== null && text("channel") !== null) {
    // The last one left goes out with it (archived): both get a copy.
    const left = answer.archived === true ? (before.find((one) => one.key === text("key"))?.channels ?? []) : [text("channel")!];
    const out = [...new Set([text("channel")!, ...left])];
    return { copies: out.map((channel) => ({ from: text("key"), to: channel })) };
  }
  if (path === "groups:archiveGroup" && text("key") !== null) {
    const members = before.find((one) => one.key === text("key"))?.channels ?? [];
    return members.length === 0 ? null : { copies: members.map((channel) => ({ from: text("key"), to: channel })) };
  }
  if (path === "groups:moveIntoGroup" && text("item") !== null && typeof answer.key === "string") {
    // Its new key, `<kind>:@<group>--<lane>/<name>`, says the group's place.
    const into = /^[a-z]+:@([a-z0-9-]+--[a-z]+)\//.exec(answer.key)?.[1];
    return into === undefined ? null : { fold: { item: text("item"), into } };
  }
  return null;
}

/** A channel's cloud call made on the live relay, and a group change followed in this library. */
export async function liveChannels(request: Request, route: string, body: Record<string, unknown>, env: LiveChannelsEnv & CloudEnv, found: Caller): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const path = route === "convex" && typeof body.path === "string" ? body.path : "";
  const follows = body.kind === "mutation" && FOLLOWED.has(path);
  // Who's in the group before it changes (taking the last one out, or putting it away, empties it).
  let before: GroupRow[] = [];
  if (follows && (path === "groups:removeChannel" || path === "groups:archiveGroup")) {
    const listed = (await (await live(env, "convex", { kind: "query", path: "groups:listGroups", args: { archived: true } }, authorization)).json().catch(() => null)) as { status?: string; value?: unknown } | null;
    if (listed?.status === "success" && Array.isArray(listed.value)) before = listed.value.filter(isObject) as GroupRow[];
  }
  const answer = await live(env, route, body, authorization);
  const text = await answer.text();
  if (follows && answer.ok) {
    const parsed = (() => {
      try {
        return JSON.parse(text) as { status?: string; value?: unknown };
      } catch {
        return null;
      }
    })();
    const follow = parsed?.status === "success" ? followOf(path, isObject(body.args) ? body.args : {}, parsed.value, before) : null;
    if (follow !== null) await followHere(env, follow, found);
  }
  return new Response(text, { status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "application/json" } });
}

/** `groups:followLibrary` on this relay's own Convex; a failure is logged, never the caller's (prod's change went through). */
async function followHere(env: CloudEnv, follow: Record<string, unknown>, found: Caller): Promise<void> {
  if (!env.CONVEX_URL || !env.CONVEX_SERVICE_TOKEN) return;
  const actor = actorOf(found);
  try {
    const answer = await fetch(`${env.CONVEX_URL.replace(/\/+$/, "")}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "groups:followLibrary", args: { ...follow, ...(actor === null ? {} : { actor }), token: env.CONVEX_SERVICE_TOKEN }, format: "json" }),
    });
    const parsed = (await answer.json().catch(() => null)) as { status?: string; value?: unknown; errorMessage?: string } | null;
    console.log(JSON.stringify({ at: "channels", follow: Object.keys(follow), status: parsed?.status ?? answer.status, ...(parsed?.status === "success" ? { done: parsed.value } : { error: String(parsed?.errorMessage ?? "").slice(0, 300) }) }));
  } catch (error) {
    console.log(JSON.stringify({ at: "channels", follow: Object.keys(follow), error: error instanceof Error ? error.message : String(error) }));
  }
}
