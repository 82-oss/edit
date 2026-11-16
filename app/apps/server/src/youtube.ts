// YouTube footage for script imports: a Doc's ranges can link YouTube as
// well as Drive. A YouTube video is a script file named `youtube:<video id>`
// (Drive ids never hold a colon). It's downloaded whole with yt-dlp (H.264 up
// to 1080p, as YouTube serves it without a sign-in, and the original sound,
// never a dub), then cut into excerpts like a Drive file: on this disk
// (`script.footageToDisk`), or put on R2 as `youtube:<id>` and cut there
// (`cloud_media`).
//
// yt-dlp: `EDIT_YTDLP`, else on PATH, else `<home>/bin/yt-dlp` (the release
// for macOS from GitHub, checked against its SHA2-256SUMS, fetched on first
// use). Every run names a JavaScript runtime (`--js-runtimes` below), which
// YouTube extraction now needs.
//
// How YouTube is asked (Sphe, Nov 16, after JJ's Mac was refused everywhere
// for 40 minutes and his downloads got through only on his own YouTube
// sign-in): a question (captions, details, a search) goes through the proxy
// first; footage comes straight from this Mac first (it's free, and faster),
// then through the proxy. Each try through the proxy goes out from an address
// of its own (`session`). Once YouTube refuses this Mac's address, nothing in
// Edit asks from it for ten minutes. The person's YouTube sign-in is only for
// a video that needs one (age, members), never to get past a bot check. When
// every address is refused, a download waits and tries again by itself
// (`timing.waveWaits`): YouTube's refusals come in waves that pass. The proxy
// URL is a credential: never in a log line or an error.

import * as fs from "node:fs";

import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as diag from "./diag.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import * as relay from "./relay.ts";
import * as tools from "./tools.ts";
import { compiled } from "./update.ts";
import { cookieArgs, supported as signInSupported } from "./youtube_signin.ts";
import { join, parent } from "./paths.ts";
import { THIS_MACHINE } from "./machine.ts";

/** The prefix of a script file that's a YouTube video. */
export const PREFIX = "youtube:";

/** The video id in a YouTube link (watch?v=, youtu.be/, /shorts/, /live/, /embed/), else null. */
export function videoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = parsed.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = parsed.pathname.split("/").filter((part) => part !== "");
    if (parts[0] === "watch") id = parsed.searchParams.get("v");
    else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
  }
  return id !== null && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** The script file a YouTube link names, else null. */
export function fileOf(url: string): string | null {
  const id = videoId(url);
  return id === null ? null : `${PREFIX}${id}`;
}

/** The video id of a script file that's a YouTube video, else null. */
export function idOf(file: string): string | null {
  if (!file.startsWith(PREFIX)) return null;
  const id = file.slice(PREFIX.length);
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** A YouTube `t` (`86`, `86s`, `1m26s`, `1h2m3s`) in seconds, else null. */
export function startOf(t: string): number | null {
  const plain = /^(\d+(?:\.\d+)?)s?$/.exec(t);
  if (plain !== null) return Number(plain[1]);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (parts === null || t === "") return null;
  return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
}

// ---------------------------------------------------------------------------
// yt-dlp.

const RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
/** yt-dlp's build for this machine (Nov 7: Linux was handed the macOS one, and every YouTube import failed). */
const ASSET = process.platform === "darwin" ? "yt-dlp_macos" : process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
/** How often Edit's yt-dlp is checked against the newest release. */
const FRESH_MS = 24 * 3600_000;
let fetching: Promise<string> | null = null;

/**
 * The yt-dlp to run: `EDIT_YTDLP`, else Edit's own copy, kept current. Never
 * one found on PATH first: a Homebrew yt-dlp two months old (this Mac, Oct
 * 28) broke YouTube imports the way YouTube breaks every old yt-dlp, and
 * nobody knew it was the one running. PATH is only the last resort, when
 * GitHub can't be reached and Edit has no copy yet.
 */
export async function ytdlp(home: string): Promise<string> {
  const set = process.env.EDIT_YTDLP;
  if (set !== undefined && set !== "") return set;
  const own = join(home, "bin", "yt-dlp");
  if (fs.existsSync(own)) {
    // Checked once a day, in the background: this run uses the copy there is.
    if (stale(own)) void freshen(own, false).catch((error) => diag.warn("youtube", `checking for a newer yt-dlp: ${diag.messageOf(error)}`));
    return own;
  }
  try {
    return await freshen(own, true);
  } catch (error) {
    const found = Bun.which("yt-dlp");
    if (found !== null) {
      diag.warn("youtube", `couldn't fetch yt-dlp (${diag.messageOf(error)}); using ${found} for now`);
      return found;
    }
    throw error;
  }
}

function stale(path: string): boolean {
  try {
    return Date.now() - fs.statSync(path).mtimeMs > FRESH_MS;
  } catch {
    return true;
  }
}

/**
 * Brings Edit's yt-dlp up to the newest release (checksum-verified): only the
 * small checksum list is fetched when it's current already. `force` checks
 * even when it was checked today. Returns its path.
 */
export function freshen(to: string, force: boolean): Promise<string> {
  if (!force && !stale(to)) return Promise.resolve(to);
  fetching ??= fetchYtdlp(to).finally(() => {
    fetching = null;
  });
  return fetching;
}

/** Whether yt-dlp's words say it's out of date for what YouTube does now (a newer yt-dlp is the fix). */
export function outdated(stderr: string): boolean {
  return /Unable to extract|nsig extraction failed|[Ss]ignature extraction failed|n challenge|Precondition check failed|Confirm you are on the latest version|please report this issue/i.test(stderr);
}

async function fetchYtdlp(to: string): Promise<string> {
  return diag.timeOnAsync("youtube", "youtube: fetch yt-dlp", to, async () => {
    const get = async (name: string): Promise<Uint8Array> => {
      const response = await fetch(`${RELEASE}/${name}`, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`fetching yt-dlp: ${response.status} for ${name}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const sums = await get("SHA2-256SUMS");
    const line = new TextDecoder()
      .decode(sums)
      .split("\n")
      .find((row) => row.trim().endsWith(` ${ASSET}`));
    const expected = line?.trim().split(/\s+/)[0];
    if (expected === undefined) throw new Error(`yt-dlp's release has no checksum for ${ASSET}`);
    // Current already: only noted as checked.
    if (fs.existsSync(to) && new Bun.CryptoHasher("sha256").update(fs.readFileSync(to)).digest("hex") === expected) {
      const now = new Date();
      fs.utimesSync(to, now, now);
      return to;
    }
    const binary = await get(ASSET);
    const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
    if (expected !== actual) throw new Error("the yt-dlp download didn't match its checksum");
    fs.mkdirSync(parent(to)!, { recursive: true });
    const part = `${to}.part-${process.pid}`;
    fs.writeFileSync(part, binary, { mode: 0o755 });
    fs.renameSync(part, to);
    diag.info("youtube", `yt-dlp updated to the newest release`);
    return to;
  });
}

/**
 * Where yt-dlp finds FFmpeg (it merges the picture and the sound): a path,
 * never a bare name, which yt-dlp takes for a missing FFmpeg and then leaves
 * the streams unmerged without a word under --no-warnings.
 */
function ffmpegArgs(): string[] {
  const tool = tools.ffmpeg();
  const path = tool.includes("/") ? tool : Bun.which(tool);
  return path === null ? [] : ["--ffmpeg-location", path];
}

/**
 * yt-dlp's JavaScript runtime for YouTube's challenges, named explicitly
 * with its path (`--js-runtimes <name>:<path>`): without one YouTube hands
 * back only storyboard images and no video, and yt-dlp enables only deno by
 * default. The qjs bundled with Edit (`tools.qjs`, QuickJS-ng) first, so a
 * packaged Edit always has one; then a runtime installed on this Mac (deno,
 * node, bun, quickjs); then, in a compiled build with none of those, the
 * `edit` binary itself, which is Bun under BUN_BE_BUN=1 (see `runtimeEnv`).
 * Nobody using Edit installs a runtime for this.
 */
function jsRuntime(): [name: string, path: string] | null {
  const bundled = tools.qjs();
  if (bundled !== null) return ["quickjs", bundled];
  for (const [name, program] of [
    ["deno", "deno"],
    ["node", "node"],
    ["bun", "bun"],
    ["quickjs", "qjs"],
    ["quickjs", "quickjs"],
  ] as const) {
    const path = Bun.which(program);
    if (path !== null) return [name, path];
  }
  if (compiled()) return ["bun", process.execPath];
  return null;
}

export function runtimeArgs(): string[] {
  const runtime = jsRuntime();
  return runtime === null ? [] : ["--js-runtimes", `${runtime[0]}:${runtime[1]}`];
}

/** yt-dlp's environment: BUN_BE_BUN=1 when it runs `edit` as its Bun. */
export function runtimeEnv(args: string[]): Record<string, string | undefined> | undefined {
  return args.some((arg) => arg.startsWith("bun:")) ? { ...process.env, BUN_BE_BUN: "1" } : undefined;
}

// H.264 (the hardware decodes it everywhere; YouTube's AV1 doesn't on an M1)
// over plain HTTPS, up to 1080p, with the original sound: yt-dlp ranks the
// original track above YouTube's dubs. A progressive MP4 when there's no DASH.
// The last resort still asks for a video: a route YouTube is withholding
// formats from offers only storyboards, and a bare `b` would take one and
// call it a download.
const FORMAT = "bv*[vcodec^=avc1][height<=1080][protocol=https]+ba[ext=m4a][protocol=https]/b[vcodec^=avc1][ext=mp4]/bv*[height<=1080]+ba/b[vcodec!=none]";
/** Through the paid proxy ($1/GB): at most 720p, about half the bytes of 1080p (the audit, Oct 23). */
const PROXY_FORMAT = "bv*[vcodec^=avc1][height<=720][protocol=https]+ba[ext=m4a][protocol=https]/b[vcodec^=avc1][ext=mp4][height<=720]/bv*[height<=720]+ba/b[height<=720][vcodec!=none]";

// ── Why a try failed (in Effect since Nov 1) ──
//
// The routes were fixed seven times in eight days (cac57fd0, 94e49c77,
// db3f473d, 3b3cb78d, 88b0d2ce, 8c25e077, 597f55ae), each one for a way
// yt-dlp failed that the list of retryable words didn't know yet, which
// stopped the whole download at its first try (Oct 31, Kroger: "yt-dlp
// stopped part-way (exit 1)", the proxy and the sign-in never tried). Now a
// try's output is read once into the reason it failed (`reasonOf`), and what
// each reason does is one table (`afterFailure`): only a video that's gone,
// or one only a signed-in YouTube can have, stops the routes. Anything else,
// a wording nobody has seen yet included, goes on to the next route.

/** The video itself can't be had (taken down, private, blocked): no route helps. */
export class VideoGone extends Schema.TaggedError<VideoGone>()("VideoGone", { line: Schema.String }) {}
/** Only a signed-in YouTube can have it (age, members, private): the sign-in route, or nothing. */
export class NeedsSignIn extends Schema.TaggedError<NeedsSignIn>()("NeedsSignIn", { line: Schema.String }) {}
/** YouTube changed and this yt-dlp doesn't know yet: the newest one, and the same route again. */
export class YtdlpOutdated extends Schema.TaggedError<YtdlpOutdated>()("YtdlpOutdated", { line: Schema.String }) {}
/** YouTube refused this route (a bot check, 403s, 429s): the next one. */
export class RouteRefused extends Schema.TaggedError<RouteRefused>()("RouteRefused", { line: Schema.String }) {}
/** The route gave no video (formats withheld, only storyboards, no JavaScript runtime): the next one. */
export class NoVideoHere extends Schema.TaggedError<NoVideoHere>()("NoVideoHere", { line: Schema.String }) {}
/** The download stopped part-way (a dropped connection, a refused fragment): the next route, carrying on from the bytes here. */
export class StoppedPartWay extends Schema.TaggedError<StoppedPartWay>()("StoppedPartWay", { line: Schema.String }) {}
/** yt-dlp said nothing for too long and was stopped: the next route. */
export class StoodStill extends Schema.TaggedError<StoodStill>()("StoodStill", { line: Schema.String }) {}
/** A failure none of the above knows: the next route, never the last word. */
export class Unrecognised extends Schema.TaggedError<Unrecognised>()("Unrecognised", { line: Schema.String }) {}

export type TryFailure = VideoGone | NeedsSignIn | YtdlpOutdated | RouteRefused | NoVideoHere | StoppedPartWay | StoodStill | Unrecognised;

/** Every route was tried, or none could help: the reason the last one failed. */
export class DownloadFailed extends Schema.TaggedError<DownloadFailed>()("DownloadFailed", { reason: Schema.String, message: Schema.String }) {}

/** Whether yt-dlp's words say YouTube refused this Mac (worth the proxy). */
function refused(stderr: string): boolean {
  return /not a bot|HTTP Error 403|HTTP Error 429|Sign in to confirm|page needs to be reloaded/i.test(stderr);
}

/**
 * Whether this route gave no video (formats withheld, only storyboard images
 * offered, or no JavaScript runtime to answer YouTube's challenge). Read on
 * the ERROR line, not the whole output: a WARNING naming the missing runtime
 * beside a real error (a private video) must not make that error retryable.
 */
function noVideo(stderr: string): boolean {
  return /requested format is not available|only images are available|did not produce a video|javascript runtime/i.test(errorLine(stderr));
}

/** Whether a download stopped part-way (a connection dropped or timed out, a fragment refused mid-video, yt-dlp giving up after its own retries). */
function partWay(stderr: string): boolean {
  return /stopped part-way|nothing came down|connection reset|timed out|IncompleteRead|urlopen error|Remote end closed|did not get any data|giving up after|Got error|fragment/i.test(errorLine(stderr));
}

/** Whether the video itself can't be had (taken down, private, blocked): no route helps. */
function gone(stderr: string): boolean {
  return /Video unavailable|has been removed|no longer available|copyright|Private video|This video is private|does not exist|terminated/i.test(stderr);
}

/** Whether a video needs a signed-in YouTube (age, members, private): only the sign-in can help. */
function needsSignIn(stderr: string): boolean {
  return /confirm your age|age.restricted|members.only|Join this channel|Private video|This video is private/i.test(errorLine(stderr));
}

/** yt-dlp's error line, without anything credential-like. */
function errorLine(stderr: string): string {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  // Say the ERROR, not a WARNING that happened to come first in its output.
  const error = [...lines].reverse().find((line) => line.toUpperCase().includes("ERROR")) ?? lines[lines.length - 1] ?? "yt-dlp failed";
  return diag.scrub(error.replace(/^ERROR:\s*/, "").replace(/https?:\/\/[^\s@]*@[^\s]*/g, "<proxy>"));
}

/** Why a try failed, read once from what yt-dlp said, in this order: the sign-in, gone, outdated, then what another route can help. */
export function reasonOf(stderr: string): TryFailure {
  const line = errorLine(stderr);
  if (needsSignIn(stderr)) return new NeedsSignIn({ line });
  if (gone(stderr)) return new VideoGone({ line });
  if (outdated(stderr)) return new YtdlpOutdated({ line });
  if (stderr.includes(STOOD_STILL)) return new StoodStill({ line });
  if (refused(stderr)) return new RouteRefused({ line });
  if (noVideo(stderr)) return new NoVideoHere({ line });
  if (partWay(stderr)) return new StoppedPartWay({ line });
  return new Unrecognised({ line });
}

/** What a failed try leads to: the next route, the sign-in route, the same route with the newest yt-dlp, or the end. */
type Next = { readonly to: "next" } | { readonly to: "sign-in" } | { readonly to: "update" } | { readonly to: "stop" };

export function afterFailure(reason: TryFailure): Next {
  switch (reason._tag) {
    case "VideoGone":
      return { to: "stop" };
    case "NeedsSignIn":
      return { to: "sign-in" };
    case "YtdlpOutdated":
      return { to: "update" };
    case "RouteRefused":
    case "NoVideoHere":
    case "StoppedPartWay":
    case "StoodStill":
    case "Unrecognised":
      return { to: "next" };
  }
}

export interface Downloaded {
  path: string;
  name: string;
  size: number;
}

const running = new Map<string, Promise<Downloaded>>();

/**
 * The wait before asking YouTube again, how long yt-dlp may say nothing
 * before it's stopped, and the waits before a download every address was
 * refused for is tried again: YouTube refuses in waves (Nov 16: every fresh
 * address for a few minutes on mandalorian, everything for 40 minutes on JJ's
 * Mac), so about half an hour in all before it's given up. Tests make them short.
 */
export const timing = { pause: (ms: number): Promise<void> => Bun.sleep(ms), quiet: 10 * 60_000, waveWaits: [2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000] };

/** What a run stopped for saying nothing reads as. */
const STOOD_STILL = "ERROR: The download stood still";

/**
 * Downloads YouTube video `id` whole into `dir` (one download per video at a
 * time; a finished one is reused, a stopped one resumes), calling
 * `progress(bytes, total, name)` as it goes.
 */
export function download(
  home: string,
  id: string,
  dir: string,
  progress: (bytes: number, total: number | null, name: string) => void,
): Promise<Downloaded> {
  const key = join(dir, id);
  const already = running.get(key);
  if (already !== undefined) return already;
  const work = runPromise(downloadWhole(home, id, dir, progress).pipe(inArea("youtube"))).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

const downloadWhole = Effect.fn("youtube.download")(function* (home: string, id: string, dir: string, progress: Progress) {
  fs.mkdirSync(dir, { recursive: true });
  const done = join(dir, ".done");
  const kept = (() => {
    try {
      const name = fs.readFileSync(done, "utf8").trim();
      const path = join(dir, name);
      return name !== "" && fs.existsSync(path) ? { path, name, size: fs.statSync(path).size } : null;
    } catch {
      // Not downloaded yet.
      return null;
    }
  })();
  if (kept !== null) {
    progress(kept.size, kept.size, kept.name);
    return kept;
  }
  const path = yield* overRoutes(home, id, dir, 2, null, null, progress, `YouTube video ${id} couldn't be downloaded`);
  const name = path.slice(dir.length + 1);
  fs.writeFileSync(done, name);
  const size = fs.statSync(path).size;
  progress(size, size, name);
  return { path, name, size };
});

type Progress = (bytes: number, total: number | null, name: string) => void;

/**
 * Downloads the video on any other page yt-dlp reads (a post, a news site's
 * player, a direct link to a file) whole into `dir`, as `download` does a
 * YouTube video: one at a time per folder, a finished one reused, no length
 * or size limit, stopped only when it says nothing for `timing.quiet`. Asked
 * straight (the proxy and the sign-in are YouTube's), with yt-dlp brought up
 * to date once when it's too old for the site.
 */
export function downloadLink(home: string, url: string, dir: string, progress: Progress): Promise<Downloaded> {
  const already = running.get(dir);
  if (already !== undefined) return already;
  const work = runPromise(linkWhole(home, url, dir, progress).pipe(inArea("youtube"))).finally(() => running.delete(dir));
  running.set(dir, work);
  return work;
}

const linkWhole = Effect.fn("youtube.downloadLink")(function* (home: string, url: string, dir: string, progress: Progress) {
  fs.mkdirSync(dir, { recursive: true });
  const done = join(dir, ".done");
  const kept = (() => {
    try {
      const name = fs.readFileSync(done, "utf8").trim();
      const path = join(dir, name);
      return name !== "" && fs.existsSync(path) ? { path, name, size: fs.statSync(path).size } : null;
    } catch {
      // Not downloaded yet.
      return null;
    }
  })();
  if (kept !== null) {
    progress(kept.size, kept.size, kept.name);
    return kept;
  }
  let binary = yield* Effect.promise(() => ytdlp(home));
  const route: Route = "straight";
  let tried = yield* tryRoute(binary, url, dir, route, progress, null, "bv*+ba/b");
  if (tried.path === null && reasonOf(tried.stderr)._tag === "YtdlpOutdated" && binary === join(home, "bin", "yt-dlp")) {
    const fresh = yield* Effect.tryPromise(() => freshen(binary, true)).pipe(Effect.option);
    if (Option.isSome(fresh)) {
      binary = fresh.value;
      tried = yield* tryRoute(binary, url, dir, route, progress, null, "bv*+ba/b");
    }
  }
  if (tried.path === null) return yield* new DownloadFailed({ reason: reasonOf(tried.stderr)._tag, message: `${url} couldn't be downloaded: ${errorLine(tried.stderr)}` });
  const path = tried.path;
  const name = path.slice(dir.length + 1);
  fs.writeFileSync(done, name);
  const size = fs.statSync(path).size;
  progress(size, size, name);
  return { path, name, size };
});

/**
 * Tries the routes in order until one gives the file, as `afterFailure`
 * says; when none does, fails with `DownloadFailed` saying the last reason.
 */
const overRoutes = Effect.fn("youtube.overRoutes")(function* (
  home: string,
  id: string,
  dir: string,
  straight: number,
  range: [number, number] | null,
  format: string | null,
  progress: Progress,
  saying: string,
  sparing = false,
) {
  let binary = yield* Effect.promise(() => ytdlp(home));
  const url = `https://www.youtube.com/watch?v=${id}`;
  let updated = false;
  let last: TryFailure = new Unrecognised({ line: "yt-dlp failed" });
  for (let pass = 0; ; pass++) {
    const routes = routesFor((yield* Effect.promise(() => proxyUrl())) !== "", straight, sparing);
    // The next route from `after` on that may be tried: never the sign-in (it's only for what needs it), nor this Mac's address while it's refused.
    const nextFrom = (after: number): number | null => {
      const at = routes.findIndex((one, index) => index > after && one !== "sign-in" && !(one === "straight" && refusedLately()));
      return at < 0 ? null : at;
    };
    let tries = 0;
    // Whether every try of this pass was YouTube refusing an address (a wave), and nothing else.
    let refusedEvery = true;
    let ended = false;
    for (let attempt = nextFrom(-1); attempt !== null; ) {
      const route = routes[attempt]!;
      tries++;
      const began = Date.now();
      const tried = yield* tryRoute(binary, url, dir, route, progress, range, format);
      diag.record("youtube", "youtube: download", Date.now() - began, tried.path === null ? `${id}${said(route)}: ${errorLine(tried.stderr)}` : null);
      if (tried.path !== null) {
        if (route === "straight") straightRefusedAt = -Infinity;
        return tried.path;
      }
      last = reasonOf(tried.stderr);
      if (last._tag !== "RouteRefused") refusedEvery = false;
      if (last._tag === "RouteRefused" && route === "straight") straightRefusedAt = Date.now();
      const next = afterFailure(last);
      if (next.to === "update" && !updated && binary === join(home, "bin", "yt-dlp")) {
        updated = true;
        const fresh = yield* Effect.tryPromise(() => freshen(binary, true)).pipe(
          Effect.tapError((error) => Effect.logWarning(`updating yt-dlp: ${diag.messageOf(error.cause)}`)),
          Effect.option,
        );
        if (Option.isSome(fresh)) {
          binary = fresh.value;
          yield* Effect.logWarning(`${id}: ${last.line}; trying again with the newest yt-dlp`);
          routes.splice(attempt + 1, 0, route);
          attempt += 1;
          continue;
        }
      }
      if (next.to === "stop") ended = true;
      const to =
        next.to === "stop"
          ? null
          : next.to === "sign-in"
            ? (() => {
                const at = routes.findIndex((one, index) => index > attempt! && one === "sign-in");
                if (at < 0) ended = true;
                return at < 0 ? null : at;
              })()
            : nextFrom(attempt);
      if (to === null) break;
      yield* Effect.logWarning(`${id}: ${last.line}${last._tag === "Unrecognised" ? " (not a failure Edit knows: the next route may still get it)" : ""}; trying again${said(routes[to]!)}`);
      yield* Effect.promise(() => timing.pause(attempt === 0 ? 3000 : 1000));
      attempt = to;
    }
    // Nothing could be tried: this Mac's address was refused a moment ago, and there's no proxy (a wave's later pass keeps what YouTube said).
    if (tries === 0 && last._tag !== "RouteRefused") last = new RouteRefused({ line: `YouTube turned ${THIS_MACHINE} away a few minutes ago` });
    // A wave of refusals passes: a download of footage waits it out (research and ideas don't: they're asked again when they're wanted).
    const wait = timing.waveWaits[pass];
    if (ended || sparing || !refusedEvery || last._tag !== "RouteRefused" || wait === undefined) break;
    yield* Effect.logWarning(`${id}: YouTube refused every address it was asked from (${last.line}); trying again in ${Math.round(wait / 60_000)} min`);
    yield* Effect.promise(() => timing.pause(wait));
  }
  return yield* new DownloadFailed({ reason: last._tag, message: `${saying}: ${last.line}` });
});

/** The relay's proxy, asked for once in a while (it's the same for everyone). */
let fromRelay: { url: string; at: number } | null = null;

/**
 * The YouTube proxy: this machine's own (`PROXY_URL`, the dev server's), else
 * the relay's, which gives it to signed-in people only (installed Edits carry
 * no keys: until Oct 30 a teammate's download YouTube refused had no proxy).
 * Each try asks through a `session` of it; never logged.
 */
export async function proxyUrl(): Promise<string> {
  const own = process.env.PROXY_URL?.trim() ?? "";
  if (own !== "") return own;
  if (fromRelay !== null && Date.now() - fromRelay.at < 10 * 60_000) return fromRelay.url;
  try {
    const answer = await relay.json<{ proxyUrl?: string | null }>("GET", "/v1/proxy", null, "the YouTube proxy", 20);
    fromRelay = { url: typeof answer.proxyUrl === "string" ? answer.proxyUrl.trim() : "", at: Date.now() };
  } catch (error) {
    diag.warn("youtube", `asking the relay for the YouTube proxy: ${diag.messageOf(error)}`);
    return "";
  }
  return fromRelay.url;
}

/**
 * The proxy with an address of its own for one try. DataImpulse holds one
 * exit address for a login (Nov 16: the relay's held a hosting company's,
 * 2.56.110.39, for half an hour and more), so a try through the proxy after
 * YouTube refused it went out from the same refused address, and every
 * teammate's tries with it. A session id in the login is a fresh home
 * connection (Cox, Charter, Comcast…), kept for every request of that try:
 * YouTube's video links work only from the address that asked for them.
 * Measured that day: YouTube refused 35–50% of fresh addresses, and a video
 * refused on one came on the next every time (5 of 5). Another proxy is used
 * as it is.
 */
export function session(proxy: string): string {
  if (proxy === "") return proxy;
  try {
    const url = new URL(proxy);
    if (!url.hostname.endsWith("dataimpulse.com")) return proxy;
    const login = decodeURIComponent(url.username).replace(/;sessid\.[^;]*/g, "");
    url.username = encodeURIComponent(`${login}${login.includes("__") ? ";" : "__"}sessid.${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    return url.toString();
  } catch {
    return proxy;
  }
}

/** Tries through the proxy, each from a fresh address, before the next way. */
export const PROXY_TRIES = 3;

/** When YouTube last refused this machine's own address (any of Edit's asks): it isn't asked from for `TURNED_AWAY_MS` after. */
let straightRefusedAt = -Infinity;
const TURNED_AWAY_MS = 10 * 60_000;
const refusedLately = (): boolean => Date.now() - straightRefusedAt < TURNED_AWAY_MS;

/** Test hook: this machine's address as good as new. */
export const forgetRefusals = (): void => {
  straightRefusedAt = -Infinity;
};

/**
 * One way of asking YouTube for a download: straight from this Mac, through
 * the paid proxy (an address of its own each try), or with the editor's
 * YouTube sign-in from Chrome (never through the proxy).
 */
type Route = "straight" | "proxy" | "sign-in";

/**
 * The ways to ask, in order. Footage: straight (free; `straight` times, the
 * second only when the first wasn't refused), through the proxy when there is
 * one, then the editor's YouTube sign-in from Chrome when there is one, for a
 * video only a signed-in YouTube has (the user, Oct 28: "a sort of last
 * resort"; Sphe, Nov 16: never to get past a bot check). Sparing of this
 * machine's address (research, ideas): the proxy first, straight once, never
 * the sign-in.
 */
function routesFor(proxied: boolean, straight: number, sparing: boolean): Route[] {
  const proxy: Route[] = proxied ? Array.from({ length: PROXY_TRIES }, () => "proxy" as const) : [];
  if (sparing) return [...proxy, "straight"];
  // Chrome's folder is looked in only when it comes to this: macOS warns the
  // person whenever Edit reads another app's data (Oct 30: "Data Access Blocked").
  const signIn: Route[] = signInSupported && process.env.EDIT_YOUTUBE_SIGNIN !== "0" ? ["sign-in"] : [];
  return [...Array.from({ length: straight }, () => "straight" as const), ...proxy, ...signIn];
}

function said(route: Route): string {
  return route === "proxy" ? " (proxy)" : route === "sign-in" ? " (with the YouTube sign-in from Chrome)" : "";
}

/** An excerpt's try is stopped after this. */
const EXCERPT_MS = 12 * 60_000;

/**
 * One yt-dlp run on `route`: the file it made, or what it said (never a
 * failure of its own: `reasonOf` reads the words). yt-dlp and the FFmpeg it
 * merges with are one process group, ended together when the try is stopped
 * (saying nothing for `timing.quiet`, an excerpt past `EXCERPT_MS`) or the
 * download is.
 */
const tryRoute = Effect.fn("youtube.tryRoute")(function* (
  binary: string,
  url: string,
  dir: string,
  route: Route,
  progress: Progress,
  range: [number, number] | null,
  format: string | null,
) {
  const proxy = route === "proxy" ? session(yield* Effect.promise(() => proxyUrl())) : null;
  if (proxy === "") return { path: null, stderr: "ERROR: the YouTube proxy isn't available just now" };
  const signIn = route === "sign-in" ? cookieArgs() : [];
  if (route === "sign-in" && signIn.length === 0) return { path: null, stderr: `ERROR: no YouTube sign-in in Chrome on ${THIS_MACHINE}` };
  const runtime = runtimeArgs();
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    // --print below makes it quiet; the progress lines still come.
    "--progress",
    "--no-mtime",
    // Through the paid proxy a retry can pay for the same bytes again (the audit, Oct 23): once there.
    "--retries",
    proxy === null ? "5" : "1",
    "--fragment-retries",
    proxy === null ? "5" : "1",
    "--socket-timeout",
    "30",
    "--continue",
    "-f",
    format ?? (proxy === null ? FORMAT : PROXY_FORMAT),
    "--merge-output-format",
    "mp4",
    ...(range === null ? [] : ["--download-sections", `*${range[0]}-${range[1]}`, "--force-keyframes-at-cuts"]),
    ...ffmpegArgs(),
    ...runtime,
    "-P",
    dir,
    "-o",
    "%(title).120B [%(id)s].%(ext)s",
    "--progress-template",
    "download:EDIT %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.filesize_approx)s %(info.title).120B",
    "--print",
    "after_move:EDIT-FILE %(filepath)s",
    ...(proxy === null ? [] : ["--proxy", proxy]),
    ...(proxy === null ? signIn : []),
    url,
  ];
  const env = runtimeEnv(runtime);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Two streams (video, then sound) are downloaded one after the other: the
  // bytes before the current one are carried. The total is the whole video's
  // (both streams, yt-dlp's estimate) from the start and never shrinks: it
  // was the picture's alone, and the bar went back (89% to 85%) as the sound began.
  let earlier = 0;
  let current = 0;
  let largest = 0;
  let path: string | null = null;
  let heard = Date.now();
  const line = (text: string) => {
    heard = Date.now();
    const said = text.trim();
    if (said.startsWith("EDIT-FILE ")) {
      path = said.slice("EDIT-FILE ".length);
    } else if (said.startsWith("EDIT ")) {
      const [bytes, total, estimate, approx, ...title] = said.slice("EDIT ".length).split(" ");
      const done = Number(bytes);
      if (!Number.isFinite(done)) return;
      if (done < current) earlier += current;
      current = done;
      const size = Number(total);
      const guess = Number(estimate);
      const whole = Number.isFinite(size) ? size : Number.isFinite(guess) ? guess : null;
      const both = Number(approx);
      largest = Math.max(largest, whole === null ? 0 : earlier + whole, Number.isFinite(both) ? both : 0, earlier + done);
      progress(earlier + done, largest > 0 ? largest : null, title.join(" "));
    }
  };
  const run = Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(binary, args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", forceKillAfter: "5 seconds", ...(env ? { env, extendEnv: false } : {}) }),
    );
    const errors = yield* Stream.mkString(Stream.decodeText(handle.stderr)).pipe(Effect.orElseSucceed(() => ""), Effect.forkScoped);
    let pending = "";
    yield* Stream.runForEach(Stream.decodeText(handle.stdout), (text) =>
      Effect.sync(() => {
        heard = Date.now();
        pending += text;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          line(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      }),
    ).pipe(Effect.ignore);
    const code = Number(yield* handle.exitCode.pipe(Effect.orElseSucceed(() => -1)));
    return { code, stderr: yield* Fiber.join(errors) };
  }).pipe(
    Effect.scoped,
    Effect.catch((error) => Effect.succeed({ code: -1, stderr: `ERROR: yt-dlp couldn't start: ${error.message}` })),
  );
  // Nothing said for this long (no progress, no merge finishing): stopped, and
  // the try counts as a failed one, never a download frozen for good.
  const quiet = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(Math.min(timing.quiet, 5000));
      if (Date.now() - heard >= timing.quiet) return { code: -1, stderr: `${STOOD_STILL} (nothing for ${Math.round(timing.quiet / 60_000)} minutes).` };
    }
  });
  const watched = Effect.raceFirst(run, quiet);
  const ran = yield* range === null
    ? watched
    : watched.pipe(Effect.timeoutOrElse({ duration: EXCERPT_MS, orElse: () => Effect.succeed({ code: -1, stderr: "ERROR: The excerpt took more than 12 minutes and was stopped." }) }));
  if (ran.code !== 0) return { path: null, stderr: ran.stderr };
  // yt-dlp said yes and made nothing (a route withholding formats can hand
  // back only storyboards): say so in words `reasonOf` reads.
  // Set by `line` as the output came: the type checker can't see into it.
  const made = path as string | null;
  if (made === null) return { path: null, stderr: `${ran.stderr}\nERROR: The download did not produce a video.` };
  if (!fs.existsSync(made)) return { path: null, stderr: `${ran.stderr}\nERROR: The download did not produce a video (yt-dlp finished without the file it named).` };
  return { path: made, stderr: ran.stderr };
});

/** Download only a selected stretch, with exact cuts. Never fall back to a
 * whole stream: visual sourcing must not materialize hours for a few seconds. */
/** A preview's picture: H.264 in an mp4, 480p at most (Script mode's review clips). */
export const PREVIEW_FORMAT = "b[vcodec^=avc1][height<=480][ext=mp4]/bv*[vcodec^=avc1][height<=480]+ba[ext=m4a]/b[height<=480][ext=mp4]/bv*[height<=480]+ba/b";

/** `sparing`: research's look at another channel's video (Find clips), asked as an idea asks: the proxy first, this Mac's address only when that's refused. */
export async function downloadRange(home: string, id: string, range: [number, number], dir: string, progress: (bytes: number, total: number | null, name: string) => void = () => {}, format: string | null = null, sparing = false): Promise<Downloaded> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0] || range[1] - range[0] > 600) throw new Error("YouTube excerpt needs a valid video and a source range of at most 10 minutes");
  fs.mkdirSync(dir, { recursive: true });
  const path = await runPromise(overRoutes(home, id, dir, 1, range, format, progress, `YouTube excerpt ${id} ${range[0]}–${range[1]} couldn't be downloaded`, sparing).pipe(inArea("youtube")));
  return { path, name: path.slice(dir.length + 1), size: fs.statSync(path).size };
}

/** A video's sound alone (m4a where YouTube has it), to hear a video that has no captions: a few MB where the picture is hundreds. `sparing`: through the proxy first, straight only when that fails, never with the YouTube sign-in. */
export async function downloadSound(home: string, id: string, dir: string, sparing = false): Promise<Downloaded> {
  fs.mkdirSync(dir, { recursive: true });
  const path = await runPromise(overRoutes(home, id, dir, 1, null, "ba[ext=m4a]/ba/b", () => {}, `YouTube video ${id}'s sound couldn't be downloaded`, sparing).pipe(inArea("youtube")));
  return { path, name: path.slice(dir.length + 1), size: fs.statSync(path).size };
}

// ── A question for YouTube that downloads no video (captions, details, a search) ──
//
// Until Nov 10 each asker had its own single try (ideas through the proxy
// only), and a refusal read as the answer: ten ideas on JJ's Mac were
// "skipped: YouTube has no English captions" while every one of those videos
// had them, because YouTube had turned the proxy's address away ("Sign in to
// confirm you're not a bot"). Now a question goes over its use's ways until
// one is answered, and a refusal is never taken for an answer. Since Nov 16
// the proxy is `PROXY_TRIES` tries, each from a fresh address (`session`), and
// a question is never sent from this Mac's address while YouTube refuses it.

/** A way of asking: through the paid proxy, or straight from this machine. */
export type Way = "proxy" | "straight";

/** What yt-dlp said to one question. */
export interface Asked {
  way: Way;
  /** The proxy's address this was asked through, the same for what's fetched after it (YouTube's links work only from the address that asked for them); "" straight. A credential: never in a line. */
  proxy: string;
  stdout: string;
  stderr: string;
  code: number;
}

/** No way was answered: `gone` when no way could be (the video is taken down or private, or only a signed-in YouTube has it), else YouTube turned Edit away for now. */
export class Unanswered extends Error {
  constructor(
    message: string,
    readonly gone: boolean,
  ) {
    super(message);
  }
}

// Sparing of this machine's own address (Sphe, Nov 10, on ideas: "we can use
// the Mac ip but sparingly, only if needed we don't want to get users banned
// for any reason"). A sparing question goes straight only after the proxy
// was asked and turned away, however often that is (the proxy first every
// time: its refusals cost a wait, never the person's address); its straight
// asks go one at a time across Edit with a rest between them, so a batch of
// ideas is never a burst from one address; and once YouTube turns this
// address away it isn't asked from again for ten minutes.
const SPARING_REST_MS = 10_000;
let straightLine: Promise<void> = Promise.resolve();

/** `work` in its turn in the line of sparing straight asks, the next one a rest after it. */
function inStraightLine<T>(work: () => Promise<T>): Promise<T> {
  const turn = straightLine.then(work);
  straightLine = turn.then(
    () => timing.pause(SPARING_REST_MS),
    () => timing.pause(SPARING_REST_MS),
  );
  return turn;
}

/**
 * Asks YouTube about `target` (a video id, or what yt-dlp takes: a link, a
 * `ytsearchN:` search) with yt-dlp `args` (no `--proxy`, no URL), over `ways`
 * in order, until `answered` says a try was (its files are there, or yt-dlp
 * ended well). The proxy is `PROXY_TRIES` tries, each from a fresh address;
 * this machine's address isn't asked from while YouTube refuses it (ten
 * minutes, whichever of Edit's asks it refused). A refusal, a 429 or a
 * failure nobody has seen goes on to the next try; a video that's gone or
 * needs a sign-in ends it; an outdated yt-dlp is brought up to date once and
 * asked again. Throws `Unanswered` with yt-dlp's last line when no way was
 * answered. `sparing` keeps this machine's own address for when it's needed (above).
 */
export async function ask(home: string, target: string, args: readonly string[], ways: readonly Way[], answered: (asked: Asked) => boolean, options: { area: string; sparing?: boolean; signal?: AbortSignal; timeoutMs?: number } = { area: "youtube" }): Promise<Asked> {
  const url = /^[A-Za-z0-9_-]{11}$/.test(target) ? `https://www.youtube.com/watch?v=${target}` : target;
  // Named in a line: a video's id, or what was asked ("ytsearch8:…" stays short).
  const name = target.length > 80 ? `${target.slice(0, 77)}…` : target;
  // The proxy's address is asked for (the relay's, kept ten minutes) only when a way needs it.
  const base = ways.includes("proxy") ? await proxyUrl() : "";
  const queue: Way[] = ways.flatMap((way): Way[] => (way === "proxy" ? (base === "" ? [] : Array.from({ length: PROXY_TRIES }, () => "proxy" as const)) : refusedLately() ? [] : ["straight"]));
  let binary = await ytdlp(home);
  let updated = false;
  let last: TryFailure = new Unrecognised({ line: ways.includes("straight") && refusedLately() ? `YouTube turned ${THIS_MACHINE} away a few minutes ago` : "the YouTube proxy isn't available" });
  for (let at = 0; at < queue.length; at++) {
    const way = queue[at]!;
    const proxy = way === "proxy" ? session(base) : "";
    const runtime = runtimeArgs();
    const once = async (): Promise<Asked | null> => {
      options.signal?.throwIfAborted();
      // Its turn may come after another ask was turned away from this address: then not this one either.
      if (way === "straight" && refusedLately()) return null;
      const child = Bun.spawn([binary, ...runtime, ...(way === "proxy" ? ["--proxy", proxy] : []), ...args, url], { stdout: "pipe", stderr: "pipe", env: runtimeEnv(runtime) });
      const stop = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", stop, { once: true });
      let late = false;
      const timeout = setTimeout(() => {
        late = true;
        stop();
      }, options.timeoutMs ?? 120_000);
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        // Stopped for taking too long: said so, in words `reasonOf` reads as a try worth making again.
        return { way, proxy, stdout, stderr: late ? `${stderr}\nERROR: YouTube took too long to answer and was timed out` : stderr, code: late ? -1 : code };
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", stop);
      }
    };
    const asked = await (way === "straight" && options.sparing === true ? inStraightLine(once) : once());
    options.signal?.throwIfAborted();
    if (asked === null) {
      last = new RouteRefused({ line: `YouTube turned ${THIS_MACHINE} away a few minutes ago` });
      continue;
    }
    if (answered(asked)) {
      if (way === "straight") straightRefusedAt = -Infinity;
      return asked;
    }
    last = reasonOf(asked.stderr);
    const next = afterFailure(last);
    if (last._tag === "RouteRefused" && way === "straight") straightRefusedAt = Date.now();
    // The sign-in from Chrome is for a download that needs it (macOS warns the person each time it's read): never for a question.
    if (next.to === "stop" || next.to === "sign-in") throw new Unanswered(last.line, true);
    if (next.to === "update" && !updated && binary === join(home, "bin", "yt-dlp")) {
      updated = true;
      const fresh = await freshen(binary, true).catch(() => null);
      if (fresh !== null) {
        binary = fresh;
        diag.warn(options.area, `${name}: ${last.line}; asking again with the newest yt-dlp`);
        queue.splice(at + 1, 0, way);
        continue;
      }
    }
    const to = queue[at + 1];
    diag.warn(options.area, `${name}: YouTube didn't answer${way === "proxy" ? " through the proxy" : ` straight from ${THIS_MACHINE}`} (${last.line})${to === undefined ? "" : `; asking ${to === "proxy" ? "through the proxy from another address" : "straight"}`}`);
    // Asked again straight after "429: Too Many Requests", YouTube wants a while first; through the proxy it's another address.
    if (to !== undefined) await timing.pause(to === "straight" && way === "straight" && /429/.test(last.line) ? 20_000 : 1000);
  }
  throw new Unanswered(last.line, false);
}
