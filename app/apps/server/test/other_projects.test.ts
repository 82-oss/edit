// other_projects (JJ, Nov 24: "do the same as I just told you to do for this
// other script", "do it in the same way as we just did with XYZ edit"): both
// agents find another project by what the person calls it and read back what
// they asked for there, never Edit's own messages, and never the asking one.

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import type { ChatTurn, Script } from "@edit/types/writer";

import * as accounts from "../src/accounts.ts";
import { dispatch, TOOLS } from "../src/mcp/index.ts";
import * as otherProjects from "../src/other_projects.ts";
import * as reviewGuard from "../src/review_guard.ts";
import * as writerStore from "../src/writer/store.ts";
import * as turnTools from "../src/writer/turn_tools.ts";
import { fixtureHome } from "./helpers/home.ts";

const SIZE = { width: 1920, height: 1080, fps: 30 };
const KIMBERLY = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const TROOPER = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const FOIA = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";

function script(id: string, title: string, updatedAt: number): Script {
  // Longer than a clip's first and last words: its middle is read too.
  const said = "Where were you on the night of March the third when the store on Main Street was robbed? Home.".split(" ");
  return {
    id, title, sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 20_000, revision: 1, createdAt: 0, updatedAt, overview: [], proxyPath: null,
    words: said.map((text, index) => ({ id: `w${index}`, text, startMs: index * 1_000, endMs: index * 1_000 + 500 })),
    clips: [
      { id: "n1", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "She said she was home." },
      { id: "c1", startMs: 0, endMs: 19_900 },
    ],
  };
}

function putScript(home: string, given: Script, chat: ChatTurn[] = [], test = false): void {
  const dir = writerStore.scriptDir(writerStore.dataDir(home), given.id);
  fs.mkdirSync(dir, { recursive: true });
  writerStore.write(dir, given);
  if (chat.length > 0) fs.writeFileSync(`${dir}/chat.json`, JSON.stringify(chat));
  if (test) writerStore.writeTest(dir, true);
}

test("a name finds the project it means; the kind said breaks a tie between a script and its edit", () => {
  const given: otherProjects.Other[] = [
    { kind: "edit", id: "p1", title: "Kimberly Kessler Interrogation", channel: null, updatedAt: 3 },
    { kind: "script", id: "s1", title: "Kimberly Kessler Interrogation", channel: null, updatedAt: 2 },
    { kind: "edit", id: "p2", title: "Trooper Stops Wrong Car", channel: null, updatedAt: 1 },
  ];
  expect(otherProjects.match(given, "the Kimberly script").picked?.id).toBe("s1");
  expect(otherProjects.match(given, "the Kimberly edit").picked?.id).toBe("p1");
  expect(otherProjects.match(given, "trooper").picked?.id).toBe("p2");
  // A script and its edit by name alone: both offered, neither picked.
  const both = otherProjects.match(given, "Kimberly Kessler");
  expect(both.picked).toBeNull();
  expect(both.candidates.map((one) => one.id)).toEqual(["p1", "s1"]);
  expect(otherProjects.match(given, "the bank robbery").candidates).toEqual([]);
  // A possessive or a plural still matches its word; fillers don't count.
  expect(otherProjects.score("Kimberly's", "Kimberly Kessler")).toBe(1);
  expect(otherProjects.score("the same as that one", "Anything")).toBe(0);
});

test("the edit's agent reads another edit's chat, the person's words only, and is pointed at its clips", async () => {
  const { app, store, cleanup } = fixtureHome("other-edit");
  try {
    const own = store.create("Today's Case", SIZE).project.id;
    const other = store.create("Trooper Stops Wrong Car", SIZE).project.id;
    fs.writeFileSync(
      store.chatPath(other),
      JSON.stringify({
        entries: [
          { id: "1", kind: "user", text: "Put the map before every new location, and no zooms on faces.", at: Date.UTC(2026, 10, 23), updated: 0 },
          { id: "2", kind: "tool", text: "apply_edit_plan", at: 0, updated: 0 },
          { id: "3", kind: "assistant", text: "Done: a map before each of the 4 locations, and the face zooms are gone.", at: 0, updated: 0 },
          { id: "4", kind: "user", text: "(Edit, automatically) Edit restarted while you were working.", at: 0, updated: 0 },
          { id: "5", kind: "user", by: "edit", text: "The footage finished importing.", at: 0, updated: 0 },
          // Edit's message's answer is no answer to the person's.
          { id: "6", kind: "assistant", text: "Placed the new footage after the intro.", at: 0, updated: 0 },
        ],
      }),
    );
    const call = async (args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "other_projects", arguments: args } }, own)) as { result: { content: { text: string }[]; isError: boolean } }).result;
    const read = await call({ name: "the trooper edit" });
    expect(read.isError).toBe(false);
    const said = read.content[0]!.text;
    expect(said).toContain('EDIT "Trooper Stops Wrong Car"');
    expect(said).toContain("[2026-11-23] The person: Put the map before every new location, and no zooms on faces.");
    expect(said).toContain("The agent: Done: a map before each of the 4 locations");
    expect(said).not.toContain("restarted");
    expect(said).not.toContain("finished importing");
    expect(said).not.toContain("Placed the new footage");
    expect(said).toContain(`get_edit_context with project_id "${other}"`);
    // Its own project is never offered; nothing named lists the rest.
    expect((await call({ name: "today's case" })).content[0]!.text).toContain("No project here is called anything like");
    const recent = (await call({})).content[0]!.text;
    expect(recent).toContain(`id ${other}`);
    expect(recent).not.toContain(`id ${own}`);
    // A review-link turn can't reach other projects.
    expect(reviewGuard.BLOCKED.has("other_projects")).toBe(true);
    // The declaration both agents give is the same.
    expect(TOOLS.find((tool) => tool.name === "other_projects")?.description).toBe(otherProjects.DESCRIPTION);
  } finally {
    cleanup();
  }
});

test("the script's agent reads another script: the producer's asks, the answers that didn't fail, and the script itself", async () => {
  const { app, home, cleanup } = fixtureHome("other-script");
  try {
    putScript(home, script(TROOPER, "Trooper Stops Wrong Car", 1));
    putScript(home, script(KIMBERLY, "Kimberly Kessler Interrogation", 2), [
      { role: "producer", text: "Open on her lie, and keep every cut-in under 40 words.", at: Date.UTC(2026, 10, 24) },
      { role: "editor", text: "Claude hit an error.", at: 0, failed: true },
      { role: "editor", text: "Moved her lie to the top; every cut-in is now under 40 words.", at: 0 },
    ]);
    const [token] = turnTools.open(writerStore.dataDir(home), TROOPER);
    const listed = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, app)) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toContain("other_projects");
    const called = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "other_projects", arguments: { name: "the Kimberly script" } } }, app)) as { result: { content: { text: string }[]; isError?: boolean } };
    const said = called.result.content[0]!.text;
    expect(said).toContain('SCRIPT "Kimberly Kessler Interrogation"');
    expect(said).toContain("The person: Open on her lie, and keep every cut-in under 40 words.");
    expect(said).toContain("The agent: Moved her lie to the top");
    expect(said).not.toContain("hit an error");
    expect(said).toContain('cut-in (');
    expect(said).toContain('"She said she was home."');
    // The script's agent can't read an edit's clips: it isn't told to.
    expect(said).not.toContain("get_edit_context");
    // Every word of a clip, its middle too.
    expect(said).toContain("the third when the store");
    // Having read another project, the turn doesn't take the review's notes as well.
    const notes = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pull_feedback", arguments: {} } }, app)) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(notes.result.isError).toBe(true);
    expect(notes.result.content[0]!.text).toContain("This turn read another project");
    turnTools.close(token);
    // Nor the other way round: notes first, then no other project.
    const [second] = turnTools.open(writerStore.dataDir(home), TROOPER);
    await turnTools.answerTo(second, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pull_feedback", arguments: {} } }, app);
    const after = (await turnTools.answerTo(second, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "other_projects", arguments: { name: "kimberly" } } }, app)) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(after.result.isError).toBe(true);
    expect(after.result.content[0]!.text).toContain("works on this script alone");
    turnTools.close(second);
  } finally {
    cleanup();
  }
});

test("a turn fixing a review's notes has no other_projects, and a hidden test project is offered only to a test", async () => {
  const { app, home, store, cleanup } = fixtureHome("other-guard");
  try {
    putScript(home, script(TROOPER, "Trooper Stops Wrong Car", 1));
    putScript(home, script(KIMBERLY, "Kimberly Kessler Interrogation", 2), [], true);
    const [token] = turnTools.open(writerStore.dataDir(home), TROOPER, ["note-1"]);
    const listed = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, app)) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).not.toContain("other_projects");
    const refused = (await turnTools.answerTo(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "other_projects", arguments: {} } }, app)) as { result: { isError: boolean } };
    expect(refused.result.isError).toBe(true);
    turnTools.close(token);
    // The hidden test script: not offered to a person's script, offered to a test one, and readable by id.
    expect(otherProjects.answer(store, { name: "kimberly" }, TROOPER, "script")).toContain("No project here is called anything like");
    const test = store.createAs("Test Edit", "bodycam", SIZE, false, true).project.id;
    expect(otherProjects.answer(store, { name: "kimberly" }, test, "edit")).toContain('SCRIPT "Kimberly Kessler Interrogation"');
    expect(otherProjects.answer(store, { id: KIMBERLY }, TROOPER, "script")).toContain('SCRIPT "Kimberly Kessler Interrogation"');
    // A script of a kind the signed-in person can't write isn't offered or read, by name or by id (writer/can.ts).
    putScript(home, { ...script(FOIA, "Kimberly Bodycam", 3), kind: "foia" });
    accounts.signedInForTests(["scripts.interrogation"]);
    try {
      expect(otherProjects.answer(store, { name: "kimberly bodycam" }, TROOPER, "script")).toContain("No project here is called anything like");
      expect(() => otherProjects.answer(store, { id: FOIA }, TROOPER, "script")).toThrow("No other project here has id");
    } finally {
      accounts.resetForTests();
    }
    // Only which kind: the most recent of that kind (the test edit hidden from a person's script).
    expect(otherProjects.answer(store, { name: "the last edit" }, TROOPER, "script")).toBe("There are no other edits on this computer.");
    expect(otherProjects.answer(store, { name: "the last script" }, test, "edit")).toContain(`script "Kimberly Kessler Interrogation"`);
  } finally {
    cleanup();
  }
});
