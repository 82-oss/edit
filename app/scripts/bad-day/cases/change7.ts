// The cases for change 7 of final.md (one table for all long work), and
// check 7 (the same saved edit gives the same video): a dropped line under
// each import with the census's answers pressed, a share and an upload waiting
// on the same drop as a Script import, Edit killed three times at each step,
// a share's upload dropped, a share failed then a newer build, and the one
// answer to "what runs now". verify.md findings 1, 2, 3 and 6 are what they
// were written to catch.
//
// Time: EDIT_BAD_DAY_SPEED=60 runs failure.ts's waits 60 times faster (a
// minute is a second); the job table still looks every 30 s, real. A build
// without the switch (7b59f4e2) runs at real speed, so its waits of a minute
// and five show as an import that comes back minutes after the line.

import * as fs from "node:fs";
import { join } from "node:path";

import type { DriveFile } from "../cloud.ts";
import type { Case, Context } from "./index.ts";
import {
  KBIT,
  describeJob,
  describeRows,
  describeScript,
  editorImport,
  exported,
  exportsOf,
  fileOf,
  filesUnder,
  importDone,
  job,
  live,
  logSince,
  project,
  restart,
  rows,
  sameVideo,
  script,
  scriptImport,
  shape,
  shareLink,
  shareRow,
  startExport,
  startShare,
  until,
  whole,
  type Row,
} from "./work.ts";

/** A Drive id of the stand-in's (27 characters, as Drive's are), unique by its tag. */
const driveId = (tag: string) => `1BadDay${tag}`.padEnd(27, "x").slice(0, 27);

const seconds = (ms: number) => Math.round(ms / 1000);

/** An edit to export or share: one 10-second range of a recording, laid out. Null (and a failed check) if it never was. */
async function editToShare(context: Context, tag: string): Promise<string | null> {
  const id = await editorImport(context, [{ id: driveId(`${tag}S`), clip: context.footage.recordings[2]!, ranges: [[5, 15]] }], `Share ${tag}`);
  const done = await importDone(context, id, 240_000);
  if (done === null) {
    context.check("the edit to share was laid out", false, describeJob(await job(context, id)));
    return null;
  }
  return id;
}

// ─────────────────────────────────────────────── wifi-drop-editor-import

/** Every answer in the census (final.md change 9) the editor's import can be sent, as if its button were pressed. */
const ANSWERS: { name: string; send: (context: Context, id: string, b: string, other: string) => Promise<{ status: number; text: string }> }[] = [
  { name: "Make the edit with its parts black (the file by name)", send: (c, id, b) => c.edit.api("POST", `/api/projects/${id}/script/footage`, { file: b, skip: true }) },
  { name: "Make the edit with its parts black (every file)", send: (c, id) => c.edit.api("POST", `/api/projects/${id}/script/footage`, { file: "*", skip: true }) },
  { name: "Use another link", send: (c, id, b, other) => c.edit.api("POST", `/api/projects/${id}/script/footage`, { file: b, url: `https://drive.google.com/file/d/${other}/view` }) },
  { name: "Try again", send: (c, id) => c.edit.api("POST", `/api/projects/${id}/script/job`) },
  { name: "Retry now (footage not here)", send: (c, id) => c.edit.api("POST", `/api/projects/${id}/missing/retry`) },
  {
    name: "Export with its parts black (footage not here)",
    send: async (c, id, b) => {
      const media = (await project(c, id)).media?.map((one) => one.id) ?? [];
      let last = { status: 0, text: "" };
      for (const one of [...media, b]) last = await c.edit.api("POST", `/api/projects/${id}/missing/${encodeURIComponent(one)}/without`);
      return last;
    },
  },
  { name: "Retry (an export)", send: (c, id) => c.edit.api("POST", `/api/projects/${id}/export/retry`) },
];

/** Every `every` ms, the import's row for file `file`: each new next-try noted with when it was first seen (finding 2). */
function followTries(context: Context, id: string, file: string, every = 250): { stop: () => void; waits: () => { tries: number; wait: number }[] } {
  const seen: { tries: number; retryAt: number; at: number }[] = [];
  let going = true;
  void (async () => {
    while (going) {
      try {
        const row = (await job(context, id))?.files.find((one) => one.file === file);
        if (row?.retry_at !== undefined && row.state !== "done" && seen.at(-1)?.retryAt !== row.retry_at) {
          seen.push({ tries: row.tries ?? 0, retryAt: row.retry_at, at: Date.now() });
          context.log(`file ${file.slice(0, 14)}: tries ${row.tries ?? "?"}, next try in ${((row.retry_at - Date.now()) / 1000).toFixed(1)} s (${(row.error ?? row.why ?? "").slice(0, 100)})`);
        }
      } catch {}
      await context.sleep(every);
    }
  })();
  return { stop: () => void (going = false), waits: () => seen.map((one) => ({ tries: one.tries, wait: (one.retryAt - one.at) / 1000 })) };
}

/** Drops the line for `ms` the first time the cloud is asked for `file`'s original (the cut of the second file); when it went down and came back. */
function dropOnSecond(context: Context, file: string, ms: number): { down: () => number; back: () => number } {
  let down = 0;
  let back = 0;
  context.cloud.beforeR2Get = (key) => {
    if (down !== 0 || !key.includes(file)) return;
    down = Date.now();
    context.log(`the line drops for ${seconds(ms)} s as the cloud is asked for ${key}`);
    context.line.set("down");
    setTimeout(() => {
      context.line.set("up");
      back = Date.now();
    }, ms);
  };
  return { down: () => down, back: () => back };
}

const wifiDropEditor: Case = {
  name: "wifi-drop-editor-import",
  change: "7",
  spec:
    "The night of Nov 18, time run 60 times faster. Two files; the line drops for 150 s as the second is cut, past the last quick try, so its try fails again and again. " +
    "Checks: its tries' waits grow 1, 5, 15, 30 (minutes, here seconds: verify.md finding 2); nothing is asked; the import finishes within 20 s of the line coming back. " +
    "Then, one import each, every answer in the census is sent while the line is down (40 s) as if its button had been pressed, shown or not: " +
    "no answer changes the ranges, none goes on without a file, and each import finishes within 20 s of the line coming back.",
  env: { EDIT_BAD_DAY_SPEED: "60" },
  async run(context) {
    const { footage } = context;
    const [one, two, three] = footage.recordings;
    // The first night: the tries' schedule.
    const a = driveId("WifiE0A");
    const b = driveId("WifiE0B");
    const drop = dropOnSecond(context, b, 150_000);
    const first = await editorImport(context, [
      { id: a, clip: one!, ranges: [[5, 15]] },
      { id: b, clip: two!, ranges: [[10, 20]] },
    ], "Wifi drop");
    const tries = followTries(context, first, b);
    const went = await until(context, () => drop.down() > 0, 180_000, 250);
    context.check("the line dropped as the second file was cut", went, went ? `at +${seconds(drop.down() - context.started)} s` : describeJob(await job(context, first)));
    if (!went) return;
    const before = shape(await project(context, first));
    await until(context, () => drop.back() > 0, 200_000, 250);
    const done = await importDone(context, first, 120_000);
    tries.stop();
    const after = done === null ? null : seconds(Date.now() - drop.back());
    context.check("the import finished within 20 s of the line coming back", after !== null && after <= 20, after === null ? `not in 120 s: ${describeJob(await job(context, first))}` : `${after} s after`);
    const waits = tries.waits();
    const expected = [1, 5, 15, 30];
    const near = (wait: number, want: number) => Math.abs(wait - want) <= Math.max(1.5, want * 0.3);
    const grew = waits.length >= 4 && expected.every((want, i) => near(waits[i]!.wait, want));
    context.check(
      "the second file's waits grow 1, 5, 15, 30 (finding 2)",
      grew,
      waits.length === 0 ? "no next try was ever set on the file" : `tries/waits seen: ${waits.map((one) => `${one.tries}:${one.wait.toFixed(1)} s`).join(", ")}`,
    );
    const end = shape(await project(context, first));
    context.check("the ranges are the same after the drop", end.ranges === before.ranges && end.gone === 0, `${before.ranges} → ${end.ranges}, ${end.gone} gone without`);
    // Every answer, one import each.
    const changed: string[] = [];
    const late: string[] = [];
    const said: string[] = [];
    for (const [n, answer] of ANSWERS.entries()) {
      const tag = `WifiE${n + 1}`;
      const fileA = driveId(`${tag}A`);
      const fileB = driveId(`${tag}B`);
      const other = driveId(`${tag}C`);
      context.cloud.addFile("1BadDayEditorFolder00000007", other, three!);
      const round = dropOnSecond(context, fileB, 40_000);
      const id = await editorImport(context, [
        { id: fileA, clip: one!, ranges: [[5, 15]] },
        { id: fileB, clip: two!, ranges: [[10, 20]] },
      ], `Wifi answer ${n + 1}`);
      if (!(await until(context, () => round.down() > 0, 120_000, 250))) {
        late.push(`${answer.name}: the line never dropped (${describeJob(await job(context, id))})`);
        continue;
      }
      const ranges = shape(await project(context, id));
      // Pressed once it waits on the file by itself (or 15 s into the drop, whatever it's doing).
      await until(context, async () => (await job(context, id))?.files.find((file) => file.file === fileB)?.state === "waiting", 15_000, 250);
      const reply = await answer.send(context, id, fileB, other);
      said.push(`${answer.name}: ${reply.status} ${reply.text.slice(0, 120)}`);
      context.log(`pressed "${answer.name}": ${reply.status} ${reply.text.slice(0, 200)}`);
      await until(context, () => round.back() > 0, 60_000, 250);
      const ended = await importDone(context, id, 90_000);
      const took = seconds(Date.now() - round.back());
      const now = shape(await project(context, id));
      if (now.ranges !== ranges.ranges || now.gone > 0) changed.push(`${answer.name}: ${ranges.ranges} → ${now.ranges}, ${now.gone} gone without`);
      if (ended === null || took > 20) late.push(`${answer.name}: ${ended === null ? `not done 90 s after the line: ${describeJob(await job(context, id))}` : `${took} s after the line`}`);
    }
    context.log(`answers: ${said.join(" | ")}`);
    context.check("no answer changed the ranges", changed.length === 0, changed.length === 0 ? `${ANSWERS.length} answers, each import's ranges as written` : changed.join(" | "));
    context.check("each import finished within 20 s of the line coming back", late.length === 0, late.length === 0 ? `${ANSWERS.length} imports` : late.join(" | "));
  },
};

// ─────────────────────────────────────────────── wifi-drop-script-import

const UPLOADS = new Set(["upload", "archive", "full"]);

const wifiDropScript: Case = {
  name: "wifi-drop-script-import",
  change: "7",
  spec:
    "Time run 60 times faster, uploads held to 20 Mbit/s. A three-recording case in Script mode mid-import (its second and third recordings held), and a share of another edit, " +
    "its export's copy for the cloud and its full-quality file going up beside it: the line drops for 90 s as the share publishes; Edit is killed and started again 20 s into the drop. " +
    "After the line is back the case's third recording takes 45 s more, so the import runs on. " +
    "Checks: everything that waited on the drop (the import, the share, the uploads) goes again within 30 s of the line coming back, none behind another (verify.md finding 1); " +
    "no 'import stopped'; the import's row survives the kill; the case is whole; the share's link comes by itself; the uploads end.",
  env: { EDIT_BAD_DAY_SPEED: "60" },
  paidAtMost: { hearings: 6 },
  async run(context) {
    const { cloud, line, footage } = context;
    const toShare = await editToShare(context, "WifiS");
    if (toShare === null) return;
    const ids = [driveId("WifiS1"), driveId("WifiS2"), driveId("WifiS3")];
    line.reshape({ up: 20_000 * KBIT });
    // The second and third recordings are held until the line drops (so the import is mid-case); after it's back, the
    // third's next download takes 45 s.
    let phase: "before" | "down" | "after" = "before";
    let release: () => void = () => {};
    const dropped = new Promise<void>((resolve) => (release = resolve));
    let slowed = false;
    cloud.beforeDownload = async (file: DriveFile) => {
      if (phase === "before" && (file.id === ids[1] || file.id === ids[2])) await dropped;
      else if (phase === "after" && file.id === ids[2] && !slowed) {
        slowed = true;
        context.log("the third recording's download takes 45 s");
        await context.sleep(45_000);
      }
    };
    let downAt = 0;
    cloud.beforeConvex = (path) => {
      if (downAt !== 0 || path !== "reviews:publish") return;
      downAt = Date.now();
      phase = "down";
      context.log("as the share publishes: the line drops for 90 s");
      line.set("down");
      release();
    };
    const id = await scriptImport(context, "1BadDayWifiScriptFolder0001", ids.map((one, i) => ({ id: one, clip: footage.recordings[i]! })));
    await startShare(context, toShare);
    const went_down = await until(context, () => downAt > 0, 400_000, 250);
    context.log(`at the drop: ${describeRows(rows(context))}`);
    if (!went_down) {
      context.check("the share reached its publish", false, describeRows(rows(context)));
      return;
    }
    // What waits while the line is down (seen at any look), and when each goes again once it's back.
    const waited = new Set<string>();
    const look = () => {
      for (const row of rows(context)) if (row.state === "waiting") waited.add(row.key);
    };
    const looking = setInterval(look, 250);
    const uploadsBeside = rows(context).filter((row) => UPLOADS.has(row.kind) && live(row)).map((row) => row.key);
    await context.sleep(20_000);
    await restart(context, "20 s into the drop");
    const afterKill = rows(context).find((row) => row.key === `script:${id}`) ?? rows(context).find((row) => row.kind === "script");
    context.check("the import's row survived the kill", afterKill !== undefined && live(afterKill), afterKill === undefined ? `no script row: ${describeRows(rows(context))}` : describeRows([afterKill]));
    await context.sleep(Math.max(0, downAt + 90_000 - Date.now()));
    look();
    clearInterval(looking);
    for (const row of rows(context)) if (UPLOADS.has(row.kind) && live(row) && !uploadsBeside.includes(row.key)) uploadsBeside.push(row.key);
    context.check(
      "the share and an upload waited on the drop beside the import",
      [...waited].some((key) => key.startsWith("share:")) && [...waited].some((key) => key.startsWith("script:")) && uploadsBeside.length > 0,
      `waited: ${[...waited].join(", ") || "nothing"}; uploads going: ${uploadsBeside.join(", ") || "none"}`,
    );
    phase = "after";
    line.set("up");
    const backAt = Date.now();
    context.log(`the line is back; waited during the drop: ${[...waited].join(", ")}; now ${describeRows(rows(context))}`);
    const went = new Map<string, number>();
    const watch = setInterval(() => {
      const now = new Map(rows(context).map((row) => [row.key, row] as const));
      for (const key of waited) {
        if (went.has(key)) continue;
        const row = now.get(key);
        if (row === undefined || row.state !== "waiting") went.set(key, Date.now() - backAt);
      }
    }, 250);
    const ended = await context.waitFor("the case whole, the link up and the uploads ended", async () => {
      const one = await script(context, id);
      const uploads = rows(context).filter((row) => UPLOADS.has(row.kind) && live(row));
      return whole(one) && shareLink(context, toShare) !== null && uploads.length === 0 ? one : null;
    }, 420_000);
    clearInterval(watch);
    const slow = [...waited].filter((key) => (went.get(key) ?? Number.POSITIVE_INFINITY) > 30_000);
    context.check(
      "everything that waited on the drop went again within 30 s of the line (finding 1)",
      waited.size > 0 && slow.length === 0,
      waited.size === 0 ? "nothing waited during the drop" : [...waited].map((key) => `${key}: ${went.has(key) ? `${seconds(went.get(key)!)} s` : "still waiting"}`).join(", "),
    );
    const last = await script(context, id);
    context.check("the case is whole", whole(last), describeScript(last));
    context.check("the share's link came by itself", shareLink(context, toShare) !== null, describeRows(rows(context).filter((row) => row.kind === "share")));
    const uploads = rows(context).filter((row) => UPLOADS.has(row.kind) && live(row));
    context.check("the uploads ended", uploads.length === 0, uploads.length === 0 ? "none left" : describeRows(uploads));
    if (ended === null) context.log(`at the end: ${describeRows(rows(context))}`);
  },
};

// ─────────────────────────────────────────────── kill-three-times

/**
 * Kills Edit `times` times in a row at a step: each time `at` comes true (after the start before), it's killed and
 * started again. How many kills landed (a step that has passed before it's seen again isn't waited for past `ms`).
 */
async function killAt(context: Context, label: string, at: (since: number) => boolean | Promise<boolean>, times = 3, ms = 90_000): Promise<number> {
  let kills = 0;
  for (let i = 0; i < times; i++) {
    const since = Date.now();
    if (!(await until(context, () => at(since), ms, 100))) {
      context.log(`${label}: not seen again within ${seconds(ms)} s after kill ${kills}`);
      break;
    }
    await restart(context, `${label} (${i + 1} of ${times})`);
    kills += 1;
  }
  return kills;
}

/** A request whose path starts with `prefix` answered since `since` (ms) and `after` ms ago or more. */
function answered(context: Context, prefix: string, since: number, after = 300): boolean {
  return context.cloud.seen.some((one) => one.at >= since && one.path.startsWith(prefix) && one.status > 0 && one.status < 400 && Date.now() - one.at >= after);
}

/** A request through the line since `since`, whose request line starts with `prefix`, under way: its answer coming (a download) or its body going (an upload, 200 kB of it). */
function asked(context: Context, prefix: string, since: number): boolean {
  return context.line.requests.some((one) => one.at >= since && one.line.startsWith(prefix) && (one.bytes > 0 || one.up > 200_000));
}

const killThreeTimes: Case = {
  name: "kill-three-times",
  change: "7",
  spec:
    "Time run 60 times faster. Edit is killed three times in a row at each step of a Script import (its downloads, its hearings), an editor import (its cut, its voice), " +
    "an export (its render, its copy to the cloud) and a share (its export, its upload, its publish), each time started again. " +
    "Checks: nothing is given up; every piece of work is listed once; nothing already fetched is fetched again (each recording about once from Drive); " +
    "nothing paid is sent twice (a hearing a recording, a voice a line); check 7: the export killed three times is the same video as a clean export of the same edit.",
  env: { EDIT_BAD_DAY_SPEED: "60" },
  // A hearing a recording and one a voice-over cut-in (the editor hears its own voice), a voice a line.
  paidAtMost: { hearings: 5, voices: 2 },
  async run(context) {
    const { line, footage, cloud } = context;
    const kills: string[] = [];
    // ── A Script import: downloads at 4 Mbit/s, so a kill lands in one.
    line.reshape({ down: 4000 * KBIT });
    const ids = [driveId("Kill1"), driveId("Kill2"), driveId("Kill3")];
    const scriptId = await scriptImport(context, "1BadDayKillScriptFolder0001", ids.map((one, i) => ({ id: one, clip: footage.recordings[i]! })));
    kills.push(`Script downloads ${await killAt(context, "a recording downloading", (since) => asked(context, "GET /www.googleapis.com/drive/v3/files/", since), 3, 15_000)}`);
    kills.push(`Script hearings ${await killAt(context, "a recording just heard", (since) => answered(context, "/v1/transcribe", since), 3, 60_000)}`);
    line.reshape({ down: 0 });
    const scripted = await context.waitFor("the case whole", async () => {
      const one = await script(context, scriptId);
      return whole(one) ? one : null;
    }, 300_000);
    context.check("the Script import came in whole", scripted !== null, describeScript(await script(context, scriptId)));
    // ── An editor import: the cut and the voice.
    const fileA = driveId("KillEA");
    const fileB = driveId("KillEB");
    line.reshape({ down: 4000 * KBIT });
    const editId = await editorImport(context, [
      { id: fileA, clip: footage.recordings[0]!, ranges: [[5, 15]] },
      { id: fileB, clip: footage.recordings[1]!, ranges: [[10, 20]] },
    ], "Killed");
    kills.push(`editor cut ${await killAt(context, "an excerpt being cut", (since) => asked(context, "GET /r2/edit/originals/", since), 3, 30_000)}`);
    line.reshape({ down: 0 });
    kills.push(`editor voice ${await killAt(context, "the import voicing its lines", async (since) => answered(context, "/v1/speech", since) || ((await job(context, editId))?.state === "voicing" && Date.now() - since > 1000), 3, 60_000)}`);
    const imported = await importDone(context, editId, 300_000);
    context.check("the editor import finished", imported !== null, describeJob(await job(context, editId)));
    if (imported === null) return;
    // ── Check 7's first video: a clean export of this edit, kept here.
    await startExport(context, editId, "clean.mp4", true);
    const clean = await exported(context, editId, "clean.mp4", 600_000);
    context.check("the clean export finished", clean !== null, clean === null ? describeRows(rows(context).filter((row) => row.kind === "export")) : `${clean.frames} frames`);
    if (clean === null) return;
    const cleanCopy = join(context.dir, "clean.mp4");
    fs.copyFileSync(clean.path, cleanCopy);
    // Its chunks gone (as a cache clean-up leaves it), so the next export of the same edit renders every frame again.
    fs.rmSync(join(context.home, "cache", "export-chunks"), { recursive: true, force: true });
    // ── The same edit exported again, killed three times while it renders and three while its copy goes to the cloud (slowed to 16 Mbit/s).
    const logAt = context.edit.log().length;
    line.reshape({ up: 16_000 * KBIT });
    await startExport(context, editId, "killed.mp4", false);
    kills.push(`export render ${await killAt(context, "the export rendering", (since) => rows(context).some((row) => row.kind === "export" && row.state === "running") && Date.now() - since > 2500, 3, 60_000)}`);
    kills.push(`export to the cloud ${await killAt(context, "the export going up", (since) => asked(context, "PUT /r2/edit/exports/", since), 3, 180_000)}`);
    line.reshape({ up: 0 });
    const again = await exported(context, editId, "killed.mp4", 600_000);
    const up = await until(context, () => !rows(context).some((row) => row.kind === "archive" && live(row)), 300_000, 500);
    context.check("the killed export finished and went up", again !== null && up, again === null ? describeRows(rows(context).filter((row) => row.kind === "export" || row.kind === "archive")) : `${again.frames} frames${up ? "" : `; ${describeRows(rows(context).filter((row) => row.kind === "archive"))}`}`);
    sameVideo(context, "an export killed three times while it rendered", cleanCopy, again === null ? null : fileOf(context, (await exported(context, editId, "killed.mp4", 5000)) ?? again));
    const renders = logSince(context, logAt, /exported \d+ frames in/);
    context.log(`renders after the clean one: ${renders.length}`);
    // ── A share: killed three times at its export, its upload (slowed) and its publish.
    line.reshape({ up: 16_000 * KBIT });
    await startShare(context, editId);
    kills.push(`share export ${await killAt(context, "the share exporting", (since) => shareRow(context, editId)?.step === "exporting" && Date.now() - since > 2500, 3, 60_000)}`);
    const uploadFrom = Date.now();
    kills.push(`share upload ${await killAt(context, "the share uploading", (since) => asked(context, "PUT /r2/edit/reviews/", since), 3, 180_000)}`);
    line.reshape({ up: 0 });
    // Published (maybe just as its upload was killed the last time): killed once it is, and again for each publish after.
    let killedAfter = uploadFrom;
    kills.push(`share publish ${await killAt(context, "the share just published", () => {
      const one = cloud.published.find((each) => each.at >= killedAfter && Date.now() - each.at >= 300);
      if (one !== undefined) killedAfter = Date.now();
      return one !== undefined;
    }, 3, 60_000)}`);
    const link = await context.waitFor("the share's link", () => shareLink(context, editId), 600_000);
    context.check("the share's link came", link !== null, describeRows(rows(context).filter((row) => row.kind === "share" || row.kind === "full")));
    await until(context, () => !rows(context).some(live), 300_000, 1000);
    context.log(`kills: ${kills.join(", ")}`);
    // ── What a person would judge.
    const list = rows(context);
    const by = new Map<string, number>();
    for (const row of list) by.set(`${row.kind}:${row.project}`, (by.get(`${row.kind}:${row.project}`) ?? 0) + 1);
    const twice = [...by.entries()].filter(([key, n]) => n > 1 && !key.startsWith("upload:") && !key.startsWith("full:"));
    context.check("every piece of work is listed once", twice.length === 0, twice.length === 0 ? `${list.length} rows, one a piece of work` : twice.map(([key, n]) => `${key} ×${n}`).join(", "));
    const gave = context.edit.log().split("\n").filter((one) => /given up|gave up|giving up/i.test(one));
    context.check("nothing is given up", gave.length === 0, gave.length === 0 ? "no 'given up' in Edit's log" : gave.slice(0, 3).map((one) => one.slice(0, 200)).join(" | "));
    const drive = ids.map((one) => ({ id: one, sent: context.line.sent(`/www.googleapis.com/drive/v3/files/${one}`), size: cloud.drive.get(one)!.size }));
    const over = drive.filter((one) => one.sent > one.size * 1.3);
    context.check("each recording came down from Drive about once", over.length === 0, drive.map((one) => `${(one.sent / 1e6).toFixed(1)}/${(one.size / 1e6).toFixed(1)} MB`).join(", "));
    // A step whose work was kept isn't asked for again after a kill (a voice, a download done): one kill there is all there can be.
    context.check("Edit was killed at every step", kills.every((one) => !/ 0$/.test(one)), kills.join(", "));
    context.log(`renders in all after the clean one (export and share): ${logSince(context, logAt, /exported \d+ frames in/).length}`);
  },
};

// ─────────────────────────────────────────────── share-drop

const shareDrop: Case = {
  name: "share-drop",
  change: "7",
  spec:
    "Time run 60 times faster, uploads held to 2 Mbit/s. A share of a laid-out edit; the line drops for 45 s 600 kB into its upload, and again for 60 s as it publishes. " +
    "Checks: the share waits and its link comes by itself (within 3 minutes of the line); it never ends failed and nothing says 'stopped'; " +
    "the bytes sent of its video are at most the file plus one part for each drop.",
  env: { EDIT_BAD_DAY_SPEED: "60" },
  async run(context) {
    const { cloud, line } = context;
    const id = await editToShare(context, "Drop");
    if (id === null) return;
    line.reshape({ up: 2000 * KBIT });
    let uploadDrop = 0;
    let publishDrop = 0;
    let back = 0;
    // Mid-upload as the line sees it (the stand-in only hears a PUT once its whole body is in): 600 kB of the video sent.
    const videoSent = () => [...line.byPathUp.entries()].filter(([path]) => path.startsWith(`/r2/edit/reviews/${id}/`) && path.endsWith("/video.mp4")).reduce((sum, [, bytes]) => sum + bytes, 0);
    const midUpload = setInterval(() => {
      if (uploadDrop !== 0 || videoSent() < 600_000) return;
      uploadDrop = Date.now();
      clearInterval(midUpload);
      context.log(`${(videoSent() / 1e6).toFixed(2)} MB into the upload: the line drops for 45 s`);
      line.set("down");
      setTimeout(() => {
        line.set("up");
        back = Date.now();
      }, 45_000);
    }, 100);
    cloud.beforeConvex = (path) => {
      if (publishDrop !== 0 || path !== "reviews:publish") return;
      publishDrop = Date.now();
      context.log("as it publishes: the line drops for 60 s");
      line.set("down");
      setTimeout(() => {
        line.set("up");
        back = Date.now();
      }, 60_000);
    };
    let failed: Row | null = null;
    const watch = setInterval(() => {
      const row = shareRow(context, id);
      if (row?.state === "failed" && failed === null) {
        failed = row;
        context.log(`the share ended failed: ${row.error}`);
      }
    }, 250);
    await startShare(context, id);
    const link = await context.waitFor("the share's link", () => shareLink(context, id), 600_000);
    clearInterval(watch);
    clearInterval(midUpload);
    context.check("the line dropped in the upload and at the publish", uploadDrop > 0 && publishDrop > 0, `upload ${uploadDrop > 0 ? "yes" : "no"}, publish ${publishDrop > 0 ? "yes" : "no"}`);
    const after = back === 0 ? null : seconds(Date.now() - back);
    context.check("the link came by itself within 3 minutes of the line", link !== null && after !== null && after <= 180, link === null ? `no link: ${describeRows(rows(context).filter((row) => row.kind === "share"))}` : `${after} s after the line was back`);
    context.check("the share never ended failed", failed === null, failed === null ? "it waited" : `failed: ${(failed as Row).error}`);
    const key = cloud.published.at(-1)?.key;
    const objects = cloud.mock.cloud.objects as unknown as { pathOf(key: string): string; has(key: string): boolean };
    const size = key !== undefined && objects.has(key) ? fs.statSync(objects.pathOf(key)).size : 0;
    const sent = key === undefined ? line.sentUp(`/r2/edit/reviews/${id}/`) : line.sentUp(`/r2/${key}`);
    const part = Math.min(size, 16 * 1024 * 1024);
    context.check(
      "the video's bytes sent are at most the file plus a part for the drop",
      size > 0 && sent <= size + part + 64 * 1024,
      `${(sent / 1e6).toFixed(2)} MB sent for a ${(size / 1e6).toFixed(2)} MB video`,
    );
  },
};

// ─────────────────────────────────────────────── upload-failed-then-update

const uploadFailedThenUpdate: Case = {
  name: "upload-failed-then-update",
  change: "7",
  spec:
    "A share whose upload the cloud refuses (403, every time) until it ends failed; then Edit starts as a newer build (last-build.json says an older one ran), the cloud taking uploads again. " +
    "Checks: the share goes up from the export it has, by itself; no chunk is rendered again (the export's chunks as they were, no new render in the log); check 7: the shared video is the export's.",
  // Not a trial server: a trial server never tries anything again after an update (serve.ts).
  env: { EDIT_BAD_DAY_SPEED: "60", EDIT_TRIALS: "0" },
  // The share failed for good on the old build: that says so, once (its own check judges the rest).
  allowed: [/Sharing stopped/],
  async run(context) {
    const { cloud, home } = context;
    const id = await editToShare(context, "Upd");
    if (id === null) return;
    let refused = 0;
    cloud.beforeR2Put = (key) => {
      if (!/^edit\/reviews\/.+\/video\.mp4$/.test(key)) return;
      refused += 1;
      return new Response("<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 });
    };
    await startShare(context, id);
    const ended = await context.waitFor("the share to fail at its upload", () => {
      const row = shareRow(context, id);
      return row?.state === "failed" ? row : null;
    }, 600_000);
    context.check("the share failed at its upload", ended !== null && refused > 0, ended === null ? `it didn't (${refused} uploads refused): ${describeRows(rows(context).filter((row) => row.kind === "share"))}` : `${refused} refused; ${ended.step}: ${ended.error}`);
    if (ended === null) return;
    const chunks = filesUnder(join(home, "cache", "export-chunks"));
    const exportsBefore = await exportsOf(context, id);
    const logAt = context.edit.log().length;
    cloud.beforeR2Put = null;
    // A newer build: the one noted as last run here is an older one.
    fs.writeFileSync(join(home, "last-build.json"), JSON.stringify({ build: "v0.0.0-before-bad-day", at: Date.now() - 3600_000 }));
    await restart(context, "a newer build starts");
    const link = await context.waitFor("the share's link after the update", () => shareLink(context, id), 300_000);
    context.check("the share went up by itself after the update", link !== null, link === null ? describeRows(rows(context).filter((row) => row.kind === "share" || row.kind === "export")) : link);
    const renders = logSince(context, logAt, /exported \d+ frames in/);
    const now = filesUnder(join(home, "cache", "export-chunks"));
    const changed = [...now.entries()].filter(([path, mark]) => chunks.get(path) !== mark).map(([path]) => path.slice(home.length));
    const gone = [...chunks.keys()].filter((path) => !now.has(path)).length;
    context.check(
      "no chunk was rendered again",
      renders.length === 0 && changed.length === 0 && gone === 0,
      `${renders.length} render(s) after the update; ${chunks.size} chunk files before, ${changed.length} new or changed, ${gone} deleted`,
    );
    const shared = cloud.published.at(-1);
    const objects = cloud.mock.cloud.objects as unknown as { pathOf(key: string): string; has(key: string): boolean };
    const exportFile = exportsBefore.find((one) => one.whole);
    if (shared !== undefined && exportFile !== undefined && objects.has(shared.key)) sameVideo(context, "the shared video and the export it had", fileOf(context, exportFile), objects.pathOf(shared.key));
  },
};

// ─────────────────────────────────────────────── awake-and-busy

/** The word the one answer (busy.ts `runningNow`, through /api/health) should have for a running row's kind. */
const WORDS: Record<string, RegExp> = {
  case: /footage import/,
  script: /script's import/,
  export: /^an export$/,
  archive: /export going up to the cloud/,
  share: /\bshares?\b/,
};

/** What the harness itself knows runs (from its start to its end as the page shows it), named as the one answer should name it. */
const STARTED: Record<string, RegExp> = {
  "a Script import (from its start to whole)": /script's import/,
  "an editor import (from its start to done)": /footage import/,
  "an export (from Export to its file)": /export/,
  "a share (from Share to its link)": /\bshares?\b/,
};

/** When Edit's log says it kept the machine awake, and when it let go ("keeping … awake: why" / "nothing running: … may sleep"). */
function awakeSpans(log: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let from: number | null = null;
  for (const line of log.split("\n")) {
    const at = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) \w+ \[awake\] (.*)$/.exec(line);
    if (at === null) continue;
    const time = new Date(`${at[1]}T${at[2]}`).getTime();
    // A hold that couldn't be taken here (no inhibitor in the sandbox) still says Edit meant to hold it.
    if (/^(keeping .* awake|couldn't keep)/.test(at[3]!)) from ??= time;
    else if (/^nothing running/.test(at[3]!) && from !== null) {
      spans.push({ from, to: time });
      from = null;
    }
  }
  if (from !== null) spans.push({ from, to: Number.POSITIVE_INFINITY });
  return spans;
}

const awakeAndBusy: Case = {
  name: "awake-and-busy",
  change: "7",
  spec:
    "Time run 60 times faster, the line held to 4 Mbit/s down and 20 up so each piece of work lasts. A Script import, an editor import, an export and its copy to the cloud, " +
    "and a share with its full-quality file. The one answer to 'what runs now' (busy.ts, as /api/health says it) is read twice a second throughout, and Edit's log read for when it kept the machine awake. " +
    "Checks: while each kind of work runs (as the job table lists it, or as the harness started it), the answer is never empty and names it where it has a word for it, " +
    "and the machine is kept awake (allowing awake.ts's 15-second look); once nothing runs, the answer is empty and the machine may sleep.",
  env: { EDIT_BAD_DAY_SPEED: "60" },
  async run(context) {
    const { line, footage, edit } = context;
    line.reshape({ down: 4000 * KBIT, up: 20_000 * KBIT });
    const samples: { at: number; busy: string[]; running: string[] }[] = [];
    const doing = new Set<string>();
    /** When each piece of work the harness started began and ended (its request sent, its end seen by a look of its own). */
    const spans = new Map<string, { from: number; to: number }>();
    let going = true;
    const sampler = (async () => {
      while (going) {
        try {
          const health = await edit.api<{ busy?: string[] }>("GET", "/api/health");
          const running = rows(context).filter((row) => row.state === "running").map((row) => row.kind);
          samples.push({ at: Date.now(), busy: health.body.busy ?? [], running: [...new Set([...running, ...doing])] });
        } catch {}
        await context.sleep(500);
      }
    })();
    const during = async <T>(what: keyof typeof STARTED, work: () => Promise<T>): Promise<T> => {
      doing.add(what);
      const from = Date.now();
      try {
        return await work();
      } finally {
        doing.delete(what);
        spans.set(what, { from, to: Date.now() });
      }
    };
    const ids = [driveId("Busy1"), driveId("Busy2"), driveId("Busy3")];
    await during("a Script import (from its start to whole)", async () => {
      const scriptId = await scriptImport(context, "1BadDayBusyScriptFolder0001", ids.map((one, i) => ({ id: one, clip: footage.recordings[i]! })));
      await context.waitFor("the case whole", async () => (whole(await script(context, scriptId)) ? true : null), 300_000);
    });
    const editId = await during("an editor import (from its start to done)", () => editToShare(context, "Busy"));
    if (editId !== null) {
      await during("an export (from Export to its file)", async () => {
        await startExport(context, editId, "busy.mp4", false);
        await exported(context, editId, "busy.mp4", 600_000);
      });
      await until(context, () => !rows(context).some((row) => row.kind === "archive" && live(row)), 300_000, 500);
      await during("a share (from Share to its link)", async () => {
        await startShare(context, editId);
        await context.waitFor("the share's link", () => shareLink(context, editId), 600_000);
      });
    }
    // Everything ends, then a quiet half-minute (awake.ts looks every 15 s).
    await until(context, () => !rows(context).some(live), 300_000, 1000);
    const quietFrom = Date.now();
    await context.sleep(30_000);
    going = false;
    await sampler;
    const held = awakeSpans(edit.log());
    const awake = (at: number) => held.some((span) => span.from <= at && at <= span.to);
    // While each kind ran.
    const kinds = new Set(samples.flatMap((one) => one.running));
    const report: string[] = [];
    const missed: string[] = [];
    const asleep: string[] = [];
    for (const kind of kinds) {
      // What the harness started is judged 2 s in from each end: Edit lists it once the request is in, and the harness sees its end a look late.
      const span = spans.get(kind);
      const looks = samples.filter((one) => one.running.includes(kind) && (span === undefined || (one.at > span.from + 2000 && one.at < span.to - 2000)));
      const empty = looks.filter((one) => one.busy.length === 0).length;
      const word = WORDS[kind] ?? STARTED[kind];
      const unnamed = word === undefined ? 0 : looks.filter((one) => !one.busy.some((said) => word.test(said))).length;
      // Running for 16 s or more without a break: awake.ts has looked since it began.
      const settled = looks.filter((one) => samples.filter((other) => other.at >= one.at - 16_000 && other.at <= one.at).every((other) => other.running.includes(kind)) && one.at - samples[0]!.at >= 16_000);
      const sleeping = settled.filter((one) => !awake(one.at)).length;
      report.push(`${kind} ${looks.length} looks${empty > 0 ? `, ${empty} empty` : ""}${unnamed > 0 ? `, ${unnamed} not naming it` : ""}${sleeping > 0 ? `, ${sleeping} of ${settled.length} not kept awake` : ""}`);
      if (empty > 0 || unnamed > 0) missed.push(`${kind}: ${empty} of ${looks.length} looks empty${unnamed > 0 ? `, ${unnamed} without "${word!.source}"` : ""} (said: ${[...new Set(looks.flatMap((one) => one.busy))].join(", ") || "nothing"})`);
      if (sleeping > 0) asleep.push(`${kind}: ${sleeping} of ${settled.length} looks with the machine let sleep`);
    }
    context.log(`while running: ${report.join("; ")}; awake ${held.map((span) => `+${seconds(span.from - context.started)}..${Number.isFinite(span.to) ? `+${seconds(span.to - context.started)}` : "end"} s`).join(", ")}`);
    context.check("while each kind of work ran, the one answer named it", kinds.size > 0 && missed.length === 0, kinds.size === 0 ? "no work was seen running" : missed.length === 0 ? report.join("; ") : missed.join(" | "));
    context.check("while each kind of work ran, the machine was kept awake", kinds.size > 0 && asleep.length === 0, asleep.length === 0 ? `awake ${held.length} time(s)` : asleep.join(" | "));
    const quiet = samples.filter((one) => one.at >= quietFrom + 16_000);
    const said = quiet.filter((one) => one.busy.length > 0);
    const stillHeld = quiet.filter((one) => awake(one.at)).length;
    context.check(
      "once nothing runs, the answer is empty and the machine may sleep",
      quiet.length > 0 && said.length === 0 && stillHeld === 0,
      `${quiet.length} looks: ${said.length === 0 ? "all empty" : `${said.length} said ${[...new Set(said.flatMap((one) => one.busy))].join(", ")}`}; ${stillHeld === 0 ? "let sleep" : `${stillHeld} with the machine still held awake`}`,
    );
  },
};

export const change7Cases: Case[] = [wifiDropEditor, wifiDropScript, killThreeTimes, shareDrop, uploadFailedThenUpdate, awakeAndBusy];
