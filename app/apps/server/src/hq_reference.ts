// Bodycam HQ copying a reference, held to it by Edit (Sphe, Nov 13: "I thought
// the point of this was that the agent would accurately replicate the
// original reference frame by frame"). The notes ask the agent to compare its
// frames beside the reference's before it calls a graphic done; on the first
// real test it studied the reference closely, built four graphics, never once
// compared one beside it (look_at_effect `beside`), and ended its turn with a
// list of where they differed. The same agent is made to do it ("can't we just
// enforce this one agent to do that on its own"): when its turn ends, Edit
// checks what it compared and sends it back for what it didn't.
//
// And the map (Sphe: "the 3D map should be the only route unless the user
// states otherwise"): pictures of a map or satellite view fetched from a map
// site are refused in a Bodycam HQ project, pointing at edit-map, unless the
// agent quotes where the person asked for another kind.

import type { Entry } from "./agent.ts";
import type { App } from "./app.ts";
import type { Project } from "./model.ts";
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

/** What changes an effect's frames: its code or files written, or a tool that puts a file in its folder (placing it, add_effect, doesn't). */
const CHANGES = new Set(["effect_picture", "effect_footage", "effect_track", "effect_beneath", "use_from_library", "restore_effect"]);

const argsOf = (entry: Entry): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(entry.detail ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The effect a call is about: a tool's `name`, or the folder of a file the agent read, wrote or edited. */
function effectOf(entry: Entry): string | null {
  const a = argsOf(entry);
  if (entry.tool === "Write" || entry.tool === "Edit") {
    const path = typeof a.file_path === "string" ? a.file_path : "";
    return /(?:^|\/)effects\/([^/]+)\//.exec(path)?.[1] ?? /^([a-z0-9][a-z0-9-]*)\/[^/]+$/.exec(path)?.[1] ?? null;
  }
  return typeof a.name === "string" ? a.name : null;
}

/** Seconds of an effect a look beside the reference covers: each moment and the half second round it, or the stretch it went through frame by frame. */
function covered(a: Record<string, unknown>, fps: number): [number, number][] {
  if (a.every_frame === true) {
    const start = typeof a.start === "number" ? a.start : 0;
    const end = typeof a.end === "number" ? a.end : start + 1;
    // A look shows at most 24 frames beside the reference.
    return [[start, Math.min(end, start + 24 / fps)]];
  }
  const times = Array.isArray(a.times) ? a.times.filter((one): one is number => typeof one === "number") : [];
  return times.map((one) => [one - 1, one + 1]);
}

/** The stretches of `[0, length)` none of `spans` reach, joined, each at least a second. */
function gaps(spans: [number, number][], length: number): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [from, to] of sorted) {
    if (from > at + 0.01) out.push([at, Math.min(from, length)]);
    at = Math.max(at, to);
    if (at >= length) break;
  }
  if (at < length - 0.01) out.push([at, length]);
  return out.filter(([from, to]) => to - from >= 1 && from < length);
}

/** A turn's closing words that list where its work differs from the reference rather than closing the gaps. */
export const DIFFERS = /\b(differs?|different|doesn'?t match|don'?t match|not (?:an? )?(?:exact|frame[- ]for[- ]frame|frame[- ]by[- ]frame) match|rather than matching|unlike the reference|where (?:it|ours|they) (?:differ|depart)|gaps?\b[^.\n]{0,40}reference)/i;

const seconds = (value: number) => `${Math.round(value * 10) / 10} s`;

/**
 * What an HQ turn that copied a reference left unchecked, as Edit's note back
 * to the agent (null when it compared everything it changed, or copied
 * nothing). `entries` are the turn's: the person's message and every entry
 * after it (Edit's own follow-ups included). A reference is footage or a
 * picture the agent studied (look_at_media) that isn't in the edit.
 */
export function referenceCheck(entries: readonly Entry[], project: Project): { note: string; count: number } | null {
  const inEdit = new Set(project.clips.map((clip) => ("media" in clip ? clip.media : null)).filter((id): id is string => id !== null));
  const references = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.tool !== "look_at_media" || entry.status === "failed") continue;
    const id = argsOf(entry).media_id;
    if (typeof id === "string" && !inEdit.has(id)) references.set(id, (references.get(id) ?? 0) + 1);
  }
  if (references.size === 0) return null;
  const reference = [...references.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const fps = project.settings.fps;
  // Each effect the turn changed, and what was compared beside the reference since its last change.
  const changed = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.kind !== "tool" || entry.status === "failed") return;
    const name = effectOf(entry);
    if (name === null) return;
    if (entry.tool === "Write" || entry.tool === "Edit" || CHANGES.has(entry.tool ?? "")) changed.set(name, index);
  });
  if (changed.size === 0) return null;
  const open: string[] = [];
  for (const [name, last] of changed) {
    const length = project.media.find((one) => one.effect === name)?.duration ?? null;
    const spans: [number, number][] = [];
    entries.slice(last + 1).forEach((entry) => {
      if (entry.kind !== "tool" || entry.tool !== "look_at_effect" || entry.status === "failed") return;
      const a = argsOf(entry);
      if (a.name !== name || typeof a.beside !== "object" || a.beside === null) return;
      spans.push(...covered(a, fps));
    });
    if (length === null) {
      if (spans.length === 0) open.push(`- ${name}: never compared beside the reference since its last change`);
      continue;
    }
    const missing = gaps(spans, length);
    if (missing.length === 0) continue;
    const whole = spans.length === 0;
    open.push(`- ${name} (${seconds(length)}): ${whole ? "never compared beside the reference since its last change" : `not compared beside the reference at ${missing.map(([from, to]) => `${seconds(from)}–${seconds(to)}`).join(", ")}`}`);
  }
  const last = [...entries].reverse().find((entry) => entry.kind === "assistant");
  const listed = last !== undefined && DIFFERS.test(last.text);
  if (open.length === 0 && !listed) return null;
  const lines: string[] = ["(Edit, automatically) This turn copies a reference, and the person wants it matched frame by frame (Sphe: \"I thought the point of this was that the agent would accurately replicate the original reference frame by frame\")."];
  if (open.length > 0) {
    lines.push(
      `What you changed hasn't been compared beside the reference (${reference}) where it moves:\n${open.join("\n")}`,
      "Go through each of those now with look_at_effect beside {media_id, start} (the reference's second that matches), every_frame through what moves (a transition, a camera move, words arriving, a glow), stills at the moments that hold. Look at each pair as a stranger would: perspective and camera, the transition's every frame, type (face, weight, size, spacing, case), glows, shadows and colours, timing. Fix what's off, then compare again.",
    );
  }
  if (listed) lines.push("Your last message listed where your work differs from the reference. Close each of those gaps now rather than reporting them; leave one only when it truly can't be done in this video (no such photo exists, the person must choose), and say in a line what stops it.");
  lines.push("Don't end the turn until every graphic you changed matches the reference beside it, frame for frame.");
  return { note: lines.join("\n\n"), count: open.length + (listed ? 1 : 0) };
}
