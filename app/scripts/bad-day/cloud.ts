// The stand-ins for everything outside Edit, behind the bad line.
//
// One front server takes every connection the line passes on, records it
// (when, what, with which sign-in), and answers:
// - the accounts site (`/app/token`, `/.well-known/jwks.json`): sign-ins
//   that live as long as a case says (20 s for the sign-in cases), refresh
//   tokens that rotate on use (the last one still taken for a minute, as the
//   real site does), and a switch to answer late or end the sign-in;
// - Google Drive (`/www.googleapis.com/drive/v3/files…`, the download
//   address): files served from disk in ranges, counted byte by byte;
// - R2 behind presigned URLs: objects kept on disk, never in memory;
// - everything else (the relay's routes, Convex, the model, Google's other
//   calls) by the tests' own mock (apps/server/test/mocks/server.ts), asked
//   over loopback, so the relay's routes are the same ones the unit tests use.
//
// The relay and Google's gateway refuse a call without a good sign-in, as the
// live relay does (401 "Sign in to Edit"), and each such call is noted: the
// harness's check 4 is that there are none.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

import { MockServer } from "../../apps/server/test/mocks/server.ts";
import type { Clip } from "./footage.ts";

export interface Seen {
  at: number;
  method: string;
  path: string;
  /** What the call's sign-in was: none, good, run out, or never issued here. */
  auth: "none" | "good" | "expired" | "unknown" | "not needed";
  status: number;
  /** Bytes of a file this answer sent (Drive and R2 downloads). */
  bytes: number;
}

interface Issued {
  sub: string;
  expires: number;
}

/** A file on the stand-in Drive. */
export interface DriveFile {
  id: string;
  name: string;
  path: string;
  size: number;
  md5: string;
  mimeType: string;
  /** Answered with this status instead (a file not shared: 404; Drive's limit: 403). */
  refuse?: number;
  /** In which folder. */
  parent: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Paths that need the person's sign-in: the relay's and Google's gateway (Drive's API). */
function needsSignIn(path: string): boolean {
  // The stand-in model (Claude's questions, the harness's preload) isn't the relay.
  if (path === "/v1/chat/completions") return false;
  return path.startsWith("/v1/") || path.startsWith("/www.googleapis.com/");
}

export class Cloud {
  readonly mock: MockServer;
  readonly seen: Seen[] = [];
  /** Access tokens issued, and when each runs out. */
  readonly issued = new Map<string, Issued>();
  /** Refresh tokens still taken (the newest, and each rotated one for a minute). */
  private refresh = new Map<string, number>();
  /** How long a sign-in lives (s). */
  signInSeconds = 3600;
  /** The accounts site answers this late (ms). */
  accountsDelayMs = 0;
  /** The sign-in is ended there: every renewal is `invalid_grant`. */
  signInEnded = false;
  /** Device sign-ins asked for (each one a sign-in screen's code), and whether each is approved. */
  deviceCodes = 0;
  readonly devices = new Map<string, boolean>();
  /** Approves every device sign-in waiting (the person typed the code). */
  approveDevices(): number {
    for (const code of this.devices.keys()) this.devices.set(code, true);
    return this.devices.size;
  }
  /** Ends the sign-in there: every kept refresh token is refused from now on (invalid_grant). */
  endSignIn(): void {
    this.signInEnded = true;
    this.refresh.clear();
  }
  /** Sign-ins renewed (POST /app/token answered 200). */
  renewals = 0;
  readonly drive = new Map<string, DriveFile>();
  readonly folders = new Map<string, string>();
  /** Bytes of each Drive file sent, by id. */
  readonly driveBytes = new Map<string, number>();
  /** Bytes of each R2 object sent, by key. */
  readonly r2Bytes = new Map<string, number>();
  /** Runs before a Drive download is answered (a case can break the line just then). */
  beforeDownload: ((file: DriveFile, from: number) => void | Promise<void>) | null = null;
  /** The relay's Drive → R2 copies (apps/relay/src/jobs.ts), done in the cloud at `copyRate` bytes a second. */
  readonly copies = new Map<string, { file: string; key: string; started: number; size: number; done: boolean }>();
  copyRate = 40e6;
  /** The relay's copy job is offered (an older relay answers 404 and Edit streams it through itself). */
  relayCopies = true;
  /** Told of each R2 GET's key as it comes in (before it's answered). */
  beforeR2Get: ((key: string) => void) | null = null;
  /** Told of each R2 PUT's key (a part's too) as it comes in; a Response given answers it instead (an upload refused). */
  beforeR2Put: ((key: string) => Response | null | void) | null = null;
  /** Told of each Convex function a call through the relay names (`reviews:publish`…), before it's answered. */
  beforeConvex: ((path: string) => void) | null = null;
  /** Repack's reviews (the `reviews:` functions a share calls), by the project shared. */
  readonly reviews = new Map<string, { reviewId: string; url: string; versions: { n: number; deleted: boolean; key: string; meta: Record<string, unknown> | null; at: number }[] }>();
  /** Every `reviews:publish` answered, in order. */
  readonly published: { at: number; project: string; version: number; key: string }[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private objectsDir: string;
  /** The MP3 a voice is answered with. */
  speech = "";
  /** The base Edit is given: the line's address, set once the line is up. */
  base = "";

  constructor(private readonly dir: string) {
    this.objectsDir = join(dir, "r2");
    fs.mkdirSync(this.objectsDir, { recursive: true });
    this.mock = MockServer.start();
    // R2's objects on disk (CloudMock keeps a Map: this one reads and writes files).
    Object.defineProperty(this.mock.cloud, "objects", { value: new DiskObjects(this.objectsDir) });
    // Presigned URLs and Convex's storage point at the line, never at the mock's own port.
    Object.defineProperty(this.mock, "url", { get: () => this.base });
  }

  /** The front server's port (the line forwards here). */
  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      maxRequestBodySize: 1024 ** 3,
      fetch: (request) => this.answer(request),
    });
    return this.server.port!;
  }

  stop(): void {
    void this.server?.stop(true);
    this.mock.stop();
  }

  // ── The accounts site ──

  /** A sign-in kept as Edit keeps it: the refresh token to put in its home's sign-in.json. */
  newSignIn(): string {
    const token = `rt-${randomBytes(18).toString("base64url")}`;
    this.refresh.set(token, Number.POSITIVE_INFINITY);
    return token;
  }

  private accessToken(): { token: string; expires: number } {
    const expires = Date.now() + this.signInSeconds * 1000;
    const claims = { sub: "user_bad_day", email: "bad-day@example.invalid", name: "Bad Day", perms: ["use"], admin: true, exp: Math.floor(expires / 1000), iat: Math.floor(Date.now() / 1000) };
    const token = `${b64({ alg: "EdDSA", typ: "JWT", kid: "bad-day" })}.${b64(claims)}.${randomBytes(32).toString("base64url")}`;
    this.issued.set(token, { sub: claims.sub, expires });
    return { token, expires };
  }

  private async accounts(request: Request, path: string): Promise<Response> {
    if (this.accountsDelayMs > 0) await sleep(this.accountsDelayMs);
    if (path === "/.well-known/jwks.json") return Response.json({ keys: [{ kty: "OKP", crv: "Ed25519", kid: "bad-day", x: "AAAA" }] });
    let body: Record<string, string> = {};
    try {
      body = (await request.json()) as Record<string, string>;
    } catch {}
    if (path === "/app/device") {
      // A device sign-in (RFC 8628), as headless `edit serve` signs in: approved when a case says so.
      this.deviceCodes += 1;
      const code = `dc-${randomBytes(12).toString("base64url")}`;
      this.devices.set(code, false);
      return Response.json({ device_code: code, user_code: "BADD-AY01", verification_uri: `${this.base}/device`, verification_uri_complete: null, interval: 1, expires_in: 600 });
    }
    if (path !== "/app/token") return Response.json({ error: "not_found" }, { status: 404 });
    if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      const approved = this.devices.get(body.device_code ?? "");
      if (approved === undefined) return Response.json({ error: "expired_token" }, { status: 400 });
      if (!approved) return Response.json({ error: "authorization_pending" }, { status: 400 });
      this.devices.delete(body.device_code!);
      this.signInEnded = false;
      const next = this.newSignIn();
      const access = this.accessToken();
      this.renewals += 1;
      return Response.json({ access_token: access.token, token_type: "Bearer", expires_in: this.signInSeconds, refresh_token: next, user: { email: "bad-day@example.invalid", name: "Bad Day", image: null } });
    }
    if (body.grant_type !== "refresh_token") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    const given = body.refresh_token ?? "";
    const until = this.refresh.get(given);
    if (this.signInEnded || until === undefined || Date.now() > until) {
      return Response.json({ error: "invalid_grant", error_description: "Your sign-in ended: sign in again." }, { status: 400 });
    }
    // Rotated: the one given stays good for a minute (its answer may be lost on the way).
    this.refresh.set(given, Math.min(until, Date.now() + 60_000));
    const next = `rt-${randomBytes(18).toString("base64url")}`;
    this.refresh.set(next, Number.POSITIVE_INFINITY);
    const access = this.accessToken();
    this.renewals += 1;
    return Response.json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: this.signInSeconds,
      refresh_token: next,
      user: { email: "bad-day@example.invalid", name: "Bad Day", image: null },
    });
  }

  // ── Drive ──

  /** Puts `clip` in Drive folder `folder` (made if new), under `id`. */
  addFile(folder: string, id: string, clip: Clip, extra: Partial<DriveFile> = {}): DriveFile {
    if (!this.folders.has(folder)) this.folders.set(folder, `Case ${folder.slice(0, 6)}`);
    const file: DriveFile = {
      id,
      name: clip.name,
      path: clip.path,
      size: clip.size,
      md5: clip.md5,
      mimeType: clip.name.endsWith(".m4a") ? "audio/mp4" : "video/mp4",
      parent: folder,
      ...extra,
    };
    this.drive.set(id, file);
    return file;
  }

  /** Bytes sent of every Drive file. */
  get driveSent(): number {
    let sum = 0;
    for (const bytes of this.driveBytes.values()) sum += bytes;
    return sum;
  }

  private driveApi(url: URL, path: string): Response | null {
    // GET /www.googleapis.com/drive/v3/files?q='<folder>' in parents …: the folder's listing.
    if (path === "/www.googleapis.com/drive/v3/files") {
      const q = url.searchParams.get("q") ?? "";
      const folder = /'([^']+)' in parents/.exec(q)?.[1];
      const files = [...this.drive.values()].filter((file) => folder === undefined || file.parent === folder);
      return Response.json({
        files: files.map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType, size: String(file.size), md5Checksum: file.md5, parents: [file.parent] })),
      });
    }
    const one = /^\/www\.googleapis\.com\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (one === null) return null;
    const id = decodeURIComponent(one[1]!);
    if (url.searchParams.get("alt") === "media") return null; // a download: answered as bytes below
    const folder = this.folders.get(id);
    if (folder !== undefined) return Response.json({ id, name: folder, mimeType: "application/vnd.google-apps.folder" });
    const file = this.drive.get(id);
    if (file === undefined) return Response.json({ error: { code: 404, message: `File not found: ${id}.` } }, { status: 404 });
    if (file.refuse !== undefined) return Response.json({ error: { code: file.refuse, message: "The user does not have sufficient permissions for this file." } }, { status: file.refuse });
    return Response.json({ id: file.id, name: file.name, mimeType: file.mimeType, size: String(file.size), md5Checksum: file.md5, parents: [file.parent] });
  }

  private async driveDownload(request: Request, id: string): Promise<{ response: Response; bytes: () => number }> {
    const file = this.drive.get(id);
    const none = { response: new Response("Not found", { status: 404 }), bytes: () => 0 };
    if (file === undefined) return none;
    if (file.refuse !== undefined) return { response: new Response("Forbidden", { status: file.refuse }), bytes: () => 0 };
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    const from = range === null ? 0 : Number(range[1]);
    await this.beforeDownload?.(file, from);
    // The file may have gone meanwhile (a case removing it).
    if (!fs.existsSync(file.path)) return none;
    const size = fs.statSync(file.path).size;
    if (from >= size && range !== null) return { response: new Response("", { status: 416, headers: { "content-range": `bytes */${size}` } }), bytes: () => 0 };
    const to = range === null || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
    const counted = countedFile(file.path, from, to, (n) => this.driveBytes.set(id, (this.driveBytes.get(id) ?? 0) + n));
    const headers: Record<string, string> = {
      "content-type": file.mimeType,
      "content-disposition": `attachment; filename="${file.name}"`,
      "content-length": String(to - from + 1),
      "accept-ranges": "bytes",
    };
    if (range !== null) headers["content-range"] = `bytes ${from}-${to}/${size}`;
    return { response: new Response(counted.stream, { status: range === null ? 200 : 206, headers }), bytes: counted.sent };
  }

  // ── R2, from disk ──

  private r2Get(request: Request, path: string): { response: Response; bytes: () => number } | null {
    const url = new URL(request.url);
    if (!url.searchParams.has("X-Amz-Signature")) return null;
    const key = path.slice("/r2/".length).split("/").map(decodeURIComponent).join("/");
    const objects = this.mock.cloud.objects as unknown as DiskObjects;
    const file = objects.pathOf(key);
    if (!fs.existsSync(file)) return null; // the mock's 404
    const size = fs.statSync(file).size;
    const etag = objects.etag(key);
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    const from = range === null ? 0 : Number(range[1]);
    if (range !== null && from >= size) return { response: new Response(null, { status: 416, headers: { etag } }), bytes: () => 0 };
    const to = range === null || range[2] === "" ? size - 1 : Math.min(size - 1, Number(range[2]));
    if (request.method === "HEAD") return { response: new Response(null, { status: 200, headers: { etag, "content-length": String(size) } }), bytes: () => 0 };
    const counted = countedFile(file, from, to, (n) => this.r2Bytes.set(key, (this.r2Bytes.get(key) ?? 0) + n));
    const headers: Record<string, string> = { etag, "content-length": String(to - from + 1) };
    if (range !== null) headers["content-range"] = `bytes ${from}-${to}/${size}`;
    return { response: new Response(counted.stream, { status: range === null ? 200 : 206, headers }), bytes: counted.sent };
  }

  // ── Script mode's cloud (apps/relay/src/writer_cloud.ts): R2 under writer/, its index in Convex's `writer` module ──

  /** Script rows (writer:listScripts), by id. */
  readonly scripts = new Map<string, Record<string, unknown>>();

  private async writerCloud(route: string, request: Request, url: URL): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const success = (value: unknown) => Response.json({ status: "success", value });
    if (route === "convex") {
      const path = String(body.path ?? "");
      const args = (body.args ?? {}) as Record<string, unknown>;
      if (path.startsWith("edit:")) return this.forward(`/v1/cloud/convex`, request, JSON.stringify(body), url);
      if (path === "writer:listScripts") return success([...this.scripts.values()]);
      if (path === "writer:getScript") return success(this.scripts.get(String(args.scriptId)) ?? null);
      if (path === "writer:commitScript") {
        const id = String(args.scriptId);
        const now = this.scripts.get(id);
        const rev = Number(now?.rev ?? 0);
        if (Number(args.baseRev ?? 0) !== rev) return Response.json({ status: "error", errorMessage: "conflict", errorData: { code: "conflict", rev } });
        const stale = ((now?.files ?? []) as { key: string }[]).map((file) => file.key).filter((key) => !((args.files ?? []) as { key: string }[]).some((file) => file.key === key));
        this.scripts.set(id, { ...args, scriptId: id, rev: rev + 1, deletedAt: null, updatedAt: Date.now() });
        return success({ rev: rev + 1, stale });
      }
      if (path === "writer:deleteScript") {
        this.scripts.delete(String(args.scriptId));
        return success({ keys: [] });
      }
      return success(null);
    }
    // The R2 routes: the tests' mock takes keys under edit/ only, so writer/<…> is kept there as edit/writer-cloud/<…>.
    const into = (key: unknown) => (typeof key === "string" && key.startsWith("writer/") ? `edit/writer-cloud/${key.slice("writer/".length)}` : key);
    const outOf = (key: string) => (key.startsWith("edit/writer-cloud/") ? `writer/${key.slice("edit/writer-cloud/".length)}` : key);
    const mapped: Record<string, unknown> = { ...body };
    if ("key" in mapped) mapped.key = into(mapped.key);
    if ("prefix" in mapped) mapped.prefix = into(mapped.prefix);
    if (Array.isArray(mapped.keys)) mapped.keys = mapped.keys.map(into);
    const answer = await this.forward(`/v1/cloud/${route}`, request, JSON.stringify(mapped), url);
    if (route !== "r2/list" || answer.status !== 200) return answer;
    const listed = (await answer.json()) as { objects: { key: string; size: number }[]; cursor?: string };
    return Response.json({ ...listed, objects: listed.objects.map((one) => ({ ...one, key: outOf(one.key) })) });
  }

  private forward(path: string, request: Request, body: string, url: URL): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.mockPort()}${path}${url.search}`, { method: "POST", headers: { "content-type": "application/json", authorization: request.headers.get("authorization") ?? "" }, body });
  }

  // ── The relay's copy jobs ──

  private async copyJob(route: string, request: Request): Promise<Response> {
    if (!this.relayCopies) return Response.json({ error: "not found" }, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as Record<string, string>;
    if (route === "drive") {
      const file = this.drive.get(body.file ?? "");
      if (file === undefined || file.refuse !== undefined) return Response.json({ error: "Google Drive: File not found." }, { status: 502 });
      const id = `copy-${this.copies.size + 1}`;
      this.copies.set(id, { file: file.id, key: body.key ?? "", started: Date.now(), size: file.size, done: false });
      return Response.json({ id, status: "running" });
    }
    const copy = this.copies.get(body.id ?? "");
    if (copy === undefined) return Response.json({ status: "unknown" });
    if (route === "cancel") {
      this.copies.delete(body.id!);
      return Response.json({ ok: true });
    }
    if (route !== "status") return Response.json({ error: "not found" }, { status: 404 });
    const bytes = Math.min(copy.size, Math.round(((Date.now() - copy.started) / 1000) * this.copyRate));
    if (bytes < copy.size) return Response.json({ status: "running", bytes });
    if (!copy.done) {
      const file = this.drive.get(copy.file)!;
      const objects = this.mock.cloud.objects as unknown as DiskObjects;
      objects.copyIn(copy.key, file.path);
      copy.done = true;
    }
    return Response.json({ status: "complete", bytes: copy.size });
  }

  // ── Every request ──

  private authOf(request: Request, path: string): Seen["auth"] {
    if (!needsSignIn(path)) return "not needed";
    const header = request.headers.get("authorization") ?? "";
    const token = /^Bearer (.+)$/.exec(header)?.[1];
    if (token === undefined) return "none";
    const issued = this.issued.get(token);
    if (issued === undefined) return "unknown";
    return Date.now() >= issued.expires ? "expired" : "good";
  }

  private async answer(given: Request): Promise<Response> {
    const url = new URL(given.url);
    const path = url.pathname;
    const entry: Seen = { at: Date.now(), method: given.method, path, auth: this.authOf(given, path), status: 0, bytes: 0 };
    this.seen.push(entry);
    // The body read once: a case may look at it (a file cut off), then whoever answers reads it.
    const raw = given.method === "GET" || given.method === "HEAD" ? undefined : new Uint8Array(await given.arrayBuffer());
    const request = new Request(given.url, { method: given.method, headers: given.headers, body: raw });
    let answered: { response: Response; bytes: () => number } | null = null;
    try {
      if (path.startsWith("/r2/") && given.method === "GET") this.beforeR2Get?.(decodeURIComponent(path.slice(4)));
      if (path === "/app/token" || path === "/.well-known/jwks.json" || path.startsWith("/app/")) {
        answered = { response: await this.accounts(request, path), bytes: () => 0 };
      } else if (needsSignIn(path) && entry.auth !== "good") {
        // As the live relay (and its Google gateway) answers a call without a good sign-in.
        answered = { response: Response.json({ error: "Sign in to Edit." }, { status: 401 }), bytes: () => 0 };
      } else if (path === "/v1/cloud/convex" && raw !== undefined && (answered = this.convexHook(raw)) !== null) {
        // Repack's reviews, answered here (the tests' mock takes edit: functions only).
      } else if (path.startsWith("/r2/") && request.method === "PUT" && this.beforeR2Put !== null && (answered = this.putHook(path)) !== null) {
        // An upload refused by the case.
      } else if (path === "/v1/speech" && this.speech !== "") {
        // A voice: two seconds of silence, a real MP3 (the tests' mock answers four bytes).
        answered = { response: new Response(Bun.file(this.speech), { headers: { "content-type": "audio/mpeg" } }), bytes: () => 0 };
      } else if (path === "/health") {
        answered = { response: Response.json({ ok: true }), bytes: () => 0 };
      } else if (path.startsWith("/v1/cloud/writer/")) {
        answered = { response: await this.writerCloud(path.slice("/v1/cloud/writer/".length), request, url), bytes: () => 0 };
      } else if (path.startsWith("/v1/cloud/jobs/")) {
        answered = { response: await this.copyJob(path.slice("/v1/cloud/jobs/".length), request), bytes: () => 0 };
      } else if (path === "/drive.usercontent.google.com/download" || path === "/drive.google.com/uc") {
        answered = await this.driveDownload(request, url.searchParams.get("id") ?? "");
      } else if (/^\/www\.googleapis\.com\/drive\/v3\/files\/[^/]+$/.test(path) && url.searchParams.get("alt") === "media") {
        answered = await this.driveDownload(request, decodeURIComponent(path.split("/").pop()!));
      } else if (path.startsWith("/www.googleapis.com/drive/")) {
        const api = this.driveApi(url, path);
        if (api !== null) answered = { response: api, bytes: () => 0 };
      } else if (path.startsWith("/r2/") && (request.method === "GET" || request.method === "HEAD")) {
        answered = this.r2Get(request, path);
      }
      if (answered === null) {
        // The tests' mock, over loopback.
        const forwarded = await fetch(`http://127.0.0.1:${this.mockPort()}${path}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: raw,
        });
        answered = { response: forwarded, bytes: () => 0 };
      }
    } catch (error) {
      answered = { response: new Response(String(error), { status: 500 }), bytes: () => 0 };
    }
    entry.status = answered.response.status;
    const bytes = answered.bytes;
    Object.defineProperty(entry, "bytes", { get: bytes, enumerable: true });
    return answered.response;
  }

  /** A Convex call through the relay: told to the case, and answered here when it's one of Repack's `reviews:`. */
  private convexHook(raw: Uint8Array): { response: Response; bytes: () => number } | null {
    let body: { path?: unknown; args?: Record<string, unknown> } = {};
    try {
      body = JSON.parse(new TextDecoder().decode(raw)) as typeof body;
    } catch {
      return null;
    }
    const path = typeof body.path === "string" ? body.path : "";
    this.beforeConvex?.(path);
    if (!path.startsWith("reviews:")) return null;
    const args = body.args ?? {};
    const project = String(args.sourceId ?? "");
    const success = (value: unknown) => ({ response: Response.json({ status: "success", value }), bytes: () => 0 });
    if (path === "reviews:get") return success(this.reviews.get(project) ?? null);
    if (path === "reviews:publish") {
      const review = this.reviews.get(project) ?? { reviewId: `review-${this.reviews.size + 1}`, url: `https://review.bad-day.invalid/r/${this.reviews.size + 1}`, versions: [] };
      const version = review.versions.reduce((most, one) => Math.max(most, one.n), 0) + 1;
      review.versions.push({ n: version, deleted: false, key: String(args.key ?? ""), meta: (args.meta ?? null) as Record<string, unknown> | null, at: Date.now() });
      this.reviews.set(project, review);
      this.published.push({ at: Date.now(), project, version, key: String(args.key ?? "") });
      return success({ reviewId: review.reviewId, url: review.url, version });
    }
    // setMeta, compress, status, checkIn…: taken, nothing to say.
    return success(null);
  }

  private putHook(path: string): { response: Response; bytes: () => number } | null {
    const key = path.slice("/r2/".length).split("/").map(decodeURIComponent).join("/");
    const answer = this.beforeR2Put?.(key);
    return answer instanceof Response ? { response: answer, bytes: () => 0 } : null;
  }

  private mockPort(): number {
    // The mock's own server (MockServer keeps it private): its port is in the URL it reported before `url` pointed here.
    return (this.mock as unknown as { server: { port: number } }).server.port;
  }

  /** Calls made without a good sign-in (check 4). */
  badSignIns(): Seen[] {
    return this.seen.filter((one) => one.auth === "none" || one.auth === "expired" || one.auth === "unknown");
  }

  /** Paid calls, by kind (check 6): hearings, voices, model calls. */
  paid(): Record<string, number> {
    const count = (test: (path: string) => boolean) => this.seen.filter((one) => test(one.path) && one.status < 400).length;
    return {
      hearings: count((path) => path === "/v1/transcribe" || path.startsWith("/v1/transcribe")),
      voices: count((path) => path === "/v1/speech"),
      model: count((path) => path === "/v1/chat/completions"),
    };
  }
}

/** A file's bytes `from`..`to` as a stream, read 256 kB at a time as it's pulled, each piece counted once sent. */
function countedFile(path: string, from: number, to: number, count: (n: number) => void): { stream: ReadableStream<Uint8Array>; sent: () => number } {
  let at = from;
  let sent = 0;
  let fd: number | null = null;
  const stream = new ReadableStream<Uint8Array>({
    type: "bytes",
    pull(controller) {
      fd ??= fs.openSync(path, "r");
      if (at > to) {
        fs.closeSync(fd);
        fd = null;
        controller.close();
        return;
      }
      const n = Math.min(256 * 1024, to - at + 1);
      const buffer = Buffer.alloc(n);
      const read = fs.readSync(fd, buffer, 0, n, at);
      if (read === 0) {
        controller.close();
        return;
      }
      at += read;
      sent += read;
      count(read);
      controller.enqueue(buffer.subarray(0, read));
    },
    cancel() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  });
  return { stream, sent: () => sent };
}

/** CloudMock's objects, on disk: a Map's face over a folder. */
class DiskObjects extends Map<string, Uint8Array> {
  private keys_ = new Set<string>();
  private etags = new Map<string, string>();
  constructor(private readonly dir: string) {
    super();
  }
  pathOf(key: string): string {
    return join(this.dir, createHash("sha256").update(key).digest("hex"));
  }
  etag(key: string): string {
    let etag = this.etags.get(key);
    if (etag === undefined) {
      etag = `"${createHash("md5").update(fs.readFileSync(this.pathOf(key))).digest("hex")}"`;
      this.etags.set(key, etag);
    }
    return etag;
  }
  /** A file put in as `key` without reading it into memory. */
  copyIn(key: string, from: string): void {
    fs.copyFileSync(from, this.pathOf(key));
    this.keys_.add(key);
    this.etags.delete(key);
  }
  override get(key: string): Uint8Array | undefined {
    if (!this.keys_.has(key)) return undefined;
    return new Uint8Array(fs.readFileSync(this.pathOf(key)));
  }
  override set(key: string, value: Uint8Array): this {
    fs.writeFileSync(this.pathOf(key), value);
    this.keys_.add(key);
    this.etags.set(key, `"${createHash("md5").update(value).digest("hex")}"`);
    return this;
  }
  override has(key: string): boolean {
    return this.keys_.has(key);
  }
  override delete(key: string): boolean {
    if (!this.keys_.delete(key)) return false;
    fs.rmSync(this.pathOf(key), { force: true });
    this.etags.delete(key);
    return true;
  }
  override keys(): MapIterator<string> {
    return this.keys_.values();
  }
  override get size(): number {
    return this.keys_.size;
  }
  override *entries(): MapIterator<[string, Uint8Array]> {
    for (const key of this.keys_) yield [key, this.get(key)!];
  }
  override [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
    return this.entries();
  }
  override *values(): MapIterator<Uint8Array> {
    for (const key of this.keys_) yield this.get(key)!;
  }
  override forEach(fn: (value: Uint8Array, key: string, map: Map<string, Uint8Array>) => void): void {
    for (const [key, value] of this.entries()) fn(value, key, this);
  }
  override clear(): void {
    for (const key of [...this.keys_]) this.delete(key);
  }
}
