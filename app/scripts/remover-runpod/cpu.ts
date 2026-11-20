// A rented CPU machine doing removal's CPU work for Edit (apps/relay/src/remover.ts rents it; Sphe, Nov 20: watermarks
// and the blur's tracks off this computer, many at once): it asks the relay for the next job, runs it with Edit's own
// engine (the Linux build's addon, put beside it at boot) and Edit's own track (text_track.ts, bundled in), puts what
// it made on R2 by the URL the relay gave, says so, and asks again; a few jobs at once, as its cores allow. After a
// minute with nothing it says goodbye and the relay lets it go.
//
// Its env: REMOVER_RELAY, REMOVER_TOKEN (the relay's), RUNPOD_POD_ID (RunPod's); the addon, FFmpeg and FFprobe in
// /opt/edit (bootstrap_cpu.sh).
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { track, type TrackPlan } from "../../apps/server/src/text_track.ts";

const RELAY = process.env.REMOVER_RELAY!.replace(/\/$/u, "");
const TOKEN = process.env.REMOVER_TOKEN!;
const POD = process.env.RUNPOD_POD_ID ?? "";
const OPT = "/opt/edit";
/** Nothing to do for this long: goodbye (Edit sends a project's work in waves, so a minute's wait first). */
const IDLE_MS = 60_000;
/** Jobs at once: a watermark cell keeps ~7 cores busy, a track ~5. */
const LANES = Math.max(1, Math.floor(os.cpus().length / 6));

const addon = require(join(OPT, "edit-native.node")) as any;
const tmp = fs.mkdtempSync(join(os.tmpdir(), "remover-"));
addon.init({ home: tmp, cacheDir: tmp, ffmpeg: join(OPT, "edit-ffmpeg"), ffprobe: join(OPT, "edit-ffprobe"), log: () => {} });
const log = (...parts: unknown[]) => console.log("[cpu]", ...parts);

/** An error's words without the presigned links in them (a link is ~600 characters: the reason after it was cut off). */
const said = (error: unknown): string => String((error as Error)?.message ?? error).replace(/https?:\/\/\S+/gu, "<the footage>").slice(0, 400);

async function call(route: string, body: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const answer = await fetch(`${RELAY}${route}`, {
        method: "POST",
        // Its own name: Cloudflare turns some clients' defaults away before the relay sees them (error 1010).
        headers: { "content-type": "application/json", "user-agent": "edit-remover-pod" },
        body: JSON.stringify({ pod: POD, token: TOKEN, ...body }),
        signal: AbortSignal.timeout(60_000),
      });
      if (answer.status >= 400 && answer.status < 500) throw new Error(`the relay refused ${route}: ${answer.status} ${await answer.text()}`);
      if (answer.ok) return answer.json();
    } catch (error) {
      if (attempt >= 4 || String(error).includes("refused")) throw error;
    }
    await Bun.sleep(2000 * (attempt + 1));
  }
}

async function put(url: string, body: Blob | string, type: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const answer = await fetch(url, { method: "PUT", body, headers: { "content-type": type }, signal: AbortSignal.timeout(300_000) }).catch(() => null);
    if (answer?.ok) return;
    if (attempt >= 2) throw new Error(`R2 refused what was made (${answer?.status ?? "unreachable"})`);
    await Bun.sleep(2000 * (attempt + 1));
  }
}

async function run(job: any): Promise<Record<string, unknown>> {
  const started = Date.now();
  if (job.kind === "learn") {
    try {
      const model = await addon.watermarkLearn(job.input_url, job.size, job.duration, job.hint ?? null, job.avoid ?? [], () => {});
      await put(job.output_url, model, "application/json");
      return { ok: true, seconds: (Date.now() - started) / 1000 };
    } catch (error) {
      // The engine's own words ("no see-through watermark", …): Edit reads them as from its own engine.
      return { ok: false, error: said(error) };
    }
  }
  if (job.kind === "watermark") {
    const model = await (await fetch(job.model_url, { signal: AbortSignal.timeout(120_000) })).text();
    const out = join(tmp, `${job.id}.mp4`);
    try {
      const removed = await addon.watermarkRemove({ source: job.input_url, size: job.size, fps: job.fps, from: job.from, to: job.to, model, keep: job.keep ?? [], out }, () => {});
      if (removed != null && fs.existsSync(out)) await put(job.output_url, Bun.file(out), "video/mp4");
      return { ok: true, removed: removed ?? null, seconds: (Date.now() - started) / 1000 };
    } finally {
      fs.rmSync(out, { force: true });
    }
  }
  if (job.kind === "track") {
    const id = addon.screenTextStretch(job.input_url, job.size, job.fps, job.region);
    try {
      const samples = await track(job.plan as TrackPlan, job.from, job.to, (times, keep) => addon.screenTextStretchRead(id, times, keep));
      await put(job.output_url, JSON.stringify(samples), "application/json");
      return { ok: true, reads: samples.length, seconds: (Date.now() - started) / 1000 };
    } finally {
      addon.screenTextStretchClose?.(id);
    }
  }
  return { ok: false, error: `no such job: ${job.kind}` };
}

let lastWork = Date.now();
let leaving = false;
/** Jobs under way in any lane: the machine never says goodbye while one is (Nov 20: idle lanes did, mid-watermark, and the relay let the machine go with the cell half done, again and again). */
let active = 0;

async function lane(n: number): Promise<void> {
  while (!leaving) {
    const answer = await call("/v1/remover/pod/next", { lane: n });
    const job = answer.job;
    if (job == null) {
      if (active === 0 && Date.now() - lastWork > IDLE_MS && !leaving) {
        leaving = true;
        log("nothing left: goodbye");
        await call("/v1/remover/pod/bye", {});
        return;
      }
      await Bun.sleep(3000);
      continue;
    }
    lastWork = Date.now();
    active += 1;
    log(`lane ${n}: ${job.kind} ${job.id}`);
    let output: Record<string, unknown>;
    try {
      output = await run(job);
    } catch (error) {
      output = { ok: false, error: said(error) };
    } finally {
      active -= 1;
    }
    await call("/v1/remover/pod/done", { id: job.id, output });
    lastWork = Date.now();
    log(`lane ${n}: ${job.kind} ${job.id} ${output.ok ? "done" : `failed: ${String(output.error)}`} in ${String(output.seconds ?? "?")} s`);
  }
}

log(`up as ${POD}, ${os.cpus().length} cores, ${LANES} lanes`);
await Promise.all(Array.from({ length: LANES }, (_, n) => lane(n)));
// The relay stops the machine; until it does, nothing more is asked.
await Bun.sleep(3_600_000);
