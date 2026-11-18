// Pictures in an agent's answer (Sphe, Nov 4: "all of the agents have the
// ability to inline images… if I ask an agent, 'Hey, can you just include an
// image for me?'"). An agent writes Markdown, and a picture as Markdown:
// ![what it is](where it is). Where it is is the agent's own: a file on this
// Mac (the pictures it reads, a look it drew) or the id of a picture it works
// with. Each agent's chat turns those into addresses the page (and a teammate
// on another Mac) can load, before the answer is kept; one it can't place is
// left for the page to show as a named picture it couldn't load.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, join } from "node:path";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";

/** A picture written as Markdown: its words and where it is. */
const PICTURE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

/** Code in Markdown, fenced or inline (captured, so splitting on it keeps it, at the odd places). */
const CODE = /(```[\s\S]*?```|`[^`\n]+`)/;

/** The image files an agent may hand on: what a browser draws. */
export const PICTURE_FILE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * The answer with each picture's address made one the page can load: `place`
 * answers the address for what the agent wrote (null when it can't). Each
 * distinct source is placed once.
 */
export async function inlinePictures(text: string, place: (source: string) => Promise<string | null>): Promise<string> {
  // Code (fenced or inline) is shown as written: a picture's Markdown in it is an example, not a picture.
  const parts = text.split(CODE);
  const prose = parts.filter((_part, index) => index % 2 === 0).join("\n");
  const sources = new Set([...prose.matchAll(PICTURE)].map((match) => match[2]!));
  if (sources.size === 0) return text;
  const placed = new Map<string, string | null>();
  for (const source of sources) {
    let path = source;
    try {
      path = decodeURI(source);
    } catch {
      // As written.
    }
    placed.set(source, await place(path).catch(() => null));
  }
  return parts
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(PICTURE, (_whole, words: string, source: string) => {
            const address = placed.get(source);
            return address ? `![${words}](${address})` : `![${words}](unavailable:${encodeURIComponent(source.split("/").pop() ?? "picture")})`;
          }),
    )
    .join("");
}

/** A file the agent named that this Mac has and a browser can show, inside one of `roots`. */
export function pictureFile(path: string, roots: string[]): string | null {
  if (!path.startsWith("/") || !PICTURE_FILE.test(path)) return null;
  let real: string;
  try {
    real = fs.realpathSync(path);
  } catch {
    return null;
  }
  if (!roots.some((root) => real.startsWith(fs.existsSync(root) ? `${fs.realpathSync(root)}/` : `${root}/`))) return null;
  return fs.statSync(real).isFile() ? real : null;
}

// ---------------------------------------------------------------- Edit's chat

/**
 * Edit's chat (agent.ts) keeps the pictures its agent may show in the
 * project's own folder, by content: every picture a tool shows the agent
 * (a frame, a sheet, its graphic beside the reference) is kept there, its
 * file named under it, so "send me the frame at 1:32" or a frame with
 * something circled is one line of Markdown (Sphe, Nov 12: "it can't seem
 * to send us an image").
 */
export const CHAT_PICTURES = "chat-pictures";

const KEPT = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/;

/** The name a picture's bytes are kept under: its content's. */
const nameOf = (bytes: Uint8Array, extension: string): string => `${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}.${extension}`;

/** A picture's file extension from its type. */
export const extensionOf = (mimeType: string): string => (mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "png");

/** Keeps `bytes` in `folder` under its content's name (written once): the file. */
export function keepPicture(folder: string, bytes: Uint8Array, extension: string): string {
  const out = join(folder, nameOf(bytes, extension));
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(folder, { recursive: true });
  const partial = `${out}.${process.pid}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, out);
  return out;
}

/**
 * Where the pictures tools show an agent wait, in case its answer shows one:
 * the cache's, not the project's (every frame of a frame-by-frame look kept
 * in the project came to 440 MB in a day, Nov 13). An answer that shows one
 * keeps it in the project's `chat-pictures` (chatPictureAddress); the rest go
 * after `TOOL_PICTURES_KEPT_MS`, or sooner once there are more than
 * `TOOL_PICTURES_MAX_BYTES` of them (oldest first).
 */
export const TOOL_PICTURES = "tool-pictures";
const TOOL_PICTURES_KEPT_MS = 2 * 24 * 60 * 60_000;
const TOOL_PICTURES_MAX_BYTES = 2 * 1024 ** 3;
const PRUNE_EVERY_MS = 10 * 60_000;
let prunedAt = 0;

/** Clears out the tool pictures under `root` (every project's) that have waited long enough, at most every ten minutes. */
export function pruneToolPictures(root: string, now = Date.now()): void {
  if (now - prunedAt < PRUNE_EVERY_MS) return;
  prunedAt = now;
  const files: { path: string; at: number; bytes: number }[] = [];
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const project of projects) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const stat = fs.statSync(join(root, project, name));
        if (stat.isFile()) files.push({ path: join(root, project, name), at: stat.mtimeMs, bytes: stat.size });
      } catch {
        // Gone already.
      }
    }
  }
  files.sort((a, b) => b.at - a.at);
  let total = 0;
  for (const file of files) {
    total += file.bytes;
    if (now - file.at > TOOL_PICTURES_KEPT_MS || total > TOOL_PICTURES_MAX_BYTES) fs.rmSync(file.path, { force: true });
  }
}

/** Lets the next prune run at once (tests). */
export function resetPruning(): void {
  prunedAt = 0;
}

/** A kept picture's file in `folder`, by name: null for any other name. */
export function keptPicture(folder: string, name: string): string | null {
  if (!KEPT.test(name)) return null;
  const file = join(folder, name);
  return fs.existsSync(file) ? file : null;
}

/** The address of a picture `file` the agent named, kept in `folder` first: null when it isn't one inside `roots`. */
export function chatPictureAddress(project: string, folder: string, file: string, roots: string[]): string | null {
  const found = pictureFile(file, [folder, ...roots]);
  if (found === null) return null;
  const extension = (found.split(".").pop() ?? "png").toLowerCase().replace("jpeg", "jpg");
  const kept = fs.existsSync(folder) && found.startsWith(`${fs.realpathSync(folder)}/`) && KEPT.test(found.split("/").pop()!) ? found : keepPicture(folder, new Uint8Array(fs.readFileSync(found)), extension);
  void sharePicture(project, kept);
  return `/api/projects/${encodeURIComponent(project)}/chat-pictures/${kept.split("/").pop()}`;
}

// The chat itself goes to the cloud (chat_sync.ts), so its pictures go too: a
// project opened on another computer (or brought back to this one) showed its
// answers' pictures as broken (Sphe, Nov 18, the second time).

/** A kept picture's cloud key: its project's and its content's, so it's put once and never changes. */
export const pictureKey = (project: string, name: string): string => `edit/chat-pictures/${project}/${name}`;

/** Keys this server has seen in the cloud, or is putting there: each is looked up once. */
const shared = new Set<string>();

/** Puts a kept picture `file` of `project` in the cloud, unless it's there. Never throws: a failure is said, and the next keep or chat push tries again. */
export async function sharePicture(project: string, file: string): Promise<void> {
  if (!cloud.enabled() || !KEPT.test(basename(file))) return;
  const key = pictureKey(project, basename(file));
  if (shared.has(key)) return;
  shared.add(key);
  try {
    if (!(await cloud.has(key))) await cloud.uploadFile(file, key);
  } catch (error) {
    shared.delete(key);
    diag.warn("agent", `a chat picture to the cloud (${key}): ${diag.messageOf(error)}`);
  }
}

/** The names of `project`'s kept pictures shown in a chat's text (a project's id is letters, digits, `_` and `-`). */
export function picturesIn(project: string, text: string): string[] {
  if (!/^[\w-]+$/.test(project)) return [];
  const address = new RegExp(`/api/projects/${project}/chat-pictures/([0-9a-f]{16}\\.(?:png|jpg|webp|gif))`, "g");
  return [...new Set([...text.matchAll(address)].map((match) => match[1]!))];
}

const fetching = new Map<string, Promise<string | null>>();

/**
 * A kept picture another computer's chat showed, brought into `folder` from
 * the cloud: its file, or null when the cloud hasn't it either (or can't be
 * reached). Its bytes must match its name, since the page keeps it for good.
 */
export function fetchPicture(project: string, folder: string, name: string): Promise<string | null> {
  if (!KEPT.test(name) || !cloud.enabled()) return Promise.resolve(null);
  const key = pictureKey(project, name);
  const waiting = fetching.get(key);
  if (waiting !== undefined) return waiting;
  const work = (async () => {
    const dest = join(folder, name);
    try {
      if (!(await cloud.has(key))) return null;
      await cloud.download(key, dest);
      if (nameOf(new Uint8Array(fs.readFileSync(dest)), name.split(".").pop()!) !== name) {
        fs.rmSync(dest, { force: true });
        diag.warn("agent", `a chat picture from the cloud (${key}) isn't the one its name says`);
        return null;
      }
      shared.add(key);
      return dest;
    } catch (error) {
      diag.warn("agent", `a chat picture from the cloud (${key}): ${diag.messageOf(error)}`);
      return null;
    } finally {
      fetching.delete(key);
    }
  })();
  fetching.set(key, work);
  return work;
}
