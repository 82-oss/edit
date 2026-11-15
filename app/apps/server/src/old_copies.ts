// The "(conflicted copy)" and "(restored copy)" edits and scripts Edit made
// before Nov 15, folded away (Sphe: "eradicate conflicted copies as a whole
// across Edit"). A version the cloud overtakes now goes into its project's
// history or its script's versions (cloud_projects.ts, writer/cloud.ts); the
// copies already made go the same way, once each, a minute after Edit starts:
//
// - an edit copy: kept in its original's history (`projects/history/<id>/`),
//   then deleted here and from the cloud;
// - a script copy: kept as a "Not synced" version of its original, then
//   deleted here and, the next round, from the cloud and every other Mac;
// - a copy whose original is gone (deleted since): renamed back to its name.
//
// The original is the edit or script of the same name without the suffix (the
// newest, when there are more). A copy something is running on waits for the
// next start.

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import * as seams from "./seams.ts";
import { OLD_COPY } from "./sync_core.ts";
import * as writerCloud from "./writer/cloud.ts";
import { importing } from "./writer/imports.ts";
import * as writerJobs from "./writer/jobs.ts";
import * as scripts from "./writer/store.ts";
import * as versions from "./writer/versions.ts";

const AFTER_START_MS = 60_000;

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

async function foldEdits(app: App): Promise<number> {
  let folded = 0;
  const all = app.store.list();
  for (const copy of all.filter((summary) => OLD_COPY.test(summary.name))) {
    const live = app.store.get(copy.id);
    if (live === null) continue;
    const name = copy.name.replace(OLD_COPY, "");
    const original = all.filter((other) => other.id !== copy.id && other.name === name).sort((a, b) => b.modified_ms - a.modified_ms)[0];
    try {
      if (original === undefined) {
        await app.store.update(copy.id, "cloud", (project) => {
          project.name = name;
        });
        diag.info("copies", `${copy.id}: an old conflicted copy of an edit that's gone, named “${name}” again`);
      } else {
        const kept = app.store.keepNow(original.id, live.project);
        // From the cloud first: one left there would come back down.
        if (app.store.cloud() !== null) await seams.cloudProjects.delete(app, copy.id);
        app.store.delete(copy.id);
        diag.info("copies", `${copy.id}: an old conflicted copy of ${original.id} kept in its history (${kept}) and deleted`);
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
    if (importing(copy.id) || writerJobs.running(copy.id)) continue;
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
