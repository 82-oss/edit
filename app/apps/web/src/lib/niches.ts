// Edit V2's niches (the server's v2_cloud.ts): kinds of video kept in the
// cloud as data, not code (Sphe, Nov 13: "make it easy for us to create a new
// niche without… code"). New project offers them with V2 on; a niche's page
// shows what its agent knows, and a teacher changes it there.

import { create } from "zustand";

import { request } from "./api";
import type { Style } from "./types";

export interface Niche {
  key: string;
  name: string;
  /** What kind of videos it is, in a line (New project's tooltip). */
  description: string;
  /** The niche it's like (whose teaching comes through), or null. */
  like: string | null;
  /** The kind of video it is to Edit's own tools. */
  kind: Style;
}

export type KnowledgeKind = "skill" | "template" | "sound" | "font";

/** One thing a niche's agent knows, and where it comes from. */
export interface Knowledge {
  kind: KnowledgeKind;
  key: string;
  name: string;
  /** A lesson's part of the edit, read when needed; null: always in mind. */
  note: string | null;
  category: string | null;
  /** Where it comes from, in words ("this niche's own", "from Bodycam HQ (this niche is like it)"). */
  origin: string;
  own: boolean;
}

export interface NichePage {
  niche: Niche;
  /** The niche, then the ones it's like, nearest first. */
  chain: { key: string; name: string }[];
  items: Knowledge[];
  niches: Niche[];
  teacher: boolean;
}

/** The niche a V2 project from before niches is in, and New project's one pill when the list can't be had. */
export const BODYCAM_HQ = "bodycam-hq";

/** The niches, as last asked (null: not yet), and whether this person may teach them. */
export const useNiches = create<{ niches: Niche[] | null; teacher: boolean }>(() => ({ niches: null, teacher: false }));

/** The niches asked again; signed out or refused, none (New project falls back to Bodycam HQ). */
export async function loadNiches(): Promise<Niche[]> {
  try {
    const { niches, teacher } = await request<{ niches: Niche[]; teacher: boolean }>("GET", "/api/v2/niches");
    useNiches.setState({ niches, teacher });
    return niches;
  } catch {
    useNiches.setState({ niches: [], teacher: false });
    return [];
  }
}

export const nicheApi = {
  page: (key: string) => request<NichePage>("GET", `/api/v2/niches/${encodeURIComponent(key)}`),
  /** Without `key`, a new niche; with it, that niche changed. `like: ""` is like none. */
  save: (body: { key?: string; name: string; description?: string; like?: string; kind?: Style }) => request<{ niche: Niche }>("POST", "/api/v2/niches", body),
  cutLoose: (key: string) => request<{ kept: number }>("POST", `/api/v2/niches/${encodeURIComponent(key)}/cut-loose`),
  lesson: (key: string) => request<{ key: string; text: string | null; note: string | null }>("GET", `/api/v2/lessons?key=${encodeURIComponent(key)}`),
  saveLesson: (key: string, text: string, niche: string) => request<{ key: string }>("POST", "/api/v2/lessons", { key, text, niche }),
  copy: (key: string, to: string) => request<{ key: string }>("POST", "/api/v2/library/copy", { key, to }),
  archive: (key: string, archived: boolean) => request<{ key: string }>("POST", "/api/v2/library/archive", { key, archived }),
};

/** The lesson every niche's agent has: read, never changed or put away from a page. */
export const GLOBAL_LESSON = "skill:global";

/** One of New project's V2 pills: a niche, or Bodycam HQ as it was before niches (`niche` null). */
export interface V2Choice {
  key: string;
  name: string;
  description: string;
  kind: Style;
  niche: string | null;
}

const BODYCAM_HQ_CHOICE: V2Choice = { key: BODYCAM_HQ, name: "Bodycam HQ", description: "16:9 · a bodycam case with graphics the agent writes as code", kind: "bodycam", niche: null };

/**
 * New project's V2 pills: the niches of a kind this person edits, and Bodycam
 * HQ as it was before niches whenever no niche is it (signed out, not asked
 * yet, refused, or a cloud without it), so nothing that worked goes.
 */
export function v2Choices(niches: Niche[] | null, styles: readonly Style[]): V2Choice[] {
  const mine = (niches ?? []).filter((one) => styles.includes(one.kind)).map((one): V2Choice => ({ key: one.key, name: one.name, description: one.description, kind: one.kind, niche: one.key }));
  // Bodycam HQ stays until a niche of its own stands for it: a cloud whose first niche is another (prod has no
  // bodycam-hq seeded) would otherwise take it off New project.
  return styles.includes("bodycam") && !mine.some((one) => one.key === BODYCAM_HQ) ? [BODYCAM_HQ_CHOICE, ...mine] : mine;
}

/** The niches `key` is like, nearest first, itself first (a loop stops where it would come back). */
export function chainOf(key: string, niches: readonly Niche[]): string[] {
  const out: string[] = [];
  for (let at: string | null = key; at !== null && !out.includes(at); at = niches.find((one) => one.key === at)?.like ?? null) out.push(at);
  return out;
}

/** What `key` may be like: any other niche that isn't, through its own likes, like it already. */
export function likeOptions(key: string, niches: readonly Niche[]): Niche[] {
  return niches.filter((one) => one.key !== key && !chainOf(one.key, niches).includes(key));
}

const SECTIONS: [KnowledgeKind, string][] = [
  ["skill", "Lessons"],
  ["template", "Effects"],
  ["sound", "Sounds"],
  ["font", "Fonts"],
];

export interface KnowledgeSection {
  kind: KnowledgeKind;
  title: string;
  count: number;
  /** By where they come from: the niche's own first, then as the server listed them. */
  groups: { origin: string; own: boolean; items: Knowledge[] }[];
}

/** A niche's page: what its agent knows, by kind (empty kinds left out), each kind by where it comes from. */
export function groupKnowledge(items: readonly Knowledge[]): KnowledgeSection[] {
  return SECTIONS.flatMap(([kind, title]) => {
    const mine = items.filter((one) => one.kind === kind);
    if (mine.length === 0) return [];
    const groups: KnowledgeSection["groups"] = [];
    for (const item of mine) {
      const group = groups.find((one) => one.origin === item.origin);
      if (group) group.items.push(item);
      else groups.push({ origin: item.origin, own: item.own, items: [item] });
    }
    groups.sort((a, b) => Number(b.own) - Number(a.own));
    return [{ kind, title, count: mine.length, groups }];
  });
}

/** Whether a page's row can be copied to another niche (lessons, effects, sounds; not fonts). */
export const copyable = (item: Knowledge): boolean => item.kind !== "font";

/** Whether a page's row can be put away (anything but the global lesson). */
export const archivable = (item: Knowledge): boolean => item.key !== GLOBAL_LESSON && item.kind !== "font";
