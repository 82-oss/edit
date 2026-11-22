// How many parts an upload sends at once follows the line out (Nov 21, JJ: an 8 Mbit/s uplink that eight parts at
// once filled, so every download on it, an import's footage and a cold play's reads, crawled behind a share or an
// export's cloud copy). Held here: the rule of scale across line speeds (a faster line is never worse off, only a
// slower one gentler), printed as a line per line a person can read; a slow simulated line measured and sent at most
// two parts at once, a fast one eight as before; a line held by each connection rather than by the line kept at
// eight; an upload nobody waits on giving way to a person's download and carrying on after by itself; and one held
// behind a share still saying it's there.
//
// The line is simulated in front of the mock R2 (`fetch` stood in for): a request's body is read a chunk at a time
// at the line's pace, as a socket takes it.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as cloud from "../src/cloud.ts";
import * as diag from "../src/diag.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
const MBIT = 1_000_000;

let mock: MockServer;
let restore: () => void;
const realFetch = globalThis.fetch;
const realPace = { ...cloud.pace };

/** The simulated line: everyone's bytes one after another at `total` bytes a second, or each connection at `perConnection`; `holdMs` more per request. */
let model: { total?: number; perConnection?: number; holdMs?: number } = {};
let lineAt = 0;
/** PUTs to R2 in flight now, and each one's start: when, and how many were in flight with it. */
let out = 0;
let starts: { at: number; out: number; bytes: number }[] = [];

async function carry(bytes: number): Promise<void> {
  if (model.total !== undefined) {
    const now = performance.now();
    lineAt = Math.max(now, lineAt) + (bytes / model.total) * 1000;
    await Bun.sleep(lineAt - now);
  } else if (model.perConnection !== undefined) {
    await Bun.sleep((bytes / model.perConnection) * 1000);
  }
}

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method !== "PUT" || !(init.body instanceof ReadableStream) || !url.includes("/r2/edit/")) return realFetch(input, init);
    out += 1;
    starts.push({ at: performance.now(), out, bytes: Number((init.headers as Record<string, string>)["content-length"] ?? 0) });
    try {
      const chunks: Uint8Array[] = [];
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        await carry(next.value.length);
      }
      if (model.holdMs !== undefined) await Bun.sleep(model.holdMs);
      return await realFetch(url, { method: "PUT", headers: init.headers, body: Buffer.concat(chunks) });
    } finally {
      out -= 1;
    }
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  restore();
  mock.stop();
});

beforeEach(() => {
  cloud.resetPace();
  // Windows short enough for a test's seconds; a part's body handed over 64 KiB at a time, as a socket takes it.
  Object.assign(cloud.pace, { warmMs: 300, spanMs: 1_000, spanBytes: 256 * KIB, pollMs: 50, forPerson: () => null });
  cloud.timing.putChunk = 64 * KIB;
  cloud.timing.resumableFrom = 512 * MIB;
  cloud.keepUploadJournalsIn(null);
  model = {};
  lineAt = 0;
  out = 0;
  starts = [];
});

afterEach(() => {
  Object.assign(cloud.pace, realPace);
  cloud.timing.filePart = cloud.FILE_PART;
  cloud.timing.putChunk = MIB;
  cloud.resetPace();
});

function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let n = 0; n < length; n++) out[n] = (n * 31) % 251;
  return out;
}

const most = (rows: { out: number }[]) => rows.reduce((top, row) => Math.max(top, row.out), 0);

/** The lines a person reads: the team's and two common ones. */
const LINES = [
  { who: "a 2 Mbit/s hotel line", bps: 2 * MBIT },
  { who: "JJ's 8 Mbit/s home line", bps: 8 * MBIT },
  { who: "a 20 Mbit/s line", bps: 20 * MBIT },
  { who: "a 40 Mbit/s line", bps: 40 * MBIT },
  { who: "a 300 Mbit/s line", bps: 300 * MBIT },
  { who: "a line not measured yet", bps: null },
];

test("the rule of scale: a faster line never sends fewer parts, an upload nobody waits on never more than one someone does", () => {
  const speeds = [0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 64, 100, 300, 1000, 10_000].map((mbit) => mbit * MBIT);
  let before = { waited: 0, behind: 0, givenWay: 0 };
  for (const bps of speeds) {
    const waited = cloud.partsFor(bps);
    const behind = cloud.partsFor(bps, true);
    const givenWay = cloud.givenWayBps(bps);
    expect(waited).toBeGreaterThanOrEqual(before.waited);
    expect(behind).toBeGreaterThanOrEqual(before.behind);
    expect(givenWay).toBeGreaterThanOrEqual(before.givenWay);
    expect(waited).toBeGreaterThanOrEqual(1);
    expect(waited).toBeLessThanOrEqual(cloud.FILE_PARALLEL);
    // Behind: about half, one at the least.
    expect(behind).toBe(Math.max(1, Math.floor(waited / 2)));
    // Each part keeps a share of the line a 16 MiB part is up in well inside a minute, unless the line is too slow even for one.
    if (waited > 1) expect(bps / waited).toBeGreaterThanOrEqual(cloud.PART_SHARE_BPS);
    // A line that more parts than eight wouldn't fill keeps all eight, as before.
    if (bps >= cloud.FILE_PARALLEL * cloud.PART_SHARE_BPS) expect(waited).toBe(cloud.FILE_PARALLEL);
    // Giving way leaves at least half the line to the person's download.
    expect(givenWay).toBeLessThanOrEqual(Math.max(bps / 2, 256_000));
    before = { waited, behind, givenWay };
  }
  // Not measured yet: as before the pace (eight), and half for one nobody waits on.
  expect(cloud.partsFor(null)).toBe(8);
  expect(cloud.partsFor(null, true)).toBe(4);
  // JJ's line: at most two.
  expect(cloud.partsFor(8 * MBIT)).toBeLessThanOrEqual(2);
  expect(cloud.partsFor(8 * MBIT, true)).toBe(1);

  for (const { who, bps } of LINES) {
    const waited = cloud.partsFor(bps);
    const behind = cloud.partsFor(bps, true);
    const share = bps === null ? null : bps / waited;
    const partS = share === null ? "" : ` (a 16 MiB part ~${Math.round((cloud.FILE_PART * 8) / share)} s)`;
    console.log(`${who}: ${waited} part${waited === 1 ? "" : "s"} at once${partS}, ${behind} for an upload nobody waits on, which sends one at ${(cloud.givenWayBps(bps) / MBIT).toFixed(1)} Mbit/s while a person's download runs`);
  }
});

test("on a slow line (10 Mbit/s) an upload measures it and sends at most two parts at once, both ways a big file goes up", async () => {
  const { dir, cleanup } = scratch("pace-slow");
  try {
    cloud.timing.filePart = MIB;
    model = { total: 1.25 * MIB };
    for (const resumable of [false, true]) {
      cloud.timing.resumableFrom = resumable ? MIB : 512 * MIB;
      cloud.keepUploadJournalsIn(resumable ? `${dir}/uploads` : null);
      // The first file measures the line (its first eight parts go before it's measured); the second goes measured.
      const data = pattern((resumable ? 4 : 12) * MIB + 77);
      const file = `${dir}/slow-${resumable}.mp4`;
      fs.writeFileSync(file, data);
      starts = [];
      let measuredAt = Infinity;
      const key = `edit/test/slow-${resumable}.mp4`;
      // Looked at every few ms, not at each progress report: progress counts only what's surely there (cloud.ts `put`).
      const watch = setInterval(() => {
        if (measuredAt === Infinity && cloud.lineBps() !== null) measuredAt = performance.now();
      }, 5);
      try {
        await cloud.uploadFile(file, key);
      } finally {
        clearInterval(watch);
      }
      expect(Buffer.from(mock.cloud.objects.get(key)!).equals(Buffer.from(data))).toBe(true);
      // The parts after the first eight (all of the second file's) went at most two at once.
      expect(most(starts.slice(resumable ? 0 : 8))).toBeLessThanOrEqual(2);
      const bps = cloud.lineBps();
      expect(bps).not.toBeNull();
      // Measured near the line (never above it by much: a slow machine only measures it slower).
      expect(bps!).toBeLessThan(1.25 * MIB * 8 * 1.3);
      expect(cloud.partsAtOnce()).toBeLessThanOrEqual(2);
      // Once measured (the first window on the first file; from the start on the second), never more than two at once:
      // the parts already going when it was measured are let finish.
      const after = starts.filter((start) => start.at > measuredAt + 50);
      expect(after.length).toBeGreaterThanOrEqual(3);
      expect(most(after)).toBeLessThanOrEqual(2);
      if (resumable) expect(most(starts)).toBeLessThanOrEqual(2);
    }
  } finally {
    cloud.keepUploadJournalsIn(null);
    cleanup();
  }
}, 120_000);

test("on a fast line eight parts go at once, as before; not measured yet, eight too; four for an upload nobody waits on", async () => {
  const { dir, cleanup } = scratch("pace-fast");
  try {
    cloud.timing.filePart = MIB;
    // Only the speeds set here: the stand-in line isn't measured.
    cloud.pace.spanBytes = Number.MAX_SAFE_INTEGER;
    model = { holdMs: 80 };
    const data = pattern(12 * MIB);
    const file = `${dir}/fast.mp4`;
    fs.writeFileSync(file, data);
    for (const [bps, behind, parts] of [[300 * MBIT, false, 8], [null, false, 8], [300 * MBIT, true, 4]] as const) {
      cloud.resetPace(bps);
      starts = [];
      await cloud.uploadFile(file, `edit/test/fast-${bps}-${behind}.mp4`, undefined, undefined, behind);
      expect(most(starts)).toBe(parts);
    }
  } finally {
    cleanup();
  }
}, 60_000);

test("a line each connection holds (not the line itself) keeps eight parts: fewer went slower, so it isn't stepped down", async () => {
  const { dir, cleanup } = scratch("pace-per-connection");
  try {
    cloud.timing.filePart = MIB;
    // Each connection carries 2 Mbit/s whatever the others do: eight at once measure 16 Mbit/s, which alone would mean four.
    model = { perConnection: 256 * KIB };
    const data = pattern(20 * MIB);
    const file = `${dir}/held.mp4`;
    fs.writeFileSync(file, data);
    await cloud.uploadFile(file, "edit/test/held.mp4");
    expect(Buffer.from(mock.cloud.objects.get("edit/test/held.mp4")!).equals(Buffer.from(data))).toBe(true);
    expect(diag.lines(200).some((row) => row.message.includes("the line isn't full at 8"))).toBe(true);
    expect(cloud.partsAtOnce()).toBe(8);
    // After it was shown, eight at once again.
    expect(most(starts.slice(-8))).toBe(8);
  } finally {
    cleanup();
  }
}, 120_000);

test("an upload nobody waits on goes one part at a time at half the line while a person's download runs, and carries on by itself after", async () => {
  const { dir, cleanup } = scratch("pace-give-way");
  try {
    cloud.timing.filePart = MIB;
    cloud.timing.resumableFrom = MIB;
    cloud.keepUploadJournalsIn(`${dir}/uploads`);
    // A 16 Mbit/s line: four parts for an upload someone waits on, two for one nobody does, 8 Mbit/s while giving way.
    cloud.resetPace(16 * MBIT);
    // Only the speed set here: the stand-in line isn't measured.
    cloud.pace.spanBytes = Number.MAX_SAFE_INTEGER;
    model = { holdMs: 30 };
    let person: string | null = "a play";
    cloud.pace.forPerson = () => person;
    const data = pattern(12 * MIB + 3);
    const file = `${dir}/archive.mp4`;
    fs.writeFileSync(file, data);
    const began = performance.now();
    const sent = cloud.uploadFile(file, "edit/test/archive.mp4", undefined, undefined, true);
    await Bun.sleep(1_500);
    const during = starts.slice();
    const gaveWayFor = (performance.now() - began) / 1000;
    person = null;
    const ended = performance.now();
    await sent;
    const after = starts.filter((start) => start.at >= ended);
    expect(Buffer.from(mock.cloud.objects.get("edit/test/archive.mp4")!).equals(Buffer.from(data))).toBe(true);
    // It never stopped: parts went while the play ran, one at a time, at no more than half the line (and a part).
    expect(during.length).toBeGreaterThanOrEqual(2);
    expect(most(during)).toBe(1);
    expect(during.length * MIB).toBeLessThanOrEqual(((cloud.givenWayBps(16 * MBIT) / 8) * gaveWayFor) + 2 * MIB);
    // Once the play stopped, two at once again, without anything telling it to.
    expect(after.length).toBeGreaterThan(4);
    expect(most(after)).toBe(2);
    expect(diag.lines(200).some((row) => row.message.includes("uploads nobody waits for give way to a play"))).toBe(true);
    expect(diag.lines(200).some((row) => row.message.includes("nothing downloads for a person now"))).toBe(true);
  } finally {
    cloud.keepUploadJournalsIn(null);
    cleanup();
  }
}, 60_000);

test("an upload nobody waits on, held behind a share, keeps saying it's there (its row's beat) and goes once the share is up", async () => {
  const { dir, cleanup } = scratch("pace-beat");
  try {
    cloud.timing.filePart = MIB;
    cloud.pace.beatMs = 40;
    const data = pattern(3 * MIB);
    const file = `${dir}/held.mp4`;
    fs.writeFileSync(file, data);
    let release = () => {};
    const share = cloud.first(() => new Promise<void>((resolve) => (release = resolve)));
    let said = 0;
    const sent = cloud.uploadFile(file, "edit/test/held-behind.mp4", () => (said += 1), undefined, true);
    await Bun.sleep(400);
    expect(starts.length).toBe(0);
    // Said again at least every 40 ms while it waited: 400 ms is ten of them (three, on a slow machine).
    expect(said).toBeGreaterThanOrEqual(3);
    release();
    await share;
    await sent;
    expect(Buffer.from(mock.cloud.objects.get("edit/test/held-behind.mp4")!).equals(Buffer.from(data))).toBe(true);
  } finally {
    cleanup();
  }
}, 30_000);
