import { expect, test } from "bun:test";

import * as firstPrompt from "../src/first_prompt.ts";
import type { ScriptJob } from "../src/model.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";

test("a new project's first message waits for its import, then goes to its agent once", async () => {
  const { app, cleanup } = fixtureHome("first-prompt");
  const live = app.store.createAs("Case", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const sent: string[] = [];
  let job: ScriptJob | null = { state: "downloading", files: [{ file: "f", bytes: 0, state: "downloading" }] };
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running: false }), send: async (_project: string, text: string) => void sent.push(text) };
  (app as unknown as { scripts: unknown }).scripts = { get: () => job, running: () => job !== null };
  try {
    firstPrompt.give(app, id, "start the editing workflow");
    await firstPrompt.sendReady(app);
    expect(sent).toEqual([]);
    expect(firstPrompt.waiting(app, id)).toBe("start the editing workflow");
    // The import is done: it goes, and only once.
    job = { ...job, state: "done" };
    await firstPrompt.sendReady(app);
    await firstPrompt.sendReady(app);
    expect(sent).toEqual(["start the editing workflow"]);
    expect(firstPrompt.waiting(app, id)).toBeNull();
  } finally {
    cleanup();
  }
});

test("a channel's project not taught yet keeps its first message, and it goes by itself once the channel is taught (Sphe, Nov 16)", async () => {
  const { app, cleanup } = fixtureHome("first-prompt-untaught");
  const before = process.env.EDIT_RELAY_TOKEN;
  // Edit's cloud on, with what's taught as read below (never asked of it here).
  process.env.EDIT_RELAY_TOKEN = "cloud-token";
  const live = app.store.createAs("Case", "bodycam", { width: 1920, height: 1080, fps: 30 }, true);
  const id = live.project.id;
  await app.store.update(id, "test", (project) => {
    project.channel = "held-ch";
  });
  const sent: string[] = [];
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running: false }), send: async (_project: string, text: string) => void sent.push(text) };
  (app as unknown as { scripts: unknown }).scripts = { get: () => ({ state: "done", files: [] }), running: () => false };
  try {
    v2cloud.useSkillsForTests([{ name: v2cloud.GLOBAL, text: "Edit's own workings.", key: v2cloud.skillKey(v2cloud.GLOBAL) }]);
    firstPrompt.give(app, id, "start the editing workflow");
    await firstPrompt.sendReady(app);
    await firstPrompt.sendReady(app);
    expect(sent).toEqual([]);
    expect(firstPrompt.waiting(app, id)).toBe("start the editing workflow");
    // Taught (a lesson in its edit lane): it goes, once.
    v2cloud.useSkillsForTests([{ name: "pins", text: "Pins are red.", key: v2cloud.ownKey("skill", v2cloud.laneKey("held-ch", "edit"), "pins") }]);
    await firstPrompt.sendReady(app);
    await firstPrompt.sendReady(app);
    expect(sent).toEqual(["start the editing workflow"]);
    expect(firstPrompt.waiting(app, id)).toBeNull();
  } finally {
    if (before === undefined) delete process.env.EDIT_RELAY_TOKEN;
    else process.env.EDIT_RELAY_TOKEN = before;
    v2cloud.useSkillsForTests([]);
    cleanup();
  }
});
