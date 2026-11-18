import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import * as cloud from "../src/cloud.ts";
import { remote } from "../src/cloud_projects.ts";
import * as diag from "../src/diag.ts";
import * as service from "../src/effect/service.ts";
import * as outages from "../src/outages.ts";
import * as relay from "../src/relay.ts";
import { MockServer } from "./mocks/server.ts";

const saved = { ...outages.timing };
let clock = 1_000_000;

beforeEach(() => {
  outages.forgetForTests();
  clock = 1_000_000;
  Object.assign(outages.timing, { now: () => clock, random: () => 0.5 });
});

afterEach(() => {
  Object.assign(outages.timing, saved);
  outages.forgetForTests();
});

/** A stand-in for the relay: down until `up`, each request saying how it went as relay.ts does. */
function destination() {
  const one = {
    up: true,
    hold: null as Promise<void> | null,
    calls: { poller: 0, renewal: 0 },
    async hit(who: "poller" | "renewal"): Promise<string> {
      one.calls[who] += 1;
      if (one.hold !== null) await one.hold;
      if (!one.up) {
        outages.failed("relay", "could not reach Edit's relay: stand-in down");
        throw new service.ServiceUnreachable({ service: relay.SERVICE, message: "could not reach Edit's relay: stand-in down" });
      }
      outages.answered("relay");
      return "ok";
    },
  };
  return one;
}

/** What was said since `since` with `part` in it; `real`: only of the real relay, not the stand-in. */
const said = (part: string, since: number, real = false) =>
  diag.lines(500).filter((line) => line.at >= since && line.message.includes(part) && (!real || !line.message.includes("stand-in")));

test("pollers stop calling a destination that's down, one probe at a time, and all resume once it answers; the lock renewal is tried throughout", async () => {
  const since = Date.now();
  const cloudSide = destination();
  const pollers = [0, 1, 2].map(() => () => outages.background("relay", () => cloudSide.hit("poller")));
  const round = async () => {
    const results = await Promise.all(pollers.map((poll) => poll()));
    // The renewal never goes through `background`: tried every round, its failure its own to handle.
    await cloudSide.hit("renewal").catch(() => {});
    return results;
  };

  expect(await round()).toEqual(["ok", "ok", "ok"]);
  expect(cloudSide.calls).toEqual({ poller: 3, renewal: 1 });

  // Down: the first round's three failures make the outage, said once, and their failures are quiet.
  cloudSide.up = false;
  expect(await round()).toEqual([undefined, undefined, undefined]);
  expect(outages.down("relay")).toBe(true);
  const atStart = { ...cloudSide.calls };
  expect(atStart.poller).toBe(6);

  // Every 5 s for 10 minutes: no poller calls but a probe now and then (15 s, then 30, 60, 120, 240, 300…).
  let probes = 0;
  for (let at = 0; at < 120; at++) {
    clock += 5_000;
    const before = cloudSide.calls.poller;
    await round();
    const made = cloudSide.calls.poller - before;
    expect(made).toBeLessThanOrEqual(1);
    probes += made;
  }
  expect(probes).toBeGreaterThanOrEqual(4);
  expect(probes).toBeLessThanOrEqual(7);
  // The renewal was tried every round.
  expect(cloudSide.calls.renewal).toBe(atStart.renewal + 120);

  // A probe that hangs: the other pollers skip meanwhile, never a second probe.
  clock += 10 * 60_000;
  let release!: () => void;
  cloudSide.hold = new Promise<void>((resolve) => (release = resolve));
  const before = cloudSide.calls.poller;
  const probe = pollers[0]!();
  expect(await pollers[1]!()).toBeUndefined();
  expect(await pollers[2]!()).toBeUndefined();
  expect(cloudSide.calls.poller).toBe(before + 1);

  // Back: the probe's answer ends it for everyone.
  cloudSide.up = true;
  release();
  cloudSide.hold = null;
  expect(await probe).toBe("ok");
  expect(outages.down("relay")).toBe(false);
  expect(await round()).toEqual(["ok", "ok", "ok"]);

  expect(said("Edit's relay unreachable: background checks paused", since)).toHaveLength(1);
  const back = said("Edit's relay reachable again after", since);
  expect(back).toHaveLength(1);
  expect(back[0]!.message).toMatch(/after 20 min \d\d s: background checks resumed \(\d+ skipped meanwhile\)/u);
  // Nothing else was said about the destination meanwhile.
  expect(said("could not reach", since).filter((line) => !line.message.includes("background checks paused"))).toHaveLength(0);
});

test("a failure that isn't the destination being down is still thrown, and a round that never reaches it leaves the probe to the next", async () => {
  await expect(outages.background("relay", async () => Promise.reject(new Error("a bug")))).rejects.toThrow("a bug");
  for (let at = 0; at < 3; at++) outages.failed("relay", "could not reach Edit's relay: stand-in down");
  expect(outages.down("relay")).toBe(true);
  clock += 20_000;
  // A round with nothing to ask (nothing shared): no verdict, so the next round probes at once.
  expect(await outages.background("relay", async () => "nothing asked")).toBe("nothing asked");
  let ran = false;
  await outages.background("relay", async () => void (ran = true));
  expect(ran).toBe(true);
  // An answer refused (the relay there) is thrown as always, and ends the outage.
  await expect(
    outages.background("relay", async () => {
      outages.answered("relay");
      throw new Error("over the daily limit (429)");
    }),
  ).rejects.toThrow("over the daily limit");
  expect(outages.down("relay")).toBe(false);
});

test("one destination's outage pauses only the rounds that reach it", async () => {
  for (let at = 0; at < 3; at++) outages.failed("r2", "could not reach R2: stand-in down");
  expect(outages.down("r2")).toBe(true);
  expect(outages.down("relay")).toBe(false);
  expect(await outages.background("relay", async () => "relay only")).toBe("relay only");
  expect(await outages.background(["relay", "r2"], async () => "both")).toBeUndefined();
  // Script mode's own offline failure is quiet too while it's down.
  expect(outages.quiet(Object.assign(new Error("Edit's cloud can't be reached"), { offline: true }))).toBe(true);
  expect(outages.quiet(new Error("a bug"))).toBe(false);
});

// ── Through the real relay calls ──

let mock: MockServer;
let restoreEnv: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restoreEnv = mock.useEnv({ EDIT_RELAY_TOKEN: "test-token" });
});

afterAll(() => {
  restoreEnv();
  mock.stop();
});

test("relay calls that can't connect make the outage, and a lock renewal during it still goes out and ends it", async () => {
  const since = Date.now();
  const real = process.env.EDIT_RELAY_URL;
  let renewals = 0;
  mock.on("POST", "/v1/cloud/convex", async (request) => {
    const body = (await request.json()) as { path?: string };
    if (body.path === "edit:renewLock") renewals += 1;
    return Response.json({ status: "success", value: { renewed: true } });
  });
  process.env.EDIT_RELAY_URL = "http://127.0.0.1:9";
  try {
    for (let at = 0; at < 3; at++) await expect(cloud.convexCall("mutation", "edit:renewLock", { projectId: "p1", lockToken: "t" }, 5)).rejects.toThrow(/could not reach Edit's relay/u);
    expect(outages.down("relay")).toBe(true);
    // A background round now is skipped: nothing asked.
    let asked = false;
    expect(await outages.background("relay", async () => void (asked = true))).toBeUndefined();
    expect(asked).toBe(false);
    // The network back: the renewal (priority, never a background round) is sent, kept, and ends the outage.
    process.env.EDIT_RELAY_URL = real;
    expect(await remote.renew("p1", "t")).toEqual({ yes: true });
    expect(renewals).toBe(1);
    expect(outages.down("relay")).toBe(false);
    expect(said("Edit's relay unreachable: background checks paused", since, true)).toHaveLength(1);
    expect(said("Edit's relay reachable again", since, true)).toHaveLength(1);
  } finally {
    process.env.EDIT_RELAY_URL = real;
  }
});
