// A channel's agents don't edit until the channel is taught (teaching_gate.ts;
// Sphe, Nov 16): the tools that change the edit refuse in a line, teaching,
// reading and research work, and an unread or failed read never refuses.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import * as accounts from "../src/accounts.ts";
import { registerChannelTools } from "../src/channel_tools.ts";
import * as cloud from "../src/cloud.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { TOOLS } from "../src/mcp/registry.ts";
import { REFUSAL, WHILE_UNTAUGHT } from "../src/teaching_gate.ts";
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

async function call(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, args: Record<string, unknown>) {
  const answer = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } };
  return answer.result.content[0]?.text ?? "";
}

test("every tool allowed while a channel is untaught is one of Edit's", () => {
  for (const name of WHILE_UNTAUGHT) expect(TOOLS.some((tool) => tool.name === name)).toBe(true);
});

test("a channel not taught yet: the edit's tools refuse in a line, reading and teaching work, and once it's taught they work", async () => {
  const { app, cleanup } = fixtureHome("gate-untaught");
  try {
    const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "gate-ch";
    });
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.gate-ch"]);
    v2cloud.useSkillsForTests([{ name: v2cloud.GLOBAL, text: "Edit's own workings.", key: v2cloud.skillKey(v2cloud.GLOBAL) }]);
    const clip = { track: 0, start: 0, duration: 30, kind: "solid", color: "#ff0000" };
    expect(await call(app, id, "add_clip", clip)).toBe(REFUSAL);
    expect(await call(app, id, "delete_clips", { ids: ["c1"] })).toBe(REFUSAL);
    expect(await call(app, id, "batch", { calls: [{ tool: "add_clip", args: clip }] })).toContain("isn't taught yet");
    // Reading works.
    expect(await call(app, id, "get_edit_context", {})).not.toBe(REFUSAL);
    // Teaching works, and the edit's tools work from the next call.
    expect(await call(app, id, "remember", { skill: "pins", text: "Pins are red.", reason: "Sphe said so" })).toContain("Remembered as pins");
    expect(await call(app, id, "add_clip", clip)).not.toBe(REFUSAL);
  } finally {
    cleanup();
  }
});

test("never refused when what's taught isn't known, nor for a V1 project or a V2 one without a channel", async () => {
  const { app, cleanup } = fixtureHome("gate-unknown");
  try {
    const channel = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(channel, "test", (project) => {
      project.hq = true;
      project.channel = "gate-ch";
    });
    const none = app.store.create("No channel", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(none, "test", (project) => {
      project.hq = true;
    });
    const v1 = app.store.create("V1", { width: 1920, height: 1080, fps: 30 }).project.id;
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.gate-ch"]);
    const clip = { track: 0, start: 0, duration: 30, kind: "solid", color: "#ff0000" };
    // Read and empty: only the channel's project waits.
    v2cloud.useSkillsForTests([]);
    expect(await call(app, none, "add_clip", clip)).not.toBe(REFUSAL);
    expect(await call(app, v1, "add_clip", clip)).not.toBe(REFUSAL);
    expect(await call(app, channel, "add_clip", clip)).toBe(REFUSAL);
    // Not read (Edit just started, or the read failed): it isn't taken for untaught.
    v2cloud.useSkillsForTests([], [], false);
    expect(await call(app, channel, "add_clip", clip)).not.toBe(REFUSAL);
  } finally {
    cleanup();
  }
});
