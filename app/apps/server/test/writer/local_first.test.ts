// A Drive recording's piece of the preview is made from a copy on this Mac as
// soon as it's down, and its original goes up to the cloud behind the import
// (Sphe, Nov 18, for nightly-88: JJ's "Mom Of 4", 48 recordings and 53 GB,
// made its pieces at 0.2–2.4× real time read back from the cloud copy). The
// relay, R2, Convex and Drive are mocks.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import * as editCloud from "../../src/cloud.ts";
import * as cloudMedia from "../../src/cloud_media.ts";
import * as macSpeech from "../../src/mac_speech.ts";
import * as room from "../../src/storage.ts";
import * as tools from "../../src/tools.ts";
import { timing } from "../../src/transcribe.ts";
import * as captionTurns from "../../src/writer/caption_turns.ts";
import * as drive from "../../src/writer/drive.ts";
import * as imports from "../../src/writer/imports.ts";
import * as store from "../../src/writer/store.ts";
import * as streamed from "../../src/writer/streamed.ts";
import * as ytWriter from "../../src/writer/youtube.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer, type Recorded } from "../mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
const FOLDER = "1LocalFirstFolder000000001";
const URL_ = `https://drive.google.com/drive/folders/${FOLDER}`;
const ids = [0, 1, 2].map((n) => `1LocalFirstFile0000000000${n}`);
const names = ["CH01.mp4", "CH02.mp4", "CH03.mp4"];
const keyOf = (n: number) => `edit/originals/drive/${ids[n]}/${names[n]}`;
let mock: MockServer;
let restore: () => void;
let bytes: Uint8Array[] = [];
/** While set, every PUT of an original (or one of its parts) waits for it: a slow upload. */
let gate: Promise<void> | null = null;
/** Parts of an original R2 answers 503 to from this part on (the line drops); null: every part goes. */
let dropFrom: number | null = null;
/** Whether the relay copies Drive files to R2 itself. */
let relayCopies = false;
const hooksBuild = imports.hooks.build;
const disk = { free: room.diskHooks.free, total: room.diskHooks.total };
const cloudTiming = { sleep: editCloud.timing.sleep, filePart: editCloud.timing.filePart, resumableFrom: editCloud.timing.resumableFrom };
const recheck = streamed.timing.recheckMs;

const originalPuts = () => mock.calls(/^\/r2\/edit\/originals\//, "PUT");
const originalGets = () => mock.calls(/^\/r2\/edit\/originals\//, "GET");
const driveDownloads = () => mock.calls(/^\/www\.googleapis\.com\/drive\/v3\/files\/1LocalFirstFile\d+$/, "GET").filter((call) => call.query.get("alt") === "media");
const record = (n: number) => mock.cloud.convex.media.get(`drive:${ids[n]}`);

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  timing.instant = true;
  tools.forget();
  macSpeech.timing.helper = null;
  drive.timing.instant = true;
  drive.hooks.accessToken = async () => "mock-access-token";
  captionTurns.asking.ask = () => async () => {
    throw new Error("no Claude in tests");
  };
  imports.hooks.build = () => {};
  Object.assign(editCloud.timing, { sleep: async () => {} });
  // Plenty of room, unless a test says otherwise.
  room.diskHooks.free = () => 1e12;
  room.diskHooks.total = () => 2e12;
  // R2's PUTs of originals, held back while `gate` is set, or dropped from a part on.
  mock.on("PUT", /^\/r2\/edit\/originals\//, async (request: Recorded) => {
    if (gate !== null) await gate;
    if (dropFrom !== null && Number(request.query.get("partNumber") ?? 0) >= dropFrom) return new Response("", { status: 503 });
    return (mock.cloud as unknown as { r2Put(request: Recorded): Response }).r2Put(request);
  });
  // The relay's Drive → R2 copy, done in the cloud at once, while `relayCopies` (else the relay has no such route).
  mock.on("POST", "/v1/cloud/jobs/drive", (request) => {
    if (!relayCopies) return Response.json({ error: "not found" }, { status: 404 });
    const { file, key } = request.json<{ file: string; key: string }>();
    mock.cloud.put(key, bytes[ids.indexOf(file)]!);
    return Response.json({ id: `drive-${file}`, status: "running" });
  });
  mock.on("POST", "/v1/cloud/jobs/status", (request) => {
    const key = request.json<{ key: string }>().key;
    return Response.json({ status: "complete", bytes: mock.cloud.objects.get(key)?.length ?? 0 });
  });
  if (ffmpeg === null) return;
  const dir = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "local-first-src-"));
  bytes = names.map((_, n) => {
    const out = join(dir, `${n}.mp4`);
    const made = Bun.spawnSync([ffmpeg, "-v", "error", "-f", "lavfi", "-i", `color=c=green:s=64x36:d=${2 + n}`, "-f", "lavfi", "-i", `sine=frequency=${300 + n * 50}:d=${2 + n}`, "-shortest", "-c:v", "libx264", "-c:a", "aac", out]);
    expect(made.exitCode).toBe(0);
    return new Uint8Array(fs.readFileSync(out));
  });
  mock.on("GET", `/www.googleapis.com/drive/v3/files/${FOLDER}`, () => Response.json({ name: "Local first case" }));
  mock.on("GET", "/www.googleapis.com/drive/v3/files", (request) =>
    Response.json({
      files: (request.query.get("q") ?? "").includes(FOLDER) ? names.map((name, n) => ({ id: ids[n], name, mimeType: "video/mp4", size: String(bytes[n]!.length), videoMediaMetadata: { durationMillis: String((2 + n) * 1000) } })) : [],
    }),
  );
  mock.on("GET", /^\/www\.googleapis\.com\/drive\/v3\/files\/1LocalFirstFile\d+$/, (request) => {
    const n = ids.indexOf(request.path.split("/").pop()!);
    if (request.query.get("alt") !== "media") return Response.json({ id: ids[n], name: names[n], size: String(bytes[n]!.length) });
    const from = Number(/^bytes=(\d+)-/.exec(request.headers.get("range") ?? "")?.[1] ?? 0);
    return new Response(bytes[n]!.slice(from), { status: from > 0 ? 206 : 200, headers: { "content-type": "video/mp4", ...(from > 0 ? { "content-range": `bytes ${from}-${bytes[n]!.length - 1}/${bytes[n]!.length}` } : {}) } });
  });
});

beforeEach(() => {
  gate = null;
  dropFrom = null;
  relayCopies = false;
  streamed.reset();
  mock.cloud.objects.clear();
  mock.cloud.convex.media.clear();
  mock.requests.length = 0;
  streamed.timing.recheckMs = 50;
});

afterAll(() => {
  imports.hooks.build = hooksBuild;
  macSpeech.timing.helper = undefined;
  drive.timing.instant = false;
  Object.assign(editCloud.timing, cloudTiming);
  editCloud.keepUploadJournalsIn(null);
  Object.assign(room.diskHooks, disk);
  streamed.timing.recheckMs = recheck;
  streamed.reset();
  restore();
  mock.stop();
});

/** Resolves `promise`'s outcome, or "pending" if it hasn't settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([promise, Bun.sleep(ms).then(() => "pending" as const)]);
}

test.skipIf(ffmpeg === null)("each piece is made from the copy here while the slow upload goes on; the script is ready, the edit here waits, and each copy goes once it's up", async () => {
  const { app, cleanup } = fixtureHome("local-first-slow-up");
  let release: () => void = () => {};
  try {
    streamed.start(app);
    const data = store.dataDir(app.store.home);
    gate = new Promise((resolve) => (release = resolve));
    const done = await imports.fromDrive(app, data, URL_, null, null, null, { note: "" });
    const dir = store.scriptDir(data, done.id);
    // Ready, with every recording, while no original is up yet.
    expect(done.status).toBe("ready");
    expect(done.parts?.map((part) => part.title)).toEqual(["CH01", "CH02", "CH03"]);
    expect(done.words.length).toBeGreaterThan(0);
    expect([0, 1, 2].map((n) => record(n)?.originalReady ?? false)).toEqual([false, false, false]);
    // Every piece read here: nothing of an original came down from the cloud.
    expect(originalGets()).toEqual([]);
    expect(driveDownloads().length).toBe(3);
    // The copies stay until they're up.
    for (const n of [0, 1, 2]) expect(fs.readFileSync(join(dir, ".originals", ids[n]!, names[n]!))).toEqual(Buffer.from(bytes[n]!));
    // The script says its footage is in Edit's originals, so the handoff shares only its words.
    expect(JSON.parse(fs.readFileSync(join(dir, "edit-shared.json"), "utf8")).map((one: { source: string; file: null }) => [one.source, one.file]).sort()).toEqual(ids.map((id) => [`drive:${id}`, null]).sort());

    // Start the edit here before it's up: Edit mode waits for this Mac's upload rather than copying it again.
    const scratch = join(app.store.home, "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const before = driveDownloads().length;
    const edit = cloudMedia.driveOriginal(ids[0]!, scratch, () => {});
    expect(await within(edit, 300)).toBe("pending");

    release();
    gate = null;
    const original = await edit;
    expect(original.key).toBe(keyOf(0));
    await streamed.settled();
    expect(driveDownloads().length).toBe(before);
    for (const n of [0, 1, 2]) {
      expect(record(n)?.originalReady).toBe(true);
      expect(mock.cloud.objects.get(keyOf(n))).toEqual(bytes[n]!);
    }
    // Up and its piece made: each copy is gone.
    expect(fs.existsSync(join(dir, ".originals", "held.json"))).toBe(false);
    for (const n of [0, 1, 2]) expect(fs.existsSync(join(dir, ".originals", ids[n]!))).toBe(false);

    // An original uploaded but its piece not made (an update mid-import): brought here from the cloud, its piece made, the copy removed.
    fs.mkdirSync(join(dir, "pieces"), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(join(dir, "drive", "manifest.json"), "utf8")) as { recordings: drive.Recording[] };
    const got = await imports.fetchRecording(dir, store.read(dir), join(dir, "drive"), 0, manifest.recordings[0]!, true, true, () => {}, true);
    expect(got.problem).toBeNull();
    expect(fs.readdirSync(join(dir, "pieces")).filter((name) => name.startsWith(`${ids[0]}-`) && name.endsWith(".mp4"))).toHaveLength(1);
    expect(originalGets().length).toBeGreaterThan(0);
    expect(driveDownloads().length).toBe(before);
    expect(fs.readdirSync(join(dir, ".originals", "read-here"))).toEqual([]);
  } finally {
    release();
    cleanup();
  }
}, 180_000);

test.skipIf(ffmpeg === null)("with the relay copying it, nothing is sent from this Mac, and a copy that's up before its piece stays until the piece is made", async () => {
  const { app, cleanup } = fixtureHome("local-first-relay");
  try {
    streamed.start(app);
    const data = store.dataDir(app.store.home);
    const dir = store.scriptDir(data, "0c0ffee0-0000-4000-8000-000000000001");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "script.json"), JSON.stringify({ status: "processing" }));
    relayCopies = true;
    const recording: drive.Recording = { id: ids[1]!, name: names[1]!, size: bytes[1]!.length, audio: false, md5: null };
    const put = await streamed.drive(dir, recording, () => {}, true);
    expect(put.here).toBe(join(dir, ".originals", ids[1]!, names[1]!));
    await streamed.settled();
    // Up by the relay, no bytes of it from here.
    expect(record(1)?.originalReady).toBe(true);
    expect(originalPuts()).toEqual([]);
    // Its piece isn't made yet: the copy stays.
    expect(fs.existsSync(put.here!)).toBe(true);
    // Made: it goes.
    streamed.done(dir, put);
    expect(fs.existsSync(put.here!)).toBe(false);
  } finally {
    cleanup();
  }
}, 60_000);

test("an upload a restart cut off carries on from the parts already up, the import's next call reads the copy without downloading it again, and the copy goes once it's up", async () => {
  const { app, cleanup } = fixtureHome("local-first-restart");
  const PART = 1024 * 1024;
  Object.assign(editCloud.timing, { filePart: PART, resumableFrom: 2 * PART });
  try {
    editCloud.keepUploadJournalsIn(join(app.store.home, "uploads"));
    const data = store.dataDir(app.store.home);
    const dir = store.scriptDir(data, "0c0ffee0-0000-4000-8000-000000000002");
    const id = "1LocalFirstRestart00000001";
    const key = `edit/originals/drive/${id}/long.mp4`;
    const path = join(dir, ".originals", id, "long.mp4");
    const data5 = new Uint8Array(5 * PART).map((_, at) => (at * 7) % 251);
    fs.mkdirSync(join(dir, ".originals", id), { recursive: true });
    fs.writeFileSync(path, data5);
    fs.writeFileSync(join(dir, "script.json"), JSON.stringify({ status: "processing" }));
    fs.writeFileSync(join(dir, ".originals", "held.json"), JSON.stringify([{ source: `drive:${id}`, drive: id, key, name: "long.mp4", size: data5.length, path: `.originals/${id}/long.mp4`, landed: true, up: false, piece: false }]));
    await editCloud.mutation("edit:putMedia", { source: `drive:${id}`, name: "long.mp4", originalKey: key, size: data5.length });

    // The first run: the relay can't copy it (no such route), so it goes from here, and the line drops at part 3.
    dropFrom = 3;
    streamed.timing.recheckMs = 3_600_000;
    streamed.start(app);
    for (let waited = 0; mock.calls(/^\/r2\/edit\/originals\/drive\/1LocalFirstRestart/, "PUT").filter((call) => call.query.get("partNumber") === "3").length < 2 && waited < 20_000; waited += 50) await Bun.sleep(50);
    await Bun.sleep(200);
    const upFirst = new Set(mock.calls(/^\/r2\//, "PUT").filter((call) => call.query.get("partNumber") !== null && Number(call.query.get("partNumber")) < 3).map((call) => call.query.get("partNumber")));
    expect(upFirst).toEqual(new Set(["1", "2"]));
    expect(record(0)).toBeUndefined();
    expect(mock.cloud.convex.media.get(`drive:${id}`)?.originalReady).toBe(false);

    // Edit restarts: the upload carries on by itself, parts 3–5 only.
    streamed.reset();
    dropFrom = null;
    const mark = mock.requests.length;
    streamed.start(app);
    // Meanwhile the import carries on: it reads the copy here, nothing downloaded again.
    const put = await streamed.drive(dir, { id, name: "long.mp4", size: data5.length, audio: false, md5: null }, () => {}, true);
    expect(put.here).toBe(path);
    await streamed.settled();
    const after = mock.requests.slice(mark);
    expect(after.filter((call) => call.method === "GET" && call.path.includes(id) && call.query.get("alt") === "media")).toEqual([]);
    expect(after.filter((call) => call.method === "PUT" && call.path.startsWith("/r2/edit/originals/")).map((call) => call.query.get("partNumber")).sort()).toEqual(["3", "4", "5"]);
    expect(mock.cloud.objects.get(key)).toEqual(data5);
    expect(mock.cloud.convex.media.get(`drive:${id}`)?.originalReady).toBe(true);
    // Up, but the import isn't done with it: kept; done, removed.
    expect(fs.existsSync(path)).toBe(true);
    streamed.done(dir, put);
    expect(fs.existsSync(path)).toBe(false);
  } finally {
    Object.assign(editCloud.timing, { filePart: cloudTiming.filePart, resumableFrom: cloudTiming.resumableFrom });
    editCloud.keepUploadJournalsIn(null);
    cleanup();
  }
}, 60_000);

test.skipIf(ffmpeg === null)("short of room to keep the recordings here, each goes to the cloud first and is read back from there, as before", async () => {
  const { app, cleanup } = fixtureHome("local-first-low-disk");
  // 15.5 GB free of 100: what Edit keeps free (15 GB) leaves no room for the recordings beside the preview's.
  room.diskHooks.free = () => 15.5e9;
  room.diskHooks.total = () => 100e9;
  try {
    streamed.start(app);
    const data = store.dataDir(app.store.home);
    const done = await imports.fromDrive(app, data, URL_, null, null, null, { note: "" });
    const dir = store.scriptDir(data, done.id);
    expect(done.status).toBe("ready");
    expect(done.parts?.map((part) => part.title)).toEqual(["CH01", "CH02", "CH03"]);
    // Up before the import went on, and the pieces read from the cloud.
    expect([0, 1, 2].map((n) => record(n)?.originalReady)).toEqual([true, true, true]);
    expect(originalGets().length).toBeGreaterThan(0);
    expect(fs.existsSync(join(dir, ".originals", "held.json"))).toBe(false);
    for (const n of [0, 1, 2]) expect(fs.existsSync(join(dir, ".originals", ids[n]!))).toBe(false);
  } finally {
    room.diskHooks.free = () => 1e12;
    room.diskHooks.total = () => 2e12;
    cleanup();
  }
}, 180_000);

test.skipIf(ffmpeg === null)("a YouTube video is read from its download here while it goes up behind the import, Edit mode here waiting for it", async () => {
  const { app, cleanup } = fixtureHome("local-first-youtube");
  let release: () => void = () => {};
  try {
    streamed.start(app);
    const data = store.dataDir(app.store.home);
    const dir = store.scriptDir(data, "0c0ffee0-0000-4000-8000-000000000003");
    const id = "LocalFirst1";
    const url = `https://www.youtube.com/watch?v=${id}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "script.json"), JSON.stringify({ status: "processing" }));
    // Its title from the Data API (no yt-dlp in tests), and its download already finished (yt-dlp's own `.done`).
    mock.on("GET", "/v1/youtube/check", () => Response.json({ videos: { [id]: { title: "Clip", channel: "Someone", durationSeconds: 3, live: "none", ageRestricted: false, privacy: "public" } } }));
    await ytWriter.probe(app, url);
    const into = join(dir, ".originals", `youtube-${id}`);
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(join(into, "v.mp4"), bytes[0]!);
    fs.writeFileSync(join(into, ".done"), "v.mp4");
    gate = new Promise((resolve) => (release = resolve));
    const put = await streamed.fromYoutube(app, dir, url, () => {});
    expect(put.here).toBe(join(into, "v.mp4"));
    expect(mock.cloud.convex.media.get(`youtube:${id}`)?.originalReady ?? false).toBe(false);
    // Edit mode here waits for it rather than downloading it again.
    const scratch = join(app.store.home, "scratch");
    const edit = cloudMedia.youtubeOriginal(app.store.home, `youtube:${id}`, scratch, () => {});
    expect(await within(edit, 300)).toBe("pending");
    release();
    gate = null;
    const [original, local] = await edit;
    expect(local).toBeNull();
    expect(original.key).toBe(put.key);
    await streamed.settled();
    expect(mock.cloud.convex.media.get(`youtube:${id}`)?.originalReady).toBe(true);
    expect(mock.cloud.objects.get(put.key)).toEqual(bytes[0]!);
    // Kept until its piece is made.
    expect(fs.existsSync(put.here!)).toBe(true);
    streamed.done(dir, put);
    expect(fs.existsSync(into)).toBe(false);
  } finally {
    release();
    cleanup();
  }
}, 60_000);
