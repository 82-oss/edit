/**
 * Their burned-in subtitles taken out by MiniMax-Remover on GPUs rented from RunPod by the minute (Sphe, Nov 20: "rent,
 * use, switch off"): a rented pod is ~4x cheaper than RunPod's serverless for the same card, and Edit's machines need
 * no GPU of their own.
 *
 * Edit hands the relay a stretch the way it handed its own worker one (text_inpaint.ts), with R2 keys where the
 * worker had files, and the worker's code itself (minimax_worker.py, as that build has it). The relay keeps the
 * stretches in a queue (RemoverPods, a Durable Object), rents pods while there are stretches waiting (cheapest card a
 * clip first, at most MAX_PODS), and each pod (app/scripts/remover-runpod/pod.py) asks for the next stretch, cleans it,
 * writes the strip straight to R2 and says so; a pod with nothing left says goodbye and is let go, and a pod that goes
 * quiet is let go too (its stretch handed to another), so nothing is ever paid for long after the work is done.
 *
 *   POST   /v1/remover/jobs        {worker, request: {input, beneath: [{key, from, box}], from, fps, width, height, matrix, masks}}
 *          → 202 {id, out}: `out` is the strip's R2 key once it's done
 *   GET    /v1/remover/jobs/<id>   → 200 {ok, box, inferred, seconds} | 202 {pending: true} | 502 {error}
 *   DELETE /v1/remover/jobs/<id>   → 200 {ok}: the person's Stop
 *   POST   /v1/remover/pod/next|done|bye   the pods' own (their token, given when rented)
 *
 * The flag is `REMOVER` ("pods" on, anything else off, wrangler.toml's vars): /health says `remover: true` only when
 * it's on and the key, the queue and R2 are here.
 */
import { allow, burstKey, type AuthEnv } from "./auth";
import { objectUrl, r2Config, validKey, type CloudEnv } from "./cloud";
import { BOOTSTRAP_B64, POD_B64 } from "./remover_kit";

interface Stub {
  fetch(request: Request): Promise<Response>;
}

export interface RemoverEnv extends CloudEnv, AuthEnv {
  RUNPOD_API_KEY?: string;
  /** "pods": stretches cleaned on rented RunPod pods; anything else (or unset), Edit blurs them (or uses its own GPU). */
  REMOVER?: string;
  REMOVER_PODS?: { idFromName(name: string): unknown; get(id: unknown): Stub };
  CLOUD_BURST?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const RUNPOD = "https://api.runpod.io/v2";
/** How long a pod has to read the footage and write the strip (a long stretch on a slow card). */
const URL_SECONDS = 6 * 3600;
/** Where a strip lands until Edit takes it (Edit deletes it then). */
const OUT_PREFIX = "edit/cleaned/work/";
const MAX_FRAMES = 36_000;
const MAX_WORKER = 200_000;
/**
 * Pods rented at once: one, the cheapest way (Sphe, Nov 20: "lets go ahead and do it the cheap way"): each pod pays its
 * ~1.5 min boot and its minute idle after, so one pod working through a project costs least; ten were ~8x quicker
 * for ~40% more.
 */
export const MAX_PODS = 1;
/** A rented pod that hasn't asked for work by now (booting: pulling the image, installing, loading) is let go. */
const BOOT_MS = 15 * 60_000;
/** A pod that has gone quiet this long (mid-stretch it asks again only when done: the longest stretch's time). */
const QUIET_MS = 3 * 60_000;
const RUNNING_MS = 45 * 60_000;
/** A stretch a pod died on is handed to another this many times, then failed (it stays blurred). */
const TRIES = 2;
/**
 * Pods let go in a row without ever asking for work: renting stops and what's waiting fails (it stays blurred), so a
 * pod that can't start is never paid for over and over (Nov 20: a refused first ask had the relay rent six in turn).
 */
const BOOT_FAILURES = 3;
const IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
/**
 * The cards tried, cheapest a clip first (measured Nov 19 on an 8 s clip: 3090 41 s, 5090 16 s, A5000 ~41 s, 4090
 * 22 s), each where it's offered; the first one RunPod has is rented. The model needs ~13 GB.
 */
export const GPUS: { id: string; cloud: "COMMUNITY" | "SECURE" }[] = [
  { id: "NVIDIA GeForce RTX 3090", cloud: "COMMUNITY" },
  { id: "NVIDIA GeForce RTX 5090", cloud: "COMMUNITY" },
  { id: "NVIDIA RTX A5000", cloud: "SECURE" },
  { id: "NVIDIA GeForce RTX 4090", cloud: "COMMUNITY" },
  { id: "NVIDIA GeForce RTX 4090", cloud: "SECURE" },
  { id: "NVIDIA GeForce RTX 3090", cloud: "SECURE" },
];

/** Whether this relay cleans on RunPod (the flag on, the key, the queue and R2 here). */
export function removerOn(env: RemoverEnv): boolean {
  return env.REMOVER === "pods" && Boolean(env.RUNPOD_API_KEY) && env.REMOVER_PODS !== undefined && r2Config(env) !== null;
}

interface Beneath {
  key: string;
  from: number;
  box: number[];
}

interface Stretch {
  input: string;
  beneath: Beneath[];
  from: number;
  fps: number;
  width: number;
  height: number;
  matrix: string;
  masks: number[][][];
}

/** The stretch as Edit sends it, held to what it must be (null: not one). */
export function readRequest(value: unknown): Stretch | null {
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

const queueOf = (env: RemoverEnv): Stub => env.REMOVER_PODS!.get(env.REMOVER_PODS!.idFromName("remover"));
const ask = (stub: Stub, path: string, body: unknown) => stub.fetch(new Request(`https://remover${path}`, { method: "POST", body: JSON.stringify(body) }));

export async function removerJobs(request: Request, url: URL, env: RemoverEnv): Promise<Response> {
  // The pods' own routes: their token is checked by the queue.
  if (url.pathname.startsWith("/v1/remover/pod/") && request.method === "POST") {
    if (!removerOn(env)) return json(503, { error: "Cleaning on RunPod isn't on for this relay." });
    const what = url.pathname.slice("/v1/remover/pod/".length);
    if (what !== "next" && what !== "done" && what !== "bye") return json(404, { error: "not found" });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "Send JSON." });
    }
    return ask(queueOf(env), `/pod/${what}`, body);
  }

  const found = await allow(request, env, "use", "remover/jobs");
  if (found instanceof Response) return found;
  // Someone whose work is editing (or an admin): the GPUs are paid by the minute.
  if (found.kind === "person" && !found.admin && !found.perms.some((perm) => perm.startsWith("edit."))) {
    return json(403, { error: "Your account can't clean footage: an admin can give you an editing permission at accounts.spheceo.com." });
  }
  if (!removerOn(env)) return json(503, { error: "Cleaning on RunPod isn't on for this relay.", remover: false });
  const queue = queueOf(env);

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
    const id = crypto.randomUUID();
    const out = `${OUT_PREFIX}${id}.mp4`;
    const answer = await ask(queue, "/enqueue", { id, out, worker: body.worker, stretch, relay: url.origin });
    if (!answer.ok) return answer;
    console.log(JSON.stringify({ route: "remover/jobs", queued: id, input: stretch.input, frames: stretch.masks.length }));
    return json(202, { id, out });
  }

  const match = /^\/v1\/remover\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (match !== null && request.method === "GET") return ask(queue, "/status", { id: match[1] });
  if (match !== null && request.method === "DELETE") return ask(queue, "/cancel", { id: match[1] });
  return json(404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// The queue and the pods

interface Job {
  id: string;
  out: string;
  worker: string;
  stretch: Stretch;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  tries: number;
  pod?: string;
  startedAt?: number;
  output?: Record<string, unknown>;
  at: number;
}

interface Pod {
  token: string;
  gpu: string;
  cloud: string;
  rentedAt: number;
  seenAt: number | null;
  job?: string;
}

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

/** The stretches waiting, being cleaned and done, and the pods rented for them (one queue for every Edit). */
export class RemoverPods {
  constructor(
    private state: { storage: Storage; blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> },
    private env: RemoverEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = (await request.json()) as Record<string, unknown>;
    return this.state.blockConcurrencyWhile(async () => {
      if (path === "/enqueue") return this.enqueue(body);
      if (path === "/status") return this.status(String(body.id));
      if (path === "/cancel") return this.cancel(String(body.id));
      if (path.startsWith("/pod/")) return this.fromPod(path.slice(5), body);
      return json(404, { error: "not found" });
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(() => this.tend());
  }

  private storage() {
    return this.state.storage;
  }

  private async pods(): Promise<Record<string, Pod>> {
    return (await this.storage().get<Record<string, Pod>>("pods")) ?? {};
  }

  private async order(): Promise<string[]> {
    return (await this.storage().get<string[]>("order")) ?? [];
  }

  private async enqueue(body: Record<string, unknown>): Promise<Response> {
    const job: Job = { id: String(body.id), out: String(body.out), worker: String(body.worker), stretch: body.stretch as Stretch, state: "queued", tries: 0, at: Date.now() };
    await this.storage().put(`j:${job.id}`, job);
    await this.storage().put("order", [...(await this.order()), job.id]);
    if (typeof body.relay === "string") await this.storage().put("relay", body.relay);
    await this.tend();
    return json(200, { ok: true });
  }

  private async status(id: string): Promise<Response> {
    const job = await this.storage().get<Job>(`j:${id}`);
    if (job === undefined) return json(404, { error: "no such stretch" });
    if (job.state === "done") return json(200, job.output ?? { ok: true, box: null });
    if (job.state === "failed") return json(502, { error: `the GPU couldn't clean it: ${String(job.output?.error ?? "it stopped twice")}` });
    if (job.state === "cancelled") return json(502, { error: "stopped" });
    return json(202, { pending: true, status: job.state });
  }

  private async cancel(id: string): Promise<Response> {
    const job = await this.storage().get<Job>(`j:${id}`);
    if (job !== undefined && (job.state === "queued" || job.state === "running")) {
      job.state = "cancelled";
      await this.storage().put(`j:${id}`, job);
      await this.storage().put("order", (await this.order()).filter((one) => one !== id));
    }
    return json(200, { ok: true });
  }

  private async fromPod(what: string, body: Record<string, unknown>): Promise<Response> {
    const pods = await this.pods();
    const id = String(body.pod ?? "");
    const pod = pods[id];
    if (pod === undefined || pod.token !== body.token) return json(403, { error: "not one of ours" });
    pod.seenAt = Date.now();
    await this.storage().put("bootFailures", 0);
    if (what === "bye") {
      delete pods[id];
      await this.storage().put("pods", pods);
      await this.letGo(id);
      return json(200, { ok: true });
    }
    if (what === "done") {
      const job = await this.storage().get<Job>(`j:${String(body.id)}`);
      if (job !== undefined && job.state === "running" && job.pod === id) {
        const output = (body.output ?? {}) as Record<string, unknown>;
        if (output.ok === true) Object.assign(job, { state: "done", output, at: Date.now() });
        else if (job.tries + 1 < TRIES) await this.requeue(job);
        else Object.assign(job, { state: "failed", output, at: Date.now() });
        job.tries += output.ok === true ? 0 : 1;
        await this.storage().put(`j:${job.id}`, job);
      }
      delete pod.job;
      await this.storage().put("pods", pods);
      return json(200, { ok: true });
    }
    // next: the stretch it had (it asked again after a restart), else the next one waiting.
    let job: Job | undefined = pod.job === undefined ? undefined : await this.storage().get<Job>(`j:${pod.job}`);
    if (job === undefined || job.state !== "running" || job.pod !== id) {
      job = undefined;
      const order = await this.order();
      while (order.length > 0 && job === undefined) {
        const next = await this.storage().get<Job>(`j:${order.shift()!}`);
        if (next !== undefined && next.state === "queued") job = next;
      }
      await this.storage().put("order", order);
      if (job !== undefined) {
        Object.assign(job, { state: "running", pod: id, startedAt: Date.now() });
        await this.storage().put(`j:${job.id}`, job);
        pod.job = job.id;
      }
    }
    await this.storage().put("pods", pods);
    if (job === undefined) return json(200, { job: null, bye: (await this.order()).length === 0 });
    return json(200, { job: await this.payload(job) });
  }

  /** What a pod needs for a stretch: its code, and fresh signed URLs for the footage, its watermark strips and the strip. */
  private async payload(job: Job): Promise<Record<string, unknown>> {
    const r2 = r2Config(this.env)!;
    const s = job.stretch;
    return {
      id: job.id,
      worker: job.worker,
      input_url: await objectUrl(r2, "GET", s.input, {}, URL_SECONDS),
      beneath: await Promise.all(s.beneath.map(async (one) => ({ file: await objectUrl(r2, "GET", one.key, {}, URL_SECONDS), from: one.from, box: one.box }))),
      output_url: await objectUrl(r2, "PUT", job.out, {}, URL_SECONDS),
      from: s.from,
      fps: s.fps,
      width: s.width,
      height: s.height,
      matrix: s.matrix,
      masks: s.masks,
    };
  }

  private async requeue(job: Job): Promise<void> {
    Object.assign(job, { state: "queued", pod: undefined, startedAt: undefined });
    await this.storage().put("order", [job.id, ...(await this.order())]);
  }

  /**
   * The pods brought in line with the work, run on every change and every 30 s while anything is out: quiet or
   * unbooted pods let go (their stretch handed on), pods rented while stretches wait, old stretches forgotten.
   */
  private async tend(): Promise<void> {
    const now = Date.now();
    const pods = await this.pods();
    let bootFailures = (await this.storage().get<number>("bootFailures")) ?? 0;
    for (const [id, pod] of Object.entries(pods)) {
      const gone = pod.seenAt === null ? now - pod.rentedAt > BOOT_MS : now - pod.seenAt > (pod.job === undefined ? QUIET_MS : RUNNING_MS);
      if (!gone) continue;
      if (pod.seenAt === null) bootFailures += 1;
      if (pod.job !== undefined) {
        const job = await this.storage().get<Job>(`j:${pod.job}`);
        if (job !== undefined && job.state === "running" && job.pod === id) {
          job.tries += 1;
          if (job.tries < TRIES) await this.requeue(job);
          else Object.assign(job, { state: "failed", output: { ok: false, error: "the GPU went quiet" }, at: now });
          await this.storage().put(`j:${job.id}`, job);
        }
      }
      delete pods[id];
      await this.letGo(id);
    }
    await this.storage().put("bootFailures", bootFailures);
    if (bootFailures >= BOOT_FAILURES) {
      // Pods aren't starting: what's waiting fails now (blurred) rather than renting more.
      for (const id of await this.order()) {
        const job = await this.storage().get<Job>(`j:${id}`);
        if (job !== undefined && job.state === "queued") await this.storage().put(`j:${id}`, { ...job, state: "failed", output: { ok: false, error: `${BOOT_FAILURES} rented GPUs in a row never started` }, at: now });
      }
      await this.storage().put("order", []);
      await this.storage().put("bootFailures", 0);
      console.log(JSON.stringify({ route: "remover/tend", stopped: "pods aren't starting" }));
    }
    const waiting = (await this.order()).length;
    const idle = Object.values(pods).filter((pod) => pod.job === undefined).length;
    const want = Math.min(MAX_PODS - Object.keys(pods).length, waiting - idle);
    for (let n = 0; n < want; n++) {
      const rented = await this.rent();
      if (rented === null) break;
      pods[rented.id] = rented.pod;
    }
    await this.storage().put("pods", pods);
    // Stretches a day old are forgotten (Edit has long taken their strips).
    const jobs = await this.storage().list<Job>({ prefix: "j:" });
    for (const [key, job] of jobs) if ((job.state === "done" || job.state === "failed" || job.state === "cancelled") && now - job.at > 86400_000) await this.storage().delete(key);
    if (Object.keys(pods).length > 0 || waiting > 0) await this.storage().setAlarm(now + 30_000);
    else await this.storage().deleteAlarm();
  }

  /** A pod rented on the first card RunPod has (cheapest a clip first), null when none is to be had now. */
  private async rent(): Promise<{ id: string; pod: Pod } | null> {
    const relay = (await this.storage().get<string>("relay")) ?? "";
    const token = crypto.randomUUID();
    for (const gpu of GPUS) {
      const answer = await fetch(`${RUNPOD}/pods`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.RUNPOD_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: `edit-remover-${token.slice(0, 8)}`,
          cloud: gpu.cloud,
          gpu: { id: gpu.id, count: 1, minCudaVersion: "12.8" },
          image: IMAGE,
          entrypoint: ["/bin/bash", "-c"],
          cmd: ['mkdir -p /tmp/remover && echo "$BOOTSTRAP_B64" | base64 -d > /tmp/remover/bootstrap.sh && echo "$POD_B64" | base64 -d > /tmp/remover/pod.py && exec bash /tmp/remover/bootstrap.sh'],
          disk: 30,
          env: { BOOTSTRAP_B64, POD_B64, REMOVER_RELAY: relay, REMOVER_TOKEN: token },
        }),
      });
      const text = await answer.text();
      if (!answer.ok) {
        console.log(JSON.stringify({ route: "remover/rent", gpu: gpu.id, cloud: gpu.cloud, refused: answer.status, why: text.slice(0, 200) }));
        continue;
      }
      const id = (JSON.parse(text) as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      console.log(JSON.stringify({ route: "remover/rent", pod: id, gpu: gpu.id, cloud: gpu.cloud }));
      return { id, pod: { token, gpu: gpu.id, cloud: gpu.cloud, rentedAt: Date.now(), seenAt: null } };
    }
    return null;
  }

  private async letGo(id: string): Promise<void> {
    const answer = await fetch(`${RUNPOD}/pods/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${this.env.RUNPOD_API_KEY}` } }).catch(() => null);
    console.log(JSON.stringify({ route: "remover/letgo", pod: id, status: answer?.status ?? "unreachable" }));
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
