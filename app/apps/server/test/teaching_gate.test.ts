// A channel taught nothing yet (teaching_gate.ts): its import's first message
// waits (first_prompt.test.ts), and its agent's tools all work, so a person can
// build effects and cut there before teaching it (Sphe, Nov 22).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import { registerChannelTools } from "../src/channel_tools.ts";
import * as cloud from "../src/cloud.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { registerMediaTools } from "../src/media_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { agentInstructions } from "../src/agent.ts";
import { waiting } from "../src/teaching_gate.ts";
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
  registerMediaTools();
});

afterAll(() => {
  restore();
  mock.stop();
});

afterEach(() => {
  accounts.resetForTests();
  v2cloud.useSkillsForTests([]);
});

async function result(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, args: Record<string, unknown>) {
  return ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
}

test("a channel not taught yet: the agent's tools all work there (Sphe, Nov 22), and its instructions say nothing is taught", async () => {
  const { app, cleanup } = fixtureHome("gate-untaught");
  try {
    const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "gate-ch";
    });
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.gate-ch"]);
    v2cloud.useSkillsForTests([{ name: v2cloud.GLOBAL, text: "Edit's own workings.", key: v2cloud.skillKey(v2cloud.GLOBAL) }]);
    expect(waiting(app.store.get(id)!.project)).toBe(true);
    const clip = { type: "solid", start: 0, duration: 30, fill: [0, 0, 0, 1] };
    const added = await result(app, id, "add_clip", { clip });
    expect(added.isError).toBe(false);
    expect(app.store.get(id)!.project.clips).toHaveLength(1);
    const batch = await result(app, id, "batch", { calls: [{ tool: "add_clip", args: { clip: { ...clip, start: 30 } } }] });
    expect(batch.content[0]!.text).not.toContain("taught");
    expect(app.store.get(id)!.project.clips).toHaveLength(2);
    const ids = app.store.get(id)!.project.clips.map((one) => one.id);
    expect((await result(app, id, "delete_clips", { clip_ids: ids })).isError).toBe(false);
    expect(app.store.get(id)!.project.clips).toHaveLength(0);
    // Footage brought in by the agent, and a picture of it handed to an effect it's building (both refused before).
    const png = join(app.store.home, "still.png");
    await Bun.write(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==", "base64"));
    const imported = await result(app, id, "import_media", { paths: [png] });
    expect(imported.isError).toBe(false);
    const media = app.store.get(id)!.project.media[0]!;
    const picture = await result(app, id, "effect_picture", { name: "lower-third", media_id: media.id });
    expect(picture.isError).toBe(false);
    expect(picture.content[0]!.text).toContain("effects/lower-third/");
    // The agent is told plainly: nothing taught, no style to follow, nothing kept just to start.
    const told = agentInstructions(app.store.get(id)!.project);
    expect(told).toContain("THIS CHANNEL ISN'T TAUGHT YET");
    expect(told).toContain("Never keep a lesson or an effect only to get started");
    expect(told).not.toContain("change the edit refuse");
  } finally {
    cleanup();
  }
});
