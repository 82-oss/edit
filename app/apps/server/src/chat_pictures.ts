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
import { join } from "node:path";

/** A picture written as Markdown: its words and where it is. */
const PICTURE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

/** The image files an agent may hand on: what a browser draws. */
export const PICTURE_FILE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * The answer with each picture's address made one the page can load: `place`
 * answers the address for what the agent wrote (null when it can't). Each
 * distinct source is placed once.
 */
export async function inlinePictures(text: string, place: (source: string) => Promise<string | null>): Promise<string> {
  const sources = new Set([...text.matchAll(PICTURE)].map((match) => match[2]!));
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
  return text.replace(PICTURE, (_whole, words: string, source: string) => {
    const address = placed.get(source);
    return address ? `![${words}](${address})` : `![${words}](unavailable:${encodeURIComponent(source.split("/").pop() ?? "picture")})`;
  });
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

/** A picture's file extension from its type. */
export const extensionOf = (mimeType: string): string => (mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "png");

/** Keeps `bytes` in `folder` under its content's name (written once): the file. */
export function keepPicture(folder: string, bytes: Uint8Array, extension: string): string {
  const out = join(folder, `${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}.${extension}`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(folder, { recursive: true });
  const partial = `${out}.${process.pid}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, out);
  return out;
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
  return `/api/projects/${encodeURIComponent(project)}/chat-pictures/${kept.split("/").pop()}`;
}
