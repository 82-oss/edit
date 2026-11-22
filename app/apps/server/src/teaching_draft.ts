// A project's teaching draft (Sphe, Nov 22: "a sort of lessons or effects
// draft that the agent puts together that we don't really see… Once we say,
// 'Okay, just take everything that we've talked about today and teach that,'
// it can just pull those exact lessons verbatim and move them over"). What
// could become a channel's teaching but isn't said to hold yet: lessons in
// their final words with the lane each belongs to, and effects built here not
// yet in the library. The agent adds to it as it works (draft_teaching), is
// shown it with each of the person's messages (media_tools.ts
// messageContext), and moves it into the channel through the same tools a
// kept lesson and a kept effect take (teach_drafted) when told to. Nothing of
// it is on screen. Kept beside the project's chat (`<id>.draft.json`), so a
// long conversation compacted, a restart, or another computer opening the
// project keeps it: it goes to the cloud as the chat does (chat_sync.ts) and
// comes down with the project, the newer one winning.

import * as fs from "node:fs";

import * as cloud from "./cloud.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";
import { validId, type Store } from "./store.ts";

/** A lane a lesson can be drafted for. */
export const LANES = ["edit", "script", "ideas", "thumbnails"] as const;
export type Lane = (typeof LANES)[number];

export interface Lesson {
  /** Its name, as it'll be kept (lower-case words with hyphens). */
  name: string;
  lane: Lane;
  /** Its words, exactly as they'll be kept. */
  text: string;
  /** For a longer part read when needed: when to read it. */
  note?: string;
  /** In a grouped channel: the group's (default) or this channel's alone. */
  for?: "group" | "channel";
  /** What the person said, in their words: the reason it's kept with. */
  said: string;
  at: number;
  /** The agent asked whether to keep it (never asked again). */
  asked?: boolean;
}

export interface Effect {
  /** Its folder here (effects/<name>/). */
  name: string;
  kind: "effect" | "sound";
  /** Its name in the library, when not the folder's. */
  as?: string;
  category: string;
  note: string;
  brief: string;
  for?: "group" | "channel";
  said: string;
  at: number;
  asked?: boolean;
}

export interface Draft {
  savedAt: number;
  lessons: Lesson[];
  effects: Effect[];
}

/** At most this many of each: a day's work, not a dump. */
export const LESSONS_MOST = 40;
export const EFFECTS_MOST = 20;

export const pathOf = (store: Store, project: string): string => join(store.home, "projects", `${project}.draft.json`);
export const draftKey = (project: string): string => `edit/drafts/${project}.json`;

const empty = (): Draft => ({ savedAt: 0, lessons: [], effects: [] });

/** The project's draft (empty when it has none, or it can't be read). */
export function read(store: Store, project: string): Draft {
  try {
    const given = JSON.parse(fs.readFileSync(pathOf(store, project), "utf8")) as Partial<Draft>;
    return { savedAt: typeof given.savedAt === "number" ? given.savedAt : 0, lessons: Array.isArray(given.lessons) ? given.lessons : [], effects: Array.isArray(given.effects) ? given.effects : [] };
  } catch {
    return empty();
  }
}

/** Saves the project's draft (gone when empty), and sends it to the cloud shortly. */
export function write(store: Store, project: string, draft: Draft): void {
  const path = pathOf(store, project);
  writeAtomic(path, JSON.stringify({ ...draft, savedAt: Math.max(Date.now(), draft.savedAt + 1) }, null, 1));
  schedulePush(store, project);
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Uploads the draft once its saves settle (as the chat is, chat_sync.ts). */
function schedulePush(store: Store, project: string): void {
  if (!cloud.enabled() || !validId(project)) return;
  clearTimeout(pending.get(project));
  pending.set(
    project,
    setTimeout(() => {
      pending.delete(project);
      const path = pathOf(store, project);
      if (!fs.existsSync(path)) return;
      void cloud.uploadFile(path, draftKey(project)).catch(() => {
        // Offline or signed out: the next save tries again.
      });
    }, 1500),
  );
}

/** Takes the cloud's draft for a project brought here when it's newer than this computer's. */
export async function pull(store: Store, project: string): Promise<boolean> {
  if (!cloud.enabled() || !validId(project)) return false;
  const dest = pathOf(store, project);
  const temp = `${dest}.cloud`;
  try {
    await cloud.download(draftKey(project), temp);
    const theirs = JSON.parse(fs.readFileSync(temp, "utf8")) as Partial<Draft>;
    if ((theirs.savedAt ?? 0) <= read(store, project).savedAt) return false;
    fs.renameSync(temp, dest);
    return true;
  } catch {
    // None in the cloud (most projects), or unreadable: this computer's stays.
    return false;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** A line of the draft's text, short. */
const short = (text: string, most = 140) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= most ? line : `${line.slice(0, most)}… (${text.length} characters)`;
};

/**
 * The draft as the agent is shown it with each of the person's messages,
 * compact: each lesson's name, lane and opening words, each effect's folder
 * and library name; "" when it's empty.
 */
export function context(draft: Draft): string {
  if (draft.lessons.length === 0 && draft.effects.length === 0) return "";
  const lessons = draft.lessons.map((one) => `- lesson ${one.name} [${one.lane}${one.for === "channel" ? ", this channel only" : ""}${one.asked === true ? "; asked" : ""}]: ${short(one.text)}`);
  const effects = draft.effects.map((one) => `- ${one.kind} ${one.name}${one.as !== undefined && one.as !== one.name ? ` (kept as ${one.as})` : ""} [${one.category}${one.asked === true ? "; asked" : ""}]: ${short(one.note, 100)}`);
  return `(Edit, automatically) YOUR TEACHING DRAFT, unseen by the person (draft_teaching changes it, teach_drafted keeps it):\n${[...lessons, ...effects].join("\n")}`;
}
