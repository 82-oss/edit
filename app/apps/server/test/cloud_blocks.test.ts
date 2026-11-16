import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { BLOCK, blocksHere, fetchWhole, fillHooks, hedgeHooks, noteViewerMiss, retryHooks, serve, viewerBusy, viewerHooks, waitForViewerRest, warm } from "../src/cloud_blocks.ts";

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
  expect(await warm(root, key, 0.4, 0.6, url)).toBeGreaterThan(0);
  const here = blocksHere(root, key)!;
  expect(here.size).toBe(size);
  expect([...here.here].sort()).toEqual([0, 1, 2, 3, 4]);
  // Warmed again: nothing read.
  expect(await warm(root, key, 0.4, 0.6, url)).toBe(0);
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
  const drop = fillHooks.dropAfterMs;
  fillHooks.dropAfterMs = 0;
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
    const warming = Promise.all(["a", "b", "c"].map((name) => warm(slowRoot, `edit/proxies/ahead-${name}.mp4`, 0, 0.1, at(`ahead-${name}`))));
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
    // Its blocks let go once it's made.
    await Bun.sleep(20);
    expect(blocksHere(slowRoot, "edit/proxies/big0.mp4")).toBeNull();
  } finally {
    fillHooks.dropAfterMs = drop;
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
    await warm(hedgeRoot, "edit/proxies/ahead.mp4", 0, 0.01, source("ahead"));
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
  // The edge slow to answer a block it hasn't seen; R2's own at once.
  const edge = Bun.serve({ port: 0, async fetch(request) { await Bun.sleep(300); return answer(request); } });
  const r2own = Bun.serve({ port: 0, fetch: answer });
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
    // Its block kept for the next read.
    expect(blocksHere(coldRoot, "edit/proxies/cold.mp4")!.here.has(0)).toBe(true);
  } finally {
    void edge.stop(true);
    void r2own.stop(true);
  }
});
