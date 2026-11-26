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
 *   POST   /v1/remover/jobs        {kind, request, worker?} → 202 {id, out, sub}: `out` is where its result lands on R2,
 *          `sub` this caller's hold on it (the same job sent twice is one job, held twice)
 *          clean:     {input, beneath: [{key, from, box}], from, fps, width, height, matrix, masks}, worker (minimax_worker.py)
 *          learn:     {input, size, duration, hint, avoid}            → the mark's model (JSON) at `out`
 *          watermark: {input, size, fps, from, to, model, keep}       → the strip at `out`, `removed` in the answer
 *          track:     {input, size, fps, region, plan, from, to}      → the reads (JSON) at `out`
 *   GET    /v1/remover/jobs/<id>   → 200 {ok, …} | 202 {pending: true} | 502 {error}
 *   DELETE /v1/remover/jobs/<id>[?sub=<sub>]   → 200 {ok}: the person's Stop (with `sub`, that hold let go at most once)
 *   POST   /v1/remover/pod/next|done|bye   the machines' own (their token, given when rented)
 *
 * The flag is `REMOVER` ("pods" on, anything else off, wrangler.toml's vars): /health says `remover: true` only when
 * it's on and the key, the queue and R2 are here.
 */
import { allow, burstKey, type AuthEnv } from "./auth";
import { Forbidden, mayRead, objectUrl, r2Config, r2Fetch, Upstream, validKey, type CloudEnv } from "./cloud";
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
/** What the finder reads: footage (an original, a slowed copy's own original too), never a project's other files. */
const FOOTAGE_PREFIX = "edit/originals/";
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
/**
 * How long a pool may have no machine at all while RunPod refuses every kind asked for (no money left on the account,
 * none of the cards offered): then what waits fails with RunPod's own words, and Edit leaves it as it was and says why
 * (Nov 24, the M1 Air's first run: the account was at -$0.07, every rent was refused, and the finder's jobs sat queued
 * with Edit at "0 of 36 pieces" and nothing said, for what would have been three hours a job). A pool with a machine
 * still working is never failed this way: its queue is only waiting its turn.
 */
export const RENT_REFUSED_MS = 10 * 60_000;
/**
 * How long a result two callers share stays on R2 after it's done: their whole wait (remover_cloud.ts, 3 hours from
 * when each sent it, which is before it was done), so one coming back late still finds it (Nov 24: it was ten minutes,
 * then the relay said "ready" for a result it had deleted).
 */
export const SHARED_OUT_MS = 3 * 3600_000;
/** An R2 delete given this long before it's tried again on a later alarm. */
const R2_DELETE_MS = 10_000;
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
    if (!(r.input as string).startsWith(FOOTAGE_PREFIX)) return null;
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
    // Every key a machine is given a signed URL for, held to the cloud's own read rules (Nov 24: an editor could have
    // a project's export read by the finder by its key alone). Footage and Edit's own work keys pass as they did.
    const keys = new Set([job.input, job.parent, job.model, ...((job.beneath as Beneath[] | undefined) ?? []).map((one) => one.key)].filter((key): key is string => typeof key === "string"));
    try {
      await Promise.all([...keys].map((key) => mayRead(found, env, key)));
    } catch (error) {
      if (error instanceof Forbidden) return json(403, { error: error.message });
      if (error instanceof Upstream) return json(502, { error: error.message });
      throw error;
    }
    if (env.CLOUD_BURST !== undefined && !(await env.CLOUD_BURST.limit({ key: `remover:${burstKey(request, found)}` })).success) return json(429, { error: "Too many jobs at once; try again in a minute." });
    const id = crypto.randomUUID();
    const out = `${OUT_PREFIX}${id}.${kind === "learn" || kind === "track" || kind === "find" ? "json" : "mp4"}`;
    const backlog = typeof body.backlog === "number" && Number.isFinite(body.backlog) ? Math.min(Math.max(0, body.backlog), 86_400) : 0;
    const sub = crypto.randomUUID();
    const answer = await ask(queue, "/enqueue", { id, kind, out, sub, worker: kind === "clean" || kind === "find" ? body.worker : undefined, request: job, relay: url.origin, backlog });
    if (!answer.ok) return answer;
    // The same job already queued or under way (Edit restarted mid-job and sent it again): that one, not a twin.
    const twin = (await answer.json()) as { id?: string; out?: string };
    if (typeof twin.id === "string" && typeof twin.out === "string") return json(202, { id: twin.id, out: twin.out, sub });
    console.log(JSON.stringify({ route: "remover/jobs", queued: id, kind, input: job.input }));
    return json(202, { id, out, sub });
  }

  const match = /^\/v1\/remover\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (match !== null && request.method === "GET") return ask(queue, "/status", { id: match[1] });
  if (match !== null && request.method === "DELETE") return ask(queue, "/cancel", { id: match[1], sub: url.searchParams.get("sub") });
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
  /** Active callers waiting on this job (incremented on twin dedup, decremented on cancel). */
  subs?: number;
  /** The holds still on it (`sub`, one a caller): a Stop sent twice by the same caller lets go of its own hold once
   * (Nov 24: a repeated DELETE took a second caller's hold and stopped its work). Older callers send no `sub`. */
  holds?: string[];
  /** True once more than one caller attached via twin dedup: clients leave `out` on R2 and tend() cleans it later. */
  shared?: boolean;
  /** True once a shared job's `out` object has been deleted from R2 (alarm()). */
  outCleaned?: boolean;
}

interface Pod {
  pool: Pool;
  token: string;
  machine: string;
  cloud: string;
  rentedAt: number;
  seenAt: number | null;
  jobs: string[];
  /** True on GPU pods booted with the pod.py that handles kind "find" (older pods only understand "clean"); a pod
   * whose OCR didn't load says so on its first ask (`find: false`) and is given cleans alone. */
  canFind?: boolean;
  /** Whether it has said, on an ask, if it can find. */
  saidFind?: boolean;
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
      if (path === "/cancel") return this.cancel(String(body.id), typeof body.sub === "string" ? body.sub : null);
      if (path.startsWith("/pod/")) return this.fromPod(path.slice(5), body);
      return json(404, { error: "not found" });
    });
  }

  async alarm(): Promise<void> {
    const due = await this.state.blockConcurrencyWhile(() => this.tend());
    const r2 = r2Config(this.env);
    if (due.length === 0 || r2 === null) return;
    // Shared results' deletes run outside the queue's block, each given R2_DELETE_MS, so a slow R2 never holds the
    // pods' and Edit's calls nor outlasts the block (Cloudflare resets an object whose block takes 30 s). One that
    // fails or runs out of time stays due: tend() has set the next alarm for it.
    const deleted = await Promise.all(
      due.map(async (one) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = r2Fetch(r2, "DELETE", one.out, {}, { allow404: true }).then(() => true, () => false);
        const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), R2_DELETE_MS)));
        const ok = await Promise.race([done, late]);
        clearTimeout(timer);
        return ok ? one : null;
      }),
    );
    const gone = deleted.filter((one) => one !== null);
    if (gone.length === 0) return;
    await this.state.blockConcurrencyWhile(async () => {
      for (const one of gone) {
        const job = await this.storage().get<Job>(one.key);
        if (job === undefined || job.out !== one.out || job.outCleaned === true) continue;
        job.outCleaned = true;
        await this.storage().put(one.key, job);
      }
      // What's done with forgotten now, and the next alarm set for what's left.
      await this.tend();
    });
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

  /** GPU seconds waiting in the queue (total across cleans + backlog + finds, plus find-only work and count). */
  private async gpuWork(): Promise<{ total: number; find: number; waitingFind: number }> {
    const ids = await this.order("gpu");
    const held = await this.storage().get<{ seconds: number; at: number }>("backlog:gpu");
    let clean = held !== undefined && Date.now() - held.at < 5 * 60_000 ? held.seconds * GPU_S_A_FOOTAGE_S : 0;
    let find = 0;
    let waitingFind = 0;
    for (let at = 0; at < ids.length; at += 128) {
      const jobs = await this.storage().get<Job>(ids.slice(at, at + 128).map((id) => `j:${id}`));
      for (const job of jobs.values()) {
        if (job.state !== "queued") continue;
        if (job.kind === "find") {
          const spans = Array.isArray(job.request.spans) ? (job.request.spans as [number, number][]) : [];
          const shown = spans.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
          find += shown * FIND_S_A_FOOTAGE_S + FIND_OVERHEAD_S;
          waitingFind += 1;
        } else {
          const frames = Array.isArray(job.request.masks) ? job.request.masks.length : 0;
          const fps = typeof job.request.fps === "number" && job.request.fps > 0 ? job.request.fps : 30;
          clean += (frames / fps) * GPU_S_A_FOOTAGE_S;
        }
      }
    }
    return { total: clean + find, find, waitingFind };
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
    const sub = typeof body.sub === "string" ? body.sub : null;
    if (before !== undefined && (before.state === "queued" || before.state === "running")) {
      before.subs = (before.subs ?? 1) + 1;
      if (sub !== null) before.holds = [...(before.holds ?? []), sub];
      before.shared = true;
      await this.storage().put(`j:${before.id}`, before);
      return json(200, { ok: true, id: before.id, out: before.out });
    }
    const job: Job = { id: String(body.id), kind, out: String(body.out), ...(typeof body.worker === "string" ? { worker: body.worker } : {}), request: body.request as Record<string, unknown>, state: "queued", tries: 0, at: Date.now(), twin, subs: 1, ...(sub === null ? {} : { holds: [sub] }) };
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
    // A shared result deleted already (past SHARED_OUT_MS): never "ready", which would send a caller to read nothing.
    if (job.state === "done" && job.outCleaned === true) return json(410, { error: "its result was cleaned up before it was read: send the job again" });
    if (job.state === "done") return json(200, { ...(job.output ?? { ok: true }), ...(job.shared ? { shared: true } : {}) });
    // Refused renting: no machine had it, RunPod's words say why.
    // Refused renting is flagged, so Edit knows no wait helps (an export goes on without the piece) without reading the words.
    if (job.state === "failed") return json(502, job.output?.refused === true ? { error: String(job.output.error), refused: true } : { error: `the rented machine couldn't do it: ${String(job.output?.error ?? "it stopped twice")}` });
    if (job.state === "cancelled") return json(502, { error: "stopped" });
    return json(202, { pending: true, status: job.state });
  }

  private async cancel(id: string, sub: string | null): Promise<Response> {
    const job = await this.storage().get<Job>(`j:${id}`);
    if (job !== undefined && (job.state === "queued" || job.state === "running")) {
      if (sub !== null) {
        // That hold let go already (a Stop sent again), or never this job's: nobody else's hold is taken for it.
        if (!(job.holds ?? []).includes(sub)) return json(200, { ok: true });
        job.holds = job.holds!.filter((one) => one !== sub);
      }
      const left = (job.subs ?? 1) - 1;
      job.subs = Math.max(0, left);
      if (left <= 0) {
        job.state = "cancelled";
        const pool = poolOf(job.kind ?? "clean");
        await this.setOrder(pool, (await this.order(pool)).filter((one) => one !== id));
      }
      await this.storage().put(`j:${id}`, job);
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
    // A GPU pod says on its first ask whether its OCR loaded (bootstrap.sh): one that didn't is given cleans alone,
    // and three in a row fail the finds waiting rather than renting card after card for them (Nov 24: an OCR that
    // wouldn't load stopped the pod's setup, and with it every clean).
    if (pod.pool === "gpu" && typeof body.find === "boolean" && pod.saidFind !== true) {
      pod.saidFind = true;
      pod.canFind = body.find;
      let failures = body.find ? 0 : ((await this.storage().get<number>("findFailures")) ?? 0) + 1;
      if (failures >= BOOT_FAILURES) {
        await this.failWaiting("gpu", "find", { ok: false, error: `the finder couldn't start on ${BOOT_FAILURES} rented GPUs in a row (its OCR didn't load)` });
        failures = 0;
      }
      await this.storage().put("findFailures", failures);
    }
    // next: the next job waiting for its kind of machine (pre-find GPU pods only take "clean" jobs).
    const order = await this.order(pod.pool);
    const keep: string[] = [];
    let job: Job | undefined;
    while (order.length > 0 && job === undefined) {
      const nextId = order.shift()!;
      const next = await this.storage().get<Job>(`j:${nextId}`);
      if (next === undefined || next.state !== "queued") continue;
      if (pod.pool === "gpu" && next.kind === "find" && pod.canFind !== true) {
        keep.push(nextId);
        continue;
      }
      job = next;
    }
    await this.setOrder(pod.pool, [...keep, ...order]);
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
  private async tend(): Promise<{ key: string; out: string }[]> {
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
      const waitingIds = await this.order(pool);
      const waiting = waitingIds.length;
      const mine = Object.values(pods).filter((pod) => pod.pool === pool);
      // A GPU does one job at a time; a CPU machine CPU_LANES.
      const lanes = pool === "gpu" ? 1 : CPU_LANES;
      const free = mine.reduce((sum, pod) => sum + Math.max(0, lanes - pod.jobs.length), 0);
      let needed: number;
      let findsWaiting = 0;
      if (pool === "gpu") {
        // Pre-find GPU pods cannot run "find" jobs: evaluate general GPU demand and find-only demand independently
        // so legacy pods neither block finder rentals nor inflate find-only rentals with clean work.
        const work = await this.gpuWork();
        const canFindPods = mine.filter((pod) => pod.canFind === true);
        const freeCanFind = canFindPods.reduce((sum, pod) => sum + Math.max(0, 1 - pod.jobs.length), 0);
        const generalNeeded = waiting > free ? Math.max(1, Math.ceil(work.total / GPU_WORK_EACH_S)) - mine.length : 0;
        const findNeeded = work.waitingFind > freeCanFind ? Math.max(1, Math.ceil(work.find / GPU_WORK_EACH_S)) - canFindPods.length : 0;
        needed = Math.max(generalNeeded, findNeeded);
        findsWaiting = work.waitingFind;
      } else {
        needed = Math.ceil(Math.max(0, waiting - free) / lanes);
      }
      const want = Math.min(MAX_PODS[pool] - mine.length, Math.max(0, needed));
      let refused: string | null = null;
      for (let n = 0; n < want; n++) {
        const rented = await this.rent(pool);
        if ("refused" in rented) {
          refused = rented.refused;
          break;
        }
        pods[rented.id] = rented.pod;
      }
      const pooled = Object.values(pods).filter((pod) => pod.pool === pool);
      await this.whileRefused(pool, null, refused !== null && waiting > 0 && pooled.length === 0 ? refused : null, now);
      // Finds wait for a pod that can find: one that can't (an older pod, or one whose OCR didn't load) cleaning
      // meanwhile doesn't keep them from failing with RunPod's words (Nov 24).
      if (pool === "gpu") await this.whileRefused(pool, "find", refused !== null && findsWaiting > 0 && pooled.length > 0 && !pooled.some((pod) => pod.canFind === true) ? refused : null, now);
      if (mine.length > 0 || waiting > 0 || want > 0) busy = true;
    }
    await this.storage().put("pods", pods);
    // A result two callers share is left on R2 by both (remover_cloud.ts) and deleted here once their wait is over
    // (alarm(), outside this block); a job is forgotten a day on, once its shared result is gone.
    const due: { key: string; out: string }[] = [];
    let nextCleanupAt: number | null = null;
    const soonest = (at: number) => (nextCleanupAt = nextCleanupAt === null ? at : Math.min(nextCleanupAt, at));
    const r2 = r2Config(this.env);
    const jobs = await this.storage().list<Job>({ prefix: "j:" });
    for (const [key, job] of jobs) {
      const ended = job.state === "done" || job.state === "failed" || job.state === "cancelled";
      if (!ended) continue;
      if (job.shared && !job.outCleaned && r2 !== null) {
        const dueAt = job.at + (job.state === "done" ? SHARED_OUT_MS : 86400_000);
        if (now >= dueAt) {
          due.push({ key, out: job.out });
          // Tried again then if this alarm's delete doesn't get through.
          soonest(now + 30_000);
        } else soonest(dueAt);
        continue;
      }
      if (now - job.at <= 86400_000) continue;
      await this.storage().delete(key);
      if (job.twin !== undefined) await this.storage().delete(`twin:${job.twin}`);
    }
    if (busy || Object.keys(pods).length > 0) await this.storage().setAlarm(now + 30_000);
    else if (nextCleanupAt !== null) await this.storage().setAlarm(Math.max(now + 1_000, nextCleanupAt));
    else await this.storage().deleteAlarm();
    return due;
  }

  /**
   * `refused` (RunPod's last words) while the pool has no machine (or, `only` "find", none that can find) and none can
   * be rented; once that has lasted RENT_REFUSED_MS, what waits in the pool (of that kind) fails with those words.
   * Null (a machine rented, or one there): forgotten.
   */
  private async whileRefused(pool: Pool, only: "find" | null, refused: string | null, now: number): Promise<void> {
    const key = `refusedSince:${pool}${only === null ? "" : `:${only}`}`;
    if (refused === null) {
      await this.storage().delete(key);
      return;
    }
    const since = (await this.storage().get<number>(key)) ?? now;
    await this.storage().put(key, since);
    if (now - since < RENT_REFUSED_MS) return;
    const error = `RunPod wouldn't rent a ${pool === "gpu" ? "GPU" : "CPU machine"} for ${Math.round((now - since) / 60_000)} minutes (${refused})`;
    await this.failWaiting(pool, only, { ok: false, error, refused: true });
    await this.storage().delete(key);
  }

  /** What waits in `pool` (of kind `only`, or all of it) failed with `output`, and taken off the queue. */
  private async failWaiting(pool: Pool, only: Kind | null, output: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const kept: string[] = [];
    for (const id of await this.order(pool)) {
      const job = await this.storage().get<Job>(`j:${id}`);
      if (job === undefined || job.state !== "queued") continue;
      if (only !== null && (job.kind ?? "clean") !== only) {
        kept.push(id);
        continue;
      }
      await this.storage().put(`j:${id}`, { ...job, state: "failed", output, at: now });
    }
    await this.setOrder(pool, kept);
    console.log(JSON.stringify({ route: "remover/tend", pool, ...(only === null ? {} : { only }), stopped: output.error }));
  }

  /** A machine rented for `pool` on the first kind RunPod has (cheapest first), or what RunPod said to the last asked. */
  private async rent(pool: Pool): Promise<{ id: string; pod: Pod } | { refused: string }> {
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
    let refused = "nothing was offered";
    for (const one of tries) {
      const answer = await fetch(`${RUNPOD}/pods`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.RUNPOD_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ name: `edit-remover-${pool}-${token.slice(0, 8)}`, entrypoint: ["/bin/bash", "-c"], ...one.body }),
      });
      const text = await answer.text();
      if (!answer.ok) {
        console.log(JSON.stringify({ route: "remover/rent", pool, machine: one.machine, cloud: one.cloud, refused: answer.status, why: text.slice(0, 200) }));
        refused = `${answer.status}: ${text.replace(/\s+/gu, " ").trim().slice(0, 160)}`;
        continue;
      }
      const id = (JSON.parse(text) as { id?: unknown }).id;
      if (typeof id !== "string") {
        refused = `no machine in its answer: ${text.slice(0, 160)}`;
        continue;
      }
      console.log(JSON.stringify({ route: "remover/rent", pool, pod: id, machine: one.machine, cloud: one.cloud }));
      return { id, pod: { pool, token, machine: one.machine, cloud: one.cloud, rentedAt: Date.now(), seenAt: null, jobs: [], ...(pool === "gpu" ? { canFind: true } : {}) } };
    }
    return { refused };
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
