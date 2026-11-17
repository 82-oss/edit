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
const seen = { mode: "", bytes: 0, uploads: 0 };
const site = { signedOut: false, noSmartPro: false, dailyLimit: false, free: false };
const PIECE = new Uint8Array(3_000_000).map((_, at) => at % 251);

const PAGE = () => `<!doctype html><html><body>
<header>${site.signedOut ? '<button>Log in</button>' : '<div class="user-avatar--x1">S</div>'}</header>
<div class="ant-segmented" aria-label="segmented control"><div>Auto</div><div>Manual</div></div>
<div style="display:none"><ul class="radio--q7"><li class="item--a active--z">Smart</li><li class="item--a disabled--d">Smart pro</li></ul></div>
<ul class="radio--q7">${["Smart", "Smart pro", "Subtitle", "Watermark", "Passerby"].map((mode, at) => `<li class="item--a ${at === 0 ? "active--z" : ""} ${mode === "Smart pro" && site.noSmartPro ? "disabled--d" : ""}">${mode}</li>`).join("")}</ul>
<span class="ant-upload-btn"><input type="file" name="file" accept=".mp4,.mov"></span>
<span class="ant-upload-btn"><input type="file" name="file" multiple></span>
<div id="work"></div>
<script>
document.querySelectorAll('ul[class*=radio] li').forEach((li) => li.addEventListener('click', () => {
  if (/disabled--/.test(li.className)) return;
  document.querySelectorAll('ul[class*=radio] li').forEach((one) => one.classList.remove('active--z'));
  li.classList.add('active--z');
}));
document.querySelector('input:not([multiple])').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  const mode = document.querySelector('li.active--z').innerText;
  await fetch('/record', { method: 'POST', body: JSON.stringify({ mode, bytes: file.size }) });
  const work = document.getElementById('work');
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
      if (url.pathname === "/pricing") return new Response(`<html><body>${site.signedOut ? "<button>Get Started</button>" : '<div class="ant-avatar avatar--x">S</div><button>Workspace</button>'}<p>Current plan: ${site.free ? "Free" : "Pro"}</p></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/video-watermark-remover/upload") return new Response(PAGE(), { headers: { "content-type": "text/html" } });
      if (url.pathname === "/record") {
        const said = (await request.json()) as { mode: string; bytes: number };
        seen.mode = said.mode;
        seen.bytes = said.bytes;
        seen.uploads += 1;
        return new Response("ok");
      }
      if (url.pathname === "/result.mp4") return new Response(new Uint8Array([1, 2, 3, url.searchParams.has("full") ? 9 : 5]), { headers: { "content-type": "video/mp4", "content-disposition": "attachment; filename=result.mp4" } });
      return new Response("no", { status: 404 });
    },
  });
  // R2's stand-in: another origin, no CORS headers (the page never sees it).
  r2 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(PIECE, { headers: { "content-type": "video/mp4" } }) });
  if (CHROME === undefined) return;
  profile = fs.mkdtempSync(join(os.tmpdir(), "edit-vmake-web-"));
  chrome = Bun.spawn([CHROME, "--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const port = await devToolsPort(profile);
  cdp = `http://127.0.0.1:${port}`;
  web.pacing.wait = async () => {};
});

afterAll(() => {
  void vmake?.stop(true);
  void r2?.stop(true);
  chrome?.kill();
  if (profile !== "") fs.rmSync(profile, { recursive: true, force: true });
});

/** Browser Use's stand-in: the local Chrome, a "session" a connection to it. */
const browsers: web.Browsers = {
  async open() {
    const one = await remote(cdp, "the stand-in browser");
    return { id: "local", liveUrl: "https://live.example/abc", remote: one, stop: async () => one.close() };
  },
  profile: async () => "profile-1",
};

const piece = () => `http://127.0.0.1:${r2.port}/edit/cleaned/send/piece.mp4?X-Amz-Signature=x`;

test.skipIf(CHROME === undefined)("a piece goes through the stand-in remover: Smart pro first, the file from R2 in the page, the full video's address", async () => {
  const session = await browsers.open(null);
  try {
    const page = await session.remote.tab();
    const progress: number[] = [];
    const url = await web.removeOnPage(page, piece(), "piece-8s.mp4", `http://localhost:${vmake.port}`, (percent) => progress.push(percent));
    expect(seen).toEqual({ mode: "Smart pro", bytes: PIECE.length, uploads: 1 });
    expect(url).toBe(`http://localhost:${vmake.port}/result.mp4?full=1`);
    // The stand-in is done before the first look (3–5 s, a person's pace), so its percent may never be seen.
    expect(progress.every((percent) => percent >= 0 && percent <= 100)).toBe(true);
    page.close();
  } finally {
    await session.stop();
  }
}, 60_000);

test.skipIf(CHROME === undefined)("the account's troubles on the page are the account's: signed out, no Smart pro, the day's files used", async () => {
  const session = await browsers.open(null);
  const whose = async () => {
    const page = await session.remote.tab();
    try {
      await web.removeOnPage(page, piece(), "piece.mp4", `http://localhost:${vmake.port}`);
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

test("Browser Use's own refusals are its account's, said as Browser Use's (Nov 17: $0.08 left, every browser refused with 402)", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('{"detail":"You need at least $0.01 in credits to start a browser session."}', { status: 402 }) });
  try {
    const error = await web.browserUse("key", `http://127.0.0.1:${server.port}`).open("profile-1").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VmakeError);
    expect([(error as VmakeError).scope, (error as VmakeError).reason]).toEqual(["account", "browser_credits"]);
    expect(tr.accountLine("browser_credits")).toBe("Taking their text out is off: the cloud browser's account (Browser Use) is out of credits. Their subtitles stay blurred until it's sorted.");
  } finally {
    void server.stop(true);
  }
});

test.skipIf(CHROME === undefined)("the website's provider counts the day's files, prices by the file, and stops at the day's allowance without sending", async () => {
  const { dir, cleanup } = scratch("vmake-web");
  try {
    const home = join(dir, "home");
    fs.mkdirSync(home, { recursive: true });
    const input = join(dir, "piece.mp4");
    fs.writeFileSync(input, PIECE);
    const staged: string[] = [];
    const provider = tr.websiteProvider(home, browsers, "profile-1", `http://localhost:${vmake.port}`, async (_file, key) => {
      staged.push(key);
      return { url: piece(), drop: async () => void staged.push(`dropped ${key}`) };
    });
    expect(provider.price(94 * 60, 19)).toBe("19 files on your Vmake plan, ≈ $42.38 of cloud browser");
    const out = join(dir, "out.mp4");
    expect(await provider.remove(input, out, 8)).toEqual({ credits: null });
    expect([...fs.readFileSync(out)]).toEqual([1, 2, 3, 9]);
    expect(staged.length).toBe(2);
    expect(staged[1]).toStartWith("dropped edit/cleaned/send/");
    // A plan that isn't paid, read off /pricing as each browser opens: the account's, nothing sent.
    site.free = true;
    const sent = seen.uploads;
    const lapsed = await tr.websiteProvider(home, browsers, "profile-1", `http://localhost:${vmake.port}`, async () => ({ url: piece(), drop: async () => {} })).remove(input, out, 8).catch((thrown: unknown) => thrown);
    expect((lapsed as VmakeError).reason).toBe("lapsed");
    expect(seen.uploads).toBe(sent);
    site.free = false;
    // The day's files used (as kept in the home): the account's, nothing sent.
    fs.writeFileSync(join(home, "text-removal.json"), JSON.stringify({ accounts: {}, runs: [], day: { date: web.today(), files: web.DAILY_FILES } }));
    const uploads = seen.uploads;
    const error = await provider.remove(input, out, 8).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VmakeError);
    expect((error as VmakeError).reason).toBe("daily_limit");
    expect(seen.uploads).toBe(uploads);
    expect(provider.price(600, 3)).toBe("3 files on your Vmake plan (0 today, the rest tomorrow), ≈ $4.51 of cloud browser");
  } finally {
    cleanup();
  }
}, 60_000);
