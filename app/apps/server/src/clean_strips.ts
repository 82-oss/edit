// Footage with another channel's subtitles taken out of its picture, or
// their see-through watermark (watermark_removal.ts, laid under a text strip
// of the same frames): the cleaned strip of each stretch is a media of its
// own (`Media::cleans`: which footage, which of its seconds, which box of its
// picture), stacked (see-through outside a feathered box round the
// subtitles' band), and laid here, on every save, as a clip over each clip of
// that footage it covers: on a lane just above the footage's own, timed to the
// same source seconds, placed over the box, stuck to the clip (`parent`: it
// pushes in and shakes with it) and fading as it fades. So a re-cut, a trim, a
// move or a reused case keeps its clean picture with nothing to redo, a clip
// of the footage new to the timeline gets it at once, and the export and
// every player draw it as they draw any see-through video.
//
// Where a strip covers a clip, a blur over the band (burned_subtitles.ts
// `cover`) gives way: blurring the clean picture would undo it.
//
// Text strips come from the model (text_inpaint.ts, where this machine has
// it); Vmake's, made before Nov 19 and kept on R2 (`edit/cleaned/…`), are
// still laid so finished edits don't change. Watermark strips come from the
// engine (watermark_removal.ts).

import type { Clip, Keyframe, Media, Project, Track, VideoClip } from "./model.ts";
import { clipEnd, fps as fpsOf, freshId, sample, trackOf } from "./project.ts";

/** Every overlay laid here is named so, its footage clip's id after it (a watermark's strips: `WATERMARK_NAME`). */
export const NAME = "Subtitles removed";
export const WATERMARK_NAME = "Watermark removed";
/** text_blur.ts's tracked blurs over their text, its footage clip's id after it: their text counts as gone there. */
export const TRACKED = "Text blur";
/** burned_subtitles.ts's covers (`COVER`): kept here so the store needn't load it. */
const COVER = "Burned-in cover";
/** burned_subtitles.ts's `UNTIL_REMOVED`: a still blur over their band that stood in while removal ran; none is laid now. */
const STAND_IN = `${COVER} · until removed`;
const isStandIn = (clip: Clip): boolean => clip.type === "adjustment" && (clip.name ?? "").startsWith(STAND_IN);

/** What a strip stands in for (`Media::cleans`). */
export interface Cleans {
  media: string;
  from: number;
  to: number;
  box: [number, number, number, number];
  /** What it took out: their text (the default) or their see-through watermark (watermark_removal.ts). */
  what?: "text" | "watermark";
}

type Strip = Media & { cleans: Cleans };

const isStrip = (media: Media): media is Strip => (media as { cleans?: Cleans | null }).cleans != null;
export const isOverlay = (clip: Clip): boolean => clip.type === "video" && ((clip.name ?? "").startsWith(`${NAME} · `) || (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `));
const isWatermark = (strip: Strip): boolean => strip.cleans.what === "watermark";
const ownerOf = (name: string | undefined): string | null => {
  const at = (name ?? "").lastIndexOf(" · ");
  return at < 0 ? null : name!.slice(at + 3);
};

/** Keys (frames into a clip) cut to [cut, cut + length) of it, a key at each new end. */
function trimmed(keys: Keyframe[], cut: number, length: number): Keyframe[] {
  if (keys.length === 0) return keys;
  const value = (frame: number) => sample(keys, frame) ?? keys[0]!.value;
  const inside = keys.filter((key) => key.frame > cut && key.frame < cut + length - 1).map((key) => ({ ...key, frame: key.frame - cut }));
  return [{ frame: 0, value: value(cut), ease: "linear" as const }, ...inside, ...(length > 1 ? [{ frame: length - 1, value: value(cut + length - 1), ease: "linear" as const }] : [])];
}

/** Frames [a, b) less `holes`. */
function minus(spans: [number, number][], holes: [number, number][]): [number, number][] {
  let out = spans;
  for (const [a, b] of holes) out = out.flatMap(([x, y]): [number, number][] => (b <= x || a >= y ? [[x, y]] : ([[x, Math.min(y, a)], [Math.max(x, b), y]] as [number, number][]).filter(([p, q]) => q > p)));
  return out;
}

/** The frames of `clip` (timeline, [a, b)) whose source second is inside the strip. */
function covered(project: Project, clip: VideoClip, strip: Strip): [number, number] | null {
  const fps = fpsOf(project);
  const speed = clip.speed ?? 1;
  if (!(speed > 0)) return null;
  const step = 1 / Math.max(1, strip.fps || fps);
  const a = clip.start + Math.ceil(((strip.cleans.from - clip.source_in) * fps) / speed - 1e-6);
  const b = clip.start + Math.floor(((strip.cleans.to - step - clip.source_in) * fps) / speed + 1e-6) + 1;
  const from = Math.max(a, clip.start);
  const to = Math.min(b, clipEnd(clip));
  return to - from >= 1 ? [from, to] : null;
}

/** The strip's transform as it sits over `clip` at rest (its parent's own transform; the parent's moves carry it). */
function placed(project: Project, clip: VideoClip, footage: Media, strip: Strip): { x: number; y: number; scale: number; rotation: number } {
  const { width, height } = project.settings;
  const [mw, mh] = [footage.width || width, footage.height || height];
  const own = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
  const fit = Math.min(width / mw, height / mh) * (own.scale ?? 1);
  const [x0, y0, x1, y1] = strip.cleans.box;
  const [dx, dy] = [((x0 + x1) / 2 - 0.5) * mw * fit, ((y0 + y1) / 2 - 0.5) * mh * fit];
  const turn = ((own.rotation ?? 0) * Math.PI) / 180;
  const [sw, sh] = [strip.width || 1, strip.height || 1];
  const stripFit = Math.min(width / sw, height / sh);
  const r = (value: number) => Math.round(value * 1000) / 1000;
  return {
    x: r((own.x ?? 0) + dx * Math.cos(turn) - dy * Math.sin(turn)),
    y: r((own.y ?? 0) + dx * Math.sin(turn) + dy * Math.cos(turn)),
    scale: Math.round((((x1 - x0) * mw * fit) / (sw * stripFit)) * 1e5) / 1e5,
    rotation: own.rotation ?? 0,
  };
}

/** The footage clip's crop as the strip's own (shares of the strip's picture). */
function cropFor(clip: VideoClip, box: Cleans["box"]): VideoClip["crop"] | undefined {
  const crop = clip.crop;
  if (crop === undefined || crop === null) return undefined;
  const [x0, y0, x1, y1] = box;
  const share = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1e4) / 1e4;
  const out = {
    left: share(((crop.left ?? 0) - x0) / (x1 - x0)),
    right: share((x1 - (1 - (crop.right ?? 0))) / (x1 - x0)),
    top: share(((crop.top ?? 0) - y0) / (y1 - y0)),
    bottom: share((y1 - (1 - (crop.bottom ?? 0))) / (y1 - y0)),
  };
  return out.left === 0 && out.right === 0 && out.top === 0 && out.bottom === 0 ? undefined : out;
}

/** What an overlay should be, less its id and lane (what's compared to tell whether anything changed). */
type Wanted = Omit<VideoClip, "id" | "track">;

function wanted(project: Project): Wanted[] {
  const strips = new Map<string, Strip[]>();
  for (const media of project.media) {
    if (!isStrip(media)) continue;
    strips.set(media.cleans.media, [...(strips.get(media.cleans.media) ?? []), media]);
  }
  if (strips.size === 0) return [];
  const out: Wanted[] = [];
  // Their text's strips first, then their watermark's: laid in that order, a watermark strip over the same frames
  // gets the lane under the text strip's (laneFor), so where both cleaned the text strip's picture shows.
  for (const kind of ["text", "watermark"] as const)
  for (const clip of project.clips) {
    if (clip.type !== "video" || isOverlay(clip) || trackOf(project, clip.track)?.hidden === true) continue;
    const mine = strips.get(clip.media)?.filter((strip) => (kind === "watermark") === isWatermark(strip));
    const footage = mine === undefined ? undefined : project.media.find((one) => one.id === clip.media);
    if (mine === undefined || mine.length === 0 || footage === undefined) continue;
    const taken: [number, number][] = [];
    for (const strip of [...mine].sort((a, b) => a.cleans.from - b.cleans.from || b.cleans.to - a.cleans.to)) {
      const span = covered(project, clip, strip);
      if (span === null) continue;
      for (const [a, b] of minus([span], taken)) {
        if (b - a < 1) continue;
        taken.push([a, b]);
        const fps = fpsOf(project);
        const into = a - clip.start;
        const opacity = clip.keyframes?.opacity;
        const crop = cropFor(clip, strip.cleans.box);
        const overlay = {
          start: a,
          duration: b - a,
          color: clip.color,
          name: `${kind === "watermark" ? WATERMARK_NAME : NAME} · ${clip.id}`,
          parent: clip.id,
          fade_in: a === clip.start ? clip.fade_in : 0,
          fade_out: b === clipEnd(clip) ? clip.fade_out : 0,
          keyframes: opacity !== undefined && opacity.length > 0 ? { opacity: trimmed(opacity, into, b - a) } : {},
          type: "video",
          media: strip.id,
          source_in: Math.round((clip.source_in + (into / fps) * (clip.speed ?? 1) - strip.cleans.from) * 1e6) / 1e6,
          speed: clip.speed ?? 1,
          transform: placed(project, clip, footage, strip),
          opacity: clip.opacity ?? 1,
          ...(crop !== undefined ? { crop } : {}),
          ...(clip.blend !== undefined && clip.blend !== "normal" ? { blend: clip.blend } : {}),
        } as Wanted;
        out.push(overlay);
      }
    }
  }
  return out;
}

/** Numbers to 1e-4: saving keeps the engine's f32s, so a value read back differs in its last digits. */
function rounded(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 1e4) / 1e4;
  if (Array.isArray(value)) return value.map(rounded);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, one]) => [name, rounded(one)]));
  return value;
}

const keyOf = (clip: Wanted | VideoClip): string => {
  const one = clip as VideoClip;
  const keys = one.keyframes !== undefined && Object.keys(one.keyframes).length > 0 ? one.keyframes : null;
  const { x, y, scale, rotation } = one.transform;
  return JSON.stringify(rounded([one.start, one.duration, one.parent, one.media, one.source_in, one.speed, [x, y, scale, rotation ?? 0], one.opacity, one.crop ?? null, one.blend ?? "normal", one.fade_in, one.fade_out, keys]));
};

/** Whether `lane` is above `owner`'s track with only overlay lanes between (a watermark's under a text strip's, a tracked blur's). */
function laneAbove(project: Project, owner: string, lane: string): boolean {
  const at = project.tracks.findIndex((track) => track.id === owner);
  const there = project.tracks.findIndex((track) => track.id === lane);
  if (at < 0 || there <= at) return false;
  // Strips' lanes, and the tracked blurs' laid just above their clip (text_blur.ts), between.
  const laidOver = (clip: Clip) => isOverlay(clip) || (clip.type === "adjustment" && (clip.name ?? "").startsWith(`${TRACKED} · `));
  return project.tracks.slice(at + 1, there).every((track) => project.clips.some((clip) => clip.track === track.id) && project.clips.filter((clip) => clip.track === track.id).every(laidOver));
}

const isWatermarkOverlay = (clip: Clip | Wanted): boolean => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `);

/**
 * A lane for an overlay of `track`'s footage over [start, end): a free one of
 * the overlay lanes just above it, else a new one there. Where a text strip and
 * a watermark strip cover the same frames the text strip's lane is the higher
 * (its picture shows), so a text overlay goes above every watermark overlay it
 * meets and a watermark overlay below every text overlay it meets.
 */
function laneFor(project: Project, track: string, watermark: boolean, start: number, end: number): string {
  const at = project.tracks.findIndex((one) => one.id === track);
  // The overlay lanes right above the footage's, bottom first.
  const stack: Track[] = [];
  for (const lane of project.tracks.slice(at + 1)) {
    if (lane.kind !== "video" || lane.subtitles === true || lane.hidden === true) break;
    const there = project.clips.filter((clip) => clip.track === lane.id);
    if (there.length === 0 || !there.every(isOverlay)) break;
    stack.push(lane);
  }
  const meets = (lane: Track) => project.clips.filter((clip) => clip.track === lane.id && clip.start < end && start < clipEnd(clip));
  let lo = 0;
  let hi = stack.length - 1;
  stack.forEach((lane, index) => {
    for (const clip of meets(lane)) {
      if (watermark && !isWatermarkOverlay(clip)) hi = Math.min(hi, index - 1);
      if (!watermark && isWatermarkOverlay(clip)) lo = Math.max(lo, index + 1);
    }
  });
  for (let index = lo; index <= hi; index++) if (meets(stack[index]!).length === 0) return stack[index]!.id;
  const id = freshId(project, "v");
  const lane: Track = { id, kind: "video", hidden: false, muted: false, locked: false };
  // A watermark's new lane at the bottom (under every text overlay); a text strip's just above the watermarks it meets.
  project.tracks.splice(at + 1 + (watermark ? 0 : lo), 0, lane);
  return id;
}

/**
 * The frames (timeline, [a, b)) each footage clip's strips cover, by clip id:
 * from the strips themselves, so it holds before the overlays are laid
 * (burned_subtitles.ts reads it to tell their subtitles gone there).
 */
export function strippedFrames(project: Project): Map<string, [number, number][]> {
  const out = trackedFrames(project);
  for (const one of wanted(project)) {
    if (!(one.name ?? "").startsWith(`${NAME} · `)) continue;
    out.set(one.parent!, [...(out.get(one.parent!) ?? []), [one.start, one.start + one.duration]]);
  }
  return out;
}

/** The frames each footage clip's tracked blurs (text_blur.ts) cover, by clip id. */
function trackedFrames(project: Project): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  for (const clip of project.clips) {
    if (clip.type !== "adjustment" || !(clip.name ?? "").startsWith(`${TRACKED} · `)) continue;
    const owner = ownerOf(clip.name);
    if (owner !== null) out.set(owner, [...(out.get(owner) ?? []), [clip.start, clipEnd(clip)]]);
  }
  return out;
}

/** Blurs over the band (burned_subtitles' covers) cut where a strip now covers their clip. */
function trimCovers(project: Project, stripped: Map<string, [number, number][]>): void {
  if (stripped.size === 0) return;
  const next: Clip[] = [];
  for (const clip of project.clips) {
    const owner = clip.type === "adjustment" && (clip.name ?? "").startsWith(COVER) ? ownerOf(clip.name) : null;
    const holes = owner === null ? undefined : stripped.get(owner);
    if (holes === undefined) {
      next.push(clip);
      continue;
    }
    const left = minus([[clip.start, clipEnd(clip)]], holes);
    if (left.length === 1 && left[0]![0] === clip.start && left[0]![1] === clipEnd(clip)) {
      next.push(clip);
      continue;
    }
    left.forEach(([a, b], index) => {
      if (b - a < 2) return;
      const keyframes: Record<string, Keyframe[]> = {};
      for (const [param, keys] of Object.entries(clip.keyframes ?? {})) if (keys.length > 0) keyframes[param] = trimmed(keys, a - clip.start, b - a);
      const piece = { ...clip, start: a, duration: b - a, keyframes } as Clip;
      if (index > 0) {
        const all = { ...project, clips: [...project.clips, ...next] };
        piece.id = freshId(all, "c");
        project.next_id = all.next_id;
      }
      next.push(piece);
    });
  }
  project.clips = next;
}

/**
 * The house rule kept on every save (the store's, as pointers.ts's): each
 * clip of footage that has cleaned strips shows them, and nothing else is
 * touched. Only what changed changes: an overlay that's still wanted, on a
 * lane still right for it, stays as it is (its id, its lane), so a strip
 * finished, taken out or re-cut touches only its own overlays, and nothing
 * drawn over the rest of the timeline (an effect's picture beneath,
 * effect_inputs.ts) is changed by it (Nov 18, Sphe's M4: each piece done laid
 * every overlay again with new ids, and ~50 effects drawn over footage went
 * back to waiting every few minutes, never catching up).
 */
export function enforceCleanStrips(_before: Project | null, project: Project): void {
  // The still blurs that stood in while their text was taken out go wherever they're left (Nov 19, the Boyfriends
  // intro: over cleaned frames, over frames with none of their words, one on a clip re-cut since): the removal itself
  // takes their words out of the picture or blurs them tight, and marks say where.
  if (project.clips.some(isStandIn)) project.clips = project.clips.filter((clip) => !isStandIn(clip));
  const old = project.clips.filter((clip): clip is VideoClip => isOverlay(clip));
  const tracked = trackedFrames(project);
  if (old.length === 0 && !project.media.some(isStrip)) {
    // No strips: only a tracked blur's frames end the blur over their band.
    if (tracked.size > 0) trimCovers(project, tracked);
    return;
  }
  const want = wanted(project);
  const owners = new Map(project.clips.map((clip) => [clip.id, clip]));
  // Each overlay that's as it should be, on a lane above its footage's, by what it is.
  const standing = new Map<string, VideoClip[]>();
  for (const one of old) {
    const owner = one.parent == null ? undefined : owners.get(one.parent);
    if (owner === undefined || !laneAbove(project, owner.track, one.track)) continue;
    standing.set(keyOf(one), [...(standing.get(keyOf(one)) ?? []), one]);
  }
  const kept = new Set<string>();
  const missing: Wanted[] = [];
  for (const one of want) {
    const match = standing.get(keyOf(one))?.shift();
    if (match !== undefined) kept.add(match.id);
    else missing.push(one);
  }
  const gone = new Set(old.filter((clip) => !kept.has(clip.id)).map((clip) => clip.id));
  if (gone.size > 0 || missing.length > 0) {
    const lanes = new Set(old.filter((clip) => gone.has(clip.id)).map((clip) => clip.track));
    project.clips = project.clips.filter((clip) => !gone.has(clip.id));
    // Lanes left empty that held the overlays taken out go with them.
    project.tracks = project.tracks.filter((track) => !lanes.has(track.id) || project.clips.some((clip) => clip.track === track.id));
    for (const one of missing) {
      const owner = owners.get(one.parent!);
      if (owner === undefined) continue;
      const clip = { ...one, id: freshId(project, "c"), track: laneFor(project, owner.track, isWatermarkOverlay(one), one.start, one.start + one.duration) } as VideoClip;
      if (clip.keyframes !== undefined && Object.keys(clip.keyframes).length === 0) delete (clip as { keyframes?: unknown }).keyframes;
      project.clips.push(clip);
    }
  }
  // Only their text's strips (and tracked blurs) end the blur over their subtitles (a watermark's leaves the subtitles there).
  const stripped = tracked;
  for (const one of want) {
    if (!(one.name ?? "").startsWith(`${NAME} · `)) continue;
    stripped.set(one.parent!, [...(stripped.get(one.parent!) ?? []), [one.start, one.start + one.duration]]);
  }
  if (stripped.size > 0) trimCovers(project, stripped);
}
