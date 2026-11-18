// An edit's footage that isn't here (Sphe, Nov 18, as for a script's import:
// "missing footage is never silently written around"): a file no longer on
// this machine with no cloud copy, or footage streamed from the cloud whose
// proxy the cloud doesn't have. The top bar's cloud says it with Retry now
// and Go on without it; Edit tries again by itself meanwhile (after 1, 5 and
// 15 minutes, then hourly: each source fetched again from where it came
// from); export and share wait for it, and the agent is told. Going on
// without a file is remembered here, per file, and never asked again.

import * as fs from "node:fs";

import type { EditMissing } from "@edit/types/footage_ready";

import type { App } from "./app.ts";
import { isMapStandIn } from "./broll.ts";
import * as cloudMedia from "./cloud_media.ts";
import { playbackKey } from "./cloud_playback.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { ApiError } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import { checkKey } from "./media.ts";
import type { Media, Project } from "./model.ts";
import { join } from "./paths.ts";
import { stableStringify } from "./stable.ts";
import { missingMedia } from "./store.ts";

/** How long after each try the next one is: 1, 5, 15 minutes, then every hour (writer/missing.ts's, the same). */
const DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const HOURLY_MS = 60 * 60_000;
export const delayAfter = (tries: number): number => DELAYS_MS[tries] ?? HOURLY_MS;

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
  const streamed = project.media.filter((media) => used.has(media.id) && proxyKeyOf(media) !== null && !madeHere(home, media));
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

/** "1 file didn't come in: CH03.avi", "3 files didn't come in: a.mp4, b.mp4 and c.mp4". */
export function line(missing: { name: string }[]): string {
  const names = missing.map((one) => one.name);
  const listed = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${missing.length} ${missing.length === 1 ? "file" : "files"} didn't come in: ${listed}`;
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
  return lines.join(" ");
}

/** Each project's tries here: how many, and when the next. */
const tries = new Map<string, { tries: number; at: number; timer: ReturnType<typeof setTimeout> | undefined }>();
const trying = new Set<string>();

/** Project `id` has footage missing: tried again later by itself (once a try is set, the next follows it). */
function keepTrying(app: App, id: string): void {
  if (tries.has(id)) return;
  const at = Date.now() + delayAfter(0);
  const timer = setTimeout(() => void tryAgain(app, id), delayAfter(0));
  timer.unref?.();
  tries.set(id, { tries: 0, at, timer });
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
  const known = tries.get(id);
  clearTimeout(known?.timer);
  if (!trying.has(id)) {
    trying.add(id);
    try {
      const { missing } = await missingOf(app.store.home, live.project);
      const ids = new Set(missing.map((media) => media.id));
      const files = [...cloudMedia.footageBySource(live.project)].flatMap(([source, media]) => {
        const file = cloudMedia.fileOfSource(source);
        return file !== null && media.some((one) => ids.has(one.id)) ? [{ source, file }] : [];
      });
      if (files.length > 0) {
        await cloudMedia.fetchFootageAgain(app, id, files, (source, now) => {
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
  const now = await state(app, id, false);
  if (now.missing.length === 0) {
    tries.delete(id);
    return now;
  }
  const count = (known?.tries ?? -1) + 1;
  const wait = delayAfter(count);
  const timer = setTimeout(() => void tryAgain(app, id), wait);
  timer.unref?.();
  tries.set(id, { tries: count, at: Date.now() + wait, timer });
  diag.info("cloud", `${id}: ${line(now.missing)}; tried again in ${Math.round(wait / 60_000)} min`);
  return now;
}

/** Where `id`'s footage stands, as the top bar's cloud shows it; with `follow`, missing footage is tried again by itself. */
export async function state(app: App, id: string, follow = true): Promise<EditMissing> {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  const { used, missing } = await missingOf(app.store.home, live.project);
  if (follow && missing.length > 0) keepTrying(app, id);
  return { used, missing: missing.map((media) => ({ id: media.id, name: media.name, path: media.path })) };
}

/** Goes on without medium `media` of project `id`: remembered here for good, never asked again. */
export function goWithout(app: App, id: string, media: string): void {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  if (!live.project.media.some((one) => one.id === media)) throw new ApiError(404, "That file isn't in this project.");
  const all = readWaived(app.store.home);
  all[id] = [...new Set([...(all[id] ?? []), media])];
  writeAtomic(waivedFile(app.store.home), JSON.stringify(all, null, 2));
  diag.info("cloud", `${id}: going on without ${live.project.media.find((one) => one.id === media)!.name}, as asked`);
}

const reply = (value: unknown): Response => new Response(stableStringify(value), { headers: { "content-type": "application/json" } });

export function routes(router: Router<App>): void {
  router
    // The editor's word on footage that isn't here (its top bar's cloud), followed by tries of its own.
    .get("/api/projects/{id}/missing", async ({ app, params }) => reply(await state(app, params.id ?? "")))
    .post("/api/projects/{id}/missing/retry", async ({ app, params }) => reply(await tryAgain(app, params.id ?? "")))
    .post("/api/projects/{id}/missing/{media}/without", async ({ app, params }) => {
      goWithout(app, params.id ?? "", params.media ?? "");
      return reply(await state(app, params.id ?? "", false));
    });
}

/** Stops the tries (tests). */
export function stop(): void {
  for (const one of tries.values()) clearTimeout(one.timer);
  tries.clear();
}
