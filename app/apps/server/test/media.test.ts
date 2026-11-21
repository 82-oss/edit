import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import { isImagePath, isLocalCopy, isMediaPath, makeThumbs, Processor, Semaphore } from "../src/media.ts";
import type { MediaStatus } from "../src/media.ts";
import type { CachePaths } from "../src/native/index.ts";
import * as steps from "../src/import_steps.ts";
import * as tools from "../src/tools.ts";
import { timing } from "../src/transcribe.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv();
  timing.instant = true;
  tools.forget();
});

afterAll(() => {
  restore();
  mock.stop();
});

test("what imports as media", () => {
  expect(isMediaPath("/a/B.MOV")).toBe(true);
  expect(isMediaPath("/a/b.opus")).toBe(true);
  expect(isMediaPath("/a/b.png")).toBe(false);
  expect(isImagePath("/a/b.JPG")).toBe(true);
  expect(isImagePath("/a/.png")).toBe(false);
  expect(isLocalCopy("/home/cache", "/home/cache/cloud/proxies/x.mp4")).toBe(true);
  expect(isLocalCopy("/home/cache", "/home/cache/cloudy/x.mp4")).toBe(false);
});

test("a semaphore lets one through at a time", async () => {
  const slots = new Semaphore(1);
  const order: string[] = [];
  await Promise.all(
    ["a", "b", "c"].map((name) =>
      slots.with(async () => {
        order.push(`${name} in`);
        await Bun.sleep(1);
        order.push(`${name} out`);
      }),
    ),
  );
  expect(order).toEqual(["a in", "a out", "b in", "b out", "c in", "c out"]);
});

test("an urgent wait goes ahead of the background work in line, never ahead of the one running", async () => {
  const slots = new Semaphore(1);
  const order: string[] = [];
  const job = (name: string, urgent = false) =>
    slots.with(async () => {
      order.push(name);
      await Bun.sleep(1);
    }, urgent);
  await Promise.all([job("fill 1"), job("fill 2"), job("fill 3"), job("viewer", true)]);
  expect(order).toEqual(["fill 1", "viewer", "fill 2", "fill 3"]);
});

test("a file opened with only its thumbnails and waveform to make waits for a play to end; one that needs its preview copy doesn't", async () => {
  const playing = await import("../src/playing.ts");
  const { dir, app, cleanup } = fixtureHome("media-plays");
  playing.reset();
  const poll = playing.hooks.pollMs;
  playing.hooks.pollMs = 5;
  try {
    const picture = `${dir}/still.png`;
    const clip = `${dir}/clip.mp4`;
    fs.writeFileSync(picture, "a picture");
    fs.writeFileSync(clip, "a clip");
    playing.note("p", true);
    app.media.ensure(picture, { kind: "image", duration: 5, width: 640, height: 360, fps: 30, has_audio: false } as never);
    app.media.ensure(clip, { kind: "video", duration: 5, width: 640, height: 360, fps: 30, has_audio: false } as never);
    // The import's preview copy is under way beside the play (once the shared slot is free); the picture's thumbnails wait.
    for (let waited = 0; app.media.status(clip).thumbs === "pending" && waited < 5_000; waited += 10) await Bun.sleep(10);
    expect(app.media.status(clip).thumbs).not.toBe("pending");
    await Bun.sleep(20);
    expect(app.media.status(picture).thumbs).toBe("pending");
    playing.note("p", false);
    await Bun.sleep(40);
    expect(app.media.status(picture).thumbs).toBe("ready");
  } finally {
    playing.hooks.pollMs = poll;
    playing.reset();
    cleanup();
  }
});

/** Waits for `source`'s stages to settle (none pending or working), from its `media` events. */
function settled(store: { subscribe: (fn: (event: Record<string, unknown>) => void) => () => void }, source: string, done: (status: MediaStatus) => boolean): Promise<MediaStatus> {
  return new Promise((resolve) => {
    const stop = store.subscribe((event) => {
      if (event.type !== "media" || event.path !== source) return;
      const status = event.status as MediaStatus;
      if (done(status)) {
        stop();
        resolve(status);
      }
    });
  });
}

// Real thumbnails, waveform and previews: seconds on a 2-core runner with no GPU and a debug addon, more than the 5 s default.
test.skipIf(ffmpeg === null)("footage gets thumbnails, a waveform, previews and (asked) a transcript", async () => {
  const { dir, app, store, cleanup } = fixtureHome("media-processor");
  try {
    const source = `${dir}/clip.mp4`;
    const made = Bun.spawnSync([
      ffmpeg!,
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=30:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-shortest",
      "-c:v",
      "libx264",
      "-g",
      "15",
      "-c:a",
      "aac",
      source,
    ]);
    expect(made.exitCode).toBe(0);
    const probe = await app.native.probe(source);
    expect([probe.kind, probe.has_audio, probe.width, probe.height]).toEqual(["video", true, 320, 180]);
    const done = settled(store, source, (status) => status.light === "ready" || status.light === "failed");
    app.media.ensure(source, probe);
    app.media.ensure(source, probe); // safe to ask again while it runs
    const status = await done;
    expect([status.thumbs, status.peaks, status.proxy, status.light]).toEqual(["ready", "ready", "ready", "ready"]);
    expect(status.thumb_count).toBeGreaterThan(0);
    const paths = app.media.paths(source);
    expect(fs.existsSync(paths.thumbs)).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.thumbsMeta, "utf8")).count).toBe(status.thumb_count);
    // Read back from disk by a fresh processor (a restarted server).
    const fresh = new Processor(store).status(source);
    expect([fresh.thumbs, fresh.peaks, fresh.proxy, fresh.light, fresh.thumb_count]).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
      status.thumb_count,
    ]);

    const transcribed = settled(store, source, (s) => s.transcript === "ready" || s.transcript === "failed");
    expect(app.media.transcribe(source, true).transcript).toBe("working");
    // A second ask while it runs doesn't pay twice.
    expect(app.media.transcribe(source, true).transcript).toBe("working");
    expect((await transcribed).transcript).toBe("ready");
    expect(mock.calls("/v1/transcribe").length).toBe(1);
    expect(app.media.transcribe(source, true).transcript).toBe("ready");
    expect(app.media.transcribe(`${dir}/silent.mp4`, false).transcript).toBe("pending");
  } finally {
    cleanup();
  }
}, 60_000);

test.skipIf(ffmpeg === null)("the transcription plan out of credit: the file waits, says why and when, and is heard by itself once it's back", async () => {
  // It failed for good with the raw words (Nov 16 audit): the agent read "couldn't be transcribed", nothing tried again.
  const { dir, app, store, cleanup } = fixtureHome("media-credit");
  const every = steps.QUOTA_RETRY_MS.value;
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]).exitCode).toBe(0);
    steps.QUOTA_RETRY_MS.value = 300;
    const asked = mock.calls("/v1/transcribe").length;
    mock.on("POST", "/v1/transcribe", () => Response.json({ error: "ElevenLabs transcription failed (401): This request exceeds your quota of 0. You have 0 credits remaining. (quota_exceeded)" }, { status: 401 }), 1);
    const waiting = settled(store, source, (s) => s.transcript === "waiting" || s.transcript === "failed" || s.transcript === "ready");
    app.media.transcribe(source, true);
    const said = await waiting;
    expect(said.transcript).toBe("waiting");
    expect(said.transcript_error).toStartWith("The transcription plan (ElevenLabs) is out of credit: an admin adds credit, and Edit tries again by itself at");
    expect(said.transcript_retry_at).toBeGreaterThan(Date.now());
    // The agent's "Not transcribed yet" names why.
    expect(app.media.unheard(source, "tone.wav")).toContain("tone.wav (The transcription plan (ElevenLabs) is out of credit");
    // Asked again before its time: not asked into the same refusal.
    expect(app.media.transcribe(source, true).transcript).toBe("waiting");
    expect(mock.calls("/v1/transcribe").length).toBe(asked + 1);
    // Its time comes: heard by itself.
    const heard = await settled(store, source, (s) => s.transcript === "ready" || s.transcript === "failed");
    expect(heard.transcript).toBe("ready");
    expect(heard.transcript_error).toBeUndefined();
    expect(mock.calls("/v1/transcribe").length).toBe(asked + 2);
  } finally {
    steps.QUOTA_RETRY_MS.value = every;
    cleanup();
  }
}, 30_000);

test("a failed step says why and the rest go on", async () => {
  const { dir, app, store, cleanup } = fixtureHome("media-failure");
  try {
    const source = `${dir}/not-really.mp4`;
    fs.writeFileSync(source, "not a video");
    const done = settled(store, source, (status) => status.light === "skipped" || status.proxy === "ready");
    app.media.ensure(source, { kind: "video", duration: 2, width: 320, height: 180, fps: 30, has_audio: false });
    const status = await done.catch(() => app.media.status(source));
    expect(status.thumbs).toBe("failed");
    expect(status.peaks).toBe("skipped");
    expect(status.proxy).toBe("ready");
  } finally {
    cleanup();
  }
}, 60_000);

test.skipIf(ffmpeg === null)("a pieced proxy's thumbnails, waveform, censor check and loudness read its original, kept as the proxy's", async () => {
  // Reading the pieced proxy itself would make every piece of it (off Modal).
  const { dir, app, store, cleanup } = fixtureHome("media-analysis-input");
  const { mediaHooks } = await import("../src/media.ts");
  const { native } = await import("../src/native/index.ts");
  const was = mediaHooks.analysisInput;
  const censor = native().censorWarm;
  const analyseFrom = native().analyseFrom;
  const warmed: [string, string | null | undefined][] = [];
  const redirected: [string, string | null | undefined][] = [];
  try {
    const original = `${dir}/original.mp4`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-c:v", "libx264", "-g", "15", "-c:a", "aac", original]);
    expect(made.exitCode).toBe(0);
    // The source the editor uses, standing in for the pieced proxy: not readable itself.
    const source = `${dir}/pieced.mp4`;
    fs.writeFileSync(source, "not a video");
    mediaHooks.analysisInput = async (asked) => (asked === source ? original : null);
    native().censorWarm = (path, read) => void warmed.push([path, read]);
    native().analyseFrom = (path, read) => void redirected.push([path, read]);
    const probe = await app.native.probe(original);
    const done = settled(store, source, (status) => status.light !== "pending" && status.light !== "working" && status.proxy !== "working");
    app.media.ensure(source, probe);
    const status = await done;
    expect([status.thumbs, status.peaks]).toEqual(["ready", "ready"]);
    expect(fs.existsSync(app.media.paths(source).thumbs)).toBe(true);
    // The censor check waits for the agent (warmForAgent), never an import or an open.
    await Bun.sleep(20);
    expect(warmed).toEqual([]);
    app.media.warmForAgent([{ path: source, name: "pieced.mp4", ...probe }]);
    await Bun.sleep(20);
    expect(warmed).toEqual([[source, original]]);
    // The engine's own analyses (loudness) are told, once.
    expect(redirected).toEqual([[source, original]]);
  } finally {
    mediaHooks.analysisInput = was;
    native().censorWarm = censor;
    native().analyseFrom = analyseFrom;
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("a streamed preview's censor check reads its whole copy here once it's come, never the stream, even when the copy can't come (the M4, Nov 16 and 17: \"Input/output error\")", async () => {
  const { dir, app, store, cleanup } = fixtureHome("media-censor-copy");
  const { mediaHooks } = await import("../src/media.ts");
  const { native } = await import("../src/native/index.ts");
  const was = mediaHooks.censorInput;
  const censor = native().censorWarm;
  const warmed: [string, string | null | undefined][] = [];
  try {
    const source = `${dir}/streamed.mp4`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-c:v", "libx264", "-g", "15", source]);
    expect(made.exitCode).toBe(0);
    let land: (path: string) => void = () => {};
    mediaHooks.censorInput = (asked) => (asked === source ? new Promise<string>((resolve) => (land = resolve)) : null);
    native().censorWarm = (path, read) => void warmed.push([path, read]);
    const probe = await app.native.probe(source);
    const done = settled(store, source, (status) => status.light !== "pending" && status.light !== "working" && status.proxy !== "working");
    app.media.ensure(source, probe);
    await done;
    app.media.warmForAgent([{ path: source, name: "streamed.mp4", ...probe }]);
    await Bun.sleep(20);
    // Not started on the stream while the copy comes.
    expect(warmed).toEqual([]);
    land(`${dir}/whole.mp4`);
    await Bun.sleep(10);
    expect(warmed).toEqual([[source, `${dir}/whole.mp4`]]);
    // A copy that can't come (no room for it, its fetch failing): never read from the stream instead (Sphe's M4,
    // Nov 17), and asked for again at the agent's next look.
    const short = `${dir}/short.mp4`;
    fs.copyFileSync(source, short);
    let asked = 0;
    mediaHooks.censorInput = (path) => {
      if (path !== short) return null;
      asked += 1;
      return Promise.reject(new Error("the disk too full to keep it whole"));
    };
    app.media.warmForAgent([{ path: short, name: "short.mp4", ...probe }]);
    await Bun.sleep(30);
    expect(asked).toBe(1);
    expect(warmed).toEqual([[source, `${dir}/whole.mp4`]]);
    app.media.warmForAgent([{ path: short, name: "short.mp4", ...probe }]);
    await Bun.sleep(30);
    expect(asked).toBe(2);
    expect(warmed).toEqual([[source, `${dir}/whole.mp4`]]);
  } finally {
    mediaHooks.censorInput = was;
    native().censorWarm = censor;
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("long footage's thumbnails are each read where they are, one a frame past the end its neighbour's", async () => {
  const { dir, app, cleanup } = fixtureHome("media-long-thumbs");
  try {
    // 50 minutes at 1 fps, a keyframe every 5 s: 120 thumbnails, 25 s apart.
    const file = `${dir}/long.mp4`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x36:rate=1:duration=3000", "-c:v", "mpeg4", "-g", "5", file]);
    expect(made.exitCode).toBe(0);
    const probe = await app.native.probe(file);
    // Probed a minute longer than it is: the last thumbnails are past its end.
    const paths = { thumbs: `${dir}/thumbs.jpg`, thumbsMeta: `${dir}/thumbs.json` } as CachePaths;
    const count = await makeThumbs(file, { ...probe, duration: 3060 }, paths);
    expect(count).toBe(120);
    expect(JSON.parse(fs.readFileSync(paths.thumbsMeta, "utf8"))).toEqual({ count: 120, interval: 25.5 });
    const strip = await app.native.probe(paths.thumbs);
    expect([strip.width, strip.height]).toEqual([128 * 120, 72]);
    expect(fs.existsSync(`${dir}/thumbs.frames`)).toBe(false);
  } finally {
    cleanup();
  }
}, 60_000);

test("a streamed proxy the cloud didn't have yet is playable once its upload lands", async () => {
  // Nov 11: a dropped file's proxy is uploaded just after the drop returns; the first ask found nothing,
  // and the file stayed "Its proxy isn't in the cloud" for good (its background watch skipped it too).
  const { mediaHooks, MISSING_IN_CLOUD } = await import("../src/media.ts");
  const { setSystemTime } = await import("bun:test");
  const { store, cleanup } = fixtureHome("media-missing");
  const was = mediaHooks.keyAnswers;
  const hex = "7b7767985de7eb1e5e4fcf0c202146b64ce305b0e1f6a970d93bdcb9bcc7a357";
  const source = `http://127.0.0.1:7731/api/cloud/preview?key=${encodeURIComponent(`edit/proxies/sha256/${hex}.mp4`)}`;
  let uploaded = false;
  const asked: boolean[] = [];
  try {
    mediaHooks.keyAnswers = async () => {
      asked.push(uploaded);
      return uploaded;
    };
    const media = new Processor(store);
    const events: MediaStatus[] = [];
    const stop = store.subscribe((event) => {
      if (event.type === "media" && event.path === source) events.push(event.status as MediaStatus);
    });
    media.ensure(source, { kind: "video", duration: 400, width: 1280, height: 720, fps: 30, has_audio: true } as never);
    media.status(source);
    await Bun.sleep(20);
    expect(media.status(source)).toMatchObject({ proxy: "failed", error: MISSING_IN_CLOUD });
    // The upload lands; while the "not there" answer is fresh nothing is asked again.
    uploaded = true;
    media.status(source);
    await Bun.sleep(20);
    expect(asked).toEqual([false]);
    // Once it's old, the next look asks again and the file is playable.
    setSystemTime(new Date(Date.now() + 61_000));
    media.status(source);
    await Bun.sleep(20);
    expect(asked).toEqual([false, true]);
    expect(media.status(source)).toMatchObject({ proxy: "ready", proxy_progress: 1 });
    expect(media.status(source).error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ proxy: "ready" });
    stop();
  } finally {
    setSystemTime();
    mediaHooks.keyAnswers = was;
    cleanup();
  }
});

// Nov 21, a MacBook Air on main: a one-minute file just imported read "failed: Its proxy isn't in the cloud", with
// Export offering its parts black, for a minute, and once for four (until a restart), its proxy up after 7 s. The
// cloud was asked while the import's upload was still on its way, and an answer already at hand never took the
// failure back.
const streamed = (hex: string) => `http://127.0.0.1:7731/api/cloud/preview?key=${encodeURIComponent(`edit/proxies/sha256/${hex}.mp4`)}`;
const VIDEO = { kind: "video", duration: 60, width: 1280, height: 720, fps: 30, has_audio: true } as never;

test("a proxy on its way up from this computer is never called missing, and is there the moment its upload ends, unasked", async () => {
  const { mediaHooks, keyIsThere } = await import("../src/media.ts");
  const { store, cleanup } = fixtureHome("media-going-up");
  const was = { answers: mediaHooks.keyAnswers, going: mediaHooks.goingUp };
  const hex = "1b7767985de7eb1e5e4fcf0c202146b64ce305b0e1f6a970d93bdcb9bcc7a351";
  const source = streamed(hex);
  let going = true;
  let asked = 0;
  try {
    mediaHooks.goingUp = () => going;
    mediaHooks.keyAnswers = async () => {
      asked += 1;
      return false;
    };
    const media = new Processor(store);
    media.ensure(source, VIDEO);
    for (let n = 0; n < 3; n++) {
      expect(media.status(source).error).toBeUndefined();
      await Bun.sleep(10);
    }
    expect(media.status(source).proxy).not.toBe("failed");
    expect(asked).toBe(0);
    // Its upload ends (cloud_media.ts `runUpload`).
    keyIsThere(`edit/proxies/sha256/${hex}.mp4`);
    going = false;
    expect(media.status(source)).toMatchObject({ proxy: "ready" });
    expect(asked).toBe(0);
  } finally {
    mediaHooks.keyAnswers = was.answers;
    mediaHooks.goingUp = was.going;
    cleanup();
  }
});

test("a file called missing is playable at the next look once its key is known to be there, without a new ask", async () => {
  const { mediaHooks, keyIsThere, MISSING_IN_CLOUD } = await import("../src/media.ts");
  const { store, cleanup } = fixtureHome("media-known-there");
  const was = mediaHooks.keyAnswers;
  const hex = "2b7767985de7eb1e5e4fcf0c202146b64ce305b0e1f6a970d93bdcb9bcc7a352";
  const source = streamed(hex);
  let asked = 0;
  try {
    mediaHooks.keyAnswers = async () => {
      asked += 1;
      return false;
    };
    const media = new Processor(store);
    media.ensure(source, VIDEO);
    media.status(source);
    await Bun.sleep(20);
    expect(media.status(source)).toMatchObject({ proxy: "failed", error: MISSING_IN_CLOUD });
    keyIsThere(`edit/proxies/sha256/${hex}.mp4`);
    expect(media.status(source)).toMatchObject({ proxy: "ready", proxy_progress: 1 });
    expect(media.status(source).error).toBeUndefined();
    expect(asked).toBe(1);
  } finally {
    mediaHooks.keyAnswers = was;
    cleanup();
  }
});

test("a \"not there\" asked before its upload ended and answered after doesn't fail a file that is there", async () => {
  const { mediaHooks, keyIsThere } = await import("../src/media.ts");
  const { store, cleanup } = fixtureHome("media-old-answer");
  const was = mediaHooks.keyAnswers;
  const hex = "3b7767985de7eb1e5e4fcf0c202146b64ce305b0e1f6a970d93bdcb9bcc7a353";
  const source = streamed(hex);
  let answer: (there: boolean) => void = () => {};
  try {
    mediaHooks.keyAnswers = () => new Promise<boolean>((resolve) => (answer = resolve));
    const media = new Processor(store);
    media.ensure(source, VIDEO);
    media.status(source);
    await Bun.sleep(5);
    keyIsThere(`edit/proxies/sha256/${hex}.mp4`);
    answer(false);
    await Bun.sleep(20);
    expect(media.status(source)).toMatchObject({ proxy: "ready" });
    expect(media.status(source).error).toBeUndefined();
  } finally {
    mediaHooks.keyAnswers = was;
    cleanup();
  }
});
