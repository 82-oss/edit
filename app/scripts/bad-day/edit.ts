// One Edit server for a case, from source (this checkout, or a commit run.ts
// exported), in a process group of its own, so a freeze or a kill reaches it
// and everything under it (FFmpeg, curl) and nothing else.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  private out: fs.WriteStream;

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
    try {
      process.kill(-this.child.pid, name);
    } catch {}
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
