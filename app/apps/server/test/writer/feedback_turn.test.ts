// The review's feedback as a tool of the script's chat (Sphe, Nov 20: "Do you
// see feedback?", "Can you please just apply the feedback?" should have the
// agent pull it, fix it all in one go, and be done): pull_feedback hands the
// notes on, and each is settled on the review by what the agent said of it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import { brief, feedbackOf, settle } from "../../src/writer/fixing.ts";
import type { Note } from "../../src/writer/reviews.ts";
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

function relay(): Call[] {
  const calls: Call[] = [];
  mock.on("POST", "/v1/cloud/writer/convex", (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    calls.push({ path, args });
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
    const replies = calls.filter((call) => call.path === "reviews:reply").map((call) => [call.args.noteId, call.args.text]);
    expect(replies).toEqual([
      ["c", "He was home: the transcript says so at 0:07."],
      ["d", "Edit didn't change the script for this note."],
    ]);
    expect(calls.filter((call) => call.path === "reviews:release").map((call) => call.args.noteIds)).toEqual([["d"]]);
    expect(done.lines.at(-1)).toBe("Left Jones's note open: Edit didn't change the script for this note.");
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
