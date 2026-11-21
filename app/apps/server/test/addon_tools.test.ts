// The agent's tools for a channel's add-ons (addon_tools.ts, slices 7 and 8,
// Nov 21): set_addon keeps the item addons.ts reads back (its group's by
// default, the channel's alone when asked, over the version read), a teacher's
// alone, with its settings checked and merged; addons lists every one and
// where each comes from; the agent is told a channel's add-ons only once it
// has one (with none, its instructions are what they were); and the tools an
// add-on gives back are a channel project's only when it has that add-on,
// while every V1 project's list is exactly what it was.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import * as accounts from "../src/accounts.ts";
import * as addons from "../src/addons.ts";
import { agentInstructions } from "../src/agent.ts";
import type { App } from "../src/app.ts";
import { useChannelsForTests, type Channel, type Group } from "../src/channels.ts";
import * as cloud from "../src/cloud.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { dispatch, HQ_TOOLS, NOT_IN_HQ, TOOLS, toolsFor } from "../src/mcp/index.ts";
import { handlerFor, registerTool, text, unregisterTool } from "../src/mcp/registry.ts";
import { STYLES, type Project, type Style } from "../src/model.ts";
import { waiting } from "../src/teaching_gate.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const WIDE = { width: 1920, height: 1080, fps: 30 };
const TALL = { width: 1080, height: 1920, fps: 30 };

function channel(key: string, group?: string): Channel {
  return {
    key, youtubeId: null, handle: null, title: key, description: "", avatar: null, banner: null, uploads: null,
    subscribers: null, videos: null, views: null, country: null, publishedAt: null, fetchedAt: 0, narration: { kind: "voice", id: "v", name: "Andrew" }, compilation: false,
    lanes: { ideas: "", thumbnails: "", script: "", edit: "" },
    ...(group !== undefined ? { group } : {}),
  } as Channel;
}

const CHANNELS = [channel("alpha", "grp"), channel("beta", "grp"), channel("solo")];
const GROUPS: Group[] = [{ key: "grp", lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, channels: ["alpha", "beta"] }];
const edit = (place: string) => v2cloud.laneKey(place, "edit");

/** What the channels are taught: the global skill, and a lesson for the group and for solo (so they're taught). */
const LESSONS: v2cloud.Skill[] = [
  { name: v2cloud.GLOBAL, text: "Edit's own workings.", key: v2cloud.skillKey(v2cloud.GLOBAL) },
  { name: "pins", text: "Pins are red.", key: v2cloud.ownKey("skill", edit("grp"), "pins") },
  { name: "tone", text: "Calm.", key: v2cloud.ownKey("skill", edit("solo"), "tone") },
];

/** An add-on's item as set_addon keeps it, at `place`. */
function item(place: string, name: addons.Name, on: boolean, settings: Record<string, unknown> = {}): v2cloud.Skill {
  return { name: addons.skillOf(name), text: addons.write(name, on, settings), note: addons.noteOf(name), key: v2cloud.ownKey("skill", place, addons.skillOf(name)), latest: 1 };
}

let mock: MockServer;
let restoreEnv: () => void;
const retry = cloud.convexRetry.baseMs;

beforeAll(() => {
  mock = MockServer.start();
  restoreEnv = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
  cloud.convexRetry.baseMs = 1;
  registerEffectTools();
});

afterAll(() => {
  cloud.convexRetry.baseMs = retry;
  useChannelsForTests([]);
  v2cloud.useSkillsForTests([]);
  restoreEnv();
  mock.stop();
});

beforeEach(() => {
  mock.cloud.convex.library.clear();
  mock.cloud.convex.libraryVersions.clear();
  useChannelsForTests(CHANNELS, GROUPS);
  v2cloud.useSkillsForTests(LESSONS);
});

afterEach(() => {
  accounts.resetForTests();
});

/** A project in a fixture home: V2 on a channel (or V1 when `channelKey` is null and `hq` false). */
async function made(app: App, channelKey: string | null, options: { hq?: boolean; style?: Style; frame?: typeof WIDE } = {}): Promise<string> {
  const id = app.store.create("Case", options.frame ?? WIDE).project.id;
  await app.store.update(id, "test", (p) => {
    p.style = options.style ?? "bodycam";
    if (options.hq !== false) p.hq = true;
    if (channelKey !== null) p.channel = channelKey;
  });
  return id;
}

async function call(app: App, project: string, name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const answer = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } };
  return { text: answer.result.content[0]?.text ?? "", error: answer.result.isError };
}

async function listed(app: App, project: string | null): Promise<string[]> {
  const answer = (await dispatch(app, { id: 1, method: "tools/list" }, project)) as { result: { tools: { name: string }[] } };
  return answer.result.tools.map((one) => one.name);
}

const projectOf = (app: App, id: string): Project => app.store.get(id)!.project;

describe("set_addon", () => {
  test("keeps the item addons.ts reads: has turns true for the channel's project, off turns it false", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-set");
    try {
      const id = await made(app, "solo");
      expect(addons.has(projectOf(app, id), "horror-look")).toBe(false);
      const on = await call(app, id, "set_addon", { name: "horror-look", on: true, reason: "Sphe: this channel is analog horror" });
      expect(on.error).toBe(false);
      expect(on.text).toContain("Analog horror is on here");
      expect(on.text).toContain("Kept as addon-horror-look (version 1)");
      expect(on.text).toContain("It runs from your next change");
      // The item in the library, at solo's own place, as addons.ts writes it.
      const key = v2cloud.ownKey("skill", edit("solo"), "addon-horror-look");
      expect(mock.cloud.convex.library.get(key)?.note).toBe(addons.noteOf("horror-look"));
      expect(mock.cloud.convex.libraryVersions.get(key)?.at(-1)?.text).toBe(addons.write("horror-look", true, {}));
      expect(addons.has(projectOf(app, id), "horror-look")).toBe(true);
      expect(addons.itemOf("solo", "horror-look")).toMatchObject({ on: true, from: "channel", key, latest: 1 });

      const off = await call(app, id, "set_addon", { name: "horror-look", on: false, reason: "Sphe: not horror after all" });
      expect(off.text).toContain("Analog horror is off here");
      expect(off.text).toContain("version 2");
      expect(addons.has(projectOf(app, id), "horror-look")).toBe(false);
      // A default switched off the same way: bodycam's intro checks.
      expect(addons.has(projectOf(app, id), "bodycam-intro")).toBe(true);
      await call(app, id, "set_addon", { name: "bodycam-intro", on: false, reason: "Sphe" });
      expect(addons.has(projectOf(app, id), "bodycam-intro")).toBe(false);
      // Asked for what's already so: nothing saved.
      const again = await call(app, id, "set_addon", { name: "bodycam-intro", on: false, reason: "Sphe" });
      expect(again.text).toContain("nothing changed");
      expect(mock.cloud.convex.libraryVersions.get(v2cloud.ownKey("skill", edit("solo"), "addon-bodycam-intro"))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("kept for the group by default, reaching both its channels; for: channel keeps it for one, and says when the channel's own still wins", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-group");
    try {
      const alpha = await made(app, "alpha");
      const beta = await made(app, "beta");
      const solo = await made(app, "solo");
      const set = await call(app, alpha, "set_addon", { name: "post-details", on: true, reason: "Sphe: show the videos we talk about" });
      expect(set.text).toContain("for the group (alpha & beta)");
      expect(mock.cloud.convex.library.has(v2cloud.ownKey("skill", edit("grp"), "addon-post-details"))).toBe(true);
      expect([alpha, beta, solo].map((id) => addons.has(projectOf(app, id), "post-details"))).toEqual([true, true, false]);
      // beta alone switches it off; the group's still holds on alpha.
      const own = await call(app, beta, "set_addon", { name: "post-details", on: false, for: "channel", reason: "Sphe: not on beta" });
      expect(own.text).toContain("for this channel only");
      expect([alpha, beta].map((id) => addons.has(projectOf(app, id), "post-details"))).toEqual([true, false]);
      // Set for the group from beta: beta's own still wins there, and the answer says so.
      const shadowed = await call(app, beta, "set_addon", { name: "post-details", on: false, reason: "Sphe: off for everyone" });
      expect(shadowed.text).toBe(
        `${addons.summary("post-details", false, {})} Kept as addon-post-details (version 2) for the group (alpha & beta). It stops from the next time it would have run.` +
          ` This channel's own setting still wins here (off): set it with for: "channel" to change it for this channel.`,
      );
      expect(addons.has(projectOf(app, alpha), "post-details")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("settings are checked (a bad one refused in checked's words) and merge over what's set; null puts one back", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-settings");
    try {
      const id = await made(app, "solo");
      const bad = await call(app, id, "set_addon", { name: "muted-words", on: true, settings: { list: "gore" }, reason: "Sphe" });
      expect(bad.error).toBe(true);
      expect(bad.text).toBe((addons.checked("muted-words", { list: "gore" }) as { error: string }).error);
      const stray = await call(app, id, "set_addon", { name: "muted-words", on: true, settings: { loud: true }, reason: "Sphe" });
      expect(stray.text).toBe((addons.checked("muted-words", { loud: true }) as { error: string }).error);
      expect((await call(app, id, "set_addon", { name: "muted-words", on: true, settings: "horror", reason: "Sphe" })).text).toContain("settings is an object");
      expect((await call(app, id, "set_addon", { name: "held-broll", on: true, settings: { size: 2 }, reason: "Sphe" })).text).toContain("held-broll takes no settings");
      expect(mock.cloud.convex.library.size).toBe(0);

      await call(app, id, "set_addon", { name: "muted-words", on: true, settings: { list: "horror" }, reason: "Sphe" });
      const more = await call(app, id, "set_addon", { name: "muted-words", on: true, settings: { words: ["gizmo"] }, reason: "Sphe: mute gizmo too" });
      expect(more.text).toContain("list horror; words gizmo");
      expect(more.text).toContain("It runs from the end of this turn.");
      expect([addons.setting(projectOf(app, id), "muted-words", "list"), addons.setting(projectOf(app, id), "muted-words", "words")]).toEqual(["horror", ["gizmo"]]);
      await call(app, id, "set_addon", { name: "muted-words", on: true, settings: { list: null }, reason: "Sphe: the usual list" });
      expect([addons.setting(projectOf(app, id), "muted-words", "list"), addons.setting(projectOf(app, id), "muted-words", "words")]).toEqual(["commentary", ["gizmo"]]);
    } finally {
      cleanup();
    }
  });

  test("an unknown name is answered with the names there are; a script's add-on is set like the rest; a project with no channel and a V1 one are refused in words", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-names");
    try {
      const id = await made(app, "solo");
      const unknown = await call(app, id, "set_addon", { name: "laser-show", on: true, reason: "Sphe" });
      expect(unknown.text).toBe(`Edit has no add-on called laser-show. The ones there are: ${addons.NAMES.join(", ")}.`);
      // A channel's script add-on is set here too (Nov 21 evening: refused, nothing in the app could set one): kept in its Script lane's place.
      const court = await call(app, id, "set_addon", { name: "court-script", on: true, reason: "Sphe: its scripts are court cases" });
      expect(court.text).toContain("It shapes every script made in this channel from now on");
      expect(addons.courtScripts("solo")).toBe(true);
      expect((await call(app, id, "addons", { name: "court-script" })).text).toContain("for this channel's scripts");
      expect((await call(app, id, "addons", { name: "court-script" })).text).toContain("Runs when a script is made in this channel. On here");
      expect((await call(app, id, "set_addon", { name: "short-form", reason: "Sphe" })).text).toContain("on is true");
      expect((await call(app, id, "set_addon", { name: "short-form", on: true })).text).toContain("reason is required");
      const loose = await made(app, null);
      expect((await call(app, loose, "set_addon", { name: "short-form", on: true, reason: "Sphe" })).text).toContain("This project isn't a channel's, so it has no add-ons");
      expect((await call(app, loose, "addons", {})).text).toContain("This project isn't a channel's");
      const v1 = await made(app, null, { hq: false });
      expect((await call(app, v1, "addons", {})).text).toContain("this project isn't an Edit V2 one");
      // Only the script's add-on above was kept.
      expect(mock.cloud.convex.library.size).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("a person who may not teach is refused; anyone may read addons", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-teacher");
    try {
      const id = await made(app, "alpha");
      accounts.signedInForTests(["edit.bodycam", "channel.alpha"]);
      const refused = await call(app, id, "set_addon", { name: "short-form", on: true, reason: "JJ" });
      expect(refused.error).toBe(true);
      expect(refused.text).toContain("Setting a channel's add-ons is a teacher's to do (agent.teach");
      expect(mock.cloud.convex.library.size).toBe(0);
      const read = await call(app, id, "addons", {});
      expect(read.error).toBe(false);
      expect(read.text).toContain("- short-form (Shorts)");
    } finally {
      cleanup();
    }
  });

  test("a save over another teacher's since is refused, and says what it is now", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-latest");
    try {
      const id = await made(app, "solo");
      await call(app, id, "set_addon", { name: "reverb-out", on: true, reason: "Sphe" });
      // Another teacher switches it off meanwhile, unseen by this conversation (what it read is still fresh).
      const key = v2cloud.ownKey("skill", edit("solo"), "addon-reverb-out");
      await v2cloud.saveSkill("addon-reverb-out", addons.write("reverb-out", false, {}), "Marc", addons.noteOf("reverb-out"), { key, latest: 1 });
      expect(addons.itemOf("solo", "reverb-out")).toMatchObject({ on: true, latest: 1 });
      // This conversation, asked for a setting, saves over version 1: refused, and told it's off now.
      const refused = await call(app, id, "set_addon", { name: "reverb-out", on: false, for: "channel", reason: "Sphe" });
      expect(refused.error).toBe(true);
      expect(refused.text).toBe(`Someone else set reverb-out on this channel since this conversation read it, so nothing changed: ${addons.summary("reverb-out", false, {})} Tell the person, and set it again only if they still want theirs.`);
      expect(mock.cloud.convex.libraryVersions.get(key)).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

describe("addons", () => {
  test("lists every add-on, the edit's then the scripts', on or off, where each comes from, and its settings", async () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("grp"), "muted-words", true, { list: "horror" }), item(edit("alpha"), "bodycam-intro", false)]);
    const { app, cleanup } = fixtureHome("addon-tools-list");
    try {
      const id = await made(app, "alpha");
      const said = (await call(app, id, "addons", {})).text;
      const lines = said.split("\n").filter((line) => line.startsWith("- "));
      expect(lines.map((line) => line.slice(2, line.indexOf(" (")))).toEqual([...addons.NAMES.filter((one) => addons.CATALOGUE[one].lane === "edit"), ...addons.NAMES.filter((one) => addons.CATALOGUE[one].lane === "script")]);
      const line = (name: string) => lines.find((one) => one.startsWith(`- ${name} `))!;
      expect(line("muted-words")).toContain("On here (set for the group), with list horror; words none.");
      expect(line("muted-words")).toContain("Runs when your turn ends.");
      expect(line("bodycam-intro")).toContain("Off here (set for this channel only).");
      expect(line("windows-screens")).toContain("On here (Edit's default for this channel).");
      expect(line("horror-look")).toContain("Off here (Edit's default for this channel).");
      expect(line("short-form")).toContain("Runs when a project is made in this channel; gives you reframe.");
      expect(line("short-form")).toContain('Takes forms: "short" (every project is a Short) or "both"');
      // One alone.
      const one = (await call(app, id, "addons", { name: "reverb-out" })).text;
      expect(one.split("\n").filter((row) => row.startsWith("- "))).toHaveLength(1);
      expect(one).toContain("gives you commentary_reverb_out");
    } finally {
      cleanup();
    }
  });
});

describe("the teaching gate", () => {
  test("addons and set_addon work on an untaught channel, and an add-on set alone leaves it untaught", async () => {
    v2cloud.useSkillsForTests([LESSONS[0]!]);
    const { app, cleanup } = fixtureHome("addon-tools-gate");
    try {
      const id = await made(app, "solo");
      expect(waiting(projectOf(app, id))).toBe(true);
      expect((await call(app, id, "addons", {})).error).toBe(false);
      const set = await call(app, id, "set_addon", { name: "held-broll", on: true, reason: "Sphe: a hearing channel" });
      expect(set.error).toBe(false);
      expect(addons.has(projectOf(app, id), "held-broll")).toBe(true);
      expect(waiting(projectOf(app, id))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("archive_in_library", () => {
  test("refuses to put an add-on away: set_addon switches it off", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-archive");
    try {
      const id = await made(app, "solo");
      await call(app, id, "set_addon", { name: "reverb-out", on: true, reason: "Sphe" });
      const refused = await call(app, id, "archive_in_library", { kind: "skill", name: "addon-reverb-out" });
      expect(refused.error).toBe(true);
      expect(refused.text).toBe("addon-reverb-out is one of this channel's add-ons, not a lesson: switch it off with set_addon (on: false), never put it away.");
      expect(mock.cloud.convex.library.get(v2cloud.ownKey("skill", edit("solo"), "addon-reverb-out"))?.archived).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("what the agent is told", () => {
  test("with no item, a channel's instructions are what they were: an item on another channel changes not a byte, and no add-ons block", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-quiet");
    try {
      for (const key of ["alpha", "solo"]) {
        const p = projectOf(app, await made(app, key));
        v2cloud.useSkillsForTests(LESSONS);
        const before = agentInstructions(p);
        v2cloud.useSkillsForTests([...LESSONS, item(edit(key === "solo" ? "beta" : "solo"), "horror-look", true), item(v2cloud.laneKey(key, "script"), "court-script", true)]);
        expect(agentInstructions(p)).toBe(before);
        expect(before).not.toContain("ADD-ONS");
        // The two tools are in V2's list like every V2 tool; nothing else says add-on.
        const head = before.slice(0, before.indexOf("The edit tools (call them directly"));
        expect(head.toLowerCase()).not.toContain("add-on");
      }
    } finally {
      cleanup();
    }
  });

  test("with items, it names those on for this project, each with when it runs, and says set_addon sets more", async () => {
    v2cloud.useSkillsForTests([...LESSONS, item(edit("grp"), "post-details", true), item(edit("alpha"), "muted-words", true, { list: "horror", words: ["gizmo"] }), item(edit("alpha"), "bodycam-intro", false)]);
    const { app, cleanup } = fixtureHome("addon-tools-told");
    try {
      const said = agentInstructions(projectOf(app, await made(app, "alpha")));
      const block = said.slice(said.indexOf("THIS CHANNEL'S ADD-ONS"), said.indexOf("set it with set_addon.") + "set it with set_addon.".length);
      expect(block).toBe(
        "THIS CHANNEL'S ADD-ONS (Edit's own code, set for this channel; each runs by itself):\n" +
          `- Video and post details (the group's): ${addons.CATALOGUE["post-details"].description} Runs inside your tools; gives you youtube_reference, tweet_reference.\n` +
          `- Extra muted words (this channel only; list horror; words gizmo): ${addons.CATALOGUE["muted-words"].description} Runs when your turn ends.\n` +
          "Switched off here: Bodycam intro checks.\n" +
          "There are more (addons lists them): when the team asks for something that should hold for every video here, see whether one does it and set it with set_addon.",
      );
      // After the channel's own words, before what it keeps.
      expect(said.indexOf("THIS PROJECT'S CHANNEL")).toBeLessThan(said.indexOf("THIS CHANNEL'S ADD-ONS"));
      // The tools it gives are in its reference.
      expect(said).toContain("- youtube_reference(");
      expect(said).not.toContain("- reframe(");
    } finally {
      cleanup();
    }
  });
});

describe("the tools an add-on gives back", () => {
  const V1 = TOOLS.map((one) => one.name).filter((name) => !HQ_TOOLS.includes(name));
  const V2 = TOOLS.map((one) => one.name).filter((name) => !NOT_IN_HQ.includes(name));

  test("a V1 project's list is every tool but V2's, for each of the six styles, whatever a channel has set", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-v1");
    try {
      for (const items of [LESSONS, [...LESSONS, item(edit("solo"), "short-form", true), item(edit("grp"), "post-details", true)]]) {
        v2cloud.useSkillsForTests(items);
        for (const { value: style } of STYLES) {
          const id = await made(app, null, { hq: false, style, frame: style === "shorts" ? TALL : WIDE });
          expect([style, await listed(app, id)]).toEqual([style, V1]);
          expect(toolsFor(false, projectOf(app, id))).toEqual(toolsFor(false));
        }
        expect(await listed(app, null)).toEqual(V1);
      }
    } finally {
      cleanup();
    }
  });

  test("a channel's project with nothing set has V2's list; with short-form on, reframe as well; a project without a channel V2's own", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-list-v2");
    try {
      const solo = await made(app, "solo", { frame: TALL });
      const alpha = await made(app, "alpha");
      const loose = await made(app, null, { style: "shorts", frame: TALL });
      expect(await listed(app, solo)).toEqual(V2);
      expect(await listed(app, alpha)).toEqual(V2);
      expect(await listed(app, loose)).toEqual(V2);
      v2cloud.useSkillsForTests([...LESSONS, item(edit("solo"), "short-form", true), item(edit("grp"), "post-details", true), item(edit("grp"), "reverb-out", true)]);
      expect(await listed(app, solo)).toEqual(TOOLS.map((one) => one.name).filter((name) => V2.includes(name) || name === "reframe"));
      expect(await listed(app, alpha)).toEqual(TOOLS.map((one) => one.name).filter((name) => V2.includes(name) || ["youtube_reference", "tweet_reference", "commentary_reverb_out"].includes(name)));
      expect(await listed(app, loose)).toEqual(V2);
      // Switched off for alpha alone: its list is V2's again, beta's keeps them.
      v2cloud.useSkillsForTests([...LESSONS, item(edit("grp"), "post-details", true), item(edit("alpha"), "post-details", false)]);
      expect(await listed(app, alpha)).toEqual(V2);
      expect(await listed(app, await made(app, "beta"))).toContain("youtube_reference");
    } finally {
      cleanup();
    }
  });

  test("a call to a tool only an add-on gives is refused in plain words without it, and runs with it", async () => {
    const original = handlerFor("reframe");
    if (original !== undefined) unregisterTool("reframe");
    registerTool("reframe", () => text("reframed"));
    const { app, cleanup } = fixtureHome("addon-tools-call");
    try {
      // solo's lesson in the cloud too, so it's still taught once set_addon reads the library again.
      await v2cloud.saveSkill("tone", "Calm.", "test", undefined, { key: v2cloud.ownKey("skill", edit("solo"), "tone") });
      const solo = await made(app, "solo", { frame: TALL });
      const without = await call(app, solo, "reframe", {});
      expect(without.error).toBe(true);
      expect(without.text).toBe("reframe comes with this channel's Shorts add-on, which isn't on here. If the person wants it for every video here, set_addon switches it on (a teacher's to do), and reframe is yours from your next turn.");
      const set = await call(app, solo, "set_addon", { name: "short-form", on: true, settings: { forms: "both" }, reason: "Sphe: Shorts and long videos here" });
      expect(set.text).toContain("It shapes every project made in this channel from now on; projects already made keep their frame. reframe is in your tools from your next turn (each turn lists them again), not this one.");
      expect(await call(app, solo, "reframe", {})).toEqual({ text: "reframed", error: false });
      expect(await listed(app, solo)).toContain("reframe");
      // On a channel making both, a long project hasn't it: refused, saying why.
      v2cloud.useSkillsForTests([...LESSONS, item(edit("solo"), "short-form", true, { forms: "both" })]);
      const long = await made(app, "solo");
      expect((await call(app, long, "reframe", {})).text).toBe("reframe comes with this channel's Shorts add-on, which is on here for its Shorts only: this project is a long one.");
      // A V1 project and a V2 one without a channel answer as before.
      expect(await call(app, await made(app, null, { hq: false }), "reframe", {})).toEqual({ text: "reframed", error: false });
      expect(await call(app, await made(app, null), "reframe", {})).toEqual({ text: "reframed", error: false });
    } finally {
      cleanup();
      unregisterTool("reframe");
      if (original !== undefined) registerTool("reframe", original.handler, { noProject: original.noProject });
    }
  });

  test("a commentary V1 edit moved onto a channel gets its style's tools back, as its checks are", async () => {
    const { app, cleanup } = fixtureHome("addon-tools-moved");
    try {
      const moved = await made(app, "solo", { style: "commentary" });
      expect(addons.has(projectOf(app, moved), "post-details")).toBe(true);
      expect(await listed(app, moved)).toEqual(TOOLS.map((one) => one.name).filter((name) => V2.includes(name) || ["youtube_reference", "tweet_reference", "commentary_reverb_out"].includes(name)));
    } finally {
      cleanup();
    }
  });
});
