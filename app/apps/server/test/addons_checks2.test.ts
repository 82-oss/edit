// The add-ons, slice 3 (Nov 21): edit_tools.ts and edit_review.ts ask
// `addons.has(project, …)` where they compared the project's style. The
// channel proof: a channel's project with nothing set, its style as
// routes.ts createChannelProject gives it (the channel's narration through
// `styleOf`), gets from every one of those sites what a V1 project of that
// style gets on the same fixture; and so does a V1 edit moved onto a channel,
// which keeps its style (channel_move.ts). It held on the code before the
// change, so it pins that nothing changed; test/addons.test.ts pins each
// site's condition and the V1 table.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { styleOf, useChannelsForTests, type Channel } from "../src/channels.ts";
import { hooks as planHooks } from "../src/edit_plan.ts";
import { narrationInFootage } from "../src/edit_review.ts";
import { audited, desktopsSparse, hooks, introLong, introWithoutArrest, registerEditingTools, windowsUnderused } from "../src/edit_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import type { Project, Style } from "../src/model.ts";
import { addTrack } from "../src/project.ts";
import type { Transcript } from "../src/transcribe.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";
import { clip, media, project as newProject, stubNative } from "./helpers/model.ts";

const WIDE = { width: 1920, height: 1080, fps: 30 };
const TALL = { width: 1080, height: 1920, fps: 30 };

function channel(key: string, narration: Channel["narration"]): Channel {
  return {
    key, youtubeId: null, handle: null, title: key, description: "", avatar: null, banner: null, uploads: null,
    subscribers: null, videos: null, views: null, country: null, publishedAt: null, fetchedAt: 0, narration, compilation: false,
  } as Channel;
}

const VOICED = channel("voiced", { kind: "voice", id: "v", name: "Andrew" });
const RECORDED = channel("recorded", { kind: "recorded" });

/** A channel's project beside the V1 project it must answer as: `made` in the channel (its style from the narration), or a V1 edit `moved` onto it. */
interface Pair {
  label: string;
  style: Style;
  channel: string;
  frame: typeof WIDE;
}

const PAIRS: Pair[] = [
  { label: "made in a voiced channel (bodycam)", style: styleOf(VOICED), channel: VOICED.key, frame: WIDE },
  { label: "made in a recorded channel (interrogation)", style: styleOf(RECORDED), channel: RECORDED.key, frame: WIDE },
  { label: "a courtroom edit moved onto a channel", style: "courtroom", channel: RECORDED.key, frame: WIDE },
  { label: "a commentary edit moved onto a channel", style: "commentary", channel: RECORDED.key, frame: WIDE },
  { label: "a horror edit moved onto a channel", style: "horror", channel: RECORDED.key, frame: WIDE },
  { label: "a Short moved onto a channel", style: "shorts", channel: VOICED.key, frame: TALL },
];

const savedHooks = { ...hooks };
const savedPlanHooks = { ...planHooks };
let savedToken: string | undefined;

beforeAll(() => {
  stubNative();
  registerEditingTools();
  savedToken = process.env.EDIT_RELAY_TOKEN;
  delete process.env.EDIT_RELAY_TOKEN;
  // As edit_tools.test.ts: what a test doesn't provide answers as an empty edit would.
  Object.assign(hooks, {
    peopleSummary: () => ({}),
    calloutTiming: () => [],
    subtitleCoverage: () => ({ uncovered: [] }),
    smoothingPending: () => [],
    smoothInBackground: () => [],
    waitForSmoothing: async () => true,
    waitForMaps: async () => {},
    watchInBackground: () => {},
    footageLoudness: async () => {
      throw new Error("no speech");
    },
  });
  Object.assign(planHooks, { oneColourPerPerson: () => [], textOnFaces: () => [], picturesOnFaces: () => [] });
  useChannelsForTests([VOICED, RECORDED]);
});

afterAll(() => {
  Object.assign(hooks, savedHooks);
  Object.assign(planHooks, savedPlanHooks);
  if (savedToken !== undefined) process.env.EDIT_RELAY_TOKEN = savedToken;
  useChannelsForTests([]);
});

test("the channels' styles are what createChannelProject gives", () => {
  expect([styleOf(VOICED), styleOf(RECORDED)]).toEqual(["bodycam", "interrogation"]);
});

// ── The sites that read only the project. ──

const words = (text: string, at: number) => text.split(" ").map((word, index) => ({ text: word, start: at + index * 0.3, end: at + index * 0.3 + 0.25 }));
const audioTrack = (p: Project) => p.tracks.find((one) => one.kind === "audio")!.id;

/** Each site run on a project that trips it for some style; the answer is what's compared. */
const PURE: { site: string; run: (p: Project) => unknown }[] = [
  { site: "introLong", run: (p) => introLong(p, [[0, 30 * 30], [36 * 30, 50 * 30]]) },
  {
    site: "introWithoutArrest",
    run: (p) => {
      p.media.push(media({ id: "m1", path: "/x.mp4", name: "x.mp4", kind: "video", duration: 100, width: 1920, height: 1080, fps: 30, has_audio: true }));
      p.clips.push(clip({ id: "a1", type: "audio", track: audioTrack(p), start: 0, duration: 300, media: "m1", name: "Teaser" }));
      const heard = new Map([["m1", { words: [...words("it will be the worst nightmare", 5), ...words("you're under arrest for risk of injury", 60)] } as unknown as Transcript]]);
      return introWithoutArrest(p, heard, [[0, 300]]);
    },
  },
  {
    // Counts V1's `Desktop · …` clips, so a channel's project with cut-ins enough gets it too: kept as it is.
    site: "windowsUnderused",
    run: (p) => {
      p.script = { blocks: Array.from({ length: 13 }, (_, index) => ({ kind: "narration", text: `cut-in ${index + 1}` })) } as unknown as Project["script"];
      return windowsUnderused(p);
    },
  },
  {
    site: "desktopsSparse",
    run: (p) => {
      p.clips.push(clip({ id: "d", name: "Cut-in 2 · Desktop · Notepad", type: "text", track: p.tracks[0]!.id, start: 10, duration: 10, text: "x" }));
      return desktopsSparse(p);
    },
  },
  {
    site: "narrationInFootage",
    run: (p) => {
      p.media.push(media({ id: "m7", name: "bodycam", path: "/b.mp4", kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true }));
      p.clips.push(clip({ id: "c24", type: "video", track: p.tracks.find((one) => one.kind === "video")!.id, start: 0, duration: 150, media: "m7", source_in: 272.2 }));
      p.clips.push(clip({ id: "c25", type: "audio", track: audioTrack(p), start: 0, duration: 150, media: "m7", source_in: 272.2 }));
      p.media.push(media({ id: "vo", name: "Cut-in 1", path: "/vo.mp3", kind: "audio", duration: 10, has_audio: true }));
      p.clips.push(clip({ id: "n1", type: "audio", track: addTrack(p, "audio"), start: 100, duration: 90, media: "vo", name: "Voice-over" }));
      return narrationInFootage(p);
    },
  },
];

function bare(style: Style, frame: typeof WIDE, onChannel: string | null): Project {
  const p = newProject("checks", frame);
  p.style = style;
  if (onChannel !== null) {
    p.hq = true;
    p.channel = onChannel;
  }
  return p;
}

describe("a channel's project answers as a V1 project of its style (the project alone)", () => {
  for (const one of PURE) {
    test(one.site, () => {
      const tripped: string[] = [];
      for (const pair of PAIRS) {
        const theirs = one.run(bare(pair.style, pair.frame, null));
        const ours = one.run(bare(pair.style, pair.frame, pair.channel));
        expect([pair.label, ours]).toEqual([pair.label, theirs]);
        if ((theirs as unknown[]).length > 0) tripped.push(pair.style);
      }
      // A fixture that trips nowhere (or everywhere) proves nothing.
      expect(tripped.length).toBeGreaterThan(0);
      expect(tripped.length).toBeLessThan(PAIRS.length);
    });
  }
});

// ── The sites that need Edit: the audit after a plan, the edit's context, remove_time. ──

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

async function tool(app: Fixture["app"], name: string, args: Record<string, unknown> = {}) {
  const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, null)) as {
    result: { content: { type: string; text?: string }[]; isError: boolean };
  };
  return reply.result;
}

/** The same edit twice in one home: as a V1 project of the pair's style, and as the channel's. */
async function twins(pair: Pair, fill: (p: Project) => void): Promise<{ v1: string; ours: string }> {
  const store = fixture!.store;
  const make = async (onChannel: string | null) => {
    const live = store.createAs("checks", pair.style, pair.frame, onChannel !== null, true);
    const [after] = await store.update(live.project.id, "test", (p) => {
      if (onChannel !== null) p.channel = onChannel;
      fill(p);
    });
    return after!.project.id;
  };
  return { v1: await make(null), ours: await make(pair.channel) };
}

/** An intro (0–10 s) with a plain subtitle in it, a narrated cut-in, two chapters and the footage under it: trips intro_uncaptioned and the essay's checks. */
function edit(p: Project): void {
  p.media.push(
    media({ id: "src", name: "Source", path: "/source.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true }),
    media({ id: "vo", name: "Narrator", path: "/vo.wav", kind: "audio", duration: 10, has_audio: true }),
  );
  p.clips.push(
    clip({ id: "foot", type: "video", track: "v1", start: 0, duration: 600, media: "src" }),
    clip({ id: "sub", type: "text", track: "v2", start: 30, duration: 60, name: "Subtitle · Officer", text: "Step out of the car." }),
    clip({ id: "card", type: "solid", track: "v1", start: 600, duration: 150, name: "Cut-in 1", link: "l1", fill: [0, 0, 0, 1] }),
    clip({ id: "voice", type: "audio", track: "a4", start: 600, duration: 150, media: "vo", link: "l1" }),
  );
  p.script = { blocks: [{ kind: "narration", text: "What happened next.", notes: ["Chapter: The stop"], clip: "card", voiceover: "voice" }] } as unknown as Project["script"];
}

describe("a channel's project answers as a V1 project of its style (in Edit)", () => {
  test("audited: the intro's captions, and the essay's list or the police edit's", async () => {
    fixture = fixtureHome("addons-audited");
    fixture.native.sections = () => ({ intro: [0, 300], intro_splits: 1, outro: null, parts: [{ kind: "intro", start: 0, end: 300, label: "Intro" }, { kind: "broll", start: 300, end: 900, label: "B-roll" }] });
    const kinds: Record<string, string[]> = {};
    for (const pair of PAIRS) {
      const { v1, ours } = await twins(pair, edit);
      const issues = (id: string) => audited(fixture!.app, fixture!.store.get(id)!.project, null).issues as unknown[];
      expect([pair.label, issues(ours)]).toEqual([pair.label, issues(v1)]);
      kinds[pair.style] = (issues(v1) as { kind: string }[]).map((issue) => issue.kind);
    }
    // The fixture trips both sides of each site somewhere.
    expect(kinds.bodycam).toContain("intro_uncaptioned");
    expect(kinds.interrogation).toContain("intro_uncaptioned");
    expect(kinds.courtroom).not.toContain("intro_uncaptioned");
    expect(kinds.commentary!.some((kind) => kind.startsWith("commentary_"))).toBe(true);
    expect(kinds.bodycam!.some((kind) => kind.startsWith("commentary_"))).toBe(false);
  });

  test("get_edit_context: the chapters and the overview", async () => {
    fixture = fixtureHome("addons-context");
    fixture.native.sections = () => ({ intro: null, intro_splits: 1, outro: null, parts: [] });
    const chapters: Record<string, boolean> = {};
    for (const pair of PAIRS) {
      const { v1, ours } = await twins(pair, edit);
      const context = async (id: string) => {
        fixture!.store.setActive(id);
        const result = await tool(fixture!.app, "get_edit_context");
        expect(result.isError, result.content[0]?.text).toBe(false);
        const read = JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
        // What the two sites decide: the chapters, and the overview's shape (its keys and its cut-ins' text).
        return { keys: Object.keys(read).sort(), chapters: read.chapters ?? null, cut_ins: read.cut_ins ?? null, clips: read.clips ?? null, audit: read.audit ?? null };
      };
      const theirs = await context(v1);
      expect([pair.label, await context(ours)]).toEqual([pair.label, theirs]);
      chapters[pair.style] = theirs.chapters !== null;
    }
    expect(chapters).toEqual({ bodycam: false, interrogation: false, courtroom: false, commentary: true, horror: true, shorts: false });
  });

  test("remove_time: most of the edit at once is asked of the person first, except in a Short", async () => {
    fixture = fixtureHome("addons-big-cut");
    const refused: Record<string, boolean> = {};
    for (const pair of PAIRS) {
      const fill = (p: Project) => {
        p.media.push(media({ id: "src", name: "Source", path: "/source.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true }));
        p.clips.push(clip({ id: "foot", type: "video", track: "v1", start: 0, duration: 300, media: "src" }));
      };
      const { v1, ours } = await twins(pair, fill);
      const cut = async (id: string) => {
        fixture!.store.setActive(id);
        const result = await tool(fixture!.app, "remove_time", { start: 0, end: 8 });
        return { refused: result.isError && (result.content[0]?.text ?? "").includes("Ask the person first"), clips: fixture!.store.get(id)!.project.clips.map((one) => [one.id, one.start, one.duration]) };
      };
      const theirs = await cut(v1);
      expect([pair.label, await cut(ours)]).toEqual([pair.label, theirs]);
      refused[pair.style] = theirs.refused;
    }
    expect(refused).toEqual({ bodycam: true, interrogation: true, courtroom: true, commentary: true, horror: true, shorts: false });
  });
});
