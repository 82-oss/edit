// Taking the music out from under footage's voices, and bringing a moment of
// the original back (Sphe and JJ, Nov 23: a source with music under the
// dialogue). `remove_music` sends only the stretches the edit plays through
// the relay (ElevenLabs' Voice Isolator, $0.12 a minute) and points those sounds
// at the cleaned file, which keeps the source's clock, so cuts, mutes, subtitles
// and words all stay as they are and no word is transcribed again.
//
// Isolation can drop a quiet word. A loudness check against the transcript was
// tried on 534 words and rejected: it missed 15% of known losses and flagged
// words that were fine. So the team says where they hear one, and
// `bring_back_sound` crossfades to the original for just that stretch; asked
// again with other times, it replaces it (longer, shorter, or undone).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { cachedTranscript, transcriptOf } from "./captions_core.ts";
import * as diag from "./diag.ts";
import { importPaths } from "./import.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { Clip, Media, Project, Word } from "./model.ts";
import {
  cleanedInfo,
  cleanedMarker,
  cleanedOf,
  covers,
  MARK,
  merged,
  missing,
  sourceRange,
  type AudioClip,
  type Stretch,
} from "./music_removed.ts";
import * as paidWork from "./paid.ts";
import { join, parent } from "./paths.ts";
import { clipEnd, fps as fpsOf, freshId, mediaOf } from "./project.ts";
import * as relay from "./relay.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";
import { ffmpeg, run } from "./tools.ts";

/** Seconds of source cleaned past each end of a sound: room for a small trim or a crossfade. */
const HANDLE = 1;
/** The relay takes up to 10 minutes a request (isolate.ts). */
const MOST_SECONDS = 540;
/** How long the crossfade to the original and back is, by default (frames). */
const FADE_FRAMES = 6;
/** How far past a word an edge is moved so it doesn't cut through it (seconds). */
const WORD_GUARD = 0.04;
/** What a brought-back piece is called on the timeline, and how it's told apart. */
export const ORIGINAL_SOUND = "Original sound";

const isOriginalPiece = (clip: AudioClip) => clip.name === ORIGINAL_SOUND || clip.name?.startsWith(`${ORIGINAL_SOUND} · `) === true;
const withoutLabel = (name: string | undefined) => {
  if (name === ORIGINAL_SOUND) return undefined;
  return name?.startsWith(`${ORIGINAL_SOUND} · `) ? name.slice(ORIGINAL_SOUND.length + 3) : name;
};

function isFootageSound(project: Project, clip: Clip): clip is AudioClip {
  if (clip.type !== "audio") return false;
  const media = mediaOf(project, clip.media);
  return media !== undefined && media.has_audio && media.library === undefined && media.effect === undefined && !seams.voiceover.isVoiceover(project, clip);
}

/** The sounds in frames from–to that remove_music should clean, by the source they play. */
export function soundsToClean(project: Project, from: number, to: number): Map<string, AudioClip[]> {
  const out = new Map<string, AudioClip[]>();
  // A muted track isn't heard, so it's never paid for.
  const muted = new Set(project.tracks.filter((track) => track.muted).map((track) => track.id));
  for (const clip of project.clips) {
    if (clipEnd(clip) <= from || clip.start >= to || muted.has(clip.track) || !isFootageSound(project, clip) || isOriginalPiece(clip) || oneSide(clip)) continue;
    const media = mediaOf(project, clip.media)!;
    const source = cleanedInfo(media)?.of ?? media.id;
    out.set(source, [...(out.get(source) ?? []), clip]);
  }
  return out;
}

/**
 * A sound playing one side of its source: the cleaned file is one channel, so
 * it would bring back the side left out. It stays on the original.
 */
const oneSide = (clip: AudioClip) => clip.channel === "left" || clip.channel === "right";

/** Footage sounds in frames from–to left with their music because they play one side of the source. */
export function oneSidedIn(project: Project, from: number, to: number): number {
  const muted = new Set(project.tracks.filter((track) => track.muted).map((track) => track.id));
  return project.clips.filter((clip) => clipEnd(clip) > from && clip.start < to && !muted.has(clip.track) && isFootageSound(project, clip) && oneSide(clip)).length;
}

/** The seconds of its source a sound plays within frames from–to: what's asked for is all that's sent. */
export function playedIn(project: Project, clip: AudioClip, from: number, to: number): Stretch {
  const rate = fpsOf(project);
  const at = (frame: number) => clip.source_in + ((frame - clip.start) / rate) * clip.speed;
  return [at(Math.max(clip.start, from)), at(Math.min(clipEnd(clip), to))];
}

/**
 * The part of each sound inside frames from–to plays the cleaned file, the
 * rest staying as it was, with a crossfade where a take carries on across the
 * edge. Returns how many sounds moved.
 */
export function moveToCleaned(project: Project, ids: readonly string[], original: string, cleaned: string, stretches: readonly Stretch[], from: number, to: number): number {
  // Where each sound is, taken before any razor: splitting one sound splits those linked to it on other tracks too,
  // so after the splits a sound is found by its track and place, not by its id.
  const places = ids.flatMap((id) => {
    const clip = project.clips.find((one): one is AudioClip => one.id === id && one.type === "audio" && one.media === original);
    if (clip === undefined || clipEnd(clip) <= from || clip.start >= to) return [];
    const [start, end] = playedIn(project, clip, from, to);
    if (!covers(stretches, start, end)) return [];
    return [{ track: clip.track, from: Math.max(clip.start, from), to: Math.min(clipEnd(clip), to) }];
  });
  for (const place of places) {
    for (const frame of [place.from, place.to]) {
      const through = audioAt(project, place.track, (one) => one.media === original && one.start < frame && clipEnd(one) > frame);
      if (through !== undefined) splitLinked(project, through, frame);
    }
  }
  let count = 0;
  for (const place of places) {
    const inside = audioAt(project, place.track, (one) => one.media === original && one.start === place.from && clipEnd(one) === place.to);
    if (inside === undefined) continue;
    const before = audioAt(project, inside.track, (one) => clipEnd(one) === inside.start && one.media === original && continues(project, one, inside));
    const after = audioAt(project, inside.track, (one) => one.start === clipEnd(inside) && one.media === original && continues(project, inside, one));
    inside.media = cleaned;
    if (before !== undefined) inside.crossfade = FADE_FRAMES;
    if (after !== undefined) after.crossfade = FADE_FRAMES;
    count++;
  }
  return count;
}

/** Stretches no longer than a request takes. */
export function requests(stretches: readonly Stretch[], most = MOST_SECONDS): Stretch[] {
  return stretches.flatMap(([from, to]) => {
    const out: Stretch[] = [];
    for (let at = from; at < to; at += most) out.push([at, Math.min(to, at + most)]);
    return out;
  });
}

const seconds = (value: number) => value.toFixed(3);

/** The one WAV format the relay takes, so it can read the billed length from the file (relay's isolate.ts). */
export function wavCommand(input: string, [from, to]: Stretch, out: string): string[] {
  return [ffmpeg(), "-nostdin", "-v", "error", "-y", "-ss", seconds(from), "-t", seconds(to - from), "-i", input, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", out];
}

/** A stretch with its music taken out, and how many seconds were sent for it (none when it was kept from a try that failed later). */
async function isolatedPiece(input: string, dir: string, [from, to]: Stretch, signal?: AbortSignal): Promise<{ file: string; sent: number }> {
  const out = join(dir, `${Math.round(from * 1000)}-${Math.round(to * 1000)}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { file: out, sent: 0 };
  const wav = `${out}.wav`;
  const partial = `${out}.partial`;
  await run(wavCommand(input, [from, to], wav), { background: true, ...(signal === undefined ? {} : { signal }) });
  try {
    await paidWork.paid(async () => {
      for (let attempt = 0; ; attempt++) {
        const answer = await fetch(`${relay.url()}/v1/isolate`, {
          method: "POST",
          headers: { ...(await relay.signedHeaders()), "content-type": "audio/wav" },
          body: Bun.file(wav),
          ...(signal === undefined ? {} : { signal }),
        }).catch((error: unknown) => {
          if (attempt >= 2) throw new Error(`${relay.UNREACHABLE}: ${diag.messageOf(error)}`);
          return null;
        });
        if (answer?.ok === true) {
          await Bun.write(partial, answer);
          await fs.promises.rename(partial, out);
          return;
        }
        if (answer !== null && (![502, 503, 504].includes(answer.status) || attempt >= 2)) {
          const said = await answer.text().catch(() => "");
          let reason = said.slice(0, 300);
          try {
            reason = (JSON.parse(said) as { error?: string }).error ?? reason;
          } catch {
            // Not JSON: its first words.
          }
          throw new Error(`music removal was refused (${answer.status}): ${reason}`);
        }
        await Bun.sleep(2000 * (attempt + 1));
      }
    });
  } finally {
    await fs.promises.rm(wav, { force: true });
    await fs.promises.rm(partial, { force: true });
  }
  return { file: out, sent: to - from };
}

/** One removal per source at a time, whoever asks (the agent, MCP, two projects): they share its pieces and its folder. */
const cleaning = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const ahead = cleaning.get(key) ?? Promise.resolve();
  const mine = ahead.catch(() => undefined).then(work);
  const held = mine.catch(() => undefined);
  cleaning.set(key, held);
  try {
    return await mine;
  } finally {
    if (cleaning.get(key) === held) cleaning.delete(key);
  }
}

/** The cleaned file: what was cleaned before, with the new pieces laid in at their times, silence elsewhere. */
export async function buildFile(base: string | null, pieces: { file: string; from: number; to: number }[], length: number, out: string, signal?: AbortSignal): Promise<void> {
  const inputs = base === null ? ["-f", "lavfi", "-t", seconds(length), "-i", "anullsrc=r=44100:cl=mono"] : ["-i", base];
  for (const piece of pieces) inputs.push("-i", piece.file);
  const format = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono";
  const laid = pieces.map(
    (piece, index) => `[${index + 1}:a]atrim=0:${seconds(piece.to - piece.from)},asetpts=PTS-STARTPTS,${format},adelay=${Math.round(piece.from * 1000)}:all=1[p${index}]`,
  );
  const graph = [`[0:a]${format}[base]`, ...laid, `[base]${pieces.map((_, index) => `[p${index}]`).join("")}amix=inputs=${pieces.length + 1}:normalize=0:duration=first[out]`].join(";");
  await run([ffmpeg(), "-nostdin", "-v", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-t", seconds(length), "-c:a", "flac", out], {
    background: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Seconds from–to (either open) as the frames that cover them; an empty or reversed span is refused before it's rounded. */
export function spanFrames(rate: number, from: number | null, to: number | null): [number, number] {
  if (to !== null && !(to > (from ?? 0))) throw new Error("end must be after start");
  return [from === null ? 0 : Math.floor(from * rate), to === null ? Number.MAX_SAFE_INTEGER : Math.ceil(to * rate)];
}

/** Cleans the sounds in a span of the edit (all of it by default). Only what isn't cleaned yet is paid for. */
export async function removeMusic(app: App, id: string, from: number | null, to: number | null, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const [first, last] = spanFrames(fpsOf(live.project), from, to);
  const groups = soundsToClean(live.project, first, last);
  const sided = oneSidedIn(live.project, first, last);
  if (groups.size === 0) throw new Error(sided > 0 ? "the footage sound there plays one side of its source (left or right), which music removal can't keep apart" : "there's no footage sound in that span");
  let paidSeconds = 0;
  let moved = 0;
  for (const originalId of groups.keys()) {
    const source = mediaOf(live.project, originalId);
    if (source === undefined) continue;
    const key = new Bun.CryptoHasher("sha256").update(source.cloud?.source ?? source.path).digest("hex").slice(0, 24);
    const [sent, changed] = await oneAtATime(key, () => cleanSource(app, id, originalId, key, first, last, signal));
    paidSeconds += sent;
    moved += changed;
  }
  return {
    sounds_cleaned: moved,
    seconds_sent: Math.round(paidSeconds * 10) / 10,
    cost_usd: Math.round((paidSeconds / 60) * 0.12 * 100) / 100,
    then: "Listen back. Where the team hears a word lost, use bring_back_sound at that moment.",
    ...(sided > 0 ? { left_with_music: sided, why: "they play one side of their source (left or right): cleaning makes one channel, which would bring back the side left out" } : {}),
  };
}

/** One source's sounds in frames first–last cleaned, read afresh once it's this one's turn: seconds sent and sounds moved. */
async function cleanSource(app: App, id: string, originalId: string, key: string, first: number, last: number, signal?: AbortSignal): Promise<[number, number]> {
  const project = app.store.get(id)?.project;
  const original = project === undefined ? undefined : mediaOf(project, originalId);
  if (project === undefined || original === undefined) return [0, 0];
  // Chosen now, not when asked: a removal just before this one may have cut or moved them.
  const sounds = soundsToClean(project, first, last).get(originalId) ?? [];
  const before = cleanedOf(project, originalId);
  const had = before === undefined ? [] : (cleanedInfo(before)?.stretches ?? []);
  const wanted = merged(
    sounds.map((clip): Stretch => {
      const [start, end] = playedIn(project, clip, first, last);
      return [Math.max(0, start - HANDLE), Math.min(original.duration, end + HANDLE)];
    }),
  );
  const need = missing(wanted, had);
  let paidSeconds = 0;
  let cleanedId = before?.id;
  let stretches = had;
  if (need.length > 0) {
    // Its words first: the cleaned file shares them, so nothing is heard twice.
    await transcriptOf(app, original, project);
    const dir = join(app.store.cacheDir(), "music-removed", key);
    await fs.promises.mkdir(dir, { recursive: true });
    const input = await app.media.analysisInput(original.path);
    const pieces: { file: string; from: number; to: number }[] = [];
    for (const piece of requests(need)) {
      const { file, sent } = await isolatedPiece(input, dir, piece, signal);
      pieces.push({ file, from: piece[0], to: piece[1] });
      paidSeconds += sent;
    }
    const folder = join(app.store.uploadsDir(id), "music-removed");
    await fs.promises.mkdir(folder, { recursive: true });
    const out = join(folder, `${original.name.replace(/\.[^.]+$/u, "").replaceAll("/", "-")} (music removed ${Date.now()}).flac`);
    const base = before === undefined ? null : await app.media.analysisInput(before.path);
    await buildFile(base, pieces, original.duration, out, signal);
    const words = app.media.paths(fs.realpathSync(out)).transcript;
    await fs.promises.mkdir(parent(words) ?? dir, { recursive: true });
    await fs.promises.copyFile(app.media.paths(original.path).transcript, words);
    const [, added, errors] = await importPaths(app, id, [out], false, "voice");
    cleanedId = added[0];
    if (cleanedId === undefined) throw new Error(`Couldn't bring in the cleaned sound: ${errors.join("; ")}`);
    stretches = merged([...had, ...need]);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  if (cleanedId === undefined) return [paidSeconds, 0];
  const newId = cleanedId;
  const ids = sounds.map((clip) => clip.id);
  const [, changed] = await app.store.update(id, "agent", (draft) => {
    const media = mediaOf(draft, newId);
    if (media === undefined) throw new Error("the cleaned sound went missing");
    // Its own marker replaced; any other (a word kept unmuted) stays.
    const seams = before === undefined ? undefined : cleanedInfo(before)?.seams;
    media.markers = [...(media.markers ?? []).filter((marker) => marker.name !== MARK), cleanedMarker({ of: originalId, stretches, ...(seams === undefined ? {} : { seams }) })];
    if (before !== undefined && newId !== before.id) {
      for (const clip of draft.clips) if (clip.type === "audio" && clip.media === before.id) clip.media = newId;
      draft.media = draft.media.filter((one) => one.id !== before.id);
    }
    return moveToCleaned(draft, ids, originalId, newId, stretches, first, last);
  });
  return [paidSeconds, changed];
}

/**
 * The razor at `frame` through a clip, whatever's linked to it and whatever
 * follows it (an overlay parented to it), as the timeline's split does: each
 * part after the cut follows the part it's on.
 */
function splitLinked(project: Project, clip: Clip, frame: number): void {
  const crosses = (one: Clip) => one.start < frame && clipEnd(one) > frame;
  if (!crosses(clip)) return;
  const rate = fpsOf(project);
  const group: Clip[] = [];
  const add = (one: Clip) => {
    if (group.includes(one)) return;
    group.push(one);
    for (const other of project.clips) {
      if (!crosses(other)) continue;
      if ((one.link !== undefined && other.link === one.link) || other.parent === one.id) add(other);
    }
  };
  add(clip);
  const links = new Map<string, string>();
  const halves = new Map<string, string>();
  for (const one of group) {
    const offset = frame - one.start;
    const right = structuredClone(one);
    right.id = freshId(project, "c");
    right.start = frame;
    right.duration = one.duration - offset;
    right.fade_in = 0;
    // A split's halves play straight on: no crossfade between them.
    if (right.type === "audio") delete right.crossfade;
    if (one.link !== undefined) {
      if (!links.has(one.link)) links.set(one.link, freshId(project, "l"));
      right.link = links.get(one.link)!;
    }
    if (right.type === "video" || right.type === "audio") right.source_in += (offset / rate) * right.speed;
    for (const keys of Object.values(right.keyframes ?? {})) for (const key of keys) key.frame -= offset;
    one.duration = offset;
    one.fade_out = 0;
    project.clips.push(right);
    halves.set(one.id, right.id);
  }
  for (const one of project.clips) {
    if (one.parent !== undefined && halves.has(one.parent) && one.start >= frame) one.parent = halves.get(one.parent)!;
  }
}

/** Whether `after` plays on from `before` in the same source (a split, not a real cut). */
function continues(project: Project, before: AudioClip, after: AudioClip): boolean {
  if (before.track !== after.track || clipEnd(before) !== after.start || before.speed !== after.speed) return false;
  return Math.abs(sourceRange(project, before)[1] - after.source_in) < 0.5 / fpsOf(project);
}

/** What differs between the two halves of a split: everything else (a level, a side, a crop, a look) must match to join them. */
const SEAM_FIELDS = new Set(["id", "start", "duration", "link", "source_in", "fade_in", "fade_out", "keyframes", "room", "crossfade"]);
const playback = (clip: Clip) => stableStringify(Object.fromEntries(Object.entries(clip).filter(([key]) => !SEAM_FIELDS.has(key))));

/** Whether `after` is the same take carrying on from `before`, nothing to tell them apart at the seam. */
function sameTake(project: Project, before: Clip, after: Clip): boolean {
  if (clipEnd(before) !== after.start || before.fade_out !== 0 || after.fade_in !== 0 || playback(before) !== playback(after)) return false;
  if ((before.type !== "video" && before.type !== "audio") || (after.type !== "video" && after.type !== "audio")) return false;
  if (Math.abs(before.source_in + (before.duration / fpsOf(project)) * before.speed - after.source_in) >= 0.5 / fpsOf(project)) return false;
  if (after.type === "audio" && (after.crossfade ?? 0) !== 0) return false;
  // A split leaves both halves the same keys, the right one's shifted back.
  const shifted = Object.fromEntries(Object.entries(after.keyframes ?? {}).map(([param, keys]) => [param, keys.map((key) => ({ ...key, frame: key.frame + before.duration }))]));
  return JSON.stringify(shifted) === JSON.stringify(before.keyframes ?? {});
}

/** The cut at `frame` taken out again where picture and sound both carry straight on, so tweaks leave no stray cuts. */
function rejoinAt(project: Project, frame: number): void {
  for (const right of project.clips.filter((clip): clip is AudioClip => clip.type === "audio" && clip.start === frame)) {
    const left = project.clips.find((clip) => clip.type === "audio" && clip.track === right.track && clipEnd(clip) === frame);
    if (left === undefined) continue;
    const lefts = left.link === undefined ? [left] : project.clips.filter((clip) => clip.link === left.link);
    const rights = right.link === undefined ? [right] : project.clips.filter((clip) => clip.link === right.link);
    if (lefts.length !== rights.length) continue;
    const pairs = lefts.map((one) => [one, rights.find((other) => other.track === one.track)] as const);
    if (!pairs.every(([one, other]) => other !== undefined && sameTake(project, one, other))) continue;
    const gone = new Map<string, string>();
    for (const [one, other] of pairs) {
      one.duration += other!.duration;
      one.fade_out = other!.fade_out;
      gone.set(other!.id, one.id);
    }
    project.clips = project.clips.filter((clip) => !gone.has(clip.id));
    for (const clip of project.clips) if (clip.parent !== undefined && gone.has(clip.parent)) clip.parent = gone.get(clip.parent)!;
  }
}

const audioAt = (project: Project, track: string, test: (clip: AudioClip) => boolean) =>
  project.clips.find((clip): clip is AudioClip => clip.type === "audio" && clip.track === track && test(clip));

function originalOfPiece(project: Project, clip: AudioClip): Media | undefined {
  return isOriginalPiece(clip) ? cleanedOf(project, clip.media) : undefined;
}

const seamKey = (track: string, frame: number) => `${track}@${frame}`;

/** The seams a brought-back piece set, and what they had before, kept on the cleaned file (Cleaned.seams). */
function seamsOf(media: Media): Record<string, number> {
  return { ...cleanedInfo(media)?.seams };
}
function setSeams(media: Media, seams: Record<string, number>): void {
  const info = cleanedInfo(media);
  if (info === null) return;
  const { seams: _, ...rest } = info;
  const marker = cleanedMarker(Object.keys(seams).length === 0 ? rest : { ...rest, seams });
  media.markers = (media.markers ?? []).map((one) => (one.name === MARK ? marker : one));
}

/**
 * Frames from–to play the original sound, crossfading in and out over `fade`
 * frames. Any brought-back piece touching that span is replaced by it, so
 * asking again with other times makes it longer or shorter. `undo`: the span
 * goes back to the cleaned sound.
 */
export function applyBringBack(project: Project, from: number, to: number, fade: number, undo: boolean): { pieces: number; undone: number } {
  if (!(to > from)) throw new Error("end must be after start");
  let undone = 0;
  const seams = new Set<number>();
  for (const clip of project.clips) {
    if (clip.type !== "audio" || clipEnd(clip) <= from || clip.start >= to) continue;
    const cleaned = originalOfPiece(project, clip);
    if (cleaned === undefined) continue;
    seams.add(clip.start).add(clipEnd(clip));
    // Each seam gets back the crossfade it had before the piece (none, where the piece's own split made it).
    const kept = seamsOf(cleaned);
    const restore = (one: AudioClip) => {
      const key = seamKey(one.track, one.start);
      if ((kept[key] ?? 0) === 0) delete one.crossfade;
      else one.crossfade = kept[key];
      delete kept[key];
    };
    const after = audioAt(project, clip.track, (one) => one.start === clipEnd(clip) && one.media === cleaned.id);
    if (after !== undefined) restore(after);
    restore(clip);
    setSeams(cleaned, kept);
    clip.media = cleaned.id;
    const name = withoutLabel(clip.name);
    if (name === undefined) delete clip.name;
    else clip.name = name;
    undone++;
  }
  for (const seam of seams) rejoinAt(project, seam);
  if (undo) return { pieces: 0, undone };
  const targets = project.clips.filter((clip): clip is AudioClip => {
    if (clip.type !== "audio" || clipEnd(clip) <= from || clip.start >= to) return false;
    const media = mediaOf(project, clip.media);
    return media !== undefined && cleanedInfo(media) !== null;
  });
  if (targets.length === 0) throw new Error("no cleaned sound plays there: remove_music first, or that moment is already the original");
  for (const clip of targets) {
    splitLinked(project, clip, from);
    const inside = clip.start >= from ? clip : project.clips.find((one): one is AudioClip => one.type === "audio" && one.track === clip.track && one.start === from && one.media === clip.media);
    if (inside !== undefined) splitLinked(project, inside, to);
  }
  const middles = project.clips.filter((clip): clip is AudioClip => {
    if (clip.type !== "audio" || clip.start < from || clipEnd(clip) > to) return false;
    const media = mediaOf(project, clip.media);
    return media !== undefined && cleanedInfo(media) !== null;
  });
  for (const clip of middles) {
    const cleanedId = clip.media;
    const original = cleanedInfo(mediaOf(project, cleanedId)!)!.of;
    const cleanedMedia = mediaOf(project, cleanedId)!;
    const before = audioAt(project, clip.track, (one) => clipEnd(one) === clip.start && one.media === cleanedId && continues(project, one, clip));
    const after = audioAt(project, clip.track, (one) => one.start === clipEnd(clip) && one.media === cleanedId);
    // What a seam had before is kept, so undo puts it back (a cut's own crossfade, a level change's).
    const kept = seamsOf(cleanedMedia);
    const set = (one: AudioClip, value: number) => {
      const key = seamKey(one.track, one.start);
      if (!(key in kept)) kept[key] = one.crossfade ?? 0;
      one.crossfade = value;
    };
    clip.media = original;
    clip.name = clip.name === undefined ? ORIGINAL_SOUND : `${ORIGINAL_SOUND} · ${clip.name}`;
    // Where the take carries on, the fade asked for; at a real cut, what the cut had.
    set(clip, before === undefined ? (clip.crossfade ?? 0) : Math.max(fade, clip.crossfade ?? 0));
    if (after !== undefined) set(after, continues(project, clip, after) ? Math.max(fade, after.crossfade ?? 0) : (after.crossfade ?? 0));
    setSeams(cleanedMedia, kept);
  }
  return { pieces: middles.length, undone };
}

/** `time` (a source second) moved out of any word it falls in, earlier for a start and later for an end. */
export function offWord(words: readonly Word[], time: number, side: "start" | "end"): number {
  // The word the edge is in first, then any whose guard it still falls in, until it's clear of them all.
  let at = time;
  for (let step = 0; step <= words.length; step++) {
    const word = words.find((one) => one.start < at && at < one.end) ?? words.find((one) => one.start - WORD_GUARD < at && at < one.end + WORD_GUARD);
    if (word === undefined) return at;
    const moved = side === "start" ? word.start - WORD_GUARD : word.end + WORD_GUARD;
    if (moved === at) return at;
    at = moved;
  }
  return at;
}

function edgeOffWord(app: App, project: Project, frame: number, side: "start" | "end"): number {
  const clip = project.clips.find((one): one is AudioClip => {
    if (one.type !== "audio" || one.start > frame || clipEnd(one) < frame) return false;
    const media = mediaOf(project, one.media);
    return media !== undefined && (cleanedInfo(media) !== null || isOriginalPiece(one));
  });
  if (clip === undefined) return frame;
  const media = mediaOf(project, clip.media)!;
  const words = cachedTranscript(app, media)?.words ?? [];
  const rate = fpsOf(project);
  const source = clip.source_in + ((frame - clip.start) / rate) * clip.speed;
  const moved = offWord(words, source, side);
  const out = clip.start + ((moved - clip.source_in) / clip.speed) * rate;
  return side === "start" ? Math.max(clip.start, Math.floor(out)) : Math.min(clipEnd(clip), Math.ceil(out));
}

const secondsArg = (value: unknown, name: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} is seconds on the timeline`);
  return value;
};

registerTool("remove_music", async ({ app, args, projectId, signal }) => {
  const done = await diag.timeAsync("music", "remove music", () => removeMusic(app, projectId, secondsArg(args.start, "start"), secondsArg(args.end, "end"), signal));
  return text(stableStringify(done));
});

registerTool("bring_back_sound", async ({ app, args, projectId }) => {
  const start = secondsArg(args.start, "start");
  const end = secondsArg(args.end, "end");
  if (start === null || end === null) throw new Error("start and end are required (seconds on the timeline)");
  const fadeSeconds = secondsArg(args.fade, "fade");
  const undo = args.undo === true;
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const rate = fpsOf(live.project);
  const from = undo ? Math.round(start * rate) : edgeOffWord(app, live.project, Math.round(start * rate), "start");
  const to = undo ? Math.round(end * rate) : edgeOffWord(app, live.project, Math.round(end * rate), "end");
  const fade = fadeSeconds === null ? FADE_FRAMES : Math.max(2, Math.round(fadeSeconds * rate));
  const [saved, report] = await app.store.update(projectId, "agent", (project) => applyBringBack(project, from, to, fade, undo));
  return text(stableStringify({ ...report, start: from / rate, end: to / rate, fade_frames: fade, rev: saved.rev }));
});
