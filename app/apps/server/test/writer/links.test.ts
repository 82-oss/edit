// writer/links.ts: footage a message to a script brings (a video linked, every
// recording of a Drive folder, a file attached in the chat) comes in whole as
// recordings of their own after the footage, heard whole by Scribe, before
// Claude places them; the footage already there keeps its times.

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";

import type { Script, Word } from "@edit/types/writer";

import * as realDrive from "../../src/writer/drive.ts";
import * as realHearing from "../../src/writer/hearing.ts";
import * as realReuse from "../../src/writer/reuse.ts";
import * as realScripting from "../../src/writer/scripting.ts";
import { diskHooks } from "../../src/storage.ts";
import { ffmpeg } from "../../src/tools.ts";
import { fixtureHome } from "../helpers/home.ts";

// Scribe, the turns pass, Drive and Claude stand in, only while this file's tests run (a module stood in for
// stays so for the test files after it in the same run).
const standIn = { on: true };
afterAll(() => {
  standIn.on = false;
});
// The real ones kept first: once a module is stood in for, its own names point at the stand-ins, and a stand-in
// calling "the real one" through them calls itself (every later test file's hearing then never ends).
const real = { hear: realHearing.hear, nameNewVoices: realReuse.nameNewVoices, reviseWith: realScripting.reviseWith, buildAndReview: realScripting.buildAndReview, recordings: realDrive.recordings, download: realDrive.download };
const heardFiles: string[] = [];
const told: string[] = [];
const built: string[] = [];
/** The Drive folder the stand-in lists, and the file each of its recordings downloads as. */
const folder: { recordings: realDrive.Recording[]; file: string } = { recordings: [], file: "" };
void mock.module("../../src/writer/hearing.ts", () => ({
  ...realHearing,
  hear: async (...args: Parameters<typeof realHearing.hear>) => {
    if (!standIn.on) return real.hear(...args);
    heardFiles.push(args[0]);
    expect(args[1]).toBeNull();
    return { model: "scribe_v3", language: "en", words: [{ text: "Hands", start: 0.2, end: 0.5, speaker: "speaker_0" }, { text: "up", start: 0.5, end: 0.8, speaker: "speaker_0" }] };
  },
}));
void mock.module("../../src/writer/reuse.ts", () => ({
  ...realReuse,
  nameNewVoices: async (...args: Parameters<typeof realReuse.nameNewVoices>) => {
    if (!standIn.on) return real.nameNewVoices(...args);
    const [now, , added] = args;
    // Each recording's voice is its own: "3:speaker_0" is Recording 3's.
    for (const word of now.words.slice(now.words.length - added)) {
      const tag = word.speaker!.split(":")[0]!;
      word.speaker = `${tag}:p9`;
      now.speakers = { ...(now.speakers ?? {}), [`${tag}:p9`]: "Officer" };
    }
  },
}));
void mock.module("../../src/writer/scripting.ts", () => ({
  ...realScripting,
  reviseWith: async (...args: Parameters<typeof realScripting.reviseWith>) => {
    if (!standIn.on) return real.reviseWith(...args);
    told.push(args[2]);
    return ["Put it after the intro.", 0.01];
  },
  buildAndReview: async (...args: Parameters<typeof realScripting.buildAndReview>) => {
    if (!standIn.on) return real.buildAndReview(...args);
    built.push(args[3]);
    return ["First draft written.", 0.02];
  },
}));
void mock.module("../../src/writer/drive.ts", () => ({
  ...realDrive,
  recordings: async (...args: Parameters<typeof realDrive.recordings>) => (standIn.on ? ["Case folder", folder.recordings] : real.recordings(...args)),
  download: async (...args: Parameters<typeof realDrive.download>) => {
    if (!standIn.on) return real.download(...args);
    fs.copyFileSync(folder.file, args[2]);
  },
}));

const { addFootage, receiveUpload } = await import("../../src/writer/links.ts");
const store = await import("../../src/writer/store.ts");
const media = await import("../../src/writer/media.ts");
const jobs = await import("../../src/writer/jobs.ts");
const chat = await import("../../src/writer/chat.ts");
const { respond } = await import("../../src/http/server.ts");
const { buildRouter } = await import("../../src/routes.ts");

const restore = { ytdlp: process.env.EDIT_YTDLP, free: diskHooks.free, token: realDrive.hooks.accessToken };
beforeEach(() => {
  // Room for everything: the room test says how much it has.
  diskHooks.free = () => Number.POSITIVE_INFINITY;
  realDrive.hooks.accessToken = async () => "token";
  heardFiles.length = 0;
  told.length = 0;
  built.length = 0;
  jobs.resetForTests();
});
afterEach(() => {
  if (restore.ytdlp === undefined) delete process.env.EDIT_YTDLP;
  else process.env.EDIT_YTDLP = restore.ytdlp;
  diskHooks.free = restore.free;
  realDrive.hooks.accessToken = restore.token;
});

function make(args: string[], out: string): void {
  const done = Bun.spawnSync([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
}

const ID = "5d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a";
const word = (text: string, startMs: number): Word => ({ id: `w${startMs}`, text, startMs, endMs: startMs + 400, speaker: "p1" });
const NO_FOCUS = { selected: [], picked: null, playheadMs: null };

/** A built single-video script: its preview, words and a cut-in (none: not built yet). */
async function aScript(fx: ReturnType<typeof fixtureHome>, built = true): Promise<{ data: string; dir: string; lengthMs: number }> {
  const data = store.dataDir(fx.app.store.home);
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  const source = `${fx.dir}/case.mp4`;
  make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=3", "-f", "lavfi", "-i", "sine=d=3", "-shortest"], source);
  await media.join([{ path: source, streams: await media.streams(source) }], store.proxyPath(dir));
  const lengthMs = (await media.streams(store.proxyPath(dir))).durationMs;
  fs.mkdirSync(`${dir}/transcript/whole`, { recursive: true });
  fs.writeFileSync(`${dir}/transcript/whole/transcript.json`, "{}");
  store.write(dir, {
    id: ID, title: "Traffic stop", sourceKind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=4mqGp1IgqEw", originalPath: store.proxyPath(dir),
    status: "ready", stage: "", progress: 100, error: null, durationMs: lengthMs, revision: 4, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null,
    speakers: { p1: "Driver" }, words: [word("license", 500), word("please", 1_000)],
    clips: built ? [{ id: "c0", kind: "cut-in", startMs: 0, endMs: 0, narration: "It began." }, { id: "c1", startMs: 400, endMs: 1_500 }] : [],
  } as unknown as Script);
  return { data, dir, lengthMs };
}

const jobOf = (stages: string[] = []) => ({ id: ID, signal: new AbortController().signal, stage: (text: string) => void stages.push(text) });

test("a video linked in a revision joins the script as its own recording, heard whole, then the revision places it", async () => {
  const fx = fixtureHome("writer-links");
  try {
    const { data, dir, lengthMs } = await aScript(fx);
    // The linked page's video, as a stand-in yt-dlp gives it.
    const linked = `${fx.dir}/linked.mp4`;
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2", "-f", "lavfi", "-i", "sine=f=330:d=2", "-shortest"], linked);
    fs.writeFileSync(`${fx.dir}/yt-dlp`, `#!/bin/sh
for arg in "$@"; do case "$prev" in -P) out="$arg";; esac; prev="$arg"; done
cp "${linked}" "$out/Dashcam [x1].mp4"
echo "EDIT-FILE $out/Dashcam [x1].mp4"
`, { mode: 0o755 });
    process.env.EDIT_YTDLP = `${fx.dir}/yt-dlp`;
    const stages: string[] = [];
    const job = jobOf(stages);
    const request = "Add this right after the intro: https://news.example.com/dashcam";
    const adding = { urls: ["https://news.example.com/dashcam"], request, focus: NO_FOCUS };
    const [answer] = await addFootage(fx.app, data, ID, adding, job);
    expect(answer).toBe("Put it after the intro.");

    const now = store.read(dir);
    // Recording 1 is the script's own footage; Recording 2 the link's, after it on the clock.
    expect(now.parts).toHaveLength(2);
    expect(now.parts![0]).toMatchObject({ title: "Traffic stop", startMs: 0, durationMs: lengthMs, url: "https://www.youtube.com/watch?v=4mqGp1IgqEw" });
    expect(now.parts![1]).toMatchObject({ title: "Dashcam", startMs: lengthMs, url: "https://news.example.com/dashcam", audio: false });
    expect(now.durationMs).toBeGreaterThanOrEqual(lengthMs + 1_900);
    expect((await media.streams(store.proxyPath(dir))).durationMs).toBeGreaterThanOrEqual(lengthMs + 1_900);
    // Heard whole from the download itself; its words on the script's clock, its voice its recording's.
    expect(heardFiles).toHaveLength(1);
    expect(heardFiles[0]).toEndWith("Dashcam [x1].mp4");
    const added = now.words.slice(2);
    expect(added.map((one) => one.text)).toEqual(["Hands", "up"]);
    expect(added[0]!.startMs).toBe(lengthMs + 200);
    expect(added.every((one) => one.speaker === "2:p9" && one.id.startsWith("w-"))).toBe(true);
    // The footage that was there keeps every time and voice.
    expect(now.words.slice(0, 2)).toEqual([word("license", 500), word("please", 1_000)]);
    expect(now.speakers).toMatchObject({ p1: "Driver", "2:p9": "Officer" });
    // Counted as heard exactly, and the whole file's hearing kept for Recording 1.
    expect(now.exact).toContainEqual([lengthMs, lengthMs + now.parts![1]!.durationMs]);
    expect(fs.existsSync(`${dir}/transcript/part-01/transcript.json`)).toBe(true);
    expect(now.revision).toBe(5);
    // Then Claude revised on the message, told which recording is new; the message is said once in the chat.
    expect(told[0]).toContain(request);
    expect(told[0]).toContain('Recording 2 ("Dashcam") is the footage from https://news.example.com/dashcam');
    expect(stages.some((stage) => stage.startsWith("Downloading “Dashcam”"))).toBe(true);
    expect(stages).toContain("Transcribing “Dashcam”");
    expect(stages.at(-1)).toBe("Editing the script");
    expect(chat.read(dir).filter((turn) => turn.role === "producer").map((turn) => turn.text)).toEqual([request]);
    // What it worked in is gone once it's in.
    expect(fs.existsSync(`${dir}/.added/footage.mp4`)).toBe(false);
    expect(fs.readdirSync(`${dir}/.added/segments`)).toEqual([]);

    // Edit finds it by its link, so Start the edit takes its words (Nov 11: a YouTube script's linked recording had no
    // source, its words weren't shared and Edit would have heard it again); a link Edit can't fetch is by its original.
    const { partSources } = await import("../../src/writer/parts.ts");
    const withYoutube = { ...now, parts: [now.parts![0]!, { ...now.parts![1]!, title: "Bodycam 4", url: "https://youtu.be/abcdefghijk" }] };
    expect(partSources(dir, withYoutube)).toEqual([["youtube:4mqGp1IgqEw", "Traffic stop [4mqGp1IgqEw].mp4"], ["youtube:abcdefghijk", "Bodycam 4 [abcdefghijk].mp4"]]);
    const original = `sha256:${"a".repeat(64)}`;
    const withPage = { ...now, parts: [now.parts![0]!, { ...now.parts![1]!, mediaSource: original, originalKey: `edit/originals/sha256/${"a".repeat(64)}/Dashcam [x1].mp4` }] };
    expect(partSources(dir, withPage)[1]).toEqual([original, "Dashcam [x1].mp4"]);

    // Start the edit gives each recording its voices' names: the script's own people ("p1", the turns pass's, no
    // recording mark) in Recording 1 as well (Nov 11: once a link made the script two recordings, Recording 1 went to
    // Edit with no speakers, and Edit's agent said its transcript didn't say who speaks).
    const { transcriptOf } = await import("../../src/writer/handoff.ts");
    const { recordings } = await import("../../src/writer/transcription.ts");
    const all = recordings(dir, now);
    const shared = all.map((one, index) => transcriptOf(dir, now, { file: null, source: `s${index}`, name: "x", offsetMs: one.offsetMs, lengthMs: one.lengthMs, tag: String(index + 1), key: one.key }));
    expect(shared[0]!.words.map((one) => one.speaker)).toEqual(["p1", "p1"]);
    expect(shared[0]!.speakers).toEqual({ p1: "Driver" });
    expect(shared[1]!.words.map((one) => one.speaker)).toEqual(["p9", "p9"]);
    expect(shared[1]!.speakers).toEqual({ p9: "Officer" });

    // Carried on after a restart, the same link isn't added twice, nor the message said again.
    await addFootage(fx.app, data, ID, adding, { ...job, resumed: true });
    expect(store.read(dir).parts).toHaveLength(2);
    expect(heardFiles).toHaveLength(1);
    expect(chat.read(dir).filter((turn) => turn.role === "producer")).toHaveLength(1);
  } finally {
    fx.cleanup();
  }
}, 120_000);

test("a Drive folder's recordings and an attached file join in one go, each a recording with its own voices; an article's link is left as words", async () => {
  const fx = fixtureHome("writer-links-folder");
  try {
    const { data, dir, lengthMs } = await aScript(fx);
    const cam = `${fx.dir}/cam.mp4`;
    make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=2", "-f", "lavfi", "-i", "sine=f=220:d=2", "-shortest"], cam);
    folder.file = cam;
    const size = fs.statSync(cam).size;
    folder.recordings = [
      { id: "1AaaaaaaaaaaaaaaaaaaA", name: "Body cam A.mp4", size, audio: false, claimedMs: 2_000, md5: null },
      { id: "1BbbbbbbbbbbbbbbbbbbB", name: "Body cam B.mp4", size, audio: false, claimedMs: 2_000, md5: null },
    ];
    // A sound file attached in the chat, uploaded to the script first.
    const call = `${fx.dir}/911 call.m4a`;
    make(["-f", "lavfi", "-i", "sine=f=440:d=1.5", "-c:a", "aac"], call);
    const { upload, name } = await receiveUpload(dir, new Request("http://localhost/", { method: "POST", body: fs.readFileSync(call) }), "911 call.m4a", fs.statSync(call).size);
    expect(name).toBe("911 call.m4a");
    // An article: yt-dlp finds no video on it.
    fs.writeFileSync(`${fx.dir}/yt-dlp`, `#!/bin/sh\necho "ERROR: Unsupported URL: https://news.example.com/story" >&2\nexit 1\n`, { mode: 0o755 });
    process.env.EDIT_YTDLP = `${fx.dir}/yt-dlp`;
    const request = "Use these for the arrest, per https://news.example.com/story: https://drive.google.com/drive/folders/1CaseFolderxxxxxxxx";
    const { footageLinks } = await import("../../src/writer/links.ts");
    const adding = { urls: footageLinks(request), files: [upload], request, focus: NO_FOCUS };
    expect(adding.urls).toEqual(["https://news.example.com/story", "https://drive.google.com/drive/folders/1CaseFolderxxxxxxxx"]);
    await addFootage(fx.app, data, ID, adding, jobOf());

    const now = store.read(dir);
    expect(now.parts!.map((part) => part.title)).toEqual(["Traffic stop", "Body cam A", "Body cam B", "911 call"]);
    // Each after the one before, on one clock; the folder's by their own Drive links, the file by its upload.
    expect(now.parts![1]).toMatchObject({ startMs: lengthMs, url: "https://drive.google.com/file/d/1AaaaaaaaaaaaaaaaaaaA/view" });
    expect(now.parts![2]!.startMs).toBe(lengthMs + now.parts![1]!.durationMs);
    expect(now.parts![3]).toMatchObject({ upload, audio: true });
    expect(now.parts![3]!.startMs).toBe(now.parts![2]!.startMs + now.parts![2]!.durationMs);
    expect(now.durationMs).toBeGreaterThanOrEqual(now.parts![3]!.startMs + now.parts![3]!.durationMs);
    // Heard straight by Scribe, each its own voices ("2:", "3:", "4:"), and the footage there before untouched.
    expect(heardFiles).toHaveLength(3);
    expect(now.words.slice(0, 2)).toEqual([word("license", 500), word("please", 1_000)]);
    expect(now.words.slice(2).map((one) => one.speaker)).toEqual(["2:p9", "2:p9", "3:p9", "3:p9", "4:p9", "4:p9"]);
    expect(now.words[2]!.startMs).toBe(lengthMs + 200);
    expect(now.exact).toHaveLength(3);
    // Claude is told each, the article left alone (no failure said for it).
    expect(told[0]).toContain('Recording 2 ("Body cam A") is the footage from https://drive.google.com/file/d/1AaaaaaaaaaaaaaaaaaaA/view');
    expect(told[0]).toContain('Recording 4 ("911 call") is the file attached to this message');
    expect(told[0]).not.toContain("couldn't be added");
    expect(chat.read(dir).some((turn) => turn.failed)).toBe(false);
    expect(chat.read(dir).find((turn) => turn.role === "producer")).toMatchObject({ text: request, files: ["911 call.m4a"] });
    // Signed out (no cloud to keep its original), the attached file stays here, the only copy beside the preview.
    expect(fs.existsSync(`${dir}/.added/uploads/${upload}`)).toBe(true);

    // Sent again (a restart carrying it on): nothing is added twice.
    await addFootage(fx.app, data, ID, adding, { ...jobOf(), resumed: true });
    expect(store.read(dir).parts).toHaveLength(4);
    expect(heardFiles).toHaveLength(3);
  } finally {
    fx.cleanup();
  }
}, 120_000);

test("the footage search's videos come in as a link's do, by what the Data API said of them, with no revision after, and never twice", async () => {
  const fx = fixtureHome("writer-links-found");
  try {
    const { addVideos } = await import("../../src/writer/links.ts");
    const { dir, lengthMs } = await aScript(fx);
    // Downloaded already (youtube.ts keeps a finished one by its .done), so no yt-dlp is asked.
    const folder = `${fx.app.store.driveDir()}/youtube/abcdefghijk`;
    fs.mkdirSync(folder, { recursive: true });
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2", "-f", "lavfi", "-i", "sine=f=330:d=2", "-shortest"], `${folder}/Trial Day 3 [abcdefghijk].mp4`);
    fs.writeFileSync(`${folder}/.done`, "Trial Day 3 [abcdefghijk].mp4");
    const url = "https://www.youtube.com/watch?v=abcdefghijk";
    const failed: string[] = [];
    const added = await addVideos(fx.app, dir, [{ url, title: "Esparza Trial Day 3", ms: 2_000 }], failed, jobOf());
    expect(failed).toEqual([]);
    expect(added.get(url)).toMatchObject({ number: 2, part: { title: "Esparza Trial Day 3", startMs: lengthMs, url } });
    expect(heardFiles).toHaveLength(1);
    expect(told).toEqual([]);
    // Asked again (a restart), it's in already.
    const again = await addVideos(fx.app, dir, [{ url, title: "Esparza Trial Day 3", ms: 2_000 }], failed, jobOf());
    expect(again.get(url)?.number).toBe(2);
    expect(store.read(dir).parts).toHaveLength(2);
    expect(heardFiles).toHaveLength(1);
  } finally {
    fx.cleanup();
  }
}, 120_000);

test("footage brought to a script not built yet comes in, then the first draft is written with the message as its note", async () => {
  const fx = fixtureHome("writer-links-build");
  try {
    const { data, dir } = await aScript(fx, false);
    const clip = `${fx.dir}/clip.mp4`;
    make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=1", "-f", "lavfi", "-i", "sine=d=1", "-shortest"], clip);
    const { upload } = await receiveUpload(dir, new Request("http://localhost/", { method: "POST", body: fs.readFileSync(clip) }), "clip.mp4", fs.statSync(clip).size);
    const [report] = await addFootage(fx.app, data, ID, { urls: [], files: [upload], build: true, request: "aim for 10 minutes", focus: NO_FOCUS }, jobOf());
    expect(report).toBe("First draft written.");
    expect(built).toEqual(["aim for 10 minutes"]);
    expect(store.read(dir).parts).toHaveLength(2);
    // Said as the build says it, so the build doesn't say it again.
    expect(chat.read(dir).filter((turn) => turn.role === "producer").map((turn) => turn.text)).toEqual(["Build the script. aim for 10 minutes"]);
  } finally {
    fx.cleanup();
  }
}, 120_000);

test("the chat's upload takes video or sound into the script, refuses anything else or what there's no room for, and a message with it adds it before revising", async () => {
  const fx = fixtureHome("writer-links-route");
  try {
    const { dir } = await aScript(fx);
    const router = buildRouter();
    const post = async (path: string, body: string | Uint8Array, json = false) => {
      const response = (await respond(fx.app, router, new Request(`http://localhost:7700${path}`, { method: "POST", headers: { host: "localhost:7700", "content-type": json ? "application/json" : "application/octet-stream" }, body }), null))!;
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    // Not footage: refused, nothing kept.
    const notes = new TextEncoder().encode("just some notes");
    const refused = await post(`/api/writer/scripts/${ID}/upload?name=notes.txt&size=${notes.length}`, notes);
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain("isn't video or sound");
    expect(fs.readdirSync(`${dir}/.added/uploads`)).toEqual([]);
    // No room for it: said with the numbers, before a byte is kept.
    const clip = `${fx.dir}/clip.mp4`;
    make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=1", "-f", "lavfi", "-i", "sine=d=1", "-shortest"], clip);
    const bytes = fs.readFileSync(clip);
    diskHooks.free = () => 1e6;
    const full = await post(`/api/writer/scripts/${ID}/upload?name=clip.mp4&size=${bytes.length}`, bytes);
    expect(full.status).toBe(400);
    expect(String(full.body.error)).toContain("GB free");
    diskHooks.free = () => Number.POSITIVE_INFINITY;
    // A clip: kept until the message that carries it.
    const landed = await post(`/api/writer/scripts/${ID}/upload?name=clip.mp4&size=${bytes.length}`, bytes);
    expect(landed.status).toBe(200);
    expect(landed.body.name).toBe("clip.mp4");
    const upload = String(landed.body.upload);
    expect(fs.existsSync(`${dir}/.added/uploads/${upload}/clip.mp4`)).toBe(true);
    // A message naming a file that isn't here is refused; one with the clip adds it, then revises.
    const gone = await post(`/api/writer/scripts/${ID}/revise`, JSON.stringify({ request: "Add this", files: ["00000000-0000-4000-8000-000000000000"] }), true);
    expect(gone.status).toBe(400);
    const started = await post(`/api/writer/scripts/${ID}/revise`, JSON.stringify({ request: "Add this clip after the intro", files: [upload] }), true);
    expect(started.status).toBe(200);
    expect(started.body.running).toBe(true);
    expect(started.body.stage).toBe("Adding the footage");
    for (let tries = 0; jobs.running(ID) && tries < 600; tries++) await Bun.sleep(100);
    expect(jobs.status(store.dataDir(fx.app.store.home), ID)).toMatchObject({ running: false, error: null, report: "Put it after the intro." });
    expect(store.read(dir).parts!.map((part) => part.title)).toEqual(["Traffic stop", "clip"]);
    expect(told[0]).toContain('Recording 2 ("clip") is the file attached to this message');
    // A message with no footage is a revision as before.
    const plain = await post(`/api/writer/scripts/${ID}/revise`, JSON.stringify({ request: "Tighten the intro" }), true);
    expect(plain.body.stage).toBe("Editing the script");
    for (let tries = 0; jobs.running(ID) && tries < 600; tries++) await Bun.sleep(100);
  } finally {
    fx.cleanup();
  }
}, 120_000);
