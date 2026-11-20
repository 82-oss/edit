// accounts.ts's tests: signing in to Edit (PKCE through the loopback), renewing, signing out,
// against a stand-in for accounts.spheceo.com's /app/* (its plan's contract).

import { afterAll, afterEach, beforeAll, expect, onTestFinished, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { Duration, Effect, Schedule } from "effect";

import * as accounts from "../src/accounts.ts";
import * as keychain from "../src/keychain.ts";
import type { App } from "../src/app.ts";
import * as relay from "../src/relay.ts";
import { baseRouter, respond } from "../src/http/server.ts";
import * as windowFocus from "../src/window_focus.ts";
import { fixtureHome } from "./helpers/home.ts";

// The relay every test file asks unless it brings its own: the closed port test/setup.ts names. Put back, never
// unset: unset, each later file in the same run asked the live relay (its pyannote flag sent a captions test to
// Scribe on Linux, where this file runs before that one: Check red from Nov 9).
const RELAY_BEFORE = process.env.EDIT_RELAY_URL;
function relayBack(): void {
  if (RELAY_BEFORE === undefined) delete process.env.EDIT_RELAY_URL;
  else process.env.EDIT_RELAY_URL = RELAY_BEFORE;
}

let roots = 0;
let rootRefused = false;
const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-accounts-"));
// The store's events as the server's: what the pages are told (an `account` event when a sign-in lands).
const listeners = new Set<(event: Record<string, unknown>) => void>();
const app = {
  store: {
    home: join(dir, "home"),
    emit: (event: Record<string, unknown>) => listeners.forEach((listener) => listener(event)),
    subscribe: (listener: (event: Record<string, unknown>) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
  },
  port: 7799,
} as unknown as App;
const challenges = new Map<string, string>();
const seen: { path: string; body: Record<string, string> }[] = [];
let refreshes = 0;
/** The token the stand-in relay's cut-off refuses (the first it saw). */
let cutOff: string | null = null;
const devices: string[] = [];
const polls = new Map<string, number>();
/** What the site answers each poll of a device sign-in, in turn ("ok" signs in). */
let deviceScript: string[] = [];
let deviceExpires = 600;
let server: ReturnType<typeof Bun.serve>;

/** An access token as the site makes one (its signature isn't checked here: the relay does that). */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", kid: "k1" })}.${part({ iss: "https://accounts.test", aud: "edit", sub: "person-1", exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.c2ln`;
}

beforeAll(() => {
  process.env.EDIT_KEYCHAIN_FILE = join(dir, "keychain.json");
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json().catch(() => ({}))) as Record<string, string>;
      seen.push({ path: url.pathname, body });
      if (url.pathname.startsWith("/app/") && !/^Edit\/\S+ \((macOS|Linux)(; [a-z ]+)?\)$/u.test(request.headers.get("user-agent") ?? "")) return Response.json({ error: "no user agent" }, { status: 400 });
      if (url.pathname === "/app/revoke") return revokeBusy-- > 0 ? Response.json({ error: "slow_down" }, { status: 429, headers: { "retry-after": "0" } }) : Response.json({});
      if (url.pathname === "/app/device") {
        devices.push(request.headers.get("user-agent") ?? "");
        const code = `dev-${devices.length}`;
        polls.set(code, 0);
        return Response.json({ device_code: code, user_code: "BCDF-GHJK", verification_uri: "https://accounts.test/device", verification_uri_complete: "https://accounts.test/device?code=BCDF-GHJK", expires_in: deviceExpires, interval: 0.02 });
      }
      // Standing in for the relay too: a cut-off refuses the first token it sees, as a token made before it.
      if (url.pathname === "/v1/test/cut-off") {
        const bearer = request.headers.get("authorization");
        cutOff ??= bearer;
        return bearer === cutOff ? Response.json({ error: "Sign in to Edit" }, { status: 401 }) : Response.json({ ok: true });
      }
      // Standing in for the relay too: the token a call carried.
      if (url.pathname === "/v1/test/bearer") return Response.json({ bearer: request.headers.get("authorization") });
      // Standing in for the relay too: a map session's root (each a new session, as Google bills them), and what a tile request carried.
      if (url.pathname === "/v1/3dtiles/root.json") {
        roots += 1;
        if (rootRefused) return Response.json({ error: "Today's maps are used up." }, { status: 429 });
        return Response.json({ root: { children: [{ content: { uri: `/v1/3dtiles/datasets/x/files/y.glb?session=s${roots}` } }] } });
      }
      if (url.pathname.startsWith("/v1/3dtiles/")) return Response.json({ bearer: request.headers.get("authorization"), query: url.search }, { headers: { "cache-control": "max-age=60" } });
      if (url.pathname !== "/app/token") return new Response("not found", { status: 404 });
      if (body.client_id !== "edit") return Response.json({ error: "invalid_client" }, { status: 400 });
      if (body.grant_type === "authorization_code") {
        const challenge = challenges.get(body.code ?? "");
        const sent = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
        if (challenge === undefined || challenge !== sent || body.redirect_uri !== "http://127.0.0.1:7799/callback") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: jwt({ perms: ["use", "cloud"], email: "someone@gmail.com", name: "Some One", picture: "https://lh3.googleusercontent.com/a/someone=s96-c" }), token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1-aaaaaaaa", user: { email: "someone@gmail.com", name: "Someone", image: null } });
      }
      if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        const n = (polls.get(body.device_code ?? "") ?? 0) + 1;
        polls.set(body.device_code ?? "", n);
        const script = deviceScript[n - 1] ?? "ok";
        if (script === "ok") return Response.json({ access_token: jwt({ perms: ["use"], email: "someone@gmail.com" }), token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-device-aaaaaaaa", user: { email: "someone@gmail.com", name: "Someone", image: null } });
        return Response.json({ error: script }, { status: 400 });
      }
      if (body.grant_type === "refresh_token") {
        if (body.refresh_token === "dead-token-aaaaaaaa") return Response.json({ error: "invalid_grant", error_description: "Signed out elsewhere." }, { status: 400 });
        if (body.refresh_token === "busy-token-aaaaaaaa") return Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { "retry-after": "60" } });
        if (body.refresh_token === "slow-token-aaaaaaaa") return Bun.sleep(1500).then(() => Response.json({ error: "too late" }));
        if (body.refresh_token === "odd-token-aaaaaaaa") return Response.json({ hello: "there" });
        if (body.refresh_token === "down-token-aaaaaaaa") return new Response("<html>502 Bad Gateway</html>", { status: 502 });

        refreshes += 1;
        return Response.json({ access_token: jwt({ perms: ["use"], email: "someone@gmail.com", n: refreshes }), token_type: "Bearer", expires_in: 3600, refresh_token: `refresh-${refreshes + 1}-aaaaaaaa`, user: { email: "someone@gmail.com", name: "Someone", image: null } });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    },
  });
  process.env.EDIT_ACCOUNTS_URL = `http://127.0.0.1:${server.port}`;
});

let revokeBusy = 0;
/** The next connection to the site closes as its request comes in (a Mac just awake); then it's passed through. */
let dropNext = false;

/** The accounts site behind a proxy that closes a connection when told to (`dropNext`), the way a dead one fails. */
function dropping(): { url: string; stop: () => void } {
  const proxy = Bun.listen<{ upstream: Promise<import("bun").Socket<undefined>> | null }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { upstream: null };
      },
      data(socket, chunk) {
        if (socket.data.upstream === null) {
          if (dropNext) {
            dropNext = false;
            socket.end();
            return;
          }
          socket.data.upstream = Bun.connect({ hostname: "127.0.0.1", port: server.port!, socket: { data: (_up, back) => void socket.write(back), close: () => void socket.end() } });
        }
        const bytes = new Uint8Array(chunk);
        void socket.data.upstream.then((up) => up.write(bytes));
      },
      close(socket) {
        void socket.data.upstream?.then((up) => up.end());
      },
    },
  });
  return { url: `http://127.0.0.1:${proxy.port}`, stop: () => proxy.stop(true) };
}

afterEach(() => accounts.resetForTests());
afterAll(() => {
  void server.stop(true);
  delete process.env.EDIT_KEYCHAIN_FILE;
  delete process.env.EDIT_ACCOUNTS_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

const kept = () => JSON.parse(fs.readFileSync(join(dir, "keychain.json"), "utf8")) as Record<string, string>;

test("signs in with PKCE through the loopback, keeps the refresh token in the keychain, and the relay sends the person's token", async () => {
  const authorize = new URL(accounts.begin(app));
  expect(authorize.pathname).toBe("/app/authorize");
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: "edit", redirect_uri: "http://127.0.0.1:7799/callback", code_challenge_method: "S256", response_type: "code" });
  // The site keeps the challenge with the code it hands out.
  challenges.set("code-1", authorize.searchParams.get("code_challenge")!);
  // Someone else's callback (another state) is turned away.
  expect((await accounts.finish(app, new URLSearchParams({ code: "code-1", state: "wrong" }))).ok).toBe(false);
  accounts.begin(app);
  const again = new URL(accounts.begin(app));
  challenges.set("code-2", again.searchParams.get("code_challenge")!);
  const done = await accounts.finish(app, new URLSearchParams({ code: "code-2", state: again.searchParams.get("state")! }));
  expect(done).toEqual({ ok: true, message: "Signed in as someone@gmail.com." });
  expect(accounts.status()).toMatchObject({ signed_in: true, person: { email: "someone@gmail.com", name: "Someone" }, perms: ["use", "cloud"] });
  expect(Object.values(kept())).toEqual(["refresh-1-aaaaaaaa"]);
  expect(await relay.token()).toBe(accounts.accessToken());
  expect((await relay.signedHeaders()).authorization).toMatch(/^Bearer eyJ/);
});

test.skipIf(process.platform === "darwin")("off macOS the sign-in is kept in the Edit home's sign-in.json, mode 600, one entry per home", async () => {
  const given = process.env.EDIT_KEYCHAIN_FILE;
  delete process.env.EDIT_KEYCHAIN_FILE;
  const home = join(dir, "linux-home");
  try {
    expect(await keychain.get(home)).toBeNull();
    await keychain.set(home, "refresh-token-1");
    await keychain.set(join(dir, "other-home"), "refresh-token-2");
    await keychain.set(home, "refresh-token-3");
    const path = join(home, "sign-in.json");
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(await keychain.get(home)).toBe("refresh-token-3");
    expect(fs.readdirSync(home)).toEqual(["sign-in.json"]);
    await keychain.remove(home);
    expect(await keychain.get(home)).toBeNull();
  } finally {
    process.env.EDIT_KEYCHAIN_FILE = given;
  }
});

test("renews with the kept refresh token and keeps the rotated one; a refused one signs out", async () => {
  await accounts.renew(app.store.home);
  expect(accounts.status()).toMatchObject({ signed_in: true, perms: ["use"] });
  expect(Object.values(kept())).toEqual(["refresh-2-aaaaaaaa"]);
  // Two renewals at once are one request (a refresh token rotates on use).
  const before = seen.length;
  await Promise.all([accounts.renew(app.store.home), accounts.renew(app.store.home)]);
  expect(seen.length - before).toBe(1);
  // The site's per-minute limit (429): still signed in, the refresh token kept, tried again later.
  const keep = Object.keys(kept());
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify(Object.fromEntries(keep.map((key) => [key, "busy-token-aaaaaaaa"]))));
  await accounts.renew(app.store.home);
  expect(accounts.status()).toMatchObject({ signed_in: true });
  expect(Object.values(kept())).toEqual(["busy-token-aaaaaaaa"]);
  // Refused: signed out, the token forgotten, the shared token back for the relay.
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify(Object.fromEntries(Object.keys(kept()).map((key) => [key, "dead-token-aaaaaaaa"]))));
  await accounts.renew(app.store.home);
  expect(accounts.status()).toMatchObject({ signed_in: false, problem: "Signed out elsewhere." });
  expect(Object.values(kept())).toEqual([]);
  expect(await relay.token()).toBe(relay.envToken());
});

test("signing out revokes the refresh token there and forgets it here", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const authorize = new URL(accounts.begin(app));
  challenges.set("code-3", authorize.searchParams.get("code_challenge")!);
  await accounts.finish(app, new URLSearchParams({ code: "code-3", state: authorize.searchParams.get("state")! }));
  await accounts.signOut(app);
  expect(seen.at(-1)).toEqual({ path: "/app/revoke", body: { token: "refresh-1-aaaaaaaa" } });
  expect(accounts.status()).toMatchObject({ signed_in: false, person: null });
  expect(Object.values(kept())).toEqual([]);
});

test("session observers see sign-in and sign-out and can unsubscribe", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const owners: (string | null)[] = [];
  const unsubscribe = accounts.onSessionChange(() => owners.push(accounts.creator()?.sub ?? null));
  try {
    const authorize = new URL(accounts.begin(app));
    challenges.set("observer-code", authorize.searchParams.get("code_challenge")!);
    await accounts.finish(app, new URLSearchParams({ code: "observer-code", state: authorize.searchParams.get("state")! }));
    await accounts.signOut(app);
    expect(owners).toEqual(["person-1", null]);
    unsubscribe();
    accounts.resetForTests();
    expect(owners).toHaveLength(2);
  } finally { unsubscribe(); }
});

test("observers are told a sign-in only where there was no good token: routine renewals are \"renewed\", a token after one ran out or was refused is \"signed-in\" (Nov 20)", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const told: accounts.SessionChange[] = [];
  const unsubscribe = accounts.onSessionChange((what) => told.push(what));
  try {
    const authorize = new URL(accounts.begin(app));
    challenges.set("change-code", authorize.searchParams.get("code_challenge")!);
    await accounts.finish(app, new URLSearchParams({ code: "change-code", state: authorize.searchParams.get("state")! }));
    // Five routine renewals while the token is still good: what serve.ts wakes waiting work on never comes.
    for (let n = 0; n < 5; n++) await accounts.renew(app.store.home);
    expect(told).toEqual(["signed-in", "renewed", "renewed", "renewed", "renewed", "renewed"]);
    // The token ran out (a Mac's sleep): the next one is a sign-in where there was none good.
    accounts.expireForTests(0);
    await accounts.renew(app.store.home);
    expect(told.at(-1)).toBe("signed-in");
    // The relay refused the one held: the token after it is a sign-in too.
    expect(await accounts.renewRefused(accounts.accessToken())).toBe(true);
    expect(told.at(-1)).toBe("signed-in");
    await accounts.signOut(app);
    expect(told.at(-1)).toBe("signed-out");
    expect(told.filter((what) => what === "signed-in")).toHaveLength(3);
  } finally {
    unsubscribe();
  }
});

test("a refusal from the site (not on the list) is said, not signed in", async () => {
  const authorize = new URL(accounts.begin(app));
  const done = await accounts.finish(app, new URLSearchParams({ error: "access_denied", error_description: "Ask an admin to add you.", state: authorize.searchParams.get("state")! }));
  expect(done).toEqual({ ok: false, message: "Ask an admin to add you." });
  expect(accounts.status()).toMatchObject({ signed_in: false, problem: "Ask an admin to add you." });
});

test("the map page's tiles go through Edit's server to the relay with the person's token", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const authorize = new URL(accounts.begin(app));
  challenges.set("code-4", authorize.searchParams.get("code_challenge")!);
  await accounts.finish(app, new URLSearchParams({ code: "code-4", state: authorize.searchParams.get("state")! }));
  process.env.EDIT_RELAY_URL = process.env.EDIT_ACCOUNTS_URL;
  try {
    const asked = new URL("http://127.0.0.1:7799/v1/3dtiles/datasets/x/files/y.glb?session=s1");
    const answer = await relay.forwardTiles(new Request(asked.toString()), asked);
    expect(answer.headers.get("cache-control")).toBe("max-age=60");
    expect(await answer.json()).toEqual({ bearer: `Bearer ${accounts.accessToken()}`, query: "?session=s1" });
  } finally {
    relayBack();
  }
});

test("every map shares one session for two hours: one root asked of the relay (one paid session), however many maps open", async () => {
  // Sphe, Nov 12: a root starts a session good for three hours of tiles; each map page asking its own was a paid one each time.
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const authorize = new URL(accounts.begin(app));
  challenges.set("code-5", authorize.searchParams.get("code_challenge")!);
  await accounts.finish(app, new URLSearchParams({ code: "code-5", state: authorize.searchParams.get("state")! }));
  process.env.EDIT_RELAY_URL = process.env.EDIT_ACCOUNTS_URL;
  relay.forgetMapSession();
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    const root = new URL("http://127.0.0.1:7799/v1/3dtiles/root.json?key=relay");
    const ask = () => relay.forwardTiles(new Request(root.toString(), { headers: { origin: "null" } }), root);
    roots = 0;
    // A refusal is passed on and not kept.
    rootRefused = true;
    const refused = await ask();
    expect(refused.status).toBe(429);
    expect(roots).toBe(1);
    rootRefused = false;
    // Five maps at once, then more within the two hours: one root, the same session for each.
    const first = await Promise.all([1, 2, 3, 4, 5].map(() => ask()));
    expect(roots).toBe(2);
    const said = await Promise.all(first.map((answer) => answer.text()));
    expect(new Set(said).size).toBe(1);
    expect(said[0]).toContain("session=s2");
    expect(first[0]!.headers.get("access-control-allow-origin")).toBe("null");
    now += relay.SHARED_SESSION_MS - 60_000;
    expect(await (await ask()).text()).toContain("session=s2");
    expect(roots).toBe(2);
    // Past two hours, the next map opens a new one (an hour of it left at least for any map opened on the old).
    now += 120_000;
    expect(await (await ask()).text()).toContain("session=s3");
    expect(roots).toBe(3);
  } finally {
    Date.now = real;
    relay.forgetMapSession();
    relayBack();
  }
});

test("a device sign-in (headless, over Tailscale): a code to type, polled through pending and slow_down until it's approved", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  deviceScript = ["authorization_pending", "slow_down", "authorization_pending", "ok"];
  // slow_down adds 50 ms to the wait here, not Edit's 5 s.
  const was = accounts.devicePace.slowDownMs;
  accounts.devicePace.slowDownMs = 50;
  onTestFinished(() => void (accounts.devicePace.slowDownMs = was));
  const device = await accounts.beginDevice(app, "edit serve");
  expect([device.userCode, device.uri, device.complete]).toEqual(["BCDF-GHJK", "https://accounts.test/device", "https://accounts.test/device?code=BCDF-GHJK"]);
  expect(devices.at(-1)).toMatch(/^Edit\/\S+ \((macOS|Linux); edit serve\)$/u);
  expect(accounts.status()).toMatchObject({ signing_in: true, device: { user_code: "BCDF-GHJK" } });
  // A second ask while it waits is the same code.
  expect((await accounts.beginDevice(app, "edit serve")).userCode).toBe("BCDF-GHJK");
  expect(devices.length).toBe(1);
  // Every open page is told when it lands, wherever it was begun (Nov 1: a page left it showing as waiting until reloaded).
  const told: Record<string, unknown>[] = [];
  const listen = app.store.subscribe((event) => void (event.type === "account" && told.push(event)));
  await accounts.devicePolling();
  listen();
  expect(accounts.status()).toMatchObject({ signed_in: true, device: null, person: { email: "someone@gmail.com" } });
  expect(told).toEqual([{ type: "account", account: expect.objectContaining({ signed_in: true, signing_in: false }) }]);
  expect(Object.values(kept())).toEqual(["refresh-device-aaaaaaaa"]);
}, 20_000);

test("a device sign-in turned down or run out stops and says so", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  deviceScript = ["authorization_pending", "access_denied"];
  await accounts.beginDevice(app, "remote");
  expect(devices.at(-1)).toMatch(/; remote\)$/u);
  const told: Record<string, unknown>[] = [];
  const listen = app.store.subscribe((event) => void (event.type === "account" && told.push(event)));
  await accounts.devicePolling();
  listen();
  expect(accounts.status()).toMatchObject({ signed_in: false, device: null, signing_in: false });
  expect(String(accounts.status().problem)).toContain("turned down");
  expect(told).toEqual([{ type: "account", account: expect.objectContaining({ signed_in: false, signing_in: false, problem: expect.stringContaining("turned down") }) }]);
  accounts.resetForTests();
  deviceScript = ["expired_token"];
  await accounts.beginDevice(app, "remote");
  await accounts.devicePolling();
  expect(String(accounts.status().problem)).toContain("ran out");
});

test("the browser lands on a calm page: the code out of the address bar, Edit's window asked to the front, the tab closed if it may be", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const routes = baseRouter();
  accounts.routes(routes);
  const host = { ...app, allowedHosts: ["127.0.0.1"] } as unknown as App;
  const visit = async (code: string) => {
    const authorize = new URL(accounts.begin(app));
    challenges.set(code, authorize.searchParams.get("code_challenge")!);
    const request = new Request(`http://127.0.0.1:7799/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
      headers: { host: "127.0.0.1:7799", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
    });
    return (await respond(host, routes, request, null))!;
  };
  // Edit's window is open (it's polling): it's told to come forward, and the tab tries to close.
  const polled = windowFocus.next(5_000);
  const page = await (await visit("code-5")).text();
  expect((await polled).focus).toBe(true);
  expect(page).toContain(`history.replaceState(null, "", "/callback")`);
  expect(page).toContain("Signed in as someone@gmail.com. Back to Edit…");
  expect(page).toContain(`<a href="/">Open Edit</a>`);
  expect(page).toContain("window.close()");
  // Headless (no window asking): the button, no close.
  windowFocus.resetForTests();
  await accounts.signOut(app);
  const headless = await (await visit("code-6")).text();
  expect(headless).toContain("You can go back to Edit.");
  expect(headless).not.toContain("window.close()");
});

test("a project made while signed in records who started it; signed out, nobody", async () => {
  const fixture = fixtureHome("accounts-creator");
  try {
    fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
    const authorize = new URL(accounts.begin(app));
    challenges.set("code-4", authorize.searchParams.get("code_challenge")!);
    await accounts.finish(app, new URLSearchParams({ code: "code-4", state: authorize.searchParams.get("state")! }));
    const by = { sub: "person-1", name: "Someone", picture: "https://lh3.googleusercontent.com/a/someone=s96-c" };
    expect(accounts.creator()).toEqual(by);
    const made = fixture.store.createAs("Trial", "bodycam", { width: 1920, height: 1080, fps: 30 });
    expect(made.project.created_by).toEqual(by);
    expect(fixture.store.list().find((one) => one.id === made.project.id)?.created_by).toEqual(by);
    await accounts.signOut(app);
    expect(accounts.creator()).toBeNull();
    expect(fixture.store.createAs("Later", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.created_by).toBeUndefined();
    // Still the first project's, signed out or not.
    expect(fixture.store.get(made.project.id)?.project.created_by).toEqual(by);
  } finally {
    fixture.cleanup();
  }
});

test("a token the relay refuses (a cut-off made after it) is renewed once and the call sent again", async () => {
  const authorize = new URL(accounts.begin(app));
  challenges.set("code-cut", authorize.searchParams.get("code_challenge")!);
  expect((await accounts.finish(app, new URLSearchParams({ code: "code-cut", state: authorize.searchParams.get("state")! }))).ok).toBe(true);
  process.env.EDIT_RELAY_URL = process.env.EDIT_ACCOUNTS_URL;
  try {
    const before = accounts.accessToken();
    expect(await relay.json("GET", "/v1/test/cut-off", null, "the test", 5)).toEqual({ ok: true });
    expect(cutOff).toBe(`Bearer ${before}`);
    expect(accounts.accessToken()).not.toBe(before);
    // Refused again within the minute: no second renewal, the refusal said.
    cutOff = `Bearer ${accounts.accessToken()}`;
    const renewals = refreshes;
    await expect(relay.json("GET", "/v1/test/cut-off", null, "the test", 5)).rejects.toThrow(/401/u);
    expect(refreshes).toBe(renewals);
  } finally {
    relayBack();
  }
});

test("a failed renewal is asked again three times 15 s apart, inside the site's 60 s grace, then each minute; a Retry-After is waited instead", async () => {
  const delays = await Effect.runPromise(
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(accounts.renewalRetries);
      const out: number[] = [];
      const offline = new accounts.RenewalFailed({ message: "offline" });
      for (let attempt = 0; attempt < 5; attempt += 1) out.push(Duration.toSeconds((yield* step(attempt * 1000, offline))[1]));
      // The per-minute limit (429) says how long.
      out.push(Duration.toSeconds((yield* step(6000, new accounts.AccountsSaidLater({ status: 429, retryAfterMs: 90_000, message: "busy" })))[1]));
      return out;
    }),
  );
  expect(delays).toEqual([15, 15, 15, 60, 60, 90]);
});

test("the accounts site's bad days keep the sign-in: too slow, a 200 with no tokens, a 502 page; each said, none signing out", async () => {
  const before = accounts.ACCOUNTS_MS.value;
  accounts.ACCOUNTS_MS.value = 300;
  try {
    // Signed in first, with a good token.
    const begun = new URL(accounts.begin(app));
    challenges.set("code-bad-days", begun.searchParams.get("code_challenge")!);
    expect((await accounts.finish(app, new URLSearchParams({ code: "code-bad-days", state: begun.searchParams.get("state")! }))).ok).toBe(true);
    const keep = Object.keys(kept());
    for (const [token, said] of [
      ["slow-token-aaaaaaaa", "didn't answer within"],
      ["odd-token-aaaaaaaa", "had no tokens"],
      ["down-token-aaaaaaaa", "502"],
    ] as const) {
      fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify(Object.fromEntries(keep.map((key) => [key, token]))));
      await accounts.renew(app.store.home);
      expect([token, accounts.status().signed_in]).toEqual([token, true]);
      expect(String(accounts.status().problem)).toContain(said);
      expect(Object.values(kept())).toEqual([token]);
    }
  } finally {
    accounts.ACCOUNTS_MS.value = before;
  }
});

test("a sign-out the site's limit refuses (429) is revoked again after its Retry-After, in the background", async () => {
  const begun = new URL(accounts.begin(app));
  challenges.set("code-revoke", begun.searchParams.get("code_challenge")!);
  expect((await accounts.finish(app, new URLSearchParams({ code: "code-revoke", state: begun.searchParams.get("state")! }))).ok).toBe(true);
  revokeBusy = 1;
  const from = seen.length;
  await accounts.signOut(app);
  expect(accounts.status().signed_in).toBe(false);
  for (let i = 0; i < 100 && seen.slice(from).filter((one) => one.path === "/app/revoke").length < 2; i++) await Bun.sleep(10);
  expect(seen.slice(from).filter((one) => one.path === "/app/revoke").length).toBe(2);
});

test("a cloud call made while the kept sign-in is restored at start waits for its token instead of going without one", async () => {
  await keychain.set(app.store.home, "refresh-start-aaaaaaaa");
  process.env.EDIT_RELAY_URL = process.env.EDIT_ACCOUNTS_URL;
  process.env.EDIT_TRIALS = "1";
  try {
    // As after an update: the server starts, and the page's first cloud call comes in the same moment.
    const starting = accounts.start(app);
    const answer = await relay.json<{ bearer: string | null }>("GET", "/v1/test/bearer", null, "the test", 5);
    await starting;
    expect(answer.bearer).toBe(`Bearer ${accounts.accessToken()}`);
  } finally {
    relayBack();
    delete process.env.EDIT_TRIALS;
  }
});

test("after a sleep every call waits on the one renewal, whose closed connection is asked again at once: none goes without a token", async () => {
  await keychain.set(app.store.home, "wake-token-aaaaaaaa");
  process.env.EDIT_RELAY_URL = process.env.EDIT_ACCOUNTS_URL;
  const site = process.env.EDIT_ACCOUNTS_URL;
  const proxy = dropping();
  process.env.EDIT_ACCOUNTS_URL = proxy.url;
  process.env.EDIT_TRIALS = "1";
  try {
    await accounts.start(app);
    expect(accounts.status().signed_in).toBe(true);
    // Asleep past the token's hour (Marc's Mac, Nov 18): it ran out, and the renewal's first connection is dead.
    accounts.expireForTests();
    dropNext = true;
    const from = seen.length;
    const answers = await Promise.all(Array.from({ length: 6 }, () => relay.json<{ bearer: string | null }>("GET", "/v1/test/bearer", null, "the test", 5)));
    const token = accounts.accessToken();
    expect(token).not.toBeNull();
    expect(answers.map((answer) => answer.bearer)).toEqual(Array(6).fill(`Bearer ${token}`));
    // One renewal: its try dropped on the way (it never reached the site) and the one asked at once.
    expect(dropNext).toBe(false);
    expect(seen.slice(from).filter((one) => one.path === "/app/token").length).toBe(1);
    expect(accounts.status().problem).toBeNull();
  } finally {
    dropNext = false;
    process.env.EDIT_ACCOUNTS_URL = site;
    proxy.stop();
    relayBack();
    delete process.env.EDIT_TRIALS;
  }
});

test("a call while the renewal is still failing after the wait doesn't go: it couldn't reach the relay, never \"Sign in to Edit\"", async () => {
  const before = { accounts: accounts.ACCOUNTS_MS.value, wait: accounts.TOKEN_WAIT_MS.value };
  process.env.EDIT_RELAY_URL = process.env.EDIT_ACCOUNTS_URL;
  process.env.EDIT_TRIALS = "1";
  try {
    await keychain.set(app.store.home, "wake-token-aaaaaaaa");
    await accounts.start(app);
    accounts.ACCOUNTS_MS.value = 300;
    accounts.TOKEN_WAIT_MS.value = 100;
    await keychain.set(app.store.home, "slow-token-aaaaaaaa");
    accounts.expireForTests();
    const from = seen.length;
    const error = await relay.json("GET", "/v1/test/bearer", null, "the test", 5).then(() => null, (failure: unknown) => failure);
    expect(String(error)).toContain(relay.UNREACHABLE);
    expect(String(error)).not.toContain("401");
    // Nothing went to the relay without a token.
    expect(seen.slice(from).filter((one) => one.path === "/v1/test/bearer").length).toBe(0);
    expect(accounts.renewalUnderWay()).toBe(true);
    // Still signed in.
    expect(accounts.hasSession()).toBe(true);
    expect(accounts.status().person).not.toBeNull();
  } finally {
    accounts.ACCOUNTS_MS.value = before.accounts;
    accounts.TOKEN_WAIT_MS.value = before.wait;
    relayBack();
    delete process.env.EDIT_TRIALS;
  }
});

test("a token in its last 30 s is still sent, a renewal asked beside it; and after a sleep, Drive's library waits for the renewed token, never \"need you signed in\" (JJ's Script import, hourly from Nov 18 19:52)", async () => {
  const own = ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DOCS_REFRESH_TOKEN"].map((name) => [name, process.env[name]] as const);
  for (const [name] of own) delete process.env[name];
  process.env.EDIT_RELAY_URL = process.env.EDIT_ACCOUNTS_URL;
  process.env.EDIT_TRIALS = "1";
  try {
    await keychain.set(app.store.home, "last-seconds-aaaaaaaa");
    await accounts.start(app);
    const held = accounts.accessToken();
    expect(held).not.toBeNull();
    // 10 s left: the relay allows 60 s of skew, so it's still good to send.
    accounts.expireForTests(10_000);
    expect(accounts.accessToken()).toBe(held);
    await accounts.renew();
    expect(accounts.accessToken()).not.toBe(held);
    // Asleep past the hour: the library's next try lands as the Mac wakes, beside the renewal.
    accounts.expireForTests();
    const { Library } = await import("../src/library.ts");
    const token = await new Library().accessToken();
    expect(token).not.toBe(held);
    expect(token).toBe(accounts.accessToken() ?? "");
  } finally {
    for (const [name, value] of own) if (value !== undefined) process.env[name] = value;
    relayBack();
    delete process.env.EDIT_TRIALS;
  }
});
