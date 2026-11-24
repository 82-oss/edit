// Music removal: only what the edit plays is paid for, cleaned sound keeps its
// source's clock, and the team can bring a lost word back by crossfading to the
// original, then lengthen, shorten or undo it (Sphe and JJ, Nov 23).

import { beforeEach, expect, test } from "bun:test";

import type { Clip, Project } from "../src/model.ts";
import { applyBringBack, moveToCleaned, offWord, oneSidedIn, ORIGINAL_SOUND, outOfFades, playedIn, requests, soundsToClean, spanFrames } from "../src/music_removal.ts";
import { cleanedInfo, cleanedMarker, covers, enforceCleanedSound, merged, missing, soundSourceId, type Stretch } from "../src/music_removed.ts";
import { footageOf, soundUses } from "../src/project.ts";
import { footageSound } from "../src/subtitles.ts";
import { setsSegments } from "../src/watch.ts";
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
  expect(applyBringBack(project, 300, 330, 6, false)).toEqual({ pieces: 1, undone: 0, from: 300, to: 330 });
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
  expect(applyBringBack(project, 290, 345, 6, false)).toEqual({ pieces: 1, undone: 1, from: 290, to: 345 });
  const originals = audio(project).filter((one) => one.media === "m1");
  expect(originals.map((one) => [one.start, one.duration])).toEqual([[290, 55]]);
  expect(originals[0]!.source_in).toBeCloseTo(10 + 290 / 30, 6);
  // No crossfade is left inside the cleaned sound where the old piece was.
  expect(audio(project).filter((one) => one.media === "m2" && (one.crossfade ?? 0) > 0).map((one) => one.start)).toEqual([345]);
});

test("undo returns the span to the cleaned sound with no crossfade left", () => {
  const project = edit();
  applyBringBack(project, 300, 330, 6, false);
  expect(applyBringBack(project, 300, 330, 6, true)).toEqual({ pieces: 0, undone: 1, from: 300, to: 330 });
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

test("an empty or reversed span is refused before it's rounded to frames", () => {
  expect(() => spanFrames(30, 15.01, 15.01)).toThrow("end must be after start");
  expect(() => spanFrames(30, 20.02, 10.01)).toThrow("end must be after start");
  expect(() => spanFrames(30, null, 0)).toThrow("end must be after start");
  expect(spanFrames(30, 15.01, 15.02)).toEqual([450, 451]);
  expect(spanFrames(30, null, null)).toEqual([0, Number.MAX_SAFE_INTEGER]);
  expect(spanFrames(30, 10, null)).toEqual([300, Number.MAX_SAFE_INTEGER]);
});

test("a sound playing one side of its source keeps its music rather than both sides mixed", () => {
  const project = edit();
  (audio(project)[0] as Audio & { channel?: string }).channel = "left";
  expect(soundsToClean(project, 0, Number.MAX_SAFE_INTEGER).size).toBe(0);
  expect(oneSidedIn(project, 0, Number.MAX_SAFE_INTEGER)).toBe(1);
});

test("an overlay following the footage is cut with it, each part following its own", () => {
  const project = edit();
  const picture = project.clips.find((one) => one.id === "pic")!;
  const v2 = structuredClone(project.tracks.find((one) => one.id === picture.track)!);
  v2.id = "v2";
  project.tracks.push(v2);
  project.clips.push(clip({ id: "box", type: "solid", track: "v2", start: 200, duration: 400, parent: "pic" } as never));
  applyBringBack(project, 300, 330, 6, false);
  const boxes = project.clips.filter((one) => one.track === "v2").sort((a, b) => a.start - b.start);
  const pictures = project.clips.filter((one) => one.type === "video").sort((a, b) => a.start - b.start);
  expect(boxes.map((one) => [one.start, one.duration])).toEqual([[200, 100], [300, 30], [330, 270]]);
  expect(boxes.map((one) => one.parent)).toEqual(pictures.map((one) => one.id));
  // Undone, the overlay is one clip again, following the one picture.
  applyBringBack(project, 300, 330, 6, true);
  const after = project.clips.filter((one) => one.track === "v2");
  expect(after.map((one) => [one.start, one.duration, one.parent])).toEqual([[200, 400, "pic"]]);
});

test("an overlay following the footage with its own sound linked to it is cut and joined again with it", () => {
  const project = edit();
  const picture = project.clips.find((one) => one.id === "pic")!;
  const v2 = structuredClone(project.tracks.find((one) => one.id === picture.track)!);
  v2.id = "v2";
  const a2 = structuredClone(project.tracks.find((one) => one.kind === "audio")!);
  a2.id = "a2";
  project.tracks.push(v2, a2);
  project.media.push(media({ id: "m3", name: "b.mp4", path: "/nowhere/b.mp4", kind: "video", duration: 60, has_audio: true }));
  project.clips.push(clip({ id: "inset", type: "video", track: "v2", media: "m3", start: 200, duration: 400, source_in: 0, speed: 1, link: "l9", parent: "pic" } as never));
  project.clips.push(clip({ id: "insetsnd", type: "audio", track: "a2", media: "m3", start: 200, duration: 400, source_in: 0, speed: 1, volume_db: 0, link: "l9" }));
  applyBringBack(project, 300, 330, 6, false);
  expect(project.clips.filter((one) => one.track === "v2" || one.track === "a2").length).toBe(6);
  applyBringBack(project, 300, 330, 6, true);
  const after = project.clips.filter((one) => one.track === "v2" || one.track === "a2").sort((a, b) => a.track.localeCompare(b.track));
  expect(after.map((one) => [one.track, one.start, one.duration, one.link])).toEqual([["a2", 200, 400, "l9"], ["v2", 200, 400, "l9"]]);
  expect(after.find((one) => one.track === "v2")!.parent).toBe("pic");
});

test("words revealed on an overlay stay up across the cut, and its parts join again on undo", () => {
  const project = edit();
  const picture = project.clips.find((one) => one.id === "pic")!;
  const v2 = structuredClone(project.tracks.find((one) => one.id === picture.track)!);
  v2.id = "v2";
  project.tracks.push(v2);
  project.clips.push(
    clip({
      id: "said",
      type: "text",
      track: "v2",
      start: 270,
      duration: 120,
      parent: "pic",
      text: "one two three four",
      style: { font: "Geist", weight: 700, size: 96, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15 },
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      animation: { preset: "words", duration: 12, stagger: 1.5 },
      opacity: 1,
      word_times: [0, 20, 40],
    } as never),
  );
  applyBringBack(project, 300, 330, 6, false);
  const parts = project.clips.filter((one) => one.track === "v2").sort((a, b) => a.start - b.start) as Extract<Clip, { type: "text" }>[];
  expect(parts.map((one) => [one.start, one.word_times])).toEqual([[270, [0, 20, 40]], [300, [-30, -10, 10, -25.5]], [330, [-60, -40, -20, -55.5]]]);
  applyBringBack(project, 300, 330, 6, true);
  const joined = project.clips.filter((one) => one.track === "v2") as Extract<Clip, { type: "text" }>[];
  expect(joined.map((one) => [one.start, one.duration, one.word_times])).toEqual([[270, 120, [0, 20, 40]]]);
});

test("a callout already faded in stays up across the cut, and is one clip again on undo", () => {
  const project = edit();
  const picture = project.clips.find((one) => one.id === "pic")!;
  const v2 = structuredClone(project.tracks.find((one) => one.id === picture.track)!);
  v2.id = "v2";
  project.tracks.push(v2);
  project.clips.push(
    clip({
      id: "callout",
      type: "text",
      track: "v2",
      start: 200,
      duration: 300,
      parent: "pic",
      text: "Sergeant arrives",
      style: { font: "Geist", weight: 700, size: 96, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15 },
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      animation: { preset: "fade", duration: 12, stagger: 1.5 },
      opacity: 1,
    } as never),
  );
  applyBringBack(project, 300, 330, 6, false);
  const parts = project.clips.filter((one) => one.track === "v2").sort((a, b) => a.start - b.start) as Extract<Clip, { type: "text" }>[];
  expect(parts.map((one) => one.animation.preset)).toEqual(["fade", "none", "none"]);
  applyBringBack(project, 300, 330, 6, true);
  const joined = project.clips.filter((one) => one.track === "v2") as Extract<Clip, { type: "text" }>[];
  expect(joined.map((one) => [one.start, one.duration, one.animation.preset])).toEqual([[200, 300, "fade"]]);
});

test("an edge inside a fade moves out of it, so the picture fades as it did", () => {
  const project = edit();
  for (const one of project.clips) one.fade_out = 60;
  // 1770 is inside the last 60 frames' fade: the span starts where the fade does, and the end at the clip's end cuts nothing.
  expect(applyBringBack(project, 1770, 1790, 6, false)).toMatchObject({ pieces: 1, from: 1740, to: 1800 });
  const pictures = project.clips.filter((one) => one.type === "video").sort((a, b) => a.start - b.start);
  expect(pictures.map((one) => [one.start, one.duration, one.fade_out])).toEqual([[0, 1740, 0], [1740, 60, 60]]);
  expect(outOfFades(project, 900, "start", () => true)).toBe(900);
  // Asked again inside that fade, the replacement keeps out of it too.
  expect(applyBringBack(project, 1760, 1780, 6, false)).toMatchObject({ pieces: 1, from: 1740, to: 1800 });
  const again = project.clips.filter((one) => one.type === "video").sort((a, b) => a.start - b.start);
  expect(again.map((one) => [one.start, one.duration, one.fade_out])).toEqual([[0, 1740, 0], [1740, 60, 60]]);
});

test("only what the cut goes through moves an edge: a music bed fading in under it doesn't", () => {
  const project = edit();
  project.media.push(media({ id: "song", name: "song.wav", path: "/nowhere/song.wav", kind: "audio", duration: 90, has_audio: true, library: "music" } as never));
  const bedTrack = structuredClone(project.tracks.find((one) => one.kind === "audio")!);
  bedTrack.id = "a9";
  project.tracks.push(bedTrack);
  project.clips.push(clip({ id: "bed", type: "audio", track: "a9", media: "song", start: 0, duration: 1800, source_in: 0, speed: 1, volume_db: -20, fade_in: 900 }));
  expect(applyBringBack(project, 300, 330, 6, false)).toMatchObject({ pieces: 1, from: 300, to: 330 });
  expect(project.clips.find((one) => one.id === "bed")!.duration).toBe(1800);
});

test("a part cut off a clip is named after it, so it shakes as the clip did", () => {
  const project = edit();
  applyBringBack(project, 300, 330, 6, false);
  applyBringBack(project, 600, 630, 6, false);
  const pictures = project.clips.filter((one) => one.type === "video").sort((a, b) => a.start - b.start);
  expect(pictures.map((one) => one.id)).toEqual(["pic", "pic~1", "pic~2", "pic~3", "pic~4"]);
});

test("an impact shake following the footage is never cut: the span takes all of it", () => {
  const project = edit();
  const picture = project.clips.find((one) => one.id === "pic")!;
  const v2 = structuredClone(project.tracks.find((one) => one.id === picture.track)!);
  v2.id = "v2";
  project.tracks.push(v2);
  project.clips.push(clip({ id: "hit", type: "adjustment", track: "v2", start: 290, duration: 30, parent: "pic", grade: {}, shake: { preset: "impact" }, opacity: 1 } as never));
  expect(applyBringBack(project, 300, 310, 6, false)).toMatchObject({ pieces: 1, from: 290, to: 320 });
  expect(project.clips.filter((one) => one.type === "adjustment").map((one) => [one.start, one.duration])).toEqual([[290, 30]]);
  // A steady handheld wiggle reads only the timeline's time: cut where asked.
  const steady = edit();
  steady.tracks.push(v2);
  steady.clips.push(clip({ id: "wig", type: "adjustment", track: "v2", start: 290, duration: 30, parent: "pic", grade: {}, shake: { preset: "handheld" }, opacity: 1 } as never));
  expect(applyBringBack(steady, 300, 310, 6, false)).toMatchObject({ from: 300, to: 310 });
  // No preset, its own numbers: a hit all the same. No preset and no numbers: no shake at all.
  for (const [shake, span] of [
    [{ preset: "none", amount: 100, envelope: "hit" }, { from: 290, to: 320 }],
    [{ preset: "none", envelope: "hit" }, { from: 300, to: 310 }],
    // A wiggle below nothing is none (shake_offset clamps it).
    [{ preset: "none", amount: -5, envelope: "hit" }, { from: 300, to: 310 }],
  ] as const) {
    const custom = edit();
    custom.tracks.push(v2);
    custom.clips.push(clip({ id: "own", type: "adjustment", track: "v2", start: 290, duration: 30, parent: "pic", grade: {}, shake, opacity: 1 } as never));
    expect(applyBringBack(custom, 300, 310, 6, false)).toMatchObject(span);
  }
  // No amount of its own but one keyed in: it shakes, so it's kept whole.
  {
    const keyed = edit();
    keyed.tracks.push(v2);
    keyed.clips.push(clip({ id: "keyed", type: "adjustment", track: "v2", start: 290, duration: 30, parent: "pic", grade: {}, shake: { preset: "none", envelope: "hit" }, keyframes: { shake: [{ frame: 0, value: 120, ease: "linear" }] }, opacity: 1 } as never));
    expect(applyBringBack(keyed, 300, 310, 6, false)).toMatchObject({ from: 290, to: 320 });
  }
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

test("cleaned sound is watched, heard and segmented as its footage", () => {
  const project = edit();
  const sound = audio(project)[0]!;
  expect(footageOf(project, sound)).toBe("m1");
  // Where the source's words are needed includes what plays through the cleaned file; the cleaned file needs none of its own.
  expect(soundUses(project, "m1")).toEqual([[10, 70]]);
  expect(soundUses(project, "m2")).toEqual([]);
  // A video of nothing but footage still has its segments set by the watcher.
  expect(setsSegments(project)).toBe(true);
});

test("an edge inside a word moves out to take the whole word", () => {
  const words = [{ text: "move", start: 10, end: 10.3 }, { text: "your", start: 10.5, end: 10.7 }];
  expect(offWord(words, 10.1, "start")).toBeCloseTo(9.96, 6);
  expect(offWord(words, 10.6, "end")).toBeCloseTo(10.74, 6);
  expect(offWord(words, 10.4, "start")).toBe(10.4);
  // An edge in a word right after another is moved out of that word, not just past its neighbour.
  const close = [{ text: "move", start: 10, end: 10.3 }, { text: "your", start: 10.31, end: 10.7 }];
  expect(offWord(close, 10.32, "end")).toBeCloseTo(10.74, 6);
  expect(offWord(close, 10.305, "end")).toBeCloseTo(10.74, 6);
  expect(offWord(close, 10.32, "start")).toBeCloseTo(9.96, 6);
});

test("a seam's own crossfade comes back on undo", () => {
  const project = edit();
  const first = audio(project)[0]!;
  const picture = project.clips.find((one) => one.id === "pic")!;
  first.duration = 300;
  picture.duration = 300;
  project.clips.push(clip({ id: "pic2", type: "video", track: picture.track, media: "m1", start: 300, duration: 300, source_in: 20, speed: 1, link: "l2" }));
  project.clips.push(clip({ id: "snd2", type: "audio", track: first.track, media: "m2", start: 300, duration: 300, source_in: 20, speed: 1, volume_db: -20, link: "l2", crossfade: 12 } as never));
  applyBringBack(project, 300, 330, 6, false);
  expect(audio(project).find((one) => one.start === 300)!.crossfade).toBe(12);
  applyBringBack(project, 300, 330, 6, true);
  expect(audio(project).map((one) => [one.start, one.duration, one.crossfade ?? 0])).toEqual([[0, 300, 0], [300, 300, 12]]);
  expect(cleanedInfo(project.media.find((one) => one.id === "m2")!)!.seams).toBeUndefined();
});
