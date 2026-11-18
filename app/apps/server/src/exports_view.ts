// Home's Exports (Sphe, Nov 18, in Later's place): this computer's exports
// whose files are still here, across its projects, and when this computer's
// person last opened the Exports view. What finished since then is the view's
// Exported and its project's "Exported" on Home, until the view is opened
// again (opening the project doesn't clear it). Exports are this computer's,
// so the mark is too: kept beside them, never in the browser or the cloud.
//
//   GET  /api/exports/list     {viewed_ms, exports}: every export here whose file is (newest first)
//   POST /api/exports/viewed   {viewed_ms}: the view opened (or left) now

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { writeAtomic } from "./files.ts";
import { json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import { homePath, join } from "./paths.ts";
import * as reviews from "./reviews.ts";

const VIEWED = "exports-viewed.json";

/** An export as the view lists it. */
export interface Exported {
  project: string;
  /** The project's name now (else the file's). */
  name: string;
  path: string;
  /** `path` with the home folder as `~`. */
  shown: string;
  finished_ms: number;
  /** The video's length (seconds), and whether it's the whole edit. */
  seconds: number;
  whole: boolean;
  bytes: number;
  /** The project's channel (V2's), for its picture. */
  channel: string | null;
  /** It's a version on the project's review link. */
  on_review: boolean;
}

/** exports.json as exports.ts keeps it: each project's records, oldest first. */
type Records = Record<string, { path: string; name: string; finished_ms: number; frames: number; whole?: boolean }[]>;

function records(home: string): Records {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, "exports.json"), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Records) : {};
  } catch {
    return {};
  }
}

/**
 * When the view was last opened. The first ask (an Edit from before the
 * view) starts it now, so exports made before don't all turn up as new.
 */
export function viewedAt(home: string, now = Date.now()): number {
  try {
    const at = (JSON.parse(fs.readFileSync(join(home, VIEWED), "utf8")) as { at?: unknown }).at;
    if (typeof at === "number" && Number.isFinite(at)) return at;
  } catch {
    // None yet.
  }
  return markViewed(home, now);
}

/** The view was opened (or left) at `now`: what finished before isn't new any more. */
export function markViewed(home: string, now = Date.now()): number {
  writeAtomic(join(home, VIEWED), JSON.stringify({ at: now }));
  return now;
}

/** Every export on this computer whose file is still here, newest first (a file gone is never listed). */
export function exportsHere(app: App): Exported[] {
  const home = app.store.home;
  const shared = reviews.read(home).shared;
  const out: Exported[] = [];
  const seen = new Set<string>();
  for (const [project, own] of Object.entries(records(home))) {
    if (!Array.isArray(own)) continue;
    const live = app.store.get(project)?.project ?? null;
    const fps = live?.settings.fps ?? 30;
    const onReview = new Set((shared[project]?.versions ?? []).map((version) => version.path));
    for (const record of own) {
      if (typeof record?.path !== "string" || seen.has(record.path)) continue;
      let bytes: number;
      try {
        const stat = fs.statSync(record.path);
        if (!stat.isFile()) continue;
        bytes = stat.size;
      } catch {
        continue;
      }
      seen.add(record.path);
      out.push({
        project,
        name: live?.name ?? record.name,
        path: record.path,
        shown: homePath(record.path),
        finished_ms: record.finished_ms,
        seconds: Math.round((record.frames ?? 0) / fps),
        whole: record.whole !== false,
        bytes,
        channel: typeof live?.channel === "string" && live.channel !== "" ? live.channel : null,
        on_review: onReview.has(record.path),
      });
    }
  }
  return out.sort((a, b) => b.finished_ms - a.finished_ms);
}

/** The projects with a whole export here finished since the view was last opened: Home's "Exported" on their rows. */
export function exportedSince(app: App): Set<string> {
  const since = viewedAt(app.store.home);
  return new Set(exportsHere(app).flatMap((one) => (one.whole && one.finished_ms > since ? [one.project] : [])));
}

export function routes(router: Router<App>): void {
  router
    .get("/api/exports/list", ({ app }) => json({ viewed_ms: viewedAt(app.store.home), exports: exportsHere(app) }))
    .post("/api/exports/viewed", ({ app }) => json({ viewed_ms: markViewed(app.store.home) }));
}
