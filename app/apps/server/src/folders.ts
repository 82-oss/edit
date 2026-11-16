// The folders the picker browses on the machine running Edit (`/api/fs`), a new
// folder made where someone is (`/api/fs/folder`), and macOS's Files and Folders
// settings (`/api/fs/privacy`).
//
// A folder Edit may not open is its own answer, a 403 with `refused`, never an
// empty or missing folder: on a Mac, Desktop, Documents and Downloads are kept
// from an app until the person allows it (TCC answers EPERM), and the picker
// stays on the folder and says so.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { ApiError, bad, json, notFound } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";
import { ioMessage } from "./files.ts";
import { isMediaPath } from "./media.ts";
import { expandHome, extension, fileName, join, parent } from "./paths.ts";

type Context = RouteContext<App>;

/** Why a folder can't be opened: macOS's privacy settings keep it from Edit, or its permissions do. */
export type Refusal = "privacy" | "permission";

/** The refusal an error is, or null when it's something else. EPERM on a Mac is TCC's answer. */
export function refusal(error: unknown, platform: string = process.platform): Refusal | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EPERM") return platform === "darwin" ? "privacy" : "permission";
  if (code === "EACCES") return "permission";
  return null;
}

/** The places down the picker's side, in Finder's order, then Home. */
const PLACES = ["Desktop", "Documents", "Downloads", "Movies", "Videos", "Music", "Pictures"];

/** macOS's Files and Folders settings. */
const PRIVACY_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

function home(): string {
  return process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : "/";
}

function places(): { name: string; path: string }[] {
  const at = home();
  const found: { name: string; path: string }[] = [];
  for (const name of PLACES) {
    const path = join(at, name);
    try {
      // The folder itself, not what's in it: macOS lets anyone see Documents is there.
      if (fs.statSync(path).isDirectory()) found.push({ name, path });
    } catch {
      // Not on this machine.
    }
  }
  found.push({ name: "Home", path: at });
  return found;
}

function above(dir: string): string | null {
  const up = parent(dir);
  return up === "" ? null : up;
}

function refused(how: Refusal, dir: string): ApiError {
  const name = dir === home() ? "your home folder" : (fileName(dir) ?? dir);
  const message = how === "privacy" ? `macOS hasn't let Edit open ${name}` : `Edit isn't allowed to open ${name}`;
  return new RefusedError(message, how, dir);
}

/** A 403 that also carries where the picker is, so it can stay there. */
class RefusedError extends ApiError {
  constructor(
    message: string,
    readonly how: Refusal,
    readonly dir: string,
  ) {
    super(403, message);
  }

  override response(): Response {
    return Response.json({ error: this.message, refused: this.how, path: this.dir, parent: above(this.dir), places: places() }, { status: 403 });
  }
}

/** The real path of a folder that's there; refused or missing are their own answers. Async: a first look into Documents waits on macOS asking the person. */
async function realFolder(given: string): Promise<string> {
  try {
    return await fs.promises.realpath(given);
  } catch (error) {
    const how = refusal(error);
    if (how !== null) throw refused(how, given);
    throw notFound("folder not found");
  }
}

async function browse(context: Context): Promise<Response> {
  const asked = context.query.get("path");
  const dir = await realFolder(asked !== null && asked !== "" ? expandHome(asked) : home());
  // `ext=txt,md`: files with these extensions instead of media (Script mode's text sources).
  const wanted = context.query.get("ext")?.split(",").map((one) => one.trim().toLowerCase()).filter((one) => one !== "") ?? null;
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    const how = refusal(error);
    if (how !== null) throw refused(how, dir);
    throw bad(ioMessage(error));
  }
  const entries: { name: string; path: string; dir: boolean; size: number }[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    let meta: fs.Stats;
    try {
      meta = fs.statSync(path);
    } catch {
      continue;
    }
    const isDir = meta.isDirectory();
    if (!isDir && !(wanted === null ? isMediaPath(path) : wanted.includes((extension(path) ?? "").toLowerCase()))) continue;
    entries.push({ name, path, dir: isDir, size: meta.size });
  }
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return json({ entries, parent: above(dir), path: dir, places: places() });
}

/** Why `name` can't be a folder's name, or null when it can. */
export function badFolderName(name: string): string | null {
  if (name === "") return "Name the folder first";
  if (name.startsWith(".")) return "A folder's name can't start with a dot";
  if (/[/:]/.test(name)) return "A folder's name can't have / or : in it";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "That name has characters a folder can't have";
  if (Buffer.byteLength(name, "utf8") > 255) return "That name is too long";
  return null;
}

/** A new folder `name` in `path`, inside this person's home. Its real path. */
async function newFolder(context: Context): Promise<Response> {
  const body = await readJson<{ path?: unknown; name?: unknown }>(context);
  if (typeof body.path !== "string" || typeof body.name !== "string") throw bad("path and name are required");
  const name = body.name.normalize("NFC").trim();
  const why = badFolderName(name);
  if (why !== null) throw bad(why);
  const where = await realFolder(expandHome(body.path));
  const mine = await realFolder(home());
  if (where !== mine && !where.startsWith(mine === "/" ? "/" : `${mine}/`)) throw bad("New folders go inside your home folder");
  const path = join(where, name);
  try {
    await fs.promises.mkdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const folder = fs.statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
      throw new ApiError(409, `There's already ${folder ? "a folder" : "a file"} called “${name}” here`);
    }
    const how = refusal(error);
    if (how !== null) throw refused(how, where);
    throw bad(ioMessage(error));
  }
  return json({ path: await fs.promises.realpath(path) });
}

async function privacySettings(): Promise<Response> {
  if (process.platform !== "darwin") throw bad("Only a Mac has these settings");
  const opened = await Bun.spawn(["open", PRIVACY_SETTINGS], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
  if (opened !== 0) throw bad("macOS didn't open its settings. Open System Settings → Privacy & Security → Files and Folders");
  return json({ ok: true });
}

export function routes(router: Router<App>): void {
  router.get("/api/fs", browse).post("/api/fs/folder", newFolder).post("/api/fs/privacy", privacySettings);
}
