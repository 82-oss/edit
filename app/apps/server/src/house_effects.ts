// V1's house graphics on a channel's project. V1 lays each as clips of its own
// names ("Horror · analog look", "Janitor · source card"); a channel's project
// shows the same graphic as one clip of an effect brought in from the library
// as V1's own `v1-<name>` (Nov 19–22: each recreated exactly, for each kind's
// channels). The add-ons' checks ask for both through here, so a check that
// counts V1's clips counts the channel's effects too (Nov 22, Horror on dev:
// `horror_look_missing` could never be met by v1-analog-look, and six more of
// horror's checks never saw a v1- effect at all).

import type { Clip, Project } from "./model.ts";
import { mediaOf } from "./project.ts";

/** Whether a project is a channel's: its graphics are effects, never V1's own clips. */
export const onChannel = (p: Pick<Project, "channel">): boolean => typeof p.channel === "string" && p.channel !== "";

/** The library effect a clip shows: what its effect was brought in as (`effect_from`), else its folder's name; null for a clip of no effect. */
export function effectOf(p: Project, clip: Clip): string | null {
  if (clip.type !== "video") return null;
  const media = mediaOf(p, clip.media);
  if (media === undefined || typeof media.effect !== "string") return null;
  return media.effect_from ?? media.effect;
}

/** Whether a clip shows an effect (any: the agent's own or the library's). */
export const isEffect = (p: Project, clip: Clip): boolean => effectOf(p, clip) !== null;

/**
 * Whether a clip shows one of V1's house graphics `names` (each without its
 * "v1-") as an effect: brought in as `v1-<name>`, or, brought in before Edit
 * kept what from (Nov 22), a folder of that name or a copy of it (`v1-<name>-2`).
 */
export function shows(p: Project, clip: Clip, names: readonly string[]): boolean {
  const from = effectOf(p, clip);
  if (from === null) return false;
  const kept = mediaOf(p, (clip as { media: string }).media)?.effect_from != null;
  return names.some((name) => from === `v1-${name}` || (!kept && from.startsWith(`v1-${name}-`) && /^\d+$/u.test(from.slice(name.length + 4))));
}

/** Horror's: the analog look over every picture. */
export const HORROR_LOOK = ["analog-look"] as const;
/** Horror's words over the picture (V1's `Horror · <look> title`, its title lines). */
export const HORROR_TITLES = ["horror-title", "horror-chapter", "horror-date", "horror-place", "horror-name-tag", "horror-quote", "horror-words"] as const;
/** Horror's cards: a picture, a screenshot or a page, a profile's picture (V1's `Horror · picture`/`screenshot`, with their grounds and markers inside). */
export const HORROR_CARDS = ["picture-card", "retro-card", "retro-page", "horror-profile"] as const;
/** What horror draws over the picture beneath without being a picture of its own: the look, the lens, the dip, its words. */
export const HORROR_OVER = [...HORROR_LOOK, "cc-lens", "dip", ...HORROR_TITLES] as const;
/** Horror's pictures of the story's own (V1's `Horror ·`/`Desktop ·` video clips): its cards, its desktop, its icons. */
export const HORROR_PICTURES = [...HORROR_CARDS, "xp-desktop", "horror-icon"] as const;

/** Commentary's (Internet Janitor's) cards: V1's `Janitor · source card`. */
export const COMMENTARY_CARDS = ["card"] as const;
/** Commentary's graphics as V1 named them for `commentary_graphics_monotony`, the plain ones (card, emphasis) first. */
export const COMMENTARY_PLAIN = ["card", "text"] as const;
export const COMMENTARY_GRAPHICS = [...COMMENTARY_PLAIN, "youtube", "youtube-list", "label", "bumper", "commentary-leak", "light-leak", "profile", "tweet", "channel", "icon", "location"] as const;
/** What commentary draws over the picture beneath without being a shot of its own (V1's adjustments and overlays). */
export const COMMENTARY_OVER = ["narration-look", "text", "chapter", "label", "location", "counter", "arrow", "commentary-leak", "light-leak", "dip"] as const;
/** The transitions a shot that's only them is (V1's Flash, Dip, Light leak…). */
export const TRANSITIONS = ["dip", "commentary-leak", "light-leak", "burn", "slide"] as const;
