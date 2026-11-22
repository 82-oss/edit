// A channel's add-on checks know V1's house graphics as the channel shows them:
// a placed effect brought in from the library as `v1-<name>` (house_effects.ts),
// where they counted only V1's own clips by name (Nov 22, Horror on dev: an
// analog look of v1-analog-look never met `horror_look_missing`, whose fix sent
// the agent to commentary_look, Internet Janitor's look). Per kind: the channel's
// project with the effects placed passes, without them the check says what a
// channel's agent can do. V1's projects are the files beside this one's.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import * as addons from "../src/addons.ts";
import { issues as essayIssues } from "../src/commentary_audit.ts";
import { hooks } from "../src/edit_plan.ts";
import { windowsUnderused } from "../src/edit_tools.ts";
import { fillReels } from "../src/horror_look.ts";
import type { Project } from "../src/model.ts";
import { issues as shortIssues } from "../src/shorts.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { clip, media, project as newProject, stubNative } from "./helpers/model.ts";

const WIDE = { width: 1920, height: 1080, fps: 30 };
const TALL = { width: 1080, height: 1920, fps: 30 };

/** An add-on switched on at a channel's edit lane, as set_addon keeps it. */
function on(channel: string, name: addons.Name, settings: Record<string, unknown> = {}): v2cloud.Skill {
  return { name: addons.skillOf(name), text: addons.write(name, true, settings), key: v2cloud.ownKey("skill", v2cloud.laneKey(channel, "edit"), addons.skillOf(name)), latest: 1 };
}

const saved = { ...hooks };
beforeAll(() => {
  stubNative();
  hooks.oneColourPerPerson = () => [];
  hooks.textOnFaces = () => [];
  hooks.picturesOnFaces = () => [];
  v2cloud.useSkillsForTests([
    on("ch-horror", "horror-look"),
    on("ch-horror", "essay-checks"),
    on("ch-ij", "essay-checks"),
    on("ch-shorts", "short-form", { forms: "short" }),
    on("ch-ted", "windows-screens"),
  ]);
});
afterAll(() => {
  Object.assign(hooks, saved);
  v2cloud.useSkillsForTests([]);
});

/** A channel's project: footage on v1, from 0 for `seconds`. */
function channelProject(channel: string, seconds: number, size = WIDE): Project {
  const p = newProject("house-effects", size);
  p.channel = channel;
  p.hq = true;
  p.media.push(media({ id: "news", name: "news.mp4", kind: "video", path: "/news.mp4", duration: 600, width: 1920, height: 1080 }));
  p.clips.push(clip({ id: "footage", type: "video", media: "news", track: "v1", start: 0, duration: seconds * 30, source_in: 0 }));
  return p;
}

/** An effect placed: its media (rendered, a video of the frame's size) and its clip. */
function place(p: Project, id: string, effect: string, track: string, start: number, frames: number, from?: string): void {
  p.media.push(media({ id: `m-${id}`, name: effect, kind: "video", path: `/${effect}.mp4`, duration: 600, width: p.settings.width, height: p.settings.height, effect, effect_key: "k", ...(from === undefined ? {} : { effect_from: from }) }));
  p.clips.push(clip({ id, type: "video", media: `m-${id}`, track, start, duration: frames, source_in: 0 }));
}

const found = (p: Project, kind: string) => essayIssues(p).filter((issue) => issue.kind === kind);

describe("horror (the Analog horror add-on)", () => {
  test("the look: v1-analog-look over every picture meets it, under any folder name it was brought in as; without it the fix is the channel's look", () => {
    const bare = channelProject("ch-horror", 20);
    expect(addons.has(bare, "horror-look")).toBe(true);
    const missing = found(bare, "horror_look_missing");
    expect(missing).toHaveLength(1);
    expect(String(missing[0]!.fix)).toContain("v1-analog-look");
    expect(String(missing[0]!.fix)).not.toContain("commentary_look");
    const graded = channelProject("ch-horror", 20);
    place(graded, "look", "v1-analog-look", "v3", 0, 600);
    expect(found(graded, "horror_look_missing")).toEqual([]);
    const renamed = channelProject("ch-horror", 20);
    place(renamed, "look", "grade-main", "v3", 0, 600, "v1-analog-look");
    expect(found(renamed, "horror_look_missing")).toEqual([]);
    // A card of its own above the look is a picture left ungraded, as V1's screenshot over its look was.
    place(graded, "card", "v1-retro-card", "v3", 300, 120);
    graded.tracks.push({ id: "v9", kind: "video", hidden: false, muted: false, locked: false } as Project["tracks"][number]);
    graded.clips.find((c) => c.id === "card")!.track = "v9";
    expect(found(graded, "horror_look_missing")).toHaveLength(1);
    // An effect of another name (the agent's own) is no look.
    const other = channelProject("ch-horror", 20);
    place(other, "look", "film-grain", "v3", 0, 600);
    expect(found(other, "horror_look_missing")).toHaveLength(1);
  });

  test("the story's own pictures: a v1- card is one, the look over the footage isn't", () => {
    const run = channelProject("ch-horror", 40);
    place(run, "look", "v1-analog-look", "v3", 0, 1200);
    expect(found(run, "horror_broll_run")).toHaveLength(1);
    place(run, "card", "v1-retro-card", "v2", 450, 300);
    expect(found(run, "horror_broll_run")).toEqual([]);
  });

  test("two cards up at once, words held too long, and an effect placed twice is no repeated clip", () => {
    const p = channelProject("ch-horror", 30);
    place(p, "look", "v1-analog-look", "v3", 0, 900);
    place(p, "a", "v1-picture-card", "v2", 0, 150);
    place(p, "b", "v1-retro-page", "v2", 60, 150);
    const stacked = found(p, "horror_cards_stacked");
    expect(stacked.map((one) => one.clip)).toEqual(["b"]);
    expect(String(stacked[0]!.fix)).not.toContain("backdrop, ground and marker");
    place(p, "t", "v1-horror-title", "v2", 400, 300);
    expect(found(p, "horror_text_long").map((one) => [one.clip, one.effect])).toEqual([["t", "v1-horror-title"]]);
    // The same dip at two cuts.
    p.media.push(media({ id: "m-dip", name: "v1-dip", kind: "video", path: "/v1-dip.mp4", duration: 2, width: 1920, height: 1080, effect: "v1-dip", effect_key: "k" }));
    p.clips.push(clip({ id: "d1", type: "video", media: "m-dip", track: "v2", start: 720, duration: 40, source_in: 0 }), clip({ id: "d2", type: "video", media: "m-dip", track: "v2", start: 850, duration: 40, source_in: 0 }));
    expect(found(p, "horror_repeated_clip")).toEqual([]);
  });

  test("a channel's Short: its graphics are tall and no reel to put over a blurred copy", () => {
    const p = channelProject("ch-horror", 10, TALL);
    place(p, "card", "v1-picture-card", "v2", 0, 120);
    const before = JSON.stringify(p.clips);
    fillReels(p);
    expect(JSON.stringify(p.clips)).toBe(before);
  });
});

describe("commentary (the narrated essay's checks)", () => {
  test("cards and centred text only: v1-card and v1-text count, other v1- graphics break it, and the fix names the channel's effects", () => {
    const p = channelProject("ch-ij", 300);
    for (let n = 0; n < 10; n++) place(p, `c${n}`, n % 2 === 0 ? "v1-card" : "v1-text", "v2", n * 600, 150);
    const monotony = found(p, "commentary_graphics_monotony");
    expect(monotony).toHaveLength(1);
    expect(String(monotony[0]!.fix)).toContain("v1-youtube");
    expect(String(monotony[0]!.fix)).not.toContain("commentary_youtube");
    for (let n = 0; n < 4; n++) place(p, `y${n}`, n % 2 === 0 ? "v1-youtube" : "v1-tweet", "v2", 6000 + n * 600, 150);
    expect(found(p, "commentary_graphics_monotony")).toEqual([]);
  });

  test("labels close together, a card too short to read", () => {
    const p = channelProject("ch-ij", 60);
    place(p, "l1", "v1-label", "v2", 0, 60);
    place(p, "l2", "v1-label", "v2", 300, 60);
    const labels = found(p, "commentary_label_overuse");
    expect(labels.map((one) => one.clip)).toEqual(["l2"]);
    expect(String(labels[0]!.fix)).toContain("v1-text");
    place(p, "card", "v1-card", "v2", 900, 30);
    expect(found(p, "commentary_short_card").map((one) => one.clip)).toEqual(["card"]);
  });

  test("a look or words over the footage are no shots of their own: a flash under them is still seen", () => {
    const p = channelProject("ch-ij", 0);
    p.clips = [];
    p.media.push(media({ id: "other", name: "other.mp4", kind: "video", path: "/other.mp4", duration: 600, width: 1920, height: 1080 }));
    p.clips.push(
      clip({ id: "a", type: "video", media: "news", track: "v1", start: 0, duration: 300, source_in: 0 }),
      clip({ id: "flash", type: "video", media: "other", track: "v1", start: 300, duration: 4, source_in: 0 }),
      clip({ id: "b", type: "video", media: "news", track: "v1", start: 304, duration: 300, source_in: 20 }),
    );
    place(p, "look", "v1-narration-look", "v3", 0, 604);
    expect(found(p, "commentary_flash").map((one) => one.clip)).toEqual(["flash"]);
  });
});

describe("shorts (the Shorts add-on)", () => {
  test("a wide shot shown whole: v1-shorts-blur-bars over it fills it; without, the fix names it", () => {
    const p = channelProject("ch-shorts", 50, TALL);
    const unfilled = shortIssues(p).filter((issue) => issue.kind === "short_unfilled");
    expect(unfilled.map((one) => one.clip)).toEqual(["footage"]);
    expect(String(unfilled[0]!.fix)).toContain("v1-shorts-blur-bars");
    place(p, "bars", "v1-shorts-blur-bars", "v2", 0, 1500);
    expect(shortIssues(p).filter((issue) => issue.kind === "short_unfilled")).toEqual([]);
  });
});

describe("bodycam (the Windows screen checks)", () => {
  test("a screen is a clip of v1-windows-desktop", () => {
    const p = channelProject("ch-ted", 60);
    p.script = { blocks: Array.from({ length: 12 }, (_, n) => ({ kind: "narration", id: `b${n}`, text: "words" })) } as unknown as Project["script"];
    const under = windowsUnderused(p);
    expect(under.map((one) => [(one as { screens?: number }).screens, (one as { at_least?: number }).at_least])).toEqual([[0, 2]]);
    expect(String((under[0] as { fix?: string }).fix)).toContain("v1-windows-desktop");
    expect(String((under[0] as { fix?: string }).fix)).not.toContain("cover_cut_in");
    place(p, "w1", "v1-windows-desktop", "v2", 0, 300);
    place(p, "w2", "v1-windows-desktop-2", "v2", 600, 300);
    expect(windowsUnderused(p)).toEqual([]);
  });
});
