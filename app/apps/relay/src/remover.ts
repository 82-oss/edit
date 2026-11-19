/**
 * Their burned-in subtitles taken out by MiniMax-Remover on RunPod's GPUs (Sphe, Nov 19: "temporarily disable the
 * local GPU stuff, and then just quickly set up Runpod"), so every Edit cleans, not only a Linux machine with the model
 * installed, and many stretches go at once instead of one at a time on one GPU.
 *
 * Edit hands the relay a stretch the way it handed its own worker one (text_inpaint.ts), with R2 keys where the
 * worker had files, and the worker's code itself (minimax_worker.py, as that build has it, so the GPU runs exactly
 * the build's version); the relay signs the keys and starts the job on the RunPod endpoint
 * (app/scripts/remover-runpod/, REMOVER_ENDPOINT below), which writes the strip straight to R2:
 *
 *   POST   /v1/remover/jobs        {worker, request: {input, beneath: [{key, from, box}], from, fps, width, height, matrix, masks}}
 *          → 202 {id, out}: `out` is the strip's R2 key once it's done
 *   GET    /v1/remover/jobs/<id>   → 200 {ok, box, inferred, seconds} | 202 {pending: true} | 502 {error}
 *   DELETE /v1/remover/jobs/<id>   → 200 {ok}: the person's Stop
 *
 * The flag is `REMOVER` ("runpod" on, anything else off, wrangler.toml's vars): /health says `remover: true` only when
 * it's on and the key and endpoint are here; Edit asks before it plans, so turning it off is a relay deploy.
 */
import { allow, burstKey, type AuthEnv } from "./auth";
import { objectUrl, r2Config, validKey, type CloudEnv } from "./cloud";

export interface RemoverEnv extends CloudEnv, AuthEnv {
  RUNPOD_API_KEY?: string;
  /** "runpod": stretches cleaned on RunPod; anything else (or unset), Edit blurs them (or cleans on its own GPU). */
  REMOVER?: string;
  /** The RunPod Serverless endpoint running app/scripts/remover-runpod/handler.py. */
  REMOVER_ENDPOINT?: string;
  CLOUD_BURST?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const RUNPOD = "https://api.runpod.ai/v2";
/** How long the GPU has to read the footage and write the strip (a long stretch on a slow card, queued behind others). */
const URL_SECONDS = 6 * 3600;
const ID = /^[A-Za-z0-9_-]{6,100}$/;
/** Where a strip lands until Edit takes it (Edit deletes it then; the cleanup cron any it never took). */
const OUT_PREFIX = "edit/cleaned/work/";
/** A stretch at most ~10 minutes at 60 fps; the worker's code at most this long. */
const MAX_FRAMES = 36_000;
const MAX_WORKER = 200_000;

/** Whether this relay cleans on RunPod (the flag on, the key, the endpoint and R2 here). */
export function removerOn(env: RemoverEnv): boolean {
  return env.REMOVER === "runpod" && Boolean(env.RUNPOD_API_KEY) && Boolean(env.REMOVER_ENDPOINT) && r2Config(env) !== null;
}

interface Beneath {
  key: string;
  from: number;
  box: number[];
}

/** The stretch as Edit sends it, held to what it must be (null: not one). */
export function readRequest(value: unknown): { input: string; beneath: Beneath[]; from: number; fps: number; width: number; height: number; matrix: string; masks: number[][][] } | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  if (!validKey(r.input)) return null;
  if (!num(r.from, 0, 1e6) || !num(r.fps, 1, 240) || !num(r.width, 16, 8192) || !num(r.height, 16, 8192)) return null;
  if (r.matrix !== "bt709" && r.matrix !== "bt601") return null;
  if (!Array.isArray(r.masks) || r.masks.length === 0 || r.masks.length > MAX_FRAMES) return null;
  const box = (b: unknown) => Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === "number" && Number.isFinite(x));
  if (!r.masks.every((frame) => Array.isArray(frame) && frame.length <= 64 && frame.every(box))) return null;
  const beneath = Array.isArray(r.beneath) ? r.beneath : [];
  if (beneath.length > 16 || !beneath.every((one) => typeof one === "object" && one !== null && validKey((one as Beneath).key) && num((one as Beneath).from, 0, 1e6) && box((one as Beneath).box))) return null;
  return { input: r.input as string, beneath: beneath as Beneath[], from: r.from as number, fps: r.fps as number, width: r.width as number, height: r.height as number, matrix: r.matrix, masks: r.masks as number[][][] };
}

export async function removerJobs(request: Request, url: URL, env: RemoverEnv): Promise<Response> {
  const found = await allow(request, env, "use", "remover/jobs");
  if (found instanceof Response) return found;
  // Someone whose work is editing (or an admin): the GPUs are paid by the second.
  if (found.kind === "person" && !found.admin && !found.perms.some((perm) => perm.startsWith("edit."))) {
    return json(403, { error: "Your account can't clean footage: an admin can give you an editing permission at accounts.spheceo.com." });
  }
  const r2 = r2Config(env);
  if (!removerOn(env) || r2 === null) return json(503, { error: "Cleaning on RunPod isn't on for this relay.", remover: false });
  const auth = { authorization: `Bearer ${env.RUNPOD_API_KEY}` };
  const endpoint = `${RUNPOD}/${env.REMOVER_ENDPOINT}`;

  if (url.pathname === "/v1/remover/jobs" && request.method === "POST") {
    let body: { worker?: unknown; request?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "Send JSON: {worker, request}." });
    }
    if (typeof body.worker !== "string" || body.worker.length === 0 || body.worker.length > MAX_WORKER) return json(400, { error: "worker must be the worker's code." });
    const stretch = readRequest(body.request);
    if (stretch === null) return json(400, { error: "request isn't a stretch to clean." });
    if (env.CLOUD_BURST !== undefined && !(await env.CLOUD_BURST.limit({ key: `remover:${burstKey(request, found)}` })).success) return json(429, { error: "Too many stretches at once; try again in a minute." });
    const out = `${OUT_PREFIX}${crypto.randomUUID()}.mp4`;
    const input = {
      worker: body.worker,
      input_url: await objectUrl(r2, "GET", stretch.input, {}, URL_SECONDS),
      beneath: await Promise.all(stretch.beneath.map(async (one) => ({ file: await objectUrl(r2, "GET", one.key, {}, URL_SECONDS), from: one.from, box: one.box }))),
      output_url: await objectUrl(r2, "PUT", out, {}, URL_SECONDS),
      from: stretch.from,
      fps: stretch.fps,
      width: stretch.width,
      height: stretch.height,
      matrix: stretch.matrix,
      masks: stretch.masks,
    };
    const started = await fetch(`${endpoint}/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ input, policy: { executionTimeout: 3_600_000, ttl: 6 * 3_600_000 } }) });
    const text = await started.text();
    if (!started.ok) return json(started.status === 429 ? 429 : 502, { error: `RunPod refused the stretch (${started.status}): ${text.slice(0, 300)}` });
    let answer: { id?: unknown } = {};
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      // Below: no id to follow.
    }
    if (typeof answer.id !== "string" || !ID.test(answer.id)) return json(502, { error: `RunPod took the stretch but gave no job to follow (${text.slice(0, 200)}).` });
    console.log(JSON.stringify({ route: "remover/jobs", started: answer.id, input: stretch.input, frames: stretch.masks.length }));
    return json(202, { id: answer.id, out });
  }

  const match = /^\/v1\/remover\/jobs\/([A-Za-z0-9_-]{6,100})$/.exec(url.pathname);
  if (match !== null && request.method === "GET") {
    const asked = await fetch(`${endpoint}/status/${encodeURIComponent(match[1]!)}`, { headers: auth });
    if (!asked.ok) return json(asked.status === 404 ? 404 : 502, { error: `RunPod couldn't say how it's going (${asked.status}): ${(await asked.text()).slice(0, 200)}` });
    const job = (await asked.json().catch(() => ({}))) as { status?: unknown; output?: Record<string, unknown>; error?: unknown };
    if (job.status === "COMPLETED") {
      const output = job.output ?? {};
      if (output.ok !== true) return json(502, { error: typeof output.error === "string" ? output.error : "the model failed" });
      return json(200, output);
    }
    if (job.status === "FAILED" || job.status === "CANCELLED" || job.status === "TIMED_OUT") {
      return json(502, { error: `the GPU couldn't clean it (${String(job.status).toLowerCase()}): ${typeof job.error === "string" ? job.error.slice(0, 300) : ""}` });
    }
    return json(202, { pending: true, status: job.status });
  }
  if (match !== null && request.method === "DELETE") {
    await fetch(`${endpoint}/cancel/${encodeURIComponent(match[1]!)}`, { method: "POST", headers: auth }).catch(() => undefined);
    return json(200, { ok: true });
  }
  return json(404, { error: "not found" });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export { OUT_PREFIX as REMOVER_OUT_PREFIX };
