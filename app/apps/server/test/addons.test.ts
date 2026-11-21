// The add-ons' V1 table against the code (Nov 21): for every site that asks a
// project's style and becomes an add-on, and every style, what `has` and
// `setting` say for a V1 project is what the site's own condition says today.
//
// Two kinds of row. A live row runs the site's own exported code on a project
// that trips it, once per style. A restated row copies the site's condition
// here, and pins it: the file must still hold that condition word for word,
// or ask `has(…, "<the add-on>")` there instead, so a site changed any other
// way fails here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as addons from "../src/addons.ts";
import { styleOf, useChannelsForTests, type Channel } from "../src/channels.ts";
import { apply, audit, hooks } from "../src/edit_plan.ts";
import { desktopsSparse, introLong, introWithoutArrest, windowsUnderused } from "../src/edit_tools.ts";
import { interrogationIssues } from "../src/framing.ts";
import { fillReels, groundsWithCards, mosaicCensors, soundEdges, textOnTop } from "../src/horror_look.ts";
import { isEssay, NARRATION, STYLES, type Project, type Style } from "../src/model.ts";
import { narrationOf } from "../src/script.ts";
import { styleTerms } from "../src/subtitles.ts";
import type { Transcript } from "../src/transcribe.ts";
import { project as newProject, stubNative } from "./helpers/model.ts";

const ALL: Style[] = STYLES.map((one) => one.value);
const WIDE = { width: 1920, height: 1080, fps: 30 };
const TALL = { width: 1080, height: 1920, fps: 30 };

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

/** A V1 project (no channel) of this style and frame. */
function v1(style: Style, frame = WIDE): Project {
  const p = newProject("addons", frame);
  p.style = style;
  return p;
}

const source = (file: string) => readFileSync(join(import.meta.dir, "..", "src", file), "utf8");

// ── Restated rows: the condition each site asks today, word for word. ──

interface Restated {
  site: string;
  file: string;
  /** The site's condition as it is in the file. */
  text: string;
  /** Holds when the site's condition gives the add-on's side, as the site asks it. */
  today: (style: Style) => boolean;
  /** What the site will ask instead (several: either of them). */
  names: addons.Name[];
}

const RESTATED: Restated[] = [
  // Slice 2.
  { site: "edit_plan.ts audit: the essay's checks and early return", file: "edit_plan.ts", text: "if (isEssay(project.style)) {\n    return { issues: sortIssues([...issues, ...commentaryAudit.issues(project)])", today: (s) => isEssay(s), names: ["essay-checks"] },
  { site: "edit_plan.ts audit: a Short's checks and early return", file: "edit_plan.ts", text: 'if (project.style === "shorts") {\n    return { issues: sortIssues([...issues, ...shortsAudit.issues(project)])', today: (s) => s === "shorts", names: ["short-form"] },
  { site: "edit_plan.ts audit: no long_broll_shot", file: "edit_plan.ts", text: 'project.style === "courtroom" || project.style === "interrogation" ? [] : project.clips', today: (s) => s === "courtroom" || s === "interrogation", names: ["held-broll"] },
  { site: "edit_plan.ts audit: the section's longest bed", file: "edit_plan.ts", text: 'project.style === "interrogation" ? LONGEST_SECTION_BED : LONGEST_BED', today: (s) => s === "interrogation", names: ["interrogation-music"] },
  { site: "edit_plan.ts audit: music_repeated from 6", file: "edit_plan.ts", text: 'project.style === "interrogation" ? 6 : 3', today: (s) => s === "interrogation", names: ["interrogation-music"] },
  { site: "edit_plan.ts audit: tape_start_unmarked, countdown_late", file: "edit_plan.ts", text: 'if (project.style === "interrogation") {\n    const counts = project.clips.filter((clip) => clip.type === "text" && clip.name === "Countdown"', today: (s) => s === "interrogation", names: ["interrogation-structure"] },
  { site: "edit_plan.ts audit: end_new_picture", file: "edit_plan.ts", text: 'if (project.style === "interrogation") {\n    const shown = ', today: (s) => s === "interrogation", names: ["interrogation-structure"] },
  { site: "edit_plan.ts audit: small_text", file: "edit_plan.ts", text: 'if (project.style === "courtroom") {\n    const scale = project.settings.height / 1080;', today: (s) => s === "courtroom", names: ["courtroom-text"] },
  { site: "edit_plan.ts audit: subtitle_coloured for unlabelled subtitles", file: "edit_plan.ts", text: 'if (text.style.label == null && project.style !== "courtroom") continue;', today: (s) => s === "courtroom", names: ["courtroom-text"] },
  { site: "onscreen.ts issues: broll_recut", file: "onscreen.ts", text: 'if (project.style === "courtroom" || project.style === "interrogation") out.push(...recuts(project, clips));', today: (s) => s === "courtroom" || s === "interrogation", names: ["held-broll"] },
  { site: "framing.ts interrogationIssues", file: "framing.ts", text: 'if (project.style !== "interrogation") return [];', today: (s) => s === "interrogation", names: ["interrogation-structure"] },
  { site: "footage_levels.ts issues: music_mood on bridges", file: "footage_levels.ts", text: 'if (project.style === "interrogation") {\n    // Categories come from the library\'s listing', today: (s) => s === "interrogation", names: ["interrogation-music"] },
  // The other half of this gate, `project.subtitle_look === "in_video"`, isn't an add-on and stays beside it.
  { site: "people.ts oneColourPerPerson: unlabelled subtitles kept white", file: "people.ts", text: 'if (style.label == null && (project.style === "courtroom" || project.subtitle_look === "in_video")) continue;', today: (s) => s === "courtroom", names: ["courtroom-text"] },
  // Slice 3.
  { site: "edit_tools.ts bigCut", file: "edit_tools.ts", text: '// A Short starts as its whole source and is cut down to a minute: its workflow takes out most of it at once.\n  if (project.style === "shorts") return;', today: (s) => s === "shorts", names: ["short-form"] },
  { site: "edit_tools.ts introLong", file: "edit_tools.ts", text: 'export function introLong(project: Project, teasers: [number, number][]): Json[] {\n  if (project.style !== "bodycam" || teasers.length === 0 || scripted(project)) return [];', today: (s) => s === "bodycam", names: ["bodycam-intro"] },
  { site: "edit_tools.ts windowsUnderused", file: "edit_tools.ts", text: 'export function windowsUnderused(project: Project): Json[] {\n  if (project.style !== "bodycam") return [];', today: (s) => s === "bodycam", names: ["windows-screens"] },
  { site: "edit_tools.ts desktopsSparse", file: "edit_tools.ts", text: 'export function desktopsSparse(project: Project): Json[] {\n  if (project.style !== "bodycam") return [];', today: (s) => s === "bodycam", names: ["windows-screens"] },
  { site: "edit_tools.ts introWithoutArrest", file: "edit_tools.ts", text: '// A script decides where its intro ends ("according to the script, the intro stops after this"): only an edit without one is told to end on the arrest.\n  if (project.style !== "bodycam" || teasers.length === 0 || scripted(project)) return [];', today: (s) => s === "bodycam", names: ["bodycam-intro"] },
  { site: "edit_tools.ts introUncaptioned", file: "edit_tools.ts", text: 'if (project.style !== "interrogation" && project.style !== "bodycam") return [];', today: (s) => s === "interrogation" || s === "bodycam", names: ["intro-captions"] },
  { site: "edit_tools.ts audited: the essay's list", file: "edit_tools.ts", text: "const extra = isEssay(project.style) ? [", today: (s) => isEssay(s), names: ["essay-checks"] },
  { site: "edit_tools.ts editContext: the chapter overview", file: "edit_tools.ts", text: "const overview = isEssay(p.style) && from === null && to === null && ids === null;", today: (s) => isEssay(s), names: ["essay-checks"] },
  { site: "edit_tools.ts editContext: chapters", file: "edit_tools.ts", text: "...(isEssay(p.style) ? { chapters: commentaryAudit.outline(p) } : {}),", today: (s) => isEssay(s), names: ["essay-checks"] },
  { site: "edit_review.ts narrationInFootage: none", file: "edit_review.ts", text: 'if (isEssay(project.style) || project.style === "shorts") return [];', today: (s) => isEssay(s) || s === "shorts", names: ["essay-checks", "short-form"] },
  // Slice 4.
  { site: "horror_look.ts fillReels", file: "horror_look.ts", text: 'const fresh = (prefix: string) => freshId(project, prefix);\n  if (project.style !== "horror") return;', today: (s) => s === "horror", names: ["horror-look"] },
  { site: "horror_look.ts mosaicCensors", file: "horror_look.ts", text: 'export function mosaicCensors(project: Project): void {\n  if (project.style !== "horror") return;', today: (s) => s === "horror", names: ["horror-look"] },
  { site: "horror_look.ts textOnTop", file: "horror_look.ts", text: 'export function textOnTop(project: Project): void {\n  if (project.style !== "horror") return;', today: (s) => s === "horror", names: ["horror-look"] },
  { site: "horror_look.ts soundEdges", file: "horror_look.ts", text: 'export function soundEdges(project: Project): void {\n  if (project.style !== "horror") return;', today: (s) => s === "horror", names: ["horror-look"] },
  { site: "horror_look.ts groundsWithCards", file: "horror_look.ts", text: 'export function groundsWithCards(project: Project): void {\n  if (project.style !== "horror") return;', today: (s) => s === "horror", names: ["horror-look"] },
  // Reached only inside the essay's audit, so on a channel it takes essay-checks too.
  { site: "commentary_audit.ts pacing: horror's checks", file: "commentary_audit.ts", text: 'if (p.style === "horror") {', today: (s) => s === "horror", names: ["horror-look"] },
  { site: "commentary_sources.ts capture_evidence: the page whole", file: "commentary_sources.ts", text: 'const around = app.store.get(projectId)?.project.style === "horror";', today: (s) => s === "horror", names: ["horror-look"] },
  { site: "commentary_sources.ts search_broll: competitors left out", file: "commentary_sources.ts", text: 'if (app.store.get(projectId)?.project.style === "horror") {\n          const theirs = videos.filter((v) => competitor(v.channel, v.title));', today: (s) => s === "horror", names: ["no-competitor-footage"] },
  { site: "commentary_sources.ts import_broll: competitors refused", file: "commentary_sources.ts", text: 'if (app.store.get(projectId)?.project.style === "horror") {\n    for (const id of sources) {', today: (s) => s === "horror", names: ["no-competitor-footage"] },
  // Slice 5.
  { site: "script.ts followOn: the research turn", file: "script.ts", text: '!(now !== null && now !== undefined && isEssay(now.project.style)) && now?.project.style !== "shorts"', today: (s) => !isEssay(s) && s !== "shorts", names: ["case-research"] },
  { site: "script.ts footageToCloud: YouTube as excerpts", file: "script.ts", text: "isEssay(live.project.style) && youtube.idOf(file) !== null", today: (s) => isEssay(s), names: ["youtube-excerpts"] },
  { site: "subtitles.ts houseWords: the style's words", file: "subtitles.ts", text: "extra = [...styleTerms(project.style), ...extra];", today: (s) => styleTerms(s).length > 0, names: ["muted-words"] },
  { site: "subtitles.ts muteHouseWords: the style's words", file: "subtitles.ts", text: "extra = [...styleTerms(live.project.style), ...extra];", today: (s) => styleTerms(s).length > 0, names: ["muted-words"] },
  { site: "house_words_pass.ts effectLine: the style's words", file: "house_words_pass.ts", text: "const extra = styleTerms(live.project.style);", today: (s) => styleTerms(s).length > 0, names: ["muted-words"] },
  // Slice 9: a Short is its footage's own sound, so its import fetches and places no recording (script.ts narrationOf).
  { site: "script.ts followOn: a Short narrated by no one", file: "script.ts", text: 'NARRATION[app.store.get(id)?.project.style ?? "bodycam"] === "recording"', today: (s) => NARRATION[s] === "none", names: ["short-form"] },
];

/** The site still asks as it did, or asks the add-on (`has(…, "name")`) instead. */
function pinned(row: Restated): boolean {
  const file = source(row.file);
  if (file.includes(row.text)) return true;
  return row.names.every((name) => new RegExp(`has\\([^)]*"${name}"\\)`, "u").test(file));
}

describe("the V1 table, site by site (restated, pinned to the source)", () => {
  for (const row of RESTATED) {
    test(row.site, () => {
      expect(pinned(row)).toBe(true);
      for (const style of ALL) {
        for (const frame of [WIDE, TALL]) {
          const p = v1(style, frame);
          expect([style, frame.height > frame.width ? "tall" : "wide", row.names.some((name) => addons.has(p, name))]).toEqual([style, frame.height > frame.width ? "tall" : "wide", row.today(style)]);
        }
      }
    });
  }
});

// ── Live rows: the site's own code run on a project that trips it. ──

type Probe = (p: Project) => boolean;
const words = (text: string, at: number) => text.split(" ").map((word, index) => ({ text: word, start: at + index * 0.3, end: at + index * 0.3 + 0.25 }));

const LIVE: { site: string; name: addons.Name; trips: Probe }[] = [
  { site: "edit_tools.ts introLong", name: "bodycam-intro", trips: (p) => introLong(p, [[0, 30 * 30], [36 * 30, 50 * 30]]).length > 0 },
  {
    site: "edit_tools.ts introWithoutArrest", name: "bodycam-intro",
    trips: (p) => {
      p.media.push({ id: "m1", path: "/x.mp4", name: "x.mp4", kind: "video", duration: 100, width: 1920, height: 1080, fps: 30, has_audio: true } as Project["media"][number]);
      const track = p.tracks.find((one) => one.kind === "audio")!.id;
      p.clips.push({ id: "a1", type: "audio", track, start: 0, duration: 300, media: "m1", source_in: 0, speed: 1, volume_db: 0, name: "Teaser", color: "green", fade_in: 0, fade_out: 0, keyframes: {} } as Project["clips"][number]);
      const heard = new Map([["m1", { words: [...words("it will be the worst nightmare", 5), ...words("you're under arrest for risk of injury", 60)] } as unknown as Transcript]]);
      return introWithoutArrest(p, heard, [[0, 300]]).length > 0;
    },
  },
  {
    site: "edit_tools.ts windowsUnderused", name: "windows-screens",
    trips: (p) => {
      p.script = { blocks: Array.from({ length: 13 }, (_, index) => ({ kind: "narration", text: `cut-in ${index + 1}` })) } as unknown as Project["script"];
      return windowsUnderused(p).length > 0;
    },
  },
  {
    site: "edit_tools.ts desktopsSparse", name: "windows-screens",
    trips: (p) => {
      p.clips.push({ id: "d", name: "Cut-in 2 · Desktop · Notepad", type: "text", track: p.tracks[0]!.id, start: 10, duration: 10 } as unknown as Project["clips"][number]);
      return desktopsSparse(p).length > 0;
    },
  },
  {
    site: "framing.ts interrogationIssues: hook_unmarked", name: "interrogation-structure",
    trips: (p) => interrogationIssues(p, [{ kind: "intro", start: 0, end: 300 }, { kind: "broll", start: 300, end: 600 }], () => ["a riser"]).length > 0,
  },
  {
    site: "edit_plan.ts audit: small_text", name: "courtroom-text",
    trips: (p) => {
      apply(p, [
        { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 90, fill: [0.5, 0.5, 0.5, 1] } },
        { op: "add", clip: { type: "text", track: "new", name: "Reaction • Oath", start: 0, duration: 60, text: "*UNDER OATH*", style: { size: 44 } } },
      ]);
      return (audit(p).issues as { kind: string }[]).some((issue) => issue.kind === "small_text");
    },
  },
  {
    site: "edit_plan.ts audit: subtitle_coloured, unlabelled", name: "courtroom-text",
    trips: (p) => {
      apply(p, [{ op: "add", clip: { type: "text", track: "new", name: "Subtitle · Trooper", start: 0, duration: 60, text: "Yes, sir.", style: { size: 48, color: [0.4, 0.6, 1, 1] } } }]);
      return (audit(p).issues as { kind: string }[]).some((issue) => issue.kind === "subtitle_coloured");
    },
  },
  {
    // On a wide frame: short_not_vertical comes only from a Short's checks.
    site: "edit_plan.ts audit: a Short's checks", name: "short-form",
    trips: (p) => (audit(p).issues as { kind: string }[]).some((issue) => issue.kind === "short_not_vertical"),
  },
  {
    site: "horror_look.ts fillReels", name: "horror-look",
    trips: (p) => {
      p.media.push({ id: "reel", path: "/reel.mp4", name: "reel.mp4", kind: "video", duration: 30, width: 1080, height: 1920, fps: 30, has_audio: false } as Project["media"][number]);
      p.clips.push({ id: "r", type: "video", track: p.tracks[0]!.id, start: 0, duration: 90, media: "reel", source_in: 0, speed: 1, name: "Reel", transform: { scale: 1, x: 0, y: 0 }, keyframes: {} } as unknown as Project["clips"][number]);
      const before = p.clips.length;
      fillReels(p);
      return p.clips.length > before;
    },
  },
  {
    site: "horror_look.ts mosaicCensors", name: "horror-look",
    trips: (p) => {
      const blur = { radius: 20, width: 200, height: 200 } as { radius: number; width: number; height: number; mosaic?: number };
      p.clips.push({ id: "b", type: "adjustment", track: p.tracks[1]!.id, start: 0, duration: 30, name: "Censor", blur, keyframes: {} } as unknown as Project["clips"][number]);
      mosaicCensors(p);
      return (blur.mosaic ?? 0) > 0;
    },
  },
  {
    site: "horror_look.ts textOnTop", name: "horror-look",
    trips: (p) => {
      p.clips.push({ id: "t", type: "text", track: p.tracks[0]!.id, start: 0, duration: 30, name: "Horror · title", text: "x" } as unknown as Project["clips"][number]);
      p.clips.push({ id: "v", type: "video", track: p.tracks[1]!.id, start: 0, duration: 30, media: "m", name: "Footage" } as unknown as Project["clips"][number]);
      const track = p.clips[0]!.track;
      textOnTop(p);
      return p.clips[0]!.track !== track;
    },
  },
  {
    site: "horror_look.ts soundEdges", name: "horror-look",
    trips: (p) => {
      const clip = { id: "vo", type: "audio", track: p.tracks[3]!.id, start: 0, duration: 90, media: "n", source_in: 0, speed: 1, volume_db: 0, name: "Voice-over", fade_in: 0, fade_out: 0, keyframes: {} };
      p.clips.push(clip as unknown as Project["clips"][number]);
      soundEdges(p);
      return clip.fade_out > 0;
    },
  },
  {
    site: "horror_look.ts groundsWithCards", name: "horror-look",
    trips: (p) => {
      p.clips.push({ id: "g", type: "video", track: p.tracks[0]!.id, start: 0, duration: 30, media: "m", name: "Horror · card ground" } as unknown as Project["clips"][number]);
      groundsWithCards(p);
      return p.clips.length === 0;
    },
  },
];

describe("the V1 table, site by site (the site's own code)", () => {
  for (const row of LIVE) {
    test(row.site, () => {
      const tripped = ALL.filter((style) => {
        const p = v1(style);
        const trips = row.trips(p);
        expect([style, addons.has(p, row.name)]).toEqual([style, trips]);
        return trips;
      });
      // A probe that trips nowhere (or everywhere) proves nothing.
      expect(tripped.length).toBeGreaterThan(0);
      expect(tripped.length).toBeLessThan(ALL.length);
    });
  }

  test("subtitles.ts styleTerms: the words muted-words gives", () => {
    const termsOf = (list: "commentary" | "horror" | undefined) => (list === undefined ? [] : styleTerms(list));
    for (const style of ALL) {
      for (const frame of [WIDE, TALL]) {
        const p = v1(style, frame);
        const extra = addons.setting(p, "muted-words", "words") ?? [];
        expect([style, [...termsOf(addons.setting(p, "muted-words", "list")), ...extra]]).toEqual([style, styleTerms(style)]);
      }
    }
    expect(styleTerms("commentary").length).toBeGreaterThan(0);
    expect(styleTerms("horror").length).toBeGreaterThan(styleTerms("commentary").length);
  });

  test("script.ts narrationOf: a V1 project's narration is its style's, whatever its frame", () => {
    for (const style of ALL) for (const frame of [WIDE, TALL]) expect([style, frame.height, narrationOf(v1(style, frame))]).toEqual([style, frame.height, NARRATION[style]]);
  });

  test("model.ts isEssay: the sites built on it", () => {
    for (const style of ALL) expect([style, addons.has(v1(style), "essay-checks")]).toEqual([style, isEssay(style)]);
  });
});

describe("the catalogue", () => {
  test("each style's list, as the design's table has it", () => {
    expect(Object.fromEntries(ALL.map((style) => [style, addons.v1Of(style)]))).toEqual({
      bodycam: ["bodycam-intro", "windows-screens", "intro-captions", "case-research"],
      interrogation: ["intro-captions", "held-broll", "interrogation-music", "interrogation-structure", "case-research"],
      courtroom: ["held-broll", "courtroom-text", "case-research", "court-script"],
      commentary: ["essay-checks", "post-details", "reverb-out", "youtube-excerpts", "muted-words", "essay-script"],
      horror: ["essay-checks", "horror-look", "no-competitor-footage", "post-details", "reverb-out", "youtube-excerpts", "muted-words"],
      shorts: ["short-form"],
    });
  });

  // end_check.ts (Nov 21): Edit's own check when a turn ends, which wakes the agent, is no kind's: a channel sets it.
  test("end-check is off for every style, and on a channel with nothing set", () => {
    for (const style of ALL) {
      expect([style, addons.has(v1(style), "end-check"), addons.has(v1(style, TALL), "end-check")]).toEqual([style, false, false]);
      expect([style, addons.has(onChannel("unset-channel", WIDE, style), "end-check")]).toEqual([style, false]);
    }
    expect(addons.CATALOGUE["end-check"]).toMatchObject({ lane: "edit", trigger: "turn-end", v1: [], form: "any", settings: {} });
  });

  test("every default passes its own check, and every V1 setting too", () => {
    for (const name of addons.NAMES) {
      const own = addons.CATALOGUE[name];
      for (const [key, one] of Object.entries(own.settings)) expect([name, key, one.check(one.default)]).toEqual([name, key, true]);
      for (const given of Object.values(own.v1Settings ?? {})) {
        for (const [key, value] of Object.entries(given)) expect([name, key, own.settings[key]?.check(value)]).toEqual([name, key, true]);
      }
    }
  });

  test("a setting the project doesn't have the add-on for is undefined", () => {
    expect(addons.setting(v1("bodycam"), "muted-words", "list")).toBeUndefined();
    expect(addons.setting(v1("courtroom"), "courtroom-text", "smallest")).toBe(60);
    expect(addons.setting(v1("shorts"), "short-form", "forms")).toBe("short");
  });
});

// ── A channel's project with nothing set: its narration's list, then its frame. ──

function channel(key: string, narration: Channel["narration"]): Channel {
  return {
    key, youtubeId: null, handle: null, title: key, description: "", avatar: null, banner: null, uploads: null,
    subscribers: null, videos: null, views: null, country: null, publishedAt: null, fetchedAt: 0, narration, compilation: false,
  } as Channel;
}

function onChannel(key: string, frame = WIDE, style: Style = "bodycam"): Project {
  const p = v1(style, frame);
  p.channel = key;
  return p;
}

const on = (p: Project) => addons.NAMES.filter((name) => addons.has(p, name));
const onEdit = (p: Project) => on(p).filter((name) => addons.CATALOGUE[name].lane === "edit");
/** A style's edit-lane add-ons. */
const EDIT_LANE = (style: Style) => addons.v1Of(style).filter((name) => addons.CATALOGUE[name].lane === "edit");

describe("a channel's project with no add-ons set", () => {
  const CHANNELS = [
    channel("recorded", { kind: "recorded" }),
    channel("voiced", { kind: "voice", id: "v", name: "Andrew" }),
    channel("unset", null),
  ];

  test("one made in the channel: bodycam's list, or interrogation's when its narration is recorded", () => {
    useChannelsForTests(CHANNELS);
    // As routes.ts createChannelProject makes it: its style from the channel's narration.
    const made = (key: string) => onChannel(key, WIDE, styleOf(CHANNELS.find((one) => one.key === key)!));
    expect(on(made("recorded"))).toEqual(EDIT_LANE("interrogation"));
    expect(on(made("voiced"))).toEqual(EDIT_LANE("bodycam"));
    expect(on(made("unset"))).toEqual(EDIT_LANE("bodycam"));
  });

  test("its style decides, not the narration read now: a moved V1 edit, a narration changed since, a channel not read", () => {
    useChannelsForTests(CHANNELS);
    // channel_move.ts keeps a moved edit's style, so what ran for its kind still runs.
    expect(onEdit(onChannel("voiced", WIDE, "courtroom"))).toEqual(EDIT_LANE("courtroom"));
    expect(onEdit(onChannel("voiced", WIDE, "horror"))).toEqual(EDIT_LANE("horror"));
    expect(on(onChannel("recorded", WIDE, "bodycam"))).toEqual(EDIT_LANE("bodycam"));
    useChannelsForTests([]);
    expect(on(onChannel("recorded", WIDE, "interrogation"))).toEqual(EDIT_LANE("interrogation"));
  });

  test("for each style, a channel's wide project has what a V1 one of that style has (its edit lane)", () => {
    useChannelsForTests(CHANNELS);
    for (const style of ALL.filter((one) => one !== "shorts")) expect([style, onEdit(onChannel("voiced", WIDE, style))]).toEqual([style, EDIT_LANE(style)]);
  });

  test("ofChannel: every add-on of the lane as a project made there now gets them, by narration", () => {
    useChannelsForTests(CHANNELS);
    const lane = addons.NAMES.filter((name) => addons.CATALOGUE[name].lane === "edit");
    const onOf = (key: string) => addons.ofChannel(key, "edit").filter((one) => one.on).map((one) => one.name);
    expect(addons.ofChannel("recorded", "edit").map((one) => one.name)).toEqual(lane);
    expect(onOf("recorded")).toEqual(EDIT_LANE("interrogation"));
    expect(onOf("voiced")).toEqual(EDIT_LANE("bodycam"));
    expect(onOf("unset")).toEqual(EDIT_LANE("bodycam"));
    expect(onOf("not-read-yet")).toEqual(EDIT_LANE("bodycam"));
    expect(addons.ofChannel("recorded", "edit").every((one) => one.from === "default")).toBe(true);
    // The script lane: none by default.
    for (const key of ["recorded", "voiced"]) expect(addons.ofChannel(key, "script").map((one) => [one.name, one.on])).toEqual([["court-script", false], ["essay-script", false]]);
  });
});

describe("form filtering", () => {
  test("a project is a Short when it's taller than wide; one without a frame is long", () => {
    expect(addons.formOf(v1("bodycam", TALL))).toBe("short");
    expect(addons.formOf(v1("bodycam", WIDE))).toBe("long");
    expect(addons.formOf(v1("bodycam", { width: 1080, height: 1080, fps: 30 }))).toBe("long");
    expect(addons.formOf({ style: "courtroom" })).toBe("long");
  });

  test("each add-on's form", () => {
    const by = (form: addons.Form) => addons.NAMES.filter((name) => addons.CATALOGUE[name].form === form);
    expect(by("short")).toEqual(["short-form"]);
    expect(by("long")).toEqual(["bodycam-intro", "windows-screens", "intro-captions", "held-broll", "interrogation-music", "interrogation-structure", "courtroom-text", "essay-checks", "case-research"]);
    expect(by("any")).toEqual(["horror-look", "no-competitor-footage", "post-details", "reverb-out", "youtube-excerpts", "muted-words", "end-check", "court-script", "essay-script"]);
    for (const name of addons.NAMES) {
      const form = addons.CATALOGUE[name].form;
      expect([name, addons.fits(form, v1("bodycam", WIDE)), addons.fits(form, v1("bodycam", TALL))]).toEqual([name, form !== "short", form !== "long"]);
    }
  });

  // The frame decides only on a channel that has set `short-form` itself (slice 6 reads those items; until then no
  // channel has). Anywhere else a channel's project runs what its style ran whatever its frame, as V1 does: a V1 edit
  // with an odd frame moved onto a channel keeps its checks and its research turn.
  test("on a channel that hasn't set short-form, a project keeps its style's list whatever its frame", () => {
    useChannelsForTests([channel("recorded", { kind: "recorded" }), channel("voiced", { kind: "voice", id: "v", name: "Andrew" })]);
    for (const frame of [WIDE, TALL]) {
      expect(on(onChannel("voiced", frame, "bodycam"))).toEqual(addons.v1Of("bodycam"));
      expect(on(onChannel("recorded", frame, "interrogation"))).toEqual(addons.v1Of("interrogation"));
      expect(on(onChannel("voiced", frame, "shorts"))).toEqual(addons.v1Of("shorts"));
      expect(on(onChannel("voiced", frame, "horror"))).toEqual(addons.v1Of("horror"));
      expect(on(onChannel("voiced", frame, "courtroom"))).toEqual(addons.v1Of("courtroom"));
    }
  });

  test("a V1 project keeps its style's list whatever its frame, as the code does today", () => {
    for (const style of ALL) expect([style, on(v1(style, TALL))]).toEqual([style, addons.v1Of(style)]);
  });
});
