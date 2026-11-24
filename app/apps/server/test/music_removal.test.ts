// Music removal: only what the edit plays is paid for, cleaned sound keeps its
// source's clock, and the team can bring a lost word back by crossfading to the
// original, then lengthen, shorten or undo it (Sphe and JJ, Nov 23).

import { beforeEach, expect, test } from "bun:test";

import type { Clip, Project } from "../src/model.ts";
import { applyBringBack, moveToCleaned, offWord, ORIGINAL_SOUND, playedIn, requests, soundsToClean } from "../src/music_removal.ts";
import { cleanedInfo, cleanedMarker, covers, enforceCleanedSound, merged, missing, soundSourceId, type Stretch } from "../src/music_removed.ts";
import { footageSound } from "../src/subtitles.ts";
import { clip, media, project as newProject, stubNative } from "./helpers/model.ts";

beforeEach(stubNative);

type Audio = Extract<Clip, { type: "audio" }>;
const audio = (project: Project) => project.clips.filter((one): one is Audio => one.type === "audio").sort((a, b) => a.start - b.start);

/** A 60 s picture and its sound (source 10–70 s), the sound on a file cleaned over `stretches`. */
function edit(stretches: Stretch[] = [[9, 71]]): Project {
  const project = newProject();
  project.media.push(media({ id: "m1", name: "a.mp4", path: "/nowhere/a.mp4", kind: "video", duration: 120, has_audio: true }));
  project.media.push(media({ id: "m2", name: "a (music removed).flac", path: "/nowhere/a.flac", kind: "audio", duration: 120, has_audio: true, markers: [cleanedMarker({ of: "m1", stretches })] }));
  const v = project.tracks.find((track) => track.kind === "video")!.id;
  const a = project.tracks.find((track) => track.kind === "audio")!.id;
  project.clips.push(clip({ id: "pic", type: "video", track: v, media: "m1", start: 0, duration: 1800, source_in: 10, speed: 1, link: "l1" }));
  project.clips.push(clip({ id: "snd", type: "audio", track: a, media: "m2", start: 0, duration: 1800, source_in: 10, speed: 1, volume_db: 0, link: "l1" }));
  return project;
}

test("only what isn't cleaned yet is sent, in pieces a request can take", () => {
  expect(merged([[5, 6], [1, 2], [1.5, 3]])).toEqual([[1, 3], [5, 6]]);
  expect(missing([[0, 10]], [[2, 4], [6, 8]])).toEqual([[0, 2], [4, 6], [8, 10]]);
  expect(missing([[2, 4]], [[0, 10]])).toEqual([]);
  expect(covers([[0, 5], [5, 9]], 1, 8)).toBe(true);
  expect(covers([[0, 5]], 1, 8)).toBe(false);
  expect(requests([[0, 1200]], 540)).toEqual([[0, 540], [540, 1080], [1080, 1200]]);
});

test("a cleaned file says what it is, and any other file says nothing", () => {
  expect(cleanedInfo({ markers: [cleanedMarker({ of: "m1", stretches: [[1, 2]] })] })).toEqual({ of: "m1", stretches: [[1, 2]] });
  expect(cleanedInfo({ markers: [{ time: 3, name: "hit" }] })).toBeNull();
  expect(cleanedInfo({ markers: [{ time: 0, name: "music removed", note: "not json" }] })).toBeNull();
});

test("music and sound effects are never cleaned, only footage", () => {
  const project = edit();
  project.media.push(media({ id: "song", name: "song.wav", path: "/nowhere/song.wav", kind: "audio", duration: 90, has_audio: true, library: "music" } as never));
  const a = project.tracks.find((track) => track.kind === "audio")!.id;
  project.clips.push(clip({ id: "bed", type: "audio", track: a, media: "song", start: 1800, duration: 300, source_in: 0, speed: 1, volume_db: -20 }));
  const groups = soundsToClean(project, 0, Number.MAX_SAFE_INTEGER);
  expect([...groups.keys()]).toEqual(["m1"]);
  expect(groups.get("m1")!.map((one) => one.id)).toEqual(["snd"]);
});

test("a sound trimmed past what's cleaned plays its original, never silence", () => {
  const project = edit([[9, 40]]);
  expect(enforceCleanedSound(project)).toBe(1);
  expect(audio(project)[0]!.media).toBe("m1");
  const kept = edit();
  expect(enforceCleanedSound(kept)).toBe(0);
  expect(audio(kept)[0]!.media).toBe("m2");
});

test("bringing a word back crossfades to the original on the same clock, picture and sound cut together", () => {
  const project = edit();
  expect(applyBringBack(project, 300, 330, 6, false)).toEqual({ pieces: 1, undone: 0 });
  const [left, middle, right] = audio(project);
  expect([left!.media, middle!.media, right!.media]).toEqual(["m2", "m1", "m2"]);
  expect([left!.duration, middle!.start, middle!.duration, right!.start]).toEqual([300, 300, 30, 330]);
  expect(middle!.source_in).toBeCloseTo(20, 6);
  expect(right!.source_in).toBeCloseTo(21, 6);
  expect([middle!.crossfade, right!.crossfade]).toEqual([6, 6]);
  expect(middle!.name).toBe(ORIGINAL_SOUND);
  const pictures = project.clips.filter((one) => one.type === "video").sort((a, b) => a.start - b.start);
  expect(pictures.map((one) => one.start)).toEqual([0, 300, 330]);
  expect(pictures.map((one) => one.link)).toEqual(audio(project).map((one) => one.link));
});

test("asked again it replaces the piece, so it can be made longer", () => {
  const project = edit();
  applyBringBack(project, 300, 330, 6, false);
  expect(applyBringBack(project, 290, 345, 6, false)).toEqual({ pieces: 1, undone: 1 });
  const originals = audio(project).filter((one) => one.media === "m1");
  expect(originals.map((one) => [one.start, one.duration])).toEqual([[290, 55]]);
  expect(originals[0]!.source_in).toBeCloseTo(10 + 290 / 30, 6);
  // No crossfade is left inside the cleaned sound where the old piece was.
  expect(audio(project).filter((one) => one.media === "m2" && (one.crossfade ?? 0) > 0).map((one) => one.start)).toEqual([345]);
});

test("undo returns the span to the cleaned sound with no crossfade left", () => {
  const project = edit();
  applyBringBack(project, 300, 330, 6, false);
  expect(applyBringBack(project, 300, 330, 6, true)).toEqual({ pieces: 0, undone: 1 });
  expect(audio(project).every((one) => one.media === "m2" && (one.crossfade ?? 0) === 0 && one.name === undefined)).toBe(true);
  // And no stray cuts: the picture and sound are one clip each again.
  expect(audio(project).map((one) => [one.start, one.duration])).toEqual([[0, 1800]]);
  expect(project.clips.filter((one) => one.type === "video").map((one) => [one.start, one.duration])).toEqual([[0, 1800]]);
});

test("a real cut next to the piece is never joined", () => {
  const project = edit();
  const snd = audio(project)[0]!;
  snd.duration = 300;
  project.clips.find((one) => one.id === "pic")!.duration = 300;
  const a = snd.track;
  const v = project.clips.find((one) => one.id === "pic")!.track;
  project.clips.push(clip({ id: "pic2", type: "video", track: v, media: "m1", start: 300, duration: 300, source_in: 50, speed: 1, link: "l2" }));
  project.clips.push(clip({ id: "snd2", type: "audio", track: a, media: "m2", start: 300, duration: 300, source_in: 50, speed: 1, volume_db: 0, link: "l2" }));
  applyBringBack(project, 300, 330, 6, false);
  expect(audio(project)[1]!.crossfade).toBe(0);
  applyBringBack(project, 300, 330, 6, true);
  expect(audio(project).map((one) => [one.start, one.duration])).toEqual([[0, 300], [300, 300]]);
});

test("a span with no cleaned sound says so", () => {
  const project = edit();
  expect(() => applyBringBack(project, 2000, 2010, 6, false)).toThrow("no cleaned sound");
  expect(() => applyBringBack(project, 30, 30, 6, false)).toThrow("end must be after start");
});

test("a muted track is never paid for", () => {
  const project = edit();
  project.tracks.find((track) => track.kind === "audio")!.muted = true;
  expect(soundsToClean(project, 0, Number.MAX_SAFE_INTEGER).size).toBe(0);
});

test("asked for ten seconds of a long clip, only those ten seconds are sent and change", () => {
  const project = edit();
  const sound = audio(project)[0]!;
  sound.media = "m1";
  expect(playedIn(project, sound, 300, 600)).toEqual([20, 30]);
  expect(moveToCleaned(project, ["snd"], "m1", "m2", [[19, 31]], 300, 600)).toBe(1);
  const [left, middle, right] = audio(project);
  expect([left!.media, middle!.media, right!.media]).toEqual(["m1", "m2", "m1"]);
  expect([middle!.start, middle!.duration, middle!.source_in]).toEqual([300, 300, 20]);
  expect([middle!.crossfade, right!.crossfade]).toEqual([6, 6]);
  expect(project.clips.filter((one) => one.type === "video").map((one) => one.start).sort((a, b) => a - b)).toEqual([0, 300, 600]);
});

test("a span that isn't cleaned stays as it was, uncut", () => {
  const project = edit();
  audio(project)[0]!.media = "m1";
  expect(moveToCleaned(project, ["snd"], "m1", "m2", [[19, 25]], 300, 600)).toBe(0);
  expect(audio(project).map((one) => [one.start, one.duration])).toEqual([[0, 1800]]);
});

test("undo never joins two pieces with different levels", () => {
  const project = edit();
  const first = audio(project)[0]!;
  const picture = project.clips.find((one) => one.id === "pic")!;
  first.duration = 300;
  picture.duration = 300;
  project.clips.push(clip({ id: "pic2", type: "video", track: picture.track, media: "m1", start: 300, duration: 300, source_in: 20, speed: 1, link: "l2" }));
  project.clips.push(clip({ id: "snd2", type: "audio", track: first.track, media: "m2", start: 300, duration: 300, source_in: 20, speed: 1, volume_db: -20, link: "l2" }));
  applyBringBack(project, 300, 330, 6, false);
  applyBringBack(project, 300, 330, 6, true);
  expect(audio(project).map((one) => [one.start, one.duration, one.volume_db])).toEqual([[0, 300, 0], [300, 300, -20]]);
});

test("a gap too short to pay for still counts as not cleaned, so that frame plays the original", () => {
  expect(missing([[1, 8]], [[0, 5], [5.01, 9]])).toEqual([]);
  expect(covers([[0, 5], [5.01, 9]], 1, 8)).toBe(false);
  expect(covers([[0, 5], [5.0005, 9]], 1, 8)).toBe(true);
});

test("two sounds of one take on separate tracks both move, though splitting one splits the other", () => {
  const project = edit();
  const first = audio(project)[0]!;
  first.media = "m1";
  const track = structuredClone(project.tracks.find((one) => one.id === first.track)!);
  track.id = "a2";
  project.tracks.push(track);
  project.clips.push(clip({ id: "snd2", type: "audio", track: "a2", media: "m1", start: 0, duration: 1800, source_in: 10, speed: 1, volume_db: 0, channel: "right", link: "l1" } as never));
  expect(moveToCleaned(project, ["snd", "snd2"], "m1", "m2", [[19, 31]], 300, 600)).toBe(2);
  for (const id of [first.track, "a2"]) {
    const pieces = audio(project).filter((one) => one.track === id);
    expect(pieces.map((one) => [one.start, one.media])).toEqual([[0, "m1"], [300, "m2"], [600, "m1"]]);
  }
});

test("cleaned sound is still the footage's sound, so its lines are still subtitled", () => {
  const project = edit();
  expect(footageSound(project, 0, 1800).map((one) => one.id)).toEqual(["snd"]);
  // Its words, faces, speakers and the words kept unmuted are all looked up on the video it came from.
  expect([soundSourceId(project, "m2"), soundSourceId(project, "m1"), soundSourceId(project, "gone")]).toEqual(["m1", "m1", "gone"]);
});

test("an edge inside a word moves out to take the whole word", () => {
  const words = [{ text: "move", start: 10, end: 10.3 }, { text: "your", start: 10.5, end: 10.7 }];
  expect(offWord(words, 10.1, "start")).toBeCloseTo(9.96, 6);
  expect(offWord(words, 10.6, "end")).toBeCloseTo(10.74, 6);
  expect(offWord(words, 10.4, "start")).toBe(10.4);
});
