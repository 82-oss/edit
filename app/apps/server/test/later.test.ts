// Home's Done (later.ts): marked done and moved back, through the relay's
// Convex (the cloud mock's editLater); a row set aside by Later, which went on
// Nov 18, is left out, so it shows in its list again.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as cloud from "../src/cloud.ts";
import { respond } from "../src/http/server.ts";
import * as later from "../src/later.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

test("marked done and moved back; what Later set aside shows in its list again", async () => {
  const { app } = fixtureHome("later");
  const router = buildRouter();
  const ask = async (method: string, body?: unknown) => {
    const response = (await respond(app, router, new Request("http://localhost:7700/api/later", { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  // Set aside before Later went (prod has two): not listed, so its row is back where it was.
  mock.cloud.convex.later.set("edit:p1793450000000-abc", { key: "edit:p1793450000000-abc", until: Date.now() + 86_400_000, at: Date.now(), by: { sub: "u1", name: "JJ" } });
  expect(await later.list()).toEqual([]);
  expect((await ask("POST", { key: "script:s1793450000000", done: true })).body).toEqual({ key: "script:s1793450000000", done: true });
  const { entries } = (await ask("GET")).body as { entries: { key: string; done?: boolean }[] };
  expect(entries.map(({ key, done }) => ({ key, done }))).toEqual([{ key: "script:s1793450000000", done: true }]);
  // Refused: a key that isn't one, and setting aside (until, or nothing said).
  expect((await ask("POST", { key: "../etc", done: true })).status).toBe(400);
  expect((await ask("POST", { key: "idea:i1793450000000-xyz", until: Date.now() + 86_400_000 })).status).toBe(400);
  expect((await ask("POST", { key: "idea:i1793450000000-xyz" })).status).toBe(400);
  // Moved back.
  expect((await ask("POST", { key: "script:s1793450000000", back: true })).body).toEqual({ key: "script:s1793450000000", back: true });
  expect(await later.list()).toEqual([]);
});
