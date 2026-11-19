// `just bad-day [--at <ref>] [case…]`: builds the sandbox and runs the
// bad-day cases inside it (inside.ts). Section 3 of
// docs/plans/2026-11-19-honest-council/final.md is the spec.
//
// - One run at a time: the scope has one name (edit-bad-day), so a second is
//   refused by systemd ("already loaded").
// - Six gigabytes for the whole run and no swap: past it the run is ended,
//   the machine isn't. It won't start with under 8 GB available.
// - Its own network (loopback only) and its own process numbers; ~/.edit,
//   ~/.edit-dev and ~/.edit-prod are empty folders inside; only the run's
//   folder (~/.cache/edit-bad-day, never /tmp: it's memory here) is written.
// - `--at <ref>` runs Edit's server as it was at that commit: the ref is
//   exported with `git archive` into ~/.cache/edit-bad-day/at-<sha>/ and given
//   this checkout's node_modules and native addon by symlink, read-only. The
//   cases are always today's (this folder), so "fails on the old code" and
//   "passes on the new" are the same test.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const APP = resolve(import.meta.dir, "../..");
const REPO = resolve(APP, "..");
const ROOT = join(homedir(), ".cache", "edit-bad-day");
const UNIT = "edit-bad-day";
const MIN_AVAILABLE = 8 * 1024 ** 3;

function fail(message: string): never {
  console.error(`bad-day: ${message}`);
  process.exit(2);
}

function git(args: string[]): string {
  const run = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
  if (run.status !== 0) fail(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

function available(): number {
  const line = fs.readFileSync("/proc/meminfo", "utf8").split("\n").find((one) => one.startsWith("MemAvailable:"));
  return Number(/(\d+)/.exec(line ?? "")?.[1] ?? 0) * 1024;
}

/** A folder's entries as symlinks to the checkout's (scoped folders entry by entry), with `own` pointing elsewhere. */
function linkModules(from: string, to: string, own: Record<string, string> = {}): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const source = join(from, name);
    if (name.startsWith("@") && fs.lstatSync(source).isDirectory()) {
      fs.mkdirSync(join(to, name), { recursive: true });
      for (const inner of fs.readdirSync(source)) {
        const key = `${name}/${inner}`;
        fs.symlinkSync(own[key] ?? fs.realpathSync(join(source, inner)), join(to, name, inner));
      }
    } else {
      fs.symlinkSync(own[name] ?? fs.realpathSync(source), join(to, name));
    }
  }
}

/** The server as it was at `ref`, ready to run: its folder (the `app` inside the export). */
function exportAt(ref: string): string {
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const dir = join(ROOT, `at-${sha.slice(0, 12)}`);
  const app = join(dir, "app");
  if (fs.existsSync(join(dir, ".ready"))) return app;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // All of app/ and agent/ (42 MB): the server reads assets, fonts and the agent's skills from beside it.
  const paths = ["app", "agent"];
  const archive = spawnSync("bash", ["-c", `git -C "$0" archive "$1" ${paths.map((one) => `'${one}'`).join(" ")} | tar -x -C "$2"`, REPO, sha, dir], { stdio: "inherit" });
  if (archive.status !== 0) fail(`couldn't export ${ref}`);
  // node_modules and the native addon from this checkout, read-only by symlink. @edit/types is the export's own.
  fs.symlinkSync(join(APP, "node_modules"), join(app, "node_modules"));
  linkModules(join(APP, "apps/server/node_modules"), join(app, "apps/server/node_modules"), { "@edit/types": join(app, "packages/edit-types") });
  for (const pkg of fs.readdirSync(join(APP, "packages"))) {
    linkModules(join(APP, "packages", pkg, "node_modules"), join(app, "packages", pkg, "node_modules"));
  }
  fs.symlinkSync(join(APP, "crates/edit-native/edit-native.node"), join(app, "crates/edit-native/edit-native.node"));
  // The page isn't needed (the cases drive the API), but a built one is linked if there is one.
  if (fs.existsSync(join(APP, "apps/web/dist"))) {
    fs.mkdirSync(join(app, "apps/web"), { recursive: true });
    fs.symlinkSync(join(APP, "apps/web/dist"), join(app, "apps/web/dist"));
  }
  fs.writeFileSync(join(dir, ".ready"), `${sha}\n`);
  return app;
}

const args = process.argv.slice(2);
let at: string | null = null;
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--at") at = args[++i] ?? fail("--at needs a ref");
  else rest.push(args[i]!);
}

if (rest.includes("--list")) {
  const { cases } = await import("./cases/index.ts");
  for (const one of cases) console.log(`${one.name}${one.stub === true ? " (not written yet)" : ""} · change ${one.change}\n  ${one.spec}\n`);
  process.exit(0);
}

if (available() < MIN_AVAILABLE) fail(`only ${(available() / 1024 ** 3).toFixed(1)} GB of memory available; a run needs 8 GB`);
const loaded = spawnSync("systemctl", ["--user", "is-active", `${UNIT}.scope`], { encoding: "utf8" });
if (loaded.stdout.trim() === "active") fail("another bad-day run is going (edit-bad-day.scope); one at a time");

const server = at === null ? APP : exportAt(at);
const label = at === null ? "the working tree" : `${at} (${git(["rev-parse", "--short=8", at])})`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN = join(ROOT, "runs", `${stamp}${at === null ? "" : `-at-${git(["rev-parse", "--short=8", at])}`}`);
fs.mkdirSync(join(RUN, "tmp"), { recursive: true });
fs.mkdirSync(join(RUN, "small-disk"), { recursive: true });
// Old runs go after a week; the footage and exports stay.
for (const old of fs.existsSync(join(ROOT, "runs")) ? fs.readdirSync(join(ROOT, "runs")) : []) {
  const path = join(ROOT, "runs", old);
  if (Date.now() - fs.statSync(path).mtimeMs > 7 * 86400_000) fs.rmSync(path, { recursive: true, force: true });
}
const home = homedir();
for (const dir of [".edit", ".edit-dev", ".edit-prod"]) fs.mkdirSync(join(home, dir), { recursive: true });

console.log(`bad-day: Edit from ${label}; run folder ${RUN}`);
const command = [
  "systemd-run", "--user", "--scope", "--quiet", `--unit=${UNIT}`, "-p", "MemoryMax=6G", "-p", "MemorySwapMax=0",
  "bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent",
  "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
  // No host sockets either: Unix sockets aren't behind the network namespace (Tailscale's, D-Bus, logind's).
  "--tmpfs", "/run",
  "--bind", ROOT, ROOT,
  // The small disk: 256 MB, memory-backed (a real one needs root), counted inside the cap.
  "--size", String(256 * 1024 * 1024), "--tmpfs", join(RUN, "small-disk"),
  "--tmpfs", join(home, ".edit"), "--tmpfs", join(home, ".edit-dev"), "--tmpfs", join(home, ".edit-prod"),
  // No Claude Code inside (Edit's model questions fail and are passed over, as they're built to be), and none of its sign-ins.
  "--tmpfs", join(home, ".local/bin"), "--tmpfs", join(home, ".claude"),
  "--setenv", "TMPDIR", join(RUN, "tmp"),
  "--setenv", "BAD_DAY_RUN", RUN,
  "--setenv", "BAD_DAY_ROOT", ROOT,
  "--setenv", "BAD_DAY_SERVER", server,
  "--setenv", "BAD_DAY_LABEL", label,
  // No transpiler cache written outside the run.
  "--setenv", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0",
  process.execPath, join(import.meta.dir, "inside.ts"), ...rest,
];
const started = Date.now();
const run = spawnSync(command[0]!, command.slice(1), { stdio: "inherit", cwd: APP });
const peak = (() => {
  try {
    return fs.readFileSync(join(RUN, "peak-memory"), "utf8").trim();
  } catch {
    return "unknown";
  }
})();
console.log(`bad-day: ${Math.round((Date.now() - started) / 1000)} s, peak memory ${peak}; logs in ${RUN}`);
process.exit(run.status ?? 1);
