// One removal of what a re-uploader burned into footage (Sphe, Nov 17): what
// a channel takes out comes from its teaching (removal_lesson.ts: their
// subtitles, their watermarks, their labels and text, each on or off, with
// examples; the camera's stamp always kept), and it all runs on one schedule:
//
//   - as soon as the footage is cut onto the timeline (a script's import, the
//     agent's first cut), 2 s after edits rest, in the background beside the
//     agent's cut-ins and graphics; whenever clips change, only the newly
//     needed seconds go (each worker keeps its pieces by file and seconds, so
//     nothing is done or paid for twice);
//   - two workers, both here and free: their watermarks taken out by the
//     engine (watermark_removal.ts; every footage file looked at once for a
//     mark of its own, kept by source; nothing done where there's none),
//     their subtitles and text under a blur tracked tight over their words
//     (text_blur.ts, through text_removal.ts's plan: only the stretches the
//     agent marked, in every section of the edit);
//   - every piece checked: the engine's automatically (how much of the mark
//     is left), then by the agent (`check_removal`: before and after, it
//     rejects what isn't clean; the blur's with render_frame); a watermark
//     that isn't is done once more, then left as it was, and said;
//   - an export waits for pieces still out ("Removing their text · 3 of 19
//     pieces" among its steps): footage of a channel taught to take theirs out
//     never goes out uncleaned while a piece is coming.

import type { App } from "./app.ts";
import * as background from "./background.ts";
import * as burned from "./burned_subtitles.ts";
import { readyNotes, readyWaits } from "./broll.ts";
import { ApiError, json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import * as found from "./found.ts";
import { image, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import { framingAt } from "./frames_fill.ts";
import type { Media, Project, VideoClip } from "./model.ts";
import { clipEnd, fps as fpsOf, trackOf } from "./project.ts";
import { isOverlay } from "./clean_strips.ts";
import * as asks from "./removal_asks.ts";
import * as removal from "./removal_lesson.ts";
import * as removerCloud from "./remover_cloud.ts";
import * as sections from "./removal_sections.ts";
import { EDIT_EVENT } from "./edit_event.ts";
import * as seams from "./seams.ts";
import * as textBlur from "./text_blur.ts";
import * as textInpaint from "./text_inpaint.ts";
import * as textRemoval from "./text_removal.ts";
import * as tools from "./tools.ts";
import * as watermarkRemoval from "./watermark_removal.ts";

/** How long an export waits for pieces still out; how soon after the server starts its work resumes. */
export const timing = { exportWaitMs: 3 * 3_600_000, restMs: 2000, resumeMs: 15_000, watchMs: 2000, wakeEveryMs: 3000 };

/** Projects whose work resumes when the server starts: those changed within this. */
const RESUME_WITHIN_MS = 14 * 86_400_000;

/**
 * Picks the work up again after the server starts (a restart, an update):
 * every recent project whose channel's lesson (or what was asked there) takes
 * something out is brought up to date, one after another, as an edit would.
 * Pieces cut short by the stop were never kept, so they're done again; kept
 * ones are laid from the shelf, never made twice (Nov 17, Sphe's M4: after a
 * restart at 15:26 nothing resumed until an edit).
 */
export async function resume(app: App): Promise<number> {
  await removal.refresh().catch(() => {});
  // The relay asked first: the queues choose rented machines or this computer synchronously, by its last answer, and
  // before any there was none (Nov 20: SMART Cops' two longest blurs, picked up at a restart, read here for an hour).
  await removerCloud.on().catch(() => false);
  const since = Date.now() - RESUME_WITHIN_MS;
  let count = 0;
  for (const summary of app.store.list()) {
    if (summary.problem !== undefined || summary.modified_ms < since || summary.clips === 0) continue;
    const project = app.store.get(summary.id)?.project;
    if (project === undefined || !project.channel || asks.inForce(removal.lessonOf(project), app.store.home, summary.id) === null) continue;
    count += 1;
    await ensure(app, summary.id).catch((error: unknown) => diag.warn("removal", `${summary.id}: resuming: ${diag.messageOf(error)}`));
  }
  if (count > 0) diag.info("removal", `resumed ${count} project(s) taught to take theirs out`);
  return count;
}

/**
 * Brings `id`'s removal up to date with its channel's lesson: each part taught
 * started on what the timeline newly shows. Nothing for a channel taught
 * nothing (theirs left, ours off them).
 */
export async function ensure(app: App, id: string): Promise<void> {
  const live = app.store.get(id);
  if (live === null) return;
  await removal.refresh();
  // The parts that run by themselves, and those asked for here (a part taught to wait for an ask does nothing until then).
  const lesson = asks.inForce(removal.lessonOf(live.project), app.store.home, id);
  if (lesson?.remove.watermarks === true) await watermarkRemoval.ensure(app, id);
  if (removal.kinds(lesson).blur.length > 0) await textRemoval.ensure(app, id);
  noteRun(app, id);
}

/**
 * What a project's lesson says of marks: where a source's is (its example's
 * box), what's kept (never a mark), and the seconds of each file to look at
 * (all the timeline shows when watermarks run by themselves, else what was
 * asked for).
 */
function hintsOf(app: App, id: string): watermarkRemoval.Hints {
  const project = app.store.get(id)?.project;
  const lesson = project === undefined ? null : removal.lessonOf(project);
  const shown = (lesson?.examples ?? []).filter((one) => one.kind === "watermarks" && one.action === "remove" && one.box !== undefined && one.from !== undefined);
  return {
    hint: (source) => shown.find((one) => one.from!.source === source)?.box ?? null,
    keep: removal.keepBoxes(lesson),
    scope: (media, seconds) => asks.scope(lesson, app.store.home, id, "watermarks", media, seconds),
  };
}

watermarkRemoval.hintsFor.project = hintsOf;
// A stretch the model cleans waits while their watermark there is still being taken out (it's cleaned over the result):
// its own file's cells there, and its own file still being looked at for a mark, never another file's (Nov 19, the
// Boyfriends intro: every stretch waited on the engine's look at each of the project's eleven files in turn).
watermarkRemoval.looked.then = async (app, id) => {
  const live = app.store.get(id);
  if (live === null) return;
  if (removal.kinds(asks.inForce(removal.lessonOf(live.project), app.store.home, id)).blur.length > 0) await textRemoval.ensure(app, id);
};
textInpaint.watermarks.pending = (id, media, from, to) =>
  watermarkRemoval.piecesOf(id).some((one) => one.media === media && (one.state === "queued" || one.state === "running") && one.from < to && one.to > from) || watermarkRemoval.lookingAtMedia(id, media);

/** Pieces out (queued or being done) and done, of both workers, for the line and the export's step. */
export function progressOf(id: string): { done: number; out: number } {
  const marks = watermarkRemoval.piecesOf(id);
  // A file still being looked at for its mark counts as out: its pieces aren't known yet.
  const blurs = textBlur.piecesOf(id);
  const cleans = textInpaint.piecesOf(id);
  // A file the finder is still reading counts as out too: its stretches aren't known yet (found.ts).
  const out = marks.filter((one) => one.state === "queued" || one.state === "running").length + watermarkRemoval.lookingAt(id) + textBlur.outOf(id) + textInpaint.outOf(id) + found.outOf(id);
  const done = marks.filter((one) => one.state === "done" || one.state === "none").length + blurs.filter((one) => one.state === "done").length + cleans.filter((one) => one.state === "done").length;
  return { done, out };
}

/** The export's step while pieces are out: "3 of 19 pieces" (null when none is). */
export function exportLine(id: string): string | null {
  const { done, out } = progressOf(id);
  return out === 0 ? null : `Removing their text · ${done} of ${done + out} pieces`;
}

/**
 * Said beside an export that goes without pieces RunPod refused a machine for (null: none): failed, they're not waited
 * for, and they're sent again REFUSED_RETRY_MS after the refusal (remover_cloud.ts), from the export row and the
 * agent's export result.
 */
export function exportNote(id: string): string | null {
  // Only footage still on the timeline (a piece of a clip cut out since stays in the list, never sent again).
  const project = removalApp.app?.store.get(id)?.project ?? null;
  const shown = project === null ? null : new Set(project.clips.flatMap((clip) => (clip.type === "video" ? [clip.media] : [])));
  const held = [...watermarkRemoval.piecesOf(id), ...textInpaint.piecesOf(id)].filter((one) => one.state === "failed" && one.refused !== undefined && (shown === null || shown.has(one.media)));
  if (held.length === 0) return null;
  const count = held.length;
  // The relay's own sentence ("RunPod wouldn't rent a GPU for 10 minutes"), not RunPod's answer after it: that stays in the log.
  const said = held[0]!.refused!.split(" (")[0]!;
  return `Going without ${count} piece${count === 1 ? "" : "s"} of their text and watermarks taken out, left as they are: RunPod won't rent the machines (${said}). They're tried again half an hour after that; once RunPod rents machines again (top up its account) and they're done, export again.`;
}

/**
 * Waits for `id`'s pieces still out before an export (broll's `waitForMaps`,
 * which every export goes through): caught up with the edit first, then
 * until none is out. Pieces RunPod refused a machine for aren't, until they're
 * sent again: the export goes on without them and says so (`exportNote`).
 */
export async function waitForPieces(app: App, id: string, limitMs = timing.exportWaitMs, signal?: AbortSignal): Promise<void> {
  await ensure(app, id).catch((error: unknown) => diag.warn("removal", `${id}: ${diag.messageOf(error)}`));
  const started = Date.now();
  while (progressOf(id).out > 0) {
    if (signal?.aborted === true) throw new Error("cancelled while waiting for their text to be taken out");
    // The quick look an export takes in its request: said "still rendering", it waits on in the background (routes.ts `whenReady`).
    if (limitMs <= 10_000 && Date.now() - started > limitMs) throw new Error("still rendering: their text is being taken out of the footage");
    if (Date.now() - started > Math.max(limitMs, timing.exportWaitMs)) throw new Error("Their text is still being taken out of the footage; export again once the chat says it's done.");
    await Bun.sleep(1000);
  }
  const without = exportNote(id);
  if (without !== null) diag.warn("removal", `${id}: ${without}`);
}

// ---------------------------------------------------------------------------
// The agent's look at each piece

/**
 * Pieces the agent has looked at (it says what isn't clean in the same call, or a later one), by project and the
 * strip each came back as: another project's piece of the same footage, or the same piece done again, is shown too.
 */
const looked = new Set<string>();

/**
 * Before and after of one strip (shares `box` of the footage, from its file's
 * second `at`): the footage's frame and the same frame with the strip laid,
 * cropped round the box, side by side.
 */
async function beforeAfter(app: App, footage: Media, strip: Media, at: number): Promise<Uint8Array> {
  const input = await cloudMedia.originalInput(app.store.cacheDir(), footage);
  const [x0, y0, x1, y1] = strip.cleans!.box;
  const [w, h] = [footage.width || 1920, footage.height || 1080];
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const [bx, by, bw, bh] = [even(x0 * w), even(y0 * h), even((x1 - x0) * w), even((y1 - y0) * h)];
  const into = Math.max(0, at - strip.cleans!.from);
  const filter = [
    `[0:v]scale=${w}:${h},split[o1][o2];`,
    `[1:v]split[s1][s2];[s1]crop=iw:ih/2:0:0[p];[s2]crop=iw:ih/2:0:ih/2,format=gray[a];[p][a]alphamerge,scale=${bw}:${bh}[pa];`,
    `[o2][pa]overlay=${bx}:${by}:alpha=premultiplied[c];`,
    `[o1]crop=${bw}:${bh}:${bx}:${by}[l];[c]crop=${bw}:${bh}:${bx}:${by}[r];[l][r]hstack,scale='min(1280,iw)':-2`,
  ].join("");
  return tools.run(
    [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", ...tools.urlArgs(input), "-ss", String(at), "-i", input, "-ss", String(into), "-i", strip.path, "-filter_complex", filter, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
    { background: true },
  );
}

/** `check_removal`: the pieces back from removal, each before and after; `reject` the ones that aren't clean. */
async function checkRemoval({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error(`no project ${projectId}`);
  const out: Content[] = [];
  const said: string[] = [];
  for (const one of Array.isArray(args.reject) ? (args.reject as { piece?: unknown; why?: unknown }[]) : []) {
    const key = typeof one.piece === "string" ? one.piece : "";
    const why = typeof one.why === "string" && one.why.trim() !== "" ? one.why.trim() : "the agent saw it isn't clean";
    if (key.startsWith("watermark:")) said.push(`${key}: ${await watermarkRemoval.reject(app, projectId, key, why)}`);
    else if (key.startsWith("clean:")) said.push(`${key}: ${await textInpaint.reject(app, projectId, key, why)}`);
    else if (key.startsWith("blur:")) said.push(`${key}: the tracked blur follows their words as read; if it misses some, mark that stretch again tighter`);
    else throw new Error(`no piece ${key}: the pieces are listed by check_removal`);
  }
  const project = app.store.get(projectId)!.project;
  const strips = project.media.filter((one) => one.cleans != null);
  const rows: string[] = [];
  let shown = 0;
  const pieces = [
    ...watermarkRemoval.piecesOf(projectId).map((one) => ({ key: `watermark:${one.media}@${Math.round(one.from * 1000)}`, media: one.media, name: one.name, from: one.from, to: one.to, state: one.state, why: one.error, what: "watermark" as const })),
    // The tracked blur's stretches: looked at with render_frame (nothing to compare), never rejected here.
    ...textBlur.piecesOf(projectId).map((one) => ({ key: one.key, media: one.media, name: one.name, from: one.from, to: one.to, state: one.state, why: one.why, what: "blur" as const })),
    // Their subtitles taken out by the model (the intro and first cases where this machine has it): a strip, before and after.
    ...textInpaint.piecesOf(projectId).map((one) => ({ key: one.key, media: one.media, name: one.name, from: one.from, to: one.to, state: one.state, why: one.why, what: "text" as const })),
  ];
  for (const piece of pieces) {
    rows.push(`${piece.key} · ${piece.name} ${Math.round(piece.from)}–${Math.round(piece.to)} s · ${piece.what} · ${piece.state}${piece.why ? ` (${piece.why})` : ""}`);
    if (shown >= 4) continue;
    const strip = strips.find((one) => one.cleans!.media === piece.media && one.cleans!.what === piece.what && Math.abs(one.cleans!.from - piece.from) < 0.01);
    const footage = project.media.find((one) => one.id === piece.media);
    if (strip === undefined || footage === undefined) continue;
    const seen = `${projectId}|${piece.key}|${strip.id}`;
    if (looked.has(seen)) continue;
    const at = Math.min(piece.to - 0.5, piece.from + (piece.to - piece.from) / 2);
    try {
      out.push(...image(await beforeAfter(app, footage, strip, at), `${piece.key} at ${Math.round(at)} s of ${piece.name}: before (left), after (right)`));
      looked.add(seen);
      shown += 1;
    } catch (error) {
      diag.warn("removal", `${projectId}: looking at ${piece.key}: ${diag.messageOf(error)}`);
    }
  }
  const head =
    pieces.length === 0
      ? "Nothing has come back from removal yet (it runs by itself as footage is cut; get_edit_context says when pieces are out)."
      : `${rows.join("\n")}\n\nLook at each after (right) against before (left): their text or mark gone, the camera's stamp the same, no ghost or smear. Reject a watermark piece that isn't clean (reject: [{piece, why}]): it's done once more, then left as it was and said; a blur that misses their words is marked again tighter (start_removal marks). Nothing to say when they're clean.`;
  return [...text([...said, head].filter(Boolean).join("\n\n")), ...out];
}

registerTool("check_removal", checkRemoval);

/** The source seconds of each footage file the timeline shows between `from` and `to` (timeline seconds). */
export const shownBetween = textRemoval.shownBetween;

/**
 * `start_removal`: what the person asked to have taken out, now (a part the
 * lesson says runs only when asked, or one not taught at all): the whole
 * project, some footage files, a case, the intro (removal_sections.ts), or a
 * stretch of the timeline. Kept (removal_asks.ts) and started at once; its
 * pieces are checked and counted as any others.
 */
async function startRemoval({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error(`no project ${projectId}`);
  const project = live.project;
  await removal.refresh();
  const lesson = removal.lessonOf(project);
  if (args.marks !== undefined || args.unmark !== undefined) return markRemoval(app, projectId, args);
  if (args.stop === true) return stopRemoval(app, projectId, args);
  const given = Array.isArray(args.kinds) ? (args.kinds as unknown[]) : [];
  if (given.some((kind) => !removal.KINDS.includes(kind as removal.Kind))) throw new Error('kinds are "subtitles", "watermarks" and "text"');
  // What the person didn't name: the parts taught to wait for an ask, else every part taught.
  const waiting = removal.KINDS.filter((kind) => lesson?.remove[kind] === true && lesson.when[kind] === "asked");
  const taught = removal.KINDS.filter((kind) => lesson?.remove[kind] === true);
  const kinds = given.length > 0 ? (given as removal.Kind[]) : waiting.length > 0 ? waiting : taught;
  if (kinds.length === 0) throw new Error('say what to take out: kinds ["subtitles", "watermarks", "text"] (nothing is taught for this channel)');
  const ids = Array.isArray(args.media) ? (args.media as unknown[]).filter((one): one is string => typeof one === "string") : [];
  for (const one of ids) {
    const media = project.media.find((m) => m.id === one);
    if (media === undefined || media.kind !== "video" || media.cleans != null || media.effect != null) throw new Error(`${one} isn't a footage file of this project`);
  }
  // A case or the intro: its stretch of the timeline, as removal_sections finds the edit's sections.
  const number = typeof args.case === "number" && Number.isInteger(args.case) && args.case >= 1 ? args.case : null;
  if (args.case !== undefined && args.case !== null && number === null) throw new Error("case is the case's number, from 1");
  let stretch: [number, number] | null = null;
  let said: string | undefined;
  if (number !== null || args.intro === true) {
    stretch = sections.stretchOf(project, number ?? "intro");
    const cases = sections.parts(project).filter((part) => part.case !== null).length;
    if (stretch === null) throw new Error(number === null ? "this edit has no intro it can tell (no script on the timeline): say from/to" : `this edit has no case ${number}: it has ${cases === 1 ? "one" : cases} (get_edit_context's removal lists them)`);
    said = number === null ? "the intro" : sections.isCompilation(project) ? `case ${number}` : "the case";
  }
  const from = stretch?.[0] ?? (typeof args.from === "number" ? args.from : null);
  const to = stretch?.[1] ?? (typeof args.to === "number" ? args.to : null);
  let scope: asks.Ask["media"];
  if (args.whole === true) scope = "all";
  else if (from !== null || to !== null) {
    // What's on the timeline there, a finished video of ours reused included: the person pointed at it.
    const between = shownBetween(project, from ?? 0, to ?? Number.MAX_SAFE_INTEGER / 1e6, true);
    scope = Object.fromEntries([...between].filter(([id]) => ids.length === 0 || ids.includes(id)));
  } else if (ids.length > 0) scope = Object.fromEntries(ids.map((id) => [id, "all" as const]));
  else throw new Error("say where: whole: true (the whole project, as it grows), case (its number), intro: true, media (footage files), or from/to (timeline seconds)");
  if (scope !== "all" && Object.keys(scope).length === 0) throw new Error("no footage is on the timeline there");
  const names = scope === "all" ? "the whole project" : (said ?? Object.keys(scope).map((id) => project.media.find((m) => m.id === id)?.name ?? id).join(", "));
  asks.add(app.store.home, projectId, { at: Date.now(), kinds, media: scope });
  await ensure(app, projectId);
  const words: Record<removal.Kind, string> = { subtitles: "their subtitles", watermarks: "their watermarks", text: "their labels and other text" };
  const { done, out } = progressOf(projectId);
  return text(
    `Taking ${kinds.map((kind) => words[kind]).join(", ")} out of ${names}, in the background, wherever the footage has them (their subtitles and text under a tight tracked blur, the camera's stamp kept)${out > 0 ? `: ${out} piece${out === 1 ? "" : "s"} out${done > 0 ? `, ${done} done` : ""}` : ""}. ` +
      "Look at pieces with check_removal as they come back (the blur's with render_frame); exports wait for them." +
      (kinds.includes("subtitles") ? " Lay ours with add_subtitles over theirs as usual." : ""),
  );
}

/**
 * start_removal `stop`: the parts the person wants stopped (their watermarks only, say), the rest going on; what's done
 * is kept. Asked again, a part runs on what that ask names.
 */
function stopRemoval(app: App, projectId: string, args: Record<string, unknown>): Content[] {
  const given = Array.isArray(args.kinds) ? (args.kinds as unknown[]) : [];
  if (given.some((kind) => !removal.KINDS.includes(kind as removal.Kind))) throw new Error('kinds are "subtitles", "watermarks" and "text"');
  const kinds = given.length > 0 ? (given as removal.Kind[]) : [...removal.KINDS];
  stop(app, projectId, kinds);
  const words: Record<removal.Kind, string> = { subtitles: "their subtitles", watermarks: "their watermarks", text: "their labels and other text" };
  const { out } = progressOf(projectId);
  return text(
    `Stopped taking ${kinds.map((kind) => words[kind]).join(", ")} out: nothing more is done there, what's done stays${out > 0 ? `; ${out} piece${out === 1 ? "" : "s"} of the rest still out` : ""}. ` +
      "It starts again only when someone asks (start_removal on what they point to).",
  );
}

/**
 * The agent's in and out points (start_removal `marks`, `unmark`), for a
 * channel taught to take their text out: timeline stretches where it saw
 * their text, kept as the source seconds of each footage file shown there
 * (so a re-cut keeps them), and only those get the tracked blur.
 */
async function markRemoval(app: App, projectId: string, args: Record<string, unknown>): Promise<Content[]> {
  const project = app.store.get(projectId)!.project;
  if (!textRemoval.marksOnly(project)) throw new Error("this channel isn't taught to take their text out: ask with start_removal on what the person points to (media, case, intro, from/to)");
  const lesson = removal.lessonOf(project);
  const kinds = removal.kinds(lesson).blur;
  const stretches = (value: unknown, name: string): [number, number][] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${name} is a list of {from, to} (timeline seconds)`);
    return value.map((one: { from?: unknown; to?: unknown }) => {
      const [from, to] = [Number(one?.from), Number(one?.to)];
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || from < 0) throw new Error(`${name}: each is {from, to} with to after from (timeline seconds), not ${JSON.stringify(one)}`);
      return [from, to];
    });
  };
  const said: string[] = [];
  if (args.marks === "proposed") {
    // Every stretch detection proposes, as it finds more: the agent looked and they're all theirs.
    asks.add(app.store.home, projectId, { at: Date.now(), kinds, media: "all", mark: "add" });
    said.push("Marked every stretch proposed");
  }
  for (const [name, mark] of [["unmark", "remove"], ["marks", "add"]] as const) {
    if (args[name] === "proposed") continue;
    const given = stretches(args[name], name);
    if (given.length === 0) continue;
    // Their watermark's box with a mark (shares of the frame as render_frame shows it): onto each file's own picture.
    const boxes = mark === "add" ? boxMarks(project, args[name] as { box?: unknown }[], given) : {};
    const media: Record<string, [number, number][]> = {};
    const bare: [number, number][] = [];
    for (const [from, to] of given) {
      // Every footage file shown there, under our own see-through subtitles or a finished video of ours reused: the agent saw their text on it.
      const shown = shownBetween(project, from, to, true);
      if (shown.size === 0) bare.push([from, to]);
      for (const [id, spans] of shown) media[id] = [...(media[id] ?? []), ...spans];
    }
    if (Object.keys(media).length === 0) throw new Error(`${name}: no footage is on the timeline at ${given.map(([a, b]) => `${a}–${b}`).join(", ")}`);
    asks.add(app.store.home, projectId, { at: Date.now(), kinds, media, mark, ...(Object.keys(boxes).length > 0 ? { boxes } : {}) });
    // Which files the stretches landed on, so a file that should be there and isn't is seen at once.
    const files = Object.entries(media)
      .map(([id, spans]) => ({ name: project.media.find((one) => one.id === id)?.name ?? id, id, seconds: spans.reduce((sum, [a, b]) => sum + b - a, 0) }))
      .sort((a, b) => b.seconds - a.seconds);
    const listed = files
      .slice(0, 8)
      .map((one) => `${one.id} ${one.seconds.toFixed(1)} s`)
      .join(", ");
    said.push(
      `${mark === "add" ? "Marked" : "Unmarked"} ${given.length} stretch${given.length === 1 ? "" : "es"} (${given.reduce((sum, [a, b]) => sum + b - a, 0).toFixed(1)} s) on ${files.length} file${files.length === 1 ? "" : "s"}: ${listed}${files.length > 8 ? `, and ${files.length - 8} more` : ""}` +
        (bare.length > 0 ? ` (no footage at ${bare.map(([a, b]) => `${a}–${b}`).join(", ")})` : ""),
    );
  }
  if (said.length === 0) throw new Error('marks: [{from, to}] (timeline seconds) where their text shows, or "proposed" for every stretch proposed; or unmark: [{from, to}]');
  await ensure(app, projectId);
  const { done, out } = progressOf(projectId);
  return text(
    `${said.join("; ")}. Only marked stretches get the tracked blur, tight to their words, in every section, in the background${out > 0 ? `: ${out} piece${out === 1 ? "" : "s"} out${done > 0 ? `, ${done} done` : ""}` : ""}. ` +
      "Look at them with render_frame as they're done; exports wait for them.",
  );
}

/**
 * Each mark's `box` (shares of the frame as render_frame shows it: their watermark, a logo or name laid over the
 * footage) as the source seconds and box of each file shown under it there, through its clip's framing (Nov 19, the
 * Boyfriends intro: ARRESTFLIX moves about 4PuH2FjxQJA, so no one place of the file is its).
 */
function boxMarks(project: Project, given: { box?: unknown }[], stretches: [number, number][]): Record<string, asks.BoxMark[]> {
  const out: Record<string, asks.BoxMark[]> = {};
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  stretches.forEach(([from, to], at) => {
    const box = given[at]?.box;
    if (box === undefined || box === null) return;
    if (!Array.isArray(box) || box.length !== 4 || box.some((value) => typeof value !== "number" || value < 0 || value > 1) || box[2] <= box[0] || box[3] <= box[1]) {
      throw new Error(`marks: box is [x0, y0, x1, y1], shares of the frame from its top left (0 to 1), not ${JSON.stringify(box)}`);
    }
    const shown = shownBetween(project, from, to, true);
    for (const clip of project.clips) {
      if (clip.type !== "video" || isOverlay(clip) || trackOf(project, clip.track)?.hidden === true || !(clip.speed > 0)) continue;
      const media = project.media.find((one) => one.id === clip.media);
      const spans = media === undefined ? undefined : shown.get(media.id);
      if (media === undefined || spans === undefined) continue;
      const [a, b] = [Math.max(clip.start, Math.round(from * fps)), Math.min(clipEnd(clip), Math.round(to * fps))];
      if (b <= a) continue;
      const at = (frame: number) => clip.source_in + ((frame - clip.start) / fps) * clip.speed;
      const mine = sections.intersect([[at(a), at(b)]], spans);
      if (mine.length === 0) continue;
      // The frame's box on the file's picture, by the clip's framing halfway through (a push-in moves it little).
      const { x, y, scale } = framingAt(clip as VideoClip, Math.round((a + b) / 2) - clip.start);
      const [mw, mh] = [media.width || width, media.height || height];
      const fit = Math.min(width / mw, height / mh) * scale;
      const share = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1e4) / 1e4;
      const onPicture: [number, number, number, number] = [
        share(((box[0] as number) * width - width / 2 - x) / (mw * fit) + 0.5),
        share(((box[1] as number) * height - height / 2 - y) / (mh * fit) + 0.5),
        share(((box[2] as number) * width - width / 2 - x) / (mw * fit) + 0.5),
        share(((box[3] as number) * height - height / 2 - y) / (mh * fit) + 0.5),
      ];
      if (onPicture[2] <= onPicture[0] || onPicture[3] <= onPicture[1]) continue;
      out[media.id] = [...(out[media.id] ?? []), ...mine.map(([s0, s1]): asks.BoxMark => [s0, s1, onPicture])];
    }
  });
  return out;
}

registerTool("start_removal", startRemoval);

// ---------------------------------------------------------------------------
// Watching edits

const resting = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The chat's waiting row (GET /api/projects/{id}/text-removal): pieces out
 * of both workers counted ("Removing their text · 3 of 19 pieces"), null
 * when none is.
 */
export interface Status {
  background: { label: string; done: number; total: number; started_at: number } | null;
}

export function statusOf(app: App, id: string): Status {
  if (app.store.get(id) === null) throw new ApiError(404, "no such project");
  return { background: backgroundOf(id) };
}

/** The parts named (`kinds`), every part when none are. */
function kindsOf(given: unknown): removal.Kind[] {
  if (given === undefined || given === null) return [...removal.KINDS];
  if (!Array.isArray(given) || given.length === 0 || given.some((kind) => !removal.KINDS.includes(kind as removal.Kind))) throw new ApiError(400, 'kinds are "subtitles", "watermarks" and "text"');
  return given as removal.Kind[];
}

export function routes(router: Router<App>): void {
  router.get("/api/projects/{id}/text-removal", ({ app, params }) => json(statusOf(app, params.id ?? "")));
  // The chat's waiting row: its Details (every piece, its seconds, how it came out and the check) and its Stop.
  router.get("/api/projects/{id}/removal", ({ app, params }) => {
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    return json({ pieces: pieceRows(id), background: backgroundOf(id), stopped: asks.isStopped(app.store.home, id) });
  });
  router.post("/api/projects/{id}/removal/stop", async ({ app, params, request }) => {
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    stop(app, id, kindsOf(((await request.json().catch(() => ({}))) as { kinds?: unknown }).kinds));
    return json(statusOf(app, id));
  });
}

// The chat's waiting row reads every line under way from one place (background.ts, Nov 21): removal's is this one,
// the same numbers and the same Stop as its own routes above.
background.provide("removal", { line: (_app, id) => backgroundOf(id), stop, underWay: (id) => progressOf(id).out > 0 || wakes.has(id) });

// ---------------------------------------------------------------------------
// A project's run in the background: the chat's waiting row, and the agent told when it's done

/** One piece of either worker, as the waiting row's Details lists it. */
export interface PieceRow {
  key: string;
  /** blur: the tracked blur; clean: their subtitles taken out by the model (text_inpaint.ts). */
  what: "watermark" | "blur" | "clean";
  media: string;
  name: string;
  from: number;
  to: number;
  /** queued, running, done, none (no mark there), failed (given up on). */
  state: string;
  why?: string;
}

export function pieceRows(id: string): PieceRow[] {
  return [
    ...watermarkRemoval.piecesOf(id).map((one): PieceRow => ({ key: `watermark:${one.media}@${Math.round(one.from * 1000)}`, what: "watermark", media: one.media, name: one.name, from: one.from, to: one.to, state: one.state, ...(one.error ? { why: one.error } : {}) })),
    ...textBlur.piecesOf(id).map((one): PieceRow => ({ key: one.key, what: "blur", media: one.media, name: one.name, from: one.from, to: one.to, state: one.state, ...(one.why ? { why: one.why } : {}) })),
    ...textInpaint.piecesOf(id).map((one): PieceRow => ({ key: one.key, what: "clean", media: one.media, name: one.name, from: one.from, to: one.to, state: one.state === "waiting" ? "queued" : one.state, ...(one.why ? { why: one.why } : {}) })),
  ];
}

interface Run {
  app: App;
  startedAt: number;
  /** Each piece's state when it started: what changed since is this run's. */
  before: Map<string, string>;
  /** When nothing was out since (a run ends only once it stays so: one worker hands over to the other). */
  quietSince: number | null;
}

const active = new Map<string, Run>();
let watcher: ReturnType<typeof setInterval> | null = null;

/** Notes a project's run when pieces are out and none was noted; watched until nothing is. */
function noteRun(app: App, id: string): void {
  if (active.has(id) || progressOf(id).out === 0) return;
  active.set(id, { app, startedAt: Date.now(), before: new Map(pieceRows(id).map((row) => [row.key, row.state])), quietSince: null });
  if (watcher === null) {
    watcher = setInterval(() => void tick(), timing.watchMs);
    watcher.unref?.();
  }
}

/** What's being taken out, in words: "their text and watermarks". */
function whatOf(rows: PieceRow[]): string {
  const text = rows.some((row) => row.what === "blur" || row.what === "clean");
  const marks = rows.some((row) => row.what === "watermark");
  return text && marks ? "their text and watermarks" : marks ? "their watermarks" : "their text";
}

/** The row's label: "Removing their text and watermarks" (it wraps in the chat, never cut). */
const labelOf = (rows: PieceRow[]) => `Removing ${whatOf(rows)}`;

/** The waiting row's numbers: what, how far, since when. */
export function backgroundOf(id: string): Status["background"] {
  const { done, out } = progressOf(id);
  if (out === 0) return null;
  const run = active.get(id);
  const rows = pieceRows(id);
  return { label: labelOf(rows.filter((row) => row.state === "queued" || row.state === "running" || run?.before.get(row.key) !== row.state)), done, total: done + out, started_at: run?.startedAt ?? Date.now() };
}

/**
 * The person's Stop: nothing more done (what's done is kept); kept across restarts until someone asks again. With
 * `kinds`, only those parts (start_removal `stop`): their watermarks stopped, say, while their captions go on.
 */
export function stop(app: App, id: string, kinds: readonly removal.Kind[] = removal.KINDS): void {
  const all = removal.KINDS.every((kind) => kinds.includes(kind));
  if (all) asks.setStopped(app.store.home, id, true);
  else asks.stopParts(app.store.home, id, [...kinds]);
  if (kinds.includes("watermarks")) watermarkRemoval.stop(id);
  if (kinds.includes("subtitles") || kinds.includes("text")) {
    textRemoval.stopped(id);
    textBlur.stop(id);
    textInpaint.stop(id);
    found.stop(id);
  }
  if (all) active.delete(id);
  diag.info("removal", `${id}: ${all ? "stopped" : `${kinds.join(" and ")} stopped`} by the person`);
  // What goes on is planned again (a text part stopped alone takes the other's queued pieces with it).
  if (!all) void ensure(app, id).catch((error: unknown) => diag.warn("removal", `${id}: after a part's Stop: ${diag.messageOf(error)}`));
}

async function tick(): Promise<void> {
  for (const [id, run] of active) {
    const app = run.app;
    if (progressOf(id).out > 0) {
      run.quietSince = null;
      continue;
    }
    run.quietSince ??= Date.now();
    if (Date.now() - run.quietSince < timing.watchMs) continue;
    active.delete(id);
    // A run the person stopped was let go then (`stop`): one after an ask is told as any.
    finished(app, id, run);
  }
  if (active.size === 0 && watcher !== null) {
    clearInterval(watcher);
    watcher = null;
  }
}

const seconds = (row: PieceRow) => `${Math.round(row.from)}–${Math.round(row.to)} s`;

/** What a run did, by file: "tape A (0–30 s, 30–60 s)". */
function byFile(rows: PieceRow[], withWhy = false): string {
  const files = new Map<string, PieceRow[]>();
  for (const row of rows) files.set(row.name, [...(files.get(row.name) ?? []), row]);
  return [...files].map(([name, mine]) => `- ${name}: ${mine.map((row) => `${row.what === "watermark" ? "watermark" : "text"} ${seconds(row)}${withWhy && row.why ? ` (${row.why})` : ""}`).join(", ")}`).join("\n");
}

/** The agent's turn when a run is done: what was cleaned and what wasn't, and what to do now. */
export function wakeText(rows: PieceRow[]): string {
  const cleaned = rows.filter((row) => row.state === "done");
  const left = rows.filter((row) => row.state === "failed");
  // Its first line is what the chat shows as Edit's event: "Their text and watermarks are out of the footage (24 pieces, 1 with the mark left)".
  const what = whatOf(rows);
  const unblurred = left.filter((row) => row.what === "blur").length;
  // A stretch the model couldn't clean keeps its tracked blur.
  const blurredInstead = left.filter((row) => row.what === "clean").length;
  const kept = left.length - unblurred - blurredInstead;
  const said = [`${cleaned.length} piece${cleaned.length === 1 ? "" : "s"}`, ...(unblurred > 0 ? [`${unblurred} not blurred`] : []), ...(blurredInstead > 0 ? [`${blurredInstead} blurred instead`] : []), ...(kept > 0 ? [`${kept} with the mark left`] : [])].join(", ");
  return (
    `${EDIT_EVENT} ${what[0]!.toUpperCase()}${what.slice(1)} ${what === "their text" ? "is" : "are"} out of the footage (${said}).\n\n` +
    (cleaned.length > 0 ? `Cleaned:\n${byFile(cleaned.slice(0, 60))}\n\n` : "") +
    (left.length > 0 ? `Not clean, and why:\n${byFile(left.slice(0, 30), true)}\n\n` : "") +
    "Now lay OUR subtitles, and the intro's titles and captions, wherever they're missing over the cleaned footage (add_subtitles with missing_only; the intro's as its lesson says), and look at your work (check_removal for any piece you haven't seen; render_frame on a blurred stretch, with ours over it). " +
    "Only then tell the person in one plain message: what was cleaned, what was left and why, and that our subtitles are on. If there's nothing to add, just say what was cleaned."
  );
}

/** A run done: the agent is woken with what it did, once any turn under way ends (Edit's own event, not the person's message). */
function finished(app: App, id: string, run: Run): void {
  const rows = pieceRows(id).filter((row) => run.before.get(row.key) !== row.state && row.state !== "none" && row.state !== "queued");
  if (!rows.some((row) => row.state === "done" || row.state === "failed")) return;
  diag.info("removal", `${id}: done in ${Math.round((Date.now() - run.startedAt) / 1000)} s; the agent is told`);
  // One wake-up a project: a run done while an earlier one's still waits for a turn to end joins it (one turn, not two).
  const waiting = wakes.get(id);
  if (waiting !== undefined) {
    for (const row of rows) waiting.set(row.key, row);
    return;
  }
  wakes.set(id, new Map(rows.map((row) => [row.key, row])));
  void wake(app, id);
}

/** Pieces each project's waiting wake-up will tell of. */
const wakes = new Map<string, Map<string, PieceRow>>();

/** Starts the agent's turn on what's done once no turn is under way (a person's message meanwhile goes first; this waits behind it). */
async function wake(app: App, id: string): Promise<void> {
  const until = Date.now() + 12 * 3_600_000;
  const mine = wakeGeneration;
  let failures = 0;
  while (Date.now() < until && mine === wakeGeneration) {
    const panel = seams.agentPanel(app);
    const running = (panel.turn?.(id) ?? (panel.chat(id) as { running?: boolean })).running === true;
    if (!running) {
      // Taken as it goes: a run done after this joins a wake-up of its own.
      const rows = wakes.get(id) ?? new Map<string, PieceRow>();
      wakes.delete(id);
      try {
        await app.store.mayWrite(id);
        await panel.send(id, wakeText([...rows.values()]), null, null);
        return;
      } catch (error) {
        // Said once; tried again less and less often (Claude not set up here can be a long while).
        if (failures === 0) diag.warn("removal", `${id}: telling the agent removal is done: ${diag.messageOf(error)}; trying again`);
        failures += 1;
        // Not sent: what it would have told goes with the next try (and whatever joined meanwhile).
        const joined = wakes.get(id);
        if (joined !== undefined) {
          for (const [key, row] of rows) if (!joined.has(key)) joined.set(key, row);
          return;
        }
        wakes.set(id, rows);
      }
    }
    await Bun.sleep(timing.wakeEveryMs * Math.min(20, 1 + failures * 4));
  }
  if (mine === wakeGeneration) wakes.delete(id);
}

/** Bumped by `reset`: wake-ups waiting from before give up. */
let wakeGeneration = 0;

/** Each project's removal to plan again once the pieces RunPod refused may be sent again (`start`). */
const retries = new Map<string, ReturnType<typeof setTimeout>>();

/** The app removal was started with (`start`): what an export's note reads the timeline from. */
const removalApp: { app: App | null } = { app: null };

/** Every project of a channel taught to take theirs out is brought up to date as soon as its edits rest, and again when the server starts (`resume`), here (not a save pulled from another Mac); every export waits for its pieces still out. */
export function start(app: App): void {
  removalApp.app = app;
  // A piece RunPod refused is held back REFUSED_RETRY_MS: its project's removal is planned again then (respecting a
  // Stop), so a topped-up account gets it done without an edit or an export to set it going.
  removerCloud.heldBack.push((id) => {
    if (retries.has(id)) return;
    const timer = setTimeout(() => {
      retries.delete(id);
      void ensure(app, id).catch((error: unknown) => diag.warn("removal", `${id}: after RunPod's refusal: ${diag.messageOf(error)}`));
    }, removerCloud.REFUSED_RETRY_MS + 1000);
    timer.unref?.();
    retries.set(id, timer);
  });
  burned.theirs.takenOut = (project, one) => textRemoval.theirsTakenOut(app, project, one);
  readyWaits.push((ready, id, limitMs, signal) => waitForPieces(ready, id, limitMs, signal));
  readyNotes.push(exportNote);
  const later = setTimeout(() => void resume(app).catch((error: unknown) => diag.warn("removal", `resuming: ${diag.messageOf(error)}`)), timing.resumeMs);
  later.unref?.();
  app.store.subscribe((event) => {
    if (event.type !== "project" || typeof event.id !== "string" || event.origin === "cloud") return;
    const id = event.id;
    clearTimeout(resting.get(id));
    const later = setTimeout(() => {
      resting.delete(id);
      ensure(app, id).catch((error: unknown) => diag.warn("removal", `${id}: ${diag.messageOf(error)}`));
    }, timing.restMs);
    later.unref?.();
    resting.set(id, later);
  });
}

/** For tests. */
export function reset(): void {
  for (const timer of retries.values()) clearTimeout(timer);
  retries.clear();
  looked.clear();
  active.clear();
  wakes.clear();
  wakeGeneration += 1;
  if (watcher !== null) clearInterval(watcher);
  watcher = null;
}
