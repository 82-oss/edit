// Removal's heavy work done on machines rented from RunPod through the relay (apps/relay/src/remover.ts; Sphe, Nov
// 20: "build out everything", the intro and first cases cleaned on a rented GPU, their watermarks and the blur's
// tracks on rented CPU machines, many at once), never this computer's own GPU or cores. One way in for all three:
// a job sent with the footage's R2 key, waited on, and what it made fetched from R2 (text_inpaint.ts cleans by it,
// watermark_removal.ts takes marks out by it, text_blur.ts reads their words by it).

import { createHash } from "node:crypto";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import type { Media } from "./model.ts";
import type { Box, WatermarkPiece, WatermarkRemoved } from "./native/index.ts";
import * as relay from "./relay.ts";
import { CHUNK, END_GRACE_S, type Sample, type TrackPlan } from "./text_track.ts";

/** The relay's `remover` flag, asked at most once a minute; the last answer meanwhile. */
const remote = { on: false, at: 0, relay: "", asking: null as Promise<boolean> | null, forced: null as boolean | null };
export const timing = { healthMs: 60_000, pollMs: 5_000, deadlineMs: 3 * 3600_000 };

/** Whether the relay cleans on RunPod now (asked again once its answer is a minute old). */
export async function on(): Promise<boolean> {
  if (remote.forced !== null) return remote.forced;
  if (!cloud.enabled()) return false;
  const asked = relay.url();
  if (remote.relay === asked && Date.now() - remote.at < timing.healthMs) return remote.on;
  remote.asking ??= (async () => {
    let found = false;
    try {
      const answer = await fetch(`${asked}/health`, { signal: AbortSignal.timeout(20_000) });
      found = answer.ok && ((await answer.json()) as { remover?: unknown }).remover === true;
    } catch {
      // Unreachable: as it was.
      found = remote.relay === asked && remote.on;
    }
    Object.assign(remote, { on: found, at: Date.now(), relay: asked });
    return found;
  })().finally(() => {
    remote.asking = null;
  });
  return remote.asking;
}

/** The relay's last answer, without asking (the queues' choices are synchronous). */
export function now(): boolean {
  if (remote.forced !== null) return remote.forced;
  if (cloud.enabled() && Date.now() - remote.at > timing.healthMs) void on();
  return cloud.enabled() && remote.on;
}

/** For tests: the flag as given (null: asked of the relay again). */
export function setOnForTests(value: boolean | null): void {
  remote.forced = value;
}

/**
 * A file's key on R2 (its original), if it has one Edit may use: what the rented machines read. None while its original
 * is still going up from here (a local-first import names the key before a byte is up: cloud.ts `notUp`), so a finder
 * read, a track or a clean waits for it, or is done here, instead of asking RunPod for a file R2 hasn't got.
 */
export function keyOf(media: Pick<Media, "cloud">): string | undefined {
  const key = media.cloud?.original;
  return key !== undefined && key !== "" && cloud.validKey(key) && !cloud.notUp(key) ? key : undefined;
}

/** The relay refusing a job (its own words): the job failed, unlike the relay out of reach a moment. */
export class RelaySaid extends Error {}

/**
 * A remover call to the relay. Not relay.json: that takes only a 200, and the relay answers a job started, or still
 * going, with a 202 (Nov 20: all 105 of Boyfriends' stretches were taken as failures the moment they started).
 */
export async function call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; value: T }> {
  const headers = await relay.signedHeaders();
  if (body !== undefined) headers["content-type"] = "application/json";
  const answer = await fetch(`${relay.url()}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  const text = await answer.text();
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    // Below: said by its status.
  }
  if (answer.status !== 200 && answer.status !== 202) {
    const said = (value as { error?: unknown } | null)?.error;
    throw new RelaySaid(typeof said === "string" ? said : `the relay answered ${answer.status}`);
  }
  return { status: answer.status, value: value as T };
}

/** A job started on the relay (its id and where its result lands on R2). */
export interface Started {
  id: string;
  out: string;
  /** This caller's hold on it (the same job sent twice is one job, held twice); a relay from before holds sends none. */
  sub?: string;
}

/** Starts a job of `kind` (the relay's request for it), `worker` for GPU clean/find jobs. */
export async function start(kind: "clean" | "learn" | "watermark" | "track" | "find", request: Record<string, unknown>, worker?: string): Promise<Started> {
  return (await call<Started>("POST", "/v1/remover/jobs", { kind, request, ...(worker === undefined ? {} : { worker }) })).value;
}

/** Waits for a job to finish: its output (the relay out of reach a moment is waited out; its refusal is the job's failure). */
export async function wait<T>(job: Started, stopped: () => boolean = () => false): Promise<T> {
  const started = Date.now();
  let misses = 0;
  for (;;) {
    await Bun.sleep(timing.pollMs);
    if (stopped()) {
      await cancel(job.id, job.sub);
      throw new Error("stopped");
    }
    if (Date.now() - started > timing.deadlineMs) {
      await cancel(job.id, job.sub);
      throw new Error("the rented machine didn't finish it in 3 hours");
    }
    try {
      const asked = await call<T>("GET", `/v1/remover/jobs/${job.id}`);
      misses = 0;
      if (asked.status === 202) continue;
      return asked.value;
    } catch (error) {
      if (error instanceof RelaySaid || ++misses >= 6) throw error;
    }
  }
}

/** Lets go of this caller's hold on job `id` (`sub`: sent twice, a Stop lets go of it once, and another caller's hold stays). */
export async function cancel(id: string, sub?: string): Promise<void> {
  await call("DELETE", `/v1/remover/jobs/${id}${sub === undefined ? "" : `?sub=${encodeURIComponent(sub)}`}`).catch(() => {});
}

/** A small result left on R2 by a rented machine (JSON or text), read without deleting. */
async function read(key: string): Promise<string> {
  const answer = await fetch(await cloud.presign(key, "GET"), { signal: AbortSignal.timeout(120_000) });
  if (!answer.ok) throw new Error(`the result wasn't on R2 (${answer.status})`);
  return answer.text();
}

/** A small result left on R2 by a rented machine (JSON or text), read and then deleted. */
async function take(key: string): Promise<string> {
  const text = await read(key);
  await cloud.remove([key]).catch(() => {});
  return text;
}

// ---------------------------------------------------------------------------
// Watermarks

/** Models put on R2 for the rented machines, by their hash (a model is the same text for every cell of a file). */
const modelsUp = new Map<string, Promise<string>>();

async function modelKey(model: string): Promise<string> {
  const hash = createHash("sha256").update(model).digest("hex").slice(0, 32);
  let up = modelsUp.get(hash);
  if (up === undefined) {
    up = (async () => {
      const key = `edit/cleaned/models/${hash}.json`;
      if ((await cloud.head(key).catch(() => null)) === null) {
        const put = await fetch(await cloud.presign(key, "PUT"), { method: "PUT", body: model, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(300_000) });
        if (!put.ok) throw new Error(`the mark's model couldn't go up (${put.status})`);
      }
      return key;
    })();
    up.catch(() => modelsUp.delete(hash));
    modelsUp.set(hash, up);
  }
  return up;
}

/**
 * watermark_removal's engine for a file on R2, run on rented CPU machines: its mark learned, and a cell's mark taken
 * out, the same engine as this computer's (the Linux build's addon), its results brought here.
 */
export function watermarkEngine(key: string) {
  return {
    async learn(_input: string, size: [number, number], duration: number, hint: Box | null, avoid: Box[], _progress: (progress: number) => void): Promise<string> {
      const job = await start("learn", { input: key, size, duration, hint, avoid });
      const answer = await wait<{ ok: boolean; error?: string; shared?: boolean }>(job);
      // The engine's own words ("no see-through watermark", …), as from this computer's.
      if (!answer.ok) throw new Error(answer.error ?? "the mark couldn't be learned");
      // Another caller's too: the relay takes it away once both had time to read it.
      return answer.shared === true ? read(job.out) : take(job.out);
    },
    async remove(piece: WatermarkPiece, _progress: (progress: number) => void, stopped: () => boolean = () => false): Promise<WatermarkRemoved | null> {
      const model = await modelKey(piece.model);
      if (stopped()) throw new Error("stopped");
      const job = await start("watermark", { input: key, size: piece.size, fps: piece.fps, from: piece.from, to: piece.to, model, keep: piece.keep });
      const answer = await wait<{ ok: boolean; error?: string; removed?: WatermarkRemoved | null; shared?: boolean }>(job, stopped);
      if (!answer.ok) throw new Error(answer.error ?? "the mark couldn't be taken out");
      if (answer.removed != null) await cloud.download(job.out, piece.out);
      if (answer.shared !== true) await cloud.remove([job.out]).catch(() => {});
      return answer.removed ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// The blur's tracks

/**
 * Longest stretch one rented machine reads at a time: a long file's track is read in parts, several machines at once,
 * and a part that fails is read again alone (Nov 20: SMART Cops' 1,295 s file read as one job for 25 minutes, then
 * failed "could not decode" near its end, and the whole case's blur with it). A whole number of text_track's chunks.
 */
export const TRACK_PART_S = 16 * CHUNK;

/** text_blur's track of a file on R2 over source seconds [from, to), read on rented CPU machines (text_track.ts there). */
export async function track(key: string, size: [number, number], fps: number, region: Box, plan: TrackPlan, from: number, to: number): Promise<Sample[]> {
  const parts: [number, number][] = [];
  for (let at = from; at < to - 1e-6; at += TRACK_PART_S) parts.push([at, Math.min(to, at + TRACK_PART_S)]);
  const read = async ([a, b]: [number, number]): Promise<Sample[]> => {
    let end = b;
    for (let attempt = 1; ; attempt++) {
      try {
        const job = await start("track", { input: key, size, fps, region, plan: { band: plan.band, labels: plan.labels, avoid: plan.avoid, subtitles: plan.subtitles, text: plan.text }, from: a, to: end });
        const answer = await wait<{ ok: boolean; error?: string }>(job);
        if (!answer.ok) throw new Error(answer.error ?? "their words couldn't be read");
        return JSON.parse(await take(job.out)) as Sample[];
      } catch (error) {
        if (attempt >= 2) throw error;
        // Read past the picture's last frame (its sound a little longer; text_track.ts END_GRACE_S): the part ends before it.
        // The machine's words can stop short at the footage's long link ("could not decode https://…"), so any decode failure.
        if (b === to && /fill whole buffer|could not decode/u.test(diag.messageOf(error))) end = Math.max(a, b - END_GRACE_S);
        diag.warn("removal", `track ${a.toFixed(1)}–${b.toFixed(1)} s on a rented machine: ${diag.messageOf(error)}; read again`);
      }
    }
  };
  // In time order, a moment two parts both read (their shared edge) once.
  const samples = (await Promise.all(parts.map(read))).flat().sort((x, y) => x.t - y.t);
  for (let at = samples.length - 1; at > 0; at--) if (samples[at]!.t === samples[at - 1]!.t) samples.splice(at, 1);
  diag.info("removal", `track ${from.toFixed(1)}–${to.toFixed(1)} s read on rented machines in ${parts.length} part${parts.length === 1 ? "" : "s"} (${samples.length} reads)`);
  return samples;
}

// ---------------------------------------------------------------------------
// The finder (captions, labels, marks and notes on rented GPUs)

/** Parent finder state put on R2 for slowed-copy find jobs, by its hash. */
const parentStatesUp = new Map<string, Promise<string>>();

export async function parentStateKey(stateJson: string): Promise<string> {
  const hash = createHash("sha256").update(stateJson).digest("hex").slice(0, 32);
  let up = parentStatesUp.get(hash);
  if (up === undefined) {
    up = (async () => {
      const key = `edit/cleaned/finder/${hash}.json`;
      if ((await cloud.head(key).catch(() => null)) === null) {
        const put = await fetch(await cloud.presign(key, "PUT"), { method: "PUT", body: stateJson, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(300_000) });
        if (!put.ok) throw new Error(`the parent finder state couldn't go up (${put.status})`);
      }
      return key;
    })();
    up.catch(() => parentStatesUp.delete(hash));
    parentStatesUp.set(hash, up);
  }
  return up;
}

/** Runs finder `survey` on a rented GPU for a file on R2 and returns its packed SurveyBundle JSON. */
export async function find<T>(key: string, spans: [number, number][], worker: string, parentKey: string | null = null, stopped: () => boolean = () => false): Promise<T> {
  const job = await start("find", { input: key, spans, ...(parentKey === null ? {} : { parent: parentKey }) }, worker);
  const answer = await wait<{ ok: boolean; error?: string; seconds?: number; shared?: boolean }>(job, stopped);
  if (!answer.ok) throw new Error(answer.error ?? "the finder couldn't read the file");
  // When another Edit deduplicated onto the same job, leave `job.out` for it (the relay cleans it up after 10 min).
  const text = answer.shared === true ? await read(job.out) : await take(job.out);
  return JSON.parse(text) as T;
}
