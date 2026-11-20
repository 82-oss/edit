// burned_subtitles.ts: footage with subtitles already burned into its picture
// (Lauana's Cuffed & Caught compilation, Nov 16: the agent's blue subtitles
// over the source's white ones). Found on real footage made with drawtext,
// told to the agent in get_edit_context, ours left off there by add_subtitles
// and repack_subtitles (or theirs covered, for a channel taught so), and a
// subtitle of ours laid over theirs refused.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import * as burned from "../src/burned_subtitles.ts";
import * as removal from "../src/removal_lesson.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import "../src/subtitles_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import type { Media, Project, TextClip } from "../src/model.ts";
import { findAddon, native, useNative, wrap, type Native, type ScreenText } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import { join } from "../src/paths.ts";
import { serialize, type Transcript } from "../src/transcribe.ts";
import { fixtureHome, scratch, write } from "./helpers/home.ts";

let before: Native | null = null;
afterEach(() => {
  if (before !== null) useNative(before);
  before = null;
});

/** Lines said (and burned in) every 4 s from 2 s: [second, words]. */
const SAID: [number, string][] = [
  [2, "That house is horrible."],
  [6, "Get out of the car now."],
  [10, "I did not do anything wrong"],
  [14, "Put your hands behind your back"],
  [18, "Where were you last night"],
  [22, "He told me to wait here"],
  [26, "You are under arrest today"],
  [30, "Can I call my mother please"],
  [34, "Watch your head getting in"],
];

/** The transcript of SAID: each word spread over its line's first two seconds. */
function transcript(lines: [number, string][] = SAID): Transcript {
  const words = lines.flatMap(([at, line]) => {
    const parts = line.split(" ");
    return parts.map((text, index) => ({ text, start: at + (index * 2) / parts.length, end: at + ((index + 1) * 2) / parts.length - 0.05, speaker: "speaker_0" }));
  });
  return { model: "scribe_v2", language: "eng", words, speakers: { speaker_0: "Officer" }, roles: { speaker_0: "officer" }, colors: { speaker_0: "#00e5c7" } };
}

/** A reader whose transcripts are `transcripts` (path → file). */
function reader(transcripts: Record<string, string>): burned.Reader {
  return { analysisInput: async (source) => source, paths: (source) => ({ transcript: transcripts[source] ?? "/nowhere/transcript.json" }) };
}

test("a line low and centred that changes is a subtitle; a credit, a stamp or words nobody says aren't", () => {
  const line = (t: string, y = 0.84): ScreenText => ({ t, b: [0.3, y, 0.7, y + 0.06] });
  const seconds = SAID.map(([at]) => at + 1);
  const stamp: ScreenText = { t: "AXON BODY 3 X81234", b: [0.6, 0.02, 0.95, 0.05] };
  const texts: Record<number, ScreenText[]> = Object.fromEntries(SAID.map(([at, words]) => [at + 1, [line(words), stamp]]));
  const found = burned.judge(texts, seconds, 40, transcript().words);
  expect(found).toEqual({ spans: [[0, 38]], band: [0.29, 0.83, 0.71, 0.91], lines: ["That house is horrible.", "Get out of the car now.", "I did not do anything wrong"], heard: 1 });
  // With no transcript, the picture alone.
  expect(burned.judge(texts, seconds, 40, null)?.heard).toBeNull();
  // A credit stays the same.
  const credit = Object.fromEntries(seconds.map((second) => [second, [line("Produced by Northside Studio")]]));
  expect(burned.judge(credit, seconds, 40, null)).toBeNull();
  // A stamp is no words; a line up top isn't a subtitle.
  expect(burned.judge(Object.fromEntries(seconds.map((second) => [second, [line(`08/14/2025 16:13:${second}`)]])), seconds, 40, null)).toBeNull();
  expect(burned.judge(Object.fromEntries(SAID.map(([at, words]) => [at + 1, [line(words, 0.1)]])), seconds, 40, null)).toBeNull();
  // Changing words nobody says (a ticker, a sign at a crossing) aren't the footage's subtitles.
  const other = transcript(SAID.map(([at]) => [at, "mumbling something quiet here"]));
  expect(burned.judge(texts, seconds, 40, other.words)).toBeNull();
  // Higher in the picture, only what's said counts (two-thirds down, and mid-screen emphasis captions at ~40–55% down like SMART Cops).
  const higher = Object.fromEntries(SAID.map(([at, words]) => [at + 1, [line(words, 0.62)]]));
  expect(burned.judge(higher, seconds, 40, transcript().words)?.band[1]).toBe(0.61);
  expect(burned.judge(higher, seconds, 40, null)).toBeNull();
  const midScreen = Object.fromEntries(SAID.map(([at, words], i) => [at + 1, [line(words, i % 2 === 0 ? 0.42 : 0.91)]]));
  expect(burned.judge(midScreen, seconds, 40, transcript().words)?.band[1]).toBe(0.41);
  // Without a transcript (or when unspoken), mid-screen text is NOT treated as subtitles.
  const midOnly = Object.fromEntries(SAID.map(([at, words]) => [at + 1, [line(words, 0.42)]]));
  expect(burned.judge(midOnly, seconds, 40, null)).toBeNull();
  expect(burned.judge(midOnly, seconds, 40, other.words)).toBeNull();
  // Subtitled in its first half only: spans where they show.
  const half = Object.fromEntries([...SAID.slice(0, 5).map(([at, words]): [number, ScreenText[]] => [at + 1, [line(words)]]), ...[23, 27, 31, 35].map((second): [number, ScreenText[]] => [second, []])]);
  expect(burned.judge(half, [...SAID.slice(0, 5).map(([at]) => at + 1), 23, 27, 31, 35], 40, null)?.spans).toEqual([[0, 22]]);
});

const ffmpeg = Bun.which("ffmpeg");
const addon = findAddon();
test.skipIf(ffmpeg === null || addon === null)("subtitles burned into real footage are found, sampled, with their band; a credit isn't", async () => {
  before = useNative(wrap(require(addon!) as Native));
  const { dir, cleanup } = scratch("burned-real");
  try {
    const font = join(import.meta.dir, "../../../crates/edit-render/fonts/Arimo-Bold.ttf");
    const draw = (text: string, from: number, to: number) =>
      `drawtext=fontfile=${font}:text='${text}':x=(w-text_w)/2:y=h*0.84:fontsize=24:fontcolor=white:borderw=2:bordercolor=black:enable='between(t,${from},${to})'`;
    const make = (path: string, filters: string[], seconds: number) => {
      const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${seconds}`, "-vf", filters.join(","), "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
      expect(made.exitCode).toBe(0);
    };
    const subtitled = join(dir, "comp.mp4");
    make(subtitled, SAID.map(([at, words]) => draw(words, at, at + 3.9)), 40);
    const said = join(dir, "comp-transcript.json");
    fs.writeFileSync(said, serialize(transcript()));
    const media = { path: subtitled, name: "comp.mp4", kind: "video" as const, duration: 40, width: 640, height: 360 };
    await burned.warm(reader({ [subtitled]: said }), media);
    const found = burned.of(media);
    const read = JSON.stringify(await native().screenTextDetect(subtitled, [640, 360], [3, 7]));
    expect(found, read).not.toBeNull();
    expect(found, read).not.toBeUndefined();
    expect(found!.spans.length).toBe(1);
    expect(found!.spans[0]![0]).toBeLessThanOrEqual(3);
    expect(found!.spans[0]![1]).toBeGreaterThanOrEqual(36);
    // The band: the bottom sixth, across the middle.
    expect(found!.band[1]).toBeGreaterThan(0.75);
    expect(found!.band[3]).toBeLessThan(0.97);
    expect(found!.band[0]).toBeGreaterThan(0.1);
    expect(found!.band[2]).toBeLessThan(0.9);
    expect(found!.heard).toBeGreaterThanOrEqual(0.5);
    // A credit that stays: none.
    const credited = join(dir, "credit.mp4");
    make(credited, [draw("Produced by Northside Studio", 0, 20)], 20);
    const credit = { path: credited, name: "credit.mp4", kind: "video" as const, duration: 20, width: 640, height: 360 };
    await burned.warm(reader({}), credit);
    expect(burned.of(credit)).toBeNull();
  } finally {
    cleanup();
  }
}, 240_000);

// ---------------------------------------------------------------------------
// The agent told, ours left off, a second set refused

/** A compilation's source: subtitled from 0 to 20 s of it, nothing after. */
function compilation(dir: string): Media {
  return { id: "m", name: "yeNu3j_K6D8 compilation", path: `${dir}/comp.mp4`, kind: "video", duration: 40, width: 1920, height: 1080, fps: 30, has_audio: true };
}

/** What the picture reads: SAID's first five lines burned in at the bottom. */
const READ: Record<number, ScreenText[]> = Object.fromEntries(
  Array.from({ length: 40 }, (_, second) => {
    const line = SAID.slice(0, 5).find(([at]) => second >= at && second < at + 4);
    return [second, line === undefined ? [] : [{ t: line[1], b: [0.3, 0.85, 0.7, 0.9] }]];
  }),
);

/** The fixture's stub, as a real addon whose words on screen are READ. */
function reading(): void {
  const raw = createStub() as unknown as Record<string, unknown>;
  const current = native() as unknown as Record<string, unknown>;
  for (const key of Object.keys(current)) raw[key] = current[key];
  raw.stub = false;
  raw.screenTextDetect = async (_source: string, _size: [number, number], indexes: number[]) => Object.fromEntries(indexes.map((index) => [index, READ[index] ?? []]));
  raw.screenTextCached = () => READ;
  before = useNative(raw as unknown as Native);
}

async function footage(app: App, dir: string): Promise<string> {
  const media = compilation(dir);
  write(media.path, "");
  write(app.media.paths(media.path).transcript, serialize(transcript()));
  const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project) as Project;
  project.media = [media];
  project.clips = [
    { id: "f", track: "v1", start: 0, duration: 1200, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, link: "l1" },
    { id: "a", track: "a4", start: 0, duration: 1200, color: "blue", fade_in: 0, fade_out: 0, type: "audio", media: "m", source_in: 0, speed: 1, volume_db: 0, link: "l1" },
  ];
  await app.store.replace(project.id, null, project, "test");
  await burned.warm(app.media, media);
  return project.id;
}

async function call(app: App, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, null)) as {
    result: { content: { text: string }[]; isError: boolean };
  };
  return { text: reply.result.content[0]!.text, isError: reply.result.isError };
}

test("the agent is told which footage has subtitles burned in; ours are left off there, and laying one over theirs is refused", async () => {
  registerEditingTools();
  const { app, dir, store, cleanup } = fixtureHome("burned");
  reading();
  try {
    const id = await footage(app, dir);
    const context = JSON.parse((await call(app, "get_edit_context", { project_id: id })).text) as { media: string[]; burned_subtitles?: { shown: unknown[]; note: string } };
    expect(context.media[0]).toContain('· burned-in subtitles at 0–23s of it, 84–91% down, 29–71% across ("That house is horrible.", "Get out of the car now.")');
    expect(context.burned_subtitles?.shown).toEqual([{ media: "yeNu3j_K6D8 compilation", clip: "f", seconds: "0.0–23.0" }]);
    expect(context.burned_subtitles?.note).toContain("ours stay off them");
    expect(context.burned_subtitles?.note).toContain("Never ask about it.");
    const texts = () => store.get(id)!.project.clips.filter((clip): clip is TextClip => clip.type === "text").map((clip) => [clip.start, clip.text] as const);
    // By default ours are left off there: only the lines after theirs stop.
    const left = await call(app, "add_subtitles", { project_id: id, start: 0 });
    expect(left.isError).toBe(false);
    expect(left.text).toContain('"left_to_the_burned_in_subtitles":5');
    expect(texts().map(([start]) => start / 30).every((second) => second >= 22)).toBe(true);
    expect(texts().length).toBe(4);
    // A subtitle of ours laid over theirs by hand (a plan, a moved clip) is refused in one line.
    const track = store.get(id)!.project.tracks.find((one) => one.subtitles === true)!.id;
    const laid = await call(app, "add_clip", { project_id: id, clip: { type: "text", track, start: 60, duration: 60, name: "Subtitle · Officer", text: "That house is horrible." } });
    expect(laid.isError).toBe(true);
    expect(laid.text).toContain('The footage already has subtitles burned in there ("yeNu3j_K6D8 compilation" at 0–23s on the timeline), so ours stay off it.');
    expect(texts().length).toBe(4);
    // One laid over theirs before they were found, carried along by an edit (a ripple), is the audit's, not refused.
    const legacy = structuredClone(store.get(id)!.project);
    legacy.clips.push({ ...structuredClone(legacy.clips.find((clip) => clip.type === "text")!), id: "old", start: 60, duration: 60 });
    const rippled = structuredClone(legacy);
    rippled.clips.find((clip) => clip.id === "old")!.start = 30;
    expect(burned.refusal(legacy, rippled)).toBeNull();
    expect(burned.refusal(store.get(id)!.project, rippled)).toContain("so ours stay off it");
    // A channel taught to cover theirs: a blur on their band, stuck to the clip, and ours on it.
    const covered = await call(app, "add_subtitles", { project_id: id, start: 0, burned_in: "cover" });
    expect(covered.isError).toBe(false);
    expect(covered.text).toContain('"burned_in_subtitles_covered":1');
    expect(texts().length).toBe(9);
    const blur = store.get(id)!.project.clips.find((clip) => (clip.name ?? "").startsWith(burned.COVER));
    expect(blur).toMatchObject({ type: "adjustment", start: 0, duration: 690, name: "Burned-in cover · f" });
    // Covered, they no longer clash: the context says nothing, a re-run keeps ours and one cover.
    expect((JSON.parse((await call(app, "get_edit_context", { project_id: id })).text) as Record<string, unknown>).burned_subtitles).toBeUndefined();
    expect((await call(app, "add_subtitles", { project_id: id, start: 0 })).isError).toBe(false);
    expect(texts().length).toBe(9);
    expect(store.get(id)!.project.clips.filter((clip) => (clip.name ?? "").startsWith(burned.COVER)).length).toBe(1);
    // repack_subtitles the same: the cover gone, ours left off there by default.
    await store.update(id, "test", (p) => {
      p.clips = p.clips.filter((clip) => !(clip.name ?? "").startsWith(burned.COVER));
    });
    const repacked = await call(app, "repack_subtitles", { project_id: id, faces: false });
    expect(repacked.isError).toBe(false);
    expect(repacked.text).toContain('"left_to_the_burned_in_subtitles":');
    expect((await call(app, "repack_subtitles", { project_id: id, faces: false, burned_in: "cover" })).text).toContain('"burned_in_subtitles_covered":1');
    // The in-video look (Sphe, Nov 18): white Gabarito, no label, and the people pass leaves them white.
    expect((await call(app, "add_subtitles", { project_id: id, start: 0, look: "in_video" })).isError).toBe(false);
    const ours = store.get(id)!.project.clips.filter((clip): clip is TextClip => clip.type === "text" && (clip.name ?? "").startsWith("Subtitle"));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((clip) => clip.style.font === "Gabarito" && (clip.style.label ?? null) === null && (clip.style.background ?? null) === null && clip.style.color.join() === "1,1,1,1")).toBe(true);
    expect(ours.every((clip) => clip.name !== "Subtitle")).toBe(true);
    // Kept: a run without look follows it, and "house" brings the box and labels back.
    expect((await call(app, "add_subtitles", { project_id: id, start: 0 })).isError).toBe(false);
    expect(store.get(id)!.project.clips.filter((clip): clip is TextClip => clip.type === "text" && (clip.name ?? "").startsWith("Subtitle")).every((clip) => clip.style.font === "Gabarito")).toBe(true);
    await call(app, "add_subtitles", { project_id: id, start: 0, look: "house" });
    expect(store.get(id)!.project.subtitle_look).toBeUndefined();
    expect(store.get(id)!.project.clips.filter((clip): clip is TextClip => clip.type === "text" && (clip.name ?? "").startsWith("Subtitle")).every((clip) => clip.style.label !== undefined && clip.style.label !== null)).toBe(true);
    // A wrong choice says the right ones.
    expect((await call(app, "add_subtitles", { project_id: id, burned_in: "hide" })).text).toBe('burned_in is "leave_off" (the default: none of ours over theirs) or "cover" (theirs blurred, ours on it)');
    // A channel taught to take theirs out (its removal lesson): no still blur over theirs (Nov 19: they stood over cleaned
    // frames and frames with none of theirs); ours laid, and removal takes theirs out where they're marked.
    await store.update(id, "test", (p) => {
      p.clips = p.clips.filter((clip) => !(clip.name ?? "").startsWith(burned.COVER));
      p.channel = "ch-taught";
    });
    v2cloud.useSkillsForTests([{ name: removal.SKILL, key: v2cloud.ownKey("skill", "ch-taught--edit", removal.SKILL), text: removal.write({ remove: { subtitles: true, watermarks: false, text: false }, when: { subtitles: "automatic", watermarks: "automatic", text: "automatic" }, examples: [] }) }]);
    try {
      const laid = (await call(app, "add_subtitles", { project_id: id, start: 0 })).text;
      expect(laid).not.toContain("burned_in_subtitles_covered");
      expect(laid).not.toContain("left_to_the_burned_in_subtitles");
      expect(store.get(id)!.project.clips.filter((clip) => (clip.name ?? "").startsWith(burned.COVER))).toEqual([]);
    } finally {
      v2cloud.useSkillsForTests([]);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Read lazily, behind a play (kenobi, Nov 17: opening Cops Found 3 Bodies began
// 73 reads beside a cold play)

test("opening footage doesn't read it for burned-in subtitles; the agent's first get_edit_context does, and its rows say where", async () => {
  registerEditingTools();
  const { app, dir, store, cleanup } = fixtureHome("burned-lazy");
  reading();
  const asked: string[] = [];
  const detect = native().screenTextDetect;
  native().screenTextDetect = (source, size, indexes) => {
    asked.push(source);
    return detect(source, size, indexes);
  };
  try {
    const media = compilation(dir);
    write(media.path, "");
    write(app.media.paths(media.path).transcript, serialize(transcript()));
    const live = store.create("p", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    project.media = [media];
    project.clips = [{ id: "f", track: "v1", start: 0, duration: 1200, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }];
    await store.replace(project.id, null, project, "test");
    // Opened: its thumbnails and waveform, nothing read on screen.
    app.media.ensure(media.path, media);
    await Bun.sleep(50);
    expect(asked).toEqual([]);
    expect(burned.of(media)).toBeUndefined();
    // The agent's first look waits for the timeline's footage to be read.
    const context = JSON.parse((await call(app, "get_edit_context", { project_id: project.id })).text) as { media: string[] };
    expect(asked.length).toBeGreaterThan(0);
    expect(context.media[0]).toContain("· burned-in subtitles at 0–23s of it");
    // Read once: asked again, nothing is read again.
    const before = asked.length;
    await call(app, "get_edit_context", { project_id: project.id });
    expect(asked.length).toBe(before);
  } finally {
    cleanup();
  }
});

test("a read nobody waits on waits for a play to end and gives way between its steps; one the agent waits on goes first, a play or not", async () => {
  const playing = await import("../src/playing.ts");
  const { app, dir, cleanup } = fixtureHome("burned-plays");
  reading();
  playing.reset();
  const poll = playing.hooks.pollMs;
  playing.hooks.pollMs = 5;
  /** Each read: the file and how many frames. */
  const calls: [string, number][] = [];
  let onCall = (_count: number) => {};
  native().screenTextDetect = async (source, _size, indexes) => {
    calls.push([source.slice(source.lastIndexOf("/") + 1), indexes.length]);
    onCall(calls.length);
    // A line low and centred at every second, changing: subtitled throughout.
    return Object.fromEntries(indexes.map((index) => [index, [{ t: SAID[index % SAID.length]![1], b: [0.3, 0.85, 0.7, 0.9] }]]));
  };
  const long = (name: string) => ({ path: `${dir}/${name}.mp4`, name, kind: "video" as const, duration: 400, width: 1920, height: 1080 });
  const [quiet, wanted, stepped] = [long("quiet"), long("wanted"), long("stepped")];
  const frames = burned.grid(400).seconds.filter((second) => !burned.probes(400).includes(second)).length;
  try {
    // Something plays: a read nobody waits on doesn't start.
    playing.note("p", true);
    const later = burned.warm(app.media, quiet);
    await Bun.sleep(30);
    expect(calls).toEqual([]);
    // One the agent waits on goes first, and reads its grid in one go.
    expect(await burned.ready(app.media, [wanted], 5_000)).toEqual([]);
    expect(calls).toEqual([["wanted.mp4", 24], ["wanted.mp4", frames]]);
    expect(burned.of(wanted)?.spans).toEqual([[0, 400]]);
    // The play over, the other is read, a step at a time.
    calls.length = 0;
    playing.note("p", false);
    await later;
    expect(calls[0]).toEqual(["quiet.mp4", 24]);
    expect(calls.slice(1).map(([, count]) => count)).toEqual(Array.from({ length: Math.ceil(frames / 25) }, (_, index) => Math.min(25, frames - index * 25)));
    // A play starting mid-read: it stops after the step under way, and goes on once the play ends.
    calls.length = 0;
    onCall = (count) => {
      if (count === 2) playing.note("p", true);
    };
    const reading = burned.warm(app.media, stepped);
    await Bun.sleep(50);
    expect(calls.length).toBe(2);
    playing.note("p", false);
    await reading;
    expect(calls.length).toBe(1 + Math.ceil(frames / 25));
    expect(burned.of(stepped)).not.toBeUndefined();
  } finally {
    playing.hooks.pollMs = poll;
    playing.reset();
    cleanup();
  }
});
