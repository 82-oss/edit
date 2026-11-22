// The teaching draft (teaching_draft.ts; Sphe, Nov 22): what could be taught,
// kept unseen with the project, shown to the agent with each message, and
// moved into the channel word for word when the person says to teach it.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import { agentInstructions } from "../src/agent.ts";
import * as cloud from "../src/cloud.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import * as effects from "../src/effects.ts";
import { dispatch } from "../src/mcp/index.ts";
import { messageContext } from "../src/media_tools.ts";
import * as teachingConflicts from "../src/teaching_conflicts.ts";
import * as draft from "../src/teaching_draft.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
const ask = teachingConflicts.hooks.ask;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
  registerEffectTools();
  teachingConflicts.hooks.ask = async () => ({ conflicts: [] });
});

afterAll(() => {
  teachingConflicts.hooks.ask = ask;
  restore();
  mock.stop();
});

afterEach(() => {
  accounts.resetForTests();
  v2cloud.useSkillsForTests([]);
});

async function call(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, args: Record<string, unknown>) {
  const answer = ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
  return { text: answer.content.map((one) => one.text ?? "").join(" "), isError: answer.isError };
}

async function channelProject(app: ReturnType<typeof fixtureHome>["app"], channel: string | null) {
  const id = app.store.create("Shorts test", { width: 1080, height: 1920, fps: 30 }).project.id;
  await app.store.update(id, "test", (project) => {
    project.hq = true;
    if (channel !== null) project.channel = channel;
  });
  return id;
}

const GLOBAL = { name: v2cloud.GLOBAL, text: "Edit's own workings.", key: v2cloud.skillKey(v2cloud.GLOBAL) };

// The M1 trial, Nov 22: "I like that lower third. Also, I think every video here should open on the loudest line." was
// kept at once (remember) for its "every video"; Sphe wants what's said in passing drafted and asked about at the end.
test("only a plain instruction to keep it is kept at once: a thought or liking said in passing, every video or not, is drafted and asked about", async () => {
  const { keepRule, DRAFT_RULE } = await import("../src/teaching.ts");
  const rule = keepRule("video", "keep it with remember");
  expect(rule).toContain('when they tell you plainly to keep it ("always…", "never…", "from now on…", "make this a rule", "we don\'t do that for any…", "remember this", "teach this", "keep that"), keep it with remember at once');
  expect(rule).toContain('A thought, a liking or a wish said in passing is not that, even when it names every video ("I like that lower third", "I think every video here should open on the loudest line"');
  expect(rule).not.toContain('"every video"');
  expect(rule).toContain("end your reply with one short question naming it");
  expect(DRAFT_RULE).toContain("a thought or liking said in passing however general) goes into your draft");
  expect(DRAFT_RULE).toContain("Only what they plainly tell you to keep is kept at once");
});

test("a day's drafting on an untaught channel becomes its first teaching, word for word, when the person says to teach it", async () => {
  const { app, cleanup } = fixtureHome("draft-teach");
  try {
    const id = await channelProject(app, "draft-ch");
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.draft-ch"]);
    v2cloud.useSkillsForTests([GLOBAL]);
    const dir = effects.folder(app.store, id, "blur-bars");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>bars</p>");
    // The agent tells the person nothing is taught, and how the draft works.
    const told = agentInstructions(app.store.get(id)!.project);
    expect(told).toContain("YOUR TEACHING DRAFT");
    expect(told).toContain("Teach everything we talked about");
    const hooks = "Open on the loudest line of the footage, never on a title card.";
    const drafted = await call(app, id, "draft_teaching", {
      lessons: [
        { name: "hooks", text: hooks, said: "Sphe: open on the loudest line" },
        { name: "short-titles", lane: "script", text: "Titles under six words.", said: "Sphe: keep titles short" },
      ],
      effects: [{ name: "blur-bars", as: "shorts-blur-bars", category: "blur", note: "Blurred bars above and below a Short.", brief: "Bar height at the top.", said: "Sphe: that blur is it" }],
    });
    expect(drafted.isError).toBe(false);
    expect(drafted.text).toContain("The draft holds 2 lessons and 1 effect");
    // Kept with the project, never in the channel yet.
    expect(fs.existsSync(draft.pathOf(app.store, id))).toBe(true);
    expect(mock.cloud.convex.library.has("skill:@draft-ch--edit/hooks")).toBe(false);
    // Asked at the end of the turn: marked, and shown so with the next message, which carries the draft.
    await call(app, id, "draft_teaching", { asked: ["hooks"] });
    const context = await messageContext(app, id, null, false);
    expect(context).toContain("YOUR TEACHING DRAFT, unseen by the person");
    expect(context).toContain(`- lesson hooks [edit; asked]: ${hooks}`);
    expect(context).toContain("- lesson short-titles [script]: Titles under six words.");
    expect(context).toContain("- effect blur-bars (kept as shorts-blur-bars) [blur]");
    // "Teach everything we talked about": all of it, through the tools a kept one takes, word for word.
    const taught = await call(app, id, "teach_drafted", {});
    expect(taught.isError).toBe(false);
    expect(taught.text).toContain("Remembered as hooks");
    expect(taught.text).toContain("Kept as short-titles");
    expect(taught.text).toContain("shorts-blur-bars is version 1");
    expect(mock.cloud.convex.libraryVersions.get("skill:@draft-ch--edit/hooks")?.[0]).toMatchObject({ text: hooks, reason: "Sphe: open on the loudest line" });
    expect(mock.cloud.convex.libraryVersions.get("skill:@draft-ch--script/short-titles")?.[0]).toMatchObject({ text: "Titles under six words." });
    expect(mock.cloud.convex.library.has("template:@draft-ch--edit/shorts-blur-bars")).toBe(true);
    // Moved, so gone from the draft, and nothing more rides the messages.
    expect(draft.read(app.store, id)).toMatchObject({ lessons: [], effects: [] });
    expect(await messageContext(app, id, null, false)).not.toContain("TEACHING DRAFT");
  } finally {
    cleanup();
  }
});

test("the draft: a no drops one, what's taught already isn't drafted, a clash stays with why, a non-teacher can't teach it, and a project with no channel has none", async () => {
  const { app, cleanup } = fixtureHome("draft-rules");
  try {
    const id = await channelProject(app, "rules-ch");
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.rules-ch"]);
    v2cloud.useSkillsForTests([GLOBAL, { name: "pins", text: "Pins are red.", key: v2cloud.ownKey("skill", v2cloud.laneKey("rules-ch", "edit"), "pins") }]);
    expect((await call(app, id, "draft_teaching", { lessons: [{ name: "pins", text: "Pins are red.", said: "Sphe" }] })).text).toContain("pins is taught already, word for word: not drafted");
    await call(app, id, "draft_teaching", { lessons: [{ name: "pace", text: "Cut every two seconds.", said: "JJ" }, { name: "zooms", text: "Slow zooms on faces.", said: "JJ" }] });
    // The same name changes it; a no drops it.
    await call(app, id, "draft_teaching", { lessons: [{ name: "pace", text: "Cut every three seconds.", said: "JJ, later" }] });
    expect(draft.read(app.store, id).lessons.find((one) => one.name === "pace")?.text).toBe("Cut every three seconds.");
    expect((await call(app, id, "draft_teaching", { drop: ["zooms"] })).text).toContain("dropped zooms");
    expect((await call(app, id, "draft_teaching", { drop: ["nothing-here"] })).text).toContain("there's no nothing-here in the draft");
    // A lesson too long for its kind, or a transcript, is refused at once (it must move as it is).
    expect((await call(app, id, "draft_teaching", { lessons: [{ name: "long", text: "x".repeat(401), said: "JJ" }] })).text).toContain("at most 400 characters");
    // Not a teacher: nothing is taught, the draft stays.
    accounts.signedInForTests(["edit.bodycam", "channel.rules-ch"]);
    expect((await call(app, id, "teach_drafted", {})).text).toContain("a teacher's to do");
    expect(draft.read(app.store, id).lessons.map((one) => one.name)).toEqual(["pace"]);
    // A clash with what's taught: left in the draft with why.
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.rules-ch"]);
    teachingConflicts.hooks.ask = async () => ({ conflicts: [{ skill: "pins", line: "Pins are red.", why: "says otherwise" }] });
    const clashed = await call(app, id, "teach_drafted", { names: ["pace"] });
    teachingConflicts.hooks.ask = async () => ({ conflicts: [] });
    expect(clashed.text).toContain("Left in the draft:\n- pace:");
    expect(draft.read(app.store, id).lessons.map((one) => one.name)).toEqual(["pace"]);
    // No channel: nothing drafted.
    const none = await channelProject(app, null);
    expect((await call(app, none, "draft_teaching", { lessons: [{ name: "x", text: "y", said: "z" }] })).text).toContain("isn't a channel's");
  } finally {
    cleanup();
  }
});

test("the draft is kept with the project: read back after a restart, and the cloud's newer copy taken when the project comes to another computer", async () => {
  const { app, cleanup } = fixtureHome("draft-sync");
  try {
    const id = await channelProject(app, "sync-ch");
    const lesson: draft.Lesson = { name: "pace", lane: "edit", text: "Cut every two seconds.", said: "JJ", at: 1 };
    draft.write(app.store, id, { savedAt: 0, lessons: [lesson], effects: [] });
    expect(draft.read(app.store, id).lessons).toEqual([lesson]);
    // Another computer's, newer, in the cloud: taken; an older one isn't.
    const theirs = join(app.store.home, "theirs.json");
    fs.writeFileSync(theirs, JSON.stringify({ savedAt: Date.now() + 60_000, lessons: [{ ...lesson, text: "Cut every three seconds." }], effects: [] }));
    await cloud.uploadFile(theirs, draft.draftKey(id));
    expect(await draft.pull(app.store, id)).toBe(true);
    expect(draft.read(app.store, id).lessons[0]!.text).toBe("Cut every three seconds.");
    fs.writeFileSync(theirs, JSON.stringify({ savedAt: 5, lessons: [], effects: [] }));
    await cloud.uploadFile(theirs, draft.draftKey(id));
    expect(await draft.pull(app.store, id)).toBe(false);
    expect(draft.read(app.store, id).lessons).toHaveLength(1);
  } finally {
    cleanup();
  }
});
