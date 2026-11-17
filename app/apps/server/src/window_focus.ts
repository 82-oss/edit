// Bringing Edit's window to the front from the server: after the browser's
// sign-in comes back (the team: Edit "should come to the front by itself").
// The window (crates/edit-window) asks `GET /api/window/next`, a long poll
// answered `{focus: true}` the moment something here wants the window in
// front, or `{focus: false}` after a while to ask again. Both ways Edit runs
// work alike (Edit.app starts the server; `edit app` starts the window), no
// macOS permission is needed, and a headless `edit serve` has no window
// asking, so `attached()` says to offer an "Open Edit" button instead.
//
// The same poll carries the notifications the window posts in the Mac's
// Notification Center (notices.ts decides when): `notices`, each with the
// page a click opens. And the Dock's badge: how many finished things the
// person hasn't looked at yet (notices.ts counts them). A window says the
// count it shows (`?badge=`) and is answered `badge` at once when that's not
// it, so one opened again, or a server started again, agree at the next poll.
//
// And it keeps the window the build the server is. An update replaces Edit.app
// and execs the server into the new build, but the window stayed the old one
// until Edit was next opened (nightly-76 on Sphe's M4, Nov 16: the window's
// engine fixes never arrived). Every answer says the server's `build`; a
// window learns its own from the first (its bundle's server), and once it's
// quiet asks with `?build=`. Differing, and with no export running, it's told
// `relaunch`: it opens itself again from its bundle's path (the new one), onto
// this server and the same page. A window that sends no build (older ones) is
// never told to.

import type { App } from "./app.ts";
import type { Router } from "./http/router.ts";
import { BUILD } from "./version.ts";

/** How long one poll is held before it's answered "nothing yet". */
const HOLD_MS = 25_000;
/** A window that asked within this long is there. */
const FRESH_MS = HOLD_MS + 10_000;
/** A notice no poll took within this long is dropped: old news by the time a window asks. */
const NOTICE_KEPT_MS = 60_000;

/** A notification for the window to post: a click opens `path`. */
export interface WindowNotice {
  key: string;
  title: string;
  body: string;
  path: string;
}

/** One poll's answer. */
export interface Answer {
  focus: boolean;
  notices: WindowNotice[];
  /** The window is of another build than this server: it should open itself again. */
  relaunch?: true;
  /** The Dock's badge, when the window shows another: unseen finished things, 0 for none. */
  badge?: number;
}

/**
 * What a poll says of its window: the build it is (none from older windows), the badge it shows (none from
 * older windows, which have none), and whether the server is busy.
 */
export interface Asking {
  build?: string | null;
  badge?: number | null;
  busy?: () => boolean;
}

/** A poll held, and the badge its window shows. */
interface Waiting {
  answer: (answer: Answer) => void;
  shown: number | null;
}

let waiting: Waiting[] = [];
let lastAsked = 0;
/** A focus asked while no window was waiting: given to the next poll that comes soon. */
let owed = 0;
/** Notices waiting for the next poll, with when they came. */
let queued: { notice: WindowNotice; at: number }[] = [];
/** The Dock badge's count. */
let badge = 0;

/** Whether Edit's own window is open and listening (Edit.app, `edit app`); false when headless. */
export function attached(): boolean {
  return waiting.length > 0 || Date.now() - lastAsked < FRESH_MS;
}

/** The queued notices still fresh, taken. */
function take(): WindowNotice[] {
  const now = Date.now();
  const fresh = queued.filter((one) => now - one.at < NOTICE_KEPT_MS).map((one) => one.notice);
  queued = [];
  return fresh;
}

/** `answer` with the badge, when the window shows another. */
function withBadge(answer: Answer, shown: number | null): Answer {
  return shown === null || shown === badge ? answer : { ...answer, badge };
}

/** Brings Edit's window to the front, if there is one. */
export function focus(): void {
  const now = waiting;
  waiting = [];
  if (now.length === 0) owed = Date.now();
  const notices = take();
  now.forEach((one, index) => one.answer(withBadge({ focus: true, notices: index === 0 ? notices : [] }, one.shown)));
}

/** Sets the Dock's badge to `count` (0 clears it): a window waiting that shows another is told at once. */
export function setBadge(count: number): void {
  badge = count;
  const told = waiting.filter((one) => one.shown !== null && one.shown !== badge);
  if (told.length === 0) return;
  waiting = waiting.filter((one) => !told.includes(one));
  const notices = take();
  told.forEach((one, index) => one.answer(withBadge({ focus: false, notices: index === 0 ? notices : [] }, one.shown)));
}

/** Hands the window a notification to post; false when no window is listening (headless, or Linux's Chrome window). */
export function notify(notice: WindowNotice): boolean {
  if (!attached()) return false;
  queued.push({ notice, at: Date.now() });
  const first = waiting.shift();
  first?.answer(withBadge({ focus: false, notices: take() }, first.shown));
  return true;
}

/**
 * One poll: answered when `focus()` or `notify()` is called, else "nothing" after HOLD_MS (`holdMs` for tests).
 * A window of another build is answered `relaunch` at once unless `busy`; what's owed and queued stays for
 * the window it opens.
 */
export function next(holdMs = HOLD_MS, asking: Asking = {}, build = BUILD): Promise<Answer> {
  lastAsked = Date.now();
  const window = asking.build ?? "";
  if (window !== "" && window !== build && asking.busy?.() !== true) {
    return Promise.resolve({ focus: false, notices: [], relaunch: true });
  }
  const shown = asking.badge ?? null;
  const focusOwed = owed > 0 && Date.now() - owed < 10_000;
  if (focusOwed || queued.length > 0 || (shown !== null && shown !== badge)) {
    owed = 0;
    return Promise.resolve(withBadge({ focus: focusOwed, notices: take() }, shown));
  }
  return new Promise((resolve) => {
    const one: Waiting = {
      answer: (given: Answer) => {
        clearTimeout(timer);
        lastAsked = Date.now();
        resolve(given);
      },
      shown,
    };
    const timer = setTimeout(() => {
      waiting = waiting.filter((other) => other !== one);
      one.answer(withBadge({ focus: false, notices: [] }, shown));
    }, holdMs);
    waiting.push(one);
  });
}

export function routes(router: Router<App>): void {
  router.get("/api/window/next", async ({ app, url }) => {
    const shown = Number.parseInt(url.searchParams.get("badge") ?? "", 10);
    const asking = { build: url.searchParams.get("build"), badge: Number.isFinite(shown) ? shown : null, busy: () => app.exports.running() };
    return Response.json({ ...(await next(HOLD_MS, asking)), build: BUILD });
  });
}

/** Tests: nothing waiting, nothing owed. */
export function resetForTests(): void {
  for (const one of waiting) one.answer({ focus: false, notices: [] });
  waiting = [];
  lastAsked = 0;
  owed = 0;
  queued = [];
  badge = 0;
}
