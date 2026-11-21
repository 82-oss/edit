// Exports made ahead (export_ahead.ts, exports.ts `startAhead`): made quietly
// once an edit rests, given up to anything someone asks for, then reused.

import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import * as channels from "../src/channels.ts";
import * as cloud from "../src/cloud.ts";
import * as ahead from "../src/export_ahead.ts";
import { aheadFile, exportCloud, ExportRegistry } from "../src/exports.ts";
import type { Project } from "../src/model.ts";
import * as diag from "../src/diag.ts";
import * as effects from "../src/effects.ts";
import { saveExportFolder } from "../src/export_folder.ts";
import { findAddon, native, useNative, wrap, type Native } from "../src/native/index.ts";
import * as removalSchedule from "../src/removal_schedule.ts";
import * as reviews from "../src/reviews.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

type Started = { name: string; output: string; background: boolean; cancelled: boolean; release: () => void };

function setUp(name: string) {
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "1";
  const fixture = fixtureHome(name);
  const { home, store, app, native } = fixture;
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const started: Started[] = [];
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const one: Started = { name: JSON.parse(job.project.json).name as string, output: job.output, background: (job as { background?: boolean }).background === true, cancelled: false, release };
    started.push(one);
    return {
      cancel: () => { one.cancelled = true; release(); },
      wait: async () => {
        await done;
        if (one.cancelled) throw new Error("cancelled");
        fs.writeFileSync(job.output, "export");
        return { seconds: 1, bytes: 6 };
      },
    };
  });
  const project = async (title: string): Promise<Project> => {
    const id = store.create(title, { width: 64, height: 36, fps: 30 }).project.id;
    // Its footage is here: an export waits for footage that isn't (missing_media.ts).
    fs.writeFileSync(`${home}/shot.mp4`, "footage");
    await store.update(id, "test", (p) => {
      p.media.push(media({ id: "m1", name: "shot.mp4", path: `${home}/shot.mp4`, kind: "video", duration: 10 }));
      p.clips.push(clip({ id: "shot", track: p.tracks[0]!.id, start: 0, duration: 30, type: "video", media: "m1", source_in: 0 }));
    });
    return structuredClone(store.get(id)!.project);
  };
  const settle = async (until: () => boolean) => {
    for (let tries = 0; !until() && tries < 200; tries++) await Bun.sleep(2);
  };
  return {
    ...fixture, registry, started, project, settle,
    done: () => {
      for (const one of started) one.release();
      render.mockRestore(); archive.mockRestore(); plan.mockRestore();
      if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
      else process.env.EDIT_LOCAL_EXPORTS = most;
      fixture.cleanup();
    },
  };
}

test("an export made ahead is quiet, and the export asked for stops it, then spends its file", async () => {
  const t = setUp("ahead-quiet");
  try {
    const project = await t.project("Cops");
    const options = t.native.exportDefaults();
    const file = aheadFile(t.store.cacheDir(), project.id);
    expect(t.registry.startAhead(t.store, t.app.library, project, options, file)).toBe(true);
    await t.settle(() => t.started.length === 1);
    // In the background, and nothing anyone waits on: not listed, not "an export", not one to follow.
    expect(t.started[0]).toMatchObject({ name: "Cops", output: file, background: true });
    expect(t.registry.activity()).toEqual([]);
    expect(t.registry.running()).toBe(false);
    expect(t.registry.localRunning()).toBe(false);
    expect(t.registry.runningFor(project.id)).toBeNull();
    expect(t.registry.aheadFor()).toBe(project.id);
    // Only one at a time.
    expect(t.registry.startAhead(t.store, t.app.library, await t.project("Other"), options, aheadFile(t.store.cacheDir(), "other"))).toBe(false);
    // Finished: its file, and a note of what it shows.
    t.started[0]!.release();
    await t.settle(() => t.registry.aheadFor() === null && fs.existsSync(`${file}.json`));
    expect(fs.readFileSync(file, "utf8")).toBe("export");
    expect(JSON.parse(fs.readFileSync(`${file}.json`, "utf8")).timeline).toBeString();
    expect(t.registry.activity()).toEqual([]);
    // Made again of a newer picture, then someone exports: the one made ahead stops first, and the export runs.
    expect(t.registry.startAhead(t.store, t.app.library, project, options, file)).toBe(true);
    await t.settle(() => t.started.length === 3);
    const output = `${t.dir}/Cops.mp4`;
    await t.registry.start(t.store, t.app.library, project, options, output, { drive: false, keepLocal: true });
    expect(t.started.find((one) => one.output === file && one !== t.started[0])?.cancelled).toBe(true);
    await t.settle(() => t.started.some((one) => one.output === output));
    expect(t.registry.running()).toBe(true);
    t.started.find((one) => one.output === output)!.release();
    await t.settle(() => !t.registry.running());
    expect(t.registry.activity().find((one) => one.id === project.id)?.state).toBe("done");
    // The export's manifest is the one now: the file made ahead is spent.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.json`)).toBe(false);
  } finally {
    t.done();
  }
});

test("an export of another project, or smooth playback for someone watching, takes the encoder from one made ahead", async () => {
  const t = setUp("ahead-yields");
  try {
    const first = await t.project("First");
    const second = await t.project("Second");
    const options = t.native.exportDefaults();
    expect(t.registry.startAhead(t.store, t.app.library, first, options, aheadFile(t.store.cacheDir(), first.id))).toBe(true);
    await t.settle(() => t.started.length === 1);
    // The Mac renders one at a time: the export asked for has it.
    const output = `${t.dir}/Second.mp4`;
    await t.registry.start(t.store, t.app.library, second, options, output, { drive: false, keepLocal: true });
    await t.settle(() => t.started.some((one) => one.output === output));
    expect(t.started[0]!.cancelled).toBe(true);
    expect(t.registry.aheadFor()).toBeNull();
    // Not while an export runs.
    expect(t.registry.startAhead(t.store, t.app.library, first, options, aheadFile(t.store.cacheDir(), first.id))).toBe(false);
    t.started.find((one) => one.output === output)!.release();
    await t.settle(() => !t.registry.running());
    // Smooth playback's render asks for a place: it gets it once the one made ahead lets go.
    expect(t.registry.startAhead(t.store, t.app.library, first, options, aheadFile(t.store.cacheDir(), first.id))).toBe(true);
    await t.settle(() => t.started.length === 3);
    let given: (() => void) | null = null;
    const turn = t.registry.takeTurn((release) => { given = release; });
    expect(turn.release).toBeNull();
    await t.settle(() => given !== null);
    expect(t.started[2]!.cancelled).toBe(true);
    (given as unknown as () => void)();
  } finally {
    t.done();
  }
});

test("an edit's export is made ahead with its next share's settings, unless it's on battery or already made", async () => {
  const t = setUp("ahead-when");
  const battery = ahead.hooks.onBattery;
  const smoothing = spyOn(seams.broll, "smoothingPending").mockReturnValue([]);
  try {
    const project = await t.project("Shared");
    // Its share asked for small pictures before: made ahead that way, for YouTube.
    fs.writeFileSync(`${t.home}/reviews.json`, JSON.stringify({ shareOptions: { [project.id]: { quality: "small" } } }));
    expect(ahead.nextShare(t.home, project).options).toMatchObject({ quality: "small", preset: "youtube", range: null, chapters: [] });
    ahead.hooks.onBattery = () => true;
    expect(await ahead.tryNow(t.app, project.id)).toBe("on battery");
    ahead.hooks.onBattery = () => false;
    smoothing.mockReturnValue(["c1"]);
    expect(await ahead.tryNow(t.app, project.id)).toBe("slowed shots still smoothing");
    smoothing.mockReturnValue([]);
    // Its picture still changing: footage being cleaned, or an effect not rendered yet (Nov 18).
    const cleaning = spyOn(removalSchedule, "progressOf").mockReturnValue({ done: 2, out: 3 });
    expect(await ahead.tryNow(t.app, project.id)).toBe("its footage still being cleaned");
    cleaning.mockRestore();
    const rendering = spyOn(effects, "notReady").mockReturnValue("The title effect is still rendering: export again in a minute or two.");
    expect(await ahead.tryNow(t.app, project.id)).toBe("its effects still rendering");
    rendering.mockRestore();
    expect(await ahead.tryNow(t.app, project.id)).toBeNull();
    await t.settle(() => t.started.length === 1);
    expect(t.started[0]).toMatchObject({ name: "Shared", background: true });
    expect(await ahead.tryNow(t.app, project.id)).toBe("already making it");
    t.started[0]!.release();
    await t.settle(() => fs.existsSync(`${aheadFile(t.store.cacheDir(), project.id)}.json`));
    await t.settle(() => t.registry.aheadFor() === null);
    // Made of this very edit with these settings: nothing to do until it changes.
    expect(await ahead.tryNow(t.app, project.id)).toBe("up to date");
    await t.store.update(project.id, "test", (p) => { p.clips[0]!.duration = 20; });
    expect(await ahead.tryNow(t.app, project.id)).toBeNull();
    await t.settle(() => t.started.length === 2);
    await t.registry.stopAhead();
  } finally {
    ahead.hooks.onBattery = battery;
    smoothing.mockRestore();
    t.done();
  }
});

// JJ's Mac, Nov 17: each of his three exports logged "SC's watermark at 10%, moving" and then rendered every chunk
// again (0 of 117, 0 of 124), 8–10 minutes each: the export made ahead had gone without the watermark, as a
// project's first share has none kept.
const lanes = { ideas: "", thumbnails: "", script: "", edit: "" };
const SC: channels.Channel = {
  key: "ch-5c0ffee123", youtubeId: null, handle: null, title: "Cuffed & Caught", description: "", avatar: null, banner: null, uploads: null, subscribers: null, videos: null, views: null,
  country: null, publishedAt: null, fetchedAt: 0, narration: null, compilation: false, lanes, archived: false, addedBy: null, at: 0,
  watermarkUpload: { sha256: "a".repeat(64), ext: "png" },
} as channels.Channel;

test("the export made ahead carries the watermark the dialog will send: a channel's own before its first share, V1's its kind's last, none once it went without", async () => {
  const { app, home, store, cleanup } = fixtureHome("ahead-watermark");
  const asked: (string | undefined)[] = [];
  (app as unknown as { exports: unknown }).exports = {
    running: () => false, runningFor: () => null, cancel: () => false, exported: () => false,
    // The share's export, as it's asked for: stopped there (what it's asked for is what's tested).
    start: async (...args: unknown[]) => {
      asked.push((args[5] as { watermark?: string }).watermark);
      throw new Error("stopped here");
    },
  };
  const enabled = spyOn(cloud, "enabled").mockReturnValue(true);
  channels.useChannelsForTests([SC]);
  const mark = channels.markFor(SC)!;
  const share = async (id: string, watermark?: string | null) => {
    asked.length = 0;
    expect(await reviews.exportAndShare(app, id, {}, false, undefined, watermark).catch((error: Error) => error.message)).toBe("stopped here");
    return asked[0];
  };
  try {
    const v2 = store.createAs("Compilation", "bodycam", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(v2, "test", (one) => { one.channel = SC.key; });
    const bodycam = store.createAs("Bodycam", "bodycam", { width: 64, height: 36, fps: 30 }).project.id;
    const next = store.createAs("Bodycam 2", "bodycam", { width: 64, height: 36, fps: 30 }).project.id;
    const interrogation = store.createAs("Interrogation", "interrogation", { width: 64, height: 36, fps: 30 }).project.id;
    const made = (id: string) => ahead.nextShare(home, store.get(id)!.project).watermark;
    const offered = (id: string) => (reviews.view(app, id) as { watermark: string | null }).watermark;
    // Never shared: a channel's project its channel's own, made ahead and offered alike.
    expect(made(v2)).toBe(mark);
    expect(offered(v2)).toBe(mark);
    // V1, nothing of its kind shared on this computer yet: none.
    expect(made(bodycam)).toBeUndefined();
    expect(offered(bodycam)).toBeNull();
    // A bodycam shared with SB's logo: the next bodycam's first share starts on it, an interrogation doesn't.
    expect(await share(bodycam, "pic-sb")).toBe("pic-sb");
    expect([made(next), offered(next)]).toEqual(["pic-sb", "pic-sb"]);
    expect([made(interrogation), offered(interrogation)]).toEqual([undefined, null]);
    // From Home (none sent): what it was last shared with.
    expect(await share(bodycam)).toBe("pic-sb");
    // Shared without: none from then on, made ahead and offered alike; a channel's own once it's asked for again.
    expect(await share(v2, null)).toBeUndefined();
    expect([made(v2), offered(v2)]).toEqual([undefined, null]);
    expect(await share(v2)).toBeUndefined();
    expect(await share(v2, mark)).toBe(mark);
    expect(made(v2)).toBe(mark);
    // And the next bodycam's kind follows its last share without one too.
    expect(await share(bodycam, null)).toBeUndefined();
    expect(made(next)).toBeUndefined();
  } finally {
    enabled.mockRestore();
    channels.useChannelsForTests([]);
    cleanup();
  }
});

const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
const addon = findAddon();
test.skipIf(ffmpeg === null || ffprobe === null || addon === null)("a Share right after the export made ahead copies every chunk out of it, the channel's watermark on both: nothing drawn again (the real engine)", async () => {
  const fixture = fixtureHome("ahead-real");
  const { dir, home, store, app } = fixture;
  const before = useNative(wrap(require(addon!) as Native));
  native().init({ home, cacheDir: store.cacheDir(), ffmpeg: ffmpeg!, ffprobe: ffprobe!, log: diag.nativeLog });
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "1";
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const signedIn = spyOn(cloud, "enabled").mockReturnValue(true);
  const smoothing = spyOn(seams.broll, "smoothingPending").mockReturnValue([]);
  const battery = ahead.hooks.onBattery;
  ahead.hooks.onBattery = () => false;
  const settle = async (until: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!until() && Date.now() < end) await Bun.sleep(50);
    expect(until()).toBe(true);
  };
  try {
    // A minute of footage with its sound, cut every second, and the channel's logo uploaded on its page.
    const shot = `${dir}/shot.mp4`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=62", "-f", "lavfi", "-i", "sine=frequency=440:duration=62",
      "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", shot]);
    expect(made.exitCode).toBe(0);
    const logo = `${store.cacheDir()}/watermarks/${SC.watermarkUpload!.sha256}.png`;
    fs.mkdirSync(`${store.cacheDir()}/watermarks`, { recursive: true });
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white@0.8:size=64x32,format=rgba", "-frames:v", "1", logo]).exitCode).toBe(0);
    channels.useChannelsForTests([SC]);
    saveExportFolder(home, `${dir}/exports`);
    const probe = await native().probe(shot);
    const id = store.createAs("Cops Surprise Fellow Officer", "bodycam", { width: 320, height: 180, fps: 30 }).project.id;
    await store.update(id, "test", (p) => {
      p.channel = SC.key;
      p.media.push(media({ id: "m1", name: "shot.mp4", path: shot, kind: "video", duration: probe.duration, width: 320, height: 180, fps: 30, has_audio: true }));
      const audio = p.tracks.find((track) => track.kind === "audio")!.id;
      for (let at = 0; at < 60; at++) {
        p.clips.push(clip({ id: `v${at}`, track: p.tracks[0]!.id, start: at * 30, duration: 30, type: "video", media: "m1", source_in: at + 0.5 }));
        p.clips.push(clip({ id: `a${at}`, track: audio, start: at * 30, duration: 30, type: "audio", media: "m1", source_in: at + 0.5 }));
      }
    });
    // Its first share is still to come: made ahead with its channel's logo, as the dialog will send it.
    expect(await ahead.tryNow(app, id)).toBeNull();
    const file = aheadFile(store.cacheDir(), id);
    await settle(() => fs.existsSync(`${file}.json`) && registry.aheadFor() === null, 120_000);
    const madeAhead = diag.lines(400).map((line) => line.message).filter((message) => /chunks \(.*\) already made/.test(message));
    // Made ahead (from nothing, or picking up chunks an earlier test's export left in the shared cache on CI's runner).
    expect(madeAhead.at(-1)).toMatch(/^export: \d+ of \d+ chunks/);
    // The dialog's Share: the house YouTube export of the whole edit (ShareDialog's HOUSE), with what it offers ticked.
    const offered = (reviews.view(app, id) as { watermark: string | null }).watermark;
    expect(offered).toBe(channels.markFor(SC)!);
    const length = 60 * 30;
    const dialog = { format: "h264", shape: "original", fill: "blur", size: null, fps: null, quality: "high", target_mb: null, hardware: true, audio: true, loudness: -14, preset: "youtube", range: [0, length], chapters: [] };
    const startedAt = Date.now();
    let exported = 0;
    const off = store.subscribe((event) => {
      if (event.type === "export" && event.id === id && event.state === "done" && exported === 0) exported = Date.now();
    });
    const sharing = reviews.exportAndShare(app, id, dialog as never, false, undefined, offered).catch((error: Error) => error.message);
    await settle(() => exported > 0, 120_000);
    off();
    reviews.cancelShare(app, id);
    await sharing;
    const lines = diag.lines(400).map((line) => line.message);
    expect(lines.some((message) => message.includes("watermark at"))).toBe(true);
    const reused = lines.filter((message) => /chunks \(.*\) already made/.test(message)).at(-1)!;
    const [, copied, all] = /^export: (\d+) of (\d+) chunks/.exec(reused)!;
    // A minute is two chunks on Linux and one on a Mac (CI's Mac, Nov 18): at least one, every one copied.
    expect(Number(all)).toBeGreaterThanOrEqual(1);
    // Every chunk copied: none drawn again, the sound too, so the share's export is the join alone.
    expect(copied).toBe(all);
    expect(reused).toContain("the sound");
    expect(exported - startedAt).toBeLessThan(15_000);
  } finally {
    ahead.hooks.onBattery = battery;
    smoothing.mockRestore();
    signedIn.mockRestore();
    archive.mockRestore();
    await registry.stopAhead();
    channels.useChannelsForTests([]);
    if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
    else process.env.EDIT_LOCAL_EXPORTS = most;
    if (before !== null) useNative(before);
    fixture.cleanup();
  }
}, 300_000);
