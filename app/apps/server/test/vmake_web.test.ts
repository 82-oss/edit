// vmake_web.ts against a stand-in of vmake.ai's remover (the selectors the
// Mac's agent mapped on Nov 17): Smart pro chosen before the file goes in, the
// piece fetched by the page from another origin (R2's stand-in) through
// DevTools' Fetch rewrite, the progress followed, the full video's address
// taken as its download starts; and the account's troubles (signed out, no
// Smart pro on the plan, the day's files used) said as the account's. Driven
// in a real headless Chrome over DevTools, as a Browser Use session is.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { devToolsPort, remote } from "../src/chrome_devtools.ts";
import { join } from "../src/paths.ts";
import * as tr from "../src/text_removal.ts";
import { VmakeError } from "../src/vmake_api.ts";
import * as web from "../src/vmake_web.ts";
import { scratch } from "./helpers/home.ts";

const CHROME = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => fs.existsSync(path));

/** What the stand-in page saw, and how it behaves. */
const seen = { mode: "", bytes: 0, uploads: 0, others: 0 };
/** `cards`: the page as Sphe's account showed it (Nov 17): a stack of job cards, a teammate's long file among them. */
/** `noModes`: a fresh page as it showed on Nov 17 afternoon: no modes until a file goes in, then its card (waiting on Apply). */
/** `stall`: a job that sits at one percent for `slowMs` (as vmake.ai's did for minutes, Nov 17), then finishes. */
/** `legacy`: a finished card from before named as pieces were (piece-8s.mp4, 8 s long); `existing`: a finished card of this name. */
/** `cardLimit`: the piece's own card refuses it for the day (as a by-hand upload of the team's could have used the allowance). */
/** `remain`/`balance`: the account's day as the page's own purchase_config says it; `spend`: a "use credits?" prompt before the job starts. */
/** `failed`: a card of this name vmake.ai gave up on ("Download failed, credits returned"). */
/** `startOn`: the mode the page (and a new card) starts on: Smart, as vmake.ai's does; another to see a mode chosen. */
const site = { signedOut: false, noSmartPro: false, dailyLimit: false, free: false, cards: false, stall: false, slowMs: 0, noModes: false, legacy: false, existing: "", failed: "", cardLimit: false, remain: 37, balance: 4110, spend: false, startOn: "Smart" };
const PIECE = new Uint8Array(3_000_000).map((_, at) => at % 251);

const PAGE = () => `<!doctype html><html><body>
<header>${site.signedOut ? '<button>Log in</button>' : '<div class="user-avatar--x1">S</div>'}</header>
<div class="ant-segmented" aria-label="segmented control"><div>Auto</div><div>Manual</div></div>
${site.noModes ? "" : `<div style="display:none"><ul class="radio--q7"><li class="item--a ${site.startOn === "Smart" ? "active--z" : ""}">Smart</li><li class="item--a disabled--d">Smart pro</li></ul></div>
<ul class="radio--q7">${["Smart", "Smart pro", "Subtitle", "Watermark", "Passerby"].map((mode) => `<li class="item--a ${mode === site.startOn ? "active--z" : ""} ${mode === "Smart pro" && site.noSmartPro ? "disabled--d" : ""}">${mode}</li>`).join("")}</ul>`}
<span class="ant-upload-btn"><input type="file" name="file" accept=".mp4,.mov"></span>
<span class="ant-upload-btn"><input type="file" name="file" multiple></span>
<div id="work">${site.cards ? `<div class="viewport-task-card--o5h" id="other"><span>v3p2.mp4</span> 40% <ul class="radio--q7"><li class="item--a active--z">Smart</li><li class="item--a disabled--d">Smart pro</li></ul><button>Download</button></div>` : ""}${[site.legacy ? "piece-8s.mp4" : "", site.existing].filter(Boolean).map((name) => `<div class="viewport-task-card--o5h"><span>${name}</span> 00:00.04 / 00:08.00 60% <button onclick="location.href='/result.mp4?full=1'">Download</button></div>`).join("")}${site.failed ? `<div class="viewport-task-card--o5h"><span>${site.failed}</span> 00:00.00 / 00:08.00 Download failed, credits returned <button disabled>Download</button></div>` : ""}</div>
<script>
fetch('/vm/tool/purchase_config.json').then((r) => r.text());
document.getElementById('other')?.addEventListener('click', () => fetch('/record-other', { method: 'POST' }));
document.querySelectorAll('ul[class*=radio] li').forEach((li) => li.addEventListener('click', () => {
  if (/disabled--/.test(li.className)) return;
  document.querySelectorAll('ul[class*=radio] li').forEach((one) => one.classList.remove('active--z'));
  li.classList.add('active--z');
}));
document.querySelector('input:not([multiple])').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  // A fresh page starts at once in the mode chosen (the cards' page waits on Apply).
  if (!${site.cards || site.noModes}) await fetch('/record', { method: 'POST', body: JSON.stringify({ mode: document.querySelector('li.active--z').innerText, bytes: file.size }) });
  const work = document.getElementById('work');
  if (${site.cards || site.noModes}) {
    // A card of its own, as Sphe's Pro account shows it: uploading, then waiting on Apply (Smart first), processing, Download.
    const card = document.createElement('div');
    card.className = 'viewport-task-card--o5h';
    card.innerHTML = '<i>Uploading... 0%</i> 00:00.00 / 00:08.00 40% <span>' + file.name + '</span> <ul class="radio--q7">' + ['Smart', 'Smart pro', 'Subtitle'].map((mode) => '<li class="item--a' + (mode === ${JSON.stringify(site.startOn)} ? ' active--z' : '') + '">' + mode + '</li>').join('') + '</ul><button>40%</button>';
    work.prepend(card);
    card.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
      if (/Uploading/.test(card.innerText)) return;
      card.querySelectorAll('li').forEach((one) => one.classList.remove('active--z'));
      li.classList.add('active--z');
    }));
    setTimeout(() => {
      if (${site.cardLimit}) { card.querySelector('i').textContent = "Upload failed. You've reached the maximum number of uploads for today."; return; }
      card.querySelector('i').textContent = 'To be processed Click Apply to begin';
      const apply = document.createElement('button');
      apply.textContent = 'Apply';
      card.append(apply);
      // The first press is lost, as Sphe's account lost the driver's (Nov 17); a stalled job never moves.
      let pressed = 0;
      apply.addEventListener('click', () => {
        if (++pressed === 1) return;
        if (${site.spend} && !card.dataset.spent) {
          // Past the free files: the plan's credits, asked first.
          const box = document.createElement('div');
          box.className = 'ant-modal';
          box.innerHTML = '<p>This file is past the free uses of the day: it will use 12 credits.</p><button>Continue</button>';
          document.body.append(box);
          box.querySelector('button').addEventListener('click', () => { card.dataset.spent = '1'; box.remove(); apply.click(); });
          return;
        }
        fetch('/record', { method: 'POST', body: JSON.stringify({ mode: card.querySelector('li.active--z').innerText, bytes: file.size }) });
        apply.remove();
        let percent = 0;
        // Slow: at 50% for a long while, then on.
        const hold = ${site.stall ? site.slowMs : 0};
        let held = 0;
        const tick = setInterval(() => {
          if (percent === 50 && held < hold) { held += 150; return; }
          percent += 25;
          card.querySelector('i').textContent = percent < 100 ? 'Processing… ' + percent + '%, Est. 1 min' : '';
          if (percent >= 100) {
            clearInterval(tick);
            const button = document.createElement('button');
            button.textContent = 'Download';
            button.addEventListener('click', () => (location.href = '/result.mp4?full=1'));
            card.append(button);
          }
        }, 150);
      });
    }, 600);
    return;
  }
  if (${site.dailyLimit}) { work.innerHTML = '<div class="ant-modal">You have reached today\\'s limit for this feature. Upgrade or come back tomorrow.</div>'; return; }
  let percent = 0;
  const tick = setInterval(() => {
    percent += 25;
    work.innerHTML = '<div>Processing… ' + percent + '%, Est. 1 min</div><button class="ant-btn ant-btn-loading">Processing...</button>';
    if (percent >= 100) {
      clearInterval(tick);
      work.innerHTML = '<video src="' + location.origin + '/result.mp4"></video><a href="/result.mp4">Download 5s preview video (Free!)</a> <a href="/result.mp4?full=1">Download full video</a>';
    }
  }, 150);
});
</script></body></html>`;

let vmake: ReturnType<typeof Bun.serve>;
let r2: ReturnType<typeof Bun.serve>;
let chrome: { kill(): void } | null = null;
let profile = "";
let cdp = "";

beforeAll(async () => {
  vmake = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/vm/tool/purchase_config.json")
        return Response.json({ meta: { code: 0 }, response: { list: [{ effect_model: "video_remove_full_pro", remain: site.remain, limit_count: 50, duration_limit: 300 }, { effect_model: "video_remove_full", remain: site.remain, limit_count: 50, duration_limit: 600 }], balance: site.balance } });
      if (url.pathname === "/pricing") return new Response(`<html><body>${site.signedOut ? "<button>Get Started</button>" : '<div class="ant-avatar avatar--x">S</div><button>Workspace</button>'}<p>Current plan: ${site.free ? "Free" : "Pro"}</p></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/video-watermark-remover/upload") return new Response(PAGE(), { headers: { "content-type": "text/html" } });
      if (url.pathname === "/record") {
        const said = (await request.json()) as { mode: string; bytes: number };
        seen.mode = said.mode;
        seen.bytes = said.bytes;
        seen.uploads += 1;
        return new Response("ok");
      }
      if (url.pathname === "/record-other") {
        seen.others += 1;
        return new Response("ok");
      }
      if (url.pathname === "/result.mp4") return new Response(new Uint8Array([1, 2, 3, url.searchParams.has("full") ? 9 : 5]), { headers: { "content-type": "video/mp4", "content-disposition": "attachment; filename=result.mp4" } });
      return new Response("no", { status: 404 });
    },
  });
  // R2's stand-in: another origin, no CORS headers (the page never sees it).
  r2 = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // Ranges, as R2 answers them (the browser reads a piece in ranges: Browser Use cuts off a big response).
    fetch(request) {
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers.get("range") ?? "");
      if (range === null) return new Response(PIECE, { headers: { "content-type": "video/mp4" } });
      const from = Number(range[1]);
      const to = range[2] === "" ? PIECE.length - 1 : Math.min(PIECE.length - 1, Number(range[2]));
      return new Response(PIECE.slice(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${PIECE.length}` } });
    },
  });
  if (CHROME === undefined) return;
  profile = fs.mkdtempSync(join(os.tmpdir(), "edit-vmake-web-"));
  chrome = Bun.spawn([CHROME, "--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const port = await devToolsPort(profile);
  cdp = `http://127.0.0.1:${port}`;
  web.pacing.wait = async () => {};
  // A headless Chrome's first start can take longer than bun's 5 s for a hook on a loaded 8 GB Mac (kenobi, Nov 18:
  // the whole file failed as "(unnamed)", a beforeAll timed out, in 2 of 3 runs beside an export).
}, 30_000);

afterAll(() => {
  void vmake?.stop(true);
  void r2?.stop(true);
  chrome?.kill();
  if (profile !== "") fs.rmSync(profile, { recursive: true, force: true });
});

/** The relay's lent browser's stand-in: the local Chrome, a "session" a connection to it. */
const browsers: web.Browsers = {
  async open() {
    const one = await remote(cdp, "the stand-in browser");
    return { id: "local", liveUrl: "https://live.example/abc", remote: one, stop: async () => one.close() };
  },
};

const piece = () => `http://127.0.0.1:${r2.port}/edit/cleaned/send/piece.mp4?X-Amz-Signature=x`;

test.skipIf(CHROME === undefined)("a piece goes through the stand-in remover: Smart pro first, the file from R2 in the page, the full video's address", async () => {
  const session = await browsers.open();
  try {
    const page = await session.remote.tab();
    const progress: number[] = [];
    const url = await web.removeOnPage(page, session.remote, piece(), "piece-8s.mp4", `http://localhost:${vmake.port}`, (percent) => progress.push(percent));
    expect(seen).toEqual({ mode: "Smart pro", bytes: PIECE.length, uploads: 1, others: 0 });
    expect(url).toBe(`http://localhost:${vmake.port}/result.mp4?full=1`);
    // The stand-in is done before the first look (3–5 s, a person's pace), so its percent may never be seen.
    expect(progress.every((percent) => percent >= 0 && percent <= 100)).toBe(true);
    page.close();
  } finally {
    await session.stop();
  }
}, 60_000);

test.skipIf(CHROME === undefined)("on a page of job cards (a teammate's among them), the piece's own card gets Smart pro and the download; nobody else's is touched", async () => {
  site.cards = true;
  const session = await browsers.open();
  try {
    const page = await session.remote.tab();
    const uploads = seen.uploads;
    const url = await web.removeOnPage(page, session.remote, piece(), "piece-card.mp4", `http://localhost:${vmake.port}`);
    expect(url).toBe(`http://localhost:${vmake.port}/result.mp4?full=1`);
    // Applied once, in Smart pro chosen on its own card.
    expect(seen.uploads - uploads).toBe(1);
    expect(seen.mode).toBe("Smart pro");
    expect(seen.others).toBe(0);
    page.close();
  } finally {
    site.cards = false;
    await session.stop();
  }
}, 60_000);

test.skipIf(CHROME === undefined)("a fresh page that shows no modes until a file goes in: Smart pro chosen on the piece's card, then Apply", async () => {
  site.noModes = true;
  const session = await browsers.open();
  try {
    const page = await session.remote.tab();
    const uploads = seen.uploads;
    const url = await web.removeOnPage(page, session.remote, piece(), "piece-nomodes.mp4", `http://localhost:${vmake.port}`);
    expect(url).toBe(`http://localhost:${vmake.port}/result.mp4?full=1`);
    expect(seen.uploads - uploads).toBe(1);
    expect(seen.mode).toBe("Smart pro");
    page.close();
  } finally {
    site.noModes = false;
    await session.stop();
  }
}, 90_000);

test.skipIf(CHROME === undefined)("Smart is chosen when a piece asks for it, on a fresh page and on its own card, never Smart pro (its own words, not a part of them); Smart pro stays the default", async () => {
  site.startOn = "Subtitle";
  const session = await browsers.open();
  try {
    const page = await session.remote.tab();
    const site_ = `http://localhost:${vmake.port}`;
    let uploads = seen.uploads;
    // A fresh page: the mode before the file.
    expect(await web.removeOnPage(page, session.remote, piece(), "piece-smart.mp4", site_, { mode: "smart" })).toBe(`${site_}/result.mp4?full=1`);
    expect([seen.mode, seen.uploads - uploads]).toEqual(["Smart", 1]);
    uploads = seen.uploads;
    // A page of job cards: on the piece's own card, then Apply.
    site.cards = true;
    expect(await web.removeOnPage(page, session.remote, piece(), "piece-smart-card.mp4", site_, { mode: "smart" })).toBe(`${site_}/result.mp4?full=1`);
    expect([seen.mode, seen.uploads - uploads, seen.others]).toEqual(["Smart", 1, 0]);
    uploads = seen.uploads;
    // No mode said: Smart pro, as every piece before Nov 18.
    expect(await web.removeOnPage(page, session.remote, piece(), "piece-pro-card.mp4", site_)).toBe(`${site_}/result.mp4?full=1`);
    expect([seen.mode, seen.uploads - uploads]).toEqual(["Smart pro", 1]);
    page.close();
  } finally {
    site.startOn = "Smart";
    site.cards = false;
    await session.stop();
  }
}, 120_000);

test.skipIf(CHROME === undefined)("a piece whose card sits at one percent for longer than the stall time is waited on, never given up or sent again (Nov 17, Sphe's M4: every piece was)", async () => {
  site.cards = true;
  site.stall = true;
  site.slowMs = 6_000;
  web.timing.stallMs = 1_500;
  const session = await browsers.open();
  try {
    const page = await session.remote.tab();
    const uploads = seen.uploads;
    const url = await web.removeOnPage(page, session.remote, piece(), "piece-slow.mp4", `http://localhost:${vmake.port}`);
    expect(url).toBe(`http://localhost:${vmake.port}/result.mp4?full=1`);
    expect(seen.uploads - uploads).toBe(1);
    page.close();
  } finally {
    site.cards = false;
    site.stall = false;
    site.slowMs = 0;
    web.timing.stallMs = 3 * 60_000;
    await session.stop();
  }
}, 60_000);

test.skipIf(CHROME === undefined)("a piece's own card already on vmake.ai is picked up (after a restart too), and a finished one from before under the old name is used once it's this piece's: nothing staged, counted or sent", async () => {
  site.cards = true;
  const session = await browsers.open();
  const sent: string[] = [];
  const hooks = (adopt: (url: string) => Promise<boolean> = async () => false): web.PieceHooks => ({ seconds: 8, adopt, sending: async () => (sent.push("counted"), false) });
  const staging = async () => (sent.push("staged"), piece());
  try {
    // Its own name: the same each time it's asked for.
    const name = web.pieceName(8, "drive:abc|0|8|1");
    expect(name).toBe(web.pieceName(8, "drive:abc|0|8|1"));
    expect(name).not.toBe(web.pieceName(8, "drive:abc|0|8|2"));
    site.existing = name;
    let page = await session.remote.tab();
    const uploads = seen.uploads;
    expect(await web.removeOnPage(page, session.remote, staging, name, `http://localhost:${vmake.port}`, hooks())).toBe(`http://localhost:${vmake.port}/result.mp4?full=1`);
    expect([sent, seen.uploads - uploads]).toEqual([[], 0]);
    page.close();
    site.existing = "";
    // The old name, as long: asked whether it's this piece's; yes, it's used.
    site.legacy = true;
    const asked: string[] = [];
    page = await session.remote.tab();
    expect(await web.removeOnPage(page, session.remote, staging, web.pieceName(8, "drive:abc|8|16|1"), `http://localhost:${vmake.port}`, hooks(async (url) => (asked.push(url), true)))).toBe(`http://localhost:${vmake.port}/result.mp4?full=1`);
    expect([asked.length, sent, seen.uploads - uploads]).toEqual([1, [], 0]);
    page.close();
    // Another piece's: the file is staged, counted and sent.
    page = await session.remote.tab();
    await web.removeOnPage(page, session.remote, staging, web.pieceName(8, "drive:abc|16|24|1"), `http://localhost:${vmake.port}`, hooks(async () => false));
    expect([sent, seen.uploads - uploads]).toEqual([["counted", "staged"], 1]);
    page.close();
  } finally {
    site.cards = false;
    site.legacy = false;
    site.existing = "";
    await session.stop();
  }
}, 90_000);

test.skipIf(CHROME === undefined)("a piece that went in before is only looked for: its card not on the list is trouble for later, never a new upload; its card failed is vmake.ai's refusal; a fresh one says as it goes in (GPT 6.2 Astra's audit, Nov 18)", async () => {
  site.cards = true;
  web.timing.lookMs = 3_000;
  const session = await browsers.open();
  const sent: string[] = [];
  const hooks = (sentBefore: boolean): web.PieceHooks => ({ seconds: 8, sentBefore: () => sentBefore, sending: async () => (sent.push("counted"), false), handed: () => sent.push("handed") });
  const staging = async () => (sent.push("staged"), piece());
  const at = `http://localhost:${vmake.port}`;
  try {
    const uploads = seen.uploads;
    // Sent before, nowhere on the list (looked for a while): not lost, not refused, nothing sent.
    let page = await session.remote.tab();
    const missing = await web.removeOnPage(page, session.remote, staging, web.pieceName(8, "drive:abc|0|8|1"), at, hooks(true)).catch((thrown: unknown) => thrown);
    page.close();
    expect(missing).toBeInstanceOf(VmakeError);
    expect(missing).not.toBeInstanceOf(web.Refused);
    expect([sent, seen.uploads - uploads]).toEqual([[], 0]);
    // Its card failed (credits returned): vmake.ai's own word that it won't come back.
    const name = web.pieceName(8, "drive:abc|0|8|2");
    site.failed = name;
    page = await session.remote.tab();
    const failed = await web.removeOnPage(page, session.remote, staging, name, at, hooks(true)).catch((thrown: unknown) => thrown);
    page.close();
    expect(failed).toBeInstanceOf(web.Refused);
    expect([sent, seen.uploads - uploads]).toEqual([[], 0]);
    site.failed = "";
    // A fresh piece: counted, staged, and said to be in vmake.ai's hands as it goes into the page.
    page = await session.remote.tab();
    expect(await web.removeOnPage(page, session.remote, staging, web.pieceName(8, "drive:abc|0|8|3"), at, hooks(false))).toBe(`${at}/result.mp4?full=1`);
    page.close();
    expect([sent, seen.uploads - uploads]).toEqual([["counted", "staged", "handed"], 1]);
  } finally {
    site.cards = false;
    site.failed = "";
    web.timing.lookMs = 60_000;
    await session.stop();
  }
}, 90_000);

test.skipIf(CHROME === undefined)("the account's troubles on the page are the account's: signed out, no Smart pro, the day's files used", async () => {
  const session = await browsers.open();
  const whose = async () => {
    const page = await session.remote.tab();
    try {
      await web.removeOnPage(page, session.remote, piece(), "piece.mp4", `http://localhost:${vmake.port}`);
      return "done";
    } catch (error) {
      return error instanceof VmakeError ? `${error.scope}:${error.reason}` : String(error);
    } finally {
      page.close();
    }
  };
  try {
    site.signedOut = true;
    expect(await whose()).toBe("account:signed_out");
    site.signedOut = false;
    site.noSmartPro = true;
    const before = seen.uploads;
    expect(await whose()).toBe("piece:null");
    // Nothing was sent: the mode is chosen before the file.
    expect(seen.uploads).toBe(before);
    site.noSmartPro = false;
    site.dailyLimit = true;
    expect(await whose()).toBe("account:daily_limit");
    site.dailyLimit = false;
  } finally {
    await session.stop();
  }
}, 90_000);

test.skipIf(CHROME === undefined)("each piece in a browser of its own (its upload in a tab in front): the profile's, then extra ones with no profile, its sign-in copied in; all stopped once nothing's left", async () => {
  const opened: string[] = [];
  const stopped: string[] = [];
  const team: web.Browsers = {
    async open(_signIn, extra) {
      // Named as it's asked for (connecting takes longer on some machines than others).
      const id = `${extra === true ? "extra" : "profile"}-${opened.length}`;
      opened.push(id);
      const one = await remote(cdp, "the stand-in browser");
      return { id, liveUrl: null, remote: one, stop: async () => void (stopped.push(id), one.close()) };
    },
  };
  // The profile's sign-in: a cookie of the site's.
  const cookies = await remote(cdp, "the sign-in");
  await cookies.call("Storage.setCookies", { cookies: [{ name: "vmake_auth_token", value: "t", domain: "localhost", path: "/" }] });
  expect(await web.copySignIn(cookies, cookies, `http://localhost:${vmake.port}`)).toBe(1);
  cookies.close();
  const wait = web.pacing.wait;
  web.pacing.wait = async () => {};
  try {
    const driver = new web.Driver(team, `http://localhost:${vmake.port}`, () => 3);
    const urls = await Promise.all([0, 1, 2].map((n) => driver.run(piece(), `piece-at-once-${n}.mp4`)));
    expect(urls.every((url) => url === `http://localhost:${vmake.port}/result.mp4?full=1`)).toBe(true);
    expect(opened).toEqual(["profile-0", "extra-1", "extra-2"]);
    await Bun.sleep(200);
    expect(stopped.sort()).toEqual(["extra-1", "extra-2", "profile-0"]);
    // The relay had no more: the pieces share the browsers there are, one at a time each.
    opened.length = 0;
    stopped.length = 0;
    const few: web.Browsers = { open: async (signIn, extra) => (extra === true ? Promise.reject(new web.ExtraRefused("full")) : team.open(signIn, extra)) };
    const alone = new web.Driver(few, `http://localhost:${vmake.port}`, () => 3);
    expect((await Promise.all([0, 1].map((n) => alone.run(piece(), `piece-few-${n}.mp4`)))).length).toBe(2);
    expect(opened).toEqual(["profile-0"]);
  } finally {
    web.pacing.wait = wait;
  }
}, 120_000);

test("vmake.ai's own words that the day's allowance is used are the account's stop for the day; a file's own limits never are", () => {
  const said = (words: string) => web.dailyLimit(words)?.reason ?? null;
  expect(said("You have reached the usage limit. Please come back tomorrow.")).toBe("daily_limit");
  expect(said("Daily limit reached")).toBe("daily_limit");
  expect(said("You've used up today's allowance")).toBe("daily_limit");
  expect(said("Upload failed. You've reached the maximum number of uploads for today.")).toBe("daily_limit");
  expect(said("The video exceeds the maximum duration of 5 minutes")).toBeNull();
  expect(said("File size limit exceeded (2 GB max)")).toBeNull();
  expect(said("Upgrade to Pro to download the full video")).toBeNull();
  expect(web.DAILY_FILES).toBe(50);
});

test.skipIf(CHROME === undefined)("the piece's card refused for the day (the team's by-hand uploads used it): the account's daily stop at once, whatever Edit's own count says", async () => {
  site.cards = true;
  site.cardLimit = true;
  const session = await browsers.open();
  try {
    const page = await session.remote.tab();
    const error = await web.removeOnPage(page, session.remote, piece(), web.pieceName(8, "drive:abc|0|8|1"), `http://localhost:${vmake.port}`).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VmakeError);
    expect([(error as VmakeError).scope, (error as VmakeError).reason]).toEqual(["account", "daily_limit"]);
    expect(tr.accountLine("daily_limit")).toBe("Taking their text out is paused: the day's Vmake allowance is used up; it carries on tomorrow.");
    page.close();
  } finally {
    site.cards = false;
    site.cardLimit = false;
    await session.stop();
  }
}, 60_000);

test("the account's day is read off the page's own purchase_config (files left a mode, credits); a prompt to spend credits past the free files is accepted", async () => {
  expect(web.parseQuota(JSON.stringify({ response: { list: [{ effect_model: "video_remove_full_pro", remain: 0, limit_count: 50, duration_limit: 300 }], balance: 4110 } }))).toMatchObject({ modes: { video_remove_full_pro: { remain: 0, limit: 50, seconds: 300 } }, balance: 4110 });
  expect(web.parseQuota("not json")).toBeNull();
  if (CHROME === undefined) return;
  site.cards = true;
  site.spend = true;
  const session = await browsers.open();
  try {
    const page = await session.remote.tab();
    const quotas: web.Quota[] = [];
    const url = await web.removeOnPage(page, session.remote, piece(), web.pieceName(8, "drive:abc|0|8|1"), `http://localhost:${vmake.port}`, { quota: (quota) => quotas.push(quota), sending: async () => true });
    expect(url).toBe(`http://localhost:${vmake.port}/result.mp4?full=1`);
    expect(quotas[0]).toMatchObject({ modes: { video_remove_full_pro: { remain: 37, limit: 50 } }, balance: 4110 });
    page.close();
  } finally {
    site.cards = false;
    site.spend = false;
    await session.stop();
  }
}, 60_000);

test("Browser Use's own refusals, said by the relay, are the team account's (Nov 17: $0.08 left, every browser refused with 402)", async () => {
  const refused = (said: string) => web.teamBrowsers("kenobi", async () => Promise.reject(new Error(said))).open().then(() => new VmakeError("lent", "piece"), (thrown: unknown) => thrown as VmakeError);
  const credits = await refused("the team's Vmake account: browser_credits (402)");
  expect(credits).toBeInstanceOf(VmakeError);
  expect([credits.scope, credits.reason]).toEqual(["account", "browser_credits"]);
  expect((await refused("the team's Vmake account: browser_key (502)")).reason).toBe("browser_key");
  // The relay down is a piece's trouble (tried again), not the account's.
  expect((await refused("could not reach Edit's relay")).scope).toBe("piece");
  expect(tr.accountLine("browser_credits")).toBe("Taking their text out is off: the cloud browser's account (Browser Use) is out of credits. Their subtitles stay blurred until it's sorted.");
});

test.skipIf(CHROME === undefined)("one Mac at a time on the team's profile: busy, this Mac waits its turn; lent, it drives the browser and stopping lets the lease go; a sign-in never waits", async () => {
  const calls: { route: string; body: unknown }[] = [];
  let busy = 2;
  const ask = async (_method: string, route: string, body: unknown) => {
    calls.push({ route, body });
    if (route === "/v1/vmake/browser") return busy-- > 0 ? { busy: "m4" } : { id: "b1", cdpUrl: cdp };
    return { stopped: true };
  };
  const before = { ...web.turns };
  web.turns.everyMs = 20;
  try {
    const session = await web.teamBrowsers("kenobi", ask).open();
    expect(calls.filter((one) => one.route === "/v1/vmake/browser").length).toBe(3);
    expect(session.liveUrl).toBeNull();
    const page = await session.remote.tab();
    expect(await page.evaluate<number>("1 + 1")).toBe(2);
    page.close();
    await session.stop();
    expect(calls.at(-1)).toEqual({ route: "/v1/vmake/browser/b1/stop", body: { holder: "kenobi" } });
    busy = 1;
    const signIn = await web.teamBrowsers("kenobi", ask).open(true).then(() => new VmakeError("lent", "piece"), (thrown: unknown) => thrown as VmakeError);
    expect(signIn.message).toContain("m4 is using the team's Vmake account now");
    // Waited past its time: given up on for now, the piece's.
    busy = 99;
    web.turns.waitMs = 30;
    const long = await web.teamBrowsers("kenobi", ask).open().then(() => new VmakeError("lent", "piece"), (thrown: unknown) => thrown as VmakeError);
    expect([long.scope, long.message]).toEqual(["piece", "m4 kept the team's Vmake account for hours"]);
  } finally {
    Object.assign(web.turns, before);
  }
}, 30_000);

test.skipIf(CHROME === undefined)("the website's provider counts the day's files, prices by the file, goes on past the free ones (the plan's credits) and stops at Edit's own ceiling without sending", async () => {
  const { dir, cleanup } = scratch("vmake-web");
  try {
    const home = join(dir, "home");
    fs.mkdirSync(home, { recursive: true });
    const input = join(dir, "piece.mp4");
    fs.writeFileSync(input, PIECE);
    const staged: string[] = [];
    const provider = tr.websiteProvider(home, browsers, `http://localhost:${vmake.port}`, async (_file, key) => {
      staged.push(key);
      return { url: piece(), drop: async () => void staged.push(`dropped ${key}`) };
    });
    expect(provider.price(94 * 60, 19)).toBe("19 files on your Vmake plan, ≈ $1.93 of cloud browser");
    const out = join(dir, "out.mp4");
    expect(await provider.remove(input, out, 8)).toEqual({ credits: null });
    expect([...fs.readFileSync(out)]).toEqual([1, 2, 3, 9]);
    expect(staged.length).toBe(2);
    expect(staged[1]).toStartWith("dropped edit/cleaned/send/");
    // A plan that isn't paid, read off /pricing as each browser opens: the account's, nothing sent.
    site.free = true;
    const sent = seen.uploads;
    const lapsed = await tr.websiteProvider(home, browsers, `http://localhost:${vmake.port}`, async () => ({ url: piece(), drop: async () => {} })).remove(input, out, 8).catch((thrown: unknown) => thrown);
    expect((lapsed as VmakeError).reason).toBe("lapsed");
    expect(seen.uploads).toBe(sent);
    site.free = false;
    // Past the day's free files: still sent (the plan's credits pay).
    fs.writeFileSync(join(home, "text-removal.json"), JSON.stringify({ accounts: {}, runs: [], day: { date: web.today(), files: web.DAILY_FILES } }));
    const past = seen.uploads;
    expect(await provider.remove(input, out, 8)).toEqual({ credits: null });
    expect(seen.uploads - past).toBe(1);
    // Edit's own ceiling a day: the account's stop, nothing sent.
    fs.writeFileSync(join(home, "text-removal.json"), JSON.stringify({ accounts: {}, runs: [], day: { date: web.today(), files: web.SANITY_FILES } }));
    const uploads = seen.uploads;
    const error = await provider.remove(input, out, 8).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VmakeError);
    expect((error as VmakeError).reason).toBe("daily_limit");
    expect(seen.uploads).toBe(uploads);
    expect(provider.price(600, 3)).toBe("3 files on your Vmake plan (0 today, the rest tomorrow), under $0.50 of cloud browser");
  } finally {
    cleanup();
  }
}, 150_000);
