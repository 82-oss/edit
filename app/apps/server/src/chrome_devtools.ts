// A headless Chrome that Edit drives over the DevTools protocol: started on a
// profile of its own, one page, commands sent and answered by id. The one
// place for it from Nov 10 (effects.ts is its first user); the two older
// copies of this handshake (thumbnails/render.ts, evidence_capture.ts) are to
// move onto it. Every headless Chrome Edit starts is `headlessCommand`'s.

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import * as diag from "./diag.ts";
import * as playing from "./playing.ts";
import * as seams from "./seams.ts";

export interface Page {
  /** One DevTools command and its answer (`waitMs`: how long before it's given up on, a minute unless said). */
  call(method: string, params?: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>>;
  /** A JavaScript expression's value in the page, its promise waited for; what the page threw is the error. */
  evaluate<T>(expression: string, waitMs?: number): Promise<T>;
  /** Calls `listener` with each `event`'s params from this page (Page.loadEventFired…); the function it returns stops it. */
  on(event: string, listener: (params: Record<string, unknown>) => void): () => void;
  /** Chrome went away (it was closed, it crashed, its connection dropped). */
  readonly closed: boolean;
  /** Chrome stopped and its profile removed. */
  close(): void;
}

export interface Opening {
  /** The profile folder's prefix under the temp folder ("edit-effect-"): names whose Chrome it is. */
  profile: string;
  /** The page's size in CSS pixels, drawn one device pixel each. */
  width: number;
  height: number;
  /** Draw on the graphics card (Metal on a Mac, Vulkan on Linux, where headless Chrome otherwise draws on the CPU). */
  gpu?: boolean;
  /** What it's for, in an error's words: "Looking at an effect". */
  what: string;
  /**
   * The agent's previews (an effect's looks and renders): started below the person's own work and kept below a play
   * while one is watched here (`playing.belowCommand`, `keepBelow`), so the player plays as if it weren't there.
   */
  below?: boolean;
}

/** Whether `gpu` asks draw on the graphics card at all: tests on CI's virtual Macs turn it off (test/setup.ts). */
export const drawing = { gpu: true };

/** The Chromes this Edit started and hasn't closed: leaving closes them (an exit handler can't wait on a promise). */
const started = new Set<ReturnType<typeof Bun.spawn>>();
process.on("exit", () => {
  for (const child of started) child.kill();
});

// ---------------------------------------------------------------------------
// Which Chrome: on a Mac, Edit's own copy of Google's headless shell
//
// Google Chrome started headless from its app (`--headless=new`) is a Dock app
// while it starts: an icon popped into the Dock and out again with every look,
// render and map, every few seconds while the agent worked on effects (Sphe's
// M4, Nov 17: "the Dock has a spaz"). The headless shell is Chrome for
// Testing's headless-only build of the same Chrome (same Blink, same Metal
// drawing through ANGLE, H.264 played): a bare program, no app, so never in the
// Dock, and it starts in a third of the time (kenobi, Nov 17: Google Chrome's
// main process a Foreground app for 12-22 ms at each start, the shell never; a
// page's first screenshot 251 ms from the start against 602; the same pixels,
// WebGL on the M1 by ANGLE's Metal). It's Chrome's stable release, fetched
// once into `<home>/bin/chrome-headless-shell/<version>` in the background,
// checked against the size and MD5 Google's storage gives for it and by its
// own signature (an ad-hoc one: Chrome for Testing has no team's), run once
// so the Mac's first look at it (Gatekeeper and XProtect, 5 s) is over before
// any work waits on it, and brought up to the newest stable once a day; until
// it's there, Google Chrome as before. Linux has no Dock and keeps
// Google Chrome: its sandbox (Ubuntu allows only Chrome's own, by AppArmor)
// refuses the shell's.

/** Chrome for Testing's newest builds, by channel. */
const SHELL_INDEX = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
export const SHELL_PLATFORM = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
/** How often the copy is checked against Chrome's newest stable release. */
const SHELL_FRESH_MS = 24 * 3600_000;

/** What the tests replace: the shell's index and where its copy lives. */
export const shellHooks = {
  /** Whether this computer runs the shell (macOS). */
  wanted: process.platform === "darwin",
  index: SHELL_INDEX,
  /** Checks the unpacked shell is whole and runs: null when it is, else why not. */
  verify: verifyShell as (binary: string) => Promise<string | null>,
};

/** The shell ready to run, once `prepareShell` found or fetched one. */
let shell: string | null = null;
let shellFetch: Promise<string | null> | null = null;

function shellRoot(home: string): string {
  return join(home, "bin", "chrome-headless-shell");
}

/** The shell's program in a version's folder. */
function shellBinary(dir: string): string {
  return join(dir, `chrome-headless-shell-${SHELL_PLATFORM}`, "chrome-headless-shell");
}

/** Whether `binary` is the headless shell (no `--headless` switch, Chrome's own fonts asked for). */
export function isShell(binary: string): boolean {
  return binary.endsWith("/chrome-headless-shell");
}

function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let at = 0; at < Math.max(x.length, y.length); at++) if ((x[at] ?? 0) !== (y[at] ?? 0)) return (x[at] ?? 0) - (y[at] ?? 0);
  return 0;
}

/** The newest shell unpacked under `root`, or null. */
function installedShell(root: string): string | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((name) => /^\d+(\.\d+)+$/.test(name));
  } catch {
    return null;
  }
  for (const name of names.sort(compareVersions).reverse()) {
    const binary = shellBinary(join(root, name));
    if (fs.existsSync(binary)) return binary;
  }
  return null;
}

/** The shell's own signature checked (every file it seals as it was built) and the shell run once, for its version. */
async function verifyShell(binary: string): Promise<string | null> {
  const checked = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", binary], { stdout: "ignore", stderr: "pipe" });
  if (checked.exitCode !== 0) return `its signature didn't verify (${checked.stderr.toString().trim()})`;
  const said = Bun.spawnSync(["/usr/bin/codesign", "-dv", binary], { stdout: "ignore", stderr: "pipe" }).stderr.toString();
  if (!said.includes("Identifier=headless_shell")) return "it isn't Chrome's headless shell";
  // The Mac's first look at a program new to it: done here, not in a look's start.
  const child = Bun.spawn([binary, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 60_000);
  const version = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(timer);
  return /Chrome/.test(version) ? null : `it didn't run (${child.exitCode})`;
}

/**
 * Finds Edit's shell and, in the background, fetches Chrome's newest stable
 * one when there's none yet or the copy wasn't checked today (macOS; the
 * server's start). Nothing waits on it: a Chrome started before it's there is
 * Google Chrome.
 */
export function prepareShell(home: string): void {
  if (!shellHooks.wanted) return;
  const root = shellRoot(home);
  findShell(home);
  let checked = 0;
  try {
    checked = fs.statSync(join(root, "checked")).mtimeMs;
  } catch {}
  if (shell !== null && Date.now() - checked < SHELL_FRESH_MS) return;
  void fetchShell(home).catch((error) => diag.warn("chrome", `fetching Chrome's headless shell: ${diag.messageOf(error)}`));
}

/** Takes up the newest shell unpacked in `home` (none: Google Chrome), fetching nothing. */
export function findShell(home: string): void {
  shell = installedShell(shellRoot(home));
}

/** Brings Edit's shell up to Chrome's newest stable release; its path (null off macOS). Once at a time. */
export function fetchShell(home: string): Promise<string | null> {
  if (!shellHooks.wanted) return Promise.resolve(null);
  shellFetch ??= fetchNewestShell(shellRoot(home)).finally(() => {
    shellFetch = null;
  });
  return shellFetch;
}

async function fetchNewestShell(root: string): Promise<string> {
  const index = (await (await fetch(shellHooks.index, { signal: AbortSignal.timeout(30_000) })).json()) as {
    channels?: { Stable?: { version?: string; downloads?: { "chrome-headless-shell"?: { platform: string; url: string }[] } } };
  };
  const stable = index.channels?.Stable;
  const url = stable?.downloads?.["chrome-headless-shell"]?.find((one) => one.platform === SHELL_PLATFORM)?.url;
  const version = stable?.version;
  if (version === undefined || !/^\d+(\.\d+)+$/.test(version) || url === undefined) throw new Error(`Chrome for Testing names no stable headless shell for ${SHELL_PLATFORM}`);
  fs.mkdirSync(root, { recursive: true });
  const dir = join(root, version);
  if (!fs.existsSync(shellBinary(dir))) {
    await diag.timeOnAsync("chrome", "chrome: fetch the headless shell", version, () => unpackShell(url, root, dir));
    diag.info("chrome", `Chrome's headless shell ${version} is the Chrome effects, thumbnails and pages are drawn in`);
  }
  shell = shellBinary(dir);
  const now = new Date();
  fs.writeFileSync(join(root, "checked"), version);
  fs.utimesSync(join(root, "checked"), now, now);
  removeOldShells(root, version);
  return shell;
}

/** The zip at `url` downloaded, checked (its size and MD5 as Google's storage gives them, Google's signature) and unpacked into `dir`. */
async function unpackShell(url: string, root: string, dir: string): Promise<void> {
  const part = join(root, `.part-${process.pid}`);
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(part, { recursive: true });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || response.body === null) throw new Error(`${response.status} for ${url}`);
    const md5 = response.headers.get("x-goog-hash")?.split(",").map((one) => one.trim()).find((one) => one.startsWith("md5="))?.slice(4);
    const length = Number(response.headers.get("content-length"));
    if (md5 === undefined) throw new Error("Google's storage gave no checksum for it");
    const zip = join(part, "shell.zip");
    const hasher = new Bun.CryptoHasher("md5");
    const writer = Bun.file(zip).writer();
    let bytes = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hasher.update(chunk);
      await writer.write(chunk);
      bytes += chunk.length;
    }
    await writer.end();
    if (Number.isFinite(length) && length > 0 && bytes !== length) throw new Error(`the download stopped at ${bytes} of ${length} bytes`);
    if (hasher.digest("base64") !== md5) throw new Error("the download didn't match its checksum");
    const out = join(part, "unpacked");
    // ditto, as Finder unpacks: the signature's extended attributes kept (unzip where there's none: the tests on Linux).
    const unzipped = Bun.spawnSync(fs.existsSync("/usr/bin/ditto") ? ["/usr/bin/ditto", "-x", "-k", zip, out] : ["unzip", "-q", zip, "-d", out], { stdout: "ignore", stderr: "pipe" });
    if (unzipped.exitCode !== 0) throw new Error(`unpacking it: ${unzipped.stderr.toString().trim()}`);
    const binary = shellBinary(out);
    if (!fs.existsSync(binary)) throw new Error("the download has no chrome-headless-shell in it");
    const refused = await shellHooks.verify(binary);
    if (refused !== null) throw new Error(refused);
    fs.rmSync(zip, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(out, dir);
  } finally {
    fs.rmSync(part, { recursive: true, force: true });
  }
}

/** Versions older than `kept` no Chrome runs from any more (one still running keeps its own until it's gone). */
function removeOldShells(root: string, kept: string): void {
  let running = "";
  try {
    running = Bun.spawnSync(["ps", "-axo", "command="]).stdout.toString();
  } catch {
    return;
  }
  for (const name of fs.readdirSync(root)) {
    const dir = join(root, name);
    if (name === kept || name === "checked" || name.startsWith(".part-") || running.includes(`${dir}/`)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The Chrome Edit runs headless: Edit's shell where it has one (macOS), else Google Chrome (or Chromium, or Edge); null with none. */
export function headlessBinary(): string | null {
  if (shell !== null && shellHooks.wanted && fs.existsSync(shell)) return shell;
  return seams.broll.chrome();
}

/** The switches that make the binary draw on the graphics card: Metal on a Mac, Vulkan on Linux, where headless Chrome otherwise draws on the CPU. */
function gpuSwitches(): string[] {
  return process.platform === "darwin" ? ["--use-angle=metal"] : process.platform === "linux" ? ["--use-angle=vulkan"] : [];
}

/**
 * The command that starts a headless Chrome with `switches` (its profile, its
 * port or page, and what else it needs), `gpu` drawing on the graphics card;
 * null when this computer has no Chrome. Every headless Chrome Edit starts.
 */
export function headlessCommand(switches: readonly string[], options: { gpu?: boolean } = {}): string[] | null {
  const binary = headlessBinary();
  if (binary === null) return null;
  return [binary, ...(isShell(binary) ? [] : ["--headless=new"]), ...(options.gpu === true ? gpuSwitches() : []), ...switches];
}

/**
 * The fonts Google Chrome on a Mac gives CSS's generic families (its
 * locale_settings_mac.grd): the shell has no settings of its own, so a page
 * asking for `serif` or `monospace` gets these there as in Google Chrome.
 * `monospace` is Menlo, not the .grd's Courier (kenobi, Chrome 157, Nov 17:
 * Google Chrome's monospace measured as Menlo to the hundredth of a pixel, and
 * with Menlo every generic family drew the same pixels in both).
 */
const CHROME_FONTS = { standard: "Times", fixed: "Menlo", serif: "Times", sansSerif: "Helvetica", cursive: "Apple Chancery", fantasy: "Papyrus" };

/** Gives a page of the shell Google Chrome's generic fonts (`call`: the page's DevTools); nothing in Google Chrome. */
export async function chromeFonts(binary: string, call: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  if (!isShell(binary) || process.platform !== "darwin") return;
  await call("Page.setFontFamilies", { fontFamilies: CHROME_FONTS });
}

const swept = new Set<string>();

/**
 * Chromes an Edit before this one left running on `profile` (a restart that
 * couldn't say goodbye: a crash, `bun --watch`, an update's exec): whatever
 * has nobody left to answer to is closed, its profile gone, and so is every
 * profile of the prefix no Chrome uses. Once a prefix.
 */
function sweepOrphans(profile: string): void {
  if (swept.has(profile)) return;
  swept.add(profile);
  try {
    const listed = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString();
    for (const line of listed.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null || match[2] !== "1" || !match[3]!.includes(`--user-data-dir=${join(os.tmpdir(), profile)}`)) continue;
      process.kill(Number(match[1]));
      const dir = /--user-data-dir=(\S+)/.exec(match[3]!)?.[1];
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      diag.info("chrome", `closed a Chrome an earlier Edit left running (pid ${match[1]}, ${profile})`);
    }
    // And the profiles no Chrome uses any more, ten minutes old or more (another Edit on this computer may have just
    // made one): one for every Chrome started (Nov 11: 225 left here by a day's looks and renders).
    const now = Bun.spawnSync(["ps", "-axo", "command="]).stdout.toString();
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (!entry.startsWith(profile)) continue;
      const dir = join(os.tmpdir(), entry);
      if (now.includes(`--user-data-dir=${dir}`)) continue;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < 10 * 60_000) continue;
      } catch {
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (error) {
    diag.warn("chrome", `looking for Chromes left running: ${diag.messageOf(error)}`);
  }
}

/** A Chrome with one blank page, ready for commands. */
export async function open(opening: Opening): Promise<Page> {
  sweepOrphans(opening.profile);
  const profile = fs.mkdtempSync(join(os.tmpdir(), opening.profile));
  const command = headlessCommand(
    [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      // Room for the page at full size: a headless window loses some height to the browser's own frame.
      `--window-size=${opening.width + 64},${opening.height + 200}`,
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { gpu: opening.gpu === true && drawing.gpu },
  );
  if (command === null) {
    fs.rmSync(profile, { recursive: true, force: true });
    throw new Error(`${opening.what} needs Google Chrome installed.`);
  }
  const child = Bun.spawn(opening.below === true ? playing.belowCommand(command) : command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  started.add(child);
  const release = opening.below === true ? playing.keepBelow(child.pid) : () => {};
  void child.exited.then(() => {
    started.delete(child);
    release();
  });
  // The profile goes once Chrome has gone: removed while it was still closing, Chrome wrote parts of it back and
  // they were left (Nov 11, on kenobi: 169 profiles, 619 MB, from renders started and stopped).
  const stop = () => {
    child.kill();
    void child.exited.then(() => fs.rmSync(profile, { recursive: true, force: true }));
  };
  try {
    return await connect(command[0]!, profile, opening, stop);
  } catch (error) {
    // A Chrome that never got as far as its page goes, with its profile: none is left running.
    stop();
    throw error;
  }
}

/**
 * The DevTools port a Chrome started with `--remote-debugging-port=0` and this
 * profile writes, once it has written it; null if it hasn't in 15 s. Chrome
 * makes the file before it writes the port in it, so it's the port that's
 * waited for, not the file (Check, Nov 11: an empty file read 180 ms in
 * failed a run as "Chrome didn't start").
 */
export async function devToolsPort(profile: string): Promise<number | null> {
  const until = Date.now() + 15_000;
  const portFile = join(profile, "DevToolsActivePort");
  for (;;) {
    let port = 0;
    try {
      port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
    } catch {
      port = 0;
    }
    if (Number.isInteger(port) && port > 0) return port;
    if (Date.now() >= until) return null;
    await Bun.sleep(50);
  }
}

async function connect(binary: string, profile: string, opening: Opening, stop: () => void): Promise<Page> {
  const port = await devToolsPort(profile);
  if (port === null) throw new Error(`${opening.what}: Chrome didn't start.`);
  const tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const target = tabs.find((one) => one.type === "page");
  if (target === undefined) throw new Error(`${opening.what}: Chrome has no page.`);
  const socket = await client(target.webSocketDebuggerUrl, opening.what);
  const page = pageOn(socket, null, () => {
    socket.close();
    stop();
  });
  await page.call("Page.enable");
  await chromeFonts(binary, page.call);
  await page.call("Emulation.setDeviceMetricsOverride", { width: opening.width, height: opening.height, deviceScaleFactor: 1, mobile: false });
  return page;
}

/** One DevTools connection: commands by id (to a tab's session when given), its events to whoever listens. */
interface Client {
  call(method: string, params: Record<string, unknown>, session: string | null, waitMs: number): Promise<Record<string, unknown>>;
  on(listener: (method: string, params: Record<string, unknown>, session: string | null) => void): () => void;
  readonly closed: boolean;
  close(): void;
}

async function client(url: string, what: string): Promise<Client> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: Chrome's connection timed out.`)), 15_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`${what}: Chrome's connection failed.`));
    };
  });
  let next = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(method: string, params: Record<string, unknown>, session: string | null) => void>();
  socket.onmessage = (event) => {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      return;
    }
    if (message.id === undefined) {
      if (message.method !== undefined) for (const listener of listeners) listener(message.method, message.params ?? {}, message.sessionId ?? null);
      return;
    }
    const own = pending.get(message.id);
    if (own === undefined) return;
    pending.delete(message.id);
    clearTimeout(own.timer);
    if (message.error) own.reject(new Error(message.error.message ?? "Chrome refused"));
    else own.resolve(message.result ?? {});
  };
  const state = { closed: false };
  socket.onclose = () => {
    state.closed = true;
    for (const one of pending.values()) {
      clearTimeout(one.timer);
      one.reject(new Error("Chrome closed"));
    }
    pending.clear();
  };
  return {
    call: (method, params, session, waitMs) =>
      new Promise((resolve, reject) => {
        if (state.closed) return reject(new Error("Chrome closed"));
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome ${method} timed out`));
        }, waitMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(session !== null ? { sessionId: session } : {}) }));
      }),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get closed() {
      return state.closed;
    },
    close() {
      state.closed = true;
      try {
        socket.close();
      } catch {}
    },
  };
}

/** A page on `socket` (a tab's flat session, or the page's own socket with null). */
function pageOn(socket: Client, session: string | null, close: () => void): Page {
  const call: Page["call"] = (method, params = {}, waitMs = 60_000) => socket.call(method, params, session, waitMs);
  const evaluate: Page["evaluate"] = async <T>(expression: string, waitMs?: number) => {
    const answer = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, waitMs);
    const thrown = answer.exceptionDetails as { text?: string; exception?: { description?: string; value?: unknown } } | undefined;
    if (thrown !== undefined) {
      const value = thrown.exception?.value;
      throw new Error(thrown.exception?.description ?? (value === undefined ? undefined : JSON.stringify(value)) ?? thrown.text ?? "the page threw");
    }
    return (answer.result as { value?: T } | undefined)?.value as T;
  };
  let gone = false;
  return {
    call,
    evaluate,
    on: (event, listener) => socket.on((method, params, from) => {
      if (method === event && from === session) listener(params);
    }),
    get closed() {
      return gone || socket.closed;
    },
    close() {
      if (gone) return;
      gone = true;
      close();
    },
  };
}
