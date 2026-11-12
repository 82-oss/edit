// Bodycam HQ's maps (Sphe, Nov 13: "the 3D map should be the only route
// unless the user states otherwise"): on the first real test of copying a
// reference, its maps were satellite pictures laid flat and tilted, though
// edit-map's 3D city was in its notes.
//
// Pictures of a map or satellite view fetched from a map
// site are refused in a Bodycam HQ project, pointing at edit-map, unless the
// agent quotes where the person asked for another kind.

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

