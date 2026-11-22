// What of an effect's folder goes into the library when it's kept (Nov 21,
// setting up Shorts on dev: save_to_library kept the whole folder, so
// v1-shorts-blur-bars carried five reference pictures and a 14 MB
// footage.mp4, and v1-windows-desktop 55 MB of one video's footage). Kept:
// what its page draws from, found by following what it names, from its
// scene.html (or sound.html) through every page, script and style it loads;
// a whole folder it names ("img/" + n) comes whole, so a name the code builds
// is kept too. Left out: whatever nothing names (the agent's references, its
// tests), and footage handed to it from this project with effect_footage,
// which is that video's and is given again wherever it's used (`.given.json`
// says what it was). The agent can name more to keep (`also`).

import * as fs from "node:fs";
import { basename, dirname, join, posix } from "node:path";

import { writeAtomic } from "./files.ts";

/** What effect_footage handed an effect: each file by its path in the folder, and what it was cut from. */
export const GIVEN = ".given.json";

export type Given = Record<string, { media: string; start: number; end: number }>;

/** The files a page reads as text, followed for the names in them. */
const TEXT = /\.(html?|m?js|css|json|svg|txt)$/iu;

/** Every file of `dir`, however deep, by its path inside it (sorted). */
function filesOf(dir: string, under = ""): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(join(dir, under), { withFileTypes: true })) {
    const inside = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesOf(dir, inside));
    else if (entry.isFile()) found.push(inside);
  }
  return found.sort();
}

/** What effect_footage handed the effect in `dir` (empty when nothing, or unreadable). */
export function given(dir: string): Given {
  try {
    const read = JSON.parse(fs.readFileSync(join(dir, GIVEN), "utf8")) as unknown;
    return typeof read === "object" && read !== null && !Array.isArray(read) ? (read as Given) : {};
  } catch {
    return {};
  }
}

/** Notes footage handed to the effect in `dir` (its files, and what they were cut from). */
export function noteGiven(dir: string, files: (string | null)[], from: { media: string; start: number; end: number }): void {
  const now = given(dir);
  for (const file of files) if (file !== null) now[file] = from;
  writeAtomic(join(dir, GIVEN), JSON.stringify(now, null, 1));
}

/** Whether `text` names `path` (a file of the folder), as written or as a URL would. */
function names(text: string, path: string): boolean {
  const name = basename(path);
  if (text.includes(name) || text.includes(encodeURI(name)) || text.includes(path)) return true;
  // A folder it names ("img/" + n, `frames/${i}.png`): everything in it may be read.
  const folder = dirname(path);
  return folder !== "." && text.includes(`${folder}/`);
}

/**
 * The files of `dir` the page at `entry` draws from: `entry`, every file a
 * page, script or style it reaches names, and Edit's own marks (dot files,
 * such as what's beneath it was made from). Footage given from this project
 * is left out unless `also` names it; `also` adds any file that's there.
 */
export function needed(dir: string, entry: string, also: readonly string[] = []): { keep: string[]; left: { path: string; size: number }[] } {
  const all = filesOf(dir);
  const handed = new Set(Object.keys(given(dir)));
  const keep = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (!TEXT.test(at)) continue;
    let text: string;
    try {
      text = fs.readFileSync(join(dir, at), "utf8");
    } catch {
      continue;
    }
    for (const path of all) {
      if (keep.has(path) || handed.has(path) || !names(text, path)) continue;
      keep.add(path);
      queue.push(path);
    }
  }
  for (const path of all) if (basename(path).startsWith(".") && !path.includes("/")) keep.add(path);
  for (const one of also) {
    const path = posix.normalize(one.replace(/^\.\//u, ""));
    if (!all.includes(path)) throw new Error(`there's no ${one} in the effect's folder (also names its files as they are inside it, such as img/top.png)`);
    keep.add(path);
  }
  const left = all.filter((path) => !keep.has(path)).map((path) => ({ path, size: fs.statSync(join(dir, path)).size }));
  return { keep: all.filter((path) => keep.has(path)), left };
}

/** Bytes, said short (14 MB, 820 KB). */
export function sizeText(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/**
 * Takes `paths` out of the effect's folder `dir` (the agent's references and
 * tests it no longer needs). Its page stays: it's the effect. Answers what
 * went, with its size.
 */
export function remove(dir: string, entry: string, paths: readonly string[]): { path: string; size: number }[] {
  const all = new Set(filesOf(dir));
  const gone: { path: string; size: number }[] = [];
  for (const one of paths) {
    const path = posix.normalize(one.replace(/^\.\//u, ""));
    if (path === entry) throw new Error(`${entry} is the effect itself: it stays (archive_in_library puts a kept one away)`);
    if (!all.has(path)) throw new Error(`there's no ${one} in the effect's folder: nothing was taken out`);
  }
  const handed = given(dir);
  for (const one of paths) {
    const path = posix.normalize(one.replace(/^\.\//u, ""));
    const size = fs.statSync(join(dir, path)).size;
    fs.rmSync(join(dir, path));
    gone.push({ path, size });
    delete handed[path];
  }
  if (Object.keys(handed).length === 0) fs.rmSync(join(dir, GIVEN), { force: true });
  else writeAtomic(join(dir, GIVEN), JSON.stringify(handed, null, 1));
  return gone;
}
