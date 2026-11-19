// Inside the sandbox (run.ts builds it): proves the sandbox is shut, makes
// the footage, then for each case starts the stand-ins, the bad line and a
// fresh Edit, runs the case, checks what every case checks, and prints one
// table at the end.
//
//   bun scripts/bad-day/inside.ts [case…]      (only ever from run.ts)

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cases, type Case, type Context, type Verdict } from "./cases/index.ts";
import { Cloud } from "./cloud.ts";
import { Edit } from "./edit.ts";
import { footage } from "./footage.ts";
import { Line } from "./line.ts";

const RUN = process.env.BAD_DAY_RUN ?? "";
const ROOT = process.env.BAD_DAY_ROOT ?? "";
const SERVER = process.env.BAD_DAY_SERVER ?? "";
const LABEL = process.env.BAD_DAY_LABEL ?? SERVER;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stop(message: string): never {
  console.error(`bad-day: ${message}`);
  process.exit(2);
}

/** That this is the sandbox: no public address answers, prod's folder is empty, our own process numbers. */
async function sandboxed(): Promise<void> {
  if (RUN === "" || SERVER === "") stop("run me through run.ts (`just bad-day`), never by hand");
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

/** The cgroup's highest memory use so far (the scope's), in MB. */
function peakMemory(): string {
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
        : "") +
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
      ...(process.env.EDIT_BAD_DAY_SPEED !== undefined ? { EDIT_BAD_DAY_SPEED: process.env.EDIT_BAD_DAY_SPEED } : {}),
      ...(one.env ?? {}),
    },
  });
  fs.mkdirSync(join(dir, "tmp"), { recursive: true });
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

await sandboxed();
const made = footage(ROOT);
const asked = process.argv.slice(2);
const chosen = asked.length === 0 ? cases.filter((one) => one.stub !== true) : asked.map((name) => cases.find((one) => one.name === name) ?? stop(`no case "${name}" (cases: ${cases.map((one) => one.name).join(", ")})`));
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
