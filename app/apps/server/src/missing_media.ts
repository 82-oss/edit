// An edit's footage that isn't here (Sphe, Nov 18, as for a script's import:
// "missing footage is never silently written around"): a file no longer on
// this machine with no cloud copy, or footage streamed from the cloud whose
// proxy the cloud doesn't have. The top bar's cloud says it with Retry now
// and Go on without it; Edit tries again by itself meanwhile (failure.ts's
// passing schedule, 1, 5 and 15 minutes then every 30, from one row a project
// in the job table, `media:<id>`, woken at once when the connection is back:
// each source fetched again from where it came from); export and share wait
// for it, and the agent is told. Going on without a file is remembered here,
// per file, and never asked again.

import * as fs from "node:fs";

import type { EditMissing } from "@edit/types/footage_ready";

import type { App } from "./app.ts";
import { isMapStandIn } from "./broll.ts";
import { clipFrom } from "./clips.ts";
import * as cloudMedia from "./cloud_media.ts";
import { playbackKey } from "./cloud_playback.ts";
import * as diag from "./diag.ts";
import * as failure from "./failure.ts";
import { writeAtomic } from "./files.ts";
import { ApiError } from "./http/errors.ts";
import * as jobs from "./jobs.ts";
import type { Router } from "./http/router.ts";
import { checkKey } from "./media.ts";
import type { Media, Project } from "./model.ts";
import { join } from "./paths.ts";
import { goneWithout, goneWithoutName, unanswered } from "./project.ts";
import { stableStringify } from "./stable.ts";
import { missingMedia } from "./store.ts";


/** The files gone on without, by project: `<home>/footage-gone-without.json`. */
const waivedFile = (home: string): string => join(home, "footage-gone-without.json");

function readWaived(home: string): Record<string, string[]> {
  try {
    const found = JSON.parse(fs.readFileSync(waivedFile(home), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(found).filter((entry): entry is [string, string[]] => Array.isArray(entry[1])));
  } catch {
    return {};
  }
}

/** The media of `id` the person went on without. */
export const waived = (home: string, id: string): string[] => readWaived(home)[id] ?? [];

/** The media the timeline uses. */
const usedIds = (project: Project): Set<string> => new Set(project.clips.flatMap((clip) => ("media" in clip && typeof clip.media === "string" ? [clip.media] : [])));

/** The R2 key a streamed medium plays (its proxy), or null for one that's a file here. */
const proxyKeyOf = (media: Media): string | null => playbackKey(media.path);

/** Edit's own folders of what it renders for a project and renders again itself: `<home>/media/<project>/<folder>/…`. */
const MADE_HERE = /^[^/]+\/(?:effect-renders|maps|smooth)\//u;

/**
 * Whether `media` is something Edit makes for the edit rather than footage:
 * a coded effect's still or render, a map shot or its stand-in, smoothed
 * slow motion, a strip with words taken out. One of those not here is
 * Edit's to make again, and an export already waits for it or makes it
 * again itself (broll.exportReady, an effect's remake); it never "didn't come in".
 */
function madeHere(home: string, media: Media): boolean {
  if (media.effect !== undefined || media.cleans !== undefined || isMapStandIn(media.path)) return true;
  const own = `${join(home, "media")}/`;
  return media.path.startsWith(own) && MADE_HERE.test(media.path.slice(own.length));
}

/**
 * What the timeline uses that isn't here and can't play: footage gone from
 * this machine with no cloud copy, and footage whose cloud proxy the cloud
 * doesn't have (8 asked at once; each answer is kept a while, media.ts).
 * Never what Edit makes itself (`madeHere`). `all`: those gone on without too.
 */
export async function missingOf(home: string, project: Project, all = false): Promise<{ used: number; missing: Media[] }> {
  const used = usedIds(project);
  const streamed = project.media.filter((media) => used.has(media.id) && proxyKeyOf(media) !== null && !madeHere(home, media) && !hereStill(home, media));
  const gone = new Set<string>();
  for (let at = 0; at < streamed.length; at += 8) {
    await Promise.all(
      streamed.slice(at, at + 8).map(async (media) => {
        if ((await checkKey(proxyKeyOf(media)!)) === false) gone.add(media.id);
      }),
    );
  }
  const left = new Set(all ? [] : waived(home, project.id));
  const missing = [...missingMedia(project).filter((media) => !madeHere(home, media)), ...streamed.filter((media) => gone.has(media.id))].filter((media) => !left.has(media.id));
  return { used: project.media.filter((media) => used.has(media.id)).length, missing };
}

/**
 * Whether a streamed medium's footage is on this machine all the same, as an
 * export reads it (cloud_media.ts `located`): its proxy whole in the cache, or
 * its original here (a file just imported, Edit's own picture of a page
 * scrolling, while its upload goes on behind). Its key not in the cloud yet is
 * then its upload under way, never a file that didn't come in (Nov 22: an
 * export right after a desktop plan was refused "1 file didn't come in:
 * Scroll · m16-1280x1160-30.mp4", the scroll the plan had just made going up;
 * the same export went through a minute later).
 */
function hereStill(home: string, media: Media): boolean {
  const cache = join(home, "cache");
  const proxy = proxyKeyOf(media);
  if (proxy !== null && isFile(cloudMedia.localPath(cache, proxy))) return true;
  const original = media.cloud?.original;
  return typeof original === "string" && cloudMedia.localOriginal(cache, original) !== null;
}

/** "1 file didn't come in: CH03.avi", "3 files didn't come in: a.mp4, b.mp4 and c.mp4". */
export function line(missing: { name: string }[]): string {
  const names = missing.map((one) => one.name);
  const listed = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${missing.length} ${missing.length === 1 ? "file" : "files"} didn't come in: ${listed}`;
}

function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `project` as an export (or any render) reads it: footage the person went on
 * without plays nothing and is heard not at all, its time kept. Each of its
 * pictures becomes an empty card of the same length (what's beneath shows,
 * black where nothing is), its sound and its sound's picture are left out.
 * Its file back here plays again. Without this an export of an edit gone on
 * without failed on the file it no longer has ("the edit uses files that
 * aren't on this machine"), the promise of a working edit broken. The same
 * project when nothing was gone without.
 */
export function playable(home: string, project: Project): Project {
  const without = new Set(waived(home, project.id));
  if (without.size === 0) return project;
  const gone = new Set(project.media.filter((media) => without.has(media.id) && !isFile(media.path)).map((media) => media.id));
  if (gone.size === 0 || !project.clips.some((clip) => "media" in clip && typeof clip.media === "string" && gone.has(clip.media))) return project;
  const out = structuredClone(project);
  out.clips = out.clips.flatMap((clip) => {
    if (!("media" in clip) || typeof clip.media !== "string" || !gone.has(clip.media)) return [clip];
    if (clip.type !== "video") return [];
    const { keyframes: _keyframes, ...rest } = clip;
    return [clipFrom({ ...rest, type: "solid", fill: [0, 0, 0, 0], opacity: 0 })];
  });
  return out;
}

/** Why an export or share of `project` waits, or null when its footage is all here (or gone on without). */
export async function held(home: string, project: Project): Promise<string | null> {
  const { missing } = await missingOf(home, project).catch(() => ({ missing: [] as Media[] }));
  if (missing.length === 0) return null;
  return `The export waits: ${line(missing)}. Retry it at the cloud in the top bar, or go on without it there.`;
}

/** What the agent is told with each message while footage is missing, so it never works around a gap unsaid. */
export async function forAgent(home: string, project: Project): Promise<string> {
  const { missing } = await missingOf(home, project).catch(() => ({ missing: [] as Media[] }));
  const without = new Set(waived(home, project.id));
  const left = project.media.filter((media) => without.has(media.id) && usedIds(project).has(media.id));
  const lines: string[] = [];
  if (missing.length > 0) lines.push(`FOOTAGE MISSING: ${line(missing)}. Its clips have no picture or sound here, and Edit is still trying to bring it in; exporting and sharing wait for it. Don't cut around it or import it again: say so in a line where it matters.`);
  if (left.length > 0) lines.push(`The person went on without ${left.map((one) => one.name).join(", ")}, which didn't come in: their clips play black and silent. Say so wherever that leaves a gap.`);
  // The import's: a file that couldn't be downloaded, its script ranges holding their place as black cards.
  const ranges = (project.script?.blocks ?? []).filter((block) => goneWithout(block) && typeof block.clip === "string" && project.clips.some((clip) => clip.id === block.clip));
  if (ranges.length > 0) {
    const names = [...new Set(ranges.map((block) => goneWithoutName(block) ?? "a file"))];
    const asked = ranges.some((block) => unanswered(block) !== null);
    const who = asked ? `${names.join(", ")} couldn't be downloaded, so the import went on without ${names.length === 1 ? "it" : "them"}` : `The person went on without ${names.join(", ")}, which couldn't be downloaded`;
    lines.push(`${who}: ${ranges.length === 1 ? "its range holds its place" : `its ${ranges.length} ranges hold their place`} as black cards named "… · didn't come in", with no picture or sound. Leave them where they are unless the person asks, and say so wherever that leaves a gap.${asked ? " The person can give another link at the cloud in the top bar (or with replace_footage), which fills them." : ""}`);
  }
  return lines.join(" ");
}

/** Projects being tried now. */
const trying = new Set<string>();

const keyOf = (id: string): string => jobs.keyOf("media", id);

/**
 * Project `id`'s missing footage waits in the job table to be tried again by itself, its `tries` so far counted
 * (honest council change 7e, Nov 19: its tries lived on timers in memory, which a restart forgot).
 */
function waitToTry(app: App, id: string, tries: number): number | null {
  const home = app.store.home;
  const key = keyOf(id);
  const listed = jobs.get(home, key);
  if (listed === undefined || !jobs.live(listed)) jobs.begin(home, "media", id, {}, "", "trying again by itself");
  const at = failure.nextTry("passing", tries, Date.now());
  jobs.settle(home, key, "waiting", { step: "trying again by itself", ...(at === null ? {} : { retry_at: at }), args: { waiting_on: "passing", tries } });
  return at;
}

/** Project `id` has footage missing: tried again later by itself (once it waits, its next try follows the last). */
export function keepTrying(app: App, id: string): void {
  const listed = jobs.get(app.store.home, keyOf(id));
  if (listed !== undefined && jobs.live(listed)) return;
  waitToTry(app, id, 0);
}

/**
 * Brings `id`'s missing footage again: each source whose footage it is
 * fetched from where it came from (Drive, YouTube, a post, a review link),
 * as clearing's bring-back does, and the project's footage made local
 * again; then asked again, and tried later if anything is still missing.
 */
export async function tryAgain(app: App, id: string): Promise<EditMissing> {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  // A script's files laid out without, each from its own link again (shared since, put back), in the background.
  const script = await import("./script.ts");
  for (const one of script.unansweredFiles(live.project)) {
    await script.refill(app, id, one.file, null, true).catch((error: unknown) => diag.warn("cloud", `${id}: ${one.name} wasn't tried again: ${diag.messageOf(error)}`));
  }
  const listed = jobs.get(app.store.home, keyOf(id));
  const before = typeof listed?.args.tries === "number" ? listed.args.tries : -1;
  if (!trying.has(id)) {
    trying.add(id);
    try {
      // Those gone on without too: going on without a file only stops the export waiting for it (Q2 of the census).
      const { missing } = await missingOf(app.store.home, live.project, true);
      const ids = new Set(missing.map((media) => media.id));
      const files = [...cloudMedia.footageBySource(live.project)].flatMap(([source, media]) => {
        const file = cloudMedia.fileOfSource(source);
        return file !== null && media.some((one) => ids.has(one.id)) ? [{ source, file }] : [];
      });
      if (files.length > 0) {
        await cloudMedia.fetchFootageAgain(app, id, files, (source, now) => {
          // Each word of how it goes notes the row (at most every 30 s): a long fetch never reads as still.
          jobs.beat(app.store.home, keyOf(id));
          if (now.state === "failed") diag.warn("cloud", `${id}: ${source} still didn't come in: ${now.error}`);
        });
      }
      await cloudMedia.ensureLocal(app, id).catch(() => {});
    } catch (error) {
      diag.warn("cloud", `${id}: trying its missing footage again: ${diag.messageOf(error)}`);
    } finally {
      trying.delete(id);
    }
  }
  let now: EditMissing;
  let still: Awaited<ReturnType<typeof missingOf>>["missing"];
  let gone: ReturnType<typeof script.unansweredFiles>;
  try {
    now = await state(app, id, false);
    const project = (app.store.get(id) ?? live).project;
    still = (await missingOf(app.store.home, project, true)).missing;
    gone = script.unansweredFiles(project);
  } catch (error) {
    // Its row never stays "running" with nothing running (Nov 20): the project deleted meanwhile ends it, anything
    // else waits its next try.
    if (app.store.get(id) === null) jobs.end(app.store.home, keyOf(id));
    else waitToTry(app, id, before + 1);
    throw error;
  }
  if (still.length === 0 && gone.length === 0) {
    jobs.end(app.store.home, keyOf(id));
    return now;
  }
  const at = waitToTry(app, id, before + 1);
  diag.info("cloud", `${id}: ${line([...still, ...gone])}; tried again${at === null ? " later" : ` at ${new Date(at).toISOString()}`}`);
  return now;
}

/** Where `id`'s footage stands, as the top bar's cloud shows it; with `follow`, missing footage is tried again by itself. */
export async function state(app: App, id: string, follow = true): Promise<EditMissing> {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  const { used, missing } = await missingOf(app.store.home, live.project);
  const { unansweredFiles } = await import("./script.ts");
  const gone = unansweredFiles(live.project);
  // Tried by itself while anything is missing, the ones gone on without too: they play again once they're back. A
  // script's file laid out without the same: its black parts fill once it comes.
  if (follow && (missing.length > 0 || gone.length > 0 || (await missingOf(app.store.home, live.project, true)).missing.length > 0)) keepTrying(app, id);
  // A file gone from this machine with no cloud copy is the person's to put back; a cloud proxy Edit fetches again itself.
  const local = new Set(missingMedia(live.project).map((media) => media.id));
  // A script's file the import laid out without by itself: the person's to answer, with another link or Retry now.
  const files = gone.map((one) => ({ id: `${FILE}${one.file}`, name: one.name, path: one.file, asked: true as const, link: true as const, why: one.why }));
  return { used, missing: [...missing.map((media) => ({ id: media.id, name: media.name, path: media.path, ...(local.has(media.id) ? { asked: true } : {}) })), ...files] };
}

/** The id of a script's file in the missing list (`state`), beside the media's own. */
const FILE = "file:";

/**
 * Exports `id` with medium `media`'s parts black (the person's answer): the export stops waiting for it, its clips
 * play black and silent, and Edit keeps trying to bring it in; once it's here it plays and exports again.
 */
export async function goWithout(app: App, id: string, media: string): Promise<void> {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  // A script's file laid out without: its parts are black already, and stay so; its question goes.
  if (media.startsWith(FILE)) {
    const { keepBlack } = await import("./script.ts");
    await keepBlack(app, id, media.slice(FILE.length));
    diag.info("cloud", `${id}: keeping ${media.slice(FILE.length)}'s parts black, as asked`);
    return;
  }
  if (!live.project.media.some((one) => one.id === media)) throw new ApiError(404, "That file isn't in this project.");
  const all = readWaived(app.store.home);
  all[id] = [...new Set([...(all[id] ?? []), media])];
  writeAtomic(waivedFile(app.store.home), JSON.stringify(all, null, 2));
  diag.info("cloud", `${id}: exporting with ${live.project.media.find((one) => one.id === media)!.name}'s parts black, as asked; still trying to bring it in`);
}

const reply = (value: unknown): Response => new Response(stableStringify(value), { headers: { "content-type": "application/json" } });

export function routes(router: Router<App>): void {
  router
    // The editor's word on footage that isn't here (its top bar's cloud), followed by tries of its own.
    .get("/api/projects/{id}/missing", async ({ app, params }) => reply(await state(app, params.id ?? "")))
    .post("/api/projects/{id}/missing/retry", async ({ app, params }) => reply(await tryAgain(app, params.id ?? "")))
    .post("/api/projects/{id}/missing/{media}/without", async ({ app, params }) => {
      await goWithout(app, params.id ?? "", params.media ?? "");
      return reply(await state(app, params.id ?? "", false));
    });
}

/** Stops the tries (tests): nothing runs here between them any more, the job table wakes them. */
export function stop(): void {
  trying.clear();
}
