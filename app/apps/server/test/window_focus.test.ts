// window_focus.ts's tests: Edit's window comes to the front when the sign-in comes back.

import { afterEach, expect, test } from "bun:test";

import * as windowFocus from "../src/window_focus.ts";

afterEach(() => windowFocus.resetForTests());

test("a window waiting is told to come to the front, and counts as open", async () => {
  expect(windowFocus.attached()).toBe(false);
  const asked = windowFocus.next(5_000);
  expect(windowFocus.attached()).toBe(true);
  windowFocus.focus();
  expect((await asked).focus).toBe(true);
});

test("a poll with nothing to do is answered no, and a focus asked between polls is kept for the next one", async () => {
  expect((await windowFocus.next(20)).focus).toBe(false);
  windowFocus.focus();
  expect((await windowFocus.next(20)).focus).toBe(true);
  expect((await windowFocus.next(20)).focus).toBe(false);
});

test("a notice goes to the window that's listening, once, and none is taken without a window", async () => {
  const notice = { key: "k", title: "First draft is ready", body: "Mom Leaves 5 Kids", path: "/scripts/abc" };
  expect(windowFocus.notify(notice)).toBe(false);
  const asked = windowFocus.next(5_000);
  expect(windowFocus.notify(notice)).toBe(true);
  expect(await asked).toEqual({ focus: false, notices: [notice] });
  // Between polls: kept for the next one.
  expect(windowFocus.notify({ ...notice, key: "k2" })).toBe(true);
  expect((await windowFocus.next(20)).notices.map((one) => one.key)).toEqual(["k2"]);
  expect((await windowFocus.next(20)).notices).toEqual([]);
});

test("a window of another build is told to open itself again, unless an export runs; one of this build or sending none isn't", async () => {
  let exporting = true;
  const busy = () => exporting;
  // An older window sends no build: held as ever.
  expect(await windowFocus.next(20, {}, "nightly-77")).toEqual({ focus: false, notices: [] });
  expect(await windowFocus.next(20, { build: null, busy }, "nightly-77")).toEqual({ focus: false, notices: [] });
  // This build: held as ever.
  expect(await windowFocus.next(20, { build: "nightly-77", busy }, "nightly-77")).toEqual({ focus: false, notices: [] });
  // Another, while exporting: not yet.
  expect(await windowFocus.next(20, { build: "nightly-76", busy }, "nightly-77")).toEqual({ focus: false, notices: [] });
  exporting = false;
  // At once, keeping what's owed and queued for the window it opens.
  windowFocus.focus();
  const notice = { key: "k", title: "First draft is ready", body: "Mom", path: "/scripts/a" };
  expect(windowFocus.notify(notice)).toBe(true);
  expect(await windowFocus.next(60_000, { build: "nightly-76", busy }, "nightly-77")).toEqual({ focus: false, notices: [], relaunch: true });
  expect(await windowFocus.next(20, { build: "nightly-77", busy }, "nightly-77")).toEqual({ focus: true, notices: [notice] });
});

test("GET /api/window/next says the server's build, and tells a window of another one to relaunch", async () => {
  const { respond } = await import("../src/http/server.ts");
  const { buildRouter } = await import("../src/routes.ts");
  const { fixtureHome } = await import("./helpers/home.ts");
  const { BUILD } = await import("../src/version.ts");
  const { app, cleanup } = fixtureHome("window-next");
  try {
    let exporting = true;
    Object.defineProperty(app, "exports", { value: { running: () => exporting } });
    const router = buildRouter();
    const ask = async (query: string) => {
      const request = new Request(`http://localhost:7700/api/window/next${query}`, { headers: { host: "localhost:7700" } });
      return (await (await respond(app, router, request, null))!.json()) as Record<string, unknown>;
    };
    windowFocus.focus();
    expect(await ask("?build=nightly-1")).toEqual({ focus: true, notices: [], build: BUILD });
    exporting = false;
    expect(await ask("?build=nightly-1")).toEqual({ focus: false, notices: [], relaunch: true, build: BUILD });
    windowFocus.focus();
    expect(await ask(`?build=${BUILD}`)).toEqual({ focus: true, notices: [], build: BUILD });
    windowFocus.focus();
    expect(await ask("")).toEqual({ focus: true, notices: [], build: BUILD });
  } finally {
    cleanup();
  }
});

test("the Dock's badge goes to a window showing another, at once or as it changes; one sending none is never told", async () => {
  // A window showing what the count is: held.
  expect(await windowFocus.next(20, { badge: 0 })).toEqual({ focus: false, notices: [] });
  const waiting = windowFocus.next(5_000, { badge: 0 });
  const older = windowFocus.next(20);
  windowFocus.setBadge(2);
  expect(await waiting).toEqual({ focus: false, notices: [], badge: 2 });
  expect(await older).toEqual({ focus: false, notices: [] });
  // A window opened again, or onto a server started again, shows another: told at once.
  expect(await windowFocus.next(5_000, { badge: 5 })).toEqual({ focus: false, notices: [], badge: 2 });
  // Set to what it shows: nothing to tell; then cleared.
  const shown = windowFocus.next(5_000, { badge: 2 });
  windowFocus.setBadge(2);
  windowFocus.setBadge(0);
  expect(await shown).toEqual({ focus: false, notices: [], badge: 0 });
});

test("GET /api/window/next reads the badge the window shows", async () => {
  const { respond } = await import("../src/http/server.ts");
  const { buildRouter } = await import("../src/routes.ts");
  const { fixtureHome } = await import("./helpers/home.ts");
  const { BUILD } = await import("../src/version.ts");
  const { app, cleanup } = fixtureHome("window-badge");
  try {
    Object.defineProperty(app, "exports", { value: { running: () => false } });
    const router = buildRouter();
    windowFocus.setBadge(1);
    const request = new Request(`http://localhost:7700/api/window/next?build=${BUILD}&badge=0`, { headers: { host: "localhost:7700" } });
    expect(await (await respond(app, router, request, null))!.json()).toEqual({ focus: false, notices: [], badge: 1, build: BUILD });
  } finally {
    cleanup();
  }
});
