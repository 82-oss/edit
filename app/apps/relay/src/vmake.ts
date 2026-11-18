// The team's Vmake account on its website (Sphe, Nov 17: "the Vmake account
// and its Browser Use profile are the TEAM's, not per Mac"): Edit takes a
// re-uploader's subtitles and labels out of footage on vmake.ai, driven in a
// Browser Use cloud browser on one profile that holds the team's sign-in
// (text_removal.ts / vmake_web.ts in Edit). Every Browser Use call is made
// here, so no install holds the key; a Mac gets only the DevTools address of
// the one browser it's lent (which drives that browser, nothing more).
//
//   GET  /v1/vmake                        {ready, filesToday}: whether the team's key is here,
//                                         and the files sent to vmake.ai today (UTC), the team's
//   POST /v1/vmake/file {holder}          one more file sent today: {filesToday}
//   POST /v1/vmake/browser {holder, signIn?}
//        a browser on the team's profile, lent to `holder` (a Mac's cloud
//        holder): {id, cdpUrl, liveUrl?} (liveUrl, the page a person can use,
//        only for an admin's sign-in), or {busy: holder} while another Mac
//        has it (one at a time: two browsers on one profile overwrite each
//        other's sign-in when they stop), or {error} said plainly
//   POST /v1/vmake/browser {holder, extra: true}
//        one more browser for the lease's holder, with NO profile (its
//        vmake.ai sign-in copied in by the Mac, never saved anywhere), up to
//        AT_ONCE browsers in all: {id, cdpUrl, extra}, {full}, or {busy}
//   POST /v1/vmake/browser/{id}/stop {holder, extra?}
//        stopped (the profile's own: its sign-in saved into the profile, and
//        the lease let go; an extra one: only counted off)
//
// The lease is kept in the BUDGET Durable Object's "vmake" instance: a holder
// and when it runs out (a browser's hour and a little), renewed by each
// browser the same Mac asks for, let go when it stops one, taken over once it
// runs out (a Mac that died holding it). The key is BROWSER_USE_API_KEY
// (Infisical `/edit-relay`, pushed with scripts/push-secrets.ts), the live
// relay's alone: the dev relay sends these calls there (`liveVmake`), so dev's
// Macs and prod's share the one lease. The profile is the team's one, named here.

export interface VmakeEnv {
  BROWSER_USE_API_KEY?: string;
  BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  /** The dev relay: the live relay's address and binding (live_channels.ts), where the team's account is. */
  CHANNELS_UPSTREAM?: string;
  LIVE_RELAY?: { fetch(request: Request): Promise<Response> };
}

/** The dev relay: the call made on the live relay with the caller's own sign-in, its answer as it came (one lease and one day's files for every Mac). */
export async function liveVmake(request: Request, url: URL, env: VmakeEnv): Promise<Response> {
  const asked = new Request(`${env.CHANNELS_UPSTREAM!.replace(/\/+$/, "")}${url.pathname}`, {
    method: request.method,
    headers: { "content-type": "application/json", authorization: request.headers.get("authorization") ?? "" },
    ...(request.method === "GET" ? {} : { body: await request.text() }),
  });
  const answer = env.LIVE_RELAY !== undefined ? await env.LIVE_RELAY.fetch(asked) : await fetch(asked);
  return new Response(await answer.text(), { status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "application/json" } });
}

/** The team's Browser Use profile, signed in to the team's Vmake Pro account (made Nov 17). */
export const VMAKE_PROFILE = "f95a5dad-bb07-43e8-8c63-5747b18d0f87";
const API = "https://api.browser-use.com/api/v4";
/** A browser's life, minutes (Browser Use takes it all up front and gives back what's unused when it's stopped). */
const BROWSER_MINUTES = 60;
/** The lease: a browser's life and five minutes. */
export const LEASE_MS = (BROWSER_MINUTES + 5) * 60_000;
/**
 * Pieces at once, the team's (Sphe, Nov 17: "3 hours for a 1 hour video is
 * insane"). vmake.ai runs several of the account's jobs at once, but that
 * evening each slowed about as much as there were (four at once: two 15 s
 * test pieces 18 min each against 4 alone that morning, the M4's 227 s 12 min
 * against 7): it looks like one budget for the account, shared. So three:
 * uploads and downloads overlap the processing, no more. One a browser, so each piece's upload is in a
 * tab in front (Chrome slows a tab behind another) and each has a machine of
 * its own: the lease's holder gets its browser on the team's profile and up to
 * AT_ONCE − 1 more that start with NO profile, its vmake.ai sign-in (cookies
 * and the site's local storage) copied in by the Mac, never written back
 * anywhere: only the profile's own browser ever saves it.
 */
export const AT_ONCE = 3;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const vmakeReady = (env: VmakeEnv): boolean => Boolean(env.BROWSER_USE_API_KEY);

/** The lease in the Durable Object (`TranscriptionBudget`'s /vmake-lease). */
export async function vmakeLease(request: Request, storage: { transaction<T>(work: (txn: { get<V>(key: string): Promise<V | undefined>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> }) => Promise<T>): Promise<T> }): Promise<Response> {
  const given = (await request.json()) as { holder?: string; release?: boolean; now?: number; day?: string; count?: boolean; extra?: "take" | "name" | "drop"; token?: string; id?: string };
  const holder = typeof given.holder === "string" ? given.holder : "";
  const now = typeof given.now === "number" ? given.now : Date.now();
  const answer = await storage.transaction(async (txn) => {
    // The day's files (the team's Vmake plan allows so many a day): counted, or read.
    if (typeof given.day === "string") {
      const key = `files:${given.day}`;
      const used = ((await txn.get<number>(key)) ?? 0) + (given.count === true ? 1 : 0);
      if (given.count === true) await txn.put(key, used);
      return { filesToday: used };
    }
    const lease = await txn.get<{ holder: string; until: number }>("lease");
    // The holder's extra browsers (no profile): counted, capped, each until its life runs out (a Mac that died with them).
    if (given.extra !== undefined) {
      const extras = Object.fromEntries(Object.entries((await txn.get<Record<string, number>>("extras")) ?? {}).filter(([, until]) => until > now));
      const token = typeof given.token === "string" ? given.token : "";
      if (given.extra === "take") {
        if (lease === undefined || lease.holder !== holder || lease.until <= now) return { ok: false, holder: lease?.holder ?? null };
        if (Object.keys(extras).length >= AT_ONCE - 1) return { ok: false, full: true };
        extras[token] = now + LEASE_MS;
      } else if (given.extra === "name" && extras[token] !== undefined && typeof given.id === "string") {
        extras[given.id] = extras[token]!;
        delete extras[token];
      } else if (given.extra === "drop") delete extras[typeof given.id === "string" ? given.id : token];
      await txn.put("extras", extras);
      return { ok: true, extras: Object.keys(extras).length };
    }
    if (given.release === true) {
      if (lease?.holder === holder) await txn.delete("lease");
      return { ok: true };
    }
    if (lease !== undefined && lease.holder !== holder && lease.until > now) return { ok: false, holder: lease.holder, until: lease.until };
    await txn.put("lease", { holder, until: now + LEASE_MS });
    return { ok: true };
  });
  return json(200, answer);
}

async function lease(env: VmakeEnv, body: Record<string, unknown>): Promise<{ ok: boolean; holder?: string; filesToday?: number; full?: boolean; extras?: number }> {
  const budget = env.BUDGET.get(env.BUDGET.idFromName("vmake"));
  return (await (await budget.fetch(new Request("https://budget/vmake-lease", { method: "POST", body: JSON.stringify(body) }))).json()) as { ok: boolean; holder?: string; filesToday?: number; full?: boolean; extras?: number };
}

/** Browser Use's answer to a new browser, said as the Mac reads it (null: made). */
function refused(made: { status: number; data: Record<string, unknown> }): Response | null {
  if (made.status === 402) return json(402, { error: "browser_credits" });
  if (made.status === 401 || made.status === 403) return json(502, { error: "browser_key" });
  if (made.status === 429) return json(200, { busy: "Browser Use (too many browsers at once)" });
  if (made.status >= 300 || typeof made.data.id !== "string" || typeof made.data.cdpUrl !== "string") return json(502, { error: `Browser Use: ${made.status}` });
  return null;
}

const today = () => new Date().toISOString().slice(0, 10);

async function browserUse(env: VmakeEnv, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${API}${path}`, { method, headers: { "X-Browser-Use-API-Key": env.BROWSER_USE_API_KEY!, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    data = { detail: text.slice(0, 200) };
  }
  return { status: response.status, data };
}

/** The routes under /v1/vmake, for someone already let in (`admin`: whether they may sign the team's profile in). */
export async function vmakeRoute(request: Request, url: URL, env: VmakeEnv, admin: boolean): Promise<Response> {
  if (url.pathname === "/v1/vmake" && request.method === "GET") return json(200, { ready: vmakeReady(env), filesToday: vmakeReady(env) ? ((await lease(env, { day: today() })).filesToday ?? 0) : 0, atOnce: AT_ONCE });
  if (!vmakeReady(env)) return json(503, { error: "The team's Vmake account isn't set up on Edit's relay." });
  const body = (await request.json().catch(() => ({}))) as { holder?: unknown; signIn?: unknown; extra?: unknown };
  const holder = typeof body.holder === "string" ? body.holder.slice(0, 200) : "";
  if (holder === "") return json(400, { error: "holder" });
  if (url.pathname === "/v1/vmake/file" && request.method === "POST") return json(200, { filesToday: (await lease(env, { day: today(), count: true })).filesToday ?? 0 });
  if (url.pathname === "/v1/vmake/browser" && request.method === "POST" && body.extra === true) {
    // One more browser for the lease's holder, with no profile (the Mac copies the sign-in in): counted against AT_ONCE.
    const token = `pending-${crypto.randomUUID()}`;
    const room = await lease(env, { holder, extra: "take", token });
    if (!room.ok) return json(200, room.full === true ? { full: true } : { busy: room.holder ?? "another Mac" });
    const made = await browserUse(env, "POST", "/browsers", { profileId: null, proxyCountryCode: null, timeout: BROWSER_MINUTES });
    const no = refused(made);
    if (no !== null) {
      await lease(env, { holder, extra: "drop", token });
      return no;
    }
    await lease(env, { holder, extra: "name", token, id: made.data.id });
    return json(200, { id: made.data.id, cdpUrl: made.data.cdpUrl, extra: true });
  }
  if (url.pathname === "/v1/vmake/browser" && request.method === "POST") {
    const signIn = body.signIn === true;
    if (signIn && !admin) return json(403, { error: "Only an admin signs the team's Vmake account in." });
    const held = await lease(env, { holder });
    if (!held.ok) return json(200, { busy: held.holder ?? "another Mac" });
    const made = await browserUse(env, "POST", "/browsers", { profileId: VMAKE_PROFILE, proxyCountryCode: null, timeout: BROWSER_MINUTES });
    const no = refused(made);
    if (no !== null) return no;
    return json(200, { id: made.data.id, cdpUrl: made.data.cdpUrl, ...(signIn && typeof made.data.liveUrl === "string" ? { liveUrl: made.data.liveUrl } : {}) });
  }
  const stop = /^\/v1\/vmake\/browser\/([0-9a-f-]{8,64})\/stop$/.exec(url.pathname);
  if (stop !== null && request.method === "POST") {
    await browserUse(env, "PATCH", `/browsers/${stop[1]}`, { action: "stop" });
    // An extra one's stop leaves the lease as it is (the holder's own browser may still be working).
    if (body.extra === true) await lease(env, { holder, extra: "drop", id: stop[1] });
    else await lease(env, { holder, release: true });
    return json(200, { stopped: true });
  }
  return json(404, { error: "no such route" });
}
