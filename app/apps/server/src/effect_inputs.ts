// What a coded effect is given from the timeline, beyond its own folder
// (Sphe, Nov 11: "create this insane effect and then just track it onto
// footage"; a glass panel that bends and blurs what's behind it):
//
// - A tracked path: points (boxes) in the footage under the effect followed
//   through it by Edit's tracker (track.rs: template matching carried by the
//   camera's own move, as track_region does for the house's clips), written
//   into the effect's folder as a script, frame by frame in frame pixels, so
//   the effect's code draws wherever they are at any second. Several points
//   give it scale, turn or a surface's four corners to warp onto.
// - The picture beneath: whatever the tracks below the effect's clip show for
//   its span, rendered by the export into its folder as a video the page
//   draws (and blurs, bends, refracts) itself. Kept in step: when what's
//   beneath changes, it's made again before the effect's next render.
//
// Both land in the folder like effect_footage's video and levels: the page
// still has no network, and the same t is still the same picture.

import fs from "node:fs";

import type { App } from "./app.ts";
import { footageFraming, toProject, toSource } from "./captions.ts";
import * as diag from "./diag.ts";
import * as effects from "./effects.ts";
import { writeAtomic } from "./files.ts";
import { Semaphore } from "./semaphore.ts";
import * as missingMedia from "./missing_media.ts";
import type { Media, Project } from "./model.ts";
import { native, planOffThread } from "./native/index.ts";
import { join } from "./paths.ts";
import { clipContains, clipEnd, fps as fpsOf, mediaOf } from "./project.ts";
import { jsonForSerde } from "./rust.ts";
import { stableStringify } from "./stable.ts";
import * as thread from "./thread.ts";
import * as tools from "./tools.ts";

type Box = [number, number, number, number];

export interface Point {
  /** Its name in the data (a word: face, corner_tl). */
  name: string;
  /** Where it is at the moment given, project pixels from the top-left. */
  box: Box;
  /** The same thing at other moments of the same footage (timeline seconds): a long or fast stretch stays on it. */
  boxes?: { time: number; box: Box }[];
}

/** At most this long tracked in one go (the tracker's own limit). */
const MOST_TRACKED_S = 180;

const NAME = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Tracks `points` (as they are at timeline `time`) through the footage there,
 * over timeline seconds `from`–`to` (the footage clip's span by default), and
 * writes `<as>.track.js` into effect `name`'s folder. Answers what the agent
 * needs to use it, and where it lost a point.
 */
export async function track(app: App, projectId: string, name: string, time: number, points: Point[], span: [number | null, number | null], as: string): Promise<string> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const dir = effects.folder(app.store, projectId, name);
  if (!fs.existsSync(join(dir, effects.ENTRY))) throw new Error(`no effect "${name}": write its ${effects.ENTRY} first`);
  if (!NAME.test(as)) throw new Error("as is a short lower-case word (letters, digits, _), starting with a letter");
  if (points.length === 0 || points.length > 8) throw new Error("points: one to eight, each {name, box}");
  for (const point of points) if (!NAME.test(point.name)) throw new Error(`point name "${point.name}": a short lower-case word (letters, digits, _)`);
  const fps = fpsOf(project);
  const [width, height] = [project.settings.width, project.settings.height];
  const frame = Math.floor(time * fps);
  const shot = footageAt(project, frame);
  if (shot === null) throw new Error(`no footage at ${time.toFixed(2)} s to track (a video clip that isn't an effect)`);
  const media = mediaOf(project, shot.media)!;
  const first = Math.max(shot.start, Math.round((span[0] ?? -Infinity) * fps));
  const last = Math.min(clipEnd(shot), Math.round((span[1] ?? Infinity) * fps));
  if (last - first < 2) throw new Error(`the footage there (${shot.id}) plays ${(shot.start / fps).toFixed(2)}–${(clipEnd(shot) / fps).toFixed(2)} s: give from and to inside it`);
  if ((last - first) / fps > MOST_TRACKED_S) throw new Error(`at most ${MOST_TRACKED_S} s tracked in one call (the tracker holds that much footage at once; this is ${((last - first) / fps).toFixed(0)} s): track it in stretches, each with its own from, to and as, and in the page use each stretch's track over its own seconds`);
  const toSourceTime = (at: number) => shot.source_in + ((at - shot.start) / fps) * shot.speed;
  const toTimelineFrame = (seconds: number) => shot.start + ((seconds - shot.source_in) / shot.speed) * fps;
  const centre = (x: number, y: number): [number, number] => [x - width / 2, y - height / 2];
  const toSourceBox = (at: number, box: Box): Box => {
    const fit = footageFraming(shot, shot.transform, at);
    const a = toSource(media, fit, [width, height], centre(box[0], box[1]));
    const b = toSource(media, fit, [width, height], centre(box[2], box[3]));
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  };
  const frames = last - first;
  const paths: Record<string, { x: number[]; y: number[]; w: number[]; h: number[] }> = {};
  const lost: Record<string, [number, number][]> = {};
  let cuts: number[] = [];
  for (const point of points) {
    const anchors = [{ at: toSourceTime(frame), region: toSourceBox(frame, point.box) }];
    for (const more of point.boxes ?? []) {
      const at = Math.floor(more.time * fps);
      if (!clipContains(shot, at)) throw new Error(`${point.name}'s box at ${more.time.toFixed(2)} s isn't on the footage tracked (${shot.id})`);
      anchors.push({ at: toSourceTime(at), region: toSourceBox(at, more.box) });
    }
    const tracked = await native().trackAnchors({ path: media.path, size: [media.width, media.height], fps: media.fps, from: toSourceTime(first), to: toSourceTime(last), anchors });
    if (tracked.samples.length < 2) throw new Error(`lost ${point.name} straight away: give a tighter box around something distinct`);
    const source = anchors[0]!.region;
    const [sw, sh] = [source[2] - source[0], source[3] - source[1]];
    // Each sample where it's seen on screen, at its timeline frame (the footage's framing then, its push-in and all).
    const seen = tracked.samples.map((sample) => {
      const at = toTimelineFrame(sample.time);
      const fit = footageFraming(shot, shot.transform, Math.round(at));
      const a = toProject(media, fit, [width, height], [sample.x - sw / 2, sample.y - sh / 2]);
      const b = toProject(media, fit, [width, height], [sample.x + sw / 2, sample.y + sh / 2]);
      return { at, x: (a[0] + b[0]) / 2 + width / 2, y: (a[1] + b[1]) / 2 + height / 2, w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
    });
    const path = { x: [] as number[], y: [] as number[], w: [] as number[], h: [] as number[] };
    let next = 0;
    for (let index = 0; index < frames; index++) {
      const at = first + index;
      while (next < seen.length - 1 && seen[next + 1]!.at <= at) next++;
      const a = seen[next]!;
      const b = seen[Math.min(next + 1, seen.length - 1)]!;
      const t = b.at > a.at ? Math.min(1, Math.max(0, (at - a.at) / (b.at - a.at))) : 0;
      const mix = (key: "x" | "y" | "w" | "h") => Math.round((a[key] + (b[key] - a[key]) * t) * 10) / 10;
      path.x.push(mix("x"));
      path.y.push(mix("y"));
      path.w.push(mix("w"));
      path.h.push(mix("h"));
    }
    paths[point.name] = path;
    const seconds = (source: number) => Math.round(((toTimelineFrame(source) - first) / fps) * 100) / 100;
    lost[point.name] = tracked.lost.map(([a, b]) => [seconds(a), seconds(b)]);
    cuts = tracked.cuts.map(seconds);
  }
  const data = { fps, start: Math.round((first / fps) * 1000) / 1000, frames, points: paths, lost, cuts };
  writeAtomic(
    join(dir, `${as}.track.js`),
    `// Tracked by Edit (effect_track): each point's centre (x, y) and size (w, h) in frame pixels from the top-left, one entry a frame from \`start\` (timeline seconds).\n` +
      `(window.tracks = window.tracks || {})[${JSON.stringify(as)}] = ${JSON.stringify(data)};\n` +
      `window.tracks[${JSON.stringify(as)}].at = function (name, t) {\n` +
      `  const p = this.points[name], f = Math.min(Math.max(t * this.fps, 0), this.frames - 1), i = Math.floor(f), j = Math.min(i + 1, this.frames - 1), k = f - i;\n` +
      `  const mix = (list) => list[i] + (list[j] - list[i]) * k;\n` +
      `  return { x: mix(p.x), y: mix(p.y), w: mix(p.w), h: mix(p.h) };\n` +
      `};\n`,
  );
  const lines = [
    `effects/${name}/${as}.track.js: ${points.map((point) => point.name).join(", ")} over ${(first / fps).toFixed(2)}–${(last / fps).toFixed(2)} s of ${shot.id} (${frames} frames). Load it with <script src="${as}.track.js"></script>; window.tracks.${as}.at(name, t) is {x, y, w, h} in frame pixels at second t of an effect whose clip starts at ${(first / fps).toFixed(2)} s (place it there).`,
  ];
  if (cuts.length > 0) lines.push(`The footage cuts at ${cuts.map((cut) => `${cut.toFixed(2)} s`).join(", ")} into it.`);
  for (const point of points) {
    const gone = lost[point.name]!;
    if (gone.length > 0) lines.push(`Lost ${point.name} at ${gone.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)} s`).join(", ")} (it rides with the camera there): look, and track again with its box there in boxes.`);
  }
  return lines.join("\n");
}

/** The topmost visible footage (a video that isn't an effect) at a timeline frame. */
function footageAt(project: Project, frame: number) {
  const order = project.tracks.filter((one) => one.kind === "video" && !one.hidden).map((one) => one.id);
  let found: Extract<Project["clips"][number], { type: "video" }> | null = null;
  let best = -1;
  for (const clip of project.clips) {
    if (clip.type !== "video" || !clipContains(clip, frame)) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || media.kind !== "video" || typeof media.effect === "string") continue;
    const rank = order.indexOf(clip.track);
    if (rank >= best) {
      best = rank;
      found = clip;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The picture beneath

/** What an effect's folder keeps of what's beneath it: the video, and what it was made from. */
export const BENEATH = "beneath.mp4";

/**
 * One render of what's beneath at a time per project, in the order asked (a graphic is made over those below it as
 * they end up), each project its own: one slot for the whole computer had four Cuffed & Caught compilations, each
 * asking for 25 to 30 (Nov 26, mandalorian), wait 2 to 3 min on every call for the others' renders. A Mac working on
 * one edit renders as before, one at a time.
 */
const beneathSlots = new Map<string, Semaphore>();
export function beneathSlot(projectId: string): Semaphore {
  let slot = beneathSlots.get(projectId);
  if (slot === undefined) {
    slot = new Semaphore(1);
    beneathSlots.set(projectId, slot);
  }
  return slot;
}

/** How what's beneath is keyed now (3: with the order of its tracks, Nov 18; 4: a graphic below by its code, Nov 23). */
const KEY_VERSION = 4;

/** A graphic's code as it is now (`whole` false: without what's beneath it), null when its code isn't on this computer. */
type CodeOf = (name: string, whole: boolean) => string | null;

/** The effect's clip, and the project as only the tracks below it: what it's laid over, or null when it isn't placed. */
function under(project: Project, name: string, codeOf?: CodeOf): { start: number; end: number; project: Project; key: string; older: string[] } | null {
  const media = project.media.find((one) => one.effect === name);
  if (media === undefined) return null;
  const clip = project.clips.find((one) => one.type === "video" && one.media === media.id);
  if (clip === undefined) return null;
  const order = project.tracks.filter((one) => one.kind === "video").map((one) => one.id);
  const below = new Set(order.slice(0, Math.max(0, order.indexOf(clip.track))));
  const [start, end] = [clip.start, clipEnd(clip)];
  const clips = project.clips.filter((one) => below.has(one.track) && one.start < end && clipEnd(one) > start);
  const used = new Set(clips.map((one) => ("media" in one ? one.media : null)).filter((one): one is string => typeof one === "string"));
  const media_ = project.media.filter((one) => used.has(one.id));
  const hashed = (value: unknown) => new Bun.CryptoHasher("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
  // Which is drawn over which: the order of the tracks below that have something in its span, and whether each shows. Only
  // those: a lane put in or taken out elsewhere on the timeline (a cleaned strip's, clean_strips.ts) changes nothing here.
  const layers = order.filter((id) => below.has(id) && clips.some((one) => one.track === id)).map((id) => [id, project.tracks.find((one) => one.id === id)?.hidden === true]);
  const byId = [...clips].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Each footage by what it is (its content's id in the cloud), not where this computer keeps it: every computer, port
  // and data folder gives a media a path of its own (cloud_media's resolver), so a key of paths was made again on each.
  const sources = media_.map((one: Media) => ({ id: one.id, source: one.cloud?.source ?? one.path, effect_key: one.effect_key ?? null }));
  // A cleaned strip by its media alone: each piece cleaned again comes back as a new media (text_removal.ts,
  // watermark_removal.ts), and its upload filling in its cloud source afterwards is the same picture, not a new render.
  const before = media_.map((one: Media) => (one.cleans != null ? { id: one.id, strip: true, effect_key: one.effect_key ?? null } : { id: one.id, source: one.cloud?.source ?? one.path, effect_key: one.effect_key ?? null }));
  // A graphic below by what it is, its code: its media's id, its file, its upload and whether it's on its clear still
  // this moment are none of it. Keyed by those, each graphic landing changed the key of those above it, the upload after
  // it changed them again, and a placeholder put back returned them to an earlier key (Nov 23, Boyfriends: interview-audio,
  // 17,460 frames, drawn four times in an afternoon). One placed on a lane that isn't below this one counts without what's
  // beneath it, so two graphics over each other's clips can't each change the other's key for ever.
  const lane = (effect: string) => {
    const its = project.media.find((one) => one.effect === effect);
    const placed = its === undefined ? undefined : project.clips.find((one) => one.type === "video" && one.media === its.id);
    return placed === undefined ? -1 : order.indexOf(placed.track);
  };
  const own = order.indexOf(clip.track);
  const graphic = (one: Media) => (typeof one.effect === "string" ? one.effect : null);
  const what = media_
    .map((one: Media, at) => {
      const effect = graphic(one);
      if (effect === null) return before[at]!;
      return { effect, code: effect === name ? null : (codeOf?.(effect, lane(effect) < own) ?? one.effect_key ?? null) };
    })
    .sort((a, b) => {
      const [x, y] = [stableStringify(a), stableStringify(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const named = new Map(media_.filter((one) => graphic(one) !== null).map((one) => [one.id, `effect:${one.effect}`]));
  const placed = byId.map((one) => ("media" in one && typeof one.media === "string" && named.has(one.media) ? { ...one, media: named.get(one.media)! } : one));
  const key = hashed({ version: KEY_VERSION, settings: project.settings, start, end, layers, clips: placed, media: what });
  // Marks written before (keyed by the media below; before that, without the order of the tracks; before that, with paths): taken as what's beneath while they hold (markHolds).
  const older = [
    hashed({ version: 3, settings: project.settings, start, end, layers, clips: byId, media: before }),
    hashed({ version: 2, settings: project.settings, start, end, clips, media: sources }),
    hashed({ version: 1, settings: project.settings, start, end, clips, media: media_.map((one: Media) => ({ id: one.id, path: one.path, effect_key: one.effect_key ?? null })) }),
  ];
  return { start, end, project: { ...project, clips, tracks: project.tracks.filter((one) => below.has(one.id)) }, key, older };
}

/** What's beneath effect `name` now, as its mark says it (null when it isn't placed): a change there is a new render. */
export function beneathKey(project: Project, name: string, codeOf?: CodeOf): string | null {
  return under(project, name, codeOf)?.key ?? null;
}

/** The code of a project's graphics as they are on this computer, for what's beneath the ones above them. */
function codeHere(app: App, projectId: string): CodeOf {
  return (name, whole) => effects.codeNow(app.store, projectId, name, whole);
}

// What's beneath an effect is told by its `.beneath.json`, which is part of its
// code: a new one is a new render. So it's written only when what's beneath has
// changed, never because this computer would have worded it otherwise. Until
// Nov 17 its key had every footage's path, which is this computer's own: on
// each computer (or data folder, or port) that opened a V2 project, every effect
// drawn over footage had what's beneath it made again, its code changed by
// that alone, and its render drawn again (kenobi, Nov 17: six of Cops Found 3
// Bodies' effects, each time a new Edit opened it). Now a mark that isn't of
// this computer's making, on an effect whose render is of its code, is taken
// as what's beneath it now (`adopted`, kept in the cache), and only a change
// from that makes it again.

const ADOPTED = "beneath-adopted.json";

/** Marks taken as they are, by `project/name`: the mark's text (its hash) and what was beneath then. */
function readAdopted(cache: string): Record<string, { mark: string; key: string; v?: number }> {
  try {
    return JSON.parse(fs.readFileSync(join(cache, ADOPTED), "utf8")) as Record<string, { mark: string; key: string; v?: number }>;
  } catch {
    return {};
  }
}

function writeAdopted(cache: string, adopted: Record<string, { mark: string; key: string; v?: number }>): void {
  fs.mkdirSync(cache, { recursive: true });
  writeAtomic(join(cache, ADOPTED), JSON.stringify(adopted));
}

/** A mark made here is what was beneath: only a change from it makes it again, never taken as the new state because its render is current. */
function ownMark(app: App, projectId: string, name: string, text: string, key: string): void {
  const cache = app.store.cacheDir();
  const adopted = readAdopted(cache);
  adopted[`${projectId}/${name}`] = { mark: new Bun.CryptoHasher("sha256").update(text).digest("hex"), key, v: KEY_VERSION };
  writeAdopted(cache, adopted);
}

/** The key a mark says, if it can be read. */
function saidKey(text: string | null): string | undefined {
  if (text === null) return undefined;
  try {
    return (JSON.parse(text) as { key?: string }).key;
  } catch {
    return undefined;
  }
}

/** Whether a mark says its video was made over a graphic still on its clear picture: it's made again once that one is drawn. */
function overStandIn(text: string | null): boolean {
  if (text === null) return false;
  try {
    return (JSON.parse(text) as { over_stand_in?: unknown }).over_stand_in === true;
  } catch {
    return false;
  }
}

/** Whether a mark says what's beneath now (`found`), taking one made elsewhere or keyed as before (see above). */
function markHolds(app: App, projectId: string, name: string, text: string | null, found: { key: string; older: string[] }): boolean {
  if (text === null) return false;
  let said: string | undefined;
  try {
    said = (JSON.parse(text) as { key?: string }).key;
  } catch {
    return false;
  }
  if (said === found.key) return true;
  const cache = app.store.cacheDir();
  const adopted = readAdopted(cache);
  const id = `${projectId}/${name}`;
  const mark = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const taken = adopted[id]?.mark === mark ? adopted[id] : undefined;
  // Taken as today's key: holds while that's what's beneath.
  if (taken !== undefined && taken.v === KEY_VERSION) return taken.key === found.key;
  // Keyed as before (by the mark, or when it was taken): holding by that key, it's kept as today's, so a change from here on is seen.
  const before = (said !== undefined && found.older.includes(said)) || (taken !== undefined && found.older.includes(taken.key));
  if (!before && (taken !== undefined || !effects.rendersItsCode(app.store, projectId, name))) return false;
  adopted[id] = { mark, key: found.key, v: KEY_VERSION };
  writeAdopted(cache, adopted);
  return true;
}

/**
 * What's beneath a graphic is footage the effect draws again, then rendered and
 * exported with it: three encodes more than V1's one. Made at the export's own
 * rate (~9 Mbit/s at 1080p) and then again at CRF 18, bodycam's grain went soft
 * under every effect drawn over it (Nov 19, V1's effects copied into V2: footage
 * under a bridge flash at SSIM 0.986 to its source before the effect touched it).
 * A span up to five minutes (nearly every graphic) is made at 40 Mbit/s and kept
 * at CRF 12 (0.994, about twice the size); a longer one as before, for the disk.
 */
const BENEATH_FINE_SECONDS = 300;
const BENEATH_FINE_RATE = 40_000_000;

/** The export's target size (MB) for `frames` of what's beneath at BENEATH_FINE_RATE (the engine's sum, export.rs `video_bitrate`). */
function beneathTargetMb(frames: number, fps: number): number {
  return (BENEATH_FINE_RATE * (frames / fps)) / (8_000_000 * 0.94);
}

/**
 * Renders what's beneath effect `name`'s clip, for its span, into its folder
 * (`beneath.mp4`: no sound, a keyframe every third of a second for seeking),
 * unless it's already of what's there now. Answers whether it was made.
 */
export async function beneath(app: App, projectId: string, name: string): Promise<{ made: boolean; seconds: number }> {
  return beneathSlot(projectId).with(async () => {
    const live = app.store.get(projectId);
    if (live === null) throw new Error("no such project");
    const dir = effects.folder(app.store, projectId, name);
    if (!fs.existsSync(join(dir, effects.ENTRY))) throw new Error(`no effect "${name}"`);
    const found = under(live.project, name, codeHere(app, projectId));
    if (found === null) throw new Error(`${name} isn't on the timeline: place it first (what's beneath it is what's on the tracks below its clip)`);
    // A graphic below it not drawn yet shows as its clear still. The agent asking now gets that, marked so, and it's made
    // again once that one is drawn; the key alone wouldn't say so, as it's of the graphic's code.
    const early = effects.belowNotDrawn(app.store, projectId, name).length > 0;
    const fps = fpsOf(live.project);
    const seconds = (found.end - found.start) / fps;
    const keyFile = join(dir, effects.BENEATH_MARK);
    let text: string | null = null;
    try {
      text = fs.readFileSync(keyFile, "utf8");
    } catch {
      // Never made: made now.
    }
    // Over a stand-in only its own exact mark holds: taken as today's, an older one would stand once the graphic has landed.
    const holds = early ? saidKey(text) === found.key : markHolds(app, projectId, name, text, found) && !overStandIn(text);
    if (holds && fs.existsSync(join(dir, BENEATH))) return { made: false, seconds };
    const work = join(app.store.cacheDir(), "beneath");
    fs.mkdirSync(work, { recursive: true });
    const exported = join(work, `${projectId}-${name}-${found.key}.mp4`);
    const partial = join(dir, `${BENEATH}.partial.mp4`);
    try {
      const fine = seconds <= BENEATH_FINE_SECONDS;
      const asked = { ...native().exportDefaults(), format: "h264" as const, size: null, range: [found.start, found.end] as [number, number], quality: "high" as const, audio: false, loudness: null };
      thread.note(`beneath ${name}: the project as JSON for its render`);
      const input = { json: jsonForSerde(missingMedia.playable(app.store.home, found.project)) };
      // Planned off the server's thread (native/index.ts `planOffThread`, Nov 21): sent as JSON, a long edit's plan
      // reads the whole project again, and a process's first plan ran FFmpeg for the encoders, all on the thread.
      const { plan } = await planOffThread(input, asked);
      // Its size from the span the plan renders, which ends where the tracks below do: sized on the effect's whole
      // clip, 8 frames of footage under a 5.9 s title card asked 940 Mbit/s, which NVENC refuses ("Invalid Level";
      // Nov 22, "When Cops Rescue Boyfriends…", at every start of the Linux prod Edit).
      const options = fine ? { ...asked, target_mb: beneathTargetMb(plan.end - plan.start, fps) } : asked;
      const job = native().ExportJob.start({ project: input, options, plan, output: exported, cacheDir: app.store.cacheDir() }, () => {});
      const timer = setTimeout(() => job.cancel(), 10 * 60_000);
      try {
        await job.wait();
      } finally {
        clearTimeout(timer);
      }
      // Seekable as the page plays it: a keyframe every third of a second, as effect_footage's.
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", exported, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", fine ? "12" : "18", "-g", "10", "-pix_fmt", "yuv420p", "-movflags", "+faststart", partial]);
      fs.renameSync(partial, join(dir, BENEATH));
      // The video alone when the mark still holds (it's never kept in the cloud: made again on each computer).
      if (!holds || early) {
        const mark = JSON.stringify(early ? { key: found.key, over_stand_in: true } : { key: found.key });
        writeAtomic(keyFile, mark);
        ownMark(app, projectId, name, mark, found.key);
      }
    } finally {
      fs.rmSync(exported, { force: true });
      fs.rmSync(partial, { force: true });
    }
    return { made: true, seconds };
  });
}

/**
 * Before an HQ project's effects render: each one that draws what's beneath it gets it made again if that changed,
 * lowest lane first, so a graphic is made over those below it as they end up. One with a graphic below it not drawn yet
 * waits for that (`effects.belowNotDrawn`): its picture would be of the clear still, and it would be drawn twice.
 */
async function keepBeneath(app: App, projectId: string, only?: ReadonlySet<string>): Promise<void> {
  const live = app.store.get(projectId);
  if (live === null) return;
  for (const name of effects.lowestFirst(live.project)) {
    // An export of part of the video: the graphics it needs.
    if (only !== undefined && !only.has(name)) continue;
    if (!fs.existsSync(join(effects.folder(app.store, projectId, name), effects.BENEATH_MARK))) continue;
    if (effects.belowNotDrawn(app.store, projectId, name).length > 0) continue;
    try {
      await beneath(app, projectId, name);
    } catch (error) {
      diag.warn("effects", `${projectId}: what's beneath ${name}: ${diag.messageOf(error)}`);
    }
  }
}

/** Hooks keeping what's beneath in step into the effects' renders (once). */
export function start(): void {
  effects.beforeRenders.set("beneath", keepBeneath);
}
