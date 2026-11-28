// Coded effects (Edit V2, a beta: a project with `hq`). A graphic is a web
// page the agent writes, kept as a folder of code among the project's media:
//
//     <home>/media/<project>/effects/<name>/scene.html   (and whatever it loads from beside it)
//
// The page draws any moment on request (`window.duration`, `window.ready`,
// `window.seek(t)`: effect_runtime.html, which the server puts into the page,
// says the rest). Playing it is asking it for the playhead's moment, so the
// viewer plays it the instant it's written, with no render (the page in a
// frame over the picture; apps/web's `EffectLayer`), and the agent looks at it
// as stills from the Chrome Edit drives (`look`).
//
// The code is the agent's, so the page is shut in wherever it runs: no origin
// of its own (no cookies, no storage, no way to the page around it), no
// network, and nothing loaded from outside its own folder (`policy`). Checked
// Nov 10 with the team's evidence board in headless Chrome on Linux: inside
// those walls, the playhead sent by message, it held 60 frames a second for
// its 44 s (two late).
//
//     GET /api/projects/{id}/effects                 the project's effects, each with its page's address and when it last changed
//     GET /api/effects/{key}/{id}/{name}/{file…}     a file of one, the page itself with Edit's runtime in it
//
// A page with no origin is a stranger to the server as well: every route
// refuses it (http/host.ts), so nothing of the app answers it. Its own files
// are the one thing it's let read, and by the address alone: `KEY`, made anew
// each time Edit starts and told only to Edit's own page with the list above,
// is part of every file's path, so no other site's page can name one.
//
// The render: once an effect's code has stopped changing for a few seconds,
// and while it's on the timeline, it's drawn frame by frame in Chromes Edit
// drives, side by side (each `seek` is pure, so any frame can be drawn by any
// of them), and the video made of the frames takes the still's place under the
// same media id (`Media::effect_key` says which version of the code it is). The
// engine then plays and exports it like footage, and the viewer stops playing
// the page live (a Mac's window draws the render on its own player, where a
// heavy page can't keep up: Nov 10, the evidence board's blur at 16 frames a
// second in WKWebView). Every export waits for the renders it needs
// (`waitForRenders`). Measured Nov 11 on mandalorian: a 1080p frame captured as
// JPEG in 84 ms, four Chromes 41 frames a second together; as PNG with
// optimizeForSpeed (and its alpha) 52 ms, so frames are PNG.
//
// See-through parts (Sphe, Nov 11: "do the transparency"): Chrome draws on
// nothing (no white behind the page), so what the page leaves unpainted is
// transparent. A render whose frames all fill the frame is plain H.264 as
// before; one with see-through parts is stacked (`Media::stacked_alpha`): the
// picture, its colour premultiplied, above its alpha as grey, in one H.264
// twice the height, which every decoder, the cloud and the engine's shared
// compositor carry as any video and which plays over what's beneath it. While
// its code is newer than its render, the engine draws a clear picture for it
// (`standIn`) and the page plays alone, so nothing shows twice.
//
// Not yet: sound.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join, sep } from "node:path";
import type { App } from "./app.ts";
import * as devtools from "./chrome_devtools.ts";
import * as frameCapture from "./frame_capture.ts";
import * as diag from "./diag.ts";
import * as cloudProjects from "./cloud_projects.ts";
import * as effectCloud from "./effect_cloud.ts";
import * as effectKept from "./effect_kept.ts";
import * as filePins from "./file_pins.ts";
import { diskFull, outOfSpace } from "./export_prep.ts";
import * as speeds from "./export_speeds.ts";
import * as effectMap from "./effect_map.ts";
import * as failures from "./failure.ts";
import runtimeText from "./effect_runtime.html" with { type: "text" };
import watchText from "./effect_watch.html" with { type: "text" };
import { writeAtomic } from "./files.ts";
import { ApiError, json, notFound } from "./http/errors.ts";
import { serveFile } from "./http/files.ts";
import { letStrangersRead } from "./http/host.ts";
import type { RouteContext, Router } from "./http/router.ts";
import { importPaths } from "./import.ts";
import { fingerprint } from "./hash.ts";
import { probe as probeFile } from "./media.ts";
import { Turns, type Turn, type TurnHooks } from "./render_turns.ts";
import type { Media, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { fps as rateOf } from "./project.ts";
import * as relay from "./relay.ts";
import * as seams from "./seams.ts";
import * as storage from "./storage.ts";
import { WORK_FLOOR_BYTES } from "./storage.ts";
import * as playing from "./playing.ts";
import type { Store } from "./store.ts";
import * as tools from "./tools.ts";
import * as v2cloud from "./v2_cloud.ts";
import * as fonts from "./fonts.ts";
import * as accounts from "./accounts.ts";

import font0 from "../../../crates/edit-render/fonts/Geist-Regular.ttf" with { type: "file" };
import font1 from "../../../crates/edit-render/fonts/Geist-Medium.ttf" with { type: "file" };
import font2 from "../../../crates/edit-render/fonts/Geist-SemiBold.ttf" with { type: "file" };
import font3 from "../../../crates/edit-render/fonts/Geist-Bold.ttf" with { type: "file" };
import font4 from "../../../crates/edit-render/fonts/Geist-Black.ttf" with { type: "file" };
import font5 from "../../../crates/edit-render/fonts/GeistMono-Medium.ttf" with { type: "file" };
import font6 from "../../../crates/edit-render/fonts/GeistMono-SemiBold.ttf" with { type: "file" };
import font7 from "../../../crates/edit-render/fonts/Montserrat-SemiBold.ttf" with { type: "file" };
import font8 from "../../../crates/edit-render/fonts/ReenieBeanie.ttf" with { type: "file" };
import font9 from "../../../crates/edit-render/fonts/VT323-Regular.ttf" with { type: "file" };
import font10 from "../../../crates/edit-render/fonts/Tinos-Regular.ttf" with { type: "file" };
import font11 from "../../../crates/edit-render/fonts/Tinos-Bold.ttf" with { type: "file" };
import font12 from "../../../crates/edit-render/fonts/Arimo-Regular.ttf" with { type: "file" };
import font13 from "../../../crates/edit-render/fonts/Arimo-Bold.ttf" with { type: "file" };
import font14 from "../../../crates/edit-render/fonts/AkwePro-Bold.otf" with { type: "file" };

/**
 * Edit's own faces (the renderer's, crates/edit-render/fonts; all SIL OFL 1.1
 * but Akwe Pro, whose licence is to be bought: TODO.md), there for every effect
 * page as if they were in its folder (`edit-fonts/…`, declared by the runtime),
 * so an effect draws the same text on every computer that renders it: the
 * agent's first board asked for Marker Felt, which a Mac has and Linux hasn't.
 * Akwe Pro is commentary's face (its text and graphics are set in it; Sphe,
 * Nov 22: a font that's used stays), here so a channel's agent can draw V1's
 * commentary graphics as they were. Noto Sans JP (a fallback of 9 MB) stays
 * the renderer's.
 */
export const FONTS: readonly { family: string; weight: number; file: string; path: string; later?: true }[] = [
  { family: "Geist", weight: 400, file: "Geist-Regular.ttf", path: font0 },
  { family: "Geist", weight: 500, file: "Geist-Medium.ttf", path: font1 },
  { family: "Geist", weight: 600, file: "Geist-SemiBold.ttf", path: font2 },
  { family: "Geist", weight: 700, file: "Geist-Bold.ttf", path: font3 },
  { family: "Geist", weight: 900, file: "Geist-Black.ttf", path: font4 },
  { family: "Geist Mono", weight: 500, file: "GeistMono-Medium.ttf", path: font5 },
  { family: "Geist Mono", weight: 600, file: "GeistMono-SemiBold.ttf", path: font6 },
  { family: "Montserrat", weight: 600, file: "Montserrat-SemiBold.ttf", path: font7 },
  { family: "Reenie Beanie", weight: 400, file: "ReenieBeanie.ttf", path: font8 },
  { family: "VT323", weight: 400, file: "VT323-Regular.ttf", path: font9 },
  { family: "Tinos", weight: 400, file: "Tinos-Regular.ttf", path: font10 },
  { family: "Tinos", weight: 700, file: "Tinos-Bold.ttf", path: font11 },
  { family: "Arimo", weight: 400, file: "Arimo-Regular.ttf", path: font12 },
  { family: "Arimo", weight: 700, file: "Arimo-Bold.ttf", path: font13 },
  { family: "Akwe Pro", weight: 700, file: "AkwePro-Bold.otf", path: font14, later: true },
];

/** The faces, declared for the page: loaded only when the page uses one. */
const faces = (fonts: typeof FONTS) => fonts.map((font) => `@font-face { font-family: "${font.family}"; font-weight: ${font.weight}; src: url(edit-fonts/${font.file}); }`).join("\n");
const FACES = faces(FONTS);
/** The faces a render's key has: all but those added `later` (see `RENDERER`). */
const KEYED = faces(FONTS.filter((font) => font.later !== true));

/** Edit's side of every effect page (effect_runtime.html), put in ahead of the page's own code. */
const RUNTIME = runtimeText as unknown as string;
/** What Edit watches while a page gets ready (effect_watch.html): no part of a render's key, as it changes no picture. */
const WATCH = watchText as unknown as string;
/**
 * What of Edit's own is in every render's key (`codeKey`): its runtime and its
 * faces. A change to either draws every effect of every project again, on
 * every computer that opens one; effects.test.ts pins it so that's never by
 * accident. What changes no picture goes in effect_watch.html instead. A face
 * added `later` is no part of it: no page drawn before could have used it, so
 * adding it changes no picture already made (Akwe Pro, Nov 22).
 */
export const RENDERER = fingerprint([RUNTIME, KEYED]);
/** What the runtime says of a CSS animation running, which it checks at a page's first seek alone (a kept page says it again: `look`). */
export const ANIMATION = /problem\("(A CSS animation[^"]*)"\)/.exec(RUNTIME)?.[1] ?? "";

/** The page an effect's folder must have. */
export const ENTRY = "scene.html";

const KEY = randomBytes(16).toString("hex");
/** Where every effect's files are served: unguessable, and the one path a page with no origin may read. */
const BASE = `/api/effects/${KEY}/`;
letStrangersRead(BASE);

/** An effect's folder as an address on this server (ending "/"). */
function addressOf(project: string, name: string): string {
  return `${BASE}${encodeURIComponent(project)}/${name}/`;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Where a project's effects are kept: a folder each, by name. */
export function root(store: Store, project: string): string {
  return join(store.uploadsDir(project), "effects");
}

/** One effect's folder; a name that isn't lower-case letters, digits and hyphens is refused. */
export function folder(store: Store, project: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`an effect's name is lower-case letters, digits and hyphens (its folder's name): "${name}" isn't`);
  return join(root(store, project), name);
}

export interface Effect {
  name: string;
  /** When its newest file last changed (ms): a new number is a new page to load. */
  changed: number;
  /** Its page's address on this server, for the viewer's frame. */
  page: string;
  /** The version of its code (`codeKey`): a media whose `effect_key` is this one plays its render, not the page. */
  key: string;
  /** Its files' key as renders had it before Nov 16 (`oldKey`): a render saved with that is of this code too. */
  old: string;
}

/** Every file in a folder, however deep: its path inside the folder, size and when it changed. */
function filesIn(dir: string, under = ""): [string, number, number][] {
  const found: [string, number, number][] = [];
  for (const entry of fs.readdirSync(join(dir, under), { withFileTypes: true })) {
    const inside = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesIn(dir, inside));
    else if (entry.isFile()) {
      const stat = fs.statSync(join(dir, inside));
      found.push([inside, stat.size, Math.floor(stat.mtimeMs)]);
    }
  }
  return found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Whether a file of an effect's folder is its code: not what Edit makes again
 * from the timeline (effect_inputs.ts's `beneath.mp4`, whose `.beneath.json`
 * says what it was made from and is code) nor a write that hasn't finished.
 * The same files V2's cloud keeps of a version (v2_cloud.ts `walk`), so a
 * version's key can be told from its list of files.
 */
function isCode(path: string): boolean {
  return path !== "beneath.mp4" && !path.endsWith(".partial.mp4");
}

/** Each file's sha256, kept while its size, time and inode stay the same: a folder's key is read on every save. */
const contents = new Map<string, { size: number; mtimeMs: number; ino: number; sha256: string }>();

/** A file's sha256 (`stat` its own), read again only when it changed. */
function contentOf(path: string, stat: fs.Stats): string {
  const known = contents.get(path);
  if (known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.ino === stat.ino) return known.sha256;
  const sha256 = new Bun.CryptoHasher("sha256").update(fs.readFileSync(path)).digest("hex");
  if (contents.size > 20_000) contents.clear();
  contents.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, sha256 });
  return sha256;
}

/** An effect's code as V2's cloud lists a version's files: each by its path in the folder and its content. */
function codeIn(dir: string): { path: string; sha256: string }[] {
  const code: { path: string; sha256: string }[] = [];
  for (const [path] of filesIn(dir)) {
    if (!isCode(path)) continue;
    const full = join(dir, path);
    code.push({ path, sha256: contentOf(full, fs.statSync(full)) });
  }
  return code;
}

/**
 * The version of an effect's code: its files (each by name and content, so
 * the same code fetched onto another computer, with times of its own, is the
 * same version and plays the render made of it), Edit's runtime and the frame
 * it's drawn at. A change makes a new one, and so does a new build whose
 * runtime draws differently. The fonts it names beyond Edit's own count only
 * when there are some.
 */
function codeKey(code: { path: string; sha256: string }[], frame: { width: number; height: number; fps: number }, used = ""): string {
  return fingerprint([RUNTIME, KEYED, "content", ...(used === "" ? [] : [used]), `${frame.width}x${frame.height}@${frame.fps}`, ...code.map((file) => `${file.path} ${file.sha256}`)]);
}

/**
 * The key renders had until Nov 16: the files by name, size and when they
 * last changed. A render saved with it is of the code here when it's this
 * key of the files here (`needed`), and is taken as the new key's, never
 * drawn again for the change of key alone.
 */
function oldKey(files: [string, number, number][], frame: { width: number; height: number; fps: number }, used = ""): string {
  return fingerprint([RUNTIME, KEYED, ...(used === "" ? [] : [used]), `${frame.width}x${frame.height}@${frame.fps}`, ...files.map(([path, size, changed]) => `${path} ${size} ${changed}`)]);
}

/** An effect's folder's version (`codeKey`) now. */
function keyOf(store: Store, project: string, dir: string, frame: { width: number; height: number; fps: number }): string {
  return codeKey(codeIn(dir), frame, fontsUsed(store, project, dir));
}

/**
 * Effect `name`'s version as it is here, for the key of what's beneath the graphics above it (effect_inputs.ts): `whole`
 * false leaves out its own mark of what's beneath it. Null when its code isn't on this computer.
 */
export function codeNow(store: Store, project: string, name: string, whole = true): string | null {
  const live = store.get(project);
  if (live === null) return null;
  try {
    const dir = folder(store, project, name);
    if (!fs.existsSync(join(dir, ENTRY))) return null;
    const code = codeIn(dir).filter((file) => whole || file.path !== BENEATH_MARK);
    return codeKey(code, frameOf(live.project), fontsUsed(store, project, dir));
  } catch {
    return null;
  }
}

/** The fonts beyond Edit's own an effect's page names (fonts.ts), for its key: one changed or added re-renders only what uses it. */
function fontsUsed(store: Store, project: string, dir: string): string {
  let code = "";
  try {
    code = fs.readFileSync(join(dir, ENTRY), "utf8");
  } catch {
    return "";
  }
  return fonts.usedBy(fonts.fontsFor(store, project), code);
}

/** The project's effects: every folder with a page in it, by name. */
export function list(store: Store, project: string): Effect[] {
  const live = store.get(project);
  const frame = live === null ? { width: 0, height: 0, fps: 0 } : frameOf(live.project);
  let names: string[];
  try {
    names = fs.readdirSync(root(store, project));
  } catch {
    return [];
  }
  const found: Effect[] = [];
  for (const name of names.sort()) {
    if (!NAME.test(name)) continue;
    const dir = join(root(store, project), name);
    try {
      if (!fs.statSync(join(dir, ENTRY)).isFile()) continue;
      const files = filesIn(dir);
      const used = fontsUsed(store, project, dir);
      found.push({ name, changed: Math.max(0, ...files.map((one) => one[2])), page: `${addressOf(project, name)}${ENTRY}`, key: codeKey(codeIn(dir), frame, used), old: oldKey(files, frame, used) });
    } catch {
      // A folder with no page yet: the agent is still writing it.
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The agent's hands

/** Claude Code's own tools the agent of a project with effects has: files, and nothing that runs a command or reaches the network. */
export const FILE_TOOLS: readonly string[] = ["Read", "Write", "Edit", "Glob", "Grep"];

/** Those tools allowed in `dir` and nowhere else (Claude Code's permission rules: `//` opens a path from the disk's root; a search is held to what may be read). */
export function fileRules(dir: string): string[] {
  return [`Read(/${dir}/**)`, `Edit(/${dir}/**)`, `Write(/${dir}/**)`];
}

/** Where a project's agent writes its effects: the folder, made and watched from here on, by the name the disk itself gives it (the rules above are held to that one). */
export function workshop(store: Store, project: string): string {
  const dir = root(store, project);
  fs.mkdirSync(dir, { recursive: true });
  watch(store, project);
  return fs.realpathSync(dir);
}

// ---------------------------------------------------------------------------
// Telling the viewer

const watched = new Map<string, fs.FSWatcher>();
/** Told when a project's effects change on disk (the renders, once `start` has run). */
let changed: ((project: string) => void) | null = null;

/**
 * Watches a project's effects from here on, so a file the agent writes is on
 * screen at once: every change tells the open editors (`{type: "effects"}`),
 * which load the page again. Started by whoever needs it (a turn in an HQ
 * project, an editor asking for the list) and kept while Edit runs.
 */
export function watch(store: Store, project: string): void {
  if (watched.has(project)) return;
  const dir = root(store, project);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let soon: ReturnType<typeof setTimeout> | null = null;
    const watcher = fs.watch(dir, { recursive: true }, () => {
      // A save is several events (the write, the rename into place): one message for them all.
      if (soon !== null) return;
      soon = setTimeout(() => {
        soon = null;
        store.emit({ type: "effects", id: project, effects: list(store, project) });
        changed?.(project);
      }, 40);
    });
    watcher.on("error", (error) => {
      diag.warn("effects", `${project}: watching its effects stopped: ${diag.messageOf(error)}`);
      watcher.close();
      watched.delete(project);
    });
    watched.set(project, watcher);
  } catch (error) {
    diag.warn("effects", `${project}: its effects can't be watched: ${diag.messageOf(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Serving the page, shut in

/**
 * What the page may do, sent with every file of an effect. `sandbox` with only
 * scripts allowed gives it no origin; the rest lets it load from its own
 * folder (`own`), from data it made itself, and from nowhere else, and ask the
 * network for nothing. The server's own guard is the second wall: a page with
 * no origin is a stranger to every route but its effect's files (http/host.ts).
 */
function policy(own: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${own}`,
    `style-src 'unsafe-inline' ${own}`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    `media-src ${own} data: blob:`,
    // Its own folder only: a map's tiles and library come through Edit under it (effect_map.ts), its workers start from blobs.
    `connect-src ${own}`,
    `worker-src ${own} blob:`,
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // Framed by Edit's own viewer and by no other site's page.
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * The effect's own folder as the page's browser names it: the host it asked
 * (already checked against the hosts Edit answers to) and the folder's path,
 * by either scheme (behind Tailscale's HTTPS the page came by https, which
 * this server never sees). The scheme has to be there: a page with no origin
 * has no scheme of its own for a source to borrow, and WebKit then matches a
 * source without one to nothing (Nov 11, Edit.app's window on kenobi: the
 * evidence board's photos and fonts refused, its `ready` failed, the page
 * black; Chrome let it through, so the Linux checks passed).
 */
function ownSource(request: Request, project: string, name: string): string {
  const host = request.headers.get("host") ?? "";
  // A policy can't name an IPv6 address: the whole of Edit's own address then, which works in Chrome only (WebKit has no origin to match 'self' against).
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return "'self'";
  const path = `${host}${addressOf(project, name)}`;
  // On a loopback name, its siblings too (t0…t7.localhost on the same port): a map's hundreds of tiles come six at a
  // time a host over HTTP/1.1, so the map helper spreads them (V1's map page does the same, http/host.ts loopbackSibling).
  const port = /:(\d+)$/.exec(host)?.[1];
  const loopback = /^(127\.0\.0\.1|localhost|[a-z0-9-]+\.localhost)(:\d+)?$/i.test(host) && port !== undefined;
  const siblings = loopback ? ` http://*.localhost:${port}${addressOf(project, name)}` : "";
  return `http://${path} https://${path}${siblings}`;
}

/** Files an effect's page asked for that its folder hasn't, by `project/name`: what a page stuck getting ready waits on. */
const misses = new Map<string, { path: string; at: number }[]>();

function missed(project: string, name: string, path: string): void {
  const key = `${project}/${name}`;
  const list = (misses.get(key) ?? []).filter((one) => one.path !== path && one.at > Date.now() - 10 * 60_000);
  list.push({ path, at: Date.now() });
  misses.set(key, list.slice(-12));
}

/**
 * What an effect's page asked of the network through Edit (its map's tiles,
 * its place, the map's library), by `project/name`: the requests not answered
 * yet, and the last that failed (Edit's relay unreachable or timing out, a
 * 5xx). A page that gets nowhere while these hang or fail is waiting on the
 * network, not stuck in its code (Nov 17, Sphe's M4 on nightly-78: the relay
 * unreachable from 03:03 to 03:04, the tiles answered 502 after 17–61 s, and
 * date-tulsa's render was failed as "waiting on something that never comes",
 * the code's to fix, and never tried again).
 */
const reaching = new Map<string, { pending: Set<{ path: string; at: number }>; failure: { at: number; said: string } | null; askedAt: number }>();

function reachOf(project: string, name: string) {
  const key = `${project}/${name}`;
  let found = reaching.get(key);
  if (found === undefined) {
    found = { pending: new Set(), failure: null, askedAt: 0 };
    reaching.set(key, found);
  }
  return found;
}

/** One of the map's files (effect_map.ts), its asking and answer noted in `reaching`. */
async function reachOut(app: App, request: Request, project: string, name: string, parts: string[]): Promise<Response | null> {
  const reach = reachOf(project, name);
  const asking = { path: parts.join("/"), at: Date.now() };
  reach.pending.add(asking);
  reach.askedAt = asking.at;
  let answer: Response | null;
  try {
    answer = await effectMap.serve(app, request, parts);
  } catch (error) {
    reach.failure = { at: Date.now(), said: diag.messageOf(error) };
    throw error;
  } finally {
    reach.pending.delete(asking);
  }
  if (answer !== null && answer.status >= 500) {
    let said = `${asking.path.startsWith("v1/3dtiles/") ? "a map tile" : asking.path} answered ${answer.status}`;
    try {
      const error = (JSON.parse(await answer.clone().text()) as { error?: unknown }).error;
      if (typeof error === "string") said = error;
    } catch {
      // Not the relay's JSON: its status says it.
    }
    reach.failure = { at: Date.now(), said };
  }
  return answer;
}

/**
 * What was wrong with the network for `project/name`'s page since `since`, in
 * a line, or null when nothing was: its requests through Edit unanswered for a
 * while, one failing, or the relay unreachable while it asked.
 */
export function networkTrouble(project: string, name: string, since: number, now = Date.now()): string | null {
  const reach = reaching.get(`${project}/${name}`);
  const hanging = [...(reach?.pending ?? [])].filter((one) => now - one.at >= Math.min(5_000, waits.quietMs / 2));
  if (hanging.length > 0) {
    const longest = Math.round((now - Math.min(...hanging.map((one) => one.at))) / 1000);
    const tiles = hanging.every((one) => one.path.startsWith("edit-map/v1/3dtiles/"));
    return `${hanging.length} of its ${tiles ? "map's tiles" : "requests through Edit"} unanswered after ${longest} s (Edit's relay wasn't answering)`;
  }
  if (reach?.failure !== null && reach?.failure !== undefined && reach.failure.at >= since) return `its requests through Edit's relay failing (${reach.failure.said.replace(/[.\s]+$/u, "")})`;
  // The relay unreachable meanwhile counts only for a page that asked something of the network then.
  if (reach !== undefined && reach.askedAt >= since && relay.reach.failedAt >= since) return `Edit's relay unreachable (${relay.reach.failed.replace(/[.\s]+$/u, "")})`;
  return null;
}

/** The page with Edit's runtime and faces ahead of its own code. */
function withRuntime(page: string, more = ""): string {
  const ahead = `<style>\n${FACES}${more === "" ? "" : `\n${more}`}\n</style>\n${RUNTIME}\n${WATCH}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(page);
  return doctype === null ? `${ahead}${page}` : `${doctype[0]}\n${ahead}${page.slice(doctype[0].length)}`;
}

async function file(context: RouteContext<App>): Promise<Response> {
  const { app, params, request } = context;
  const project = params.id!;
  if (params.key !== KEY) throw notFound("no such effect");
  if (app.store.get(project) === null) throw notFound("no such project");
  const why = app.store.unavailable(project);
  if (why !== null) throw new ApiError(403, why);
  let dir: string;
  try {
    dir = folder(app.store, project, params.name!);
  } catch {
    throw notFound("no such effect");
  }
  const parts = PARTS.map((part) => params[part]).filter((part): part is string => part !== undefined);
  if (parts.some((part) => part === "" || part === "." || part === ".." || /[/\\\0]/.test(part))) throw notFound("no such file");
  const headers = { "content-security-policy": policy(ownSource(request, project, params.name!)), "cache-control": "no-store" };
  // The map (effect_map.ts), as if it were in the folder (a file of the effect's own by that name is never shadowed).
  const map = parts[0] === "edit-map" && !fs.existsSync(join(dir, ...parts)) ? await reachOut(app, request, project, params.name!, parts) : null;
  if (map !== null) {
    for (const [name, value] of Object.entries(headers)) if (name !== "cache-control" || !map.headers.has(name)) map.headers.set(name, value);
    map.headers.set("access-control-allow-origin", "null");
    return map;
  }
  if (parts.length > 3 && parts[0] !== "edit-map") {
    missed(project, params.name!, parts.join("/"));
    throw notFound("no such file");
  }
  // A still Edit's Chrome just drew, handed back to the page that drew it (`look`), once.
  if (parts.length === 2 && parts[0] === HANDED && !fs.existsSync(join(dir, ...parts))) {
    const key = `${project}/${params.name}/${parts[1]}`;
    const bytes = handed.get(key);
    if (bytes === undefined) throw notFound("no such file");
    handed.delete(key);
    return new Response(bytes, { headers: { ...headers, "content-type": "image/png", "access-control-allow-origin": "null" } });
  }
  // One of Edit's faces, as if it were in the folder (a file of the effect's own by that name is never shadowed: its folder wins).
  const face = parts.length === 2 && parts[0] === "edit-fonts" && !fs.existsSync(join(dir, ...parts)) ? FONTS.find((font) => font.file === parts[1]) : undefined;
  if (face !== undefined) {
    const response = new Response(Bun.file(face.path), { headers: { ...headers, "content-type": "font/ttf", "access-control-allow-origin": "null" } });
    response.headers.set("cache-control", "max-age=86400");
    return response;
  }
  // A font of the project's or V2's cloud's (fonts.ts), as if it were in the folder too.
  const more = parts.length === 3 && parts[0] === "edit-fonts" && !fs.existsSync(join(dir, ...parts)) ? fonts.fileOf(app.store, project, parts[1]!, parts[2]!) : null;
  if (more !== null) {
    const response = new Response(Bun.file(more), { headers: { ...headers, "content-type": more.endsWith(".woff2") ? "font/woff2" : more.endsWith(".woff") ? "font/woff" : more.endsWith(".otf") ? "font/otf" : "font/ttf", "access-control-allow-origin": "null" } });
    response.headers.set("cache-control", "max-age=86400");
    return response;
  }
  // The file itself, wherever a link in the folder points: nothing outside the folder is served.
  let path: string;
  try {
    path = fs.realpathSync(join(dir, ...parts));
    if (!path.startsWith(fs.realpathSync(dir) + sep)) throw new Error("outside");
  } catch {
    missed(project, params.name!, parts.join("/"));
    throw notFound("no such file");
  }
  if (path.endsWith(".html")) {
    let page: string;
    try {
      page = fs.readFileSync(path, "utf8");
    } catch {
      throw notFound("no such file");
    }
    // Fonts beyond Edit's own: the project's (fetch_font) and V2's cloud's (read once before the first page, so it's
    // drawn in them), read again when it's been a while.
    await cloudFontsRead(app);
    void fonts.refreshCloud(app.store);
    return new Response(withRuntime(page, fonts.facesOf(fonts.fontsFor(app.store, project))), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  }
  const response = serveFile(request, path);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  // A page with no origin asks for its files as a stranger would, and a browser lets it read one (a font, a module,
  // a picture's or a video's pixels on a canvas) only when the server says a page of no origin may. Said for every
  // file of its folder: it's the agent's to do anything with (Sphe, Nov 11: "FULL control"), and no other page can
  // name one (the key in the address).
  response.headers.set("access-control-allow-origin", "null");
  return response;
}

/** A file's path parts as route params: three for an effect's own files, up to eight under the map's `edit-map/`. */
const PARTS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

export function routes(router: Router<App>): void {
  router
    .get("/api/projects/{id}/effects", ({ app, params }: RouteContext<App>) => {
      const project = params.id!;
      if (app.store.get(project) === null) throw notFound("no such project");
      const why = app.store.unavailable(project);
      if (why !== null) throw new ApiError(403, why);
      watch(app.store, project);
      // An editor opening a project made on another computer: its effects' code comes down (the list follows by the watch).
      void bringDown(app, project);
      return json({ effects: list(app.store, project) });
    })
    .get("/api/effects/{key}/{id}/{name}/{a}", file)
    .get("/api/effects/{key}/{id}/{name}/{a}/{b}", file)
    .get("/api/effects/{key}/{id}/{name}/{a}/{b}/{c}", file);
  // Deeper paths are the map's alone (its library's folders and the tiles': effect_map.ts).
  for (let depth = 4; depth <= PARTS.length; depth++) router.get(`/api/effects/{key}/{id}/{name}/${PARTS.slice(0, depth).map((part) => `{${part}}`).join("/")}`, file);
}

// ---------------------------------------------------------------------------
// Looking at one: stills from the Chrome Edit drives

const PROFILE = "edit-effect-";

/**
 * Chromes kept for looks, side by side: each holds one effect's page, loaded
 * and ready, while that effect's code stays the same (`Warm`), so a look again
 * is its seeks alone. A map's page took 7–11 s to be ready (CesiumJS, its
 * places found, the first tiles) and its first seek 4–6 s more, every look
 * (Nov 15, mandalorian); looks at two effects no longer wait on each other
 * (the agent asks for several at once; four stretches of one map finished at
 * 34, 66, 104 and 143 s, Nov 13). By the computer's memory, as the render's.
 */
const LOOK_PAGES = os.totalmem() >= 16 * 2 ** 30 ? 3 : 2;
/** Maps among them at most: each holds a 3D city on the graphics card, beside the render's and the viewer's. */
const LOOK_MAPS = LOOK_PAGES > 2 ? 2 : 1;
/** A kept Chrome unused this long is closed. */
const LOOK_IDLE_MS = 5 * 60_000;

/** An effect's page loaded in a kept Chrome, ready, and what it said while it loaded. */
interface Warm {
  /** The version of the page it is (its code's, its address's): another is loaded afresh. */
  version: string;
  duration: number;
  seek: boolean;
  /** What the runtime and the page said up to `ready`, which every look on it says again. */
  problems: string[];
  errors: string[];
  /** A CSS animation seen running at its first seek (the runtime checks once a page): said again by every look, as a fresh page would. */
  animation: string | null;
}

interface Kept {
  page: Promise<devtools.Page>;
  width: number;
  height: number;
  /** The screen's interval in it (ms). */
  interval: number;
  /** The effect it's for (`project/name`), null for any work; and whether that's a map. */
  owner: string | null;
  map: boolean;
  warm: Warm | null;
  /** Looks waiting on it or under way. */
  busy: number;
  line: Promise<unknown>;
  used: number;
  idle: ReturnType<typeof setTimeout> | null;
}

const kept: Kept[] = [];
/** Told when a kept Chrome comes free: a look waiting for one tries again. */
let freed: (() => void)[] = [];

function close(slot: Kept): void {
  const at = kept.indexOf(slot);
  if (at >= 0) kept.splice(at, 1);
  if (slot.idle !== null) clearTimeout(slot.idle);
  // A Chrome that never started: its error went to the look that waited on it.
  void slot.page.then((page) => page.close()).catch(() => {});
}

/** Opens `slot`'s Chrome at this size, its page and the screen's interval there. */
function open(slot: Kept, width: number, height: number): void {
  slot.width = width;
  slot.height = height;
  slot.interval = 0;
  slot.page = devtools.open({ profile: PROFILE, width, height, gpu: true, what: "Looking at an effect", below: true }).then(async (page) => {
    // The screen's own interval there, with nothing to draw: what a frame's cost is held against.
    slot.interval = await page.evaluate<number>(
      "new Promise((resolve) => { const gaps = []; let last = 0; const tick = (now) => { if (last) gaps.push(now - last); last = now; if (gaps.length === 12) resolve(gaps.sort((a, b) => a - b)[6]); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })",
    );
    return page;
  });
}

/**
 * The kept Chrome a piece of work goes to, or null to wait for one: the one
 * that has its effect's page already (even busy: looks at one effect take
 * turns on it), else a free one or a new one, the one used longest ago
 * giving its page up when all are taken.
 */
function slotFor(owner: string | null, map: boolean): Kept | null {
  if (owner !== null) {
    const own = kept.find((slot) => slot.owner === owner);
    if (own !== undefined) return own;
  }
  const maps = kept.filter((slot) => slot.map).length;
  const free = kept.filter((slot) => slot.busy === 0).sort((a, b) => a.used - b.used);
  // A map past the most: a free map's Chrome is the one it may take, its city given up.
  if (map && maps >= LOOK_MAPS) return free.find((slot) => slot.map) ?? null;
  if (kept.length < LOOK_PAGES) {
    // Opened at its size by its first turn.
    const none = Promise.reject(new Error("not opened"));
    none.catch(() => {});
    const slot: Kept = { page: none, width: 0, height: 0, interval: 0, owner, map, warm: null, busy: 0, line: Promise.resolve(), used: 0, idle: null };
    kept.push(slot);
    return slot;
  }
  return free[0] ?? null;
}

/**
 * One piece of work on a page of the Chromes kept for effects (started again
 * once if it went away): `owner`'s own page when there is one, looks at the
 * same effect one at a time, looks at others beside them. The work is handed
 * the page, the screen's interval and the slot's `warm` (null: the page is
 * whatever was there, to load afresh); what it returns as `warm` stays loaded.
 */
async function inChrome<T>(width: number, height: number, want: { owner: string | null; map: boolean }, work: (page: devtools.Page, interval: number, warm: Warm | null) => Promise<{ value: T; warm: Warm | null }>): Promise<T> {
  let slot = slotFor(want.owner, want.map);
  while (slot === null) {
    await new Promise<void>((resolve) => freed.push(resolve));
    slot = slotFor(want.owner, want.map);
  }
  const mine = slot;
  if (mine.owner !== want.owner) {
    // Taken over from another effect (or for work of no effect's): what it had loaded is gone.
    mine.owner = want.owner;
    mine.warm = null;
  }
  mine.map = want.map;
  mine.busy += 1;
  if (mine.idle !== null) clearTimeout(mine.idle);
  const turn = mine.line.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const page = await mine.page.catch(() => null);
      if (page === null || page.closed || mine.width !== width || mine.height !== height) {
        void mine.page.then((one) => one.close()).catch(() => {});
        open(mine, width, height);
        mine.warm = null;
      }
      try {
        // Its owner may have changed while it waited its turn: a page that isn't the work's isn't warm for it.
        const ready = await mine.page;
        const done = await work(ready, mine.interval, mine.owner === want.owner ? mine.warm : null);
        mine.warm = mine.owner === want.owner ? done.warm : null;
        return done.value;
      } catch (error) {
        mine.warm = null;
        const gone = (await mine.page.catch(() => null))?.closed !== false;
        if (!gone || attempt >= 1) throw error;
      }
    }
  });
  // The line only orders the work: each one's error goes to its own caller.
  mine.line = turn.catch(() => {});
  try {
    return await turn;
  } finally {
    mine.busy -= 1;
    mine.used = Date.now();
    if (mine.busy === 0) {
      mine.idle = setTimeout(() => close(mine), LOOK_IDLE_MS);
      mine.idle.unref?.();
    }
    const waiting = freed;
    freed = [];
    for (const resolve of waiting) resolve();
  }
}

/** Closes the Chromes kept for effects (tests, and Edit leaving). */
export function closeChrome(): void {
  for (const slot of [...kept]) close(slot);
}

export interface Still {
  /** Seconds into the effect. */
  time: number;
  picture: Uint8Array;
  mime: string;
  /** What a frame takes while it plays from here, in milliseconds, on this computer (0 when the look didn't measure it). */
  cost: number;
  /** Some of it is see-through (shown over a checkerboard): it plays over what's beneath it. */
  seeThrough: boolean;
}

/** Where a page fetches the still it just drew from (`edit-look/<token>` in its own folder): the screenshot's PNG. */
const HANDED = "edit-look";
const handed = new Map<string, Uint8Array>();

/**
 * Run in the effect's page: its PNG screenshot, fetched from Edit as a file in
 * its own folder (`HANDED`), drawn over a grey checkerboard as a JPEG, and
 * whether any of it was see-through, so the agent sees which parts will show
 * what's beneath. Fetched, not sent in as base64 in the call's source: that
 * was 0.15 s of a 960 px still and 0.8 s of a full one, the same pictures
 * (Nov 15, mandalorian).
 */
const OVER_CHECKS = `async (address, quality) => {
  const shot = await createImageBitmap(await (await fetch(address)).blob());
  const plain = new OffscreenCanvas(shot.width, shot.height).getContext("2d");
  plain.drawImage(shot, 0, 0);
  const pixels = plain.getImageData(0, 0, shot.width, shot.height).data;
  let clear = false;
  for (let at = 3; at < pixels.length; at += 4) if (pixels[at] < 250) { clear = true; break; }
  // A canvas of the page's, encoded at once by toDataURL: OffscreenCanvas.convertToBlob encodes in the page's idle
  // time, which a headless page on a Mac never has, so each waited out its ~1 s fallback (CI's Mac, Nov 16).
  const canvas = document.createElement("canvas");
  canvas.width = shot.width;
  canvas.height = shot.height;
  const ctx = canvas.getContext("2d");
  const cell = Math.max(8, Math.round(shot.width / 60));
  for (let y = 0; y < shot.height; y += cell) for (let x = 0; x < shot.width; x += cell) {
    ctx.fillStyle = ((x / cell + y / cell) & 1) === 0 ? "#9a9a9a" : "#6a6a6a";
    ctx.fillRect(x, y, cell, cell);
  }
  ctx.drawImage(shot, 0, 0);
  const jpeg = canvas.toDataURL("image/jpeg", quality);
  return { jpeg: jpeg.slice(jpeg.indexOf(",") + 1), clear };
}`;

export interface Look {
  /** The effect's length in seconds (`window.duration`; 0 when the page doesn't say). */
  duration: number;
  stills: Still[];
  /** The screen's interval in the Chrome that drew them (ms): a cost near it plays live. */
  interval: number;
  /** Where the page's code breaks the contract (it draws on its own clock, it has no seek…), each once. */
  problems: string[];
  /** What the page threw. */
  errors: string[];
  /** How its page got ready, when this look loaded it (null: kept from a look before): how long it took and the longest its code ran without a break (ms). */
  ready: { ms: number; longest: number } | null;
  /**
   * Whether a frame's cost was measured: not when the look didn't ask, or when a play was watched on this computer
   * while it looked (its Chrome then runs below the player, `playing.keepBelow`, and a cost would be the play's, not
   * its code's).
   */
  measured: boolean;
}

/** The size an effect is drawn at, and its frames a second: the project's. */
function frameOf(project: Project): { width: number; height: number; fps: number } {
  return { width: project.settings.width, height: project.settings.height, fps: rateOf(project) };
}

/**
 * A page getting ready (or making its sound) that has got nowhere this long, its code idle and nothing arriving, is
 * waiting on something that never comes. One still working is waited for, however long it takes (Sphe, Nov 16:
 * "throw this at anything"; a painting of thousands of strokes takes as long as it takes), up to `workingMostMs`.
 */
export const waits = {
  quietMs: 15_000,
  /** A page still working after this long is in a loop that never ends. */
  workingMostMs: 10 * 60_000,
  /** A seek still unsettled after this long never settles (a map's frame waits for its tiles meanwhile: effect_map.html). */
  seekMs: 60_000,
};

/**
 * `window.__edit.seek(time)` in `page`, its answer. One that never settles is said with what the page's code said
 * meanwhile, the code's to fix: an error thrown in a listener its promise waited on (a "seeked" handler whose read of
 * the video threw) leaves the promise unresolved, and the render had said only "Chrome Runtime.evaluate timed out",
 * the computer's moment, tried again to the same end (Nov 22, horror's v1-analog-look).
 */
async function seekIn(page: devtools.Page, time: number): Promise<{ error?: string; spent?: number }> {
  try {
    return await page.evaluate<{ error?: string; spent?: number }>(`window.__edit.seek(${time})`, waits.seekMs);
  } catch (error) {
    if (page.closed || !/timed out/.test(diag.messageOf(error))) throw error;
    const errors = await page.evaluate<string[]>("[...window.__edit.errors]", 5_000).catch(() => [] as string[]);
    if (errors.length === 0) throw error;
    throw new Error(`its page's seek(${time.toFixed(2)}) never finished in ${waits.seekMs / 1000} s, after it said: ${errors.map(firstLines).join("; ")}`);
  }
}
/** The share of the time its main thread runs that counts as working: an idle page's is a fraction of a percent, one drawing nearly all of it. */
const WORKING_SHARE = 0.02;

/** What the runtime says of a page while it's waited on (`window.__edit.waiting()`), with what it's waited for. */
interface Waiting<T> {
  done: T | null;
  /** Milliseconds since a file arrived, a font loaded or a worker answered. */
  quiet: number;
  /** Workers it started that haven't answered yet. */
  unheard: number;
  errors: string[];
}

/**
 * Waits for `poll` (an expression answering a `Waiting`, or null before the
 * runtime is there) to be done, for as long as the page gets anywhere: its
 * main thread working (Chrome's own count, which it answers even while the
 * page's code runs on without a break), a file arriving, a font loading, a
 * worker answering. Refused with what it was waiting on once nothing has
 * happened for `waits.quietMs`, or after `waits.workingMostMs` in all.
 */
async function settle<T>(page: devtools.Page, poll: string, said: { stuck: (errors: string[]) => string | Error; endless: string; unloaded: string }): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  await page.call("Performance.enable").catch(() => {});
  let working = started;
  let task: number | null = null;
  let taskAt = started;
  let seen = false;
  let errors: string[] = [];
  for (;;) {
    const metrics = await page.call("Performance.getMetrics", {}, 5_000).catch(() => null);
    if (page.closed) throw new Error("Chrome closed");
    let now = Date.now();
    const count = (metrics?.metrics as { name: string; value: number }[] | undefined)?.find((metric) => metric.name === "TaskDuration")?.value;
    if (typeof count === "number") {
      // A new document counts from 0 again.
      if (task !== null && count - task > ((now - taskAt) / 1000) * WORKING_SHARE) working = now;
      task = count;
      taskAt = now;
    }
    let state: Waiting<T> | null | "blocked";
    const asked = Date.now();
    try {
      state = await page.evaluate<Waiting<T> | null>(poll, 5_000);
      // Answered only once its code stopped running: it was working all that while.
      if (Date.now() - asked > 1_000 && (state === null || state.done === null)) state = state === null ? "blocked" : { ...state, quiet: 0 };
    } catch (error) {
      if (page.closed) throw error;
      // Its code running on without a break answers nothing; a page between documents has no context to ask.
      state = /timed out/.test(diag.messageOf(error)) ? "blocked" : null;
    }
    now = Date.now();
    if (state === "blocked") working = now;
    else if (state !== null) {
      seen = true;
      errors = state.errors;
      if (state.done !== null) return { value: state.done, ms: now - started };
      working = Math.max(working, state.unheard > 0 ? now : now - state.quiet);
    }
    if (now - working > waits.quietMs) {
      if (!seen) throw new Error(said.unloaded);
      const stuck = said.stuck(await withWebgl(page, errors));
      throw stuck instanceof Error ? stuck : new Error(stuck);
    }
    if (now - started > waits.workingMostMs) throw new Error(said.endless);
    await Bun.sleep(250);
  }
}

/** What a page did getting ready: its length, whether it has a seek, how long it took and the longest its code ran without a break (ms). */
interface Loaded {
  duration: number;
  seek: boolean;
  ms: number;
  longest: number;
}

/** Opens an effect's page (`url`, carrying `token`) in a Chrome's page and waits for it to be ready, as long as it's getting there (`settle`). */
async function load(page: devtools.Page, url: string, token: string, project: string, name: string): Promise<Loaded> {
  const since = Date.now();
  await page.call("Page.navigate", { url });
  const { value, ms } = await settle<{ duration: number; seek: boolean; longest: number }>(
    page,
    `(() => { if (!location.search.includes(${JSON.stringify(token)}) || !window.__edit) return null; const now = window.__edit.waiting(); return { ...now, done: now.loaded }; })()`,
    {
      stuck: (errors) => {
        const trouble = networkTrouble(project, name, since);
        if (trouble !== null) return new NetworkDown(`${name}'s page got nowhere for ${waits.quietMs / 1000} s waiting on the network, with ${trouble}: nothing in its code to fix, it goes once the connection is back`);
        // Its WebGL not starting is what it waits on: this computer's, never a file to put in its folder.
        if (errors.some(noWebgl)) return `${name}'s window.ready never resolved: this computer's browser couldn't start WebGL (it said: ${errors.join("; ")})`;
        const asked = (misses.get(`${project}/${name}`) ?? []).filter((one) => one.at >= since).map((one) => `"${one.path}"`);
        const parts = [`${name}'s window.ready never resolved: its page got nowhere for ${waits.quietMs / 1000} s (no code running, nothing loading), waiting on something that never comes`];
        parts.push(asked.length > 0 ? `it asked for ${asked.join(", ")}, not in its folder` : "a picture, font or video whose load it waits for and whose error it never hears, or a Promise nothing resolves");
        if (errors.length > 0) parts.push(`it said: ${errors.join("; ")}`);
        return `${parts.join(": ")}. Everything it loads must be in its own folder.`;
      },
      endless: `${name}'s page was still working on window.ready after ${waits.workingMostMs / 60_000} minutes: a loop that never ends, or work to make lighter`,
      unloaded: `${name}'s page didn't load in Chrome`,
    },
  );
  return { duration: value.duration, seek: value.seek, ms, longest: value.longest };
}

/**
 * The effect as the Chrome Edit drives draws it: its length, a still at each
 * of `times` (null: six spread over its length; `side`: the longest side in
 * pixels, whole frames when 0), what a frame costs to play from each (when
 * `measure`: five refreshes a still), and everything wrong the page or the
 * runtime noticed. A page that can't be loaded at all is the error.
 */
export async function look(app: App, projectId: string, name: string, times: number[] | null, side = 960, measure = true): Promise<Look> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const dir = folder(app.store, projectId, name);
  if (!fs.existsSync(join(dir, ENTRY))) {
    const others = list(app.store, projectId).map((effect) => effect.name);
    throw new Error(`no effect "${name}": it needs ${ENTRY} at effects/${name}/${ENTRY}${others.length > 0 ? `; there are ${others.join(", ")}` : ""}`);
  }
  const frame = frameOf(live.project);
  const { width, height, fps } = frame;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const host = seams.broll.pageHost(app);
  const url = `http://${host}${addressOf(projectId, name)}${ENTRY}?look=${token}`;
  // The page as it is now: a kept one of another version is loaded afresh.
  const version = `${host} ${keyOf(app.store, projectId, dir, frame)}`;
  const map = fs.readFileSync(join(dir, ENTRY), "utf8").includes("edit-map/map.js");
  const started = Date.now();
  // A look never waits for a play to stop (the agent works on through a long watch); it only doesn't measure beside one.
  let played = playing.isPlaying();
  const stopListening = playing.onChange((now) => {
    if (now) played = true;
  });
  try {
    return await inChrome(width, height, { owner: `${projectId}/${name}`, map }, async (page, interval, held) => {
      let warm = held !== null && held.version === version ? held : null;
      let readied: Look["ready"] = null;
      if (warm === null) {
        const loaded = await load(page, url, token, projectId, name);
        readied = { ms: loaded.ms, longest: loaded.longest };
        // As it renders: nothing behind the page, its unpainted parts see-through, shown over a checkerboard.
        await page.call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
        const said = await page.evaluate<{ problems: string[]; errors: string[] }>("({ problems: [...window.__edit.problems], errors: [...window.__edit.errors] })");
        warm = { version, duration: loaded.duration, seek: loaded.seek, problems: said.problems, errors: await withWebgl(page, said.errors), animation: null };
      } else {
        // Kept from a look before: it says what it said as it loaded, and what this look's seeks say, as a fresh page would.
        const before = [...warm.problems, ...(warm.animation === null ? [] : [warm.animation])];
        await page.evaluate(`(() => { const edit = window.__edit; edit.problems.splice(0, edit.problems.length, ...${JSON.stringify(before)}); edit.errors.splice(0, edit.errors.length, ...${JSON.stringify(warm.errors)}); })()`);
      }
      const stills: Still[] = [];
      if (warm.seek) {
        // Six of it, each from the middle of its sixth, when no moments are asked for.
        const duration = warm.duration;
        const wanted = times ?? (duration > 0 ? [0, 1, 2, 3, 4, 5].map((part) => Math.round(((part + 0.5) * duration * 100) / 6) / 100) : [0]);
        for (const time of wanted) {
          // Unmeasured, the cost's same five seeks one after another, not a refresh apart (five refreshes a still, 4 s of a
          // stretch's 48 frames): what they throw is said as before, and the still is drawn after the same seeks.
          const cost = measure && !played
            ? await page.evaluate<number>(`window.__edit.cost(${time}, ${1 / fps})`)
            : (await page.evaluate(`(() => { for (let drawn = 0; drawn < 5; drawn++) window.__edit.seek(${time} + drawn * ${1 / fps}); })()`), 0);
          await seekIn(page, time);
          const scale = side > 0 ? Math.min(1, side / Math.max(width, height)) : 1;
          const shot = await page.call("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: { x: 0, y: 0, width, height, scale } }, 90_000);
          if (typeof shot.data !== "string") throw new Error("Chrome drew nothing");
          // At full size too a JPEG (fine enough for small text at this quality): a full-size PNG was 1.4–4 MB, kept again
          // in the agent's session with every look (Nov 13: 290 MB of one project's).
          const handle = randomBytes(12).toString("hex");
          handed.set(`${projectId}/${name}/${handle}`, new Uint8Array(Buffer.from(shot.data, "base64")));
          let shown: { jpeg: string; clear: boolean };
          try {
            shown = await page.evaluate<{ jpeg: string; clear: boolean }>(`(${OVER_CHECKS})(${JSON.stringify(`${HANDED}/${handle}`)}, ${side === 0 ? 0.92 : 0.82})`, 60_000);
          } finally {
            handed.delete(`${projectId}/${name}/${handle}`);
          }
          stills.push({ time, picture: new Uint8Array(Buffer.from(shown.jpeg, "base64")), mime: "image/jpeg", cost, seeThrough: shown.clear });
        }
      }
      const said = await page.evaluate<{ problems: string[]; errors: string[] }>("({ problems: window.__edit.problems, errors: window.__edit.errors })");
      if (warm.animation === null) warm.animation = said.problems.find((problem) => problem === ANIMATION) ?? null;
      const measured = measure && !played && stills.length > 0;
      return { value: { duration: warm.duration, stills: measured ? stills : stills.map((still) => ({ ...still, cost: 0 })), interval, problems: said.problems, errors: await withWebgl(page, said.errors), ready: readied, measured }, warm };
    });
  } finally {
    stopListening();
    diag.record("effects", "look", Date.now() - started);
  }
}

// ---------------------------------------------------------------------------
// On the timeline

/**
 * The effect as one of the project's media, so it's placed and cut like
 * footage: `media.effect` names it, its length is the page's, and what the
 * engine plays for it is a clear picture until the render is built (the
 * viewer plays the page itself, live, alone). Adding one that's there already
 * takes its length again from the page.
 */
export async function add(app: App, projectId: string, name: string): Promise<{ media: string; duration: number }> {
  const first = await look(app, projectId, name, []);
  const wrong = [...first.errors, ...first.problems];
  if (first.duration <= 0 || wrong.length > 0) throw new Error(`${name} isn't ready for the timeline: ${wrong.join(" ") || "its page has no window.duration"}`);
  const live = app.store.get(projectId);
  const existing = live?.project.media.find((media) => media.effect === name);
  let mediaId = existing?.id;
  if (mediaId === undefined) {
    const [, added, errors] = await importPaths(app, projectId, [clearStill(app.store, projectId, name)], false, "agent");
    mediaId = added[0];
    if (mediaId === undefined) throw new Error(errors.join("; "));
  }
  const id = mediaId;
  await app.store.update(projectId, "agent", (project) => {
    const media = project.media.find((one) => one.id === id);
    if (media === undefined) throw new Error(`media ${id} is gone`);
    media.effect = name;
    media.name = name;
    // The library item it came from, whatever its folder is called (effect_kept.ts FROM): the add-ons' checks know it by that.
    const from = effectKept.fromOf(folder(app.store, projectId, name));
    if (from !== null) media.effect_from = from;
    media.duration = first.duration;
    if (media.effect_key === undefined || media.effect_key === null) {
      media.width = project.settings.width;
      media.height = project.settings.height;
    }
  });
  return { media: id, duration: first.duration };
}

/** A 2×2 PNG with nothing in it: what the engine draws for an effect whose render isn't its code's. */
const CLEAR_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR42mNgQAcAABIAAeRVjecAAAAASUVORK5CYII=", "base64");

/** An effect's clear picture among the project's uploads (its own file, so it's its own media). */
function clearStill(store: Store, project: string, name: string): string {
  const dir = join(store.uploadsDir(project), "effect-stills");
  const path = join(dir, `${name}.clear.png`);
  if (!fs.existsSync(path)) {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(path, CLEAR_PNG);
  }
  return path;
}

/**
 * Each effect whose code here is newer than its render: the engine draws its
 * clear picture in the render's place until the new one is made, so the page
 * playing live is all that's seen of it (a see-through page over its old
 * render would show both), in the browser and a Mac's window alike. Only on
 * the computer editing the project (`editingHere`): code here older than the
 * render another computer made is brought down (`bringDown`), never put in
 * its place.
 */
async function standIn(app: App, project: string): Promise<void> {
  const stale = needed(app.store, project).filter((effect) => effect.current !== null && !effect.fresh && typeof effect.media.effect_key === "string");
  // Only where the code was changed: a project another computer is editing keeps its renders, and its lock stays there.
  if (stale.length === 0 || !editingHere(app, project)) return;
  const paths = new Map(stale.map((effect) => [effect.name, clearStill(app.store, project, effect.name)]));
  const gone: [string, string][] = [];
  const kept = readKept(app.store.home);
  await app.store.update(project, "effects", (edited) => {
    let changed = false;
    for (const media of edited.media) {
      const path = media.effect === undefined || media.effect === null ? undefined : paths.get(media.effect);
      if (path === undefined || typeof media.effect_key !== "string") continue;
      // The render it stands in for, when it went up as the project's own: kept as the one before the next (effect_cloud.ts).
      if (effectCloud.isRender(project, media.cloud?.original)) gone.push([media.effect!, media.cloud!.original]);
      // And what the cloud keeps showing everyone until the new one is made (`forCloud`).
      if (media.cloud !== undefined && media.cloud !== null) (kept[project] ??= {})[media.id] = keptOf(media);
      media.path = path;
      media.kind = "image";
      media.width = edited.settings.width;
      media.height = edited.settings.height;
      delete media.effect_key;
      delete media.stacked_alpha;
      delete media.cloud;
      changed = true;
    }
    return changed;
  });
  writeKept(app.store.home, kept);
  for (const [name, key] of gone) effectCloud.replaced(app.store.home, project, name, key);
}

// ---------------------------------------------------------------------------
// What the team sees while a render is made again
//
// The clear still is this computer's alone: it stands in for a render only
// while this computer's code is newer than it, so the page playing live here
// isn't drawn over its old render. Until Nov 17 it went to the cloud like any
// change, so everyone else saw nothing where the effect was until the new
// render was made and pushed, and a render that never came (kenobi's disk
// full: Cops Found 3 Bodies, five map graphics blank for the team, exports
// included) left it blank for good. Now the render it stands in for is kept
// (`<home>/cloud/effect-standins.json`) and the cloud is sent that render in
// its place (`forCloud`, cloud_projects.ts' `hooks.outgoing`) until a new one
// is placed (`draw`).

/** A render's reference, as its media had it before the clear still took its place. */
type StoodFor = Pick<Media, "path" | "kind" | "duration" | "width" | "height" | "fps" | "has_audio" | "effect_key" | "stacked_alpha" | "cloud"> & { effect: string };

const keptFile = (home: string) => join(home, "cloud", "effect-standins.json");

function keptOf(media: Media): StoodFor {
  const kept: StoodFor = { effect: media.effect!, path: media.path, kind: media.kind, duration: media.duration, width: media.width, height: media.height, fps: media.fps, has_audio: media.has_audio, effect_key: media.effect_key, cloud: media.cloud };
  if (media.stacked_alpha === true) kept.stacked_alpha = true;
  return kept;
}

/** The renders kept, by project and media id. */
function readKept(home: string): Record<string, Record<string, StoodFor>> {
  try {
    const value = JSON.parse(fs.readFileSync(keptFile(home), "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Record<string, StoodFor>>) : {};
  } catch {
    return {};
  }
}

function writeKept(home: string, kept: Record<string, Record<string, StoodFor>>): void {
  for (const [project, media] of Object.entries(kept)) if (Object.keys(media).length === 0) delete kept[project];
  fs.mkdirSync(join(home, "cloud"), { recursive: true });
  writeAtomic(keptFile(home), JSON.stringify(kept));
}

/**
 * `project` as the cloud is sent it: each effect whose clear still stands in
 * for a render here goes as that render (one the clip would play past the end
 * of stays the still: nothing new rather than a broken edit).
 */
export function forCloud(home: string, id: string, project: Project): Project {
  const kept = readKept(home)[id];
  if (kept === undefined) return project;
  const media = [...project.media];
  let swapped = false;
  for (let at = 0; at < media.length; at++) {
    const here = media[at]!;
    const render = kept[here.id];
    if (render === undefined || here.effect !== render.effect || typeof here.effect_key === "string") continue;
    if (render.duration + 1e-3 < here.duration) continue;
    const { effect: _effect, ...fields } = render;
    const replaced: Media = { ...here, ...fields };
    if (fields.stacked_alpha !== true) delete replaced.stacked_alpha;
    media[at] = replaced;
    swapped = true;
  }
  return swapped ? { ...project, media } : project;
}

cloudProjects.hooks.outgoing = (app, id, project) => forCloud(app.store.home, id, project);

/**
 * A picture of the project's put into an effect's folder, where its page can
 * load it (the page reaches nothing outside the folder): a photo as it is, or
 * the frame of a video at `time`. Answers the file's name beside scene.html
 * and its size.
 */
export async function give(app: App, projectId: string, name: string, mediaId: string, time: number | null, as: string | null): Promise<{ file: string; width: number; height: number }> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const media = live.project.media.find((one) => one.id === mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  if (media.kind === "audio") throw new Error(`${mediaId} is a sound: an effect takes pictures`);
  if (media.effect !== undefined && media.effect !== null) throw new Error(`${mediaId} is an effect itself`);
  const dir = folder(app.store, projectId, name);
  fs.mkdirSync(dir, { recursive: true });
  const stem = (as ?? media.name).replace(/\.[A-Za-z0-9]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "picture";
  if (media.kind === "image") {
    const extension = /\.([A-Za-z0-9]+)$/.exec(media.path)?.[1]?.toLowerCase() ?? "png";
    const file = `${stem}.${extension}`;
    fs.copyFileSync(media.path, join(dir, file));
    return { file, width: media.width, height: media.height };
  }
  if (time === null || !(time >= 0 && time <= media.duration)) throw new Error(`${mediaId} is a video: give the second of the frame to take (0 to ${media.duration.toFixed(2)})`);
  const file = `${stem}.png`;
  await native().saveStill(structuredClone(media), time, join(dir, file));
  return { file, width: media.width, height: media.height };
}

/**
 * Footage longer than this is given only as a stretch the agent names: left to its defaults, a two-hour source
 * would be copied whole. A stretch it names is given at any length (Sphe, Nov 16: nothing the team asks of an
 * effect is refused by a number of ours).
 */
const WHOLE_FOOTAGE_S = 180;
/** The frequency bands a sound's levels are given in, low to high, spaced as the ear hears them. */
const BANDS = 16;

export interface Given {
  /** The footage's moving picture beside scene.html (an H.264 MP4, no sound), when it has one. */
  video: string | null;
  /** Its sound's levels beside scene.html, a script that puts them at `window.levels[key]`, when it has sound. */
  levels: string | null;
  /** Its sound itself beside scene.html, a script that puts it at `window.waves[key]`, when it has sound. */
  wave: string | null;
  /** Their key in `window.levels` and `window.waves`. */
  key: string;
  width: number;
  height: number;
  /** Seconds of the media the files hold. */
  start: number;
  duration: number;
}

/**
 * A stretch of one of the project's videos or sounds put into an effect's
 * folder (Sphe, Nov 11: the agent has "FULL control… just write code and go
 * crazy"): its picture as a video the page plays and seeks itself, and its
 * sound's levels, frame by frame, for the page to draw from (a waveform, a
 * pulse, anything). The sound itself stays on the timeline as an audio clip.
 */
export async function giveFootage(app: App, projectId: string, name: string, mediaId: string, from: number | null, to: number | null, as: string | null): Promise<Given> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const media = live.project.media.find((one) => one.id === mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  if (media.kind === "image") throw new Error(`${mediaId} is a picture: effect_picture gives one`);
  if (media.effect !== undefined && media.effect !== null) throw new Error(`${mediaId} is an effect itself`);
  const start = Math.max(0, from ?? 0);
  const end = Math.min(media.duration, to ?? media.duration);
  if (!(end > start)) throw new Error(`start and end are seconds of ${mediaId}, 0 to ${media.duration.toFixed(2)}, start before end`);
  if (from === null && to === null && media.duration > WHOLE_FOOTAGE_S) throw new Error(`${mediaId} is ${(media.duration / 60).toFixed(1)} minutes long: give start and end, the stretch the effect shows (any length)`);
  const dir = folder(app.store, projectId, name);
  fs.mkdirSync(dir, { recursive: true });
  const stem = (as ?? media.name).replace(/\.[A-Za-z0-9]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "footage";
  const { width, fps } = frameOf(live.project);
  const range = ["-ss", start.toFixed(3), "-to", end.toFixed(3), "-i", media.path];
  let video: string | null = null;
  if (media.kind === "video") {
    video = `${stem}.mp4`;
    const partial = join(dir, `${stem}.partial.mp4`);
    // Keyframes every third of a second, so a seek anywhere is quick in the page (and in the render, which seeks every frame).
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...range, "-an", "-vf", `scale='min(${width},iw)':-2`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "10", "-pix_fmt", "yuv420p", "-movflags", "+faststart", partial], { background: true });
    fs.renameSync(partial, join(dir, video));
  }
  let levels: string | null = null;
  let wave: string | null = null;
  if (media.kind === "audio" || media.has_audio) {
    // A script, not JSON: the page has no network, so it can't fetch data; a script from its own folder it can load.
    levels = `${stem}.levels.js`;
    const pcm = await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", ...range, "-vn", "-ac", "1", "-ar", "24000", "-f", "f32le", "-"], { background: true });
    const data = JSON.stringify(levelsOf(new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4)), 24000, fps));
    writeAtomic(join(dir, levels), `(window.levels = window.levels || {})[${JSON.stringify(stem)}] = ${data};\n`);
    wave = `${stem}.wave.js`;
    writeAtomic(join(dir, wave), waveScript(stem, new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4)), 24000));
  }
  // That video's, not the effect's: left out of the library when it's kept (effect_kept.ts).
  effectKept.noteGiven(dir, { video, levels, wave }, end - start, { width: media.width, height: media.height });
  return { video, levels, wave, key: stem, width: media.width, height: media.height, start, duration: end - start };
}

/** How many samples a second of a sound's wave a page is given: enough for a voice's shape, under 1 MB for three minutes. */
export const WAVE_RATE = 4000;

/**
 * A sound itself for a page to draw (Sphe, Nov 13: a reference's call
 * waveform is the sound's own shape, dense rippling strands where a voice
 * is, which loudness levels a frame at a time can't give; the agent had to
 * make its bursts up): its samples at `WAVE_RATE`, scaled so the loudest is
 * ±127, as a script putting `{ rate, peak, samples: Int8Array }` at
 * `window.waves[key]` (the page has no network: a script from its own
 * folder it can load). `peak` is the loudest sample before scaling, 0 to 1.
 */
export function waveScript(key: string, samples: Float32Array, rate: number): string {
  const step = rate / WAVE_RATE;
  const count = Math.floor(samples.length / step);
  // Each output sample the mean of the input's it stands for: a plain average keeps a voice's shape and drops the hiss above it.
  const thinned = new Float32Array(count);
  let peak = 0;
  for (let index = 0; index < count; index++) {
    const from = Math.floor(index * step), to = Math.max(from + 1, Math.floor((index + 1) * step));
    let sum = 0;
    for (let at = from; at < to; at++) sum += samples[at] ?? 0;
    thinned[index] = sum / (to - from);
    peak = Math.max(peak, Math.abs(thinned[index]!));
  }
  const bytes = new Int8Array(count);
  for (let index = 0; index < count; index++) bytes[index] = peak > 0 ? Math.round((thinned[index]! / peak) * 127) : 0;
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  return `(window.waves = window.waves || {})[${JSON.stringify(key)}] = { rate: ${WAVE_RATE}, peak: ${Math.round(peak * 1000) / 1000}, samples: new Int8Array(Uint8Array.from(atob("${text}"), (c) => c.charCodeAt(0)).buffer) };\n`;
}

/**
 * A sound's levels for a page to draw from, a frame of the project at a time:
 * `rms[i]`, how loud frame i is, and `bands[i]`, its loudness in 16 bands from
 * 40 Hz to 12 kHz; each 0 (silence, -60 dB) to 1 (full scale).
 */
export function levelsOf(samples: Float32Array, rate: number, fps: number): { fps: number; frames: number; rms: number[]; bands: number[][] } {
  const frames = Math.floor((samples.length / rate) * fps);
  const size = 1024;
  const edges = Array.from({ length: BANDS + 1 }, (_, band) => 40 * Math.pow(12_000 / 40, band / BANDS));
  const scale = (power: number) => Math.round(Math.min(1, Math.max(0, (10 * Math.log10(Math.max(power, 1e-12)) + 60) / 60)) * 1000) / 1000;
  const rms: number[] = [];
  const bands: number[][] = [];
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let index = 0; index < frames; index++) {
    const from = Math.floor((index / fps) * rate);
    const to = Math.min(samples.length, Math.floor(((index + 1) / fps) * rate));
    let sum = 0;
    for (let at = from; at < to; at++) sum += samples[at]! * samples[at]!;
    rms.push(scale(to > from ? sum / (to - from) : 0));
    // The frame's spectrum, a Hann window round its middle.
    const middle = Math.floor((from + to) / 2);
    for (let at = 0; at < size; at++) {
      const sample = samples[middle - size / 2 + at] ?? 0;
      re[at] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * at) / (size - 1)));
      im[at] = 0;
    }
    fft(re, im);
    const row: number[] = [];
    for (let band = 0; band < BANDS; band++) {
      const low = Math.max(1, Math.floor((edges[band]! * size) / rate));
      const high = Math.max(low + 1, Math.floor((edges[band + 1]! * size) / rate));
      let power = 0;
      for (let bin = low; bin < high && bin < size / 2; bin++) power += (re[bin]! * re[bin]! + im[bin]! * im[bin]!) / ((size / 4) * (size / 4));
      row.push(scale(power / (high - low)));
    }
    bands.push(row);
  }
  return { fps, frames, rms, bands };
}

/** In-place radix-2 FFT (`re.length` a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let i = 0; i < n; i += length) {
      for (let k = 0; k < length / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const ar = re[i + k + length / 2]!;
        const ai = im[i + k + length / 2]!;
        const tr = ar * wr - ai * wi;
        const ti = ar * wi + ai * wr;
        re[i + k + length / 2] = re[i + k]! - tr;
        im[i + k + length / 2] = im[i + k]! - ti;
        re[i + k] = re[i + k]! + tr;
        im[i + k] = im[i + k]! + ti;
      }
    }
  }
}

// ---------------------------------------------------------------- Sounds as code

/** A sound's page: `window.sound = { render(rate) }` answering its samples, a Float32Array a channel (or an AudioBuffer). */
export const SOUND_ENTRY = "sound.html";
const SOUND_RATE = 48_000;
/** Longer is a length gone wrong (milliseconds taken for seconds), not a sound: half an hour is 350 MB of samples in the page. */
const MOST_SOUND_S = 30 * 60;
/** Samples read out of the page a call: 10 s, under 3 MB of base64 (a minute of one channel is 15 MB). */
const SOUND_PART = 10 * SOUND_RATE;

/**
 * A sound effect made from its code (Sphe, Nov 11: sound effects "stored
 * separately as code", made by the agent rather than taken from the house's):
 * the folder's sound.html run in the Chrome Edit drives, shut in as an effect's
 * page is, its samples written as a WAV beside the project's media and put
 * among them, in place of the one made before so the clips playing it play the
 * new sound.
 */
export async function makeSound(app: App, projectId: string, name: string): Promise<{ media: string; duration: number }> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const dir = folder(app.store, projectId, name);
  if (!fs.existsSync(join(dir, SOUND_ENTRY))) throw new Error(`effects/${name}/ has no ${SOUND_ENTRY}: write it, with window.sound = { render(rate) } answering a Float32Array a channel (or an AudioBuffer)`);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `http://${seams.broll.pageHost(app)}${addressOf(projectId, name)}${SOUND_ENTRY}?sound=${token}`;
  const made = await inChrome<{ channels: Float32Array[] } | { error: string }>(640, 360, { owner: null, map: false }, async (page) => {
    await load(page, url, token, projectId, name);
    // Made in the page while Edit waits as long as it's working (`settle`), then read out a stretch at a time.
    await page.evaluate(`(() => {
      const made = (window.__sound = { done: null, channels: [] });
      (async () => {
        const sound = window.sound;
        if (!sound || typeof sound.render !== "function") return { error: "The page has no window.sound = { render(rate) }." };
        let channels = await sound.render(${SOUND_RATE});
        if (typeof AudioBuffer !== "undefined" && channels instanceof AudioBuffer) { const buffer = channels; channels = Array.from({ length: buffer.numberOfChannels }, (_, at) => buffer.getChannelData(at)); }
        if (channels instanceof Float32Array) channels = [channels];
        if (!Array.isArray(channels) || channels.length === 0 || !channels.every((one) => one instanceof Float32Array)) return { error: "render(rate) must answer a Float32Array a channel (or an AudioBuffer)." };
        if (channels[0].length === 0) return { error: "render(rate) answered no samples." };
        if (channels[0].length > ${MOST_SOUND_S * SOUND_RATE}) return { error: "A sound is at most ${MOST_SOUND_S / 60} minutes (this is " + Math.round(channels[0].length / ${SOUND_RATE}) + " s): its length is in seconds of samples at the rate given." };
        made.channels = channels.slice(0, 2);
        return { length: channels[0].length, count: made.channels.length };
      })().then((done) => { made.done = done; }, (error) => { made.done = { error: "render(rate) failed: " + String((error && error.stack) || error) }; });
    })()`);
    const { value: done } = await settle<{ length: number; count: number } | { error: string }>(page, "(() => ({ ...window.__edit.waiting(), done: window.__sound.done }))()", {
      stuck: (errors) => `${name}'s render(rate) never answered: its page got nowhere for ${waits.quietMs / 1000} s (no code running, nothing loading), waiting on a Promise nothing resolves${errors.length > 0 ? `: it said: ${errors.join("; ")}` : ""}`,
      endless: `${name}'s render(rate) was still working after ${waits.workingMostMs / 60_000} minutes: a loop that never ends, or work to make lighter`,
      unloaded: `${name}'s page didn't load in Chrome`,
    });
    if ("error" in done) return { value: done, warm: null };
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < done.count; channel++) {
      const parts: Buffer[] = [];
      for (let at = 0; at < done.length; at += SOUND_PART) {
        const part = await page.evaluate<string>(
          `(() => { const samples = window.__sound.channels[${channel}].subarray(${at}, ${Math.min(done.length, at + SOUND_PART)}); const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength); let out = ""; for (let at = 0; at < bytes.length; at += 32768) out += String.fromCharCode.apply(null, bytes.subarray(at, at + 32768)); return btoa(out); })()`,
        );
        parts.push(Buffer.from(part, "base64"));
      }
      // Copied into its own memory: a Buffer may start anywhere in Node's pool, where a Float32Array can't.
      const bytes = Buffer.concat(parts);
      const samples = new Float32Array(Math.floor(bytes.byteLength / 4));
      new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.byteLength));
      channels.push(samples);
    }
    return { value: { channels }, warm: null };
  });
  if ("error" in made) throw new Error(`${name}: ${made.error}`);
  const channels = made.channels;
  const left = channels[0]!;
  const right = channels[1] ?? left;
  const frames = left.length;
  // 16-bit PCM, stereo, at the rate it was made.
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + frames * 4, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(SOUND_RATE, 24);
  wav.writeUInt32LE(SOUND_RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 4, 40);
  const clamp = (value: number) => Math.max(-32768, Math.min(32767, Math.round((Number.isFinite(value) ? value : 0) * 32767)));
  for (let at = 0; at < frames; at++) {
    wav.writeInt16LE(clamp(left[at]!), 44 + at * 4);
    wav.writeInt16LE(clamp(right[at] ?? 0), 46 + at * 4);
  }
  const out = join(app.store.uploadsDir(projectId), "effect-sounds", `${name}-${fingerprint([wav.toString("base64")])}.wav`);
  fs.mkdirSync(join(app.store.uploadsDir(projectId), "effect-sounds"), { recursive: true });
  writeAtomic(out, wav);
  const probe = await probeFile(out);
  // The sound made before: the same media plays the new one.
  const before = live.project.media.find((media) => media.kind === "audio" && media.name === name && media.path.includes("effect-sounds"));
  if (before !== undefined) {
    await app.store.update(projectId, "agent", (project) => {
      const media = project.media.find((one) => one.id === before.id);
      if (media === undefined) return;
      media.path = out;
      media.duration = probe.duration;
      media.has_audio = true;
      delete media.cloud;
    });
    app.media.ensure(out, probe);
    return { media: before.id, duration: probe.duration };
  }
  const [, added, errors] = await importPaths(app, projectId, [out], false, "agent");
  const id = added[0];
  if (id === undefined) throw new Error(errors.join("; "));
  await app.store.update(projectId, "agent", (project) => {
    const media = project.media.find((one) => one.id === id);
    if (media !== undefined) media.name = name;
  });
  return { media: id, duration: probe.duration };
}

/** What an effect's folder says of the picture beneath it (effect_inputs.ts): an effect with one is drawn over what's below it. */
export const BENEATH_MARK = ".beneath.json";

/** The first clip of effect `name`, as what's beneath it is read (effect_inputs.ts `under`). */
function clipOf(project: Project, name: string): { track: string; start: number; duration: number } | undefined {
  const media = project.media.find((one) => one.effect === name);
  return media === undefined ? undefined : project.clips.find((one) => one.type === "video" && one.media === media.id);
}

/** The other graphics on the lanes below effect `name`'s clip, within its span: what its picture of what's beneath shows. */
function graphicsBelow(project: Project, name: string): string[] {
  const clip = clipOf(project, name);
  if (clip === undefined) return [];
  const order = project.tracks.filter((one) => one.kind === "video").map((one) => one.id);
  const below = new Set(order.slice(0, Math.max(0, order.indexOf(clip.track))));
  // By id: a two-hour edit has thousands of clips, and this is asked of each graphic on the server's thread.
  const graphics = new Map(project.media.filter((one) => typeof one.effect === "string").map((one) => [one.id, one.effect as string]));
  const found = new Set<string>();
  for (const one of project.clips) {
    if (one.type !== "video" || !below.has(one.track) || one.start >= clip.start + clip.duration || one.start + one.duration <= clip.start) continue;
    const effect = graphics.get(one.media);
    if (effect !== undefined && effect !== name) found.add(effect);
  }
  return [...found];
}

/** The project's graphics, those on the lowest lanes first: each is drawn over the ones before it. */
export function lowestFirst(project: Project): string[] {
  const order = project.tracks.filter((one) => one.kind === "video").map((one) => one.id);
  const lane = (name: string) => {
    const clip = clipOf(project, name);
    return clip === undefined ? -1 : order.indexOf(clip.track);
  };
  return onTimeline(project)
    .map((name) => ({ name, lane: lane(name) }))
    .sort((a, b) => a.lane - b.lane)
    .map((one) => one.name);
}

/** Whether effect `name` draws what's beneath it. */
function drawsBeneath(store: Store, project: string, name: string): boolean {
  try {
    return fs.existsSync(join(folder(store, project, name), BENEATH_MARK));
  } catch {
    return false;
  }
}

/** The graphics below effect `name` whose render isn't of their code here yet: until they land, what's beneath it isn't what it will be. */
export function belowNotDrawn(store: Store, project: string, name: string): string[] {
  const live = store.get(project);
  if (live === null) return [];
  const below = new Set(graphicsBelow(live.project, name));
  if (below.size === 0) return [];
  return needed(store, project)
    .filter((effect) => below.has(effect.name) && !effect.fresh && effect.current !== null)
    .map((effect) => effect.name);
}

/**
 * The graphics an export of frames `range` needs: those with a clip in it, and the ones below any of them that draws
 * what's beneath it, whose picture is made from them wherever they are in its span.
 */
function graphicsIn(store: Store, project: Project, range: readonly [number, number]): Set<string> {
  const [start, end] = range;
  const graphics = new Map(project.media.filter((one) => typeof one.effect === "string").map((one) => [one.id, one.effect as string]));
  const wanted = new Set<string>();
  for (const clip of project.clips) {
    if ((clip.type !== "video" && clip.type !== "audio") || clip.start >= end || clip.start + clip.duration <= start) continue;
    const effect = graphics.get(clip.media);
    if (effect !== undefined) wanted.add(effect);
  }
  // A set takes in what's added as it's walked: those below the ones below.
  for (const name of wanted) if (drawsBeneath(store, project.id, name)) for (const below of graphicsBelow(project, name)) wanted.add(below);
  return wanted;
}

/**
 * Of the graphics to draw (`todo`), those to start now, lowest lane first: one drawn over a graphic still to land waits
 * for it, so it's drawn once, over the finished picture. A graphic below that failed holds nothing up, and if they
 * all wait on each other (clips laid across each other's lanes) they all start.
 */
function startable<T extends { name: string; current: Effect | null }>(store: Store, project: string, todo: T[]): T[] {
  const live = store.get(project);
  if (live === null) return todo;
  const coming = new Set(todo.filter((effect) => effect.current !== null && failureOf(id(project, effect.name, effect.current.key)) === undefined).map((effect) => effect.name));
  const ready = todo.filter((effect) => !drawsBeneath(store, project, effect.name) || !graphicsBelow(live.project, effect.name).some((below) => coming.has(below)));
  const order = lowestFirst(live.project);
  return (ready.length > 0 ? ready : todo).slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

/** Whether a graphic above effect `name` is drawn over it: one `startable` holds back until this one has landed or failed. */
function drawnOver(app: App, project: string, name: string): boolean {
  const now = app.store.get(project)?.project;
  return now !== undefined && onTimeline(now).some((other) => other !== name && drawsBeneath(app.store, project, other) && graphicsBelow(now, other).includes(name));
}

/** The effects a project's timeline shows, by the clips of their media. */
export function onTimeline(project: Project): string[] {
  const names: string[] = [];
  for (const media of project.media) {
    if (media.effect === undefined || media.effect === null || names.includes(media.effect)) continue;
    if (project.clips.some((clip) => (clip.type === "video" || clip.type === "audio") && clip.media === media.id)) names.push(media.effect);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The render

/** How long an effect's code has to stay unchanged before it's rendered: the agent saves a page several times a minute while it works. */
const SETTLE_MS = 6_000;
/**
 * Chromes drawing one render side by side: as the map shots, by the computer's memory. Two at most on Linux, where
 * each draws through Vulkan on the one graphics card everything else there shares: four (some 56 Chrome processes
 * with a render under way) beside the encoder, the desktop and a frame asked for filled an 8 GB card's address space,
 * and NVIDIA's driver answers that by hanging every program that touches the card until the machine is restarted
 * (Nov 22, mandalorian, twice in an evening: "can't alloc VA space for mapping" by the thousand, Chrome, FFmpeg and
 * the desktop's shell stuck in the driver).
 */
const CHROMES = process.platform === "linux" ? 2 : os.totalmem() >= 16 * 2 ** 30 ? 4 : 2;
/** Chromes drawing a map's render (one that loads edit-map): each holds a 3D city on the graphics card. */
const MAP_CHROMES = Math.min(2, CHROMES);
const RENDER_PROFILE = "edit-effect-render-";

/** An error's first line, and where it was thrown when that line says nothing more than its kind ("Error"). */
export function firstLines(error: string): string {
  const lines = error.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const first = lines[0] ?? "";
  return /^[A-Za-z]*Error:?$/.test(first) && lines[1] !== undefined ? `${first} ${lines[1]}` : first;
}

/** Where a project's renders and their frames are kept. */
function rendersDir(store: Store, project: string): string {
  return join(store.uploadsDir(project), "effect-renders");
}

/** A render that stopped because the code changed under it: it's started again for the new code. */
class Outdated extends Error {}

/** Waits for an effect's code to stay the same for `SETTLE_MS` (at most ten minutes of changes). */
async function settled(app: App, project: string, name: string): Promise<void> {
  const until = Date.now() + 10 * 60_000;
  let before = "";
  while (Date.now() < until) {
    const live = app.store.get(project);
    if (live === null) return;
    const now = keyOf(app.store, project, folder(app.store, project, name), frameOf(live.project));
    if (now === before) return;
    before = now;
    await Bun.sleep(SETTLE_MS);
  }
}

/** One effect's render: what it's for and how far it's got. */
interface Render {
  project: string;
  /** Its project's name, for a render waiting behind it. */
  title: string;
  name: string;
  key: string;
  /** Frames drawn of all of them (0 until its length is known). */
  drawn: number;
  frames: number;
  done: Promise<void>;
  /** A map's page (edit-map): far slower to draw, so timed apart. */
  map?: boolean;
  /** When this run began drawing, and the frames it had then (a render cut short goes on from them): its own speed. */
  began?: number;
  from?: number;
  /** Its frames drawn and joined, its video being put in place (the slot given up): under way, not waiting. */
  placing?: boolean;
  /** Its time with the slot and its time waiting for it (ms), across its turns. */
  spent: number;
  queued: number;
  /** Frames it drew itself across its turns (not found drawn), for its speed. */
  made: number;
}

const renders = new Map<string, Render>();
/** The render drawing now (the slot's), for a render waiting behind it to say whose it waits for. */
let holding: Render | null = null;
/** A render under way: drawing now, or its video being put in place. */
const underWay = (render: Render) => render === holding || render.placing === true;

/**
 * What's rendering on this Mac, the one drawing first, then those waiting
 * their turn (each "<project>'s <name> effect"): empty when nothing is. The
 * keep-awake's, so the Mac stays awake while an effect renders.
 */
export function drawing(): string[] {
  return [...renders.values()].sort((a, b) => Number(underWay(b)) - Number(underWay(a))).map((render) => `${render.title}'s ${render.name} effect`);
}

/**
 * What an export of `project` waiting on its effects is waiting for, in a few
 * words: the render drawing and how far it is, or the one it waits behind;
 * null when none of its renders is under way.
 */
export function renderingLine(project: string, only?: ReadonlySet<string>): string | null {
  const own = [...renders.values()].filter((render) => render.project === project && (only === undefined || only.has(render.name)));
  if (own.length === 0) return null;
  const now = own.find(underWay) ?? own[0]!;
  const ahead = holding;
  if (!underWay(now) && ahead !== null) return ahead.project === project ? `waiting behind the ${ahead.name} effect's render` : `waiting behind ${ahead.title}'s render`;
  const more = own.length > 1 ? ` (then ${own.length - 1} more)` : "";
  return now.frames > 0 ? `rendering the ${now.name} effect · ${now.drawn} of ${now.frames} frames${more}` : `rendering the ${now.name} effect${more}`;
}

/**
 * The effects an export waits on, by project: those that weren't rendered
 * from their code as it is when the export was asked for (`noteWait`), so
 * its steps say "Graphic 3 of 5", and never count the ones that were ready.
 */
const waitedOn = new Map<string, string[]>();

/** The graphics an export of part of a project waits on, by project: its row names those alone (`waitLine`). */
const waitScope = new Map<string, ReadonlySet<string>>();

/** An export of `project` is asked for (of frames `range`, or all of it): what it waits on is what isn't rendered now (nothing: none). */
export function noteWait(app: App, project: string, range?: readonly [number, number] | null): void {
  const live = app.store.get(project);
  const only = range === undefined || range === null || live === null ? undefined : graphicsIn(app.store, live.project, range);
  const names = needed(app.store, project)
    .filter((effect) => !effect.fresh && (only === undefined || only.has(effect.name)))
    .map((effect) => effect.name);
  if (names.length === 0) waitedOn.delete(project);
  else waitedOn.set(project, names);
  if (only === undefined) waitScope.delete(project);
  else waitScope.set(project, only);
}

/** What an export of `project` waiting on its graphics is waiting for: `renderingLine`, of the graphics in its range. */
export function waitLine(project: string): string | null {
  return renderingLine(project, waitScope.get(project));
}

/** One graphic an export waits on, as its steps say it. */
export interface Graphic {
  name: string;
  /** Its first frame on the timeline, and the edit's frames a second. */
  at: number;
  fps: number;
  map: boolean;
  sound: boolean;
  state: "done" | "current" | "waiting";
  frames: number;
  drawn: number;
  /** This render's own frames a second, once it has drawn a few seconds' worth. */
  rate: number | null;
}

/** What's needed of a project's effects changes only with its code or timeline: read again at most every few seconds by the steps, which are asked every second. */
const neededLately = new Map<string, { at: number; effects: ReturnType<typeof needed>; maps: Set<string> }>();

/**
 * The graphics an export of `project` waits on (`noteWait`), in the order
 * they're done: rendered, the one drawing, then the rest by their place on
 * the timeline. Empty when it waits on none.
 */
export function graphicsOf(app: App, project: string, now = Date.now()): Graphic[] {
  const names = waitedOn.get(project);
  const live = app.store.get(project);
  if (names === undefined || live === null) return [];
  let known = neededLately.get(project);
  if (known === undefined || now - known.at > 3000) {
    const effects = needed(app.store, project);
    const maps = new Set<string>();
    for (const effect of effects) {
      try {
        if (fs.readFileSync(join(folder(app.store, project, effect.name), ENTRY), "utf8").includes("edit-map/map.js")) maps.add(effect.name);
      } catch {
        // Not on this computer: a page, as far as anyone knows.
      }
    }
    known = { at: now, effects, maps };
    neededLately.set(project, known);
  }
  const fps = rateOf(live.project);
  const out: Graphic[] = [];
  for (const name of names) {
    const effect = known.effects.find((one) => one.name === name);
    // Taken off the timeline since: nothing waits on it.
    if (effect === undefined) continue;
    const clip = live.project.clips.filter((one) => (one.type === "video" || one.type === "audio") && one.media === effect.media.id).sort((a, b) => a.start - b.start)[0];
    const running = [...renders.values()].find((render) => render.project === project && render.name === name);
    const current = running !== undefined && underWay(running);
    const frames = running !== undefined && running.frames > 0 ? running.frames : Math.max(1, Math.round(effect.media.duration * fps));
    const drawn = running?.drawn ?? 0;
    const ran = current && running.began !== undefined ? (now - running.began) / 1000 : 0;
    const rate = current && ran >= 3 && drawn - (running.from ?? 0) >= 3 ? (drawn - (running.from ?? 0)) / ran : null;
    out.push({ name, at: clip?.start ?? 0, fps, map: known.maps.has(name) || running?.map === true, sound: effect.media.kind === "audio", state: effect.fresh ? "done" : current ? "current" : "waiting", frames, drawn: Math.min(drawn, frames), rate });
  }
  const rank = { done: 0, current: 1, waiting: 2 } as const;
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.at - b.at);
}

/** Why a render failed, by what can be done about it. */
type Failure = "code" | "passing" | "network" | "disk";

/**
 * What Edit adds to a page's error naming WebGL when this browser gives a fresh canvas none (`withWebgl`): this
 * computer's, never the effect's code (Nov 25, Boyfriends on mandalorian under WSL: Chrome's WebGL found no graphics
 * card, and the agent, told to fix its code, drew the three 3D date maps as flat 2D titles instead). The page's words
 * alone aren't it: a canvas asked for "webgl" after "2d" gets none on any computer.
 */
const NO_WEBGL = "(this computer's browser has no WebGL)";

/** What the agent is told when this computer's browser couldn't start WebGL: what's there stays, and it waits on Edit. */
export const NO_WEBGL_LINE =
  "THIS COMPUTER'S BROWSER COULDN'T START WEBGL: nothing in the effect's code to fix, and no other look in its place. If you changed its code, put it back exactly as it was: the render Edit kept of that code then plays again, without being drawn. Leave its clips on the timeline as they are, report_problem, and say it's FAILED in your summary: Edit's to fix, and the change waits on it.";

/** Whether `said` is the browser's WebGL not starting, as Edit found it (`NO_WEBGL`, `withWebgl`). */
export function noWebgl(said: string): boolean {
  return said.includes(NO_WEBGL);
}

/** Asked in the page: whether this browser gives a fresh canvas WebGL at all (the context let go at once). */
const HAS_WEBGL = `(() => { try { const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl"); if (gl && gl.getExtension) gl.getExtension("WEBGL_lose_context")?.loseContext(); return !!gl; } catch { return false; } })()`;

/** A page's words for a WebGL context not made (CesiumJS's, three.js's, Chrome's own): what `withWebgl` then asks about. */
const NO_CONTEXT = /WebGL, but initialization failed|Error creating WebGL context|WebGL (?:isn't|is not) (?:available|supported)|could not create a WebGL/iu;

/**
 * A page's errors, those of a WebGL context not made (`NO_CONTEXT`) marked as this computer's (`NO_WEBGL`) when the
 * browser gives a fresh canvas none either: both, so neither the page's words (a canvas asked for "webgl" after "2d")
 * nor its other errors naming WebGL ("WebGLRenderer is not defined", its code's) are taken for the computer's.
 */
async function withWebgl(page: devtools.Page, errors: string[]): Promise<string[]> {
  const context = (error: string) => NO_CONTEXT.test(error) && !noWebgl(error);
  if (!errors.some(context)) return errors;
  const has = await page.evaluate<boolean>(HAS_WEBGL, 5_000).catch(() => true);
  return has ? errors : errors.map((error) => (context(error) ? `${error} ${NO_WEBGL}` : error));
}

/** A page held up by the network, not its code: Edit's relay unreachable, its requests through Edit hanging or failing. */
export class NetworkDown extends Error {}

/**
 * Renders that failed, by project, effect and code version: not tried again
 * until the code changes, or for `FAILED_RETRY_MS` (a map's page reaches the
 * network: tiles or a place that timed out once may load the next time, and an
 * export shouldn't stop on that failure until Edit restarts). `said` is what
 * went wrong (the agent's and the log's), `told` what a person is told.
 */
const failed = new Map<string, { said: string; told: string; at: number; kind: Failure; until: number }>();
const FAILED_RETRY_MS = 5 * 60_000;

/** Why a render failed, while that still stands. */
function failureOf(render: string): { said: string; told: string; kind: Failure } | undefined {
  const found = failed.get(render);
  if (found === undefined) return undefined;
  if (Date.now() < found.until) return found;
  failed.delete(render);
  return undefined;
}
/**
 * Renders that failed for their code's sake that the agent hasn't been told
 * of, by render (`id`): what went wrong. A render starts seconds after the
 * code settles, mostly after the turn that wrote it has ended, so the agent
 * hears of it with the person's next message (`untoldFailures`), or by
 * looking at the effect; once either way.
 */
const untold = new Map<string, string>();
const settling = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * One render draws at a time, renders taking turns at a chunk's end (render_turns.ts). A turn is five minutes, so most
 * renders finish in theirs: at 30 s (Nov 26, mandalorian, five projects rendering) each drew a chunk or two, gave way,
 * waited some 23 min and loaded its pages again, and four compilations' 130 effects went at one or two a quarter hour.
 * A render an export or a tool waits on still goes ahead at the next chunk's end. On a Mac with one edit rendering it
 * changes nothing; with two, the other's next render starts at most five minutes later, or at once when it's waited on.
 */
export const turnHooks: TurnHooks = { sliceMs: 5 * 60_000, ageMs: 5 * 60_000, now: () => Date.now() };
const turns = new Turns(turnHooks, () => new Outdated());
/** Effects someone waits on now (an export, a tool), by `project/name`, and how many wait: their renders go first. */
const waitedFor = new Map<string, number>();

/** Someone waits on effect `name`'s render until the answer is called. */
function waitOn(project: string, name: string): () => void {
  const at = `${project}/${name}`;
  waitedFor.set(at, (waitedFor.get(at) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (waitedFor.get(at) ?? 1) - 1;
    if (left > 0) waitedFor.set(at, left);
    else waitedFor.delete(at);
  };
}

/**
 * How long a render someone waits on (an export, a tool) gives way to a play before each chunk and before it's put in
 * (Nov 20). Nobody waits on it: it waits for nothing to play and nobody to wait on footage (`playing.whenIdle`), as
 * before. Waited on, that froze an export's graphic at "40 of 300 frames" for as long as anything played, or for hours
 * while a cloud project's footage was still coming down (its page renews `holdLink` every 3 s), and the export failed
 * at 20 minutes. Now footage waited on doesn't stop it at all, and a play gets the machine for up to this long between
 * its chunks: a chunk is a few seconds' drawing, so the export's graphic keeps going at about half speed through a play
 * and the play stays smooth between. Ends at this time or when the play stops.
 */
export const PLAY_FIRST_MS = { value: 5_000 };

/** A play (and footage waited on) first, as long as nobody waits on `project`'s effect `name`; then a play, for a few seconds at most. */
async function giveWayToPlay(project: string, name: string): Promise<void> {
  const waited = () => waitedFor.has(`${project}/${name}`);
  if (!waited()) await playing.whenIdle(waited);
  if (!waited()) return;
  const until = Date.now() + PLAY_FIRST_MS.value;
  await playing.whenNotPlaying(() => Date.now() >= until);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const id = (project: string, name: string, key: string) => `${project}/${name}/${key}`;

/** The disk can't hold a render: said as how much to free. */
class DiskShort extends Error {
  constructor(readonly short: number) {
    super(diskFull(short));
  }
}

/**
 * What kind of failure a render's is. Chrome not starting or going away, a
 * call timing out and a map losing its drawing are the computer's state at
 * that moment (`passing`): tried again at once. The disk running out is the
 * person's to fix. The rest is the page's code.
 */
export function failureKind(error: unknown): Failure {
  if (error instanceof DiskShort || outOfSpace(error)) return "disk";
  if (error instanceof NetworkDown) return "network";
  const said = diag.messageOf(error);
  // The map helper's own words for tiles that hang or fail (effect_map.html), and the relay's when it can't be reached.
  if (/could not reach Edit's relay|asked for and unanswered|Edit's server didn't answer/.test(said)) return "network";
  // Its frames not joining is the encoder's moment (NVENC refusing a session while the card is shared), never the
  // page's code: its frames were drawn (Nov 22, the trial server: every render for five minutes "failed at encoding",
  // told the agent to fix its effect, and the same command worked by hand two minutes on).
  // The browser's WebGL not starting is this computer's: tried again as Edit tries any passing failure, never the code's.
  if (noWebgl(said)) return "passing";
  if (/Chrome didn't start|Chrome has no page|Chrome's connection|Chrome closed|timed out|lost its drawing|didn't load in Chrome|Chrome drew nothing|needs Google Chrome|frames didn't join into a video/.test(said)) return "passing";
  return "code";
}

/** What a person is told of an effect's render that failed: the effect, and what to do. */
function toldOf(name: string, kind: Failure, error: unknown): string {
  // Edit draws it again by itself once there's room (`FAILED_RETRY_MS`), as the working copy and exports go on.
  if (kind === "disk") return `The disk is too full to draw the ${name} effect: ${error instanceof DiskShort ? `free about ${Math.max(1, Math.ceil(error.short / 1e9))} GB` : "make room"}, and Edit draws it by itself.`;
  if (kind === "passing") return `The ${name} effect couldn't render just now: press Retry.`;
  if (kind === "network") return `The ${name} effect couldn't render while the connection was down. It renders again by itself once it's back.`;
  return `The ${name} effect didn't render: ask the agent to fix the ${name} effect.`;
}

/** The effects on a project's timeline, each with its media, its code now (null: not on this computer) and whether its render is that code's. */
function needed(store: Store, project: string): { name: string; media: Media; current: Effect | null; fresh: boolean }[] {
  const live = store.get(project);
  if (live === null || live.project.hq !== true) return [];
  const effects = list(store, project);
  const out: { name: string; media: Media; current: Effect | null; fresh: boolean }[] = [];
  for (const name of onTimeline(live.project)) {
    const media = live.project.media.find((one) => one.effect === name)!;
    const current = effects.find((one) => one.name === name) ?? null;
    // Made on another computer: whatever it rendered there is what there is.
    const fresh = current === null ? media.effect_key !== undefined && media.effect_key !== null : sameCode(project, name, media.effect_key, current);
    out.push({ name, media, current, fresh });
  }
  return out;
}

/**
 * Keys found (`bringDown`) to name the code here: a render saved under a key
 * of another computer's (before Nov 16 a key had the files' times), its
 * version in V2's cloud the same files as this folder. By `project/name/key`,
 * the code's key here.
 */
const alike = new Map<string, string>();

/** Whether a render saved as `key` is of effect `name`'s code here: its key now, its key from before Nov 16, or one found to be the same files. */
function sameCode(project: string, name: string, key: string | null | undefined, current: Effect): boolean {
  if (typeof key !== "string") return false;
  return key === current.key || key === current.old || alike.get(`${project}/${name}/${key}`) === current.key;
}

/** Whether a version's files (V2's cloud) are the code here: what Edit makes again from the timeline is neither's. */
function sameFiles(files: v2cloud.File[], code: { path: string; sha256: string }[]): boolean {
  const theirs = files.filter((file) => isCode(file.path)).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return theirs.length === code.length && theirs.every((file, at) => file.path === code[at]!.path && file.sha256 === code[at]!.sha256);
}

/** The folder here was just fetched as the version render `rendered` was made of: that render is of this code (`alike`). */
function sameFilesHere(store: Store, project: string, name: string, rendered: string, frame: { width: number; height: number; fps: number }): void {
  const dir = folder(store, project, name);
  alike.set(`${project}/${name}/${rendered}`, codeKey(codeIn(dir), frame, fontsUsed(store, project, dir)));
}

/**
 * Whether effect `name`'s render on the timeline is of its code here (what's
 * beneath it is then taken as what it was drawn over: effect_inputs.ts).
 */
export function rendersItsCode(store: Store, project: string, name: string): boolean {
  const effect = needed(store, project).find((one) => one.name === name);
  return effect !== undefined && effect.current !== null && effect.fresh;
}

/**
 * Whether this computer is the one editing `project`: its own project (not
 * the cloud's, or signed out), or the cloud's with its lock here. Another
 * computer's edit is never written from here by what Edit does by itself:
 * a write would take the lock from whoever is editing it.
 */
function editingHere(app: App, project: string): boolean {
  let status: Record<string, unknown>;
  try {
    const cloud = cloudProjects.cloudOf(app);
    if (cloud === null) return true;
    status = cloud.status(project);
  } catch {
    return true;
  }
  if (status.cloud !== true || status.on !== true) return true;
  return status.lock === "held" || status.lock === "provisional";
}

/**
 * Renders saved under a key that names the code here another way (from
 * before Nov 16, or found the same files as their version in V2's cloud): the
 * key written as this computer's, nothing drawn again. Only on the computer
 * editing the project.
 */
async function rekey(app: App, project: string): Promise<void> {
  const moved = new Map(needed(app.store, project).filter((effect) => effect.fresh && effect.current !== null && effect.media.effect_key !== effect.current.key).map((effect) => [effect.name, { from: effect.media.effect_key, to: effect.current!.key }]));
  if (moved.size === 0 || !editingHere(app, project)) return;
  await app.store.update(project, "effects", (edited) => {
    let changed = false;
    for (const media of edited.media) {
      const move = media.effect === undefined || media.effect === null ? undefined : moved.get(media.effect);
      if (move === undefined || media.effect_key !== move.from) continue;
      media.effect_key = move.to;
      changed = true;
    }
    return changed;
  });
}

/**
 * Renders an effect's code as it is now, unless it's rendered already or
 * under way: the frames drawn in `CHROMES` Chromes at once, kept on disk as
 * they land (a render cut short goes on from them), joined into a video, and
 * that put in place of the still. Answers when it's in place. A failure that
 * was the computer's at that moment (`passing`) is tried again once at once;
 * one that stands is said with the effect's name and what to do, and the
 * render is started again when that stops standing (unless it's the code's,
 * which waits for the code to change).
 */
export function renderNow(app: App, project: string, name: string): Promise<void> {
  const dir = folder(app.store, project, name);
  const live = app.store.get(project);
  if (live === null) return Promise.reject(new Error("no such project"));
  const key = keyOf(app.store, project, dir, frameOf(live.project));
  const running = renders.get(id(project, name, key));
  if (running !== undefined) return running.done;
  let failure = failureOf(id(project, name, key));
  // The computer's moment, with someone waiting on it now (an export, a tool): tried again for them, not refused until
  // its own try comes (Nov 22: an export after a render the encoder failed refused "ask the agent to fix").
  if (failure !== undefined && failure.kind === "passing" && waitedFor.has(`${project}/${name}`)) {
    failed.delete(id(project, name, key));
    failure = undefined;
  }
  if (failure !== undefined) return Promise.reject(new Error(failure.told));
  const render: Render = { project, title: live.project.name, name, key, drawn: 0, frames: 0, done: Promise.resolve(), spent: 0, queued: 0, made: 0 };
  const since = Date.now();
  // Dropped before it draws when its code (or what it's given from the timeline) changed while it waited.
  const stale = () => {
    const now = app.store.get(project);
    return now !== null && keyOf(app.store, project, dir, frameOf(now.project)) !== key;
  };
  const urgent = () => waitedFor.has(`${project}/${name}`);
  const once = async () => {
    // Turns with the slot until its frames are drawn and joined: it gives way at a chunk's end to another project's render
    // that goes first, and goes on from its chunks when its turn comes again.
    for (let turn = 1; ; turn++) {
      const mine = await turns.take({ project, urgent, stale });
      holding = render;
      render.queued += mine.waited;
      const began = Date.now();
      const progress = render.frames > 0 ? `, ${render.drawn} of ${render.frames} frames drawn` : "";
      diag.info("effects", `${project}: ${name}'s render ${turn === 1 ? "starts" : "takes its turn again"} after ${seconds(mine.waited)} in the queue${progress}${urgent() ? " (waited on)" : ""}`);
      let gaveWay: boolean;
      render.began = undefined;
      render.from = undefined;
      try {
        gaveWay = await drawIn(app, render, mine);
      } finally {
        render.spent += Date.now() - began;
        if (render.began !== undefined && render.from !== undefined) render.made += Math.max(0, render.drawn - render.from);
        holding = null;
        mine.release();
      }
      if (!gaveWay) break;
      const forOwn = [...renders.values()].some((other) => other !== render && other.project === project && waitedFor.has(`${project}/${other.name}`));
      diag.info("effects", `${project}: ${name}'s render gives way to ${forOwn ? "one an export waits on" : "another project's"} at ${render.drawn} of ${render.frames} frames, ${seconds(render.spent)} drawn so far`);
    }
    render.placing = true;
    try {
      await place(app, render);
    } finally {
      render.placing = false;
    }
    // Its speed here, frames drawn and joined a second: the next renders' times.
    if (render.made > 0) speeds.noteGraphic(app.store.home, render.map === true, render.made, render.spent / 1000);
  };
  render.done = once()
    .catch((error: unknown) => {
      if (error instanceof Outdated || failureKind(error) !== "passing") throw error;
      diag.warn("effects", `${project}: ${name}'s render stopped (${diag.messageOf(error)}); trying it again`);
      return once();
    })
    .catch((error: unknown) => {
      // The code changed under it: started again once the code has settled, never at once (Nov 11, on kenobi: renders
      // restarted every 60 frames for as long as the agent kept saving, and left 4.6 GB of frames behind). It leaves the
      // list first: when the code came back to this same key meanwhile, the render asked for next found this one still
      // listed and waited on it, which was waiting on that, for ever, with nothing drawing and "180 of 8250 frames" said
      // until Edit restarted (Nov 23, cutin-keys, stuck from 15:52 to 16:11; the same at 12:29, 14:10 and 14:29).
      if (error instanceof Outdated) {
        if (renders.get(id(project, name, key)) === render) renders.delete(id(project, name, key));
        return settled(app, project, name).then(() => renderNow(app, project, name));
      }
      let said = diag.messageOf(error);
      let kind = failureKind(error);
      // What breaks while the network is down (a tile that never came, a place not found) is the network's, not the code's.
      const trouble = kind === "code" ? networkTrouble(project, name, since) : null;
      if (trouble !== null) {
        kind = "network";
        said = `${said.replace(/[.\s]+$/u, "")} (with ${trouble})`;
      }
      const told = toldOf(name, kind, error);
      const now = Date.now();
      // The computer's moment: tried again by itself after 1, 5 and 15 minutes, then every 30 (failure.ts), as every
      // passing failure is; the rest stand for `FAILED_RETRY_MS`.
      const tried = kind === "passing" ? (passingTries.get(id(project, name, key)) ?? 0) : 0;
      if (kind === "passing") passingTries.set(id(project, name, key), tried + 1);
      const until = kind === "passing" ? (failures.nextTry("passing", tried, now) ?? now + FAILED_RETRY_MS) : now + FAILED_RETRY_MS;
      failed.set(id(project, name, key), { said, told, at: now, kind, until });
      if (kind === "code") untold.set(id(project, name, key), said);
      // The network's: started again once the relay answers, or in five minutes at most.
      if (kind === "network") retryWhenBack(app, project, id(project, name, key));
      // What isn't the code's may go the next time: started again once the failure stops standing.
      else if (kind !== "code") {
        const again = setTimeout(() => renderSoon(app, project), until - now + 1_000);
        again.unref?.();
      }
      // Its code's to fix, and nothing starts it again: the graphic held back for it goes on over what's there.
      else if (drawnOver(app, project, name)) renderSoon(app, project);
      diag.warn("effects", `${project}: ${name} didn't render: ${said}`);
      throw new Error(told);
    })
    .then(() => {
      strikes.delete(id(project, name, key));
      passingTries.delete(id(project, name, key));
    })
    .finally(() => {
      // Only its own place: the render that took over from it may be under the same key.
      if (renders.get(id(project, name, key)) === render) renders.delete(id(project, name, key));
    });
  renders.set(id(project, name, key), render);
  // Its error goes to whoever waits on it; one nobody waits on is in the log.
  render.done.catch(() => {});
  return render.done;
}

/** How often a render failed by the network is checked for the relay's being back (`retryWhenBack`), the first time. */
export const networkRetry = { probeMs: 30_000 };
/** Renders failed for a passing reason one after another, by render: each tried again later than the one before (failure.ts). */
const passingTries = new Map<string, number>();
/** Renders failed by the network one after another, by render: each waits twice as long for the relay as the one before. */
const strikes = new Map<string, number>();
/** Projects whose network-failed renders wait for the relay. */
const probing = new Set<string>();

/**
 * Starts a project's renders failed by the network again once Edit's relay
 * answers (asked every `networkRetry.probeMs`, twice as long after each
 * failure in a row), or after `FAILED_RETRY_MS` at most: a render goes on as
 * soon as the connection is back, and a network that keeps failing isn't
 * hammered.
 */
function retryWhenBack(app: App, project: string, render: string): void {
  const strike = (strikes.get(render) ?? 0) + 1;
  strikes.set(render, strike);
  if (probing.has(project)) return;
  probing.add(project);
  const began = Date.now();
  const wait = Math.min(FAILED_RETRY_MS, networkRetry.probeMs * 2 ** (strike - 1));
  const again = (back: boolean) => {
    probing.delete(project);
    for (const [one, failure] of failed) if (one.startsWith(`${project}/`) && failure.kind === "network") failed.delete(one);
    diag.info("effects", `${project}: rendering its effects the network held up again, ${back ? "Edit's relay answering" : `${FAILED_RETRY_MS / 60_000} minutes on`}`);
    renderSoon(app, project);
  };
  const check = () => {
    const timer = setTimeout(() => {
      void relay.answers().then((back) => {
        if (back || Date.now() - began >= FAILED_RETRY_MS) again(back);
        else check();
      });
    }, Math.min(wait, Math.max(0, FAILED_RETRY_MS - (Date.now() - began))));
    timer.unref?.();
  };
  check();
}

/**
 * A render's turn with the slot: its video brought back or its frames drawn
 * and joined (`drawAndJoin`). True when it gave way to another project's
 * render at a chunk's end, its chunks kept for its next turn.
 */
async function drawIn(app: App, render: Render, turn: Turn): Promise<boolean> {
  const { project, name, key } = render;
  const live = app.store.get(project);
  if (live === null) throw new Error("the project is gone");
  const dir = rendersDir(app.store, project);
  const out = join(dir, `${name}-${key}.mp4`);
  const frames = join(dir, `${name}-${key}.frames`);
  // Drawn before and kept in the cache since it went up (effect_cloud.ts): that file again, not drawn again.
  if (!fs.existsSync(out) && effectCloud.bringBack(app.store.cacheDir(), project, `${name}-${key}.mp4`, out)) diag.info("effects", `${project}: ${name}'s render of this code was here already`);
  if (fs.existsSync(out)) return false;
  return drawAndJoin(app, render, live.project, dir, frames, out, turn);
}

/** A render's video, drawn and joined, put in place of the effect's still: outside the slot, so the next render draws meanwhile. */
async function place(app: App, render: Render): Promise<void> {
  const { project, name, key } = render;
  const live = app.store.get(project);
  if (live === null) throw new Error("the project is gone");
  const frame = frameOf(live.project);
  const dir = rendersDir(app.store, project);
  const out = join(dir, `${name}-${key}.mp4`);
  const probe = await probeFile(out);
  if (probe.kind !== "video" || !(probe.duration > 0)) throw new Error("its render isn't a video Edit can read");
  // A stacked render is twice as tall as the frame is for its width (whatever size it was kept at).
  const stacked = probe.width > 0 && Math.abs(probe.height / probe.width - (2 * frame.height) / frame.width) < 0.01;
  // Put in once nobody's watching: swapped in under a play, the page playing it live gave way to a video still opening,
  // a blink in the picture (Sphe, Nov 17: the agent's work goes on "as if it's not even happening").
  await giveWayToPlay(project, name);
  // Code changed while the video was made: the next render takes over.
  if (keyOf(app.store, project, folder(app.store, project, name), frame) !== key) throw new Outdated();
  let placed = false;
  // The render this one replaces, when it went up as the project's own (effect_cloud.ts keeps it, the one before it goes).
  let before = null as string | null;
  await app.store.update(project, "effects", (edited) => {
    for (const media of edited.media) {
      if (media.effect !== name) continue;
      if (effectCloud.isRender(project, media.cloud?.original)) before = media.cloud!.original;
      media.path = out;
      media.kind = probe.kind;
      media.duration = probe.duration;
      media.width = stacked ? frame.width : probe.width;
      media.height = stacked ? frame.height : probe.height;
      media.fps = probe.fps;
      media.has_audio = probe.has_audio;
      media.effect_key = key;
      if (stacked) media.stacked_alpha = true;
      else delete media.stacked_alpha;
      delete media.cloud;
      placed = true;
    }
    return placed;
  });
  if (!placed) return;
  const kept = readKept(app.store.home);
  const mine = kept[project];
  if (mine !== undefined) {
    for (const [media, render] of Object.entries(mine)) if (render.effect === name) delete mine[media];
    writeKept(app.store.home, kept);
  }
  if (before !== null) effectCloud.replaced(app.store.home, project, name, before);
  prune(app.store, project, name, out);
  // A graphic drawn over this one can go now: its picture of what's beneath is made from this render, then it's drawn.
  if (drawnOver(app, project, name)) renderSoon(app, project);
  // Its own preview: no copy of it made to seek in (see the encode above).
  app.media.ensure(out, probe, true);
  try {
    if (relay.cloudEnabled()) seams.cloudMedia.backfillSoon(app, project);
  } catch (error) {
    diag.warn("cloud", `backfill ${project}: ${diag.messageOf(error)}`);
  }
  diag.record("effects", "render", render.spent);
  diag.info("effects", `${project}: ${name} rendered (${render.frames} frames, ${seconds(render.spent)} drawing and joining, ${seconds(render.queued)} in the queue)`);
  void keepVersion(app, project, name, key);
}

/**
 * Each settled version of an effect's code kept in V2's cloud as the effect's
 * next version: its history, to go back through (`restore`), and its code for
 * another computer's agent to carry on with. Kept as it settles, before its
 * render (Nov 25: the 1957 murder edit's two maps never finished rendering on
 * the MacBook Air, so their code was on that Mac alone and the edit couldn't
 * go on from another computer), and again once rendered (the same files: no
 * new version). In the background; signed out, there's no cloud and nothing
 * is kept.
 */
export function keepVersion(app: App, project: string, name: string, key: string, reason: "settled" | "rendered" = "rendered", attempt = 1): Promise<void> {
  if (!v2cloud.enabled()) return Promise.resolve();
  const item = v2cloud.effectKey(project, name);
  const dir = folder(app.store, project, name);
  // One effect's saves one after another, in the order asked, each made the version in use: side by side, an older
  // one whose files went up slower was made the version in use after a newer one (PR #14's CodeRabbit review). A save
  // whose code here has moved on is left to the save asked for the newer code: its files aren't the code `key` names.
  const next = (keeping.get(item) ?? Promise.resolve())
    .then(async () => {
      // Its code as `key` names it (here, then in the copy that's sent, once its files are up), and the
      // project still edited here: a save tried again after another computer took it over kept this computer's older
      // code over the code settled there (PR #14's Codex review).
      // The copy sent is judged by the files as they went up (`sent`), never read again here: a copy's every file would
      // be read and hashed at once, an effect's video among them, holding the server's thread (PR #14's CodeRabbit review).
      const still = (folder: string, sent?: readonly { path: string; sha256: string }[]) => {
        const live = app.store.get(project);
        if (live === null || !editingHere(app, project) || !fs.existsSync(join(folder, ENTRY))) return false;
        // Just taken over and not caught up with the cloud's version yet: the code here may be the older one (PR #14's
        // CodeRabbit review); kept once it has caught up, by the pass that follows.
        const catching = catchingUp.get(project);
        if (catching !== undefined && !catching.has(name)) return false;
        const frame = frameOf(live.project);
        const now = sent === undefined ? keyOf(app.store, project, folder, frame) : codeKey(sent.filter((file) => isCode(file.path)).map(({ path, sha256 }) => ({ path, sha256 })), frame, fontsUsed(app.store, project, folder));
        return now === key;
      };
      if (!still(dir)) return;
      await v2cloud.save(item, name, dir, { source: key, reason, still });
    })
    .catch((error: unknown) => {
      // Moved on while it went up: the save asked for the newer code keeps that, or, back to this code by now, the
      // try below does (it does nothing once the code here isn't this).
      if (!(error instanceof v2cloud.Moved)) diag.warn("effects", `${project}: ${name} wasn't kept in V2's cloud (try ${attempt} of ${keepHooks.tries}): ${diag.messageOf(error)}`);
      // Tried again a little later, while it's still the code here: nothing else may come to keep it (its render failing
      // too, and no change after), and the edit couldn't go on from another computer (PR #14's CodeRabbit review).
      if (attempt < keepHooks.tries) setTimeout(() => void keepVersion(app, project, name, key, reason, attempt + 1), keepHooks.againMs).unref?.();
    })
    .finally(() => {
      if (keeping.get(item) === next) keeping.delete(item);
    });
  keeping.set(item, next);
  return next;
}

/** How often a save that failed is tried in all, and how long after the last (tests make it quick). */
export const keepHooks = { tries: 4, againMs: 30_000 };

/** Each effect's saves to V2's cloud under way, by its item: the last asked, which the next waits on. */
const keeping = new Map<string, Promise<void>>();

/** Each project's bringDown under way: one at a time, every caller waiting on the same. */
const bringing = new Map<string, Promise<string[]>>();
/** Effects already looked for in V2's cloud (`project/name/render key/key here`), and when: nothing there to bring. */
const lookedFor = new Map<string, number>();
/** Whether each project was edited here when its effects were last looked for: a change of hands forgets what was. */
const lookedWhileEditing = new Map<string, boolean>();
/** How long an effect looked for stays so while another computer edits the project (and may settle newer code). */
const LOOK_AGAIN_MS = 60_000;

/**
 * Whether `asked` was looked for since the cloud could have moved on: while this computer edits the project, only
 * it settles code, so once is enough; while another computer does, a minute (PR #14's CodeRabbit review: a version
 * settled there without a render left the render's key and the code here as they were, and was never asked for).
 */
/**
 * Projects taken over here, and which of their effects have been brought up to the version in use since. Until then
 * code here older than that version is the last editor's and is replaced by it; after, it's this computer's agent's,
 * put back to an older version on purpose maybe, and stays (PR #14's Codex review: a revert to the render's code was
 * fetched over with the newer version settled before it).
 */
const catchingUp = new Map<string, Set<string>>();

/** Project `project` taken over here (its lock taken, or this computer began editing it): its effects catch up once. */
export function tookOver(project: string): void {
  forgetLookedFor(project);
  catchingUp.set(project, new Set());
}

/** What a restart forgets of the cloud (tests). */
export function forgetCloudForTests(): void {
  lookedFor.clear();
  lookedWhileEditing.clear();
  catchingUp.clear();
}

/** What was looked for of a project's effects forgotten: it changed hands (taken here, or the editing changed). */
function forgetLookedFor(project: string): void {
  for (const asked of [...lookedFor.keys()]) if (asked.startsWith(`${project}/`)) lookedFor.delete(asked);
}

function lookedForLately(asked: string, editing: boolean): boolean {
  const at = lookedFor.get(asked);
  return at !== undefined && (editing || Date.now() - at < LOOK_AGAIN_MS);
}

/**
 * The effects of a project's timeline whose code here is older than V2's
 * cloud has, brought down at the version in use (the code its agent last
 * settled on, rendered or not), so its agent can see and change them, and
 * the viewer play them live: one made on another computer, or changed there
 * since this computer last had it. Code here that's the render's (by its
 * files) or the version in use is left as it is, and so is code that's none
 * of the versions kept (the agent's work, not settled yet).
 */
export function bringDown(app: App, project: string): Promise<string[]> {
  const going = bringing.get(project);
  if (going !== undefined) return going;
  // Its own fonts and its effects' code side by side (one after the other, a first open waited 14 s more on kenobi).
  const work = Promise.all([
    fonts.bringDownProject(app.store, project).catch((error: unknown) => {
      diag.warn("effects", `${project}: its fonts couldn't come down from the cloud: ${diag.messageOf(error)}`);
      return [] as string[];
    }),
    bringDownNow(app, project),
  ])
    .then(([fontsCame, code]) => [...fontsCame.map((slug) => `font ${slug}`), ...code])
    .then((brought) => {
      // Said here, not left to the folder's watch (which may not hear a folder swapped in whole): the viewer plays it
      // live, and its render follows on the computer editing it.
      if (brought.length > 0) {
        app.store.emit({ type: "effects", id: project, effects: list(app.store, project) });
        changed?.(project);
      }
      return brought;
    })
    .finally(() => bringing.delete(project));
  bringing.set(project, work);
  return work;
}

async function bringDownNow(app: App, project: string): Promise<string[]> {
  const live = app.store.get(project);
  if (live === null || live.project.hq !== true || !v2cloud.enabled()) return [];
  const frame = frameOf(live.project);
  const editing = editingHere(app, project);
  if (lookedWhileEditing.get(project) !== editing) {
    if (editing && lookedWhileEditing.get(project) === false) tookOver(project);
    else forgetLookedFor(project);
    lookedWhileEditing.set(project, editing);
  }
  // Each effect asked of the cloud side by side: an edit of 19 effects asked one after another kept its renders waiting.
  // Each effect once, however many of the timeline's media are of it: two fetches into one folder side by side
  // cleared each other's (PR #14's CodeRabbit review).
  const seen = new Set<string>();
  const came = await Promise.all(
    live.project.media.map(async (media): Promise<string | null> => {
      const name = media.effect;
      if (name === undefined || name === null || !NAME.test(name) || seen.has(name)) return null;
      seen.add(name);
      try {
        return (await bringOne(app, project, name, typeof media.effect_key === "string" ? media.effect_key : null, frame, editing)) ? name : null;
      } catch (error) {
        diag.warn("effects", `${project}: ${name} couldn't come down from V2's cloud: ${diag.messageOf(error)}`);
        return null;
      }
    }),
  );
  return came.filter((name): name is string => name !== null);
}

/** One effect's code brought down from V2's cloud when what's here is older (`bringDown`): whether it came. */
async function bringOne(app: App, project: string, name: string, rendered: string | null, frame: { width: number; height: number; fps: number }, editing: boolean): Promise<boolean> {
  const dir = folder(app.store, project, name);
  const item = v2cloud.effectKey(project, name);
  if (!fs.existsSync(dir)) {
    const asked = `${project}/${name}/${rendered}/none`;
    if (lookedForLately(asked, editing)) return false;
    // The version in use: the code its agent last settled on, rendered or not (a render still to come, or one that
    // never finished on the computer it was made on: Nov 25, the 1957 murder edit's maps), so the work goes on from it.
    // Not swapped in over a folder its agent made meanwhile.
    const came = await v2cloud.fetchInto(item, null, dir, () => !fs.existsSync(dir));
    if (came === null) {
      lookedFor.set(asked, Date.now());
      return false;
    }
    // The render's own version came down: its files are the code the render was made of, whatever key that computer
    // gave it (before Nov 16 a key had the files' times, which no fetch keeps). Said at once, before the clear still is
    // judged (`standIn`): kenobi, Nov 17, swapped five such renders of Cops Found 3 Bodies for clear stills on its first
    // open, for the whole team.
    if (rendered !== null && came.source === rendered) sameFilesHere(app.store, project, name, rendered, frame);
    return true;
  }
  if (!fs.existsSync(join(dir, ENTRY))) return false;
  const files = filesIn(dir);
  const used = fontsUsed(app.store, project, dir);
  const code = codeIn(dir);
  const here: Effect = { name, changed: 0, page: "", key: codeKey(code, frame, used), old: oldKey(files, frame, used) };
  // Asked once a session for each render and code here: the render's own code here too, as another computer may have
  // settled on newer code since that render.
  const asked = `${project}/${name}/${rendered}/${here.key}`;
  if (lookedForLately(asked, editing)) return false;
  // Said looked for only once the cloud has answered: a question that failed is asked again (PR #14's CodeRabbit review).
  const looked = (came: boolean) => {
    lookedFor.set(asked, Date.now());
    catchingUp.get(project)?.add(name);
    return came;
  };
  const versions = await v2cloud.versions(item);
  const same = (kept: v2cloud.File[]) => sameFiles(kept, code);
  const its = versions.find((one) => one.source === rendered && one.files !== null);
  // The same files under another computer's key: the render is of this code.
  if (rendered !== null && its !== undefined && !sameCode(project, name, rendered, here) && same(its.files!)) alike.set(`${project}/${name}/${rendered}`, here.key);
  // The version in use here already (the render's, or settled since and its render to come): left as it is.
  const inUse = versions.length === 0 ? null : await v2cloud.version(item);
  if (inUse === null || inUse.version.files === null || same(inUse.version.files)) return looked(false);
  // An older version of it here (the render's among them): the one in use comes in its place. Code that's no version
  // kept is the agent's work, not settled yet: left as it is, and so is code its agent changed while the cloud was
  // asked (judged again just before the swap, PR #14's CodeRabbit review: the folder was swapped whole over it).
  if (!versions.some((one) => one.files !== null && same(one.files))) return looked(false);
  // Where it's edited, only once it's just been taken over: else the older code here is its agent's own.
  const catching = catchingUp.get(project);
  if (editing && (catching === undefined || catching.has(name))) return looked(false);
  const came = await v2cloud.fetchInto(item, inUse.version.n, dir, () => fs.existsSync(join(dir, ENTRY)) && codeKey(codeIn(dir), frame, fontsUsed(app.store, project, dir)) === here.key);
  if (came === null) return looked(false);
  if (rendered !== null && came.source === rendered) sameFilesHere(app.store, project, name, rendered, frame);
  return looked(true);
}

/**
 * An effect's older renders go once a newer one is in place, all but the one
 * before it (what an undo of the swap would show); so do frames left by a
 * render the code outran. The agent saves a page many times a session, and each
 * settled version is a render: the first trial left 255 MB of three.
 */
function prune(store: Store, project: string, name: string, kept: string): void {
  const dir = rendersDir(store, project);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const own = (entry: string) => entry.startsWith(`${name}-`) && /^[0-9a-f]{12}\./.test(entry.slice(name.length + 1));
  const running = new Set([...renders.values()].filter((render) => render.project === project && render.name === name).map((render) => render.key));
  const videos = entries
    .filter((entry) => own(entry) && entry.endsWith(".mp4") && !entry.endsWith(".partial.mp4") && join(dir, entry) !== kept)
    .map((entry) => ({ entry, at: fs.statSync(join(dir, entry)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  // One an export is reading stays (file_pins.ts): the renders' sweep takes it later.
  for (const { entry } of videos.slice(1)) if (!filePins.pinned(join(dir, entry))) fs.rmSync(join(dir, entry), { force: true });
  for (const entry of entries) {
    if (!own(entry) || !entry.endsWith(".frames") || running.has(entry.slice(name.length + 1, name.length + 13))) continue;
    fs.rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * An effect's frames drawn in its Chromes and made into `out`, in chunks of a
 * couple of seconds (`chunkFrames`): each chunk's frames drawn, then encoded
 * into a video of its own while the next is drawn, its frames let go, and the
 * chunks joined at the end by a stream copy (the concat demuxer: nothing
 * encoded twice). So a render needs room for two chunks' frames and its video,
 * not every frame at once: until Nov 17 each of its frames was kept as a PNG
 * (3.1 MB a 1080p frame) until all were drawn, and on kenobi, an M1 with
 * little disk, every render was refused ("free about 8 GB").
 *
 * See-through (some pixel less than opaque) is asked of each chunk as it's
 * encoded: once one is, the whole render is stacked (colour over alpha), the
 * chunks encoded before it plain are drawn again stacked (a page draws each
 * moment the same), never made from their H.264, and `state.json` says so. A
 * render cut short (a quit) goes on from its chunks and frames.
 */
async function drawAndJoin(app: App, render: Render, project: Project, dir: string, frames: string, out: string, turn: Turn): Promise<boolean> {
  const { name, key } = render;
  const frame = frameOf(project);
  const id = render.project;
  fs.mkdirSync(frames, { recursive: true });
  const url = `http://${seams.broll.pageHost(app)}${addressOf(id, name)}${ENTRY}?render=`;
  const opened: devtools.Page[] = [];
  const claim = storage.claim(0);
  // What this render holds on the disk now beyond what it had when it began, so its claim is what it still needs.
  let held = 0;
  let need = 0;
  const hold = (bytes: number) => {
    held += bytes;
    claim.bytes = Math.max(0, Math.min(need, need - held));
  };
  const statePath = join(frames, "state.json");
  const per = chunkFrames(frame);
  let count = 0;
  let stacked = false;
  // The hardware encoder failed this render once: every chunk on libx264 from then, so its video is one encoder's.
  let software = false;
  const chunkPath = (n: number, alpha: boolean) => join(frames, `chunk-${String(n).padStart(5, "0")}${alpha ? ".alpha" : ""}.mp4`);
  const rangeOf = (n: number): [number, number] => [n * per, Math.min(render.frames, (n + 1) * per)];
  const rate = rateArg(project);
  try {
    try {
      // A map's page is far heavier on the graphics card (Google's 3D city, drawn half as big again from high up): four of
      // them at once with the viewer's and the agent's looks beside them ran an 8 GB card out, and their maps went black
      // (Nov 13: call-map-a failed at the same second every try, where its camera rose).
      const map = fs.readFileSync(join(folder(app.store, id, name), ENTRY), "utf8").includes("edit-map/map.js");
      render.map = map;
      for (let at = 0; at < (map ? MAP_CHROMES : CHROMES); at++) opened.push(await devtools.open({ profile: RENDER_PROFILE, width: frame.width, height: frame.height, gpu: true, what: "Rendering an effect", below: true }));
      // Nothing behind the page: what it leaves unpainted is see-through.
      await Promise.all(opened.map((page) => page.call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } })));
      const loaded = await Promise.all(opened.map((page, at) => load(page, `${url}${key}-${at}`, `${key}-${at}`, id, name)));
      // A page whose WebGL wouldn't start here says so first (this computer's, whatever broke after it), then one whose
      // window.ready failed (a map whose place wasn't found), not what breaks after either.
      const said = (await Promise.all(opened.map(async (page) => withWebgl(page, await page.evaluate<string[]>("[...window.__edit.errors]"))))).flat();
      const computer = said.find(noWebgl);
      if (computer !== undefined) throw new Error(`its page couldn't start: ${computer}`);
      const rejected = said.find((error) => error.startsWith("window.ready was rejected"));
      if (rejected !== undefined) throw new Error(`its ${rejected}`);
      const duration = loaded[0]!.duration;
      if (!(duration > 0)) throw new Error("its page has no window.duration");
      if (!loaded[0]!.seek) throw new Error("its page has no window.seek(t)");
      render.frames = Math.max(1, Math.round(duration * frame.fps));
      count = Math.ceil(render.frames / per);
      // Stacked already (said, or a chunk made so): the chunks made plain before that are drawn again.
      const state = readState(statePath);
      stacked = state.stacked || Array.from({ length: count }, (_, n) => n).some((n) => fs.existsSync(chunkPath(n, true)));
      software = state.software;
      if (stacked) for (let n = 0; n < count; n++) fs.rmSync(chunkPath(n, false), { force: true });
      const queue: number[] = [];
      let toDraw = 0;
      render.drawn = 0;
      for (let n = 0; n < count; n++) {
        const [first, end] = rangeOf(n);
        if (fs.existsSync(chunkPath(n, stacked))) {
          render.drawn += end - first;
          continue;
        }
        queue.push(n);
        for (let index = first; index < end; index++) {
          if (fs.existsSync(join(frames, frameName(index)))) render.drawn += 1;
          else toDraw += 1;
        }
      }
      render.began = Date.now();
      render.from = render.drawn;
      // Room for what it holds at once (two chunks' frames, its chunks and the video joined from them), asked before it
      // draws, beside every other write under way (storage.ts claims), the disk's floor kept; the cleaner asked once.
      need = renderBytes(frame, toDraw, duration);
      let left = storage.spare(dir, need, WORK_FLOOR_BYTES);
      if (left < 0 && storage.askForRoom(storage.freeBytes(dir) - left) > 0) left = storage.spare(dir, need, WORK_FLOOR_BYTES);
      if (left < 0) throw new DiskShort(-left);
      claim.bytes = need;
      const pixels = frame.width * frame.height;
      const drawChunk = async (n: number) => {
        // The code changed while it rendered: these frames are an older version's.
        if (keyOf(app.store, id, folder(app.store, id, name), frame) !== key) throw new Outdated();
        const [first, end] = rangeOf(n);
        const wanted: number[] = [];
        for (let index = first; index < end; index++) if (!fs.existsSync(join(frames, frameName(index)))) wanted.push(index);
        // Something else took the disk to its floor meanwhile: refused here, never written into ENOSPC.
        const free = storage.freeBytes(dir);
        if (wanted.length > 0 && free - wanted.length * pixels * PNG_BYTES_A_PIXEL < WORK_FLOOR_BYTES) throw new DiskShort(WORK_FLOOR_BYTES + wanted.length * pixels * PNG_BYTES_A_PIXEL - free);
        // Each page draws its share (every page-th frame, so each works across the chunk) in a process of its own,
        // its PNGs never on the server's thread (frame_capture.ts); a page with no address of its own draws here.
        if (opened.every((page) => page.target !== undefined)) {
          await captureShares(opened, wanted, frame, frames, () => keyOf(app.store, id, folder(app.store, id, name), frame) !== key, (bytes) => {
            hold(bytes);
            render.drawn += 1;
          });
          return;
        }
        let next = 0;
        await Promise.all(
          opened.map(async (page) => {
            for (;;) {
              const index = wanted[next++];
              if (index === undefined) return;
              if (index % 60 === 0 && keyOf(app.store, id, folder(app.store, id, name), frame) !== key) throw new Outdated();
              const time = index / frame.fps;
              // A map's frame waits for its tiles while they keep coming (effect_map.html), the first ones longest.
              const drawn = await seekIn(page, time);
              if (drawn.error !== undefined) throw new Error(`its page threw at ${time.toFixed(2)} s: ${firstLines(drawn.error)}`);
              const shot = await page.call("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: { x: 0, y: 0, width: frame.width, height: frame.height, scale: 1 } }, 60_000);
              if (typeof shot.data !== "string") throw new Error(`Chrome drew nothing at ${time.toFixed(2)} s`);
              // Whole frames only: one cut short by a quit is drawn again.
              const path = join(frames, frameName(index));
              const png = Buffer.from(shot.data, "base64");
              fs.writeFileSync(`${path}.partial`, png);
              fs.renameSync(`${path}.partial`, path);
              hold(png.length);
              render.drawn += 1;
            }
          }),
        );
      };
      const encodeChunk = async (n: number) => {
        const [first, end] = rangeOf(n);
        const input = ["-framerate", rate, "-start_number", String(first), "-i", join(frames, "frame-%05d.png")];
        const limit = ["-frames:v", String(end - first)];
        try {
          if (!stacked && (await seeThrough(input, limit))) {
            stacked = true;
            writeAtomic(statePath, JSON.stringify({ stacked: true, software }));
            for (let m = 0; m < count; m++) {
              if (m === n || !fs.existsSync(chunkPath(m, false))) continue;
              hold(-fs.statSync(chunkPath(m, false)).size);
              fs.rmSync(chunkPath(m, false), { force: true });
              const [a, b] = rangeOf(m);
              render.drawn -= b - a;
              queue.push(m);
            }
          }
          const partial = join(frames, `chunk-${String(n).padStart(5, "0")}.partial.mp4`);
          const encode = () => tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...input, ...limit, ...encodeArgs(frame, stacked, software), "-an", partial], { background: true });
          try {
            await encode();
          } catch (error) {
            // The hardware encoder refused (NVENC busy or out of memory while the card is shared): this chunk and the
            // rest on libx264, as review copies do (reviews.ts), and the chunks it made before drawn again, as joined
            // they'd play with the first one's encoder setup. A full disk is the disk's, never the encoder's.
            const hardware = encoderHooks.hardware();
            if (software || hardware === null || outOfSpace(error) || outOfSpace(tools.saidOf(error))) throw error;
            software = true;
            writeAtomic(statePath, JSON.stringify({ stacked, software }));
            let again = 0;
            for (let m = 0; m < count; m++) {
              if (m === n || !fs.existsSync(chunkPath(m, stacked))) continue;
              hold(-fs.statSync(chunkPath(m, stacked)).size);
              fs.rmSync(chunkPath(m, stacked), { force: true });
              const [a, b] = rangeOf(m);
              render.drawn -= b - a;
              queue.push(m);
              again += 1;
            }
            diag.warn("effects", `${id}: ${name}'s frames didn't encode on ${hardware[1]} (${tools.saidOf(error)}): made with libx264 instead${again > 0 ? `, its ${again} chunks before drawn again` : ""}`);
            await encode();
          }
          fs.renameSync(partial, chunkPath(n, stacked));
          let freed = 0;
          for (let index = first; index < end; index++) {
            const path = join(frames, frameName(index));
            try {
              freed += fs.statSync(path).size;
              fs.rmSync(path);
            } catch {
              // Gone already.
            }
          }
          hold(fs.statSync(chunkPath(n, stacked)).size - freed);
        } catch (error) {
          if (error instanceof Outdated || error instanceof DiskShort) throw error;
          throw new Error(`its frames didn't join into a video: ${tools.saidOf(error)}`);
        }
      };
      // One chunk drawn while the one before it is encoded: at most two chunks' frames on the disk.
      let encoding: Promise<void> = Promise.resolve();
      let drawnThisTurn = 0;
      for (;;) {
        if (queue.length === 0) {
          await encoding;
          if (queue.length === 0) break;
        }
        // Another project's render goes first (render_turns.ts): this one gives way at a chunk's end, at least one chunk
        // drawn each turn, its chunks kept for its next turn, which goes on from them.
        if (drawnThisTurn > 0 && turn.shouldYield()) {
          await encoding;
          return true;
        }
        const n = queue.shift()!;
        // A play on this Mac comes first: the next chunk waits for it to stop (kenobi, Nov 17: a render's FFmpeg at
        // 160–400% CPU beside a cold play of Cops Found 3 Bodies); for a few seconds only when an export waits on it.
        await giveWayToPlay(render.project, render.name);
        await drawChunk(n);
        drawnThisTurn += 1;
        await encoding;
        encoding = encodeChunk(n);
        encoding.catch(() => {});
      }
    } finally {
      for (const page of opened) page.close();
    }
    const partial = join(dir, `${name}-${key}.partial.mp4`);
    // The joined video is as big as its chunks: room for it asked now, at their real size (its chunks are kept, so a
    // Retry once there's room only joins them).
    let chunkBytes = 0;
    for (let n = 0; n < count; n++) chunkBytes += fs.statSync(chunkPath(n, stacked)).size;
    need = chunkBytes;
    held = 0;
    claim.bytes = 0;
    let room = storage.spare(dir, chunkBytes, WORK_FLOOR_BYTES, claim);
    if (room < 0 && storage.askForRoom(storage.freeBytes(dir) - room) > 0) room = storage.spare(dir, chunkBytes, WORK_FLOOR_BYTES, claim);
    if (room < 0) throw new DiskShort(-room);
    claim.bytes = chunkBytes;
    try {
      const list = join(frames, "chunks.txt");
      fs.writeFileSync(list, `${Array.from({ length: count }, (_, n) => `file '${chunkPath(n, stacked).replaceAll("'", "'\\''")}'`).join("\n")}\n`);
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-an", "-movflags", "+faststart", partial]);
      fs.renameSync(partial, out);
      // Which encoder made it (Nov 22: whether a render was the card's or the processor's couldn't be told).
      diag.info("effects", `${id}: ${name}'s ${count} ${count === 1 ? "chunk" : "chunks"} joined, encoded with ${software ? "libx264" : (encoderHooks.hardware()?.[1] ?? "libx264")}`);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      throw new Error(`its frames didn't join into a video: ${tools.saidOf(error)}`);
    }
    fs.rmSync(frames, { recursive: true, force: true });
    return false;
  } catch (error) {
    // Outrun by the code: its frames are of a version nobody will play.
    if (error instanceof Outdated) fs.rmSync(frames, { recursive: true, force: true });
    throw error;
  } finally {
    claim.release();
  }
}

/** What a render found (`state.json`): see-through, so its chunks are stacked; the hardware encoder failed it, so they're libx264's. */
function readState(path: string): { stacked: boolean; software: boolean } {
  try {
    const read = JSON.parse(fs.readFileSync(path, "utf8")) as { stacked?: unknown; software?: unknown };
    return { stacked: read.stacked === true, software: read.software === true };
  } catch {
    return { stacked: false, software: false };
  }
}

/** A PNG drawn for speed: about one and a half bytes a pixel. */
const PNG_BYTES_A_PIXEL = 1.5;
/** About how much of its frames a render's chunk holds (`bytes`: two seconds of 1080p); a seam for tests. */
export const chunkHooks = { bytes: 200_000_000 };

/** Frames in a render's chunk: about `chunkHooks.bytes` of its frames, in whole keyframe intervals (half a second), one at least. */
export function chunkFrames(frame: { width: number; height: number; fps: number }): number {
  const gop = Math.max(1, Math.round(frame.fps / 2));
  const fit = Math.floor(chunkHooks.bytes / (frame.width * frame.height * PNG_BYTES_A_PIXEL));
  return gop * Math.max(1, Math.floor(fit / gop));
}

/**
 * How a render's frames are encoded (each chunk alike, so they join by a stream copy): at most twice the bitrate of
 * Edit's best export (export.rs: 0.14 bits a pixel), which is what the render goes into (uncapped, the agent's first
 * board, grain on every frame, was 204 MB for 12 s, too much to send up for the cloud); on the video hardware where
 * there is some (the encoder Edit's export uses: tools.hardwareH264; on a busy M1, libx264 took 75 s to join a 12 s
 * board's frames, Nov 11, kenobi), else libx264 by quality under the cap. Stacked, it's twice the pixels (the alpha
 * half costs little). Every render plays as it is, with no preview copy to seek in (a preview made of each, ~1 MB a
 * second, was thrown away once it went up): a keyframe every half second and no B-frames. Kept within H.264's 4096
 * lines: a 4K project's stack is half size.
 */
/** The hardware encoder a render's chunks are made on, null for libx264 (tests: one that fails). */
export const encoderHooks = { hardware: (): string[] | null => tools.hardwareH264() };

function encodeArgs(frame: { width: number; height: number; fps: number }, stacked: boolean, software = false): string[] {
  const cap = Math.round(frame.width * frame.height * frame.fps * 0.14 * 2);
  const hardware = software ? null : encoderHooks.hardware();
  const rate = stacked ? Math.round(cap * 1.5) : cap;
  const shrink = Math.min(1, 4096 / (frame.height * 2));
  const gop = ["-g", String(Math.max(1, Math.round(frame.fps / 2))), "-bf", "0"];
  const encode = hardware === null ? ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-maxrate", String(rate), "-bufsize", String(rate * 2)] : [...hardware, "-b:v", String(rate), "-maxrate", String(rate), "-bufsize", String(rate * 2)];
  const picture = stacked
    ? ["-filter_complex", `[0:v]format=rgba,split[c][m];[c]premultiply=inplace=1,format=rgb24[p];[m]alphaextract,format=rgb24[a];[p][a]vstack=inputs=2${shrink < 1 ? `,scale=${even(frame.width * shrink)}:${even(frame.height * 2 * shrink)}` : ""},${TO_VIDEO}`]
    : ["-vf", TO_VIDEO];
  return [...picture, ...encode, ...gop, ...VIDEO_TAGS];
}

/**
 * The room a render asks for before it draws: two chunks of its frames still to draw (one drawn while the one
 * before is encoded), and those chunks' video twice (each chunk, and its share of the video joined from them), at
 * most twice the best export's bitrate (as the encode caps it) and half as much again stacked. The whole video's
 * room is asked for at the join, at the chunks' real size (`drawAndJoin`): asked up front at the cap, an hour of
 * subtitles reserved about 30 GB for what's mostly see-through, and both of Sphe's M4 edits were refused with
 * 20 GB free (Nov 18); each chunk is already drawn only above the floor.
 */
export function renderBytes(frame: { width: number; height: number; fps: number }, frames: number, seconds: number): number {
  const inFlight = Math.min(seconds, (2 * chunkFrames(frame)) / frame.fps);
  const video = (inFlight * frame.width * frame.height * frame.fps * 0.14 * 2 * 1.5) / 8;
  return Math.ceil(Math.min(frames, 2 * chunkFrames(frame)) * frame.width * frame.height * PNG_BYTES_A_PIXEL + 2 * video);
}

/** The frames (RGB) as footage is: BT.709, video range, 4:2:0, and tagged so (the engine's fast path reads it as it is). */
const TO_VIDEO = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
const VIDEO_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/** Even, as H.264's 4:2:0 wants a size. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** Whether any of the frames (`input`: FFmpeg's arguments for them, `limit` how many) has a pixel less than opaque. */
async function seeThrough(input: string[], limit: string[] = []): Promise<boolean> {
  const out = new TextDecoder().decode(await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", ...input, ...limit, "-vf", "format=rgba,alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMIN:file=-", "-f", "null", "-"], { background: true }));
  return [...out.matchAll(/YMIN=(\d+)/g)].some((match) => Number(match[1]) < 255);
}

/** The command that draws a share of a render's frames (frame_capture.ts): the compiled `edit capture-frames`, or the file run by bun. */
function captureCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\");
  return compiled ? [process.execPath, "capture-frames"] : [process.execPath, join(import.meta.dir, "frame_capture.ts")];
}

/**
 * Draws `wanted` across `pages`, each page's share by a process of its own (frame_capture.ts), counting each frame as
 * it lands (`landed`, its PNG's size). Its code changing meanwhile (`outdated`, asked every 60 frames) stops them all.
 */
async function captureShares(pages: devtools.Page[], wanted: number[], frame: ReturnType<typeof frameOf>, dir: string, outdated: () => boolean, landed: (bytes: number) => void): Promise<void> {
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let counted = 0;
  let stale = false;
  const one = async (page: devtools.Page, indexes: number[]) => {
    if (indexes.length === 0) return;
    const spec: frameCapture.Spec = { target: page.target!, indexes, fps: frame.fps, width: frame.width, height: frame.height, dir, seekMs: waits.seekMs };
    const child = Bun.spawn(captureCommand(), { stdin: new Blob([JSON.stringify(spec)]), stdout: "pipe", stderr: "ignore" });
    children.push(child);
    let said: string | null = null;
    let rest = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      rest += decoder.decode(chunk, { stream: true });
      let at = rest.indexOf("\n");
      while (at >= 0) {
        const line = rest.slice(0, at);
        rest = rest.slice(at + 1);
        at = rest.indexOf("\n");
        let message: { index?: number; bytes?: number; error?: string };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.error !== undefined) said = message.error;
        else if (typeof message.bytes === "number") {
          landed(message.bytes);
          if (++counted % 60 === 0 && outdated()) {
            stale = true;
            for (const each of children) each.kill();
          }
        }
      }
    }
    const code = await child.exited;
    if (stale) throw new Outdated();
    if (said !== null) throw new Error(said);
    if (code !== 0) throw new Error(`its frames stopped being drawn (the drawing process ended with ${code})`);
  };
  try {
    await Promise.all(pages.map((page, at) => one(page, wanted.filter((_, k) => k % pages.length === at))));
  } finally {
    for (const child of children) child.kill();
  }
}

function frameName(index: number): string {
  return frameCapture.frameName(index);
}

/** The project's rate as FFmpeg reads it ("30", "30000/1001"). */
function rateArg(project: Project): string {
  const whole = Math.max(project.settings.fps, 1);
  return project.settings.ntsc === true ? `${whole * 1000}/1001` : String(whole);
}

/**
 * Renders, a few seconds after the code stops changing, every effect on the
 * project's timeline whose render isn't of its code now. Called on every
 * change to the project or its effects; cheap when there's nothing to do.
 */
/**
 * What runs before a project's effects are rendered (by name): what an effect
 * is given from the timeline made again where it changed (effect_inputs.ts:
 * the picture beneath it), so its code, and so its render, is of what's there.
 */
export const beforeRenders = new Map<string, (app: App, project: string, only?: ReadonlySet<string>) => Promise<void>>();

/**
 * V2's cloud's fonts read once since Edit started (after its sign-in is back):
 * a render's key has the fonts its page uses, and with none read yet an effect
 * drawn in a library font looked changed at every start, its render replaced
 * by the clear still and its cloud copy dropped, then made again (Nov 13 audit).
 */
let fontsRead: Promise<void> | null = null;
function cloudFontsRead(app: App): Promise<void> {
  fontsRead ??= accounts
    .tokenWhenReady()
    .catch(() => null)
    .then(() => fonts.refreshCloud(app.store, true))
    .then(
      () => {},
      () => {},
    );
  return fontsRead;
}

async function readyToRender(app: App, project: string, only?: ReadonlySet<string>): Promise<void> {
  await cloudFontsRead(app);
  // Code here older than the render another computer made comes down first: never drawn again over it.
  await bringDown(app, project).catch(() => []);
  await rekey(app, project).catch((error: unknown) => diag.warn("effects", `${project}: its renders' keys: ${diag.messageOf(error)}`));
  // Its own fonts kept in the cloud by the computer editing it, those from before they were kept there among them.
  if (editingHere(app, project)) await fonts.keepUp(app.store, project).catch((error: unknown) => diag.warn("effects", `${project}: its fonts didn't go to the cloud: ${diag.messageOf(error)}`));
  for (const [what, before] of beforeRenders) {
    await before(app, project, only).catch((error: unknown) => diag.warn("effects", `${project}: before its renders (${what}): ${diag.messageOf(error)}`));
  }
}

/**
 * A project's renders against its code here, before anything is drawn: code
 * older than the render another computer made brought down (`bringDown`),
 * a render's key from before Nov 16 written anew (`rekey`), and a render
 * older than the code here swapped for the clear still (`standIn`). Judged
 * only once the fonts a key has are known (`cloudFontsRead`).
 */
export async function bringUpToDate(app: App, project: string): Promise<void> {
  await cloudFontsRead(app);
  await bringDown(app, project).catch(() => []);
  await rekey(app, project);
  await standIn(app, project);
}

export function renderSoon(app: App, project: string): void {
  bringUpToDate(app, project).catch((error: unknown) => diag.warn("effects", `${project}: its effects' clear pictures: ${diag.messageOf(error)}`));
  const waiting = settling.get(project);
  if (waiting !== undefined) clearTimeout(waiting);
  const timer = setTimeout(() => {
    settling.delete(project);
    prepareAndRender(app, project);
  }, SETTLE_MS);
  timer.unref?.();
  settling.set(project, timer);
}

/**
 * Projects being made ready to render (`readyToRender`), and whether they
 * changed again meanwhile. One pass a project at a time: each change starting
 * its own pass piled them up in the one line what's beneath is made in (Nov 20:
 * Boyfriends' cleaned strips landing one after another queued pass on pass over
 * its 40 keylines, and no project's effect rendered for two hours).
 */
const preparing = new Map<string, { again: boolean }>();

function prepareAndRender(app: App, project: string): void {
  const running = preparing.get(project);
  if (running !== undefined) {
    running.again = true;
    return;
  }
  // Made ready and drawn by itself only where the project is being edited: its render is written into the project (an
  // export asked for here makes it ready and waits for it all the same, `waitForRenders`). Elsewhere what's beneath its
  // graphics was made again at every change that came down for nothing drawn after (Nov 28, the Mac: BERSERK, held by
  // nobody there, kept its graphics' footage exporting for hours and Gen Alpha's export went at half speed beside it).
  if (!editingHere(app, project)) return;
  const pass = { again: false };
  preparing.set(project, pass);
  void readyToRender(app, project)
    .then(() => {
      if (!editingHere(app, project)) return;
      const due = needed(app.store, project).filter((one) => !one.fresh && one.current !== null);
      // Its code in the cloud before it's drawn: a render can take long, or never finish here. Not while a newer change
      // is still settling (it landed while this pass made ready): the pass that change starts keeps it (PR #14's CodeRabbit review).
      if (!settling.has(project)) for (const effect of due) void keepVersion(app, project, effect.name, effect.current!.key, "settled");
      for (const effect of startable(app.store, project, due)) {
        renderNow(app, project, effect.name).catch(() => {});
      }
    })
    .catch((error: unknown) => diag.warn("effects", `${project}: its renders didn't start: ${diag.messageOf(error)}`))
    .finally(() => {
      preparing.delete(project);
      if (pass.again) prepareAndRender(app, project);
    });
}

/** What the agent is told of an effect's render: null while the effect isn't on the timeline (nothing renders it then). */
export function renderLine(app: App, project: string, name: string): string | null {
  const effect = needed(app.store, project).find((one) => one.name === name);
  if (effect === undefined) return null;
  if (effect.fresh) return "Its render is of this code: that's what plays and exports.";
  const state = effect.current === null ? null : renderState(project, name, effect.current.key);
  // A failure said here isn't said again with the next message (`untoldFailures`).
  if (effect.current !== null && state?.startsWith("its render failed") === true) untold.delete(id(project, name, effect.current.key));
  return state === null ? "Its render follows a few seconds after the code stops changing; until then the viewer plays the code live, and Edit's frames (render_frame, contact_sheet) show nothing of it: look_at_effect does." : `Its render: ${state}.`;
}

/** What an effect's render is doing, for the agent and the person: null when there's nothing to say. */
export function renderState(project: string, name: string, key: string): string | null {
  const running = renders.get(id(project, name, key));
  if (running !== undefined) {
    // One render draws at a time: another's holds the place (this one's turn may come again, its frames kept).
    const ahead = holding;
    if (ahead !== null && !underWay(running)) {
      const behind = ahead.project === project ? `waiting behind the ${ahead.name} effect's render` : `waiting behind ${ahead.title}'s render`;
      return running.frames > 0 ? `${behind} (${running.drawn} of ${running.frames} frames drawn)` : behind;
    }
    if (running.frames > 0) return `rendering, ${running.drawn} of ${running.frames} frames`;
    return "rendering";
  }
  const failure = failureOf(id(project, name, key));
  if (failure?.kind === "network") return `not made yet: the connection dropped while it rendered (${failure.said.replace(/[.\s]+$/u, "")}); nothing in its code to fix, it renders again by itself once Edit's relay answers`;
  if (failure === undefined) return null;
  // Without its last full stop: the line it's in ends with one (`renderLine`).
  return noWebgl(failure.said) ? `its render failed: ${failure.said.replace(/[.\s]+$/u, "")}. ${NO_WEBGL_LINE.replace(/\.$/u, "")}` : `its render failed: ${failure.said}`;
}

/**
 * What the agent is told with the person's next message of a V2 project's
 * effects whose render of their code as it is failed for the code's sake (a
 * passing failure Edit tries again itself; a full disk is the person's): each
 * failure once, and none of code that has changed since. Read once a turn
 * goes (media_tools.messageContext).
 */
export function untoldFailures(app: App, project: string): string[] {
  const out: string[] = [];
  for (const effect of needed(app.store, project)) {
    if (effect.fresh || effect.current === null) continue;
    const said = untold.get(id(project, effect.name, effect.current.key));
    if (said !== undefined) out.push(`The ${effect.name} effect's render failed: ${said.replace(/[.\s]+$/u, "")}. Fix its code, then check it with look_at_effect.`);
  }
  for (const render of [...untold.keys()]) if (render.startsWith(`${project}/`)) untold.delete(render);
  return out;
}

/** The longest an export waits for what comes before its renders (what's beneath each graphic), however short its own limit. */
const PREPARE_MS = 20 * 60_000;

/**
 * What comes before the renders, waited for no longer than the export would wait and never past its Cancel: this wait
 * had neither, so a step that never came back held the share at "waiting" with nothing said (Nov 23, 14:10 and 14:29).
 */
async function preparedFor(work: Promise<void>, limitMs: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.max(limitMs, PREPARE_MS));
    timer.unref?.();
  });
  const aborted = new Promise<"cancelled">((resolve) => {
    onAbort = () => resolve("cancelled");
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  // One given up on still ends by itself, in the log if it fails.
  work.catch(() => {});
  try {
    const ended = await Promise.race([work.then(() => "ready" as const), late, aborted]);
    if (ended === "cancelled") throw new Error("cancelled while waiting for its graphics");
    if (ended === "late") throw new Error("Its graphics are still rendering: export again in a minute or two.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Waits (up to `limitMs`) for every effect on the timeline to be rendered from
 * its code as it is, starting any render that isn't under way: an export never
 * goes out with a still, or an older version, where an effect is. An error
 * says which effect and why. With `range` (an export of those frames) only the
 * graphics it shows: a 65-second export waited on "interview-audio (then 5
 * more)", a quarter of an hour of graphics after the part it was of (Nov 23).
 */
export async function waitForRenders(app: App, project: string, limitMs: number, signal?: AbortSignal, range?: readonly [number, number] | null): Promise<void> {
  const until = Date.now() + limitMs;
  // Every render it waits on is waited on from now (render_turns.ts: it goes ahead of renders nobody waits on, another
  // project's long one giving way at its next chunk), started now if it isn't under way.
  const held: (() => void)[] = [];
  let abortWait = () => {};
  // Its asker's Cancel (a share's) ends the wait, and lets go of the renders it put ahead of others (the Nov 21 audit).
  const aborted = new Promise<"cancelled">((resolve) => {
    abortWait = () => resolve("cancelled");
    if (signal?.aborted === true) abortWait();
    else signal?.addEventListener("abort", abortWait, { once: true });
  });
  try {
    // In rounds, lowest lane first: a graphic drawn over another starts once that one has landed (`startable`), its
    // picture of what's beneath made then. A round for each graphic at most, and what's still not drawn then is refused
    // by the export itself (`notReady`).
    const rounds = needed(app.store, project).length + 2;
    for (let round = 0; round < rounds; round++) {
      const live = app.store.get(project);
      const only = range === undefined || range === null || live === null ? undefined : graphicsIn(app.store, live.project, range);
      await preparedFor(readyToRender(app, project, only), limitMs, signal);
      const todo = needed(app.store, project).filter((effect) => !effect.fresh && (only === undefined || only.has(effect.name)));
      if (todo.length === 0) return;
      for (const effect of todo) {
        if (effect.current === null) throw new Error(`The ${effect.name} effect was made on another computer and never rendered there: open the project there to render it.`);
      }
      // Those that only now need drawing (one over a graphic that has just landed) are on its steps too.
      const noted = waitedOn.get(project);
      if (noted !== undefined) for (const effect of todo) if (!noted.includes(effect.name)) noted.push(effect.name);
      const waits: { effect: (typeof todo)[number]; done: Promise<void> }[] = [];
      for (const effect of startable(app.store, project, todo)) {
        held.push(waitOn(project, effect.name));
        const done = renderNow(app, project, effect.name);
        // Said when its turn in the loop below comes; one failing before then isn't a rejection nobody heard.
        done.catch(() => {});
        waits.push({ effect, done });
      }
      for (const { effect, done } of waits) {
        const left = until - Date.now();
        const timedOut = await Promise.race([done.then(() => false), Bun.sleep(Math.max(0, left)).then(() => true), aborted]);
        if (timedOut === "cancelled") throw new Error("cancelled while waiting for its graphics");
        if (timedOut) {
          const state = renderState(project, effect.name, effect.current!.key);
          if (state !== null && state.startsWith("waiting behind")) throw new Error(`The ${effect.name} effect is ${state}: export again once it's done.`);
          throw new Error(`The ${effect.name} effect is still rendering${state !== null && state.startsWith("rendering,") ? ` (${state.slice("rendering, ".length)})` : ""}: export again in a minute or two.`);
        }
      }
      for (const done of held.splice(0)) done();
    }
  } finally {
    signal?.removeEventListener("abort", abortWait);
    for (const done of held) done();
  }
}

/**
 * Why an export of `project` (the edit it's of, as it was taken) from frame
 * `start` to `end` can't go out yet, or null: an effect it shows that has no
 * render, or whose render isn't of its code here. Checked on the edit the
 * export is made of (exports.ts `start`), whichever way it was asked for, so
 * none goes out with a clear still or an older version where an effect is.
 */
export function notReady(store: Store, project: Project, start = 0, end = Number.POSITIVE_INFINITY): string | null {
  if (project.hq !== true) return null;
  const shown = new Set(project.clips.filter((clip) => (clip.type === "video" || clip.type === "audio") && clip.start < end && clip.start + clip.duration > start).map((clip) => (clip as { media: string }).media));
  const effects = list(store, project.id);
  for (const media of project.media) {
    const name = media.effect;
    if (name === undefined || name === null || !shown.has(media.id)) continue;
    const current = effects.find((one) => one.name === name) ?? null;
    if (typeof media.effect_key !== "string") {
      return current === null ? `The ${name} effect was made on another computer and never rendered there: open the project there to render it.` : `The ${name} effect is still rendering: export again in a minute or two.`;
    }
    if (current !== null && !sameCode(project.id, name, media.effect_key, current)) return `The ${name} effect is still rendering: export again in a minute or two.`;
  }
  return null;
}

/** The Edit the effects run in (`start`): an export reaches the renders through it (`remake`). */
let appHere: App | null = null;

/**
 * An effect's render an export of `project` found gone, or couldn't read
 * (`unreadable`): Edit's own file, so it's made again here (or brought back
 * from this computer's copy of it) and the export carries on from the chunks
 * it made, never sending the person to download it again (Sphe's M4, Nov 17:
 * "Edit can't read that video … import it again" for cutfx-10's render, 9
 * minutes into an export). Only a render of the code here: code changed
 * since is a new render, which the export says it waits for.
 */
export async function remake(project: string, name: string, key: string, unreadable: boolean): Promise<void> {
  const app = appHere;
  if (app === null) throw new Error(`the ${name} effect's render can't be made on this computer now`);
  const live = app.store.get(project);
  if (live === null) throw new Error("the project is gone");
  const media = live.project.media.find((one) => one.effect === name);
  if (media === undefined) throw new Error(`the ${name} effect isn't in the edit any more: export again`);
  const file = `${name}-${key}.mp4`;
  const out = join(rendersDir(app.store, project), file);
  const cached = effectCloud.cachePath(app.store.cacheDir(), effectCloud.keyOf(project, file));
  if (unreadable) {
    // Whichever copy it read: the same file linked in both places, or one of them. Drawn again from the code below.
    diag.warn("effects", `${project}: ${name}'s render ${file} couldn't be read by an export; drawing it again`);
    fs.rmSync(out, { force: true });
    fs.rmSync(cached, { force: true });
  } else if (media.effect_key === key) {
    // Here after all, where the edit has it now: the export reads it from there.
    if (fs.existsSync(media.path)) return;
    // The cache's copy of it: linked back where the edit reads it.
    if (media.path === out && effectCloud.bringBack(app.store.cacheDir(), project, file, out)) return;
  }
  const current = list(app.store, project).find((one) => one.name === name) ?? null;
  if (current === null) throw new Error(`the ${name} effect's render isn't on this computer and its code isn't either: open the project where it was made`);
  if (!sameCode(project, name, key, current)) throw new Error(`The ${name} effect is still rendering: export again in a minute or two.`);
  // An export waits on it: it goes first.
  const done = waitOn(project, name);
  try {
    await renderNow(app, project, name);
  } finally {
    done();
  }
}

/** Whether a file of a project's renders (`<name>-<key>.frames`, `.partial.mp4`) is a render's under way or waiting to go on (effect_cloud.ts's sweep leaves it). */
function rendering(project: string, file: string): boolean {
  for (const render of renders.values()) if (render.project === project && file.startsWith(`${render.name}-${render.key}.`)) return true;
  return false;
}
effectCloud.renderingNow.is = rendering;

/**
 * From Edit's start: every change to a project made the new way (a clip of an
 * effect placed, a file of one saved) brings its renders up to date, and the
 * ones left undone when Edit last closed are made.
 */
export function start(app: App): void {
  appHere = app;
  changed = (project) => renderSoon(app, project);
  // A project opened again here, nothing changed in it: what wasn't drawn while another computer (or nobody) held it is
  // drawn now (Nov 16, the M4: an effect brought down after its project was closed again never rendered on reopening).
  // What was looked for in V2's cloud while another computer edited it is asked again (PR #14's Codex review: code
  // settled there, never rendered, was otherwise not asked for until a restart).
  // Its renders' code kept too once it has caught up with the cloud's (PR #14's Codex review: a project opened without
  // its lock skipped that on start, and nothing kept it after).
  cloudProjects.hooks.held = (project) => {
    tookOver(project);
    if (app.store.get(project)?.project.hq !== true) return;
    renderSoon(app, project);
    void bringDown(app, project)
      .catch(() => [])
      .then(() => keepRendered(app, project));
  };
  app.store.subscribe((event) => {
    if (event.type !== "project" || typeof event.id !== "string" || event.origin === "effects") return;
    if ((event.project as Project | undefined)?.hq === true) renderSoon(app, event.id);
  });
  for (const summary of app.store.list()) {
    if (summary.hq !== true) continue;
    watch(app.store, summary.id);
    renderSoon(app, summary.id);
  }
  // Once the kept sign-in is back (a second or so in: before it, there's no cloud), what V2's cloud and this computer each lack.
  void accounts
    .tokenWhenReady()
    .catch(() => null)
    .then(async () => {
      for (const summary of app.store.list()) {
        if (summary.hq !== true) continue;
        await bringDown(app, summary.id);
        keepRendered(app, summary.id);
      }
    });
}

/** The effects already rendered from their code as it is kept in V2's cloud too, those from before it was (Nov 11) among them: what's there already isn't sent again. */
function keepRendered(app: App, project: string): void {
  // Only where it's edited: a computer watching another's edit kept its own older render over the code settled there
  // (PR #14's CodeRabbit review).
  if (!editingHere(app, project)) return;
  // Just taken over: only the effects brought up to the cloud's version since (one that couldn't be asked may be older).
  const catching = catchingUp.get(project);
  for (const effect of needed(app.store, project)) {
    if (catching !== undefined && !catching.has(effect.name)) continue;
    if (effect.fresh && effect.current !== null) void keepVersion(app, project, effect.name, effect.current.key);
  }
}
