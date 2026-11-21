// Add-ons, slice 5 (Nov 21): the research turn after an import, the essay's
// YouTube excerpts and the extra muted words ask the project's add-ons
// instead of its style, and give the same answer. A V1 project's muted words
// are its style's; a channel's project with nothing set is a V1 bodycam one
// (researched after its import, no extra words); and a channel's add-ons that
// can't be read hold neither the import's follow-on nor the house words pass.
// Everything but `mutedWords` itself ran the same on the code before.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import type { App } from "../src/app.ts";
import * as channels from "../src/channels.ts";
import { effectLine, start as startPass } from "../src/house_words_pass.ts";
import { STYLES, type Project, type Probe, type Style, type TextClip } from "../src/model.ts";
import * as relay from "../src/relay.ts";
import { Processor } from "../src/media.ts";
import { Jobs, RESEARCH, start, timing } from "../src/script.ts";
import * as seams from "../src/seams.ts";
import type { Excerpt } from "../src/seams.ts";
import * as subtitles from "../src/subtitles.ts";
import { serialize, type Transcript } from "../src/transcribe.ts";
import { fixtureHome, write, type Fixture } from "./helpers/home.ts";

const ALL: Style[] = STYLES.map((one) => one.value);
const WIDE = { width: 1920, height: 1080, fps: 30 };
const TALL = { width: 1080, height: 1920, fps: 30 };

let restores: (() => void)[] = [];
const waits = timing.retryWaits;
const sleep = timing.sleep;

beforeEach(() => {
  timing.retryWaits = [0];
  timing.sleep = async () => {};
  restores = [];
});

afterEach(() => {
  for (const undo of restores) undo();
  timing.retryWaits = waits;
  timing.sleep = sleep;
});

function mocked<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

/** The channels read (what `addons.ready` waits on), never from the network here: as they were, or failing. */
const channelsRead = (fails: boolean) =>
  mocked(spyOn(channels, "refresh").mockImplementation(async () => {
    if (fails) throw new Error("the cloud can't be reached");
  }));

// ── The words. ──

// `mutedWords` is new with the add-ons; before it a site asked `styleTerms(style)` itself.
test.skipIf(!("mutedWords" in subtitles))("a V1 project's muted words are its style's, every style, either frame", () => {
  const mutedWords = (subtitles as unknown as { mutedWords: (project: Project) => string[] }).mutedWords;
  const { store, cleanup } = fixtureHome("addons-words-v1");
  try {
    for (const style of ALL) {
      for (const frame of [WIDE, TALL]) {
        const project = structuredClone(store.create(style, frame).project) as Project;
        project.style = style;
        expect([style, frame.height, mutedWords(project)]).toEqual([style, frame.height, subtitles.styleTerms(style)]);
      }
    }
    expect(subtitles.styleTerms("horror").length).toBeGreaterThan(subtitles.styleTerms("commentary").length);
    expect(subtitles.styleTerms("bodycam")).toEqual([]);
  } finally {
    cleanup();
  }
});

test.skipIf(!("mutedWords" in subtitles))("a channel's bodycam project with nothing set mutes no extra words, as a V1 bodycam one", () => {
  const mutedWords = (subtitles as unknown as { mutedWords: (project: Project) => string[] }).mutedWords;
  const { store, cleanup } = fixtureHome("addons-words-channel");
  try {
    const project = structuredClone(store.create("c", WIDE).project) as Project;
    project.hq = true;
    project.channel = "inspector-ted";
    expect(mutedWords(project)).toEqual([]);
    project.channel = undefined;
    expect(mutedWords(project)).toEqual([]);
  } finally {
    cleanup();
  }
});

/** A project of this style shown an effect that says "Gun store": a commentary word, not the house's. */
async function withEffect(fixture: Fixture, style: Style, channel: string | null): Promise<string> {
  const live = fixture.store.create("effect", WIDE);
  const edited = structuredClone(live.project) as Project;
  edited.style = style;
  if (channel !== null) {
    edited.hq = true;
    edited.channel = channel;
  }
  await fixture.store.replace(edited.id, null, edited, "test");
  write(`${fixture.store.uploadsDir(edited.id)}/effects/title/scene.html`, "<div>Gun store</div>");
  return edited.id;
}

test("an effect's extra words: a channel's bodycam project as a V1 bodycam one (none), a commentary one its list", async () => {
  const fixture = fixtureHome("addons-words-effect");
  try {
    expect(effectLine(fixture.store, await withEffect(fixture, "bodycam", "inspector-ted"), "title")).toBeNull();
    expect(effectLine(fixture.store, await withEffect(fixture, "bodycam", null), "title")).toBeNull();
    expect(effectLine(fixture.store, await withEffect(fixture, "commentary", null), "title")).toContain(`(scene.html): "gun"`);
    // A V1 commentary edit moved onto a channel keeps its style's words.
    expect(effectLine(fixture.store, await withEffect(fixture, "commentary", "inspector-ted"), "title")).toContain(`(scene.html): "gun"`);
  } finally {
    fixture.cleanup();
  }
});

// ── The research turn after an import. ──

const SOUNDLESS: Probe = { kind: "video", duration: 60, width: 640, height: 360, fps: 30, has_audio: false };

/** An import's world: the cloud on (its channels read as `fails` says), footage on R2 as whole-file excerpts, nothing researched yet, the voice-over made. */
function importing(fails = false): void {
  mocked(spyOn(relay, "cloudEnabled").mockReturnValue(true));
  channelsRead(fails);
  mocked(spyOn(seams.research, "articles").mockReturnValue([]));
  mocked(spyOn(seams.research, "items").mockReturnValue([]));
  mocked(spyOn(seams.research, "caseNames").mockResolvedValue([]));
  mocked(spyOn(Processor.prototype, "ensure").mockImplementation(() => {}));
  mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
  mocked(
    spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async (file: string) => ({ file, source: `drive:${file}`, key: `edit/originals/drive/${file}/a.mp4`, name: `${file}.mp4`, size: 100 })),
  );
  mocked(
    spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache: string, original) => {
      const proxy = `edit/proxies/drive/${original.file}.mp4`;
      const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
      const excerpt: Excerpt = { path, from: 0, to: SOUNDLESS.duration, cloud: { path, name: original.name, probe: SOUNDLESS, cloud: { source: original.source, original: original.key, proxy, size: 100 } } };
      return [excerpt];
    }),
  );
}

/** A project of this style (on a channel, as a V2 one, when given) with a script of one footage file. */
async function scripted(fixture: Fixture, style: Style, channel: string | null, file: string): Promise<string> {
  const id = fixture.store.create("import", WIDE).project.id;
  await fixture.store.update(id, "test", (p) => {
    p.style = style;
    if (channel !== null) {
      p.hq = true;
      p.channel = channel;
    }
    p.script = {
      blocks: [
        { kind: "footage", file, url: file.startsWith("youtube:") ? `https://www.youtube.com/watch?v=${file.slice(8)}` : `https://drive.google.com/file/d/${file}/view`, start: 0, end: 4, label: "00:00–00:04", words: ["where", "you"], notes: ["Case 1: link"] },
        { kind: "narration", text: "Then it happened." },
      ],
    };
  });
  return id;
}

/** Imports the project's script (its footage `file`); the messages Edit sent its agent, and how the job ended. */
async function imported(style: Style, channel: string | null, file = "FILEcase0001"): Promise<{ sent: string[]; state: string; research: string | undefined }> {
  const sent: string[] = [];
  const agents = { status: async () => ({}), ask: async () => "", send: async (_project: string, text: string) => void sent.push(text) };
  const scripts = new Jobs();
  const fixture = fixtureHome(`addons-import-${style}`, { services: { scripts, agents: agents as never } });
  try {
    const id = await scripted(fixture, style, channel, file);
    await start(fixture.app, id, false);
    for (let i = 0; i < 1000 && scripts.working(id); i++) await Bun.sleep(2);
    const job = scripts.get(id)!;
    return { sent, state: job.state, research: job.after?.find((line) => line.step === "research")?.state };
  } finally {
    fixture.cleanup();
  }
}

test("after an import: a channel's bodycam project with nothing set is researched, as a V1 bodycam one; an essay and a Short aren't", async () => {
  importing();
  const researched = { sent: [RESEARCH], state: "done", research: "done" };
  expect(await imported("bodycam", "inspector-ted")).toEqual(researched);
  expect(await imported("bodycam", null)).toEqual(researched);
  expect(await imported("courtroom", null)).toEqual(researched);
  const not = { sent: [], state: "done", research: undefined };
  expect(await imported("commentary", null)).toEqual(not);
  expect(await imported("shorts", null)).toEqual(not);
});

test("a channel's add-ons that can't be read hold neither the import's follow-on nor its research turn", async () => {
  importing(true);
  expect(await imported("bodycam", "inspector-ted")).toEqual({ sent: [RESEARCH], state: "done", research: "done" });
});

test("during an import, YouTube footage comes in as excerpts for an essay alone (a V1 one, or one moved onto a channel), whole for the rest", async () => {
  importing();
  const cut: string[] = [];
  const whole: string[] = [];
  const excerpt = (file: string): Excerpt => {
    const proxy = `edit/proxies/youtube/${file}.mp4`;
    const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
    return { path, from: 0, to: SOUNDLESS.duration, cloud: { path, name: `${file}.mp4`, probe: SOUNDLESS, cloud: { source: file, original: `edit/originals/${file}.mp4`, proxy, size: 100 } } };
  };
  mocked(spyOn(seams.cloudMedia, "youtubeExcerpts").mockImplementation(async (_home: string, _cache: string, file: string) => {
    cut.push(file);
    return [excerpt(file)];
  }));
  mocked(spyOn(seams.cloudMedia, "youtubeOriginal").mockImplementation(async (_home: string, file: string) => {
    whole.push(file);
    return [{ file, source: file, key: `edit/originals/${file}.mp4`, name: `${file}.mp4`, size: 100 }, null];
  }));
  const video = "youtube:abcdefghijk";
  const by = async (style: Style, channel: string | null) => {
    [cut.length, whole.length] = [0, 0];
    await imported(style, channel, video);
    return [style, channel, cut.length, whole.length];
  };
  expect(await by("commentary", null)).toEqual(["commentary", null, 1, 0]);
  expect(await by("horror", null)).toEqual(["horror", null, 1, 0]);
  expect(await by("horror", "inspector-ted")).toEqual(["horror", "inspector-ted", 1, 0]);
  expect(await by("bodycam", null)).toEqual(["bodycam", null, 0, 1]);
  expect(await by("bodycam", "inspector-ted")).toEqual(["bodycam", "inspector-ted", 0, 1]);
  expect(await by("shorts", null)).toEqual(["shorts", null, 0, 1]);
});

// ── The house words pass. ──

const words = (said: [string, number, number][]): Transcript => ({ model: "scribe_v2", language: "eng", words: said.map(([text, start, end]) => ({ text, start, end, speaker: "speaker_0" })), speakers: {}, roles: {}, colors: {} });
const STYLE = { font: "Geist", weight: 700, size: 96, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15, glow: { enabled: false, color: null, radius: 46, strength: 0.5 } } as TextClip["style"];

/** A channel's V2 project: bodycam footage saying "fucking" and a caption saying "drug". */
async function channelProject(app: App, dir: string): Promise<string> {
  const footage = `${dir}/bodycam.mp4`;
  write(app.media.paths(footage).transcript, serialize(words([["Stop", 1.0, 1.3], ["fucking", 1.35, 1.7], ["moving.", 1.75, 2.0]])));
  const live = app.store.create("p", WIDE);
  const edited = structuredClone(live.project) as Project;
  edited.hq = true;
  edited.channel = "inspector-ted";
  edited.media = [{ id: "m", name: "bodycam", path: footage, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true }];
  edited.clips = [
    { id: "f", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, link: "l1" },
    { id: "a", track: "a4", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "audio", media: "m", source_in: 0, speed: 1, volume_db: 0, link: "l1" },
    { id: "c", track: "v2", start: 0, duration: 60, color: "cyan", name: "Caption", fade_in: 0, fade_out: 0, type: "text", text: "Drug deal gone wrong", style: STYLE, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, animation: { preset: "none", duration: 12, stagger: 1.5 }, opacity: 1 },
  ];
  await app.store.replace(edited.id, null, edited, "test");
  return edited.id;
}

test("a channel's add-ons that can't be read don't hold the house words pass at a turn's end", async () => {
  channelsRead(true);
  const notes: [string, string][] = [];
  let told: () => void = () => {};
  const agents = { status: async () => ({}), ask: async () => "", note: (project: string, text: string) => { notes.push([project, text]); told(); } };
  const { app, dir, store, cleanup } = fixtureHome("addons-pass-offline", { services: { agents: agents as never } });
  try {
    const id = await channelProject(app, dir);
    startPass(app);
    const heard = new Promise<void>((resolve) => (told = resolve));
    store.emit({ type: "agent", event: "status", running: true, project: id } as never);
    await store.update(id, "agent", (edited) => {
      edited.name = "Changed";
    });
    store.emit({ type: "agent", event: "status", running: false, project: id } as never);
    await heard;
    expect(notes).toEqual([[id, "Muted 1 house word in the footage's sound, and starred 1 on screen."]]);
  } finally {
    cleanup();
  }
});
