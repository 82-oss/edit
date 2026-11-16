// Channels (the server's channels.ts): the team's YouTube channels, each with
// its lanes (ideas, thumbnails, script, edit), how its videos are made, and the
// teaching each lane's agent is given. Home's Channels lists them; New project
// picks one. A placeholder is a channel by its name alone, before it's on
// YouTube, linked to its YouTube channel later with its teaching kept. A group
// is channels sharing one style, taught once: shown as one row, its channels'
// names together; work still belongs to one channel.

import { useEffect } from "react";
import { create } from "zustand";

import type { WatermarkLook } from "@edit/types/watermark";

import { ApiError, request } from "./api";

export const LANES = [
  { key: "ideas", label: "Ideas" },
  { key: "thumbnails", label: "Thumbnails" },
  { key: "script", label: "Script" },
  { key: "edit", label: "Edit" },
] as const;
export type Lane = (typeof LANES)[number]["key"];

export type Narration = { kind: "voice"; id: string; name: string } | { kind: "recorded" };

export interface Channel {
  key: string;
  /** null: a placeholder, not on YouTube yet, or (masked) not shown to this account. */
  youtubeId: string | null;
  /** What someone given only its label sees for its name ("Channel 2" unless a teacher set one). */
  label?: string;
  /** Seen by its label alone (accounts.spheceo.com): the label is its title, and nothing YouTube says of it is here. */
  masked?: boolean;
  handle: string | null;
  title: string;
  description: string;
  avatar: string | null;
  banner: string | null;
  subscribers: number | null;
  videos: number | null;
  views: number | null;
  /** Who narrates its videos; null until it's set up. */
  narration: Narration | null;
  compilation: boolean;
  /** Its watermark: its logo's Drive id in the Watermarks folder, put on its exports; null or missing: none, so its exports offer none. */
  watermark?: string | null;
  /** Its watermark uploaded on its page instead (kept in Edit's cloud under its key); null or missing: none. */
  watermarkUpload?: { sha256: string; ext: string } | null;
  /** How its watermark looks on its exports; null or missing: the house look. */
  watermarkLook?: WatermarkLook | null;
  lanes: Record<Lane, string>;
  /** Its group's key, or null. */
  group?: string | null;
  at: number;
}

/** Channels sharing one style: its lanes' descriptions, and the channels in it this person sees. */
export interface Group {
  key: string;
  lanes: Record<Lane, string>;
  channels: string[];
}

/** What YouTube says of a link's channel, before it's added. */
export interface Found {
  youtubeId: string;
  handle?: string;
  title: string;
  description: string;
  avatar?: string;
  subscribers?: number;
  videos?: number;
}

/** One thing a lane's agent has been taught: a lesson, an effect or a sound. */
export interface Taught {
  kind: "skill" | "template" | "sound";
  key: string;
  name: string;
  note: string | null;
  category: string | null;
}

export interface Voice {
  voice_id: string;
  name: string;
  description?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

/** A voice narrating for a niche or a channel already. */
export interface Used {
  voice: string;
  label: string;
  channel?: string;
}

/**
 * The channels, as last read (null: not read yet), whether this person adds
 * and teaches them (false until read), and why they couldn't be read (null
 * once they are): a failed read is never "no channels".
 */
export const useChannels = create<{ channels: Channel[] | null; groups: Group[]; teacher: boolean; failed: unknown }>(() => ({ channels: null, groups: [], teacher: false, failed: null }));

export async function loadChannels(): Promise<Channel[]> {
  // Tried again after a failure: the wait shows, not the failure.
  if (useChannels.getState().channels === null) useChannels.setState({ failed: null });
  try {
    const { channels, groups, teacher } = await request<{ channels: Channel[]; groups?: Group[]; teacher: boolean }>("GET", "/api/channels");
    useChannels.setState({ channels, groups: groups ?? [], teacher, failed: null });
    return channels;
  } catch (error) {
    // What was read stays; never read, it's a failure to show (with Try again), not an empty list.
    useChannels.setState((now) => (now.channels === null ? { failed: error } : {}));
    return useChannels.getState().channels ?? [];
  }
}

/** A group's channels, as listed. */
export const channelsOf = (group: Group, channels: Channel[]) => group.channels.map((key) => channels.find((one) => one.key === key)).filter((one): one is Channel => one !== undefined);

/** "A & B", "A, B & C": a group by its channels' names. */
export function groupTitle(group: Group, channels: Channel[]): string {
  const names = channelsOf(group, channels).map((one) => one.title);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
}

/** One channel changed: in the list at once. */
function keep(channel: Channel): Channel {
  useChannels.setState((now) => ({ channels: [channel, ...(now.channels ?? []).filter((one) => one.key !== channel.key)] }));
  return channel;
}

export const channelApi = {
  resolve: (url: string) => request<{ channel: Found }>("GET", `/api/channels/resolve?url=${encodeURIComponent(url)}`).then((answer) => answer.channel),
  add: (url: string) => request<{ channel: Channel }>("POST", "/api/channels", { url }).then((answer) => keep(answer.channel)),
  /** A placeholder: a channel by its name, not on YouTube yet. */
  addPlaceholder: (title: string) => request<{ channel: Channel }>("POST", "/api/channels", { title }).then((answer) => keep(answer.channel)),
  /** A placeholder linked to its YouTube channel: its teaching stays. */
  link: (key: string, url: string) => request<{ channel: Channel }>("POST", `/api/channels/${key}/link`, { url }).then((answer) => keep(answer.channel)),
  set: (key: string, change: { narration?: Narration; compilation?: boolean; lanes?: Partial<Record<Lane, string>>; label?: string; watermark?: string | null; watermarkLook?: WatermarkLook | null }) =>
    request<{ channel: Channel }>("PUT", `/api/channels/${key}`, change).then((answer) => keep(answer.channel)),
  /** A picture uploaded as its watermark (a teacher's): kept with the channel, in place of a Drive one. */
  uploadWatermark: async (key: string, file: File) => {
    const response = await fetch(`/api/channels/${key}/watermark`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    const parsed = (await response.json().catch(() => null)) as { channel?: Channel; error?: string } | null;
    if (!response.ok || parsed?.channel === undefined) throw new ApiError(parsed?.error ?? `The picture couldn't be uploaded (${response.status}).`, response.status, parsed);
    return keep(parsed.channel);
  },
  /** Its watermark's picture, as its exports draw it (null: none); named by the picture, so a new one is fetched. */
  watermarkUrl: (channel: Channel): string | null => {
    const picture = channel.watermarkUpload?.sha256 ?? (channel.watermark || null);
    return picture === null ? null : `/api/channels/${channel.key}/watermark?p=${encodeURIComponent(picture)}`;
  },
  /** Its newest video's picture on YouTube: a still of its own to try the watermark on. */
  latestStill: async (key: string): Promise<string | null> => {
    const answer = await request<{ videos: { thumbnail?: string }[] }>("GET", `/api/channels/${key}/videos?order=recent`);
    return answer.videos.find((one) => one.thumbnail)?.thumbnail ?? null;
  },
  /** A channel with what each lane has been taught, and its group's. */
  page: (key: string) => request<{ channel: Channel; taught: Record<Lane, Taught[]>; group: (Group & { taught: Record<Lane, Taught[]> }) | null; teacher: boolean }>("GET", `/api/channels/${key}`),
  remove: async (key: string) => {
    await request("DELETE", `/api/channels/${key}`);
    useChannels.setState((now) => ({ channels: (now.channels ?? []).filter((one) => one.key !== key) }));
  },
  /** Who could narrate, and who narrates for which niche or channel already. */
  voices: () => request<{ voices: Voice[]; used: Used[] }>("GET", "/api/channels/voices"),
};

/** Every change to a group reads the channels again: what moved where is the server's. */
const reloaded = async <T>(work: Promise<T>): Promise<T> => {
  const answer = await work;
  await loadChannels();
  return answer;
};

/** A change that moves teaching between a group and its channels: what each was taught is read again. */
const moved = async <T>(work: Promise<T>): Promise<T> => {
  const answer = await reloaded(work);
  forgetTaught();
  return answer;
};

export const groupApi = {
  /** A group with what each of its lanes has been taught. */
  page: (key: string) => request<{ group: Group; taught: Record<Lane, Taught[]>; teacher: boolean }>("GET", `/api/groups/${key}`),
  /** Made of `channels`, its style started from `from`'s (whose teaching moves into it). */
  make: (channels: string[], from: string) => moved(request<{ group: Group }>("POST", "/api/groups", { channels, from }).then((answer) => answer.group)),
  set: (key: string, lanes: Partial<Record<Lane, string>>) => reloaded(request<{ group: Group }>("PUT", `/api/groups/${key}`, { lanes })),
  add: (key: string, channel: string) => moved(request("POST", `/api/groups/${key}/channels`, { channel })),
  /** Taken out with a copy of the group's teaching. */
  takeOut: (key: string, channel: string) => moved(request("DELETE", `/api/groups/${key}/channels/${channel}`)),
  /** Every channel taken out so. */
  ungroup: (key: string) => moved(request("DELETE", `/api/groups/${key}`)),
  /** A channel's own item moved into the group. */
  move: (key: string, item: string) => request("POST", `/api/groups/${key}/move`, { item }).then(forgetTaught),
};

/** 1,200,000 → "1.2M". */
export function compact(count: number | null | undefined): string | null {
  if (count === null || count === undefined) return null;
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

/** Who narrates, in a word or two. */
export const narrationLabel = (narration: Narration | null) => (narration === null ? null : narration.kind === "recorded" ? "Recorded by the editor" : narration.name);

/**
 * What each place's lanes have been taught, as last read: `group:<key>` (a
 * group's shared teaching) or `channel:<key>` (a channel's own). Read once a
 * minute at most (Channels' table asks for every row), again at once on a
 * page and after teaching moves.
 */
export const useTaught = create<{ places: Record<string, Record<Lane, Taught[]>>; round: number }>(() => ({ places: {}, round: 0 }));
const readAt = new Map<string, number>();
const asking = new Map<string, Promise<void>>();

export function loadTaught(place: string, fresh = false): Promise<void> {
  if (!fresh && Date.now() - (readAt.get(place) ?? 0) < 60_000) return Promise.resolve();
  const going = asking.get(place);
  if (going !== undefined) return going;
  const [kind, key] = [place.slice(0, place.indexOf(":")), place.slice(place.indexOf(":") + 1)];
  const keepAll = (found: Record<string, Record<Lane, Taught[]>>) => {
    for (const one of Object.keys(found)) readAt.set(one, Date.now());
    useTaught.setState((now) => ({ places: { ...now.places, ...found } }));
  };
  const work = (
    kind === "group"
      ? groupApi.page(key).then((page) => keepAll({ [place]: page.taught }))
      : channelApi.page(key).then((page) => keepAll({ [place]: page.taught, ...(page.group ? { [`group:${page.group.key}`]: page.group.taught } : {}) }))
  )
    .catch(() => undefined)
    .finally(() => asking.delete(place));
  asking.set(place, work);
  return work;
}

/** Everything read again where it's shown (teaching moved). */
export function forgetTaught(): void {
  readAt.clear();
  useTaught.setState((now) => ({ round: now.round + 1 }));
}

/** A place's teaching (null until read), read as it's shown; `fresh`: read again now (a page opening). */
export function useTaughtOf(place: string | null, fresh = false): Record<Lane, Taught[]> | null {
  const round = useTaught((state) => state.round);
  const taught = useTaught((state) => (place === null ? null : (state.places[place] ?? null)));
  useEffect(() => {
    if (place !== null) void loadTaught(place, fresh);
  }, [place, round, fresh]);
  return taught;
}

/** How many things a lane's agent was taught, per lane. */
export const countsOf = (taught: Record<Lane, Taught[]> | null): Record<Lane, number> | null =>
  taught === null ? null : (Object.fromEntries(LANES.map((lane) => [lane.key, taught[lane.key]?.length ?? 0])) as Record<Lane, number>);

/** "Script 3 · Edit 17", or "Nothing yet". */
export function taughtWords(counts: Record<Lane, number>): string {
  const words = LANES.filter((lane) => counts[lane.key] > 0).map((lane) => `${lane.label} ${counts[lane.key]}`);
  return words.length === 0 ? "Nothing yet" : words.join(" · ");
}

/** A voice's first name ("Andrew - Smooth audio books" → "Andrew"); the editor's recording, "Recorded". */
export const narrationShort = (narration: Narration | null) => (narration === null ? null : narration.kind === "recorded" ? "Recorded" : narration.name.split(" - ")[0]!.trim());

/** A group's channels, as shown: a group is one only while two or more of its channels are seen. */
export function shownGroup(channel: Channel, groups: Group[], channels: Channel[]): { group: Group; members: Channel[] } | null {
  const group = groups.find((one) => one.key === channel.group);
  if (group === undefined) return null;
  const members = channelsOf(group, channels);
  return members.length >= 2 ? { group, members } : null;
}

/** The channels as one list: the groups first (each where its first channel stands), then every channel in none. */
export type ChannelRow = { kind: "group"; key: string; group: Group; members: Channel[] } | { kind: "channel"; key: string; channel: Channel };

export function rowsOf(channels: Channel[], groups: Group[]): ChannelRow[] {
  const rows: ChannelRow[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    const shown = shownGroup(channel, groups, channels);
    if (shown === null) rows.push({ kind: "channel", key: channel.key, channel });
    else if (!seen.has(shown.group.key)) {
      seen.add(shown.group.key);
      rows.push({ kind: "group", key: shown.group.key, ...shown });
    }
  }
  return [...rows.filter((row) => row.kind === "group"), ...rows.filter((row) => row.kind === "channel")];
}

/** A YouTube banner's desktop band (2048 × 339), from the picture YouTube gives. */
export const bannerUrl = (banner: string | null | undefined): string | null => (banner ? (banner.includes("=") ? banner : `${banner}=w2120-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj`) : null);
