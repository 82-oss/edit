// Paid minutes on the local-first path (local_first.ts): a source imported whole is never heard whole as a side
// effect. A compilation-shaped Doc (three short stretches of a 12-minute YouTube video, no free words for it, as on
// Linux without captions) sends Scribe no more on the local path than today's excerpts did; a transcript the
// source already has (Script mode's) is taken, nothing heard; and a stretch the agent asks for outside the edit is
// heard then, that stretch only.

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";

import * as fs from "node:fs";
import { join } from "node:path";

import * as cloud from "../src/cloud.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { mediaTranscript } from "../src/broll.ts";
import * as jobs from "../src/jobs.ts";
import * as localFirst from "../src/local_first.ts";
import type { Probe } from "../src/model.ts";
import { useNative, wrap } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import * as relay from "../src/relay.ts";
import * as seams from "../src/seams.ts";
import { Jobs, start } from "../src/script.ts";
import * as tools from "../src/tools.ts";
import * as transcribe from "../src/transcribe.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome, scratch, type Fixture } from "./helpers/home.ts";
import { MockServer, scribeAnswer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
let clips: { dir: string; cleanup(): void };
let source: string;
const LENGTH = 720;
/** Three cases of a compilation: 18 s each, minutes apart, not on a keyframe (YouTube's are 5 s apart here). */
const RANGES: [number, number][] = [[62, 80], [302, 320], [602, 620]];

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token", EDIT_CLOUD_HOLDER: undefined });
  cloud.timing.sleep = async () => {};
  transcribe.timing.instant = true;
  clips = scratch("local-first-minutes");
  source = join(clips.dir, "long.mp4");
  const made = Bun.spawnSync([
    tools.ffmpeg(), "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=160x90:rate=5:duration=${LENGTH}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${LENGTH}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0",
    "-c:a", "aac", "-ac", "1", "-b:a", "32k", "-shortest", "-movflags", "+faststart", source,
  ]);
  if (made.exitCode !== 0) throw new Error(`ffmpeg: ${made.stderr.toString()}`);
}, 120_000);

afterAll(() => {
  clips.cleanup();
  restore();
  mock.stop();
});

/** A home whose addon probes files as they are and "makes" a cloud proxy by copying (the stub has no encoder). */
function home(name: string): Fixture {
  const fixture = fixtureHome(name, { services: { scripts: new Jobs() } });
  // This server's loopback, which every cloud media's path names (cloud_playback.ts).
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(fixture.app, router, request, null)) ?? new Response(null, { status: 404 }) });
  fixture.app.port = server.port!;
  const cleanup = fixture.cleanup;
  fixture.cleanup = () => {
    void server.stop(true);
    cleanup();
  };
  const raw = createStub();
  raw.init({ home: fixture.home, cacheDir: `${fixture.home}/cache`, ffmpeg: "ffmpeg", ffprobe: "ffprobe", log: () => {} });
  raw.makeCloudProxy = async (from: string, _probe: Probe, out: string) => void fs.copyFileSync(from, out);
  useNative(wrap(raw));
  mock.cloud.objects.clear();
  mock.cloud.convex.media.clear();
  cloudMedia.configurePlayback(fixture.app);
  return fixture;
}

/** A stand-in yt-dlp that "downloads" the long video; it has no captions to give. */
function fakeYtDlp(dir: string): string {
  const binary = join(dir, "yt-dlp");
  fs.writeFileSync(binary, `#!/bin/sh
for arg in "$@"; do if [ "$prev" = '-P' ]; then out="$arg"; fi; prev="$arg"; done
[ -n "$out" ] || exit 1
cp '${source}' "$out/long.mp4"
echo "EDIT-FILE $out/long.mp4"
`, { mode: 0o755 });
  return binary;
}

/** Seconds of sound sent to Scribe since call `from` (each request's audio, measured). */
function secondsSent(dir: string, from: number): number {
  let total = 0;
  for (const [n, call] of mock.calls("/v1/transcribe", "POST").slice(from).entries()) {
    const at = join(dir, `sent-${from}-${n}.ogg`);
    fs.writeFileSync(at, call.body);
    const out = Bun.spawnSync([tools.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", at]).stdout.toString().trim();
    total += Number(out);
  }
  return Math.round(total);
}

const sentCount = () => mock.calls("/v1/transcribe", "POST").length;

/** The Doc: three cases of one YouTube video, each with its words to cut on. */
function doc(video: string) {
  return {
    blocks: RANGES.map(([from, to]) => ({ kind: "footage" as const, file: `youtube:${video}`, url: `https://youtu.be/${video}`, start: from, end: to, label: `${from}–${to}`, words: ["Hello", "there."] as [string, string] })),
  };
}

/** Imports `doc(video)` into a project (a V1 one: today's path; a channel project: the local path), and the seconds sent to Scribe for it. */
async function imported(fixture: Fixture, video: string, channel: boolean): Promise<{ id: string; seconds: number }> {
  const id = channel ? fixture.store.createAs("local", "bodycam", { width: 1280, height: 720, fps: 30 }, true).project.id : fixture.store.create("today", { width: 1280, height: 720, fps: 30 }).project.id;
  await fixture.store.update(id, "test", (project) => {
    if (channel) project.channel = "ch-test";
    project.script = doc(video);
  });
  const before = sentCount();
  await start(fixture.app, id, false);
  expect((fixture.app.scripts as Jobs).get(id)!.state).toBe("done");
  return { id, seconds: secondsSent(fixture.dir, before) };
}

/** What the test changes for every import: the relay on, no research, the stand-in yt-dlp, no working copy encode. */
function setUp(fixture: Fixture): () => void {
  const previous = process.env.EDIT_YTDLP;
  process.env.EDIT_YTDLP = fakeYtDlp(fixture.dir);
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const run = localFirst.hooks.run;
  // The working copy isn't what's measured here: its making stops at once.
  localFirst.hooks.run = async () => {
    throw new jobs.Gone("not made in this test");
  };
  mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["Hello", "there."])));
  return () => {
    localFirst.hooks.run = run;
    localFirst.reset();
    enabled.mockRestore();
    researched.mockRestore();
    if (previous === undefined) delete process.env.EDIT_YTDLP;
    else process.env.EDIT_YTDLP = previous;
  };
}

test("a compilation's import sends Scribe no more on the local path than today's excerpts did, never the whole source", async () => {
  const fixture = home("minutes-both-paths");
  const undo = setUp(fixture);
  try {
    const today = await imported(fixture, "todayPath01", false);
    const local = await imported(fixture, "localPath01", true);
    const project = fixture.store.get(local.id)!.project;
    expect(project.local_media).toBe(true);
    expect(project.media.length).toBe(1);
    // Today: each excerpt (the range, 10 s either side, from the keyframe before) heard whole: 3 × 40 s.
    expect(today.seconds).toBe(120);
    // Local: the same ranges with the same handles, heard once, joined (a second of quiet between): 3 × 38 s + 2 s.
    expect(local.seconds).toBeLessThanOrEqual(today.seconds);
    expect(local.seconds).toBe(116);
    // What it heard is what the edit keeps; nothing else of the 12 minutes has words.
    const transcript = JSON.parse(fs.readFileSync(fixture.app.media.paths(project.media[0]!.path).transcript, "utf8")) as transcribe.Transcript;
    expect(transcript.heard).toEqual([[52, 90], [292, 330], [592, 630]]);
    expect(transcript.rough).toBe("none");
  } finally {
    undo();
    fixture.cleanup();
  }
}, 120_000);

test("a source Script mode heard already takes its words on the local path: nothing sent", async () => {
  const fixture = home("minutes-script-mode");
  const undo = setUp(fixture);
  try {
    // Script mode heard the recording whole (writer: its words at the recording's own analysis).
    const words = Array.from({ length: 300 }, (_, n) => ({ text: n % 2 === 0 ? "Hello" : "there.", start: n * 2, end: n * 2 + 0.5, speaker: "speaker_0" }));
    mock.cloud.put("edit/analysis/youtube/scriptMode1/transcript.json", JSON.stringify({ model: "scribe_v3", words }));
    const local = await imported(fixture, "scriptMode1", true);
    expect(local.seconds).toBe(0);
    const project = fixture.store.get(local.id)!.project;
    const transcript = JSON.parse(fs.readFileSync(fixture.app.media.paths(project.media[0]!.path).transcript, "utf8")) as transcribe.Transcript;
    expect([transcript.model, transcript.words.length, transcript.heard]).toEqual(["scribe_v3", 300, undefined]);
  } finally {
    undo();
    fixture.cleanup();
  }
}, 120_000);

test("the agent asking for a stretch outside the edit has it heard then, that stretch only, once", async () => {
  const fixture = home("minutes-asked");
  const undo = setUp(fixture);
  try {
    const local = await imported(fixture, "askedPath01", true);
    const media = fixture.store.get(local.id)!.project.media[0]!;
    const before = sentCount();
    mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["(cut)", "Outside", "the", "edit."])), 1);
    await mediaTranscript(fixture.app, media, 400, 420, false);
    // 400–420 s with 3 s either side, its words where Scribe heard them (the stand-in answers at its start).
    expect(secondsSent(fixture.dir, before)).toBe(26);
    const transcript = JSON.parse(fs.readFileSync(fixture.app.media.paths(media.path).transcript, "utf8")) as transcribe.Transcript;
    expect(transcript.heard).toContainEqual([397, 423]);
    expect(await mediaTranscript(fixture.app, media, 397, 423, false)).toContain("Outside the edit.");
    // Asked again, or for what the edit keeps: nothing more.
    const again = sentCount();
    await mediaTranscript(fixture.app, media, 405, 415, false);
    await mediaTranscript(fixture.app, media, 62, 80, false);
    expect(sentCount()).toBe(again);
  } finally {
    undo();
    fixture.cleanup();
  }
}, 120_000);
