// A case takes all of its footage, however long (Sphe, Nov 18: for a good script every recording has to be
// considered). Writer's limits, 60 recordings and 20 hours a case and 10 hours a recording, stopped JJ's 48-recording,
// 23.4-hour Drive folder as "too_much"; a folder over them now comes in whole, and one an older Edit stopped carries
// on with Retry. Drive's lengths here are what it claims (the limits were read from them); the files are short.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as macSpeech from "../../src/mac_speech.ts";
import { diskHooks } from "../../src/storage.ts";
import * as tools from "../../src/tools.ts";
import { timing } from "../../src/transcribe.ts";
import * as captionTurns from "../../src/writer/caption_turns.ts";
import * as drive from "../../src/writer/drive.ts";
import * as imports from "../../src/writer/imports.ts";
import * as parts from "../../src/writer/parts.ts";
import * as store from "../../src/writer/store.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
const HOUR = 3_600_000;
const FOLDER = "1WholeCaseFolder0000000001";
const URL_ = `https://drive.google.com/drive/folders/${FOLDER}`;
/** 29 hours as Drive claims them, the second over the ten hours a recording took. */
const CLAIMED = [9 * HOUR, 11 * HOUR, 9 * HOUR];
const ids = CLAIMED.map((_, n) => `1WholeCaseFile00000000000${n}`);
let mock: MockServer;
let restore: () => void;
let bytes: Uint8Array[] = [];

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  timing.instant = true;
  tools.forget();
  macSpeech.timing.helper = null;
  drive.hooks.accessToken = async () => "mock-access-token";
  captionTurns.asking.ask = () => async () => {
    throw new Error("no Claude in tests");
  };
  if (ffmpeg === null) return;
  const dir = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "whole-case-src-"));
  bytes = CLAIMED.map((_, n) => {
    const out = join(dir, `${n}.mp4`);
    const made = Bun.spawnSync([ffmpeg, "-v", "error", "-f", "lavfi", "-i", `color=c=blue:s=64x36:d=${2 + n}`, "-f", "lavfi", "-i", `sine=frequency=${300 + n * 50}:d=${2 + n}`, "-shortest", "-c:v", "libx264", "-c:a", "aac", out]);
    expect(made.exitCode).toBe(0);
    return new Uint8Array(fs.readFileSync(out));
  });
  mock.on("GET", `/www.googleapis.com/drive/v3/files/${FOLDER}`, () => Response.json({ name: "Whole case" }));
  mock.on("GET", "/www.googleapis.com/drive/v3/files", (request) =>
    Response.json({
      files: (request.query.get("q") ?? "").includes(FOLDER)
        ? CLAIMED.map((ms, n) => ({ id: ids[n], name: `Recording ${n + 1}.mp4`, mimeType: "video/mp4", size: String(bytes[n]!.length), videoMediaMetadata: { durationMillis: String(ms) } }))
        : [],
    }),
  );
  mock.on("GET", /^\/www\.googleapis\.com\/drive\/v3\/files\/1WholeCaseFile\d+$/, (request) => {
    const n = ids.indexOf(request.path.split("/").pop()!);
    if (request.query.get("alt") !== "media") return Response.json({ id: ids[n], name: `Recording ${n + 1}.mp4`, size: String(bytes[n]!.length) });
    const from = Number(/^bytes=(\d+)-/.exec(request.headers.get("range") ?? "")?.[1] ?? 0);
    const body = bytes[n]!.slice(from);
    return new Response(body, { status: from > 0 ? 206 : 200, headers: { "content-type": "video/mp4", ...(from > 0 ? { "content-range": `bytes ${from}-${bytes[n]!.length - 1}/${bytes[n]!.length}` } : {}) } });
  });
});
afterAll(() => {
  macSpeech.timing.helper = undefined;
  restore();
  mock.stop();
});

/** Each recording's real length, as the case's clock holds it. */
const lengths = () => CLAIMED.map((_, n) => (2 + n) * 1000);

test.skipIf(ffmpeg === null)("a Drive folder over Writer's limits (29 hours claimed, one recording of 11) comes in whole, without asking", async () => {
  const { app, cleanup } = fixtureHome("whole-case");
  try {
    const data = store.dataDir(app.store.home);
    const done = await imports.fromDrive(app, data, URL_, null, null, null);
    expect(done.status).toBe("ready");
    expect(done.decision).toBeUndefined();
    expect(done.parts?.map((part) => part.durationMs).map((ms) => Math.round(ms / 1000) * 1000)).toEqual(lengths());
    expect(done.words.length).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
}, 120_000);

/** A script as an Edit from before Nov 18 left it: stopped over a case's limits, its recordings listed, nothing come down yet. */
function stoppedAsTooMuch(data: string): string {
  const id = crypto.randomUUID();
  const dir = store.scriptDir(data, id);
  fs.mkdirSync(dir, { recursive: true });
  const recordings = CLAIMED.map((ms, n) => ({ id: ids[n]!, name: `Recording ${n + 1}.mp4`, size: bytes[n]!.length, audio: false, claimedMs: ms, md5: null }));
  parts.writeManifest(dir, { recordings, skipped: [] });
  const now = Date.now();
  const script: Script = {
    id,
    title: "Whole case",
    sourceKind: "drive",
    sourceUrl: URL_,
    originalPath: "",
    status: "needs_choice",
    stage: "waiting",
    progress: 5,
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
    decision: {
      kind: "too_much",
      summary: "This folder holds more footage than one import takes. A case takes at most twenty hours of footage. Choose the recordings to bring in.",
      files: recordings.map((one) => ({ id: one.id, title: one.name, size: one.size, durationMs: one.claimedMs, audio: false, tooLong: one.claimedMs > 10 * HOUR })),
      maxFiles: 60,
      maxMs: 20 * HOUR,
    },
  } as Script;
  store.write(dir, script);
  return id;
}

test.skipIf(ffmpeg === null)("an import an older Edit stopped as too much carries on whole with Retry, or with the recordings chosen", async () => {
  const { app, cleanup } = fixtureHome("whole-case-retry");
  try {
    const data = store.dataDir(app.store.home);
    const retried = await imports.resume(app, data, stoppedAsTooMuch(data), { kind: "retry" });
    expect(retried.status).toBe("ready");
    expect(retried.decision).toBeUndefined();
    expect(retried.parts?.length).toBe(3);

    // Two of the three chosen, the one over ten hours among them: no limit refuses it.
    const chosen = await imports.resume(app, data, stoppedAsTooMuch(data), { kind: "select", ids: [ids[1]!, ids[2]!] });
    expect(chosen.status).toBe("ready");
    expect(chosen.parts?.map((part) => part.title)).toEqual(["Recording 2", "Recording 3"]);
  } finally {
    cleanup();
  }
}, 180_000);

test("a case's room is counted by its length: its pieces, and the preview they're joined into or the longest recordings' stretches", () => {
  // Three recordings of 9, 11 and 9 hours: 29 h of pieces at ~450 MB an hour, and the three in stretches at once (more than the preview).
  expect(imports.previewRoom(CLAIMED.map((claimedMs) => ({ size: 1e9, claimedMs }))) / 1e9).toBeCloseTo(29 * 0.45 + 29 * 1.116, 1);
  // Nov 18's 26-hour case, measured at 25.4 GB besides its recordings.
  expect(imports.previewRoom([12, 2, 2, 2, 2, 2, 2, 2].map((hours) => ({ size: 1e9, claimedMs: hours * HOUR }))) / 1e9).toBeCloseTo(26 * 0.45 + 16 * 1.116, 1);
  // Many short recordings: the preview beside its pieces.
  expect(imports.previewRoom(Array.from({ length: 100 }, () => ({ size: 1e9, claimedMs: 5 * 60_000 }))) / 1e9).toBeCloseTo(2 * 100 * 5 * 60_000 * 125 / 1e9, 3);
  // A recording Drive gives no length for: a fifth of its size, as before.
  expect(imports.previewRoom([{ size: 5e9, claimedMs: null }])).toBe(2e9);
});

test.skipIf(ffmpeg === null)("a long case a Mac has no room for is refused before anything comes down, with the numbers", async () => {
  const { app, cleanup } = fixtureHome("whole-case-room");
  const free = diskHooks.free;
  diskHooks.free = () => 20e9;
  try {
    const data = store.dataDir(app.store.home);
    const before = mock.calls("/www.googleapis.com/drive/v3/files/").filter((call) => call.query.get("alt") === "media").length;
    await expect(imports.fromDrive(app, data, URL_, null, null, null)).rejects.toThrow(/^This import needs about \d+ GB free and this (Mac|computer) has 20 GB\./);
    expect(mock.calls("/www.googleapis.com/drive/v3/files/").filter((call) => call.query.get("alt") === "media").length).toBe(before);
  } finally {
    diskHooks.free = free;
    cleanup();
  }
}, 60_000);
