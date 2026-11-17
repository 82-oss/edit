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
//   - two workers: their watermarks taken out here by the engine
//     (watermark_removal.ts, free; every footage file looked at once for a
//     mark of its own, kept by source; nothing done where there's none),
//     their subtitles and text by Vmake (text_removal.ts, the team's
//     plan on its website by default; the API only after the person's yes to
//     its price);
//   - every piece checked: automatically as it comes back (Vmake's: their
//     words read again; the engine's: how much of the mark is left), then by
//     the agent (`check_removal`: before and after, it rejects what isn't
//     clean); a piece that isn't is done once more, then given up on and
//     blurred (a watermark left as it was), and said;
//   - an export waits for pieces still out ("Removing their text · 3 of 19
//     pieces" among its steps): footage of a channel taught to take theirs out
//     never goes out uncleaned while a piece is coming.

import type { App } from "./app.ts";
import { readyWaits } from "./broll.ts";
import { ApiError, json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { image, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import type { Clip, Media, Project } from "./model.ts";
import { clipEnd, fps as fpsOf } from "./project.ts";
import * as asks from "./removal_asks.ts";
import * as removal from "./removal_lesson.ts";
import * as textRemoval from "./text_removal.ts";
import * as tools from "./tools.ts";
import * as v2cloud from "./v2_cloud.ts";
import * as watermarkRemoval from "./watermark_removal.ts";

/** How long an export waits for pieces still out (Vmake's site takes minutes a piece, three at once); how soon after the server starts its work resumes. */
export const timing = { exportWaitMs: 3 * 3_600_000, restMs: 2000, resumeMs: 15_000 };

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
  await v2cloud.refreshSkills().catch(() => {});
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
  await v2cloud.refreshSkills();
  // The parts that run by themselves, and those asked for here (a part taught to wait for an ask does nothing until then).
  const lesson = asks.inForce(removal.lessonOf(live.project), app.store.home, id);
  if (lesson?.remove.watermarks === true) await watermarkRemoval.ensure(app, id);
  if (removal.kinds(lesson).vmake.length > 0) await textRemoval.ensure(app, id);
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
textRemoval.schedule.ensure = (app, id) => ensure(app, id);

/** Pieces out (queued or being done) and done, of both workers, for the line and the export's step. */
export function progressOf(id: string): { done: number; out: number } {
  const text = textRemoval.piecesOf(id);
  const marks = watermarkRemoval.piecesOf(id);
  // A file still being looked at for its mark counts as out: its pieces aren't known yet.
  const out = text.filter((one) => one.state === "queued" || one.state === "running").length + marks.filter((one) => one.state === "queued" || one.state === "running").length + watermarkRemoval.lookingAt(id);
  const done = text.filter((one) => one.state === "check" || one.state === "done").length + marks.filter((one) => one.state === "done" || one.state === "none").length;
  return { done, out };
}

/** The export's step while pieces are out: "3 of 19 pieces" (null when none is). */
export function exportLine(id: string): string | null {
  const { done, out } = progressOf(id);
  return out === 0 ? null : `Removing their text · ${done} of ${done + out} pieces`;
}

/**
 * Waits for `id`'s pieces still out before an export (broll's `waitForMaps`,
 * which every export goes through): caught up with the edit first, then
 * until none is out. Vmake not set up, or its account refused, has nothing
 * coming: the export goes with their blur. The API's paid route without the
 * person's yes is refused in words.
 */
export async function waitForPieces(app: App, id: string, limitMs = timing.exportWaitMs): Promise<void> {
  await ensure(app, id).catch((error: unknown) => diag.warn("removal", `${id}: ${diag.messageOf(error)}`));
  const said = await textRemoval.status(app, id).catch(() => null);
  if (said?.action === "remove") throw new Error("Their text isn't out of the footage yet: say yes to the price at the top of the editor first.");
  const started = Date.now();
  while (progressOf(id).out > 0) {
    // The quick look an export takes in its request: said "still rendering", it waits on in the background (routes.ts `whenReady`).
    if (limitMs <= 10_000 && Date.now() - started > limitMs) throw new Error("still rendering: their text is being taken out of the footage");
    if (Date.now() - started > Math.max(limitMs, timing.exportWaitMs)) throw new Error("Their text is still being taken out of the footage; export again once the line at the top says it's done.");
    await Bun.sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// The agent's look at each piece

/** Pieces the agent has looked at (it says what isn't clean in the same call, or a later one). */
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
    if (key.startsWith("text:")) said.push(`${key}: ${await textRemoval.reject(app, projectId, key, why)}`);
    else if (key.startsWith("watermark:")) said.push(`${key}: ${await watermarkRemoval.reject(app, projectId, key, why)}`);
    else throw new Error(`no piece ${key}: the pieces are listed by check_removal`);
  }
  const project = app.store.get(projectId)!.project;
  const strips = project.media.filter((one) => one.cleans != null);
  const rows: string[] = [];
  let shown = 0;
  const pieces = [
    ...textRemoval.piecesOf(projectId).map((one) => ({ key: one.key, media: one.media, name: one.name, from: one.from, to: one.to, state: one.state, why: one.why, what: "text" as const })),
    ...watermarkRemoval.piecesOf(projectId).map((one) => ({ key: `watermark:${one.media}@${Math.round(one.from * 1000)}`, media: one.media, name: one.name, from: one.from, to: one.to, state: one.state, why: one.error, what: "watermark" as const })),
  ];
  for (const piece of pieces) {
    rows.push(`${piece.key} · ${piece.name} ${Math.round(piece.from)}–${Math.round(piece.to)} s · ${piece.what} · ${piece.state}${piece.why ? ` (${piece.why})` : ""}`);
    if (looked.has(piece.key) || shown >= 4) continue;
    const strip = strips.find((one) => one.cleans!.media === piece.media && (one.cleans!.what ?? "text") === piece.what && Math.abs(one.cleans!.from - piece.from) < 0.01);
    const footage = project.media.find((one) => one.id === piece.media);
    if (strip === undefined || footage === undefined) continue;
    const at = Math.min(piece.to - 0.5, piece.from + (piece.to - piece.from) / 2);
    try {
      out.push(...image(await beforeAfter(app, footage, strip, at), `${piece.key} at ${Math.round(at)} s of ${piece.name}: before (left), after (right)`));
      looked.add(piece.key);
      shown += 1;
    } catch (error) {
      diag.warn("removal", `${projectId}: looking at ${piece.key}: ${diag.messageOf(error)}`);
    }
  }
  const head =
    pieces.length === 0
      ? "Nothing has come back from removal yet (it runs by itself as footage is cut; get_edit_context says when pieces are out)."
      : `${rows.join("\n")}\n\nLook at each after (right) against before (left): their text or mark gone, the camera's stamp the same, no ghost or smear. Reject any that isn't clean (reject: [{piece, why}]): it's done once more, then blurred and said. Nothing to say when they're clean.`;
  return [...text([...said, head].filter(Boolean).join("\n\n")), ...out];
}

registerTool("check_removal", checkRemoval);

/** The source seconds of each footage file the timeline shows between `from` and `to` (timeline seconds). */
export function shownBetween(project: Project, from: number, to: number): Map<string, [number, number][]> {
  const fps = fpsOf(project);
  const [a, b] = [Math.round(from * fps), Math.round(to * fps)];
  const trimmed = structuredClone(project);
  trimmed.clips = trimmed.clips.flatMap((clip): Clip[] => {
    if (clip.type !== "video") return [clip];
    const start = Math.max(clip.start, a);
    const end = Math.min(clipEnd(clip), b);
    if (end <= start) return [];
    return [{ ...clip, start, duration: end - start, source_in: clip.source_in + ((start - clip.start) / fps) * clip.speed }];
  });
  return textRemoval.shownSeconds(trimmed);
}

/**
 * `start_removal`: what the person asked to have taken out, now (a part the
 * lesson says runs only when asked, or one not taught at all): the whole
 * project, some footage files, or a stretch of the timeline. Kept
 * (removal_asks.ts) and started at once; its pieces come back, are checked
 * and counted as any others.
 */
async function startRemoval({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error(`no project ${projectId}`);
  const project = live.project;
  await v2cloud.refreshSkills();
  const lesson = removal.lessonOf(project);
  const given = Array.isArray(args.kinds) ? (args.kinds as unknown[]) : [];
  if (given.some((kind) => !removal.KINDS.includes(kind as removal.Kind))) throw new Error('kinds are "subtitles", "watermarks" and "text"');
  // What the person didn't name: the parts taught to wait for an ask, else every part taught.
  const waiting = removal.KINDS.filter((kind) => lesson?.remove[kind] === true && lesson.when[kind] === "asked");
  const kinds = given.length > 0 ? (given as removal.Kind[]) : waiting.length > 0 ? waiting : removal.KINDS.filter((kind) => lesson?.remove[kind] === true);
  if (kinds.length === 0) throw new Error('say what to take out: kinds ["subtitles", "watermarks", "text"] (nothing is taught for this channel)');
  const ids = Array.isArray(args.media) ? (args.media as unknown[]).filter((one): one is string => typeof one === "string") : [];
  for (const one of ids) {
    const media = project.media.find((m) => m.id === one);
    if (media === undefined || media.kind !== "video" || media.cleans != null || media.effect != null) throw new Error(`${one} isn't a footage file of this project`);
  }
  const from = typeof args.from === "number" ? args.from : null;
  const to = typeof args.to === "number" ? args.to : null;
  let scope: asks.Ask["media"];
  if (args.whole === true) scope = "all";
  else if (from !== null || to !== null) {
    const between = shownBetween(project, from ?? 0, to ?? Number.MAX_SAFE_INTEGER / 1e6);
    scope = Object.fromEntries([...between].filter(([id]) => ids.length === 0 || ids.includes(id)));
  } else if (ids.length > 0) scope = Object.fromEntries(ids.map((id) => [id, "all" as const]));
  else throw new Error("say where: whole: true (the whole project, as it grows), media (footage files), or from/to (timeline seconds)");
  if (scope !== "all" && Object.keys(scope).length === 0) throw new Error("no footage is on the timeline there");
  asks.add(app.store.home, projectId, { at: Date.now(), kinds, media: scope });
  await ensure(app, projectId);
  const names = scope === "all" ? "the whole project" : Object.keys(scope).map((id) => project.media.find((m) => m.id === id)?.name ?? id).join(", ");
  const words: Record<removal.Kind, string> = { subtitles: "their subtitles", watermarks: "their watermarks", text: "their labels and other text" };
  const { done, out } = progressOf(projectId);
  return text(
    `Taking ${kinds.map((kind) => words[kind]).join(", ")} out of ${names}, in the background, wherever the footage has them (the camera's stamp kept)${out > 0 ? `: ${out} piece${out === 1 ? "" : "s"} out${done > 0 ? `, ${done} done` : ""}` : ""}. ` +
      "Look at pieces with check_removal as they come back; exports wait for them." +
      (kinds.includes("subtitles") ? " Their subtitles are blurred until theirs are out: lay ours with add_subtitles over them as usual." : ""),
  );
}

registerTool("start_removal", startRemoval);

// ---------------------------------------------------------------------------
// Watching edits

const resting = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The editor's line (GET /api/projects/{id}/text-removal): pieces out of
 * both workers quietly counted ("Removing their text · 3 of 19 pieces"), else
 * Vmake's own (its account's trouble, the API's price to say yes to, pieces
 * given up on).
 */
export async function statusOf(app: App, id: string): Promise<textRemoval.Status> {
  if (app.store.get(id) === null) throw new ApiError(404, "no such project");
  const { done, out } = progressOf(id);
  if (out > 0) return { line: `Removing their text · ${done} of ${done + out} pieces`, action: null, running: { done, total: done + out } };
  return textRemoval.status(app, id);
}

export function routes(router: Router<App>): void {
  router.get("/api/projects/{id}/text-removal", ({ app, params }) => statusOf(app, params.id ?? "").then((answer) => json(answer)));
}

/** Every project of a channel taught to take theirs out is brought up to date as soon as its edits rest, and again when the server starts (`resume`), here (not a save pulled from another Mac); every export waits for its pieces still out. */
export function start(app: App): void {
  readyWaits.push((ready, id, limitMs) => waitForPieces(ready, id, limitMs));
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
  looked.clear();
}
