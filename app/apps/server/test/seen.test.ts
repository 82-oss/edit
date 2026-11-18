// Home's seen marks (seen.ts): marked and listed through the relay's Convex
// (the cloud mock's editSeen); a mamagi from before them (a nightly out before
// they're deployed) is no error: nothing listed, a mark goes nowhere, said
// once in the log.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as cloud from "../src/cloud.ts";
import * as diag from "../src/diag.ts";
import { respond } from "../src/http/server.ts";
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

const router = buildRouter();
const ask = async (app: ReturnType<typeof fixtureHome>["app"], method: string, body?: unknown) => {
  const response = (await respond(app, router, new Request("http://localhost:7700/api/seen", { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

test("opened marks are listed by key, only ever moving on", async () => {
  const { app } = fixtureHome("seen");
  mock.cloud.convex.seenGone = false;
  expect((await ask(app, "GET")).body).toEqual({ on: true, seen: {} });
  const at = Date.now() - 60_000;
  expect((await ask(app, "POST", { key: "edit:p1793450000000-abc", at })).body).toEqual({ ok: true });
  expect((await ask(app, "POST", { key: "idea:i1793450000000-xyz" })).body).toEqual({ ok: true });
  // A late mark (another computer's, sent after) never takes one back.
  await ask(app, "POST", { key: "edit:p1793450000000-abc", at: at - 30_000 });
  const listed = (await ask(app, "GET")).body as { on: boolean; seen: Record<string, number> };
  expect(listed.on).toBe(true);
  expect(listed.seen["edit:p1793450000000-abc"]).toBe(at);
  expect(listed.seen["idea:i1793450000000-xyz"]).toBeGreaterThan(at);
  // Refused here: a key that isn't one (a board card has no page to open).
  expect((await ask(app, "POST", { key: "card:c1" })).status).toBe(400);
  expect((await ask(app, "POST", { key: "../etc" })).status).toBe(400);
});

test("a mamagi without the marks: Home gets none, a mark is dropped, the log says so once", async () => {
  const { app } = fixtureHome("seen-old");
  mock.cloud.convex.seenGone = true;
  const since = Date.now();
  try {
    for (let i = 0; i < 3; i++) {
      const listed = await ask(app, "GET");
      expect(listed).toEqual({ status: 200, body: { on: false, seen: {} } });
      expect(await ask(app, "POST", { key: "edit:p1793450000000-abc" })).toEqual({ status: 200, body: { ok: false } });
    }
    const warned = diag.lines(500).filter((line) => line.at >= since && line.message.startsWith("seen:"));
    expect(warned.length).toBe(1);
    expect(warned[0]!.message).toContain("Could not find public function");
  } finally {
    mock.cloud.convex.seenGone = false;
  }
  // Deployed since: on again, and a failure after that is said once more.
  expect((await ask(app, "GET")).body).toMatchObject({ on: true });
});
