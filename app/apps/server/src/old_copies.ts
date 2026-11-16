// The "(conflicted copy)" and "(restored copy)" edits and scripts Edit made
// before Nov 15, folded away (Sphe: "eradicate conflicted copies as a whole
// across Edit"). A version the cloud overtakes now is kept aside with its
// project or as a version of its script (cloud_projects.ts, writer/cloud.ts);
// the copies already made go the same way, once each, a minute after Edit
// starts, and never with anyone's work:
//
// - an edit copy nobody worked in since it was made: kept aside with its
//   original (`projects/kept/<id>/<copy id>.json`, which the agent lists and
//   brings back), deleted from the cloud, then here (its renders too);
// - an edit copy someone worked in: left a project of its own, named
//   "<name> (kept 7 Nov)" (the day it was made) so it no longer says
//   "(conflicted copy)";
// - a script copy: kept as a "Not synced" version of its original, then
//   deleted here and, the next round, from the cloud and every other Mac;
// - a copy whose original is gone (deleted since): renamed back to its name.
//
// The original is the edit or script of the same name without the suffix
// (the newest, when there are more), here or, for an edit, in the cloud. A
// copy something is running on or is to carry on (an agent turn, an export,
// an import, any job of it in jobs.json) waits for the next start, as does
// every edit copy while the cloud's list can't be read, and one whose delete
// from the cloud is refused (someone has it open, offline).

import type { App } from "./app.ts";
import { workingOn } from "./busy.ts";
import * as changes from "./changes.ts";
import * as diag from "./diag.ts";
import * as effectCloud from "./effect_cloud.ts";
import * as jobs from "./jobs.ts";
import type { ProjectSummary } from "./model.ts";
import * as seams from "./seams.ts";
import { OLD_COPY } from "./sync_core.ts";
import * as writerCloud from "./writer/cloud.ts";
import { importing } from "./writer/imports.ts";
import * as writerJobs from "./writer/jobs.ts";
import * as scripts from "./writer/store.ts";
import * as versions from "./writer/versions.ts";

const AFTER_START_MS = 60_000;
/** A copy saved this long after it was made was worked in (its file is written once as it's made). */
const UNTOUCHED_MS = 5_000;

/** Folds the old copies a minute after start (the cloud's list and the scripts' first pull in by then). */
export function start(app: App): void {
  const timer = setTimeout(() => {
    void fold(app).catch((error: unknown) => diag.warn("copies", `folding old conflicted copies: ${diag.messageOf(error)}`));
  }, AFTER_START_MS);
  timer.unref?.();
}

const day = (ms: number): string => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Folds every old copy on this machine; answers how many went. */
export async function fold(app: App): Promise<number> {
  return (await foldEdits(app)) + foldScripts(app);
}

/** When an edit copy was made: its id's time (`p<ms>-<n>`, as Store made every copy); null for an id that doesn't say. */
const madeAt = (id: string): number | null => {
  const found = /^p(\d+)-/.exec(id);
  return found === null ? null : Number(found[1]);
};

/** Whether a job of `id` (an edit's or a script's) in jobs.json is still to do: one a restart cut short carries on. */
const toCarryOn = (app: App, id: string): boolean => jobs.list(app.store.home).some((job) => job.project === id && jobs.live(job));

/** Whether anything runs on project `id` here, or is to carry on after a restart: an agent turn, an import, an export, any job of it. */
function busyHere(app: App, id: string): boolean {
  if (workingOn(app, id)) return true;
  try {
    if ((app.exports.runningFor?.(id) ?? null) !== null) return true;
  } catch (error) {
    // No exports in this App (tests).
    if (!seams.isUnavailable(error)) throw error;
  }
  return toCarryOn(app, id);
}

/**
 * Whether someone worked in an edit copy since it was made, as far as this
 * machine can tell: the person or an agent changed it here (changes.ts), it
 * has changes here not pushed, the cloud has a save of it after its first
 * (the copy went up as rev 1), or, for one that never was a cloud project
 * here, its file was written after it was made. Unsure is worked in: it's
 * kept as a project.
 */
function workedIn(app: App, copy: ProjectSummary, cloudRev: number | null): boolean {
  if (changes.workedIn(app, copy.id)) return true;
  const synced = app.store.cloud() !== null ? seams.cloudProjects.synced(app, copy.id) : null;
  if (synced?.dirty === true) return true;
  if (cloudRev !== null) return cloudRev > 1;
  // Gone from the cloud since (folded on another Mac): as far as this copy got.
  if (synced !== null) return synced.rev > 1;
  const made = madeAt(copy.id);
  return made === null || copy.modified_ms - made > UNTOUCHED_MS;
}

async function foldEdits(app: App): Promise<number> {
  const all = app.store.list();
  const copies = all.filter((summary) => OLD_COPY.test(summary.name));
  if (copies.length === 0) return 0;
  // An original only in the cloud counts too: without it, the copy would be named as it and pushed, two projects of one name.
  let inCloud: { id: string; name: string; rev: number }[] = [];
  if (app.store.cloud() !== null) {
    try {
      inCloud = (await seams.cloudProjects.listed(app)) ?? [];
    } catch (error) {
      diag.warn("copies", `the cloud's projects can't be read (${diag.messageOf(error)}), so the old conflicted copies wait for the next start`);
      return 0;
    }
  }
  const here: Pick<ProjectSummary, "id" | "name" | "modified_ms">[] = all.filter((summary) => !OLD_COPY.test(summary.name));
  let folded = 0;
  for (const copy of copies) {
    const live = app.store.get(copy.id);
    if (live === null) continue;
    if (busyHere(app, copy.id)) {
      diag.info("copies", `${copy.id}: an old conflicted copy with work on it, left for the next start`);
      continue;
    }
    const name = copy.name.replace(OLD_COPY, "");
    const candidates = [
      ...here.filter((other) => other.id !== copy.id && other.name === name).map((other) => ({ id: other.id, at: other.modified_ms })),
      ...inCloud.filter((other) => other.id !== copy.id && other.name === name).map((other) => ({ id: other.id, at: Number.NEGATIVE_INFINITY })),
    ];
    // The newest here first, else the cloud's.
    const original = candidates.sort((a, b) => b.at - a.at)[0];
    const cloudRev = inCloud.find((other) => other.id === copy.id)?.rev ?? null;
    try {
      if (original === undefined) {
        await app.store.update(copy.id, "cloud", (project) => {
          project.name = name;
        });
        // The original now, for another copy of it.
        here.push({ id: copy.id, name, modified_ms: Date.now() });
        diag.info("copies", `${copy.id}: an old conflicted copy of an edit that's gone, named “${name}” again`);
      } else if (workedIn(app, copy, cloudRev)) {
        // Someone's work: a project of its own, never folded away.
        const kept = `${name} (kept ${day(madeAt(copy.id) ?? copy.modified_ms)})`;
        await app.store.update(copy.id, "cloud", (project) => {
          project.name = kept;
        });
        diag.info("copies", `${copy.id}: an old conflicted copy of ${original.id} worked in since it was made, kept as “${kept}”`);
      } else {
        // From the cloud first (one left there would come back down); refused, it waits, and nothing is kept twice.
        if (app.store.cloud() !== null) await seams.cloudProjects.delete(app, copy.id);
        // Named by the copy's id: kept once, however often this is tried.
        const kept = app.store.keepAside(original.id, live.project, copy.id);
        // Its effects' renders in the cloud go, as a project deleted from Home does (routes.ts).
        const renders = live.project.media.map((media) => media.cloud?.original);
        void effectCloud.forgetProject(app, copy.id, renders).catch((error: unknown) => diag.warn("effects", `${copy.id}: its renders in the cloud: ${diag.messageOf(error)}`));
        app.store.delete(copy.id);
        diag.info("copies", `${copy.id}: an old conflicted copy of ${original.id}, untouched since it was made, kept aside with it (projects/kept/${original.id}/${kept}.json) and deleted`);
      }
      folded++;
    } catch (error) {
      diag.warn("copies", `${copy.id}: folding an old conflicted copy: ${diag.messageOf(error)}`);
    }
  }
  return folded;
}

function foldScripts(app: App): number {
  const data = scripts.dataDir(app.store.home);
  let folded = 0;
  const all = scripts.list(data);
  for (const copy of all.filter((row) => OLD_COPY.test(row.title))) {
    if (importing(copy.id) || writerJobs.running(copy.id) || toCarryOn(app, copy.id)) continue;
    const dir = scripts.scriptDir(data, copy.id);
    const title = copy.title.replace(OLD_COPY, "");
    const original = all.filter((other) => other.id !== copy.id && other.title === title).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    try {
      if (original === undefined) {
        scripts.update(dir, (script) => {
          script.title = title;
        });
        diag.info("copies", `${copy.id}: an old conflicted copy of a script that's gone, named “${title}” again`);
      } else {
        const script = scripts.read(dir);
        if (!versions.keepOvertaken(scripts.scriptDir(data, original.id), script, `A conflicted copy from ${day(copy.updatedAt)}, kept here`)) throw new Error("its version couldn't be written");
        // The cloud's delete is recorded first, as the script page's Delete does.
        writerCloud.deleted(data, copy.id);
        scripts.remove(data, copy.id);
        diag.info("copies", `${copy.id}: an old conflicted copy of script ${original.id} kept in its versions and deleted`);
      }
      folded++;
    } catch (error) {
      diag.warn("copies", `${copy.id}: folding an old conflicted copy: ${diag.messageOf(error)}`);
    }
  }
  if (folded > 0) scripts.libraryChanged();
  return folded;
}
