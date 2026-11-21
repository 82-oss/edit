// A channel's add-ons read from V2's library (addons.ts, slice 6, Nov 21):
// each a skill item `addon-<name>` at the channel's lane's place or its
// group's, its line then `<addon>{"v":1,"on":…,"settings":…}</addon>`. With
// nothing set (every channel today) every answer is what it was; an item
// switches an add-on on or off for its channel, or for the whole group, the
// channel's own winning by name; its settings go over the defaults; one that
// can't be read is nothing, said once. An add-on is never a lesson: not
// listed, not kept with remember, never what makes a channel taught. And the
// wait before a trigger outside a turn (`ready`) is short, never throws, and
// a cloud that hangs or can't be reached leaves what was read before.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import * as accounts from "../src/accounts.ts";
import * as addons from "../src/addons.ts";
import type { App } from "../src/app.ts";
import { registerChannelTools } from "../src/channel_tools.ts";
import { useChannelsForTests, type Channel, type Group } from "../src/channels.ts";
import * as channels from "../src/channels.ts";
import * as cloud from "../src/cloud.ts";
import * as diag from "../src/diag.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { apply, audit, hooks } from "../src/edit_plan.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { start as startHouseWords } from "../src/house_words_pass.ts";
import * as lanes from "../src/lanes.ts";
import { dispatch } from "../src/mcp/index.ts";
import * as outages from "../src/outages.ts";
import { STYLES, type Project, type Style } from "../src/model.ts";
import { mutedWords } from "../src/subtitles.ts";
import { waiting } from "../src/teaching_gate.ts";
import { serialize, type Transcript } from "../src/transcribe.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome, write } from "./helpers/home.ts";
import { clip, media, project as newProject, stubNative } from "./helpers/model.ts";
import { MockServer } from "./mocks/server.ts";

const ALL: Style[] = STYLES.map((one) => one.value);
const WIDE = { width: 1920, height: 1080, fps: 30 };
const TALL = { width: 1080, height: 1920, fps: 30 };

function channel(key: string, narration: Channel["narration"] = { kind: "voice", id: "v", name: "Andrew" }, group?: string): Channel {
  return {
    key, youtubeId: null, handle: null, title: key, description: "", avatar: null, banner: null, uploads: null,
    subscribers: null, videos: null, views: null, country: null, publishedAt: null, fetchedAt: 0, narration, compilation: false,
    lanes: { ideas: "", thumbnails: "", script: "", edit: "" },
    ...(group !== undefined ? { group } : {}),
  } as Channel;
}

// Two channels in a group, one alone, one whose narration is the team's recording.
const CHANNELS = [channel("alpha", undefined, "grp"), channel("beta", undefined, "grp"), channel("solo"), channel("taped", { kind: "recorded" })];
const GROUPS: Group[] = [{ key: "grp", lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, channels: ["alpha", "beta"] }];

const edit = (place: string) => v2cloud.laneKey(place, "edit");

/** An add-on's item as the tool that sets it keeps it (`addons.write`), at `place`. */
function item(place: string, name: addons.Name, on: boolean, settings: Record<string, unknown> = {}, text = addons.write(name, on, settings)): v2cloud.Skill {
  return { name: addons.skillOf(name), text, note: addons.noteOf(name), key: v2cloud.ownKey("skill", place, addons.skillOf(name)), latest: 1 };
}

/** What every channel is taught today: the global skill, lessons, and removal; no add-on. */
const LESSONS: v2cloud.Skill[] = [
  { name: v2cloud.GLOBAL, text: "Edit's own workings.", key: v2cloud.skillKey(v2cloud.GLOBAL) },
  { name: "pins", text: "Pins are red.", key: v2cloud.ownKey("skill", edit("grp"), "pins") },
  { name: "removal", text: "Their subtitles get a tight blur.\n<removal>{\"remove\":{\"subtitles\":true}}</removal>", key: v2cloud.ownKey("skill", edit("solo"), "removal") },
];

function on(channelKey: string | null, style: Style = "bodycam", frame = WIDE): Project {
  const p = newProject("addons-library", frame);
  p.style = style;
  if (channelKey !== null) p.channel = channelKey;
  return p;
}

const names = (p: Project) => addons.NAMES.filter((name) => addons.has(p, name));

let mock: MockServer;
let restoreEnv: () => void;
const saved = { ...hooks };
const retry = cloud.convexRetry.baseMs;

beforeAll(() => {
  mock = MockServer.start();
  restoreEnv = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
  cloud.convexRetry.baseMs = 1;
  stubNative();
  hooks.oneColourPerPerson = () => [];
  hooks.textOnFaces = () => [];
  hooks.picturesOnFaces = () => [];
  registerEffectTools();
  registerChannelTools();
  registerEditingTools();
});

afterAll(() => {
  Object.assign(hooks, saved);
  cloud.convexRetry.baseMs = retry;
  useChannelsForTests([]);
  v2cloud.useSkillsForTests([]);
  restoreEnv();
  mock.stop();
});

afterEach(() => {
  accounts.resetForTests();
  // The relay hung or unreachable on purpose: no outage left for the tests after.
  outages.forgetForTests();
  useChannelsForTests(CHANNELS, GROUPS);
  v2cloud.useSkillsForTests(LESSONS);
});

describe("nothing set: every answer is what it was", () => {
  test("no channel holds an item, and every project of every style, frame and channel has its style's list", () => {
    useChannelsForTests(CHANNELS, GROUPS);
    v2cloud.useSkillsForTests(LESSONS);
    for (const key of CHANNELS.map((one) => one.key)) {
      for (const lane of ["edit", "script"] as const) expect([key, lane, addons.itemsAt(key, lane).size]).toEqual([key, lane, 0]);
      expect(addons.ofChannel(key, "edit").every((one) => one.from === "default")).toBe(true);
    }
    for (const style of ALL) {
      for (const frame of [WIDE, TALL]) {
        for (const key of [null, "alpha", "solo", "taped", "not-read"]) {
          expect([style, frame.height, key, names(on(key, style, frame))]).toEqual([style, frame.height, key, addons.v1Of(style)]);
        }
      }
    }
  });

  test("the lessons a place knows, and whether it's taught, are as they were", () => {
    expect(v2cloud.memories(channels.placesOf("alpha", "edit")).map((one) => one.name)).toEqual(["global", "pins"]);
    expect(v2cloud.memories(channels.placesOf("solo", "edit")).map((one) => one.name)).toEqual(["global", "removal"]);
    expect(v2cloud.taughtAnything(channels.placesOf("alpha", "edit"))).toBe(true);
    expect(v2cloud.taughtAnything(channels.placesOf("taped", "edit"))).toBe(false);
  });
});

describe("an item at a channel's place", () => {
  /** A tall reel full frame on a wide edit: what horror's first pass puts a blurred backdrop behind. */
  function reel(p: Project): Project {
    p.media.push(media({ id: "reel", name: "reel.mp4", kind: "video", path: "/reel.mp4", duration: 30, width: 720, height: 1280, has_audio: true }));
    p.clips.push(clip({ id: "reel-clip", type: "video", media: "reel", track: "v2", start: 0, duration: 120, source_in: 3 }));
    return p;
  }
  const backdrops = (p: Project) => {
    apply(p, [{ op: "add", clip: { type: "solid", track: "v1", start: 800, duration: 30, fill: [0, 0, 0, 1] } }]);
    return p.clips.filter((one) => one.name === "Horror · reel backdrop").length;
  };

  test("addon-horror-look at alpha's own place: its bodycam project has it, and a real plan gets horror's pass; beta's and solo's don't", () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("alpha"), "horror-look", true)]);
    expect(addons.has(on("alpha"), "horror-look")).toBe(true);
    expect(names(on("alpha"))).toEqual(addons.NAMES.filter((name) => name === "horror-look" || addons.v1Of("bodycam").includes(name)));
    expect(backdrops(reel(on("alpha")))).toBe(1);
    expect(backdrops(reel(on("beta")))).toBe(0);
    expect(backdrops(reel(on("solo")))).toBe(0);
    expect(backdrops(reel(on(null)))).toBe(0);
    expect(addons.ofChannel("alpha", "edit").find((one) => one.name === "horror-look")).toEqual({ name: "horror-look", on: true, from: "channel", settings: {} });
  });

  test("a group's item reaches both its channels, and no one else", () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("grp"), "horror-look", true)]);
    expect(["alpha", "beta", "solo", "taped"].map((key) => [key, addons.has(on(key), "horror-look")])).toEqual([["alpha", true], ["beta", true], ["solo", false], ["taped", false]]);
    expect(addons.ofChannel("beta", "edit").find((one) => one.name === "horror-look")?.from).toBe("group");
  });

  test("a channel's on:false switches the group's off for that channel alone, and a default off too", () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("grp"), "horror-look", true), item(edit("alpha"), "horror-look", false), item(edit("beta"), "bodycam-intro", false)]);
    expect(addons.has(on("alpha"), "horror-look")).toBe(false);
    expect(addons.has(on("beta"), "horror-look")).toBe(true);
    expect(addons.ofChannel("alpha", "edit").find((one) => one.name === "horror-look")).toMatchObject({ on: false, from: "channel" });
    // A default switched off: bodycam's intro checks gone on beta's, kept on alpha's.
    expect(addons.has(on("beta"), "bodycam-intro")).toBe(false);
    expect(addons.has(on("alpha"), "bodycam-intro")).toBe(true);
    // A V1 project never reads them.
    expect(names(on(null))).toEqual(addons.v1Of("bodycam"));
  });

  test("settings go over the defaults: muted words with the channel's own, courtroom text with another smallest size", () => {
    v2cloud.useSkillsForTests([
      ...LESSONS,
      item(edit("alpha"), "muted-words", true, { list: "horror", words: ["gizmo"] }),
      item(edit("solo"), "muted-words", true, { words: ["widget"] }),
      item(edit("grp"), "courtroom-text", true, { smallest: 40 }),
      item(edit("beta"), "courtroom-text", true),
    ]);
    expect([addons.setting(on("alpha"), "muted-words", "list"), addons.setting(on("alpha"), "muted-words", "words")]).toEqual(["horror", ["gizmo"]]);
    // Only its own words set: the list is the catalogue's default.
    expect([addons.setting(on("solo"), "muted-words", "list"), addons.setting(on("solo"), "muted-words", "words")]).toEqual(["commentary", ["widget"]]);
    expect(mutedWords(on("alpha")).filter((term) => term.startsWith("gizmo"))).toEqual(["gizmo = g****"]);
    expect(mutedWords(on("solo")).filter((term) => term.startsWith("widget"))).toEqual(["widget = w*****"]);
    expect(mutedWords(on("alpha")).length).toBeGreaterThan(mutedWords(on("solo")).length);
    expect(mutedWords(on("taped"))).toEqual([]);
    // The group's 40 on alpha; beta's own item (no settings) wins whole, so its default 60.
    expect(addons.setting(on("alpha"), "courtroom-text", "smallest")).toBe(40);
    expect(addons.setting(on("beta"), "courtroom-text", "smallest")).toBe(60);
    // Through a real audit: text 44 px high is small at 60, not at 40.
    const small = (key: string) => {
      const p = on(key);
      apply(p, [
        { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 90, fill: [0.5, 0.5, 0.5, 1] } },
        { op: "add", clip: { type: "text", track: "new", name: "Reaction • Oath", start: 0, duration: 60, text: "*UNDER OATH*", style: { size: 44 } } },
      ]);
      return (audit(p).issues as { kind: string }[]).filter((issue) => issue.kind === "small_text").length;
    };
    expect([small("alpha"), small("beta"), small("solo")]).toEqual([0, 1, 0]);
  });

  test("an item that can't be read is nothing, said once, and never throws", () => {
    const since = Date.now();
    const said = () => diag.lines(10_000).filter((line) => line.area === "addons" && line.at >= since);
    {
      const bad = [
        item(edit("alpha"), "horror-look", true, {}, "Analog horror is on here."),
        item(edit("alpha"), "reverb-out", true, {}, "<addon>{not json</addon>"),
        item(edit("alpha"), "muted-words", true, {}, `<addon>${JSON.stringify({ v: 1, on: true, settings: { list: "gore" } })}</addon>`),
        item(edit("alpha"), "post-details", true, {}, `<addon>${JSON.stringify({ v: 1, on: "yes" })}</addon>`),
        item(edit("alpha"), "essay-checks", true, {}, `<addon>${JSON.stringify({ v: 2, on: true })}</addon>`),
        item(edit("alpha"), "bodycam-intro", false, {}, `<addon>${JSON.stringify({ v: 1, on: false, settings: { loud: true } })}</addon>`),
        // The script lane's add-on kept in the edit lane, and one Edit doesn't have.
        item(edit("alpha"), "court-script", true),
        { ...item(edit("alpha"), "horror-look", true), name: "addon-made-up", key: v2cloud.ownKey("skill", edit("alpha"), "addon-made-up") },
      ];
      v2cloud.useSkillsForTests([...LESSONS, ...bad]);
      expect(names(on("alpha"))).toEqual(addons.v1Of("bodycam"));
      expect(addons.itemsAt("alpha", "edit").size).toBe(0);
      expect(said().map((line) => line.level)).toEqual(bad.map(() => "warn"));
      // Asked again, and after the same items are read again: nothing said twice.
      names(on("alpha"));
      v2cloud.useSkillsForTests([...LESSONS, ...bad]);
      names(on("alpha"));
      expect(said()).toHaveLength(bad.length);
    }
  });
});

describe("an add-on is never a lesson", () => {
  async function call(app: App, project: string, name: string, args: Record<string, unknown>) {
    const answer = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[] } };
    return answer.result.content[0]?.text ?? "";
  }

  test("not one of the agent's lessons, nor read with read_skill, nor the lanes' lessons", async () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("alpha"), "horror-look", true), item(v2cloud.laneKey("alpha", "script"), "court-script", true)]);
    expect(v2cloud.memories(channels.placesOf("alpha", "edit")).map((one) => one.name)).toEqual(["global", "pins"]);
    expect(v2cloud.skill("addon-horror-look", channels.placesOf("alpha", "edit"))).toBeUndefined();
    expect(lanes.lessonsOf({ channel: "alpha", lane: "script" })).toEqual([]);
    expect(lanes.laneText({ channel: "alpha", lane: "script" })).not.toContain("addon-");
    const { app, cleanup } = fixtureHome("addons-library-read");
    try {
      const id = app.store.create("Case", WIDE).project.id;
      await app.store.update(id, "test", (p) => {
        p.hq = true;
        p.channel = "alpha";
      });
      expect(await call(app, id, "read_skill", { name: "addon-horror-look" })).toContain("no skill addon-horror-look");
      await expect(lanes.call("read_skill", { name: "addon-court-script" }, { channel: "alpha", lane: "script" })).rejects.toThrow("no lesson addon-court-script");
    } finally {
      cleanup();
    }
  });

  test("remember refuses an add-on's name in every lane, and removal in the edit's", async () => {
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.alpha"]);
    const { app, cleanup } = fixtureHome("addons-library-remember");
    try {
      const id = app.store.create("Case", WIDE).project.id;
      await app.store.update(id, "test", (p) => {
        p.hq = true;
        p.channel = "alpha";
      });
      const saves = () => mock.cloud.convex.library.size;
      const before = saves();
      expect(await call(app, id, "remember", { skill: "addon-horror-look", text: "On.", reason: "Sphe" })).toContain("set only by their own tool");
      expect(await call(app, id, "remember", { skill: "removal", text: "Take out subtitles.", reason: "Sphe" })).toContain("teach_removal");
      await expect(lanes.call("remember", { skill: "addon-court-script", text: "On.", reason: "Sphe" }, { channel: "alpha", lane: "script" })).rejects.toThrow("set only by their own tool");
      expect(saves()).toBe(before);
      // Any other name is kept as before.
      expect(await call(app, id, "remember", { skill: "addons-are-fun", text: "A lesson.", reason: "Sphe" })).toContain("Remembered as addons-are-fun");
    } finally {
      cleanup();
    }
  });

  test("an add-on alone doesn't make a channel taught (the teaching gate, the lanes, the channel's page)", async () => {
    v2cloud.useSkillsForTests([LESSONS[0]!, item(edit("taped"), "horror-look", true), item(v2cloud.laneKey("taped", "script"), "court-script", true)]);
    expect(v2cloud.taughtAnything(channels.placesOf("taped", "edit"))).toBe(false);
    expect(waiting({ hq: true, channel: "taped" })).toBe(true);
    expect(await lanes.teachingOf("taped", "script")).toBe("untaught");
    // The page's list of what's taught, from the library itself.
    await v2cloud.saveSkill(addons.skillOf("held-broll"), addons.write("held-broll", true, {}), "test", addons.noteOf("held-broll"), { key: v2cloud.ownKey("skill", edit("taped"), addons.skillOf("held-broll")) });
    await v2cloud.saveSkill("tone", "Calm.", "test", undefined, { key: v2cloud.ownKey("skill", edit("taped"), "tone") });
    expect((await channels.taughtOf("taped")).edit.map((one) => one.name)).toEqual(["tone"]);
  });
});

describe("the frame, on a channel that makes Shorts", () => {
  const LONG = addons.v1Of("bodycam");

  test('"both": a tall project has the Short\'s add-ons and not the long edit\'s, a wide one the reverse', () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("solo"), "short-form", true, { forms: "both" })]);
    expect(names(on("solo", "bodycam", TALL))).toEqual(["short-form"]);
    expect(names(on("solo", "bodycam", WIDE))).toEqual(LONG);
    expect(addons.setting(on("solo", "bodycam", TALL), "short-form", "forms")).toBe("both");
    // New project offers both: long unless a Short is asked.
    expect([addons.formMade("solo"), addons.formMade("solo", "long"), addons.formMade("solo", "short")]).toEqual(["long", "long", "short"]);
  });

  test('"short": every project made there is a Short, with the Short\'s add-ons alone', () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("grp"), "short-form", true, { forms: "short" })]);
    for (const key of ["alpha", "beta"]) {
      expect([addons.formMade(key), addons.formMade(key, "long"), addons.formMade(key, "short")]).toEqual(["short", "short", "short"]);
      expect(names(on(key, "bodycam", TALL))).toEqual(["short-form"]);
    }
    // Set with no forms: the catalogue's default, "short".
    v2cloud.useSkillsForTests([...LESSONS, item(edit("solo"), "short-form", true)]);
    expect(addons.formMade("solo", "long")).toBe("short");
  });

  test("a V1 edit moved onto a channel that hasn't set short-form keeps its style's list at any frame; none made there is a Short", () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("grp"), "short-form", true, { forms: "both" }), item(edit("alpha"), "horror-look", true)]);
    for (const style of ALL) {
      for (const frame of [WIDE, TALL]) {
        expect([style, frame.height, names(on("solo", style, frame))]).toEqual([style, frame.height, addons.v1Of(style)]);
        expect([style, frame.height, names(on("taped", style, frame))]).toEqual([style, frame.height, addons.v1Of(style)]);
      }
    }
    expect([addons.formMade("solo", "short"), addons.formMade("taped", "short")]).toEqual(["long", "long"]);
    // A channel's short-form switched off over its group's: the frame no longer decides there.
    v2cloud.useSkillsForTests([...LESSONS, item(edit("grp"), "short-form", true, { forms: "both" }), item(edit("alpha"), "short-form", false)]);
    expect(names(on("alpha", "bodycam", TALL))).toEqual(LONG);
    expect(names(on("beta", "bodycam", TALL))).toEqual(["short-form"]);
  });
});

describe("ready: the wait before a trigger outside a turn", () => {
  /** A relay that holds every request until let go, then says it's down. */
  function hangingRelay() {
    let letGo: () => void = () => {};
    const gone = new Promise<void>((resolve) => (letGo = resolve));
    const server = Bun.serve({ port: 0, fetch: async () => { await gone; return new Response("down", { status: 503 }); } });
    return { url: `http://127.0.0.1:${server.port}`, release: () => { letGo(); void server.stop(true); } };
  }

  test("without a channel, or signed out, it waits on nothing", async () => {
    v2cloud.forgetSkills();
    const asked = mock.requests.length;
    await addons.ready(on(null));
    await addons.ready(null);
    expect(mock.requests.length).toBe(asked);
  });

  test("the cloud hanging holds it READY_MS at most, then what was read before answers (an item kept, defaults where none)", async () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("alpha"), "horror-look", true)]);
    v2cloud.forgetSkills();
    const relay = hangingRelay();
    const url = process.env.EDIT_RELAY_URL;
    process.env.EDIT_RELAY_URL = relay.url;
    try {
      const began = performance.now();
      await addons.ready(on("alpha"), "alpha's case");
      const took = performance.now() - began;
      expect(took).toBeGreaterThanOrEqual(addons.READY_MS - 50);
      expect(took).toBeLessThan(addons.READY_MS + 1_000);
      expect(addons.has(on("alpha"), "horror-look")).toBe(true);
      expect(names(on("beta"))).toEqual(addons.v1Of("bodycam"));
    } finally {
      relay.release();
      // The read under way ends (a failure, what was read kept) before the next test.
      await v2cloud.refreshSkills();
      process.env.EDIT_RELAY_URL = url;
    }
  }, 15_000);

  test("the cloud unreachable: it comes back at once, never throws, and a channel read as nothing has its style's defaults", async () => {
    v2cloud.useSkillsForTests([], [], false);
    v2cloud.forgetSkills();
    const url = process.env.EDIT_RELAY_URL;
    process.env.EDIT_RELAY_URL = "http://127.0.0.1:9";
    try {
      const began = performance.now();
      await addons.ready(on("alpha"), "alpha's case");
      expect(performance.now() - began).toBeLessThan(addons.READY_MS);
      expect(v2cloud.teachingKnown()).toBe(false);
      expect(names(on("alpha"))).toEqual(addons.v1Of("bodycam"));
      expect(names(on("taped", "interrogation"))).toEqual(addons.v1Of("interrogation"));
    } finally {
      process.env.EDIT_RELAY_URL = url;
    }
  });

  test("the end-of-turn pass on a channel's project isn't held past READY_MS by a hung cloud", async () => {
    const words = (said: [string, number, number][]): Transcript => ({ model: "scribe_v2", language: "eng", words: said.map(([text, start, end]) => ({ text, start, end, speaker: "speaker_0" })), speakers: {}, roles: {}, colors: {} });
    let told: (at: number) => void = () => {};
    const heard = new Promise<number>((resolve) => (told = resolve));
    const agents = { status: async () => ({}), ask: async () => "", note: () => told(performance.now()) };
    const { app, dir, store, cleanup } = fixtureHome("addons-library-pass", { services: { agents: agents as never } });
    v2cloud.useSkillsForTests(LESSONS);
    v2cloud.forgetSkills();
    const relay = hangingRelay();
    const url = process.env.EDIT_RELAY_URL;
    try {
      const take = `${dir}/take.mp3`;
      write(app.media.paths(take).transcript, serialize(words([["He", 0.0, 0.2], ["tried", 0.25, 0.5], ["to", 0.55, 0.65], ["kill", 0.7, 1.1], ["her.", 1.15, 1.4]])));
      const id = store.create("p", WIDE).project.id;
      await store.update(id, "test", (p) => {
        p.hq = true;
        p.channel = "alpha";
        p.media = [{ id: "t", name: "take", path: take, kind: "audio", duration: 2, width: 0, height: 0, fps: 0, has_audio: true }];
        const track = p.tracks.find((one) => one.kind === "audio" && one.id !== "a4")!.id;
        p.clips = [{ id: "vo", type: "audio", track, start: 0, duration: 60, media: "t", name: "Voice-over", color: "blue", fade_in: 0, fade_out: 0, source_in: 0, speed: 1, volume_db: 0 } as Project["clips"][number]];
      });
      process.env.EDIT_RELAY_URL = relay.url;
      startHouseWords(app);
      store.emit({ type: "agent", event: "status", running: true, project: id } as never);
      await store.update(id, "agent", (p) => {
        p.name = "Changed";
      });
      const ended = performance.now();
      store.emit({ type: "agent", event: "status", running: false, project: id } as never);
      const at = await heard;
      expect(at - ended).toBeLessThan(addons.READY_MS + 1_500);
    } finally {
      relay.release();
      await v2cloud.refreshSkills();
      process.env.EDIT_RELAY_URL = url;
      cleanup();
    }
  }, 15_000);
});
