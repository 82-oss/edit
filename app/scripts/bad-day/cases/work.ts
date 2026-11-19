// What the change 7 cases share: an editor project made from a pasted script,
// a Script mode case, the job table read from disk, an export, a share, a
// restart, and check 7 (the same saved edit gives the same video).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Clip } from "../footage.ts";
import type { Context } from "./index.ts";

export const KBIT = 1000 / 8;

// ── The job table, read as Edit wrote it ──

export interface Row {
  key: string;
  kind: string;
  project: string;
  state: string;
  step?: string;
  attempts?: number;
  retry_at?: number;
  until?: string;
  put_off?: number;
  why?: string;
  error?: string;
  given_up?: string;
  args?: Record<string, unknown>;
  updated_ms?: number;
}

export function rows(context: Context): Row[] {
  try {
    return JSON.parse(fs.readFileSync(join(context.home, "jobs.json"), "utf8")) as Row[];
  } catch {
    return [];
  }
}

export const live = (row: Row) => row.state === "queued" || row.state === "running" || row.state === "waiting";

export function describeRows(list: Row[]): string {
  return list.map((row) => `${row.key} ${row.state}${row.step ? `/${row.step}` : ""}${row.until ? ` until ${row.until}` : ""}${row.retry_at ? ` at +${Math.round((row.retry_at - Date.now()) / 1000)} s` : ""}${row.error || row.why ? ` (${(row.error ?? row.why ?? "").slice(0, 120)})` : ""}`).join("; ");
}

// ── The editor's import ──

export interface FileRow {
  file: string;
  name?: string;
  state: string;
  error?: string;
  why?: string;
  tries?: number;
  retry_at?: number;
}

export interface ScriptJob {
  state: string;
  error?: string;
  files: FileRow[];
}

interface Block {
  kind: string;
  file?: string;
  start?: number;
  end?: number;
  notes?: string[];
}

export interface Project {
  id: string;
  name?: string;
  settings?: { fps?: number };
  script?: { blocks?: Block[] };
  clips?: { start: number; duration: number }[];
  media?: { id: string; name?: string }[];
}

const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** A project whose pasted script cuts `ranges` from files on the stand-in Drive, started as the page does. */
export async function editorImport(context: Context, files: { id: string; clip: Clip; ranges: [number, number][] }[], name = "Bad day"): Promise<string> {
  const { cloud, edit } = context;
  const lines: string[] = [];
  for (const { id, clip, ranges } of files) {
    cloud.addFile("1BadDayEditorFolder00000007", id, clip);
    for (const [from, to] of ranges) {
      lines.push(`[${stamp(from)}-${stamp(to)}](https://drive.google.com/file/d/${id}/view)`);
      lines.push("On July 13 police in Kent were called to a crash on the highway near the old mill.");
    }
  }
  const made = await edit.api<{ project: Project }>("POST", "/api/projects", { name, style: "shorts" });
  if (made.status !== 200) throw new Error(`making the project answered ${made.status}: ${made.text.slice(0, 300)}`);
  const project = made.body.project.id;
  const started = await edit.api("POST", `/api/projects/${project}/script`, { url: lines.join("\n") });
  if (started.status !== 200) throw new Error(`starting the import answered ${started.status}: ${started.text.slice(0, 300)}`);
  context.log(`editor import started: project ${project} (${name})`);
  return project;
}

export async function job(context: Context, project: string): Promise<ScriptJob | null> {
  const answer = await context.edit.api<{ job: ScriptJob | null }>("GET", `/api/projects/${project}/script/job`);
  return answer.body?.job ?? null;
}

export async function project(context: Context, id: string): Promise<Project> {
  return (await context.edit.api<{ project: Project }>("GET", `/api/projects/${id}`)).body.project;
}

export function describeJob(one: ScriptJob | null): string {
  if (one === null) return "no job";
  const files = one.files.map((file) => `${file.name ?? file.file.slice(0, 14)} ${file.state}${file.tries ? ` tries ${file.tries}` : ""}${file.error ? ` (${file.error.slice(0, 120)})` : ""}`).join("; ");
  return `job ${one.state}${one.error ? ` "${one.error.slice(0, 160)}"` : ""}: ${files}`;
}

/** The ranges as the script holds them and how many are gone without: what check 2 compares. */
export function shape(one: Project): { ranges: string; gone: number; seconds: number } {
  const blocks = (one.script?.blocks ?? []).filter((block) => block.kind === "footage");
  const ranges = blocks.map((block) => `${block.file}:${block.start}-${block.end}`).join(",");
  const gone = blocks.filter((block) => (block.notes ?? []).some((note) => /^Gone without/.test(note))).length;
  const frames = (one.clips ?? []).reduce((most, clip) => Math.max(most, clip.start + clip.duration), 0);
  return { ranges, gone, seconds: frames / (one.settings?.fps ?? 30) };
}

export async function importDone(context: Context, id: string, ms: number): Promise<ScriptJob | null> {
  return context.waitFor("the import done", async () => {
    const one = await job(context, id);
    return one?.state === "done" ? one : null;
  }, ms);
}

// ── Script mode ──

export interface Script {
  id: string;
  status: string;
  stage?: string;
  error: string | null;
  missing?: { id: string; title: string; error: string; tries: number; nextAt: number }[];
  parts?: { title: string }[];
}

export async function scriptImport(context: Context, folder: string, files: { id: string; clip: Clip }[]): Promise<string> {
  for (const { id, clip } of files) context.cloud.addFile(folder, id, clip);
  const started = await context.edit.api<Script>("POST", "/api/writer/scripts/drive", { url: `https://drive.google.com/drive/folders/${folder}` });
  if (started.status !== 200 || typeof started.body?.id !== "string") throw new Error(`starting the Script import answered ${started.status}: ${started.text.slice(0, 300)}`);
  context.log(`Script import started: script ${started.body.id}`);
  return started.body.id;
}

export async function script(context: Context, id: string): Promise<Script | null> {
  const answer = await context.edit.api<Script>("GET", `/api/writer/scripts/${id}`);
  return answer.status === 200 ? answer.body : null;
}

export function describeScript(one: Script | null): string {
  if (one === null) return "no script";
  const missing = (one.missing ?? []).map((item) => `${item.title} (tries ${item.tries}: ${item.error.slice(0, 100)})`).join(", ");
  return `status ${one.status}${one.stage ? `/${one.stage}` : ""}${one.error ? `, error "${one.error.slice(0, 160)}"` : ""}, ${one.parts?.length ?? 0} part(s)${missing ? `, missing ${missing}` : ""}`;
}

export const whole = (one: Script | null) => one !== null && one.status === "ready" && (one.missing ?? []).length === 0;

// ── Exports and shares ──

export interface Exported {
  path: string;
  name: string;
  frames: number;
  whole: boolean;
  timeline?: string;
  cloudKey?: string;
  finished_ms: number;
}

export async function exportsOf(context: Context, id: string): Promise<Exported[]> {
  const answer = await context.edit.api<Exported[]>("GET", `/api/projects/${id}/exports`);
  return Array.isArray(answer.body) ? answer.body : [];
}

/** Starts an export of the edit as it is (the Export button); `keepLocal` keeps its file here (no copy for the cloud). */
export async function startExport(context: Context, id: string, file: string, keepLocal: boolean): Promise<void> {
  const path = join(context.home, "exports-here", file);
  fs.mkdirSync(join(context.home, "exports-here"), { recursive: true });
  const answer = await context.edit.api("POST", `/api/projects/${id}/export`, { path, ...(keepLocal ? { keepLocal: true } : {}) });
  if (answer.status !== 200) throw new Error(`the export answered ${answer.status}: ${answer.text.slice(0, 300)}`);
  context.log(`export of ${id} started (${file}${keepLocal ? ", kept here" : ""})`);
}

/** The export named `file` once it's listed, done. */
export async function exported(context: Context, id: string, file: string, ms: number): Promise<Exported | null> {
  return context.waitFor(`the export ${file}`, async () => (await exportsOf(context, id)).find((one) => one.name === file || one.path.endsWith(`/${file}`)) ?? null, ms);
}

/** Where an export's file is now: here, or the cloud's copy (the archive deletes it here once it's up). */
export function fileOf(context: Context, one: Exported): string | null {
  if (fs.existsSync(one.path)) return one.path;
  if (one.cloudKey !== undefined) {
    const objects = context.cloud.mock.cloud.objects as unknown as { pathOf(key: string): string; has(key: string): boolean };
    if (objects.has(one.cloudKey)) return objects.pathOf(one.cloudKey);
  }
  return null;
}

export async function startShare(context: Context, id: string): Promise<void> {
  const answer = await context.edit.api("POST", `/api/projects/${id}/share`, {});
  if (answer.status !== 200) throw new Error(`Share answered ${answer.status}: ${answer.text.slice(0, 300)}`);
  context.log(`share of ${id} started`);
}

export function shareRow(context: Context, id: string): Row | undefined {
  return rows(context).find((row) => row.kind === "share" && row.project === id);
}

/** The share's link, once it's up (its row done with what it published). */
export function shareLink(context: Context, id: string): string | null {
  const row = shareRow(context, id);
  const published = row?.args?.published as { url?: string } | undefined;
  return row?.state === "done" && typeof published?.url === "string" ? published.url : null;
}

// ── Edit itself ──

/** Killed (SIGKILL to its group) and started again, as after a crash; resolves once it's up (and signed in, when the line lets it). */
export async function restart(context: Context, why: string): Promise<void> {
  context.log(`kill: ${why}`);
  await context.edit.kill();
  await context.edit.start();
  await context.waitFor("Edit signed in after the restart", async () => (await context.edit.api<{ signed_in: boolean }>("GET", "/api/account")).body.signed_in === true || null, context.line.state === "up" ? 30_000 : 1000);
  context.log(`Edit up again (start ${context.edit.starts})`);
}

/** `test`, every `every` ms, until true or `ms` passes; whether it came true. */
export async function until(context: Context, test: () => boolean | Promise<boolean>, ms: number, every = 200): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await test()) return true;
    } catch {}
    await context.sleep(every);
  }
  return false;
}

// ── Check 7: the same saved edit gives the same video ──

interface Look {
  frames: number;
  fps: number;
}

function look(path: string): Look | null {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets,r_frame_rate", "-of", "json", path], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const stream = (JSON.parse(probe.stdout) as { streams?: { nb_read_packets?: string; r_frame_rate?: string }[] }).streams?.[0];
  if (stream === undefined) return null;
  const [num, den] = (stream.r_frame_rate ?? "30/1").split("/").map(Number);
  return { frames: Number(stream.nb_read_packets ?? 0), fps: (num ?? 30) / (den || 1) };
}

/** Frame `n` of `path`, 64 pixels wide and grey (enough to tell one picture from another, not an encoder's noise). */
function still(path: string, n: number): Buffer | null {
  const run = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", path, "-vf", `select=eq(n\\,${n}),scale=64:-2,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
  return run.status === 0 && run.stdout.length > 0 ? run.stdout : null;
}

/** Check 7: `after` has `before`'s frame count and its first, middle and last frames (mean difference under 3 of 255). */
export function sameVideo(context: Context, label: string, before: string | null, after: string | null): void {
  if (before === null || after === null) {
    context.check(`check 7: ${label} gives the same video`, false, `no file to compare (${before === null ? "the first export's" : "the second export's"} is gone)`);
    return;
  }
  const a = look(before);
  const b = look(after);
  if (a === null || b === null) {
    context.check(`check 7: ${label} gives the same video`, false, `couldn't read ${a === null ? before : after}`);
    return;
  }
  const picks = [0, Math.floor(a.frames / 2), a.frames - 1];
  const differences = picks.map((n) => {
    const x = still(before, n);
    const y = still(after, n);
    if (x === null || y === null || x.length !== y.length) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += Math.abs(x[i]! - y[i]!);
    return sum / x.length;
  });
  const ok = a.frames === b.frames && differences.every((one) => one < 3);
  context.check(
    `check 7: ${label} gives the same video`,
    ok,
    `${a.frames} → ${b.frames} frames; first/middle/last frames differ by ${differences.map((one) => (Number.isFinite(one) ? one.toFixed(2) : "unreadable")).join(" / ")} of 255`,
  );
}

/** Every file under a folder with its size and time: what was rendered (the export's chunks). */
export function filesUnder(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (at: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        try {
          const stat = fs.statSync(path);
          found.set(path, `${stat.size}@${Math.round(stat.mtimeMs)}`);
        } catch {}
      }
    }
  };
  walk(dir);
  return found;
}

/** Lines of Edit's own log that match, from `since` (a length of the log read before). */
export function logSince(context: Context, since: number, pattern: RegExp): string[] {
  return context.edit.log().slice(since).split("\n").filter((line) => pattern.test(line));
}
