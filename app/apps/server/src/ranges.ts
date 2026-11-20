// Stretches of the edit marked to export (Sphe, Nov 12: "I want to be able to
// tell the agents, go to all of the cut-ins and then set all the in and out
// points for me. Once those are set up, I can then click to export"). The
// agent marks them (`set_ranges`: by time, or every cut-in at once); the
// Export dialog makes a video of each, or one of them joined (the person picks,
// each time). Each is the house export of its stretch, one after another
// through the export line; joined, their files are put end to end without
// encoding again (they're made with the same settings).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as channels from "./channels.ts";
import * as diag from "./diag.ts";
import * as jobs from "./jobs.ts";
import { exportsDir } from "./export_folder.ts";
import { chunkFolder, listExports, listMade, unlist } from "./exports.ts";
import { writeAtomic } from "./files.ts";
import { bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { ExportOptions, Project, Range } from "./model.ts";
import { native } from "./native/index.ts";
import { isFile, join } from "./paths.ts";
import { clipEnd, duration as durationOf, fps as fpsOf } from "./project.ts";
import { fixed, isAlphanumeric, jsonForSerde } from "./rust.ts";
import * as seams from "./seams.ts";
import * as tools from "./tools.ts";

/** Frames of `ranges` made valid: in order, inside the edit, none empty, none overlapping (a later one starts where the one before ends). */
export function tidy(ranges: Range[], length: number): Range[] {
  const sorted = ranges
    .map((one) => ({ start: Math.max(0, Math.round(one.start)), end: Math.min(length, Math.round(one.end)), name: one.name.trim() }))
    .filter((one) => one.end > one.start)
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const one of sorted) {
    const before = out.at(-1);
    const start = before === undefined ? one.start : Math.max(one.start, before.end);
    if (one.end > start) out.push({ ...one, start });
  }
  return out;
}

/** What the in and out points are called as a marked stretch. */
export const IN_OUT = "In–out";

/**
 * Everything marked to export: the stretches, and the in and out points as
 * one more (Sphe, Nov 13: "I thought the in and out points are the export
 * ranges"; he set them on the first call, and Export would have made the five
 * stretches marked before and not it). One idea, marked by hand (I / O,
 * set_in_out) or by the agent (set_ranges), made valid (`tidy`).
 */
export function marked(project: Project): Range[] {
  const length = durationOf(project);
  const all = [...(project.ranges ?? [])];
  if (project.mark_in != null || project.mark_out != null) all.push({ start: project.mark_in ?? 0, end: project.mark_out == null ? length : project.mark_out + 1, name: IN_OUT });
  return tidy(all, length);
}

/**
 * The cut-ins, each named as its clips are ("Cut-in 36"): from the first of
 * its clips to the end of the last. An edit with no clip so named has its
 * B-roll sections instead (an Edit V2 edit's sections are slivers between
 * its voice clips, Nov 12: 16 found where it has 30).
 */
export function cutIns(project: Project): Range[] {
  const named = new Map<string, Range>();
  for (const clip of project.clips) {
    const name = /^(Cut-in \d+)/u.exec(clip.name ?? "")?.[1];
    if (name === undefined) continue;
    const before = named.get(name);
    named.set(name, { name, start: Math.min(before?.start ?? clip.start, clip.start), end: Math.max(before?.end ?? 0, clipEnd(clip)) });
  }
  if (named.size > 0) return [...named.values()].sort((a, b) => a.start - b.start);
  let parts: { kind: string; start: number; end: number }[] = [];
  try {
    parts = native().sections({ json: jsonForSerde(project) }).parts;
  } catch {
    return [];
  }
  // A sliver under a second isn't a cut-in to export.
  const fps = fpsOf(project);
  return parts.filter((part) => part.kind === "broll" && part.end - part.start >= fps).map((span, index) => ({ start: span.start, end: span.end, name: `Cut-in ${index + 1}` }));
}

registerTool("set_ranges", async ({ app, args, projectId }) => {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const fps = fpsOf(live.project);
  const length = durationOf(live.project);
  let wanted: Range[];
  if (args.cut_ins === true) {
    wanted = cutIns(live.project);
    if (wanted.length === 0) throw new Error("this edit has no cut-ins to mark (its script's B-roll sections)");
  } else if (Array.isArray(args.ranges)) {
    wanted = (args.ranges as unknown[]).map((given, index) => {
      const one = (given ?? {}) as Record<string, unknown>;
      if (typeof one.start !== "number" || typeof one.end !== "number") throw new Error(`ranges[${index}]: start and end are seconds on the timeline`);
      return { start: one.start * fps, end: one.end * fps, name: typeof one.name === "string" && one.name.trim() !== "" ? one.name : `Part ${index + 1}` };
    });
  } else {
    throw new Error("give ranges (a list of {start, end, name}, seconds; [] clears them) or cut_ins: true");
  }
  const ranges = tidy(wanted, length);
  await app.store.update(projectId, "agent", (project) => {
    if (ranges.length === 0) delete project.ranges;
    else project.ranges = ranges;
    // They're one of the marked stretches: replaced with the rest.
    delete project.mark_in;
    delete project.mark_out;
  });
  if (ranges.length === 0) return text("marked stretches cleared");
  const listed = ranges.map((one) => `${one.name} ${fixed(one.start / fps, 2)}–${fixed(one.end / fps, 2)}s`).join("; ");
  return text(`${ranges.length} stretch${ranges.length === 1 ? "" : "es"} marked to export (on the progress bar; the person exports each, or them joined, from Export): ${listed}`);
});

// ---------------------------------------------------------------- exporting them

export type Mode = "each" | "joined";

export interface Batch {
  mode: Mode;
  total: number;
  done: number;
  /** The stretch being exported now. */
  current: string | null;
  /** The files made (each), or the one file (joined) once it's whole. */
  outputs: string[];
  error: string | null;
  cancelled: boolean;
  finished: boolean;
  /** When it ended (one kept before this was noted reads its file's time). */
  finished_ms: number | null;
}

const batches = new Map<string, Batch>();

/** Where a project's last batch is kept, so a restart doesn't take its Download away (Sphe, Nov 12: on another computer, the file can't be fetched any other way). */
const keptAt = (app: App, id: string) => join(app.store.cacheDir(), "range-exports", `${safe(id)}.json`);

/** The project's batch: the one running or last run, else the one kept from before a restart. */
export function batchOf(app: App, id: string): Batch | null {
  const known = batches.get(id);
  if (known !== undefined) return known;
  // Written down and not carried on yet (just after a restart, or waiting to go again).
  const listed = jobs.get(app.store.home, rowOf(id));
  if (listed !== undefined && jobs.live(listed) && isBatch(listed)) return fromRow(listed);
  try {
    const kept = JSON.parse(fs.readFileSync(keptAt(app, id), "utf8")) as Batch;
    return kept.finished ? { ...kept, finished_ms: kept.finished_ms ?? fs.statSync(keptAt(app, id)).mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * The batch as the Export dialog shows it: one running, or one finished that
 * is still the last thing to happen to the project's exports. Kept for good,
 * yesterday's "Saved to … 36 marked.mp4" stood in for today's share.
 */
export function latestBatch(app: App, id: string): Batch | null {
  const batch = batchOf(app, id);
  if (batch === null || !batch.finished) return batch;
  const at = batch.finished_ms ?? 0;
  if ((app.exports.runningFor?.(id) ?? null) !== null) return null;
  if ((app.exports.activity?.() ?? []).some((one) => one.id === id && one.updated_ms > at)) return null;
  return listExports(app.store.home, id).some((one) => one.finished_ms > at) ? null : batch;
}

/** Seams for tests: what's held in memory goes, as after a restart. */
export const forgetBatches = () => batches.clear();

/** Seams for tests. */
export const timing = { poll: 500, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

const safe = (name: string) => {
  const kept = [...name].map((char) => (isAlphanumeric(char) || " -_".includes(char) ? char : "_")).join("").trim();
  return kept === "" ? "Edit" : kept;
};

/** A file's time, or null when it isn't there. */
const timeOf = (path: string): bigint | null => {
  try {
    return fs.statSync(path, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
};

/** Waits for `id`'s export to end; whether it wrote `output` anew (`before`: its time then): the engine renames over it only on success, so a failure leaves the last run's file. */
async function finished(app: App, id: string, output: string, before: bigint | null): Promise<boolean> {
  while ((app.exports.runningFor?.(id) ?? null) !== null) await timing.sleep(timing.poll);
  const now = timeOf(output);
  return now !== null && now !== before;
}

/** A file's first sound: its codec, rate and channel layout; null when it has none (a stretch where nothing is heard is exported picture alone). */
async function soundOf(path: string): Promise<{ codec: string; rate: string; layout: string } | null> {
  const said = JSON.parse(new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channel_layout,channels", "-of", "json", path], { timeoutMs: 60_000 }))) as {
    streams?: { codec_name?: string; sample_rate?: string; channel_layout?: string; channels?: number }[];
  };
  const stream = said.streams?.[0];
  if (stream?.codec_name === undefined) return null;
  return { codec: stream.codec_name, rate: stream.sample_rate ?? "48000", layout: stream.channel_layout ?? (stream.channels === 1 ? "mono" : "stereo") };
}

/**
 * `parts` ready to join: a silent one gets a silent track like the others'
 * when some have sound (the join takes its streams from the first file, so a
 * silent first stretch left the whole video without sound).
 */
async function withSound(parts: string[]): Promise<string[]> {
  const sounds = await Promise.all(parts.map(soundOf));
  const like = sounds.find((one) => one !== null);
  if (like === undefined) return parts;
  return Promise.all(
    parts.map(async (part, index) => {
      if (sounds[index] !== null) return part;
      const out = part.replace(/(\.[^./]+)$/u, ".sound$1");
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-i", part, "-f", "lavfi", "-i", `anullsrc=r=${like.rate}:cl=${like.layout}`, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", like.codec, "-shortest", out], { timeoutMs: 10 * 60_000 });
      return out;
    }),
  );
}

// A batch's state is its row in jobs.json (`export:<id>:ranges`), written as each stretch ends (Nov 21: it lived in
// memory and was kept on disk only once it finished, so an update or a crash mid-batch lost it and every stretch it
// had made with nothing said). After a restart serve.ts's export resumer carries it on (`carryOn`, through routes.ts
// `carryOnAsked`): the stretches made are kept, and only those left are made.

/** What a batch's row holds: how it was asked for, the stretches it makes, and what's made so far. */
interface Kept {
  batch: true;
  mode: Mode;
  options: ExportOptions;
  watermark: string | null;
  /** The stretches it makes, fixed once its graphics are in; null before (it waits for them again). */
  ranges: Range[] | null;
  /** Each stretch made, in order: its file (each), or its part (joined). */
  made: string[];
  /** Every part asked for (joined): its export lists it, and it comes off the list however the batch ends. */
  asked: string[];
  /** Where the project's chunk manifest as it was before is kept until the batch ends; null when there was none. */
  manifest: string | null;
  began: number;
}

/** The row's key: one batch a project. */
const rowOf = (id: string) => jobs.keyOf("export", id, "ranges");

/** Whether `job` is a batch of marked stretches (its row: carried on by `carryOn`, never as a lone export). */
export function isBatch(job: jobs.Job): boolean {
  return job.kind === "export" && job.args.batch === true;
}

/** The batch a live row holds, as the dialog shows it (one not carried on yet after a restart). */
function fromRow(job: jobs.Job): Batch {
  const kept = job.args as unknown as Kept;
  const total = kept.ranges?.length ?? 0;
  const made = Array.isArray(kept.made) ? kept.made : [];
  return { mode: kept.mode, total, done: made.length, current: job.step ?? null, outputs: kept.mode === "each" ? [...made] : [], error: null, cancelled: false, finished: false, finished_ms: null };
}

/** Exports `project`'s marked stretches with `options` (the house's), each its own file or one of them joined, in the background. */
export function exportRanges(app: App, given: Project, options: ExportOptions, mode: Mode, watermark: string | null): Batch {
  const running = batches.get(given.id);
  if (running !== undefined && !running.finished) throw new Error("its marked parts are already being exported");
  const listed = jobs.get(app.store.home, rowOf(given.id));
  if (listed !== undefined && jobs.live(listed)) throw new Error("its marked parts are already being exported");
  // What's left of them in the edit as it is now: one past an end shortened since it was marked was refused, and stopped the batch.
  const ranges = marked(given);
  if (ranges.length === 0) throw new Error("no parts are marked: set in and out points (I / O), or ask the agent to mark them");
  if ((app.exports.runningFor?.(given.id) ?? null) !== null) throw new Error("an export of this edit is running: wait for it, or cancel it");
  // The project's chunk manifest, put back after: each stretch's export writes its own, and the next export of the
  // edit then reused nothing of the last one (minutes of rendering again). Kept on disk, so a restart puts it back too.
  const manifest = join(chunkFolder(app.store.cacheDir(), given.id), "manifest-v1.json");
  let keptManifest: string | null = join(app.store.cacheDir(), "range-exports", `${safe(given.id)}.manifest.json`);
  try {
    const before = fs.readFileSync(manifest, "utf8");
    fs.mkdirSync(join(app.store.cacheDir(), "range-exports"), { recursive: true });
    writeAtomic(keptManifest, before);
  } catch {
    // None yet.
    keptManifest = null;
  }
  const kept: Kept = { batch: true, mode, options, watermark, ranges: null, made: [], asked: [], manifest: keptManifest, began: Date.now() };
  jobs.begin(app.store.home, "export", given.id, kept as unknown as Record<string, unknown>, "ranges", "waiting for its graphics");
  const batch: Batch = { mode, total: ranges.length, done: 0, current: null, outputs: [], error: null, cancelled: false, finished: false, finished_ms: null };
  batches.set(given.id, batch);
  void runBatch(app, given.id, batch, kept, given);
  return batch;
}

/**
 * Carries on a batch a restart cut short (serve.ts's export resumer, through routes.ts `carryOnAsked`): the stretches
 * made are kept, and those left are made, as asked.
 */
export function carryOn(app: App, job: jobs.Job): void {
  if (app.store.get(job.project) === null) throw new jobs.Gone("the project is gone");
  const running = batches.get(job.project);
  if (running !== undefined && !running.finished) return;
  const kept = job.args as unknown as Kept;
  const batch = fromRow(job);
  batches.set(job.project, batch);
  diag.info("export", `${job.project}: carrying on its marked stretches after the restart (${batch.done} of ${batch.total || "?"} made)`);
  void runBatch(app, job.project, batch, { ...kept, made: [...(kept.made ?? [])], asked: [...(kept.asked ?? [])] });
}

/** A batch's work, from its first stretch not made (`kept.made`) to its end, its row written as each stretch ends. `given`: the edit it was asked of (none when carried on). */
async function runBatch(app: App, id: string, batch: Batch, kept: Kept, given?: Project): Promise<void> {
  const home = app.store.home;
  const key = rowOf(id);
  const { mode, options, watermark } = kept;
  const dir = exportsDir(home);
  const parts = join(app.store.cacheDir(), "range-exports", safe(id));
  let name = id;
  let ranges: Range[] = kept.ranges ?? [];
  try {
    // Its effects' renders and map shots first, as a share waits for them (each stretch would go out with their
    // stand-ins), then the edit as it is once they're in (after a restart too: they may be rendering again).
    await seams.broll.waitForMaps(app, id, 20 * 60_000).catch((error: unknown) => {
      if (!seams.isUnavailable(error)) throw error;
    });
    if (batch.cancelled) return;
    const now = app.store.get(id)?.project;
    let project = given ?? now;
    if (project === undefined) throw new Error("the project is gone");
    if (now !== undefined && marked(now).length > 0) project = now;
    name = project.name;
    if (kept.ranges === null) {
      ranges = marked(project);
      if (ranges.length === 0) throw new Error("no parts are marked any more");
      kept.ranges = ranges;
    }
    batch.total = ranges.length;
    fs.mkdirSync(dir, { recursive: true });
    if (mode === "joined") fs.mkdirSync(parts, { recursive: true });
    // Made before a restart: kept while their files are here, from the first that isn't on.
    const here = kept.made.findIndex((file) => !isFile(file));
    if (here >= 0) kept.made = kept.made.slice(0, here);
    batch.done = kept.made.length;
    batch.outputs = mode === "each" ? [...kept.made] : [];
    const note = (step: string) => jobs.step(home, key, step, { ranges, made: kept.made, asked: kept.asked });
    // Each its own file: two stretches whose names come out the same (two "Call"s, "Part 1/2" and "Part 1:2") numbered.
    const names = new Map<string, number>();
    for (const [index, range] of ranges.entries()) {
      const stem = `${safe(project.name)} - ${safe(range.name)}`;
      const seen = (names.get(stem) ?? 0) + 1;
      names.set(stem, seen);
      if (index < kept.made.length) continue;
      if (batch.cancelled) return;
      batch.current = range.name;
      note(`${range.name}, ${index + 1} of ${ranges.length}`);
      const output = mode === "each" ? join(dir, `${seen === 1 ? stem : `${stem} (${seen})`}.mp4`) : join(parts, `part-${String(index).padStart(3, "0")}.mp4`);
      // Its file as it was (the export writes `output` with its format's extension).
      const before = timeOf(native().withExtension(output, options.format));
      const path = await app.exports.start(app.store, app.library, project, { ...options, range: [range.start, range.end], chapters: [] }, output, {
        // On this computer only: no cloud copy, no Drive (a part of the edit, not the edit).
        keepLocal: true,
        stretch: true,
        // Its render moving is the batch's row moving.
        beats: key,
        ...(watermark === null ? {} : { watermark }),
      });
      kept.asked.push(path);
      if (!(await finished(app, id, path, before))) {
        if (!batch.cancelled) batch.error = `${range.name} didn't export`;
        return;
      }
      kept.made.push(path);
      batch.done = index + 1;
      if (mode === "each") batch.outputs.push(path);
    }
    if (mode === "joined") {
      if (batch.cancelled) return;
      batch.current = "joining them";
      note("joining them");
      const list = join(parts, "list.txt");
      fs.writeFileSync(list, (await withSound(kept.made)).map((file) => `file '${file.replace(/'/gu, "'\\''")}'`).join("\n"));
      const file = `${safe(project.name)} - ${ranges.length} marked.mp4`;
      const output = join(dir, file);
      // Beside it until whole: the last run's file under this name is listed for Download, and a join that failed
      // or was stopped wrote over it.
      const partial = join(dir, `${file.slice(0, -".mp4".length)}.partial.mp4`);
      try {
        await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", partial], { timeoutMs: 30 * 60_000 });
        fs.renameSync(partial, output);
      } finally {
        fs.rmSync(partial, { force: true });
      }
      // Listed as the export it is (downloaded from the dialog, shown with the project's exports), its parts not
      // (below): the download hands out listed exports alone (Sphe, Nov 12: "I clicked download. I got file.json twice").
      listMade(home, id, {
        path: output,
        name: file,
        finished_ms: Date.now(),
        seconds: (Date.now() - kept.began) / 1000,
        bytes: fs.statSync(output).size,
        frames: ranges.reduce((sum, range) => sum + range.end - range.start, 0),
        whole: false,
        start: ranges[0]!.start,
        format: options.format,
      });
      batch.outputs.push(output);
    }
    diag.info("export", `${project.name}: ${ranges.length} marked stretch${ranges.length === 1 ? "" : "es"} exported (${mode})`);
  } catch (error) {
    batch.error = diag.messageOf(error);
    diag.warn("export", `${name}: exporting its marked stretches: ${batch.error}`);
  } finally {
    batch.current = null;
    batch.finished = true;
    batch.finished_ms = Date.now();
    jobs.end(home, key);
    // Still listed: Edit is restarting (an update), its table kept as it was, and the batch is carried on from it. What
    // it made stays as it is.
    const over = jobs.get(home, key) === undefined;
    if (over) {
      try {
        fs.mkdirSync(join(app.store.cacheDir(), "range-exports"), { recursive: true });
        fs.writeFileSync(keptAt(app, id), JSON.stringify(batch));
      } catch (error) {
        diag.warn("export", `${name}: its marked stretches' export wasn't kept: ${diag.messageOf(error)}`);
      }
      const manifest = join(chunkFolder(app.store.cacheDir(), id), "manifest-v1.json");
      try {
        if (kept.manifest === null) fs.rmSync(manifest, { force: true });
        else {
          writeAtomic(manifest, fs.readFileSync(kept.manifest, "utf8"));
          fs.rmSync(kept.manifest, { force: true });
        }
      } catch (error) {
        diag.warn("export", `${name}: putting its last export's chunk list back: ${diag.messageOf(error)}`);
      }
      if (mode === "joined") {
        unlist(home, id, kept.asked);
        fs.rmSync(parts, { recursive: true, force: true });
      }
    }
  }
}

/** Stops a batch: the stretch being exported, and the rest (or one written down that isn't carried on yet). */
export function cancel(app: App, id: string): boolean {
  const batch = batches.get(id);
  if (batch === undefined || batch.finished) {
    const listed = jobs.get(app.store.home, rowOf(id));
    if (listed === undefined || !jobs.live(listed)) return false;
    jobs.end(app.store.home, rowOf(id));
    return true;
  }
  batch.cancelled = true;
  app.exports.cancel(id);
  return true;
}

export function routes(router: Router<App>): void {
  router
    .get("/api/projects/{id}/export-ranges", ({ app, params }) => json(latestBatch(app, params.id ?? "")))
    .post("/api/projects/{id}/export-ranges", async (context: RouteContext<App>) => {
      const { app, params } = context;
      const live = app.store.get(params.id ?? "");
      if (live === null) throw bad("no such project");
      const given = (await readJson(context)) as { mode?: unknown; options?: unknown; watermark?: unknown };
      const mode = given.mode === "joined" ? "joined" : given.mode === "each" ? "each" : null;
      if (mode === null) throw bad("mode is each or joined");
      const options: ExportOptions = { ...app.native.exportDefaults(), ...((given.options ?? {}) as Partial<ExportOptions>) };
      try {
        // A channel's project carries its channel's own logo, or none (channels.watermarkFor).
        const mark = await channels.watermarkOf(live.project, typeof given.watermark === "string" && given.watermark !== "" ? given.watermark : undefined);
        return json(exportRanges(app, live.project, options, mode, mark ?? null));
      } catch (error) {
        throw bad(diag.messageOf(error));
      }
    })
    .delete("/api/projects/{id}/export-ranges", ({ app, params }) => json({ cancelled: cancel(app, params.id ?? "") }));
}
