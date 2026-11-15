// Reaching the team's Macs from this one (Sphe, Nov 4: "give yourself as MUCH
// control and info as needed to be able to diagnose issues that come up on
// other people's Macs"): straight to the team's Convex and relay, as the
// admin signed in to a data folder here (`--home`, ~/.edit-dev by default),
// with no Edit running. A Mac is named as its report names it (a part of
// "mathiass-macbook-pro" will do). Questions are read-only (remote_ask.ts);
// the commands that change something say so.
//
//   bun apps/server/scripts/remote.ts devices                    every Mac: build, last report, id
//   bun apps/server/scripts/remote.ts latest [mac]                its latest report and how old it is (or every Mac's first lines)
//   bun apps/server/scripts/remote.ts logs <mac> [since=2h] [grep=re] [level=warn|error] [area=x] [lines=500]   its log, sent every 5 min: works with the Mac off
//   bun apps/server/scripts/remote.ts crashes <mac> [days=7]      its crashes and the times Edit stopped without quitting
//   bun apps/server/scripts/remote.ts ask <mac> <question…>       read-only: help, log, system, ps, net, work, project, ls, file, get
//   bun apps/server/scripts/remote.ts diagnostics <mac>           a fresh full report
//   bun apps/server/scripts/remote.ts probe <mac> <id>            one import's whole error and its files
//   bun apps/server/scripts/remote.ts history <mac>               the commands sent to it and how they went
//   bun apps/server/scripts/remote.ts reports [days]              the team's sent problem reports
//   changes something: unstick | restart | update-when-idle | update <mac>, resume <mac> <id>
//
// Full control (Sphe, Nov 15; a build with remote_control.ts; everything that changes something shows on their screen):
//   bun apps/server/scripts/remote.ts help <mac> <why…>           a dialog over their Edit: who's working on it, why, each step live
//   bun apps/server/scripts/remote.ts help <mac> end [words…]     closes it ("All done. You can carry on." unless given)
//   bun apps/server/scripts/remote.ts say <mac> <words…>          a line on their screen
//   bun apps/server/scripts/remote.ts call <mac> <METHOD> </api/…> [json]   any of Edit's own routes, as their Mac
//   bun apps/server/scripts/remote.ts agent <mac> <project> <prompt…>       a message to that project's agent, as you
//   bun apps/server/scripts/remote.ts sh <mac> <command…> [--seconds 60]    a shell there (output scrubbed)
//   bun apps/server/scripts/remote.ts restart <mac> --now [--hold agents,exports,imports]   now, whatever runs; held work waits for release
//   bun apps/server/scripts/remote.ts update <mac> --now [--hold …]          the newest build now, the same way
//   bun apps/server/scripts/remote.ts hold <mac> <agents,exports,imports|all|kinds>  /  release <mac>   /  open <mac>
//   A question longer than ~85 characters goes as a run by itself. --minutes N: how long a run waits for the Mac (10, at most 60).
//
// Answers are printed and kept in /tmp/edit-remote/. `--dev` asks dev's devices instead (the dev server here).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The team's relay (prod), whatever this shell points dev at; `--dev`: dev's (the dev server on :7700 is a device there).
const DEV_RELAY = "https://edit-relay-dev.sphe-g-personal.workers.dev";
if (process.argv.includes("--dev")) {
  process.argv.splice(process.argv.indexOf("--dev"), 1);
  process.env.EDIT_RELAY_URL = DEV_RELAY;
} else {
  delete process.env.EDIT_RELAY_URL;
}

// The server's modules in the order the server loads them (cli.ts is its entry; importing it starts nothing): started
// from accounts.ts, reviews.ts ran before busy.ts had finished and the script died on start (Nov 11, "Cannot access
// 'others' before initialization").
await import("../src/cli.ts");
const { ConvexClient } = await import("convex/browser");
const { makeFunctionReference } = await import("convex/server");
const accounts = await import("../src/accounts.ts");
const cloud = await import("../src/cloud.ts");
const problemReports = await import("../src/problem_reports.ts");
const relay = await import("../src/relay.ts");
const { authTokenFetcher } = await import("../src/remote_support.ts");
const { encodeAsk } = await import("../src/remote_ask.ts");
const { duration, parse } = await import("../src/remote_ask.ts");
const lastRun = await import("../src/last_run.ts");
const logShip = await import("../src/log_ship.ts");

const OUT = path.join(os.tmpdir(), "edit-remote");
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const value = argv[at + 1] ?? fallback;
  argv.splice(at, 2);
  return value;
};
const home = flag("--home", path.join(os.homedir(), ".edit-dev"));
const waitSeconds = Number(flag("--wait", "180"));
const holdFlag = flag("--hold", "");
const shSeconds = Number(flag("--seconds", "60"));
const runMinutes = Number(flag("--minutes", "10"));
const nowFlag = argv.includes("--now");
if (nowFlag) argv.splice(argv.indexOf("--now"), 1);
const [command = "help", ...rest] = argv;

function fail(message: string): never {
  console.error(`remote: ${message}`);
  process.exit(2);
}

if ((command === "help" && rest.length === 0) || command === "--help") {
  console.log(fs.readFileSync(import.meta.path, "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.slice(3)).join("\n"));
  process.exit(0);
}

await accounts.renew(home);
const status = accounts.status() as { signed_in?: boolean; admin?: boolean; person?: { email?: string } | null };
if (status.signed_in !== true) fail(`nobody is signed in to ${home}: sign in to Edit there (or give --home)`);
if (status.admin !== true) fail(`${status.person?.email ?? "this sign-in"} isn't an admin`);

const query = (name: string) => makeFunctionReference<"query">(`editSupport:${name}`);
const mutation = (name: string) => makeFunctionReference<"mutation">(`editSupport:${name}`);

let client: InstanceType<typeof ConvexClient> | null = null;
async function convex(): Promise<InstanceType<typeof ConvexClient>> {
  if (client !== null) return client;
  // The relay now and then doesn't answer one call (Nov 4, dev's: a 30 s hang, then fine): asked again.
  let config: { url: string } | null = null;
  for (let tries = 1; config === null; tries++) {
    try {
      config = await relay.json<{ url: string }>("POST", "/v1/cloud/support-config", {}, "remote support", 15);
    } catch (error) {
      if (tries >= 3) throw error;
      console.error(`remote: the relay didn't answer (${error instanceof Error ? error.message : String(error)}); asking again`);
    }
  }
  const c = new ConvexClient(new URL(config.url).origin, { initialAuthTokenReuse: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Convex didn't take the sign-in in 20 s")), 20_000);
    c.setAuth(authTokenFetcher(home), (authenticated) => {
      if (authenticated) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  client = c;
  return c;
}

interface Device {
  deviceId: string;
  label: string;
  build: string;
  enabled: boolean;
  updatedAt: number;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "mac";

/** Every Mac's latest report: its sender and when it came (a Mac sends one at least hourly while Edit is open). */
async function latestReports(): Promise<Map<string, { from: string; sent: string; path: string }>> {
  const out = new Map<string, { from: string; sent: string; path: string }>();
  for (const one of await problemReports.latest(path.join(OUT, "home"))) out.set(slug(one.mac), { from: one.from, sent: one.sent, path: one.path });
  return out;
}

const ago = (iso: string | number) => {
  const ms = Date.now() - (typeof iso === "number" ? iso : Date.parse(iso));
  if (!Number.isFinite(ms)) return "never";
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 172_800_000 ? `${(ms / 3_600_000).toFixed(1)} h ago` : `${Math.round(ms / 86_400_000)} days ago`;
};

async function devices(): Promise<Device[]> {
  return ((await (await convex()).query(query("devices"), {})) as Device[]).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The Mac `name` names as its reports are kept (`logs`, `crashes`): the one whose latest report's name is it or has it, needing no Convex. */
async function sentFrom(name: string | undefined): Promise<string> {
  if (name === undefined) fail("name a Mac (latest lists them)");
  const macs = (await cloud.list("edit/reports/latest/")).map((one) => one.key.slice("edit/reports/latest/".length).replace(/\.txt$/u, ""));
  const wanted = slug(name);
  const found = macs.includes(wanted) ? [wanted] : macs.filter((mac) => mac.includes(wanted));
  if (found.length > 1) fail(`${name} could be ${found.join(" or ")}`);
  return found[0] ?? wanted;
}

/** The Mac `name` names: its id, its label or a part of it; the latest started of those that share it. */
async function find(name: string | undefined): Promise<Device> {
  if (name === undefined) fail("name a Mac (devices lists them)");
  const all = await devices();
  const wanted = name.toLowerCase();
  const exact = all.filter((one) => one.deviceId === name || slug(one.label) === slug(name));
  const found = exact.length > 0 ? exact : all.filter((one) => one.label.toLowerCase().includes(wanted) || one.deviceId.startsWith(name));
  const labels = new Set(found.map((one) => slug(one.label)));
  if (found.length === 0) fail(`no Mac is called ${name}: ${[...new Set(all.map((one) => one.label))].join(", ")}`);
  if (labels.size > 1) fail(`${name} could be ${[...labels].join(" or ")}`);
  return found[0]!;
}

/** Sends a command and waits for its outcome; the outcome's words. A `run`'s target is its request (remote_control.ts). */
async function send(device: Device, kind: "update" | "diagnostics" | "resume" | "run", target?: string): Promise<string> {
  const c = await convex();
  const commandId = crypto.randomUUID();
  if (kind === "update") await c.mutation(mutation("requestUpdate"), { deviceId: device.deviceId, commandId });
  else if (kind === "run") await c.mutation(mutation("requestRun"), { deviceId: device.deviceId, commandId, payload: target ?? "{}", minutes: runMinutes });
  else await c.mutation(mutation("requestAction"), { deviceId: device.deviceId, commandId, kind, ...(target ? { projectId: target } : {}) });
  const began = Date.now();
  let last = "";
  while (Date.now() - began < waitSeconds * 1000) {
    const history = (await c.query(query("history"), { deviceId: device.deviceId })) as { commandId: string; state: string; detail?: string }[];
    const ours = history.find((one) => one.commandId === commandId);
    if (ours !== undefined && ours.state !== last) {
      last = ours.state;
      if (ours.state === "claimed") console.error(`remote: ${device.label} took it (${Math.round((Date.now() - began) / 1000)} s)`);
    }
    if (ours?.state === "complete") return ours.detail ?? "";
    if (ours?.state === "failed") fail(`${device.label}: ${ours.detail ?? "failed"}`);
    await Bun.sleep(2000);
  }
  const reports = await latestReports();
  const seen = reports.get(slug(device.label));
  fail(`${device.label} didn't ${last === "claimed" ? "finish" : "take"} it in ${waitSeconds} s: is Edit open there? Its last report came ${seen ? ago(seen.sent) : "never"}. The command waits 10 minutes (history shows it).`);
}

/** Prints what an outcome points at (a report it sent up), else the outcome itself. */
async function show(device: Device, detail: string): Promise<void> {
  const key = /edit\/reports\/[^\s]+\.txt/.exec(detail)?.[0];
  if (key === undefined) {
    console.log(detail);
    return;
  }
  const local = path.join(OUT, `${slug(device.label)}-${Date.now()}.txt`);
  for (let tries = 1; ; tries++) {
    try {
      await cloud.download(key, local);
      break;
    } catch (error) {
      if (tries >= 3) throw new Error(`the answer is at ${key}, but it couldn't be fetched: ${error instanceof Error ? error.message : String(error)}`);
      console.error("remote: fetching the answer failed; asking again");
    }
  }
  console.log(fs.readFileSync(local, "utf8"));
  console.error(`remote: kept in ${local}`);
}

try {
  switch (command) {
    case "devices": {
      const reports = await latestReports();
      for (const one of await devices()) {
        const report = reports.get(slug(one.label));
        console.log(`${one.label.padEnd(30)} ${one.build.padEnd(12)} started ${ago(one.updatedAt).padEnd(12)} last report ${report ? ago(report.sent) : "never"}${report ? ` (${report.from})` : ""}  ${one.enabled ? "" : "[off] "}${one.deviceId}`);
      }
      break;
    }
    case "latest": {
      const reports = await latestReports();
      if (rest[0] === undefined) {
        for (const [mac, one] of reports) {
          const lines = fs.readFileSync(one.path, "utf8").split("\n");
          const attention = lines.slice(lines.indexOf("Needs attention:") + 1, lines.indexOf("Machine:")).filter((line) => line.trim() !== "");
          console.log(`${mac} · ${one.from} · ${ago(one.sent)}\n  ${attention.join("\n  ")}`);
        }
      } else {
        const one = [...reports].find(([mac]) => mac.includes(slug(rest[0]!)));
        if (one === undefined) fail(`no latest report from ${rest[0]}: ${[...reports.keys()].join(", ")}`);
        // Sent every 10 minutes while Edit is open: older than that, it's off or closed (or a build from before Nov 15, hourly).
        console.log(`(sent ${ago(one[1].sent)}, ${one[1].sent})\n`);
        console.log(fs.readFileSync(one[1].path, "utf8"));
      }
      break;
    }
    case "ask": {
      const device = await find(rest[0]);
      const question = rest.slice(1).join(" ") || "help";
      // Too long to ride on a resume's target: a run carries any length (a build with remote_control.ts).
      let target: string | null = null;
      try {
        target = encodeAsk(question);
      } catch {
        target = null;
      }
      await show(device, target !== null ? await send(device, "resume", target) : await send(device, "run", JSON.stringify({ do: "ask", question })));
      break;
    }
    case "help":
    case "say":
    case "call":
    case "agent":
    case "sh":
    case "hold":
    case "release":
    case "open": {
      const device = await find(rest[0]);
      const words = rest.slice(1);
      let request: Record<string, unknown>;
      if (command === "help") request = words[0] === "end" ? { do: "help-end", message: words.slice(1).join(" ") } : { do: "help", message: words.join(" ") };
      else if (command === "say") request = { do: "say", message: words.join(" ") };
      else if (command === "call") {
        const [method, route, body] = words;
        if (method === undefined || route === undefined) fail("call <mac> <METHOD> </api/…> [json]");
        request = { do: "call", method, path: route, ...(body === undefined ? {} : { body: JSON.parse(body) as unknown }) };
      } else if (command === "agent") {
        if (words.length < 2) fail("agent <mac> <project> <prompt…>");
        request = { do: "agent", project: words[0], prompt: words.slice(1).join(" ") };
      } else if (command === "sh") request = { do: "sh", command: words.join(" "), seconds: shSeconds };
      else if (command === "hold") request = { do: "hold", what: words };
      else request = { do: command };
      await show(device, await send(device, "run", JSON.stringify(request)));
      break;
    }
    case "diagnostics": {
      const device = await find(rest[0]);
      await show(device, await send(device, "diagnostics"));
      break;
    }
    case "probe":
    case "resume": {
      const device = await find(rest[0]);
      if (rest[1] === undefined) fail(`${command} needs a project or script id`);
      await show(device, await send(device, "resume", command === "probe" ? `probe-${rest[1]}` : rest[1]));
      break;
    }
    case "unstick":
    case "restart":
    case "update-when-idle":
    case "update": {
      const device = await find(rest[0]);
      // --now (or --hold): whatever runs, through remote_control.ts; everything carries on after it but what's held.
      if ((command === "restart" || command === "update") && (nowFlag || holdFlag !== "")) {
        console.log(await send(device, "run", JSON.stringify({ do: command, ...(holdFlag === "" ? {} : { hold: holdFlag.split(",") }) })));
        break;
      }
      console.log(command === "update" ? await send(device, "update") : await send(device, "resume", command));
      break;
    }
    case "history": {
      const device = await find(rest[0]);
      const history = (await (await convex()).query(query("history"), { deviceId: device.deviceId })) as { commandId: string; kind: string; projectId?: string; state: string; detail?: string; createdAt: number }[];
      for (const one of history) console.log(`${new Date(one.createdAt).toISOString()} ${one.kind}${one.projectId ? ` ${one.projectId.slice(0, 40)}` : ""} · ${one.state}${one.detail ? ` · ${one.detail.slice(0, 200)}` : ""}`);
      break;
    }
    case "logs": {
      const mac = await sentFrom(rest[0]);
      const { options } = parse(`logs ${rest.slice(1).join(" ")}`);
      const since = duration(options.get("since") ?? "2h");
      if (since === null) fail(`since=${options.get("since")} isn't a time: 30m, 2h, 1d`);
      const from = Date.now() - since;
      const paths = await logShip.pullLogs(mac, from, path.join(OUT, "logs", mac));
      if (paths.length === 0) fail(`${mac} sent no log since ${new Date(from).toISOString()}: Edit wasn't open there, or its build is from before Nov 15`);
      const chunks = paths.map(logShip.readSent);
      for (const note of chunks.flatMap((chunk) => chunk.notes.slice(1))) console.error(`remote: ${note}`);
      const picked = logShip.pick(chunks, { from, level: options.get("level")?.toLowerCase(), area: options.get("area"), grep: options.get("grep"), limit: Math.max(Number(options.get("lines") ?? 500) || 500, 1) });
      const kept = path.join(OUT, `${mac}-log-${Date.now()}.log`);
      fs.writeFileSync(kept, `${picked.lines.join("\n")}\n`);
      console.log(picked.lines.join("\n"));
      console.error(`remote: ${picked.matched} line(s) matched in ${chunks.length} chunk(s), the latest sent ${ago(logShip.keyTime(paths.at(-1)!) ?? Number.NaN)}; kept in ${kept}`);
      break;
    }
    case "crashes": {
      const mac = await sentFrom(rest[0]);
      const days = Number(parse(`crashes ${rest.slice(1).join(" ")}`).options.get("days") ?? 7);
      const paths = await logShip.pullCrashes(mac, Number.isFinite(days) && days > 0 ? days : 7, path.join(OUT, "crashes", mac));
      if (paths.length === 0) console.log(`no crash or unexpected stop from ${mac} in ${days} days`);
      for (const file of paths) {
        const sent = logShip.readSent(file);
        const plain = file.replace(/\.gz$/u, "");
        fs.writeFileSync(plain, `${sent.lines.join("\n")}\n`);
        // A crash report is pages of JSON: what stopped it; the whole report is kept.
        const body = file.endsWith(".ips.gz") ? (lastRun.crashSummary(sent.lines.join("\n")) ?? "a crash report this can't read") : sent.lines.join("\n");
        console.log(`== ${new Date(logShip.keyTime(file) ?? 0).toISOString()} · ${path.basename(plain)} (${plain})\n${body}\n`);
      }
      break;
    }
    case "reports": {
      for (const one of await problemReports.pull(path.join(OUT, "home"), Number(rest[0] ?? 7))) console.log(`${one.sent} · ${one.mac} · ${one.from}\n  ${one.summary}\n  ${one.path}`);
      break;
    }
    default:
      fail(`unknown command ${command}: bun apps/server/scripts/remote.ts help`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
await (client as InstanceType<typeof ConvexClient> | null)?.close();
process.exit(0);
