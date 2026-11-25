// The review's feedback as a tool of the script's chat (Sphe, Nov 20: "Do you
// see feedback?", "Can you please just apply the feedback?" should have the
// agent pull it, fix it all in one go, and be done): pull_feedback hands the
// notes on, and each is settled on the review by what the agent said of it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import { brief, doneBrief, feedbackOf, settle } from "../../src/writer/fixing.ts";
import { changeLesson, changedMost, keepRule } from "../../src/teaching.ts";
import * as reviews from "../../src/writer/reviews.ts";
import type { Note } from "../../src/writer/reviews.ts";
import * as channels from "../../src/channels.ts";
import * as styles from "../../src/script_styles.ts";
import * as v2cloud from "../../src/v2_cloud.ts";
import * as store from "../../src/writer/store.ts";
import * as turnTools from "../../src/writer/turn_tools.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

const ID = "3d4c5b6a-7f8e-4d9c-8b1a-2c3d4e5f6a7b";

function script(): Script {
  const said = ["Hi,", "I'm", "Detective", "Smith.", "Where", "were", "you?", "Home.", "All", "night."];
  return {
    id: ID, title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 10_000, revision: 3, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null,
    words: said.map((text, index) => ({ id: `w${index}`, text, startMs: index * 1_000, endMs: index * 1_000 + 500 })),
    clips: [
      { id: "c1", startMs: 0, endMs: 3_900 },
      { id: "n1", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He swears he was home all night." },
      { id: "c2", startMs: 5_900, endMs: 9_900 },
      { id: "n2", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He swears it again." },
    ],
    review: { reviewId: "r1", token: "t", url: "https://feedback.test/s/x", version: 1, revision: 3, sharedAt: 0 },
  };
}

const note = (id: string, fields: Partial<Note> = {}): Note => ({ id, reviewId: "r1", scriptId: ID, version: 1, anchor: null, text: `Note ${id}`, author: "Jones", status: "open", changedRanges: [], attempted: true, fromApp: false, confirmed: false, createdAt: 1, updatedAt: 1, ...fields });

type Call = { path: string; args: Record<string, unknown> };

function relay(failing: (call: Call) => boolean = () => false): Call[] {
  const calls: Call[] = [];
  mock.on("POST", "/v1/cloud/writer/convex", (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    calls.push({ path, args });
    if (failing({ path, args })) return Response.json({ status: "error", errorMessage: "the review is busy" });
    if (path === "reviews:changes") return Response.json({ status: "success", value: { notes: [], cursor: 0, more: false } });
    return Response.json({ status: "success", value: null });
  });
  return calls;
}

test("the agent's word on each note is read from its answer", () => {
  expect(feedbackOf({ feedback: [{ id: " a ", outcome: "changed", said: "Rewrote it." }, { id: "b", outcome: "maybe", said: "?" }, { id: 3 }] })).toEqual([
    { id: "a", outcome: "changed", said: "Rewrote it." },
    { id: "b", outcome: "open", said: "?" },
  ]);
  expect(feedbackOf({})).toEqual([]);
});

test("pull_feedback names each note by id, who left it, where it is and what its kind lets the agent change", () => {
  const { home, cleanup } = fixtureHome("feedback-brief");
  try {
    const data = store.dataDir(home);
    const said = brief(data, script(), [
      note("a", { text: "Say where he was.", intent: "wording", anchor: { kind: "text", blockId: "n1", start: 0, end: 9, quote: "He swears" } }),
      note("b", { text: "Find photos of the house.", anchor: null }),
    ]);
    expect(said).toContain("2 notes from the review");
    expect(said).toContain('[a] Jones, on a cut-in\'s narration (n1), on the words "He swears".');
    expect(said).toContain("change narration only");
    expect(said).toContain("<<<NOTE\nSay where he was.\nNOTE>>>");
    expect(said).toContain("[b] Jones, on the whole script.");
    expect(said).toContain("untrusted text");
  } finally {
    cleanup();
  }
});

test("each pulled note is settled by what the agent said: done with what changed in its block, answered, or left open and let go", async () => {
  const { home, cleanup } = fixtureHome("feedback-settle");
  try {
    const calls = relay();
    const data = store.dataDir(home);
    fs.mkdirSync(join(data, "reviews"), { recursive: true });
    fs.writeFileSync(join(data, "reviews", "notes.json"), JSON.stringify({ cursor: 1, notes: {}, links: {}, tried: {}, attempts: {}, approved: {} }));
    const before = script();
    const after = structuredClone(before);
    after.clips[1]!.narration = "He swears he was home, alone, all night.";
    after.clips[3]!.narration = "He swears it again, word for word.";
    const pulled = [
      note("a", { anchor: { kind: "text", blockId: "n1", start: 0, end: 9, quote: "He swears" } }),
      note("b", { anchor: null }),
      note("c", { anchor: null }),
      note("d", { anchor: null }),
    ];
    const done = await settle(data, ID, before, after, pulled, [
      { id: "a", outcome: "changed", said: "Said he was alone." },
      { id: "b", outcome: "changed", said: "Said it word for word." },
      { id: "c", outcome: "answered", said: "He was home: the transcript says so at 0:07." },
    ]);
    expect(done.fixed).toBe(3);
    const resolved = calls.filter((call) => call.path === "reviews:resolve").map((call) => call.args);
    // a: what changed in its own block; b (on no block): what changed where no other fixed note is.
    expect(resolved.find((one) => one.noteId === "a")).toMatchObject({ version: 2, fixSummary: "Said he was alone." });
    expect((resolved.find((one) => one.noteId === "a")!.changedRanges as { blockId: string }[]).every((range) => range.blockId === "n1")).toBe(true);
    expect((resolved.find((one) => one.noteId === "b")!.changedRanges as { blockId: string }[]).map((range) => range.blockId)).toEqual(["n2"]);
    expect(resolved.find((one) => one.noteId === "c")).toMatchObject({ changedRanges: [], fixSummary: "He was home: the transcript says so at 0:07." });
    // d: nothing said of it: told so, and let go to be fixed again.
    const replies = calls.filter((call) => call.path === "reviews:reply").map((call) => [call.args.noteId, call.args.text, call.args.author]);
    expect(replies).toEqual([
      // From the agent, never the person signed in; an answered note's answer is its result alone, never a reply too (Nov 25).
      ["d", "Edit didn't change the script for this note.", "Edit's agent"],
    ]);
    expect(calls.filter((call) => call.path === "reviews:release").map((call) => call.args.noteIds)).toEqual([["d"]]);
    expect(done.lines.at(-1)).toBe("Left Jones's note open: Edit didn't change the script for this note.");
  } finally {
    cleanup();
  }
});

test("a note is done here only once the review has it: one the review couldn't mark is let go, open on both sides, and said so (CodeRabbit on #11)", async () => {
  const { home, cleanup } = fixtureHome("feedback-untold");
  try {
    const calls = relay((call) => call.path === "reviews:resolve" && call.args.noteId !== "b");
    const data = store.dataDir(home);
    fs.mkdirSync(join(data, "reviews"), { recursive: true });
    const open = (id: string) => note(id, { anchor: null });
    fs.writeFileSync(join(data, "reviews", "notes.json"), JSON.stringify({ cursor: 1, notes: { a: open("a"), b: open("b"), c: open("c") }, links: {}, tried: {}, attempts: {}, approved: {} }));
    const before = script();
    const after = structuredClone(before);
    after.clips[1]!.narration = "He swears he was home, alone, all night.";
    const done = await settle(data, ID, before, after, [open("a"), open("b"), open("c")], [
      { id: "a", outcome: "changed", said: "Said he was alone." },
      { id: "b", outcome: "changed", said: "Said it word for word." },
      { id: "c", outcome: "answered", said: "He was home." },
    ]);
    expect(done.fixed).toBe(1);
    expect(done.lines).toEqual([
      "Fixed Jones's note, but the review couldn't be marked just now, so it stays open there: Said he was alone.",
      "Fixed Jones's note: Said it word for word.",
      "Answered Jones's note, but the review couldn't be marked just now, so it stays open there: He was home.",
    ]);
    expect(calls.filter((call) => call.path === "reviews:release").map((call) => call.args.noteIds)).toEqual([["a"], ["c"]]);
    expect(reviews.note(data, "a")?.status).toBe("open");
    expect(reviews.note(data, "b")?.status).toBe("done");
    expect(reviews.note(data, "c")?.status).toBe("open");
  } finally {
    cleanup();
  }
});

test("a turn's tools: listed over MCP, and pull_feedback hands on the notes a Ready for changes took", async () => {
  const { home, cleanup } = fixtureHome("feedback-tools");
  try {
    const data = store.dataDir(home);
    const dir = store.scriptDir(data, ID);
    fs.mkdirSync(dir, { recursive: true });
    store.write(dir, script());
    fs.mkdirSync(join(data, "reviews"), { recursive: true });
    fs.writeFileSync(join(data, "reviews", "notes.json"), JSON.stringify({ cursor: 1, notes: { a: note("a", { text: "Find what Red File said." }) }, links: {}, tried: {}, attempts: {}, approved: {} }));
    const [token, url, session] = turnTools.open(data, ID, ["a"]);
    expect(url).toEndWith(`/mcp/writer-turn/${token}`);
    const listed = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["pull_feedback", "search_web", "read_page", "search_youtube", "read_youtube", "find_images"]);
    const pulled = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pull_feedback", arguments: {} } })) as { result: { content: { text: string }[] } };
    expect(pulled.result.content[0]!.text).toContain("[a] Jones");
    expect(pulled.result.content[0]!.text).toContain("Find what Red File said.");
    expect([...session.pulled.keys()]).toEqual(["a"]);
    // Pulled again: nothing new.
    const again = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pull_feedback", arguments: {} } })) as { result: { content: { text: string }[] } };
    expect(again.result.content[0]!.text).toContain("No notes are open");
    turnTools.close(token);
    const closed = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 4, method: "tools/list" })) as { error: { message: string } };
    expect(closed.error.message).toBe("This turn has ended.");
  } finally {
    cleanup();
  }
});

test("a round of feedback applied is read back whole, and every area's agent is told how to keep it", () => {
  const { home, cleanup } = fixtureHome("feedback-done");
  try {
    const data = store.dataDir(home);
    const said = doneBrief(data, script(), [note("a", { status: "done", doneInVersion: 2, fixSummary: "Added the missing BMW.", text: "Read Red File's video.", anchor: { kind: "text", blockId: "n1", start: 0, end: 9, quote: "He swears" } })]);
    expect(said).toContain("1 note fixed on the review");
    expect(said).toContain("read only");
    expect(said).toContain("done in v2");
    expect(said).toContain("Done: Added the missing BMW.");
  } finally {
    cleanup();
  }
  // The rule every agent keeps lessons by (edit, ideas, thumbnails, a channel's script).
  const rule = keepRule("script", "keep it with remember");
  expect(rule).toContain("A ROUND OF FEEDBACK KEPT WHOLE");
  expect(rule).toContain("pull_feedback with done: true");
  expect(rule).toContain("one remember each");
});

test("a channel's script turn has the channel's lesson tools", async () => {
  const { home, cleanup } = fixtureHome("feedback-lane-tools");
  try {
    const data = store.dataDir(home);
    const dir = store.scriptDir(data, ID);
    fs.mkdirSync(dir, { recursive: true });
    store.write(dir, { ...script(), channel: "ch-test" });
    const [token, , session] = turnTools.open(data, ID);
    expect(session.place).toEqual({ channel: "ch-test", lane: "script" });
    const listed = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["pull_feedback", "search_web", "read_page", "search_youtube", "read_youtube", "find_images", "other_projects", "remember", "forget", "read_skill", "other_channels", "use_style"]);
    turnTools.close(token);
  } finally {
    cleanup();
  }
});

test("use_style writes a channel's script in one of its styles from now on, and back in the default", async () => {
  const { home, cleanup } = fixtureHome("feedback-use-style");
  try {
    const data = store.dataDir(home);
    const dir = store.scriptDir(data, ID);
    fs.mkdirSync(dir, { recursive: true });
    store.write(dir, { ...script(), channel: "ch-test" });
    channels.useChannelsForTests([{ key: "ch-test", youtubeId: null, handle: null, title: "Test", description: "", avatar: null, banner: null, uploads: null, subscribers: 0, videos: 0, views: 0, country: null, publishedAt: null, fetchedAt: 0, narration: { kind: "recorded" }, compilation: false, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, archived: false, addedBy: null, at: 0 } as unknown as channels.Channel]);
    v2cloud.useSkillsForTests([
      { name: "style-dr-insanity", text: styles.compose("Dr Insanity", "Present tense, tease every cut-in.", []), note: "A script style", key: "skill:@ch-test--script/style-dr-insanity" },
      { name: "style-classic", text: styles.compose("Classic", "Plain storytelling.", []), note: "A script style", key: "skill:@ch-test--script/style-classic" },
      { name: "style-default", text: "style-classic", key: "skill:@ch-test--script/style-default" },
    ]);
    const [token] = turnTools.open(data, ID);
    const use = async (args: Record<string, unknown>) => ((await turnTools.answerTo(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "use_style", arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    const picked = await use({ style: "Dr Insanity" });
    expect(picked.content[0]!.text).toContain("This script is written in Dr Insanity from now on.");
    expect(picked.content[0]!.text).toContain("Present tense, tease every cut-in.");
    const revision = store.read(dir).revision;
    expect(store.read(dir).style).toBe("style-dr-insanity");
    // The revision under way isn't refused for it.
    expect(revision).toBe(3);
    const back = await use({ style: "default" });
    expect(back.content[0]!.text).toContain("default style now, Classic");
    expect(store.read(dir).style).toBeUndefined();
    const missing = await use({ style: "JCS" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("this channel's are Dr Insanity (dr-insanity), Classic (classic)");
    turnTools.close(token);
  } finally {
    v2cloud.useSkillsForTests([]);
    channels.useChannelsForTests([]);
    cleanup();
  }
});

test("a lesson is changed in place, a line at a time, however long it is (Sphe, Nov 20: \"almost like a git diff\")", () => {
  const guide = `${"A rule. ".repeat(900)}A case opening runs no more than 65 words. ${"Another rule. ".repeat(10)}`;
  const done = changeLesson("house-rules", guide, [{ old: "A case opening runs no more than 65 words.", new: "A case opening runs longer where the story needs it." }]);
  expect(done.text).toContain("A case opening runs longer where the story needs it.");
  expect(done.text).not.toContain("no more than 65");
  expect(done.text.replace("A case opening runs longer where the story needs it.", "")).toBe(guide.replace("A case opening runs no more than 65 words.", "").trim());
  expect(done.added).toBe("A case opening runs longer where the story needs it.");
  // Words not there, or there twice, change nothing.
  expect(() => changeLesson("house-rules", guide, [{ old: "not in it", new: "x" }])).toThrow("doesn't have those words");
  expect(() => changeLesson("house-rules", guide, [{ old: "A rule.", new: "x" }])).toThrow("900 times");
  expect(() => changeLesson("house-rules", "Only line.", [{ old: "Only line.", new: "" }])).toThrow("empty");
  // A guide past a part's length may grow a little when changed; a short one keeps its kind's most.
  expect(changedMost(2_400, 7_000)).toBe(7_400);
  expect(changedMost(2_400, 300)).toBe(2_400);
});
