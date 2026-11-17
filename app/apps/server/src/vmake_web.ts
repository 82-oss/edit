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
// The file gets into the input from inside the page: the page fetches a path
// of vmake.ai's own, which DevTools' Fetch domain sends on to the piece's
// presigned R2 URL (the page never sees the move, so no CORS), and the Blob
// goes in through a DataTransfer and a change event. Browser Use has no upload
// into a session's disk for files this size (v2's is 10 MiB, documents only).
//
// Browser Use (Nov 17): $0.06 a browser-hour by the minute, $0.20 a GB with
// its proxy off (vmake.ai shows no bot check), sessions of at most 240
// minutes, 10 at once on pay-as-you-go; a profile keeps cookies and storage,
// saved when its browser stops.

import * as fs from "node:fs";

import * as cloud from "./cloud.ts";
import type { Page, Remote } from "./chrome_devtools.ts";
import * as devtools from "./chrome_devtools.ts";
import * as diag from "./diag.ts";
import { classify, textOf, VmakeError } from "./vmake_api.ts";

export const SITE = "https://vmake.ai";
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
const SESSION_MINUTES = 240;
/** A session's age after which it's let go once its tabs are done (another takes over). */
const SESSION_RENEW_MS = 180 * 60_000;

// ---------------------------------------------------------------------------
// Browser Use

const API = "https://api.browser-use.com/api/v4";

export interface Session {
  id: string;
  /** Where a person can see and use it (a credential: anyone with it can). */
  liveUrl: string | null;
  remote: Remote;
  /** Stops it (its profile is saved then). */
  stop(): Promise<void>;
}

/** What starts browsers: Browser Use's, or a stand-in in tests. */
export interface Browsers {
  open(profile: string | null): Promise<Session>;
  profile(name: string): Promise<string>;
}

export function browserUse(key: string, api = API): Browsers {
  const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetch(`${api}${path}`, { method, headers: { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new VmakeError(`Browser Use didn't answer: ${diag.messageOf(error)}`, "piece");
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403 || response.status === 402) throw new VmakeError(`Browser Use refused (${response.status}): ${text.slice(0, 160)}`, "account", response.status === 402 ? "out_of_credits" : "keys_refused");
    if (response.status === 429) throw new VmakeError("Browser Use has no browser free (too many at once)", "piece");
    if (!response.ok) throw new VmakeError(`Browser Use: ${response.status} ${text.slice(0, 160)}`, "piece");
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  };
  return {
    async open(profile) {
      const made = await call("POST", "/browsers", { proxyCountryCode: null, timeout: SESSION_MINUTES, ...(profile !== null ? { profileId: profile } : {}) });
      const id = textOf(made.id);
      const stop = () => call("PATCH", `/browsers/${id}`, { action: "stop" }).then(() => undefined, () => undefined);
      try {
        const remote = await devtools.remote(textOf(made.cdpUrl), "Vmake's browser");
        return { id, liveUrl: typeof made.liveUrl === "string" ? made.liveUrl : null, remote, stop: async () => (remote.close(), await stop()) };
      } catch (error) {
        await stop();
        throw new VmakeError(`Browser Use's browser didn't connect: ${diag.messageOf(error)}`, "piece");
      }
    },
    async profile(name) {
      return textOf((await call("POST", "/profiles", { name })).id);
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
  const signedOut = buttons.some((text) => /^(log ?in|sign ?in|sign up|log in \\/ sign up)$/.test(text)) && !document.querySelector('[class*=avatar]');
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

async function go(page: Page, url: string): Promise<void> {
  const loaded = new Promise<void>((resolve) => {
    const stop = page.on("Page.loadEventFired", () => {
      stop();
      resolve();
    });
  });
  await page.call("Page.navigate", { url });
  await Promise.race([loaded, Bun.sleep(45_000)]);
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

const MODE_ITEM = `[...document.querySelectorAll('ul[class*=radio] li')].find((li) => li.innerText.trim().toLowerCase() === '${MODE}')`;
const DOWNLOAD_FULL = `[...document.querySelectorAll('button, a')].find((el) => /download full video/i.test(el.innerText))`;
/** The page's state while it works: the result's URL once it's there, the percent while processing. */
const PROGRESS_SCRIPT = `(() => {
  const video = [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src).find((src) => /^https?:.*\\.mp4(\\?|$)/.test(src) && !src.startsWith('blob:'));
  const full = ${DOWNLOAD_FULL};
  const percent = /Processing[^0-9]{0,6}(\\d{1,3})%/.exec(document.body.innerText);
  return { video: video ?? null, full: !!full, percent: percent ? Number(percent[1]) : null };
})()`;

/**
 * One piece through the remover on `page`: Smart pro chosen, the piece put in
 * from `pieceUrl` (fetched by the browser), waited for, and the full result's
 * URL. Throws VmakeError (the account's or the piece's).
 */
export async function removeOnPage(page: Page, pieceUrl: string, name: string, site = SITE, onProgress: (percent: number) => void = () => {}): Promise<string> {
  await go(page, `${site}${REMOVER}`);
  await waitFor(page, `!!document.querySelector('.ant-upload-btn input[type=file][name=file]:not([multiple])')`, 60_000, "the remover's page");
  await pacing.wait();
  const problem = await accountProblem(page);
  if (problem !== null) throw problem;
  // The mode first: the upload starts processing by itself.
  const mode = await waitFor<string>(page, `(() => { const li = ${MODE_ITEM}; return li ? li.className : null; })()`, 30_000, "Smart pro");
  if (/disabled--/u.test(mode)) throw new VmakeError("vmake.ai offers this account no Smart pro (its plan)", "account", "lapsed");
  if (!/active--/u.test(mode)) {
    await click(page, MODE_ITEM);
    await waitFor(page, `(() => { const li = ${MODE_ITEM}; return !!li && /active--/.test(li.className); })()`, 15_000, "Smart pro chosen");
  }
  await pacing.wait();
  // The piece, fetched by the page from a path of its own that DevTools sends on to R2.
  const path = `/__edit_piece/${Date.now()}-${Math.round(Math.random() * 1e9)}/${encodeURIComponent(name)}`;
  await page.call("Fetch.enable", { patterns: [{ urlPattern: `*__edit_piece*`, requestStage: "Request" }] });
  const stop = page.on("Fetch.requestPaused", (params) => {
    const url = String(params.request && (params.request as { url?: string }).url);
    void page.call("Fetch.continueRequest", { requestId: params.requestId, ...(url.includes(path) ? { url: pieceUrl } : {}) }).catch(() => {});
  });
  try {
    const put = await page.evaluate<string>(
      `(async () => {
        const response = await fetch(${JSON.stringify(path)});
        if (!response.ok) return 'fetch ' + response.status;
        const file = new File([await response.blob()], ${JSON.stringify(name)}, { type: 'video/mp4' });
        const input = document.querySelector('.ant-upload-btn input[type=file][name=file]:not([multiple])');
        const files = new DataTransfer();
        files.items.add(file);
        input.files = files.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`,
      30 * 60_000,
    );
    if (put !== "ok") throw new VmakeError(`the piece didn't reach the browser (${put})`, "piece");
  } finally {
    stop();
    await page.call("Fetch.disable").catch(() => {});
  }
  // Processing: the result, or the account's or the file's trouble said on the page.
  const until = Date.now() + JOB_MS;
  let last = -1;
  for (;;) {
    await Bun.sleep(3000 + Math.random() * 2000);
    const state = await page.evaluate<{ video: string | null; full: boolean; percent: number | null }>(PROGRESS_SCRIPT, 15_000).catch(() => null);
    if (state !== null && state.percent !== null && state.percent !== last) onProgress((last = state.percent));
    if (state !== null && state.video !== null && state.full) break;
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
  await click(page, DOWNLOAD_FULL);
  const url = (await asked) ?? (await page.evaluate<{ video: string | null }>(PROGRESS_SCRIPT)).video;
  // Asked to upgrade for the full video: the plan isn't Pro.
  const refused = await accountProblem(page).catch(() => null);
  if (refused !== null) throw refused;
  if (url === null || !/^https?:/u.test(url)) throw new VmakeError("vmake.ai gave no video to download", "piece");
  return url;
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
    private readonly profile: string | null,
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
    if (this.session === null) this.session = { at: Date.now(), open: this.browsers.open(this.profile) };
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
      const session = await this.current();
      const page = await session.remote.tab();
      try {
        return await removeOnPage(page, pieceUrl, name, this.site, onProgress);
      } finally {
        page.close();
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
