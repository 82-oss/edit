// Add-ons, slice 2 (Nov 21): the checks in edit_plan.ts, onscreen.ts,
// framing.ts and people.ts ask a project's add-ons instead of its style. A
// channel's project with nothing set on its channel is checked exactly as a
// V1 project of the style it was made with, on the same footage: bodycam's
// when its channel's narration isn't recorded, interrogation's when it is.
// It holds before the change too: it pins that nothing changed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { styleOf, useChannelsForTests, type Channel } from "../src/channels.ts";
import { apply, audit, hooks } from "../src/edit_plan.ts";
import { interrogationIssues } from "../src/framing.ts";
import type { Project } from "../src/model.ts";
import { issues as onscreenIssues } from "../src/onscreen.ts";
import { oneColourPerPerson } from "../src/people.ts";
import { newProject } from "../src/project.ts";
import { media, stubNative } from "./helpers/model.ts";

const saved = { ...hooks };
beforeAll(() => {
  stubNative();
  hooks.oneColourPerPerson = () => [];
  hooks.textOnFaces = () => [];
  hooks.picturesOnFaces = () => [];
});
afterAll(() => {
  Object.assign(hooks, saved);
  useChannelsForTests([]);
});

function channel(key: string, narration: Channel["narration"]): Channel {
  return {
    key, youtubeId: null, handle: null, title: key, description: "", avatar: null, banner: null, uploads: null,
    subscribers: null, videos: null, views: null, country: null, publishedAt: null, fetchedAt: 0, narration, compilation: false,
  } as Channel;
}

const VOICED = channel("voiced", { kind: "voice", id: "v", name: "Andrew" });
const RECORDED = channel("recorded", { kind: "recorded" });
const WIDE = { width: 1920, height: 1080, fps: 30 };
const TALL = { width: 1080, height: 1920, fps: 30 };

/**
 * Footage that trips each style's own checks: a long B-roll shot and one song
 * three times (bodycam's), a bed past bodycam's longest, a countdown with no
 * riser after a date, a new picture after the last page (interrogation's), a
 * small callout and a coloured unlabelled subtitle (courtroom's), and two
 * back-to-back shots of one camera.
 */
function lay(p: Project): Project {
  p.media.push(
    media({ id: "m1", name: "f", path: "/f.mp4", kind: "video", duration: 600, width: 1920, height: 1080, has_audio: false }),
    media({ id: "song", name: "Song.wav", path: "/home/library/music/abc/Song.wav", kind: "audio", duration: 120 }),
    media({ id: "vo", name: "vo.mp3", path: "/vo.mp3", kind: "audio", duration: 30 }),
    media({ id: "mug", name: "mug", path: "/mug.png", kind: "image", duration: 30, width: 800, height: 1000 }),
  );
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 3000, fill: [0, 0, 0, 1] } },
    { op: "add", clip: { type: "video", track: "new", name: "Cut-in 1 · B-roll: a", media: "m1", source_in: 10, start: 1200, duration: 300 } },
    { op: "add", clip: { type: "video", track: "v2", name: "Cut-in 1 · B-roll: b", media: "m1", source_in: 20, start: 1500, duration: 30 } },
    { op: "add", clip: { type: "audio", track: "new", name: "Voice-over", media: "vo", source_in: 0, start: 0, duration: 600 } },
    { op: "add", clip: { type: "audio", track: "new", media: "song", source_in: 0, start: 0, duration: 300 } },
    { op: "add", clip: { type: "audio", track: "new", media: "song", source_in: 0, start: 1000, duration: 300 } },
    { op: "add", clip: { type: "audio", track: "new", media: "song", source_in: 0, start: 2000, duration: 900 } },
    { op: "date_title", text: "March 16, 2024", place: "Austin, Texas", start: 60, end: 200 },
    { op: "countdown", start: 450, end: 600 },
    { op: "add", clip: { type: "text", track: "new", name: "Reaction • Oath", start: 700, duration: 60, text: "*UNDER OATH*", style: { size: 44 } } },
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle · Trooper", start: 800, duration: 60, text: "Yes, sir.", style: { size: 48, color: [0.4, 0.6, 1, 1] } } },
    { op: "add", clip: { type: "video", track: "new", media: "mug", source_in: 0, start: 2600, duration: 300, name: "Resolution · mugshot" } },
    { op: "add", clip: { type: "text", track: "new", start: 2600, duration: 180, text: "He was charged.", name: "Resolution · page 1" } },
    { op: "add", clip: { type: "video", track: "new", media: "mug", source_in: 0, start: 2780, duration: 120, name: "Resolution · mugshot full" } },
  ]);
  return p;
}

const PARTS = [{ start: 0, end: 300, kind: "intro" }, { start: 300, end: 700, kind: "broll" }];

/** Everything this slice's sites answer for a project. */
function checked(p: Project) {
  const coloured = structuredClone(p);
  return {
    audit: audit(p).issues,
    framing: interrogationIssues(p, PARTS, () => ["a riser"]),
    onscreen: onscreenIssues(p).issues,
    people: [oneColourPerPerson(coloured), coloured.clips],
  };
}

/** A V1 project of this style (no channel). */
const v1 = (style: Project["style"], frame = WIDE) => lay(newProject("p", "v1", frame, style));

/** As routes.ts createChannelProject makes one: its style from the channel's narration, then its channel. */
function made(given: Channel, frame = WIDE): Project {
  const p = newProject("p", "channel", frame, styleOf(given));
  p.hq = true;
  p.channel = given.key;
  return lay(p);
}

const kindsOf = (found: unknown[]) => new Set((found as { kind: string }[]).map((one) => one.kind));

describe("a channel's project with nothing set is checked as a V1 project of its style", () => {
  test("bodycam: a channel whose narration isn't recorded", () => {
    useChannelsForTests([VOICED, RECORDED]);
    const channelled = made(VOICED);
    expect(channelled.style).toBe("bodycam");
    const v1Checks = checked(v1("bodycam"));
    expect(checked(channelled)).toEqual(v1Checks);
    // The fixture is bodycam's, not anyone's: its own checks fire, interrogation's and courtroom's don't.
    const kinds = kindsOf(v1Checks.audit);
    for (const kind of ["long_broll_shot", "music_repeated", "music_bed_long"]) expect([kind, kinds.has(kind)]).toEqual([kind, true]);
    for (const kind of ["tape_start_unmarked", "countdown_late", "end_new_picture", "small_text", "subtitle_coloured"]) expect([kind, kinds.has(kind)]).toEqual([kind, false]);
    expect(v1Checks.framing).toEqual([]);
  });

  test("interrogation: a channel whose narration is recorded", () => {
    useChannelsForTests([VOICED, RECORDED]);
    const channelled = made(RECORDED);
    expect(channelled.style).toBe("interrogation");
    const v1Checks = checked(v1("interrogation"));
    expect(checked(channelled)).toEqual(v1Checks);
    const kinds = kindsOf(v1Checks.audit);
    for (const kind of ["tape_start_unmarked", "countdown_late", "end_new_picture"]) expect([kind, kinds.has(kind)]).toEqual([kind, true]);
    for (const kind of ["long_broll_shot", "music_repeated", "music_bed_long", "small_text", "subtitle_coloured"]) expect([kind, kinds.has(kind)]).toEqual([kind, false]);
    expect(v1Checks.framing.length).toBeGreaterThan(0);
  });

  test("the two differ on this footage, so each comparison proves something", () => {
    useChannelsForTests([VOICED, RECORDED]);
    expect(checked(made(VOICED)).audit).not.toEqual(checked(made(RECORDED)).audit);
  });

  test("bodycam, tall: still bodycam's (none of these checks are bodycam's, so a Short's frame changes nothing)", () => {
    useChannelsForTests([VOICED, RECORDED]);
    expect(checked(made(VOICED, TALL))).toEqual(checked(v1("bodycam", TALL)));
  });

  test("a channel not read yet: its project's stored style decides", () => {
    useChannelsForTests([]);
    const p = newProject("p", "channel", WIDE, "interrogation");
    p.hq = true;
    p.channel = "recorded";
    expect(checked(lay(p))).toEqual(checked(v1("interrogation")));
  });
});
