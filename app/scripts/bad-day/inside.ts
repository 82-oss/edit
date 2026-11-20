// Inside the sandbox (run.ts builds it): proves the sandbox is shut, makes
// the footage, then for each case starts the stand-ins, the bad line and a
// fresh Edit, runs the case, checks what every case checks, and prints one
// table at the end.
//
//   bun scripts/bad-day/inside.ts [case…]      (only ever from run.ts)

import { spawnSync } from "node:child_process";
import { promises as dns } from "node:dns";
import * as fs from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { cases, type Case, type Context, type Verdict } from "./cases/index.ts";
import { Cloud } from "./cloud.ts";
import { Edit } from "./edit.ts";
import { footage } from "./footage.ts";
import { Line } from "./line.ts";
import { macProbes } from "./mac_probes.ts";

const RUN = process.env.BAD_DAY_RUN ?? "";
const ROOT = process.env.BAD_DAY_ROOT ?? "";
const SERVER = process.env.BAD_DAY_SERVER ?? "";
const LABEL = process.env.BAD_DAY_LABEL ?? SERVER;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAC = process.platform === "darwin";

function stop(message: string): never {
  console.error(`bad-day: ${message}`);
  process.exit(2);
}

/** Whether a TCP connection to `host:port` is taken within 1.5 s. */
function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

/** macOS: that sandbox-exec shut what bwrap shuts on Linux (macos.sb); each part tried, not assumed. */
async function sandboxedMac(): Promise<void> {
  const home = homedir();
  // No public address, no name looked up, not the live relay or accounts site.
  for (const address of ["http://1.1.1.1/", "http://8.8.8.8/", "https://edit-relay.sphe-g-personal.workers.dev/", "https://accounts.spheceo.com/"]) {
    try {
      await fetch(address, { signal: AbortSignal.timeout(3000) });
      stop(`${address} answered from inside: the sandbox isn't shut`);
    } catch {}
  }
  for (const host of ["edit-relay.sphe-g-personal.workers.dev", "accounts.spheceo.com", "apple.com"]) {
    const found = await dns.lookup(host).then(
      () => true,
      () => false,
    );
    if (found) stop(`${host} was looked up from inside: the sandbox isn't shut`);
  }
  for (const [host, port] of [["1.1.1.1", 443], ["17.253.144.10", 80]] as const) if (await connects(host, port)) stop(`${host}:${port} took a connection from inside`);
  // Loopback is the host's here: Edit's own ports are shut, proved on one run.ts listens on outside.
  const canary = (process.env.BAD_DAY_CANARY ?? "").split(":");
  if (canary.length !== 2) stop("no canary port from run.ts");
  if (await connects(canary[0]!, Number(canary[1]))) stop(`the host's ${canary.join(":")} answered from inside: Edit's ports aren't shut`);
  // And the run's own loopback does work (a port above Edit's).
  const own = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
  const reached = await connects("127.0.0.1", (own.address() as net.AddressInfo).port);
  own.close();
  if (!reached) stop("the run's own loopback doesn't work in here");
  for (const port of [7700, 7710, 7790]) if (await connects("127.0.0.1", port)) stop(`127.0.0.1:${port} (an Edit of the host's) answered from inside`);
  // Edit's folders, the app's, the Keychain's files and Claude Code can't be read.
  for (const dir of [".edit", ".edit-dev", ".edit-prod", ".edit-trials", "Library/Application Support/edit", "Library/Application Support/com.spheceo.writer", "Library/Keychains", ".claude", ".local/bin"]) {
    try {
      fs.readdirSync(join(home, dir));
      stop(`~/${dir} can be read in here: the sandbox isn't shut`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") stop(`~/${dir}: ${String(error)}`);
    }
  }
  // Nothing written outside the run's root.
  for (const path of [join(home, `.bad-day-probe-${process.pid}`), join(home, ".edit", `bad-day-probe-${process.pid}`), `/private/tmp/bad-day-probe-${process.pid}`]) {
    let wrote = false;
    try {
      fs.writeFileSync(path, "probe");
      wrote = true;
    } catch {}
    if (wrote) {
      fs.rmSync(path, { force: true });
      stop(`${path} could be written in here: the sandbox isn't shut`);
    }
  }
  fs.writeFileSync(join(RUN, "probe"), "probe");
  fs.rmSync(join(RUN, "probe"));
  // The Keychain doesn't answer (the same command lists the login keychain outside).
  if (spawnSync("/usr/bin/security", ["list-keychains"], { encoding: "utf8" }).status === 0) stop("the Keychain answered from inside");
  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0) stop("Claude Code runs in here");
  // The small disk is a disk of its own, of 256 MB.
  const disk = fs.statfsSync(join(RUN, "small-disk"));
  const size = disk.blocks * disk.bsize;
  if (fs.statSync(join(RUN, "small-disk")).dev === fs.statSync(RUN).dev || size > 300 * 1024 ** 2) stop(`the small disk isn't a 256 MB disk of its own (${Math.round(size / 1024 ** 2)} MB)`);
}

/** That this is the sandbox: no public address answers, prod's folder is empty, our own process numbers. */
async function sandboxed(): Promise<void> {
  if (RUN === "" || SERVER === "") stop("run me through run.ts (`just bad-day`), never by hand");
  if (MAC) return sandboxedMac();
  if (process.pid > 50) stop(`not in a process namespace of its own (pid ${process.pid})`);
  for (const dir of [".edit-prod", ".edit-dev", ".edit", ".edit-trials"]) {
    const path = join(homedir(), dir);
    if (dir === ".edit-trials") continue; // read-only like the rest of the disk; never given to Edit
    if (fs.existsSync(path) && fs.readdirSync(path).length > 0) stop(`~/${dir} isn't empty in here: the sandbox isn't shut`);
  }
  for (const address of ["http://1.1.1.1/", "http://8.8.8.8/", "http://127.0.0.1:7790/api/health", "http://127.0.0.1:7710/api/health"]) {
    try {
      await fetch(address, { signal: AbortSignal.timeout(1500) });
      stop(`${address} answered from inside: the sandbox isn't shut`);
    } catch {}
  }
  if (fs.existsSync("/run/tailscale") || fs.existsSync("/run/user")) stop("the host's sockets are visible in here");
}

/** The cgroup's highest memory use so far (the scope's), in MB; on macOS, Edit's tree's most at once over the cases. */
let macPeak = 0;
function peakMemory(): string {
  if (MAC) return macPeak > 0 ? `${Math.round(macPeak / 1024 ** 2)} MB (Edit's tree)` : "unknown";
  try {
    const path = fs.readFileSync("/proc/self/cgroup", "utf8").trim().split(":").pop() ?? "";
    const bytes = Number(fs.readFileSync(join("/sys/fs/cgroup", path, "memory.peak"), "utf8").trim());
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  } catch {
    return "unknown";
  }
}

/**
 * The preload Edit starts with, through two hooks the server already has for its tests: Claude's questions go to the
 * stand-in model (ai_claude.standIn), and, off the small disk, the disk is a roomy one (storage.diskHooks, as
 * test/setup.ts sets it): this machine's own sits on Edit's keep-free line (a tenth of 468 GB), so whether a copy is
 * kept here would turn on whatever else is on it that minute.
 */
function preload(dir: string, modelUrl: string, roomy: boolean): string {
  const path = join(dir, "preload.ts");
  fs.writeFileSync(
    path,
    `// Written by the bad-day harness: Claude's questions go to the stand-in, as under bun test.\n` +
      (roomy
        ? `import { diskHooks } from ${JSON.stringify(join(SERVER, "apps/server/src/storage.ts"))};\n` +
          `diskHooks.free = () => 1e12;\ndiskHooks.total = () => 2e12;\n`
        : // The small disk (256 MB) is smaller than the floor Edit leaves free under its own work: what's really free
          // counts as over the floor, so "is there room for N bytes" means N bytes are free on it (the disk still fills
          // and refuses writes for real).
          `import { diskHooks, WORK_FLOOR_BYTES } from ${JSON.stringify(join(SERVER, "apps/server/src/storage.ts"))};\n` +
          `const realFree = diskHooks.free;\ndiskHooks.free = (dir) => realFree(dir) + WORK_FLOOR_BYTES;\n`) +
      `import { standIn } from ${JSON.stringify(join(SERVER, "apps/server/src/ai_claude.ts"))};\n` +
      `standIn.post = async (body) => {\n` +
      `  const answer = await fetch(${JSON.stringify(`${modelUrl}/v1/chat/completions`)}, { method: "POST", headers: { "content-type": "application/json" }, body: require("node:fs").readFileSync(body) });\n` +
      `  if (answer.status !== 200) throw new Error("the model answered " + answer.status);\n` +
      `  return answer.json();\n` +
      `};\n`,
  );
  return path;
}

interface Outcome {
  name: string;
  verdict: Verdict;
  checks: { name: string; ok: boolean; detail: string }[];
  seconds: number;
  error?: string;
}

async function runCase(one: Case, made: ReturnType<typeof footage>, index: number): Promise<Outcome> {
  const dir = join(RUN, one.name);
  fs.mkdirSync(dir, { recursive: true });
  const logFile = fs.createWriteStream(join(dir, "harness.log"));
  const started = Date.now();
  const log = (line: string) => {
    const stamp = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
    logFile.write(`${stamp}s ${line}\n`);
    if (process.env.BAD_DAY_VERBOSE === "1") console.log(`  ${stamp}s ${line}`);
  };
  const checks: Outcome["checks"] = [];
  const cloud = new Cloud(join(dir, "cloud"));
  const front = cloud.start();
  const line = new Line(front, log);
  const linePort = await line.start();
  cloud.base = `http://127.0.0.1:${linePort}`;
  if (one.signInSeconds !== undefined) cloud.signInSeconds = one.signInSeconds;
  cloud.speech = made.speech.path;
  // The home: on the real disk, or on the 256 MB one.
  const home = one.smallDisk === true ? join(RUN, "small-disk", one.name, "home") : join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const real = fs.realpathSync(home);
  // Signed in before the case starts, as the team is: a refresh token kept as Edit keeps it off macOS.
  const account = `home-${new Bun.CryptoHasher("sha256").update(real).digest("hex").slice(0, 16)}`;
  fs.writeFileSync(join(real, "sign-in.json"), JSON.stringify({ [account]: cloud.newSignIn() }), { mode: 0o600 });
  // Exports go into the home: the suggested ~/Videos/Edit is read-only in here, as the rest of the disk is.
  fs.mkdirSync(join(real, "exports"), { recursive: true });
  fs.writeFileSync(join(real, "export-folder.json"), `${JSON.stringify({ path: join(real, "exports") })}\n`);
  const edit = new Edit({
    server: SERVER,
    home: real,
    port: 7800 + index,
    preload: preload(dir, cloud.base, one.smallDisk !== true),
    log,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: homedir(),
      TMPDIR: join(dir, "tmp"),
      LANG: "C.UTF-8",
      TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      EDIT_HOME: real,
      EDIT_TRIALS: "1",
      EDIT_RELAY_URL: cloud.base,
      EDIT_ACCOUNTS_URL: cloud.base,
      EDIT_GOOGLE_API_URL: cloud.base,
      EDIT_YOUTUBE_SIGNIN: "0",
      EDIT_NO_BROWSER: "1",
      EDIT_CLOUD_HOLDER: "bad-day",
      // macOS: the sign-in kept in the home's sign-in.json as off macOS, never the Keychain (shut in here anyway), and
      // the FFmpeg Edit.app ships (scripts/ffmpeg.sh), not Homebrew's.
      ...(MAC ? { EDIT_KEYCHAIN_FILE: join(real, "sign-in.json"), ...shippedFfmpeg() } : {}),
      ...(process.env.EDIT_BAD_DAY_SPEED !== undefined ? { EDIT_BAD_DAY_SPEED: process.env.EDIT_BAD_DAY_SPEED } : {}),
      ...(one.env ?? {}),
    },
  });
  fs.mkdirSync(join(dir, "tmp"), { recursive: true });
  current = edit;
  const context: Context = {
    dir,
    home: real,
    cloud,
    line,
    edit,
    footage: made,
    log,
    started,
    check(name, ok, detail) {
      checks.push({ name, ok, detail });
      log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    },
    async freeze(ms, lineBackAfterMs = 5000) {
      // The lid shut: Edit and everything under it stop, the line is cut at the same moment.
      line.set("down");
      edit.freeze();
      await sleep(ms);
      edit.thaw();
      // The network comes back a few seconds after the wake, as a Mac's does.
      await sleep(lineBackAfterMs);
      line.set("up");
    },
    async waitFor(label, test, ms) {
      const deadline = Date.now() + ms;
      let last: unknown = null;
      while (Date.now() < deadline) {
        try {
          last = await test();
          if (last !== false && last !== null && last !== undefined) return last as never;
        } catch (error) {
          last = error;
        }
        await sleep(1000);
      }
      log(`gave up waiting for ${label} after ${Math.round(ms / 1000)} s (last: ${String(last).slice(0, 200)})`);
      return null;
    },
    sleep,
  };
  let error: string | undefined;
  try {
    log(`case ${one.name} on ${LABEL}`);
    await edit.start();
    // A person starts work once the window shows them signed in (at 7b59f4e2 the server answers before its kept sign-in is back).
    const signedIn = await context.waitFor("Edit signed in", async () => (await edit.api<{ signed_in: boolean }>("GET", "/api/account")).body.signed_in === true || null, 30_000);
    log(`Edit up on ${edit.url}${signedIn === null ? ", NOT signed in after 30 s" : ", signed in"}`);
    await one.run(context);
  } catch (caught) {
    error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
    log(`the case threw: ${error}`);
  }
  // What every case checks, whatever it tests.
  try {
    await common(context, one);
  } catch (caught) {
    log(`the common checks threw: ${String(caught)}`);
  }
  await edit.stop();
  current = null;
  macPeak = Math.max(macPeak, edit.peakRss);
  if (MAC) log(`Edit's tree held at most ${Math.round(edit.peakRss / 1024 ** 2)} MB`);
  // The small disk goes with the sandbox: its log and table are kept with the case's.
  if (one.smallDisk === true) {
    for (const name of ["logs", "jobs.json", "projects"]) {
      try {
        fs.cpSync(join(real, name), join(dir, "home", name), { recursive: true });
      } catch {}
    }
  }
  line.stop();
  cloud.stop();
  fs.writeFileSync(join(dir, "requests.json"), JSON.stringify(cloud.seen, null, 1));
  fs.writeFileSync(join(dir, "line.json"), JSON.stringify(line.requests.map((one) => ({ ...one, at: one.at - started })), null, 1));
  logFile.end();
  const failed = checks.some((check) => !check.ok) || error !== undefined;
  return { name: one.name, verdict: failed ? "fail" : "pass", checks, seconds: Math.round((Date.now() - started) / 1000), error };
}

/** Section 3's "what every case checks", as far as a case's run lets it be judged. */
async function common(context: Context, one: Case): Promise<void> {
  const { cloud, edit, check } = context;
  // 4. No request left Edit without a good sign-in.
  const bad = cloud.badSignIns();
  check(
    "every call had a good sign-in",
    bad.length === 0,
    bad.length === 0 ? `${cloud.seen.filter((seen) => seen.auth === "good").length} calls, all signed in` : `${bad.length} without one: ${bad.slice(0, 4).map((seen) => `${seen.method} ${seen.path} (${seen.auth}) at +${Math.round((seen.at - context.started) / 1000)} s`).join("; ")}`,
  );
  // 1 and 3. Nobody asked over trouble that passes; nothing failed or given up (the table and the log).
  const log = edit.log();
  const asked = [
    /need you signed in/i,
    /Sign in to Edit \(401\)/,
    /import stopped/i,
    /waiting for the person/i,
    /Sharing stopped/i,
  ].filter((pattern) => !(one.allowed ?? []).some((allowed) => allowed.source === pattern.source));
  const said = asked.map((pattern) => ({ pattern, line: log.split("\n").find((line) => pattern.test(line)) })).filter((one) => one.line !== undefined);
  check("nothing-asked: nobody asked, nothing stopped", said.length === 0, said.length === 0 ? "no sign-in, stopped or needs-you line in Edit's log" : said.map((one) => one.line!.slice(0, 220)).join(" | "));
  let jobs: { key: string; kind: string; state: string; until?: string; given_up?: string; error?: string }[] = [];
  try {
    jobs = JSON.parse(fs.readFileSync(join(context.home, "jobs.json"), "utf8"));
  } catch {}
  const stuck = jobs.filter((job) => job.state === "failed" || job.state === "given_up" || job.until === "person");
  check("no work failed, given up or waiting for a person", stuck.length === 0, stuck.length === 0 ? `${jobs.length} rows in jobs.json` : stuck.map((job) => `${job.key} ${job.state}${job.until ? ` until ${job.until}` : ""}: ${job.given_up ?? job.error ?? ""}`.slice(0, 200)).join(" | "));
  const leaked = /No space left|ENOSPC/.test(JSON.stringify(jobs));
  if (leaked) check("no disk error kept in jobs.json", false, "jobs.json holds 'No space left'");
  // 6. Nothing paid sent twice: hearings at most one a recording the case brought in.
  if (one.paidAtMost !== undefined) {
    const paid = cloud.paid();
    const over = Object.entries(one.paidAtMost).filter(([kind, most]) => (paid[kind] ?? 0) > most);
    check("nothing paid sent twice", over.length === 0, JSON.stringify(paid));
  }
}

function table(outcomes: Outcome[]): string {
  const rows = outcomes.map((one) => {
    const failed = one.checks.filter((check) => !check.ok);
    const why = one.error !== undefined ? `threw: ${one.error.split("\n")[0]}` : failed.map((check) => `${check.name}: ${check.detail}`).join("\n      ");
    return `${one.verdict === "pass" ? "PASS" : one.verdict === "stub" ? "STUB" : "FAIL"}  ${one.name.padEnd(26)} ${String(one.seconds).padStart(4)} s${why === "" ? "" : `\n      ${why}`}`;
  });
  return rows.join("\n");
}

/** macOS: Edit.app's FFmpeg (`just ffmpeg`), when this checkout has it. */
function shippedFfmpeg(): Record<string, string> {
  const dir = resolve(SERVER, "target/ffmpeg", process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin");
  return fs.existsSync(join(dir, "ffmpeg")) ? { EDIT_FFMPEG: join(dir, "ffmpeg"), EDIT_FFPROBE: join(dir, "ffprobe") } : {};
}

/** The case's Edit, ended if this process is stopped (macOS: no namespace takes it down with us). */
let current: Edit | null = null;
if (MAC) {
  const end = async (code: number) => {
    await current?.kill();
    process.exit(code);
  };
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, () => void end(130));
  // run.ts gone (as bwrap's --die-with-parent).
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) void end(1);
  }, 1000).unref();
}

await sandboxed();
const made = footage(ROOT);
const asked = process.argv.slice(2);
const chosen = asked.length === 0 ? cases.filter((one) => one.stub !== true) : asked.map((name) => cases.find((one) => one.name === name) ?? macProbes.find((one) => one.name === name) ?? stop(`no case "${name}" (cases: ${cases.map((one) => one.name).join(", ")})`));
console.log(`bad-day: ${chosen.length} case(s) on ${LABEL}`);
const outcomes: Outcome[] = [];
for (const [index, one] of chosen.entries()) {
  if (one.stub === true) {
    outcomes.push({ name: one.name, verdict: "stub", checks: [], seconds: 0, error: "not written yet (its spec is in cases/)" });
    continue;
  }
  console.log(`· ${one.name} …`);
  const outcome = await runCase(one, made, index);
  outcomes.push(outcome);
  console.log(`  ${outcome.verdict === "pass" ? "passed" : "FAILED"} in ${outcome.seconds} s`);
}
const report = `bad-day on ${LABEL}\n${table(outcomes)}\n`;
console.log(`\n${report}`);
fs.writeFileSync(join(RUN, "report.txt"), report);
fs.writeFileSync(join(RUN, "peak-memory"), peakMemory());
process.exit(outcomes.every((one) => one.verdict !== "fail") ? 0 : 1);
