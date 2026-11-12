// Bodycam HQ copying a reference (Sphe, Nov 13: "the team is able to give a
// reference video to the agents, and the effect can be recreated almost
// perfectly"). On the first real test it built four graphics and compared none
// beside the reference; made to compare, it compared ten times and still
// passed frames that were plainly different: the builder grading its own work
// is the weak point. So it writes the reference down before building
// (agent/hq/notes.md) and has its work judged by a checker it starts itself,
// a sub-agent with fresh eyes and no stake in the build (`GRAPHICS_CHECKER`).
// Edit sends nothing itself: prompts are the team's alone (Sphe: "I really do
// just want prompts to be from our users, unless it's a server restart").
//
// And the map (Sphe: "the 3D map should be the only route unless the user
// states otherwise"): pictures of a map or satellite view fetched from a map
// site are refused in a Bodycam HQ project, pointing at edit-map, unless the
// agent quotes where the person asked for another kind.

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

import type { Entry } from "./agent.ts";
import type { App } from "./app.ts";
import { agentPanel } from "./seams.ts";

/** Map sites, by host, and the paths of theirs that are pictures of a place (null: all of it). */
const MAP_SITES: [RegExp, RegExp | null][] = [
  [/(^|\.)arcgisonline\.com$/, null],
  [/(^|\.)arcgis\.com$/, /imagery|mapserver|tile/],
  [/^(maps|khms?\d*|mts?\d*)\.googleapis\.com$/, null],
  [/^maps\.gstatic\.com$/, null],
  [/^(maps|earth)\.google\.[a-z.]+$/, null],
  [/(^|\.)google\.[a-z.]+$/, /^\/maps/],
  [/(^|\.)bing\.com$/, /^\/maps/],
  [/(^|\.)virtualearth\.net$/, null],
  [/(^|\.)mapbox\.com$/, null],
  [/^(www\.|tile\.|[a-c]\.tile\.)?openstreetmap\.org$/, null],
  [/^maps\.apple\.com$/, null],
  [/(^|\.)zoom\.earth$/, null],
];

/** A link to a map site's picture of a place (satellite, aerial, a map's tiles), not edit-map's 3D city. */
export function mapImagery(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return MAP_SITES.some(([site, path]) => site.test(host) && (path === null || path.test(parsed.pathname.toLowerCase())));
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Whether `words` (the agent's quote of the person) are in one of the person's own messages. */
export function personSaid(entries: readonly Entry[], words: string): boolean {
  const quote = squash(words);
  if (quote.split(" ").length < 3) return false;
  return entries.some((entry) => entry.kind === "user" && !entry.text.startsWith("(Edit, automatically)") && squash(entry.text).includes(quote));
}

/** The refusal of a map site's picture in a Bodycam HQ project. */
export const MAP_REFUSED =
  "In Bodycam HQ every map is edit-map's 3D city (Google's photorealistic 3D tiles: a real place from any angle, buildings standing), never a picture from a map site laid flat or tilted (Sphe, Nov 13: \"the 3D map should be the only route unless the user states otherwise\"). " +
  "Load edit-map/map.js in the effect and aim its camera in seek(t): find() the place, look() or fly() the camera, screen() to pin anything to it. " +
  "Only if the person asked for another kind of map (a flat 2D map, a satellite photo), call again with `asked`: their words, quoted from their message.";

/**
 * Refuses a map site's picture in a Bodycam HQ project (capture_evidence,
 * import_link) unless `asked` quotes where the person asked for that kind.
 */
export function mapAllowed(app: App, projectId: string, url: string, asked: unknown): void {
  if (app.store.get(projectId)?.project.hq !== true || !mapImagery(url)) return;
  const entries = (agentPanel(app).turn?.(projectId).entries ?? []) as readonly Entry[];
  if (typeof asked === "string" && personSaid(entries, asked)) return;
  throw new Error(typeof asked === "string" ? `${MAP_REFUSED} ("${asked}" isn't in the person's messages, word for word.)` : MAP_REFUSED);
}

/**
 * The sub-agent Bodycam HQ's agent starts (the Agent tool) to judge a graphic
 * against the reference it copies: it sees only frames and the brief the
 * builder wrote down (`<effect>/reference.md`), changes nothing, and answers
 * with every difference or "MATCHES".
 */
export const GRAPHICS_CHECKER: AgentDefinition = {
  description:
    "Judges one graphic (an effect) against the reference it copies, frame by frame, with fresh eyes: give it the effect's name, the reference's media id and the reference's second that lines up with the effect's start. It changes nothing; it answers with every difference it finds, or MATCHES.",
  prompt: [
    "You check one coded graphic (an effect) against the reference it copies, for a YouTube video team that wants it matched frame by frame. You didn't make it and have no stake in it: your job is to find every way it differs, not to approve it. A difference you miss reaches the team.",
    "1. Read <effect>/reference.md, the builder's list of what the reference shows. Don't trust it: it may have missed things.",
    "2. Study the reference yourself (look_at_media on its media id, every_frame through what moves, zoom on small things: lettering, edges, glows, ghosts and trails, grain). Note every element and every motion you see.",
    "3. Compare the graphic beside it (look_at_effect with beside {media_id, start}): every_frame through every stretch that moves (a transition, a camera move, words arriving and leaving, a waveform), stills where it holds, and zoom on every small element. Go through its whole length.",
    "4. For each element and motion, say whether ours matches, and if not exactly what differs: the second or frame, what the reference shows, what ours shows (shape, size, position, typeface, weight, case, spacing, colour, glow, blur, opacity, timing, easing, perspective, camera). Be concrete and visual; never suggest code.",
    "Differences of content the story needs (another place, other people's names and photos, other words said) are not differences. Everything about how it looks and moves is.",
    "End with a list of every difference, most visible first, or with the single word MATCHES if, frame by frame and zoomed in, you can find none.",
  ].join("\n"),
  tools: ["Read", "Glob", "Grep", "mcp__edit__look_at_effect", "mcp__edit__look_at_media"],
  model: "inherit",
};
