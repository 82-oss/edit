// Edit V2's cloud (v2_cloud.ts): an effect's code kept version by version and
// brought back, an effect made elsewhere brought down, templates, and the
// agent's skills a teacher saves, read over the release's in Edit V2;
// through the relay to the cloud mock's library (mamagi's editLibrary).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import { agentInstructions } from "../src/agent.ts";
import * as channels from "../src/channels.ts";
import * as lanes from "../src/lanes.ts";
import { registerChannelTools } from "../src/channel_tools.ts";
import * as cloud from "../src/cloud.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import * as effects from "../src/effects.ts";
import { dispatch } from "../src/mcp/index.ts";
import { HOUSE_VOICE } from "../src/voice.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
  registerEffectTools();
  registerChannelTools();
  registerEditingTools();
});

afterAll(() => {
  restore();
  mock.stop();
});

afterEach(() => {
  accounts.resetForTests();
  v2cloud.useSkillsForTests([]);
});

function hq(name: string) {
  const home = fixtureHome(name);
  const id = home.app.store.create("HQ", { width: 1920, height: 1080, fps: 30 }).project.id;
  return { ...home, id };
}

async function call(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, args: Record<string, unknown>) {
  return ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
}

test("an effect's code kept version by version, the same files never twice, and put back to any of them", async () => {
  const { app, cleanup, id } = hq("v2-versions");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = effects.folder(app.store, id, "board");
    fs.mkdirSync(join(dir, "img"), { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>one</p>");
    fs.writeFileSync(join(dir, "img/a.png"), "picture");
    const key = v2cloud.effectKey(id, "board");
    expect(await v2cloud.save(key, "board", dir, { source: "k1", reason: "rendered" })).toMatchObject({ n: 1, made: true });
    // The same files again (saved as it renders once more, or just brought back): no new version.
    expect(await v2cloud.save(key, "board", dir, { source: "k1b" })).toEqual({ n: 1, made: false });
    fs.writeFileSync(join(dir, "scene.html"), "<p>two</p>");
    fs.rmSync(join(dir, "img/a.png"));
    expect(await v2cloud.save(key, "board", dir, { source: "k2", reason: "rendered" })).toMatchObject({ n: 2, made: true });
    // The files went up once each, by their content.
    expect([...mock.cloud.objects.keys()].filter((one) => one.startsWith("edit/library/sha256/")).length).toBe(3);

    // The agent's history and undo.
    const listed = await call(app, id, "effect_versions", { name: "board" });
    expect(listed.isError).toBe(false);
    expect(listed.content[0]!.text).toContain("version 2 (in use)");
    expect(listed.content[0]!.text).toContain("version 1:");
    const back = await call(app, id, "restore_effect", { name: "board", version: 1 });
    expect(back.isError).toBe(false);
    expect(fs.readFileSync(join(dir, "scene.html"), "utf8")).toBe("<p>one</p>");
    expect(fs.readFileSync(join(dir, "img/a.png"), "utf8")).toBe("picture");
    expect((await v2cloud.version(key))?.item.current).toBe(1);
    // Forward again: the newer version was kept.
    await call(app, id, "restore_effect", { name: "board", version: 2 });
    expect(fs.readFileSync(join(dir, "scene.html"), "utf8")).toBe("<p>two</p>");
    expect(fs.existsSync(join(dir, "img/a.png"))).toBe(false);
    expect((await call(app, id, "restore_effect", { name: "board", version: 9 })).content[0]!.text).toContain("has no version 9");

    // Opened on another computer, without the folder: its code comes down at the version in use.
    await app.store.update(id, "test", (project) => {
      project.media.push({ id: "m1", name: "board", path: "/elsewhere/board.mp4", kind: "video", duration: 2, width: 1920, height: 1080, fps: 30, has_audio: false, effect: "board", effect_key: "k2" });
    });
    fs.rmSync(dir, { recursive: true });
    expect(await effects.bringDown(app, id)).toEqual(["board"]);
    expect(fs.readFileSync(join(dir, "scene.html"), "utf8")).toBe("<p>two</p>");
    // Here already: left as it is.
    expect(await effects.bringDown(app, id)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("what's beneath an effect is made again from the timeline, never kept in the library: a version leaves it out, and a restore leaves it as it is here", async () => {
  // Nov 13: beneath.mp4 was 392 of the library's 489 MB, a copy of the footage at every version, in templates too.
  const { app, cleanup, id } = hq("v2-beneath");
  try {
    const dir = effects.folder(app.store, id, "glass");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>one</p>");
    fs.writeFileSync(join(dir, ".beneath.json"), JSON.stringify({ key: "k" }));
    fs.writeFileSync(join(dir, "beneath.mp4"), "the footage beneath");
    const key = v2cloud.effectKey(id, "glass");
    await v2cloud.save(key, "glass", dir, { source: "k1" });
    fs.writeFileSync(join(dir, "scene.html"), "<p>two</p>");
    await v2cloud.save(key, "glass", dir, { source: "k2" });
    const kept = (await v2cloud.version(key))!.version.files!.map((file) => file.path);
    expect(kept).toEqual([".beneath.json", "scene.html"]);
    await v2cloud.fetchInto(key, 1, dir);
    expect(fs.readFileSync(join(dir, "scene.html"), "utf8")).toBe("<p>one</p>");
    expect(fs.readFileSync(join(dir, "beneath.mp4"), "utf8")).toBe("the footage beneath");
  } finally {
    cleanup();
  }
});

test("the library: effects and sounds kept with a category, a note and a brief, searched, put away and back, brought into a project", async () => {
  const { app, cleanup, id } = hq("v2-library");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "lib-ch";
    });
    const dir = effects.folder(app.store, id, "board");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>board</p>");
    const keep = { kind: "effect", name: "board", as: "evidence-board", category: "evidence board", note: "A paper board the camera glides across.", brief: "PHOTOS, CAM keys and TEXTS at the top." };
    // Not a teacher: refused, in words to pass on.
    accounts.signedInForTests(["edit.bodycam"]);
    expect((await call(app, id, "save_to_library", keep)).content[0]!.text).toContain("a teacher's to do");
    accounts.signedInForTests(["edit.bodycam", "agent.teach"]);
    expect((await call(app, id, "save_to_library", { ...keep, brief: "x".repeat(300) })).content[0]!.text).toContain("brief is at most 240 characters");
    expect((await call(app, id, "save_to_library", keep)).content[0]!.text).toContain("evidence-board is version 1");
    expect(mock.cloud.convex.library.has("template:@lib-ch--edit/evidence-board")).toBe(true);
    const found = await call(app, id, "library", { kind: "effect", query: "board" });
    expect(found.content[0]!.text).toBe("- evidence-board [evidence board; this channel's own]: A paper board the camera glides across. To change it: PHOTOS, CAM keys and TEXTS at the top.");
    expect((await call(app, id, "library", { kind: "effect", query: "whoosh" })).content[0]!.text).toContain('No effects match "whoosh"');
    expect((await call(app, id, "library", { kind: "sound" })).content[0]!.text).toContain("No sounds");
    // Read for how it's made (Sphe, Nov 13: "some inspiration here as to how things are done"): its code, nothing brought in.
    const read = (await call(app, id, "library", { kind: "effect", name: "evidence-board" })).content[0]!.text!;
    expect(read).toContain("To change it: PHOTOS, CAM keys and TEXTS at the top.");
    expect(read).toContain("<p>board</p>");
    expect(fs.existsSync(effects.folder(app.store, id, "evidence-board"))).toBe(false);
    // Brought into a project as its own folder.
    expect((await call(app, id, "use_from_library", { kind: "effect", name: "evidence-board", as: "intro-board" })).isError).toBe(false);
    expect(fs.readFileSync(join(effects.folder(app.store, id, "intro-board"), "scene.html"), "utf8")).toBe("<p>board</p>");
    expect((await call(app, id, "use_from_library", { kind: "effect", name: "evidence-board", as: "intro-board" })).content[0]!.text).toContain("already");
    // Put away ("delete it"): out of the list, unless asked for; back again.
    await call(app, id, "archive_in_library", { kind: "effect", name: "evidence-board" });
    expect((await call(app, id, "library", { kind: "effect" })).content[0]!.text).toContain("No effects");
    expect((await call(app, id, "library", { kind: "effect", archived: true })).content[0]!.text).toContain("evidence-board (put away)");
    await call(app, id, "archive_in_library", { kind: "effect", name: "evidence-board", archived: false });
    expect((await call(app, id, "library", { kind: "effect" })).content[0]!.text).toContain("- evidence-board [");
  } finally {
    cleanup();
  }
});

test("what the agent remembers: a line or two each, the global skill first and never put away, in a V2 channel project's instructions alone", async () => {
  const { app, cleanup, id } = hq("v2-memory");
  const place = "mem-ch--edit";
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "mem-ch";
    });
    accounts.signedInForTests(["edit.bodycam"]);
    expect((await call(app, id, "remember", { skill: "pins", text: "Pins are red.", reason: "Sphe" })).content[0]!.text).toContain("a teacher's to do");
    accounts.signedInForTests(["edit.bodycam", "agent.teach"]);
    expect((await call(app, id, "remember", { skill: "pins", text: "x".repeat(401), reason: "Sphe" })).content[0]!.text).toContain("at most 400 characters");
    expect((await call(app, id, "remember", { skill: "global", text: "x", reason: "y" })).content[0]!.text).toContain("Edit's own");
    expect((await call(app, id, "remember", { skill: "pins", text: "Board pins are red.", reason: "Sphe: pins are red" })).content[0]!.text).toContain("Remembered as pins (version 1)");
    // The global skill is seeded where Edit is made (the mock stands in for accounts' setGlobalSkill).
    mock.cloud.convex.library.set("skill:global", { key: "skill:global", kind: "skill", name: "global", current: 1, latest: 1, at: Date.now(), by: { name: "Edit" } });
    mock.cloud.convex.libraryVersions.set("skill:global", [{ key: "skill:global", n: 1, text: "- Keep what you remember short.", at: Date.now(), by: { name: "Edit" } }]);
    v2cloud.forgetSkills();
    await v2cloud.refreshSkills();
    expect(v2cloud.memories(place).map((one) => one.name)).toEqual(["global", "pins"]);
    const project = app.store.get(id)!.project;
    const prompt = agentInstructions(project);
    expect(prompt).toContain("WHAT YOU REMEMBER");
    expect(prompt.indexOf("- Keep what you remember short.")).toBeLessThan(prompt.indexOf("[pins] Board pins are red."));
    // None of the house's instructions or skills: its own, short.
    expect(prompt).not.toContain("WORK FAST");
    expect(prompt).not.toContain("- skill(");
    expect((await call(app, id, "archive_in_library", { kind: "skill", name: "global" })).content[0]!.text).toContain("stays");
    await call(app, id, "archive_in_library", { kind: "skill", name: "pins" });
    await v2cloud.refreshSkills();
    expect(v2cloud.memories(place).map((one) => one.name)).toEqual(["global"]);
    // A part of the edit's skill: named with when it fits, read when needed, longer than a memory and still short.
    expect((await call(app, id, "remember", { skill: "subtitles", text: "y".repeat(500), reason: "the house's, cut down", note: "Subtitles after the intro." })).content[0]!.text).toContain("version 1");
    expect((await call(app, id, "remember", { skill: "subtitles", text: "y".repeat(2_401), reason: "too long" })).content[0]!.text).toContain("at most 2400 characters");
    await call(app, id, "remember", { skill: "subtitles", text: "- Locked bottom middle.", reason: "JJ" });
    await v2cloud.refreshSkills();
    expect(v2cloud.skill("subtitles", place)).toMatchObject({ name: "subtitles", text: "- Locked bottom middle.", note: "Subtitles after the intro." });
    const withParts = agentInstructions(project);
    expect(withParts).toContain("YOUR SKILLS");
    expect(withParts).toContain("- subtitles: Subtitles after the intro.");
    expect(withParts).not.toContain("Locked bottom middle");
    expect((await call(app, id, "read_skill", { name: "subtitles" })).content[0]!.text).toBe("- Locked bottom middle.");
    expect((await call(app, id, "read_skill", { name: "nope" })).content[0]!.text).toContain("no skill nope");
    // Every other project reads the house's, and none of this.
    const plain = app.store.create("Plain", { width: 1920, height: 1080, fps: 30 }).project;
    expect(agentInstructions(plain)).toContain("WORK FAST");
    expect(agentInstructions(plain)).not.toContain("WHAT YOU REMEMBER");
  } finally {
    cleanup();
  }
});

test("a V2 project without a channel is taught the global skill alone and keeps nothing; a place uses its own and the global skill, never the house's or another place's", async () => {
  const items = [
    { key: "skill:global", name: "global" },
    { key: "skill:pins", name: "pins" },
    { key: "skill:@a--edit/pins", name: "pins" },
    { key: "skill:@b--edit/glow", name: "glow" },
    { key: "skill:@bodycam-hq/intro", name: "intro" },
  ];
  expect(v2cloud.forPlace(items, "a--edit").map((one) => one.key)).toEqual(["skill:global", "skill:@a--edit/pins"]);
  expect(v2cloud.forPlace(items, null).map((one) => one.key)).toEqual(["skill:global"]);
  expect(v2cloud.placeOfProject({})).toBeNull();
  const { app, cleanup, id } = hq("v2-no-channel");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    accounts.signedInForTests(["edit.bodycam", "agent.teach"]);
    v2cloud.useSkillsForTests([
      { name: "global", text: "Edit's own rules.", key: "skill:global" },
      { name: "pins", text: "The house's pins.", key: "skill:pins" },
      { name: "intro", text: "Edit V2's intro.", key: "skill:@bodycam-hq/intro" },
    ]);
    const prompt = agentInstructions(app.store.get(id)!.project);
    expect(prompt).toContain("Edit's own rules.");
    expect(prompt).not.toContain("The house's pins.");
    expect(prompt).not.toContain("Edit V2's intro.");
    expect(prompt).toContain("This project isn't a channel's, so nothing is kept");
    expect((await call(app, id, "remember", { skill: "pins", text: "Pins are red.", reason: "Sphe" })).content[0]!.text).toContain("This project isn't a channel's");
    const dir = effects.folder(app.store, id, "board");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>board</p>");
    expect((await call(app, id, "save_to_library", { kind: "effect", name: "board", category: "board", note: "A board.", brief: "Its texts." })).content[0]!.text).toContain("This project isn't a channel's");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- channels (Nov 14)

const CHANNEL = {
  key: "drinsanity", youtubeId: "UC" + "a".repeat(22), handle: "drinsanity", title: "Dr Insanity", description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0,
  narration: { kind: "voice" as const, id: "v123", name: "House" }, compilation: true, lanes: { ideas: "", thumbnails: "", script: "", edit: "bodycam and interrogation mixed into one" }, archived: false, addedBy: null, at: 0,
};
const OTHER = { ...CHANNEL, key: "jcs", youtubeId: "UC" + "b".repeat(22), handle: "jcs", title: "JCS", narration: { kind: "recorded" as const }, compilation: false, lanes: { ...CHANNEL.lanes, edit: "slow and moody" } };

test("a channel's edit lane is its own: it starts empty, none of V2's house comes through but the global skill, and another channel's is never in it", () => {
  const lane = v2cloud.placeOfProject({ channel: "drinsanity" })!;
  expect(lane).toBe("drinsanity--edit");
  expect(v2cloud.laneOf(lane)).toEqual({ channel: "drinsanity", lane: "edit" });
  expect(v2cloud.laneOf("drinsanity")).toBeNull();
  const items = [
    { key: "skill:global", name: "global", niches: null },
    { key: "skill:pins", name: "pins", niches: null },
    { key: "template:board", name: "board", niches: null },
    { key: "skill:@drinsanity--edit/intro", name: "intro" },
    { key: "skill:@jcs--edit/outro", name: "outro" },
    { key: "skill:@drinsanity--ideas/hooks", name: "hooks" },
  ];
  expect(v2cloud.forPlace(items, lane).map((one) => one.key)).toEqual(["skill:global", "skill:@drinsanity--edit/intro"]);
});

test("a script's, an idea's or a thumbnail's agent is told its channel's lane alone: its style, its own lessons (never the edit's global skill or another lane's), and how it keeps what it's taught", () => {
  channels.useChannelsForTests([{ ...CHANNEL, lanes: { ...CHANNEL.lanes, ideas: "short, punchy titles" } }, OTHER]);
  v2cloud.useSkillsForTests([
    { name: "global", text: "Edit's own rules.", key: "skill:global" },
    { name: "numbers", text: "Every title has a number in it.", key: "skill:@drinsanity--ideas/numbers" },
    { name: "hooks", text: "The hook pattern, long.", note: "When the person asks for hooks", key: "skill:@drinsanity--ideas/hooks" },
    { name: "intro", text: "The edit's intro.", key: "skill:@drinsanity--edit/intro" },
    { name: "jcs-titles", text: "JCS's way.", key: "skill:@jcs--ideas/jcs-titles" },
  ]);
  const text = lanes.section("drinsanity", "ideas");
  expect(text).toContain("THIS CHANNEL: Dr Insanity (@drinsanity)");
  expect(text).toContain("short, punchy titles");
  expect(text).toContain("- numbers: Every title has a number in it.");
  expect(text).toContain("- hooks: When the person asks for hooks");
  expect(text).not.toContain("Edit's own rules");
  expect(text).not.toContain("The edit's intro");
  expect(text).not.toContain("JCS's way");
  expect(text).toContain("keep it with remember");
  // Said outright, kept; maybe, asked once at the end and kept only on a yes (teaching.ts; Sphe, Nov 14).
  expect(text).toContain("whether to do it on every idea from now on");
  expect(text).toContain("If they go on without answering, it stays this idea's");
  expect(text).toContain("channel_videos");
  // A thumbnail's lane has nothing taught yet; a script's revision keeps lessons in its answer; a build only reads.
  expect(lanes.section("drinsanity", "thumbnails")).toContain("ISN'T TAUGHT YET");
  expect(lanes.section("drinsanity", "script", "lesson")).toContain('goes with scope "channel"');
  expect(lanes.section("drinsanity", "script", "none")).not.toMatch(/remember|send lesson/);
  expect(lanes.section(undefined, "ideas")).toBe("");
  expect(lanes.toolsFor("script").map((one) => one.name)).toEqual(["remember", "read_skill", "other_channels"]);
  expect(lanes.toolsFor("ideas").map((one) => one.name)).toContain("channel_videos");
});

test("who narrates for whom already, for the voice picker: each niche with its own narrator (bodycam's the house voice), then each channel with a voice, never one recorded", () => {
  const used = channels.usedVoices([CHANNEL, OTHER]);
  expect(used.find((one) => one.label === "Bodycam")?.voice).toBe(HOUSE_VOICE);
  expect(used.filter((one) => one.channel !== undefined)).toEqual([{ voice: "v123", label: "Dr Insanity", channel: "drinsanity" }]);
  expect(used.some((one) => one.label === "Interrogation")).toBe(false);
});

test("a channel's agent is told its channel, its edit style and how its videos are made, and that it isn't taught yet", () => {
  const { app, cleanup } = fixtureHome("v2-channel-prompt");
  try {
    channels.useChannelsForTests([CHANNEL]);
    const project = { ...app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project, hq: true, channel: "drinsanity" };
    const prompt = agentInstructions(project);
    expect(prompt).toContain("THIS PROJECT'S CHANNEL: Dr Insanity (@drinsanity), on YouTube. Its edit style, in the team's words: bodycam and interrogation mixed into one.");
    expect(prompt).toContain("narrated by the voice House (voice id v123)");
    expect(prompt).toContain("Its videos are compilations: several cases each.");
    expect(prompt).toContain("THIS CHANNEL ISN'T TAUGHT YET");
    expect(prompt).toContain("other_channels");
    // One case, though the channel's are compilations.
    expect(agentInstructions({ ...project, compilation: false })).toContain("This video is one case, unlike the channel's usual videos.");
  } finally {
    channels.useChannelsForTests([]);
    cleanup();
  }
});

test("other_channels: the rest listed only when asked, one's edit style shown, and a piece of it (or all of it) brought in as this channel's own, never over what it has", async () => {
  const { app, cleanup, id } = hq("v2-other-channels");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "drinsanity";
    });
    accounts.signedInForTests(["edit.bodycam", "agent.teach"]);
    mock.cloud.convex.channels = [CHANNEL, OTHER];
    const seed = (key: string, name: string, text: string, note: string) => {
      mock.cloud.convex.library.set(key, { key, kind: "skill", name, current: 1, latest: 1, note, niches: [key.slice(key.indexOf("@") + 1, key.indexOf("/"))], at: Date.now(), by: { name: "Sphe" } });
      mock.cloud.convex.libraryVersions.set(key, [{ key, n: 1, text, at: Date.now(), by: { name: "Sphe" } }]);
    };
    seed("skill:@jcs--edit/pacing", "pacing", "Hold on faces.", "How long a shot holds.");
    seed("skill:@jcs--edit/intro", "intro", "Cold open.", "The first minute.");
    seed("skill:@drinsanity--edit/intro", "intro", "Our own intro.", "The first minute.");
    const listed = (await call(app, id, "other_channels", {})).content[0]!.text!;
    expect(listed).toContain("- JCS (@jcs): 2 lessons, effects and sounds. Its edit style: slow and moody");
    expect(listed).not.toContain("Dr Insanity");
    expect((await call(app, id, "other_channels", { channel: "@jcs" })).content[0]!.text).toContain("- lesson pacing: How long a shot holds.");
    const brought = (await call(app, id, "other_channels", { channel: "JCS", bring: "all" })).content[0]!.text!;
    expect(brought).toContain("Brought into this channel's own edit style, to change here: lesson pacing.");
    expect(brought).toContain("This channel has its own intro already");
    expect(mock.cloud.convex.libraryVersions.get("skill:@drinsanity--edit/pacing")?.[0]).toMatchObject({ text: "Hold on faces.", from: { key: "skill:@jcs--edit/pacing", n: 1 } });
    expect(mock.cloud.convex.libraryVersions.get("skill:@drinsanity--edit/intro")).toHaveLength(1);
    expect((await call(app, id, "other_channels", { channel: "nobody" })).content[0]!.text).toContain('no channel "nobody"');
  } finally {
    mock.cloud.convex.channels = [];
    cleanup();
  }
});
