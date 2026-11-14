// Channels (Nov 14): any link to a YouTube channel, read into what Edit keeps
// of it (mamagi's channels: its id, handle, title, description, pictures, the
// playlist of its uploads and its counts) with YouTube's Data API, whatever
// form it's pasted in (Sphe: "whether it's /videos, whether it's just the @,
// whether it's the ID").
//
//   GET /v1/channels/resolve?url=<link>   {channel} | {error}
//
// A channel's id (UC…) or its /channel/ link, an @handle or its link (with
// /videos, /shorts, /featured…), a /user/ link, a video's link (its channel),
// and a /c/ link or a bare name (searched, the first channel found).

const API = "https://www.googleapis.com/youtube/v3";

export interface ChannelsEnv {
  YOUTUBE_API_KEY?: string;
}

export class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Found = { id?: string; snippet?: Record<string, unknown>; statistics?: Record<string, unknown>; contentDetails?: Record<string, unknown>; brandingSettings?: Record<string, unknown> };

async function api(path: string, params: Record<string, string>, env: ChannelsEnv): Promise<Record<string, unknown>> {
  if (!env.YOUTUBE_API_KEY) throw new Refused(503, "The YouTube API is not configured on the relay yet.");
  const answer = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY })}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (answer === null) throw new Refused(502, "YouTube's API did not answer.");
  if (answer.status === 403) throw new Refused(502, "YouTube's API refused the relay's key (its daily quota may be spent).");
  if (!answer.ok) throw new Refused(502, `YouTube's API answered ${answer.status}.`);
  return (await answer.json()) as Record<string, unknown>;
}

/** What to ask YouTube for, from a link as pasted. */
export function lookupOf(given: string): { by: "id" | "forHandle" | "forUsername" | "video" | "search"; value: string } {
  const text = given.trim();
  if (text === "") throw new Refused(400, "Paste a link to the channel.");
  if (/^UC[A-Za-z0-9_-]{22}$/.test(text)) return { by: "id", value: text };
  if (/^@[\w.-]{1,100}$/u.test(text)) return { by: "forHandle", value: text };
  let url: URL | null = null;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    url = null;
  }
  const host = url?.hostname.replace(/^(www\.|m\.|music\.)/, "") ?? "";
  if (url !== null && (host === "youtube.com" || host === "youtu.be")) {
    const [first = "", second = ""] = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    if (host === "youtu.be" && /^[\w-]{11}$/.test(first)) return { by: "video", value: first };
    if (first === "watch" && /^[\w-]{11}$/.test(url.searchParams.get("v") ?? "")) return { by: "video", value: url.searchParams.get("v")! };
    if ((first === "shorts" || first === "live" || first === "embed") && /^[\w-]{11}$/.test(second)) return { by: "video", value: second };
    if (first === "channel" && /^UC[A-Za-z0-9_-]{22}$/.test(second)) return { by: "id", value: second };
    if (first.startsWith("@") && first.length > 1) return { by: "forHandle", value: first };
    if (first === "user" && second !== "") return { by: "forUsername", value: second };
    if (first === "c" && second !== "") return { by: "search", value: second };
    if (first !== "" && !["watch", "results", "feed", "playlist"].includes(first)) return { by: "search", value: first };
    throw new Refused(400, "That link isn't to a channel or one of its videos.");
  }
  if (url !== null && text.includes(".") && !text.includes(" ")) throw new Refused(400, "That isn't a YouTube link.");
  // A bare handle without its @, or a name.
  if (/^[\w.-]{3,100}$/u.test(text)) return { by: "forHandle", value: `@${text}` };
  return { by: "search", value: text };
}

const PARTS = "snippet,statistics,contentDetails,brandingSettings";
const number = (value: unknown) => (Number.isFinite(Number(value)) && value !== undefined && value !== null && value !== "" ? Number(value) : undefined);
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/** The channel a link is to, as mamagi's `channels:saveChannel` takes it. */
export async function resolveChannel(given: string, env: ChannelsEnv) {
  const lookup = lookupOf(given);
  let params: Record<string, string>;
  if (lookup.by === "video") {
    const video = ((await api("videos", { part: "snippet", id: lookup.value }, env)).items as Found[] | undefined)?.[0];
    const channelId = text(video?.snippet?.channelId);
    if (channelId === undefined) throw new Refused(404, "That video isn't on YouTube, or it's private.");
    params = { id: channelId };
  } else if (lookup.by === "search") {
    const hit = ((await api("search", { part: "snippet", type: "channel", q: lookup.value, maxResults: "1" }, env)).items as { id?: { channelId?: string } }[] | undefined)?.[0];
    if (hit?.id?.channelId === undefined) throw new Refused(404, `No channel called “${lookup.value}” on YouTube.`);
    params = { id: hit.id.channelId };
  } else params = { [lookup.by]: lookup.value };
  const channel = ((await api("channels", { part: PARTS, ...params }, env)).items as Found[] | undefined)?.[0];
  if (channel?.id === undefined) throw new Refused(404, "No channel found for that link.");
  const snippet = channel.snippet ?? {};
  const pictures = (snippet.thumbnails ?? {}) as Record<string, { url?: string } | undefined>;
  const avatar = ["high", "medium", "default"].map((size) => pictures[size]?.url).find((one) => typeof one === "string");
  const banner = text(((channel.brandingSettings?.image ?? {}) as { bannerExternalUrl?: unknown }).bannerExternalUrl);
  const stats = channel.statistics ?? {};
  const fields = {
    youtubeId: channel.id,
    handle: text(snippet.customUrl)?.replace(/^@/, ""),
    title: text(snippet.title) ?? "",
    description: (text(snippet.description) ?? "").slice(0, 5000),
    avatar,
    banner,
    uploads: text((channel.contentDetails?.relatedPlaylists as { uploads?: unknown } | undefined)?.uploads),
    subscribers: stats.hiddenSubscriberCount === true ? undefined : number(stats.subscriberCount),
    videos: number(stats.videoCount),
    views: number(stats.viewCount),
    country: text(snippet.country),
    publishedAt: text(snippet.publishedAt),
  };
  // Absent, not undefined: mamagi's validators take only what's there.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export async function channelsRoute(request: Request, url: URL, env: ChannelsEnv): Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (request.method !== "GET" || url.pathname !== "/v1/channels/resolve") return json(404, { error: "No such route." });
  try {
    return json(200, { channel: await resolveChannel(url.searchParams.get("url") ?? "", env) });
  } catch (error) {
    if (error instanceof Refused) return json(error.status, { error: error.message });
    return json(502, { error: error instanceof Error ? error.message : String(error) });
  }
}
