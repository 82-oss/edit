// Probes of what only a Mac has (its hardware encoder, its timers after a
// stop), on the same pieces as the cases: the stand-ins, the bad line, Edit
// from source in the sandbox. Run by name only (`just bad-day mac-export`),
// never in the whole run: they measure and log more than they judge, and each
// says what it saw in its harness.log ("probe:" lines).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Case, Context } from "./cases/index.ts";
import { describeJob, describeRows, editorImport, exported, filesUnder, importDone, job, logSince, restart, rows, startExport, type Row } from "./cases/work.ts";
import { tree } from "./edit.ts";
import type { Clip } from "./footage.ts";

const driveId = (tag: string) => `1BadDay${tag}`.padEnd(27, "x").slice(0, 27);
const seconds = (ms: number) => Math.round(ms / 1000);

async function laidOut(context: Context, tag: string, clip: Clip, ranges: [number, number][]): Promise<string | null> {
  const id = await editorImport(context, [{ id: driveId(tag), clip, ranges }], `Probe ${tag}`);
  const done = await importDone(context, id, 600_000);
  if (done === null) {
    context.check(`the edit ${tag} was laid out`, false, describeJob(await job(context, id)));
    return null;
  }
  return id;
}

/** The programs of Edit's tree now, by command. */
function programs(context: Context): string[] {
  const pid = context.edit.child?.pid;
  if (pid === undefined) return [];
  const ids = new Set(tree(pid).keys());
  const out = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .map((row) => /^\s*(\d+)\s+(.*)$/.exec(row))
    .filter((match): match is RegExpExecArray => match !== null && ids.has(Number(match[1])))
    .map((match) => `${match[1]} ${match[2]!.slice(0, 160)}`);
}

interface Activity {
  id: string;
  name: string;
  path: string;
  state: string;
  progress: number;
  updated_ms: number;
  phase?: string;
  waiting?: string;
}

async function activity(context: Context): Promise<Activity[]> {
  try {
    const answer = await context.edit.api<Activity[] | { exports?: Activity[] }>("GET", "/api/exports/activity");
    const body = answer.body;
    return Array.isArray(body) ? body : (body?.exports ?? []);
  } catch {
    return [];
  }
}

/**
 * Every 2 s: the job table, the exports' queue and /api/health's "busy". A row that says it runs while nothing of it
 * changes (its row, its time `updated_ms`, or its export's progress, phase and wait) for `stillMs` is noted, once a
 * stretch. Each row's time is followed too (`ticking`: the longest it went with nothing in it changed but its time, and
 * the longest it went with its time not moving), and each export's words in the queue are kept.
 */
class Watch {
  readonly still: string[] = [];
  readonly busySeen = new Set<string>();
  /** Per running row: the longest stretch with nothing but its time changed, and the longest with its time still (ms). */
  readonly ticking = new Map<string, { onlyTime: number; gap: number; moves: number }>();
  /** Per export file: what the queue said of it (state, phase, wait), in order, each once. */
  readonly said = new Map<string, string[]>();
  private times = new Map<string, { ms: number | undefined; at: number; body: string; bodySince: number }>();
  private last = new Map<string, { look: string; since: number; noted: boolean }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly context: Context,
    private readonly stillMs = 120_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.look(), 2000);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  private async look(): Promise<void> {
    const { context } = this;
    if (context.edit.frozen || context.edit.child === null) {
      // A freeze isn't Edit sitting still: the clocks start again at the wake.
      for (const one of this.last.values()) one.since = Date.now();
      for (const one of this.times.values()) one.at = one.bodySince = Date.now();
      return;
    }
    const now = Date.now();
    const looks = new Map<string, string>();
    for (const row of rows(context).filter((one: Row) => one.state === "running")) {
      const body = JSON.stringify({ ...row, updated_ms: undefined });
      looks.set(`row ${row.key}`, `${row.updated_ms ?? ""} ${body}`);
      const was = this.times.get(row.key);
      const tick = this.ticking.get(row.key) ?? { onlyTime: 0, gap: 0, moves: 0 };
      if (was === undefined) this.times.set(row.key, { ms: row.updated_ms, at: now, body, bodySince: now });
      else {
        if (was.body !== body) {
          was.body = body;
          was.bodySince = now;
        }
        if (was.ms !== row.updated_ms) {
          tick.moves++;
          was.ms = row.updated_ms;
          was.at = now;
        }
        tick.gap = Math.max(tick.gap, now - was.at);
        tick.onlyTime = Math.max(tick.onlyTime, now - was.bodySince);
      }
      this.ticking.set(row.key, tick);
    }
    const running = new Set(rows(context).filter((one: Row) => one.state === "running").map((one: Row) => one.key));
    for (const key of [...this.times.keys()]) if (!running.has(key)) this.times.delete(key);
    for (const one of await activity(context)) {
      const file = one.path.split("/").pop() ?? one.path;
      const words = `${one.state}${one.phase === undefined ? "" : ` · ${one.phase.replace(/\d+/g, "N")}`}${one.waiting === undefined ? "" : ` · waiting: ${one.waiting}`}`;
      const list = this.said.get(file) ?? [];
      if (!list.includes(words)) list.push(words);
      this.said.set(file, list);
      if (one.state === "running" || one.state === "queued") looks.set(`export ${file}`, `${one.state} ${one.progress.toFixed(4)} ${one.phase ?? ""} ${one.waiting ?? ""}`);
    }
    try {
      const health = await context.edit.api<{ busy?: string[] }>("GET", "/api/health");
      for (const one of health.body.busy ?? []) this.busySeen.add(one);
    } catch {}
    for (const [key, look] of looks) {
      const was = this.last.get(key);
      if (was === undefined || was.look !== look) this.last.set(key, { look, since: now, noted: false });
      else if (!was.noted && now - was.since > this.stillMs) {
        was.noted = true;
        const line = `${key} running with nothing changed for ${seconds(now - was.since)} s: ${look.slice(0, 200)}`;
        this.still.push(line);
        context.log(`probe: STILL ${line}`);
      }
    }
    for (const key of [...this.last.keys()]) if (!looks.has(key)) this.last.delete(key);
  }
}

/** The export named `file`, once it's done, and how long it took from `from`. */
async function finished(context: Context, id: string, file: string, from: number, ms: number): Promise<number | null> {
  const done = await exported(context, id, file, ms);
  return done === null ? null : Date.now() - from;
}

/** Waits until the export of `name` reports progress past `at` (0-1); whether it did. */
async function pastProgress(context: Context, name: string, at: number, ms: number): Promise<boolean> {
  const found = await context.waitFor(`${name} past ${Math.round(at * 100)}%`, async () => (await activity(context)).some((one) => one.path.endsWith(`/${name}`) && one.state === "running" && one.progress >= at) || null, ms);
  return found !== null;
}

const exportProbe: Case = {
  name: "mac-export",
  change: "probe",
  spec:
    "The Mac's encoder under trouble: a 3-minute edit exported clean (its time), then (i) Edit's whole tree stopped 30 s at ~30% of a render, the line cut, " +
    "and woken; (ii) an FFmpeg child of the render killed (or, with none, Edit killed) three times mid-render; (iii) two exports of two projects at once with an " +
    "import cutting excerpts. Throughout: any row or export that says running with nothing changed for 2 min is a finding.",
  allowed: [/import stopped/i],
  async run(context) {
    const { footage } = context;
    const watch = new Watch(context);
    watch.start();
    try {
      // ── The edits: 3 min of the long recording; a second project of 2 min of the other.
      const a = await laidOut(context, "PA", footage.axon, [[0, 180]]);
      const b = await laidOut(context, "PB", footage.long2, [[0, 110]]);
      if (a === null || b === null) return;
      const chunks = join(context.home, "cache", "export-chunks");

      // ── Clean: its time, what runs while it renders.
      let from = Date.now();
      await startExport(context, a, "clean.mp4", true);
      const seen = new Set<string>();
      const sampler = setInterval(() => {
        for (const one of programs(context)) seen.add(one.replace(/^\d+ /, "").split(" ")[0]!.split("/").pop()!);
      }, 500);
      const clean = await finished(context, a, "clean.mp4", from, 900_000);
      clearInterval(sampler);
      context.log(`probe: clean export ${clean === null ? "never finished" : `in ${(clean / 1000).toFixed(1)} s`}; programs in Edit's tree while it ran: ${[...seen].join(", ")}`);
      context.check("the clean export finished", clean !== null, clean === null ? describeRows(rows(context)) : `${(clean / 1000).toFixed(1)} s`);
      const renders = (since: number) => logSince(context, since, /exported \d+ frames in|export.*(fail|stopp|again|resum|restart)/i);

      // ── (i) Stopped 30 s mid-render, the line cut, woken.
      let logAt = context.edit.log().length;
      // Its chunks gone (as kill-three-times does), so it renders every frame again rather than joining the last export's.
      fs.rmSync(chunks, { recursive: true, force: true });
      from = Date.now();
      await startExport(context, a, "frozen.mp4", true);
      if (await pastProgress(context, "frozen.mp4", 0.3, 300_000)) {
        const before = (await activity(context)).find((one) => one.path.endsWith("/frozen.mp4"));
        context.log(`probe: (i) freezing at ${Math.round((before?.progress ?? 0) * 100)}%, ${seconds(Date.now() - from)} s in`);
        await context.freeze(30_000, 5000);
        const woke = Date.now();
        const moved = await context.waitFor("frozen.mp4 moving after the wake", async () => {
          const now = (await activity(context)).find((one) => one.path.endsWith("/frozen.mp4"));
          return now === undefined || now.state !== "running" || now.progress > (before?.progress ?? 0) + 0.01 || null;
        }, 120_000);
        context.log(`probe: (i) ${moved === null ? "NOT moving 2 min after the wake" : `moving again ${((Date.now() - woke) / 1000).toFixed(1)} s after the wake`}`);
        const took = await finished(context, a, "frozen.mp4", from, 900_000);
        context.log(`probe: (i) frozen export ${took === null ? "never finished" : `finished in ${(took / 1000).toFixed(1)} s (clean ${((clean ?? 0) / 1000).toFixed(1)} s + 30 s stopped)`}; its log: ${renders(logAt).map((one) => one.slice(24, 200)).join(" | ")}`);
        context.check("(i) the export stopped 30 s carried on and finished", took !== null && moved !== null, `${took === null ? "unfinished" : `${(took / 1000).toFixed(1)} s`}`);
      } else context.check("(i) the export reached 30%", false, describeRows(rows(context)));

      // ── (ii) The encoder's child killed three times, or Edit, mid-render.
      logAt = context.edit.log().length;
      fs.rmSync(chunks, { recursive: true, force: true });
      from = Date.now();
      const chunksBefore = filesUnder(chunks);
      await startExport(context, a, "killed.mp4", true);
      const kills: string[] = [];
      for (let i = 0; i < 3; i++) {
        if (!(await pastProgress(context, "killed.mp4", 0.15 + i * 0.25, 300_000))) {
          kills.push(`not seen past ${Math.round((0.15 + i * 0.25) * 100)}%`);
          break;
        }
        context.log(`probe: (ii) chunks here before kill ${i + 1}: ${filesUnder(chunks).size}`);
        const ffmpeg = programs(context).filter((one) => /ffmpeg/.test(one));
        if (ffmpeg.length > 0) {
          for (const one of ffmpeg) {
            try {
              process.kill(Number(one.split(" ")[0]), "SIGKILL");
            } catch {}
          }
          kills.push(`killed ${ffmpeg.length} FFmpeg (${ffmpeg[0]!.slice(0, 120)})`);
        } else {
          await restart(context, `mid-render ${i + 1} of 3 (no FFmpeg child to kill)`);
          kills.push("killed Edit");
        }
        context.log(`probe: (ii) ${kills.at(-1)}`);
      }
      const killed = await finished(context, a, "killed.mp4", from, 900_000);
      const chunksAfter = filesUnder(chunks);
      const kept = [...chunksBefore.keys()].filter((key) => chunksAfter.get(key) === chunksBefore.get(key)).length;
      context.log(
        `probe: (ii) ${kills.join("; ")}; the export ${killed === null ? "never finished" : `finished by itself in ${(killed / 1000).toFixed(1)} s`}; chunks before ${chunksBefore.size}, after ${chunksAfter.size}, unchanged ${kept}; renders logged: ${renders(logAt).length} (${renders(logAt).map((one) => one.slice(24, 160)).join(" | ")})`,
      );
      context.check("(ii) the export killed mid-render finished by itself", killed !== null, describeRows(rows(context).filter((row) => row.kind === "export")));

      // ── (ii-b) The FFmpeg joining the chunks killed once (the export's last seconds): joined again, or rendered again?
      logAt = context.edit.log().length;
      fs.rmSync(chunks, { recursive: true, force: true });
      from = Date.now();
      await startExport(context, a, "join.mp4", true);
      // Looked for every 100 ms: a join of 3 minutes takes about 4 s here.
      let joiner: string | null = null;
      for (const until = Date.now() + 600_000; joiner === null && Date.now() < until; ) {
        joiner = programs(context).find((one) => /ffmpeg/.test(one) && / concat /.test(one)) ?? null;
        if (joiner === null) await context.sleep(100);
      }
      if (joiner !== null) {
        try {
          process.kill(Number(joiner.split(" ")[0]), "SIGKILL");
        } catch {}
        context.log(`probe: (ii-b) killed the join ${seconds(Date.now() - from)} s in: ${joiner.slice(0, 140)}`);
      } else context.log("probe: (ii-b) no FFmpeg joining chunks seen");
      const joined = await finished(context, a, "join.mp4", from, 900_000);
      context.log(
        `probe: (ii-b) the export ${joined === null ? "never finished" : `finished in ${(joined / 1000).toFixed(1)} s (clean ${((clean ?? 0) / 1000).toFixed(1)} s)`}; its log: ${logSince(context, logAt, /already made|join took|exported \d+ frames in|chunked export failed|frames composited/i).map((one) => one.slice(11, 200)).join(" | ")}`,
      );
      context.check("(ii-b) the export whose join was killed finished by itself", joined !== null, describeRows(rows(context).filter((row) => row.kind === "export")));

      // ── (iii) Two exports of two projects at once, with an import cutting excerpts.
      logAt = context.edit.log().length;
      fs.rmSync(chunks, { recursive: true, force: true });
      from = Date.now();
      const c = editorImport(context, [{ id: driveId("PC"), clip: footage.axon, ranges: [[200, 260], [300, 360], [400, 460]] }], "Probe PC");
      await startExport(context, a, "both-a.mp4", true);
      await startExport(context, b, "both-b.mp4", true);
      const cId = await c;
      const [ta, tb, tc] = await Promise.all([
        finished(context, a, "both-a.mp4", from, 900_000),
        finished(context, b, "both-b.mp4", from, 900_000),
        importDone(context, cId, 900_000).then((done) => (done === null ? null : Date.now() - from)),
      ]);
      context.log(`probe: (iii) export A ${ta === null ? "never finished" : `${(ta / 1000).toFixed(1)} s`}, export B ${tb === null ? "never finished" : `${(tb / 1000).toFixed(1)} s`}, import ${tc === null ? "never finished" : `${(tc / 1000).toFixed(1)} s`}; waits said: ${[...new Set(logSince(context, logAt, /encoder|waiting for/i).map((one) => one.slice(24, 160)))].slice(0, 6).join(" | ")}`);
      context.check("(iii) both exports and the import finished side by side", ta !== null && tb !== null && tc !== null, describeRows(rows(context)));
      const tickOf = (key: string) => {
        const one = watch.ticking.get(key);
        return one === undefined ? "never running" : `its time moved ${one.moves} times, still at most ${(one.gap / 1000).toFixed(1)} s; nothing but its time changed for at most ${(one.onlyTime / 1000).toFixed(1)} s`;
      };
      context.log(`probe: (iii) row export:${b} (B): ${tickOf(`export:${b}`)}; the queue said of both-b.mp4: ${(watch.said.get("both-b.mp4") ?? []).join(" → ").slice(0, 700)}`);
      context.log(`probe: (iii) row export:${a} (A): ${tickOf(`export:${a}`)}; the queue said of both-a.mp4: ${(watch.said.get("both-a.mp4") ?? []).join(" → ").slice(0, 400)}`);
    } finally {
      watch.stop();
      context.log(`probe: busy said by /api/health: ${[...watch.busySeen].join(" | ").slice(0, 600)}`);
      context.check("nothing said running with nothing moving for 2 min", watch.still.length === 0, watch.still.length === 0 ? "none" : watch.still.join(" | "));
    }
  },
};

// ─────────────────────────────────────────────── mac-playback

/** Edit's TCP connections to the line's port now (lsof), by state. */
function connections(context: Context): Record<string, number> {
  const pid = context.edit.child?.pid;
  if (pid === undefined) return {};
  const out = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP"], { encoding: "utf8" }).stdout ?? "";
  const counts: Record<string, number> = {};
  for (const row of out.split("\n")) {
    if (!row.includes(`:${context.line.port}`) || row.includes("LISTEN")) continue;
    const state = /\((\w+)\)\s*$/.exec(row)?.[1] ?? "?";
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

interface Ready {
  ready: [number, number][];
  keeping: boolean;
}

/** Frames of `[0, total)` ready, from the stretches. */
const covered = (spans: [number, number][], from: number, to: number) => spans.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);

const playbackProbe: Case = {
  name: "mac-playback",
  change: "probe",
  spec:
    "Playback's server side on a bad line, for a project whose footage is only in the stand-in cloud (its copies here removed, Edit started again): from an open " +
    "(POST …/playback/warm at frame 0), the time until GET …/playback/ready covers the first 4 s and the whole edit, on a line held to 50 Mbit/s, to 8 Mbit/s, and " +
    "with the line dropped 30 s mid-warm then back; R2 reads asked and finished, and Edit's connections to the line left after.",
  async run(context) {
    const { footage, line } = context;
    const id = await laidOut(context, "PP", footage.axon, [[0, 60], [120, 180], [300, 360]]);
    if (id === null) return;
    // The import's copies up first: nothing of it may be left only here.
    const settled = await context.waitFor("the import's uploads settled", () => rows(context).every((row) => !["queued", "running", "waiting"].includes(row.state)) || null, 600_000);
    context.log(`probe: uploads ${settled === null ? "NOT settled" : "settled"}: ${describeRows(rows(context)).slice(0, 400)}`);
    const saved = (await context.edit.api<{ project: unknown }>("GET", `/api/projects/${id}`)).body.project as { media: { id: string; path: string; duration: number; cloud?: { proxy?: string } }[]; clips: { start: number; duration: number }[]; settings?: { fps?: number } };
    const fps = saved.settings?.fps ?? 30;
    const total = Math.max(...saved.clips.map((clip) => clip.start + clip.duration));
    const objects = context.cloud.mock.cloud.objects as unknown as { has(key: string): boolean; pathOf(key: string): string };
    const keys = saved.media.map((one) => one.cloud?.proxy).filter((key): key is string => key !== undefined);
    const inCloud = keys.filter((key) => objects.has(key));
    const bytes = inCloud.reduce((sum, key) => sum + fs.statSync(objects.pathOf(key)).size, 0);
    context.log(`probe: ${saved.media.length} media, ${keys.length} with a proxy key, ${inCloud.length} of them in the stand-in R2 (${(bytes / 1e6).toFixed(1)} MB); paths ${saved.media.map((one) => one.path.slice(0, 90)).join(" | ")}; the edit ${(total / fps).toFixed(1)} s`);
    if (inCloud.length === 0) {
      context.check("the footage is in the stand-in cloud", false, "no proxy of the project's is in R2: nothing to stream");
      return;
    }
    const cloudDir = join(context.home, "cache", "cloud");
    const forget = async () => {
      // Only the cloud's copies here: as a project opened on another Mac.
      await context.edit.stop();
      for (const key of keys) fs.rmSync(join(cloudDir, key.replace(/^edit\//, "")), { force: true });
      fs.rmSync(join(cloudDir, "blocks"), { recursive: true, force: true });
      for (const one of saved.media) if (fs.existsSync(one.path)) context.log(`probe: media ${one.id} still a file here: ${one.path}`);
      await context.edit.start();
      await context.waitFor("signed in", async () => (await context.edit.api<{ signed_in: boolean }>("GET", "/api/account")).body.signed_in === true || null, 30_000);
    };
    const results: string[] = [];
    for (const condition of [
      { name: "50 Mbit/s", down: 50e6 / 8, dropAt: 0 },
      { name: "8 Mbit/s", down: 8e6 / 8, dropAt: 0 },
      { name: "8 Mbit/s, dropped 30 s mid-warm", down: 8e6 / 8, dropAt: 3000 },
    ]) {
      await forget();
      line.clear();
      line.reshape({ down: condition.down, up: 0 });
      const first = await context.edit.api<Ready>("GET", `/api/projects/${id}/playback/ready`);
      const requestsBefore = line.requests.length;
      const from = Date.now();
      await context.edit.api("POST", `/api/projects/${id}/playback/warm`, { frame: 0 });
      let firstReady: number | null = null;
      let allReady: number | null = null;
      let dropped = false;
      let back = 0;
      let readyBeforeDrop = 0;
      while (Date.now() - from < 600_000) {
        if (condition.dropAt > 0 && !dropped && Date.now() - from >= condition.dropAt) {
          dropped = true;
          const now = await context.edit.api<Ready>("GET", `/api/projects/${id}/playback/ready`);
          readyBeforeDrop = covered(now.body.ready, 0, total);
          line.set("down");
          context.log(`probe: line down at +${((Date.now() - from) / 1000).toFixed(1)} s (${(readyBeforeDrop / fps).toFixed(1)} s of the edit ready)`);
          await context.sleep(30_000);
          line.set("up");
          back = Date.now();
          context.log("probe: line back");
        }
        const answer = await context.edit.api<Ready>("GET", `/api/projects/${id}/playback/ready`).catch(() => null);
        const spans = answer?.body.ready ?? [];
        if (firstReady === null && covered(spans, 0, Math.min(total, 4 * fps)) >= Math.min(total, 4 * fps) - 1) firstReady = Date.now() - from;
        if (covered(spans, 0, total) >= total - 1) {
          allReady = Date.now() - from;
          break;
        }
        await context.sleep(250);
      }
      // Quiet a while, then what's left open to the line.
      await context.sleep(15_000);
      const asked = line.requests.slice(requestsBefore).filter((one) => one.line.startsWith("GET /r2/"));
      const short = asked.filter((one) => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(one.range);
        return range !== null && one.bytes < Number(range[2]) - Number(range[1]) + 1;
      });
      const open = connections(context);
      const line_ = `${condition.name}: ready at the open ${(covered(first.body.ready, 0, total) / fps).toFixed(1)} s; first 4 s ready ${firstReady === null ? "NEVER" : `${(firstReady / 1000).toFixed(1)} s`}, all ${(total / fps).toFixed(0)} s ready ${allReady === null ? "NEVER (10 min)" : `${(allReady / 1000).toFixed(1)} s`}${back > 0 ? ` (${allReady === null ? "-" : ((from + allReady - back) / 1000).toFixed(1)} s after the line came back)` : ""}; R2 reads ${asked.length} (${short.length} cut short), ${(asked.reduce((sum, one) => sum + one.bytes, 0) / 1e6).toFixed(1)} MB; Edit's connections to the line after 15 s quiet: ${JSON.stringify(open)}`;
      results.push(line_);
      context.log(`probe: ${line_}`);
      context.check(`ready came for ${condition.name}`, allReady !== null, line_);
    }
    line.clear();
  },
};

export const macProbes: Case[] = [exportProbe, playbackProbe];
