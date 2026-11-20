// One Edit server for a case, from source (this checkout, or a commit run.ts
// exported), in a process group of its own, so a freeze or a kill reaches it
// and everything under it (FFmpeg, curl) and nothing else.
//
// On macOS there's no process namespace around the run, so a signal goes to
// Edit's tree as `ps` shows it that moment: its group, and every program
// descended from it that left the group, never this process or anything else.
// The tree's memory is read every 2 s there too: its peak is the run's, and
// past 4 GB (an 8 GB Mac's cgroup cap) Edit is ended.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAC = process.platform === "darwin";
const MEMORY_CAP = 4 * 1024 ** 3;

/** macOS: the programs of Edit's tree (pid → rss in bytes): `root`'s group, and every descendant of anything in it. */
export function tree(root: number): Map<number, number> {
  const rows = (spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss="], { encoding: "utf8" }).stdout ?? "").split("\n");
  const all: { pid: number; ppid: number; pgid: number; rss: number }[] = [];
  for (const row of rows) {
    const cells = row.trim().split(/\s+/).map(Number);
    if (cells.length === 4 && cells.every(Number.isFinite)) all.push({ pid: cells[0]!, ppid: cells[1]!, pgid: cells[2]!, rss: cells[3]! * 1024 });
  }
  const found = new Map<number, number>();
  for (const one of all) if (one.pgid === root || one.pid === root) found.set(one.pid, one.rss);
  for (let grew = true; grew; ) {
    grew = false;
    for (const one of all) {
      if (!found.has(one.pid) && found.has(one.ppid)) {
        found.set(one.pid, one.rss);
        grew = true;
      }
    }
  }
  // Never this process or its parents (the harness, the shell that ran it).
  for (let pid = process.pid; pid > 1; pid = all.find((one) => one.pid === pid)?.ppid ?? 0) found.delete(pid);
  return found;
}

export interface EditOptions {
  /** The app folder whose apps/server/src/main.ts runs. */
  server: string;
  home: string;
  port: number;
  env: Record<string, string>;
  /** A preload (the stand-in model, test-only switches the server already has). */
  preload: string;
  log: (line: string) => void;
}

export class Edit {
  child: ChildProcess | null = null;
  starts = 0;
  frozen = false;
  /** macOS: the most Edit's tree has held at once (bytes), over every start. */
  peakRss = 0;
  private out: fs.WriteStream;
  private watch: ReturnType<typeof setInterval> | null = null;

  constructor(readonly options: EditOptions) {
    fs.mkdirSync(options.home, { recursive: true });
    this.out = fs.createWriteStream(join(options.home, "..", "edit.out"), { flags: "a" });
  }

  get url(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  async start(): Promise<void> {
    const { server, home, port, env, preload } = this.options;
    this.starts += 1;
    this.out.write(`\n===== start ${this.starts} at ${new Date().toISOString()} =====\n`);
    const child = spawn(process.execPath, ["--preload", preload, join(server, "apps/server/src/main.ts"), "serve", "--port", String(port), "--home", home], {
      cwd: server,
      env: { ...env },
      // Its own process group: `kill(-pid)` freezes or ends it and its children together.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.pipe(this.out, { end: false });
    child.stderr!.pipe(this.out, { end: false });
    this.child = child;
    if (MAC && child.pid !== undefined) {
      // For run.ts, which ends whatever of these groups outlives the run.
      const run = process.env.BAD_DAY_RUN;
      if (run !== undefined && run !== "") fs.appendFileSync(join(run, "edit-pids"), `${child.pid}\n`);
      if (this.watch !== null) clearInterval(this.watch);
      this.watch = setInterval(() => {
        if (this.child !== child || child.pid === undefined) return;
        let rss = 0;
        for (const one of tree(child.pid).values()) rss += one;
        if (rss > this.peakRss) this.peakRss = rss;
        if (rss > MEMORY_CAP) {
          this.options.log(`Edit's tree holds ${Math.round(rss / 1024 ** 2)} MB, over the ${MEMORY_CAP / 1024 ** 3} GB cap: ended`);
          this.signal("SIGKILL");
        }
      }, 2000);
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Edit exited at start (${child.exitCode}); see edit.out`);
      try {
        const answer = await fetch(`${this.url}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (answer.ok) return;
      } catch {}
      await sleep(300);
    }
    throw new Error("Edit didn't answer /api/health within 2 minutes");
  }

  private signal(name: NodeJS.Signals): void {
    if (this.child?.pid === undefined) return;
    const root = this.child.pid;
    try {
      process.kill(-root, name);
    } catch {}
    if (!MAC) return;
    // The group first (at once), then anything of Edit's that left it; twice, for a program started in between.
    for (let pass = 0; pass < 2; pass++) {
      for (const pid of tree(root).keys()) {
        try {
          process.kill(pid, name);
        } catch {}
      }
    }
  }

  /** Every program in Edit's group stops where it is (a lid shut). */
  freeze(): void {
    this.options.log("Edit frozen (SIGSTOP to its group)");
    this.signal("SIGSTOP");
    this.frozen = true;
  }

  thaw(): void {
    this.options.log("Edit woken (SIGCONT)");
    this.signal("SIGCONT");
    this.frozen = false;
  }

  /** A kill is a kill: the group, at once, nothing saved on the way out. */
  async kill(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.options.log("Edit killed (SIGKILL to its group)");
    if (this.frozen) this.thaw();
    this.signal("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
    this.child = null;
  }

  /** Ended as a person quits it (SIGTERM, then a kill if it won't go). */
  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    if (this.frozen) this.thaw();
    this.signal("SIGTERM");
    const deadline = Date.now() + 15_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
    this.signal("SIGKILL");
    this.child = null;
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
  }

  /** The server's own log, as written (all of it, every start). */
  log(): string {
    const dir = join(this.options.home, "logs");
    let text = "";
    for (const name of ["edit.log.5", "edit.log.4", "edit.log.3", "edit.log.2", "edit.log.1", "edit.log"]) {
      try {
        text += fs.readFileSync(join(dir, name), "utf8");
      } catch {}
    }
    return text;
  }

  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
    const answer = await fetch(`${this.url}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await answer.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: answer.status, body: parsed as T, text };
  }
}
