// A commentary written on a channel (Nov 21: commentary's home is the
// InternetJanitor channel) is written as the channel's other scripts are, from
// its Script lane alone (formats.ts `taught`): not the house's guide, nor the
// lessons its reviews kept; with nothing taught it waits to be told how. One
// with no channel reads exactly what it read before.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import * as v2cloud from "../../src/v2_cloud.ts";
import { GUIDE, reviseSystem, writerSystem } from "../../src/writer/commentary.ts";
import { waitsForTeaching } from "../../src/writer/routes.ts";
import { UNREAD, UNTAUGHT } from "../../src/writer/scripting.ts";
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

afterEach(() => v2cloud.useSkillsForTests([]));

const CHANNEL = "ch-internetjanitor";
const LANE = "Write as the Janitor: dry, exact, never a sneer.";
const taught = () => v2cloud.useSkillsForTests([{ name: "voice", text: LANE, key: v2cloud.ownKey("skill", v2cloud.laneKey(CHANNEL, "script"), "voice") }]);
const LESSONS = "## Keep the intro short\nUnder a minute.";

function essay(channel?: string): Script {
  return {
    id: "c1", title: "Why He's Hated", sourceKind: "commentary", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 0, words: [], clips: [], overview: [], kind: "interrogation",
    commentary: { pacing: "channel", sources: [] }, revision: 0, createdAt: 0, updatedAt: 0, proxyPath: null, ...(channel === undefined ? {} : { channel }),
  } as Script;
}

test("on a taught channel the writer is given the channel's Script lane, and neither the house's guide nor its review lessons", async () => {
  taught();
  for (const prompt of [await writerSystem(essay(CHANNEL), { lessons: LESSONS, extra: "" }), await reviseSystem(essay(CHANNEL), LESSONS, false), await reviseSystem(essay(CHANNEL), LESSONS, true)]) {
    expect(prompt).toContain(LANE);
    expect(prompt).toContain("everything this channel's scripts are made from");
    expect(prompt).not.toContain("COMMENTARY GUIDE");
    expect(prompt).not.toContain(GUIDE.trim().slice(0, 200));
    expect(prompt).not.toContain("LESSONS FROM PAST REVIEWS");
    expect(prompt).not.toContain("where it differs from the guide above");
    // How a commentary is written stays the writer's: the plan's shape, the pacing.
    expect(prompt).toContain("The answer:\n- open:");
    expect(prompt).toContain("CHANNEL PACING");
  }
  // A lesson under test still comes (feedback.ts's rounds).
  expect(await writerSystem(essay(CHANNEL), { lessons: "", extra: "A LESSON UNDER TEST" })).toContain("A LESSON UNDER TEST");
});

test("with no channel the writer reads the house's guide and the review lessons, as it always has", async () => {
  taught();
  const prompt = await writerSystem(essay(), { lessons: LESSONS, extra: "" });
  expect(prompt).toContain(`Working title: Why He's Hated\n\nCOMMENTARY GUIDE\n${GUIDE}\n\nCHANNEL PACING`);
  expect(prompt).toEndWith(`\n\nLESSONS FROM PAST REVIEWS (follow them as you follow the guide)\n${LESSONS}`);
  expect(prompt).not.toContain(LANE);
  const revise = await reviseSystem(essay(), LESSONS, false);
  expect(revise).toContain(`COMMENTARY GUIDE\n${GUIDE}`);
  expect(revise).toContain(`LESSONS FROM PAST REVIEWS (follow them as you follow the guide)\n${LESSONS}\n\nTHIS TURN IS A REVISION`);
});

test("a channel's commentary taught nothing waits to be told how, as the channel's footage scripts do; none with no channel", async () => {
  v2cloud.useSkillsForTests([]);
  expect(await waitsForTeaching(essay(CHANNEL), "")).toBe(UNTAUGHT);
  expect(await waitsForTeaching(essay(CHANNEL), "Open on the lawsuit.")).toBeNull();
  expect(await waitsForTeaching(essay(), "")).toBeNull();
  taught();
  expect(await waitsForTeaching(essay(CHANNEL), "")).toBeNull();
  v2cloud.useSkillsForTests([], [], false);
  expect(await waitsForTeaching(essay(CHANNEL), "")).toBe(UNREAD);
});
