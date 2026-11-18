// A channel's script (Edit V2) is written only from what the channel was
// taught (formats.ts `taught`; Sphe, Nov 18): none of the house's guides or
// checks, never a kind picked from its narration, and with nothing taught it
// builds only once someone says what to write.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import type { Script, Word } from "@edit/types/writer";

import * as accounts from "../../src/accounts.ts";
import * as lanes from "../../src/lanes.ts";
import * as v2cloud from "../../src/v2_cloud.ts";
import { formatOf } from "../../src/writer/formats.ts";
import { heading } from "../../src/writer/pages.ts";
import { audit, compile, formatOfScript, purposes, systemPrompt } from "../../src/writer/plan.ts";
import { freshEyesRequest, needsTeaching, UNREAD, UNTAUGHT } from "../../src/writer/scripting.ts";
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

afterEach(() => {
  accounts.resetForTests();
  v2cloud.useSkillsForTests([]);
});

const CHANNEL = "ch-taught";
const lesson = (name: string, text: string, note?: string): v2cloud.Skill => ({ name, text, key: v2cloud.ownKey("skill", v2cloud.laneKey(CHANNEL, "script"), name), ...(note === undefined ? {} : { note }) });

function script(channel?: string): Script {
  const words: Word[] = Array.from({ length: 40 }, (_, index) => ({ id: `w${index}`, text: `word${index}.`, startMs: index * 1_000, endMs: index * 1_000 + 600, speaker: "a" }));
  return { id: "t1", title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 40_000, words, clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null, ...(channel === undefined ? {} : { channel }) };
}

test("a channel's script reads none of the house's guides, only how a plan is written and what the channel was taught, its parts whole", () => {
  v2cloud.useSkillsForTests([lesson("voice", "Narrate in the second person."), lesson("intro-guide", "Open on the confession, always.", "When writing the intro")]);
  const given = script(CHANNEL);
  const prompt = systemPrompt(given, formatOfScript(given));
  for (const house of ["PRODUCER'S CUT-IN GUIDE", "PRODUCER'S JUDGMENT CALLS", "WRITER'S HOUSE RULES", "INTERRO", "Editorial priority", "past tense", "em dash"]) expect(prompt).not.toContain(house);
  expect(prompt).toContain("there is no house style beside it");
  expect(prompt).toContain('"kind":"clip","firstWordId"');
  expect(prompt).toContain("everything this channel's scripts are made from");
  expect(prompt).toContain("Narrate in the second person.");
  // A part comes whole: Script mode's agents have no read_skill.
  expect(prompt).toContain("## intro-guide (When writing the intro)\nOpen on the confession, always.");
  expect(prompt).not.toContain("read_skill");
  // A script with no channel keeps the house's.
  const house = script();
  expect(systemPrompt(house, formatOfScript(house))).toContain("PRODUCER'S CUT-IN GUIDE");
});

test("a channel's kind is never its own: whatever it was stored as, it's written as the plain one", () => {
  expect(formatOf("foia", false, "Case", true).kind).toBe("interrogation");
  expect(formatOfScript({ ...script(CHANNEL), kind: "courtroom" }).taught).toBe(true);
  expect(formatOfScript({ ...script(CHANNEL), kind: "courtroom" }).kind).toBe("interrogation");
  expect(formatOfScript(script()).taught).toBe(false);
});

test("a channel's plan is checked for its shape alone: an em dash, an intro clip never replayed and no house flags pass", () => {
  const given = script(CHANNEL);
  const plan = {
    items: [
      { kind: "clip", firstWordId: "w0", lastWordId: "w2" },
      { kind: "cut-in", narration: "She said nothing — then everything." },
      { kind: "clip", firstWordId: "w10", lastWordId: "w14" },
      { kind: "cut-in", narration: "On the night it happened." },
      { kind: "clip", firstWordId: "w20", lastWordId: "w30" },
      { kind: "cut-in", narration: "In the end." },
    ],
    report: "Done.",
  };
  const done = compile(given, plan);
  expect(done.clips.filter((clip) => clip.kind === "cut-in").length).toBe(3);
  // Opens on an intro unless the plan says otherwise.
  expect(purposes(done.clips, formatOfScript(given), "two-split")).toEqual(["intro", "case-opening", "conclusion"]);
  expect(purposes(done.clips, formatOfScript(given), "one-run")).toEqual(["case-opening", "story-development", "conclusion"]);
  expect(audit({ ...given, clips: done.clips })).toEqual([]);
  // The same plan with no channel: the house refuses the em dash.
  expect(() => compile(script(), plan)).toThrow("em dash");
  // Its shape still holds: footage first, a cut-in last.
  expect(() => compile(given, { items: [{ kind: "cut-in", narration: "Hi." }, { kind: "clip", firstWordId: "w0", lastWordId: "w2" }], report: "" })).toThrow("starts with footage");
});

test("a channel's Doc has no house series, and its fresh read is against what it was taught", () => {
  expect(heading({ ...script(CHANNEL), kind: "foia" })).toBe("Case");
  expect(heading({ ...script(), kind: "foia" })).toBe("FOIA Case");
  expect(freshEyesRequest(false, true)).toContain("this channel has been taught");
  expect(freshEyesRequest(false, true)).not.toContain("three minutes");
});

test("a channel taught nothing builds only when told what to write; one whose lessons can't be read waits; any other builds", async () => {
  v2cloud.useSkillsForTests([]);
  expect(await needsTeaching(script(CHANNEL), "")).toBe(UNTAUGHT);
  expect(await needsTeaching(script(CHANNEL), "Write it as an interrogation case.")).toBeNull();
  expect(await needsTeaching(script(), "")).toBeNull();
  v2cloud.useSkillsForTests([lesson("voice", "Narrate plainly.")]);
  expect(await needsTeaching(script(CHANNEL), "")).toBeNull();
  v2cloud.useSkillsForTests([], [], false);
  expect(await needsTeaching(script(CHANNEL), "")).toBe(UNREAD);
});

test("a guide brought over whole is never written over by a short lesson of the same name", async () => {
  accounts.signedInForTests(["agent.teach", `channel.${CHANNEL}`]);
  v2cloud.useSkillsForTests([lesson("cut-in-guide", "x".repeat(5_000))]);
  await expect(lanes.keepLesson({ channel: CHANNEL, lane: "script" }, "cut-in-guide", "Shorter cut-ins.", "Sphe said so", "channel")).rejects.toThrow("brought over whole");
});
