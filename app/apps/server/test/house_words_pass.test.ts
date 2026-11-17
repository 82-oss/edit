// Edit V2's house words, by itself after a turn (house_words_pass.ts; Sphe,
// Nov 17): a narration take saying a house word ends muted, a second pass
// changes nothing, a word kept unmuted stays so, V1 is left to its agent.

import { expect, test } from "bun:test";

import type { App } from "../src/app.ts";
import { effectLine, line, pass, start, unstarredIn } from "../src/house_words_pass.ts";
import type { AudioClip, Project, TextClip } from "../src/model.ts";
import { NOT_MUTED } from "../src/subtitles.ts";
import { serialize, type Transcript } from "../src/transcribe.ts";
import { fixtureHome, write } from "./helpers/home.ts";

const words = (said: [string, number, number][]): Transcript => ({ model: "scribe_v2", language: "eng", words: said.map(([text, start, end]) => ({ text, start, end, speaker: "speaker_0" })), speakers: {}, roles: {}, colors: {} });

const STYLE = { font: "Geist", weight: 700, size: 96, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15, glow: { enabled: false, color: null, radius: 46, strength: 0.5 } } as TextClip["style"];

/** An Edit V2 project (or V1, `hq` false): bodycam footage saying "fucking", a narration take saying "killed… kill", and a caption saying "drug". */
async function project(app: App, dir: string, hq = true): Promise<string> {
  const footage = `${dir}/bodycam.mp4`;
  const take = `${dir}/take.mp3`;
  write(app.media.paths(footage).transcript, serialize(words([["Stop", 1.0, 1.3], ["fucking", 1.35, 1.7], ["moving.", 1.75, 2.0]])));
  write(app.media.paths(take).transcript, serialize(words([["He", 0.0, 0.2], ["tried", 0.25, 0.5], ["to", 0.55, 0.65], ["kill", 0.7, 1.1], ["her.", 1.15, 1.4]])));
  const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
  const edited = structuredClone(live.project) as Project;
  if (hq) edited.hq = true;
  edited.media = [
    { id: "m", name: "bodycam", path: footage, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true },
    { id: "t", name: "take", path: take, kind: "audio", duration: 2, width: 0, height: 0, fps: 0, has_audio: true },
  ];
  const narrationTrack = edited.tracks.find((track) => track.kind === "audio" && track.id !== "a4")!.id;
  const sound = { color: "blue", fade_in: 0, fade_out: 0, type: "audio", source_in: 0, speed: 1, volume_db: 0 } as const;
  edited.clips = [
    { id: "f", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, link: "l1" },
    { ...sound, id: "a", track: "a4", start: 0, duration: 300, media: "m", link: "l1" },
    { ...sound, id: "vo", track: narrationTrack, start: 300, duration: 60, media: "t", name: "Voice-over" },
    { id: "c", track: "v2", start: 300, duration: 60, color: "cyan", name: "Caption", fade_in: 0, fade_out: 0, type: "text", text: "Drug deal gone wrong", style: STYLE, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, animation: { preset: "none", duration: 12, stagger: 1.5 }, opacity: 1 },
  ];
  await app.store.replace(edited.id, null, edited, "test");
  return edited.id;
}

const clip = (app: App, id: string, clipId: string) => app.store.get(id)!.project.clips.find((one) => one.id === clipId)!;

test("a V2 turn's narration take saying a house word ends muted, its first sound kept; the footage and captions too; a second pass changes nothing", async () => {
  const { app, dir, store, cleanup } = fixtureHome("house-pass");
  try {
    const id = await project(app, dir);
    const passed = await pass(app, id);
    expect(passed).toEqual({ narration: 1, sound: 1, starred: 1 });
    expect(line(passed!)).toBe("Muted 1 house word in the narration and 1 in the footage's sound, and starred 1 on screen.");
    const narration = (clip(app, id, "vo") as AudioClip).mutes!;
    expect(narration).toHaveLength(1);
    // "kill" said 0.7–1.1 s: its first sound is heard ("k-"), the rest muted.
    expect(narration[0]!.from).toBeGreaterThan(0.7);
    expect(narration[0]!.to).toBeGreaterThanOrEqual(1.1);
    expect((clip(app, id, "a") as AudioClip).mutes).toHaveLength(1);
    expect((clip(app, id, "c") as TextClip).text).toBe("D*** deal gone wrong");
    const rev = store.get(id)!.rev;
    expect(await pass(app, id)).toBeNull();
    expect(store.get(id)!.rev).toBe(rev);
  } finally {
    cleanup();
  }
});

test("a word kept unmuted stays unmuted, and a mute the agent made itself is never taken away", async () => {
  const { app, dir, store, cleanup } = fixtureHome("house-pass-keep");
  try {
    const id = await project(app, dir);
    await store.update(id, "test", (edited) => {
      edited.media.find((one) => one.id === "m")!.markers = [{ time: 1.35, name: NOT_MUTED, note: "fucking" }];
      // The agent's own mute_house_words words (a Doc's "Blur this"): "moving".
      (edited.clips.find((one) => one.id === "a") as AudioClip).mutes = [{ from: 1.75, to: 2.0 }];
    });
    expect(await pass(app, id)).toEqual({ narration: 1, sound: 0, starred: 1 });
    expect((clip(app, id, "a") as AudioClip).mutes).toEqual([{ from: 1.75, to: 2.0 }]);
  } finally {
    cleanup();
  }
});

test("a V1 project is left to its agent's mute_house_words", async () => {
  const { app, dir, store, cleanup } = fixtureHome("house-pass-v1");
  try {
    const id = await project(app, dir, false);
    const rev = store.get(id)!.rev;
    expect(await pass(app, id)).toBeNull();
    expect(store.get(id)!.rev).toBe(rev);
    expect((clip(app, id, "vo") as AudioClip).mutes ?? []).toEqual([]);
  } finally {
    cleanup();
  }
});

test("a turn that changed the edit is passed over when it ends, and the person reads one line; a turn that changed nothing isn't", async () => {
  const notes: [string, string][] = [];
  let told: () => void = () => {};
  const agents = { status: async () => ({}), ask: async () => "", note: (project: string, text: string) => { notes.push([project, text]); told(); } };
  const { app, dir, store, cleanup } = fixtureHome("house-pass-turn", { services: { agents: agents as never } });
  try {
    const id = await project(app, dir);
    start(app);
    const heard = new Promise<void>((resolve) => (told = resolve));
    store.emit({ type: "agent", event: "status", running: true, project: id } as never);
    await store.update(id, "agent", (edited) => {
      edited.name = "Changed";
    });
    store.emit({ type: "agent", event: "status", running: false, project: id } as never);
    await heard;
    expect(notes).toEqual([[id, "Muted 1 house word in the narration and 1 in the footage's sound, and starred 1 on screen."]]);
    // A turn with no change: nothing looked at, nothing said, no revision.
    const rev = store.get(id)!.rev;
    store.emit({ type: "agent", event: "status", running: true, project: id } as never);
    store.emit({ type: "agent", event: "status", running: false, project: id } as never);
    await pass(app, id);
    expect(store.get(id)!.rev).toBe(rev);
    expect(notes).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("an effect's words on screen are read from its code: unstarred house words named, names and starred words left out", async () => {
  expect(unstarredIn(`<h1>Shot dead in the street</h1><script>const state = "dead"; title.textContent = "KILL ZONE"; done = "k*ll";</script>`)).toEqual(["kill", "shot", "dead"]);
  expect(unstarredIn(`<div class="shot">S**t happens</div><script>play("crack-sound")</script>`)).toEqual([]);
  const { app, dir, store, cleanup } = fixtureHome("house-pass-effect");
  try {
    const id = await project(app, dir);
    const folder = `${store.uploadsDir(id)}/effects/title`;
    write(`${folder}/scene.html`, `<div>Drug bust</div>`);
    expect(effectLine(store, id, "title")).toContain(`(scene.html): "drug"`);
    write(`${folder}/scene.html`, `<div>D**g bust</div>`);
    expect(effectLine(store, id, "title")).toBeNull();
  } finally {
    cleanup();
  }
});
