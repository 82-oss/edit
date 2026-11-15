// log_ship.ts: each Mac's log, its crashes and a note of a run that stopped
// without quitting, sent to the team's cloud as they happen, so an admin reads
// them with that Mac off (Sphe, Nov 15).

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import type { App } from "../src/app.ts";
import * as cloud from "../src/cloud.ts";
import * as lastRun from "../src/last_run.ts";
import * as logShip from "../src/log_ship.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  logShip.stopForTests();
  accounts.resetForTests();
  restore();
  mock.stop();
});

const line = (n: number, level = "INFO", area = "http") => `2026-11-15 10:00:${String(n % 60).padStart(2, "0")}.000 ${level} [${area}] line ${n}\n`;
const text = (got: logShip.Collected | null) => got?.bytes.toString("utf8") ?? null;

test("the log is sent from where the last send stopped, across a restart, a rotation and a log cut short", () => {
  const box = scratch("log-ship");
  try {
    const dir = box.dir;
    const log = join(dir, "edit.log");
    fs.writeFileSync(log, line(1) + line(2));
    // The first send: all of it.
    let got = logShip.collect(dir, null)!;
    expect(text(got)).toBe(line(1) + line(2));
    expect(got.why).toEqual([]);
    // Nothing new: nothing sent, the mark where it was.
    expect(text(logShip.collect(dir, got.next))).toBe("");
    // A line half written waits for the next send.
    fs.appendFileSync(log, `${line(3)}2026-11-15 10:00:04.000 INFO [http] half`);
    got = logShip.collect(dir, got.next)!;
    expect(text(got)).toBe(line(3));
    fs.appendFileSync(log, " done\n");
    // A restart reads the mark from where it was kept: the same answer from the mark alone.
    const kept = JSON.parse(JSON.stringify(got.next)) as logShip.Mark;
    got = logShip.collect(dir, kept)!;
    expect(text(got)).toBe("2026-11-15 10:00:04.000 INFO [http] half done\n");
    // Set aside as diag.ts does (edit.log.1 → .2…, edit.log → .1, a new edit.log): the rest of the old, then the new.
    const rotate = () => {
      for (let n = 4; n >= 1; n--) if (fs.existsSync(`${log}.${n}`)) fs.renameSync(`${log}.${n}`, `${log}.${n + 1}`);
      fs.renameSync(log, `${log}.1`);
    };
    fs.appendFileSync(log, line(5));
    rotate();
    fs.writeFileSync(log, line(6));
    got = logShip.collect(dir, got.next)!;
    expect(text(got)).toBe(line(5) + line(6));
    // Set aside twice since: .2's rest, all of .1, then edit.log.
    fs.appendFileSync(log, line(7));
    rotate();
    fs.writeFileSync(log, line(8));
    rotate();
    fs.writeFileSync(log, line(9));
    got = logShip.collect(dir, got.next)!;
    expect(text(got)).toBe(line(7) + line(8) + line(9));
    // Cut short (a new file in place, the same inode emptied): from its start, and said.
    fs.truncateSync(log, 0);
    fs.appendFileSync(log, line(11));
    got = logShip.collect(dir, { ...got.next, offset: got.next.offset + 1000 })!;
    expect(text(got)).toBe(line(11));
    expect(got.why[0]).toContain("cut short");
    // The mark's file no longer kept: edit.log from its start, and said.
    got = logShip.collect(dir, { ino: -1, offset: 5 })!;
    expect(text(got)).toBe(line(11));
    expect(got.why[0]).toContain("set aside more often");
    // No log at all.
    expect(logShip.collect(join(dir, "nowhere"), null)).toBeNull();
  } finally {
    box.cleanup();
  }
});

test("more than a chunk's worth since the last send: the newest whole lines, and how much was left out", () => {
  const box = scratch("log-ship-cap");
  try {
    const log = join(box.dir, "edit.log");
    const all = Array.from({ length: 100 }, (_, n) => line(n)).join("");
    fs.writeFileSync(log, all);
    const got = logShip.collect(box.dir, null, 200)!;
    const sent = text(got)!;
    expect(sent.length).toBeLessThanOrEqual(200);
    expect(all.endsWith(sent)).toBe(true);
    expect(sent.startsWith("2026-11-15 ")).toBe(true);
    expect(got.skipped).toBe(all.length - sent.length);
    expect(got.why[0]).toContain(`${got.skipped} bytes of the log left out`);
    expect(got.next.offset).toBe(all.length);
  } finally {
    box.cleanup();
  }
});

test("chunks and crashes are named by the Mac and the time, and the time is read back from the name", () => {
  const at = Date.parse("2026-11-15T10:05:00.123Z");
  expect(logShip.chunkKey("JJ's MacBook Pro", at)).toBe("edit/reports/logs/jj-s-macbook-pro/2026-11-15/2026-11-15T10-05-00.123Z.log.gz");
  expect(logShip.crashKey("kenobi", at, "edit-2026-11-15-100500.ips")).toBe("edit/reports/crashes/kenobi/2026-11-15/2026-11-15T10-05-00.123Z-edit-2026-11-15-100500.ips.gz");
  expect(logShip.keyTime(logShip.chunkKey("kenobi", at))).toBe(at);
  expect(logShip.keyTime(logShip.crashKey("kenobi", at, "stopped.txt"))).toBe(at);
  expect(logShip.keyTime("edit/reports/logs/kenobi/2026-11-15/notes.txt")).toBeNull();
  expect(cloud.validKey(logShip.chunkKey("JJ's MacBook Pro", at))).toBe(true);
});

test("a run that stopped without quitting is kept with its log's last lines, never this run's own", () => {
  const box = scratch("log-ship-stopped");
  try {
    const home = box.dir;
    fs.mkdirSync(join(home, "logs"));
    const lines = Array.from({ length: 400 }, (_, n) => line(n).trimEnd());
    // diag.open writes this run's first line before last_run.begin looks.
    fs.writeFileSync(join(home, "logs", "edit.log"), `${lines.join("\n")}\n2026-11-15 11:00:00.000 INFO [edit] started nightly-80 (macos aarch64)\n`);
    fs.writeFileSync(join(home, "logs", "running.json"), JSON.stringify({ pid: process.pid + 1, started: Date.parse("2026-11-15T09:00:00Z"), build: "nightly-79" }));
    lastRun.begin(home, join(home, "no-reports"));
    const stopped = lastRun.lastStop()!;
    expect(stopped.build).toBe("nightly-79");
    expect(stopped.tail).toHaveLength(lastRun.TAIL);
    expect(stopped.tail.at(-1)).toBe(lines.at(-1)!);
    const note = logShip.stoppedText("kenobi", stopped);
    expect(note).toStartWith("Edit stopped unexpectedly around 2026-11-15 10:00:39 on kenobi");
    expect(note).toContain("nightly-79");
    // A run that quit leaves none.
    lastRun.quitting();
    lastRun.begin(home, join(home, "no-reports"));
    expect(lastRun.lastStop()).toBeNull();
  } finally {
    lastRun.quitting();
    box.cleanup();
  }
});

test("what's sent is scrubbed and gzipped: the log, a crash report once, and the stopped note; an admin reads them back", async () => {
  const box = scratch("log-ship-send");
  try {
    const home = join(box.dir, "home");
    const reports = join(box.dir, "DiagnosticReports");
    fs.mkdirSync(join(home, "logs"), { recursive: true });
    fs.mkdirSync(reports);
    const log = join(home, "logs", "edit.log");
    fs.writeFileSync(log, `${line(1, "WARN", "cloud")}2026-11-15 10:00:02.000 ERROR [cloud] upload of https://r2.example/x?X-Amz-Signature=secret failed\n  at a stack line\n`);
    fs.writeFileSync(join(reports, "edit-2026-11-15-100000.ips"), '{"app_name":"edit"}\n{"note":"see https://example.com/?token=abc"}');
    fs.writeFileSync(join(reports, "Safari-2026-11-15-100000.ips"), "not ours");
    fs.writeFileSync(join(home, "logs", "running.json"), JSON.stringify({ pid: process.pid + 1, started: Date.now() - 60_000, build: "nightly-79" }));
    lastRun.begin(home, reports);
    accounts.signedInForTests(["use"]);
    const app = { store: { home }, machine: "kenobi" } as unknown as App;
    logShip.start(app, reports);
    await logShip.ship();
    // Nothing new: nothing more sent; a crash report goes once.
    const sentOnce = [...mock.cloud.objects.keys()].filter((key) => key.startsWith("edit/reports/")).sort();
    await logShip.ship();
    expect([...mock.cloud.objects.keys()].filter((key) => key.startsWith("edit/reports/")).sort()).toEqual(sentOnce);
    expect(sentOnce.filter((key) => key.startsWith("edit/reports/logs/kenobi/"))).toHaveLength(1);
    expect(sentOnce.filter((key) => key.startsWith("edit/reports/crashes/kenobi/") && key.endsWith("-edit-2026-11-15-100000.ips.gz"))).toHaveLength(1);
    expect(sentOnce.filter((key) => key.endsWith("-stopped.txt.gz"))).toHaveLength(1);
    expect(sentOnce.some((key) => key.includes("Safari"))).toBe(false);
    // The mark was kept: a restart sends only what's new.
    expect(JSON.parse(fs.readFileSync(join(home, "logs", "shipped.json"), "utf8")).log.offset).toBe(fs.statSync(log).size);

    // A new line, and the way out: sent within the quit's budget.
    fs.appendFileSync(log, line(3));
    await Bun.sleep(5);
    await logShip.finish();

    accounts.signedInForTests(["use"], true);
    const inbox = join(box.dir, "inbox");
    const chunks = (await logShip.pullLogs("kenobi", Date.now() - 3_600_000, inbox)).map(logShip.readSent);
    expect(chunks).toHaveLength(2);
    const all = chunks.map((chunk) => [...chunk.notes, ...chunk.lines].join("\n")).join("\n");
    expect(all).not.toContain("X-Amz-Signature");
    expect(all).toContain("upload of <url> failed");
    expect(chunks[0]!.notes[0]).toContain("Edit's log from kenobi");
    expect(chunks[1]!.lines).toEqual([line(3).trimEnd()]);
    const crashes = (await logShip.pullCrashes("kenobi", 7, join(box.dir, "crashes"))).map(logShip.readSent);
    const crashText = crashes.map((one) => [...one.notes, ...one.lines].join("\n")).join("\n");
    expect(crashText).not.toContain("token=abc");
    expect(crashText).toContain("Edit stopped unexpectedly around");
    expect(crashText).toContain("No crash report for it");
  } finally {
    logShip.stopForTests();
    lastRun.quitting();
    accounts.resetForTests();
    box.cleanup();
  }
});

test("lines are picked in the Mac's time zone, by level, area and pattern, each with its continuation lines", () => {
  // The Mac is at UTC+02:00: 12:00 there is 10:00 UTC.
  const tz = 120;
  const chunk = {
    tz,
    lines: [
      "2026-11-15 11:59:00.000 ERROR [cloud] too early",
      "2026-11-15 12:00:01.000 INFO [http] fine",
      "2026-11-15 12:00:02.000 ERROR [cloud] upload failed",
      "  at the stack",
      "2026-11-15 12:00:03.000 WARN [media] slow",
    ],
  };
  const from = Date.parse("2026-11-15T10:00:00Z");
  expect(logShip.lineTime(chunk.lines[1]!, tz)).toBe(Date.parse("2026-11-15T10:00:01Z"));
  expect(logShip.pick([chunk], { from, limit: 500 }).lines).toEqual(chunk.lines.slice(1));
  expect(logShip.pick([chunk], { from, level: "warn", limit: 500 }).lines).toEqual(chunk.lines.slice(2));
  expect(logShip.pick([chunk], { from, level: "error", limit: 500 }).lines).toEqual(chunk.lines.slice(2, 4));
  expect(logShip.pick([chunk], { from, grep: "STACK", limit: 500 }).lines).toEqual(chunk.lines.slice(2, 4));
  expect(logShip.pick([chunk], { from, area: "media", limit: 500 }).lines).toEqual(chunk.lines.slice(4));
  const last = logShip.pick([chunk], { from, limit: 1 });
  expect(last).toEqual({ matched: 3, lines: chunk.lines.slice(4) });
});
