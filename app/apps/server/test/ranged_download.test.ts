import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as rd from "../src/ranged_download.ts";

const MIB = 1 << 20;
const file = Uint8Array.from({ length: 5 * MIB + 12_345 }, (_, i) => (i * 31 + (i >> 11)) % 251);
/** What the stand-in Drive does to the next requests, by part start: "fail", "refuse", "shifted" (answers from 1 byte on), "short". */
const trouble = new Map<number, string[]>();
const asked: number[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (match === null) return new Response(file);
      let [from, to] = [Number(match[1]), Math.min(Number(match[2]), file.length - 1)];
      asked.push(from);
      const what = trouble.get(from)?.shift();
      if (what === "fail") return new Response("busy", { status: 503 });
      if (what === "refuse") return new Response("no", { status: 403 });
      if (what === "shifted") from += 1;
      const body = file.subarray(from, what === "short" ? to - 100 : to + 1);
      return new Response(body, { status: 206, headers: { "content-range": `bytes ${from}-${to}/${file.length}` } });
    },
  });
  rd.ranged.part = MIB;
  rd.ranged.parallel = 3;
  rd.ranged.sleep = async () => {};
});

afterAll(() => {
  void server.stop(true);
});

afterEach(() => {
  trouble.clear();
  asked.length = 0;
});

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ranged-"));
const run = (dest: string, onBytes?: (bytes: number) => void) => rd.download({ url: `http://127.0.0.1:${server.port}/f`, size: file.length, dest, fetch: (url, init) => fetch(url, init), onBytes });

test("a big file comes down in parts at once, each where it belongs, and progress only grows to its size", async () => {
  const dest = path.join(dir(), "a.mp4");
  const seen: number[] = [];
  await run(dest, (bytes) => seen.push(bytes));
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
  expect(asked.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5].map((n) => n * MIB));
  expect(seen.at(-1)).toBe(file.length);
  expect(seen.every((bytes, i) => i === 0 || bytes >= seen[i - 1]! - MIB)).toBe(true);
  expect(rd.partlyDone(dest)).toBe(false);
});

test("a part that fails, comes short or starts elsewhere is asked again; the file comes out whole", async () => {
  const dest = path.join(dir(), "b.mp4");
  trouble.set(2 * MIB, ["fail", "shifted"]);
  trouble.set(4 * MIB, ["short"]);
  await run(dest);
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
  expect(asked.filter((from) => from === 2 * MIB)).toHaveLength(3);
  // The short part asked again only for what it lacked (Nov 22: from its start again).
  expect(asked.filter((from) => from === 4 * MIB)).toHaveLength(1);
  expect(asked.filter((from) => from === 4 * MIB + MIB - 101)).toHaveLength(1);
});

// Nov 22, the bad-day resume-download: a 150 MB file in five 32 MB parts at 8 Mbit/s. Each cut threw away what every
// part under way had, and Edit killed before any part was whole left a file of its full length with no journal: it
// read as whole, failed Drive's checksum, and came down again from nothing.
test("stopped before any part is whole, it carries on from what each part has, never from nothing", async () => {
  const dest = path.join(dir(), "e.mp4");
  // Every part comes short and is then refused: the download stops with something of each, and no part whole.
  // (The stand-in's short answer stops 101 bytes before the part's end; the part's next ask starts there.)
  for (let n = 0; n <= 5; n++) {
    const end = Math.min((n + 1) * MIB, file.length) - 1;
    trouble.set(n * MIB, ["short"]);
    trouble.set(end - 100, ["refuse"]);
  }
  await expect(run(dest)).rejects.toBeInstanceOf(rd.Refused);
  expect(rd.partlyDone(dest)).toBe(true);
  const begun = asked.filter((from) => from % MIB === 0);
  expect(begun.length).toBeGreaterThan(0);
  trouble.clear();
  const before = asked.length;
  const seen: number[] = [];
  await run(dest, (bytes) => seen.push(bytes));
  // Each part begun before asked again only from where it stopped (it was noted as far as it got).
  const again = asked.slice(before);
  expect(again.filter((from) => begun.includes(from))).toEqual([]);
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
  expect(seen[0]).toBeGreaterThan(0);
  expect(rd.partlyDone(dest)).toBe(false);
});

test("a part's bytes are noted as they come, so a kill mid-part loses at most a little of it", async () => {
  const dest = path.join(dir(), "f.mp4");
  const every = rd.ranged.noteEvery;
  rd.ranged.noteEvery = 64 * 1024;
  try {
    let journalHad = 0;
    // Watched as the file comes: the most any part not yet whole had noted.
    await rd.download({
      url: `http://127.0.0.1:${server.port}/f`,
      size: file.length,
      dest,
      fetch: (url, init) => fetch(url, init),
      onBytes: () => {
        try {
          const kept = JSON.parse(fs.readFileSync(`${dest}.parts`, "utf8")) as { have?: Record<string, number> };
          journalHad = Math.max(journalHad, ...Object.values(kept.have ?? {}), 0);
        } catch {}
      },
    });
    expect(journalHad).toBeGreaterThan(0);
    expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
  } finally {
    rd.ranged.noteEvery = every;
  }
});

test("stopped part-way, it carries on with the parts left; a file that's gone starts over", async () => {
  const dest = path.join(dir(), "c.mp4");
  // Part 3 refused (Drive said no): the download stops, the parts done are noted.
  trouble.set(3 * MIB, ["refuse"]);
  await expect(run(dest)).rejects.toBeInstanceOf(rd.Refused);
  expect(rd.partlyDone(dest)).toBe(true);
  const before = asked.length;
  await run(dest);
  const again = asked.slice(before);
  expect(again).toContain(3 * MIB);
  expect(again.length).toBeLessThan(6);
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
  // Removed (as damaged) with its parts still noted: all of it again.
  fs.writeFileSync(`${dest}.parts`, JSON.stringify({ size: file.length, part: MIB, done: [0, 1, 2, 3, 4] }));
  fs.rmSync(dest);
  const from = asked.length;
  await run(dest);
  expect(asked.slice(from)).toHaveLength(6);
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
});

// Nov 16 audit: a part was noted done before its bytes were on the disk (a crash then left a hole the journal
// called done), and nothing checked the whole against Drive's own checksum.
test("a part is on the disk before it's noted done, and the whole is checked against Drive's MD5: one that doesn't match is fetched again from nothing", async () => {
  const dest = path.join(dir(), "c.mp4");
  const synced: number[] = [];
  const fsync = spyOn(fs, "fsync").mockImplementation(((fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
    // Each fsync comes before its part is in the journal.
    synced.push(fs.existsSync(`${dest}.parts`) ? (JSON.parse(fs.readFileSync(`${dest}.parts`, "utf8")) as { done: number[] }).done.length : 0);
    fs.fsyncSync(fd);
    done(null);
  }) as never);
  try {
    const md5 = new Bun.CryptoHasher("md5").update(file).digest("hex");
    await rd.download({ url: `http://127.0.0.1:${server.port}/f`, size: file.length, dest, fetch: (url, init) => fetch(url, init), md5 });
    expect(synced.length).toBe(6);
    expect(synced.toSorted()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
    // Drive's checksum isn't this file's: none of it is kept, and it says so.
    await expect(rd.download({ url: `http://127.0.0.1:${server.port}/f`, size: file.length, dest, fetch: (url, init) => fetch(url, init), md5: "0".repeat(32) })).rejects.toThrow("doesn't match Drive's checksum");
    expect(fs.existsSync(dest)).toBe(false);
    expect(rd.partlyDone(dest)).toBe(false);
  } finally {
    fsync.mockRestore();
  }
});

test("Drive's MD5 is asked of Drive beside the parts when the address is a Drive file's", async () => {
  const dest = path.join(dir(), "d.mp4");
  const md5 = new Bun.CryptoHasher("md5").update(file).digest("hex");
  const asked: string[] = [];
  const drive = (url: string, init: RequestInit) => {
    asked.push(url);
    if (url.includes("fields=md5Checksum")) return Promise.resolve(Response.json({ md5Checksum: "f".repeat(32) }));
    return fetch(`http://127.0.0.1:${server.port}/f`, init);
  };
  await expect(rd.download({ url: "https://www.googleapis.com/drive/v3/files/abc123?alt=media&supportsAllDrives=true", size: file.length, dest, fetch: drive })).rejects.toThrow("doesn't match Drive's checksum");
  expect(asked).toContain("https://www.googleapis.com/drive/v3/files/abc123?fields=md5Checksum&supportsAllDrives=true");
  expect(md5).not.toBe("f".repeat(32));
});
