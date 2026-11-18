// Vmake's developer API (Meitu's "action-api-sdk", v2.0.1), the few HTTP
// calls of its Python SDK done here so Edit needs no Python: the skill's
// config (where the algorithm lives and what a task is called), a token
// policy (temporary OSS credentials for the upload, and the algorithm's
// host), the file PUT to Meitu's OSS bucket (Alibaba's V4 signature), the
// quota taken (`/skill/consume.json`: this is what spends credits), the task
// submitted and polled, the result fetched. Read from the wheel's own code
// (action_api_sdk/client.py, ai/api.py, sign_sdk/sign.py and
// alibabacloud_oss_v2/signer/v4.py), Nov 17.
//
// Every failure says whose it is (`VmakeError.scope`): the account's (keys
// refused, out of credits, a closed account: nothing more is sent until it's
// sorted, subtitle_removal.ts) or this piece's (the network, a timeout, a file
// Vmake couldn't do: tried again, else that piece stays blurred).

import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";

import * as diag from "./diag.ts";

/** The WAPI host and the SDK's own name and version (the server checks it: `need_update`). */
const WAPI = "wapi-skill.vmake.ai";
const VERSION = "v2.0.1";
const USER_AGENT = `action-api-sdk-${VERSION}`;
const REGION = "cn-north-4";
/** Smart Pro, video smart removal: 4 credits a second, ≤600 s, ≤300 MB a file. */
export const SMART_PRO = "SKM0005";
/** How long a task may take once submitted (15 s of footage took 187 s, Nov 17; a 5-minute piece is far longer). */
const TASK_MS = 3 * 3_600_000;
const CALL_MS = 30_000;

export interface Keys {
  ak: string;
  sk: string;
}

/** Why the account can't be used: each one says so plainly (subtitle_removal.ts). */
export type AccountReason = "closed" | "signed_out" | "lapsed" | "out_of_credits" | "daily_limit" | "keys_refused" | "refused" | "browser_credits" | "browser_key";

/** A failure of Vmake's: the account's (stop sending) or this piece's (try again, else blur). */
export class VmakeError extends Error {
  constructor(
    message: string,
    readonly scope: "account" | "piece",
    readonly reason: AccountReason | null = null,
  ) {
    super(message);
  }
}

/**
 * Whose a refusal is, from what Vmake said: the account's when it names the
 * keys, the account, the plan, the credits or a day's allowance. `quota`: it
 * came from taking the quota (`consume`), where every refusal is the
 * account's (the SDK's ConsumeDeniedError: quota or permission).
 */
export function classify(message: string, quota: boolean, status: number | null = null): VmakeError {
  const said = message.toLowerCase();
  const account = (reason: AccountReason) => new VmakeError(message, "account", reason);
  if (/\b(ban(ned)?|suspend(ed)?|closed|disabled|frozen|blocked|deactivat|terminated)\b|封禁|冻结|禁用|注销/u.test(said)) return account("closed");
  if (/\b(daily|per day|today|24 ?h)\b|今日|每日|当天/u.test(said)) return account("daily_limit");
  if (/\b(insufficient|not enough|balance|credits?|points?|quota|exhausted|run out|余额|额度|点数|不足)\b/u.test(said)) return account("out_of_credits");
  if (/\b(sign(ed)? ?out|log ?in again|session (expired|ended)|not logged( in)?|please (log|sign) ?in)\b/u.test(said)) return account("signed_out");
  if (/\b(subscription|plan|membership|vip|expired|lapsed|renew)\b|会员|过期|到期/u.test(said)) return account("lapsed");
  if (status === 401 || status === 403 || /\b(signature|access ?key|secret|unauthori[sz]ed|forbidden|invalid (ak|sk|key)|auth(entication|orization)? failed|appkey|ak\/sk|sign not equals?)\b|签名|鉴权/u.test(said)) return account("keys_refused");
  return quota ? account("refused") : new VmakeError(message, "piece");
}

/** A value of an answer as text: a string or number as it is, anything else none. */
export const textOf = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const stamp = (at: Date) => at.toISOString().replace(/[-:]/gu, "").replace(/\.\d+/u, "");

/** RFC 3986 as Python's urlencode writes it for these (quote_plus). */
const enc = (value: string) => encodeURIComponent(value).replace(/%20/gu, "+");

/** The SDK's own signature (sign_sdk/sign.py): SDK-HMAC-SHA256 over the method, path (ending /), sorted query, the headers given, and the body's hash. */
export function signSdk(keys: Keys, method: string, url: string, headers: Record<string, string>, body: string, at = new Date()): Record<string, string> {
  const out: Record<string, string> = { ...headers, "X-Sdk-Date": stamp(at) };
  const parsed = new URL(url);
  const names = Object.keys(out)
    .map((name) => name.toLowerCase())
    .sort();
  const low = Object.fromEntries(Object.entries(out).map(([name, value]) => [name.toLowerCase(), value.trim()]));
  const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  const query = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${enc(name)}=${enc(value)}`)
    .join("&");
  const canonical = `${method}\n${path}\n${query}\n${names.map((name) => `${name}:${low[name]}`).join("\n")}\n${names.join(";")}\n${sha256(body)}`;
  const toSign = `SDK-HMAC-SHA256\n${out["X-Sdk-Date"]}\n${sha256(canonical)}`;
  const signature = createHmac("sha256", keys.sk).update(toSign).digest("hex");
  out.Authorization = `Bearer ${Buffer.from(`SDK-HMAC-SHA256 Access=${keys.ak}, SignedHeaders=${names.join(";")}, Signature=${signature}`).toString("base64")}`;
  return out;
}

/** Alibaba OSS's V4 header signature (signer/v4.py) for a PUT of `key` into `bucket`. */
export function signOss(
  creds: { access_key: string; secret_key: string; session_token?: string },
  region: string,
  bucket: string,
  key: string,
  headers: Record<string, string>,
  at = new Date(),
): Record<string, string> {
  const when = stamp(at);
  const day = when.slice(0, 8);
  const out: Record<string, string> = { ...headers, "x-oss-date": when, "x-oss-content-sha256": "UNSIGNED-PAYLOAD" };
  if (creds.session_token) out["x-oss-security-token"] = creds.session_token;
  const scope = `${day}/${region}/oss/aliyun_v4_request`;
  const signed = Object.entries(out)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .filter(([name]) => name.startsWith("x-oss-") || name === "content-type" || name === "content-md5")
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const uri = encodeURI(`/${bucket}/${key}`).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonical = `PUT\n${uri}\n\n${signed.map(([name, value]) => `${name}:${value}\n`).join("")}\n\nUNSIGNED-PAYLOAD`;
  const toSign = `OSS4-HMAC-SHA256\n${when}\n${scope}\n${sha256(canonical)}`;
  const hmac = (k: Buffer | string, data: string) => createHmac("sha256", k).update(data).digest();
  const signing = hmac(hmac(hmac(hmac(`aliyun_v4${creds.secret_key}`, day), region), "oss"), "aliyun_v4_request");
  out.Authorization = `OSS4-HMAC-SHA256 Credential=${creds.access_key}/${scope},Signature=${createHmac("sha256", signing).update(toSign).digest("hex")}`;
  return out;
}

/** Sent, with its failures classified: a network error or 5xx is the piece's, a refusal by status or words as `classify` says. */
async function call(url: string, init: RequestInit & { timeout?: number }, what: string, quota = false): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? CALL_MS) });
  } catch (error) {
    throw new VmakeError(`Vmake's ${what} didn't answer: ${diag.messageOf(error)}`, "piece");
  }
  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* Said in words below. */
  }
  const meta = (body.meta ?? {}) as { code?: unknown; msg?: unknown; error?: unknown };
  const code = meta.code === undefined || meta.code === null || meta.code === "0" ? 0 : Number(meta.code);
  if (response.status >= 500) throw new VmakeError(`Vmake's ${what} failed (${response.status})`, "piece");
  if (response.status !== 200 || (Number.isFinite(code) && code !== 0) || Number.isNaN(code)) {
    const found = [meta.msg, meta.error, body.message, body.error_msg].find((one) => typeof one === "string" && one !== "") as string | undefined;
    // Its refusals can quote the request back (the key's id, the signatures): only the words before that, never a key.
    const said = found === undefined ? undefined : found.split(/,? server: |\bAccess=/u)[0]!.replace(/\b[0-9a-f]{24,}\b/giu, "…").slice(0, 160);
    // Whose it is from Vmake's own words (never Edit's around them).
    const whose = classify(said ?? "", quota, response.status === 200 ? null : response.status);
    throw new VmakeError(`Vmake's ${what}: ${said ?? `status ${response.status}, code ${textOf(meta.code)}`}`, whose.scope, whose.reason);
  }
  return body;
}

interface Task {
  material: string;
  task: string;
  type: string;
  params: Record<string, unknown>;
  maxSeconds: number;
  maxBytes: number;
}

interface AiPolicy {
  url: string;
  push_path: string;
  sync_timeout: number;
  status_query: { path: string; durations: string; default?: string };
}

interface UploadPolicy {
  credentials: { access_key: string; secret_key: string; session_token?: string };
  bucket: string;
  url: string;
  key: string;
  data: string;
  region?: string;
}

/** The gid Vmake gave these keys (it's sent back with each config and consume). */
const gids = new Map<string, string>();

async function wapi(keys: Keys, path: string, body: unknown, quota = false): Promise<Record<string, unknown>> {
  const text = JSON.stringify(body);
  const url = `https://${WAPI}${path}`;
  const headers = signSdk(keys, "POST", url, { "User-Agent": USER_AGENT, "Content-Type": "application/json" }, text);
  const answer = await call(url, { method: "POST", headers, body: text }, path === "/skill/config.json" ? "sign-in" : "quota", quota);
  return (answer.response ?? {}) as Record<string, unknown>;
}

/** The skill's config: the algorithm's host and the task. A refusal here is the keys'. */
async function config(keys: Keys, material: string): Promise<{ endpoint: string; task: Task }> {
  let response: Record<string, unknown>;
  try {
    response = await wapi(keys, "/skill/config.json", { gid: gids.get(keys.ak) ?? "", version: VERSION, supported_schemas: ["v2", "v1"] });
  } catch (error) {
    // Refused with no words Edit knows: it's the keys (nothing else is asked here).
    if (error instanceof VmakeError && error.scope === "piece" && !/didn't answer|failed \(\d+\)/u.test(error.message)) throw new VmakeError(error.message, "account", "keys_refused");
    throw error;
  }
  if (typeof response.gid === "string") gids.set(keys.ak, response.gid);
  const algorithm = (response.algorithm ?? {}) as { regions?: Record<string, string>; invoke?: Record<string, Record<string, unknown>> };
  const endpoint = algorithm.regions?.[REGION];
  const spec = algorithm.invoke?.[material];
  if (typeof endpoint !== "string" || endpoint === "") throw new VmakeError("Vmake's config named no algorithm host", "piece");
  if (spec === undefined || typeof spec.task !== "string") throw new VmakeError(`Vmake doesn't offer ${material} to these keys`, "account", "refused");
  return {
    endpoint,
    task: {
      material,
      task: spec.task,
      type: typeof spec.task_type === "string" && spec.task_type !== "" ? spec.task_type : "mtlab",
      params: (spec.params ?? {}) as Record<string, unknown>,
      maxSeconds: Number(spec.max_duration ?? 600),
      maxBytes: Number(spec.max_size ?? 314_572_800),
    },
  };
}

async function policy(keys: Keys, endpoint: string): Promise<{ ai: AiPolicy; upload: UploadPolicy }> {
  const url = `https://${endpoint}/ai/token_policy?type=mtai`;
  const headers = signSdk(keys, "GET", url, { Host: endpoint, "User-Agent": USER_AGENT }, "");
  const answer = await call(url, { headers }, "token policy");
  const mtai = ((answer.data ?? {}) as { mtai?: { api?: Record<string, unknown>; upload?: Record<string, unknown> } }).mtai;
  const pick = <T>(group: Record<string, unknown> | undefined): T | null => {
    const order = group?.order as string[] | undefined;
    const name = Array.isArray(order) ? order[0] : undefined;
    return name === undefined ? null : ((group?.[name] as T | undefined) ?? null);
  };
  const ai = pick<AiPolicy>(mtai?.api);
  const upload = pick<UploadPolicy>(mtai?.upload);
  if (ai === null || upload === null) throw new VmakeError("Vmake gave no upload or algorithm policy", "piece");
  return { ai, upload };
}

/** OSS's region from its endpoint's host (oss-ap-southeast-1.aliyuncs.com → ap-southeast-1). */
export function ossRegion(endpoint: string, fallback?: string): string {
  const host = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`).hostname.toLowerCase();
  const match = /(?:^|\.)oss-([a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/u.exec(host);
  if (match !== null) return match[1]!;
  if (fallback) return fallback;
  throw new VmakeError(`no OSS region in ${host}`, "piece");
}

async function upload(path: string, given: UploadPolicy): Promise<string> {
  const host = new URL(given.url.includes("://") ? given.url : `https://${given.url}`).host;
  const region = ossRegion(given.url, given.region);
  const headers = signOss(given.credentials, region, given.bucket, given.key, { "Content-Type": "video/mp4", "Content-Length": String(fs.statSync(path).size) });
  const url = `https://${given.bucket}.${host}/${given.key.split("/").map(encodeURIComponent).join("/")}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "PUT", headers, body: Bun.file(path), signal: AbortSignal.timeout(30 * 60_000) });
  } catch (error) {
    throw new VmakeError(`sending the piece to Vmake: ${diag.messageOf(error)}`, "piece");
  }
  if (response.status !== 200) {
    const text = (await response.text().catch(() => "")).slice(0, 300);
    throw new VmakeError(`sending the piece to Vmake: ${response.status} ${/<Code>([^<]+)/u.exec(text)?.[1] ?? ""}`.trim(), "piece");
  }
  return given.data;
}

function aiHeaders(keys: Keys, ai: AiPolicy, method: string, url: string, body: string): Record<string, string> {
  const host = ai.url.replace(/^https?:\/\//u, "");
  return signSdk(keys, method, url, { Host: host, "User-Agent": USER_AGENT, ...(body !== "" ? { "Content-Type": "application/json" } : {}) }, body);
}

/** Every http(s) URL of a video in the task's answer, the result's first. */
export function resultUrls(answer: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 12) return;
    if (typeof value === "string") {
      if (/^https?:\/\//u.test(value) && /\.(mp4|mov|m4v)(\?|$)/iu.test(value)) found.push(value);
    } else if (Array.isArray(value)) for (const one of value) walk(one, depth + 1);
    else if (value !== null && typeof value === "object") for (const one of Object.values(value)) walk(one, depth + 1);
  };
  walk(answer, 0);
  return [...new Set(found)];
}

/** What the run spent and what its answer said, for the log and the record (never a URL with a signature). */
export interface Spent {
  task: string;
  /** Credits Vmake says it took, when it says. */
  credits: number | null;
  seconds: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new VmakeError("stopped", "piece"));
    });
  });

/** A number of credits in an answer, if it names one (consume's or the task's). */
function creditsIn(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  for (const [name, one] of Object.entries(value)) {
    if (/^(cost|credits?|consumed?|points?|deduct(ed)?|amount)$/iu.test(name) && typeof one === "number") return one;
    const inner = creditsIn(one);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * Smart Pro on the video at `input`, written to `out`. Throws VmakeError.
 */
export async function remove(
  keys: Keys,
  input: string,
  out: string,
  options: { signal?: AbortSignal; seconds: number; material?: string; log?: (step: string, answer: unknown) => void } = { seconds: 0 },
): Promise<Spent> {
  const material = options.material ?? SMART_PRO;
  const { endpoint, task } = await config(keys, material);
  const size = fs.statSync(input).size;
  if (size > task.maxBytes) throw new VmakeError(`the piece is ${Math.round(size / 1e6)} MB, over Vmake's ${Math.round(task.maxBytes / 1e6)} MB`, "piece");
  if (options.seconds > task.maxSeconds) throw new VmakeError(`the piece is ${Math.round(options.seconds)} s, over Vmake's ${task.maxSeconds} s`, "piece");
  const { ai, upload: storage } = await policy(keys, endpoint);
  const url = await upload(input, storage);
  const consumed = await wapi(keys, "/skill/consume.json", { url, task: material, gid: gids.get(keys.ak) ?? "" }, true);
  options.log?.("consume", consumed);
  const context = typeof consumed.context === "string" ? consumed.context : "";
  const started = Date.now();
  const body = JSON.stringify({
    params: JSON.stringify(task.params),
    context,
    task: task.task,
    task_type: task.type,
    sync_timeout: ai.sync_timeout,
    init_images: [{ url }],
  });
  const push = `${ai.url}/${ai.push_path}`;
  const submitted = await call(push, { method: "POST", headers: aiHeaders(keys, ai, "POST", push, body), body, timeout: (ai.sync_timeout + 10) * 1000 }, "task");
  let answer: Record<string, unknown> = submitted;
  const data = (submitted.data ?? {}) as { status?: number; result?: { id?: unknown } };
  if (data.status === 9) {
    const id = textOf(data.result?.id).trim();
    if (id === "") throw new VmakeError("Vmake took the task but gave no id", "piece");
    const status = `${ai.url}/${ai.status_query.path}?task_id=${encodeURIComponent(id)}`;
    const steps = ai.status_query.durations
      .split(",")
      .map((one) => Number(one.trim()))
      .filter((one) => Number.isFinite(one) && one > 0);
    for (let at = 0; ; at++) {
      if (Date.now() - started > TASK_MS) throw new VmakeError("Vmake's task took over three hours", "piece");
      await sleep(steps[at] ?? 5_000, options.signal);
      let polled: Record<string, unknown>;
      try {
        polled = await call(status, { headers: aiHeaders(keys, ai, "GET", status, "") }, "task status");
      } catch (error) {
        // A missed answer isn't the task's end.
        if (error instanceof VmakeError && error.scope === "piece") continue;
        throw error;
      }
      const state = ((polled.data ?? {}) as { status?: number }).status;
      if (state === 10 || state === 2 || state === 20) {
        answer = polled;
        break;
      }
    }
  }
  options.log?.("result", answer);
  const urls = resultUrls((answer.data as Record<string, unknown> | undefined)?.result ?? answer.data);
  if (urls.length === 0) {
    const said = JSON.stringify(answer.data ?? answer).slice(0, 300);
    throw new VmakeError(`Vmake's task gave no video (${said.replace(/https?:\/\/\S+/gu, "<url>")})`, "piece");
  }
  await download(urls[0]!, out, options.signal);
  return { task: textOf(((answer.data ?? {}) as { result?: { id?: unknown } }).result?.id), credits: creditsIn(consumed) ?? creditsIn(answer.data), seconds: (Date.now() - started) / 1000 };
}

async function download(url: string, out: string, signal?: AbortSignal): Promise<void> {
  const partial = `${out}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(30 * 60_000) });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      await Bun.write(partial, response);
      fs.renameSync(partial, out);
      return;
    } catch (error) {
      fs.rmSync(partial, { force: true });
      if (attempt >= 3) throw new VmakeError(`fetching Vmake's result: ${diag.messageOf(error)}`, "piece");
      await sleep(2_000 * attempt, signal);
    }
  }
}

/** Whether the keys are taken (config and a token policy: nothing spent). Throws VmakeError. */
export async function check(keys: Keys, material = SMART_PRO): Promise<void> {
  const { endpoint } = await config(keys, material);
  await policy(keys, endpoint);
}
