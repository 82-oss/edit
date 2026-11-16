// A channel's watermark on the final video (Sphe, Nov 2: "once we do the
// FINAL export and are happy we have a checkbox to include the watermark and
// we pick the channel. so the opacity is like 20% and the logo moves around
// the screen like the dvd player"). The logos are the pictures in the team's
// Watermarks folder on Drive. A channel (channels.ts) is linked to its picture
// by the picture's Drive id, set on its page by a teacher (Sphe, Nov 16: "it's
// linked to a channel"), so a renamed channel keeps its logo and nothing here
// names one. A channel's project offers its channel's logo alone, or nothing
// when it has none; a project of no channel (V1's, a niche's) still picks from
// the folder's pictures, each named by the channel linked to it when this
// person sees that channel, else by its file's name (`SI_watermark.png` → SI).
//
// A channel's logo can also be uploaded on its page (Sphe, Nov 16), kept in
// Edit's cloud under the channel's key (`edit/channels/<key>/watermark/
// <sha256>.<ext>`, the live relay's R2: one channel list for dev and prod),
// and each channel sets its own look there: opacity, size, speed, moving or
// still (@edit/types/watermark, which the page's preview draws from too).
//
// What an export carries is a mark (`markOf`): the picture (a Drive id, or
// `up/<channel>/<sha256>.<ext>`) and, when it isn't the house look, `~` and
// the look's numbers. It's in the export's options key, so a changed look or
// picture is a new export, and a restarted one draws the same thing.
//
// The logo goes on the timeline being exported, not into the project: a
// locked top track over everything (subtitles too), at the look's opacity,
// its x and y keyframed in straight lines from wall to wall (or still in the
// bottom-right corner).
//
// Only over the story's footage (JJ, Nov 5: "we only want watermarks where
// we have 'story'", and not on reuse cases): one picture clip per stretch of
// Story, none over the intro, cut-ins, case transitions, the outro or a
// reused case's footage. The bounce runs across the whole export, so the
// logo comes back after a cut-in where it would have been.
//
//   GET /api/watermarks?project=   a channel's project: {channel: {key, name}, channels: [its picture] or []};
//                                  else {channel: null, channels: [{id, code, name}], usual}: the folder's
//                                  pictures, and the one to start on (`usual`)

import * as fs from "node:fs";

import { boxOf, HOUSE_LOOK, MARGIN, type Picture, readMark, startOf, uploadKey, type WatermarkLook } from "@edit/types/watermark";

import * as diag from "./diag.ts";
import type { App } from "./app.ts";
import * as channelList from "./channels.ts";
import * as cloud from "./cloud.ts";
import { ApiError, bad, json } from "./http/errors.ts";
import { readBytes, type Router } from "./http/router.ts";
import { curl, driveError, encode, quote } from "./library.ts";
import type { Clip, Keyframe, Media, Plan, Project, Sections, Track } from "./model.ts";
import { native } from "./native/index.ts";
import { join } from "./paths.ts";
import { clipEnd, reusedScriptBlock, reusedSpans } from "./project.ts";
import { read as reviewState } from "./reviews.ts";
import { jsonForSerde, serdeParse } from "./rust.ts";
import * as seams from "./seams.ts";

const API = "https://www.googleapis.com/drive/v3";

/** The team's Watermarks folder (Drive): one picture per channel. */
export const FOLDER = "1E1I0ykeqXFqrjIcU8P6fQEXgNBwdS6OU";

/** The house look (@edit/types/watermark): 10%, 14% of the frame's height, 0.04 frame heights a second, a DVD player's bounce. */
export const LOOK = { opacity: HOUSE_LOOK.opacity, height: HOUSE_LOOK.size, speed: HOUSE_LOOK.speed, margin: MARGIN };

/** The track and clip the watermark is, on the exported timeline only. */
export const TRACK = "watermark";

/** A picture in the Watermarks folder: a channel's logo. */
export interface Channel {
  /** The picture's Drive file id: what a channel is linked to. */
  id: string;
  /** Its short name, from the file's ("SI"). */
  code: string;
  /** Its file's name in words ("SI", "Inspector Ted"); the menu says the linked channel's when there is one. */
  name: string;
  /** Drive's checksum: a changed picture is fetched again. */
  md5?: string;
}

/** A Watermarks folder picture: `SI_watermark.png` → SI; `InspectorTed_watermark_under.png` → Inspector Ted. */
export function channelOf(file: { id: string; name: string; md5Checksum?: string }): Channel {
  const code = file.name.replace(/\.[a-z0-9]+$/iu, "").replace(/[_ -]*watermark.*$/iu, "").trim() || file.name;
  const name = code.replace(/([a-z])([A-Z])/gu, "$1 $2");
  return { id: file.id, code, name, ...(file.md5Checksum ? { md5: file.md5Checksum } : {}) };
}

let listed: { at: number; channels: Channel[] } | null = null;

/** The channels, by name; looked up again after five minutes, so a picture added to the folder shows soon. */
export async function channels(library: seams.Library, fresh = false): Promise<Channel[]> {
  if (!fresh && listed !== null && Date.now() - listed.at < 5 * 60_000) return listed.channels;
  const files: { id: string; name: string; mimeType: string; md5Checksum?: string }[] = [];
  let page = "";
  for (;;) {
    const query = `'${FOLDER}' in parents and trashed = false`;
    let url = `${API}/files?q=${encode(query)}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,md5Checksum)`;
    if (page !== "") url += `&pageToken=${encode(page)}`;
    const [code, body] = await curl(`header = ${quote(`Authorization: Bearer ${await library.accessToken()}`)}\n`, ["--max-time", "30", url]);
    const text = new TextDecoder().decode(body);
    if (code !== 200) throw new Error(driveError(code, text));
    const value = serdeParse(text) as { files?: unknown; nextPageToken?: unknown } | null;
    if (Array.isArray(value?.files)) files.push(...(value.files as typeof files));
    if (typeof value?.nextPageToken === "string") page = value.nextPageToken;
    else break;
  }
  const found = files
    .filter((file) => typeof file.mimeType === "string" && file.mimeType.startsWith("image/"))
    .map(channelOf)
    .sort((a, b) => a.name.localeCompare(b.name));
  listed = { at: Date.now(), channels: found };
  return found;
}

/** The channel's picture on this Mac (`<cache>/watermarks/`), fetched from Drive when it's missing or changed. */
export async function logoFile(library: seams.Library, cacheDir: string, channel: Channel): Promise<string> {
  const dir = join(cacheDir, "watermarks");
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${channel.id}-${channel.md5 ?? "x"}.png`);
  if (fs.existsSync(path) && fs.statSync(path).size > 0) return path;
  const partial = `${path}.part`;
  const url = `${API}/files/${encode(channel.id)}?alt=media&supportsAllDrives=true`;
  const [code, body] = await curl(`header = ${quote(`Authorization: Bearer ${await library.accessToken()}`)}\n`, ["--max-time", "60", "--output", partial, url]);
  if (code !== 200) {
    fs.rmSync(partial, { force: true });
    throw new Error(`couldn't fetch ${channel.name}'s watermark: ${driveError(code, new TextDecoder().decode(body))}`);
  }
  fs.renameSync(partial, path);
  return path;
}

/** An uploaded picture on this Mac (`<cache>/watermarks/`), fetched from Edit's cloud once: it's named by its content. */
export async function uploadFile(cacheDir: string, picture: Extract<Picture, { kind: "upload" }>): Promise<string> {
  const dir = join(cacheDir, "watermarks");
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${picture.sha256}.${picture.ext}`);
  if (fs.existsSync(path) && fs.statSync(path).size > 0) return path;
  await cloud.download(uploadKey(picture.channel, picture.sha256, picture.ext), path);
  return path;
}

/** A mark's picture on this Mac and what it's called in the log, from Drive or Edit's cloud. */
export async function pictureFile(app: Pick<App, "library">, cacheDir: string, picture: Picture): Promise<{ path: string; code: string; name: string }> {
  if (picture.kind === "upload") return { path: await uploadFile(cacheDir, picture), code: picture.sha256.slice(0, 8), name: "The channel's" };
  let channel = (await channels(app.library)).find((one) => one.id === picture.id);
  channel ??= (await channels(app.library, true)).find((one) => one.id === picture.id);
  if (channel === undefined) throw new Error("that channel's watermark isn't in the Watermarks folder any more: pick it again");
  return { path: await logoFile(app.library, cacheDir, channel), code: channel.code, name: `${channel.name}'s` };
}

/**
 * One axis of the bounce: from `from` towards `+1` or `-1` at `speed` px a
 * frame, turning at ±`reach`, over `frames` frames. Keyframes at the start,
 * at every wall and at the end, straight lines between: the path exactly.
 */
export function bounce(from: number, direction: 1 | -1, reach: number, speed: number, frames: number): Keyframe[] {
  const at = (frame: number, value: number): Keyframe => ({ frame, value, ease: "linear" });
  if (reach <= 0 || speed <= 0 || frames <= 0) return [at(0, 0)];
  const keys = [at(0, from)];
  let position = Math.max(-reach, Math.min(reach, from));
  let heading = direction;
  let frame = 0;
  for (;;) {
    const wall = heading * reach;
    const next = frame + Math.abs(wall - position) / speed;
    if (next >= frames) {
      keys.push(at(frames, position + heading * speed * (frames - frame)));
      return keys;
    }
    if (next > frame) keys.push(at(next, wall));
    position = wall;
    heading = heading === 1 ? -1 : 1;
    frame = next;
  }
}

/** A stretch of story shorter than this (seconds) gets no logo, nor a gap this short between two: no flashes. */
const SHORTEST = 0.5;

/**
 * The frames of `plan` (timeline frames, `end` exclusive) the logo shows
 * over: the Story parts of `sections`, less the frames a reused case plays
 * (a finished video reused whole, or a reused script's footage). A script
 * whose story wasn't found: its footage between cut-ins. An edit without a
 * script (a subtitled video) is all of it, as before.
 */
export function storySpans(project: Project, sections: Sections, plan: Pick<Plan, "start" | "end">, fps: number): [number, number][] {
  // No story found (a compilation with no "On <date>" cut-in reads as all intro): the footage between its cut-ins.
  const story = sections.parts.filter((part) => part.kind === "story");
  const between = story.length > 0 ? story : sections.parts.filter((part) => part.kind === "intro");
  let spans: [number, number][] = between.length === 0 ? [[plan.start, plan.end]] : between.map((part) => [part.start, part.end]);
  const ids = new Set((project.script?.blocks ?? []).flatMap((block) => (block.kind === "footage" && reusedScriptBlock(block) && typeof block.clip === "string" ? [block.clip] : [])));
  const reused = [...reusedSpans(project), ...project.clips.filter((clip) => ids.has(clip.id)).map((clip): [number, number] => [clip.start, clipEnd(clip)])];
  for (const [from, to] of reused) {
    spans = spans.flatMap(([a, b]): [number, number][] => (to <= a || from >= b ? [[a, b]] : ([[a, Math.min(b, from)], [Math.max(a, to), b]] as [number, number][]).filter(([x, y]) => y > x)));
  }
  const shortest = Math.round(SHORTEST * fps);
  const joined: [number, number][] = [];
  for (const [a, b] of spans
    .map(([a, b]): [number, number] => [Math.max(a, plan.start), Math.min(b, plan.end)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])) {
    const last = joined.at(-1);
    if (last !== undefined && a - last[1] < shortest) last[1] = Math.max(last[1], b);
    else joined.push([a, b]);
  }
  return joined.filter(([a, b]) => b - a >= shortest);
}

/** `keys` (a path over frames from 0) between frames `from` and `to`, counted from `from`. */
function slice(keys: Keyframe[], from: number, to: number): Keyframe[] {
  const at = (frame: number): number => {
    const after = keys.findIndex((key) => key.frame >= frame);
    if (after < 0) return keys.at(-1)!.value;
    if (after === 0) return keys[0]!.value;
    const [a, b] = [keys[after - 1]!, keys[after]!];
    return a.value + ((b.value - a.value) * (frame - a.frame)) / (b.frame - a.frame);
  };
  const key = (frame: number, value: number): Keyframe => ({ frame: frame - from, value, ease: "linear" });
  return [key(from, at(from)), ...keys.filter((one) => one.frame > from && one.frame < to).map((one) => key(one.frame, one.value)), key(to, at(to))];
}

/**
 * `project` with `logo` (a picture's media) across `plan`'s frames at `look`
 * (bouncing, or still in the bottom-right corner), shown over `spans`
 * (timeline frames; all of `plan` when not given): a new top track, locked,
 * with a clip per span. Pure: the project given is left as it was.
 */
export function withWatermark(project: Project, plan: Pick<Plan, "start" | "end">, logo: Media, spans: [number, number][] = [[plan.start, plan.end]], look: WatermarkLook = HOUSE_LOOK): Project {
  const frames = plan.end - plan.start;
  if (frames <= 0 || spans.length === 0) return project;
  const { width: W, height: H } = project.settings;
  const fps = project.settings.fps * (project.settings.ntsc ? 1000 / 1001 : 1);
  const fit = Math.min(W / Math.max(logo.width, 1), H / Math.max(logo.height, 1));
  const { h, reach } = boxOf(look, W, H, logo.width, logo.height);
  const scale = h / Math.max(logo.height * fit, 1);
  const speed = (look.speed * H) / fps;
  const still = !look.motion || speed <= 0;
  const start = startOf(project.id, reach);
  const x = still ? [{ frame: 0, value: reach[0], ease: "linear" as const }] : bounce(start.from[0], start.heading[0], reach[0], speed, frames);
  const y = still ? [{ frame: 0, value: reach[1], ease: "linear" as const }] : bounce(start.from[1], start.heading[1], reach[1], speed, frames);
  const out = structuredClone(project);
  const ids = new Set([...out.tracks.map((one) => one.id), ...out.clips.map((one) => one.id), ...out.media.map((one) => one.id)]);
  const fresh = (base: string) => {
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  const media: Media = { ...logo, id: fresh(logo.id) };
  const track: Track = { id: fresh(TRACK), kind: "video", hidden: false, muted: false, locked: true };
  const clips = spans.map(([start, end]): Clip => {
    const [from, to] = [start - plan.start, end - plan.start];
    const keyframes = still ? null : { x: slice(x, from, to), y: slice(y, from, to) };
    return {
      id: fresh(TRACK),
      track: track.id,
      type: "video",
      name: `Watermark: ${logo.name}`,
      color: "purple",
      start,
      duration: end - start,
      fade_in: 0,
      fade_out: 0,
      media: media.id,
      source_in: 0,
      speed: 1,
      transform: { x: keyframes?.x[0]!.value ?? x[0]!.value, y: keyframes?.y[0]!.value ?? y[0]!.value, scale, rotation: 0 },
      opacity: look.opacity,
      ...(keyframes === null ? {} : { keyframes }),
    };
  });
  out.media.push(media);
  out.tracks.push(track);
  out.clips.push(...clips);
  return out;
}

/** The export's timeline with `mark`'s watermark on it (`markOf`): the picture fetched and laid over `plan` at its look. */
export async function addWatermark(app: Pick<App, "library">, cacheDir: string, project: Project, plan: Pick<Plan, "start" | "end">, mark: string): Promise<Project> {
  const read = readMark(mark);
  if (read === null) throw new Error("that watermark isn't one Edit knows: pick it again");
  const picture = await pictureFile(app, cacheDir, read.picture);
  const probe = await native().probe(picture.path);
  if (probe.kind !== "image") throw new Error(`${picture.name} watermark isn't a picture`);
  const logo: Media = { id: `watermark-${picture.code.toLowerCase()}`, name: `${picture.code} watermark`, path: picture.path, kind: "image", duration: probe.duration, width: probe.width, height: probe.height, fps: probe.fps, has_audio: false };
  const fps = project.settings.fps * (project.settings.ntsc ? 1000 / 1001 : 1);
  const spans = storySpans(project, native().sections({ json: jsonForSerde(project) }), plan, fps);
  const shown = spans.reduce((sum, [a, b]) => sum + b - a, 0);
  diag.info("watermark", `${project.name}: ${picture.name} watermark at ${Math.round(read.look.opacity * 100)}%, ${read.look.motion ? "moving" : "still"}, over ${spans.length} stretches of story (${Math.round(shown / fps)} of ${Math.round((plan.end - plan.start) / fps)} s)`);
  return withWatermark(project, plan, logo, spans, read.look);
}

/** What the Export dialog offers. */
export type Offer = { channel: { key: string; name: string } | null; channels: Pick<Channel, "id" | "code" | "name">[]; usual?: string | null };

/**
 * What a project's Export dialog offers (`given`: the folder's pictures; the
 * channels as last read). A channel's project: its channel's logo alone,
 * named by the channel as it's called now, or nothing when it has none (or
 * its picture left the folder). A project of no channel: every picture, by
 * its linked channel's name when this person sees that channel, the one
 * picked most on this computer to start on (`picked`: each project's last),
 * else one linked to a channel.
 */
export function offerFor(project: { channel?: string | null } | null, given: Channel[], picked: string[] = []): Offer {
  const shown = (one: Channel, name = one.name) => ({ id: one.id, code: one.code, name });
  if (project !== null && typeof project.channel === "string" && project.channel !== "") {
    const channel = channelList.channelOf(project);
    if (channel === null) throw bad("Its channel couldn't be read: try again in a moment.");
    // Its own picture (Drive's, or one uploaded on its page) at its own look, as its exports carry it.
    const mark = channelList.markFor(channel);
    const logo = channel.watermarkUpload ? { code: channel.title } : given.find((one) => one.id === channel.watermark);
    return { channel: { key: channel.key, name: channel.title }, channels: mark === undefined || logo === undefined ? [] : [{ id: mark, code: logo.code, name: channel.title }] };
  }
  const linked = new Map(channelList.knownChannels().flatMap((one) => (typeof one.watermark === "string" && !one.archived && one.masked !== true ? [[one.watermark, one.title] as const] : [])));
  const named = given.map((one) => shown(one, linked.get(one.id) ?? one.name)).sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const id of picked) if (named.some((one) => one.id === id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { channel: null, channels: named, usual: most ?? named.find((one) => linked.has(one.id))?.id ?? null };
}

/** The biggest picture a channel's page takes as its watermark. */
const UPLOAD_LIMIT = 10 << 20;

/** A picture's file type from its first bytes (PNG, JPEG, WebP); null for anything else. */
export function pictureType(bytes: Uint8Array): "png" | "jpg" | "webp" | null {
  const starts = (...values: number[]) => values.every((value, at) => bytes[at] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return null;
}

/**
 * A picture uploaded on a channel's page as its watermark: kept in Edit's
 * cloud by its content, under the channel's key, and the channel pointed at
 * it (which takes a Drive picture's place). The channel as it is now back.
 */
export async function uploadWatermark(cacheDir: string, key: string, bytes: Uint8Array): Promise<channelList.Channel> {
  const ext = pictureType(bytes);
  if (ext === null) throw bad("A watermark is a PNG, JPEG or WebP picture.");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const dir = join(cacheDir, "watermarks");
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha256}.${ext}`);
  fs.writeFileSync(`${path}.part`, bytes);
  fs.renameSync(`${path}.part`, path);
  const probe = await native().probe(path);
  if (probe.kind !== "image" || probe.width < 8 || probe.height < 8) throw bad("That picture couldn't be read: try a PNG with a transparent background.");
  await cloud.uploadFile(path, uploadKey(key, sha256, ext));
  diag.info("watermark", `${key}: a ${probe.width}×${probe.height} ${ext} uploaded as its watermark (${sha256.slice(0, 12)})`);
  return channelList.setWatermark(key, { watermark: { sha256, ext } });
}

/** A channel's watermark picture on this Mac, for its page's preview: null when it has none (or it's seen by its label alone). */
export async function channelPicture(app: Pick<App, "library">, cacheDir: string, channel: channelList.Channel): Promise<string | null> {
  const mark = channelList.markFor(channel);
  const read = mark === undefined ? null : readMark(mark);
  return read === null ? null : (await pictureFile(app, cacheDir, read.picture)).path;
}

export function routes(router: Router<App>): void {
  router
    .get("/api/watermarks", async ({ app, url }) => {
      const id = url.searchParams.get("project");
      const project = id === null || id === "" ? null : (app.store.get(id)?.project ?? null);
      const [given] = await Promise.all([channels(app.library), channelList.refresh()]);
      return json(offerFor(project, given, Object.values(reviewState(app.store.home).shareWatermark ?? {})));
    })
    // The channel page's watermark (a teacher's): its picture, and a new one uploaded.
    .get("/api/channels/{key}/watermark", async ({ app, params }) => {
      const channel = await channelList.read(params.key!);
      const path = await channelPicture(app, app.store.cacheDir(), channel);
      if (path === null) throw new ApiError(404, "This channel has no watermark.");
      return new Response(Bun.file(path), { headers: { "cache-control": "private, max-age=300" } });
    })
    .post("/api/channels/{key}/watermark", async (context) => {
      channelList.needTeacher();
      const bytes = await readBytes(context.request, UPLOAD_LIMIT);
      return json({ channel: await uploadWatermark(context.app.store.cacheDir(), context.params.key!, bytes) });
    });
}

/** Tests: the folder's pictures as given, as if just listed. */
export function usePicturesForTests(given: Channel[]): void {
  listed = { at: Date.now(), channels: given };
}
