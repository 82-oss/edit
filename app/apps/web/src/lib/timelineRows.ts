// What the V2 timeline draws (Sphe, Nov 21: the team "wasn't asking for the
// timeline mainly to hand-edit… a quick glance over the entire project", at
// where the sound effects, graphics, footage and the rest are placed). An edit
// made the new way has dozens of tracks the agent laid (28 in one real
// project), so its clips are shown by what they are, one row per kind, not one
// per track. The model says what each is (checked Nov 21 against three real
// channel projects, of 45, 1,355 and 3,173 clips):
//
// - Subtitles: the text clips on the track marked `subtitles`, also those an
//   effect draws for them that leave their text at opacity 0 (2,028 in one
//   project): they're still the words. Any other text clip is a caption.
// - Graphics: a video clip of a coded effect (`Media::effect`), and the
//   generated pictures (solids: dips and flashes; waveforms).
// - Cut-ins: footage named as the server names a cut-in's clips ("Cut-in N · …",
//   ranges.ts `cutIns`; nothing else in the model marks one).
// - Footage: every other picture clip.
// - Looks: adjustment clips that change the whole picture (a grade, a leak).
// - Footage sound: an audio clip of a video's sound.
// - Voice-over: as the server knows one (voiceover.ts `isVoiceover`): read by a
//   script's narration block, laid as "Voice-over", or a voice-over take.
// - Music and Sound effects: the library's halves (`Media::library`); any other
//   sound file is a sound effect.
//
// What covers part of the picture (a cleaned strip, `Media::cleans`, and a blur
// over a box) isn't a row of its own: it's drawn on the footage it covers, its
// `parent` when it has one, else the footage under it, as a band along the foot
// of that footage's block.

import type { Clip, Media, Project, TextClip } from "./types";

export type RowKind = "subtitles" | "graphics" | "captions" | "cutins" | "footage" | "looks" | "footsound" | "voiceover" | "music" | "sfx";

/** The rows top to bottom: what's seen, then what's heard. Subtitles first, held under the ruler. */
export const ROWS: { kind: RowKind; label: string }[] = [
  { kind: "subtitles", label: "Subtitles" },
  { kind: "graphics", label: "Graphics" },
  { kind: "captions", label: "Captions" },
  { kind: "cutins", label: "Cut-ins" },
  { kind: "footage", label: "Footage" },
  { kind: "looks", label: "Looks" },
  { kind: "footsound", label: "Footage sound" },
  { kind: "voiceover", label: "Voice-over" },
  { kind: "music", label: "Music" },
  { kind: "sfx", label: "Sound effects" },
];

/** Rows whose blocks show their frames, and those that show their waveform. */
export const PICTURE_ROWS: ReadonlySet<RowKind> = new Set(["graphics", "cutins", "footage"]);
export const SOUND_ROWS: ReadonlySet<RowKind> = new Set(["footsound", "voiceover", "music", "sfx"]);

export interface Block {
  clip: Clip;
  kind: RowKind;
  /** Its lane within the row (clips that overlap stack). */
  lane: number;
  start: number;
  end: number;
  /** What it's called on screen. */
  name: string;
  media: Media | null;
}

export interface Cover {
  clip: Clip;
  start: number;
  end: number;
  /** The footage block it's drawn on, or null: the footage row's first lane. */
  host: Block | null;
  name: string;
}

export interface Row {
  kind: RowKind;
  label: string;
  lanes: number;
  /** By start. */
  blocks: Block[];
  /** The longest block's length: how far back a search for what's in view starts. */
  longest: number;
}

export interface Layout {
  rows: Row[];
  covers: Cover[];
  /** One past the last frame of anything. */
  end: number;
}

const CUT_IN = /^Cut-in \d+\b/u;
/** The clip ids Edit puts in names ("Text blur · c568"): nothing to anyone reading them. */
const CLIP_ID = /\s·\s(c\d+|extension of c\d+)$/u;

/** A name as shown: without the clip id Edit names some by. */
export function shownName(name: string): string {
  return name.replace(CLIP_ID, "").trim();
}

/** A blur over a box of the picture, not the whole of it (a whole one is a look: a key line's backdrop). */
function coversPart(clip: Extract<Clip, { type: "adjustment" }>, project: Project): boolean {
  const blur = clip.blur;
  if (blur === undefined || blur === null) return false;
  const { width, height } = project.settings;
  return (blur.width !== undefined && blur.width < width) || (blur.height !== undefined && blur.height < height);
}

/** Whether `clip` is a voice-over, as the server's voiceover.ts `isVoiceover` says. */
export function isVoiceover(project: Project, clip: Clip, media: Media | null): boolean {
  if (clip.type !== "audio") return false;
  const narrated = (project.script?.blocks ?? []).some((block) => block.kind === "narration" && block.voiceover === clip.id);
  return narrated || (clip.name ?? "").startsWith("Voice-over") || (media?.name.includes(" - Cut-in ") ?? false);
}

/** Which row `clip` goes in, or "cover" for one drawn on its footage. */
export function kindOf(project: Project, clip: Clip, media: Media | null, subtitleTracks: ReadonlySet<string>): RowKind | "cover" {
  switch (clip.type) {
    case "text":
      return subtitleTracks.has(clip.track) ? "subtitles" : "captions";
    case "adjustment":
      return coversPart(clip, project) ? "cover" : "looks";
    case "solid":
    case "waveform":
      return "graphics";
    case "audio":
      if (isVoiceover(project, clip, media)) return "voiceover";
      if (media?.kind === "video") return "footsound";
      if (media?.library === "music") return "music";
      return "sfx";
    case "video":
      if (media?.cleans !== undefined && media.cleans !== null) return "cover";
      if (typeof media?.effect === "string") return "graphics";
      if (CUT_IN.test(clip.name ?? "")) return "cutins";
      return "footage";
  }
}

/** A clip's name on screen: a subtitle's or a caption's its words, else its own name or its media's. */
function nameOf(clip: Clip, media: Media | null): string {
  if (clip.type === "text") return (clip as TextClip).text.replace(/\s+/gu, " ").trim();
  return shownName(clip.name ?? media?.name ?? "");
}

/** The rows of `project` (only those with something in them), its covers, and its end. */
export function layoutOf(project: Project): Layout {
  const media = new Map(project.media.map((one) => [one.id, one]));
  const subtitleTracks = new Set(project.tracks.filter((track) => track.subtitles === true).map((track) => track.id));
  const byKind = new Map<RowKind, Block[]>();
  const covering: Clip[] = [];
  let end = 0;
  for (const clip of project.clips) {
    const own = clip.type === "video" || clip.type === "audio" ? (media.get(clip.media) ?? null) : null;
    const kind = kindOf(project, clip, own, subtitleTracks);
    end = Math.max(end, clip.start + clip.duration);
    if (kind === "cover") {
      covering.push(clip);
      continue;
    }
    const blocks = byKind.get(kind) ?? [];
    blocks.push({ clip, kind, lane: 0, start: clip.start, end: clip.start + clip.duration, name: nameOf(clip, own), media: own });
    byKind.set(kind, blocks);
  }
  const rows: Row[] = [];
  for (const { kind, label } of ROWS) {
    const blocks = byKind.get(kind);
    if (blocks === undefined || blocks.length === 0) continue;
    blocks.sort((a, b) => a.start - b.start || b.end - a.end);
    // First fit: each block in the first lane free by its start.
    const ends: number[] = [];
    let longest = 0;
    for (const block of blocks) {
      let lane = ends.findIndex((laneEnd) => laneEnd <= block.start);
      if (lane < 0) lane = ends.push(block.end) - 1;
      else ends[lane] = block.end;
      block.lane = lane;
      longest = Math.max(longest, block.end - block.start);
    }
    rows.push({ kind, label, lanes: Math.max(1, ends.length), blocks, longest });
  }
  return { rows, covers: coversOf(project, covering, rows), end };
}

/** Each cover with the footage block it's drawn on: its parent's, else the topmost footage or cut-in under its middle. */
function coversOf(project: Project, covering: Clip[], rows: Row[]): Cover[] {
  if (covering.length === 0) return [];
  const pictures = rows.filter((row) => row.kind === "footage" || row.kind === "cutins").flatMap((row) => row.blocks);
  const byId = new Map(pictures.map((block) => [block.clip.id, block]));
  const level = new Map(project.tracks.map((track, index) => [track.id, index]));
  const media = new Map(project.media.map((one) => [one.id, one]));
  return covering.map((clip) => {
    const start = clip.start;
    const end = clip.start + clip.duration;
    const middle = (start + end) / 2;
    let host = clip.parent !== undefined && clip.parent !== null ? (byId.get(clip.parent) ?? null) : null;
    if (host === null) {
      for (const block of pictures) {
        if (block.start > middle || block.end <= middle) continue;
        if (host === null || (level.get(block.clip.track) ?? 0) > (level.get(host.clip.track) ?? 0)) host = block;
      }
    }
    const own = clip.type === "video" ? (media.get(clip.media) ?? null) : null;
    return { clip, start, end, host, name: shownName(clip.name ?? own?.name ?? "Blur") };
  });
}

/** The index of the first block of `row` that may reach past `frame` (its blocks start in order; none is longer than `longest`). */
export function firstFrom(row: Row, frame: number): number {
  const from = frame - row.longest;
  let low = 0;
  let high = row.blocks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (row.blocks[mid]!.start < from) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The block of `row` under `frame` in `lane`, if any. */
export function blockAt(row: Row, lane: number, frame: number): Block | null {
  for (let at = firstFrom(row, frame); at < row.blocks.length; at++) {
    const block = row.blocks[at]!;
    if (block.start > frame) break;
    if (block.lane === lane && frame < block.end) return block;
  }
  return null;
}
