// YouTube for Script mode: which links it takes, what a video is before it
// downloads, and the download itself, through Edit's own (youtube.ts: its
// yt-dlp, format, proxy and the editor's sign-in from Chrome). A video comes
// down once into Edit's media folder, where Edit mode finds it too, and the
// script plays that same file.

import * as fs from "node:fs";

import type { App } from "../app.ts";
import { join } from "../paths.ts";
import * as relay from "../relay.ts";
import * as edit from "../youtube.ts";
import { cookieArgs } from "../youtube_signin.ts";

/** A single YouTube watch or short link. Other hosts are refused so yt-dlp is not pointed at an arbitrary site. */
export function checkUrl(raw: string): void {
  const url = raw.trim();
  if (url === "" || /[\p{Cc}\s]/u.test(url)) throw new Error("Paste one YouTube link.");
  if (!url.startsWith("https://")) throw new Error("Use an https YouTube link.");
  const rest = url.slice(8);
  const slash = rest.indexOf("/");
  const host = (slash < 0 ? rest : rest.slice(0, slash)).split(":")[0];
  const path = (slash < 0 ? "" : rest.slice(slash + 1)).split("?")[0]!;
  const ok = ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(host ?? "") ? path.startsWith("watch") || path.startsWith("shorts/") : host === "youtu.be" && path !== "" && !path.includes("/");
  if (!ok) throw new Error("That is not a YouTube video link.");
}

/** Plain-http YouTube links made https, as YouTube itself serves them (Nov 7: "http://youtube.com/watch?v=…" pasted into New project was refused). */
export const secure = (text: string): string => text.replace(/\bhttp:\/\/((?:www\.|m\.)?youtube\.com|youtu\.be)(?=[/?#\s]|$)/gi, "https://$1");

export const isYoutube = (url: string): boolean => {
  try {
    checkUrl(url);
    return true;
  } catch {
    return false;
  }
};

/** What a video is, checked before anything downloads, as Repack checks its videos: its title, channel and length, or why it can't be imported. */
export interface Probe {
  title: string;
  channel: string;
  durationMs?: number | null;
  problem?: string | null;
  /** Something that couldn't be checked but may still import (through the proxy). */
  warning?: string | null;
}

/** Titles the New script check just read, by link, so the import that follows doesn't ask YouTube again. */
const checked = new Map<string, [string, number]>();

/**
 * A question about a link, asked as every question to YouTube is (youtube.ts
 * `ask`): through the proxy first, each try from an address of its own, then
 * straight. With the editor's sign-in (an age-restricted video), straight
 * only: the sign-in never goes through the proxy.
 */
async function ytdlp(app: App, url: string, args: string[], timeoutMs: number, signIn: string[] = []): Promise<string> {
  const asked = await edit.ask(app.store.home, url, [...args, ...signIn], signIn.length > 0 ? ["straight"] : ["proxy", "straight"], (one) => one.code === 0, { area: "writer", timeoutMs });
  return asked.stdout;
}

export async function title(app: App, url: string): Promise<string> {
  const known = checked.get(url);
  if (known !== undefined && Date.now() - known[1] < 3_600_000) return known[0];
  // The Data API through the relay first (a second), as `probe` asks it; yt-dlp through the proxy (17 s to a minute)
  // only for what it can't answer. Kept, so the import's second ask (the file's name) is free (Nov 22: asked of
  // yt-dlp twice before every YouTube download, the bar saying "Starting." meanwhile).
  const quick = await fromApi(url).catch(() => null);
  if (quick !== null) return quick.title;
  try {
    const text = await ytdlp(app, url, ["--no-playlist", "--skip-download", "--print", "%(title)s"], 60_000);
    const line = text.split("\n").find((one) => one.trim() !== "")?.trim().replace(/[\r\n]/g, " ");
    if (!line) return "YouTube video";
    const name = [...line].slice(0, 180).join("");
    checked.set(url, [name, Date.now()]);
    return name;
  } catch {
    return "YouTube video";
  }
}

export async function probe(app: App, url: string): Promise<Probe> {
  // YouTube's Data API through the relay first: a second, where yt-dlp read the watch page through the proxy (17 s to
  // over a minute behind a bot wall, Sphe, Nov 18). What it can't settle (no public video by that id, an age limit
  // the editor's sign-in may get past, no length) is asked of yt-dlp as before.
  const quick = await fromApi(url).catch(() => null);
  if (quick !== null) return quick;
  const first = await probeOnce(app, url, []);
  // An age-restricted (or members-only) video is checked again with the
  // editor's YouTube sign-in from Chrome, as its download will be (youtube.ts):
  // without it, the check refused videos the import could have.
  if (!first.signInWouldHelp) return first.probe;
  const signIn = cookieArgs();
  return signIn.length === 0 ? first.probe : (await probeOnce(app, url, signIn)).probe;
}

async function probeOnce(app: App, url: string, signIn: string[]): Promise<{ probe: Probe; signInWouldHelp: boolean }> {
  let said: string;
  try {
    said = await ytdlp(app, url, ["--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings"], 90_000, signIn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [why, blocking] = probeTrouble(message);
    return { probe: blocking ? { title: "", channel: "", problem: why } : { title: "", channel: "", warning: why }, signInWouldHelp: SIGN_IN.test(message) };
  }
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(said.trim()) as Record<string, unknown>;
  } catch {
    return { probe: { title: "", channel: "", problem: "YouTube didn't say what this video is." }, signInWouldHelp: false };
  }
  const name = [...(typeof info.title === "string" ? info.title : "YouTube video")].slice(0, 180).join("");
  if (typeof info.title === "string") checked.set(url, [name, Date.now()]);
  const channel = typeof info.channel === "string" ? info.channel : typeof info.uploader === "string" ? info.uploader : "";
  const seconds = typeof info.duration === "number" && info.duration > 0 ? info.duration : null;
  const durationMs = seconds === null ? null : Math.floor(seconds * 1000);
  const live = typeof info.live_status === "string" ? info.live_status : "";
  // Signed in, YouTube gives an 18+ video's formats: it downloads the same way.
  const ageLocked = Number(info.age_limit ?? 0) >= 18 && signIn.length === 0;
  const problem =
    info.is_live === true || live === "is_live"
      ? "It's live now; import it once the stream has ended."
      : live === "is_upcoming"
        ? "It hasn't premiered yet."
        : ageLocked
          ? AGE
          : durationMs === null
            ? "YouTube doesn't give its length."
            : durationMs > 10 * 3_600_000
              ? "It runs over 10 hours."
              : null;
  return { probe: { title: name, channel, durationMs, problem, warning: null }, signInWouldHelp: ageLocked };
}

type Checked = { title: string; channel: string; durationSeconds: number | null; live: "live" | "upcoming" | "none"; ageRestricted: boolean; privacy: string } | null;

/** A link's check from the Data API (the relay's /v1/youtube/check), or null to ask yt-dlp. */
async function fromApi(url: string): Promise<Probe | null> {
  const id = edit.videoId(url);
  // Signed out (or a test with no relay): yt-dlp alone, as before.
  if (id === null || !relay.cloudEnabled()) return null;
  const answer = await relay.json<{ videos: Record<string, Checked> }>("GET", `/v1/youtube/check?ids=${id}`, null, "YouTube's details", 15);
  const video = answer.videos[id] ?? null;
  if (video === null || video.ageRestricted || video.durationSeconds === null || video.durationSeconds <= 0) return null;
  const name = [...(video.title || "YouTube video")].slice(0, 180).join("");
  checked.set(url, [name, Date.now()]);
  const durationMs = Math.floor(video.durationSeconds * 1000);
  const problem = video.live === "live" ? "It's live now; import it once the stream has ended." : video.live === "upcoming" ? "It hasn't premiered yet." : durationMs > 10 * 3_600_000 ? "It runs over 10 hours." : null;
  return { title: name, channel: video.channel, durationMs, problem, warning: null };
}

/** What only a signed-in YouTube gets past (age, members). */
const SIGN_IN = /confirm your age|age.restricted|inappropriate|members.only|join this channel/i;
const AGE = "It's age-restricted. Sign in to YouTube in Chrome (Settings → YouTube) to import it.";

/** yt-dlp's failure as a reason a person can act on, and whether it stops the import (a sign-in or connection trouble may not). */
function probeTrouble(error: string): [string, boolean] {
  const lower = error.toLowerCase();
  if (lower.includes("private video")) return ["It's private.", true];
  if (lower.includes("confirm your age") || lower.includes("age-restricted") || lower.includes("inappropriate")) return [AGE, true];
  if (lower.includes("not a bot") || lower.includes("sign in") || lower.includes("turned")) return ["YouTube turned Edit away just now, so it couldn't be checked. It should still import.", false];
  if (["unavailable", "removed", "does not exist", "terminated"].some((word) => lower.includes(word))) return ["It's no longer available.", true];
  if (lower.includes("premiere") || lower.includes("live event")) return ["It hasn't premiered yet.", true];
  // Nov 6, Marius's Mac on a slow connection: checks ran past 90 s, and four of six links showed only their URL.
  if (lower.includes("took too long")) return ["YouTube was too slow to check it. It should still import.", false];
  return ["YouTube couldn't be asked about it, so it wasn't checked. Check the link opens.", false];
}

/**
 * Brings video `url` down once into Edit's media folder (where Edit mode
 * finds it too) and answers its path; `onPercent` hears how far it is.
 */
export async function fetch(app: App, url: string, onPercent: (percent: number) => void = () => {}): Promise<string> {
  const id = edit.videoId(url);
  if (id === null) throw new Error("That is not a YouTube video link.");
  const dir = join(app.store.driveDir(), "youtube", id);
  const got = await edit.download(app.store.home, id, dir, (bytes, total) => onPercent(total ? Math.min(100, Math.floor((bytes * 100) / total)) : 0));
  return got.path;
}

/**
 * Puts the shared download at `dest` in a script's folder: the same file,
 * hard-linked, when they're on one disk; else the script keeps pointing at
 * the shared one (answered).
 */
export function place(shared: string, dest: string): string {
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest);
    fs.linkSync(shared, dest);
    return dest;
  } catch {
    return shared;
  }
}
