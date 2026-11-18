// The agent's tools for coded effects (effects.ts; Edit V2, a project with
// `hq`). It writes an effect's code itself, with its own file tools in the
// project's effects folder (agent.ts); these are the three things code can't
// do from there: see the page drawn, bring one of the project's pictures into
// its folder, and put it among the project's media.

import type { App } from "./app.ts";
import fs from "node:fs";
import { join } from "node:path";
import * as channels from "./channels.ts";
import * as effectInputs from "./effect_inputs.ts";
import * as effects from "./effects.ts";
import * as looker from "./effect_looker.ts";
import * as frameCompare from "./frame_compare.ts";
import * as fonts from "./fonts.ts";
import * as houseWords from "./house_words_pass.ts";
import { handlerFor, image, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import { fixed } from "./rust.ts";
import * as tools from "./tools.ts";
import * as removal from "./removal_lesson.ts";
import * as removalSchedule from "./removal_schedule.ts";
import * as textRemoval from "./text_removal.ts";
import * as teachingConflicts from "./teaching_conflicts.ts";
import * as v2cloud from "./v2_cloud.ts";

/** An effect's name from a call, in a project made the new way. */
function named(app: App, projectId: string, args: Record<string, unknown>): string {
  if (app.store.get(projectId)?.project.hq !== true) throw new Error("coded effects are for Edit V2 projects: this project isn't one");
  if (typeof args.name !== "string" || args.name === "") throw new Error("name is required: the effect's folder under effects/");
  return args.name;
}

/** What a frame's cost means for playing it: the video's own frame time is what it's held to. */
function costLine(look: effects.Look, fps: number): string {
  const frame = 1000 / fps;
  // The cost is counted in the screen's refreshes, so one over the frame time by less than half a refresh still fits it.
  const slow = look.stills.filter((still) => still.cost > frame + look.interval / 2);
  if (look.stills.length === 0) return "";
  if (!look.measured) return "What a frame costs to play wasn't measured: someone was watching a play on this computer meanwhile, which a look runs below. Look again to measure it.";
  if (slow.length === 0) return `It plays live on this computer: a frame took ${fixed(Math.max(...look.stills.map((still) => still.cost)), 0)} ms at most to draw from the moments looked at, and the video's frames are ${fixed(frame, 0)} ms apart.`;
  return `IT WON'T PLAY LIVE at ${slow.map((still) => `${fixed(still.time, 2)} s (${fixed(still.cost, 0)} ms a frame, about ${fixed(1000 / still.cost, 0)} a second)`).join(", ")} on this computer: the video's frames are ${fixed(frame, 0)} ms apart. Make those moments lighter (whole-frame blurs and filters, big blurred shadows and thousands of things redrawn each frame are what cost).`;
}

/** Code running this long without a break while a page gets ready is said: the person's viewer runs it too. */
const UNBROKEN_MS = 2_000;

/** How the page got ready, when this look loaded it and its code ran long without a break: "" otherwise. */
function readyLine(look: effects.Look): string {
  if (look.ready === null || look.ready.longest < UNBROKEN_MS) return "";
  return `ITS CODE RAN ${fixed(look.ready.longest / 1000, 1)} s WITHOUT A BREAK getting ready (${fixed(look.ready.ms / 1000, 1)} s in all). It may take as long as it needs, but the person's viewer loads the same page, where a long stretch can hold up Edit's window: do that work in slices of about 50 ms, with await new Promise((go) => setTimeout(go)) between them.`;
}

/** Frames a look at a stretch shows, each one, at most (1.6 s at 30 fps); 16 to a sheet, 4 across. */
export const EFFECT_FRAMES_MOST = 48;
const PER_SHEET = 16;
/** A frame's width on a sheet (px): four across stay under the 2,000 px a picture is read at whole. */
const SHEET_FRAME = 480;

/**
 * look_at_effect over a stretch, every frame of it (Sphe, Nov 12): stills at
 * moments can't show what only moves between frames, a handwriting that
 * shimmers as the board drifts under it, so a board read right in each still
 * jittered on screen. Each frame drawn by the page, tiled into numbered
 * sheets with FFmpeg, to set beside the reference's (look_at_media every_frame).
 * A long stretch is read by the looker (effect_looker.ts): the agent gets its
 * words and the frames it picks, every frame only with detail "full".
 */
async function lookAtStretch(app: ToolCall["app"], projectId: string, name: string, args: Record<string, unknown>): Promise<Content[]> {
  const fps = app.store.get(projectId)!.project.settings.fps;
  const start = typeof args.start === "number" && Number.isFinite(args.start) && args.start >= 0 ? args.start : 0;
  const end = typeof args.end === "number" && Number.isFinite(args.end) && args.end > start ? args.end : start + 1;
  const first = Math.round(start * fps);
  const last = Math.max(first, Math.round(end * fps) - 1);
  const count = Math.min(last - first + 1, EFFECT_FRAMES_MOST);
  const times = Array.from({ length: count }, (_, index) => (first + index) / fps);
  // A stretch says nothing of a frame's cost: not measured.
  const look = await effects.look(app, projectId, name, times, SHEET_FRAME, false);
  const sheets: { data: Uint8Array; caption: string }[] = [];
  const dir = fs.mkdtempSync(join(app.store.cacheDir(), "effect-frames-"));
  let seen: looker.Seen | null = null;
  let picked: Uint8Array | null = null;
  try {
    for (let at = 0; at < look.stills.length; at += PER_SHEET) {
      const part = look.stills.slice(at, at + PER_SHEET);
      part.forEach((still, index) => fs.writeFileSync(join(dir, `f${String(index).padStart(3, "0")}.jpg`), still.picture));
      const sheet = join(dir, `sheet-${at}.jpg`);
      const label = `drawtext=${frameCompare.labelFont(app.store.cacheDir())}:text='%{eif\\:n+${first + at}\\:d}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7`;
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-framerate", "1", "-i", join(dir, "f%03d.jpg"), "-frames:v", "1", "-vf", `${label},tile=4x${Math.ceil(part.length / 4)}:padding=4`, "-q:v", "3", sheet], { background: true });
      const from = first + at;
      sheets.push({ data: new Uint8Array(fs.readFileSync(sheet)), caption: `${name}: every frame, ${from}–${from + part.length - 1} (${fixed(from / fps, 2)}–${fixed((from + part.length - 1) / fps, 2)} s), left-to-right then down, numbered by frame` });
      for (const file of fs.readdirSync(dir)) fs.rmSync(join(dir, file), { force: true });
    }
    // Read by the looker unless every frame is asked for (detail "full") or there are few.
    if (looker.ON && args.detail !== "full" && look.stills.length >= looker.LOOKED_LEAST) {
      seen = await looker.read(app, name, first, first + look.stills.length - 1, fps, sheets);
      if (seen !== null) {
        const cells = seen.frames.map((frame) => {
          const file = join(dir, `picked-${frame}.jpg`);
          fs.writeFileSync(file, look.stills[frame - first]!.picture);
          return { files: [file], labels: [`${frame}`] };
        });
        picked = (await frameCompare.sheets(cells, null, SHEET_FRAME, 3, 2, dir, frameCompare.labelFont(app.store.cacheDir())))[0] ?? null;
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const out: Content[] = [];
  if (seen === null) for (const sheet of sheets) out.push(...image(sheet.data, sheet.caption, "image/jpeg"));
  else {
    const to = first + look.stills.length - 1;
    out.push(...text(`${name}, every frame ${first}–${to} (${fixed(first / fps, 2)}–${fixed(to / fps, 2)} s), looked at frame by frame for you:\n${seen.words}\n(detail "full" shows you every frame.)`));
    if (picked !== null) out.push(...image(picked, `${name}: frames ${seen.frames.join(", ")}, left-to-right then down, numbered by frame`, "image/jpeg"));
  }
  const lines: string[] = [];
  if (first + count <= last) lines.push(`Frames ${first + count}–${last} are left: look again with start ${fixed((first + count) / fps, 3)}.`);
  if (look.errors.length > 0) lines.push(`ERRORS its page threw (fix these first):\n${look.errors.map((error) => `- ${error}`).join("\n")}`);
  if (readyLine(look) !== "") lines.push(readyLine(look));
  if (look.problems.length > 0) lines.push(`BREAKS THE EFFECT CONTRACT:\n${look.problems.map((problem) => `- ${problem}`).join("\n")}`);
  if (lines.length > 0) out.push(...text(lines.join("\n")));
  return out;
}

/** Pairs a look at its frames beside a reference shows at most; 8 to a sheet. */
export const BESIDE_MOST = 24;

/**
 * look_at_effect `beside` a reference and/or `zoom`ed: each of its frames (a
 * stretch, or the moments asked) drawn at full size, cropped to the region,
 * and set beside the reference's frame at the matching moment (`beside.start`
 * lines up with the first; the rest follow at the project's pace), labelled.
 */
async function lookCompared(app: ToolCall["app"], projectId: string, name: string, args: Record<string, unknown>): Promise<Content[]> {
  const project = app.store.get(projectId)!.project;
  const { width, height, fps } = project.settings;
  const zoom = frameCompare.regionOf(args.zoom, width, height);
  const beside = args.beside as { media_id?: unknown; start?: unknown } | undefined | null;
  const reference = beside === undefined || beside === null ? null : project.media.find((one) => one.id === beside.media_id);
  if (beside !== undefined && beside !== null && (reference === undefined || reference === null)) throw new Error(`beside.media_id: no media ${String(beside.media_id)} (the reference's, from look_at_media)`);
  const refStart = typeof beside?.start === "number" && Number.isFinite(beside.start) ? beside.start : 0;
  const most = reference ? BESIDE_MOST : EFFECT_FRAMES_MOST;
  let times: number[];
  let rest = "";
  if (args.every_frame === true) {
    const start = typeof args.start === "number" && Number.isFinite(args.start) && args.start >= 0 ? args.start : 0;
    const end = typeof args.end === "number" && Number.isFinite(args.end) && args.end > start ? args.end : start + 1;
    const first = Math.round(start * fps);
    const total = Math.max(1, Math.round(end * fps) - first);
    times = Array.from({ length: Math.min(total, most) }, (_, index) => (first + index) / fps);
    if (times.length < total) rest = `Frames ${first + times.length}–${first + total - 1} are left: look again with start ${fixed((first + times.length) / fps, 3)}.`;
  } else {
    const given = Array.isArray(args.times) ? (args.times as unknown[]).filter((one): one is number => typeof one === "number" && Number.isFinite(one) && one >= 0) : [];
    if (given.length === 0) throw new Error("times (moments, seconds into the effect) or every_frame with start and end");
    if (given.length > 8) throw new Error("times: at most 8 moments a look (every_frame for a stretch)");
    times = given;
  }
  const look = await effects.look(app, projectId, name, times, 0, false);
  const dir = fs.mkdtempSync(join(app.store.cacheDir(), "effect-compare-"));
  try {
    const ours = look.stills.map((still, index) => {
      const file = join(dir, `ours${String(index).padStart(3, "0")}.png`);
      fs.writeFileSync(file, still.picture);
      return file;
    });
    let refs: string[] = [];
    const still = reference?.kind === "image";
    if (reference) {
      // A still is the same picture at every moment.
      if (still) {
        const one = (await frameCompare.framesOf(reference.path, 0, 1, fps, width, height, dir, "ref"))[0] ?? "";
        refs = times.map(() => one);
      } else if (args.every_frame === true) refs = await frameCompare.framesOf(reference.path, refStart, times.length, fps, width, height, dir, "ref");
      else for (const [index, time] of times.entries()) refs[index] = (await frameCompare.framesOf(reference.path, refStart + time - times[0]!, 1, fps, width, height, dir, `ref${index}-`))[0] ?? "";
    }
    // Past the reference's end, black of the same size: every pair is as wide as the others on a sheet.
    const black = join(dir, "black.png");
    if (reference && ours.some((_, index) => (refs[index] ?? "") === "")) await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `color=black:s=${width}x${height}`, "-frames:v", "1", black], { background: true });
    const cells = ours.map((file, index) => {
      const frame = Math.round(times[index]! * fps);
      const said = `yours ${fixed(times[index]!, 2)}s f${frame}`;
      if (!reference) return { files: [file], labels: [said] };
      const ref = refs[index] ?? "";
      const at = `${fixed(refStart + times[index]! - times[0]!, 2)}s`;
      return { files: [ref === "" ? black : ref, file], labels: [ref === "" ? `reference ended before ${at}` : still ? "reference (a still)" : `reference ${at}`, said] };
    });
    const few = cells.length <= 2;
    const size = few ? 960 : 480;
    const across = reference ? (few ? 1 : 2) : few ? 2 : 4;
    const font = frameCompare.labelFont(app.store.cacheDir());
    const grid = args.grid === true ? await frameCompare.gridImage(width, height, dir, font) : null;
    const pictures = await frameCompare.sheets(cells, zoom, size, across, 4, dir, font, grid);
    const what = `${reference ? `beside ${reference.id} (reference left, yours right)` : "each frame"}${zoom === null ? "" : `, zoomed to ${zoom.width}×${zoom.height} at ${zoom.x},${zoom.y}`}${grid === null ? "" : ", the same lettered grid over both"}`;
    const out: Content[] = [];
    pictures.forEach((picture, index) => out.push(...image(picture, `${name} ${what}: sheet ${index + 1} of ${pictures.length}, left-to-right then down`, "image/jpeg")));
    const lines: string[] = rest === "" ? [] : [rest];
    if (look.errors.length > 0) lines.push(`ERRORS its page threw (fix these first):\n${look.errors.map((error) => `- ${error}`).join("\n")}`);
    if (readyLine(look) !== "") lines.push(readyLine(look));
    if (look.problems.length > 0) lines.push(`BREAKS THE EFFECT CONTRACT:\n${look.problems.map((problem) => `- ${problem}`).join("\n")}`);
    if (lines.length > 0) out.push(...text(lines.join("\n")));
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function lookAtEffect({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  if ((args.beside !== undefined && args.beside !== null) || (args.zoom !== undefined && args.zoom !== null) || args.grid === true) return await lookCompared(app, projectId, name, args);
  if (args.every_frame === true) return await lookAtStretch(app, projectId, name, args);
  let times: number[] | null = null;
  if (args.times !== undefined && args.times !== null) {
    if (!Array.isArray(args.times) || args.times.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0)) throw new Error("times is a list of seconds into the effect, each 0 or more");
    if (args.times.length > 8) throw new Error("times: at most 8 moments a look");
    times = args.times as number[];
  }
  const fps = app.store.get(projectId)!.project.settings.fps;
  // detail "full": each still at the frame's own size, for small text and fine edges.
  const full = args.detail === "full";
  const look = await effects.look(app, projectId, name, times, full ? 0 : 960);
  const out: Content[] = [];
  for (const still of look.stills) out.push(...image(still.picture, `${name} at ${fixed(still.time, 2)} s${full ? ", at full size" : ""}`, still.mime));
  const lines = [`${name}: ${look.duration > 0 ? `${fixed(look.duration, 2)} s long` : "no length (window.duration)"}.`];
  // What it leaves unpainted plays over what's beneath it: said, so a background left out by mistake is seen as one.
  if (look.stills.some((still) => still.seeThrough)) lines.push("See-through where the checkerboard shows: there it plays over whatever is beneath it on the timeline. Paint a background if it should fill the frame.");
  if (look.errors.length > 0) lines.push(`ERRORS its page threw (fix these first):\n${look.errors.map((error) => `- ${error}`).join("\n")}`);
  if (readyLine(look) !== "") lines.push(readyLine(look));
  if (look.problems.length > 0) lines.push(`BREAKS THE EFFECT CONTRACT:\n${look.problems.map((problem) => `- ${problem}`).join("\n")}`);
  const house = houseWords.effectLine(app.store, projectId, name);
  if (house !== null) lines.push(house);
  const cost = costLine(look, fps);
  if (cost !== "") lines.push(cost);
  const render = effects.renderLine(app, projectId, name);
  if (render !== null) lines.push(render);
  out.push(...text(lines.join("\n")));
  return out;
}

/**
 * A Google Fonts family into the project's fonts (fonts.ts), for its effects
 * to use by name at once: closer to a reference's handwriting or a brand's
 * type than Edit's own faces (Sphe, Nov 12). Google Fonts' are all open
 * licences, free to use in videos; a font from elsewhere is the person's to add.
 */
async function fetchFont({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  if (typeof args.family !== "string" || args.family.trim() === "") throw new Error("family is required: its name on Google Fonts (\"Reenie Beanie\", \"Caveat\")");
  const weights = Array.isArray(args.weights) ? (args.weights as unknown[]).filter((one): one is number => typeof one === "number") : [];
  const font = await fonts.fetchGoogle(app.store, projectId, args.family, weights);
  const faces = font.faces.map((face) => `${face.weight}${face.style === "italic" ? " italic" : ""}`).join(", ");
  return text(`"${font.family}" (${faces}) is this project's (${font.slug}): use it in any effect by that name, as font-family "${font.family}" (await document.fonts.load in ready). ${font.source}. Compare it with the reference (look_at_effect beside, zoomed) before settling on it; save_to_library kind font name ${font.slug} keeps it for every agent when the person says to.`);
}

async function addEffect({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  const added = await effects.add(app, projectId, name);
  const fps = app.store.get(projectId)!.project.settings.fps;
  const house = houseWords.effectLine(app.store, projectId, name);
  return text(`${name} is media ${added.media}: ${fixed(added.duration, 2)} s (${Math.round(added.duration * fps)} frames). Place it like a video (add_clip or apply_edit_plan with media ${added.media}); the viewer plays its page live wherever its clip is, and a change to its code shows there at once. Edit's frames (render_frame, contact_sheet) show it once its render lands, a few seconds after its code stops changing.${house === null ? "" : `\n${house}`}`);
}

async function effectPicture({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  if (typeof args.media_id !== "string") throw new Error("media_id is required");
  const time = typeof args.time === "number" && Number.isFinite(args.time) ? args.time : null;
  const given = await effects.give(app, projectId, name, args.media_id, time, typeof args.as === "string" && args.as !== "" ? args.as : null);
  return text(`effects/${name}/${given.file} (${given.width}x${given.height}): load it in the page as "${given.file}".`);
}

async function effectFootage({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  if (typeof args.media_id !== "string") throw new Error("media_id is required");
  const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const given = await effects.giveFootage(app, projectId, name, args.media_id, seconds(args.start), seconds(args.end), typeof args.as === "string" && args.as !== "" ? args.as : null);
  const lines = [`${fixed(given.duration, 2)} s of ${args.media_id} from ${fixed(given.start, 2)} s, in effects/${name}/:`];
  if (given.video !== null) lines.push(`- "${given.video}": its picture (${given.width}x${given.height}, no sound). Play it in the page and seek it to the moment in seek(t), returning a Promise that resolves on its "seeked" (its time 0 is ${fixed(given.start, 2)} s of the media); wait for its "loadeddata" in window.ready.`);
  if (given.levels !== null) lines.push(`- "${given.levels}": its sound's levels. Load it with <script src="${given.levels}"></script> before your own script, and they're window.levels[${JSON.stringify(given.key)}]: { fps, frames, rms: [per frame], bands: [per frame][16, low to high] }, each 0 (silent) to 1; frame i is i / fps seconds in.`);
  if (given.wave !== null) lines.push(`- "${given.wave}": the sound itself, its wave. Load it the same way, and it's window.waves[${JSON.stringify(given.key)}]: { rate: ${effects.WAVE_RATE}, peak, samples: Int8Array }, sample i at i / rate seconds, -127 to 127 (the loudest of it at ±127). Draw it for a waveform: a stretch of it is the sound's own shape, where the levels are only how loud.`);
  if (given.video === null && given.levels === null) lines.push("- nothing: it has neither picture nor sound");
  return text(lines.join("\n"));
}

/** V2's cloud is there (signed in), or the tool says why not. */
function cloudOn(): void {
  if (!v2cloud.enabled()) throw new Error("V2's cloud needs this computer signed in to Edit: nothing is kept or shared signed out");
}

/** A teacher's tool: refused, in words, to anyone else. */
function teacherOnly(what: string): void {
  if (!v2cloud.teacher()) throw new Error(`${what} is a teacher's to do (agent.teach; admins have it): this computer's account isn't one. Say so to the person: an admin can make them a teacher at accounts.spheceo.com.`);
  // Not read yet, a lesson kept now could replace one the team has, unseen (Nov 16 audit).
  if (!v2cloud.teachingKnown()) throw new Error(`What's taught couldn't be read from Edit's cloud yet, so nothing is kept now. Say so to the person, and keep it in a moment, once it reads.`);
}

const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16);

// ---------------------------------------------------------------- where it's taught (a channel's edit lane)

/** The project's places in the library (its channel's edit lane, then its group's; null without a channel), the skills read fresh enough. */
async function placeHere(app: App, projectId: string): Promise<string[] | null> {
  // The channels too: a group made (or joined) since the turn began decides where a lesson is kept (Nov 16 audit).
  await Promise.all([v2cloud.refreshSkills(), channels.refresh()]);
  return channels.placesOfProject(app.store.get(projectId)?.project ?? {});
}

/**
 * Where what's taught here is kept: the channel's edit style, its group's
 * unless `given` says this channel alone (channels.ts `keptIn`). A V2 project
 * made without a channel keeps nothing (it's taught the global skill alone),
 * refused in words for the person.
 */
function keptIn(app: App, projectId: string, given: unknown): { place: string; words: string } {
  const channel = app.store.get(projectId)?.project.channel;
  if (typeof channel !== "string" || channel === "") throw new Error("This project isn't a channel's, so nothing is kept from it: what's taught is a channel's edit style. Say so to the person: an edit made for a channel (New edit, Channel) keeps what it's taught.");
  return channels.keptIn(channel, "edit", given);
}

async function effectVersions({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  cloudOn();
  const listed = await v2cloud.versions(v2cloud.effectKey(projectId, name));
  if (listed.length === 0) return text(`${name} has no versions in V2's cloud yet: one is kept each time its code settles and renders.`);
  const item = (await v2cloud.version(v2cloud.effectKey(projectId, name)))?.item;
  return text(listed.map((one) => `- version ${one.n}${one.n === item?.current ? " (in use)" : ""}: ${when(one.at)}, ${v2cloud.whoIs(one.by)}${one.reason ? `, ${one.reason}` : ""}${one.from ? `, from ${one.from.key} version ${one.from.n}` : ""}, ${one.files?.length ?? 0} files`).join("\n"));
}

async function restoreEffect({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  cloudOn();
  const n = typeof args.version === "number" && Number.isInteger(args.version) ? args.version : null;
  if (n === null || n < 1) throw new Error("version is required: a version's number (effect_versions lists them)");
  const key = v2cloud.effectKey(projectId, name);
  const restored = await v2cloud.fetchInto(key, n, effects.folder(app.store, projectId, name));
  if (restored === null) throw new Error(`${name} has no version ${n}`);
  await v2cloud.setCurrent(key, n);
  return text(`${name} is version ${n} again (${when(restored.at)}${restored.reason ? `, ${restored.reason}` : ""}): the viewer plays it now and it renders by itself. The newer versions are kept; effect_versions lists them.`);
}

/** A library kind as the agent names it: effect (a template) or sound. */
function kindArg(value: unknown): "template" | "sound" | "font" {
  if (value === "effect") return "template";
  if (value === "sound") return "sound";
  if (value === "font") return "font";
  throw new Error('kind is effect, sound or font');
}

const keyOf = (kind: "template" | "sound" | "font", name: string) => (kind === "template" ? v2cloud.templateKey(name) : kind === "font" ? v2cloud.fontKey(name) : v2cloud.soundKey(name));

/** A name the library takes: lower-case letters, digits and hyphens. */
function libraryName(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(value)) throw new Error(`${what} is lower-case letters, digits and hyphens: "${String(value)}" isn't`);
  return value;
}

async function library({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  const kind = kindArg(args.kind);
  const words = typeof args.query === "string" ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  // What this channel can use: its own (fonts are every project's).
  const here = await placeHere(app, projectId);
  // One read for how it's made, not brought in (Sphe, Nov 13: a new effect starts from "some inspiration here as to how
  // things are done"): its note and brief, then its page's code, from a copy outside the project that's gone after.
  if (typeof args.name === "string" && kind !== "font") {
    const name = libraryName(args.name, "name");
    const found = v2cloud.forPlace(await v2cloud.list(kind), here).find((one) => one.name === name);
    if (found === undefined) throw new Error(`no ${kind === "template" ? "effect" : "sound"} ${name} in the library this project can use (library lists them)`);
    const dir = fs.mkdtempSync(join(app.store.cacheDir(), "library-read-"));
    try {
      const version = await v2cloud.fetchInto(found.key, null, join(dir, "item"));
      const entry = join(dir, "item", kind === "template" ? effects.ENTRY : effects.SOUND_ENTRY);
      const code = version !== null && fs.existsSync(entry) ? fs.readFileSync(entry, "utf8") : "";
      const files = (version?.files ?? []).map((file) => file.path).filter((path) => path !== effects.ENTRY && path !== effects.SOUND_ENTRY);
      const most = 60_000;
      return text(
        `${found.name} (version ${version?.n ?? "?"}; ${v2cloud.originOf(found, here)}) [${found.category ?? "no category"}]: ${found.note ?? ""}${found.brief ? `\nTo change it: ${found.brief}` : ""}` +
          (files.length > 0 ? `\nBeside its page: ${files.slice(0, 40).join(", ")}${files.length > 40 ? ", …" : ""}` : "") +
          `\n\n${code.length > most ? `${code.slice(0, most)}\n… (${code.length - most} more characters: use_from_library brings it in whole)` : code}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const all = await v2cloud.list(kind, args.archived === true);
  const listed = (kind === "font" ? all : v2cloud.forPlace(all, here)).filter((one) => {
    const said = `${one.name} ${one.category ?? ""} ${one.note ?? ""}`.toLowerCase();
    return words.every((word) => said.includes(word));
  });
  const what = kind === "template" ? "effects" : kind === "font" ? "fonts" : "sounds";
  if (kind === "font") {
    const kept = await fonts.refreshCloud(app.store, true);
    if (listed.length === 0) return text(words.length === 0 ? "No fonts in V2's cloud yet: fetch_font one, and it's kept (save_to_library kind font) when the person says to." : `No fonts match "${String(args.query)}".`);
    return text(listed.map((one) => {
      const font = kept.find((mine) => mine.slug === one.name);
      return `- ${one.name}${one.archived ? " (put away)" : ""}: "${font?.family ?? one.name}" (${font?.faces.map((face) => `${face.weight}${face.style === "italic" ? " italic" : ""}`).join(", ") ?? "?"}) [${one.category ?? "no category"}]: ${one.note ?? ""}`;
    }).join("\n") + "\nEach is there in every effect by its family name, as Edit's own faces are.");
  }
  if (listed.length === 0) return text(words.length === 0 ? `No ${what} in V2's cloud yet: write one, and it's kept when the person says to.` : `No ${what} match "${String(args.query)}".`);
  return text(listed.map((one) => `- ${one.name}${one.archived ? " (put away)" : ""} [${one.category ?? "no category"}; ${v2cloud.originOf(one, here)}]: ${one.note ?? ""}${one.brief ? ` To change it: ${one.brief}` : ""}`).join("\n"));
}

async function useFromLibrary({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  const kind = kindArg(args.kind);
  if (kind === "font") throw new Error("a font in the library is there in every effect already, by its family name (library kind font lists them): nothing to bring in");
  const name = libraryName(args.name, "name");
  const as = args.as === undefined ? name : libraryName(args.as, "as");
  const into = effects.folder(app.store, projectId, as);
  if (fs.existsSync(into)) throw new Error(`there's a folder called ${as} already: give another with as`);
  const n = typeof args.version === "number" && Number.isInteger(args.version) ? args.version : null;
  // The one of that name this channel uses (its own).
  const here = await placeHere(app, projectId);
  const found = v2cloud.forPlace(await v2cloud.list(kind), here).find((one) => one.name === name);
  // Only this channel's (or its group's): another channel's comes in by other_channels' bring.
  if (found === undefined) throw new Error(`no ${kind === "template" ? "effect" : "sound"} ${name} in this channel's edit style (library lists them)`);
  const from = await v2cloud.fetchInto(found.key, n, into);
  if (from === null) throw new Error(`no ${kind === "template" ? "effect" : "sound"} ${name}${n === null ? "" : ` version ${n}`} in the library`);
  return text(`effects/${as}/ is ${name} (version ${from.n}, ${from.files?.length ?? 0} files): yours to change.${kind === "sound" ? " make_sound renders it." : " Look at it, then add_effect."}`);
}

async function saveToLibrary({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Keeping it in the library");
  const kind = kindArg(args.kind);
  const name = libraryName(args.name, "name");
  const as = args.as === undefined ? name : libraryName(args.as, "as");
  const line = (field: string, most: number) => {
    const value = args[field];
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
    if (value.length > most) throw new Error(`${field} is at most ${most} characters: keep it short`);
    return value.trim();
  };
  if (kind === "font") {
    // A font the project fetched (fetch_font), kept for every agent: its note says when it's the one to use.
    const font = fonts.projectFonts(app.store, projectId).find((one) => one.slug === name);
    if (font === undefined) throw new Error(`no font ${name} in this project: fetch_font it first (the project's are ${fonts.projectFonts(app.store, projectId).map((one) => one.slug).join(", ") || "none"})`);
    const kept = await v2cloud.save(keyOf(kind, as), as, font.dir, { category: line("category", 40), note: line("note", 160), ...(typeof args.reason === "string" && args.reason !== "" ? { reason: args.reason } : {}) });
    await fonts.refreshCloud(app.store, true);
    return text(kept.made ? `${as} ("${font.family}") is version ${kept.n} in the library: every V2 agent's effects, in every channel, have it by that name now. If the person said when to use it ("on evidence boards from now on"), remember that too.` : `${as} is already exactly this (version ${kept.n}).`);
  }
  const dir = effects.folder(app.store, projectId, name);
  if (!fs.existsSync(join(dir, kind === "template" ? effects.ENTRY : effects.SOUND_ENTRY))) throw new Error(`effects/${name}/ has no ${kind === "template" ? effects.ENTRY : effects.SOUND_ENTRY}`);
  // Optional in the schema only because a font has none.
  if (typeof args.brief !== "string" || args.brief.trim() === "") throw new Error(`brief is required for ${kind === "sound" ? "a sound" : "an effect"}: how to change it without making it again, in a line or two`);
  await placeHere(app, projectId);
  const where = keptIn(app, projectId, args.for);
  const kept = await v2cloud.save(v2cloud.ownKey(kind, where.place, as), as, dir, { category: line("category", 40), note: line("note", 160), brief: line("brief", 240), ...(typeof args.reason === "string" && args.reason !== "" ? { reason: args.reason } : {}) });
  return text(kept.made ? `${as} is version ${kept.n} in the library, in this channel's edit style${where.words === "" ? "" : ` ${where.words}`}: what its projects start from.` : `${as} is already exactly this (version ${kept.n}).`);
}

async function archiveInLibrary({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Putting it away");
  const name = libraryName(args.name, "name");
  if (args.kind === "skill" && name === v2cloud.GLOBAL) throw new Error("the global skill stays: it's Edit's own");
  // This channel's own (a font is every project's).
  const kind = args.kind === "skill" ? "skill" : kindArg(args.kind);
  let key = keyOf("font", name);
  if (kind !== "font") {
    keptIn(app, projectId, undefined);
    // The one of that name this channel uses: its own, else its group's.
    const places = (await placeHere(app, projectId)) ?? [];
    const seen = v2cloud.forPlace(await v2cloud.list(kind, true), places).find((one) => one.name === name);
    if (seen === undefined || !places.includes(v2cloud.ownPlaceOf(seen.key) ?? "")) throw new Error(`no ${kind === "template" ? "effect" : kind} ${name} in this channel's edit style`);
    key = seen.key;
  }
  const archived = args.archived !== false;
  await v2cloud.archive(key, archived);
  if (args.kind === "skill") v2cloud.forgetSkills();
  if (args.kind === "font") await fonts.refreshCloud(app.store, true);
  return text(archived ? `${name} is put away: out of every list, its versions kept (archived: false brings it back).` : `${name} is back.`);
}

/** A memory is a line or two; a part of the edit (a skill with a note, read when needed) is longer, and still short. */
const MEMORY_MOST = 400;
const SKILL_MOST = 2_400;

async function remember({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Remembering it for this channel's agents");
  const skill = libraryName(args.skill, "skill");
  if (skill === v2cloud.GLOBAL) throw new Error("the global skill is Edit's own: give your own a name");
  if (typeof args.text !== "string" || args.text.trim() === "") throw new Error("text is required");
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the person said");
  const note = typeof args.note === "string" && args.note.trim() !== "" ? args.note.trim() : undefined;
  if (note !== undefined && note.length > 160) throw new Error("note is at most 160 characters: when to read it");
  const places = await placeHere(app, projectId);
  const where = keptIn(app, projectId, args.for);
  // A part's skill, or one already longer than a memory (the house rules, always in mind): saved whole again with the change.
  const before = v2cloud.skill(skill, places);
  const part = note !== undefined || before?.note !== undefined || (before?.text.length ?? 0) > MEMORY_MOST;
  const most = part ? SKILL_MOST : MEMORY_MOST;
  if (args.text.length > most) throw new Error(`at most ${most} characters (this is ${args.text.length}): ${part ? "keep the part's skill short: its rules, not their history" : "a line or two, in the person's words"}`);
  // What it contradicts is said first, and kept only once the person says which holds (teaching_conflicts.ts).
  const settled = typeof args.settled === "string" && args.settled.trim() !== "";
  const clashes = settled ? [] : await teachingConflicts.conflicts(skill, args.text.trim(), v2cloud.memories(places));
  if (clashes !== null && clashes.length > 0) throw new Error(teachingConflicts.refusal(clashes));
  // A part keeps its note when it's saved somewhere else (a channel's own changed for its group).
  const key = v2cloud.ownKey("skill", where.place, skill);
  const reason = settled ? `${args.reason.trim()} (settled against what was taught: ${String(args.settled).trim()})` : args.reason.trim();
  const saved = await v2cloud.saveSkill(skill, args.text.trim(), reason, note ?? before?.note, { key, ...(before?.key === key && before.latest !== undefined ? { latest: before.latest } : {}) });
  // Kept for the group while this channel has its own of that name: the channel's still wins here.
  const shadowed = places !== null && where.place !== places[0] && v2cloud.ownPlaceOf(before?.key ?? "") === places[0];
  v2cloud.forgetSkills();
  return text(`Remembered as ${skill} (version ${saved.n}) in this channel's edit style${where.words === "" ? "" : ` ${where.words}`}: its agents have it from their next turn.${shadowed ? ` This channel's own ${skill} still wins here: change that one (for: "channel") to change it for this channel.` : ""}${clashes === null ? teachingConflicts.UNCHECKED : ""}`);
}

/**
 * `teach_removal`: what this channel takes out of its footage's picture
 * (removal_lesson.ts), kept as its `removal` lesson (its group's by default),
 * with examples that only help. Each part
 * given is set, the others stay as they were; examples are added (the same
 * frame's replaced). A teacher's to do.
 */
async function teachRemoval({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Teaching what this channel takes out of its footage");
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the person said");
  const places = await placeHere(app, projectId);
  const where = keptIn(app, projectId, args.for);
  const project = app.store.get(projectId)!.project;
  const parts: Partial<Record<removal.Kind, boolean>> = {};
  for (const kind of removal.KINDS) {
    if (args[kind] === undefined) continue;
    if (typeof args[kind] !== "boolean") throw new Error(`${kind} is true (take theirs out) or false (leave them)`);
    parts[kind] = args[kind] as boolean;
  }
  // When each part runs: by itself as footage is cut, or only once someone asks (start_removal).
  const when: Partial<Record<removal.Kind, removal.When>> = {};
  const timing = args.when === undefined || args.when === null ? {} : (args.when as Record<string, unknown>);
  if (typeof timing !== "object" || Array.isArray(timing)) throw new Error('when is {subtitles?, watermarks?, text?}, each "automatic" or "asked"');
  for (const [kind, value] of Object.entries(timing)) {
    if (!removal.KINDS.includes(kind as removal.Kind) || (value !== "automatic" && value !== "asked")) throw new Error(`when.${kind} is "automatic" (by itself after import) or "asked" (only when someone asks)`);
    when[kind as removal.Kind] = value;
  }
  const given = Array.isArray(args.examples) ? (args.examples as Record<string, unknown>[]) : [];
  if (given.length > 6) throw new Error("at most 6 examples at a time");
  const examples: removal.Example[] = [];
  for (const one of given) {
    const kind = one.kind;
    if (kind !== "stamp" && !removal.KINDS.includes(kind as removal.Kind)) throw new Error('an example\'s kind is "subtitles", "watermarks", "text" or "stamp"');
    if (one.action !== "remove" && one.action !== "keep") throw new Error('an example\'s action is "remove" or "keep"');
    const box = Array.isArray(one.box) && one.box.length === 4 && one.box.every((value) => typeof value === "number") ? (one.box as [number, number, number, number]) : undefined;
    examples.push(
      await textRemoval.takeExample(
        app,
        project,
        project.channel!,
        {
          kind: kind as removal.Example["kind"],
          action: one.action,
          ...(typeof one.media === "string" ? { media: one.media } : {}),
          ...(typeof one.at === "number" ? { at: one.at } : {}),
          ...(typeof one.picture === "string" ? { picture: one.picture } : {}),
          ...(box !== undefined ? { box } : {}),
          ...(typeof one.text === "string" ? { text: one.text } : {}),
          ...(typeof one.note === "string" ? { note: one.note } : {}),
        },
        [app.store.uploadsDir(projectId), app.store.cacheDir()],
      ),
    );
  }
  const before = v2cloud.skill(removal.SKILL, places);
  const lesson = removal.changed(before === undefined ? null : removal.parse(before.text), parts, examples, args.clear_examples === true, when);
  const key = v2cloud.ownKey("skill", where.place, removal.SKILL);
  const saved = await v2cloud.saveSkill(removal.SKILL, removal.write(lesson), args.reason.trim(), removal.NOTE, { key, ...(before?.key === key && before.latest !== undefined ? { latest: before.latest } : {}) });
  // Kept for the group while this channel has its own: the channel's still wins here.
  const shadowed = places !== null && where.place !== places[0] && v2cloud.ownPlaceOf(before?.key ?? "") === places[0];
  v2cloud.forgetSkills();
  // Started at once on this project's footage (its mark learned first when watermarks are taught).
  void removalSchedule.ensure(app, projectId).catch(() => {});
  const read = examples.map((one) => `${one.action} ${one.kind}${one.text ? ` "${one.text}"` : ""}${one.box ? ` at ${one.box.join(" ")}` : " (no box: say where on the picture, box, to place it)"}`);
  return text(
    `${removal.summary(lesson)} Kept as ${removal.SKILL} (version ${saved.n}) in this channel's edit style${where.words === "" ? "" : ` ${where.words}`}.` +
      (read.length > 0 ? ` Examples: ${read.join("; ")}.` : "") +
      (removal.KINDS.some((kind) => lesson.remove[kind] && lesson.when[kind] === "automatic")
        ? " Edit looks at every footage file itself as it's cut, in the background, and takes out what each one actually has (nothing where a file has none; their subtitles blurred until then); look at pieces as they come back with check_removal."
        : "") +
      (removal.KINDS.some((kind) => lesson.remove[kind] && lesson.when[kind] === "asked") ? " What runs only when asked waits until someone asks: then start_removal on what they point to." : "") +
      (shadowed ? ` This channel's own ${removal.SKILL} still wins here: change that one (for: "channel") to change it for this channel.` : ""),
  );
}

async function readSkill({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  const name = libraryName(args.name, "name");
  const found = v2cloud.skill(name, await placeHere(app, projectId));
  if (found === undefined) throw new Error(`no skill ${name}: the ones there are listed in your instructions`);
  return text(found.text);
}

async function makeSound({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  const made = await effects.makeSound(app, projectId, name);
  return text(`${name} is media ${made.media}: ${fixed(made.duration, 2)} s. Place it as an audio clip; make_sound again after changing its code (the same media plays the new sound).`);
}

/** A box [x0, y0, x1, y1] from the agent, or the error that says what one is. */
function boxOf(value: unknown, what: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || value.some((one) => typeof one !== "number" || !Number.isFinite(one))) throw new Error(`${what} is [x0, y0, x1, y1] in project pixels from the top-left`);
  return value as [number, number, number, number];
}

async function effectTrack({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  if (typeof args.time !== "number" || !Number.isFinite(args.time) || args.time < 0) throw new Error("time is required: the timeline second the boxes are as given");
  if (!Array.isArray(args.points)) throw new Error("points is a list of {name, box, boxes?}");
  const points = (args.points as unknown[]).map((given, at): effectInputs.Point => {
    const point = (typeof given === "object" && given !== null ? given : {}) as Record<string, unknown>;
    if (typeof point.name !== "string") throw new Error(`points[${at}] needs a name`);
    const boxes = Array.isArray(point.boxes)
      ? (point.boxes as unknown[]).map((more) => {
          const one = (typeof more === "object" && more !== null ? more : {}) as Record<string, unknown>;
          if (typeof one.time !== "number") throw new Error(`${point.name}'s boxes are {time, box}`);
          return { time: one.time, box: boxOf(one.box, `${point.name}'s box at ${one.time}`) };
        })
      : [];
    return { name: point.name, box: boxOf(point.box, `${point.name}'s box`), boxes };
  });
  const span: [number | null, number | null] = [typeof args.from === "number" ? args.from : null, typeof args.to === "number" ? args.to : null];
  return text(await effectInputs.track(app, projectId, name, args.time, points, span, typeof args.as === "string" ? args.as : "track"));
}

async function effectBeneath({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  const made = await effectInputs.beneath(app, projectId, name);
  return text(
    `effects/${name}/${effectInputs.BENEATH}: what the tracks below ${name}'s clip show over its ${fixed(made.seconds, 2)} s (no sound), second t of it at second t of the effect${made.made ? "" : " (already of what's there now)"}. ` +
      `Play it in the page (a <video> you seek to t and wait for, as effect_footage's) and draw it as you like: blurred, bent, refracted, cut up. Edit makes it again by itself when what's beneath changes, or the clip moves; the effect is rendered again after it.`,
  );
}

const TOOLS: [string, (call: ToolCall) => Promise<Content[]>][] = [
  ["effect_track", effectTrack],
  ["effect_beneath", effectBeneath],
  ["effect_versions", effectVersions],
  ["restore_effect", restoreEffect],
  ["library", library],
  ["use_from_library", useFromLibrary],
  ["save_to_library", saveToLibrary],
  ["archive_in_library", archiveInLibrary],
  ["remember", remember],
  ["teach_removal", teachRemoval],
  ["read_skill", readSkill],
  ["make_sound", makeSound],
  ["effect_footage", effectFootage],
  ["look_at_effect", lookAtEffect],
  ["fetch_font", fetchFont],
  ["add_effect", addEffect],
  ["effect_picture", effectPicture],
];

/** Registers the effects' tools with the MCP server (once; later calls do nothing). */
export function registerEffectTools(): void {
  effectInputs.start();
  for (const [name, handler] of TOOLS) {
    if (handlerFor(name)?.handler === handler) continue;
    registerTool(name, handler);
  }
}
