// Footage that didn't come in (Sphe, Nov 18: "an import never stops or asks a
// question because of one file, and missing footage is never silently written
// around"). An import carries on past a recording that fails (imports.ts
// `stillMissing`); each one is tried again here by itself, after 1, 5 and 15
// minutes, then hourly, and joined into the case when it comes (imports.ts
// `rejoin`: its piece copied into the preview, heard, the voices read again).
// Until it's here, or the producer goes on without it (remembered in the
// case's list, never asked again), the script isn't written: a build waits
// (`firstBuild`) and starts by itself, and the writer is told what's missing.

import * as fs from "node:fs";

import type { Choice, MissingRecording, Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import * as jobs from "./jobs.ts";
import * as parts from "./parts.ts";
import * as store from "./store.ts";

/** How long after each try the next one is: 1, 5, 15 minutes, then every hour. */
const DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const HOURLY_MS = 60 * 60_000;

export const delayAfter = (tries: number): number => DELAYS_MS[tries] ?? HOURLY_MS;

/** Each script's next try, here; one timer wakes for the soonest. */
const due = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let started: { app: App; data: string } | null = null;
/** Scripts being tried now. */
const trying = new Set<string>();

/** Script `id` has footage to try again at `at` (the soonest of its recordings). */
export function schedule(id: string, at: number): void {
  const known = due.get(id);
  if (known === undefined || at < known) due.set(id, at);
  wake();
}

function wake(): void {
  if (started === null) return;
  clearTimeout(timer);
  if (due.size === 0) return;
  const soonest = Math.min(...due.values());
  timer = setTimeout(() => void tick(), Math.max(0, Math.min(soonest - Date.now(), HOURLY_MS)));
  timer.unref?.();
}

async function tick(): Promise<void> {
  const now = Date.now();
  const ready = [...due.entries()].filter(([, at]) => at <= now).map(([id]) => id);
  for (const id of ready) due.delete(id);
  await Promise.all(ready.map((id) => tryAgain(id)));
  wake();
}

/**
 * Starts the tries with the server: each script here with footage missing is
 * tried when it's due, and an import an older Edit stopped on "some
 * recordings couldn't be imported" carries on as one would now (its failed
 * recordings missing, the rest of the import run).
 */
export function start(app: App, data: string): void {
  started = { app, data };
  const older: string[] = [];
  for (const id of store.ids(data)) {
    let script: Script;
    try {
      script = store.read(store.scriptDir(data, id));
    } catch {
      continue;
    }
    if (script.status === "needs_choice" && script.decision?.kind === "failed_recordings") older.push(id);
    else if ((script.missing ?? []).length > 0 && hasList(store.scriptDir(data, id), script)) schedule(id, Math.min(...script.missing!.map((one) => one.nextAt)));
  }
  wake();
  if (older.length > 0) void carryOnOlder(app, data, older);
}

/**
 * Footage is tried only on the computer whose import left it missing, which
 * keeps its pieces for the join: marked by a dot file, which never syncs (the
 * script and its list do, so another Mac sees the note but doesn't join).
 */
const HERE = ".missing-here";

export function markHere(dir: string, missing: boolean): void {
  if (missing) fs.writeFileSync(join(dir, HERE), "");
  else fs.rmSync(join(dir, HERE), { force: true });
}

function hasList(dir: string, script: Script): boolean {
  const listed = script.sourceKind === "compilation" ? parts.readVideos(dir) !== null : parts.readManifest(dir) !== null;
  return listed && fs.existsSync(join(dir, HERE));
}

/** Imports an older Edit paused on failed recordings, run again: what failed is tried with the rest and, failing, missing. */
async function carryOnOlder(app: App, data: string, ids: string[]): Promise<void> {
  const imports = await import("./imports.ts");
  for (const id of ids) {
    try {
      diag.info("writer", `${id}: its import waited on recordings that failed; it carries on without them now, and they're tried again by themselves`);
      await imports.resume(app, data, id, { kind: "retry" }, "started");
    } catch (error) {
      diag.warn("writer", `${id}: the import waiting on failed recordings didn't carry on: ${diag.messageOf(error)}`);
    }
  }
}

/**
 * Tries script `id`'s recordings that are due. Each that comes is joined into
 * the case (a fresh run of its import); each that doesn't is tried again
 * later, its error kept. Nothing runs beside the script's import or Claude.
 */
export async function tryAgain(id: string, all = false): Promise<void> {
  if (started === null || trying.has(id)) return;
  const { app, data } = started;
  const imports = await import("./imports.ts");
  const dir = store.scriptDir(data, id);
  if (imports.importing(id) || jobs.running(id)) {
    schedule(id, Date.now() + 60_000);
    return;
  }
  let script: Script;
  try {
    script = store.read(dir);
  } catch {
    return;
  }
  if (!hasList(dir, script)) return;
  const now = Date.now();
  const missing = script.missing ?? [];
  const wanted = missing.filter((one) => all || one.nextAt <= now);
  if (wanted.length === 0) {
    if (missing.length > 0) schedule(id, Math.min(...missing.map((one) => one.nextAt)));
    return;
  }
  trying.add(id);
  const arrived: string[] = [];
  const tried = new Map<string, MissingRecording>();
  try {
    for (const one of wanted) {
      try {
        await imports.fetchMissing(app, dir, script, one.id);
        arrived.push(one.id);
        diag.info("writer", `${jobs.named(id, script.title)}: ${one.title} came in on try ${one.tries + 2}`);
      } catch (error) {
        const tries = one.tries + 1;
        tried.set(one.id, { ...one, tries, error: diag.scrub(diag.messageOf(error)), nextAt: Date.now() + delayAfter(tries) });
        diag.warn("writer", `${jobs.named(id, script.title)}: ${one.title} still didn't come in (try ${tries + 1}): ${diag.messageOf(error)}; next try in ${Math.round(delayAfter(tries) / 60_000)} min`);
      }
    }
  } finally {
    trying.delete(id);
  }
  // Only the tries are written here: the rest of the script is as it is now.
  if (tried.size > 0) {
    try {
      script = store.update(dir, (fresh) => {
        if (fresh.missing) fresh.missing = fresh.missing.map((one) => tried.get(one.id) ?? one);
      }, true);
    } catch (error) {
      diag.warn("writer", `${id}: its footage's tries weren't saved: ${diag.messageOf(error)}`);
    }
  }
  if (arrived.length > 0) {
    try {
      imports.rejoin(app, data, id, arrived);
    } catch (error) {
      diag.warn("writer", `${jobs.named(id, script.title)}: what came in wasn't joined into the case yet: ${diag.messageOf(error)}`);
      schedule(id, Date.now() + delayAfter(0));
      return;
    }
  }
  const left = (script.missing ?? []).filter((one) => !arrived.includes(one.id));
  if (left.length > 0) schedule(id, Math.min(...left.map((one) => tried.get(one.id)?.nextAt ?? one.nextAt)));
}

/**
 * The note's two answers: Retry now (every missing recording tried at once,
 * in the background), or Go on without it (confirmed on the page): left out
 * of the case for good, remembered in its list so it's never asked again,
 * and a build that waited starts.
 */
export async function answer(app: App, data: string, id: string, choice: Choice & { kind: "retry_missing" | "skip_missing" }): Promise<Script> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (choice.kind === "retry_missing") {
    if ((script.missing ?? []).length === 0) return script;
    void tryAgain(id, true);
    return script;
  }
  const imports = await import("./imports.ts");
  if (imports.importing(id) || trying.has(id)) throw new Error("Edit is bringing this footage in right now. Try again in a moment.");
  const one = (script.missing ?? []).find((item) => item.id === choice.id);
  if (one === undefined) return script;
  if (script.sourceKind === "compilation") {
    const videos = parts.readVideos(dir);
    if (videos !== null) parts.writeVideos(dir, { ...videos, missing: (videos.missing ?? []).filter((item) => item !== one.id), skipped: [...new Set([...videos.skipped, one.id])] });
  } else {
    const manifest = parts.readManifest(dir);
    if (manifest !== null) parts.writeManifest(dir, { ...manifest, missing: (manifest.missing ?? []).filter((item) => item !== one.id), skipped: [...new Set([...manifest.skipped, one.id])] });
  }
  const saved = store.update(dir, (fresh) => {
    const left = (fresh.missing ?? []).filter((item) => item.id !== one.id);
    if (left.length > 0) fresh.missing = left;
    else delete fresh.missing;
    fresh.notes ??= [];
    const said = leftOutNote(one.title);
    if (!fresh.notes.includes(said)) fresh.notes.push(said);
  }, true);
  diag.info("writer", `${jobs.named(id, saved.title)}: going on without ${one.title}, as asked`);
  if ((saved.missing ?? []).length === 0) {
    due.delete(id);
    markHere(dir, false);
    // Nothing more to join: the pieces kept for it go.
    fs.rmSync(join(dir, "pieces"), { recursive: true, force: true });
    imports.buildIfWaiting(app, data, saved);
  }
  return saved;
}

const LEFT_OUT = "Left out at the producer's word: ";
const leftOutNote = (title: string): string => `${LEFT_OUT}${title} didn't come in.`;

/**
 * What the writer is told of footage not in the case: what's still missing,
 * and what the producer went on without, so it never writes around a gap
 * without saying so. Empty when the case is whole.
 */
export function forWriter(script: Script): string {
  const missing = (script.missing ?? []).map((one) => one.title);
  const leftOut = (script.notes ?? []).filter((note) => note.startsWith(LEFT_OUT)).map((note) => note.slice(LEFT_OUT.length).replace(/ didn't come in\.$/u, ""));
  if (missing.length === 0 && leftOut.length === 0) return "";
  const lines: string[] = [];
  if (missing.length > 0) lines.push(`Not in the footage yet: ${missing.join(", ")} didn't come in, and Edit is still trying to bring ${missing.length === 1 ? "it" : "them"} in.`);
  if (leftOut.length > 0) lines.push(`Not in the footage: the producer went on without ${leftOut.join(", ")}, which didn't come in.`);
  lines.push("Don't write around the gap as if the case were whole: where the story needs what's missing, say so in your answer.");
  return lines.join(" ");
}

/** Missing footage said in a line, for a refusal: "1 recording didn't come in: CH03.avi". */
export function line(script: Script): string {
  const missing = script.missing ?? [];
  const what = script.sourceKind === "compilation" ? (missing.length === 1 ? "video" : "videos") : missing.length === 1 ? "recording" : "recordings";
  return `${missing.length} ${what} didn't come in: ${missing.map((one) => one.title).join(", ")}`;
}

/** Stops the tries (tests). */
export function stop(): void {
  clearTimeout(timer);
  due.clear();
  started = null;
}
