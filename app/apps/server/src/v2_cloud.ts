// Edit V2's cloud (v2_cloud.ts), the library (Nov 11, Sphe: "v2's cloud where its code and
// skills should live"): what Bodycam HQ's agent makes and is taught, kept by
// the team rather than by one computer or by Edit's release, every save a
// numbered version beside the others with one in use. Three kinds of item:
//
//     effect:<project>/<name>   a project's coded effect: its folder's files at each settled version
//     template:<name>           an effect every project can start from (a teacher's to change)
//     sound:<name>              a sound effect as code every project can start from (a teacher's)
//     skill:<name>              something the agent was told to remember, a line or two (a teacher's);
//                               skill:global, the one every agent has, is Edit's own (accounts' setGlobalSkill)
//
// Each template and sound carries a category to search by, a note (when to
// use it) and a brief (how to change it without making it again). Put away
// ("delete" it), an item leaves every list unless asked for, its versions
// kept: what the agent sees stays short (Sphe, Nov 11: with many projects
// over time the agents "are going to get quite clouded").
//
// The versions and pointers are mamagi's (edit:listLibrary, libraryVersions,
// libraryVersion, saveLibraryVersion, setLibraryCurrent; accounts'
// convex/edit.ts), the files R2's, each once, by its content
// (edit/library/sha256/<hex>), through the relay as everything of Edit's is.
// Nothing here happens signed out (no cloud): an effect then has only its
// folder, and the agent the release's text.

import fs from "node:fs";
import { dirname, join, sep } from "node:path";
import type { App } from "./app.ts";
import * as accounts from "./accounts.ts";
import * as cloud from "./cloud.ts";
import { sha256File } from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { granted } from "./kinds.ts";
import * as relay from "./relay.ts";

export type Kind = "effect" | "template" | "sound" | "skill" | "font" | "niche";

export interface File {
  /** Inside the effect's folder ("scene.html", "img/top.jpg"). */
  path: string;
  sha256: string;
  size: number;
}

export interface Item {
  key: string;
  kind: Kind;
  projectId: string | null;
  name: string;
  current: number;
  latest: number;
  note: string | null;
  brief: string | null;
  category: string | null;
  archived: boolean;
  /** The V2 niches it's for; null: V2's house, every niche's (a niche's own key, `<kind>:@<niche>/<name>`, is that one's). */
  niches?: string[] | null;
  at: number;
  by: { name: string } | null;
}

export interface Version {
  key: string;
  n: number;
  files: File[] | null;
  text?: string | null;
  reason: string | null;
  from: { key: string; n: number } | null;
  source: string | null;
  at: number;
  by: { name: string } | null;
}

/** Whether the library is there: signed in (or a relay token), so the cloud is. */
export function enabled(): boolean {
  return relay.cloudEnabled();
}

/** Whether the person on this computer is a teacher (`agent.teach`; an admin, or nobody signed in in tests, is one). */
export function teacher(): boolean {
  const given = granted();
  return given === null || given.has("agent.teach");
}

export const effectKey = (project: string, name: string) => `effect:${project}/${name}`;
/** A niche's own item of a kind: `<kind>:@<niche>/<name>`, which wins over the house's of its name in that niche. */
export const ownKey = (kind: "template" | "sound" | "skill" | "font", niche: string, name: string) => `${kind}:@${niche}/${name}`;
/** The niche an item's key makes it its own, or null. */
export const ownNicheOf = (key: string): string | null => /^[a-z]+:@([a-z0-9][a-z0-9-]{0,39})\//.exec(key)?.[1] ?? null;
export const templateKey = (name: string) => `template:${name}`;
export const soundKey = (name: string) => `sound:${name}`;
export const skillKey = (name: string) => `skill:${name}`;
export const fontKey = (name: string) => `font:${name}`;
/** The one skill every agent has: Edit's own, never put away. */
export const GLOBAL = "global";

const fileKey = (sha256: string) => `edit/library/sha256/${sha256}`;

/** One kind's items; those put away only with `archived`. */
export async function list(kind: Exclude<Kind, "effect">, archived = false): Promise<Item[]> {
  // owned: the niches' and the channel lanes' own items too (mamagi hands Edit from before niches the house's alone).
  return (await cloud.query("edit:listLibrary", { kind, owned: true, ...(archived ? { archived: true } : {}) })) as Item[];
}

/** Puts an item away (out of every list unless asked for, its versions kept), or back. */
export async function archive(key: string, archived: boolean): Promise<void> {
  await cloud.mutation("edit:archiveLibrary", { key, archived });
}

export async function projectEffects(project: string): Promise<Item[]> {
  return (await cloud.query("edit:listLibrary", { projectId: project })) as Item[];
}

export async function versions(key: string, text = false): Promise<Version[]> {
  return (await cloud.query("edit:libraryVersions", { key, ...(text ? { text: true } : {}) })) as Version[];
}

/** A version (`n`, else the one in use) and its item; null when the item has none. */
export async function version(key: string, n: number | null = null): Promise<{ item: Item; version: Version } | null> {
  return (await cloud.query("edit:libraryVersion", { key, ...(n === null ? {} : { n }) })) as { item: Item; version: Version } | null;
}

export async function setCurrent(key: string, n: number): Promise<void> {
  await cloud.mutation("edit:setLibraryCurrent", { key, n });
}

/**
 * An effect's files Edit makes again from the timeline, never kept in the
 * cloud: what's beneath it (effect_inputs.ts, made again before its next
 * render wherever its `.beneath.json` is but the video isn't). They were
 * 80% of the library's bytes (392 of 489 MB on Nov 13), a fresh copy of the
 * footage at every version, and a template carried its project's footage.
 */
const REMADE = new Set(["beneath.mp4"]);

/** Every file in a folder, however deep, by its path inside it (what's made again from the timeline left out). */
function walk(dir: string, under = ""): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(join(dir, under), { withFileTypes: true })) {
    const inside = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(dir, inside));
    else if (entry.isFile() && !entry.name.endsWith(".partial.mp4") && !REMADE.has(inside)) found.push(inside);
  }
  return found.sort();
}

/** A folder's files in R2, each once by its content: the list of them. */
async function putFiles(dir: string): Promise<File[]> {
  const files: File[] = [];
  for (const path of walk(dir)) {
    const full = join(dir, path);
    const sha256 = await sha256File(full);
    if (!(await cloud.has(fileKey(sha256)))) await cloud.uploadFile(full, fileKey(sha256));
    files.push({ path, sha256, size: fs.statSync(full).size });
  }
  return files;
}

/**
 * A version's files into `dir`, which then holds them and nothing else:
 * built beside it and swapped in, so a page is never half the old and half
 * the new.
 */
async function getFiles(files: File[], dir: string): Promise<void> {
  const fresh = `${dir}.incoming-${process.pid}`;
  fs.rmSync(fresh, { recursive: true, force: true });
  for (const file of files) {
    const target = join(fresh, file.path);
    if (!target.startsWith(fresh + sep)) throw new Error(`a file outside the folder: ${file.path}`);
    fs.mkdirSync(dirname(target), { recursive: true });
    // The same content already here (most of a revision is): copied, not fetched.
    const here = join(dir, file.path);
    if (fs.existsSync(here) && (await sha256File(here)) === file.sha256) fs.copyFileSync(here, target);
    else await cloud.download(fileKey(file.sha256), target);
  }
  // What's made again from the timeline stays as it was here (a version that has none of its own); its key says whether it's still of what's there.
  for (const path of REMADE) {
    if (files.some((file) => file.path === path) || !fs.existsSync(join(dir, path))) continue;
    fs.mkdirSync(fresh, { recursive: true });
    fs.linkSync(join(dir, path), join(fresh, path));
  }
  const old = `${dir}.outgoing-${process.pid}`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dir)) fs.renameSync(dir, old);
  fs.renameSync(fresh, dir);
  fs.rmSync(old, { recursive: true, force: true });
}

/**
 * A folder kept as the item's next version (in use at once): its files sent
 * up first, those already there not again. `source` names the code's version
 * (an effect's key): the same as the newest makes no new version.
 */
export async function save(key: string, name: string, dir: string, options: { reason?: string; from?: { key: string; n: number }; source?: string; note?: string; brief?: string; category?: string; niches?: string[] } = {}): Promise<{ n: number; made: boolean }> {
  const files = await putFiles(dir);
  // The same files as the version in use (a version just brought back, saved again as it renders): not a new one.
  const now = await version(key).catch(() => null);
  const same = (a: File[], b: File[]) => a.length === b.length && a.every((one, at) => one.path === b[at]!.path && one.sha256 === b[at]!.sha256);
  if (now !== null && now.version.files !== null && same(files, now.version.files)) return { n: now.version.n, made: false };
  return (await cloud.mutation("edit:saveLibraryVersion", { key, name, files, ...options })) as { n: number; made: boolean };
}

/**
 * A skill's next version (in use at once): a teacher's. A note (when to read
 * it) makes it one read when needed rather than always in mind. `key` is
 * where it's kept (a niche's own, by default `skill:<name>`), `niches` which
 * niches a shared one is for ([]: the house).
 */
export async function saveSkill(name: string, text: string, reason: string, note?: string, place: { key?: string; niches?: string[] } = {}): Promise<{ n: number }> {
  return (await cloud.mutation("edit:saveLibraryVersion", { key: place.key ?? skillKey(name), name, text, reason, ...(note !== undefined ? { note } : {}), ...(place.niches !== undefined ? { niches: place.niches } : {}) })) as { n: number };
}

/** An item's version in use kept again under another key (a niche cut loose keeps what it had), its note, brief and category with it. */
export async function copyItem(from: Item, toKey: string, reason: string): Promise<boolean> {
  const found = await version(from.key);
  if (found === null) return false;
  const kept = found.version;
  await cloud.mutation("edit:saveLibraryVersion", {
    key: toKey,
    name: from.name,
    ...(kept.files !== null ? { files: kept.files } : {}),
    ...(typeof kept.text === "string" ? { text: kept.text } : {}),
    reason,
    from: { key: from.key, n: kept.n },
    ...(from.note !== null ? { note: from.note } : {}),
    ...(from.brief !== null ? { brief: from.brief } : {}),
    ...(from.category !== null ? { category: from.category } : {}),
  });
  return true;
}

/**
 * A niche cut loose from the one it's like: what came through from the
 * niches it's like (not the house's) kept as its own, then the link gone.
 * Answers how many were kept.
 */
export async function cutLoose(key: string, reason: string): Promise<number> {
  const all = await listNiches();
  const niche = all.find((one) => one.key === key);
  if (niche === undefined) throw new Error(`no niche ${key}`);
  if (niche.like === null) throw new Error(`${niche.name} isn't like another niche: nothing to cut loose from`);
  const chain = chainOf(key, all);
  let copied = 0;
  for (const kind of ["skill", "template", "sound"] as const) {
    for (const item of forNiche(await list(kind), chain)) {
      const own = ownNicheOf(item.key);
      const inherited = own !== null ? own !== key : item.niches != null && item.niches.length > 0 && !item.niches.includes(key);
      if (inherited && (await copyItem(item, ownKey(kind, key, item.name), `kept when ${niche.name} was cut loose from ${niche.like}`))) copied++;
    }
  }
  await saveNiche({ ...niche, like: null }, reason);
  return copied;
}

/** What a niche knows, as its agents get it (`forNiche`), each with where it comes from: its lessons, effects, sounds and fonts. */
export async function knowledgeOf(key: string): Promise<{ kind: Kind; key: string; name: string; note: string | null; category: string | null; origin: string; own: boolean }[]> {
  const all = await listNiches();
  const chain = chainOf(key, all);
  const out: { kind: Kind; key: string; name: string; note: string | null; category: string | null; origin: string; own: boolean }[] = [];
  for (const kind of ["skill", "template", "sound", "font"] as const) {
    const items = await list(kind);
    for (const item of kind === "font" ? items : forNiche(items, chain)) {
      out.push({ kind, key: item.key, name: item.name, note: item.note, category: item.category, origin: kind === "font" ? "V2's house, every niche's" : originOf(item, chain), own: ownNicheOf(item.key) === key || (item.niches?.length === 1 && item.niches[0] === key) });
    }
  }
  return out;
}

/** An item's version `n` (else the one in use) put in `dir`; null when the item has none. */
export async function fetchInto(key: string, n: number | null, dir: string): Promise<Version | null> {
  const found = await version(key, n);
  if (found === null || found.version.files === null) return null;
  await getFiles(found.version.files, dir);
  return found.version;
}

// ---------------------------------------------------------------- V2's niches

/**
 * A V2 niche (Sphe, Nov 13: made "without us, creative manager and code",
 * taught from scratch, or "like" another, "this niche works very similarly to
 * the bodycam niche"): a key, its name, what kind of video it is, and the
 * niche it's like, whose teaching it has until it's taught otherwise (or cut
 * loose). Kept in V2's cloud as `niche:<key>`, its text this as JSON.
 */
export interface Niche {
  key: string;
  name: string;
  description: string;
  /** The niche it's like (its lessons and effects come through), or null. */
  like: string | null;
  /** The kind of video it is to Edit's own tools (a style: bodycam, interrogation…). */
  kind: string;
}

/** The niche a V2 project from before niches is in. */
export const BODYCAM_HQ = "bodycam-hq";
const NICHE_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A niche's key from its name ("Interrogation HQ" → interrogation-hq). */
export function nicheKeyOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "niche";
}

let niches: Niche[] = [];

/** The niches as last read (refreshSkills reads them with the skills). */
export function knownNiches(): Niche[] {
  return niches;
}

/** Reads the niches now. */
export async function listNiches(): Promise<Niche[]> {
  const items = await list("niche");
  const read = await Promise.all(items.map(async (item) => ({ item, text: (await version(item.key))?.version.text })));
  const out: Niche[] = [];
  for (const { item, text } of read) {
    try {
      const given = JSON.parse(text ?? "{}") as Partial<Niche>;
      out.push({ key: item.name, name: typeof given.name === "string" && given.name.trim() !== "" ? given.name : item.name, description: typeof given.description === "string" ? given.description : "", like: typeof given.like === "string" && given.like !== "" ? given.like : null, kind: typeof given.kind === "string" && given.kind !== "" ? given.kind : "bodycam" });
    } catch {
      // A niche's text that isn't JSON is left out, not the rest.
    }
  }
  niches = out.sort((a, b) => a.name.localeCompare(b.name));
  return niches;
}

/** A niche made or changed (a teacher's): what it's like refused when that would make a loop. */
export async function saveNiche(niche: Niche, reason: string): Promise<Niche> {
  if (!NICHE_KEY.test(niche.key)) throw new Error(`a niche's key is lower-case letters, digits and hyphens: "${niche.key}" isn't`);
  if (niche.like !== null) {
    const all = await listNiches();
    if (!all.some((one) => one.key === niche.like)) throw new Error(`there's no niche ${niche.like} to be like`);
    const others = all.filter((one) => one.key !== niche.key).concat(niche);
    if (chainOf(niche.key, others).length !== new Set(chainOf(niche.key, others)).size || chainOf(niche.like, others).includes(niche.key)) throw new Error(`${niche.like} is already like ${niche.key}: a niche can't be like itself`);
  }
  const text = JSON.stringify({ name: niche.name.trim(), description: niche.description.trim(), like: niche.like, kind: niche.kind });
  await cloud.mutation("edit:saveLibraryVersion", { key: `niche:${niche.key}`, name: niche.key, text, reason });
  await listNiches();
  forgetSkills();
  return niche;
}

/** A niche and the ones it's like, nearest first (a loop stops where it comes round). */
export function chainOf(key: string, among: Niche[] = niches): string[] {
  const out: string[] = [];
  for (let at: string | null = key; at !== null && !out.includes(at); at = among.find((one) => one.key === at)?.like ?? null) out.push(at);
  return out;
}

// ---------------------------------------------------------------- channels' lanes (Nov 14, channels.ts)

/** A channel's lanes: one per part of the work, each its own style; one lane's agent never sees another's. */
export const LANES = ["ideas", "thumbnails", "script", "edit"] as const;
export type Lane = (typeof LANES)[number];

/** A lane's place in the library, kept like a niche: its own lessons and effects are `<kind>:@<laneKey>/<name>`. */
export const laneKey = (channel: string, lane: Lane) => `${channel}--${lane}`;

/** The channel and lane a place in the library is, or null when it's a niche (a channel key has no "--"). */
export function laneOf(place: string): { channel: string; lane: Lane } | null {
  const at = place.lastIndexOf("--");
  if (at <= 0) return null;
  const lane = place.slice(at + 2);
  return (LANES as readonly string[]).includes(lane) ? { channel: place.slice(0, at), lane: lane as Lane } : null;
}

/** The niche a project is in: its channel's edit lane, else its own niche, else Bodycam HQ's (a V2 project from before niches). */
export function nicheOfProject(project: { niche?: string | null; channel?: string | null }): string {
  if (typeof project.channel === "string" && project.channel !== "") return laneKey(project.channel, "edit");
  return typeof project.niche === "string" && project.niche !== "" ? project.niche : BODYCAM_HQ;
}

/**
 * How near an item is to a niche: its own key in the niche or one it's like
 * (nearest first), then one kept for some of them, then the house's; null
 * when it's for other niches only. Of the items of a name, the nearest is
 * the one that niche uses.
 */
export function nearness(item: { key: string; niches?: string[] | null }, chain: string[]): number | null {
  const own = ownNicheOf(item.key);
  if (own !== null) {
    const at = chain.indexOf(own);
    return at < 0 ? null : at * 2;
  }
  // A channel's lane starts empty (Sphe, Nov 14: "the teaching, music, skills, and all that stuff, I think, should be
  // blank"): none of V2's house comes through, only the global skill, which is Edit's own workings.
  if (item.niches == null || item.niches.length === 0) return laneOf(chain[0] ?? "") !== null && item.key !== skillKey(GLOBAL) ? null : chain.length * 2;
  const at = Math.min(...item.niches.map((niche) => chain.indexOf(niche)).filter((index) => index >= 0));
  return Number.isFinite(at) ? at * 2 + 1 : null;
}

/** Of `items`, the one of each name a niche uses (`nearness`), in their order. */
export function forNiche<T extends { key: string; name: string; niches?: string[] | null }>(items: T[], chain: string[]): T[] {
  const best = new Map<string, { item: T; near: number }>();
  for (const item of items) {
    const near = nearness(item, chain);
    if (near === null) continue;
    const before = best.get(item.name);
    if (before === undefined || near < before.near) best.set(item.name, { item, near });
  }
  return items.filter((item) => best.get(item.name)?.item === item);
}

/** Where an item comes from, for a niche, in a few words ("this niche's own", "from Bodycam HQ", "V2's house"). */
export function originOf(item: { key: string; niches?: string[] | null }, chain: string[]): string {
  const own = ownNicheOf(item.key);
  const name = (key: string) => niches.find((one) => one.key === key)?.name ?? key;
  if (own !== null && laneOf(own) !== null) return own === chain[0] ? "this channel's own" : `from ${laneOf(own)!.channel}'s ${laneOf(own)!.lane} style`;
  if (own !== null) return own === chain[0] ? "this niche's own" : `from ${name(own)} (this niche is like it)`;
  if (item.niches == null || item.niches.length === 0) return "V2's house, every niche's";
  if (item.niches.length === 1 && item.niches[0] === chain[0]) return "this niche's own";
  return `kept for ${item.niches.map(name).join(", ")}`;
}

// ---------------------------------------------------------------- the agent's skills: what it's been told to remember

/**
 * One of the agent's skills: a memory (no note: always in its instructions,
 * a line or two) or a part of the edit (its note says when to read it, and
 * read_skill brings it in then), so what's always in mind stays short.
 */
export interface Skill {
  name: string;
  text: string;
  note?: string;
  /** Its item's key and niches (which niches have it: `forNiche`). */
  key?: string;
  niches?: string[] | null;
}

/** The skills in V2's cloud (the global one first), as last read. */
let skills: Skill[] = [];
let readAt = 0;
const SKILLS_FRESH_MS = 30_000;

/** What a niche's agent knows (`niche`'s and the ones it's like, then the house's): the global skill, then the rest by name. */
export function memories(niche: string = BODYCAM_HQ): Skill[] {
  return forNiche(skills.map((one) => ({ ...one, key: one.key ?? skillKey(one.name) })), chainOf(niche));
}

/** One skill a niche knows, as last read. */
export function skill(name: string, niche: string = BODYCAM_HQ): Skill | undefined {
  return memories(niche).find((one) => one.name === name);
}

/** Reads the skills, at most every 30 s (a turn's start asks): a failure keeps what was read before. */
export async function refreshSkills(): Promise<void> {
  if (!enabled() || Date.now() - readAt < SKILLS_FRESH_MS) return;
  readAt = Date.now();
  try {
    const items = await list("skill");
    // Each skill's text at once, and the niches: a turn waits on this.
    // The niches as last read when they can't be: a turn's lessons don't wait on them.
    const [read] = await Promise.all([Promise.all(items.map(async (item) => ({ item, text: (await version(item.key))?.version.text }))), listNiches().catch(() => knownNiches())]);
    const next: Skill[] = [];
    for (const { item, text } of read) {
      if (typeof text === "string" && text.trim() !== "") next.push({ name: item.name, text: text.trim(), ...(item.note ? { note: item.note } : {}), key: item.key, niches: item.niches ?? null });
    }
    skills = next.sort((a, b) => Number(b.name === GLOBAL) - Number(a.name === GLOBAL) || a.name.localeCompare(b.name));
  } catch (error) {
    diag.warn("library", `the agent's skills from the cloud: ${diag.messageOf(error)}`);
  }
}

/** The skills read again at the next ask (one was just saved or put away). */
export function forgetSkills(): void {
  readAt = 0;
}

/** Tests: the skills as given, read now. */
export function useSkillsForTests(given: Skill[]): void {
  skills = given;
  readAt = Date.now();
}

/** Who saves, for the agent's words ("you" when it's this computer's person). */
export function whoIs(by: { name: string } | null): string {
  const me = accounts.status() as { person: { name?: string } | null };
  if (by === null) return "Edit";
  return me.person?.name === by.name ? `${by.name} (this computer)` : by.name;
}

export type { App };
