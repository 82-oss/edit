// What kind of script a channel writes comes from its add-ons (slice 10, Sphe,
// Nov 21: what New script offers on a channel comes from the channel, never a
// control that's the same on every channel). `court-script`: a channel's
// footage scripts are courtroom cases, getting the code a courtroom script
// runs (the relaxed second half, the Doc's running time, a hearing's roles
// when naming the voices) while their words still come from the channel's
// Script lane alone, never the house's courtroom guide (Sphe, Nov 18).
// `essay-script`: its scripts are commentaries, or either with "both"; a
// channel without it writes footage scripts, and a commentary asked there is
// refused in words.

import * as fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { Clip, Script, Word } from "@edit/types/writer";

import * as accounts from "../src/accounts.ts";
import * as addons from "../src/addons.ts";
import { writerGuide } from "../src/agent_text.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import * as macSpeech from "../src/mac_speech.ts";
import * as tools from "../src/tools.ts";
import { timing } from "../src/transcribe.ts";
import * as captionTurns from "../src/writer/caption_turns.ts";
import * as formats from "../src/writer/formats.ts";
import * as imports from "../src/writer/imports.ts";
import { rolesOf } from "../src/writer/naming.ts";
import { pageCount } from "../src/writer/pages.ts";
import { compile, formatOfScript, purposes, systemPrompt } from "../src/writer/plan.ts";
import { systemPrompt as reviseSystem } from "../src/writer/revise.ts";
import { freshEyesRequest } from "../src/writer/scripting.ts";
import * as store from "../src/writer/store.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer, scribeAnswer } from "./mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  timing.instant = true;
  tools.forget();
  macSpeech.timing.helper = null;
  captionTurns.asking.ask = () => async () => {
    throw new Error("no Claude in tests");
  };
});

afterAll(() => {
  macSpeech.timing.helper = undefined;
  v2cloud.useSkillsForTests([]);
  restore();
  mock.stop();
});

afterEach(() => {
  mock.cloud.convex.channels = [];
  accounts.resetForTests();
  setItems();
});

const lanes = { ideas: "", thumbnails: "", script: "", edit: "" };
function channel(key: string, title: string) {
  return { key, youtubeId: "UC" + key.padEnd(22, "x").slice(0, 22), handle: key, title, description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0, narration: { kind: "voice", id: "v123", name: "Andrew" }, compilation: false, lanes, archived: false, addedBy: null, at: 0 };
}
/** Nothing set: every channel today. */
const PLAIN = channel("ch-ted", "Inspector Ted");
/** Courtroom cases. */
const COURT = channel("ch-court", "Courtroom Placeholder");
/** Commentaries only. */
const ESSAY = channel("ch-janitor", "InternetJanitor");
/** Footage scripts or commentaries. */
const MIXED = channel("ch-mixed", "Mixed Channel");
const ALL = [PLAIN, COURT, ESSAY, MIXED];

const item = (key: string, name: addons.Name, settings: Record<string, unknown> = {}): v2cloud.Skill => ({ name: addons.skillOf(name), text: addons.write(name, true, settings), key: v2cloud.ownKey("skill", v2cloud.laneKey(key, "script"), addons.skillOf(name)), latest: 1 });
/** The courtroom channel's one lesson: what its scripts are written from. */
const LESSON = "Open on the judge's sharpest line, then the backstory.";
const lesson = (key: string): v2cloud.Skill => ({ name: "court-voice", text: LESSON, key: v2cloud.ownKey("skill", v2cloud.laneKey(key, "script"), "court-voice") });

function setItems(): void {
  v2cloud.useSkillsForTests([item(COURT.key, "court-script"), lesson(COURT.key), lesson(PLAIN.key), item(ESSAY.key, "essay-script"), item(MIXED.key, "essay-script", { scripts: "both" })]);
}

function signedIn(app: { store: { home: string } }): void {
  fs.writeFileSync(`${app.store.home}/beta.json`, JSON.stringify({ v2: true }));
  mock.cloud.convex.channels = ALL;
  accounts.signedInForTests(["use", "cloud", ...ALL.map((one) => `channel.${one.key}`)]);
  setItems();
}

function routes(app: Parameters<typeof respond>[0]) {
  const router = buildRouter();
  return async (method: string, path: string, body?: unknown) => {
    const response = (await respond(app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), null))!;
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
}

/** A channel's footage script: 60 words a second apart, one speaker. */
function script(key: string, kind?: Script["kind"]): Script {
  const words: Word[] = Array.from({ length: 60 }, (_, index) => ({ id: `w${index}`, text: `word${index}.`, startMs: index * 1_000, endMs: index * 1_000 + 600, speaker: "a" }));
  return { id: "s1", title: "Judge Loses It", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 60_000, words, clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null, channel: key, ...(kind === undefined ? {} : { kind }) };
}

/** A plan whose first cut-in is one paragraph, with clips in the second half a few seconds apart in one block. */
const PLAN = {
  items: [
    { kind: "clip", firstWordId: "w0", lastWordId: "w3" },
    { kind: "cut-in", narration: "The judge had heard enough." },
    { kind: "clip", firstWordId: "w8", lastWordId: "w14" },
    { kind: "cut-in", narration: "It started with a traffic stop." },
    { kind: "clip", firstWordId: "w30", lastWordId: "w34" },
    { kind: "clip", firstWordId: "w38", lastWordId: "w42" },
    { kind: "clip", firstWordId: "w46", lastWordId: "w50" },
    { kind: "cut-in", narration: "In the end, the case was thrown out." },
  ],
  report: "Done.",
};
const footage = (clips: Clip[]) => clips.filter((clip) => clip.kind !== "cut-in");

describe("what a channel's scripts can be", () => {
  test("read off its add-ons, and served on its row only where it isn't a footage script alone", async () => {
    const { app, cleanup } = fixtureHome("addons-scripts-rows");
    try {
      signedIn(app);
      expect(ALL.map((one) => [one.key, addons.scriptsOf(one.key), addons.courtScripts(one.key)])).toEqual([
        [PLAIN.key, ["footage"], false],
        [COURT.key, ["footage"], true],
        [ESSAY.key, ["commentary"], false],
        [MIXED.key, ["footage", "commentary"], false],
      ]);
      const rows = (await routes(app)("GET", "/api/channels")).body.channels as Record<string, unknown>[];
      const by = (key: string) => rows.find((one) => one.key === key)!;
      for (const key of [PLAIN.key, COURT.key]) expect(by(key)).not.toHaveProperty("scripts");
      expect(by(ESSAY.key).scripts).toEqual(["commentary"]);
      expect(by(MIXED.key).scripts).toEqual(["footage", "commentary"]);
      // The channel's page names them in the script lane.
      expect((await routes(app)("GET", `/api/channels/${COURT.key}`)).body.addons).toMatchObject({ script: ["Courtroom script"] });
      expect((await routes(app)("GET", `/api/channels/${ESSAY.key}`)).body.addons).toMatchObject({ script: ["Commentary script"] });
      expect((await routes(app)("GET", `/api/channels/${PLAIN.key}`)).body.addons).toMatchObject({ script: [] });
    } finally {
      cleanup();
    }
  });
});

describe("court-script", () => {
  test.skipIf(ffmpeg === null)("a script made on the channel is a courtroom case; on a channel without it, it has no kind, as before", async () => {
    const { dir, app, cleanup } = fixtureHome("addons-scripts-made");
    try {
      signedIn(app);
      const data = store.dataDir(app.store.home);
      const source = `${dir}/hearing.m4a`;
      expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=4", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
      mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["Order", "in", "the", "court."])));
      const made: Script[] = [];
      for (const key of [COURT.key, PLAIN.key]) {
        const one = await imports.fromFile(app, data, source, null, `On ${key}`, null, null, "started", { channel: key });
        for (let i = 0; i < 600 && imports.importing(one.id); i++) await Bun.sleep(50);
        made.push(store.read(store.scriptDir(data, one.id)));
      }
      expect(made.map((one) => [one.channel, one.kind ?? null])).toEqual([[COURT.key, "courtroom"], [PLAIN.key, null]]);
    } finally {
      cleanup();
    }
  });

  test("its format is a courtroom case only where the script was made one and the channel still has the add-on", () => {
    expect(formatOfScript(script(COURT.key, "courtroom"))).toMatchObject({ kind: "courtroom", taught: true });
    // Made before the add-on, or on a channel without it: the plain kind, as every channel's script was.
    expect(formatOfScript(script(COURT.key)).kind).toBe("interrogation");
    expect(formatOfScript(script(PLAIN.key, "courtroom")).kind).toBe("interrogation");
    expect(formats.formatOf("courtroom", false, "Case", true).kind).toBe("interrogation");
  });

  test("its prompts hold the lane alone: not a word of the house's courtroom guide, shape or length, nor any other house guide", () => {
    const court = script(COURT.key, "courtroom");
    const plain = script(COURT.key);
    const house = [
      "PRODUCER'S COURTROOM GUIDE",
      "PRODUCER'S CUT-IN GUIDE",
      "PRODUCER'S JUDGMENT CALLS",
      "WRITER'S HOUSE RULES",
      "This is a Courtroom video",
      "18-25 minutes",
      "relax: let the hearing breathe",
      formats.plain(writerGuide("courtroom")).trim().split("\n").find((line) => line.trim().length > 40)!.trim(),
    ];
    const prompts = [systemPrompt(court, formatOfScript(court)), reviseSystem(court, formatOfScript(court), false), reviseSystem(court, formatOfScript(court), true)];
    for (const prompt of prompts) {
      for (const words of house) expect([words, prompt.includes(words)]).toEqual([words, false]);
      expect(prompt).toContain(LESSON);
      expect(prompt).toContain("there is no house style beside it");
    }
    // Word for word the prompt of the same channel's script that isn't a courtroom case: the kind adds no words.
    expect(prompts[0]).toBe(systemPrompt(plain, formatOfScript(plain)));
    expect(prompts[1]).toBe(reviseSystem(plain, formatOfScript(plain), false));
    expect(freshEyesRequest(court.kind === "courtroom", true)).toBe(freshEyesRequest(false, true));
    // A courtroom script of no channel keeps the house's.
    const v1: Script = { ...script(COURT.key, "courtroom"), channel: undefined };
    expect(systemPrompt(v1, formatOfScript(v1))).toContain("PRODUCER'S COURTROOM GUIDE");
  });

  test("its plan: the relaxed second half joins nearby clips, its opening is its plan's, and the house's two-paragraph rule isn't asked", () => {
    const court = script(COURT.key, "courtroom");
    const plain = script(COURT.key);
    const done = compile(court, PLAN);
    const before = compile(plain, PLAN);
    // Past the cut's halfway point (tidy.ts relaxedFrom), the block's last two clips, 3 s apart, play as one range in
    // the courtroom case alone.
    expect(footage(before.clips)).toHaveLength(5);
    expect(footage(done.clips)).toHaveLength(4);
    const last = footage(done.clips)[3]!;
    expect([last.startMs < 39_000, last.endMs > 50_000]).toEqual([true, true]);
    // The cut-ins' places are what the plan says, as any channel's script's.
    for (const opening of ["two-split", "one-run"] as const) expect(purposes(done.clips, formatOfScript(court), opening)).toEqual(purposes(before.clips, formatOfScript(plain), opening));
    // With no channel, a courtroom case's first cut-in must hold two paragraphs.
    expect(() => compile({ ...court, channel: undefined }, PLAN)).toThrow("first cut-in holds two paragraphs");
  });

  test("its Doc runs its clips together and gives the running time, and its voices are named as a hearing's, narrator and all", () => {
    const court = script(COURT.key, "courtroom");
    const plain = script(COURT.key);
    // Forty short blocks: a courtroom Doc lays them without the gaps between.
    const clips: Clip[] = Array.from({ length: 40 }, (_, index) => [
      { id: `f${index}`, startMs: index * 1_000, endMs: index * 1_000 + 600 } as Clip,
      { id: `c${index}`, kind: "cut-in", startMs: 0, endMs: 3_000, narration: "A short line." } as Clip,
    ]).flat();
    expect(pageCount(court, clips)).toBeLessThan(pageCount(plain, clips));
    expect(rolesOf(court)).toMatchObject({ courtroom: true, narrated: true });
    expect(rolesOf(court).system).toContain("court hearing");
    expect(rolesOf(plain)).toMatchObject({ courtroom: false, narrated: false });
  });
});

describe("essay-script", () => {
  test("a commentary is made only on a channel whose add-on writes them; elsewhere it's refused in words, and nothing is made", async () => {
    const { app, cleanup } = fixtureHome("addons-scripts-essay");
    try {
      signedIn(app);
      const call = routes(app);
      const data = store.dataDir(app.store.home);
      for (const key of [ESSAY.key, MIXED.key]) {
        const made = await call("POST", "/api/writer/scripts/commentary", { title: "Why he's hated", links: [], channel: key });
        expect([key, made.status]).toEqual([key, 200]);
        expect(made.body).toMatchObject({ channel: key, sourceKind: "commentary" });
      }
      const count = store.ids(data).length;
      expect(await call("POST", "/api/writer/scripts/commentary", { title: "x", links: [], channel: PLAIN.key })).toEqual({ status: 400, body: { error: "Inspector Ted writes its scripts from a case's footage, not as commentaries: paste the footage instead." } });
      expect((await call("POST", "/api/writer/scripts/commentary", { title: "x", links: [], channel: COURT.key })).status).toBe(400);
      // A footage script on a channel that writes commentaries alone: refused before anything is fetched.
      expect(await call("POST", "/api/writer/scripts/youtube", { url: "https://youtu.be/dslLBsHkVzE", channel: ESSAY.key })).toEqual({ status: 400, body: { error: "InternetJanitor writes commentaries, not scripts from a case's footage: paste the sources instead." } });
      expect(store.ids(data).length).toBe(count);
    } finally {
      cleanup();
    }
  });
});
