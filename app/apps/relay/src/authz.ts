/**
 * Who may do what in Edit's cloud. The audit (Oct 23): any signed-in account,
 * a subtitler's or a stolen hour-long token, could call any `edit:` function
 * (`deleteProject`, a forced `acquireLock`) and read, write, list or delete
 * any key under `edit/`. Now:
 *
 * - only the `edit:` functions Edit calls, each as its kind;
 * - a project outside the person's kinds of video is neither read nor
 *   changed (the same rule as Edit's own, apps/server/src/kinds.ts, so a
 *   token alone can't get round it), judged by the summary its commits keep;
 * - a project is deleted only by who started it, or an admin;
 * - keys are written only where Edit writes them, deleted and listed beyond
 *   the analysis only by an admin, and a project's own keys (its reviews and
 *   cover) follow the project's kind.
 *
 * Footage keys are named by their content (a Drive file, a hash), shared by
 * every project that uses them, so they can't be tied to one project.
 */
import type { Style } from "@edit/types";

import type { Caller } from "./auth";

/** What the kinds rule needs of a project. */
export interface Shape {
  style: string;
  subtitles: boolean;
  footageOnly: boolean;
  /** The channel it's for (Edit V2), when it is one's. */
  channel?: string | null;
}

/** The capabilities a caller has; null for everything (an admin). A token with none has none: `use` alone opens nothing (Oct 29: the fallback for tokens from before the kinds went, so `use` can't give Script mode's work too). */
export function grantedTo(found: Caller): Set<string> | null {
  if (found.kind !== "person" || found.admin) return null;
  return new Set(found.perms);
}

export const isAdmin = (found: Caller) => found.kind === "person" && found.admin;

/** Edit's styles (@edit/types `Style`). Nov 5: only interrogation and courtroom were read, so a commentary, horror or Shorts project counted as bodycam: hidden from someone given only its kind, open to a bodycam editor. */
const STYLES = new Set<string>(["bodycam", "interrogation", "courtroom", "commentary", "horror", "shorts"] satisfies Style[]);

/** A project's shape from its Convex summary (none: an edit in the default style), as Edit's `cloudShape`. */
export function shapeOf(summary: unknown): Shape {
  const field = (name: string) => (typeof summary === "object" && summary !== null ? (summary as Record<string, unknown>)[name] : undefined);
  const style = field("style");
  return {
    style: typeof style === "string" && STYLES.has(style) ? style : "bodycam",
    subtitles: field("subtitles") === true,
    footageOnly: field("footageOnly") === true,
    channel: typeof field("channel") === "string" ? (field("channel") as string) : null,
  };
}

/** Whether work names a channel (Edit V2's); null, undefined and "" are no channel's (V1), as Edit's kinds.ts `onChannel`. */
export const onChannel = (channel: unknown): channel is string => typeof channel === "string" && channel !== "";

/** Whether `perms` hold this channel, in full or by its label (kinds.ts `mayChannel`, channels.ts in mamagi). */
export const holdsChannel = (perms: Iterable<string>, channel: string): boolean => {
  for (const perm of perms) if (perm === `channel.${channel}` || perm === `channel.${channel}.label`) return true;
  return false;
};

/** Whether `perms` hold any channel, in full or by its label: each is work of its own, whatever kinds they hold (kinds.ts `anyChannel`). */
export const holdsAnyChannel = (perms: Iterable<string>): boolean => {
  for (const perm of perms) if (perm.startsWith("channel.")) return true;
  return false;
};

/**
 * Whether someone with `given` may see and change a project of this shape
 * (kinds.ts `mayWork`). A channel's is the channel's alone (Sphe, Nov 21: "a
 * channel I've given a person access to should be all they need"), in full or
 * by its label, a subtitled one too: it had needed `edit.<style>` beside the
 * channel, so Edit let someone holding only the channel make its edit and this
 * refused every save of it. Work of no channel keeps the kinds rule exactly.
 */
export function mayWork(shape: Shape, given: Set<string> | null): boolean {
  if (given === null) return true;
  if (onChannel(shape.channel)) return holdsChannel(given, shape.channel);
  if (!shape.subtitles && given.has(`edit.${shape.style}`)) return true;
  return given.has("video.subtitles") && (shape.subtitles || shape.footageOnly);
}

export const UNAVAILABLE = "This project isn't available to your account: an admin can give you its kind of video at accounts.spheceo.com.";

/** The `edit:` functions Edit calls, each as its kind. */
export const EDIT_CALLS = new Map<string, string>([
  ["edit:listProjects", "query"], ["edit:getProject", "query"], ["edit:uploadUrl", "mutation"], ["edit:commitProject", "mutation"],
  ["edit:deleteProject", "mutation"], ["edit:acquireLock", "mutation"], ["edit:renewLock", "mutation"], ["edit:releaseLock", "mutation"],
  ["edit:clearRestore", "mutation"], ["edit:getMedia", "query"], ["edit:listMedia", "query"], ["edit:putMedia", "mutation"],
  // Home's Later: what someone set aside, the team's (who set it aside comes from the token).
  ["edit:listLater", "query"], ["edit:setLater", "mutation"], ["edit:clearLater", "mutation"],
  // Home's New and Changed: when each person last opened an edit, a script or an idea (whose marks they are comes from the token).
  ["edit:listSeen", "query"], ["edit:markSeen", "mutation"],
  // The lessons inbox: the team's lasting feedback, noted by the agents, closed by a teaching round (who comes from the token).
  ["edit:listLessons", "query"], ["edit:noteLesson", "mutation"], ["edit:closeLesson", "mutation"],
  // The team's own notes on an edit, left in Edit at the playhead for the agent (who left one comes from the token).
  ["edit:listNotes", "query"], ["edit:addNote", "mutation"], ["edit:editNote", "mutation"], ["edit:removeNote", "mutation"],
  ["edit:sendNotes", "mutation"], ["edit:resolveNote", "mutation"],
  // Edit V2's cloud (the library): a project's coded effects, the templates and the agent's skills, each a list of
  // versions with one in use (who saved one comes from the token; mamagi refuses a project's to who can't open it,
  // and a template's or a skill's to who isn't a teacher).
  ["edit:listLibrary", "query"], ["edit:libraryVersions", "query"], ["edit:libraryVersion", "query"],
  ["edit:saveLibraryVersion", "mutation"], ["edit:setLibraryCurrent", "mutation"], ["edit:archiveLibrary", "mutation"],
  // Channels (mamagi's channels.ts): the team's YouTube channels and their lanes (who changed one comes from the token;
  // mamagi refuses a change to anyone but a teacher).
  ["channels:listChannels", "query"], ["channels:getChannel", "query"],
  ["channels:saveChannel", "mutation"], ["channels:setChannel", "mutation"], ["channels:archiveChannel", "mutation"],
  // A placeholder (a channel not on YouTube yet), and linking it to its YouTube channel once it's made.
  ["channels:addPlaceholder", "mutation"], ["channels:linkChannel", "mutation"],
  // Channel groups (mamagi's groups.ts): channels sharing one style, taught once (a teacher's to change).
  ["groups:listGroups", "query"], ["groups:makeGroup", "mutation"], ["groups:setGroup", "mutation"], ["groups:addChannel", "mutation"],
  ["groups:removeChannel", "mutation"], ["groups:archiveGroup", "mutation"], ["groups:moveIntoGroup", "mutation"],
]);

/** Calls that change a project, or read its notes (refused outside the caller's kinds). */
export const PROJECT_WRITES = new Set([
  "edit:commitProject", "edit:deleteProject", "edit:acquireLock", "edit:clearRestore",
  // A project's notes, read or written, are its own: only for who may work on it.
  "edit:listNotes", "edit:addNote", "edit:editNote", "edit:removeNote", "edit:sendNotes", "edit:resolveNote",
]);

/**
 * Problem reports sent from Edit's Report a problem (the error, the log, how
 * long things took): anyone signed in writes one, only an admin reads or
 * lists them (they hold another person's log).
 */
export const REPORTS = "edit/reports/";

/** Why `found` may not read `key` when it's a problem report (null: they may). */
export function reportRefused(found: Caller, key: string): string | null {
  return key.startsWith(REPORTS) && !isAdmin(found) ? "Only an admin reads problem reports." : null;
}

/** An idea's pictures (ideas/images.ts): read and written only by someone who works on ideas. */
export const IDEAS = "edit/ideas/";

/** A thumbnail's pictures and the team's overlays (Nov 2): the same people as ideas, the repackagers. */
export const THUMBNAILS = "edit/thumbnails/";

/**
 * Why `found` may not touch `key` when it's an idea's or a thumbnail's picture
 * (null: they may). Who works on ideas at all: an `ideas.*` capability, or a
 * channel given to them, whose ideas and thumbnails are theirs with it (Sphe,
 * Nov 21; Edit's ideas/routes.ts `mayIdeas`). A picture's key names its idea
 * or thumbnail, not a channel or a workspace, so it's judged as `ideas.*`
 * always was: by working on ideas at all, not by whose idea it is.
 */
export function ideaRefused(found: Caller, key: string): string | null {
  if ((!key.startsWith(IDEAS) && !key.startsWith(THUMBNAILS)) || found.kind !== "person" || found.admin || found.perms.some((perm) => perm.startsWith("ideas.")) || holdsAnyChannel(found.perms)) return null;
  return "Your account can't work on ideas yet: an admin can give you Interrogation ideas at accounts.spheceo.com.";
}

/**
 * A channel's own files (Nov 16: its watermark, uploaded on its page, at
 * `edit/channels/<key>/watermark/<sha256>.<ext>`): read by who sees the
 * channel in full, written by a teacher who does (mamagi's channels.ts rules:
 * someone given only its label never sees its logo, which says whose it is).
 */
export const CHANNELS = "edit/channels/";

/** Why `found` may not touch `key` when it's a channel's file (null: they may). */
export function channelRefused(found: Caller, op: "read" | "write", key: string): string | null {
  if (!key.startsWith(CHANNELS) || isAdmin(found)) return null;
  const channel = /^edit\/channels\/([a-z0-9][a-z0-9-]{0,39})\//.exec(key)?.[1];
  if (channel === undefined) return "That isn't a channel's file.";
  const perms = found.kind === "person" ? found.perms : [];
  if (!perms.includes(`channel.${channel}`) || perms.includes(`channel.${channel}.label`)) return "That channel isn't shown to your account in full: an admin can give it to you at accounts.spheceo.com.";
  if (op === "write" && !perms.includes("agent.teach")) return "Only a teacher changes a channel's watermark: an admin can make you one at accounts.spheceo.com.";
  return null;
}

/** Where Edit writes in R2 (cloud_media.ts, reviews.ts, reports, ideas). */
export const WRITABLE = [
  "edit/originals/", "edit/proxies/", "edit/excerpts/", "edit/analysis/", "edit/sound/",
  // A long video's proxy in pieces (proxy_pieces.ts): its layout, head and each piece's picture and sound.
  "edit/pieces/",
  // A project's chat (chat_sync.ts), its finished exports (exports.ts), scrub strips (cloud_media.ts) and
  // research (research_cloud.ts). Only admins could write them before Nov 4, so a teammate's never went up.
  "edit/chats/", "edit/exports/", "edit/scrub/", "edit/research/",
  // A project's teaching draft (teaching_draft.ts): what its agent may be asked to teach later, kept as its chat is.
  "edit/drafts/",
  "edit/reviews/",
  // A long recording to be heard by link (transcribe_jobs.ts); the relay deletes it once heard.
  "edit/transcribe/",
  // Edit V2's cloud: the library's files (effects' and templates'), each by its content (library.ts).
  "edit/library/",
  // Footage with a re-uploader's text taken out (text_removal.ts), by file and seconds: never paid for twice.
  "edit/cleaned/",
  // An agent chat's pictures (chat_pictures.ts), by project and content, so another computer shows them.
  "edit/chat-pictures/",
  REPORTS, IDEAS, THUMBNAILS, CHANNELS,
];

/** What a non-admin may list: the analysis beside a source (cloud_media's fetchAnalysisOf). */
export const LISTABLE = "edit/analysis/";

/**
 * The project a key belongs to: its review's files, its cover, its chat, its
 * exports and smooth-playback renders, its research. Null for shared keys
 * (footage, named by what it holds). Nov 4 (Sphe: "if we've given someone X
 * permissions, their account literally cannot access anything else"): a
 * project's chat, exports and research were readable by anyone signed in who
 * knew its id.
 */
export function projectOfKey(key: string): string | null {
  const patterns = [
    /^edit\/reviews\/([^/]+)\//,
    // Home's old card covers: Edit no longer writes them, but those still in R2 stay its project's.
    /^edit\/covers\/([^/]+)\.jpg$/,
    /^edit\/chats\/([^/]+)\.json$/,
    /^edit\/chat-pictures\/([^/]+)\//,
    /^edit\/exports\/playback\/([^/]+)\//,
    /^edit\/exports\/(?!playback\/)([^/]+)\//,
    /^edit\/research\/projects\/([^/]+)\//,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(key)?.[1];
    if (found !== undefined) return found;
  }
  return null;
}

const HOUR = 3600;
/** Presigned URLs last at most an hour; a GET of footage up to 6 h (FFmpeg reads an original through one URL for a whole excerpt or export). */
export const MAX_EXPIRES = HOUR;
export const MAX_FOOTAGE_GET = 6 * HOUR;
const FOOTAGE = /^edit\/(originals|proxies|excerpts|sound)\//;

export function maxExpires(method: string, key: string): number {
  return method === "GET" && FOOTAGE.test(key) ? MAX_FOOTAGE_GET : MAX_EXPIRES;
}
