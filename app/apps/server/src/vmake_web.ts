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
// `ul[class*=radio]`: "Smart", "Smart pro"…, `active--` when chosen, `disabled--` when
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

import { createHash } from "node:crypto";

import * as cloud from "./cloud.ts";
import type { Page, Remote } from "./chrome_devtools.ts";
import * as devtools from "./chrome_devtools.ts";
import * as diag from "./diag.ts";
import { fetchFile } from "./ranged_download.ts";
import { classify, VmakeError } from "./vmake_api.ts";

export const SITE = "https://vmake.ai";

/** Where the driver's steps are said besides Edit's log: a script's console (`trace.on = console.log`). */
export const trace: { on: ((line: string) => void) | null } = { on: null };
function said(line: string): void {
  diag.info("removal", line);
  trace.on?.(line);
}
const REMOVER = "/video-watermark-remover/upload";
/**
 * Vmake's modes as the remover's page names them (each matched on its own
 * words, lower case: "Smart pro" is never "Smart"), and as they're said.
 * Smart Pro for an intro, Smart for a video's first cases (Sphe and JJ, Nov
 * 18: removal_modes.ts); Smart Pro is off on a file over 5 minutes.
 */
export type Mode = "pro" | "smart";
const LABEL: Record<Mode, string> = { pro: "smart pro", smart: "smart" };
export const SAID: Record<Mode, string> = { pro: "Smart pro", smart: "Smart" };
/** Pieces at once when the relay doesn't say (its AT_ONCE: one a browser). */
export const AT_ONCE = 3;
/**
 * The plan's free files a day, the team's: Pro's 50 for the remover, nothing
 * kept back for by-hand uploads (Sphe, Nov 17). Not a stop: past them
 * vmake.ai spends the plan's credits ("Credits can be used beyond this
 * quota"), so Edit goes on while it takes the jobs, each such file's credits
 * read before and after and said; vmake.ai's own refusal is the real stop
 * (`dailyLimit`). The page's own count (`Quota`, its purchase_config) says
 * what's left, by-hand uploads included.
 */
export const DAILY_FILES = 50;
/** Files a day Edit never goes past, whatever the credits: so a fault can't spend the month's credits. */
export const SANITY_FILES = 150;
/** Credits under which the editor says, in one line, that they're running low. */
export const LOW_CREDITS = 300;

/** Vmake's own name for each mode, in its purchase_config. */
export const MODELS = { pro: "video_remove_full_pro", smart: "video_remove_full" } as const;

/** The account's day as the remover's page loads it (its purchase_config): files left a mode, and its credits. */
export interface Quota {
  modes: Record<string, { remain: number | null; limit: number | null; seconds: number | null }>;
  balance: number | null;
  at: number;
}

/** The page's purchase_config answer read, or null when it isn't one. */
export function parseQuota(text: string): Quota | null {
  try {
    const given = JSON.parse(text) as { response?: { list?: { effect_model?: unknown; remain?: unknown; limit_count?: unknown; duration_limit?: unknown }[]; balance?: unknown } };
    const list = given.response?.list;
    if (!Array.isArray(list)) return null;
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const modes: Quota["modes"] = {};
    for (const one of list) if (typeof one.effect_model === "string") modes[one.effect_model] = { remain: number(one.remain), limit: number(one.limit_count), seconds: number(one.duration_limit) };
    return { modes, balance: number(given.response?.balance), at: Date.now() };
  } catch {
    return null;
  }
}

/** Every purchase_config answer the page loads itself, read off its own traffic (never asked for by Edit: their terms). */
function watchQuota(page: Page, onQuota: (quota: Quota) => void): () => void {
  const ids = new Set<string>();
  const offs = [
    page.on("Network.responseReceived", (params) => {
      const url = (params.response as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && url.includes("/vm/tool/purchase_config.json")) ids.add(String(params.requestId));
    }),
    page.on("Network.loadingFinished", (params) => {
      const id = String(params.requestId);
      if (!ids.delete(id)) return;
      void page
        .call("Network.getResponseBody", { requestId: id })
        .then((body) => {
          const quota = parseQuota(String(body.body ?? ""));
          if (quota !== null) onQuota(quota);
        })
        .catch(() => {});
    }),
  ];
  return () => offs.forEach((off) => off());
}

/**
 * A prompt to spend the plan's credits on a file past the free ones
 * (vmake.ai's "use N credits?"): accepted, as the plan's credits are what
 * it's for, its words said. Never one that says there aren't enough.
 */
async function acceptSpend(page: Page, name: string): Promise<void> {
  const prompt = await page
    .evaluate<string | null>(
      `(() => {
        const shown = (el) => !!el && el.getClientRects().length > 0;
        const box = [...document.querySelectorAll('.ant-modal, [role=dialog]')].find((el) => shown(el) && /credit/i.test(el.innerText) && !/insufficient|not enough|top up|buy more|purchase/i.test(el.innerText));
        if (!box) return null;
        const yes = [...box.querySelectorAll('button')].find((b) => shown(b) && /^(confirm|continue|ok|yes|use|start|apply|generate)/i.test(b.innerText.trim()));
        if (!yes) return null;
        const words = box.innerText.replace(/\s+/g, ' ').slice(0, 200);
        yes.click();
        return words;
      })()`,
    )
    .catch(() => null);
  if (prompt !== null) said(`vmake.ai ${name}: its prompt to spend credits accepted: "${prompt}"`);
}
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
  /**
   * A browser on the team's profile; `signIn`: with its live view, for an
   * admin. Waits while another Mac has the profile. `extra`: one more browser
   * with NO profile for the lease's holder (ExtraRefused when there's none).
   */
  open(signIn?: boolean, extra?: boolean): Promise<Session>;
}

/** How long a Mac waits its turn on the team's profile before a piece gives up for now, and between asks. */
export const turns = { waitMs: 3 * 3_600_000, everyMs: 45_000 };

/** The relay's answer to asking for a browser. */
type Lent = { id?: string; cdpUrl?: string; liveUrl?: string; busy?: string; full?: boolean };

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
    async open(signIn = false, extra = false) {
      const until = Date.now() + turns.waitMs;
      for (;;) {
        const lent = await call("/v1/vmake/browser", { holder, signIn, ...(extra ? { extra: true } : {}) });
        if (extra && (lent.full === true || lent.busy !== undefined)) throw new ExtraRefused(lent.full === true ? "the team's browsers at once are all out" : `${lent.busy} has the team's browser`);
        if (lent.busy === undefined && typeof lent.id === "string" && typeof lent.cdpUrl === "string") {
          const id = lent.id;
          const stop = () => call(`/v1/vmake/browser/${id}/stop`, { holder, ...(extra ? { extra: true } : {}) }).then(() => undefined, () => undefined);
          try {
            const remote = await devtools.remote(lent.cdpUrl, "Vmake's browser");
            return { id, liveUrl: lent.liveUrl ?? null, remote, stop: async () => (remote.close(), await stop()) };
          } catch (error) {
            await stop();
            throw new BrowserUnreachable(diag.messageOf(error));
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

/**
 * Whether vmake.ai's words say the day's allowance is used (its limit
 * reached, come back tomorrow), never a file's own trouble (too long, too
 * big, its format): the account's stop for the day, whatever Edit's count
 * says (the team uploads by hand too). The first such words are logged as
 * they're put, to learn Vmake's own wording.
 */
export function dailyLimit(said: string, card = false): VmakeError | null {
  const words = said.toLowerCase();
  const daily = classify(said, false).reason === "daily_limit" || (/\b(limit|limits|maximum|allowance|quota)\b/u.test(words) && /\b(reached|tomorrow|used up|exceeded|hit)\b/u.test(words));
  if (!daily || /\b(duration|length|size|minutes?|seconds?|mb|gb|resolution|format|too long|too large|file type)\b/u.test(words)) return null;
  if (!limitSaid) {
    limitSaid = true;
    diag.info("removal", `vmake.ai said the day's allowance is used, in its words: "${said.slice(0, 300)}"`);
  }
  // On the piece's own card it's that file refused (sent again tomorrow, under its next name); elsewhere on the page, the account's day.
  return new (card ? Refused : VmakeError)(`vmake.ai: ${said.slice(0, 160)}`, "account", "daily_limit");
}
let limitSaid = false;

async function accountProblem(page: Page): Promise<VmakeError | null> {
  const seen = await page.evaluate<{ said: string; signedOut: boolean }>(ACCOUNT_SCRIPT, 15_000);
  if (seen.signedOut) return new VmakeError("vmake.ai shows Edit's browser signed out", "account", "signed_out");
  const limit = seen.said === "" ? null : dailyLimit(seen.said);
  if (limit !== null) return limit;
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

/**
 * vmake.ai said, on the piece's own card, that it won't come back: the card
 * failed (credits returned), the page refused the file, the mode not offered for it,
 * the day's limit in its own words. Only then is a piece that went in sent
 * again, under its next name (a new file of the day). Any other trouble once
 * it went in (its card not found in time, the page not answering, still
 * processing at the deadline, the browser lost) can't say it's lost: it's
 * looked for again under the same name, never sent twice (GPT 6.2 Astra's
 * audit and Sphe's M4, Nov 17–18: a 3 s piece sat at 32% for two hours and
 * was sent again).
 */
export class Refused extends VmakeError {}

/** The team's cloud browser was lent but didn't connect (Chrome's connection timed out): nothing went in, try again soon. */
export class BrowserUnreachable extends VmakeError {
  constructor(why: string) {
    super(`the team's browser didn't connect: ${why}`, "piece");
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

/** The shown mode's item, "Smart pro" or "Smart" (the page keeps the list five times over, Nov 17; only one is on screen). */
const modeItem = (mode: Mode) => `[...document.querySelectorAll('ul[class*=radio] li')].find((li) => li.getClientRects().length > 0 && !li.closest('[class*=task-card]') && li.innerText.trim().toLowerCase() === '${LABEL[mode]}')`;
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

export async function putPiece(page: Page, remote: Remote, pieceUrl: string, name: string, handing: () => void = () => {}): Promise<void> {
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
  // From here the file may be in vmake.ai's hands, whatever this call hears back.
  handing();
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
export const timing = { stallMs: 3 * 60_000, lookMs: 60_000 };

/**
 * Presses our card's Apply and makes sure it took: the card leaves "To be
 * processed" (Nov 17: a press two seconds after choosing the mode was lost,
 * the card sat there 23 minutes; the same press a little later began it).
 * Pressed again up to three times, a few seconds apart, each looked at for 15 s.
 */
async function apply(page: Page, name: string, step: (what: string) => void): Promise<void> {
  for (let press = 1; press <= 3; press++) {
    await pacing.wait(2500 + Math.random() * 1500);
    await click(page, `[...(${cardOf(name)}).querySelectorAll('button')].find((b) => /^apply/i.test(b.innerText.trim()))`);
    // Past the free files vmake.ai may ask first to spend the plan's credits: yes.
    await Bun.sleep(800);
    await acceptSpend(page, name);
    const took = await waitFor<boolean>(page, `(() => { const s = ${cardState(name)}; return !!s && !s.ready; })()`, 15_000, "Apply taking", 1000).catch(() => false);
    step(took ? `applied (press ${press})` : `Apply didn't take (press ${press})`);
    if (took) return;
  }
  throw new VmakeError("vmake.ai didn't begin the piece when Apply was pressed", "piece");
}

/** The piece's mode chosen on its card, if it isn't already. */
async function modeOn(page: Page, name: string, mode: Mode, step: (what: string) => void): Promise<void> {
  const state = await page.evaluate<{ mode: string | null } | null>(cardState(name, mode));
  if (state === null) throw new VmakeError("vmake.ai's card for the piece went away", "piece");
  if (state.mode == null || /disabled--/u.test(state.mode)) throw new Refused(`vmake.ai doesn't offer ${SAID[mode]} for the piece`, "piece");
  if (!/active--/u.test(state.mode)) {
    await pacing.wait();
    await click(page, `[...(${cardOf(name)}).querySelectorAll('ul[class*=radio] li')].find((li) => li.innerText.trim().toLowerCase() === '${LABEL[mode]}')`);
    await waitFor(page, `(() => { const s = ${cardState(name, mode)}; return !!s && /active--/.test(s.mode ?? ''); })()`, 15_000, `${SAID[mode]} chosen on the piece`);
  }
  await pacing.wait();
  step(`${SAID[mode]} chosen`);
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
const cardState = (name: string, mode: Mode = "pro") => `(() => {
  const card = ${cardOf(name)};
  if (!card) return null;
  const mode = [...card.querySelectorAll('ul[class*=radio] li')].find((li) => li.innerText.trim().toLowerCase() === '${LABEL[mode]}');
  const text = card.innerText;
  const buttons = [...card.querySelectorAll('button')];
  const apply = buttons.find((b) => /^apply/i.test(b.innerText.trim()));
  const download = buttons.find((b) => /download/i.test(b.innerText));
  const percent = /Processing[^0-9]{0,8}(\\d{1,3})%/i.exec(text);
  const busy = /uploading|loading\\.\\.\\.|to be processed|processing/i.test(text);
  const videos = [...card.querySelectorAll('video')].map((v) => v.currentSrc || v.src).filter((src) => /^https?:/.test(src) && !/web_video\\//.test(src));
  return {
    mode: mode ? mode.className : null,
    ready: !!apply && !apply.disabled && /to be processed|click apply/i.test(text),
    percent: percent ? Number(percent[1]) : null,
    failed: /download failed|upload failed|failed to process|processing failed/i.test(text),
    text: text.replace(/\s+/g, ' ').slice(0, 300),
    done: !!download && !download.disabled && !busy,
    videos,
  };
})()`;

/**
 * One piece through the remover on `page`: its mode chosen, the piece put in
 * from `pieceUrl` (fetched by the browser), waited for, and the full result's
 * URL. Throws VmakeError (the account's or the piece's).
 *
 * The page (Nov 17, Sphe's Pro account) is a stack of job cards, each with its
 * own modes (Smart pro off on a file over 5 minutes); a new file is a new
 * card, and processing starts by itself. On a page with no cards the mode is
 * chosen before the file goes in; with cards, on our own card (found by its
 * file's name) as it comes. Nobody else's card is ever touched.
 */
/**
 * A piece's file name on vmake.ai: its own, never another's (the page finds a
 * piece's job card by it, among every card the account has; Nov 17, packed
 * pieces are mostly 300 s: "piece-300s.mp4" was many cards at once). From
 * `label` (its file, seconds and try) it's the same each time the piece is
 * asked for, so a card already there is picked up, after a restart too, and
 * never sent again.
 */
export const pieceName = (seconds: number, label?: string): string =>
  `edit-${label === undefined ? Math.random().toString(36).slice(2, 8) : createHash("sha256").update(label).digest("hex").slice(0, 8)}-${Math.round(seconds)}s.mp4`;

/** The account's credits as the page's pill shows them (null when it shows none). */
export async function creditsPill(page: Page): Promise<string | null> {
  return page.evaluate<string | null>(`[...document.querySelectorAll('[class*=credit], [class*=Credit], [class*=point]')].filter((el) => el.getClientRects().length > 0).map((el) => el.innerText.trim()).find((t) => /^[0-9,]+$/.test(t)) ?? null`).catch(() => null);
}

/** What removeOnPage is told along the way. */
export interface PieceHooks {
  /** The mode it's cleaned in: Smart Pro unless said. */
  mode?: Mode;
  progress?: (percent: number) => void;
  /** vmake.ai took the piece and is processing it (the account worked for it: the run's other pieces may go now). */
  begun?: () => void;
  /** About to send the file (it's counted then; a card already there sends nothing): whether it's past the free files (its credits read before and after). */
  sending?: () => Promise<boolean>;
  /** The account's day, each time the page loads it (files left a mode, credits). */
  quota?: (quota: Quota) => void;
  /**
   * A finished result from before (a card named as pieces were before Nov 17's
   * evening, `piece-<s>s.mp4`, as long as this one): whether it's this piece's
   * (the provider fetches and compares it). The first that is, is used:
   * nothing is sent (Sphe, Nov 17: the jobs given up on that afternoon had
   * finished on vmake.ai, already paid for).
   */
  adopt?: (url: string) => Promise<boolean>;
  /** The piece's length, for `adopt`'s cards. */
  seconds?: number;
  /**
   * Whether this name's file went in before (a run cut short, a restart, a
   * look again): then its card is looked for longer (`timing.lookMs`) and the
   * file is never sent again; a card not found is trouble for later, never
   * "absent".
   */
  sentBefore?: () => boolean;
  /** It may have gone in (kept by a build before it was said): its card looked for as long, and sent only if it isn't there. */
  lookLonger?: boolean;
  /** The file is going into the page now (from here it may be vmake.ai's, whatever comes back). */
  handed?: () => void;
}

/** The finished cards named `legacy` and as long as `seconds` (±0.2 s, as each card shows it), by their place in the list. */
const doneCards = (legacy: string, seconds: number) => `(() => {
  const all = ${CARDS};
  const length = (text) => { const m = /\\/\\s*(?:(\\d+):)?(\\d+):(\\d+(?:\\.\\d+)?)/.exec(text); return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null; };
  return all.map((el, at) => ({ el, at })).filter(({ el }) => {
    const text = el.innerText;
    const download = [...el.querySelectorAll('button')].find((b) => /download/i.test(b.innerText));
    const seen = length(text);
    return text.includes(${JSON.stringify(legacy)}) && !!download && !download.disabled && !/uploading|to be processed|processing|failed/i.test(text) && seen !== null && Math.abs(seen - ${seconds}) <= 0.2;
  }).map(({ at }) => at);
})()`;

/**
 * Every card of the list read while it's in view: `each` is called as the page
 * comes and again after each card is scrolled to, and the drawing stops once it
 * says so. The page draws a card's words only while it's near the view, and
 * loads more cards as it's scrolled (Nov 18, live: the newest card, at the top,
 * read blank right after the list was scrolled through and back, so a piece
 * picked up after a restart wasn't found for 5 minutes, and a script's look
 * never found it). Ends back at the top when nothing stopped it.
 */
async function drawCards(page: Page, each: () => Promise<boolean>): Promise<void> {
  if (await each()) return;
  const count = await page.evaluate<number>(`${CARDS}.length`).catch(() => 0);
  for (let at = 0; at < count; at++) {
    await page.evaluate(`(() => { ${CARDS}[${at}]?.scrollIntoView({ block: "center" }); return 1; })()`).catch(() => 0);
    await Bun.sleep(700);
    if (await each()) return;
  }
  await page.evaluate(`(() => { ${CARDS}[0]?.scrollIntoView({ block: "center" }); return 1; })()`).catch(() => 0);
}

/** A finished result on the account's list from before pieces had names of their own (`piece-<s>s.mp4`): its name, length and address. */
export interface Legacy {
  name: string;
  seconds: number;
  url: string;
}

/** The account's finished cards named as pieces were before Nov 17's evening, each with its result's address. */
export async function legacyCards(page: Page, site = SITE): Promise<Legacy[]> {
  await go(page, `${site}${REMOVER}`);
  if (!(await waitFor<boolean>(page, `${CARDS}.length > 0`, 15_000, "the job cards", 500).catch(() => false))) return [];
  // Each card's words read while it's drawn (they're gone again once it's out of view).
  const seen = new Map<number, { at: number; name: string; seconds: number }>();
  await drawCards(page, async () => {
    const drawn = await page.evaluate<{ at: number; name: string; seconds: number }[]>(`(() => {
      const length = (text) => { const m = /\\/\\s*(?:(\\d+):)?(\\d+):(\\d+(?:\\.\\d+)?)/.exec(text); return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null; };
      return ${CARDS}.map((el, at) => {
        const text = el.innerText;
        const name = /piece-\\d+s\\.mp4/.exec(text)?.[0] ?? null;
        const download = [...el.querySelectorAll('button')].find((b) => /download/i.test(b.innerText));
        const seconds = length(text);
        return name && download && !download.disabled && !/uploading|to be processed|processing|failed/i.test(text) && seconds !== null ? { at, name, seconds } : null;
      }).filter(Boolean);
    })()`).catch(() => []);
    for (const one of drawn) seen.set(one.at, one);
    return false;
  });
  const out: Legacy[] = [];
  for (const one of seen.values()) {
    const url = await downloadOf(page, one.at);
    if (url !== null && /^https?:/u.test(url)) out.push({ name: one.name, seconds: one.seconds, url });
  }
  said(`vmake.ai: ${out.length} finished result(s) from before on the account (${out.map((one) => `${one.name} ${one.seconds.toFixed(1)} s`).join(", ")})`);
  return out;
}

/** The full video's address as a download of card `at` (in the list) starts (null when none starts). */
async function downloadOf(page: Page, at: number): Promise<string | null> {
  await page.call("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  const asked = new Promise<string | null>((resolve) => {
    const off = page.on("Page.downloadWillBegin", (params) => {
      off();
      resolve(typeof params.url === "string" ? params.url : null);
    });
    setTimeout(() => (off(), resolve(null)), 20_000);
  });
  await click(page, `(() => { const el = ${CARDS}[${at}]; el?.scrollIntoView({ block: "center" }); return [...(el?.querySelectorAll('button') ?? [])].find((b) => /download/i.test(b.innerText)); })()`);
  await Bun.sleep(2500);
  await click(page, `[...document.querySelectorAll('.ant-dropdown *, .ant-popover *, .ant-modal *, [role=menu] *, [role=dialog] *')].find((el) => el.children.length === 0 && el.getClientRects().length > 0 && /full/i.test(el.innerText))`).catch(() => {});
  return asked;
}

/** Our card's state as `cardState` reads it. */
type CardSeen = { ready: boolean; percent: number | null; done: boolean; failed: boolean };

/**
 * Our card on the remover's page, looked for up to `ms`: the job list waited
 * for, every card drawn (the page writes a card's words only once it's been in
 * view), our name looked for; `again`: drawn and looked for again until `ms`
 * is up. `unsure`: a read of the page failed, so a card not found can't be
 * taken as absent.
 */
async function findCard(page: Page, name: string, ms: number, again: boolean): Promise<{ cards: boolean; state: CardSeen | null; unsure: boolean }> {
  const until = Date.now() + ms;
  const cards = await waitFor<boolean>(page, `${CARDS}.length > 0`, ms, "the job cards", 500).catch(() => false);
  if (!cards) {
    // No list at all: an empty account's page, or one that didn't answer.
    const answered = await page.evaluate<boolean>("true").then(() => true, () => false);
    return { cards, state: null, unsure: !answered };
  }
  let unsure = false;
  for (;;) {
    // Looked for as the list comes (a new card is at the top) and as each card is drawn, never after scrolling away.
    const seen: { state: CardSeen | null; failed: boolean } = { state: null, failed: false };
    await drawCards(page, async () => {
      seen.state = await page.evaluate<CardSeen | null>(cardState(name), 15_000).catch(() => ((seen.failed = true), null));
      return seen.state !== null;
    });
    if (seen.state !== null) return { cards, state: seen.state, unsure: false };
    unsure = seen.failed;
    if (!again || Date.now() > until) return { cards, state: null, unsure };
    await Bun.sleep(3000);
  }
}

/**
 * One piece through the remover's page: its card if vmake.ai has one already
 * (by name: processing, waiting on Apply, or done), else the file sent
 * (`piece`: its address, or what stages it, only then).
 */
export async function removeOnPage(page: Page, remote: Remote, piece: string | (() => Promise<string>), name: string, site = SITE, given: PieceHooks | ((percent: number) => void) = {}): Promise<string> {
  const hooks: PieceHooks = typeof given === "function" ? { progress: given } : given;
  // The page's own count of the day, as it loads it.
  const latest: { quota: Quota | null } = { quota: null };
  await page.call("Network.enable").catch(() => {});
  const stop = watchQuota(page, (quota) => {
    latest.quota = quota;
    hooks.quota?.(quota);
  });
  try {
    return await onPage(page, remote, piece, name, site, hooks, latest);
  } finally {
    stop();
  }
}

async function onPage(page: Page, remote: Remote, piece: string | (() => Promise<string>), name: string, site: string, hooks: PieceHooks, latest: { quota: Quota | null }): Promise<string> {
  const onProgress = hooks.progress ?? (() => {});
  const mode = hooks.mode ?? "pro";
  await go(page, `${site}${REMOVER}`);
  await waitFor(page, `!!document.querySelector('.ant-upload-btn input[type=file][name=file]:not([multiple])')`, 60_000, "the remover's page");
  await pacing.wait();
  const problem = await accountProblem(page);
  if (problem !== null) throw problem;
  const began = Date.now();
  const step = (what: string) => said(`vmake.ai ${name}: ${what} (${Math.round((Date.now() - began) / 1000)} s)`);
  // The account's job cards come a moment after the page (its task list): looked for a few seconds first, up to
  // `timing.lookMs` (drawn again and again) when this name went in before.
  const sentBefore = hooks.sentBefore?.() === true;
  const longer = sentBefore || hooks.lookLonger === true;
  const found = await findCard(page, name, longer ? timing.lookMs : 8_000, longer);
  const cards = found.cards;
  // Sent before and not seen: vmake.ai may still have it (a slow list, a page not answering): looked at again later, never sent twice.
  if (sentBefore && found.state === null) throw new VmakeError(found.unsure ? "vmake.ai's page didn't answer when its card was looked for" : "the piece's card isn't on vmake.ai's list yet", "piece");
  // Couldn't tell whether a card's there: nothing sent this time.
  if (found.unsure && found.state === null) throw new VmakeError("vmake.ai's page didn't answer when the job cards were read", "piece");
  // Its card from before. One vmake.ai gave up on ("Download failed… credits returned") is the piece's trouble: it's
  // sent once more, under its next try's name (never this one's, whose dead card the page still shows).
  const before = found.state;
  if (before?.failed === true) throw new Refused("vmake.ai failed the piece (its card says so)", "piece");
  let card = before !== null;
  let credits = false;
  let creditsBefore: string | null = null;
  if (before !== null) {
    // Sent before (a run cut short, a restart): its own card, picked up where it is.
    step(`its card from before: ${JSON.stringify(before)}`);
    if (before.ready) {
      await modeOn(page, name, mode, step);
      await apply(page, name, step);
    }
  } else {
    // Finished before under the old names (as long as this piece): the first that's this piece's is used, nothing sent.
    if (hooks.adopt !== undefined && hooks.seconds !== undefined && cards) {
      const legacy = `piece-${Math.round(hooks.seconds)}s.mp4`;
      const found = await page.evaluate<number[]>(doneCards(legacy, hooks.seconds)).catch(() => []);
      for (const at of found) {
        const url = await downloadOf(page, at);
        if (url !== null && /^https?:/u.test(url) && (await hooks.adopt(url))) {
          step(`${legacy}'s result from before is this piece's: used, nothing sent`);
          return url;
        }
        step(`${legacy} (card ${at}) is another piece's`);
      }
    }
    // A fresh page showing the modes: the mode first, since the upload starts processing by itself.
    // A fresh page with no modes shown (Nov 17 afternoon: only Upload and Batch upload until a file goes in) chooses the mode on the piece's card, as a page with cards does.
    const shown = cards ? null : await waitFor<string>(page, `(() => { const li = ${modeItem(mode)}; return li ? li.className : null; })()`, 30_000, SAID[mode]).catch(() => null);
    const fresh = shown !== null;
    if (shown !== null) {
      if (/disabled--/u.test(shown)) throw new VmakeError(`vmake.ai doesn't offer ${SAID[mode]} on the remover's page now`, "piece");
      if (!/active--/u.test(shown)) {
        await click(page, modeItem(mode));
        await waitFor(page, `(() => { const li = ${modeItem(mode)}; return !!li && /active--/.test(li.className); })()`, 15_000, `${SAID[mode]} chosen`);
      }
      await pacing.wait();
    }
    credits = (await hooks.sending?.()) ?? false;
    if (credits) creditsBefore = latest.quota?.balance?.toString() ?? (await creditsPill(page));
    await putPiece(page, remote, typeof piece === "string" ? piece : await piece(), name, () => hooks.handed?.());
    step("in the page");
    await acceptSpend(page, name);
    // Our card, when the page makes one: the mode on it (Smart pro only on a file of 5 minutes or less).
    card = await waitFor<boolean>(page, `!!${cardOf(name)}`, fresh ? 15_000 : 120_000, "the piece's card", 1500).catch(() => false);
    if (card) {
      // Uploaded to Vmake from the browser (the card says how far), then waiting on Apply: the mode chosen first.
      step("its card");
      await waitFor(page, `(() => { const s = ${cardState(name)}; return !!s && (s.ready || s.percent !== null || s.done || s.failed || /limit|allowance|tomorrow|quota|today|maximum/i.test(s.text)); })()`, 30 * 60_000, "the piece's upload to vmake.ai", 2000);
      const after = await page.evaluate<{ text: string; failed: boolean } | null>(cardState(name, mode)).catch(() => null);
      const refused = dailyLimit(after?.text ?? "", true);
      if (refused !== null) throw refused;
      if (after?.failed === true) throw new Refused(`vmake.ai didn't take the piece: ${after.text.slice(0, 120)}`, "piece");
      const state = await page.evaluate<{ mode: string | null; ready: boolean } | null>(cardState(name, mode));
      step(`uploaded: ${JSON.stringify(state)}`);
      if (state === null) throw new VmakeError("vmake.ai's card for the piece went away", "piece");
      if (state.mode == null || /disabled--/u.test(state.mode)) throw new Refused(`vmake.ai doesn't offer ${SAID[mode]} for the piece`, "piece");
      if (state.ready) {
        await modeOn(page, name, mode, step);
        await apply(page, name, step);
      } else if (!/active--/u.test(state.mode)) throw new Refused(`vmake.ai began the piece in another mode than ${SAID[mode]}`, "piece");
    }
  }
  hooks.begun?.();
  // Processing: the result, or the account's or the file's trouble said on the page.
  const until = Date.now() + JOB_MS;
  let last = -1;
  let videos: string[] = [];
  let moved = Date.now();
  let pressedAgain = 0;
  for (;;) {
    await Bun.sleep(3000 + Math.random() * 2000);
    if (card) {
      const state = await page.evaluate<{ percent: number | null; done: boolean; videos: string[]; text: string } | null>(cardState(name), 15_000).catch(() => null);
      // The card refused for the day (its own words): the account's stop, whatever Edit's count says.
      const refused = state === null ? null : dailyLimit(state.text, true);
      if (refused !== null) throw refused;
      if (state !== null && state.percent !== null && state.percent !== last) {
        onProgress((last = state.percent));
        moved = Date.now();
      }
      if (Date.now() - began > 0 && Math.round((Date.now() - began) / 1000) % 60 < 5) step(`waiting: ${JSON.stringify(state)}`);
      if (state !== null && state.done) {
        videos = state.videos;
        break;
      }
      // No change for timing.stallMs: only a card back at "To be processed" (its Apply lost) is pressed again, twice at
      // most. A card still processing is waited on, however slowly its percent moves (Nov 17, Sphe's M4: every piece
      // sat over three minutes at one percent while vmake.ai worked through several, each was given up on and sent
      // again, a file of the day each time, and none came back). A card gone is the piece's trouble.
      if (Date.now() - moved > timing.stallMs) {
        const now = await page.evaluate<{ ready: boolean; done: boolean } | null>(cardState(name)).catch(() => undefined);
        if (now === null) throw new VmakeError("vmake.ai's card for the piece went away", "piece");
        if (now?.ready === true) {
          if (pressedAgain >= 2) throw new VmakeError("vmake.ai didn't begin the piece when Apply was pressed again", "piece");
          pressedAgain += 1;
          step("back at To be processed: Apply again");
          await apply(page, name, step);
        } else step(`still processing at ${last}%`);
        moved = Date.now();
      }
    } else {
      const state = await page.evaluate<{ video: string | null; full: boolean; percent: number | null }>(PROGRESS_SCRIPT, 15_000).catch(() => null);
      if (state !== null && state.percent !== null && state.percent !== last) onProgress((last = state.percent));
      if (state !== null && state.video !== null && state.full) {
        videos = [state.video];
        break;
      }
    }
    await acceptSpend(page, name);
    const problem = await accountProblem(page).catch(() => null);
    if (problem !== null) throw problem;
    if (Date.now() > until) throw new VmakeError(`vmake.ai is still on the piece after two hours${last >= 0 ? ` (${last}%)` : ""}`, "piece");
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
  if (credits) {
    // Past the free files: what it cost in the plan's credits, to learn the price (read again from the page as it shows them).
    await go(page, `${site}${REMOVER}`).catch(() => {});
    await Bun.sleep(2000);
    const after = latest.quota?.balance?.toString() ?? (await creditsPill(page));
    diag.info("removal", `vmake.ai ${name}: past the day's free files: credits ${creditsBefore ?? "not shown"} before, ${after ?? "not shown"} after`);
  }
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

/** The relay had no more browsers for this Mac now (AT_ONCE in all, or the lease another Mac's): its pieces use the ones it has. */
export class ExtraRefused extends Error {}

/**
 * The profile's browser's sign-in to `site` copied into another browser,
 * which never had the profile: its cookies, and the site's local storage
 * (vmake.ai keeps its sign-in there too: with the cookies alone, Nov 17, a
 * piece's upload never finished and its card went). The count copied.
 */
export async function copySignIn(from: Remote, to: Remote, site = SITE): Promise<number> {
  const host = new URL(site).hostname.replace(/^www\./u, "");
  const all = ((await from.call("Storage.getCookies")) as { cookies?: Record<string, unknown>[] }).cookies ?? [];
  const cookies = all
    .filter((one) => typeof one.domain === "string" && one.domain.replace(/^\./u, "").endsWith(host))
    .map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path, expires, httpOnly, secure, ...(sameSite ? { sameSite } : {}) }));
  if (cookies.length > 0) await to.call("Storage.setCookies", { cookies });
  const read = await from.tab();
  let storage: Record<string, string> = {};
  try {
    await go(read, site);
    storage = JSON.parse(await read.evaluate<string>(`JSON.stringify(Object.fromEntries(Object.entries(localStorage)))`)) as Record<string, string>;
  } finally {
    read.close();
  }
  const write = await to.tab();
  try {
    await go(write, site);
    await write.evaluate(`(() => { const given = ${JSON.stringify(storage)}; for (const [key, value] of Object.entries(given)) localStorage.setItem(key, value); })()`);
  } finally {
    write.close();
  }
  return cookies.length + Object.keys(storage).length;
}

/** A browser the Driver holds: the profile's, or an extra one; a piece in it at a time. */
interface Held {
  open: Promise<Session>;
  at: number;
  busy: boolean;
  extra: boolean;
}

/**
 * The team's browsers for this Mac's pieces, one piece a browser (its upload
 * in a tab in front: Chrome slows a tab behind another; a machine each):
 * the profile's browser (the relay's lease), then
 * up to `atOnce` − 1 more with no profile, its vmake.ai sign-in copied into
 * each (none of them ever writes the profile). Renewed past SESSION_RENEW_MS
 * between pieces, all stopped when nothing's left.
 */
export class Driver {
  private writer: Held | null = null;
  private extras: Held[] = [];
  private pieces = 0;
  private waiting: (() => void)[] = [];
  /** Until when no more extra browsers are asked for (the relay had none; or one wasn't signed in: never again here). */
  private noMore = 0;

  constructor(
    private readonly browsers: Browsers,
    private readonly site = SITE,
    private readonly atOnce: () => number = () => AT_ONCE,
  ) {}

  private async slot(): Promise<void> {
    if (this.pieces < this.atOnce()) {
      this.pieces++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) return next();
    this.pieces--;
    if (this.pieces === 0) void this.close();
  }

  /** The profile's browser: it looks at the plan once, on its first tab, before any piece is sent. */
  private openWriter(): Held {
    return {
      at: Date.now(),
      busy: false,
      extra: false,
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

  /** An extra browser: the profile's sign-in copied in, and looked at once (one that shows signed out is never used: no extra ones here after). */
  private openExtra(writer: Held): Held {
    return {
      at: Date.now(),
      busy: true,
      extra: true,
      open: this.browsers.open(false, true).then(async (session) => {
        try {
          const copied = await copySignIn((await writer.open).remote, session.remote, this.site);
          const page = await session.remote.tab();
          try {
            if (copied === 0 || !(await signedIn(page, this.site))) {
              this.noMore = Infinity;
              throw new ExtraRefused("the profile's sign-in didn't carry into another browser");
            }
          } finally {
            page.close();
          }
          return session;
        } catch (error) {
          await session.stop();
          throw error;
        }
      }),
    };
  }

  private async drop(held: Held): Promise<void> {
    if (this.writer === held) this.writer = null;
    this.extras = this.extras.filter((one) => one !== held);
    await (await held.open.catch(() => null))?.stop();
  }

  /** A browser of its own for one piece: the profile's when it's free, else a free extra one, else a new one, else wait for one. */
  private async browser(): Promise<{ held: Held; session: Session }> {
    for (;;) {
      for (const one of [this.writer, ...this.extras]) if (one !== null && !one.busy && Date.now() - one.at > SESSION_RENEW_MS) await this.drop(one);
      if (this.writer === null) this.writer = this.openWriter();
      const writer = this.writer;
      if (!writer.busy) {
        writer.busy = true;
        const session = await writer.open.catch((error: unknown) => {
          writer.busy = false;
          if (this.writer === writer) this.writer = null;
          throw error;
        });
        if (!session.remote.closed) return { held: writer, session };
        await this.drop(writer);
        continue;
      }
      const idle = this.extras.find((one) => !one.busy);
      if (idle !== undefined) {
        idle.busy = true;
        const session = await idle.open.catch(() => null);
        if (session !== null && !session.remote.closed) return { held: idle, session };
        await this.drop(idle);
        continue;
      }
      if (Date.now() > this.noMore) {
        const held = this.openExtra(writer);
        this.extras.push(held);
        try {
          return { held, session: await held.open };
        } catch (error) {
          this.extras = this.extras.filter((one) => one !== held);
          if (!(error instanceof ExtraRefused)) throw error;
          if (this.noMore !== Infinity) this.noMore = Date.now() + 60_000;
          said(`vmake.ai: no more browsers now (${error.message}); this piece waits for one of the ${1 + this.extras.length} there`);
          continue;
        }
      }
      // Every browser busy and no more to be had: the first to free goes to this piece.
      await Bun.sleep(3000);
    }
  }

  async close(): Promise<void> {
    const all = [this.writer, ...this.extras].filter((one): one is Held => one !== null);
    this.writer = null;
    this.extras = [];
    await Promise.all(all.map(async (one) => (await one.open.catch(() => null))?.stop()));
  }

  /** The account's finished results from before (`legacyCards`), in a browser of the Driver's. */
  async legacy(): Promise<Legacy[]> {
    await this.slot();
    let got: { held: Held; session: Session } | null = null;
    try {
      got = await this.browser();
      const page = await got.session.remote.tab();
      try {
        return await legacyCards(page, this.site);
      } finally {
        page.close();
      }
    } finally {
      if (got !== null) got.held.busy = false;
      this.release();
    }
  }

  /** One piece (at `pieceUrl`) cleaned: the result's URL. */
  async run(piece: string | (() => Promise<string>), name: string, hooks: PieceHooks = {}): Promise<string> {
    await this.slot();
    let got: { held: Held; session: Session } | null = null;
    try {
      // Pieces started a little apart, as a person would.
      if (this.pieces > 1) await pacing.wait(3_000 + Math.random() * 5_000);
      for (let attempt = 1; ; attempt++) {
        got = await this.browser();
        const page = await got.session.remote.tab();
        try {
          return await removeOnPage(page, got.session.remote, piece, name, this.site, hooks);
        } catch (error) {
          // A browser whose way out is down: another.
          if (!(error instanceof ProxyDown) || attempt >= 3) throw error;
          diag.warn("removal", `vmake.ai: the cloud browser's proxy is down; another browser`);
          await this.drop(got.held);
          got = null;
        } finally {
          page.close();
        }
      }
    } finally {
      if (got !== null) got.held.busy = false;
      this.release();
    }
  }
}

/** Fetches Vmake's result to `out` (streamed, a stall ends it: ranged_download.ts `fetchFile`). */
export async function fetchResult(url: string, out: string): Promise<void> {
  try {
    await fetchFile(url, out, { what: "fetching vmake.ai's result" });
  } catch (error) {
    throw new VmakeError(diag.messageOf(error), "piece");
  }
}

/** A piece put where the cloud browser can fetch it: R2 (a key it's kept under) and a presigned URL; `drop` removes it. */
export async function stage(file: string, key: string): Promise<{ url: string; drop: () => Promise<void> }> {
  await cloud.uploadFile(file, key);
  return { url: await cloud.presign(key, "GET", 3 * 3600), drop: () => cloud.remove([key]).catch(() => undefined) };
}

export { today };
