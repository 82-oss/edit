// found.ts on RunPod: pure-TS finishSurvey parity, parallel scans on RunPod,
// shared R2 found cache, slowed-copy parentState handoff, Stop cancellation, and not-yet-uploaded files.

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { App } from "../src/app.ts";
import * as found from "../src/found.ts";
import type { Media } from "../src/model.ts";
import * as removerCloud from "../src/remover_cloud.ts";

// ---------------------------------------------------------------------------
// 1. Pure-TS finishSurvey parity with find.py finish + assemble.py build

test("finishSurvey keeps labels/roamers on overlay or unclear, unsure/one-offs only on overlay, merges notes, and clamps to frames", () => {
  const bundle: found.SurveyBundle = {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    frames: 300,
    covered: [[0, 10]],
    baseMasks: [
      [10, 40, 500, 900, 1400, 980, "subtitle"],
      [-5, 350, 100, 100, 200, 140, "subtitle"], // clamped to [0, 299]
      [50, 60, 200, 200, 200, 250, "subtitle"], // degenerate x1 <= x0: dropped
    ],
    baseNotes: [[100, 120, 400, 200, 600, 240]],
    roamMasks: [[0, 50, 10, 10, 110, 50, "mark"]],
    ask: [
      // #0 label -> overlay: kept
      { kind: "label", text: "actualcasefootage", n: 80, f: 30, masks: [[0, 299, 50, 40, 350, 80, "label"]] },
      // #1 label -> unclear: still kept (held its place across scene changes)
      { kind: "label", text: "officers", n: 60, f: 40, masks: [[10, 200, 50, 100, 250, 130, "label"]] },
      // #2 label -> camera: dropped
      { kind: "label", text: "axonbody", n: 90, f: 50, masks: [[0, 299, 1500, 20, 1880, 60, "label"]] },
      // #3 roamer -> overlay: roamMasks included once
      { kind: "roamer", text: "bodycam", n: 50, f: 60 },
      // #4 roamer -> unclear: roamMasks still included only once
      { kind: "roamer", text: "bodycam2", n: 40, f: 70 },
      // #5 unsure -> overlay: kept
      { kind: "unsure", text: "warning", n: 35, f: 80, masks: [[20, 80, 700, 50, 900, 90, "label"]] },
      // #6 unsure -> unclear: dropped
      { kind: "unsure", text: "poster", n: 35, f: 90, masks: [[20, 80, 300, 300, 400, 340, "label"]] },
      // #7 one-off -> overlay: merged into baseNotes block (frame 125 <= 120+60, close vertically & horizontally)
      { kind: "one-off", text: "two hours later", n: 5, f: 130, note: [125, 150, 410, 245, 620, 285] },
      // #8 one-off -> scene: dropped
      { kind: "one-off", text: "stop sign", n: 4, f: 200, note: [195, 210, 100, 500, 200, 540] },
    ],
    sheetsB64: [],
  };
  const { found: result, parentVerdicts } = found.finishSurvey(bundle, {
    "0": "overlay",
    "1": "unclear",
    "2": "camera",
    "3": "overlay",
    "4": "unclear",
    "5": "overlay",
    "6": "unclear",
    "7": "overlay",
    "8": "scene",
  });
  expect(result.version).toBe(1);
  expect(result.width).toBe(1920);
  expect(result.height).toBe(1080);
  expect(result.fps).toBe(30);
  expect(result.covered).toEqual([[0, 10]]);
  // Base subtitles (clamped, degenerate dropped)
  expect(result.masks).toContainEqual([10, 40, 500, 900, 1400, 980, "subtitle"]);
  expect(result.masks).toContainEqual([0, 299, 100, 100, 200, 140, "subtitle"]);
  // Approved & unclear labels kept, camera dropped
  expect(result.masks).toContainEqual([0, 299, 50, 40, 350, 80, "label"]);
  expect(result.masks).toContainEqual([10, 200, 50, 100, 250, 130, "label"]);
  expect(result.masks.some((m) => m[2] === 1500)).toBe(false);
  // Roam masks included exactly once
  expect(result.masks.filter((m) => m[6] === "mark")).toEqual([[0, 50, 10, 10, 110, 50, "mark"]]);
  // Unsure: #5 kept, #6 dropped
  expect(result.masks).toContainEqual([20, 80, 700, 50, 900, 90, "label"]);
  expect(result.masks.some((m) => m[2] === 300 && m[3] === 300)).toBe(false);
  // Merged note block: [100..150], box [400, 200, 620, 285] (h=85 -> py=10.2, px=25.5, ex=42)
  // pad([400, 200, 620, 285]) = [374, 189, 645, 295]; ex=42 -> x0=332, x1=687; frames [90, 160]
  const notes = result.masks.filter((m) => m[6] === "note");
  expect(notes).toEqual([[90, 160, 332, 189, 687, 295, "note"]]);
  expect(parentVerdicts.labels).toEqual(["actualcasefootage", "officers", "bodycam", "bodycam2"]);
  expect(parentVerdicts.yes).toEqual([
    ["unsure", "warning", 80],
    ["one-off", "two hours later", 130],
  ]);
});

test("finishSurvey handles slowed-copy bundle with precomputed one-off masks", () => {
  const bundle: found.SurveyBundle = {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    frames: 150,
    covered: [[0, 5]],
    baseMasks: [[0, 149, 20, 20, 200, 60, "label"]],
    baseNotes: [],
    roamMasks: [],
    ask: [
      { kind: "one-off", text: "replay", n: 6, f: 40, masks: [[30, 80, 300, 200, 600, 260, "note"]] },
      { kind: "one-off", text: "exit", n: 4, f: 90, masks: [[80, 110, 100, 400, 200, 440, "note"]] },
    ],
    sheetsB64: [],
  };
  const { found: result } = found.finishSurvey(bundle, { "0": "overlay", "1": "scene" });
  expect(result.masks).toEqual([
    [0, 149, 20, 20, 200, 60, "label"],
    [30, 80, 300, 200, 600, 260, "note"],
  ]);
});

// ---------------------------------------------------------------------------
// 2. End-to-end RunPod flow in found.ts (stand-in relay + R2)

let tmpDir: string;
let relayServer: ReturnType<typeof Bun.serve>;
let r2Store: Map<string, string>;
let jobsPosted: { id: string; kind: string; worker: string; request: Record<string, unknown> }[];
let jobsCancelled: string[];
let activePolls: Map<string, number>;
let holdJobIds: Set<string>;
let holdInputs: Set<string>;
let sharedJobIds: Set<string>;
let releaseHeld: (() => void) | null;
let bundleForInput: (input: string, request: Record<string, unknown>) => found.SurveyBundle;
let judgeCalls: { ask: found.Asked[]; sheetsB64?: string[] }[];
const origJudge = found.judgeHooks.judge;

function makeApp(cacheDir: string): App {
  return { store: { cacheDir: () => cacheDir } } as unknown as App;
}

function makeMedia(id: string, name: string, original?: string): Media {
  return {
    id,
    name,
    path: `/nonexistent/${name}`,
    kind: "video",
    duration: 120,
    fps: 30,
    width: 1920,
    height: 1080,
    ...(original !== undefined ? { cloud: { original } } : {}),
  } as unknown as Media;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-found-runpod-"));
  r2Store = new Map();
  jobsPosted = [];
  jobsCancelled = [];
  activePolls = new Map();
  holdJobIds = new Set();
  holdInputs = new Set();
  sharedJobIds = new Set();
  releaseHeld = null;
  judgeCalls = [];
  bundleForInput = (input) => ({
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    frames: 3600,
    covered: [[0, 60]],
    baseMasks: [[30, 90, 400, 900, 1500, 980, "subtitle"]],
    baseNotes: [],
    roamMasks: [],
    ask: [{ kind: "label", text: `lbl-${path.basename(input)}`, n: 50, f: 60, masks: [[0, 3599, 40, 30, 300, 70, "label"]] }],
    sheetsB64: [Buffer.from("fake-jpeg").toString("base64")],
    parentState: { zone: { W: 1920, H: 1080, fps: 30, zone: [0.7, 0.9] }, marks: [], notes: [], cands: [], roamExt: null },
  });

  relayServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ ok: true, remover: true });
      if (url.pathname === "/v1/cloud/r2/url" && request.method === "POST") {
        const body = (await request.json()) as { key: string; method: string };
        return Response.json({ url: `http://127.0.0.1:${relayServer.port}/r2/${encodeURIComponent(body.key)}` });
      }
      if (url.pathname === "/v1/cloud/r2/head" && request.method === "POST") {
        const body = (await request.json()) as { key: string };
        const val = r2Store.get(body.key);
        return Response.json(val !== undefined ? { exists: true, size: val.length } : { exists: false });
      }
      if (url.pathname === "/v1/cloud/r2/delete" && request.method === "POST") {
        const body = (await request.json()) as { keys: string[] };
        for (const k of body.keys) r2Store.delete(k);
        return Response.json({ ok: true, deleted: body.keys.length });
      }
      if (url.pathname.startsWith("/r2/")) {
        const key = decodeURIComponent(url.pathname.slice(4));
        if (request.method === "PUT") {
          r2Store.set(key, await request.text());
          return new Response(null, { status: 200 });
        }
        if (request.method === "GET") {
          const val = r2Store.get(key);
          return val !== undefined ? new Response(val, { status: 200, headers: { "content-type": "application/json" } }) : new Response("not found", { status: 404 });
        }
      }
      if (url.pathname === "/v1/remover/jobs" && request.method === "POST") {
        const body = (await request.json()) as { kind: string; worker: string; request: Record<string, unknown> };
        const id = `00000000-0000-4000-8000-${String(jobsPosted.length + 1).padStart(12, "0")}`;
        const out = `edit/cleaned/work/${id}.json`;
        jobsPosted.push({ id, kind: body.kind, worker: body.worker, request: body.request });
        const bundle = bundleForInput(String(body.request.input), body.request);
        r2Store.set(out, JSON.stringify(bundle));
        activePolls.set(id, 0);
        return Response.json({ id, out }, { status: 202 });
      }
      const match = /^\/v1\/remover\/jobs\/([0-9a-f-]+)$/.exec(url.pathname);
      if (match !== null && request.method === "GET") {
        const id = match[1]!;
        const posted = jobsPosted.find((j) => j.id === id);
        if (holdJobIds.has(id) || (posted !== undefined && holdInputs.has(String(posted.request.input)))) return Response.json({ pending: true, status: "running" }, { status: 202 });
        const n = (activePolls.get(id) ?? 0) + 1;
        activePolls.set(id, n);
        if (n < 2) return Response.json({ pending: true, status: "running" }, { status: 202 });
        return Response.json({ ok: true, ask: 1, sheets: 1, seconds: 2, ...(sharedJobIds.has(id) ? { shared: true } : {}) });
      }
      if (match !== null && request.method === "DELETE") {
        const id = match[1]!;
        jobsCancelled.push(id);
        holdJobIds.delete(id);
        const posted = jobsPosted.find((j) => j.id === id);
        if (posted !== undefined) holdInputs.delete(String(posted.request.input));
        releaseHeld?.();
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  process.env.EDIT_RELAY_URL = `http://127.0.0.1:${relayServer.port}`;
  process.env.EDIT_RELAY_TOKEN = "test-token";
  removerCloud.timing.pollMs = 5;
  removerCloud.setOnForTests(true);
  found.reset();
  found.judgeHooks.judge = async (_dir, ask, _sheets, sheetsB64) => {
    judgeCalls.push({ ask, sheetsB64 });
    return Object.fromEntries(ask.map((_, i) => [String(i), "overlay" as const]));
  };
});

afterEach(async () => {
  found.stop("p1");
  found.stop("p2");
  await found.settled();
  found.judgeHooks.judge = origJudge;
  found.reset();
  removerCloud.setOnForTests(null);
  await relayServer.stop(true);
  delete process.env.EDIT_RELAY_URL;
  delete process.env.EDIT_RELAY_TOKEN;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Mac/non-Linux client gets the finder via RunPod, judges with sheetsB64, writes local + R2 cache, and reuses R2 cache on a second machine", async () => {
  expect(found.available()).toBe(true);
  const app1 = makeApp(path.join(tmpDir, "mac1"));
  const media = makeMedia("m1", "clip.mp4", "edit/originals/drive/abc/clip.mp4");
  found.ensure(app1, "p1", [{ media, source: "drive:abc", shown: [[0, 60]], parent: null }]);
  await found.settled();

  expect(jobsPosted).toHaveLength(1);
  expect(jobsPosted[0]!.kind).toBe("find");
  const scripts = JSON.parse(jobsPosted[0]!.worker) as Record<string, string>;
  expect(Object.keys(scripts)).toContain("find.py");
  expect(Object.keys(scripts)).toContain("assemble.py");
  expect(Object.keys(scripts)).toContain("slowcopy.py");
  expect(judgeCalls).toHaveLength(1);
  expect(judgeCalls[0]!.sheetsB64).toHaveLength(1);

  const saved = found.foundOf(app1, "drive:abc");
  expect(saved).not.toBeNull();
  expect(saved!.masks).toContainEqual([30, 90, 400, 900, 1500, 980, "subtitle"]);
  expect(saved!.masks).toContainEqual([0, 3599, 40, 30, 300, 70, "label"]);
  // Temp work key deleted, shared R2 cache key written
  expect([...r2Store.keys()].some((k) => k.startsWith("edit/cleaned/work/"))).toBe(false);
  expect([...r2Store.keys()].some((k) => k.startsWith("edit/cleaned/found/"))).toBe(true);

  // Second machine (fresh cache) gets an instant hit from R2 with zero new RunPod jobs or judge calls
  found.reset();
  const app2 = makeApp(path.join(tmpDir, "mac2"));
  found.ensure(app2, "p2", [{ media, source: "drive:abc", shown: [[5, 50]], parent: null }]);
  await found.settled();
  expect(jobsPosted).toHaveLength(1);
  expect(judgeCalls).toHaveLength(1);
  expect(found.foundOf(app2, "drive:abc")).toEqual(saved);
});

test("multiple files scan in parallel on RunPod, and a slowed copy sends its parent's state to RunPod", async () => {
  const app = makeApp(path.join(tmpDir, "mac-par"));
  // Hold parent by input key (arrival-order independent) until both A and B are submitted concurrently!
  holdInputs.add("edit/originals/drive/a/a.mp4");
  const m1 = makeMedia("m1", "a.mp4", "edit/originals/drive/a/a.mp4");
  const m2 = makeMedia("m2", "b.mp4", "edit/originals/drive/b/b.mp4");
  const slow = makeMedia("m3", "a_slow.mp4", "edit/originals/sha256/slow/a_slow.mp4");

  found.ensure(app, "p1", [
    { media: m1, source: "drive:a", shown: [[0, 30]], parent: null },
    { media: m2, source: "drive:b", shown: [[0, 30]], parent: null },
    { media: slow, source: "sha256:slow", shown: [[0, 10]], parent: { media: m1, source: "drive:a" } },
  ]);

  // Wait briefly until both m1 and m2 are posted concurrently while m1 is still held
  for (let i = 0; i < 60 && jobsPosted.length < 2; i++) await Bun.sleep(10);
  expect(new Set(jobsPosted.map((j) => j.request.input))).toEqual(new Set([
    "edit/originals/drive/a/a.mp4",
    "edit/originals/drive/b/b.mp4",
  ]));
  // Slowed copy has NOT been submitted yet because its parent (m1) is still running
  expect(jobsPosted).toHaveLength(2);

  // Release m1; now slowed copy should run with parent state key uploaded to edit/cleaned/finder/
  holdInputs.delete("edit/originals/drive/a/a.mp4");
  await found.settled();
  expect(jobsPosted).toHaveLength(3);
  const childJob = jobsPosted[2]!;
  expect(childJob.request.input).toBe("edit/originals/sha256/slow/a_slow.mp4");
  expect(typeof childJob.request.parent).toBe("string");
  expect(String(childJob.request.parent)).toMatch(/^edit\/cleaned\/finder\/[0-9a-f]{32}\.json$/);
  const uploadedParent = JSON.parse(r2Store.get(String(childJob.request.parent))!) as found.ParentState;
  expect(uploadedParent.verdicts?.labels).toEqual(["lbl-a.mp4"]);
});

test("Stop cancels a running RunPod find job, a new project right after Stop starts a fresh run, and slowed copies defer while their parent uploads", async () => {
  const app = makeApp(path.join(tmpDir, "mac-stop"));
  // Parent not uploaded yet, slowed copy already uploaded: BOTH are deferred cleanly (neither marked permanently failed)
  const parentUploading = makeMedia("m0", "parent.mp4");
  const childUploaded = makeMedia("m0s", "parent_slow.mp4", "edit/originals/sha256/child/parent_slow.mp4");
  found.ensure(app, "p1", [
    { media: parentUploading, source: "sha256:par", shown: [[0, 20]], parent: null },
    { media: childUploaded, source: "sha256:child", shown: [[0, 10]], parent: { media: parentUploading, source: "sha256:par" } },
  ]);
  await found.settled();
  expect(jobsPosted).toHaveLength(0);
  expect(found.piecesOf("p1")).toEqual([]);

  // Now parent upload finishes; p1 starts scanning, then clicks Stop mid-job; p2 immediately asks for the same file and must NOT join the dying run
  holdInputs.add("edit/originals/sha256/par/parent.mp4");
  const parentUploaded = makeMedia("m0", "parent.mp4", "edit/originals/sha256/par/parent.mp4");
  found.ensure(app, "p1", [{ media: parentUploaded, source: "sha256:par", shown: [[0, 20]], parent: null }]);
  for (let i = 0; i < 60 && jobsPosted.length < 1; i++) await Bun.sleep(10);
  expect(jobsPosted).toHaveLength(1);
  const firstId = jobsPosted[0]!.id;

  found.stop("p1");
  // Release hold for the fresh run from p2 while p1's cancel is still settling
  holdInputs.delete("edit/originals/sha256/par/parent.mp4");
  found.ensure(app, "p2", [
    { media: parentUploaded, source: "sha256:par", shown: [[0, 20]], parent: null },
    { media: childUploaded, source: "sha256:child", shown: [[0, 10]], parent: { media: parentUploaded, source: "sha256:par" } },
  ]);
  await found.settled();
  expect(jobsCancelled).toEqual([firstId]);
  expect(found.foundOf(app, "sha256:par")).not.toBeNull();
  expect(found.foundOf(app, "sha256:child")).not.toBeNull();
  expect(found.piecesOf("p2").every((p) => p.state === "done")).toBe(true);
});

test("malformed R2 cache (missing or non-tuple covered) is treated as a miss, shared job output stays on R2, and newer RunPod parent state refreshes local scan files", async () => {
  const app = makeApp(path.join(tmpDir, "mac-edge"));
  // Seed a malformed R2 found record (`covered: [null]` would throw inside covers() if accepted)
  const { createHash } = await import("node:crypto");
  const badKey = `edit/cleaned/found/${createHash("sha256").update("drive:malformed").digest("hex").slice(0, 32)}.v1.json`;
  r2Store.set(badKey, JSON.stringify({ version: 1, width: 1920, height: 1080, fps: 30, masks: [], covered: [null] }));
  // Mark job #1 as shared so removerCloud.find leaves job.out on R2 for other callers
  sharedJobIds.add("00000000-0000-4000-8000-000000000001");

  const media = makeMedia("m9", "mal.mp4", "edit/originals/drive/mal/mal.mp4");
  found.ensure(app, "p1", [{ media, source: "drive:malformed", shown: [[0, 20]], parent: null }]);
  await found.settled();
  expect(jobsPosted).toHaveLength(1);
  expect(found.foundOf(app, "drive:malformed")).not.toBeNull();
  // Shared output key was NOT deleted by client
  expect(r2Store.has("edit/cleaned/work/00000000-0000-4000-8000-000000000001.json")).toBe(true);

  // Materialize local scan files from RunPod parent state, then verify syncLocalParentScanFiles prefers whichever is newer
  const scanDir = path.join(tmpDir, "mac-edge", "cleaned", "finder", "f", "scan");
  const zoneFile = path.join(scanDir, "drive-malformed.zone.json");
  const sidecarFile = path.join(tmpDir, "mac-edge", "cleaned", "found", "drive-malformed.v1.parent.json");
  const oldState: found.ParentState = {
    zone: { W: 1920, H: 1080, fps: 30, zone: [0.7, 0.9] },
    marks: [{ key: "old-lbl", kind: "label", reads: [] }],
    notes: [],
    cands: [],
    roamExt: [-10, -10, 10, 10],
    verdicts: { yes: [], labels: ["old-lbl"] },
  };
  found.writeLocalParentScanFiles(app, "drive:malformed", oldState);
  const olderMs = Date.now() - 60_000;
  fs.utimesSync(zoneFile, olderMs / 1000, olderMs / 1000);

  // RunPod rescan saves a newer sidecar with updated verdicts -> syncLocalParentScanFiles refreshes the local scan files
  const newState: found.ParentState = {
    zone: { W: 1920, H: 1080, fps: 30, zone: [0.75, 0.92] },
    marks: [{ key: "new-lbl", kind: "label", reads: [] }],
    notes: [],
    cands: [],
    roamExt: [-5, -5, 5, 5],
    verdicts: { yes: [["one-off", "hi", 15]], labels: ["new-lbl"] },
  };
  fs.writeFileSync(sidecarFile, JSON.stringify(newState));
  const newerMs = Date.now() + 10_000;
  fs.utimesSync(sidecarFile, newerMs / 1000, newerMs / 1000);

  await found.syncLocalParentScanFiles(app, "drive:malformed");
  expect(JSON.parse(fs.readFileSync(zoneFile, "utf8"))).toEqual(newState.zone);
  expect(JSON.parse(fs.readFileSync(path.join(scanDir, "drive-malformed.roam.ext.json"), "utf8"))).toEqual([-5, -5, 5, 5]);
  const verdicts = JSON.parse(fs.readFileSync(path.join(tmpDir, "mac-edge", "cleaned", "finder", "f", "verdicts.json"), "utf8")) as Record<string, unknown>;
  expect(verdicts["drive-malformed:labels"]).toEqual(["new-lbl"]);

  // A subsequent refresh with roamExt: null removes the obsolete .roam.ext.json file
  fs.writeFileSync(sidecarFile, JSON.stringify({ ...newState, roamExt: null }));
  const newestMs = Date.now() + 20_000;
  fs.utimesSync(sidecarFile, newestMs / 1000, newestMs / 1000);
  await found.syncLocalParentScanFiles(app, "drive:malformed");
  expect(fs.existsSync(path.join(scanDir, "drive-malformed.roam.ext.json"))).toBe(false);
});

test("queued child never deadlocks a single-slot drain behind a stopped-and-replaced parent expansion", async () => {
  const app = makeApp(path.join(tmpDir, "single-slot"));
  let releaseBlocker!: () => void;
  const blockerGate = new Promise<void>((resolve) => (releaseBlocker = resolve));
  const order: string[] = [];

  // Use standIn so drain() uses its 1-slot limit (same as local GPU / RunPod-off mode)
  found.useFinderForTests({
    async find(req) {
      order.push(req.mid);
      if (req.mid === "blk") await blockerGate;
      return { ask: [], sheets: [] };
    },
    async finish() {
      return { version: 1, width: 1920, height: 1080, fps: 30, masks: [], covered: [[0, 60]] };
    },
  });
  try {
    // Seed an initial parent result so p1 is queuing a parent expansion ([0, 40]) while blk holds the only slot
    const parentFile = path.join(tmpDir, "single-slot", "cleaned", "found", "par.v1.json");
    fs.mkdirSync(path.dirname(parentFile), { recursive: true });
    fs.writeFileSync(parentFile, JSON.stringify({ version: 1, width: 1920, height: 1080, fps: 30, masks: [], covered: [[0, 10]] }));

    const blk = makeMedia("mb", "blk.mp4");
    const par = makeMedia("mp", "par.mp4");
    const child = makeMedia("mc", "child.mp4");

    // 1. blk occupies the single slot
    found.ensure(app, "p0", [{ media: blk, source: "blk", shown: [[0, 10]], parent: null }]);
    // 2. p1 queues parent expansion, p2 queues slowed child behind it
    found.ensure(app, "p1", [{ media: par, source: "par", shown: [[0, 40]], parent: null }]);
    found.ensure(app, "p2", [{ media: child, source: "child", shown: [[0, 10]], parent: { media: par, source: "par" } }]);
    // 3. p1 stops -> cancels and detaches queued parent expansion
    found.stop("p1");
    // 4. p3 queues replacement parent expansion AFTER child in the queue
    found.ensure(app, "p3", [{ media: par, source: "par", shown: [[0, 50]], parent: null }]);

    // 5. Release blocker: drain() must skip child and run replacement parent first instead of deadlocking
    releaseBlocker();
    await found.settled();
    expect(order).toEqual(["blk", "par", "child"]);
    expect(found.piecesOf("p2")[0]?.state).toBe("done");
    expect(found.piecesOf("p3")[0]?.state).toBe("done");
  } finally {
    found.useFinderForTests(null);
  }
});
