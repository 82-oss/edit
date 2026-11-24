// Their subtitles taken out of the picture, not blurred, in the intro and the first two cases (Sphe, Nov 19:
// MiniMax-Remover, run here on this computer's GPU, judged spotless on Cuffed & Caught's footage, beating Vmake's
// Smart). Only on a machine that has it (`available`: Linux with the model installed in REMOVER, an NVIDIA GPU); every
// other machine, and every case after the second, keeps the tracked blur (text_blur.ts), with nothing to choose.
//
// Each marked stretch of a file shown in those sections (text_removal.ts `blurPlan`'s `inpaint`) is tracked first, as
// for the blur (the same reads, kept the same way: text_blur's track is the mask, so the camera's stamp and the
// picture's own text stay as the blur leaves them), and until it's cleaned it's blurred. Then the stretch goes through
// the model (minimax_worker.py, one process kept alive while there's work, the model loaded once and kept on the GPU):
// each frame's mask is their words' boxes from the track, grown; what comes back is a stacked see-through strip of
// their band (`Media::cleans`, what clean_strips.ts lays over every clip of the file there, its tracked blur then off).
// Where the relay cleans on RunPod (its /health `remover`, apps/relay/src/remover.ts; Sphe, Nov 19: "temporarily disable
// the local GPU stuff, and then just quickly set up Runpod"), every Edit cleans there instead,
// many stretches at once, and this machine's GPU isn't used (still the intro and first two cases only: Sphe, Nov 19).
// Strips are kept by file and seconds, here and on R2 beside the rest (`edit/cleaned/<file>/<from>-<to>.minimax-…`),
// so a re-cut, another project of the same case, or a restart lays them again with nothing run twice; what was
// still being cleaned when the server stopped is planned again from the edit when it starts (removal_schedule
// `resume`) and cleaned again.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { probe } from "./media.ts";
import type { Media } from "./model.ts";
import type { Box } from "./native/index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import { freshId } from "./project.ts";
import * as removerCloud from "./remover_cloud.ts";
import * as seams from "./seams.ts";
import * as tools from "./tools.ts";
import workerSource from "./minimax_worker.py" with { type: "text" };

/** Where the model is installed (its Python, weights and code): a machine without it blurs. */
export const REMOVER = join(os.homedir(), ".local", "share", "edit-remover");
/** A new way of cleaning is a new name on the shelf. 2: cleaned over their watermark (`beneath`); 3: mid-screen subtitle band coverage. */
const VERSION = 3;
/** Previous version still accepted without re-cleaning when its strip box already covers the tracked vertical range. */
const PREV_VERSION = 2;
/** The worker is let go (its GPU memory freed) after this long with nothing to do. */
const IDLE_MS = 5 * 60_000;
/** A stretch the model failed on is tried once more, then left blurred. */
const TRIES = 2;
/** Its memory, capped so it alone can die (the model, torch and a chunk's frames: ~4 GB). */
const MEMORY_MAX = "8G";

export type Spans = [number, number][];

/** One file's stretches to clean (text_removal.ts's plan), each tracked by text_blur first. */
export interface InpaintPlan {
  media: Media;
  source: string;
  spans: Spans;
  /** Their watermark's boxes the agent marked (text_blur's `Mark`): in the masks, and in the strip's name. */
  marks?: { from: number; to: number; box: Box }[];
}

/**
 * What a stretch's strip was cleaned over and with: the watermark strips beneath (`beneathOf`'s hash) and the marked
 * boxes there, as one hash ("" with neither): a mark added later makes the strip again.
 */
export function underWith(under: string, marks: { from: number; to: number; box: Box }[], from: number, to: number): string {
  const mine = marks.filter((one) => one.from < to && one.to > from).map((one) => `${Math.round(one.from * 1000)}-${Math.round(one.to * 1000)}:${one.box.map((value) => Math.round(value * 1e4)).join(",")}`);
  if (mine.length === 0) return under;
  // "m3": whole-frame mark coverage + edge hold + tight padding and generous band context on tall logo boxes.
  return createHash("sha256").update(["m3", under, ...mine.sort()].join("|")).digest("hex").slice(0, 10);
}

/** One stretch being cleaned or cleaned, as the waiting row lists it. */
export interface InpaintPiece {
  key: string;
  media: string;
  name: string;
  from: number;
  to: number;
  /** waiting: its track (text_blur's) isn't read yet; it's blurred meanwhile. */
  state: "waiting" | "queued" | "running" | "done" | "failed";
  why?: string;
}

/** The track's boxes of their words over a stretch: text_blur hands it (its samples, per place). */
export type MasksOf = (source: string, from: number, to: number, fps: number, first: number, frames: number) => Box[][] | null;
/** Cached vertical bounds [minY, maxY] of a stretch's masks (undefined: untracked; null: no text): cheap check for legacy v2 strips without expanding per-frame masks. */
export type RangeOf = (source: string, from: number, to: number) => [number, number] | null | undefined;

// ---------------------------------------------------------------------------
// Whether this machine can

const isFile = (path: string) => {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Whether the relay cleans on RunPod (remover_cloud.ts: one flag for cleaning, watermarks and the blur's tracks). */
export const timing = removerCloud.timing;
export const cloudOn = async (): Promise<boolean> => override === null && (await removerCloud.on());
export const setCloudOnForTests = (value: boolean): void => removerCloud.setOnForTests(value);
const cloudNow = (): boolean => override === null && removerCloud.now();

let availableHere: boolean | null = null;
/** Whether stretches are cleaned with the model: on RunPod (the relay's flag), or on this machine (Linux, the model installed, an NVIDIA GPU). */
export function available(): boolean {
  if (override !== null) return true;
  if (cloudNow()) return true;
  if (availableHere !== null) return availableHere;
  availableHere =
    // Under tests only a stand-in counts (`useCleaner`): a test never starts the real model on a machine that has it.
    process.env.NODE_ENV !== "test" &&
    process.platform === "linux" &&
    isFile(join(REMOVER, "venv", "bin", "python")) &&
    isFile(join(REMOVER, "weights", "transformer", "diffusion_pytorch_model.safetensors")) &&
    isFile(join(REMOVER, "weights", "vae", "diffusion_pytorch_model.safetensors")) &&
    isFile(join(REMOVER, "repo", "transformer_minimax_remover.py")) &&
    fs.existsSync("/dev/nvidiactl");
  return availableHere;
}

// ---------------------------------------------------------------------------
// The stretch's frames and masks

/**
 * A stretch's frames at the file's rate: its first frame's number and how many (source seconds [from, to)). The first is
 * the frame on screen at `from`, not the next one: a clip whose start falls between two frames shows the one before
 * (Nov 19, the Boyfriends intro: four clips showed their subtitles for a frame before the strip began).
 */
export function framesOf(from: number, to: number, fps: number): { first: number; frames: number } {
  const first = Math.max(0, Math.floor(from * fps + 1e-6));
  return { first, frames: Math.max(0, Math.ceil(to * fps - 1e-6) - first) };
}

/** Boxes (shares) as pixels of a `width` × `height` picture. */
export function pixelsOf(boxes: Box[][], width: number, height: number): number[][][] {
  const r = (value: number) => Math.round(value * 10) / 10;
  return boxes.map((frame) => frame.map((box) => [r(box[0] * width), r(box[1] * height), r(box[2] * width), r(box[3] * height)]));
}

// ---------------------------------------------------------------------------
// The shelf: strips kept by file and seconds

const boxPart = (box: Box) => box.map((value) => String(Math.round(value * 1e4))).join("-");
/**
 * A strip's name on the shelf: its seconds, which watermark strips it was cleaned over (`under`: their hash, "" with
 * none; a watermark done again is a new strip), and its box.
 */
export const stripName = (from: number, to: number, box: Box | null, under = "") =>
  `${Math.round(from * 1000)}-${Math.round(to * 1000)}.minimax-v${VERSION}${under === "" ? "" : `-u${under}`}-${box === null ? "none.json" : `${boxPart(box)}.mp4`}`;

/** A kept strip's name read back: its seconds, what it was cleaned over, its box (null: nothing of theirs was there), and its version. */
export function parseStrip(name: string, version: number = VERSION): { from: number; to: number; box: Box | null; under: string } | null {
  const match = new RegExp(`^(\\d+)-(\\d+)\\.minimax-v${version}(?:-u([0-9a-f]+))?-(?:none\\.json|(\\d+)-(\\d+)-(\\d+)-(\\d+)\\.mp4)$`, "u").exec(name);
  if (match === null) return null;
  const box = match[4] === undefined ? null : ([match[4], match[5], match[6], match[7]].map((value) => Number(value) / 1e4) as Box);
  return { from: Number(match[1]) / 1000, to: Number(match[2]) / 1000, box, under: match[3] ?? "" };
}

/** A watermark strip under a stretch (watermark_removal.ts's), laid on the picture before it's cleaned. */
export interface Beneath {
  file: string;
  from: number;
  box: Box;
  /** Its key on R2, where RunPod's GPU reads it (none: not backed up yet). */
  key?: string;
}

/** The file's watermark strips over source seconds [from, to) in `project`, and their hash for the shelf ("" with none). */
export function beneathOf(project: { media: Media[] }, media: string, from: number, to: number): { strips: Beneath[]; under: string } {
  const strips = project.media
    .filter((one) => one.cleans != null && one.cleans.media === media && one.cleans.what === "watermark" && one.cleans.from < to && one.cleans.to > from)
    .sort((a, b) => a.cleans!.from - b.cleans!.from)
    .map((one): Beneath => ({ file: one.path, from: one.cleans!.from, box: one.cleans!.box, ...(cloudKeyOf(one) === undefined ? {} : { key: cloudKeyOf(one) }) }));
  const under = strips.length === 0 ? "" : createHash("sha256").update(strips.map((one) => one.file.slice(one.file.lastIndexOf("/") + 1)).join("|")).digest("hex").slice(0, 10);
  return { strips, under };
}

/** A file's key on R2 (its original), if it has one Edit may use. */
const cloudKeyOf = (media: Pick<Media, "cloud">): string | undefined => {
  const key = media.cloud?.original;
  return key !== undefined && key !== "" && cloud.validKey(key) ? key : undefined;
};

/** Whether a watermark piece of the file over [from, to) is still being made (watermark_removal.ts; removal_schedule.ts sets it): a stretch waits for it. */
export const watermarks = { pending: (_id: string, _media: string, _from: number, _to: number): boolean => false };

const PREFIX = "edit/cleaned";

/** text_removal's `folderOf` (that file imports this one). */
const folderOf = (source: string) => createHash("sha256").update(source).digest("hex").slice(0, 32);

/** Whether a legacy v2 strip's vertical box covers a tracked vertical range [minY, maxY]. */
export function coversRange(stripBox: Box | null, yRange: [number, number] | null | undefined): boolean {
  if (yRange === undefined || yRange === null) return true;
  if (stripBox === null) return false;
  return stripBox[1] <= yRange[0] + 0.005 && stripBox[3] >= yRange[1] - 0.005;
}

type LazyRange = [number, number] | null | undefined | (() => [number, number] | null | undefined);
const resolveRange = (yRange: LazyRange): [number, number] | null | undefined => (typeof yRange === "function" ? yRange() : yRange);

/** A stretch's strip on the shelf, brought here (null: not cleaned yet). Prefers current VERSION; accepts PREV_VERSION when its box covers `yRange`, preserving its actual version so `place` never promotes an unchecked v2 strip to v3. */
async function shelved(app: App, source: string, from: number, to: number, under: string, yRange: LazyRange = undefined): Promise<{ file: string | null; box: Box | null; version: number } | null> {
  const folder = folderOf(source);
  const dir = join(app.store.cacheDir(), "cleaned", folder);
  const matchOf = (name: string, version: number) => {
    const one = parseStrip(name, version);
    if (one === null || one.under !== under || Math.abs(one.from - from) >= 0.001 || Math.abs(one.to - to) >= 0.001) return null;
    if (version !== VERSION && !coversRange(one.box, resolveRange(yRange))) return null;
    return { ...one, version };
  };
  const pick = (list: string[]) => {
    for (const one of list) {
      const m = matchOf(one, VERSION);
      if (m !== null) return { name: one, ...m };
    }
    for (const one of list) {
      const m = matchOf(one, PREV_VERSION);
      if (m !== null) return { name: one, ...m };
    }
    return null;
  };
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => !name.endsWith(".partial.mp4"));
  } catch {
    /* Nothing here yet. */
  }
  let hit = pick(names);
  if (hit === null && cloud.enabled()) {
    const listed = await cloud.list(`${PREFIX}/${folder}/`).catch(() => []);
    hit = pick(listed.map((object) => object.key.slice(object.key.lastIndexOf("/") + 1)));
    if (hit !== null && hit.name.endsWith(".mp4")) {
      fs.mkdirSync(dir, { recursive: true });
      await cloud.download(`${PREFIX}/${folder}/${hit.name}`, join(dir, hit.name));
    }
  }
  if (hit === null) return null;
  return { file: hit.box === null ? null : join(dir, hit.name), box: hit.box, version: hit.version };
}

async function keep(app: App, source: string, from: number, to: number, file: string | null, box: Box | null, under: string): Promise<string | null> {
  const folder = folderOf(source);
  const dir = join(app.store.cacheDir(), "cleaned", folder);
  fs.mkdirSync(dir, { recursive: true });
  const name = stripName(from, to, box, under);
  const local = join(dir, name);
  if (file === null) fs.writeFileSync(local, "{}");
  else fs.renameSync(file, local);
  if (cloud.enabled()) await cloud.uploadFile(local, `${PREFIX}/${folder}/${name}`).catch((error: unknown) => diag.warn("removal", `keeping ${name} in the cloud: ${diag.messageOf(error)}`));
  return box === null ? null : local;
}

// ---------------------------------------------------------------------------
// The worker

interface Request {
  /** The footage's key on R2 (RunPod reads it there), when it has one. */
  inputKey?: string;
  /** The piece it's for (a Stop cancels its RunPod job). */
  piece?: string;
  input: string;
  input_args: string[];
  from: number;
  fps: number;
  width: number;
  height: number;
  matrix: string;
  masks: number[][][];
  out: string;
  beneath: Beneath[];
}

interface Answer {
  ok: boolean;
  box?: Box | null;
  inferred?: number;
  seconds?: number;
  error?: string;
}

/** What runs a stretch through the model: the worker here (tests put a stand-in in its place). */
export interface Cleaner {
  clean(request: Request): Promise<Answer>;
}

let override: Cleaner | null = null;
/** For tests: a stand-in for the model (and this machine counts as having it). */
export function useCleaner(cleaner: Cleaner | null): void {
  override = cleaner;
}

class Worker implements Cleaner {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<string, { resolve: (answer: Answer) => void }>();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private next = 0;

  constructor(private readonly home: string) {}

  private start(): Promise<void> {
    if (this.ready !== null) return this.ready;
    const script = join(this.home, "minimax_worker.py");
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(script, workerSource);
    const python = join(REMOVER, "venv", "bin", "python");
    const args = [python, "-I", script, "--models", join(REMOVER, "weights"), "--repo", join(REMOVER, "repo")];
    // Its own memory cap where systemd can give one, so a runaway takes only it down, never Edit or the desktop.
    const capped = Bun.which("systemd-run") !== null ? ["systemd-run", "--user", "--scope", "--quiet", "-p", `MemoryMax=${MEMORY_MAX}`, "-p", "MemorySwapMax=0", ...args] : args;
    const child = Bun.spawn(capped, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      let up = false;
      void (async () => {
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (line === "") continue;
            let message: Record<string, unknown>;
            try {
              message = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (message.ready === true) {
              up = true;
              resolve();
              continue;
            }
            if (typeof message.id !== "string" || "progress" in message) continue;
            this.waiting.get(message.id)?.resolve(message as unknown as Answer);
            this.waiting.delete(message.id);
          }
        }
        // Gone: everything waiting on it fails, and the next stretch starts a new one.
        if (!up) reject(new Error("the model's worker stopped before it was ready"));
        for (const one of this.waiting.values()) one.resolve({ ok: false, error: "the model's worker stopped" });
        this.waiting.clear();
        this.child = null;
        this.ready = null;
      })();
      void (async () => {
        const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (line.startsWith("minimax:")) diag.info("removal", line);
          }
        }
      })();
    });
    return this.ready;
  }

  async clean(request: Request): Promise<Answer> {
    if (this.idle !== null) clearTimeout(this.idle);
    await this.start();
    const id = `r${++this.next}`;
    const answer = new Promise<Answer>((resolve) => this.waiting.set(id, { resolve }));
    const stdin = this.child!.stdin as import("bun").FileSink;
    void stdin.write(`${JSON.stringify({ id, ffmpeg: tools.ffmpeg(), ...request })}\n`);
    void stdin.flush();
    const done = await answer;
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref?.();
    return done;
  }

  stop(): void {
    const child = this.child;
    if (child === null) return;
    try {
      void (child.stdin as import("bun").FileSink).end();
    } catch {
      child.kill();
    }
  }
}

let worker: Worker | null = null;
const cleaner = (app: App): Cleaner => override ?? (cloudNow() ? remoteCleaner : (worker ??= new Worker(join(app.store.cacheDir(), "cleaned", "minimax"))));

/** RunPod's GPUs, through the relay (apps/relay/src/remover.ts): the stretch's R2 keys go, its strip comes back by R2. */
class RunPod implements Cleaner {
  /** Each running piece's RunPod job (a Stop cancels it: the GPU is paid by the second). */
  readonly jobs = new Map<string, string>();

  async clean(request: Request): Promise<Answer> {
    if (request.inputKey === undefined) return { ok: false, error: "the footage isn't in the cloud yet" };
    const beneath = request.beneath.map((one) => (one.key === undefined ? null : { key: one.key, from: one.from, box: one.box }));
    if (beneath.some((one) => one === null)) return { ok: false, error: "a watermark strip under it isn't in the cloud yet" };
    const { from, fps, width, height, matrix, masks } = request;
    const started = Date.now();
    const job = (await removerCloud.call<{ id: string; out: string }>("POST", "/v1/remover/jobs", { kind: "clean", worker: workerSource, backlog: Math.round(waitingSeconds()), request: { input: request.inputKey, beneath, from, fps, width, height, matrix, masks } })).value;
    if (request.piece !== undefined) this.jobs.set(request.piece, job.id);
    let misses = 0;
    try {
      for (;;) {
        await Bun.sleep(timing.pollMs);
        if (request.piece !== undefined && !this.jobs.has(request.piece)) return { ok: false, error: "stopped" };
        if (Date.now() - started > timing.deadlineMs) {
          await this.cancel(job.id);
          return { ok: false, error: "RunPod didn't finish it in 3 hours" };
        }
        let answer: Answer & { pending?: boolean };
        try {
          const asked = await removerCloud.call<Answer & { pending?: boolean }>("GET", `/v1/remover/jobs/${job.id}`);
          answer = asked.value;
          misses = 0;
          if (asked.status === 202) continue;
        } catch (error) {
          // The model's own failure (502 with its words) ends it; the relay out of reach a moment is waited out.
          if (error instanceof removerCloud.RelaySaid || ++misses >= 6) throw error;
          continue;
        }
        if (answer.box != null) await cloud.download(job.out, request.out);
        await cloud.remove([job.out]).catch(() => {});
        return { ok: true, box: answer.box ?? null, inferred: answer.inferred, seconds: answer.seconds };
      }
    } finally {
      if (request.piece !== undefined) this.jobs.delete(request.piece);
    }
  }

  /** The piece's job stopped on RunPod (a person's Stop). */
  stop(piece: string): void {
    const job = this.jobs.get(piece);
    if (job === undefined) return;
    this.jobs.delete(piece);
    void this.cancel(job);
  }

  private async cancel(job: string): Promise<void> {
    await removerCloud.call("DELETE", `/v1/remover/jobs/${job}`).catch(() => {});
  }
}

const remoteCleaner = new RunPod();
/** For tests: the RunPod cleaner itself. */
export const runPodForTests: Cleaner = remoteCleaner;

// ---------------------------------------------------------------------------
// Each project's stretches, one at a time

const pieces = new Map<string, Map<string, InpaintPiece>>();
const tries = new Map<string, number>();
/**
 * The stretches whose clean was turned down and tried again: they stay blurred, across a restart too (`tries` is
 * forgotten at one, and each would have been paid for again; Nov 23, a retry of 15 pieces had fixed none of them).
 */
const gaveUp = new Map<string, Set<string>>();
function givenUp(app: App): Set<string> {
  const file = join(app.store.cacheDir(), "cleaned", "given-up.json");
  let jobs = gaveUp.get(file);
  if (jobs === undefined) {
    try {
      jobs = new Set(JSON.parse(fs.readFileSync(file, "utf8")) as string[]);
    } catch {
      jobs = new Set();
    }
    gaveUp.set(file, jobs);
  }
  return jobs;
}
function giveUp(app: App, job: string): void {
  const jobs = givenUp(app);
  jobs.add(job);
  const file = join(app.store.cacheDir(), "cleaned", "given-up.json");
  fs.mkdirSync(join(app.store.cacheDir(), "cleaned"), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify([...jobs]));
  fs.renameSync(`${file}.tmp`, file);
}
const queue: { key: string; seconds: number; run: () => Promise<void> }[] = [];
/** Footage seconds still waiting here to be sent: the relay rents more GPUs when there's a lot (apps/relay/src/remover.ts). */
const waitingSeconds = (): number => queue.reduce((sum, one) => sum + one.seconds, 0);
let busy: Promise<void> | null = null;
/** Stretches cleaned at once: RunPod's workers (the account's 10), or this machine's one GPU. */
const AT_ONCE_CLOUD = 10;

const keyOf = (media: string, from: number, to: number) => `clean:${media}@${Math.round(from * 1000)}-${Math.round(to * 1000)}`;
const jobKey = (source: string, from: number, to: number) => `${source}|${Math.round(from * 1000)}|${Math.round(to * 1000)}`;

/** The project's stretches being cleaned or cleaned. */
export function piecesOf(id: string): InpaintPiece[] {
  return [...(pieces.get(id)?.values() ?? [])].sort((a, b) => a.media.localeCompare(b.media) || a.from - b.from);
}

/** How many are still out (an export waits for them); one waiting on its track counts as the track does (text_blur's). */
export const outOf = (id: string): number => piecesOf(id).filter((one) => one.state === "queued" || one.state === "running").length;

/** Whether `media` has a strip of theirs out over [from, to) of its seconds (its tracked blur is off there). */
export function stripCovers(project: { media: Media[] }, media: string, from: number, to: number): boolean {
  return project.media.some((one) => one.cleans != null && one.cleans.media === media && (one.cleans.what ?? "text") === "text" && one.cleans.from <= from + 0.05 && one.cleans.to >= to - 0.05);
}

/**
 * What a strip of ours is called: its seconds and, last, how it was made (`tagOf`). Its name, not its path, says so: a
 * strip backed up to the cloud is read from a URL made from its name (Nov 19: the shelf's name was gone after that,
 * and a strip from before the watermark fix was taken as current).
 */
const OURS = / · their subtitles out \d+–\d+ s(?: · (v\d+(?:\.[0-9a-f]+)?))?$/u;
export const tagOf = (under: string, version: number = VERSION) => `v${version}${under === "" ? "" : `.${under}`}`;
export const nameOf = (footage: string, from: number, to: number, under: string, version: number = VERSION) =>
  `${footage} · their subtitles out ${Math.round(from)}–${Math.round(to)} s · ${tagOf(under, version)}`;

/**
 * A strip of ours for [from, to) made as it'd be made now (current VERSION with this `under`, or PREV_VERSION whose
 * box already covers `yRange`), or another's (a Vmake one from before Nov 19, kept as it was). A newly produced
 * current-VERSION strip always counts as current even if its box is narrower than `yRange`, so it can never re-enqueue itself.
 */
export function current(project: { media: Media[] }, media: string, from: number, to: number, under: string, yRange: LazyRange = undefined): boolean {
  const curTag = tagOf(under, VERSION);
  const prevTag = tagOf(under, PREV_VERSION);
  return project.media.some((one) => {
    if (one.cleans == null || one.cleans.media !== media || (one.cleans.what ?? "text") !== "text" || Math.abs(one.cleans.from - from) > 0.01 || Math.abs(one.cleans.to - to) > 0.05) return false;
    const ours = OURS.exec(one.name);
    if (ours === null || ours[1] === curTag) return true;
    return ours[1] === prevTag && coversRange(one.cleans.box, resolveRange(yRange));
  });
}

/** Puts a stretch's strip in the project (clean_strips.ts lays it over the clips there). */
async function place(app: App, id: string, footage: Media, from: number, to: number, box: Box, file: string, under: string, version: number = VERSION, yRange: LazyRange = undefined): Promise<void> {
  const probed = await probe(file);
  await playing.whenIdle();
  await app.store.update(id, "text removal", (project) => {
    if (!project.media.some((one) => one.id === footage.id)) return;
    // A current-VERSION strip always replaces an older PREV_VERSION strip; only skip if current-VERSION (or legacy Vmake) is already placed.
    const already =
      version === VERSION
        ? project.media.some((one) => {
            if (one.cleans == null || one.cleans.media !== footage.id || (one.cleans.what ?? "text") !== "text" || Math.abs(one.cleans.from - from) > 0.01 || Math.abs(one.cleans.to - to) > 0.05) return false;
            const ours = OURS.exec(one.name);
            return ours === null || ours[1] === tagOf(under, VERSION);
          })
        : current(project, footage.id, from, to, under, yRange);
    if (already) return;
    // One of ours for these seconds made before (another version, over a watermark done again, a frame later, a
    // marked watermark since) gives way to it.
    project.media = project.media.filter((one) => !(one.cleans?.media === footage.id && (one.cleans.what ?? "text") === "text" && one.cleans.from >= from - 0.05 && one.cleans.to <= to + 0.05 && OURS.test(one.name)));
    project.media.push({
      id: freshId(project, "m"),
      name: nameOf(footage.name, from, to, under, version),
      path: file,
      kind: "video",
      duration: probed.duration,
      width: probed.width,
      height: Math.round(probed.height / 2),
      fps: probed.fps,
      has_audio: false,
      stacked_alpha: true,
      cleans: { media: footage.id, from, to, box: box.map((value) => Math.round(value * 1e4) / 1e4) as Box, what: "text" },
    } as Media);
  });
  app.media.ensure(file, probed, true);
  try {
    if (cloud.enabled()) seams.cloudMedia.backfillSoon(app, id);
  } catch (error) {
    diag.warn("cloud", `backfill ${id}: ${diag.messageOf(error)}`);
  }
}

/** The colour matrix an untagged file's YUV is in: BT.709 from 720 lines up. */
const matrixOf = (height: number) => (height >= 720 ? "bt709" : "bt601");

/**
 * Brings project `id`'s cleaned stretches up to `given`: those on the shelf are laid at once, those tracked are
 * cleaned in the background (one at a time: the GPU holds one model), those not tracked yet wait for their track
 * (text_blur calls back, `tracked`), and what's no longer wanted is forgotten (its strip, if laid, stays: a strip is
 * only ever what was there).
 */
export function ensure(app: App, id: string, given: InpaintPlan[], masksOf: MasksOf, rangeOf: RangeOf = () => undefined): Promise<void> {
  // One at a time a project: two at once (an edit resting as a track finished) each queued the same stretch, and it
  // was cleaned twice (Nov 19, four of the Boyfriends intro's 13).
  const run = (ensuring.get(id) ?? Promise.resolve()).then(() => ensureNow(app, id, given, masksOf, rangeOf));
  const settledRun = run.catch(() => {});
  ensuring.set(id, settledRun);
  void settledRun.finally(() => {
    if (ensuring.get(id) === settledRun) ensuring.delete(id);
  });
  return run;
}

const ensuring = new Map<string, Promise<void>>();

async function ensureNow(app: App, id: string, given: InpaintPlan[], masksOf: MasksOf, rangeOf: RangeOf): Promise<void> {
  if (!available()) return;
  const live = app.store.get(id);
  if (live === null) return;
  const was = pieces.get(id);
  const mine = new Map<string, InpaintPiece>();
  pieces.set(id, mine);
  for (const plan of given) {
    const fps = plan.media.fps || 30;
    for (const [from0, to0] of plan.spans) {
      const { first, frames } = framesOf(from0, to0, fps);
      if (frames < 2) continue;
      const [from, to] = [first / fps, (first + frames) / fps];
      const key = keyOf(plan.media.id, from, to);
      const piece: InpaintPiece = was?.get(key) ?? { key, media: plan.media.id, name: plan.media.name, from, to, state: "waiting" };
      mine.set(key, piece);
      const beneath = beneathOf(live.project, plan.media.id, from, to);
      const strips = beneath.strips;
      const under = underWith(beneath.under, plan.marks ?? [], from, to);
      const getRange = () => rangeOf(plan.source, from0, to0);
      // Fast O(1) path: current-version strips never inspect tracks; legacy v2 strips only check the cached y-range (never expanding per-frame masks).
      if (current(live.project, plan.media.id, from, to, under, getRange)) {
        piece.state = "done";
        continue;
      }
      if (piece.state === "queued" || piece.state === "running") continue;
      // Read, and nothing of theirs for the model in it: no card is rented for it, and it keeps its blur.
      if (getRange() === null) {
        piece.state = "done";
        continue;
      }
      if (givenUp(app).has(jobKey(plan.source, from, to))) {
        piece.state = "failed";
        piece.why ??= "turned down twice: it stays blurred";
        continue;
      }
      if (piece.state === "failed" && (tries.get(jobKey(plan.source, from, to)) ?? 0) >= TRIES) continue;
      // Their watermark there still being taken out: cleaned once it's out (a strip laid saves the project, which asks again).
      if (watermarks.pending(id, plan.media.id, from, to)) {
        piece.state = "waiting";
        continue;
      }
      const kept = await shelved(app, plan.source, from, to, under, getRange).catch(() => null);
      if (kept !== null) {
        piece.state = "done";
        if (kept.file !== null && kept.box !== null) await place(app, id, plan.media, from, to, kept.box, kept.file, under, kept.version, getRange);
        continue;
      }
      // Only expand per-frame masks when we actually need to queue work.
      const boxes = masksOf(plan.source, from0, to0, fps, first, frames);
      if (boxes === null) {
        piece.state = "waiting";
        continue;
      }
      piece.state = "queued";
      queue.push({ key, seconds: to - from, run: () => work(app, id, plan, piece, from, to, first, boxes, strips, under) });
    }
  }
  drain();
}

async function work(app: App, id: string, plan: InpaintPlan, piece: InpaintPiece, from: number, to: number, first: number, boxes: Box[][], beneath: Beneath[], under: string): Promise<void> {
  piece.state = "running";
  const job = jobKey(plan.source, from, to);
  tries.set(job, (tries.get(job) ?? 0) + 1);
  const dir = join(app.store.cacheDir(), "cleaned", "work");
  fs.mkdirSync(dir, { recursive: true });
  // Its own file each run: two stretches of a video from the same second shared one, and each took the other's away
  // (Nov 23, 3 of the Boyfriends intro's 41 stayed blurred).
  const out = join(dir, `${id}-${plan.media.id}-${Math.round(from * 1000)}-${randomUUID()}.minimax.mp4`);
  const label = `${plan.media.name} ${Math.round(from)}–${Math.round(to)} s`;
  try {
    const fps = plan.media.fps || 30;
    const [width, height] = [plan.media.width || 1920, plan.media.height || 1080];
    const input = await cloudMedia.originalInput(app.store.cacheDir(), plan.media);
    const started = Date.now();
    const inputKey = cloudKeyOf(plan.media);
    const answer = await cleaner(app).clean({ ...(inputKey === undefined ? {} : { inputKey }), piece: `${id} ${piece.key}`, input, input_args: tools.urlArgs(input), from: first / fps, fps, width, height, matrix: matrixOf(height), masks: pixelsOf(boxes, width, height), out, beneath });
    if (!answer.ok) throw new Error(answer.error ?? "the model failed");
    const box = answer.box ?? null;
    const file = await keep(app, plan.source, from, to, box === null ? null : out, box, under);
    if (file !== null && box !== null) await place(app, id, plan.media, from, to, box, file, under);
    piece.state = "done";
    const seconds = (Date.now() - started) / 1000;
    diag.info("removal", `${id}: ${label} cleaned by the model in ${Math.round(seconds)} s (${answer.inferred ?? 0} of ${boxes.length} frames through it, ${(seconds / Math.max(0.1, to - from)).toFixed(1)} s a second)`);
  } catch (error) {
    piece.state = "failed";
    piece.why = diag.messageOf(error);
    diag.warn("removal", `${id}: ${label} couldn't be cleaned by the model (it stays blurred): ${piece.why}`);
  } finally {
    fs.rmSync(out, { force: true });
    fs.rmSync(`${out}.partial.mp4`, { force: true });
  }
}

/** The lanes at work now: each takes stretches off the queue one after another until it's empty. */
const lanes = new Set<Promise<void>>();

/**
 * Starts lanes for what waits, up to as many as run at once. Asked again whenever stretches are queued: the lanes
 * were all started together and never again while any was still at work, so stretches queued after the first few
 * had begun went through the one or two lanes still going (Nov 23: 59 stretches sent back while 3 were running were
 * cleaned one at a time, 58 queued and 1 running, on a relay with cards to spare).
 */
function drain(): void {
  const most = cloudNow() ? AT_ONCE_CLOUD : 1;
  while (lanes.size < most && queue.length > 0) {
    // Its first stretch is taken off the queue before this line returns, so the count above is right.
    const lane = (async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await next.run();
    })();
    lanes.add(lane);
    void lane
      .catch(() => {})
      .finally(() => {
        lanes.delete(lane);
        if (queue.length > 0) drain();
      });
  }
  if (lanes.size === 0 || busy !== null) return;
  busy = (async () => {
    while (lanes.size > 0) await Promise.allSettled([...lanes]);
  })().finally(() => {
    busy = null;
    if (queue.length > 0) drain();
  });
}

/** Resolves once nothing is being cleaned (tests). */
export async function settled(): Promise<void> {
  while (busy !== null) await busy;
}

/**
 * A cleaned stretch that isn't clean (the agent's look, check_removal): its strip out of the project and off the
 * shelf, so it's blurred; cleaned once more the next time only if it hasn't been twice already.
 */
export async function reject(app: App, id: string, key: string, why: string): Promise<string> {
  const piece = pieces.get(id)?.get(key);
  if (piece === undefined) throw new Error(`no piece ${key}`);
  const live = app.store.get(id);
  const footage = live?.project.media.find((one) => one.id === piece.media);
  if (footage === undefined) throw new Error(`no footage for ${key}`);
  const source = await (await import("./text_removal.ts")).sourceOf(footage);
  const strip = live!.project.media.find((one) => one.cleans?.media === piece.media && (one.cleans.what ?? "text") === "text" && Math.abs(one.cleans.from - piece.from) < 0.01);
  const folder = folderOf(source);
  const dir = join(app.store.cacheDir(), "cleaned", folder);
  const names = new Set<string>(
    (() => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    })(),
  );
  if (cloud.enabled()) {
    for (const object of await cloud.list(`${PREFIX}/${folder}/`).catch(() => [])) {
      names.add(object.key.slice(object.key.lastIndexOf("/") + 1));
    }
  }
  const cloudKeys: string[] = [];
  for (const name of names) {
    const one = parseStrip(name, VERSION) ?? parseStrip(name, PREV_VERSION);
    if (one === null || Math.abs(one.from - piece.from) > 0.001 || Math.abs(one.to - piece.to) > 0.001) continue;
    fs.rmSync(join(dir, name), { force: true });
    if (cloud.enabled()) cloudKeys.push(`${PREFIX}/${folder}/${name}`);
  }
  if (cloudKeys.length > 0) await cloud.remove(cloudKeys).catch(() => {});
  await app.store.update(id, "text removal", (project) => {
    project.media = project.media.filter((one) => one.id !== strip?.id);
  });
  piece.state = "failed";
  piece.why = why;
  const again = (tries.get(jobKey(source, piece.from, piece.to)) ?? 0) < TRIES;
  if (again) piece.state = "waiting";
  else giveUp(app, jobKey(source, piece.from, piece.to));
  return again ? "taken out; it's cleaned once more (blurred meanwhile)" : "taken out; it stays blurred";
}

/** The person's Stop: nothing more is cleaned (what's done is kept), and its stretches on RunPod are let go. */
export function stop(id: string): void {
  for (let at = queue.length - 1; at >= 0; at--) if (piecesOf(id).some((one) => one.key === queue[at]!.key)) queue.splice(at, 1);
  for (const one of piecesOf(id)) remoteCleaner.stop(`${id} ${one.key}`);
  pieces.delete(id);
}

/** For tests: nothing remembered. */
export function reset(): void {
  pieces.clear();
  tries.clear();
  gaveUp.clear();
  queue.length = 0;
  availableHere = null;
}
