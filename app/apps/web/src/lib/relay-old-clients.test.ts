// Older builds against today's relay (TODO "No release check runs an old client against the new relay"): the live
// relay is deployed with each nightly, and every older build still on the team's Macs then talks to the new one; twice
// a relay change broke them. For each of the last five nightlies, its server's source (read from its tag) is combed
// for (a) the relay routes it calls, (b) the cloud functions it calls through the relay, and (c) the `edit/<prefix>/`
// keys it writes, and today's relay must still route (a) (asked of it as its Worker, with a stand-in for everything
// behind it), still allow (b), and still let a teammate write (c). Check's TS leg runs this, and a nightly ships only
// past a green Check (release.yml `checked`). Its checkout is shallow, with no tags: the tags are fetched here, or the
// check is skipped with why.

import { execFileSync } from "node:child_process";

import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { readCutOffsWith, useKeys } from "../../../relay/src/auth";
import { EDIT_CALLS, WRITABLE } from "../../../relay/src/authz";
import { callable } from "../../../relay/src/cloud";
import { ideaCallable } from "../../../relay/src/ideas";
import relay, { type Env } from "../../../relay/src/index";
import { WRITER_FUNCTIONS } from "../../../relay/src/writer_cloud";

/** How many nightlies back are checked. */
const BACK = 5;
const SERVER = "app/apps/server/src/";

const git = (args: string[], input?: string): string => execFileSync("git", args, { cwd: top(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...(input === undefined ? {} : { input }) });
let root: string | null = null;
function top(): string {
  root ??= execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return root;
}

const byNumber = (a: string, b: string) => Number(b.slice("nightly-".length)) - Number(a.slice("nightly-".length));

/** The last `BACK` nightly tags, fetched (shallow) when they aren't here; or why they can't be had. */
function nightlies(): { tags: string[] } | { why: string } {
  const here = () => git(["tag", "-l", "nightly-*"]).split("\n").filter((one) => /^nightly-\d+$/.test(one)).sort(byNumber);
  try {
    let tags = here();
    // CI's shallow checkout has none: the newest on origin, each fetched with its one commit.
    const remote = git(["ls-remote", "--tags", "--refs", "origin", "nightly-*"])
      .split("\n")
      .map((line) => /refs\/tags\/(nightly-\d+)$/.exec(line)?.[1])
      .filter((one): one is string => one !== undefined)
      .sort(byNumber)
      .slice(0, BACK);
    const missing = remote.filter((one) => !tags.includes(one));
    for (const tag of missing) git(["fetch", "--quiet", "--depth=1", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    tags = here().slice(0, BACK);
    if (tags.length === 0) return { why: "no nightly tags here or on origin" };
    return { tags };
  } catch (error) {
    // origin unreachable (offline, no remote): the tags here, if there are any.
    try {
      const tags = here().slice(0, BACK);
      if (tags.length > 0) return { tags };
    } catch {}
    return { why: `the nightly tags couldn't be fetched: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
}

/** Each `.ts` file of the server's source at `tag`, read in one go. */
function sources(tag: string): { path: string; text: string }[] {
  const paths = git(["ls-tree", "-r", "--name-only", tag, SERVER]).split("\n").filter((one) => one.endsWith(".ts") && !one.endsWith(".d.ts"));
  // Each object as "<sha> blob <bytes>\n<content>\n", its size in bytes: read as bytes, not text.
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd: top(), input: paths.map((path) => `${tag}:${path}`).join("\n") + "\n", maxBuffer: 256 * 1024 * 1024 });
  const files: { path: string; text: string }[] = [];
  let at = 0;
  for (const path of paths) {
    const end = out.indexOf(10, at);
    const size = Number(out.subarray(at, end).toString("utf8").split(" ")[2]);
    files.push({ path, text: out.subarray(end + 1, end + 1 + size).toString("utf8") });
    at = end + 1 + size + 1;
  }
  return files;
}

export type Route = { method: string | null; path: string };
export type Call = { kind: string | null; name: string };

/** What a build's server source asks of the relay: its routes, its cloud functions, and the `edit/` prefixes it names. */
export function asks(files: { path: string; text: string }[]): { routes: Route[]; calls: Call[]; prefixes: string[] } {
  const routes = new Map<string, Route>();
  const calls = new Map<string, Call>();
  const prefixes = new Set<string>();
  const route = (method: string | null, raw: string) => {
    // A path built on (`/v1/cloud/${path}`, `/v1/remover/jobs/${id}`): its static part, any one segment after it.
    let path = raw.split(/[?$]/u)[0]!;
    if (path === "/v1/" || path === "/v1/cloud/" || path === "/v1/cloud/writer/") return;
    if (path.endsWith("/")) path += "x";
    const key = `${method ?? "*"} ${path}`;
    if (!routes.has(key)) routes.set(key, { method, path });
  };
  for (const { path, text } of files) {
    for (const found of text.matchAll(/"(GET|POST|PUT|DELETE)"\s*,\s*[`"'](\/v1\/[^`"']*)/gu)) route(found[1]!, found[2]!);
    for (const found of text.matchAll(/[`"'](\/v1\/[A-Za-z0-9/_.${}-]*)/gu)) route(null, found[1]!);
    // cloud.ts `relayJson(path)`: POST /v1/cloud/<path>; Script mode's writer/cloud.ts `call(route)`: POST /v1/cloud/writer/<route>.
    for (const found of text.matchAll(/relayJson\(\s*"([a-z0-9/_-]+)"/gu)) route("POST", `/v1/cloud/${found[1]}`);
    if (path.endsWith("writer/cloud.ts")) for (const found of text.matchAll(/\bcall\(\s*"([a-z0-9/_-]+)"/gu)) route("POST", `/v1/cloud/writer/${found[1]}`);
    for (const found of text.matchAll(/"((?:edit|reviews|writer|channels|groups|ideas|thumbnails):[A-Za-z_]+)"/gu)) {
      const before = text.slice(Math.max(0, found.index - 80), found.index);
      // Its kind only where the call says it: `cloud.query("…"`, `convexCall("query", "…"`, `kind: "query", path: "…"`.
      const said = /(?:\b(query|mutation|action)(?:<[^>]*>)?\(\s*|"(query|mutation|action)"\s*,\s*|kind:\s*"(query|mutation|action)"\s*,\s*path:\s*)$/u.exec(before);
      const kind = said === null ? null : (said[1] ?? said[2] ?? said[3] ?? null);
      const key = `${kind ?? "*"} ${found[1]}`;
      if (!calls.has(key)) calls.set(key, { kind, name: found[1]! });
    }
    for (const found of text.matchAll(/[`"'](edit\/[a-z0-9-]+\/)/gu)) prefixes.add(found[1]!);
  }
  // A route or function named with its method or kind somewhere is checked as that; named nowhere with one, as any.
  for (const [key, one] of routes) if (one.method === null && [...routes.values()].some((other) => other.path === one.path && other.method !== null)) routes.delete(key);
  for (const [key, call] of calls) if (call.kind === null && [...calls.values()].some((other) => other.name === call.name && other.kind !== null)) calls.delete(key);
  return { routes: [...routes.values()], calls: [...calls.values()], prefixes: [...prefixes] };
}

/** Whether today's relay lets Edit call `name` (as `kind`, or as any kind when it isn't known) through any of its doors. */
export function allowed(call: Call): boolean {
  const kinds = call.kind === null ? ["query", "mutation", "action"] : [call.kind];
  return kinds.some((kind) => callable(call.name, kind) || ideaCallable(call.name, kind)) || Object.hasOwn(WRITER_FUNCTIONS, call.name) || (call.kind === null && EDIT_CALLS.has(call.name));
}

// ---------------------------------------------------------------------------
// Today's relay, as its Worker

const ISSUER = "https://accounts.example.test";
let privateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});

afterEach(() => {
  useKeys(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An admin's token: what a route answers isn't who may, only whether it's there. */
const token = () =>
  new SignJWT({ email: "admin@example.test", name: "Admin", perms: ["use", "agent.teach", "ideas.interrogation"], admin: true })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience("edit")
    .setSubject("person-1")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);

/** Everything the relay can be configured with, so a route is looked up before anything says it isn't set up. */
const env = {
  ACCOUNTS_ISSUER: ISSUER,
  CONVEX_URL: "https://convex.test",
  CONVEX_SERVICE_TOKEN: "s".repeat(40),
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
  TRELLO_API_KEY: "tk",
  TRELLO_TOKEN: "tt",
  YOUTUBE_API_KEY: "yk",
  MEDIA_HOST: "media.example.test",
  MEDIA_SECRET: "a long random secret",
} as unknown as Env;

/** Whether today's relay routes `route`: anything but its "not found", a method it doesn't take, or "out of date". */
async function routes(route: Route, bearer: string): Promise<boolean> {
  const methods = route.method === null ? ["GET", "POST"] : [route.method];
  for (const method of methods) {
    const body = method === "GET" || method === "DELETE" ? undefined : "{}";
    const answer = await relay.fetch(
      new Request(`https://relay.test${route.path}`, { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(body === undefined ? {} : { "content-length": String(body.length) }) }, ...(body === undefined ? {} : { body }) }),
      env,
    );
    const said = await answer.text();
    const missing = (answer.status === 404 && /"error":"not found"/u.test(said)) || answer.status === 405 || answer.status === 410;
    if (!missing) return true;
  }
  return false;
}

describe("the last nightlies against today's relay", () => {
  it("still routes every relay call they make, allows every cloud function they call, and lets a teammate write every edit/ prefix they write", async (context) => {
    const found = nightlies();
    if ("why" in found) {
      console.warn(`SKIPPED: older builds weren't checked against today's relay: ${found.why}`);
      context.skip();
      return;
    }
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Nothing behind the relay answers: a route that's there says so its own way (502, 503, 400…).
    vi.stubGlobal("fetch", async () => new Response("no stand-in", { status: 599 }));
    const bearer = await token();
    const problems: string[] = [];
    for (const tag of found.tags) {
      const { routes: wanted, calls, prefixes } = asks(sources(tag));
      for (const route of wanted) if (!(await routes(route, bearer))) problems.push(`${tag} calls ${route.method ?? "GET/POST"} ${route.path}: today's relay doesn't route it`);
      for (const call of calls) if (!allowed(call)) problems.push(`${tag} calls ${call.kind ?? "the function"} ${call.name}: today's relay doesn't allow it`);
      for (const prefix of prefixes) if (!WRITABLE.some((one) => prefix.startsWith(one))) problems.push(`${tag} names ${prefix}: today's relay doesn't let a teammate write there`);
      // The comb found something: an empty build would pass everything.
      expect(wanted.length, `${tag}'s relay routes`).toBeGreaterThan(10);
      expect(calls.length, `${tag}'s cloud functions`).toBeGreaterThan(20);
    }
    expect(problems).toEqual([]);
  }, 120_000);
});

describe("the comb", () => {
  it("finds routes with their methods, built paths, cloud functions with their kinds, and edit/ prefixes", () => {
    const found = asks([
      { path: `${SERVER}a.ts`, text: 'relay.json("GET", `/v1/ideas/lanes?${on}`); relay.call("POST", "/v1/speech", body); fetch(`/v1/remover/jobs/${id}`); relayJson("r2/presign", {}); cloud.mutation("edit:commitProject", {}); const key = `edit/exports/${id}`; const x = "https://api.elevenlabs.io/v1/speech-to-text";' },
      { path: `${SERVER}writer/cloud.ts`, text: 'call("convex", { kind: "query", path: "writer:getScript" })' },
    ]);
    expect(found.routes).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/v1/ideas/lanes" },
        { method: "POST", path: "/v1/speech" },
        { method: null, path: "/v1/remover/jobs/x" },
        { method: "POST", path: "/v1/cloud/r2/presign" },
        { method: "POST", path: "/v1/cloud/writer/convex" },
      ]),
    );
    expect(found.routes.some((one) => one.path.includes("speech-to-text"))).toBe(false);
    expect(found.calls).toEqual(expect.arrayContaining([{ kind: "mutation", name: "edit:commitProject" }, { kind: "query", name: "writer:getScript" }]));
    expect(found.prefixes).toEqual(["edit/exports/"]);
    expect(allowed({ kind: "mutation", name: "edit:commitProject" })).toBe(true);
    expect(allowed({ kind: "query", name: "edit:commitProject" })).toBe(false);
    expect(allowed({ kind: "mutation", name: "edit:noSuchThing" })).toBe(false);
  });
});
