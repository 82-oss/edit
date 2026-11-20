// Reading YouTube without downloading its footage: a search's videos, and a
// video's details and timed captions. The edit agent's B-roll research
// (commentary_sources.ts: search_broll, read_broll_source) and the script
// agent's (writer/turn_tools.ts: search_youtube, read_youtube) both ask here.

import * as fs from "node:fs";

import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";
import * as youtube from "./youtube.ts";

type Args = Record<string, unknown>;

/**
 * A research question for YouTube (a search, a video's details or captions, a
 * channel), `args` ending in what's asked about. Other channels' videos, so
 * asked as every question is (youtube.ts `ask`) and sparing of the person's
 * address as an idea is: through the proxy first, each try from an address of
 * its own, this Mac's only when that's refused (Sphe, Nov 16).
 */
export async function run(home: string, args: string[], ms = 100_000): Promise<string> {
  const target = args.at(-1)!;
  try {
    return (await youtube.ask(home, target, ["--no-warnings", "--socket-timeout", "20", ...args.slice(0, -1)], ["proxy", "straight"], (one) => one.code === 0, { area: "broll", sparing: true, timeoutMs: ms })).stdout;
  } catch (error) {
    if (error instanceof youtube.Unanswered && !error.gone) throw new Error("YouTube turned Edit away just now; try again in a few minutes, or use an already supplied source");
    throw new Error("YouTube research failed or timed out; try another query or use an already supplied source");
  }
}

/** One video a search found. */
export interface Video {
  id: string;
  url: string;
  title: unknown;
  channel: unknown;
  duration: unknown;
  views: unknown;
  thumbnail: string;
}

/** The videos YouTube finds for `query`, at most `limit`, live streams left out. */
export async function search(home: string, query: string, limit: number): Promise<Video[]> {
  const data = JSON.parse(await run(home, ["--flat-playlist", "--dump-single-json", `ytsearch${limit}:${query}`])) as { entries?: Args[] };
  return (data.entries ?? [])
    .filter((e) => typeof e.id === "string" && !["is_live", "is_upcoming"].includes(String(e.live_status)))
    .map((e) => ({
      id: String(e.id),
      url: `https://www.youtube.com/watch?v=${String(e.id)}`,
      title: e.title,
      channel: e.channel ?? e.uploader,
      duration: e.duration,
      views: e.view_count,
      thumbnail: `https://i.ytimg.com/vi/${String(e.id)}/hqdefault.jpg`,
    }));
}

/** A video's details and its English captions, each line at its second. */
export interface Source {
  url: string;
  title: unknown;
  channel: unknown;
  date: unknown;
  duration: unknown;
  description?: unknown;
  lines: { at: number; text: string }[];
}

/** A video's details and captions, read once into `dir` (source.json) and from there after. */
export async function source(home: string, id: string, dir: string): Promise<[Source, boolean]> {
  fs.mkdirSync(dir, { recursive: true });
  const cached = join(dir, "source.json");
  try {
    const kept = JSON.parse(fs.readFileSync(cached, "utf8")) as Source;
    // None kept: read again (until Nov 20 --dump-single-json simulated, so no captions were ever written).
    if (kept.lines.length > 0) return [kept, false];
  } catch {
    // Read below.
  }
  // --no-simulate: --dump-single-json alone simulates, and writes no captions.
  const answer = await run(home, ["--skip-download", "--no-simulate", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-orig", "--sub-format", "json3", "--dump-single-json", "-o", join(dir, "captions.%(ext)s"), `https://www.youtube.com/watch?v=${id}`]);
  const info = JSON.parse(answer) as Args;
  const file = fs.readdirSync(dir).find((name) => name.endsWith(".json3"));
  const data = file === undefined ? { events: [] } : (JSON.parse(fs.readFileSync(join(dir, file), "utf8")) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] });
  const lines = (data.events ?? []).flatMap((e) => {
    const said = (e.segs ?? []).map((s) => s.utf8 ?? "").join("").trim();
    return said === "" ? [] : [{ at: (e.tStartMs ?? 0) / 1000, text: said }];
  });
  const out: Source = { url: `https://www.youtube.com/watch?v=${id}`, title: info.title, channel: info.channel ?? info.uploader, date: info.upload_date, duration: info.duration, description: info.description, lines };
  writeAtomic(cached, JSON.stringify(out));
  return [out, true];
}
