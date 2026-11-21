// The horror and research add-ons asked of a channel's project (slice 4, Nov 21):
// horror_look.ts's passes after every plan, the essay audit's horror checks,
// and the research tools' competitor rule. A channel's project with nothing set
// (its style a bodycam's, as routes.ts createChannelProject makes it) gets
// none of them, exactly as a V1 bodycam project on the same fixture, and a V1
// horror project gets them all. It held before the sites asked `has()` too: it
// pins that the question changed, never the answer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as addons from "../src/addons.ts";
import { styleOf, useChannelsForTests, type Channel } from "../src/channels.ts";
import { issues as essayIssues } from "../src/commentary_audit.ts";
import { keep } from "../src/commentary_sources.ts";
import { apply, hooks } from "../src/edit_plan.ts";
import { fillReels, groundsWithCards, mosaicCensors, soundEdges, textOnTop } from "../src/horror_look.ts";
import { handlerFor } from "../src/mcp/registry.ts";
import type { Project } from "../src/model.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media, project as newProject, stubNative } from "./helpers/model.ts";
import { MockServer } from "./mocks/server.ts";

const WIDE = { width: 1920, height: 1080, fps: 30 };

function channel(key: string, narration: Channel["narration"]): Channel {
  return {
    key, youtubeId: null, handle: null, title: key, description: "", avatar: null, banner: null, uploads: null,
    subscribers: null, videos: null, views: null, country: null, publishedAt: null, fetchedAt: 0, narration, compilation: false,
  } as Channel;
}

const CHANNELS = [channel("voiced", { kind: "voice", id: "v", name: "Andrew" }), channel("unset", null)];

/** Each project the passes are asked of: V1's two, and a channel's as it's made (its style from the narration). */
const KINDS = ["v1-bodycam", "channel-voiced", "channel-unset", "v1-horror"] as const;
type Kind = (typeof KINDS)[number];

function shaped(p: Project, kind: Kind): Project {
  if (kind === "v1-bodycam") p.style = "bodycam";
  else if (kind === "v1-horror") p.style = "horror";
  else {
    const key = kind.slice("channel-".length);
    p.style = styleOf(CHANNELS.find((one) => one.key === key)!);
    p.channel = key;
  }
  return p;
}

/** One project holding what trips each of the five passes, apart in time so none touches another's. */
function scene(kind: Kind): Project {
  const p = newProject("addons-horror", WIDE);
  p.media.push(
    media({ id: "reel", name: "reel.mp4", kind: "video", path: "/reel.mp4", duration: 30, width: 720, height: 1280, has_audio: true }),
    media({ id: "wide", name: "news.mp4", kind: "video", path: "/news.mp4", duration: 30, width: 1920, height: 1080, has_audio: true }),
    media({ id: "shot", name: "bio.png", kind: "image", path: "/bio.png", duration: 0, width: 1170, height: 900 }),
    media({ id: "vo", name: "narration.wav", kind: "audio", path: "/vo.wav", duration: 600 }),
  );
  p.clips.push(
    // fillReels: a tall reel full frame.
    clip({ id: "reel-clip", type: "video", media: "reel", track: "v2", start: 0, duration: 120, source_in: 3 }),
    // textOnTop: horror's words under a picture placed above them.
    clip({ id: "title", type: "text", track: "v1", start: 200, duration: 60, name: "Horror · title", text: "THE CASE" }),
    clip({ id: "over", type: "video", media: "wide", track: "v3", start: 200, duration: 60 }),
    // mosaicCensors: a region blur over the footage.
    clip({ id: "censor", type: "adjustment", track: "v3", start: 300, duration: 30, name: "Censor", blur: { radius: 20, width: 200, height: 200 } }),
    // soundEdges: the narration cut with no fade.
    clip({ id: "voice", type: "audio", media: "vo", track: "a4", start: 400, duration: 90, source_in: 0, name: "Voice-over" } as never),
    // groundsWithCards: a card's ground with its card gone.
    clip({ id: "lone", type: "video", media: "shot", track: "v1", start: 600, duration: 90, name: "Horror · card ground" }),
  );
  return shaped(p, kind);
}

/** What the passes may change: the clips and tracks, as JSON. */
const cut = (p: Project) => JSON.stringify({ clips: p.clips, tracks: p.tracks });

/** The five passes, in the order edit_plan.ts applyWith and edit_tools.ts cover_cut_in run them. */
function passes(p: Project): void {
  fillReels(p);
  mosaicCensors(p);
  textOnTop(p);
  soundEdges(p);
  groundsWithCards(p);
}

const saved = { ...hooks };
beforeAll(() => {
  stubNative();
  hooks.oneColourPerPerson = () => [];
  hooks.textOnFaces = () => [];
  hooks.picturesOnFaces = () => [];
  useChannelsForTests(CHANNELS);
});
afterAll(() => {
  Object.assign(hooks, saved);
  useChannelsForTests([]);
});

describe("horror's passes after every plan", () => {
  test("a channel's project with nothing set: none of them, as a V1 bodycam project", () => {
    const before = cut(scene("v1-bodycam"));
    for (const kind of KINDS.filter((one) => one !== "v1-horror")) {
      const p = scene(kind);
      passes(p);
      expect([kind, cut(p)]).toEqual([kind, before]);
      expect([kind, addons.has(p, "horror-look")]).toEqual([kind, false]);
    }
  });

  test("a V1 horror project: every one of them", () => {
    const p = scene("v1-horror");
    passes(p);
    const named = (name: string) => p.clips.filter((c) => c.name === name);
    expect(named("Horror · reel backdrop")).toHaveLength(1);
    expect(named("Horror · reel blur")).toHaveLength(1);
    expect((p.clips.find((c) => c.id === "censor") as { blur: { mosaic?: number } }).blur.mosaic ?? 0).toBeGreaterThan(0);
    expect(p.clips.find((c) => c.id === "title")!.track).not.toBe("v1");
    const voice = p.clips.find((c) => c.id === "voice") as { fade_in: number; fade_out: number };
    expect([voice.fade_in, voice.fade_out]).toEqual([2, 2]);
    expect(p.clips.find((c) => c.id === "lone")).toBeUndefined();
  });

  test("through a plan (edit_plan.ts apply): the reel's backdrop only for horror", () => {
    const backdrops = (kind: Kind) => {
      const p = scene(kind);
      apply(p, [{ op: "add", clip: { type: "solid", track: "v1", start: 800, duration: 30, fill: [0, 0, 0, 1] } }]);
      return p.clips.filter((c) => c.name === "Horror · reel backdrop").length;
    };
    expect(KINDS.map((kind) => [kind, backdrops(kind)])).toEqual([["v1-bodycam", 0], ["channel-voiced", 0], ["channel-unset", 0], ["v1-horror", 1]]);
  });
});

describe("the essay audit's horror checks (commentary_audit.ts pacing)", () => {
  /** Footage with no analog look over it. */
  function bare(kind: Kind): Project {
    const p = newProject("addons-horror-audit", WIDE);
    p.media.push(media({ id: "wide", name: "news.mp4", kind: "video", path: "/news.mp4", duration: 30, width: 1920, height: 1080 }));
    p.clips.push(clip({ id: "a", type: "video", media: "wide", track: "v1", start: 0, duration: 300 }));
    return shaped(p, kind);
  }
  const kinds = (p: Project) => essayIssues(p).map((issue) => String(issue.kind));

  test("a channel's project with nothing set: the same issues as a V1 bodycam project, none of horror's", () => {
    const bodycam = kinds(bare("v1-bodycam"));
    expect(bodycam.filter((kind) => kind.startsWith("horror_"))).toEqual([]);
    for (const kind of ["channel-voiced", "channel-unset"] as const) expect([kind, kinds(bare(kind))]).toEqual([kind, bodycam]);
  });

  test("a V1 horror project: the look asked for", () => {
    expect(kinds(bare("v1-horror"))).toContain("horror_look_missing");
  });
});

describe("the research tools (commentary_sources.ts)", () => {
  let mock: MockServer;
  let restoreEnv: () => void;
  beforeAll(() => {
    mock = MockServer.start();
    // No cloud (so an import past the competitor rule stops at "needs cloud storage", never the network),
    // a yt-dlp of the test's own and a proxy that's only a name.
    restoreEnv = mock.useEnv({ EDIT_RELAY_TOKEN: undefined, PROXY_URL: "http://127.0.0.1:9" });
  });
  afterAll(() => {
    restoreEnv();
    mock.stop();
  });

  /** A fixture home with one project of each kind, and a yt-dlp that finds a competitor's upload and a station's. */
  async function home(): Promise<{ fx: ReturnType<typeof fixtureHome>; ids: Record<Kind, string>; restore: () => void }> {
    const fx = fixtureHome("addons-horror-sources");
    const ids = {} as Record<Kind, string>;
    for (const kind of KINDS) {
      const made = fx.app.store.createAs(kind, "bodycam", WIDE).project.id;
      await fx.app.store.update(made, "test", (p) => { shaped(p, kind); });
      ids[kind] = made;
    }
    const binary = `${fx.dir}/yt-dlp`;
    const found = { entries: [
      { id: "aaaaaaaaaaa", title: "The Instagram Iceberg Explained", channel: "Sirius" },
      { id: "bbbbbbbbbbb", title: "Man rescued from flood", channel: "KTLA 5" },
    ] };
    fs.writeFileSync(binary, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(found)}\nJSON\n`, { mode: 0o755 });
    const previous = process.env.EDIT_YTDLP;
    process.env.EDIT_YTDLP = binary;
    return { fx, ids, restore: () => { if (previous === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = previous; fx.cleanup(); } };
  }

  test("search_broll: a competitor's upload is left out only for horror", async () => {
    const { fx, ids, restore } = await home();
    try {
      const search = async (kind: Kind) => {
        const answer = await handlerFor("search_broll")!.handler({ app: fx.app, projectId: ids[kind], args: { queries: ["instagram stalker case"], per_query: 2 } } as never);
        const said = JSON.parse((answer[0] as { text: string }).text) as { results: { videos?: { id: string }[]; left_out?: string[]; error?: string }[] };
        const one = said.results[0]!;
        expect([kind, one.error]).toEqual([kind, undefined]);
        return [kind, one.videos!.map((v) => v.id), one.left_out?.length ?? 0];
      };
      const all = ["aaaaaaaaaaa", "bbbbbbbbbbb"];
      expect(await Promise.all(KINDS.map(search))).toEqual([
        ["v1-bodycam", all, 0],
        ["channel-voiced", all, 0],
        ["channel-unset", all, 0],
        ["v1-horror", ["bbbbbbbbbbb"], 1],
      ]);
    } finally {
      restore();
    }
  });

  test("import_broll: a competitor's upload is refused only for horror", async () => {
    const { fx, ids, restore } = await home();
    try {
      const imported = async (kind: Kind) => {
        keep(fx.app, ids[kind], "source:aaaaaaaaaaa", { channel: "Sirius", title: "The Instagram Iceberg Explained" });
        try {
          const answer = await handlerFor("import_broll")!.handler({
            app: fx.app, projectId: ids[kind],
            args: { ranges: [{ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", start: 10, end: 20, purpose: "the post" }] },
          } as never);
          const said = JSON.parse((answer[0] as { text: string }).text) as { results: { error?: string }[] };
          return [kind, said.results[0]?.error ?? "imported"];
        } catch (error) {
          return [kind, (error as Error).message.includes("never their footage") ? "refused" : (error as Error).message];
        }
      };
      const results = await Promise.all(KINDS.map(imported));
      const cloudless = "B-roll sourcing needs cloud storage; sign in to Edit";
      expect(results).toEqual([["v1-bodycam", cloudless], ["channel-voiced", cloudless], ["channel-unset", cloudless], ["v1-horror", "refused"]]);
    } finally {
      restore();
    }
  });

  test("capture_evidence: the page whole around the phrase only for horror (the question it asks; capturing needs Chrome)", () => {
    // The site asks has(project, "horror-look") of the project in the store; before Nov 21, its style === "horror".
    const asked = (kind: Kind) => [kind, addons.has(scene(kind), "horror-look"), scene(kind).style === "horror"];
    expect(KINDS.map(asked)).toEqual([["v1-bodycam", false, false], ["channel-voiced", false, false], ["channel-unset", false, false], ["v1-horror", true, true]]);
  });
});
