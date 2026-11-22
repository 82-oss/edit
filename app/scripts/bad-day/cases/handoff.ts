// Start the edit from a script Script mode imported on this Mac (writer_handoff.ts `importScript`, script.ts
// `scriptModeCopy`): change 8 of final.md. Nov 21: each recording's copy here was removed the moment it was up and its
// piece made, so 113 of the team's 126 scripts had none left by Start the edit, which read every recording back over
// the line (an 8 Mbit/s line: hours). The copies now stay as the local originals while there's room (writer/streamed.ts),
// and Start the edit cuts from them.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Case, Context } from "./index.ts";
import { restart } from "./work.ts";

const FOLDER = "1BadDayHandoffFolder0000001";
const IDS = ["1BadDayHandoffRecordingAA1", "1BadDayHandoffRecordingAA2", "1BadDayHandoffRecordingAA3"];

interface Script {
  id: string;
  status: "processing" | "ready" | "needs_choice" | "error";
  stage?: string;
  error: string | null;
  missing?: { title: string; error: string }[];
  parts?: { title: string }[];
}

interface Job {
  state: string;
  error?: string;
  files: { file: string; name?: string; state: string; error?: string }[];
}

async function script(context: Context, id: string): Promise<Script> {
  const answer = await context.edit.api<Script>("GET", `/api/writer/scripts/${id}`);
  if (answer.status !== 200) throw new Error(`GET script answered ${answer.status}`);
  return answer.body;
}

function describe(one: Script): string {
  const missing = (one.missing ?? []).map((item) => `${item.title} (${item.error})`).join(", ");
  return `status ${one.status}${one.stage ? `/${one.stage}` : ""}${one.error ? `, error "${one.error}"` : ""}, ${one.parts?.length ?? 0} part(s)${missing ? `, missing ${missing}` : ""}`;
}

function describeJob(one: Job | null | undefined): string {
  if (one === null || one === undefined) return "no job";
  const files = one.files.map((file) => `${file.name ?? file.file.slice(0, 12)} ${file.state}${file.error ? ` (${file.error.slice(0, 140)})` : ""}`).join("; ");
  return `job ${one.state}${one.error ? ` "${one.error}"` : ""}: ${files}`;
}

/** The three recordings in a Drive folder, imported as the page does, until the script is ready with all three. */
async function imported(context: Context): Promise<string | null> {
  const { cloud, edit, footage } = context;
  for (const [n, clip] of footage.recordings.entries()) cloud.addFile(FOLDER, IDS[n]!, clip);
  const started = await edit.api<Script>("POST", "/api/writer/scripts/drive", { url: `https://drive.google.com/drive/folders/${FOLDER}` });
  if (started.status !== 200 || typeof started.body?.id !== "string") throw new Error(`starting the import answered ${started.status}: ${started.text.slice(0, 300)}`);
  const id = started.body.id;
  context.log(`import started: script ${id}`);
  const ready = await context.waitFor(
    "the script ready with its three recordings",
    async () => {
      const one = await script(context, id);
      if (one.status === "error" || one.status === "needs_choice") return one;
      return one.status === "ready" && (one.missing ?? []).length === 0 ? one : null;
    },
    300_000,
  );
  const last = ready ?? (await script(context, id));
  context.check("the script was imported whole", ready !== null && ready.status === "ready", describe(last));
  return ready !== null && ready.status === "ready" ? id : null;
}

/** Whether the registry (the stand-in Convex) says `id`'s original is whole in the cloud. */
function up(context: Context, id: string): boolean {
  return context.cloud.mock.cloud.convex.media.get(`drive:${id}`)?.originalReady === true;
}

/** Bytes of the recordings Edit was handed from the cloud (R2's originals) and from Drive, counted at the line. */
function fetched(context: Context): number {
  return IDS.reduce((sum, id) => sum + context.line.sent(`/r2/edit/originals/drive/${id}/`) + context.line.sent(`/www.googleapis.com/drive/v3/files/${id}`), 0);
}

const recordingsBytes = (context: Context) => context.footage.recordings.reduce((sum, clip) => sum + clip.size, 0);

/** "About zero": at most 2% of the recordings (an index read, say), never less than 256 kB allowed. */
const aboutZero = (context: Context) => Math.max(256 * 1024, recordingsBytes(context) * 0.02);

/** Start the edit pressed as Home does: the project made, and how long the press took to answer. */
async function startTheEdit(context: Context, id: string): Promise<{ project: string | null; ms: number; detail: string }> {
  const at = Date.now();
  const answer = await context.edit.api<{ project?: string }>("POST", `/api/writer/handoff/${id}/import`, {});
  const ms = Date.now() - at;
  const project = answer.status === 200 && typeof answer.body?.project === "string" ? answer.body.project : null;
  context.log(`Start the edit answered ${answer.status} in ${ms} ms${project !== null ? `: project ${project}` : `: ${answer.text.slice(0, 300)}`}`);
  return { project, ms, detail: project !== null ? `project ${project} in ${(ms / 1000).toFixed(1)} s` : `answered ${answer.status}: ${answer.text.slice(0, 200)}` };
}

async function job(context: Context, project: string): Promise<Job | null> {
  const answer = await context.edit.api<{ job: Job }>("GET", `/api/projects/${project}/script/job`);
  return answer.status === 200 ? answer.body.job : null;
}

/** The edit laid out (its import's job done), or the job as it ended otherwise; null if it never ended in `ms`. */
async function laidOut(context: Context, project: string, ms: number): Promise<Job | null> {
  return context.waitFor(
    "the edit laid out",
    async () => {
      const one = await job(context, project);
      return one?.state === "done" || one?.state === "failed" || one?.state === "error" ? one : null;
    },
    ms,
  );
}

const RESUME_FOLDER = "1BadDayResumeFolder0000001";
const RESUME_ID = "1BadDayResumeRecording0001";
const KBIT = 1000 / 8;

/** Every file named `name` under `dir`, however deep. */
function filesNamed(dir: string, name: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const one of names) {
      if (one.isDirectory()) stack.push(join(at, one.name));
      else if (one.name === name) out.push(join(at, one.name));
    }
  }
  return out;
}

function md5Of(path: string): string {
  const hash = createHash("md5");
  const fd = fs.openSync(path, "r");
  const buffer = Buffer.alloc(1 << 20);
  for (;;) {
    const n = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n));
  }
  fs.closeSync(fd);
  return hash.digest("hex");
}

/**
 * `resume-download` (change 8): a 150 MB recording comes down to this Mac at 8 Mbit/s in Script mode (writer/streamed.ts
 * `driveHere`), the line cut five times and Edit killed once as it comes. Each cut and the kill should cost only what
 * was in flight, never the file again.
 */
const resumeDownload: Case = {
  name: "resume-download",
  change: "8",
  spec:
    "A 150 MB recording in a Drive folder, imported in Script mode at 8 Mbit/s; the line cut five times (3 s each, at 15, 30, 45, 90 and 105 MB) and Edit killed once (at 60 MB) as it comes down. " +
    "Checks: the case comes in whole; bytes fetched from Drive are at most the file plus 8 MB for each cut and the kill; the copy on this Mac has the file's checksum. " +
    "(Not yet: the excerpts against a clean run's, by length and by first, middle and last frame.)",
  paidAtMost: { hearings: 2 },
  async run(context) {
    const { cloud, edit, footage, line } = context;
    const clip = footage.axon;
    cloud.addFile(RESUME_FOLDER, RESUME_ID, clip);
    line.reshape({ down: 8000 * KBIT });
    const fromDrive = () => line.sent(`/www.googleapis.com/drive/v3/files/${RESUME_ID}`);
    const started = await edit.api<{ id?: string }>("POST", "/api/writer/scripts/drive", { url: `https://drive.google.com/drive/folders/${RESUME_FOLDER}` });
    if (started.status !== 200 || typeof started.body?.id !== "string") throw new Error(`starting the import answered ${started.status}: ${started.text.slice(0, 300)}`);
    const id = started.body.id;
    context.log(`import started: script ${id}`);
    // The cuts and the kill, each once the line has carried that much of the recording.
    const steps: [number, "cut" | "kill"][] = [[15e6, "cut"], [30e6, "cut"], [45e6, "cut"], [60e6, "kill"], [90e6, "cut"], [105e6, "cut"]];
    const done: string[] = [];
    for (const [bytes, what] of steps) {
      const reached = await context.waitFor(`${(bytes / 1e6).toFixed(0)} MB of the recording down`, () => fromDrive() >= bytes || null, 600_000);
      if (reached === null) {
        context.log(`never got to ${(bytes / 1e6).toFixed(0)} MB (${(fromDrive() / 1e6).toFixed(1)} MB came)`);
        break;
      }
      if (what === "kill") await restart(context, `the recording coming down, ${(fromDrive() / 1e6).toFixed(1)} MB in`);
      else {
        context.log(`the line cut for 3 s, ${(fromDrive() / 1e6).toFixed(1)} MB in`);
        line.set("down");
        await context.sleep(3_000);
        line.set("up");
      }
      done.push(what);
    }
    context.check("the line was cut five times and Edit killed once as it came down", done.length === steps.length, done.join(", ") || "none");
    const ready = await context.waitFor(
      "the case whole",
      async () => {
        const one = await script(context, id);
        if (one.status === "error" || one.status === "needs_choice") return one;
        return one.status === "ready" && (one.missing ?? []).length === 0 ? one : null;
      },
      900_000,
    );
    const last = ready ?? (await script(context, id));
    context.check("the case came in whole", ready !== null && ready.status === "ready", describe(last));
    const allowed = clip.size + steps.length * 8e6;
    context.check(
      "bytes fetched are at most the file plus a little for each cut",
      fromDrive() <= allowed,
      `${(fromDrive() / 1e6).toFixed(1)} MB came from Drive for a ${(clip.size / 1e6).toFixed(1)} MB file (at most ${(allowed / 1e6).toFixed(1)} MB)`,
    );
    const copies = filesNamed(join(context.home, "writer", "scripts", id), clip.name);
    const sums = copies.map(md5Of);
    context.check(
      "the copy on this Mac has the file's checksum",
      sums.length > 0 && sums.every((sum) => sum === clip.md5),
      copies.length === 0 ? "no copy of the recording on this Mac" : copies.map((path, n) => `${path.slice(context.home.length + 1)}: ${sums[n] === clip.md5 ? "right" : `md5 ${sums[n]}, not ${clip.md5}`}`).join("; "),
    );
  },
};

export const handoffCases: Case[] = [
  resumeDownload,
  {
    name: "handoff-no-refetch",
    change: "8",
    spec:
      "A three-recording case imported in Script mode, its originals copied to the cloud by the relay, then 'Start the edit' in the same run. " +
      "Checks: the edit is laid out; the bytes of the recordings Edit fetched (from R2 and from Drive) between the press and the layout are about zero, counted at the line.",
    paidAtMost: { hearings: 3 },
    async run(context) {
      const id = await imported(context);
      if (id === null) return;
      // Every original in the cloud (the relay's copies are quick here), and a moment for whatever follows that.
      const allUp = await context.waitFor("every original in the cloud", () => IDS.every((one) => up(context, one)) || null, 120_000);
      context.check("every original reached the cloud", allUp !== null, IDS.map((one) => `${one.slice(-3)} ${up(context, one) ? "up" : "not up"}`).join(", "));
      await context.sleep(5_000);
      const before = fetched(context);
      const pressed = await startTheEdit(context, id);
      context.check("Start the edit made the edit", pressed.project !== null, pressed.detail);
      if (pressed.project === null) return;
      const end = await laidOut(context, pressed.project, 300_000);
      context.check("the edit was laid out", end?.state === "done", describeJob(end ?? (await job(context, pressed.project))));
      const during = fetched(context) - before;
      context.check(
        "no recording fetched again for the edit",
        during <= aboutZero(context),
        `${(during / 1e6).toFixed(2)} MB of the recordings came over the line between the press and the layout (${(recordingsBytes(context) / 1e6).toFixed(1)} MB of recordings; about zero is at most ${(aboutZero(context) / 1e6).toFixed(2)} MB)`,
      );
    },
  },
  {
    name: "upload-behind",
    change: "8",
    spec:
      "No relay copy: this Mac uploads each original behind the import. The first goes up; the second's and third's uploads are refused by R2 until the edit is laid out (put off in the job table, still to go). " +
      "Checks: Start the edit answers within 10 s; the edit is laid out while those two are still not in the cloud; no recording was fetched for it (the first included, whose copy here stays once it's up), counted at the line.",
    paidAtMost: { hearings: 3 },
    async run(context) {
      const { cloud } = context;
      cloud.relayCopies = false;
      // The way up refused for the second and third recordings' originals: their uploads stay to go behind the edit.
      let holding = true;
      cloud.beforeR2Put = (key) => {
        if (!holding || !IDS.slice(1).some((one) => key.startsWith(`edit/originals/drive/${one}/`))) return null;
        return new Response("", { status: 503 });
      };
      const id = await imported(context);
      if (id === null) return;
      const firstUp = await context.waitFor("the first recording's original in the cloud", () => up(context, IDS[0]!) || null, 180_000);
      context.check("the first original went up from this Mac", firstUp !== null, firstUp === null ? "not in the cloud after 3 minutes" : "up");
      // A moment after it's up: the old code removed its copy here then.
      await context.sleep(5_000);
      const before = fetched(context);
      const pressed = await startTheEdit(context, id);
      context.check("Start the edit answered at once", pressed.project !== null && pressed.ms <= 10_000, pressed.detail);
      if (pressed.project === null) return;
      const end = await laidOut(context, pressed.project, 300_000);
      const stillGoing = IDS.slice(1).filter((one) => !up(context, one));
      context.check(
        "the edit was laid out while the originals were still going up",
        end?.state === "done" && stillGoing.length === 2,
        `${describeJob(end ?? (await job(context, pressed.project)))}; not in the cloud yet: ${stillGoing.length} of 2`,
      );
      const during = fetched(context) - before;
      context.check(
        "no recording fetched for the edit",
        during <= aboutZero(context),
        `${(during / 1e6).toFixed(2)} MB of the recordings came over the line between the press and the layout (about zero is at most ${(aboutZero(context) / 1e6).toFixed(2)} MB)`,
      );
      // Let through: the table sends them by itself (a minute after a refused try, then 5): said, not judged here.
      holding = false;
      const landed = await context.waitFor("the other two originals in the cloud", () => IDS.every((one) => up(context, one)) || null, 420_000);
      context.log(landed !== null ? "the other two originals went up behind the edit" : "the other two originals weren't up 7 minutes after they were let through");
    },
  },
];
