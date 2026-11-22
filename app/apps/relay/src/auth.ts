// Who is calling, and may they: every route but /health asks here.
//
// A caller is a person signed in through accounts.spheceo.com: their access
// token, a JWT signed with the accounts site's key, checked against its JWKS
// for `iss`, `aud: "edit"` and `exp`, with the route's permission in its
// `perms`. The shared token every Edit build used to carry was retired on
// Oct 23 (it's in every old build: burnt); a build still sending it is told
// to update and sign in. `OPEN_MAPS = "1"` would open the maps to anyone
// again (they're gated, "0", since then).
//
// Budgets (transcription, voices, maps) are kept per caller: a person by
// their id, everyone else by connection, as before. The log says who made
// each request (the person's id), never their token.

import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";

import { isEditing } from "./manifest";

/**
 * What a route needs. Since accounts' contract v2 every route needs only
 * `use` (has Edit at all): Edit enforces the kinds of work itself, from the
 * capabilities in `perms` (manifest.ts). The v1 names are accepted as words
 * and ignored, as any id the relay doesn't know is.
 */
export type Permission = "use";

export interface AuthEnv {
  /** The accounts site (default https://accounts.spheceo.com): the tokens' issuer; its JWKS is at /.well-known/jwks.json. */
  ACCOUNTS_ISSUER?: string;
  /** "1": the maps routes answer without a token (builds from before signing in sent none). */
  OPEN_MAPS?: string;
}

/** A person as their token names them (name, email and Google photo when the token carries them). */
export type Caller = { kind: "person"; sub: string; perms: string[]; admin: boolean; name?: string; email?: string; picture?: string } | { kind: "open" };

const ISSUER = "https://accounts.spheceo.com";
/** Allowed clock skew between the accounts site and here (the contract's 60 s). */
export const SKEW_SECONDS = 60;

/**
 * What this copy of the relay last read of the accounts site: kept as data,
 * never as a read in flight. On Workers, a request awaiting a read another
 * request started waits forever when that one is cancelled (its I/O goes
 * with it), and so does every request after it in that copy (Nov 4: runs of
 * requests hanging 20 to 120 s with nothing logged, Marc's Mac 187 of them in
 * a day). jose's remote key set shares its read like that, and so did the
 * cut-offs here. So a request that needs keys another request is reading
 * waits for them as data (`keySets`, looked at on its own timer), never on
 * that read; one not landed in `READ_MS` (cancelled with its request, or
 * slow) is let be and this request reads them itself. A cold copy then reads
 * them once for a burst (Nov 22: bursts of 27 and 38 calls at a server's
 * start each read them, and all those reads timed out together).
 */
const keySets = new Map<string, { jwks: JSONWebKeySet; read: number }>();
/** Each address's last read of the keys here: when it began, and when it last failed (0: never). */
const keyReads = new Map<string, { began: number; failed: number }>();
/** The keys are read again after this, or at once (after 5 s since the last try) for a `kid` they lack. */
const KEYS_EVERY_MS = 10 * 60_000;
const KEYS_RETRY_MS = 5_000;
/** How long a read of the accounts site may take. */
const READ_MS = 5_000;
/** How often a request waiting on another's read looks at what's been read. */
const LOOK_MS = 20;
/** The longest the sign-in check may take before the request is answered 503 (Edit asks again) instead of hanging. */
export const CHECK_MS = 10_000;
/** Tests verify against keys of their own. */
let given: JWTVerifyGetKey | null = null;
export function useKeys(keys: JWTVerifyGetKey | null): void {
  given = keys;
}

function issuer(env: AuthEnv): string {
  return (env.ACCOUNTS_ISSUER ?? ISSUER).replace(/\/+$/, "");
}

/** Reads the keys at `url` (this request's own read), noting when it began and whether it failed. */
async function readKeys(url: string): Promise<void> {
  const began = Date.now();
  const reads = { began, failed: keyReads.get(url)?.failed ?? 0 };
  keyReads.set(url, reads);
  try {
    const answer = await fetch(url, { signal: AbortSignal.timeout(READ_MS) });
    const jwks = answer.ok ? ((await answer.json()) as JSONWebKeySet) : null;
    if (jwks === null || !Array.isArray(jwks.keys)) throw new Error(`the accounts site answered ${answer.status}`);
    keySets.set(url, { jwks, read: began });
  } catch (error) {
    reads.failed = Math.max(Date.now(), began);
    console.log(JSON.stringify({ route: "keys", unread: String(error) }));
  }
}

/**
 * The keys to check a token signed with `kid` against: those last read, read again when old or lacking it, by this
 * request or, when another began reading them a moment ago, by that one, waited for as data. A token whose key they
 * lack when its read failed or never landed can't be checked (`KeysUnread`, 503); lacking it after a read that
 * worked, it's refused (401). Until Nov 22 the failed re-read's case was checked against the old keys: a 401, which
 * tells Edit the person is signed out.
 */
async function keysOf(env: AuthEnv, kid: string | undefined): Promise<JWTVerifyGetKey> {
  if (given !== null) return given;
  const url = `${issuer(env)}/.well-known/jwks.json`;
  const holds = () => {
    const set = keySets.get(url);
    return set !== undefined && (kid === undefined || set.jwks.keys.some((key) => key.kid === kid));
  };
  // Whether the last read began has an outcome: its keys read, or it failed.
  const settled = (began: number) => (keySets.get(url)?.read ?? -1) >= began || (keyReads.get(url)?.failed ?? 0) >= began;
  const known = keySets.get(url);
  const lacking = !holds();
  const old = known === undefined || Date.now() - known.read > KEYS_EVERY_MS;
  if (lacking || old) {
    const last = keyReads.get(url);
    const going = last !== undefined && !settled(last.began) && Date.now() - last.began < READ_MS;
    if (going && lacking) {
      for (let looked = 0; looked * LOOK_MS < READ_MS && !settled(last.began); looked++) await new Promise((resolve) => setTimeout(resolve, LOOK_MS));
      // That read never landed (its request cancelled, or slow past its time): this one reads them.
      if (!settled(last.began)) await readKeys(url);
    } else if (!going && (last === undefined || Date.now() - last.began > KEYS_RETRY_MS)) await readKeys(url);
  }
  const set = keySets.get(url);
  if (set === undefined) throw new KeysUnread();
  const last = keyReads.get(url);
  if (!holds() && last !== undefined && !(set.read >= last.began)) throw new KeysUnread();
  return createLocalJWKSet(set.jwks);
}

/**
 * The accounts site's keys couldn't be read: the token can't be checked
 * either way. Answered 503 ("Edit asks again"), as a check too slow is, never
 * 401: a 401 tells Edit the person is signed out (JJ's Mac, Nov 19: "the
 * relay refused the sign-in's token" five times with a good token).
 */
export class KeysUnread extends Error {
  constructor() {
    super("the accounts site's keys couldn't be read");
  }
}

/** Tests: forget the keys read, so the next request reads them again. */
export function forgetKeys(): void {
  keySets.clear();
  keyReads.clear();
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** How often the accounts site's cut-offs are read (each running copy of the relay keeps them meanwhile). */
const CUT_OFFS_EVERY_MS = 60_000;

/** People whose sign-ins an admin ended (removed, signed out everywhere, an app taken away): when, by person, and for which app (`*`: every app). */
let cutOffs: { read: number; at: Map<string, Map<string, number>> } | null = null;
/** When this copy last began reading them: one request reads while the rest use the list held; one not back in `READ_MS` is let be. */
let readingSince = 0;

/** How the list is fetched (tests give their own). */
let fetchCutOffs = (url: string): Promise<Response> => fetch(url, { signal: AbortSignal.timeout(3_000) });

/** Tests: where the cut-offs come from, and forget the ones read so the next request reads them again. */
export function readCutOffsWith(read: ((url: string) => Promise<Response>) | null): void {
  fetchCutOffs = read ?? ((url) => fetch(url, { signal: AbortSignal.timeout(3_000) }));
  cutOffs = null;
  readingSince = 0;
}

/** The accounts site's cut-offs (`/app/revoked`, the last two hours): one read a minute, the last list kept when it can't be read. */
async function readCutOffs(env: AuthEnv): Promise<void> {
  const at = new Map(cutOffs?.at ?? []);
  try {
    const answer = await fetchCutOffs(`${issuer(env)}/app/revoked`);
    if (!answer.ok) throw new Error(`the accounts site answered ${answer.status}`);
    const body = (await answer.json()) as { revoked?: { sub?: unknown; at?: unknown; aud?: unknown }[] };
    at.clear();
    for (const one of body.revoked ?? []) {
      if (typeof one.sub !== "string" || typeof one.at !== "number") continue;
      const app = typeof one.aud === "string" ? one.aud : "*";
      const apps = at.get(one.sub) ?? new Map<string, number>();
      apps.set(app, Math.max(apps.get(app) ?? 0, one.at));
      at.set(one.sub, apps);
    }
  } catch (error) {
    console.log(JSON.stringify({ route: "cut-offs", unread: String(error) }));
  }
  cutOffs = { read: Date.now(), at };
}

/**
 * Whether a person's token was issued before an admin ended their sign-ins:
 * the relay refuses it within a minute of the cut-off, not when the token
 * runs out an hour later (the user, Oct 30: a lost laptop's sign-in).
 */
async function cutOff(env: AuthEnv, sub: string, issuedAt: number, audience: string): Promise<boolean> {
  // Never read at all here: this request reads them (it can't go on without). Old: one request reads, the others use what's held.
  const now = Date.now();
  if (cutOffs === null || (now - cutOffs.read > CUT_OFFS_EVERY_MS && now - readingSince > READ_MS)) {
    readingSince = now;
    await readCutOffs(env);
  }
  // Cut off from every app, or from this one (another app's access taken away isn't this one's).
  const apps = cutOffs?.at.get(sub);
  const at = Math.max(apps?.get("*") ?? 0, apps?.get(audience) ?? 0);
  return at > 0 && issuedAt * 1000 <= at;
}

/** What `authorization` says about the caller: a person, or nothing usable (null). */
export async function caller(request: Request, env: AuthEnv, audience = "edit"): Promise<Caller | null> {
  const sent = request.headers.get("authorization") ?? "";
  if (sent === "") return null;
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(sent)?.[1];
  if (token === undefined) return null;
  try {
    const { payload } = await jwtVerify(token, await keysOf(env, decodeProtectedHeader(token).kid), { issuer: issuer(env), audience, clockTolerance: SKEW_SECONDS, algorithms: ["RS256"] });
    if (typeof payload.sub !== "string" || payload.sub === "" || typeof payload.exp !== "number") return null;
    // Signed out by an admin since this token was made: as good as no token (they sign in again, if they still may).
    if (await cutOff(env, payload.sub, typeof payload.iat === "number" ? payload.iat : 0, audience)) return null;
    const perms = Array.isArray(payload.perms) ? payload.perms.filter((one): one is string => typeof one === "string") : [];
    const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
    const found: Caller = { kind: "person", sub: payload.sub, perms, admin: payload.admin === true };
    const name = text(payload.name);
    const email = text(payload.email);
    const picture = text(payload.picture);
    if (name !== undefined) found.name = name;
    if (email !== undefined) found.email = email;
    if (picture !== undefined && picture.startsWith("https://")) found.picture = picture;
    return found;
  } catch (error) {
    if (error instanceof KeysUnread) throw error;
    return null;
  }
}

/**
 * Whether a person may make voice-overs (paid): they come with editing, so an
 * admin or anyone with an `edit.*` capability (manifest.ts), or a channel given
 * to them, whose edits are theirs to make with it (Sphe, Nov 21: "a channel
 * I've given a person access to should be all they need"; a bodycam channel's
 * edit is narrated); subtitles alone don't. Nov 5: a token with no capability
 * ids passed too, kept for tokens from before accounts' contract v2; Edit has
 * been v2 since (accounts' APP_MANIFESTS), so that only let someone given Edit
 * with nothing ticked spend on voices.
 */
export function mayVoice(found: Caller): boolean {
  return found.kind === "person" && (found.admin || found.perms.some((perm) => isEditing(perm) || perm.startsWith("channel.")));
}

/** Who to put in the log line: a person's id, never their token or more than that. */
export function who(found: Caller): string {
  return found.kind === "person" ? found.sub : found.kind;
}

/**
 * The route's gate: the caller, or the response refusing them (401 with no
 * usable token, 403 without the permission). `open` lets a route answer
 * with no token at all (the maps while OPEN_MAPS holds, or a relay with no
 * shared token set, as `wrangler dev` runs).
 */
export async function allow(request: Request, env: AuthEnv, permission: Permission, route: string, open = false, log = true): Promise<Caller | Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), CHECK_MS)));
  const unread = (error: unknown) => {
    if (error instanceof KeysUnread) return "unread" as const;
    throw error;
  };
  const checked = await Promise.race([caller(request, env).catch(unread), late]).finally(() => clearTimeout(timer));
  if (checked === "late" || checked === "unread") {
    console.log(JSON.stringify({ route, ...(checked === "late" ? { late: CHECK_MS } : { keys: "unread" }) }));
    return uncheckable();
  }
  const found = checked;
  const sent = request.headers.get("authorization") ?? "";
  // A bearer that isn't a person's token: an Edit from before signing in (the shared token).
  const stale = sent !== "" && !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sent);
  const result: Caller | Response =
    found === null
      ? open
        ? { kind: "open" }
        : stale
          ? refuse(401, "This Edit is out of date: update it (Edit → Update, or reinstall from github.com/spheceo/edit) and sign in with your Google account.")
          : refuse(401, "Sign in to Edit (this relay answers signed-in people only).")
      : found.kind === "person" && !found.admin && !found.perms.includes(permission)
        ? refuse(403, `Your account can't use this yet: an admin can give you Edit's "${permission}" permission at accounts.spheceo.com.`)
        : found;
  if (log) console.log(JSON.stringify({ route, who: result instanceof Response ? (found === null ? "none" : who(found)) : who(result), ...(result instanceof Response ? { refused: result.status } : {}) }));
  return result;
}

/** The sign-in couldn't be checked (too slow, or the accounts site's keys unread): Edit asks again in a second. */
export function uncheckable(): Response {
  return new Response(JSON.stringify({ error: "The relay couldn't check your sign-in in time; Edit asks again." }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "retry-after": "1" } });
}

function refuse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** The key a caller's budgets are kept under: a person by their id, anyone else by connection (hex, as the budgets want). */
export async function budgetKey(request: Request, found: Caller): Promise<string> {
  const basis = found.kind === "person" ? `person:${found.sub}` : (request.headers.get("cf-connecting-ip") ?? "unknown");
  return Array.from(await sha256(basis), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The rate limiter's key for a caller (a person's id, else the connection). */
export function burstKey(request: Request, found: Caller): string {
  return found.kind === "person" ? `p:${found.sub}` : (request.headers.get("cf-connecting-ip") ?? "unknown");
}

/**
 * What the database is told of who's asking (Nov 4: Convex checks each call's
 * person itself, accounts' convex/access.ts, so the relay isn't the only
 * gate): `caller` added to a forwarded call's args, from the verified token.
 * Only with `CONVEX_CALLER` "1": Convex's validators refuse an argument they
 * don't know, so a deployment without that module must not be sent one (and
 * then not a thumbnail's `workspace` either, which came with it).
 */
export function withCaller(env: { CONVEX_CALLER?: string }, found: Caller, path: string, args: Record<string, unknown>): Record<string, unknown> {
  const { caller: _sent, ...rest } = args;
  if (env.CONVEX_CALLER !== "1") {
    if (path === "thumbnails:commit") delete rest.workspace;
    return rest;
  }
  const caller = found.kind === "person" ? { sub: found.sub, admin: found.admin, perms: found.perms } : { sub: "", admin: false, perms: [] };
  return { ...rest, caller };
}

/** Convex's refusal of a call outside the caller's permissions (`ConvexError` with `{code: "forbidden"}`), as a 403; null for anything else. */
export function forbiddenOf(parsed: unknown): Response | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const answer = parsed as { status?: unknown; errorData?: unknown; errorMessage?: unknown };
  const data = answer.errorData as { code?: unknown; message?: unknown } | null | undefined;
  if (answer.status !== "error" || data?.code !== "forbidden") return null;
  const message = typeof data.message === "string" ? data.message : "That isn't available to your account.";
  return new Response(JSON.stringify({ error: message }), { status: 403, headers: { "content-type": "application/json" } });
}
