// Script mode's words reach the cloud before its footage, and a footage upload
// cut off (a dropped line, a restart) carries on from the parts already up
// (Sphe, Nov 18: JJ's 2.6 GB preview at 0.47 GB, 44 minutes or more on his
// 8 Mbit/s line, and every other script's save waiting behind it).

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as editCloud from "../../src/cloud.ts";
import * as cloud from "../../src/writer/cloud.ts";
import * as store from "../../src/writer/store.ts";

const ID = "5b001eed-86e7-471f-b0c0-3fcc4009a772";
const OTHER = "6c001eed-86e7-471f-b0c0-3fcc4009a773";
/** A part (cloud.ts never makes one under a MiB). */
const PART = 1024 * 1024;

// A relay and R2 in one: Convex's writer functions over the rows here, presigned
// addresses that are this server's /r2/, and R2's multipart uploads.
const rows = new Map<string, Record<string, unknown>>();
const objects = new Map<string, Uint8Array>();
const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
/** Parts R2 took, by key. */
const partsTaken: { key: string; part: number }[] = [];
/** While set, each part PUT waits for it (a slow line). */
let gate: Promise<void> | null = null;
/** Parts R2 answers 503 to from this number on (the line drops); null: every part goes. */
let dropFrom: number | null = null;
let nextUpload = 1;
let server: ReturnType<typeof Bun.serve>;
let env: Record<string, string | undefined>;
const saved = { sleep: editCloud.timing.sleep, filePart: editCloud.timing.filePart, resumableFrom: editCloud.timing.resumableFrom };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/r2/")) {
        const key = decodeURIComponent(url.pathname.slice(4));
        if (request.method === "PUT") {
          const bytes = new Uint8Array(await request.arrayBuffer());
          const uploadId = url.searchParams.get("uploadId");
          if (uploadId === null) {
            objects.set(key, bytes);
            return new Response("");
          }
          const part = Number(url.searchParams.get("partNumber"));
          if (gate !== null) await gate;
          if (dropFrom !== null && part >= dropFrom) return new Response("", { status: 503 });
          const upload = uploads.get(uploadId);
          if (upload === undefined) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
          upload.parts.set(part, bytes);
          partsTaken.push({ key, part });
          return new Response("", { headers: { etag: `"${key}-${part}-${bytes.length}"` } });
        }
        const bytes = objects.get(key);
        return bytes === undefined ? new Response("", { status: 404 }) : new Response(bytes);
      }
      const body = (await request.json()) as Record<string, any>;
      if (url.pathname === "/v1/cloud/writer/r2/url") return Response.json({ url: `${url.origin}/r2/${encodeURIComponent(body.key)}` });
      if (url.pathname === "/v1/cloud/writer/r2/delete") {
        for (const key of body.keys) objects.delete(key);
        return Response.json({});
      }
      if (url.pathname === "/v1/cloud/writer/r2/multipart/create") {
        const uploadId = `upload-${nextUpload++}`;
        uploads.set(uploadId, { key: body.key, parts: new Map() });
        return Response.json({ uploadId });
      }
      if (url.pathname === "/v1/cloud/writer/r2/multipart/urls") {
        return Response.json({ urls: Object.fromEntries((body.parts as number[]).map((n) => [String(n), `${url.origin}/r2/${encodeURIComponent(body.key)}?partNumber=${n}&uploadId=${body.uploadId}`])) });
      }
      if (url.pathname === "/v1/cloud/writer/r2/multipart/complete") {
        const upload = uploads.get(body.uploadId);
        if (upload === undefined) return Response.json({ error: "R2: NoSuchUpload" }, { status: 502 });
        const chunks = (body.parts as { partNumber: number }[]).map((part) => upload.parts.get(part.partNumber)!);
        objects.set(upload.key, new Uint8Array(Buffer.concat(chunks)));
        uploads.delete(body.uploadId);
        return Response.json({ ok: true, size: chunks.reduce((sum, chunk) => sum + chunk.length, 0) });
      }
      if (url.pathname === "/v1/cloud/writer/r2/multipart/abort") {
        uploads.delete(body.uploadId);
        return Response.json({ ok: true });
      }
      if (body.path === "writer:listScripts") return Response.json({ status: "success", value: [...rows.values()] });
      if (body.path === "writer:getScript") return Response.json({ status: "success", value: rows.get(body.args.scriptId) ?? null });
      if (body.path === "writer:commitScript") {
        const args = body.args;
        const row = rows.get(args.scriptId);
        const rev = Number(row?.rev ?? 0);
        if (args.baseRev !== rev) return Response.json({ status: "error", errorData: { code: "conflict" } });
        const kept = new Set([args.bodyKey, ...(args.files as { key: string }[]).map((file) => file.key)]);
        const stale = [row?.bodyKey, ...((row?.files as { key: string }[] | undefined) ?? []).map((file) => file.key)].filter((key): key is string => typeof key === "string" && !kept.has(key));
        rows.set(args.scriptId, { ...args, scriptId: args.scriptId, rev: rev + 1 });
        return Response.json({ status: "success", value: { rev: rev + 1, stale } });
      }
      return Response.json({ status: "error", errorData: { message: `no ${body.path}` } });
    },
  });
  env = { url: process.env.EDIT_RELAY_URL, token: process.env.EDIT_RELAY_TOKEN };
  process.env.EDIT_RELAY_URL = `http://127.0.0.1:${server.port}`;
  process.env.EDIT_RELAY_TOKEN = "test";
  cloud.settleForTests(0);
  Object.assign(editCloud.timing, { sleep: async () => {}, filePart: PART, resumableFrom: 2 * PART });
});

afterAll(async () => {
  await server.stop(true);
  cloud.settleForTests(null);
  Object.assign(editCloud.timing, saved);
  editCloud.keepUploadJournalsIn(null);
  for (const [name, value] of [["EDIT_RELAY_URL", env.url], ["EDIT_RELAY_TOKEN", env.token]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  rows.clear();
  objects.clear();
  uploads.clear();
  partsTaken.length = 0;
  gate = null;
  dropFrom = null;
  cloud.resetFootageForTests();
});

const script = (change: Partial<Script>): Script =>
  ({ id: ID, title: "Cuffed at the Gas Station", sourceKind: "drive", sourceUrl: "", originalPath: "", status: "ready", stage: "ready", progress: 100, error: null, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [], ...change }) as Script;

/** A Mac's data folder with its upload journals, as serve.ts keeps them. */
function mac(): string {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-footage-first-"));
  editCloud.keepUploadJournalsIn(join(data, "uploads"));
  return data;
}

/** A script on this Mac with a preview of `parts` parts. */
function made(data: string, id: string, title: string, parts: number): Uint8Array {
  const dir = store.scriptDir(data, id);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, script({ id, title }));
  const preview = new Uint8Array(parts * PART - 100).map((_, at) => (at * 31 + parts) % 251);
  fs.writeFileSync(join(dir, "proxy.mp4"), preview);
  return preview;
}

/** A save on this Mac: its title changed. */
function retitle(data: string, id: string, title: string): void {
  const dir = store.scriptDir(data, id);
  store.write(dir, { ...store.read(dir), title, revision: store.read(dir).revision + 1 });
}

const named = (id: string, name: string): string | undefined => ((rows.get(id)?.files as { name: string; key: string }[] | undefined) ?? []).find((file) => file.name === name)?.key;
const bodyOf = async (id: string): Promise<Script> => JSON.parse(new TextDecoder().decode(objects.get(String(rows.get(id)!.bodyKey))!)) as Script;

test("a script's words reach the cloud, and another Mac, while its preview is still going up; the preview is named once it's there", { timeout: 20_000 }, async () => {
  const a = mac();
  const preview = made(a, ID, "Cuffed at the Gas Station", 12);
  made(a, OTHER, "Bodycam at the Diner", 3);
  let open!: () => void;
  gate = new Promise<void>((resolve) => (open = resolve));

  // The first round commits both scripts' words with no preview: neither waits on a part.
  await cloud.syncOnceForTests(a);
  expect(rows.get(ID)?.rev).toBe(1);
  expect(rows.get(OTHER)?.rev).toBe(1);
  expect(named(ID, "proxy.mp4")).toBeUndefined();
  expect((await bodyOf(ID)).title).toBe("Cuffed at the Gas Station");
  expect(cloud.statusNow().pending).toBeGreaterThan(0);

  // Saved again while the preview is held up on the line: the save goes up at once.
  retitle(a, ID, "Cuffed at the Gas Station (v2)");
  await cloud.syncOnceForTests(a);
  expect(rows.get(ID)?.rev).toBe(2);
  expect((await bodyOf(ID)).title).toBe("Cuffed at the Gas Station (v2)");
  expect(named(ID, "proxy.mp4")).toBeUndefined();

  // Another Mac has the words now, and knows the preview isn't in the cloud yet.
  const b = mac();
  await cloud.syncOnceForTests(b);
  expect(store.read(store.scriptDir(b, ID)).title).toBe("Cuffed at the Gas Station (v2)");
  expect(cloud.fileKey(b, ID, "proxy.mp4")).toBeNull();

  // The line frees: the previews go up, and the next round names them.
  open();
  gate = null;
  await cloud.footageForTests(a);
  await cloud.syncOnceForTests(a);
  await cloud.footageForTests(a);
  await cloud.syncOnceForTests(a);
  const key = named(ID, "proxy.mp4");
  expect(key).toBeDefined();
  expect(Buffer.from(objects.get(key!)!).equals(Buffer.from(preview))).toBe(true);
  expect(named(OTHER, "proxy.mp4")).toBeDefined();
  expect((await bodyOf(ID)).title).toBe("Cuffed at the Gas Station (v2)");
  expect(cloud.sameAsHere(a, ID, "proxy.mp4")).toBe(true);
  expect(fs.existsSync(join(a, "cloud", "footage.json")) ? Object.keys(JSON.parse(fs.readFileSync(join(a, "cloud", "footage.json"), "utf8"))) : []).toEqual([]);

  // Nothing changed: no more revisions.
  const rev = rows.get(ID)?.rev;
  await cloud.syncOnceForTests(a);
  expect(rows.get(ID)?.rev).toBe(rev);

  // The other Mac plays it from the cloud now.
  await cloud.syncOnceForTests(b);
  expect(cloud.fileKey(b, ID, "proxy.mp4")?.key).toBe(key!);
});

test("a preview cut off mid-upload carries on after a restart from the parts already up", { timeout: 20_000 }, async () => {
  const a = mac();
  const preview = made(a, ID, "Cuffed at the Gas Station", 10);
  dropFrom = 5;
  await cloud.syncOnceForTests(a);
  await cloud.footageForTests(a);
  // Parts 1–4 are up; the line dropped at part 5.
  expect(partsTaken.map((one) => one.part).sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  expect(named(ID, "proxy.mp4")).toBeUndefined();
  const slot = JSON.parse(fs.readFileSync(join(a, "cloud", "footage.json"), "utf8"))[`${ID}/proxy.mp4`] as { key: string; done: boolean };
  expect(slot.done).toBe(false);

  // Edit restarts: what it held in memory is gone, the journals and footage.json stay.
  cloud.resetFootageForTests();
  editCloud.keepUploadJournalsIn(join(a, "uploads"));
  dropFrom = null;
  partsTaken.length = 0;
  await cloud.syncOnceForTests(a);
  await cloud.footageForTests(a);
  expect(partsTaken.map((one) => one.part).sort((x, y) => x - y)).toEqual([5, 6, 7, 8, 9, 10]);
  expect(partsTaken.every((one) => one.key === slot.key)).toBe(true);
  await cloud.syncOnceForTests(a);
  expect(named(ID, "proxy.mp4")).toBe(slot.key);
  expect(Buffer.from(objects.get(slot.key)!).equals(Buffer.from(preview))).toBe(true);
});

test("an upload R2 no longer has begins again cleanly, and one whose file changed is let go for the file as it is", { timeout: 20_000 }, async () => {
  const a = mac();
  made(a, ID, "Cuffed at the Gas Station", 8);
  dropFrom = 3;
  await cloud.syncOnceForTests(a);
  await cloud.footageForTests(a);
  expect(partsTaken.length).toBe(2);

  // A week on: R2 let the upload go. The next try begins it again and finishes.
  uploads.clear();
  cloud.resetFootageForTests();
  dropFrom = null;
  partsTaken.length = 0;
  await cloud.syncOnceForTests(a);
  await cloud.footageForTests(a);
  expect(partsTaken.map((one) => one.part).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  await cloud.syncOnceForTests(a);
  const first = named(ID, "proxy.mp4")!;
  expect(first).toBeDefined();

  // Footage added: the preview changes. Halfway up, it changes again; the first try's parts are let go.
  const dir = store.scriptDir(a, ID);
  fs.writeFileSync(join(dir, "proxy.mp4"), new Uint8Array(9 * PART).fill(7));
  fs.utimesSync(join(dir, "proxy.mp4"), new Date(), new Date(Date.now() + 5_000));
  retitle(a, ID, "Cuffed at the Gas Station (more footage)");
  dropFrom = 3;
  await cloud.syncOnceForTests(a);
  // The words went with the earlier preview still named, until the new one is up.
  expect((await bodyOf(ID)).title).toBe("Cuffed at the Gas Station (more footage)");
  expect(named(ID, "proxy.mp4")).toBe(first);
  expect(cloud.sameAsHere(a, ID, "proxy.mp4")).toBe(false);
  await cloud.footageForTests(a);
  const halfway = Object.values(JSON.parse(fs.readFileSync(join(a, "cloud", "footage.json"), "utf8")) as Record<string, { key: string }>)[0]!.key;
  expect(uploads.size).toBe(1);

  const last = new Uint8Array(9 * PART + 17).fill(9);
  fs.writeFileSync(join(dir, "proxy.mp4"), last);
  fs.utimesSync(join(dir, "proxy.mp4"), new Date(), new Date(Date.now() + 10_000));
  dropFrom = null;
  cloud.resetFootageForTests();
  await cloud.syncOnceForTests(a);
  // The halfway upload is aborted (its abort goes in the background), and a new one goes to its own key.
  const aborted = () => ![...uploads.values()].some((upload) => upload.key === halfway);
  for (let tries = 0; tries < 200 && !aborted(); tries++) await Bun.sleep(5);
  expect(aborted()).toBe(true);
  await cloud.footageForTests(a);
  await cloud.syncOnceForTests(a);
  const now = named(ID, "proxy.mp4")!;
  expect(now).not.toBe(first);
  expect(now).not.toBe(halfway);
  expect(Buffer.from(objects.get(now)!).equals(Buffer.from(last))).toBe(true);
  // The revision before's preview is the cloud's to delete (its commit's stale list), and was.
  expect(objects.has(first)).toBe(false);
});
