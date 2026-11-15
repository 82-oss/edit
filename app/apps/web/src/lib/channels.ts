// Channels (the server's channels.ts): the team's YouTube channels, each with
// its lanes (ideas, thumbnails, script, edit), how its videos are made, and the
// teaching each lane's agent is given. Home's Channels lists them; New project
// picks one. A placeholder is a channel by its name alone, before it's on
// YouTube, linked to its YouTube channel later with its teaching kept. A group
// is channels sharing one style, taught once: shown as one row, its channels'
// names together; work still belongs to one channel.

import { create } from "zustand";

import { request } from "./api";

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

/** The channels, as last asked (null: not yet), and whether this person adds and teaches them. */
export const useChannels = create<{ channels: Channel[] | null; groups: Group[]; teacher: boolean }>(() => ({ channels: null, groups: [], teacher: false }));

export async function loadChannels(): Promise<Channel[]> {
  try {
    const { channels, groups, teacher } = await request<{ channels: Channel[]; groups?: Group[]; teacher: boolean }>("GET", "/api/channels");
    useChannels.setState({ channels, groups: groups ?? [], teacher });
    return channels;
  } catch {
    useChannels.setState((now) => ({ channels: now.channels ?? [], teacher: now.teacher }));
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
  set: (key: string, change: { narration?: Narration; compilation?: boolean; lanes?: Partial<Record<Lane, string>>; label?: string }) =>
    request<{ channel: Channel }>("PUT", `/api/channels/${key}`, change).then((answer) => keep(answer.channel)),
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

export const groupApi = {
  /** A group with what each of its lanes has been taught. */
  page: (key: string) => request<{ group: Group; taught: Record<Lane, Taught[]>; teacher: boolean }>("GET", `/api/groups/${key}`),
  /** Made of `channels`, its style started from `from`'s (whose teaching moves into it). */
  make: (channels: string[], from: string) => reloaded(request<{ group: Group }>("POST", "/api/groups", { channels, from }).then((answer) => answer.group)),
  set: (key: string, lanes: Partial<Record<Lane, string>>) => reloaded(request<{ group: Group }>("PUT", `/api/groups/${key}`, { lanes })),
  add: (key: string, channel: string) => reloaded(request("POST", `/api/groups/${key}/channels`, { channel })),
  /** Taken out with a copy of the group's teaching. */
  takeOut: (key: string, channel: string) => reloaded(request("DELETE", `/api/groups/${key}/channels/${channel}`)),
  /** Every channel taken out so. */
  ungroup: (key: string) => reloaded(request("DELETE", `/api/groups/${key}`)),
  /** A channel's own item moved into the group. */
  move: (key: string, item: string) => request("POST", `/api/groups/${key}/move`, { item }),
};

/** 1,200,000 → "1.2M". */
export function compact(count: number | null | undefined): string | null {
  if (count === null || count === undefined) return null;
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

/** Who narrates, in a word or two. */
export const narrationLabel = (narration: Narration | null) => (narration === null ? null : narration.kind === "recorded" ? "Recorded by the editor" : narration.name);
