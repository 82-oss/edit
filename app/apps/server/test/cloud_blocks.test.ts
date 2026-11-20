import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import * as playing from "../src/playing.ts";
import * as storage from "../src/storage.ts";
import * as vbr from "./helpers/vbr_mp4.ts";

import { BLOCK, blocksHere, fetchWhole, HELD_BYTES, heldInMemory, keeping, laneHooks, NoRoom, hedgeHooks, noteViewerMiss, retryHooks, serve, setSoon, signHooks, viewerBusy, viewerHooks, waitForViewerRest, warm } from "../src/cloud_blocks.ts";

// R2 stood in for: a 5½-block object, every range read counted.
const size = BLOCK * 5 + BLOCK / 2;
const object = new Uint8Array(size).map((_, i) => (i * 7) % 251);
const reads: string[] = [];
const r2 = Bun.serve({
  port: 0,
  fetch(request) {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "") ?? [];
    reads.push(`${a}-${b}`);
    const [from, to] = [Number(a), Math.min(Number(b), size - 1)];
    return new Response(object.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${size}` } });
  },
});
afterAll(() => r2.stop(true));
const url = async () => `http://127.0.0.1:${r2.port}/object`;
const root = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-"));
const folderFor = (at: string, key: string) => join(at, createHash("sha1").update(key).digest("hex"));
const bytes = async (response: Response | null) => new Uint8Array(await response!.arrayBuffer());

test("a range comes from 2 MiB blocks read once, the next two read ahead, picture and sound sharing them", async () => {
  // The page's 256 KiB reads of one block: R2 is read once for it (plus the two after it, ahead).
  const asks = [0, 1, 2, 3].map((n) => serve(root, "edit/proxies/a.mp4", `bytes=${n * 262144}-${(n + 1) * 262144 - 1}`, url));
  const answers = await Promise.all(asks);
  expect(answers.map((answer) => answer!.status)).toEqual([206, 206, 206, 206]);
  expect(await bytes(answers[2]!)).toEqual(object.subarray(2 * 262144, 3 * 262144));
  expect(answers[0]!.headers.get("content-range")).toBe(`bytes 0-262143/${size}`);
  await Bun.sleep(50);
  expect(reads.sort()).toEqual([`0-${BLOCK - 1}`, `${BLOCK}-${2 * BLOCK - 1}`, `${2 * BLOCK}-${3 * BLOCK - 1}`].sort());
  // Across a block's edge, and to the object's end: from the blocks kept, and the end clamped.
  const across = await serve(root, "edit/proxies/a.mp4", `bytes=${BLOCK - 10}-${BLOCK + 9}`, url);
  expect(await bytes(across)).toEqual(object.subarray(BLOCK - 10, BLOCK + 10));
  const end = await serve(root, "edit/proxies/a.mp4", `bytes=${size - 5}-${size + 100}`, url);
  expect(end!.headers.get("content-range")).toBe(`bytes ${size - 5}-${size - 1}/${size}`);
  expect(await bytes(end)).toEqual(object.subarray(size - 5));
});

test("a range to the object's end is sent a block at a time, whole; a reader that stops stops the reads (Nov 10: a long script preview was \"Out of memory\")", async () => {
  const key = "edit/proxies/whole.mp4";
  const before = reads.length;
  // Through a server, as the page gets it: the length said, every byte there.
  const edit = Bun.serve({ port: 0, fetch: async (request) => (await serve(root, key, request.headers.get("range"), url))! });
  try {
    const answer = await fetch(`http://127.0.0.1:${edit.port}/`, { headers: { range: `bytes=10-${size - 1}` } });
    expect(answer.status).toBe(206);
    // Bun sends a stream chunked, as it does R2's own body on the way through.
    expect(answer.headers.get("content-range")).toBe(`bytes 10-${size - 1}/${size}`);
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(object.subarray(10));
  } finally {
    void edit.stop(true);
  }
  expect(reads.length - before).toBe(6);
  // Another object, read only as far as its first block: the rest isn't fetched (its next two ahead at most).
  const other = "edit/proxies/stopped.mp4";
  const started = reads.length;
  const response = await serve(root, other, `bytes=0-${size - 1}`, url);
  const reader = response!.body!.getReader();
  expect((await reader.read()).value!.length).toBe(BLOCK);
  await reader.cancel();
  await Bun.sleep(50);
  expect(reads.length - started).toBeLessThanOrEqual(3);
});

test("a read to the end or of the whole object comes from blocks too, its length said (FFmpeg's reads: Edit.app's window, the censor check)", async () => {
  const key = "edit/proxies/open.mp4";
  const before = reads.length;
  const edit = Bun.serve({ port: 0, fetch: async (request) => (await serve(root, key, request.headers.get("range"), url))! });
  try {
    // A read asking for no range: the whole object, as 200 with its size said (Bun sends it chunked), so FFmpeg knows it can seek.
    const whole = await fetch(`http://127.0.0.1:${edit.port}/`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-range")).toBe(`bytes 0-${size - 1}/${size}`);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(object);
    // After a seek, a range to the end: from the blocks kept, not R2 again.
    const kept = reads.length;
    const rest = await fetch(`http://127.0.0.1:${edit.port}/`, { headers: { range: `bytes=${BLOCK + 5}-` } });
    expect(rest.status).toBe(206);
    expect(rest.headers.get("content-range")).toBe(`bytes ${BLOCK + 5}-${size - 1}/${size}`);
    expect(new Uint8Array(await rest.arrayBuffer())).toEqual(object.subarray(BLOCK + 5));
    expect(reads.length).toBe(kept);
  } finally {
    void edit.stop(true);
  }
  expect(reads.length - before).toBe(6);
});

test("an odd ask isn't served from blocks; one past the end is refused", async () => {
  expect(await serve(root, "edit/proxies/a.mp4", "bytes=-500", url)).toBeNull();
  expect(await serve(root, "edit/proxies/a.mp4", "bytes=0-10,20-30", url)).toBeNull();
  expect((await serve(root, "edit/proxies/a.mp4", `bytes=${size + 10}-${size + 20}`, url))?.status).toBe(416);
  expect((await serve(root, "edit/proxies/a.mp4", `bytes=${size + 10}-`, url))?.status).toBe(416);
});

test("a stretch is warmed into blocks (its index too), and what's here is said", async () => {
  const key = "edit/proxies/warmed.mp4";
  expect(blocksHere(root, key)).toBeNull();
  // The middle fifth: its blocks and one either side, and the first (the index).
  expect(await warm(root, key, 0.4, 0.6, 1, url)).toBeGreaterThan(0);
  const here = blocksHere(root, key)!;
  expect(here.size).toBe(size);
  expect([...here.here].sort()).toEqual([0, 1, 2, 3, 4]);
  // Warmed again: nothing read.
  expect(await warm(root, key, 0.4, 0.6, 1, url)).toBe(0);
});

test("a read someone waits on goes first, then the seconds ahead of a jump, then whole copies' fills (Nov 16: a jump froze behind them)", async () => {
  // An R2 that answers only when let go, in the order asked.
  const order: string[] = [];
  const gates: (() => void)[] = [];
  const slow = Bun.serve({
    port: 0,
    async fetch(request) {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "") ?? [];
      order.push(`${new URL(request.url).pathname} ${a}`);
      await new Promise<void>((resolve) => gates.push(resolve));
      const [from, to] = [Number(a), Math.min(Number(b), size - 1)];
      return new Response(object.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${size}` } });
    },
  });
  try {
    const slowRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-slow-"));
    const at = (name: string) => async () => `http://127.0.0.1:${slow.port}/${name}`;
    // Four whole copies filling: four of the six reads at most, so two are always there for someone waiting.
    const fills = Array.from({ length: 4 }, (_, n) => fetchWhole(slowRoot, `edit/proxies/big${n}.mp4`, join(slowRoot, `big${n}.mp4`), at(`big${n}`)));
    for (let tries = 0; tries < 100 && order.length < 4; tries++) await Bun.sleep(5);
    gates.splice(0).forEach((go) => go());
    for (let tries = 0; tries < 100 && order.length < 8; tries++) await Bun.sleep(5);
    await Bun.sleep(20);
    expect(order.length).toBe(8);
    // A jump: the seconds ahead of it warmed in three files (two at once in the free reads, one waiting), then the page's read of the picture there.
    const warming = Promise.all(["a", "b", "c"].map((name) => warm(slowRoot, `edit/proxies/ahead-${name}.mp4`, 0, 0.1, 1, at(`ahead-${name}`))));
    for (let tries = 0; tries < 100 && order.length < 10; tries++) await Bun.sleep(5);
    expect(order.slice(8, 10)).toEqual(["/ahead-a 0", "/ahead-b 0"]);
    const jump = serve(slowRoot, "edit/proxies/jump.mp4", "bytes=0-100", at("jump"));
    await Bun.sleep(20);
    expect(order.length).toBe(10);
    // A read lets go: the page's goes next, ahead of the warming and the fills waiting.
    gates.shift()!();
    for (let tries = 0; tries < 100 && order.length < 11; tries++) await Bun.sleep(5);
    expect(order[10]).toBe("/jump 0");
    // Everything let go, everything answers, and each copy is the object whole.
    const drain = setInterval(() => gates.splice(0).forEach((go) => go()), 2);
    expect((await jump)!.status).toBe(206);
    await warming;
    await Promise.all(fills);
    clearInterval(drain);
    expect(new Uint8Array(fs.readFileSync(join(slowRoot, "big0.mp4")))).toEqual(object);
    // Its blocks let go as it's joined: the copy takes its own size on the disk, not twice it.
    expect(blocksHere(slowRoot, "edit/proxies/big0.mp4")).toBeNull();
  } finally {
    void slow.stop(true);
  }
});

test("a viewer read that misses on R2 marks the viewer busy; a cache hit does not, and a rest wait waits for rest", async () => {
  const key = "edit/proxies/viewer-busy.mp4";
  noteViewerMiss(0);
  expect(viewerBusy()).toBe(false);
  // A miss: the page waited on R2, so background work must pause.
  await serve(root, key, "bytes=0-1023", url);
  expect(viewerBusy()).toBe(true);
  // Backdate the miss past the rest window: a hit must not mark it again.
  const rest = viewerHooks.restMs;
  noteViewerMiss(Date.now() - rest - 1000);
  expect(viewerBusy()).toBe(false);
  await serve(root, key, "bytes=0-1023", url);
  expect(viewerBusy()).toBe(false);
  // Background work waits while the viewer is busy, then goes once it rests.
  viewerHooks.restMs = 200;
  noteViewerMiss();
  const began = Date.now();
  expect(await waitForViewerRest()).toBe(true);
  expect(Date.now() - began).toBeGreaterThanOrEqual(150);
  viewerHooks.restMs = rest;
  noteViewerMiss(0);
});

test("a bounded rest wait proceeds anyway once it is up, however busy the viewer stays", async () => {
  noteViewerMiss();
  const began = Date.now();
  // The viewer stays busy (a miss within the rest window): the bound, not rest, ends this wait.
  expect(await waitForViewerRest(() => false, 120)).toBe(true);
  expect(Date.now() - began).toBeGreaterThanOrEqual(100);
  // A stop still wins over the bound.
  expect(await waitForViewerRest(() => true, 60_000)).toBe(false);
  noteViewerMiss(0);
});


test("a block read that fails in passing is tried again, so a read to the end never ends short (FFmpeg: \"Input/output error\"); one not there fails at once", async () => {
  const waits = retryHooks.waits;
  retryHooks.waits = [5, 5];
  let failures = 2;
  let gone = 0;
  const flaky = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/gone") {
        gone++;
        return new Response("no", { status: 404 });
      }
      if (failures-- > 0) return new Response("busy", { status: 503 });
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "") ?? [];
      const [from, to] = [Number(a), Math.min(Number(b), size - 1)];
      return new Response(object.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${size}` } });
    },
  });
  try {
    const flakyRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-flaky-"));
    const answer = await serve(flakyRoot, "edit/proxies/flaky.mp4", "bytes=0-99", async () => `http://127.0.0.1:${flaky.port}/flaky`);
    expect(new Uint8Array(await answer!.arrayBuffer())).toEqual(object.subarray(0, 100));
    await expect(serve(flakyRoot, "edit/proxies/gone.mp4", "bytes=0-99", async () => `http://127.0.0.1:${flaky.port}/gone`)).rejects.toThrow("404");
    expect(gone).toBe(1);
  } finally {
    retryHooks.waits = waits;
    void flaky.stop(true);
  }
});

test("a read someone waits on goes to R2's own URL too when the edge is slow, and takes the first answer; read-ahead and fills stay on the edge", async () => {
  const hedge = hedgeHooks.ms;
  hedgeHooks.ms = 30;
  const asked: string[] = [];
  const answer = (request: Request) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "") ?? [];
    const [from, to] = [Number(a), Math.min(Number(b), size - 1)];
    return new Response(object.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${size}` } });
  };
  // The edge answers in 400 ms (a block it hasn't seen), R2 at once.
  const edge = Bun.serve({ port: 0, async fetch(request) { asked.push(`edge ${new URL(request.url).pathname}`); await Bun.sleep(400); return answer(request); } });
  const r2own = Bun.serve({ port: 0, fetch(request) { asked.push(`r2 ${new URL(request.url).pathname}`); return answer(request); } });
  try {
    const hedgeRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-hedge-"));
    const source = (name: string) => Object.assign(async () => `http://127.0.0.1:${edge.port}/${name}`, { direct: async () => `http://127.0.0.1:${r2own.port}/${name}` });
    const began = performance.now();
    const read = await serve(hedgeRoot, "edit/proxies/hedged.mp4", "bytes=0-99", source("hedged"));
    expect(new Uint8Array(await read!.arrayBuffer())).toEqual(object.subarray(0, 100));
    expect(performance.now() - began).toBeLessThan(300);
    expect(asked).toContain("r2 /hedged");
    // Read ahead of the playhead and warmed: the edge alone (the first read's own reads done first).
    await Bun.sleep(500);
    asked.length = 0;
    await warm(hedgeRoot, "edit/proxies/ahead.mp4", 0, 0.01, 1, source("ahead"));
    expect(asked.every((one) => one.startsWith("edge"))).toBe(true);
  } finally {
    hedgeHooks.ms = hedge;
    void edge.stop(true);
    void r2own.stop(true);
  }
});

test("a cold read starts on its first bytes straight from R2's own URL while its block lands, then reads on from the blocks, every byte in place", async () => {
  const answer = (request: Request) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "") ?? [];
    const [from, to] = [Number(a), Math.min(Number(b), size - 1)];
    return new Response(object.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${size}` } });
  };
  // The edge slow to answer a block it hasn't seen; R2's own at once. Every ask counted.
  let asks = 0;
  const edge = Bun.serve({ port: 0, async fetch(request) { asks++; await Bun.sleep(300); return answer(request); } });
  const r2own = Bun.serve({ port: 0, fetch(request) { asks++; return answer(request); } });
  try {
    const coldRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-cold-"));
    const source = Object.assign(async () => `http://127.0.0.1:${edge.port}/x`, { direct: async () => `http://127.0.0.1:${r2own.port}/x` });
    // From just before a block's end, to the end: the first bytes cross into the next block.
    const from = BLOCK - 1000;
    const began = performance.now();
    const read = await serve(coldRoot, "edit/proxies/cold.mp4", `bytes=${from}-`, source);
    expect(read!.headers.get("content-range")).toBe(`bytes ${from}-${size - 1}/${size}`);
    const reader = read!.body!.getReader();
    const firstBytes = await reader.read();
    expect(performance.now() - began).toBeLessThan(200);
    const chunks = [firstBytes.value!];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const whole = new Uint8Array(chunks.reduce((sum, one) => sum + one.length, 0));
    let at = 0;
    for (const one of chunks) {
      whole.set(one, at);
      at += one.length;
    }
    expect(whole).toEqual(object.subarray(from));
    // Its block kept for the next read. The answer never waits on it (its first bytes came from the peek), so it
    // may land after the blocks read on from: waited for, not assumed (CI's Macs, Nov 17, it hadn't yet).
    const landed = performance.now() + 5_000;
    while (!blocksHere(coldRoot, "edit/proxies/cold.mp4")?.here.has(0) && performance.now() < landed) await Bun.sleep(5);
    expect(blocksHere(coldRoot, "edit/proxies/cold.mp4")!.here.has(0)).toBe(true);
    // The next read of it is the disk's alone: nothing asked of the edge or R2.
    const before = asks;
    const again = await serve(coldRoot, "edit/proxies/cold.mp4", `bytes=0-99`, source);
    expect(await bytes(again)).toEqual(object.subarray(0, 100));
    expect(asks).toBe(before);
  } finally {
    void edge.stop(true);
    void r2own.stop(true);
  }
});

test("at the disk's floor a block read is answered from memory and not kept, a whole copy stops (NoRoom) before it reads, and the page is told nothing is kept", async () => {
  const realFree = storage.diskHooks.free;
  try {
    const floorRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-floor-"));
    storage.diskHooks.free = () => storage.WORK_FLOOR_BYTES + BLOCK / 2;
    expect(keeping(floorRoot)).toBe(false);
    const key = "edit/proxies/floor.mp4";
    const read = await serve(floorRoot, key, `bytes=0-99`, url);
    expect(await bytes(read)).toEqual(object.subarray(0, 100));
    // Its size kept (a few bytes), no block on disk: the block held in memory.
    expect(fs.existsSync(join(folderFor(floorRoot, key), "0"))).toBe(false);
    expect(blocksHere(floorRoot, key)).toEqual({ size, here: new Set([0]) });
    expect(heldInMemory().blocks).toBeGreaterThanOrEqual(1);
    const before = reads.length;
    await expect(fetchWhole(floorRoot, "edit/proxies/floor-whole.mp4", join(floorRoot, "floor-whole.mp4"), url)).rejects.toBeInstanceOf(NoRoom);
    expect(reads.length).toBe(before);
    // Room again: kept, and the page told so.
    storage.diskHooks.free = () => Number.POSITIVE_INFINITY;
    expect(keeping(floorRoot)).toBe(true);
    const again = reads.length;
    await serve(floorRoot, key, `bytes=0-99`, url).then(bytes);
    // Read from memory, not R2 again, and kept on disk now there's room (written off the server's thread: soon after).
    expect(reads.length).toBe(again);
    for (let tries = 0; tries < 100 && !fs.existsSync(join(folderFor(floorRoot, key), "0")); tries++) await Bun.sleep(5);
    expect(fs.existsSync(join(folderFor(floorRoot, key), "0"))).toBe(true);
  } finally {
    storage.diskHooks.free = realFree;
  }
});

test("a whole copy is told what's left to write as its blocks land, stops where its room says no, and takes its own size, not twice it", async () => {
  const wholeRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-whole-"));
  const told: number[] = [];
  const local = join(wholeRoot, "copy.mp4");
  await fetchWhole(wholeRoot, "edit/proxies/told.mp4", local, url, (left, total) => {
    expect(total).toBe(size);
    told.push(left);
    return true;
  });
  // After its first block: five left, then one fewer each.
  expect(told[0]).toBe(5 * BLOCK);
  expect(told.at(-1)).toBe(0);
  expect(told).toEqual([...told].sort((a, b) => b - a));
  expect(new Uint8Array(fs.readFileSync(local))).toEqual(object);
  expect(blocksHere(wholeRoot, "edit/proxies/told.mp4")).toBeNull();
  // Its room says no once its size is known: nothing past its first block read.
  const before = reads.length;
  await expect(fetchWhole(wholeRoot, "edit/proxies/refused.mp4", join(wholeRoot, "refused.mp4"), url, () => false)).rejects.toBeInstanceOf(NoRoom);
  expect(reads.length - before).toBe(1);
  expect(fs.existsSync(join(wholeRoot, "refused.mp4"))).toBe(false);
});

test("on a line too slow (or not measured), a shown play gives whole copies' fills no slot but the next minute's files'; they carry on once it stops; a read someone waits on still goes", async () => {
  const playRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-play-"));
  const at = (name: string) => async () => `http://127.0.0.1:${r2.port}/${name}`;
  try {
    playing.note("p", true);
    const before = reads.length;
    let done = false;
    const copy = fetchWhole(playRoot, "edit/proxies/paused.mp4", join(playRoot, "paused.mp4"), at("paused")).then(() => (done = true));
    await Bun.sleep(30);
    expect(reads.length).toBe(before);
    // The page's own read isn't held.
    expect((await serve(playRoot, "edit/proxies/watched.mp4", "bytes=0-99", at("watched")))!.status).toBe(206);
    expect(done).toBe(false);
    // A file the play needs next comes down whole during it.
    setSoon(new Set(["edit/proxies/next.mp4"]));
    await fetchWhole(playRoot, "edit/proxies/next.mp4", join(playRoot, "next.mp4"), at("next"));
    expect(new Uint8Array(fs.readFileSync(join(playRoot, "next.mp4")))).toEqual(object);
    expect(done).toBe(false);
    playing.note("p", false);
    await copy;
    expect(new Uint8Array(fs.readFileSync(join(playRoot, "paused.mp4")))).toEqual(object);
  } finally {
    setSoon(new Set());
    playing.reset();
  }
});

test("how many whole copies' fills read at once: four at rest and while a play holds on its spinner, two beside a shown play on a fast line, one on an 8 Mbit/s one, none under it (Nov 20: none at all while anything played or held)", async () => {
  // An R2 that holds every read until let go, counting how many are open at once.
  let open = 0;
  let most = 0;
  const gates: (() => void)[] = [];
  const held = Bun.serve({
    port: 0,
    async fetch(request) {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "") ?? [];
      open++;
      most = Math.max(most, open);
      await new Promise<void>((resolve) => gates.push(resolve));
      open--;
      const [from, to] = [Number(a), Math.min(Number(b), size - 1)];
      return new Response(object.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${size}` } });
    },
  });
  const realSpeed = laneHooks.downloadBytesPerSecond;
  const at = (name: string) => async () => `http://127.0.0.1:${held.port}/${name}`;
  /** The most fill reads open at once over six copies, with `setup` said of the play and the line. */
  const fillsAtOnce = async (name: string, setup: () => void): Promise<number> => {
    const fillRoot = fs.mkdtempSync(join(os.tmpdir(), `edit-blocks-${name}-`));
    open = 0;
    most = 0;
    setup();
    const copies = Array.from({ length: 6 }, (_, n) => fetchWhole(fillRoot, `edit/proxies/${name}${n}.mp4`, join(fillRoot, `${name}${n}.mp4`), at(`${name}${n}`)));
    await Bun.sleep(60);
    const seen = most;
    laneHooks.downloadBytesPerSecond = realSpeed;
    // The play's stop is heard (its reads let go), as a page's pause is.
    playing.note("p", false);
    const drain = setInterval(() => gates.splice(0).forEach((go) => go()), 2);
    await Promise.all(copies);
    clearInterval(drain);
    return seen;
  };
  try {
    expect(await fillsAtOnce("rest", () => {})).toBe(4);
    expect(await fillsAtOnce("held", () => {
      laneHooks.downloadBytesPerSecond = () => 1_000_000 / 8;
      playing.note("p", true, true);
    })).toBe(4);
    expect(await fillsAtOnce("fast", () => {
      laneHooks.downloadBytesPerSecond = () => 50_000_000 / 8;
      playing.note("p", true);
    })).toBe(2);
    expect(await fillsAtOnce("eight", () => {
      laneHooks.downloadBytesPerSecond = () => 8_000_000 / 8;
      playing.note("p", true);
    })).toBe(1);
    expect(await fillsAtOnce("slow", () => {
      laneHooks.downloadBytesPerSecond = () => 4_000_000 / 8;
      playing.note("p", true);
    })).toBe(0);
  } finally {
    laneHooks.downloadBytesPerSecond = realSpeed;
    playing.reset();
    void held.stop(true);
  }
});

test("a key slow to sign holds no read slot: an asked block of a key already signed is served at once beside six that wait on the relay; one someone waits on gives up signing after its bound, in passing", async () => {
  const signRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-sign-"));
  const hang: (() => void)[] = [];
  let signedAll = false;
  // Six keys whose signing takes 30 s (the relay renewing a sign-in): read ahead of a jump, each wanting a slot.
  const slowSign = (name: string) => () => {
    const signedUrl = `http://127.0.0.1:${r2.port}/${name}`;
    return signedAll ? Promise.resolve(signedUrl) : new Promise<string>((resolve) => hang.push(() => resolve(signedUrl)));
  };
  const warming = Array.from({ length: 6 }, (_, n) => warm(signRoot, `edit/proxies/unsigned${n}.mp4`, 0, 0.1, 1, slowSign(`unsigned${n}`)).catch(() => 0));
  await Bun.sleep(20);
  const began = performance.now();
  const read = await serve(signRoot, "edit/proxies/signed.mp4", "bytes=0-99", url);
  expect(await bytes(read)).toEqual(object.subarray(0, 100));
  expect(performance.now() - began).toBeLessThan(1_000);
  // Someone waiting on a read of a key the relay won't sign: refused after the bound, with no status (a passing failure).
  const bound = signHooks.askedMs;
  signHooks.askedMs = 100;
  try {
    const failing = serve(signRoot, "edit/proxies/never.mp4", "bytes=0-99", () => new Promise<string>(() => {}));
    const error = await failing.then(() => null, (thrown: unknown) => thrown);
    expect(String(error)).toContain("to sign a read");
    expect((error as { status?: number }).status).toBeUndefined();
  } finally {
    signHooks.askedMs = bound;
    signedAll = true;
    hang.splice(0).forEach((go) => go());
    await Promise.all(warming);
  }
});

test("joining a whole copy and reading a file to its end give the server's thread a turn between blocks (Nov 20: a 1.26 GB join held a 50 ms timer for 1.86 s)", async () => {
  const joinRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-join-"));
  const key = "edit/proxies/long.mp4";
  const blocks = 32;
  const total = blocks * BLOCK;
  const folder = folderFor(joinRoot, key);
  fs.mkdirSync(folder, { recursive: true });
  // Every block on disk already: nothing read from R2, so all of it is the disk's.
  fs.writeFileSync(join(folder, "meta.json"), JSON.stringify({ size: total, type: "video/mp4", key }));
  const one = new Uint8Array(BLOCK);
  for (let n = 0; n < blocks; n++) fs.writeFileSync(join(folder, `${n}`), one.fill(n));
  /** Turns the event loop took (a timer chain at 0 ms) and the longest gap of a 20 ms timer while `work` ran. */
  const watched = async (work: () => Promise<unknown>) => {
    let turns = 0;
    let going = true;
    const turn = () => {
      turns++;
      if (going) setTimeout(turn, 0);
    };
    setTimeout(turn, 0);
    let last = performance.now();
    let gap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      gap = Math.max(gap, now - last);
      last = now;
    }, 20);
    // The work starts on a turn of its own, as a request's would.
    await Bun.sleep(25);
    turns = 0;
    last = performance.now();
    await work();
    gap = Math.max(gap, performance.now() - last);
    going = false;
    clearInterval(timer);
    return { turns, gap };
  };
  const local = join(joinRoot, "long-whole.mp4");
  const joined = await watched(() => fetchWhole(joinRoot, key, local, url));
  expect(fs.statSync(local).size).toBe(total);
  // At least a turn every other block (it was none: the whole join one stretch).
  expect(joined.turns).toBeGreaterThanOrEqual(blocks / 2);
  expect(joined.gap).toBeLessThan(100);
  // A read to the end of a file kept in blocks (the window's FFmpeg): the same.
  const other = "edit/proxies/streamed.mp4";
  const otherFolder = folderFor(joinRoot, other);
  fs.mkdirSync(otherFolder, { recursive: true });
  fs.writeFileSync(join(otherFolder, "meta.json"), JSON.stringify({ size: total, type: "video/mp4", key: other }));
  for (let n = 0; n < blocks; n++) fs.writeFileSync(join(otherFolder, `${n}`), one.fill(n));
  const streamed = await watched(async () => {
    const response = await serve(joinRoot, other, "bytes=0-", url);
    const reader = response!.body!.getReader();
    let got = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      got += next.value.length;
    }
    expect(got).toBe(total);
  });
  expect(streamed.turns).toBeGreaterThanOrEqual(blocks / 2);
  expect(streamed.gap).toBeLessThan(100);
});

/** An R2 holding `bytes`, every block read counted by its start. */
function holding(bytes: Uint8Array) {
  const asked: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "") ?? [];
      const [from, to] = [Number(a), Math.min(Number(b), bytes.length - 1)];
      asked.push(from);
      return new Response(bytes.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${bytes.length}` } });
    },
  });
  return { asked, url: async () => `http://127.0.0.1:${server.port}/object`, stop: () => void server.stop(true) };
}

const haveFfmpeg = vbr.ffmpeg !== null && vbr.ffprobe !== null;

test.skipIf(!haveFfmpeg)("a stretch of a proxy is warmed from its index: exactly the blocks its samples lie in, picture and sound, from the keyframe before it, not an even share of the bytes", async () => {
  const file = vbr.makeVbr();
  const r2file = holding(file.bytes);
  try {
    const warmRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-index-"));
    const key = "edit/proxies/vbr.mp4";
    const blocksOf = (from: number, to: number) => {
      const out = new Set<number>([0]);
      for (const [stream, packets] of [0, 1].map((n) => [n, file.packets.filter((one) => one.stream === n)] as const)) {
        let first = packets.findIndex((one, n) => one.pts < to && (packets[n + 1]?.pts ?? Number.POSITIVE_INFINITY) > from);
        const last = packets.findLastIndex((one) => one.pts < to && one.pts + 0.02 > from);
        if (stream === 0) while (first > 0 && !packets[first]!.key) first--;
        else first = Math.max(0, first - 1);
        for (const one of packets.slice(first, last + 1)) for (let n = Math.floor(one.pos / BLOCK); n <= Math.floor((one.pos + one.size - 1) / BLOCK); n++) out.add(n);
      }
      return out;
    };
    // The still's first two seconds: all in the first block (an even share would have read four).
    expect(blocksOf(0, 2)).toEqual(new Set([0]));
    await warm(warmRoot, key, 0, 2, 6, r2file.url);
    expect(r2file.asked).toEqual([0]);
    // Into the noise: its blocks, no more.
    const want = blocksOf(4.05, 4.6);
    const read = await warm(warmRoot, key, 4.05, 4.6, 6, r2file.url);
    expect(read).toBe(want.size - 1);
    expect(blocksHere(warmRoot, key)!.here).toEqual(want);
  } finally {
    r2file.stop();
    file.cleanup();
  }
});

test("where nothing can be kept, blocks read are held in memory a while, at most HELD_BYTES, the least lately used let go first; a block read twice in a moment is read once", async () => {
  const many = HELD_BYTES / BLOCK + 8;
  const big = new Uint8Array(many * BLOCK).map((_, i) => (i * 13) % 251);
  const r2big = holding(big);
  const realFree = storage.diskHooks.free;
  try {
    const heldRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-held-"));
    storage.diskHooks.free = () => storage.WORK_FLOOR_BYTES;
    const key = "edit/proxies/held.mp4";
    // The window's read-ahead then its decoder: the same block twice, R2 once.
    expect(await bytes(await serve(heldRoot, key, `bytes=0-99`, r2big.url))).toEqual(big.subarray(0, 100));
    await Bun.sleep(30);
    const first = r2big.asked.filter((at) => at === 0).length;
    expect(await bytes(await serve(heldRoot, key, `bytes=10-99`, r2big.url))).toEqual(big.subarray(10, 100));
    expect(r2big.asked.filter((at) => at === 0).length).toBe(first);
    // Every block, in turn: never more than HELD_BYTES held.
    for (let n = 0; n < many; n++) {
      const at = n * BLOCK + 5;
      expect(await bytes(await serve(heldRoot, key, `bytes=${at}-${at + 9}`, r2big.url))).toEqual(big.subarray(at, at + 10));
      expect(heldInMemory().bytes).toBeLessThanOrEqual(HELD_BYTES);
    }
    await Bun.sleep(30);
    expect(heldInMemory().bytes).toBeLessThanOrEqual(HELD_BYTES);
    expect(heldInMemory().blocks).toBe(HELD_BYTES / BLOCK);
    // The first block was let go long since: read again.
    const before = r2big.asked.length;
    await serve(heldRoot, key, `bytes=0-9`, r2big.url).then(bytes);
    expect(r2big.asked.slice(before)).toContain(0);
    expect(fs.readdirSync(folderFor(heldRoot, key))).toEqual(["meta.json"]);
  } finally {
    storage.diskHooks.free = realFree;
    r2big.stop();
  }
});

test("a read to the end reads ahead only the blocks not here: those on disk aren't read and thrown away (each FFmpeg pull read 10 MiB off the disk for nothing)", async () => {
  const aheadRoot = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-skip-"));
  const key = "edit/proxies/skip.mp4";
  // Every block here.
  const all = await serve(aheadRoot, key, `bytes=0-${size - 1}`, url);
  await bytes(all);
  const folder = folderFor(aheadRoot, key);
  const long = new Date(Date.now() - 3_600_000);
  for (let n = 0; n <= 5; n++) fs.utimesSync(join(folder, `${n}`), long, long);
  const before = reads.length;
  // FFmpeg opening at the start and reading its first block: the four after it already here are left alone.
  const open = await serve(aheadRoot, key, "bytes=0-", url);
  const reader = open!.body!.getReader();
  await reader.read();
  await reader.cancel();
  await Bun.sleep(30);
  expect(reads.length).toBe(before);
  // Block 0 was read (touched); the ones ahead weren't.
  expect(fs.statSync(join(folder, "0")).mtimeMs).toBeGreaterThan(long.getTime() + 1000);
  for (let n = 2; n <= 4; n++) expect(fs.statSync(join(folder, `${n}`)).mtimeMs).toBe(long.getTime());
});
