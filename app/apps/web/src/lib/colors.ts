import type { ClipColor } from "./types";

/** Timeline label colours: vivid on black, readable with white text. */
export const CLIP_HEX: Record<ClipColor, string> = {
  blue: "#3b82f6",
  cyan: "#06b6d4",
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  red: "#ef4444",
  purple: "#a855f7",
  pink: "#ec4899",
};

/**
 * The V2 timeline's rows (lib/timelineRows.ts), one colour each, from the same
 * palette: a footage's sound in its footage's blue, the words in a quiet grey.
 */
export const ROW_HEX = {
  subtitles: "#94a3b8",
  graphics: CLIP_HEX.purple,
  captions: CLIP_HEX.pink,
  cutins: CLIP_HEX.cyan,
  footage: CLIP_HEX.blue,
  looks: "#64748b",
  footsound: CLIP_HEX.blue,
  voiceover: CLIP_HEX.orange,
  music: CLIP_HEX.green,
  sfx: CLIP_HEX.yellow,
} as const;

/** What covers part of a footage's picture (a removal, a blur), drawn along its foot. */
export const COVER_HEX = "#fbbf24";
