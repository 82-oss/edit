// The editor's Script import (script.ts `start`, cloud_media.ts
// `driveExcerpts`): ranges cut from a Drive file the relay has copied to the
// cloud, read over the line by FFmpeg. Changes 4 and 5 of final.md.
//
// Time: the switch EDIT_BAD_DAY_SPEED=60 (change 6, failure.ts) runs every
// wait 60 times faster; a build without it (7b59f4e2) ignores it and runs at
// real speed. So each case is sized to fail at real speed on the old code
// where that can be done in minutes (its line slow for longer than the old
// fixed 2-minute limit), and passes on the new only if no step is stopped
// while it's making progress, at either speed.

import * as fs from "node:fs";
import { join } from "node:path";

import type { Clip } from "../footage.ts";
import type { Case, Context } from "./index.ts";

const A = "1BadDayAxonFileAAAAAAAAAAA1";
const B = "1BadDayAxonFileBBBBBBBBBBB2";
const KBIT = 1000 / 8;

interface FileRow {
  file: string;
  name?: string;
  state: string;
  error?: string;
  why?: string;
  retry_at?: number;
  cut?: { done: number; total: number };
}

interface Job {
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

interface Project {
  id: string;
  settings?: { fps?: number };
  script?: { blocks?: Block[] };
  tracks?: { clips?: { start: number; duration: number }[] }[];
  clips?: { start: number; duration: number }[];
  media?: unknown[];
}

/** The ranges as the script holds them, and the edit's length: what check 2 compares. */
function shape(project: Project): { ranges: string; seconds: number; gone: number } {
  const blocks = (project.script?.blocks ?? []).filter((block) => block.kind === "footage");
  const ranges = blocks.map((block) => `${block.file}:${block.start}-${block.end}`).join(",");
  const gone = blocks.filter((block) => (block.notes ?? []).some((note) => /^Gone without/.test(note))).length;
  const clips = [...(project.clips ?? []), ...(project.tracks ?? []).flatMap((track) => track.clips ?? [])];
  const frames = clips.reduce((most, clip) => Math.max(most, clip.start + clip.duration), 0);
  return { ranges, seconds: frames / (project.settings?.fps ?? 30), gone };
}

/** The size of the file's index (moov): read again by each probe and each cut. */
function moovBytes(path: string): number {
  const fd = fs.openSync(path, "r");
  const header = Buffer.alloc(16);
  let at = 0;
  const size = fs.fstatSync(fd).size;
  let moov = 0;
  while (at < size) {
    fs.readSync(fd, header, 0, 16, at);
    let length = header.readUInt32BE(0);
    if (length === 1) length = Number(header.readBigUInt64BE(8));
    if (header.toString("latin1", 4, 8) === "moov") moov = length;
    if (length <= 0) break;
    at += length;
  }
  fs.closeSync(fd);
  return moov;
}

const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

interface Setup {
  project: string;
  /** Bytes of the originals the cuts need at least (the spans' share, plus one read of each index). */
  needed: number;
  originals: string[];
}

/**
 * A project whose pasted script cuts `ranges` (seconds) from the given files on the stand-in Drive, started as the page
 * does. Shorts: no voice-over and no research turn after (neither is what these cases test).
 */
async function editorImport(context: Context, files: { id: string; clip: Clip; ranges: [number, number][] }[]): Promise<Setup> {
  const { cloud, edit } = context;
  const lines: string[] = [];
  let needed = 0;
  for (const { id, clip, ranges } of files) {
    cloud.addFile("1BadDayEditorFolder00000001", id, clip);
    for (const [from, to] of ranges) {
      lines.push(`[${stamp(from)}-${stamp(to)}](https://drive.google.com/file/d/${id}/view)`);
      lines.push("On July 13 police in Kent were called to a crash on the highway near the old mill, and what they found surprised them.");
      // Edit cuts each range with 10 s either side.
      needed += ((to - from + 20) / clip.seconds) * clip.size;
    }
    needed += moovBytes(clip.path);
  }
  const made = await edit.api<{ project: Project }>("POST", "/api/projects", { name: "Bad day", style: "shorts" });
  if (made.status !== 200) throw new Error(`making the project answered ${made.status}: ${made.text.slice(0, 300)}`);
  const project = made.body.project.id;
  const started = await edit.api("POST", `/api/projects/${project}/script`, { url: lines.join("\n") });
  if (started.status !== 200) throw new Error(`starting the import answered ${started.status}: ${started.text.slice(0, 300)}`);
  context.log(`editor import started: project ${project}`);
  return { project, needed, originals: files.map(({ id, clip }) => `edit/originals/drive/${id}/${clip.name}`) };
}

async function job(context: Context, project: string): Promise<Job> {
  const answer = await context.edit.api<{ job: Job }>("GET", `/api/projects/${project}/script/job`);
  return answer.body.job;
}

async function project(context: Context, id: string): Promise<Project> {
  return (await context.edit.api<{ project: Project }>("GET", `/api/projects/${id}`)).body.project;
}

function describe(one: Job | null): string {
  if (one === null) return "no job";
  const files = one.files.map((file) => `${file.name ?? file.file.slice(0, 12)} ${file.state}${file.cut ? ` ${file.cut.done}/${file.cut.total}` : ""}${file.error ? ` (${file.error.slice(0, 140)})` : ""}`).join("; ");
  return `job ${one.state}${one.error ? ` "${one.error}"` : ""}: ${files}`;
}

async function done(context: Context, id: string, ms: number): Promise<Job | null> {
  return context.waitFor("the import done", async () => {
    const one = await job(context, id);
    return one?.state === "done" ? one : null;
  }, ms);
}

/** Bytes of the originals sent over the line, against what the cuts needed (check 5). */
function bytesCheck(context: Context, setup: Setup, most = 1.3): void {
  const sent = setup.originals.reduce((sum, key) => sum + (context.line.sent(`/r2/${key}`)), 0);
  context.check(
    `bytes fetched at most ${most}× what the excerpts need`,
    sent <= setup.needed * most,
    `${(sent / 1e6).toFixed(1)} MB fetched of the originals, ${(setup.needed / 1e6).toFixed(1)} MB needed`,
  );
}

const stopped = /was stopped|took more than \d+ min/;

function nothingStopped(context: Context): void {
  const lines = context.edit.log().split("\n").filter((line) => stopped.test(line));
  context.check("no step was stopped", lines.length === 0, lines.length === 0 ? "no 'took more than … was stopped' in Edit's log" : lines.slice(0, 3).map((line) => line.slice(0, 220)).join(" | "));
}

/** Runs `then` once the line has carried `bytes` of `key` (a cut under way), checking every 200 ms. */
function whenRead(context: Context, key: string, bytes: number, then: () => void | Promise<void>): { fired: () => boolean } {
  let fired = false;
  const timer = setInterval(() => {
    if (fired || (context.line.sent(`/r2/${key}`)) < bytes) return;
    fired = true;
    clearInterval(timer);
    void then();
  }, 200);
  return { fired: () => fired };
}

export const cutCases: Case[] = [
  {
    name: "slow-cut",
    change: "5",
    spec:
      "A 150 MB Axon-shaped file (index at the end, keyframes every 8 s, B-frames), two 20-second ranges, time run 60 times faster. " +
      "The line toward Edit runs at 8 kbit/s for the first 330 s of reading it from the cloud (its 616 kB index can't come in under today's 2-minute limit on reading its length or keyframe, at real speed), then 2 Mbit/s. " +
      "Checks: both excerpts are cut; nothing 'was stopped'; bytes fetched are at most 1.3 times the excerpts' size.",
    env: { EDIT_BAD_DAY_SPEED: "60" },
    async run(context) {
      const { line, cloud, footage } = context;
      const setup = await editorImport(context, [{ id: A, clip: footage.axon, ranges: [[60, 80], [360, 380]] }]);
      let slowed = false;
      cloud.beforeR2Get = (key) => {
        if (slowed || key !== setup.originals[0]) return;
        slowed = true;
        context.log("first read of the original from the cloud: the line toward Edit at 8 kbit/s for 330 s");
        line.reshape({ down: 8 * KBIT });
        setTimeout(() => {
          context.log("the line toward Edit at 2 Mbit/s");
          line.reshape({ down: 2000 * KBIT });
        }, 330_000);
      };
      const end = await done(context, setup.project, 660_000);
      const last = end ?? (await job(context, setup.project));
      context.check("both excerpts are cut", end !== null, describe(last));
      nothingStopped(context);
      bytesCheck(context, setup);
    },
  },
  {
    name: "stalled-cut",
    change: "5",
    spec:
      "The same file and ranges at 2 Mbit/s, time run 60 times faster; the line goes silent mid-cut for 90 s, then comes back. " +
      "Checks: the cut is stopped after the no-progress time and tried again by itself (nothing waits for a person or fails); done when the line is back; bytes fetched at most 1.3 times the excerpts'.",
    env: { EDIT_BAD_DAY_SPEED: "60" },
    async run(context) {
      const { line, footage } = context;
      line.reshape({ down: 2000 * KBIT });
      const setup = await editorImport(context, [{ id: A, clip: footage.axon, ranges: [[60, 80], [360, 380]] }]);
      // Mid-cut: once the index and a few megabytes of the footage have come down.
      let back = 0;
      const silent = whenRead(context, setup.originals[0]!, moovBytes(footage.axon.path) + 4e6, async () => {
        context.log("mid-cut: the line goes silent for 90 s");
        line.set("silent");
        await context.sleep(90_000);
        line.set("up");
        back = Date.now();
      });
      const end = await done(context, setup.project, 420_000);
      const last = end ?? (await job(context, setup.project));
      context.check("the line went silent mid-cut", silent.fired(), silent.fired() ? "yes" : "the cut never got that far");
      context.check("done when the line was back", end !== null && back > 0, `${describe(last)}${back > 0 && end !== null ? `, ${Math.round((Date.now() - back) / 1000)} s after` : ""}`);
      bytesCheck(context, setup);
    },
  },
  {
    name: "frozen-cut",
    change: "5",
    spec:
      "The same file and ranges at 2 Mbit/s, time run 60 times faster; Edit frozen 30 s mid-cut (the line cut at the freeze, back 5 s after the wake). " +
      "Check: the cut isn't stopped by the freeze (no step stopped, no file failed and started again); it finishes; bytes fetched at most 1.3 times the excerpts'.",
    env: { EDIT_BAD_DAY_SPEED: "60" },
    async run(context) {
      const { line, footage } = context;
      line.reshape({ down: 2000 * KBIT });
      const setup = await editorImport(context, [{ id: A, clip: footage.axon, ranges: [[60, 80], [360, 380]] }]);
      const frozen = whenRead(context, setup.originals[0]!, moovBytes(footage.axon.path) + 4e6, async () => {
        context.log("mid-cut: Edit frozen for 30 s");
        await context.freeze(30_000, 5000);
      });
      const end = await done(context, setup.project, 360_000);
      const last = end ?? (await job(context, setup.project));
      context.check("Edit was frozen mid-cut", frozen.fired(), frozen.fired() ? "yes" : "the cut never got that far");
      context.check("the import finished", end !== null, describe(last));
      const lines = context.edit.log().split("\n").filter((one) => stopped.test(one) || /no progress|stood still|standing still/i.test(one) || /file \d+ of \d+ \([^)]*\) failed after|cloud excerpts failed after/.test(one));
      context.check("the cut wasn't stopped for the freeze", lines.length === 0, lines.length === 0 ? "nothing stopped" : lines.slice(0, 3).map((one) => one.slice(0, 220)).join(" | "));
      bytesCheck(context, setup);
    },
  },
  {
    name: "no-room",
    change: "5",
    spec:
      "Time run 60 times faster. The import runs with Edit's home on a 256 MB disk with only ~12 MB of it free, then, a minute in (a dozen five-minute room waits at this speed), the room is made (the filler deleted). " +
      "Checks: Edit says how much room it needs; while there's no room the originals are fetched at most once (it looks at the disk, never cutting again into it: Fable's last look); " +
      "the same bytes aren't fetched over and over; no 'No space left' reaches jobs.json or a project's file; the file comes in once room is made.",
    smallDisk: true,
    env: { EDIT_BAD_DAY_SPEED: "60" },
    async run(context) {
      const { footage, home } = context;
      // Fill the small disk to ~12 MB free.
      const filler = join(home, "..", "filler.bin");
      const free = () => {
        const stat = fs.statfsSync(home);
        return stat.bavail * stat.bsize;
      };
      const fd = fs.openSync(filler, "w");
      const block = Buffer.alloc(1 << 20, 1);
      while (free() > 12e6 + (1 << 20)) fs.writeSync(fd, block);
      fs.closeSync(fd);
      context.log(`small disk filled: ${(free() / 1e6).toFixed(1)} MB free`);
      const setup = await editorImport(context, [{ id: A, clip: footage.axon, ranges: [[60, 80], [360, 380]] }]);
      await context.sleep(60_000);
      const before = describe(await job(context, setup.project));
      const fetchedBefore = setup.originals.reduce((sum, key) => sum + context.line.sent(`/r2/${key}`), 0);

      context.log(`before the room is made: ${before}`);
      const said = [before, context.edit.log()].join("\n");
      context.check("Edit says how much room it needs", /Needs [\d.]+ ?[MG]B free/i.test(said), /Needs [\d.]+ ?[MG]B free/i.test(said) ? "yes" : `no "Needs … free" line: ${before.slice(0, 300)}`);
      fs.rmSync(filler, { force: true });
      context.log(`room made: ${(free() / 1e6).toFixed(1)} MB free`);
      const end = await done(context, setup.project, 300_000);
      const last = end ?? (await job(context, setup.project));
      context.check("the file came in once room was made", end !== null, describe(last));
      // One try into the full disk is how Edit learns what it needs; after it, it looks at the disk, never cutting again
      // into it (Fable's last look): what it fetched before the room is at most about one try's worth.
      const fetchedAfter = setup.originals.reduce((sum, key) => sum + context.line.sent(`/r2/${key}`), 0) - fetchedBefore;
      context.check(
        "while there's no room, the originals were fetched for one try at most",
        end !== null && fetchedBefore <= fetchedAfter * 1.3,
        `${(fetchedBefore / 1e6).toFixed(1)} MB fetched before the room was made, ${(fetchedAfter / 1e6).toFixed(1)} MB by the try that came in`,
      );
      bytesCheck(context, setup, 2);
      const files = [join(home, "jobs.json"), ...fs.readdirSync(join(home, "projects"), { recursive: true }).map((name) => join(home, "projects", String(name)))];
      const leaked = files.filter((path) => {
        try {
          return fs.statSync(path).isFile() && /No space left|ENOSPC/.test(fs.readFileSync(path, "utf8"));
        } catch {
          return false;
        }
      });
      context.check("no 'No space left' kept in jobs.json or a project's file", leaked.length === 0, leaked.length === 0 ? "none" : leaked.map((path) => path.slice(home.length)).join(", "));
    },
  },
  {
    name: "skip-named-file",
    change: "4",
    spec:
      "An import of two files; the second's every request is cut off (a cut line, for it alone) until the import waits on it by itself. " +
      "Then the route and the agent's tool are both asked to skip that file by name. " +
      "Checks: both refuse; the script's ranges and the edit are the same before and after; the file comes in when the line is back.",
    env: { EDIT_BAD_DAY_SPEED: "60" },
    async run(context) {
      const { cloud, edit, footage } = context;
      context.line.cutOff.add(B);
      const setup = await editorImport(context, [
        { id: A, clip: footage.long2, ranges: [[10, 20]] },
        { id: B, clip: footage.axon, ranges: [[60, 70]] },
      ]);
      // Waiting on B by itself: the import isn't working (a skip now isn't refused as "still working").
      const waiting = await context.waitFor(
        "the import to wait on the second file by itself",
        async () => {
          const one = await job(context, setup.project);
          const row = one?.files.find((file) => file.file === B);
          return one !== null && (one.state === "waiting" || one.state === "failed") && row !== undefined ? one : null;
        },
        480_000,
      );
      if (waiting === null) {
        context.check("the import waited on the cut-off file", false, describe(await job(context, setup.project)));
        context.line.cutOff.delete(B);
        return;
      }
      context.log(`waiting: ${describe(waiting)}`);
      const before = shape(await project(context, setup.project));
      const route = await edit.api<{ error?: string }>("POST", `/api/projects/${setup.project}/script/footage`, { file: B, skip: true });
      context.check("the route refuses to skip it by name", route.status >= 400, `${route.status}: ${route.text.slice(0, 200)}`);
      const tool = await edit.api<{ result?: { isError?: boolean; content?: { text: string }[] } }>("POST", `/mcp?project=${setup.project}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "skip_footage", arguments: { file: B } },
      });
      const refused = tool.body?.result?.isError === true;
      context.check("the agent's tool refuses to skip it by name", refused, (tool.body?.result?.content?.[0]?.text ?? tool.text).slice(0, 200));
      await context.sleep(3000);
      const after = shape(await project(context, setup.project));
      context.check(
        "the script's ranges are the same before and after",
        before.ranges === after.ranges && after.gone === 0,
        `before ${before.ranges} (${before.gone} gone without), after ${after.ranges} (${after.gone} gone without), edit ${before.seconds.toFixed(1)} s → ${after.seconds.toFixed(1)} s`,
      );
      context.line.cutOff.delete(B);
      context.log("the line is back for the second file");
      const end = await done(context, setup.project, 900_000);
      const last = end ?? (await job(context, setup.project));
      const finalShape = shape(await project(context, setup.project));
      context.check("the file came in when the line was back", end !== null && finalShape.gone === 0, `${describe(last)}; ${finalShape.gone} range(s) gone without`);
    },
  },
];
