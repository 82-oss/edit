/**
 * Removal's heavy work on machines rented from RunPod by the minute (Sphe, Nov 20: "rent, use, switch off", then
 * "build out everything"): their subtitles cleaned by MiniMax-Remover on a rented GPU, their watermarks taken out and
 * the blur's tracks read by Edit's own engine on rented CPU machines, many at once, so no Edit needs a GPU or its
 * cores for it, and a project's removal takes minutes, not hours.
 *
 * Edit hands the relay a job the way it ran it itself (remover_cloud.ts), with R2 keys where it had files. The relay
 * keeps the jobs in a queue per kind of machine (RemoverPods, a Durable Object), rents machines while jobs wait
 * (a GPU for cleaning, the cheapest card a clip first; CPU machines for the rest), and each machine asks for its next
 * job, does it, writes what it made straight to R2 and says so (app/scripts/remover-runpod: pod.py on a GPU, cpu.ts
 * on a CPU machine, handed to it with their setup as remover_kit.ts). A machine with nothing left says goodbye and
 * is let go; one that goes quiet is let go too (its jobs handed to another), and machines that never start stop the
 * renting, so nothing is ever paid for long after the work is done.
 *
 *   POST   /v1/remover/jobs        {kind, request, worker?} → 202 {id, out}: `out` is where its result lands on R2
 *          clean:     {input, beneath: [{key, from, box}], from, fps, width, height, matrix, masks}, worker (minimax_worker.py)
 *          learn:     {input, size, duration, hint, avoid}            → the mark's model (JSON) at `out`
 *          watermark: {input, size, fps, from, to, model, keep}       → the strip at `out`, `removed` in the answer
 *          track:     {input, size, fps, region, plan, from, to}      → the reads (JSON) at `out`
 *   GET    /v1/remover/jobs/<id>   → 200 {ok, …} | 202 {pending: true} | 502 {error}
 *   DELETE /v1/remover/jobs/<id>   → 200 {ok}: the person's Stop
 *   POST   /v1/remover/pod/next|done|bye   the machines' own (their token, given when rented)
 *
 * The flag is `REMOVER` ("pods" on, anything else off, wrangler.toml's vars): /health says `remover: true` only when
 * it's on and the key, the queue and R2 are here.
 */
import { allow, burstKey, type AuthEnv } from "./auth";
import { objectUrl, r2Config, validKey, type CloudEnv } from "./cloud";
import { BOOTSTRAP_B64, CPU_B64, CPU_BOOT_B64, POD_B64 } from "./remover_kit";
import { RUNTIME } from "./remover_runtime";

interface Stub {
  fetch(request: Request): Promise<Response>;
}

export interface RemoverEnv extends CloudEnv, AuthEnv {
  RUNPOD_API_KEY?: string;
  /** "pods": removal's heavy work on rented RunPod machines; anything else (or unset), Edit does it itself. */
  REMOVER?: string;
  REMOVER_PODS?: { idFromName(name: string): unknown; get(id: unknown): Stub };
  CLOUD_BURST?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const RUNPOD = "https://api.runpod.io/v2";
/** How long a machine has to read the footage and write what it made. */
const URL_SECONDS = 6 * 3600;
/** Where results land until Edit takes them (Edit deletes them then). */
const OUT_PREFIX = "edit/cleaned/work/";
/** The marks' models Edit puts up for the watermark jobs (remover_cloud.ts `modelKey`). */
const MODEL_PREFIX = "edit/cleaned/models/";
/** Parent finder state Edit puts up for slowed-copy find jobs (remover_cloud.ts `parentStateKey`). */
const FINDER_PREFIX = "edit/cleaned/finder/";
const MAX_FRAMES = 36_000;
const MAX_WORKER = 200_000;

type Kind = "clean" | "learn" | "watermark" | "track" | "find";
type Pool = "gpu" | "cpu";
const poolOf = (kind: Kind): Pool => (kind === "clean" || kind === "find" ? "gpu" : "cpu");

/**
 * Machines rented at once a pool. One GPU, the cheapest way (Sphe, Nov 20: "lets go ahead and do it the cheap way":
 * each pays its ~1.5 min boot and a minute idle after). Two 32-core CPU machines: a video's watermarks and tracks
 * (~21 core-hours, measured Nov 20) in ~20 minutes for ~$0.75; more were barely quicker for more.
 */
export const MAX_PODS: Record<Pool, number> = { gpu: 16, cpu: 2 };
/**
 * GPU work one rented GPU is given before another is rented: its boot and idle minute (~2.5 min paid) stay a few
 * percent of what it does, so more GPUs cost about the same as one and finish sooner (Nov 20: SMART Cops' ~2,300 s
 * to clean was ~3.5 h on one 4090). A clean's work: ~8 s of GPU a footage second (Nov 22, Boyfriends: 1,560 s of
 * tall caption bands took ~3.3 card-hours on a 5090 and a 3090; at 5 s and 45 minutes a card, two cards were rented
 * and this morning's 376 s took two hours). A quarter of an hour's work a card, up to sixteen cards (Sphe, Nov 23:
 * eight videos on one afternoon): a video's ~1,500 s is on a dozen cards and back in about a quarter of an hour.
 */
const GPU_WORK_EACH_S = 15 * 60;
const GPU_S_A_FOOTAGE_S = 8;
/** Weight of one finder job when deciding how many GPUs to rent: ~1 s of card weight per footage second plus 60 s overhead,
 * so one short file or a handful of tiny clips share a card while several long files rent cards in parallel (and stay warm for cleans). */
const FIND_S_A_FOOTAGE_S = 1;
const FIND_OVERHEAD_S = 60;
/** Jobs a CPU machine does at once (cpu.ts LANES on 32 cores): how many waiting jobs one machine covers. */
const CPU_LANES = 5;
/** A rented machine that hasn't asked for work by now (booting: pulling the image, installing, loading) is let go. */
const BOOT_MS = 15 * 60_000;
/** A machine that has gone quiet this long with nothing to do, or this long mid-job (the longest job's time). */
const QUIET_MS = 3 * 60_000;
const RUNNING_MS = 45 * 60_000;
/** A job a machine died on is handed to another this many times, then failed (Edit leaves it as it was). */
const TRIES = 2;
/**
 * Machines let go in a row without ever asking for work: renting stops and what waits fails, so a machine that can't
 * start is never paid for over and over (Nov 20: a refused first ask had the relay rent six in turn).
 */
const BOOT_FAILURES = 3;
const GPU_IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
/** The engine is built on Ubuntu 26.04 (glibc 2.43): its machines run the same. */
const CPU_IMAGE = "ubuntu:26.04";
/**
 * The cards tried for cleaning, quickest first, then cheapest a clip (measured Nov 19 on an 8 s clip: 3090 41 s, 5090
 * 16 s, A5000 ~41 s, 4090 22 s; the 5090 is ~2.5 times as quick as the 3090 for about a fifth more a clip), each
 * where it's offered; the first one RunPod has is rented. The model needs ~13 GB.
 */
export const GPUS: { id: string; cloud: "COMMUNITY" | "SECURE" }[] = [
  { id: "NVIDIA GeForce RTX 5090", cloud: "COMMUNITY" },
  { id: "NVIDIA GeForce RTX 3090", cloud: "COMMUNITY" },
  { id: "NVIDIA RTX A5000", cloud: "SECURE" },
  { id: "NVIDIA GeForce RTX 4090", cloud: "COMMUNITY" },
  { id: "NVIDIA GeForce RTX 4090", cloud: "SECURE" },
  { id: "NVIDIA GeForce RTX 3090", cloud: "SECURE" },
];
/** The CPU machines tried, cheapest a core first ($0.03, $0.035, $0.04 a core-hour); 32 cores each. */
export const CPUS = ["cpu3c", "cpu5c", "cpu3g"];

/** Whether this relay does removal on RunPod (the flag on, the key, the queue and R2 here). */
export function removerOn(env: RemoverEnv): boolean {
  return env.REMOVER === "pods" && Boolean(env.RUNPOD_API_KEY) && env.REMOVER_PODS !== undefined && r2Config(env) !== null;
}

// ---------------------------------------------------------------------------
// What Edit sends, held to what it must be

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isBox = (b: unknown): b is number[] => Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === "number" && Number.isFinite(x));
const isSize = (s: unknown): s is [number, number] => Array.isArray(s) && s.length === 2 && num(s[0], 16, 8192) && num(s[1], 16, 8192);
const boxes = (v: unknown, most = 64): v is number[][] => Array.isArray(v) && v.length <= most && v.every(isBox);

interface Beneath {
  key: string;
  from: number;
  box: number[];
}

/** A job's request as Edit sends it, held to what its kind needs (null: not one). */
export function readRequest(kind: Kind, value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!validKey(r.input)) return null;
  if (kind === "clean") {
    if (!num(r.from, 0, 1e6) || !num(r.fps, 1, 240) || !num(r.width, 16, 8192) || !num(r.height, 16, 8192)) return null;
    if (r.matrix !== "bt709" && r.matrix !== "bt601") return null;
    if (!Array.isArray(r.masks) || r.masks.length === 0 || r.masks.length > MAX_FRAMES || !r.masks.every((frame) => boxes(frame))) return null;
    const beneath = Array.isArray(r.beneath) ? r.beneath : [];
    if (beneath.length > 16 || !beneath.every((one) => typeof one === "object" && one !== null && validKey((one as Beneath).key) && num((one as Beneath).from, 0, 1e6) && isBox((one as Beneath).box))) return null;
    return { input: r.input, beneath, from: r.from, fps: r.fps, width: r.width, height: r.height, matrix: r.matrix, masks: r.masks };
  }
  if (kind === "learn") {
    if (!isSize(r.size) || !num(r.duration, 0, 1e6) || !(r.hint === null || r.hint === undefined || isBox(r.hint)) || !boxes(r.avoid ?? [])) return null;
    return { input: r.input, size: r.size, duration: r.duration, hint: r.hint ?? null, avoid: r.avoid ?? [] };
  }
  if (kind === "watermark") {
    if (!isSize(r.size) || !num(r.fps, 1, 240) || !num(r.from, 0, 1e6) || !num(r.to, 0, 1e6) || !(r.to > r.from) || !boxes(r.keep ?? [])) return null;
    if (!validKey(r.model) || !(r.model as string).startsWith(MODEL_PREFIX)) return null;
    return { input: r.input, size: r.size, fps: r.fps, from: r.from, to: r.to, model: r.model, keep: r.keep ?? [] };
  }
  if (kind === "find") {
    if (!Array.isArray(r.spans) || r.spans.length === 0 || r.spans.length > 2000) return null;
    if (!r.spans.every((span) => Array.isArray(span) && span.length === 2 && num(span[0], 0, 1e6) && num(span[1], 0, 1e6) && (span[1] as number) >= (span[0] as number))) return null;
    const parent = r.parent === undefined || r.parent === null ? null : validKey(r.parent) && String(r.parent).startsWith(FINDER_PREFIX) ? String(r.parent) : undefined;
    if (parent === undefined) return null;
    return { input: r.input, spans: r.spans, ...(parent === null ? {} : { parent }) };
  }
  // track
  const plan = r.plan as Record<string, unknown> | undefined;
  if (!isSize(r.size) || !num(r.fps, 1, 240) || !num(r.from, 0, 1e6) || !num(r.to, 0, 1e6) || !(r.to > r.from) || !isBox(r.region)) return null;
  if (plan === undefined || plan === null || !(plan.band === null || isBox(plan.band)) || !boxes(plan.labels) || !boxes(plan.avoid) || typeof plan.subtitles !== "boolean" || typeof plan.text !== "boolean") return null;
  return { input: r.input, size: r.size, fps: r.fps, region: r.region, from: r.from, to: r.to, plan: { band: plan.band, labels: plan.labels, avoid: plan.avoid, subtitles: plan.subtitles, text: plan.text } };
}

const queueOf = (env: RemoverEnv): Stub => env.REMOVER_PODS!.get(env.REMOVER_PODS!.idFromName("remover"));
const ask = (stub: Stub, path: string, body: unknown) => stub.fetch(new Request(`https://remover${path}`, { method: "POST", body: JSON.stringify(body) }));

export async function removerJobs(request: Request, url: URL, env: RemoverEnv): Promise<Response> {
  // The machines' own routes: their token is checked by the queue.
  if (url.pathname.startsWith("/v1/remover/pod/") && request.method === "POST") {
    if (!removerOn(env)) return json(503, { error: "Removal on RunPod isn't on for this relay." });
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
  // Someone whose work is editing (or an admin): the machines are paid by the minute. A channel given is editing work
  // (Sphe, Nov 21: "a channel I've given a person access to should be all they need"), and removal runs on channels' edits.
  if (found.kind === "person" && !found.admin && !found.perms.some((perm) => perm.startsWith("edit.") || perm.startsWith("channel."))) {
    return json(403, { error: "Your account can't clean footage: an admin can give you an editing permission at accounts.spheceo.com." });
  }
  if (!removerOn(env)) return json(503, { error: "Removal on RunPod isn't on for this relay.", remover: false });
  const queue = queueOf(env);

  if (url.pathname === "/v1/remover/jobs" && request.method === "POST") {
    let body: { kind?: unknown; worker?: unknown; request?: unknown; backlog?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "Send JSON: {kind, request, worker?}." });
    }
    // Builds before kinds sent a clean alone.
    const kind = (body.kind ?? "clean") as Kind;
    if (!["clean", "learn", "watermark", "track", "find"].includes(kind)) return json(400, { error: "kind is clean, learn, watermark, track or find." });
    if ((kind === "clean" || kind === "find") && (typeof body.worker !== "string" || body.worker.length === 0 || body.worker.length > MAX_WORKER)) return json(400, { error: "worker must be the worker's code." });
    const job = readRequest(kind, body.request);
    if (job === null) return json(400, { error: `request isn't a ${kind} job.` });
    if (env.CLOUD_BURST !== undefined && !(await env.CLOUD_BURST.limit({ key: `remover:${burstKey(request, found)}` })).success) return json(429, { error: "Too many jobs at once; try again in a minute." });
    const id = crypto.randomUUID();
    const out = `${OUT_PREFIX}${id}.${kind === "learn" || kind === "track" || kind === "find" ? "json" : "mp4"}`;
    const backlog = typeof body.backlog === "number" && Number.isFinite(body.backlog) ? Math.min(Math.max(0, body.backlog), 86_400) : 0;
    const answer = await ask(queue, "/enqueue", { id, kind, out, worker: kind === "clean" || kind === "find" ? body.worker : undefined, request: job, relay: url.origin, backlog });
    if (!answer.ok) return answer;
    // The same job already queued or under way (Edit restarted mid-job and sent it again): that one, not a twin.
    const twin = (await answer.json()) as { id?: string; out?: string };
    if (typeof twin.id === "string" && typeof twin.out === "string") return json(202, { id: twin.id, out: twin.out });
    console.log(JSON.stringify({ route: "remover/jobs", queued: id, kind, input: job.input }));
    return json(202, { id, out });
  }

  const match = /^\/v1\/remover\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (match !== null && request.method === "GET") return ask(queue, "/status", { id: match[1] });
  if (match !== null && request.method === "DELETE") return ask(queue, "/cancel", { id: match[1] });
  return json(404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// The queue and the machines

interface Job {
  id: string;
  kind: Kind;
  out: string;
  worker?: string;
  request: Record<string, unknown>;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  tries: number;
  pod?: string;
  startedAt?: number;
  output?: Record<string, unknown>;
  at: number;
  /** Its request's hash: the same job sent again is this one while it's queued or under way. */
  twin?: string;
}

interface Pod {
  pool: Pool;
  token: string;
  machine: string;
  cloud: string;
  rentedAt: number;
  seenAt: number | null;
  jobs: string[];
}

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  /** Up to 128 keys at once (Durable Objects' own limit). */
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** The jobs waiting, being done and done, and the machines rented for them (one queue for every Edit). */
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
    const pods = (await this.storage().get<Record<string, Pod>>("pods")) ?? {};
    // Pods rented before pools: the GPU's, one job at a time.
    for (const pod of Object.values(pods)) {
      pod.pool ??= "gpu";
      pod.jobs ??= (pod as unknown as { job?: string }).job === undefined ? [] : [(pod as unknown as { job: string }).job];
    }
    return pods;
  }

  private async order(pool: Pool): Promise<string[]> {
    // The GPU's queue was "order" before pools.
    return (await this.storage().get<string[]>(`order:${pool}`)) ?? (pool === "gpu" ? ((await this.storage().get<string[]>("order")) ?? []) : []);
  }

  /** GPU seconds the waiting cleans come to (their frames, and what Edit said it holds back, at ~5 s a footage second). */
  private async gpuWork(): Promise<number> {
    const ids = await this.order("gpu");
    const held = await this.storage().get<{ seconds: number; at: number }>("backlog:gpu");
    let seconds = held !== undefined && Date.now() - held.at < 5 * 60_000 ? held.seconds * GPU_S_A_FOOTAGE_S : 0;
    for (let at = 0; at < ids.length; at += 128) {
      const jobs = await this.storage().get<Job>(ids.slice(at, at + 128).map((id) => `j:${id}`));
      for (const job of jobs.values()) {
        if (job.kind === "find") {
          const spans = Array.isArray(job.request.spans) ? (job.request.spans as [number, number][]) : [];
          const shown = spans.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
          seconds += shown * FIND_S_A_FOOTAGE_S + FIND_OVERHEAD_S;
        } else {
          const frames = Array.isArray(job.request.masks) ? job.request.masks.length : 0;
          const fps = typeof job.request.fps === "number" && job.request.fps > 0 ? job.request.fps : 30;
          seconds += (frames / fps) * GPU_S_A_FOOTAGE_S;
        }
      }
    }
    return seconds;
  }

  private async setOrder(pool: Pool, order: string[]): Promise<void> {
    await this.storage().put(`order:${pool}`, order);
    if (pool === "gpu") await this.storage().delete("order");
  }

  private async enqueue(body: Record<string, unknown>): Promise<Response> {
    const kind = body.kind as Kind;
    // What Edit still holds back for the GPU (it sends a few at a time): what more GPUs are rented by.
    if (kind === "clean") await this.storage().put("backlog:gpu", { seconds: typeof body.backlog === "number" ? body.backlog : 0, at: Date.now() });
    // A job the same as one queued or under way is that one (Nov 20: a restarted Edit sent SMART Cops' ten running
    // cleans again, and the GPU did each twice, the first for nobody).
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([kind, body.worker ?? null, body.request])));
    const twin = [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const earlier = await this.storage().get<string>(`twin:${twin}`);
    const before = earlier === undefined ? undefined : await this.storage().get<Job>(`j:${earlier}`);
    if (before !== undefined && (before.state === "queued" || before.state === "running")) return json(200, { ok: true, id: before.id, out: before.out });
    const job: Job = { id: String(body.id), kind, out: String(body.out), ...(typeof body.worker === "string" ? { worker: body.worker } : {}), request: body.request as Record<string, unknown>, state: "queued", tries: 0, at: Date.now(), twin };
    await this.storage().put(`j:${job.id}`, job);
    await this.storage().put(`twin:${twin}`, job.id);
    await this.setOrder(poolOf(kind), [...(await this.order(poolOf(kind))), job.id]);
    if (typeof body.relay === "string") await this.storage().put("relay", body.relay);
    await this.tend();
    return json(200, { ok: true });
  }

  private async status(id: string): Promise<Response> {
    const job = await this.storage().get<Job>(`j:${id}`);
    if (job === undefined) return json(404, { error: "no such job" });
    if (job.state === "done") return json(200, job.output ?? { ok: true });
    if (job.state === "failed") return json(502, { error: `the rented machine couldn't do it: ${String(job.output?.error ?? "it stopped twice")}` });
    if (job.state === "cancelled") return json(502, { error: "stopped" });
    return json(202, { pending: true, status: job.state });
  }

  private async cancel(id: string): Promise<Response> {
    const job = await this.storage().get<Job>(`j:${id}`);
    if (job !== undefined && (job.state === "queued" || job.state === "running")) {
      job.state = "cancelled";
      await this.storage().put(`j:${id}`, job);
      const pool = poolOf(job.kind ?? "clean");
      await this.setOrder(pool, (await this.order(pool)).filter((one) => one !== id));
    }
    return json(200, { ok: true });
  }

  private async fromPod(what: string, body: Record<string, unknown>): Promise<Response> {
    const pods = await this.pods();
    const id = String(body.pod ?? "");
    const pod = pods[id];
    if (pod === undefined || pod.token !== body.token) return json(403, { error: "not one of ours" });
    pod.seenAt = Date.now();
    await this.storage().put(`bootFailures:${pod.pool}`, 0);
    if (what === "bye") {
      // Jobs still out on it (a lane gone ahead of another) go back to the queue.
      for (const one of pod.jobs) {
        const job = await this.storage().get<Job>(`j:${one}`);
        if (job !== undefined && job.state === "running" && job.pod === id) {
          await this.requeue(job);
          await this.storage().put(`j:${job.id}`, job);
        }
      }
      delete pods[id];
      await this.storage().put("pods", pods);
      await this.letGo(id);
      return json(200, { ok: true });
    }
    if (what === "done") {
      const job = await this.storage().get<Job>(`j:${String(body.id)}`);
      if (job !== undefined && job.state === "running" && job.pod === id) {
        const output = (body.output ?? {}) as Record<string, unknown>;
        if (output.ok === true || job.kind === "learn") Object.assign(job, { state: "done", output, at: Date.now() });
        else if (job.tries + 1 < TRIES) {
          job.tries += 1;
          await this.requeue(job);
        } else Object.assign(job, { state: "failed", output, at: Date.now(), tries: job.tries + 1 });
        await this.storage().put(`j:${job.id}`, job);
      }
      pod.jobs = pod.jobs.filter((one) => one !== String(body.id));
      await this.storage().put("pods", pods);
      return json(200, { ok: true });
    }
    // next: the next job waiting for its kind of machine.
    const order = await this.order(pod.pool);
    let job: Job | undefined;
    while (order.length > 0 && job === undefined) {
      const next = await this.storage().get<Job>(`j:${order.shift()!}`);
      if (next !== undefined && next.state === "queued") job = next;
    }
    await this.setOrder(pod.pool, order);
    if (job !== undefined) {
      Object.assign(job, { state: "running", pod: id, startedAt: Date.now() });
      await this.storage().put(`j:${job.id}`, job);
      pod.jobs = [...pod.jobs, job.id];
    }
    await this.storage().put("pods", pods);
    if (job === undefined) return json(200, { job: null });
    return json(200, { job: await this.payload(job) });
  }

  /** What a machine needs for a job: fresh signed URLs for what it reads and where it writes, and the job itself. */
  private async payload(job: Job): Promise<Record<string, unknown>> {
    const r2 = r2Config(this.env)!;
    const get = (key: string) => objectUrl(r2, "GET", key, {}, URL_SECONDS);
    const r = job.request;
    const base = { id: job.id, kind: job.kind ?? "clean", input_url: await get(String(r.input)), output_url: await objectUrl(r2, "PUT", job.out, {}, URL_SECONDS) };
    if ((job.kind ?? "clean") === "clean") {
      const beneath = await Promise.all(((r.beneath as Beneath[] | undefined) ?? []).map(async (one) => ({ file: await get(one.key), from: one.from, box: one.box })));
      return { ...base, worker: job.worker, beneath, from: r.from, fps: r.fps, width: r.width, height: r.height, matrix: r.matrix, masks: r.masks };
    }
    if (job.kind === "find") {
      const parentUrl = typeof r.parent === "string" ? await get(r.parent) : null;
      return { ...base, worker: job.worker, spans: r.spans, ...(parentUrl === null ? {} : { parent_url: parentUrl }) };
    }
    if (job.kind === "watermark") return { ...base, size: r.size, fps: r.fps, from: r.from, to: r.to, keep: r.keep, model_url: await get(String(r.model)) };
    if (job.kind === "learn") return { ...base, size: r.size, duration: r.duration, hint: r.hint, avoid: r.avoid };
    return { ...base, size: r.size, fps: r.fps, region: r.region, plan: r.plan, from: r.from, to: r.to };
  }

  private async requeue(job: Job): Promise<void> {
    Object.assign(job, { state: "queued", pod: undefined, startedAt: undefined });
    const pool = poolOf(job.kind ?? "clean");
    await this.setOrder(pool, [job.id, ...(await this.order(pool))]);
  }

  /**
   * The machines brought in line with the work, run on every change and every 30 s while anything is out: quiet or
   * unbooted machines let go (their jobs handed on), machines rented while jobs wait, old jobs forgotten.
   */
  private async tend(): Promise<void> {
    const now = Date.now();
    const pods = await this.pods();
    // Machines RunPod no longer has (stopped from its console, or gone with their host) are forgotten at once, their
    // jobs handed on: kept, their free lanes held renting back (Nov 20: a machine deleted by hand stopped all renting).
    const there = await this.rented();
    if (there !== null) {
      for (const [id, pod] of Object.entries(pods)) {
        // One rented a moment ago may not be listed yet: never forgotten then (it would run on unseen).
        if (there.has(id) || now - pod.rentedAt < 2 * 60_000) continue;
        for (const one of pod.jobs) {
          const job = await this.storage().get<Job>(`j:${one}`);
          if (job === undefined || job.state !== "running" || job.pod !== id) continue;
          await this.requeue(job);
          await this.storage().put(`j:${job.id}`, job);
        }
        delete pods[id];
        console.log(JSON.stringify({ route: "remover/tend", forgot: id }));
      }
    }
    let busy = false;
    for (const pool of ["gpu", "cpu"] as Pool[]) {
      let bootFailures = (await this.storage().get<number>(`bootFailures:${pool}`)) ?? 0;
      for (const [id, pod] of Object.entries(pods)) {
        if (pod.pool !== pool) continue;
        const gone = pod.seenAt === null ? now - pod.rentedAt > BOOT_MS : now - pod.seenAt > (pod.jobs.length === 0 ? QUIET_MS : RUNNING_MS);
        if (!gone) continue;
        if (pod.seenAt === null) bootFailures += 1;
        for (const one of pod.jobs) {
          const job = await this.storage().get<Job>(`j:${one}`);
          if (job === undefined || job.state !== "running" || job.pod !== id) continue;
          job.tries += 1;
          if (job.tries < TRIES) await this.requeue(job);
          else Object.assign(job, { state: "failed", output: { ok: false, error: "the rented machine went quiet" }, at: now });
          await this.storage().put(`j:${job.id}`, job);
        }
        delete pods[id];
        await this.letGo(id);
      }
      await this.storage().put(`bootFailures:${pool}`, bootFailures);
      if (bootFailures >= BOOT_FAILURES) {
        // Machines aren't starting: what waits fails now (Edit leaves it as it was) rather than renting more.
        for (const id of await this.order(pool)) {
          const job = await this.storage().get<Job>(`j:${id}`);
          if (job !== undefined && job.state === "queued") await this.storage().put(`j:${id}`, { ...job, state: "failed", output: { ok: false, error: `${BOOT_FAILURES} rented machines in a row never started` }, at: now });
        }
        await this.setOrder(pool, []);
        await this.storage().put(`bootFailures:${pool}`, 0);
        console.log(JSON.stringify({ route: "remover/tend", pool, stopped: "machines aren't starting" }));
      }
      const waiting = (await this.order(pool)).length;
      const mine = Object.values(pods).filter((pod) => pod.pool === pool);
      // A GPU does one job at a time; a CPU machine CPU_LANES.
      const lanes = pool === "gpu" ? 1 : CPU_LANES;
      const free = mine.reduce((sum, pod) => sum + Math.max(0, lanes - pod.jobs.length), 0);
      const needed =
        pool === "gpu"
          ? waiting > free
            ? Math.max(1, Math.ceil((await this.gpuWork()) / GPU_WORK_EACH_S)) - mine.length
            : 0
          : Math.ceil(Math.max(0, waiting - free) / lanes);
      const want = Math.min(MAX_PODS[pool] - mine.length, needed);
      for (let n = 0; n < want; n++) {
        const rented = await this.rent(pool);
        if (rented === null) break;
        pods[rented.id] = rented.pod;
      }
      if (mine.length > 0 || waiting > 0 || want > 0) busy = true;
    }
    await this.storage().put("pods", pods);
    // Jobs a day old are forgotten (Edit has long taken what they made).
    const jobs = await this.storage().list<Job>({ prefix: "j:" });
    for (const [key, job] of jobs) {
      if (!((job.state === "done" || job.state === "failed" || job.state === "cancelled") && now - job.at > 86400_000)) continue;
      await this.storage().delete(key);
      if (job.twin !== undefined) await this.storage().delete(`twin:${job.twin}`);
    }
    if (busy || Object.keys(pods).length > 0) await this.storage().setAlarm(now + 30_000);
    else await this.storage().deleteAlarm();
  }

  /** A machine rented for `pool` on the first kind RunPod has (cheapest first), null when none is to be had now. */
  private async rent(pool: Pool): Promise<{ id: string; pod: Pod } | null> {
    const relay = (await this.storage().get<string>("relay")) ?? "";
    const token = crypto.randomUUID();
    const r2 = r2Config(this.env)!;
    const tries: { machine: string; cloud: string; body: Record<string, unknown> }[] =
      pool === "gpu"
        ? GPUS.map((gpu) => ({
            machine: gpu.id,
            cloud: gpu.cloud,
            body: {
              cloud: gpu.cloud,
              gpu: { id: gpu.id, count: 1, minCudaVersion: "12.8" },
              image: GPU_IMAGE,
              cmd: ['mkdir -p /tmp/remover && echo "$BOOTSTRAP_B64" | base64 -d > /tmp/remover/bootstrap.sh && echo "$POD_B64" | base64 -d > /tmp/remover/pod.py && exec bash /tmp/remover/bootstrap.sh'],
              disk: 40,
              env: { BOOTSTRAP_B64, POD_B64, REMOVER_RELAY: relay, REMOVER_TOKEN: token },
            },
          }))
        : await Promise.all(
            CPUS.map(async (id) => ({
              machine: id,
              cloud: "SECURE",
              body: {
                cloud: "SECURE",
                cpu: { id, vcpuCount: 32 },
                image: CPU_IMAGE,
                cmd: ['mkdir -p /tmp/remover && echo "$CPU_BOOT_B64" | base64 -d > /tmp/remover/bootstrap_cpu.sh && echo "$CPU_B64" | base64 -d > /tmp/remover/cpu.js && exec bash /tmp/remover/bootstrap_cpu.sh'],
                disk: 20,
                env: {
                  CPU_BOOT_B64,
                  CPU_B64,
                  REMOVER_RELAY: relay,
                  REMOVER_TOKEN: token,
                  ADDON_URL: await objectUrl(r2, "GET", `${RUNTIME}/edit-native.node.gz`, {}, URL_SECONDS),
                  FFMPEG_URL: await objectUrl(r2, "GET", `${RUNTIME}/edit-ffmpeg.gz`, {}, URL_SECONDS),
                  FFPROBE_URL: await objectUrl(r2, "GET", `${RUNTIME}/edit-ffprobe.gz`, {}, URL_SECONDS),
                },
              },
            })),
          );
    for (const one of tries) {
      const answer = await fetch(`${RUNPOD}/pods`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.RUNPOD_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ name: `edit-remover-${pool}-${token.slice(0, 8)}`, entrypoint: ["/bin/bash", "-c"], ...one.body }),
      });
      const text = await answer.text();
      if (!answer.ok) {
        console.log(JSON.stringify({ route: "remover/rent", pool, machine: one.machine, cloud: one.cloud, refused: answer.status, why: text.slice(0, 200) }));
        continue;
      }
      const id = (JSON.parse(text) as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      console.log(JSON.stringify({ route: "remover/rent", pool, pod: id, machine: one.machine, cloud: one.cloud }));
      return { id, pod: { pool, token, machine: one.machine, cloud: one.cloud, rentedAt: Date.now(), seenAt: null, jobs: [] } };
    }
    return null;
  }

  /** The ids of the machines RunPod has for us now (null: it couldn't say). */
  private async rented(): Promise<Set<string> | null> {
    const answer = await fetch(`${RUNPOD}/pods`, { headers: { authorization: `Bearer ${this.env.RUNPOD_API_KEY}` } }).catch(() => null);
    if (answer === null || !answer.ok) return null;
    const listed = (await answer.json().catch(() => null)) as { pods?: { id?: unknown; name?: unknown }[] } | null;
    if (listed?.pods === undefined) return null;
    return new Set(listed.pods.filter((one) => String(one.name).startsWith("edit-remover-")).map((one) => String(one.id)));
  }

  private async letGo(id: string): Promise<void> {
    const answer = await fetch(`${RUNPOD}/pods/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${this.env.RUNPOD_API_KEY}` } }).catch(() => null);
    console.log(JSON.stringify({ route: "remover/letgo", pod: id, status: answer?.status ?? "unreachable" }));
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
