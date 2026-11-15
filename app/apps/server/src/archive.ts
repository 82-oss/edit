// Archived projects: a member
// archives an Edit project on Repack's Projects page to free its big files
// (Repack's server deletes its footage on R2 that no active project uses);
// this machine, hearing it, deletes the project's exports and its footage
// here, keeping the project and what was paid to hear and watch. A restore
// (on Repack, or the card's button here) brings the footage back from Drive
// and YouTube, under the same keys, so the edit is as it was.
//
// Cleared footage (Sphe, Nov 15): mamagi's footage sweep (footage.ts) clears
// the footage only a project uses once it's been Done and untouched for 30
// days, marking its row `footageCleared`. Opening it offers to bring the
// footage back (the editor's FootageBack): each source checked, the ones that
// can't be fetched named for a replacement link or left out, then each
// fetched again as its import did, into the same media, the progress as an
// import's. Done, the mark goes.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { deleteExport, listExports } from "./exports.ts";
import { writeAtomic } from "./files.ts";
import { ApiError } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import { join } from "./paths.ts";
import type { ScriptJob } from "./model.ts";
import { stableStringify } from "./stable.ts";
import * as scriptParts from "./script.ts";

/** How often the cloud's list is read for archives and restores. */
export const POLL_MS = 60_000;

/** What happened here to an archived project. */
export interface Here {
  /** When it was archived here (its files freed). */
  at: number;
  /** Bytes freed on this machine. */
  freed: number;
  /** A restore under way, or why the last one failed. */
  restoring?: boolean;
  error?: string;
  /** Media a restore couldn't bring back (from a disk). */
  lost?: string[];
}

function file(home: string): string {
  return join(home, "cloud", "archived.json");
}

export function archived(home: string): Record<string, Here> {
  try {
    return JSON.parse(fs.readFileSync(file(home), "utf8")) as Record<string, Here>;
  } catch {
    return {};
  }
}

function change(home: string, edit: (all: Record<string, Here>) => void): void {
  const all = archived(home);
  edit(all);
  fs.mkdirSync(join(home, "cloud"), { recursive: true });
  writeAtomic(file(home), JSON.stringify(all));
}

/** Frees an archived project here: its exports, then its footage and previews (cloud_media.archiveHere). */
export function archiveHere(app: App, id: string): number {
  const home = app.store.home;
  let freed = 0;
  for (const one of listExports(home, id)) {
    try {
      freed += one.missing ? 0 : (one.bytes ?? 0);
      deleteExport(home, id, one.path);
    } catch (error) {
      diag.warn("cloud", `archiving ${id}: ${one.path}: ${diag.messageOf(error)}`);
    }
  }
  freed += cloudMedia.archiveHere(app, id, new Set(Object.keys(archived(home))));
  change(home, (all) => {
    all[id] = { at: Date.now(), freed };
  });
  return freed;
}

const restoring = new Set<string>();

/** Brings an archived project's footage back (once at a time per project), then tells the cloud it's back. */
export async function restore(app: App, id: string): Promise<void> {
  if (restoring.has(id)) return;
  restoring.add(id);
  const home = app.store.home;
  change(home, (all) => {
    if (all[id] !== undefined) all[id] = { ...all[id]!, restoring: true, error: undefined };
  });
  try {
    const lost = await diag.timeOnAsync("cloud", "cloud: restore", id, () => cloudMedia.restoreHere(app, id));
    await cloud.mutation("edit:clearRestore", { projectId: id }).catch((error: unknown) => diag.warn("cloud", `restore of ${id}: telling the cloud: ${diag.messageOf(error)}`));
    change(home, (all) => {
      delete all[id];
    });
    void cloudMedia.ensureLocal(app, id).catch(() => {});
    diag.info("cloud", `${id}: restored${lost.length > 0 ? `; can't come back: ${lost.join(", ")}` : ""}`);
  } catch (error) {
    change(home, (all) => {
      if (all[id] !== undefined) all[id] = { ...all[id]!, restoring: false, error: diag.messageOf(error) };
    });
    diag.warn("cloud", `restoring ${id}: ${diag.messageOf(error)}`);
  } finally {
    restoring.delete(id);
  }
}

/** One look at the cloud's list: archives freed here, restores asked for started, cleared footage known. */
export async function poll(app: App): Promise<void> {
  const rows = (await cloud.query("edit:listProjects", {})) as { projectId?: string; archived?: unknown; restore?: unknown; footageCleared?: unknown }[];
  const here = archived(app.store.home);
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row.projectId;
    if (typeof id !== "string") continue;
    know(id, row.footageCleared);
    if (app.store.get(id) === null) continue;
    const isArchived = row.archived !== null && row.archived !== undefined;
    const asked = row.restore !== null && row.restore !== undefined;
    if (isArchived && here[id] === undefined && !asked) archiveHere(app, id);
    if (asked && here[id] !== undefined && here[id]!.restoring !== true) void restore(app, id);
    // Brought back from another machine: nothing archived here any more.
    if (!isArchived && !asked && here[id] !== undefined && here[id]!.restoring !== true) {
      change(app.store.home, (all) => {
        delete all[id];
      });
      cloudMedia.setNoFootage(app.store.home, id, false);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Follows archives and restores from the start, whenever the cloud is on (the sign-in is read after this runs; see reviews.start). */
export function start(app: App): void {
  if (timer !== null) return;
  const tick = () => {
    if (!cloud.enabled()) return;
    void poll(app).catch((error: unknown) => diag.warn("cloud", `following archives: ${diag.messageOf(error)}`));
  };
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  setTimeout(tick, 8_000).unref?.();
}

// ---------------------------------------------------------------------------
// Cleared footage, brought back.

/** What the footage sweep cleared of a project (mamagi's `footageCleared`, as its card shows it). */
export interface Cleared {
  at: number;
  media: { id: string; name: string; key: string; size: number; source: { kind: string; id: string; url?: string } }[];
}

/** The projects whose footage is cleared, as the cloud last said (the list every minute, a look on opening). */
const cleared = new Map<string, Cleared>();
/** Bringing footage back: each project's, while it runs and once it's ended (until it's opened again). */
const backJobs = new Map<string, ScriptJob>();

function know(id: string, value: unknown): void {
  const given = value as Partial<Cleared> | null | undefined;
  if (given !== null && given !== undefined && typeof given.at === "number" && Array.isArray(given.media)) cleared.set(id, { at: given.at, media: given.media });
  else cleared.delete(id);
}

/** A project's cleared footage, as last heard (the agent's note, the editor's dialog); null when it isn't cleared. */
export function clearedOf(id: string): Cleared | null {
  return cleared.get(id) ?? null;
}

/** Asks the cloud about `id` now (on opening); what it last said when it can't be reached. */
export async function lookUp(id: string): Promise<Cleared | null> {
  if (!cloud.enabled()) return null;
  try {
    const row = (await cloud.query("edit:getProject", { projectId: id })) as { footageCleared?: unknown } | null;
    know(id, row?.footageCleared);
  } catch (error) {
    diag.warn("cloud", `${id}: asking whether its footage was cleared: ${diag.messageOf(error)}`);
  }
  return clearedOf(id);
}

/** Whether `id`'s footage is coming back here now. */
export const backRunning = (id: string): boolean => running(id);

const running = (id: string) => {
  const job = backJobs.get(id);
  return job !== undefined && job.state !== "done" && job.state !== "failed";
};

function said(app: App, id: string, job: ScriptJob): void {
  backJobs.set(id, job);
  app.store.emit({ type: "script", id, job: structuredClone(job) });
}

/**
 * Brings `id`'s cleared footage back: each source fetched again from where
 * it came from, or from the link given for it in `replacements` (by source);
 * a source that can't be fetched and has none is left out (the person's "Go
 * on without them"). Once every one is back or left out, the cloud's mark
 * goes; one that failed keeps it, so opening the project offers it again.
 */
export async function bringBack(app: App, id: string, replacements: Record<string, string>, leftOut: Set<string>): Promise<void> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const groups = cloudMedia.footageBySource(live.project);
  const files: { source: string; file: string }[] = [];
  for (const source of groups.keys()) {
    const link = replacements[source]?.trim() ?? "";
    const file = link !== "" ? scriptParts.footageFile(link) : leftOut.has(source) ? null : cloudMedia.fileOfSource(source);
    if (link !== "" && file === null) throw new ApiError(400, `That isn't a link to one video: ${link}`);
    if (file !== null) files.push({ source, file });
  }
  const job: ScriptJob = { state: "downloading", back: true, files: files.map(({ source }) => ({ file: source, name: groups.get(source)![0]!.name, bytes: 0, state: "queued" })) };
  said(app, id, job);
  const fileOf = (source: string) => job.files.find((one) => one.file === source)!;
  let last = 0;
  try {
    await cloudMedia.fetchFootageAgain(app, id, files, (source, now) => {
      const file = fileOf(source);
      if (now.state === "downloading") Object.assign(file, { state: "downloading", bytes: now.bytes, ...(now.total !== null ? { total: now.total } : {}) });
      else if (now.state === "cutting") Object.assign(file, { state: "cutting", cut: { done: now.done, total: now.total } });
      else if (now.state === "done") Object.assign(file, { state: "done", ...(file.total !== undefined ? { bytes: file.total } : {}) });
      else Object.assign(file, { state: "failed", error: now.error });
      // Bytes a few times a second at most; every change of state at once.
      if (now.state !== "downloading" || Date.now() - last > 250) {
        last = Date.now();
        said(app, id, job);
      }
    });
  } catch (error) {
    said(app, id, { ...job, state: "failed", error: diag.messageOf(error) });
    throw error;
  }
  const failed = job.files.filter((one) => one.state === "failed");
  if (failed.length > 0) {
    said(app, id, { ...job, state: "failed", error: failed.length === 1 ? `${failed[0]!.name}: ${failed[0]!.error ?? "it couldn't be fetched"}` : `${failed.length} files couldn't be fetched: open the project again to try them again.` });
    return;
  }
  await cloud.mutation("edit:clearRestore", { projectId: id });
  cleared.delete(id);
  diag.info("cloud", `${id}: its cleared footage is back (${files.length} sources${leftOut.size > 0 ? `, ${leftOut.size} left out` : ""})`);
  said(app, id, { ...job, state: "done" });
  void cloudMedia.ensureLocal(app, id).catch(() => {});
}

export function routes(router: Router<App>): void {
  // Opening a project: whether its footage was cleared, and its bringing back if that's going (or ended) here.
  router.get("/api/projects/{id}/footage", async ({ app, params }) => {
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    const job = backJobs.get(id) ?? null;
    if (job !== null && !running(id)) backJobs.delete(id);
    return new Response(stableStringify({ cleared: running(id) ? clearedOf(id) : await lookUp(id), job }), { headers: { "content-type": "application/json" } });
  });
  // The footage that can't be fetched again as it was (asked before bringing it back).
  router.post("/api/projects/{id}/footage/check", async ({ app, params }) => {
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    return new Response(stableStringify({ missing: await cloudMedia.unfetchable(app, id) }), { headers: { "content-type": "application/json" } });
  });
  // Bring the footage back: `replacements` (a link by source), `leave` (the sources to go on without).
  router.post("/api/projects/{id}/footage/back", async (context) => {
    const { app, params } = context;
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    if (running(id)) throw new ApiError(409, "Its footage is already coming back.");
    try {
      await app.store.mayWrite(id);
    } catch (error) {
      throw new ApiError(423, diag.messageOf(error));
    }
    const given = ((await readJson(context)) ?? {}) as { replacements?: unknown; leave?: unknown };
    const replacements = typeof given.replacements === "object" && given.replacements !== null ? (Object.fromEntries(Object.entries(given.replacements).filter(([, url]) => typeof url === "string")) as Record<string, string>) : {};
    const leave = new Set(Array.isArray(given.leave) ? given.leave.filter((one): one is string => typeof one === "string") : []);
    for (const url of Object.values(replacements)) if (url.trim() !== "" && scriptParts.footageFile(url.trim()) === null) throw new ApiError(400, "Give a link to one video: a Google Drive file or a YouTube video.");
    void bringBack(app, id, replacements, leave).catch((error: unknown) => diag.warn("cloud", `${id}: bringing its footage back: ${diag.messageOf(error)}`));
    return new Response(stableStringify({ started: true }), { headers: { "content-type": "application/json" } });
  });
  router.get("/api/archived", ({ app }) => new Response(stableStringify(archived(app.store.home)), { headers: { "content-type": "application/json" } }));
  router.post("/api/projects/{id}/restore", ({ app, params }) => {
    const id = params.id ?? "";
    if (archived(app.store.home)[id] === undefined) throw new ApiError(400, "this project isn't archived");
    void restore(app, id);
    return new Response(stableStringify({ started: true }), { headers: { "content-type": "application/json" } });
  });
}
