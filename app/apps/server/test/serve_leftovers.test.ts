import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { endLeftovers } from "../src/serve.ts";

test("a restart ends the agent's processes the last run left under this process, nothing else", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-leftovers-"));
  // A stand-in `claude` that keeps its name (no exec), as the agent's does while it works.
  fs.writeFileSync(join(dir, "claude"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  // Both under a parent of their own standing in for the server: under the test
  // runner itself, other tests' FFmpeg would be ended too (and counted).
  const parent = Bun.spawn(["/bin/sh", "-c", `"${join(dir, "claude")}" --output-format stream-json & sleep 30 & echo started; wait`], { stdout: "pipe", stderr: "ignore" });
  const reader = parent.stdout.getReader();
  await reader.read();
  await Bun.sleep(300);
  const children = () =>
    new TextDecoder()
      .decode(Bun.spawnSync(["/bin/ps", "-axo", "ppid=,command="], { stdout: "pipe" }).stdout)
      .split("\n")
      .filter((line) => Number(line.trim().split(/\s+/)[0]) === parent.pid);
  try {
    expect(children().some((line) => line.includes("sleep 30") && !line.includes("claude"))).toBe(true);
    expect(endLeftovers(parent.pid)).toEqual(["claude"]);
    await Bun.sleep(500);
    const left = children();
    expect(left.some((line) => line.includes("claude"))).toBe(false);
    expect(left.some((line) => line.includes("sleep 30"))).toBe(true);
  } finally {
    parent.kill();
    Bun.spawnSync(["/usr/bin/pkill", "-P", String(parent.pid)]);
  }
});

// Nov 21 audit: after a hard crash the old run's `claude` belongs to init (or a subreaper), not to the new server, and
// kept calling the new server's /mcp. One whose MCP address is this server's own is ended too; another's never.
test("a start after a hard crash ends the agent the crashed run left on this server's own address, never another's", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-orphans-"));
  fs.writeFileSync(join(dir, "claude"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  const port = 47_000 + Math.floor(Math.random() * 1000);
  const config = (at: number) => JSON.stringify({ mcpServers: { edit: { type: "http", url: `http://127.0.0.1:${at}/mcp?project=p1` } } });
  // Orphaned (its parent gone, as a crashed server's are): started in the background of a shell that exits at once.
  const orphan = (at: number) => Bun.spawnSync(["/bin/sh", "-c", `nohup "${join(dir, "claude")}" --output-format stream-json --mcp-config '${config(at)}' >/dev/null 2>&1 &`]);
  orphan(port);
  orphan(port + 1);
  await Bun.sleep(300);
  const running = (at: number) =>
    new TextDecoder()
      .decode(Bun.spawnSync(["/bin/ps", "-axo", "command="], { stdout: "pipe" }).stdout)
      .split("\n")
      .some((line) => line.includes(join(dir, "claude")) && line.includes(`127.0.0.1:${at}/mcp`));
  try {
    expect(running(port)).toBe(true);
    expect(endLeftovers(process.pid, port)).toEqual(["claude"]);
    await Bun.sleep(500);
    expect(running(port)).toBe(false);
    expect(running(port + 1)).toBe(true);
  } finally {
    Bun.spawnSync(["/usr/bin/pkill", "-f", join(dir, "claude")]);
  }
});
