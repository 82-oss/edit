// Edit V2's cloud (v2_cloud.ts), the library (Nov 11, Sphe: "v2's cloud where its code and
// skills should live"): what Edit V2's agent makes and is taught, kept by
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
// What an agent is taught is a place's: a channel's lane (`laneKey`), whose
// own items are `<kind>:@<place>/<name>`, and, for a channel in a group, its
// group's lane after it (channels.ts `placesOf`; the channel's own winning by
// name). A V2 project made without a channel has no place and is taught
// nothing but the global skill.
//
// The versions and pointers are mamagi's (edit:listLibrary, libraryVersions,
// libraryVersion, saveLibraryVersion, setLibraryCurrent; accounts'
// convex/edit.ts), the files R2's, each once, by its content
// (edit/library/sha256/<hex>), through the relay as everything of Edit's is.
// Nothing here happens signed out (no cloud): an effect then has only its
// folder, and the agent the release's text.

import * as addons from "./addons.ts";
import { ADDON_PREFIX } from "./addons.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { dirname, join, sep } from "node:path";
import type { App } from "./app.ts";
import * as accounts from "./accounts.ts";
import * as cloud from "./cloud.ts";
import { sha256File } from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { granted } from "./kinds.ts";
import * as relay from "./relay.ts";

export type Kind = "effect" | "template" | "sound" | "skill" | "font";

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
/** A place's own item of a kind (a channel lane's, `laneKey`): `<kind>:@<place>/<name>`. */
export const ownKey = (kind: "template" | "sound" | "skill" | "font", place: string, name: string) => `${kind}:@${place}/${name}`;
/** The place an item's key makes it its own, or null (V2's house). */
export const ownPlaceOf = (key: string): string | null => /^[a-z]+:@([a-z0-9][a-z0-9-]{0,39})\//.exec(key)?.[1] ?? null;
export const templateKey = (name: string) => `template:${name}`;
export const soundKey = (name: string) => `sound:${name}`;
export const skillKey = (name: string) => `skill:${name}`;
export const fontKey = (name: string) => `font:${name}`;
/** The one skill every agent has: Edit's own, never put away. */
export const GLOBAL = "global";

const fileKey = (sha256: string) => `edit/library/sha256/${sha256}`;

/** One kind's items; those put away only with `archived`. */
export async function list(kind: Exclude<Kind, "effect">, archived = false): Promise<Item[]> {
  // owned: the channel lanes' own items too (mamagi hands older Edits the house's alone).
  return (await cloud.query("edit:listLibrary", { kind, owned: true, ...(archived ? { archived: true } : {}) })) as Item[];
}

/** Puts an item away (out of every list unless asked for, its versions kept), or back. */
export async function archive(key: string, archived: boolean): Promise<void> {
  await cloud.mutation("edit:archiveLibrary", { key, archived });
  forgetSkills();
  // Put away: out of what agents are told at once, and out of any read begun before this (CodeRabbit on #11).
  if (archived) {
    putAway.set(key, skillsChanged);
    asRead([...skills, ...addonSkills].filter((one) => one.key !== key));
  } else putAway.delete(key);
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

/**
 * A folder's files in R2, each once by its content: the list of them. Each is hashed and sent from a copy of its own:
 * read where it's written (an agent's edit landing between the hash and the upload), R2 kept bytes that weren't the
 * content its key names, for every version after that names it (PR #14's CodeRabbit review).
 */
async function putFiles(dir: string, only?: readonly string[]): Promise<File[]> {
  const files = only === undefined ? walk(dir) : walk(dir).filter((path) => only.includes(path));
  const copies = await fs.promises.mkdtemp(join(os.tmpdir(), "edit-put-"));
  let made = 0;
  try {
    return await eachAtOnce(files, async (path) => {
      const copy = join(copies, String(made++));
      await fs.promises.copyFile(join(dir, path), copy);
      const sha256 = await sha256File(copy);
      if (!(await cloud.has(fileKey(sha256)))) await cloud.uploadFile(copy, fileKey(sha256));
      return { path, sha256, size: (await fs.promises.stat(copy)).size };
    });
  } finally {
    await fs.promises.rm(copies, { recursive: true, force: true });
  }
}

/** A save whose copy of its folder wasn't what it was asked for (`save`'s `still`): no version made of it. */
export class Moved extends Error {}

/**
 * How many of a version's files go up or come down at once. One at a time, an
 * effect of 45 pictures took 54 s to come down on a Mac that opened its
 * project (Nov 16, Test Motion Graphics on the M4: about a second a file,
 * most of it the asking), its viewer blank all the while.
 */
const FILES_AT_ONCE = 8;

/** `work` on each item, `FILES_AT_ONCE` at a time; the answers in the items' order. One that fails stops the rest taking more. */
export async function eachAtOnce<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const answers = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      const at = next++;
      try {
        answers[at] = await work(items[at]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  // Every lane ended before a failure is said (none takes a new item once one fails): what's cleared after it, a
  // folder or copies, isn't written again by a lane still running (PR #14's CodeRabbit review).
  const ended = await Promise.allSettled(Array.from({ length: Math.min(FILES_AT_ONCE, items.length) }, lane));
  const failure = ended.find((one) => one.status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return answers;
}

/**
 * A version's files into `dir`, which then holds them and nothing else:
 * built beside it and swapped in, so a page is never half the old and half
 * the new.
 */
async function getFiles(files: File[], dir: string, still?: () => boolean): Promise<boolean> {
  // Its own, by call: two fetches into one folder side by side each cleared the other's (PR #14's CodeRabbit review).
  const call = `${process.pid}-${randomUUID()}`;
  const fresh = `${dir}.incoming-${call}`;
  fs.rmSync(fresh, { recursive: true, force: true });
  for (const file of files) {
    if (!join(fresh, file.path).startsWith(fresh + sep)) throw new Error(`a file outside the folder: ${file.path}`);
  }
  // What came of a fetch that failed is cleared (each call's folder is its own, so no later one clears it).
  try {
    await eachAtOnce(files, async (file) => {
      const target = join(fresh, file.path);
      fs.mkdirSync(dirname(target), { recursive: true });
      // The same content already here (most of a revision is): copied, not fetched.
      const here = join(dir, file.path);
      if (fs.existsSync(here) && (await sha256File(here)) === file.sha256) fs.copyFileSync(here, target);
      else await cloud.download(fileKey(file.sha256), target);
    });
  } catch (error) {
    fs.rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
  // What's made again from the timeline stays as it was here (a version that has none of its own); its key says whether it's still of what's there.
  for (const path of REMADE) {
    if (files.some((file) => file.path === path) || !fs.existsSync(join(dir, path))) continue;
    fs.mkdirSync(fresh, { recursive: true });
    fs.linkSync(join(dir, path), join(fresh, path));
  }
  // Asked with nothing else run between it and the swap.
  if (still !== undefined && !still()) {
    fs.rmSync(fresh, { recursive: true, force: true });
    return false;
  }
  const old = `${dir}.outgoing-${call}`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dir)) fs.renameSync(dir, old);
  fs.renameSync(fresh, dir);
  fs.rmSync(old, { recursive: true, force: true });
  return true;
}

/**
 * A folder kept as the item's next version (in use at once): its files sent
 * up first, those already there not again. `source` names the code's version
 * (an effect's key): the same as the newest makes no new version. `only`:
 * just these of its files (a kept effect's, effect_kept.ts), the rest left.
 */
export async function save(key: string, name: string, dir: string, options: { reason?: string; from?: { key: string; n: number }; source?: string; note?: string; brief?: string; category?: string; only?: readonly string[]; still?: (folder: string, files: File[]) => boolean } = {}): Promise<{ n: number; made: boolean }> {
  const { only, still, ...given } = options;
  if (still === undefined) return saveFiles(key, name, await putFiles(dir, only), given);
  // Judged on a copy of the folder, the one sent: the folder itself may change while it's read, and judged where the
  // agent writes, code that went A, B as a file was copied, then A again passed for A with B's page (PR #14's
  // CodeRabbit review). `still` says the copy is the code asked for, by the files as they went up (hashed going up,
  // off the server's thread: a copy is never read twice, and an effect's video read at once held the thread).
  const copy = await fs.promises.mkdtemp(join(os.tmpdir(), "edit-save-"));
  try {
    await eachAtOnce(only === undefined ? walk(dir) : walk(dir).filter((path) => only.includes(path)), async (path) => {
      await fs.promises.mkdir(dirname(join(copy, path)), { recursive: true });
      await fs.promises.copyFile(join(dir, path), join(copy, path));
    });
    const files = await putFiles(copy);
    if (!still(copy, files)) throw new Moved(`${name} isn't the code asked for, or isn't to be kept from here now`);
    return await saveFiles(key, name, files, given);
  } finally {
    await fs.promises.rm(copy, { recursive: true, force: true });
  }
}

/** `files`, already sent, kept as the item's next version (`save`). */
async function saveFiles(key: string, name: string, files: File[], given: { reason?: string; from?: { key: string; n: number }; source?: string; note?: string; brief?: string; category?: string }): Promise<{ n: number; made: boolean }> {
  // The same files as the version in use (a version just brought back, saved again as it renders): not a new one.
  const now = await version(key).catch(() => null);
  const same = (a: File[], b: File[]) => a.length === b.length && a.every((one, at) => one.path === b[at]!.path && one.sha256 === b[at]!.sha256);
  if (now !== null && now.version.files !== null && same(files, now.version.files)) return { n: now.version.n, made: false };
  const saved = (await cloud.mutation("edit:saveLibraryVersion", { key, name, files, ...given })) as { n: number; made: boolean };
  // A library piece kept (not a project's own effect): what's taught is read again (teaching_gate.ts sees it at once).
  if (!key.startsWith("effect:")) forgetSkills();
  return saved;
}

/**
 * A skill's next version (in use at once): a teacher's. A note (when to read
 * it) makes it one read when needed rather than always in mind. `key` is
 * where it's kept (a place's own, `ownKey`; by default `skill:<name>`).
 */
export async function saveSkill(name: string, text: string, reason: string, note?: string, place: { key?: string; latest?: number } = {}): Promise<{ n: number }> {
  const key = place.key ?? skillKey(name);
  try {
    return (await cloud.mutation("edit:saveLibraryVersion", { key, name, text, reason, ...(note !== undefined ? { note } : {}), ...(place.latest !== undefined ? { latest: place.latest } : {}) })) as { n: number };
  } catch (error) {
    // Changed by someone else since it was read (Nov 16 audit: the last save won, unseen): the agent is handed it as it is now, to put its change into.
    if (!/has a newer version|conflict/iu.test(diag.messageOf(error))) throw error;
    forgetSkills();
    const now = await version(key).catch(() => null);
    throw new Error(`Someone else changed ${name} since this conversation read it. As it is now:\n${now?.version.text?.trim() ?? "(couldn't be read: remember it again in a moment)"}\nPut your change into that, keeping theirs, and remember it again.`);
  }
}

/** An item's version in use kept again under another key (one channel's brought into another's), its note, brief and category with it. */
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
  forgetSkills();
  return true;
}

/**
 * An item's version `n` (else the one in use) put in `dir`; null when the item has none, or `still` (asked just
 * before the swap, once its files are here) says `dir` is no longer as it was asked for.
 */
export async function fetchInto(key: string, n: number | null, dir: string, still?: () => boolean): Promise<Version | null> {
  const found = await version(key, n);
  if (found === null || found.version.files === null) return null;
  return (await getFiles(found.version.files, dir, still)) ? found.version : null;
}

// ---------------------------------------------------------------- channels' lanes (Nov 14, channels.ts)

/** A channel's lanes: one per part of the work, each its own style; one lane's agent never sees another's. */
export const LANES = ["ideas", "thumbnails", "script", "edit"] as const;
export type Lane = (typeof LANES)[number];

/** A lane's place in the library: its own lessons and effects are `<kind>:@<laneKey>/<name>`. */
export const laneKey = (channel: string, lane: Lane) => `${channel}--${lane}`;

/** The channel and lane a place in the library is, or null when it isn't a lane's (a channel key has no "--"). */
export function laneOf(place: string): { channel: string; lane: Lane } | null {
  const at = place.lastIndexOf("--");
  if (at <= 0) return null;
  const lane = place.slice(at + 2);
  return (LANES as readonly string[]).includes(lane) ? { channel: place.slice(0, at), lane: lane as Lane } : null;
}

/** The place a V2 project is taught from: its channel's edit lane; null for one made without a channel (the global skill alone). */
export function placeOfProject(project: { channel?: string | null }): string | null {
  return typeof project.channel === "string" && project.channel !== "" ? laneKey(project.channel, "edit") : null;
}

/** Where an agent is taught from, nearest first: a channel lane's place, then its group's (`channels.placesOf`); null: nowhere but the global skill. */
export type Places = string | readonly string[] | null;

const placeList = (places: Places): readonly string[] => (places === null ? [] : typeof places === "string" ? [places] : places);

/**
 * How near an item is to a place: its own first, then its group's, then the
 * global skill; null for anything else (Sphe, Nov 14: a channel's lane starts
 * "blank", none of V2's house coming through but the global skill, which is
 * Edit's own workings). Of the items of a name, the nearest is the one that
 * place uses.
 */
export function nearness(item: { key: string }, places: Places): number | null {
  const list = placeList(places);
  const own = ownPlaceOf(item.key);
  if (own !== null) return list.includes(own) ? list.indexOf(own) : null;
  return item.key === skillKey(GLOBAL) ? list.length : null;
}

/** Of `items`, the one of each name a place uses (`nearness`), in their order. */
export function forPlace<T extends { key: string; name: string }>(items: T[], place: Places): T[] {
  const best = new Map<string, { item: T; near: number }>();
  for (const item of items) {
    const near = nearness(item, place);
    if (near === null) continue;
    const before = best.get(item.name);
    if (before === undefined || near < before.near) best.set(item.name, { item, near });
  }
  return items.filter((item) => best.get(item.name)?.item === item);
}

/** Where an item comes from, for a place, in a few words ("this channel's own", "its group's", "V2's house"). */
export function originOf(item: { key: string }, places: Places): string {
  const list = placeList(places);
  const own = ownPlaceOf(item.key);
  const lane = own === null ? null : laneOf(own);
  if (own !== null && own === list[0]) return "this channel's own";
  if (own !== null && list.indexOf(own) > 0) return "its group's";
  if (lane !== null) return `from ${lane.channel}'s ${lane.lane} style`;
  return "V2's house";
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
  /** Its item's key (whose it is: `forPlace`). */
  key?: string;
  /** Its newest version when it was read: a save over a newer one (another teacher's) is refused, not lost. */
  latest?: number;
}

/** The skills in V2's cloud (the global one first), as last read: the lessons alone, the add-ons apart. */
let skills: Skill[] = [];
/** Of those, the channels' add-ons (`addon-<name>`), apart: as last read, a new array at each read. */
let addonSkills: Skill[] = [];

/**
 * A channel's add-on is kept as a skill named `addon-<name>` (addons.ts):
 * Edit's own code switched on for the channel, not something the agent was
 * told. It's never one of the agent's lessons, never read with read_skill,
 * and never makes a place taught; addons.ts reads them (`addonItems`).
 */
export { ADDON_PREFIX };
export const isAddon = (name: string) => name.startsWith(ADDON_PREFIX);

/** The skills as read: the lessons, and the add-ons apart. */
function asRead(given: Skill[]): void {
  skills = given.filter((one) => !isAddon(one.name));
  addonSkills = given.filter((one) => isAddon(one.name));
}

/**
 * Why a lesson can't be kept under `name`, or null when it can: an add-on's
 * name (set only by its own tool), and in the edit lane `removal`
 * (removal_lesson.ts SKILL: what a channel takes out of its footage, kept only
 * by teach_removal, which a lesson by hand would replace with nothing read).
 */
export function reservedName(name: string, lane: Lane): string | null {
  if (isAddon(name)) return `${name}: names starting ${ADDON_PREFIX} are the channel's add-ons (Edit's own code it switches on), set only by their own tool, never kept as a lesson. Give the lesson another name.`;
  if (name === "removal" && lane === "edit") return "removal is what this channel takes out of its footage's picture, kept only with teach_removal, never as a lesson: use teach_removal, or give the lesson another name.";
  return null;
}
/** The effects and sounds in V2's cloud, by key and name alone, as last read with the skills. */
let pieces: { key: string; name: string }[] = [];
let readAt = 0;
const SKILLS_FRESH_MS = 30_000;

/** What a place's agent knows (null: a V2 project without a channel): the global skill, then the place's own by name; never an add-on. */
export function memories(place: Places): Skill[] {
  return forPlace(skills.map((one) => ({ ...one, key: one.key ?? skillKey(one.name) })), place);
}

/**
 * Whether a place has been taught anything of its own, as last read: a lesson
 * past the global skill, or an effect, a graphic or a sound. A channel taught
 * only effects is taught (Nov 16 audit: it was told it had nothing).
 */
export function taughtAnything(place: Places): boolean {
  return memories(place).some((one) => one.name !== GLOBAL) || forPlace(pieces, place).length > 0;
}

/** One skill a place knows, as last read. */
export function skill(name: string, place: Places): Skill | undefined {
  return memories(place).find((one) => one.name === name);
}

/** Every add-on item as last read, whatever its place: the same array until the next read (addons.ts indexes it once per read). */
export function addonItems(): readonly Skill[] {
  return addonSkills;
}

/** Whether the skills have been read from the cloud since Edit started: until then "nothing taught" means "not known". */
let skillsRead = false;
/** The read under way, which every caller shares (Nov 16 audit: a second turn starting while the first read was still out got the empty list, and was told its channel was untaught). */
let skillsReading: Promise<void> | null = null;
/** Bumped by each save or put-away (`forgetSkills`): a read that began before one is read again, never kept as fresh (CodeRabbit on #11). */
let skillsChanged = 0;
/** Items put away here, with the `skillsChanged` they were put away at: a read begun before that leaves them out. */
const putAway = new Map<string, number>();
/** A failed read is tried again this soon, not after the usual 30 s. */
const SKILLS_RETRY_MS = 5_000;
/** How long a turn's start waits on a read; it carries on in the background, and the turn goes with what was read before. */
export const SKILLS_WAIT_MS = 20_000;

/** Whether what's taught is known: read from the cloud at least once since Edit started. */
export function teachingKnown(): boolean {
  return skillsRead;
}

/** Reads the skills, at most every 30 s (a turn's start asks), waiting at most SKILLS_WAIT_MS: a failure keeps what was read before. */
export async function refreshSkills(): Promise<void> {
  if (!enabled()) return;
  if (skillsReading === null && Date.now() - readAt < SKILLS_FRESH_MS) return;
  skillsReading ??= (async () => {
    try {
      for (let tries = 1; ; tries++) {
        const asked = skillsChanged;
        const [items, templates, sounds] = await Promise.all([list("skill"), list("template"), list("sound")]);
        // Each skill's text at once: a turn waits on this.
        const read = await Promise.all(items.map(async (item) => ({ item, text: (await version(item.key))?.version.text })));
        const next: Skill[] = [];
        for (const { item, text } of read) {
          const gone = putAway.get(item.key);
          if (gone !== undefined && asked < gone) continue;
          if (typeof text === "string" && text.trim() !== "") next.push({ name: item.name, text: text.trim(), ...(item.note ? { note: item.note } : {}), key: item.key, latest: item.latest });
        }
        // Something saved or put away while this read was out: it's never shown (what was there stays, a put-away already out of it), and it's read again (CodeRabbit on #11). A first read made stale leaves what's taught unknown (`teachingKnown`), never taken from it.
        const current = asked === skillsChanged;
        if (current) {
          pieces = [...templates, ...sounds].map(({ key, name }) => ({ key, name }));
          asRead(next.sort((a, b) => Number(b.name === GLOBAL) - Number(a.name === GLOBAL) || a.name.localeCompare(b.name)));
          skillsRead = true;
        }
        if (current || tries === 3) {
          readAt = current ? Date.now() : 0;
          break;
        }
      }
    } catch (error) {
      readAt = Date.now() - SKILLS_FRESH_MS + SKILLS_RETRY_MS;
      diag.warn("library", `the agent's skills from the cloud: ${diag.messageOf(error)}`);
    } finally {
      skillsReading = null;
    }
  })();
  const reading = skillsReading;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([reading, new Promise<void>((resolve) => (timer = setTimeout(resolve, SKILLS_WAIT_MS)))]);
  clearTimeout(timer);
}

/** The skills read again at the next ask (one was just saved or put away). */
export function forgetSkills(): void {
  readAt = 0;
  skillsChanged++;
}

/** Tests: the skills as given, read now. */
export function useSkillsForTests(given: Skill[], effectsAndSounds: { key: string; name: string }[] = [], known = true): void {
  asRead(given);
  pieces = effectsAndSounds;
  readAt = Date.now();
  skillsRead = known;
}

/** Who saves, for the agent's words ("you" when it's this computer's person). */
export function whoIs(by: { name: string } | null): string {
  const me = accounts.status() as { person: { name?: string } | null };
  if (by === null) return "Edit";
  return me.person?.name === by.name ? `${by.name} (this computer)` : by.name;
}

export type { App };

// addons.ts reads the library through these, handed over here instead of imported there (its `from`: a ring of imports otherwise).
Object.assign(addons.from, { addonItems, skillKey, ownPlaceOf, laneOf, enabled, refreshSkills });
