// A compilation's Drive folder case into Edit: its joined recordings are
// shared to Edit's originals, and the script names that master on the case
// so Start the edit finds it on any Mac. Nov 4: nothing named it, and
// "751) Predator Teacher Gets the Surprise of His Life" couldn't start its
// edit ("has no Drive or YouTube link").

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import * as handoff from "../../src/writer/handoff.ts";
import * as parts from "../../src/writer/parts.ts";
import * as store from "../../src/writer/store.ts";
import { fetchScript, toParsed } from "../../src/writer_handoff.ts";
import { scratch } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

const ID = "30be49cb-4df6-475c-b6d0-68b383c7db76";
const FOLDER = "https://drive.google.com/drive/folders/13lxSl0lJKDvQLFzCMzwiZs01DcYil6Ke?usp=sharing";
const YOUTUBE = "https://www.youtube.com/watch?v=bEhqcbdJP3k";

/** The Nov 4 script as its import left it: a folder case joined from its recordings, then a YouTube case. */
function imported(home: string): { dir: string; master: Uint8Array; hash: string } {
  const data = store.dataDir(home);
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(join(dir, "compilation"), { recursive: true });
  parts.writeVideos(dir, { videos: [{ url: FOLDER, title: "751) Predator Teacher Gets the Surprise of His Life" }, { url: YOUTUBE, title: "Special Ed Teacher" }], skipped: [] });
  const master = new Uint8Array(4096).map((_, at) => at % 251);
  fs.writeFileSync(join(dir, "compilation", "00.mp4"), master);
  fs.writeFileSync(join(dir, "script.json"), JSON.stringify({
    id: ID, title: "Predator Teacher", sourceKind: "compilation", compilation: true, kind: "interrogation", sourceUrl: `${FOLDER}\n${YOUTUBE}`,
    status: "ready", stage: "ready", revision: 3, updatedAt: 1, durationMs: 20_000, originalPath: join(dir, "proxy.mp4"),
    parts: [
      { title: "751) Predator Teacher Gets the Surprise of His Life", startMs: 0, durationMs: 12_000, audio: false, url: FOLDER },
      { title: "Special Ed Teacher", startMs: 12_000, durationMs: 8_000, audio: false, url: YOUTUBE },
    ],
    clips: [{ id: "in-folder", startMs: 1_000, endMs: 3_000 }, { id: "on-youtube", startMs: 13_000, endMs: 14_000 }],
    words: [],
  }));
  return { dir, master, hash: createHash("sha256").update(master).digest("hex") };
}

test("Start the edit names a folder case's master once it's shared, and says what's missing until then", async () => {
  const { dir: home, cleanup } = scratch("folder-case");
  try {
    const { dir, master, hash } = imported(home);
    // Not shared yet: the case does have a Drive link, so the message says what's actually missing.
    expect(() => toParsed(store.read(dir) as never)).toThrow("is a Drive folder whose joined recordings aren't in Edit's cloud yet");

    // The real share: the master goes to Edit's originals and the script names it on its case.
    await handoff.share(store.dataDir(home), ID);
    const key = `edit/originals/sha256/${hash}/00.mp4`;
    expect(mock.cloud.objects.get(key)?.length).toBe(master.length);
    expect(store.read(dir).parts?.[0]).toMatchObject({ mediaSource: `sha256:${hash}`, originalKey: key });
    expect(store.read(dir).parts?.[1]?.mediaSource).toBeUndefined();

    const parsed = toParsed(await fetchScript(ID, home));
    expect(parsed.blocks[0]).toMatchObject({ file: `sha256:${hash}`, start: 1, end: 3, notes: [`Shared original: ${key}`] });
    expect(parsed.blocks[1]).toMatchObject({ file: "youtube:bEhqcbdJP3k", start: 1, end: 2 });
    expect(handoff.stampShared(dir)).toBe(false);
  } finally {
    cleanup();
  }
});

test("a script shared before Nov 4 (or pulled from an older Edit) names its folder masters on read, on start, and on every save", async () => {
  const { dir: home, cleanup } = scratch("folder-case-old");
  const before = store.hooks.withSharedKeys;
  try {
    const { dir, hash } = imported(home);
    const key = `edit/originals/sha256/${hash}/00.mp4`;
    // What share() left beside it then: the master in Edit's originals, the script itself never told.
    handoff.keepShared(dir, join(dir, "compilation", "00.mp4"), `sha256:${hash}`, key);
    const body = fs.readFileSync(join(dir, "script.json"), "utf8");

    // Start the edit reads it named, without waiting for a save.
    expect(toParsed(await fetchScript(ID, home)).blocks[0]).toMatchObject({ file: `sha256:${hash}` });

    // The start's repair writes it into the body, which syncs to every Mac.
    handoff.stampAll(store.dataDir(home));
    expect(store.read(dir).parts?.[0]).toMatchObject({ mediaSource: `sha256:${hash}`, originalKey: key });

    // A pull from an older Edit drops it again: the next save puts it back.
    fs.writeFileSync(join(dir, "script.json"), body);
    store.hooks.withSharedKeys = handoff.withSharedKeys;
    store.update(dir, (script) => void (script.title = "Predator Teacher, renamed"));
    expect(store.read(dir).parts?.[0]).toMatchObject({ mediaSource: `sha256:${hash}`, originalKey: key });

    // An entry the handoff wouldn't take is never written onto the case.
    fs.writeFileSync(join(dir, "script.json"), body);
    fs.writeFileSync(join(dir, "edit-shared.json"), JSON.stringify([{ source: `sha256:${hash}`, key: "edit/originals/sha256/other/00.mp4", file: "compilation/00.mp4" }]));
    expect(handoff.stampShared(dir)).toBe(false);
  } finally {
    store.hooks.withSharedKeys = before;
    cleanup();
  }
});

// Nov 20: Start the edit sent a folder case's recordings up inside its request, one by one, before it made the project:
// on an 8 Mbit/s line a few GB kept its spinner up for hours, and a drop past the quick retries ended it with nothing.
test("Start the edit answers at once with its project while the folder master's upload never ends; the edit cuts from the master here", async () => {
  const { spyOn } = await import("bun:test");
  const cloud = await import("../../src/cloud.ts");
  const jobs = await import("../../src/jobs.ts");
  const seams = await import("../../src/seams.ts");
  const streamed = await import("../../src/writer/streamed.ts");
  const { importScript } = await import("../../src/writer_handoff.ts");
  const { fixtureHome } = await import("../helpers/home.ts");
  const { app, cleanup } = fixtureHome("folder-case-start");
  const undo: (() => void)[] = [];
  try {
    const { dir } = imported(app.store.home);
    // A master of its own (the mock cloud keeps what the tests above sent up).
    const master = new Uint8Array(4096).map((_, at) => (at * 7) % 253);
    fs.writeFileSync(join(dir, "compilation", "00.mp4"), master);
    const hash = createHash("sha256").update(master).digest("hex");
    streamed.start(app);
    // The upload never finishes (the line gone mid-way).
    const up = spyOn(cloud, "uploadFile").mockImplementation(() => new Promise(() => {}));
    undo.push(() => up.mockRestore());
    const inputs: (string | null | undefined)[] = [];
    const cut = spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache, _original, _ranges, input) => {
      inputs.push(input);
      return new Promise(() => {});
    });
    undo.push(() => cut.mockRestore());
    const tube = spyOn(seams.cloudMedia, "youtubeOriginal").mockImplementation(() => new Promise(() => {}));
    undo.push(() => tube.mockRestore());
    const began = Date.now();
    const made = await importScript(app, ID);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(app.store.get(made.project)).not.toBeNull();
    // Going up behind it, in the job table (resumable, carried on after a quit).
    for (let i = 0; i < 100 && jobs.list(app.store.home, "upload").length === 0; i++) await Bun.sleep(10);
    expect(jobs.list(app.store.home, "upload").map((job) => job.args.originalKey)).toEqual([`edit/originals/sha256/${hash}/00.mp4`]);
    // The edit's file is cut from the master on this Mac, not waited on.
    for (let i = 0; i < 200 && inputs.length === 0; i++) await Bun.sleep(10);
    expect(inputs).toEqual([join(dir, "compilation", "00.mp4")]);
    // Every Mac's script is named only once the master is up.
    expect(store.read(dir).parts?.[0]?.mediaSource).toBeUndefined();
  } finally {
    for (const one of undo) one();
    streamed.reset();
    cleanup();
  }
});
