// An upload through a proxy (the MacBook Air on a line proxy, Nov 22; some VPNs do the same). Bun's fetch takes a
// part's whole body into the proxy's tunnel at once, so the bytes it has taken read 100% within seconds, then nothing
// moves until R2 answers: the stall check ended every part as "Operation too slow" a minute in (a 53 MB share at
// 2 Mbit/s failed after 8 minutes), and the percent ran ahead of what had got there. Held here with Bun's real fetch
// through a real CONNECT proxy to a TLS stand-in for R2 that takes the bytes slowly, as a 2 Mbit/s line does: the
// upload gets there whole, is never given up on while it moves, and its percent never says more than R2 has.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as net from "node:net";
import { join } from "node:path";

import * as cloud from "../src/cloud.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const KIB = 1024;
const MIB = 1024 * KIB;

let mock: MockServer;
let restore: () => void;
let home: { dir: string; cleanup(): void };
let front: ReturnType<typeof Bun.serve>;
let proxy: net.Server;
let proxyUrl = "";
const realFetch = globalThis.fetch;
const realTiming = { ...cloud.timing };

/** What R2's stand-in has taken of the bodies so far, and how fast it reads them (bytes a second). */
let taken = 0;
let rate = 256 * KIB;
/** Whether the test's PUTs go through the proxy. */
let viaProxy = true;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  home = scratch("upload-proxy");
  const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(home.dir, "key.pem"), "-out", join(home.dir, "cert.pem"), "-days", "2", "-subj", "/CN=127.0.0.1"]);
  expect(made.exitCode).toBe(0);
  // R2 over TLS: reads each body at `rate`, then hands it to the mock's R2 and answers with its answer.
  front = Bun.serve({
    port: 0,
    tls: { cert: Bun.file(join(home.dir, "cert.pem")), key: Bun.file(join(home.dir, "key.pem")) },
    async fetch(request) {
      const chunks: Uint8Array[] = [];
      const reader = request.body!.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        for (let at = 0; at < next.value.length; at += 16 * KIB) {
          const piece = next.value.subarray(at, at + 16 * KIB);
          await Bun.sleep((piece.length / rate) * 1000);
          chunks.push(piece);
          taken += piece.length;
        }
      }
      const url = new URL(request.url);
      const answer = await realFetch(`${mock.url}${url.pathname}${url.search}`, { method: "PUT", headers: { "content-length": String(Buffer.concat(chunks).length) }, body: Buffer.concat(chunks) });
      return new Response(await answer.text(), { status: answer.status, headers: answer.headers });
    },
  });
  // A CONNECT proxy: a plain tunnel, as a line proxy or a VPN's is.
  proxy = net.createServer((client) => {
    client.once("data", (head) => {
      const asked = /^CONNECT ([^:\s]+):(\d+)/.exec(head.toString());
      if (asked === null) return client.destroy();
      const target = net.connect(Number(asked[2]), asked[1], () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(target);
        target.pipe(client);
      });
      const end = () => (client.destroy(), target.destroy());
      client.on("error", end);
      target.on("error", end);
      client.on("close", end);
      target.on("close", end);
    });
  });
  proxy.listen(0, "127.0.0.1");
  proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method !== "PUT" || !url.includes("/r2/edit/")) return realFetch(input, init);
    const at = new URL(url);
    return realFetch(`https://127.0.0.1:${front.port}${at.pathname}${at.search}`, { ...init, tls: { rejectUnauthorized: false }, ...(viaProxy ? { proxy: proxyUrl } : {}) } as RequestInit);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  void front.stop(true);
  proxy.close();
  restore();
  mock.stop();
  home.cleanup();
});

beforeEach(() => {
  cloud.resetPace();
  cloud.keepUploadJournalsIn(null);
  // A second of nothing moving is a stall here (a minute in Edit); 1 MiB parts that take 4 s each to get there.
  Object.assign(cloud.timing, { sleep: async () => {}, stallMs: 1_000, filePart: MIB, resumableFrom: 512 * MIB, putChunk: 64 * KIB });
  taken = 0;
  rate = 256 * KIB;
  viaProxy = true;
});

afterEach(() => {
  Object.assign(cloud.timing, realTiming);
  cloud.resetPace();
});

function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let n = 0; n < length; n++) out[n] = (n * 31) % 251;
  return out;
}

test("through a proxy, a slow upload that moves gets there whole, and its percent never says more than R2 has taken", async () => {
  cloud.timing.proxied = () => true;
  const data = pattern(3 * MIB);
  const file = join(home.dir, "share.mp4");
  fs.writeFileSync(file, data);
  const said: { sent: number; taken: number }[] = [];
  await cloud.uploadFile(file, "edit/test/through-proxy.mp4", (sent) => said.push({ sent, taken }));
  expect(Buffer.from(mock.cloud.objects.get("edit/test/through-proxy.mp4")!).equals(Buffer.from(data))).toBe(true);
  expect(said.length).toBeGreaterThan(0);
  for (const one of said) expect(one.sent).toBeLessThanOrEqual(one.taken);
  expect(said.at(-1)!.sent).toBe(data.length);
}, 60_000);

test("directly, a slow line's last stretch (the bytes the connection holds, nothing more to hand over) isn't a stall", async () => {
  viaProxy = false;
  cloud.timing.proxied = () => false;
  const data = pattern(2 * MIB);
  const file = join(home.dir, "direct.mp4");
  fs.writeFileSync(file, data);
  const said: { sent: number; taken: number }[] = [];
  await cloud.uploadFile(file, "edit/test/direct.mp4", (sent) => said.push({ sent, taken }));
  expect(Buffer.from(mock.cloud.objects.get("edit/test/direct.mp4")!).equals(Buffer.from(data))).toBe(true);
  for (const one of said) expect(one.sent).toBeLessThanOrEqual(one.taken);
}, 60_000);

test("a handed-over body that never gets there is still given up on, once it would have gone under 1 KB/s all along", async () => {
  cloud.timing.stallMs = 300;
  const stall = new cloud.Stall();
  const started = performance.now();
  stall.handedOver(2 * KIB);
  await new Promise<void>((resolve) => stall.signal.addEventListener("abort", () => resolve(), { once: true }));
  const waited = performance.now() - started;
  stall.stop();
  // 300 ms for the answer and 2 s for 2 KiB at 1 KB/s.
  expect(waited).toBeGreaterThan(2_200);
  expect(waited).toBeLessThan(4_000);
  expect(stall.reason).toContain("Operation too slow");
});

test("which requests go through a proxy is what Bun's fetch decides from the environment", () => {
  const r2 = "https://abc.r2.cloudflarestorage.com/edit/x?sig";
  expect(cloud.throughProxy(r2, {})).toBe(false);
  expect(cloud.throughProxy(r2, { HTTPS_PROXY: "http://127.0.0.1:8080" })).toBe(true);
  expect(cloud.throughProxy(r2, { https_proxy: "http://127.0.0.1:8080" })).toBe(true);
  // Bun takes HTTP_PROXY for http only.
  expect(cloud.throughProxy(r2, { HTTP_PROXY: "http://127.0.0.1:8080" })).toBe(false);
  expect(cloud.throughProxy("http://127.0.0.1:7790/x", { HTTP_PROXY: "http://127.0.0.1:8080" })).toBe(true);
  expect(cloud.throughProxy(r2, { HTTPS_PROXY: "http://p:1", NO_PROXY: "r2.cloudflarestorage.com" })).toBe(false);
  expect(cloud.throughProxy(r2, { HTTPS_PROXY: "http://p:1", NO_PROXY: ".cloudflarestorage.com" })).toBe(false);
  expect(cloud.throughProxy(r2, { HTTPS_PROXY: "http://p:1", no_proxy: "*" })).toBe(false);
  expect(cloud.throughProxy(r2, { HTTPS_PROXY: "http://p:1", NO_PROXY: "example.com,localhost" })).toBe(true);
});
