// Each Mac's log, its crashes and a note when Edit stopped without quitting,
// kept in the team's cloud as they happen, so an admin reads them from here
// with that Mac off or Edit closed (Sphe, Nov 15: "we've had many issues where
// X person's Mac is now off or closed the app so we can't pull logs from it").
// Every five minutes the log written since the last send goes up, scrubbed
// and gzipped, as one chunk; once more at start (what the last run left) and
// on the way out (within `timing.quitMs`). Under edit/reports/, so anyone
// signed in writes and only an admin reads or lists (the relay's authz.ts);
// R2 keeps them 30 days (a lifecycle rule on each prefix). Read with
// scripts/remote.ts `logs` and `crashes`.

import * as fs from "node:fs";
import * as os from "node:os";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import * as lastRun from "./last_run.ts";
import { join } from "./paths.ts";
import { slug } from "./problem_reports.ts";
import { BUILD } from "./version.ts";

/** `<mac>/<day>/<time>.log.gz`: a chunk of that Mac's log, sent at that time (UTC). */
export const LOGS = "edit/reports/logs/";
/** `<mac>/<day>/<time>-<name>.gz`: a crash report macOS wrote, or `…-stopped.txt.gz`, Edit's note of a run that stopped without quitting. */
export const CRASHES = "edit/reports/crashes/";
/** A chunk is at most this much of the log; past it, the newest part goes and the chunk says how much was left out. */
export const MAX_CHUNK = 5 << 20;
const MAX_CRASH = 2 << 20;
/** On the first look, crash reports this recent are sent. */
const CRASH_DAYS = 7;
const DAY = 86_400_000;

/** What tests change. */
export const timing = { quitMs: 3_000, putMs: 60_000, warnEveryMs: 60 * 60_000 };

/** Where the log was sent up to: its file (the inode, which stays with it when it's set aside as edit.log.1…) and the byte after. */
export interface Mark {
  ino: number;
  offset: number;
}

/** What's been sent, kept in `<home>/logs/shipped.json` across restarts. */
interface Shipped {
  log: Mark | null;
  /** The crash reports sent (their file names), the latest 200. */
  crashes: string[];
  /** When the crash reports were last looked at. */
  crashesAt: number | null;
}

function statePath(home: string): string {
  return join(home, "logs", "shipped.json");
}

function readState(home: string): Shipped {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(home), "utf8")) as Partial<Shipped>;
    const log = value.log;
    return {
      log: log !== null && typeof log === "object" && typeof log.ino === "number" && typeof log.offset === "number" ? { ino: log.ino, offset: log.offset } : null,
      crashes: Array.isArray(value.crashes) ? value.crashes.filter((name): name is string => typeof name === "string") : [],
      crashesAt: typeof value.crashesAt === "number" ? value.crashesAt : null,
    };
  } catch {
    return { log: null, crashes: [], crashesAt: null };
  }
}

function writeState(home: string, state: Shipped): void {
  fs.mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  writeAtomic(statePath(home), JSON.stringify(state), 0o600);
}

// ---------------------------------------------------------------- names

/** A moment as it's named in keys: ISO 8601 in UTC with `-` for `:` (`2026-11-15T10-05-00.123Z`). */
export function timeName(at: number): string {
  return new Date(at).toISOString().replace(/:/g, "-");
}

/** Where a chunk of `machine`'s log sent at `at` goes. */
export function chunkKey(machine: string, at: number): string {
  const time = timeName(at);
  return `${LOGS}${slug(machine)}/${time.slice(0, 10)}/${time}.log.gz`;
}

/** Where a crash report (or the stopped note, `stopped.txt`) from `machine` goes, named by when it was written. */
export function crashKey(machine: string, at: number, name: string): string {
  const time = timeName(at);
  return `${CRASHES}${slug(machine)}/${time.slice(0, 10)}/${time}-${name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120)}.gz`;
}

/** When a chunk's or crash's key says it was sent or written (ms), or null when it isn't one of these. */
export function keyTime(key: string): number | null {
  const found = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)(\.\d{3})?Z/.exec(key.slice(key.lastIndexOf("/") + 1));
  if (found === null) return null;
  const at = Date.parse(`${found[1]}T${found[2]}:${found[3]}:${found[4]}${found[5] ?? ""}Z`);
  return Number.isFinite(at) ? at : null;
}

/** This Mac's offset from UTC at `at`, as `+02:00`. */
export function utcOffset(at: number): string {
  const minutes = -new Date(at).getTimezoneOffset();
  const whole = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- the log since the last send

/** The log since `mark`: its bytes (whole lines), how much was left out to stay under `max`, why, and the mark after. */
export interface Collected {
  bytes: Buffer;
  skipped: number;
  why: string[];
  next: Mark;
}

/**
 * The log in `dir` written since `mark`, oldest first: the rest of the file
 * the mark was in (set aside as edit.log.N since), the files set aside after
 * it, then edit.log. A log cut short starts again from its beginning; one set
 * aside more often than it's kept is sent from what's left. At most `max`
 * bytes, the newest, and only whole lines (one being written waits for the
 * next send). Null when there's no log.
 */
export function collect(dir: string, mark: Mark | null, max = MAX_CHUNK, kept = diag.rotation.kept): Collected | null {
  const path = join(dir, "edit.log");
  let fd: number;
  try {
    fd = fs.openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    const why: string[] = [];
    const parts: { path: string; fd: number | null; from: number; to: number }[] = [];
    let from = 0;
    if (mark !== null && mark.ino === stat.ino) {
      if (stat.size >= mark.offset) from = mark.offset;
      else why.push(`the log was cut short since the last send (${mark.offset} bytes, now ${stat.size}): sent from its start`);
    } else if (mark !== null) {
      // Set aside since: edit.log.1 is the newest of those.
      const aside: { path: string; size: number; ino: number }[] = [];
      for (let n = 1; n <= kept; n++) {
        try {
          const one = fs.statSync(`${path}.${n}`);
          aside.push({ path: `${path}.${n}`, size: one.size, ino: one.ino });
        } catch {
          break;
        }
      }
      const at = aside.findIndex((one) => one.ino === mark.ino);
      if (at < 0) why.push("the log was set aside more often than it's kept since the last send: sent from edit.log's start");
      else {
        const was = aside[at]!;
        parts.push({ path: was.path, fd: null, from: was.size >= mark.offset ? mark.offset : 0, to: was.size });
        for (let n = at - 1; n >= 0; n--) parts.push({ path: aside[n]!.path, fd: null, from: 0, to: aside[n]!.size });
      }
    }
    parts.push({ path, fd, from, to: stat.size });
    // The newest `max` bytes.
    let total = parts.reduce((sum, part) => sum + (part.to - part.from), 0);
    let skipped = 0;
    for (const part of parts) {
      if (total <= max) break;
      const cut = Math.min(part.to - part.from, total - max);
      part.from += cut;
      total -= cut;
      skipped += cut;
    }
    const chunks: Buffer[] = [];
    for (const part of parts) {
      if (part.to <= part.from) continue;
      const bytes = Buffer.alloc(part.to - part.from);
      const own = part.fd ?? fs.openSync(part.path, "r");
      try {
        const read = fs.readSync(own, bytes, 0, bytes.length, part.from);
        chunks.push(bytes.subarray(0, read));
      } catch {
        // Gone while reading (set aside again): what's left is sent next time.
      } finally {
        if (part.fd === null) fs.closeSync(own);
      }
    }
    let bytes = Buffer.concat(chunks);
    if (skipped > 0) {
      // Cut mid-line: from the next whole one.
      const newline = bytes.indexOf(10);
      const drop = newline < 0 ? bytes.length : newline + 1;
      bytes = bytes.subarray(drop);
      skipped += drop;
      why.push(`${skipped} bytes of the log left out before this (more than ${max} since the last send)`);
    }
    // A line still being written goes next time.
    const mine = parts[parts.length - 1]!;
    const own = mine.to - mine.from;
    const last = bytes.lastIndexOf(10);
    const partial = bytes.length - (last + 1);
    let offset = stat.size;
    if (partial > 0 && partial <= Math.min(own, bytes.length)) {
      bytes = bytes.subarray(0, last + 1);
      offset -= partial;
    }
    return { bytes, skipped, why, next: { ino: stat.ino, offset } };
  } finally {
    fs.closeSync(fd);
  }
}

/** A chunk as it's sent: a line saying whose log it is, when and in which time zone its times are, then its lines, scrubbed. */
export function chunkText(machine: string, at: number, collected: Pick<Collected, "bytes" | "why">): string {
  const said = [`# Edit's log from ${machine} · ${BUILD} · sent ${new Date(at).toISOString()} · times UTC${utcOffset(at)}`, ...collected.why.map((why) => `# ${why}`)];
  return `${said.join("\n")}\n${scrubLines(collected.bytes.toString("utf8"))}`;
}

/** `diag.scrub` a line at a time: over a whole 5 MB log it's quadratic (a minute), a line at a time it's milliseconds. */
export function scrubLines(text: string): string {
  return text.split("\n").map(diag.scrub).join("\n");
}

// ---------------------------------------------------------------- sending

interface Place {
  home: string;
  machine: string;
  /** macOS's crash reports' folder; null where there's none. */
  reports: string | null;
}

let place: Place | null = null;
let stopped: lastRun.Stopped | null = null;
let flight: Promise<void> = Promise.resolve();
let warnedAt = 0;

function macReports(): string | null {
  return process.platform === "darwin" ? join(os.homedir(), "Library", "Logs", "DiagnosticReports") : null;
}

/**
 * Starts sending this Mac's log, crashes and a note of a run that stopped
 * without quitting, sending at once what the last run left: from
 * remote_actions.keepLatest (remote support's start, once the sign-in is
 * back; never on a trial server), which then calls `ship` every five
 * minutes. Once, whatever calls it again.
 */
export function start(app: App, reports: string | null = macReports()): void {
  if (place !== null) return;
  place = { home: app.store.home, machine: app.machine, reports };
  stopped = lastRun.lastStop();
  void ship();
}

/** Tests: forget the start. */
export function stopForTests(): void {
  place = null;
  stopped = null;
  warnedAt = 0;
}

/** Sends what's new now (one send at a time: a second waits for the first). Never throws. */
export function ship(signal?: AbortSignal): Promise<void> {
  flight = flight.then(() => once(signal));
  return flight;
}

/**
 * On the way out (serve.ts's quit): what's left of the log sent, within
 * `timing.quitMs`, never longer; never throws. What doesn't make it goes at
 * the next start.
 */
export async function finish(): Promise<void> {
  if (place === null) return;
  const stop = new AbortController();
  const late = setTimeout(() => stop.abort(), timing.quitMs);
  try {
    await Promise.race([ship(stop.signal), new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }))]);
  } finally {
    clearTimeout(late);
  }
}

async function once(signal?: AbortSignal): Promise<void> {
  const here = place;
  // Signed out: the mark stays where it was, so it's all sent once someone signs in.
  if (here === null || !cloud.enabled() || signal?.aborted) return;
  try {
    if (stopped !== null) {
      await sendStopped(here, stopped, signal);
      stopped = null;
    }
    if (here.reports !== null) await sendCrashes(here, here.reports, signal);
    await sendLog(here, signal);
  } catch (error) {
    if (signal?.aborted) return;
    // Offline for a day is 288 tries: said once an hour, not each time.
    if (Date.now() - warnedAt < timing.warnEveryMs) return;
    warnedAt = Date.now();
    diag.warn("reports", `sending the log to the team's cloud (tried again every five minutes, said at most hourly): ${diag.messageOf(error)}`);
  }
}

async function put(key: string, text: string, signal?: AbortSignal): Promise<void> {
  const body = Bun.gzipSync(new TextEncoder().encode(text));
  const url = await cloud.presign(key, "PUT");
  const timeout = AbortSignal.timeout(timing.putMs);
  const answer = await fetch(url, { method: "PUT", body, headers: { "content-type": "application/gzip" }, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
  if (!answer.ok) throw new Error(`R2 answered ${answer.status} for ${key}`);
}

async function sendLog(here: Place, signal?: AbortSignal): Promise<void> {
  const state = readState(here.home);
  const got = collect(join(here.home, "logs"), state.log);
  if (got === null) return;
  if (got.bytes.length > 0) {
    const now = Date.now();
    await put(chunkKey(here.machine, now), chunkText(here.machine, now, got), signal);
  }
  writeState(here.home, { ...readState(here.home), log: got.next });
}

/** The note of a run that stopped without quitting: when, macOS's crash report's words, and its log's last lines. */
export function stoppedText(machine: string, run: lastRun.Stopped, now = Date.now()): string {
  const around = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.exec([...run.tail].reverse().find((line) => /^\d{4}-/.test(line)) ?? "")?.[0] ?? `some time after ${diag.stamp(run.started)}`;
  return scrubLines(
    [
      `Edit stopped unexpectedly around ${around} on ${machine} (its local time, UTC${utcOffset(now)}).`,
      `That run: ${run.build || "?"}, started ${diag.stamp(run.started)}. Now running ${BUILD}.`,
      run.crash !== null ? `macOS's crash report: ${run.crash}` : "No crash report for it: stopped from outside, the Mac shut down or restarted, or not a Mac.",
      "",
      `Its log's last ${run.tail.length} lines:`,
      ...run.tail,
    ].join("\n"),
  );
}

async function sendStopped(here: Place, run: lastRun.Stopped, signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  await put(crashKey(here.machine, now, "stopped.txt"), stoppedText(here.machine, run, now), signal);
  diag.info("reports", "sent the team a note that the last run stopped without quitting");
}

/** macOS's crash reports of Edit's programs (`edit`, `edit-window`, `Edit`) written since the last look, each sent once. */
async function sendCrashes(here: Place, dir: string, signal?: AbortSignal): Promise<void> {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => /^edit/i.test(name)).sort();
  } catch {
    return;
  }
  const state = readState(here.home);
  const lookedAt = Date.now();
  // A little before the last look: a report written while it ran.
  const since = (state.crashesAt ?? lookedAt - CRASH_DAYS * DAY) - 10 * 60_000;
  const sent = new Set(state.crashes);
  for (const name of names) {
    if (sent.has(name)) continue;
    const path = join(dir, name);
    let text: string;
    let written: number;
    try {
      const stat = fs.statSync(path);
      if (!stat.isFile() || stat.mtimeMs < since) continue;
      written = stat.mtimeMs;
      const fd = fs.openSync(path, "r");
      try {
        const bytes = Buffer.alloc(Math.min(stat.size, MAX_CRASH));
        text = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    await put(crashKey(here.machine, written, name), `# ${name} from ${here.machine} · ${BUILD} · written ${new Date(written).toISOString()}\n${scrubLines(text)}`, signal);
    sent.add(name);
    writeState(here.home, { ...readState(here.home), crashes: [...sent].slice(-200) });
    diag.info("reports", `sent macOS's crash report ${name} to the team`);
  }
  writeState(here.home, { ...readState(here.home), crashes: [...sent].slice(-200), crashesAt: lookedAt });
}

// ---------------------------------------------------------------- reading them (an admin, scripts/remote.ts)

/** `mac`'s (its slug's) chunks sent since `from`, fetched to `dir` (each once: a chunk never changes), oldest first. */
export async function pullLogs(mac: string, from: number, dir: string, now = Date.now()): Promise<string[]> {
  return pull(LOGS, mac, from, dir, now);
}

/** `mac`'s crash reports and stopped notes of the last `days` days, fetched to `dir`, oldest first. */
export async function pullCrashes(mac: string, days: number, dir: string, now = Date.now()): Promise<string[]> {
  return pull(CRASHES, mac, now - days * DAY, dir, now);
}

async function pull(prefix: string, mac: string, from: number, dir: string, now: number): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const keys: string[] = [];
  for (let at = Date.parse(new Date(from).toISOString().slice(0, 10)); at <= now; at += DAY) {
    for (const object of await cloud.list(`${prefix}${mac}/${new Date(at).toISOString().slice(0, 10)}/`)) {
      const time = keyTime(object.key);
      if (time !== null && time >= from) keys.push(object.key);
    }
  }
  const out: string[] = [];
  for (const key of keys.sort()) {
    const path = join(dir, key.slice(key.lastIndexOf("/") + 1));
    if (!fs.existsSync(path)) await cloud.download(key, path);
    out.push(path);
  }
  return out;
}

/** A sent chunk or crash file, read back: its `# ` lines, its time zone (minutes east of UTC, null when unsaid) and the rest. */
export function readSent(path: string): { notes: string[]; tz: number | null; lines: string[] } {
  const all = Buffer.from(Bun.gunzipSync(fs.readFileSync(path))).toString("utf8").split("\n");
  const notes: string[] = [];
  while (all.length > 0 && all[0]!.startsWith("# ")) notes.push(all.shift()!.slice(2));
  const zone = /times UTC([+-])(\d\d):(\d\d)/.exec(notes[0] ?? "");
  const tz = zone === null ? null : (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
  if (all.at(-1) === "") all.pop();
  return { notes, tz, lines: all };
}

/** A log line's time (ms) given its Mac's time zone, or null for a line that isn't stamped (a continuation). */
export function lineTime(line: string, tz: number): number | null {
  const found = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3}) /.exec(line);
  if (found === null) return null;
  const [, y, mo, d, h, mi, s, ms] = found.map(Number);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!, ms!) - tz * 60_000;
}

/**
 * The lines of `chunks` from `from` on that match, as remote_ask's `log`
 * picks them (level=warn|error, area=, grep= a case-blind pattern), each
 * entry with its continuation lines; the last `limit` entries, and how many
 * matched.
 */
export function pick(chunks: { tz: number | null; lines: string[] }[], options: { from: number; level?: string; area?: string; grep?: string; limit: number }): { matched: number; lines: string[] } {
  const grep = options.grep === undefined ? null : new RegExp(options.grep, "i");
  const levels = options.level === "error" ? ["ERROR"] : options.level === "warn" ? ["WARN", "ERROR"] : null;
  const entries: string[][] = [];
  let matched = 0;
  for (const chunk of chunks) {
    let entry: string[] | null = null;
    let at: number | null = null;
    const close = () => {
      if (entry === null) return;
      const head = entry[0]!;
      const keep =
        at !== null &&
        at >= options.from &&
        (levels === null || levels.some((one) => head.includes(` ${one} [`))) &&
        (options.area === undefined || head.includes(` [${options.area}] `)) &&
        (grep === null || grep.test(entry.join("\n")));
      if (keep) {
        matched++;
        entries.push(entry);
        if (entries.length > options.limit) entries.shift();
      }
      entry = null;
    };
    for (const line of chunk.lines) {
      const time = lineTime(line, chunk.tz ?? 0);
      if (time !== null) {
        close();
        entry = [line];
        at = time;
      } else if (entry !== null) entry.push(line);
    }
    close();
  }
  return { matched, lines: entries.flat() };
}
