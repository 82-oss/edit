// The relay's team Vmake account (relay/src/vmake.ts): a browser on the team's
// Browser Use profile lent to one Mac at a time, the key never leaving the
// relay, its live view only for an admin's sign-in.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readCutOffsWith, useKeys } from "../../../relay/src/auth";
import relay, { TranscriptionBudget, type Env } from "../../../relay/src/index";
import { LEASE_MS, VMAKE_PROFILE } from "../../../relay/src/vmake";

const ISSUER = "https://accounts.example.test";
let privateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});

beforeEach(() => {
  useKeys(createLocalJWKSet({ keys: [jwk] }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  useKeys(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const token = (claims: Record<string, unknown> = {}) =>
  new SignJWT({ email: "jj@example.test", name: "JJ", perms: ["use", "edit.bodycam"], admin: false, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience("edit")
    .setSubject("person-1")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);

/** The relay's environment with a real BUDGET Durable Object over a map. */
function env(extra: Partial<Env> = {}): Env {
  const values = new Map<string, unknown>();
  let chain = Promise.resolve();
  interface Store {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  }
  const storage: Store & { transaction<T>(callback: (store: Store) => Promise<T>): Promise<T>; setAlarm(): Promise<void>; deleteAll(): Promise<void> } = {
    get: async <T,>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void values.set(key, value),
    delete: async (key: string) => values.delete(key),
    transaction: <T,>(callback: (store: Store) => Promise<T>): Promise<T> => {
      const result = chain.then(() => callback(storage));
      chain = result.then(() => {});
      return result;
    },
    setAlarm: async () => {},
    deleteAll: async () => values.clear(),
  };
  const base = { ACCOUNTS_ISSUER: ISSUER, BROWSER_USE_API_KEY: "bu-key", ...extra } as Env;
  const budget = new TranscriptionBudget({ storage } as never, base);
  return { ...base, BUDGET: { idFromName: (name: string) => name, get: () => budget } } as Env;
}

/** Browser Use's stand-in: its calls, and what POST /browsers answers. */
function browserUse(status = 201) {
  const calls: { method: string; url: string; key: string | null; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method: init?.method ?? "GET", url, key: new Headers(init?.headers).get("x-browser-use-api-key"), body });
    if (url.endsWith("/browsers") && status !== 201) return Response.json({ detail: "You need at least $0.01 in credits" }, { status });
    if (url.endsWith("/browsers")) return Response.json({ id: `b${calls.length}aaaaaaaa`, cdpUrl: "https://cdp.example.test/x", liveUrl: "https://live.example.test/x" }, { status: 201 });
    return Response.json({ ok: true });
  });
  return calls;
}

const ask = async (e: Env, path: string, body: unknown = undefined, claims: Record<string, unknown> = {}) => {
  const response = await relay.fetch(new Request(`https://relay.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${await token(claims)}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), e);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("the team's Vmake account on the relay", () => {
  it("lends one Mac at a time a browser on the team's profile, the key never leaving the relay", async () => {
    const e = env();
    const calls = browserUse();
    expect((await ask(e, "/v1/vmake")).body).toEqual({ ready: true, filesToday: 0 });
    // The day's files are the team's: counted here whichever Mac sends one.
    expect((await ask(e, "/v1/vmake/file", { holder: "m4" })).body).toEqual({ filesToday: 1 });
    expect((await ask(e, "/v1/vmake/file", { holder: "kenobi" })).body).toEqual({ filesToday: 2 });
    expect((await ask(e, "/v1/vmake")).body).toEqual({ ready: true, filesToday: 2 });
    const lent = await ask(e, "/v1/vmake/browser", { holder: "kenobi" });
    expect(lent.status).toBe(200);
    expect(lent.body).toEqual({ id: expect.any(String), cdpUrl: "https://cdp.example.test/x" });
    expect(calls[0]).toMatchObject({ method: "POST", key: "bu-key", body: { profileId: VMAKE_PROFILE, proxyCountryCode: null, timeout: 60 } });
    // Another Mac waits; the same Mac's next browser renews its lease.
    expect((await ask(e, "/v1/vmake/browser", { holder: "m4" })).body).toEqual({ busy: "kenobi" });
    expect((await ask(e, "/v1/vmake/browser", { holder: "kenobi" })).body.cdpUrl).toBe("https://cdp.example.test/x");
    // Stopped: the lease let go, the other Mac's turn.
    const id = String(lent.body.id);
    expect((await ask(e, `/v1/vmake/browser/${id}/stop`, { holder: "kenobi" })).body).toEqual({ stopped: true });
    expect(calls.some((one) => one.method === "PATCH" && one.url.endsWith(`/browsers/${id}`))).toBe(true);
    expect((await ask(e, "/v1/vmake/browser", { holder: "m4" })).body.cdpUrl).toBe("https://cdp.example.test/x");
  });

  it("a Mac that died holding the lease loses it once it runs out", async () => {
    const e = env();
    browserUse();
    await ask(e, "/v1/vmake/browser", { holder: "kenobi" });
    const later = Date.now() + LEASE_MS + 1;
    const lease = (holder: string, now: number) => e.BUDGET.get(e.BUDGET.idFromName("vmake")).fetch(new Request("https://budget/vmake-lease", { method: "POST", body: JSON.stringify({ holder, now }) }));
    expect(await (await lease("m4", Date.now())).json()).toMatchObject({ ok: false, holder: "kenobi" });
    expect(await (await lease("m4", later)).json()).toEqual({ ok: true });
  });

  it("its sign-in's live view is an admin's alone; Browser Use's refusals are said as its own; no work, no browser", async () => {
    const e = env();
    browserUse();
    expect((await ask(e, "/v1/vmake/browser", { holder: "kenobi", signIn: true })).status).toBe(403);
    const admin = await ask(e, "/v1/vmake/browser", { holder: "kenobi", signIn: true }, { admin: true });
    expect(admin.body.liveUrl).toBe("https://live.example.test/x");
    expect((await ask(e, "/v1/vmake", undefined, { perms: ["use", "ideas.interrogation"] })).status).toBe(403);
    const poor = env();
    browserUse(402);
    expect(await ask(poor, "/v1/vmake/browser", { holder: "kenobi" })).toEqual({ status: 402, body: { error: "browser_credits" } });
    const unset = env({ BROWSER_USE_API_KEY: undefined });
    expect((await ask(unset, "/v1/vmake")).body).toEqual({ ready: false, filesToday: 0 });
    expect((await ask(unset, "/v1/vmake/browser", { holder: "kenobi" })).status).toBe(503);
  });

  it("the dev relay sends it to the live one with the caller's own sign-in: one lease for dev's Macs and prod's", async () => {
    const live = env();
    const calls = browserUse();
    const passed: string[] = [];
    const dev = env({ BROWSER_USE_API_KEY: undefined, CHANNELS_UPSTREAM: "https://live.relay.test", LIVE_RELAY: { fetch: async (request: Request) => (passed.push(`${request.method} ${new URL(request.url).pathname}`), relay.fetch(request, live)) } });
    expect((await ask(live, "/v1/vmake/browser", { holder: "m4" })).body.cdpUrl).toBe("https://cdp.example.test/x");
    expect((await ask(dev, "/v1/vmake")).body).toEqual({ ready: true, filesToday: 0 });
    expect((await ask(dev, "/v1/vmake/browser", { holder: "mandalorian" })).body).toEqual({ busy: "m4" });
    expect(passed).toEqual(["GET /v1/vmake", "POST /v1/vmake/browser"]);
    expect(calls.filter((one) => one.method === "POST").length).toBe(1);
  });
});
