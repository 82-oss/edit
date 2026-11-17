// Vmake's website (vmake.ai) on the team's flat Pro plan, driven like a
// person in a cloud browser (Sphe, Nov 17): Browser Use's, so a piece goes
// from R2 to the browser at a datacenter's speed rather than up a teammate's
// home line, and the Mac stays quiet and needn't stay awake. The sign-in lives
// in a Browser Use profile: the person signs in once through the session's
// live view ("Sign in to Vmake"), and every session after reuses it.
//
// The page, as the Mac's agent mapped it on Nov 17 (a free account): the
// remover at /video-watermark-remover/upload, its file input
// `input[type=file][name=file]` in `.ant-upload-btn`; the mode (`li` items in
// `ul[class*=radio]`: "Smart pro", `active--` when chosen, `disabled--` when
// the plan hasn't it) chosen BEFORE the file, since processing starts by
// itself once the upload's done; "Processing… N%" while it works; then a
// result <video> (oss.vl.starii.com/…mp4) and "Download full video". Only the
// page is used, never its endpoints (their terms forbid scraping), at a
// person's pace.
//
// The file gets into the input from inside the browser (`putPiece`): a tab
// the page opens on the piece's presigned R2 URL reads it (R2's own origin, no
// CORS) and hands it to the page with postMessage; it goes in through a
// DataTransfer and a change event. Browser Use has no upload
// into a session's disk for files this size (v2's is 10 MiB, documents only).
//
// Browser Use (Nov 17): $0.06 a browser-hour by the minute, $0.20 a GB with
// its proxy off (vmake.ai shows no bot check), sessions of at most 240
// minutes, 10 at once on pay-as-you-go; a profile keeps cookies and storage,
// saved when its browser stops. The account, its key and its one profile are
// the team's, on Edit's relay (relay/src/vmake.ts), which lends a Mac a
// browser one at a time: no Mac holds a key or a sign-in.

import * as fs from "node:fs";

import * as cloud from "./cloud.ts";
import type { Page, Remote } from "./chrome_devtools.ts";
import * as devtools from "./chrome_devtools.ts";
import * as diag from "./diag.ts";
import { classify, VmakeError } from "./vmake_api.ts";

export const SITE = "https://vmake.ai";

/** Where the driver's steps are said besides Edit's log: a script's console (`trace.on = console.log`). */
export const trace: { on: ((line: string) => void) | null } = { on: null };
function said(line: string): void {
  diag.info("removal", line);
  trace.on?.(line);
}
const REMOVER = "/video-watermark-remover/upload";
/** The mode to choose. */
const MODE = "smart pro";
/** Tabs working at once (one job a tab) within a session. */
export const TABS = 3;
/** Files a day Edit sends at most: Pro's is 30–50 (pricing says 50, the FAQ 30). */
export const DAILY_FILES = 30;
/** A job's longest wait for Vmake (a 60 s piece took 2.5 min; 300 s of 1080p far longer at busy hours). */
const JOB_MS = 2 * 3_600_000;
/** Browser Use's price (Nov 17), and a session's longest life. */
export const DOLLARS_AN_HOUR = 0.06;
export const DOLLARS_A_GB = 0.2;
/** A session's age after which it's let go once its tabs are done (another takes over). */
const SESSION_RENEW_MS = 45 * 60_000;

// ---------------------------------------------------------------------------
// The team's browsers, lent by Edit's relay

export interface Session {
  id: string;
  /** Where a person can see and use it (a credential: anyone with it can); an admin's sign-in only. */
  liveUrl: string | null;
  remote: Remote;
  /** Stops it (its sign-in saved into the team's profile, the relay's lease let go). */
  stop(): Promise<void>;
}

/** What starts browsers on the team's profile: the relay's, or a stand-in in tests. */
export interface Browsers {
  /** A browser on the team's profile; `signIn`: with its live view, for an admin. Waits while another Mac has the profile. */
  open(signIn?: boolean): Promise<Session>;
}

/** How long a Mac waits its turn on the team's profile before a piece gives up for now, and between asks. */
export const turns = { waitMs: 3 * 3_600_000, everyMs: 45_000 };

/** The relay's answer to asking for a browser. */
type Lent = { id?: string; cdpUrl?: string; liveUrl?: string; busy?: string };

/**
 * The team's Vmake account through Edit's relay (relay/src/vmake.ts): the
 * relay holds the Browser Use key and the team's profile and lends this Mac
 * (`holder`, its cloud holder) one browser at a time, the others waiting
 * their turn. `ask` is the relay's JSON call (a stand-in in tests).
 */
export function teamBrowsers(holder: string, ask: (method: string, route: string, body: unknown) => Promise<unknown>): Browsers {
  const call = async (route: string, body: unknown): Promise<Lent> => {
    try {
      return (await ask("POST", route, body)) as Lent;
    } catch (error) {
      const said = diag.messageOf(error);
      if (/browser_credits/u.test(said)) throw new VmakeError("Browser Use refused: the team's account is out of credits", "account", "browser_credits");
      if (/browser_key/u.test(said)) throw new VmakeError("Browser Use refused the team's key", "account", "browser_key");
      if (/\(403\)/u.test(said)) throw new VmakeError(said, "account", "refused");
      throw new VmakeError(`Edit's relay: ${said}`, "piece");
    }
  };
  return {
    async open(signIn = false) {
      const until = Date.now() + turns.waitMs;
      for (;;) {
        const lent = await call("/v1/vmake/browser", { holder, signIn });
        if (lent.busy === undefined && typeof lent.id === "string" && typeof lent.cdpUrl === "string") {
          const id = lent.id;
          const stop = () => call(`/v1/vmake/browser/${id}/stop`, { holder }).then(() => undefined, () => undefined);
          try {
            const remote = await devtools.remote(lent.cdpUrl, "Vmake's browser");
            return { id, liveUrl: lent.liveUrl ?? null, remote, stop: async () => (remote.close(), await stop()) };
          } catch (error) {
            await stop();
            throw new VmakeError(`the team's browser didn't connect: ${diag.messageOf(error)}`, "piece");
          }
        }
        // Another Mac has the team's profile: this one waits its turn (a sign-in never waits).
        if (signIn) throw new VmakeError(`${lent.busy ?? "Another Mac"} is using the team's Vmake account now; sign it in once that's done`, "piece");
        if (Date.now() > until) throw new VmakeError(`${lent.busy ?? "another Mac"} kept the team's Vmake account for hours`, "piece");
        said(`vmake.ai: ${lent.busy ?? "another Mac"} has the team's browser; waiting`);
        await Bun.sleep(turns.everyMs);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The page

/** Waits like a person between steps: 0.6–2 s, never the same. */
export const pacing = { wait: (ms = 600 + Math.random() * 1400) => Bun.sleep(ms) };

/** What the page says of the account, from what it shows: signed out, the plan without Smart pro, a limit reached. */
const ACCOUNT_SCRIPT = `(() => {
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const said = [...document.querySelectorAll('.ant-modal, .ant-message, .ant-notification, [role=dialog], [role=alert]')].filter(shown).map((el) => el.innerText.trim()).filter(Boolean).join(' | ');
  const buttons = [...document.querySelectorAll('button, a')].filter(shown).map((el) => el.innerText.trim().toLowerCase());
  const signedOut = buttons.some((text) => /^(log ?in|sign ?in|sign up|get started|log in \\/ sign up)$/.test(text)) && ![...document.querySelectorAll('[class*=avatar]')].some(shown);
  return { said, signedOut };
})()`;

async function accountProblem(page: Page): Promise<VmakeError | null> {
  const seen = await page.evaluate<{ said: string; signedOut: boolean }>(ACCOUNT_SCRIPT, 15_000);
  if (seen.signedOut) return new VmakeError("vmake.ai shows Edit's browser signed out", "account", "signed_out");
  if (seen.said !== "") {
    const whose = classify(seen.said, false);
    if (whose.scope === "account") return new VmakeError(`vmake.ai: ${seen.said.slice(0, 160)}`, "account", whose.reason);
  }
  return null;
}

async function waitFor<T>(page: Page, expression: string, ms: number, what: string, step = 1000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await page.evaluate<T | null>(expression, 15_000).catch(() => null);
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new VmakeError(`vmake.ai: ${what} didn't come`, "piece");
    await Bun.sleep(step);
  }
}

/** The browser's proxy refuses every connection: that browser is let go and another started (its own way out). */
export class ProxyDown extends VmakeError {
  constructor() {
    super("vmake.ai couldn't be reached through the cloud browser's proxy", "piece");
  }
}

/**
 * Opens `url` in the tab, tried again when the page is Chrome's own error
 * (Browser Use's home proxy now and then refuses connections: Nov 17,
 * ERR_SOCKS_CONNECTION_FAILED, in some browsers on every try; then
 * ProxyDown, and the Driver starts another browser).
 */
export async function go(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const loaded = new Promise<void>((resolve) => {
      const stop = page.on("Page.loadEventFired", () => {
        stop();
        resolve();
      });
    });
    await page.call("Page.navigate", { url });
    await Promise.race([loaded, Bun.sleep(45_000)]);
    const at = await page.evaluate<string>("location.href").catch(() => "");
    if (!at.startsWith("chrome-error:")) return;
    if (attempt >= 3) throw new ProxyDown();
    await Bun.sleep(3000 * attempt);
  }
}

/** A click as a person's: the element's middle, pressed and let go. */
async function click(page: Page, selectorScript: string): Promise<void> {
  const at = await page.evaluate<{ x: number; y: number } | null>(`(() => { const el = ${selectorScript}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (at === null) throw new VmakeError("vmake.ai: a button Edit needs isn't on the page", "piece");
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await pacing.wait(120 + Math.random() * 200);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
}

/** The shown "Smart pro" (the page keeps the list five times over, Nov 17; only one is on screen). */
const MODE_ITEM = `[...document.querySelectorAll('ul[class*=radio] li')].find((li) => li.getClientRects().length > 0 && !li.closest('[class*=task-card]') && li.innerText.trim().toLowerCase() === '${MODE}')`;
const DOWNLOAD_FULL = `[...document.querySelectorAll('button, a')].find((el) => /download full video/i.test(el.innerText))`;
/** The page's state while it works: the result's URL once it's there, the percent while processing. */
const PROGRESS_SCRIPT = `(() => {
  const video = [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src).find((src) => /^https?:.*\\.mp4(\\?|$)/.test(src) && !src.startsWith('blob:'));
  const full = ${DOWNLOAD_FULL};
  const percent = /Processing[^0-9]{0,6}(\\d{1,3})%/.exec(document.body.innerText);
  return { video: video ?? null, full: !!full, percent: percent ? Number(percent[1]) : null };
})()`;

/**
 * The piece into the remover's file input, from inside the browser: the page
 * opens its R2 address in a tab of its own, that tab (R2's origin: no CORS)
 * reads it and hands the file back with postMessage, and the page puts it in
 * its input. Nothing goes through Edit; R2 to the browser at a datacenter's
 * speed. (Nov 17, Browser Use: the page's own fetch of a path DevTools sent on
 * to R2, and R2's answer given an Allow-Origin by DevTools, both failed there
 * with ERR_FAILED, though a tab on R2 plays it.)
 */
/** The ranges a piece is read in, in the browser. */
const CHUNK = 4 * 1024 * 1024;

export async function putPiece(page: Page, remote: Remote, pieceUrl: string, name: string): Promise<void> {
  const tag = `edit_piece_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const began = Date.now();
  const step = (what: string) => said(`vmake.ai ${name}: ${what} (${Math.round((Date.now() - began) / 1000)} s)`);
  await page.evaluate(
    `(() => { window.${tag} = new Promise((resolve) => addEventListener('message', (event) => { if (event.data && event.data.${tag}) resolve(event.data.blob); })); return true; })()`,
  );
  await page.call("Runtime.evaluate", { expression: `void window.open(${JSON.stringify(pieceUrl)}, ${JSON.stringify(tag)})`, userGesture: true });
  const bare = pieceUrl.split("?")[0]!;
  step("opening the piece's tab");
  const reader = await remote.attach((url) => url.split("?")[0] === bare, 30_000);
  if (reader === null) throw new VmakeError("the browser didn't open the piece", "piece");
  step("its tab attached");
  try {
    // Listed at once with its address, the tab's document is still its opener's blank page for a moment (a fetch from there is vmake.ai's: CORS).
    await waitFor(reader, `location.href.split('?')[0] === ${JSON.stringify(bare)}`, 60_000, "the piece's tab", 250);
    step("its tab on R2");
    const read = await reader.evaluate<string>(
      // In ranges: Browser Use's browser cuts off a response too big at once (Nov 17: 26 MB whole failed with ERR_FAILED, in 8 MB ranges it came in a second).
      `(async () => {
        const first = await fetch(location.href, { headers: { Range: 'bytes=0-0' } });
        const size = Number((first.headers.get('content-range') || '').split('/')[1]);
        if (first.status !== 206 || !(size > 0)) return 'error ranges: ' + first.status;
        const parts = [];
        for (let at = 0; at < size; at += ${CHUNK}) {
          const part = await fetch(location.href, { headers: { Range: 'bytes=' + at + '-' + (Math.min(size, at + ${CHUNK}) - 1) } });
          if (part.status !== 206) return 'error status ' + part.status;
          parts.push(await part.blob());
        }
        const blob = new Blob(parts, { type: 'video/mp4' });
        if (blob.size !== size) return 'error size ' + blob.size + ' of ' + size;
        if (!window.opener) return 'error no opener';
        window.opener.postMessage({ ${tag}: true, blob }, '*');
        return 'ok ' + blob.size;
      })().catch((error) => 'error ' + error.message)`,
      30 * 60_000,
    );
    step(`read: ${read}`);
    if (!read.startsWith("ok")) throw new VmakeError(`the piece didn't reach the browser (${read})`, "piece");
  } finally {
    reader.close();
  }
  const put = await page.evaluate<string>(
    `(async () => {
      const blob = await Promise.race([window.${tag}, new Promise((resolve) => setTimeout(() => resolve(null), 120000))]);
      if (!blob) return 'never came';
      const file = new File([blob], ${JSON.stringify(name)}, { type: 'video/mp4' });
      const input = document.querySelector('.ant-upload-btn input[type=file][name=file]:not([multiple])');
      const files = new DataTransfer();
      files.items.add(file);
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      delete window.${tag};
      return 'ok';
    })()`,
    3 * 60_000,
  );
  if (put !== "ok") throw new VmakeError(`the piece didn't reach the page (${put})`, "piece");
}

/** How long a piece may show no progress before it's looked at again (15 s of 1080p: 10 s of Vmake's processing). */
export const timing = { stallMs: 3 * 60_000 };

/**
 * Presses our card's Apply and makes sure it took: the card leaves "To be
 * processed" (Nov 17: a press two seconds after choosing Smart pro was lost,
 * the card sat there 23 minutes; the same press a little later began it).
 * Pressed again up to three times, a few seconds apart, each looked at for 15 s.
 */
async function apply(page: Page, name: string, step: (what: string) => void): Promise<void> {
  for (let press = 1; press <= 3; press++) {
    await pacing.wait(2500 + Math.random() * 1500);
    await click(page, `[...(${cardOf(name)}).querySelectorAll('button')].find((b) => /^apply/i.test(b.innerText.trim()))`);
    const took = await waitFor<boolean>(page, `(() => { const s = ${cardState(name)}; return !!s && !s.ready; })()`, 15_000, "Apply taking", 1000).catch(() => false);
    step(took ? `applied (press ${press})` : `Apply didn't take (press ${press})`);
    if (took) return;
  }
  throw new VmakeError("vmake.ai didn't begin the piece when Apply was pressed", "piece");
}

/** The cards of jobs the remover's page shows (the account's jobs, anyone's: Nov 17, two 7–9 minute files of the team's at 40%). */
const CARDS = `[...document.querySelectorAll('[class*=viewport-task-card]')].filter((el) => el.getClientRects().length > 0)`;
const cardOf = (name: string) => `${CARDS}.find((el) => el.innerText.includes(${JSON.stringify(name)}))`;
/**
 * Our card's state (Nov 17, Sphe's Pro account): "Uploading… N%", then "To be
 * processed / Click Apply to begin" with its Apply button (it doesn't start by
 * itself on this account), "Processing… N%", and done with its Download. The
 * "40%" every card shows is its zoom, never progress.
 */
const cardState = (name: string) => `(() => {
  const card = ${cardOf(name)};
  if (!card) return null;
  const smartPro = [...card.querySelectorAll('ul[class*=radio] li')].find((li) => li.innerText.trim().toLowerCase() === '${MODE}');
  const text = card.innerText;
  const buttons = [...card.querySelectorAll('button')];
  const apply = buttons.find((b) => /^apply/i.test(b.innerText.trim()));
  const download = buttons.find((b) => /download/i.test(b.innerText));
  const percent = /Processing[^0-9]{0,8}(\\d{1,3})%/i.exec(text);
  const busy = /uploading|loading\\.\\.\\.|to be processed|processing/i.test(text);
  const videos = [...card.querySelectorAll('video')].map((v) => v.currentSrc || v.src).filter((src) => /^https?:/.test(src) && !/web_video\\//.test(src));
  return {
    smartPro: smartPro ? smartPro.className : null,
    ready: !!apply && !apply.disabled && /to be processed|click apply/i.test(text),
    percent: percent ? Number(percent[1]) : null,
    done: !!download && !download.disabled && !busy,
    videos,
  };
})()`;

/**
 * One piece through the remover on `page`: Smart pro chosen, the piece put in
 * from `pieceUrl` (fetched by the browser), waited for, and the full result's
 * URL. Throws VmakeError (the account's or the piece's).
 *
 * The page (Nov 17, Sphe's Pro account) is a stack of job cards, each with its
 * own modes (Smart pro off on a file over 5 minutes); a new file is a new
 * card, and processing starts by itself. On a page with no cards the mode is
 * chosen before the file goes in; with cards, on our own card (found by its
 * file's name) as it comes. Nobody else's card is ever touched.
 */
export async function removeOnPage(page: Page, remote: Remote, pieceUrl: string, name: string, site = SITE, onProgress: (percent: number) => void = () => {}): Promise<string> {
  await go(page, `${site}${REMOVER}`);
  await waitFor(page, `!!document.querySelector('.ant-upload-btn input[type=file][name=file]:not([multiple])')`, 60_000, "the remover's page");
  await pacing.wait();
  const problem = await accountProblem(page);
  if (problem !== null) throw problem;
  // A fresh page showing the modes: the mode first, since the upload starts processing by itself.
  // The account's job cards come a moment after the page (its task list): looked for a few seconds first.
  // A fresh page with no modes shown (Nov 17 afternoon: only Upload and Batch upload until a file goes in) chooses Smart pro on the piece's card, as a page with cards does.
  const cards = await waitFor<boolean>(page, `${CARDS}.length > 0`, 8_000, "the job cards", 500).catch(() => false);
  const mode = cards ? null : await waitFor<string>(page, `(() => { const li = ${MODE_ITEM}; return li ? li.className : null; })()`, 30_000, "Smart pro").catch(() => null);
  const fresh = mode !== null;
  if (mode !== null) {
    if (/disabled--/u.test(mode)) throw new VmakeError("vmake.ai doesn't offer Smart pro on the remover's page now", "piece");
    if (!/active--/u.test(mode)) {
      await click(page, MODE_ITEM);
      await waitFor(page, `(() => { const li = ${MODE_ITEM}; return !!li && /active--/.test(li.className); })()`, 15_000, "Smart pro chosen");
    }
    await pacing.wait();
  }
  const began = Date.now();
  const step = (what: string) => said(`vmake.ai ${name}: ${what} (${Math.round((Date.now() - began) / 1000)} s)`);
  await putPiece(page, remote, pieceUrl, name);
  step("in the page");
  // Our card, when the page makes one: Smart pro on it (a file of 5 minutes or less has it).
  const card = await waitFor<boolean>(page, `!!${cardOf(name)}`, fresh ? 15_000 : 120_000, "the piece's card", 1500).catch(() => false);
  if (card) {
    // Uploaded to Vmake from the browser (the card says how far), then waiting on Apply: Smart pro chosen first.
    step("its card");
    await waitFor(page, `(() => { const s = ${cardState(name)}; return !!s && (s.ready || s.percent !== null || s.done); })()`, 30 * 60_000, "the piece's upload to vmake.ai", 2000);
    const state = await page.evaluate<{ smartPro: string | null; ready: boolean } | null>(cardState(name));
    step(`uploaded: ${JSON.stringify(state)}`);
    if (state?.smartPro == null || /disabled--/u.test(state.smartPro)) throw new VmakeError("vmake.ai doesn't offer Smart pro for the piece", "piece");
    if (state.ready) {
      if (!/active--/u.test(state.smartPro)) {
        await pacing.wait();
        await click(page, `[...(${cardOf(name)}).querySelectorAll('ul[class*=radio] li')].find((li) => li.innerText.trim().toLowerCase() === '${MODE}')`);
        await waitFor(page, `(() => { const s = ${cardState(name)}; return !!s && /active--/.test(s.smartPro ?? ''); })()`, 15_000, "Smart pro chosen on the piece");
      }
      await pacing.wait();
      step("Smart pro chosen");
      await apply(page, name, step);
    } else if (!/active--/u.test(state.smartPro)) throw new VmakeError("vmake.ai began the piece in another mode than Smart pro", "piece");
  }
  // Processing: the result, or the account's or the file's trouble said on the page.
  const until = Date.now() + JOB_MS;
  let last = -1;
  let videos: string[] = [];
  let moved = Date.now();
  let pressedAgain = false;
  for (;;) {
    await Bun.sleep(3000 + Math.random() * 2000);
    if (card) {
      const state = await page.evaluate<{ percent: number | null; done: boolean; videos: string[] } | null>(cardState(name), 15_000).catch(() => null);
      if (state !== null && state.percent !== null && state.percent !== last) {
        onProgress((last = state.percent));
        moved = Date.now();
      }
      if (Date.now() - began > 0 && Math.round((Date.now() - began) / 1000) % 60 < 5) step(`waiting: ${JSON.stringify(state)}`);
      if (state !== null && state.done) {
        videos = state.videos;
        break;
      }
      // No progress for timing.stallMs: back at "To be processed" its Apply is pressed again (once), else the piece is given up on (tried again by the run).
      if (Date.now() - moved > timing.stallMs) {
        const now = await page.evaluate<{ ready: boolean } | null>(cardState(name)).catch(() => null);
        if (now?.ready === true && !pressedAgain) {
          pressedAgain = true;
          step("stalled at To be processed: Apply again");
          await apply(page, name, step);
          moved = Date.now();
        } else throw new VmakeError(`vmake.ai showed no progress on the piece for ${Math.round(timing.stallMs / 60_000)} minutes`, "piece");
      }
    } else {
      const state = await page.evaluate<{ video: string | null; full: boolean; percent: number | null }>(PROGRESS_SCRIPT, 15_000).catch(() => null);
      if (state !== null && state.percent !== null && state.percent !== last) onProgress((last = state.percent));
      if (state !== null && state.video !== null && state.full) {
        videos = [state.video];
        break;
      }
    }
    const problem = await accountProblem(page).catch(() => null);
    if (problem !== null) throw problem;
    if (Date.now() > until) throw new VmakeError("vmake.ai took over two hours on the piece", "piece");
  }
  await pacing.wait();
  // The full video, as a person downloads it: its address as the download starts, the file fetched by Edit.
  await page.call("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  const asked = new Promise<string | null>((resolve) => {
    const off = page.on("Page.downloadWillBegin", (params) => {
      off();
      resolve(typeof params.url === "string" ? params.url : null);
    });
    setTimeout(() => (off(), resolve(null)), 20_000);
  });
  await click(page, card ? `[...(${cardOf(name)}).querySelectorAll('button')].find((b) => /download/i.test(b.innerText))` : DOWNLOAD_FULL);
  // A choice of downloads (a free account's preview and full): the full one.
  await Bun.sleep(2500);
  await click(page, `[...document.querySelectorAll('.ant-dropdown *, .ant-popover *, .ant-modal *, [role=menu] *, [role=dialog] *')].find((el) => el.children.length === 0 && el.getClientRects().length > 0 && /full/i.test(el.innerText))`).catch(() => {});
  const url = (await asked) ?? videos[0] ?? null;
  // Asked to upgrade for the full video: the plan isn't Pro.
  const refused = await accountProblem(page).catch(() => null);
  if (refused !== null) throw refused;
  if (url === null || !/^https?:/u.test(url)) throw new VmakeError("vmake.ai gave no video to download", "piece");
  return url;
}

/**
 * The account's plan as /pricing says it ("Current plan: Pro"): an account
 * problem when it's signed out or on no paid plan (Smart pro and the daily
 * files are Pro's and Plus's).
 */
export async function plan(page: Page, site = SITE): Promise<string> {
  await go(page, `${site}/pricing`);
  const said = await waitFor<string>(page, `(() => { const m = /Current plan:\\s*([A-Za-z]+)/.exec(document.body.innerText); return m ? m[1] : null; })()`, 30_000, "the plan").catch(() => null);
  const problem = await accountProblem(page);
  if (problem !== null) throw problem;
  if (said === null || !/^(pro|plus|business|team|enterprise)$/iu.test(said)) throw new VmakeError(`vmake.ai says the plan is ${said ?? "none"}`, "account", "lapsed");
  return said;
}

/** Whether the profile's browser is signed in to vmake.ai (the remover's page shows no sign-in). */
export async function signedIn(page: Page, site = SITE): Promise<boolean> {
  await go(page, `${site}${REMOVER}`);
  await Bun.sleep(3000);
  return (await accountProblem(page))?.reason !== "signed_out";
}

// ---------------------------------------------------------------------------
// The provider's sessions

/** The day's files, kept beside the account's state (text_removal.ts's home file). */
export interface Day {
  date: string;
  files: number;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * One Browser Use session at a time for the account (two at once on one
 * profile isn't documented), up to TABS jobs in it, renewed past
 * SESSION_RENEW_MS between jobs, stopped when nothing's left.
 */
export class Driver {
  private session: { at: number; open: Promise<Session> } | null = null;
  private busy = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private readonly browsers: Browsers,
    private readonly site = SITE,
  ) {}

  private async slot(): Promise<void> {
    if (this.busy < TABS) {
      this.busy++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) return next();
    this.busy--;
    if (this.busy === 0) void this.close();
  }

  private async current(): Promise<Session> {
    if (this.session !== null && Date.now() - this.session.at > SESSION_RENEW_MS && this.busy <= 1) await this.close();
    // Each browser looks at the plan once, on its first tab, before any piece is sent.
    if (this.session === null) {
      this.session = {
        at: Date.now(),
        open: this.browsers.open().then(async (session) => {
          const page = await session.remote.tab();
          try {
            await plan(page, this.site);
          } catch (error) {
            await session.stop();
            throw error;
          } finally {
            page.close();
          }
          return session;
        }),
      };
    }
    const session = await this.session.open.catch((error: unknown) => {
      this.session = null;
      throw error;
    });
    if (session.remote.closed) {
      this.session = null;
      return this.current();
    }
    return session;
  }

  async close(): Promise<void> {
    const was = this.session;
    this.session = null;
    if (was !== null) await (await was.open.catch(() => null))?.stop();
  }

  /** One piece (at `pieceUrl`) cleaned: the result's URL. */
  async run(pieceUrl: string, name: string, onProgress?: (percent: number) => void): Promise<string> {
    await this.slot();
    try {
      // Tabs started a little apart, as a person would.
      if (this.busy > 1) await pacing.wait(5_000 + Math.random() * 10_000);
      for (let browser = 1; ; browser++) {
        const session = await this.current();
        const page = await session.remote.tab();
        try {
          return await removeOnPage(page, session.remote, pieceUrl, name, this.site, onProgress);
        } catch (error) {
          // A browser whose way out is down: another (alone, so no other tab's job goes with it).
          if (!(error instanceof ProxyDown) || browser >= 3 || this.busy > 1) throw error;
          diag.warn("removal", `vmake.ai: the cloud browser's proxy is down; another browser`);
          await this.close();
        } finally {
          page.close();
        }
      }
    } finally {
      this.release();
    }
  }
}

/** Fetches Vmake's result to `out`. */
export async function fetchResult(url: string, out: string): Promise<void> {
  const partial = `${out}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      await Bun.write(partial, response);
      fs.renameSync(partial, out);
      return;
    } catch (error) {
      fs.rmSync(partial, { force: true });
      if (attempt >= 3) throw new VmakeError(`fetching vmake.ai's result: ${diag.messageOf(error)}`, "piece");
      await Bun.sleep(2000 * attempt);
    }
  }
}

/** A piece put where the cloud browser can fetch it: R2 (a key it's kept under) and a presigned URL; `drop` removes it. */
export async function stage(file: string, key: string): Promise<{ url: string; drop: () => Promise<void> }> {
  await cloud.uploadFile(file, key);
  return { url: await cloud.presign(key, "GET", 3 * 3600), drop: () => cloud.remove([key]).catch(() => undefined) };
}

export { today };
