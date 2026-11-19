// An import never stops or asks because of one file (Sphe, Nov 18, for nightly-87): a Drive folder's recording that
// won't come down is left out for now, the import carries on with the rest, writing waits, and the recording is tried
// again by itself and joined into the case in its place when it comes (its piece, its hearing; the others' hearings
// moved, not heard again). Go on without it leaves it out for good and the waiting build starts. An import an older
// Edit stopped on "some recordings couldn't be imported" carries on the same way by itself. Drive is a mock.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as durable from "../../src/jobs.ts";
import * as macSpeech from "../../src/mac_speech.ts";
import * as tools from "../../src/tools.ts";
import { timing } from "../../src/transcribe.ts";
import * as captionTurns from "../../src/writer/caption_turns.ts";
import * as drive from "../../src/writer/drive.ts";
import * as imports from "../../src/writer/imports.ts";
import * as missing from "../../src/writer/missing.ts";
import * as parts from "../../src/writer/parts.ts";
import * as scripting from "../../src/writer/scripting.ts";
import * as store from "../../src/writer/store.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
const FOLDER = "1MissingCaseFolder00000001";
const URL_ = `https://drive.google.com/drive/folders/${FOLDER}`;
const ids = [0, 1, 2].map((n) => `1MissingCaseFile00000000${n}`);
const names = ["CH01.mp4", "CH02.mp4", "CH03.mp4"];
let mock: MockServer;
let restore: () => void;
let bytes: Uint8Array[] = [];
/** Recordings Drive refuses to give right now. */
const refused = new Set<number>();
const built: [string, string][] = [];
const hooksBuild = imports.hooks.build;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  timing.instant = true;
  tools.forget();
  macSpeech.timing.helper = null;
  drive.timing.instant = true;
  drive.hooks.accessToken = async () => "mock-access-token";
  captionTurns.asking.ask = () => async () => {
    throw new Error("no Claude in tests");
  };
  imports.hooks.build = (_app, id, note) => void built.push([id, note]);
  if (ffmpeg === null) return;
  const dir = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "missing-case-src-"));
  bytes = names.map((_, n) => {
    const out = join(dir, `${n}.mp4`);
    const made = Bun.spawnSync([ffmpeg, "-v", "error", "-f", "lavfi", "-i", `color=c=blue:s=64x36:d=${2 + n}`, "-f", "lavfi", "-i", `sine=frequency=${300 + n * 50}:d=${2 + n}`, "-shortest", "-c:v", "libx264", "-c:a", "aac", out]);
    expect(made.exitCode).toBe(0);
    return new Uint8Array(fs.readFileSync(out));
  });
  mock.on("GET", `/www.googleapis.com/drive/v3/files/${FOLDER}`, () => Response.json({ name: "Missing case" }));
  mock.on("GET", "/www.googleapis.com/drive/v3/files", (request) =>
    Response.json({
      files: (request.query.get("q") ?? "").includes(FOLDER) ? names.map((name, n) => ({ id: ids[n], name, mimeType: "video/mp4", size: String(bytes[n]!.length), videoMediaMetadata: { durationMillis: String((2 + n) * 1000) } })) : [],
    }),
  );
  mock.on("GET", /^\/www\.googleapis\.com\/drive\/v3\/files\/1MissingCaseFile\d+$/, (request) => {
    const n = ids.indexOf(request.path.split("/").pop()!);
    if (request.query.get("alt") !== "media") return Response.json({ id: ids[n], name: names[n], size: String(bytes[n]!.length) });
    if (refused.has(n)) return new Response("no", { status: 403 });
    const from = Number(/^bytes=(\d+)-/.exec(request.headers.get("range") ?? "")?.[1] ?? 0);
    return new Response(bytes[n]!.slice(from), { status: from > 0 ? 206 : 200, headers: { "content-type": "video/mp4", ...(from > 0 ? { "content-range": `bytes ${from}-${bytes[n]!.length - 1}/${bytes[n]!.length}` } : {}) } });
  });
});
beforeEach(() => {
  refused.clear();
  built.length = 0;
});
afterAll(() => {
  missing.stop();
  imports.hooks.build = hooksBuild;
  macSpeech.timing.helper = undefined;
  drive.timing.instant = false;
  restore();
  mock.stop();
});

/** Until `ready(script)` holds, read from disk. */
async function until(data: string, id: string, ready: (script: Script) => boolean, ms = 60_000): Promise<Script> {
  const end = Date.now() + ms;
  for (;;) {
    const script = store.read(store.scriptDir(data, id));
    if (ready(script) && !imports.importing(id)) return script;
    if (Date.now() > end) throw new Error(`waited too long: ${script.status} ${script.stage} ${JSON.stringify(script.missing)}`);
    await Bun.sleep(100);
  }
}

const scribeCalls = () => mock.calls("/v1/transcribe").length;

test.skipIf(ffmpeg === null)("a recording that won't come down is left out for now, writing waits, and it's joined in its place when it comes", async () => {
  const { app, cleanup } = fixtureHome("missing-rejoin");
  try {
    const data = store.dataDir(app.store.home);
    missing.start(app, data);
    refused.add(1);
    const done = await imports.fromDrive(app, data, URL_, null, null, null, { note: "Write it tight." });
    const dir = store.scriptDir(data, done.id);
    // Carried on: ready with the other two, no question, the missing one named and tried again later.
    expect(done.status).toBe("ready");
    expect(done.decision).toBeUndefined();
    expect(done.parts?.map((part) => part.title)).toEqual(["CH01", "CH03"]);
    expect(done.missing?.map((one) => [one.id, one.title, one.tries])).toEqual([[ids[1]!, "CH02.mp4", 0]]);
    expect(done.missing![0]!.nextAt - Date.now()).toBeGreaterThan(50_000);
    expect(parts.readManifest(dir)?.missing).toEqual([ids[1]!]);
    expect(store.summary(done).missing?.length).toBe(1);
    // Its tries are a row in this computer's job table, not a timer in memory: a restart keeps them.
    expect(durable.get(app.store.home, durable.keyOf("missing", done.id))).toMatchObject({ state: "waiting", args: { waiting_on: "passing" } });
    // Writing waits, and the writer would be told.
    expect(built).toEqual([]);
    expect(store.read(dir).firstBuild).toEqual({ note: "Write it tight." });
    expect(scripting.withMissing("Write it tight.", done)).toContain("CH02.mp4 didn't come in");
    // Pieces are kept for the join to come.
    expect(fs.readdirSync(join(dir, "pieces")).length).toBeGreaterThan(0);
    const third = fs.readFileSync(join(dir, "transcript", "part-02", "transcript.json"), "utf8");

    // Retry now while Drive still refuses: tried, still missing, the next try further off.
    await imports.resume(app, data, done.id, { kind: "retry_missing" });
    const still = await until(data, done.id, (script) => (script.missing?.[0]?.tries ?? 0) === 1);
    expect(still.missing![0]!.error).not.toBe("");
    expect(still.missing![0]!.nextAt - Date.now()).toBeGreaterThan(4 * 60_000);

    // It comes: joined in its place, only it heard, and the build that waited starts by itself.
    refused.clear();
    const heard = scribeCalls();
    await missing.tryAgain(done.id, true);
    const whole = await until(data, done.id, (script) => script.status === "ready" && script.missing === undefined);
    expect(whole.parts?.map((part) => part.title)).toEqual(["CH01", "CH02", "CH03"]);
    expect(whole.durationMs).toBeGreaterThan(8_500);
    expect(whole.words.length).toBeGreaterThan(0);
    expect(whole.words.some((word) => word.startMs >= 2_000 && word.startMs < 5_000)).toBe(true);
    expect(scribeCalls() - heard).toBe(1);
    // CH03's hearing moved to its new place, not heard again.
    expect(fs.readFileSync(join(dir, "transcript", "part-03", "transcript.json"), "utf8")).toBe(third);
    expect(parts.readManifest(dir)?.missing).toEqual([]);
    expect(fs.existsSync(join(dir, "pieces"))).toBe(false);
    await until(data, done.id, () => built.length > 0);
    expect(built).toEqual([[done.id, "Write it tight."]]);
  } finally {
    cleanup();
  }
}, 180_000);

test.skipIf(ffmpeg === null)("a recording that can't be read as the preview is joined never stops the case: the rest is joined, it's left out with the real reason and tried again by itself (JJ's Mom Of 4 on nightly-90: \"its import stopped (Could not read BenjaminCunningham_…)\")", async () => {
  const { app, cleanup } = fixtureHome("missing-unreadable");
  try {
    const data = store.dataDir(app.store.home);
    const id = "0bad-cafe-0001";
    const dir = store.scriptDir(data, id);
    const now = Date.now();
    const script = { id, title: "Unreadable", sourceKind: "drive", sourceUrl: URL_, originalPath: "", status: "processing", stage: "downloading", progress: 5, error: null, durationMs: 0, words: [], clips: [], overview: [], parts: [], notes: [], kind: "interrogation", revision: 1, createdAt: now, updatedAt: now, proxyPath: null } as unknown as Script;
    const folder = join(dir, "drive");
    fs.mkdirSync(folder, { recursive: true });
    const files = [0, 1, 2].map((n) => join(folder, `0${n}.mp4`));
    fs.writeFileSync(files[0]!, bytes[0]!);
    // Its copy here gone bad, as a dropped read leaves it: a megabyte of noise.
    fs.writeFileSync(files[1]!, new Uint8Array(1_000_000).map(() => Math.floor(Math.random() * 256)));
    fs.writeFileSync(files[2]!, bytes[2]!);
    store.write(dir, script);
    const items: imports.JoinItem[] = files.map((path, n) => ({ title: `CH0${n + 1}`, path, url: drive.fileLink(ids[n]!), id: ids[n]! }));
    await imports.joinPreview(dir, script, items, "recordings");
    const after = store.read(dir);
    expect(after.parts?.map((part) => part.title)).toEqual(["CH01", "CH03"]);
    expect(after.missing?.map((one) => one.id)).toEqual([ids[1]!]);
    expect(after.missing?.[0]?.error ?? "").not.toBe("");
    expect(after.missing?.[0]?.error).not.toContain("Could not read");
    // None readable: it says so, with why.
    fs.writeFileSync(files[0]!, new Uint8Array(1000));
    fs.writeFileSync(files[2]!, new Uint8Array(1000));
    await expect(imports.joinPreview(dir, after, items, "recordings")).rejects.toThrow(/None of the recordings could be read\. CH01: /);
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("Go on without it leaves the recording out for good, says so to the writer, and the waiting build starts", async () => {
  const { app, cleanup } = fixtureHome("missing-without");
  try {
    const data = store.dataDir(app.store.home);
    missing.start(app, data);
    refused.add(2);
    const done = await imports.fromDrive(app, data, URL_, null, null, null, { note: "" });
    const dir = store.scriptDir(data, done.id);
    expect(done.missing?.map((one) => one.id)).toEqual([ids[2]!]);
    const after = await imports.resume(app, data, done.id, { kind: "skip_missing", id: ids[2]! });
    expect(after.missing).toBeUndefined();
    expect(parts.readManifest(dir)?.skipped).toEqual([ids[2]!]);
    expect(parts.readManifest(dir)?.missing).toEqual([]);
    expect(scripting.withMissing("", after)).toContain("went on without CH03.mp4");
    expect(fs.existsSync(join(dir, "pieces"))).toBe(false);
    expect(built).toEqual([[done.id, ""]]);
    // Never tried or asked about again.
    await missing.tryAgain(done.id, true);
    expect(store.read(dir).missing).toBeUndefined();
  } finally {
    cleanup();
  }
}, 120_000);

test.skipIf(ffmpeg === null)("an import an older Edit stopped on failed recordings carries on by itself, the failed one missing", async () => {
  const { app, cleanup } = fixtureHome("missing-older");
  try {
    const data = store.dataDir(app.store.home);
    const id = crypto.randomUUID();
    const dir = store.scriptDir(data, id);
    fs.mkdirSync(dir, { recursive: true });
    parts.writeManifest(dir, { recordings: names.map((name, n) => ({ id: ids[n]!, name, size: bytes[n]!.length, audio: false, claimedMs: (2 + n) * 1000, md5: null })), skipped: [] });
    const now = Date.now();
    store.write(dir, {
      id,
      title: "Missing case",
      sourceKind: "drive",
      sourceUrl: URL_,
      originalPath: "",
      status: "needs_choice",
      stage: "waiting",
      progress: 38,
      error: null,
      durationMs: 0,
      words: [],
      clips: [],
      overview: [],
      parts: [],
      notes: [],
      kind: "interrogation",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      proxyPath: null,
      decision: { kind: "failed_recordings", summary: "CH01.mp4 couldn't be imported; the other 2 are ready. Go on without it, try it again, or cancel.", failed: [{ id: ids[0]!, title: "CH01.mp4", error: "no" }], total: 3 },
    } as Script);
    refused.add(0);
    // Its import ran here: its preview pieces are here (a teammate's synced copy has none, below).
    fs.mkdirSync(join(dir, "pieces"), { recursive: true });
    missing.start(app, data);
    const carried = await until(data, id, (script) => script.status === "ready");
    expect(carried.decision).toBeUndefined();
    expect(carried.parts?.map((part) => part.title)).toEqual(["CH02", "CH03"]);
    expect(carried.missing?.map((one) => one.title)).toEqual(["CH01.mp4"]);
  } finally {
    cleanup();
  }
}, 120_000);

test("a teammate's script paused on failed recordings, synced here, is left to their computer (Sphe's Linux Edit took over two of JJ's imports, Nov 18)", async () => {
  const { app, cleanup } = fixtureHome("missing-theirs");
  try {
    const data = store.dataDir(app.store.home);
    const id = crypto.randomUUID();
    const dir = store.scriptDir(data, id);
    fs.mkdirSync(dir, { recursive: true });
    parts.writeManifest(dir, { recordings: names.map((name, n) => ({ id: ids[n]!, name, size: bytes[n]!.length, audio: false, claimedMs: (2 + n) * 1000, md5: null })), skipped: [] });
    const now = Date.now();
    // As the sync brings it: the script and its list, no pieces (its import ran on the teammate's Mac).
    store.write(dir, {
      id, title: "Their case", sourceKind: "drive", sourceUrl: URL_, originalPath: "", status: "needs_choice", stage: "waiting", progress: 38, error: null,
      durationMs: 0, words: [], clips: [], overview: [], parts: [], notes: [], kind: "interrogation", revision: 1, createdAt: now, updatedAt: now, proxyPath: null,
      decision: { kind: "failed_recordings", summary: "CH01.mp4 couldn't be imported; the other 2 are ready.", failed: [{ id: ids[0]!, title: "CH01.mp4", error: "no" }], total: 3 },
    } as Script);
    missing.start(app, data);
    await Bun.sleep(500);
    expect(imports.importing(id)).toBe(false);
    expect(store.read(dir).status).toBe("needs_choice");
  } finally {
    cleanup();
  }
});

test("the tries back off as failure.ts says: a dropped line after 1, 5 and 15 minutes, then every 30; a file nobody shared looked at again in 30", () => {
  const now = 1_000_000;
  const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly";
  expect([1, 2, 3, 4, 10].map((tries) => missing.nextAt(tries, dropped, now) - now)).toEqual([60_000, 300_000, 900_000, 1_800_000, 1_800_000]);
  expect(missing.nextAt(1, "This file isn't shared with Edit's Google account", now) - now).toBe(1_800_000);
});

test("a hearing moves with its recording when one joins before it; what nobody keeps goes", () => {
  const { dir, cleanup } = (() => {
    const made = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "hearings-"));
    return { dir: made, cleanup: () => fs.rmSync(made, { recursive: true, force: true }) };
  })();
  try {
    const put = (key: string, text: string) => {
      fs.mkdirSync(join(dir, "transcript", key), { recursive: true });
      fs.writeFileSync(join(dir, "transcript", key, "transcript.json"), text);
    };
    const read = (key: string) => fs.readFileSync(join(dir, "transcript", key, "transcript.json"), "utf8");
    put("part-01", "a");
    put("part-02", "c");
    put("part-03", "stale");
    put("reuse-00", "r");
    imports.moveHearings(dir, ["A", "C"], ["A", "B", "C"]);
    expect(read("part-01")).toBe("a");
    expect(read("part-03")).toBe("c");
    expect(fs.existsSync(join(dir, "transcript", "part-02"))).toBe(false);
    expect(read("reuse-00")).toBe("r");
    // One alone was "whole"; with a second before it, it's part-02.
    fs.rmSync(join(dir, "transcript"), { recursive: true });
    put("whole", "b");
    imports.moveHearings(dir, ["B"], ["A", "B"]);
    expect(read("part-02")).toBe("b");
    expect(fs.existsSync(join(dir, "transcript", "whole"))).toBe(false);
  } finally {
    cleanup();
  }
});
