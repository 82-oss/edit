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
    accounts.signedInForTests(["edit.bodycam", "channel.lib-ch"]);
    expect((await call(app, id, "save_to_library", keep)).content[0]!.text).toContain("a teacher's to do");
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.lib-ch"]);
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
    accounts.signedInForTests(["edit.bodycam", "channel.mem-ch"]);
    expect((await call(app, id, "remember", { skill: "pins", text: "Pins are red.", reason: "Sphe" })).content[0]!.text).toContain("a teacher's to do");
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.mem-ch"]);
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

test("teaching not read from the cloud yet is never taken for untaught: the agent's told it didn't load, and nothing is kept until it reads", async () => {
  // Nov 16 audit: a turn starting while the first read was still out (or after it failed) was told its channel was
  // untaught and to build its style from scratch, keeping lessons over the team's.
  const { app, cleanup, id } = hq("v2-unread");
  try {
    channels.useChannelsForTests([CHANNEL]);
    v2cloud.useSkillsForTests([], [], false);
    const project = { ...app.store.get(id)!.project, hq: true, channel: "drinsanity" };
    const prompt = agentInstructions(project);
    expect(prompt).toContain("THIS CHANNEL'S TEACHING COULDN'T BE READ");
    expect(prompt).not.toContain("THIS CHANNEL ISN'T TAUGHT YET");
    expect(lanes.section("drinsanity", "ideas")).toContain("COULDN'T BE READ");
    await app.store.update(id, "test", (one) => {
      one.hq = true;
      one.channel = "drinsanity";
    });
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.drinsanity"]);
    expect((await call(app, id, "remember", { skill: "pins", text: "Pins are red.", reason: "Sphe" })).content[0]!.text).toContain("couldn't be read from Edit's cloud yet");
    // Once it reads, it's as before.
    v2cloud.useSkillsForTests([]);
    expect(agentInstructions(project)).toContain("THIS CHANNEL ISN'T TAUGHT YET");
  } finally {
    v2cloud.useSkillsForTests([]);
    channels.useChannelsForTests([]);
    cleanup();
  }
});

test("a lesson another teacher changed since this conversation read it isn't saved over: the agent gets it as it is now, to put its change into", async () => {
  // Nov 16 audit: remember wrote the lesson whole from text read at the turn's start, so another Mac's newer save was lost, unseen.
  const { app, cleanup, id } = hq("v2-conflict");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "conf-ch";
    });
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.conf-ch"]);
    expect((await call(app, id, "remember", { skill: "pins", text: "Board pins are red.", reason: "Sphe" })).content[0]!.text).toContain("version 1");
    v2cloud.forgetSkills();
    await v2cloud.refreshSkills();
    // Another Mac's teacher, meanwhile.
    const key = "skill:@conf-ch--edit/pins";
    const item = mock.cloud.convex.library.get(key)!;
    mock.cloud.convex.libraryVersions.get(key)!.push({ key, n: 2, text: "Board pins are red, with a soft shadow.", at: Date.now(), by: { name: "Marc" } });
    item.latest = 2;
    item.current = 2;
    const said = (await call(app, id, "remember", { skill: "pins", text: "Board pins are blue.", reason: "Sphe" })).content[0]!.text;
    expect(said).toContain("Someone else changed pins since this conversation read it");
    expect(said).toContain("with a soft shadow");
    expect(mock.cloud.convex.libraryVersions.get(key)!.length).toBe(2);
    // Read again, it saves.
    await v2cloud.refreshSkills();
    expect((await call(app, id, "remember", { skill: "pins", text: "Board pins are blue, with a soft shadow.", reason: "Sphe" })).content[0]!.text).toContain("version 3");
  } finally {
    cleanup();
  }
});

test("a channel that's put away or not given is said in words, never by its key, and a script's edit is never quietly made without its channel", async () => {
  // Nov 16 audit: channelFor said "There's no channel ch-…", and Start edit on a channel's script fell back to today's
  // kind of edit (not V2, and not movable onto the channel afterwards) on any failure.
  const { app, cleanup } = fixtureHome("v2-channel-words");
  try {
    fs.writeFileSync(join(app.store.home, "beta.json"), JSON.stringify({ v2: true }));
    accounts.signedInForTests(["edit.bodycam", "channel.drinsanity"]);
    mock.cloud.convex.channels = [{ ...CHANNEL, archived: true }];
    await expect(channels.channelFor("drinsanity", app.store.home)).rejects.toThrow("Dr Insanity was put away: an admin can bring it back");
    mock.cloud.convex.channels = [];
    const missing = channels.channelFor("ch-0123456789", app.store.home);
    await expect(missing).rejects.toThrow("isn't in Edit, or isn't shown to your account");
    await expect(channels.channelFor("ch-0123456789", app.store.home)).rejects.not.toThrow("ch-0123456789");
  } finally {
    mock.cloud.convex.channels = [];
    cleanup();
  }
});

test("a placeholder channel (Sphe, Nov 15): its agents know it isn't on YouTube yet, and its videos aren't asked of YouTube", () => {
  const { app, cleanup } = fixtureHome("v2-channel-placeholder");
  try {
    const PLACEHOLDER = { ...OTHER, key: "gta-6-channel", youtubeId: null, handle: null, title: "GTA 6 channel", subscribers: null, videos: null, views: null };
    channels.useChannelsForTests([PLACEHOLDER]);
    const project = { ...app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project, hq: true, channel: "gta-6-channel" };
    expect(agentInstructions(project)).toContain("THIS PROJECT'S CHANNEL: GTA 6 channel (a new channel, not on YouTube yet).");
    expect(lanes.section("gta-6-channel", "ideas")).toContain("THIS CHANNEL: GTA 6 channel (a new channel, not on YouTube yet).");
  } finally {
    channels.useChannelsForTests([]);
    cleanup();
  }
});

test("a channel seen by its label alone (Sphe, Nov 15): its agents have the label for its name and don't read its videos", async () => {
  const { app, cleanup } = fixtureHome("v2-channel-masked");
  try {
    const MASKED = { ...CHANNEL, youtubeId: null, handle: null, title: "Bodycam Channel 1", label: "Bodycam Channel 1", masked: true, subscribers: null, videos: null, views: null };
    channels.useChannelsForTests([MASKED]);
    expect(channels.placeholder(MASKED)).toBe(false);
    const project = { ...app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project, hq: true, channel: "drinsanity" };
    const prompt = agentInstructions(project);
    expect(prompt).toContain("THIS PROJECT'S CHANNEL: Bodycam Channel 1, on YouTube.");
    expect(prompt).not.toContain("Dr Insanity");
    expect(lanes.section("drinsanity", "ideas")).toContain("THIS CHANNEL: Bodycam Channel 1, on YouTube.");
    expect(await lanes.call("channel_videos", {}, { channel: "drinsanity", lane: "ideas" })).toContain("aren't shown to this account");
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
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.drinsanity"]);
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

// Channel groups (Nov 15; mamagi's groups.ts): channels sharing one style, taught once, each keeping its exceptions.
const BODYCAM = { ...CHANNEL, key: "ch-sambodycam", handle: "samsbodycam", title: "Sam's Bodycam", compilation: false, group: "gr-0123456789", lanes: { ...CHANNEL.lanes, edit: "a red pin on every name" } };
const COMPILATIONS = { ...CHANNEL, key: "ch-samcompila", youtubeId: "UC" + "c".repeat(22), handle: "samscompilations", title: "Sam's Compilations", compilation: true, group: "gr-0123456789", lanes: { ...CHANNEL.lanes, edit: "" } };
const GROUP = { key: "gr-0123456789", lanes: { ideas: "", thumbnails: "", script: "", edit: "fast cuts, captions in yellow" }, channels: ["ch-sambodycam", "ch-samcompila"] };

test("a grouped channel reads its group's teaching and its own, its own winning by name; an ungrouped one only its own", () => {
  channels.useChannelsForTests([BODYCAM, COMPILATIONS, OTHER], [GROUP]);
  try {
    expect(channels.placesOf("ch-sambodycam", "edit")).toEqual(["ch-sambodycam--edit", "gr-0123456789--edit"]);
    expect(channels.placesOf("jcs", "edit")).toEqual(["jcs--edit"]);
    const items = [
      { key: "skill:global", name: "global" },
      { key: "skill:@gr-0123456789--edit/pins", name: "pins" },
      { key: "skill:@gr-0123456789--edit/captions", name: "captions" },
      { key: "skill:@ch-sambodycam--edit/pins", name: "pins" },
      { key: "skill:@ch-samcompila--edit/cards", name: "cards" },
      { key: "skill:@jcs--edit/outro", name: "outro" },
    ];
    expect(v2cloud.forPlace(items, channels.placesOf("ch-sambodycam", "edit")).map((one) => one.key)).toEqual(["skill:global", "skill:@gr-0123456789--edit/captions", "skill:@ch-sambodycam--edit/pins"]);
    expect(v2cloud.forPlace(items, channels.placesOf("ch-samcompila", "edit")).map((one) => one.key)).toEqual(["skill:global", "skill:@gr-0123456789--edit/pins", "skill:@gr-0123456789--edit/captions", "skill:@ch-samcompila--edit/cards"]);
    expect(v2cloud.originOf(items[1]!, channels.placesOf("ch-sambodycam", "edit"))).toBe("its group's");
    expect(v2cloud.originOf(items[3]!, channels.placesOf("ch-sambodycam", "edit"))).toBe("this channel's own");
  } finally {
    channels.useChannelsForTests([]);
  }
});

test("a grouped channel's agents are told the group, its other channels (which are compilations), the shared style and the channel's exceptions; labels when that's all they see", () => {
  const { app, cleanup } = fixtureHome("v2-channel-group");
  try {
    channels.useChannelsForTests([BODYCAM, COMPILATIONS], [GROUP]);
    v2cloud.useSkillsForTests([
      { name: "global", text: "Edit's own rules.", key: "skill:global" },
      { name: "numbers", text: "Every title has a number.", key: "skill:@gr-0123456789--ideas/numbers" },
      { name: "single", text: "One case in each title.", key: "skill:@ch-sambodycam--ideas/single" },
      { name: "pins", text: "Pins are red.", key: "skill:@gr-0123456789--edit/pins" },
      { name: "cards", text: "A card between cases.", key: "skill:@ch-samcompila--edit/cards" },
    ]);
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.ch-sambodycam", "channel.ch-samcompila"]);
    const project = { ...app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project, hq: true, channel: "ch-samcompila" };
    const prompt = agentInstructions(project);
    expect(prompt).toContain("It's in a group with Sam's Bodycam: they share one edit style, the group's, taught once for all of them; this channel's videos are compilations.");
    expect(prompt).toContain("The group's edit style, in the team's words: fast cuts, captions in yellow.");
    expect(prompt).toContain("[pins] Pins are red.");
    expect(prompt).toContain("[cards (this channel only)] A card between cases.");
    expect(prompt).toContain('"I\'ll remember this for the group: …", or "I\'ll remember this for this channel only: …"');
    expect(prompt).toContain('a lesson is the group\'s by default (for: "group")');
    expect(prompt).not.toContain("THIS CHANNEL ISN'T TAUGHT YET");
    const ideas = lanes.section("ch-sambodycam", "ideas");
    expect(ideas).toContain("It's in a group with Sam's Compilations (compilations): they share one ideas style");
    expect(ideas).toContain("What the team has taught you for the group's ideas (always):\n- numbers: Every title has a number.");
    expect(ideas).toContain("For Sam's Bodycam alone, its exceptions (always; they win over the group's):\n- single: One case in each title.");
    expect(lanes.section("ch-sambodycam", "script", "lesson")).toContain('It\'s this channel\'s alone (for: "channel")');
    // Someone given only labels: labels, never names.
    channels.useChannelsForTests([{ ...BODYCAM, title: "Bodycam 1", masked: true, youtubeId: null, handle: null }, { ...COMPILATIONS, title: "Bodycam 2", masked: true, youtubeId: null, handle: null }], [GROUP]);
    const masked = agentInstructions(project) + lanes.section("ch-sambodycam", "ideas");
    expect(masked).toContain("It's in a group with Bodycam 1");
    expect(masked).toContain("with Bodycam 2 (compilations)");
    expect(masked).not.toMatch(/Sam's/);
  } finally {
    channels.useChannelsForTests([]);
    cleanup();
  }
});

test("in a grouped channel a lesson goes to the group by default and to the channel alone when told; an ungrouped channel's to its own", async () => {
  const { app, cleanup, id } = hq("v2-group-remember");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "ch-sambodycam";
    });
    channels.useChannelsForTests([BODYCAM, COMPILATIONS, OTHER], [GROUP]);
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.ch-sambodycam", "channel.ch-samcompila", "channel.jcs"]);
    expect((await call(app, id, "remember", { skill: "pins", text: "Pins are red.", reason: "Sphe: always" })).content[0]!.text).toContain("in this channel's edit style for the group (Sam's Bodycam & Sam's Compilations)");
    expect(mock.cloud.convex.libraryVersions.get("skill:@gr-0123456789--edit/pins")?.[0]).toMatchObject({ text: "Pins are red." });
    expect((await call(app, id, "remember", { skill: "pins", text: "Pins are blue here.", reason: "Sphe: for this channel", for: "channel" })).content[0]!.text).toContain("for this channel only");
    expect(mock.cloud.convex.libraryVersions.get("skill:@ch-sambodycam--edit/pins")?.[0]).toMatchObject({ text: "Pins are blue here." });
    await v2cloud.refreshSkills();
    // Kept for the group again while this channel has its own: said so.
    expect((await call(app, id, "remember", { skill: "pins", text: "Pins are dark red.", reason: "Sphe" })).content[0]!.text).toContain("This channel's own pins still wins here");
    expect((await call(app, id, "remember", { skill: "x", text: "y", reason: "z", for: "everyone" })).content[0]!.text).toContain('for is "group" or "channel"');
    // A lane's agent the same way; Script mode's lesson too (lesson_note.ts passes its `for`).
    expect(await lanes.call("remember", { skill: "numbers", text: "A number in each title.", reason: "Sphe" }, { channel: "ch-samcompila", lane: "ideas" })).toContain("for the group (Sam's Bodycam & Sam's Compilations)");
    expect(mock.cloud.convex.library.has("skill:@gr-0123456789--ideas/numbers")).toBe(true);
    expect(await lanes.keepLesson({ channel: "ch-samcompila", lane: "script" }, "cases", "A card between cases.", "said", "channel")).toContain("for this channel only");
    expect(mock.cloud.convex.library.has("skill:@ch-samcompila--script/cases")).toBe(true);
    // Ungrouped: its own, said as before.
    expect(await lanes.call("remember", { skill: "slow", text: "Slow titles.", reason: "Sphe" }, { channel: "jcs", lane: "ideas" })).toBe("Kept as slow (version 1) in JCS (@jcs)'s ideas style: its agents have it from their next turn.");
  } finally {
    channels.useChannelsForTests([]);
    cleanup();
  }
});
