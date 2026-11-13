// The agent's tools for coded effects (effects.ts; Edit V2, a project with
// `hq`). It writes an effect's code itself, with its own file tools in the
// project's effects folder (agent.ts); these are the three things code can't
// do from there: see the page drawn, bring one of the project's pictures into
// its folder, and put it among the project's media.

import type { App } from "./app.ts";
import fs from "node:fs";
import { join } from "node:path";
import * as effectInputs from "./effect_inputs.ts";
import * as effects from "./effects.ts";
import * as frameCompare from "./frame_compare.ts";
import * as fonts from "./fonts.ts";
import { handlerFor, image, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import { fixed } from "./rust.ts";
import * as tools from "./tools.ts";
import * as v2cloud from "./v2_cloud.ts";
import type { Entry } from "./agent.ts";
import { personSaid } from "./hq_reference.ts";
import { agentPanel } from "./seams.ts";

/** An effect's name from a call, in a project made the new way. */
function named(app: App, projectId: string, args: Record<string, unknown>): string {
  if (app.store.get(projectId)?.project.hq !== true) throw new Error("coded effects are for Bodycam HQ projects (Edit V2): this project isn't one");
  if (typeof args.name !== "string" || args.name === "") throw new Error("name is required: the effect's folder under effects/");
  return args.name;
}

/** What a frame's cost means for playing it: the video's own frame time is what it's held to. */
function costLine(look: effects.Look, fps: number): string {
  const frame = 1000 / fps;
  // The cost is counted in the screen's refreshes, so one over the frame time by less than half a refresh still fits it.
  const slow = look.stills.filter((still) => still.cost > frame + look.interval / 2);
  if (look.stills.length === 0) return "";
  if (slow.length === 0) return `It plays live on this computer: a frame took ${fixed(Math.max(...look.stills.map((still) => still.cost)), 0)} ms at most to draw from the moments looked at, and the video's frames are ${fixed(frame, 0)} ms apart.`;
  return `IT WON'T PLAY LIVE at ${slow.map((still) => `${fixed(still.time, 2)} s (${fixed(still.cost, 0)} ms a frame, about ${fixed(1000 / still.cost, 0)} a second)`).join(", ")} on this computer: the video's frames are ${fixed(frame, 0)} ms apart. Make those moments lighter (whole-frame blurs and filters, big blurred shadows and thousands of things redrawn each frame are what cost).`;
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
 */
async function lookAtStretch(app: ToolCall["app"], projectId: string, name: string, args: Record<string, unknown>): Promise<Content[]> {
  const fps = app.store.get(projectId)!.project.settings.fps;
  const start = typeof args.start === "number" && Number.isFinite(args.start) && args.start >= 0 ? args.start : 0;
  const end = typeof args.end === "number" && Number.isFinite(args.end) && args.end > start ? args.end : start + 1;
  const first = Math.round(start * fps);
  const last = Math.max(first, Math.round(end * fps) - 1);
  const count = Math.min(last - first + 1, EFFECT_FRAMES_MOST);
  const times = Array.from({ length: count }, (_, index) => (first + index) / fps);
  const look = await effects.look(app, projectId, name, times, SHEET_FRAME);
  const out: Content[] = [];
  const dir = fs.mkdtempSync(join(app.store.cacheDir(), "effect-frames-"));
  try {
    for (let at = 0; at < look.stills.length; at += PER_SHEET) {
      const part = look.stills.slice(at, at + PER_SHEET);
      part.forEach((still, index) => fs.writeFileSync(join(dir, `f${String(index).padStart(3, "0")}.jpg`), still.picture));
      const sheet = join(dir, `sheet-${at}.jpg`);
      const label = `drawtext=${frameCompare.labelFont(app.store.cacheDir())}:text='%{eif\\:n+${first + at}\\:d}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7`;
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-framerate", "1", "-i", join(dir, "f%03d.jpg"), "-frames:v", "1", "-vf", `${label},tile=4x${Math.ceil(part.length / 4)}:padding=4`, "-q:v", "3", sheet]);
      const from = first + at;
      out.push(...image(new Uint8Array(fs.readFileSync(sheet)), `${name}: every frame, ${from}–${from + part.length - 1} (${fixed(from / fps, 2)}–${fixed((from + part.length - 1) / fps, 2)} s), left-to-right then down, numbered by frame`, "image/jpeg"));
      for (const file of fs.readdirSync(dir)) fs.rmSync(join(dir, file), { force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const lines: string[] = [];
  if (first + count <= last) lines.push(`Frames ${first + count}–${last} are left: look again with start ${fixed((first + count) / fps, 3)}.`);
  if (look.errors.length > 0) lines.push(`ERRORS its page threw (fix these first):\n${look.errors.map((error) => `- ${error}`).join("\n")}`);
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
  const look = await effects.look(app, projectId, name, times, 0);
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
    if (reference && ours.some((_, index) => (refs[index] ?? "") === "")) await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `color=black:s=${width}x${height}`, "-frames:v", "1", black]);
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
  if (look.problems.length > 0) lines.push(`BREAKS THE EFFECT CONTRACT:\n${look.problems.map((problem) => `- ${problem}`).join("\n")}`);
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
  return text(`${name} is media ${added.media}: ${fixed(added.duration, 2)} s (${Math.round(added.duration * fps)} frames). Place it like a video (add_clip or apply_edit_plan with media ${added.media}); the viewer plays its page live wherever its clip is, and a change to its code shows there at once. Edit's frames (render_frame, contact_sheet) show it once its render lands, a few seconds after its code stops changing.`);
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
}

const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16);

// ---------------------------------------------------------------- niches (Sphe, Nov 13)

/** The project's V2 niche and the ones it's like, nearest first (the niches read fresh enough). */
async function nicheHere(app: App, projectId: string): Promise<{ niche: string; chain: string[]; name: (key: string) => string }> {
  await v2cloud.refreshSkills();
  const niche = v2cloud.nicheOfProject(app.store.get(projectId)?.project ?? {});
  const name = (key: string) => v2cloud.knownNiches().find((one) => one.key === key)?.name ?? key;
  return { niche, chain: v2cloud.chainOf(niche), name };
}

/** Whether `asked` quotes one of the person's own messages in this chat (a widening of what's kept is theirs to ask for). */
function quoted(app: App, projectId: string, asked: unknown): boolean {
  const entries = (agentPanel(app).turn?.(projectId).entries ?? []) as readonly Entry[];
  return typeof asked === "string" && personSaid(entries, asked);
}

/**
 * Where a lesson or an effect of this niche's is kept (Sphe, Nov 13: "tell
 * the agent, hey, this should apply to bodycam and interrogation… only when
 * the user specifically asks for it"; "if some effect is linked between
 * multiple niches, it can then ask… just this one or the rest"):
 * - by default this niche's own (`<kind>:@<niche>/<name>`), which wins over
 *   the house's or another niche's of its name here and touches no other;
 * - `niches` (niche keys, or "all" for every niche) only quoting the person;
 * - changing one this niche shares with others (the house's, or kept for
 *   several): refused until the person has said which, `for` "this niche"
 *   (made this niche's own) or "all" (quoting them).
 */
function placeOf(app: App, projectId: string, args: Record<string, unknown>, kind: "template" | "sound" | "skill", name: string, here: { niche: string; chain: string[]; name: (key: string) => string }, existing: { key: string; niches?: string[] | null } | undefined): { key: string; niches?: string[]; where: string } {
  const plain = kind === "template" ? v2cloud.templateKey(name) : kind === "sound" ? v2cloud.soundKey(name) : v2cloud.skillKey(name);
  const own = { key: v2cloud.ownKey(kind, here.niche, name), where: `${here.name(here.niche)}'s own` };
  if (Array.isArray(args.niches)) {
    const given = (args.niches as unknown[]).filter((one): one is string => typeof one === "string");
    if (!quoted(app, projectId, args.asked)) throw new Error(`Keeping it for ${given.join(", ")} is the person's to ask for: call again with asked, their words quoted from their message (otherwise leave niches out: it's this niche's own).`);
    if (given.includes("all")) return { key: plain, niches: [], where: "every niche (V2's house)" };
    const known = new Set(v2cloud.knownNiches().map((one) => one.key));
    const unknown = given.filter((one) => !known.has(one) && one !== here.niche);
    if (unknown.length > 0) throw new Error(`no niche ${unknown.join(", ")}: the niches are ${[...known].join(", ") || "none yet"}`);
    const niches = [...new Set([here.niche, ...given])].sort();
    return { key: plain, niches, where: niches.map(here.name).join(", ") };
  }
  // Its own already, or one that came through from a niche it's like (that niche's, not this one's): taught otherwise here, it's this niche's own.
  const ownedBy = existing === undefined ? null : v2cloud.ownNicheOf(existing.key);
  const listed = existing?.niches ?? null;
  if (existing === undefined || ownedBy !== null || (listed !== null && listed.length > 0 && !listed.includes(here.niche))) return own;
  const sharedWith = existing.niches == null || existing.niches.length === 0 ? "every niche (it's V2's house)" : existing.niches.map(here.name).join(", ");
  if (args.for === "this niche") return own;
  if (args.for === "all") {
    if (!quoted(app, projectId, args.asked)) throw new Error("Changing it for every niche it's in is the person's to ask for: call again with asked, their words quoted from their message.");
    return { key: existing.key, where: sharedWith };
  }
  throw new Error(`${name} is shared: ${sharedWith} use${existing.niches?.length === 1 ? "s" : ""} it. Ask the person whether this change is for ${here.name(here.niche)} alone or for all of them, and end your turn; then call again with for: "this niche" (made this niche's own, the others keep theirs) or for: "all" with asked, their answer quoted.`);
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
  // What this niche can use: its own, the niches it's like, then the house's; one of each name (fonts are every niche's).
  const here = await nicheHere(app, projectId);
  const all = await v2cloud.list(kind, args.archived === true);
  const listed = (kind === "font" ? all : v2cloud.forNiche(all, here.chain)).filter((one) => {
    const said = `${one.name} ${one.category ?? ""} ${one.note ?? ""}`.toLowerCase();
    return words.every((word) => said.includes(word));
  });
  const what = kind === "template" ? "effects" : kind === "font" ? "fonts" : "sounds";
  if (kind === "font") {
    const here = await fonts.refreshCloud(app.store, true);
    if (listed.length === 0) return text(words.length === 0 ? "No fonts in V2's cloud yet: fetch_font one, and it's kept (save_to_library kind font) when the person says to." : `No fonts match "${String(args.query)}".`);
    return text(listed.map((one) => {
      const font = here.find((mine) => mine.slug === one.name);
      return `- ${one.name}${one.archived ? " (put away)" : ""}: "${font?.family ?? one.name}" (${font?.faces.map((face) => `${face.weight}${face.style === "italic" ? " italic" : ""}`).join(", ") ?? "?"}) [${one.category ?? "no category"}]: ${one.note ?? ""}`;
    }).join("\n") + "\nEach is there in every effect by its family name, as Edit's own faces are.");
  }
  if (listed.length === 0) return text(words.length === 0 ? `No ${what} in V2's cloud yet: write one, and it's kept when the person says to.` : `No ${what} match "${String(args.query)}".`);
  return text(listed.map((one) => `- ${one.name}${one.archived ? " (put away)" : ""} [${one.category ?? "no category"}; ${v2cloud.originOf(one, here.chain)}]: ${one.note ?? ""}${one.brief ? ` To change it: ${one.brief}` : ""}`).join("\n"));
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
  // The one of that name this niche uses (its own, a niche it's like, the house's).
  const here = await nicheHere(app, projectId);
  const found = v2cloud.forNiche(await v2cloud.list(kind), here.chain).find((one) => one.name === name);
  const from = await v2cloud.fetchInto(found?.key ?? keyOf(kind, name), n, into);
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
    return text(kept.made ? `${as} ("${font.family}") is version ${kept.n} in the library: every V2 agent's effects, in every niche, have it by that name now. If the person said when to use it ("on evidence boards from now on"), remember that too.` : `${as} is already exactly this (version ${kept.n}).`);
  }
  const dir = effects.folder(app.store, projectId, name);
  if (!fs.existsSync(join(dir, kind === "template" ? effects.ENTRY : effects.SOUND_ENTRY))) throw new Error(`effects/${name}/ has no ${kind === "template" ? effects.ENTRY : effects.SOUND_ENTRY}`);
  // Optional in the schema only because a font has none.
  if (typeof args.brief !== "string" || args.brief.trim() === "") throw new Error(`brief is required for ${kind === "sound" ? "a sound" : "an effect"}: how to change it without making it again, in a line or two`);
  const here = await nicheHere(app, projectId);
  const existing = v2cloud.forNiche(await v2cloud.list(kind), here.chain).find((one) => one.name === as);
  const place = placeOf(app, projectId, args, kind, as, here, existing);
  const kept = await v2cloud.save(place.key, as, dir, { category: line("category", 40), note: line("note", 160), brief: line("brief", 240), ...(place.niches !== undefined ? { niches: place.niches } : {}), ...(typeof args.reason === "string" && args.reason !== "" ? { reason: args.reason } : {}) });
  return text(kept.made ? `${as} is version ${kept.n} in the library, for ${place.where}: what their projects start from.` : `${as} is already exactly this (version ${kept.n}).`);
}

async function archiveInLibrary({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Putting it away");
  const name = libraryName(args.name, "name");
  if (args.kind === "skill" && name === v2cloud.GLOBAL) throw new Error("the global skill stays: it's Edit's own");
  // The one this niche uses; one it shares with others is put away for all of them only when the person asked.
  const here = await nicheHere(app, projectId);
  const kind = args.kind === "skill" ? "skill" : kindArg(args.kind);
  const seen = kind === "skill" ? v2cloud.skill(name, here.niche) : kind === "font" ? undefined : v2cloud.forNiche(await v2cloud.list(kind, true), here.chain).find((one) => one.name === name);
  const key = seen?.key ?? (kind === "skill" ? v2cloud.skillKey(name) : keyOf(kind, name));
  if (kind !== "font" && v2cloud.ownNicheOf(key) !== here.niche && !quoted(app, projectId, args.asked)) {
    throw new Error(`${name} isn't ${here.name(here.niche)}'s alone (${v2cloud.originOf({ key, niches: seen?.niches ?? null }, here.chain)}): putting it away takes it from every niche that has it. Ask the person, then call again with asked, their words quoted.`);
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
  teacherOnly("Remembering it for the niche's agents");
  const skill = libraryName(args.skill, "skill");
  if (skill === v2cloud.GLOBAL) throw new Error("the global skill is Edit's own: give your own a name");
  if (typeof args.text !== "string" || args.text.trim() === "") throw new Error("text is required");
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the person said");
  const note = typeof args.note === "string" && args.note.trim() !== "" ? args.note.trim() : undefined;
  if (note !== undefined && note.length > 160) throw new Error("note is at most 160 characters: when to read it");
  const here = await nicheHere(app, projectId);
  // A part's skill, or one already longer than a memory (the house rules, always in mind): saved whole again with the change.
  const before = v2cloud.skill(skill, here.niche);
  const part = note !== undefined || before?.note !== undefined || (before?.text.length ?? 0) > MEMORY_MOST;
  const most = part ? SKILL_MOST : MEMORY_MOST;
  if (args.text.length > most) throw new Error(`at most ${most} characters (this is ${args.text.length}): ${part ? "keep the part's skill short: its rules, not their history" : "a line or two, in the person's words"}`);
  const place = placeOf(app, projectId, args, "skill", skill, here, before?.key === undefined ? undefined : { key: before.key, niches: before.niches ?? null });
  const saved = await v2cloud.saveSkill(skill, args.text.trim(), args.reason.trim(), note, { key: place.key, ...(place.niches !== undefined ? { niches: place.niches } : {}) });
  v2cloud.forgetSkills();
  return text(`Remembered as ${skill} (version ${saved.n}) for ${place.where}: their agents have it from their next turn.`);
}

async function readSkill({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  const name = libraryName(args.name, "name");
  const here = await nicheHere(app, projectId);
  const found = v2cloud.skill(name, here.niche);
  if (found === undefined) throw new Error(`no skill ${name}: the ones there are listed in your instructions`);
  return text(found.text);
}

/**
 * The project's V2 niche (Sphe, Nov 13): what it is and what it's like; and,
 * a teacher's when the person asks (asked: their words), its name and
 * description changed, what it's like set ("this niche works very similarly
 * to the bodycam niche") or cut loose (what came through kept as its own), or
 * a new niche made.
 */
async function nicheTool({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  const here = await nicheHere(app, projectId);
  const known = v2cloud.knownNiches();
  const project = app.store.get(projectId)!.project;
  const current = known.find((one) => one.key === here.niche) ?? { key: here.niche, name: here.niche === v2cloud.BODYCAM_HQ ? "Bodycam HQ" : here.niche, description: "", like: null, kind: project.style };
  const changing = ["name", "description", "like", "cut_loose", "create"].some((field) => args[field] !== undefined);
  if (changing) {
    teacherOnly("Changing a niche");
    if (!quoted(app, projectId, args.asked)) throw new Error("A niche is the team's: change it only when the person asks, with asked, their words quoted from their message.");
  }
  const reason = typeof args.asked === "string" ? args.asked : "asked in the chat";
  const keyOfNiche = (given: unknown): string | null => {
    if (given === null || given === "") return null;
    if (typeof given !== "string") throw new Error("a niche is given by its key or its name");
    const found = known.find((one) => one.key === given || one.name.toLowerCase() === given.toLowerCase());
    if (found === undefined) throw new Error(`no niche ${given}: the niches are ${known.map((one) => `${one.name} (${one.key})`).join(", ") || "none yet"}`);
    return found.key;
  };
  if (args.create !== undefined) {
    const made = (typeof args.create === "object" && args.create !== null ? args.create : {}) as Record<string, unknown>;
    if (typeof made.name !== "string" || made.name.trim() === "") throw new Error("create is {name, description, like?}");
    const key = v2cloud.nicheKeyOf(made.name);
    if (known.some((one) => one.key === key)) throw new Error(`there's a niche ${key} already`);
    const like = keyOfNiche(made.like ?? null);
    // Its kind of video: as given, else the one it's like's, else this project's.
    const kind = typeof made.kind === "string" && made.kind !== "" ? made.kind : (known.find((one) => one.key === like)?.kind ?? project.style);
    const niche = await v2cloud.saveNiche({ key, name: made.name.trim(), description: typeof made.description === "string" ? made.description : "", like, kind }, reason);
    return text(`Made the niche ${niche.name} (${niche.key})${niche.like ? `, like ${niche.like}` : ""}: new V2 projects can be made in it from Home. This project stays in ${current.name}.`);
  }
  if (args.cut_loose === true) {
    if (current.like === null) throw new Error(`${current.name} isn't like another niche: nothing to cut loose from`);
    const copied = await v2cloud.cutLoose(here.niche, reason);
    return text(`${current.name} is cut loose from ${current.like}: ${copied} lesson(s), effect(s) and sound(s) it had from it are its own now, and what ${current.like} is taught from here doesn't come through.`);
  }
  if (changing) {
    const next = { ...current, ...(typeof args.name === "string" && args.name.trim() !== "" ? { name: args.name.trim() } : {}), ...(typeof args.description === "string" ? { description: args.description } : {}), ...(args.like !== undefined ? { like: keyOfNiche(args.like) } : {}) };
    await v2cloud.saveNiche(next, reason);
    return text(`${next.name} (${next.key}): ${next.description || "no description"}${next.like ? `; like ${next.like}, whose teaching comes through where ${next.name} isn't taught otherwise` : "; like no other niche"}. Its agents have it from their next turn.`);
  }
  const own = (await Promise.all((["skill", "template", "sound"] as const).map((kind) => v2cloud.list(kind)))).flat().filter((item) => v2cloud.ownNicheOf(item.key) === here.niche || item.niches?.includes(here.niche));
  return text(
    `This project's niche: ${current.name} (${current.key})${current.description ? `: ${current.description.replace(/\.$/u, "")}` : ""}.\n` +
      `Like: ${here.chain.slice(1).map(here.name).join(" → ") || "no other niche"}.\n` +
      `Its own lessons, effects and sounds: ${own.length}. The niches: ${known.map((one) => `${one.name} (${one.key}${one.like ? `, like ${one.like}` : ""})`).join("; ") || "none yet"}.`,
  );
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
  ["read_skill", readSkill],
  ["niche", nicheTool],
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
