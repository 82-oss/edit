// What a local-first project (local_first.ts) gives up when room is short, and what it keeps last (Sphe, Nov 22, on
// footage kept local while a project is in work: it "will lead to insane storage getting used up across many
// projects"). Each source is here twice at most: its original and its working copy (the original itself when it plays
// as it is). With room, both stay, as any project's footage does. Short of room, the cleaner (cache_cleanup.ts) gives
// them up in this order, idle projects before projects in work, the one worked on longest ago first:
//
// 1. whole originals the cloud holds at their size, once their working copy is made (a stand-in, the original under
//    the copy's name, frees nothing) and what the timeline shows of them is kept here as export cells (`keep`);
// 2. working copies of sources the timeline doesn't use;
// 3. working copies of sources it does (a project in work only with the disk truly out);
// 4. the used stretches themselves: the export cells and the sound copy (a project in work only with the disk truly out).
//
// The used stretches are export_excerpts.ts's cells (30 s of the original's picture, stream-copied, never re-encoded)
// and the original's sound copy (cloud_media `soundKey`), cut from the original here (`keep`) before it goes, so an
// export reads them and fetches nothing; what neither the original nor the cells hold (a clip added or moved since) is
// cut here again while the original's here, else fetched once from the cloud. Everything given up comes back: playing
// fetches the working copy (it went up behind the import), an export the original's stretches.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import { localPath, soundCopy, soundKey } from "./cloud_media.ts";
import * as diag from "./diag.ts";
import * as exportExcerpts from "./export_excerpts.ts";
import { chosen, isStandIn, isWorkingKey } from "./local_first.ts";
import type { Project } from "./model.ts";
import { openedTimes } from "./opened.ts";
import { isFile } from "./paths.ts";
import * as storage from "./storage.ts";

/** A source of a local-first project, as the cleaner weighs it (keys in R2; `paths` puts them here). */
export interface Footage {
  media: string;
  /** Its original's key. */
  original: string;
  /** Its working copy's key: the original's own when it plays as it is (`own`). */
  copy: string;
  own: boolean;
  /** A clip of the timeline plays it (picture or sound). */
  onTimeline: boolean;
  /** The export cells the timeline's picture of it needs (export_excerpts.ts `cellKey`), in the order they're shown. */
  cells: string[];
  /** Its sound copy's key when the timeline hears it. */
  sound: string | null;
}

/** Far past any timeline's end (frames). */
const ALL = Number.MAX_SAFE_INTEGER;

/**
 * The sources of `project` that keep their footage local (none unless it took the local path), each with what its
 * timeline uses of it. `project` may be read straight from its file (the cleaner's): every field is checked.
 */
export function footageOf(project: Project): Footage[] {
  if (project === null || typeof project !== "object" || !Array.isArray(project.media) || !chosen(project)) return [];
  const clips = Array.isArray(project.clips) ? project.clips : [];
  const shaped = { ...project, clips, settings: project.settings ?? { fps: 30 } } as Project;
  const used = new Set(clips.flatMap((clip) => (clip.type === "video" || clip.type === "audio" ? [clip.media] : [])));
  const out: Footage[] = [];
  for (const media of project.media) {
    const where = media?.cloud;
    if (media?.kind !== "video" || where === null || where === undefined) continue;
    const { original, proxy } = where;
    if (typeof original !== "string" || typeof proxy !== "string" || !cloud.validKey(original) || !cloud.validKey(proxy)) continue;
    const own = proxy === original;
    if (!own && !isWorkingKey(proxy)) continue;
    const onTimeline = used.has(media.id);
    const cells = onTimeline
      ? exportExcerpts.cellsOf(shaped, 0, ALL, new Set([media.id])).flatMap((cell) => {
          const key = exportExcerpts.cellKey(original, media.fps, cell.index);
          return key === null ? [] : [key];
        })
      : [];
    const sound = media.has_audio && onTimeline ? soundKey(original) : null;
    out.push({ media: media.id, original, copy: proxy, own, onTimeline, cells, sound });
  }
  return out;
}

/** A source's files here (`<cache>/cloud/…`). */
export function paths(cache: string, footage: Footage): { original: string; copy: string | null; cells: string[]; sound: string | null } {
  return {
    original: localPath(cache, footage.original),
    copy: footage.own ? null : localPath(cache, footage.copy),
    cells: footage.cells.map((key) => localPath(cache, key)),
    sound: footage.sound === null ? null : localPath(cache, footage.sound),
  };
}

/** Whether what the timeline shows and hears of `footage` is kept here: every cell and the sound copy. */
export function stretchesHere(cache: string, footage: Footage): boolean {
  const at = paths(cache, footage);
  return at.cells.every(isFile) && (at.sound === null || isFile(at.sound));
}

/** A project worked on this lately keeps its stretches whole when its original is gone: a clip moved past them is fetched behind. */
const IN_WORK_MS = 3 * 24 * 3600 * 1000;

/**
 * Keeps the used stretches of every local-first source whose original may go (`mayGo`: the cloud has said it holds
 * it at its size), cut from the original here, so it can go: only what isn't kept yet is cut, only while the original
 * is here and its working copy made. A source whose original is gone already and some of whose stretches are kept
 * has what's missing (a clip moved or extended since) fetched from the cloud, for a project worked on lately. None
 * for a project marked `done`. How many cells were cut.
 */
export async function keep(app: App, mayGo: (path: string, bytes: number) => boolean, done: ReadonlySet<string> = new Set(), signal?: AbortSignal): Promise<number> {
  const cache = app.store.cacheDir();
  const opened = openedTimes(app.store.home);
  let cut = 0;
  for (const summary of app.store.list()) {
    if (signal?.aborted) break;
    const project = app.store.get(summary.id)?.project;
    // A project marked done gives all of it up at the next pass: nothing kept for it.
    if (project === undefined || !chosen(project) || done.has(summary.id)) continue;
    for (const footage of footageOf(project)) {
      if (signal?.aborted) break;
      if (!footage.onTimeline || stretchesHere(cache, footage)) continue;
      const at = paths(cache, footage);
      const name = project.media.find((one) => one.id === footage.media)?.name ?? footage.media;
      let input: string;
      let bytes = 0;
      try {
        bytes = fs.statSync(at.original).size;
        input = at.original;
      } catch {
        input = "";
      }
      if (input !== "") {
        // Its working copy not made (the original stands in for it), or the cloud not sure of it: it stays whole.
        if (at.copy !== null && (!isFile(at.copy) || isStandIn(at.copy, at.original))) continue;
        if (!mayGo(at.original, bytes)) continue;
      } else {
        // Gone already: what's missing is fetched only for a project in work, only where some of it is kept here.
        const lately = Math.max(opened[project.id] ?? 0, summary.modified_ms ?? 0);
        if (Date.now() - lately > IN_WORK_MS || !at.cells.some(isFile) || !cloud.enabled()) continue;
        try {
          input = await cloud.presign(footage.original, "GET", 6 * 3600, false, signal);
        } catch (error) {
          diag.warn("cache", `${name}: its used stretches weren't fetched (${diag.messageOf(error)}); an export fetches them`);
          continue;
        }
      }
      const before = at.cells.filter(isFile).length;
      try {
        await exportExcerpts.prepare(project, 0, ALL, cache, new Map([[footage.media, input]]), new Map([[footage.media, footage.original]]), () => signal?.aborted === true, {
          behindViewer: input !== at.original,
          ...(signal === undefined ? {} : { signal }),
        });
        if (at.sound !== null && !isFile(at.sound)) await soundCopy(cache, footage.original, input, signal);
      } catch (error) {
        if (signal?.aborted) break;
        diag.warn("cache", `${name}: keeping its used stretches: ${diag.scrub(diag.messageOf(error))}`);
        continue;
      }
      // Counted as Edit's own (ledger.ts), so the cleaner weighs them.
      for (const path of [...at.cells, ...(at.sound === null ? [] : [at.sound])]) if (isFile(path)) storage.ledger.note(path);
      const now = at.cells.filter(isFile).length;
      cut += now - before;
      diag.info(
        "cache",
        `${name}: its used stretches kept here (${now} of ${at.cells.length} cells${at.sound === null ? "" : isFile(at.sound) ? " and its sound" : ", its sound not"}), ${input === at.original ? "cut from its original here, which may now go for room" : "the missing ones fetched from the cloud"}`,
      );
    }
  }
  return cut;
}
