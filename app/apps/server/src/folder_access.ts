// Folders the system may ask the person about before Edit reads them, looked
// at first off the event loop (kenobi, Nov 17: Edit's cache on a removable
// drive; macOS asked "Edit would like to access files on a removable volume",
// and the server sat in a synchronous mkdir, answering nothing, until it was
// quit). macOS's privacy prompts (TCC) hold the calling thread inside the
// system call until the person answers, and the server's sync file calls run
// on its one event loop. A hung network volume holds it the same way.
//
// So each place that may ask (`rootOf`) is first looked at with fs.promises,
// which Bun runs on its own threads, once, and its answer remembered: granted,
// refused (EPERM: macOS doesn't ask again, and a sync call then fails at
// once) or gone (not mounted: asked again after a while, in case it comes
// back). Until a place has answered, the routes and jobs that would touch it
// wait for it asynchronously (`beforeRoute`, `reach`), every other request
// keeps being answered, and a route that has waited `ROUTE_WAIT_MS` answers
// "Waiting for macOS: allow Edit to use “Drive”." with a Retry-After. The
// places asked about now are an `access` event for the page.
//
// The data folder's own places (its cache or media folder a link to another
// drive) are held at start by serve.ts: the server listens, and everything
// that reads them starts once they've answered.

import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as diag from "./diag.ts";
import { ApiError } from "./http/errors.ts";
import type { Project } from "./model.ts";

/** How a place is looked at first, and where "home" is: replaceable in tests. */
export const hooks = {
  /** Lists the place: what makes macOS ask, on a thread of its own (never the event loop). */
  probe: async (root: string): Promise<void> => {
    await fs.promises.readdir(root);
  },
  platform: process.platform as string,
  home: (): string => process.env.HOME ?? "",
};

/** How long a route waits for an answer before it says what it's waiting for. */
export const ROUTE_WAIT_MS = { value: 20_000 };
/** A place that wasn't there is looked at again after this (a drive plugged back in). */
const GONE_MS = 30_000;
/** A question open this long is said to the page (shorter ones are a first look's few milliseconds). */
export const SHOWN_AFTER_MS = { value: 1_000 };

type State = "granted" | "refused" | "gone";

const answers = new Map<string, { state: State; at: number }>();
const asking = new Map<string, { since: number; done: Promise<void> }>();
const listeners = new Set<(waiting: Waiting[]) => void>();
/** The data folder's places (serve.ts): every route but the few in OPEN waits for them. */
let dataRoots: string[] = [];
/** The start's own hold: the work that reads the data folder, started once its places answered. */
let held: Promise<void> | null = null;

/** Home folders macOS keeps from an app until the person allows it. */
const PROTECTED_HOME = ["Desktop", "Documents", "Downloads", "Library/Mobile Documents"];

/**
 * The place that may ask before `path` is read: on a Mac, a volume
 * (`/Volumes/<name>`, removable, network or another disk), a network mount
 * (`/Network/…`, `/net/…`), Desktop, Documents, Downloads, iCloud Drive or a
 * cloud provider's folder (`~/Library/CloudStorage/<provider>`); on Linux a
 * mounted drive (`/media/…`, `/run/media/…`, `/mnt/<name>`), which asks
 * nothing but may hang the same way when it's a network mount. Null: nothing
 * to ask (Edit's data folder, the system's own folders). Read from the path
 * alone, touching nothing.
 */
export function rootOf(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts = nodePath.posix.normalize(path).split("/").filter((part) => part !== "");
  const top = (count: number) => (parts.length >= count ? `/${parts.slice(0, count).join("/")}` : null);
  if (hooks.platform === "darwin") {
    if (parts[0] === "Volumes" || parts[0] === "Network" || parts[0] === "net") return top(2);
    const home = hooks.home().replace(/\/+$/, "");
    if (home === "" || home === "/") return null;
    const inHome = path === home ? "" : path.startsWith(`${home}/`) ? nodePath.posix.normalize(path.slice(home.length + 1)) : null;
    if (inHome === null || inHome === "") return null;
    for (const folder of PROTECTED_HOME) {
      if (inHome === folder || inHome.startsWith(`${folder}/`)) return `${home}/${folder}`;
    }
    const cloud = /^Library\/CloudStorage\/([^/]+)/.exec(inHome);
    return cloud === null ? null : `${home}/Library/CloudStorage/${cloud[1]}`;
  }
  if (hooks.platform === "linux") {
    if (parts[0] === "media") return top(3) ?? top(2);
    if (parts[0] === "run" && parts[1] === "media") return top(4) ?? top(3);
    if (parts[0] === "mnt") return top(2);
  }
  return null;
}

/**
 * Where `path` really is, its links followed without touching a place that
 * may ask (Edit's cache made a link to a folder on a drive: `~/.edit/cache` →
 * `/Volumes/Drive/edit-cache`). Each folder above it is looked at only until
 * one is such a place; the rest is taken as written.
 */
export function placeOf(path: string): string {
  let rest = nodePath.posix.normalize(path).split("/").filter((part) => part !== "");
  if (!path.startsWith("/")) return path;
  let at = "/";
  for (let hops = 0; rest.length > 0 && hops < 40; ) {
    const next = nodePath.posix.join(at, rest[0]!);
    if (rootOf(next) !== null) return nodePath.posix.join(next, ...rest.slice(1));
    let link: string | null = null;
    try {
      if (fs.lstatSync(next).isSymbolicLink()) link = fs.readlinkSync(next);
    } catch {
      // Not there (yet): the rest as written.
      return nodePath.posix.join(next, ...rest.slice(1));
    }
    if (link === null) {
      at = next;
      rest = rest.slice(1);
      continue;
    }
    hops += 1;
    const target = nodePath.posix.resolve(at, link);
    rest = [...target.split("/").filter((part) => part !== ""), ...rest.slice(1)];
    at = "/";
  }
  return nodePath.posix.join(at, ...rest);
}

function answered(root: string): boolean {
  const answer = answers.get(root);
  if (answer === undefined) return false;
  if (answer.state === "gone" && Date.now() - answer.at > GONE_MS) return false;
  return true;
}

/** Whether a sync call on `path` can't wait on the system's question: nothing to ask, or asked and answered. From the path alone. */
export function ready(path: string): boolean {
  const root = rootOf(path);
  return root === null || answered(root);
}

/** How a place answered, or null while it hasn't (or nothing asks for it). */
export function stateOf(path: string): State | null {
  const root = rootOf(path);
  return root === null ? null : answered(root) ? answers.get(root)!.state : null;
}

/** A place being asked about, for the page and the log. */
export interface Waiting {
  /** The place: `/Volumes/Drive`, `~/Desktop`'s full path. */
  root: string;
  /** Its name as Finder shows it: "Drive", "Desktop". */
  name: string;
  since: number;
}

/** The places asked about for a second or more. */
export function waiting(now = Date.now()): Waiting[] {
  return [...asking]
    .filter(([, open]) => now - open.since >= SHOWN_AFTER_MS.value)
    .map(([root, open]) => ({ root, name: nodePath.posix.basename(root), since: open.since }));
}

/** Told the places asked about whenever that changes (serve.ts sends it to the page as an `access` event). */
export function onChange(listener: (waiting: Waiting[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  const now = waiting();
  for (const listener of listeners) {
    try {
      listener(now);
    } catch (error) {
      diag.warn("access", diag.messageOf(error));
    }
  }
}

function ask(root: string): Promise<void> {
  const open = asking.get(root);
  if (open !== undefined) return open.done;
  const since = Date.now();
  // Shown once it has taken a second: a granted place answers in milliseconds.
  const shown = setTimeout(() => {
    if (asking.has(root)) {
      diag.info("access", `waiting for the system to let Edit use ${root} (macOS may be asking)`);
      changed();
    }
  }, SHOWN_AFTER_MS.value);
  shown.unref?.();
  const done = (async () => {
    let state: State = "granted";
    try {
      await hooks.probe(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // Refused stays refused (macOS doesn't ask again: sync calls fail at once); gone is asked again later.
      state = code === "EPERM" || code === "EACCES" ? "refused" : code === "ENOENT" ? "gone" : "granted";
    }
    answers.set(root, { state, at: Date.now() });
    asking.delete(root);
    clearTimeout(shown);
    const took = Date.now() - since;
    if (took >= SHOWN_AFTER_MS.value || state !== "granted") diag.info("access", `${root}: ${state === "granted" ? "may be used" : state === "refused" ? "refused (System Settings › Privacy & Security › Files & Folders)" : "not there"}${took >= SHOWN_AFTER_MS.value ? ` after ${(took / 1000).toFixed(1)} s` : ""}`);
    if (took >= SHOWN_AFTER_MS.value) changed();
  })();
  asking.set(root, { since, done });
  return done;
}

/** Resolves once every place in `roots` has answered (asking each that hasn't, once). */
export function reachRoots(roots: Iterable<string>): Promise<void> {
  const open = [...new Set(roots)].filter((root) => !answered(root));
  return open.length === 0 ? Promise.resolve() : Promise.all(open.map(ask)).then(() => undefined);
}

/**
 * `reachRoots`, but given up on after `ms`: true when every place answered in time. A dead network mount or a
 * question nobody answers must not hold what waits on it for good (Nov 20: every resume and wake of the run sat
 * behind one); places that answer later are fine, and work there waits for them by itself (`reach`).
 */
export async function reachRootsWithin(roots: Iterable<string>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([reachRoots(roots).then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The places `paths` are in (their links followed) that haven't answered. */
export function unanswered(paths: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const root = rootOf(path) ?? rootOf(placeOf(path));
    if (root !== null && !answered(root)) roots.add(root);
  }
  return [...roots];
}

/** Resolves once the places `paths` are in (their links followed) have answered: await before sync work on them. */
export function reach(paths: Iterable<string>): Promise<void> {
  return reachRoots(unanswered(paths));
}

/** "Waiting for macOS: allow Edit to use “Drive”." for the places in `roots`. */
export function waitingLine(roots: string[]): string {
  const names = [...new Set(roots.map((root) => `“${nodePath.posix.basename(root)}”`))];
  const what = names.length <= 1 ? (names[0] ?? "a folder") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return hooks.platform === "darwin" ? `Waiting for macOS: allow Edit to use ${what}.` : `Waiting for ${what} to answer.`;
}

/** A route's wait that ran out: a 503 that says to ask again soon (http/server.ts doesn't log it as a failure). */
class StillWaiting extends ApiError {
  constructor(message: string) {
    super(503, message);
  }

  override response(): Response {
    return Response.json({ error: this.message, waiting: true }, { status: 503, headers: { "retry-after": "2" } });
  }
}

/** `work`, or a StillWaiting once `ROUTE_WAIT_MS` has gone by without it. */
async function capped(work: Promise<void>, roots: () => string[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ROUTE_WAIT_MS.value);
  });
  try {
    if ((await Promise.race([work.then(() => "done" as const), late])) === "late") throw new StillWaiting(waitingLine(roots()));
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the data folder and routes

/**
 * The data folder's places that may ask (`<home>/cache`, `<home>/media` made
 * links to another drive, or the data folder itself on one). Every route but
 * the few in OPEN waits for them. Empty in the usual case.
 */
export function useDataFolder(home: string): string[] {
  dataRoots = unanswered([home, nodePath.posix.join(home, "cache"), nodePath.posix.join(home, "media")]);
  // Answered ones are left out too: none is, at start.
  return [...dataRoots];
}

/** The start's work that reads the data folder: routes wait for it as well as for the places. */
export function hold(work: Promise<void>): void {
  held = work.finally(() => {
    held = null;
  });
}

/** Routes that never read the data folder's cache or media, answered while a place is asked about. */
const OPEN = new Set(["/api/ws", "/api/health", "/api/window/next", "/fonts/{file}", "/api/diagnostics/client", "/api/presence", "/api/access"]);

/** A project's footage places, per version of the project (it's frozen: a change is a new object). */
const projectRoots = new WeakMap<Project, string[]>();

function rootsOfPaths(paths: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const root = rootOf(path);
    if (root !== null) roots.add(root);
  }
  return [...roots];
}

/** The places a project's footage is in, from the project as it is (no file looked at). */
export function rootsOf(project: Project): string[] {
  let roots = projectRoots.get(project);
  if (roots === undefined) {
    roots = rootsOfPaths(project.media.map((media) => media.path));
    projectRoots.set(project, roots);
  }
  return roots;
}

/** What a route's request needs from the store and the export folder, to know what it waits for. */
export interface RouteNeeds {
  /** A project's footage paths, read without loading it (store.ts `mediaPathsOf`). */
  projectMedia: (id: string) => Project | string[];
  /** The saved export folder, as saved. */
  exportFolder: () => string | null;
}

/**
 * Before a route runs: waits (asynchronously, at most `ROUTE_WAIT_MS`) for
 * the places it would read synchronously: the data folder's while they're
 * asked about, a project's footage folders for its routes, the export folder
 * for an export's. Nothing to wait for, it returns at once.
 */
export async function beforeRoute(pattern: string, params: Record<string, string>, needs: RouteNeeds): Promise<void> {
  if (OPEN.has(pattern)) return;
  if (held !== null) await capped(held, () => dataRoots);
  const roots = dataRoots.filter((root) => !answered(root));
  if (pattern.startsWith("/api/projects/{id}") && params.id !== undefined) {
    const media = needs.projectMedia(params.id);
    roots.push(...(Array.isArray(media) ? rootsOfPaths(media) : rootsOf(media)).filter((root) => !answered(root)));
  }
  if (pattern.includes("export") || pattern.includes("share")) {
    const folder = needs.exportFolder();
    const root = folder === null ? null : rootOf(folder);
    if (root !== null && !answered(root)) roots.push(root);
  }
  if (roots.length === 0) return;
  await capped(reachRoots(roots), () => roots.filter((root) => !answered(root)));
}

/** Waits (at most `ROUTE_WAIT_MS`) for the places `paths` are in, for a route that's about to read them; a StillWaiting after. */
export function reachForRoute(paths: Iterable<string>): Promise<void> {
  const roots = unanswered(paths);
  return roots.length === 0 ? Promise.resolve() : capped(reachRoots(roots), () => roots.filter((root) => !answered(root)));
}

/** The data folder's places not yet answered, as a line (remote asks of its files); null when there are none. */
export function dataWaitingLine(): string | null {
  const open = dataRoots.filter((root) => !answered(root));
  return open.length === 0 && held === null ? null : waitingLine(open.length === 0 ? dataRoots : open);
}

/** Tests: nothing asked or answered. */
export function resetForTests(): void {
  answers.clear();
  asking.clear();
  listeners.clear();
  dataRoots = [];
  held = null;
}
