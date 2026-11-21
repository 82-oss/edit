// A project whose footage isn't on this computer (another Mac imported it,
// or the cache was cleared): what the team opens every day. Two things are
// done with it on a bad line here, an export and a play.
//
// Nov 20: none of the earlier cases exported or played an edit whose footage
// had to come down first, and the three complaints the team keeps making are
// about exactly that (imports aside): an export that sits, and a play that
// only works once the player has been open a long time.
//
// The play is the server's side of one (the page and Edit.app's window can't
// run in here): what a player asks of the server as it opens and plays is
// asked the same way, at the pace a play reads, and what comes down is
// counted on the line.

import * as fs from "node:fs";
import { join } from "node:path";

import type { Case, Context } from "./index.ts";
import { editorImport, exported, fileOf, importDone, describeJob, describeRows, job, KBIT, live, project, rows, sameVideo, startExport, until } from "./work.ts";

const driveId = (tag: string) => `1BadDayCold${tag}`.padEnd(27, "x");

interface Laid {
  id: string;
  /** Each footage file's preview in the cloud: its key, its size, where its whole copy lands here, and the address the players read. */
  previews: { key: string; size: number; local: string; url: string }[];
  /** The originals' keys (what an export's excerpts are cut from). */
  originals: string[];
}

/** An edit laid out from two files, everything of it up in the cloud and nothing still going. */
async function laidOut(context: Context, tag: string): Promise<Laid | null> {
  const { footage } = context;
  const files = [
    { id: driveId(`${tag}A`), clip: footage.axon, ranges: [[60, 80], [300, 320]] as [number, number][] },
    { id: driveId(`${tag}B`), clip: footage.long2, ranges: [[20, 40]] as [number, number][] },
  ];
  const id = await editorImport(context, files, `Cold ${tag}`);
  const done = await importDone(context, id, 300_000);
  if (done === null) {
    context.check("the edit was laid out", false, describeJob(await job(context, id)));
    return null;
  }
  // Its uploads behind the import done too: the cloud holds all of it.
  const quiet = await until(context, () => !rows(context).some(live), 240_000, 1000);
  if (!quiet) context.log(`work still listed after the import: ${describeRows(rows(context).filter(live))}`);
  const objects = context.cloud.mock.cloud.objects as unknown as { pathOf(key: string): string; has(key: string): boolean };
  const previews: Laid["previews"] = [];
  for (const media of ((await project(context, id)).media ?? []) as { id: string; path?: string }[]) {
    const path = media.path ?? "";
    const key = /[?&]key=([^&]+)/.exec(path)?.[1];
    if (key === undefined) continue;
    const decoded = decodeURIComponent(key);
    // The footage's previews: what the players read and keep whole (a voice-over's own file isn't one).
    if (!decoded.startsWith("edit/proxies/") || !objects.has(decoded)) continue;
    previews.push({ key: decoded, size: fs.statSync(objects.pathOf(decoded)).size, local: join(context.home, "cache", "cloud", decoded.replace(/^edit\//, "")), url: path.replace(/^https?:\/\/[^/]+/, "") });
  }
  context.log(`laid out ${id}: ${previews.map((one) => `${one.key} ${(one.size / 1e6).toFixed(1)} MB`).join(", ")}`);
  if (previews.length === 0) {
    context.check("the edit's footage is in the cloud", false, "no footage of it has a preview in the stand-in cloud");
    return null;
  }
  return { id, previews, originals: files.map(({ id: file, clip }) => `edit/originals/drive/${file}/${clip.name}`) };
}

/** Edit quit, everything it kept of the cloud's footage gone, and started again: this project as another Mac opens it. */
async function cold(context: Context): Promise<void> {
  context.log("cold: Edit stopped, its copies of the cloud's footage and its export chunks removed");
  await context.edit.kill();
  for (const dir of ["cache/cloud", "cache/export-chunks"]) fs.rmSync(join(context.home, dir), { recursive: true, force: true });
  await context.edit.start();
  await context.waitFor("Edit signed in after the cold start", async () => (await context.edit.api<{ signed_in: boolean }>("GET", "/api/account")).body.signed_in === true || null, 30_000);
}

const landed = (one: Laid["previews"][number]): boolean => {
  try {
    return fs.statSync(one.local).size === one.size;
  } catch {
    return false;
  }
};

/** What the Exports queue says of this project's export now, in a line. */
async function activity(context: Context, id: string): Promise<string> {
  const answer = await context.edit.api<unknown>("GET", "/api/exports/activity");
  const text = JSON.stringify(answer.body);
  const at = text.indexOf(id);
  return at < 0 ? "not listed" : text.slice(Math.max(0, at - 40), at + 420);
}

// ─────────────────────────────────────────────── exports

type Trouble = "down" | "silent" | "frozen";

/** An export of an edit whose footage has to come down first, with `trouble` in the middle of it. */
function coldExport(name: string, trouble: Trouble, spec: string): Case {
  return {
    name,
    change: "exports",
    spec,
    env: { EDIT_BAD_DAY_SPEED: "60" },
    async run(context) {
      const { line, edit } = context;
      const laid = await laidOut(context, name.replace(/[^a-z]/g, "").slice(-6));
      if (laid === null) return;
      // The same edit exported with everything here: what the cold one must come out as (check 7).
      await startExport(context, laid.id, "warm.mp4", true);
      const warm = await exported(context, laid.id, "warm.mp4", 300_000);
      context.check("the edit exports with its footage here", warm !== null, warm === null ? `no export after 300 s: ${await activity(context, laid.id)}` : `${warm.frames} frames`);
      if (warm === null) return;
      const warmFile = fileOf(context, warm);
      const kept = warmFile === null ? null : join(context.dir, "warm.mp4");
      if (warmFile !== null && kept !== null) fs.copyFileSync(warmFile, kept);
      await cold(context);
      // A slow home line: the footage (a few megabytes of excerpts here) takes the better part of a minute to come.
      line.reshape({ down: 2000 * KBIT, up: 8000 * KBIT });
      // Everything read from the cloud's storage since the export began: its excerpts, or the originals they're cut from.
      const before = line.sent("/r2/");
      const fetched = () => line.sent("/r2/") - before;
      const done = async () => (await edit.api<{ name: string; path: string }[]>("GET", `/api/projects/${laid.id}/exports`)).body.some?.((one) => one.name === "cold.mp4" || one.path.endsWith("/cold.mp4")) === true;
      const startedAt = Date.now();
      await startExport(context, laid.id, "cold.mp4", true);
      // The trouble begins once the export is reading its footage over the line.
      const reading = await until(context, () => fetched() > 1_000_000, 120_000, 100);
      context.log(`${(fetched() / 1e6).toFixed(1)} MB of the edit's footage fetched ${Math.round((Date.now() - startedAt) / 1000)} s into the export${reading ? "" : " (it never read 1 MB over the line)"}: ${await activity(context, laid.id)}`);
      context.check("the trouble began while the export was reading its footage", reading && !(await done()), reading ? `${(fetched() / 1e6).toFixed(1)} MB in` : "the export read under 1 MB from the cloud in two minutes: this run proves nothing about a bad line");
      let backAt = Date.now();
      const said = new Set<string>();
      const watch = async (ms: number) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          const now = (await activity(context, laid.id).catch(() => "no answer")).replace(/\d+(\.\d+)?/g, "N").slice(0, 300);
          if (!said.has(now)) {
            said.add(now);
            context.log(`the queue says: ${now}`);
          }
          await context.sleep(3000);
        }
      };
      if (trouble === "frozen") {
        // A lid shut for 40 s mid-export (the line cut with it, back 5 s after the wake).
        await context.freeze(40_000, 5000);
        backAt = Date.now();
      } else {
        line.set(trouble);
        // Down: two minutes here are two hours of waits at this speed. Silent: FFmpeg's own 30 s read limit and the
        // block reads' are real seconds, so 75 s is two of them and a bit.
        await watch(trouble === "down" ? 120_000 : 75_000);
        line.set("up");
        backAt = Date.now();
      }
      const cold_ = await exported(context, laid.id, "cold.mp4", 300_000);
      const took = Math.round((Date.now() - backAt) / 1000);
      context.check(
        "the export finished by itself once the trouble was over",
        cold_ !== null,
        cold_ === null ? `not after ${took} s: the queue says ${await activity(context, laid.id)}; the table: ${describeRows(rows(context).filter((row) => row.project === laid.id))}` : `${took} s after, ${cold_.frames} frames`,
      );
      if (cold_ !== null) {
        // What's left to read then comes at the line's 2 Mbit/s (a first run, Nov 21: the export had given up on its
        // excerpts during the drop and read its originals straight from the cloud, 2 min 45 s of its 171 s), so five
        // minutes: past that it waited on something other than the line.
        context.check("it finished within five minutes of the trouble ending", took <= 300, `${took} s`);
        sameVideo(context, "the cold export", kept, fileOf(context, cold_));
      }
      // Whether it had to wait and go again (the line gone under its reads), and how often: said, not judged. What's
      // judged is the end: done by itself, the same video, no row failed (the common checks).
      const waited = edit.log().split("\n").filter((one) => /\[export\].*it waits and goes again by itself/.test(one));
      context.log(`the export waited and went again ${waited.length} time(s)${waited.length > 0 ? `: ${waited[0]!.slice(24, 220)}` : ""}`);
    },
  };
}

// ─────────────────────────────────────────────── a play

/** What a play reads of a file each second (bytes): a little over the preview's own rate. */
const READ_STEP = 512 * 1024;

interface Play {
  /** When the play began (ms since the epoch). */
  began: number;
  /** Each read the player made: when (ms into the play), and how long its bytes took. */
  reads: { at: number; ms: number; ok: boolean }[];
  stop: () => Promise<void>;
}

/**
 * A play of the edit from its start, as the server sees one: the page says where the playhead is and that it plays
 * (`playback/warm`, every second here, the frame moving at 30 a second), and the player reads the first file's
 * preview on from its start, half a megabyte a second.
 */
function play(context: Context, laid: Laid): Play {
  const { edit } = context;
  const began = Date.now();
  let going = true;
  const reads: Play["reads"] = [];
  const told = (async () => {
    while (going) {
      const frame = Math.round(((Date.now() - began) / 1000) * 30);
      await edit.api("POST", `/api/projects/${laid.id}/playback/warm`, { frame, playing: true }).catch(() => undefined);
      await context.sleep(1000);
    }
    await edit.api("POST", `/api/projects/${laid.id}/playback/warm`, { frame: 0, playing: false }).catch(() => undefined);
  })();
  const first = laid.previews[0]!;
  const reading = (async () => {
    let at = 0;
    while (going && at < first.size) {
      const from = Date.now();
      let ok = false;
      try {
        const answer = await fetch(`${edit.url}${first.url}`, { headers: { range: `bytes=${at}-${Math.min(first.size, at + READ_STEP) - 1}` }, signal: AbortSignal.timeout(60_000) });
        const bytes = await answer.arrayBuffer();
        ok = answer.status === 206 && bytes.byteLength > 0;
        if (ok) at += bytes.byteLength;
      } catch {
        ok = false;
      }
      reads.push({ at: from - began, ms: Date.now() - from, ok });
      await context.sleep(Math.max(0, 1000 - (Date.now() - from)));
    }
  })();
  return {
    began,
    reads,
    async stop() {
      going = false;
      await Promise.all([told, reading]);
    },
  };
}

const coldPlay: Case = {
  name: "cold-open-play",
  change: "playback",
  spec:
    "An edit whose footage is only in the cloud, opened cold on a 50 Mbit/s line, and played at once: the page says it plays every second, and a player reads the first file half a megabyte a second. " +
    "Checks: the play's own reads are answered within 3 s throughout; the footage's whole copies keep coming down while it plays and are here within a minute " +
    "(Nov 20: a play, or its spinner, stopped every download that would have made it smooth, so it played well only after sitting paused); " +
    "then, cold again, the line drops for 8 s mid-play: reads are answered again within 5 s of it coming back, and the copies still land within a minute (a 3 s drop marked every copy under way failed for ten minutes).",
  async run(context) {
    const { line } = context;
    const laid = await laidOut(context, "Play");
    if (laid === null) return;
    const total = laid.previews.reduce((sum, one) => sum + one.size, 0);

    // 1. Cold, a good line, played from the moment it opens.
    await cold(context);
    line.reshape({ down: 50_000 * KBIT, up: 20_000 * KBIT });
    let playing = play(context, laid);
    const here = await until(context, () => laid.previews.every(landed), 60_000, 500);
    await context.sleep(3000);
    await playing.stop();
    const slow = playing.reads.filter((one) => !one.ok || one.ms > 3000);
    context.check(
      "the play's reads were answered within 3 s throughout",
      slow.length === 0 && playing.reads.length > 0,
      `${playing.reads.length} reads, the slowest ${Math.max(0, ...playing.reads.map((one) => one.ms))} ms${slow.length > 0 ? `; ${slow.length} slow or failed, the first at +${Math.round(slow[0]!.at / 1000)} s` : ""}`,
    );
    context.check(
      "the footage's whole copies came down while it played",
      here,
      here
        ? `${laid.previews.length} copies (${(total / 1e6).toFixed(1)} MB) here within a minute of a play that never paused`
        : `after a minute of playing: ${laid.previews.map((one) => `${one.key.split("/").pop()} ${landed(one) ? "here" : "not here"}`).join(", ")}; ${(laid.previews.reduce((sum, one) => sum + line.sent(`/r2/${one.key}`), 0) / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB fetched`,
    );

    // 2. Cold again, and the Wi-Fi drops for 8 s as the copies come.
    await cold(context);
    const before = laid.previews.reduce((sum, one) => sum + line.sent(`/r2/${one.key}`), 0);
    playing = play(context, laid);
    await until(context, () => laid.previews.reduce((sum, one) => sum + line.sent(`/r2/${one.key}`), 0) - before > total * 0.25, 30_000, 100);
    line.set("down");
    await context.sleep(8000);
    line.set("up");
    const back = Date.now();
    // The first read answered after the line is back (one begun during the drop may be the one that comes through).
    const answered = () => playing.reads.find((one) => one.ok && playing.began + one.at + one.ms > back);
    await until(context, () => answered() !== undefined, 20_000, 100);
    const first = answered();
    const lateBy = first === undefined ? null : playing.began + first.at + first.ms - back;
    const landedAgain = await until(context, () => laid.previews.every(landed), 60_000, 500);
    await playing.stop();
    context.check("reads were answered again within 5 s of the line coming back", lateBy !== null && lateBy <= 5000, lateBy === null ? "none in 20 s" : `${(lateBy / 1000).toFixed(1)} s`);
    context.check(
      "the copies still landed within a minute of the line coming back",
      landedAgain,
      landedAgain ? `all ${laid.previews.length} here ${Math.round((Date.now() - back) / 1000)} s after` : `${laid.previews.map((one) => `${one.key.split("/").pop()} ${landed(one) ? "here" : "not here"}`).join(", ")}`,
    );
  },
};

export const coldCases: Case[] = [
  coldExport(
    "cold-export-drop",
    "down",
    "Time run 60 times faster, the line held to 2 Mbit/s. An edit whose footage is only in the cloud is exported; a megabyte into its footage coming down the line drops for 120 s (two hours of waits at this speed), then comes back. " +
      "Checks: the export finishes by itself within five minutes of the line coming back, the same video as with its footage here; no export failed; nothing was asked; Edit answered throughout.",
  ),
  coldExport(
    "cold-export-silent",
    "silent",
    "The same export, the line going silent for 75 s instead (connections held, nothing passing: Wi-Fi with no internet, where every read waits out its own limit). " +
      "Checks: as cold-export-drop.",
  ),
  coldExport(
    "cold-export-frozen",
    "frozen",
    "The same export, Edit and everything under it frozen for 40 s in the middle (a lid shut; the line cut with it and back 5 s after the wake). Checks: as cold-export-drop.",
  ),
  coldPlay,
];
