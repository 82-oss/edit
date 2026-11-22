// The add-on end-check, "Check when a turn ends" (end_check.ts; Sphe, Nov 21):
// on a channel that sets it, a turn of the person's that changed the edit is
// checked in the background with the chat's waiting line (background.ts, the
// same as removal's); nothing found, nothing is shown or said; something
// found, the agent is started once more with it, the prompt never in the chat
// (as the page is served it, and as it's kept and synced). Off everywhere else.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as addons from "../src/addons.ts";
import type { Agents } from "../src/agent.ts";
import type { App } from "../src/app.ts";
import { linesOf } from "../src/background.ts";
import { useChannelsForTests, type Channel } from "../src/channels.ts";
import type * as claude from "../src/claude.ts";
import { EDIT_EVENT } from "../src/edit_event.ts";
import * as endCheck from "../src/end_check.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

function channel(key: string): Channel {
  return {
    key, youtubeId: null, handle: null, title: key, description: "", avatar: null, banner: null, uploads: null,
    subscribers: null, videos: null, views: null, country: null, publishedAt: null, fetchedAt: 0, narration: { kind: "voice", id: "v", name: "Andrew" }, compilation: false,
    lanes: { ideas: "", thumbnails: "", script: "", edit: "" },
  } as Channel;
}

const place = v2cloud.laneKey("solo", "edit");
const TAUGHT: v2cloud.Skill[] = [{ name: "tone", text: "Calm.", key: v2cloud.ownKey("skill", place, "tone") }];
const ON: v2cloud.Skill = { name: addons.skillOf("end-check"), text: addons.write("end-check", true, {}), note: addons.noteOf("end-check"), key: v2cloud.ownKey("skill", place, addons.skillOf("end-check")), latest: 1 };

const saved = { ...endCheck.timing };
beforeAll(() => {
  useChannelsForTests([channel("solo")]);
});
afterEach(() => {
  endCheck.reset();
  Object.assign(endCheck.timing, saved);
  v2cloud.useSkillsForTests([]);
});
afterAll(() => useChannelsForTests([]));

/** A stand-in Claude Code: each turn's query, ended by the test. */
function fakeClaude(agents: Agents) {
  const asked: string[] = [];
  const ends: (() => void)[] = [];
  agents.findClaude = async () => "/test/claude";
  agents.listClaudeModels = async () => [];
  agents.claudeQuery = async (params) => {
    asked.push(typeof params.prompt === "string" ? params.prompt : "(pictures)");
    const queue: unknown[] = [{ type: "system", subtype: "init", session_id: "session-1" }];
    let wake: (() => void) | null = null;
    let ended = false;
    ends.push(() => {
      queue.push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Done." }] } });
      queue.push({ type: "result", subtype: "success", is_error: false, usage: {} });
      ended = true;
      wake?.();
    });
    async function* messages() {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    }
    return Object.assign(messages(), { interrupt: async () => undefined, close: () => {} }) as unknown as claude.Query;
  };
  return { asked, ends };
}

const until = async (what: () => boolean, ms = 3000) => {
  const by = Date.now() + ms;
  while (!what() && Date.now() < by) await Bun.sleep(5);
  return what();
};

/** A channel's Edit V2 project (or V1, `v2` false): a tape on the base track. */
async function project(app: App, v2 = true): Promise<string> {
  const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
  await app.store.update(id, "test", (p) => {
    if (v2) {
      p.hq = true;
      p.channel = "solo";
    }
    p.media.push(media({ id: "m1", name: "tape", path: "/nowhere/tape.mp4", kind: "video", duration: 120, width: 1920, height: 1080, fps: 30 }));
    p.clips.push(clip({ id: "base", type: "video", track: "v1", media: "m1", source_in: 0, start: 0, duration: 1800, name: "tape" }));
  });
  return id;
}

/** The agent's work in a turn: a B-roll shot of `seconds` over the tape (held past 4.5 s, the audit's long_broll_shot). */
const broll = (app: App, id: string, clipId: string, seconds: number, start = 300) =>
  app.store.update(id, "agent", (p) => {
    p.clips.push(clip({ id: clipId, type: "video", track: "v2", media: "m1", source_in: 30, start, duration: seconds * 30, name: "Cut-in 1 · B-roll: street" }));
  });

function setUp(name: string, on = true) {
  v2cloud.useSkillsForTests(on ? [...TAUGHT, ON] : TAUGHT);
  const fixture = fixtureHome(name);
  const agents = fixture.app.agents as Agents;
  const claude = fakeClaude(agents);
  endCheck.start(fixture.app);
  const router = buildRouter();
  const call = async (method: string, path: string) => {
    const response = (await respond(fixture.app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700" } }), null))!;
    return (await response.json()) as { lines: { key: string; label: string }[] };
  };
  /** A turn: sent, its work done, ended. */
  const turn = async (id: string, text: string, work: () => Promise<unknown> = async () => {}) => {
    await agents.send(id, text, null, null);
    await work();
    claude.ends.at(-1)!();
    await until(() => !agents.withChat(id).running);
  };
  return { ...fixture, agents, ...claude, call, turn };
}

/** What the page is served of the chat, and what's kept beside the project and synced to the team's cloud (chat_sync.ts uploads this file). */
const shown = (agents: Agents, app: App, id: string) => [JSON.stringify(agents.chat(id)), fs.readFileSync(app.store.chatPath(id), "utf8")];

describe("off unless a channel sets it", () => {
  test("not on any V1 style's list, nor a channel's with nothing set", () => {
    for (const style of ["bodycam", "interrogation", "courtroom", "commentary", "horror", "shorts"] as const) expect([style, addons.v1Of(style).includes("end-check")]).toEqual([style, false]);
    v2cloud.useSkillsForTests(TAUGHT);
    expect(addons.ofChannel("solo", "edit").find((one) => one.name === "end-check")).toEqual({ name: "end-check", on: false, from: "default", settings: {} });
  });

  test("a channel without it, and a V1 project: a turn that left a B-roll held too long starts nothing and shows nothing", async () => {
    const { app, agents, asked, turn, cleanup } = setUp("end-check-off", false);
    try {
      endCheck.timing.readsWithinMs = 0;
      for (const v2 of [true, false]) {
        const id = await project(app, v2);
        await turn(id, "Add B-roll over the start", () => broll(app, id, "b", 10));
        await Bun.sleep(300);
        expect(linesOf(app, id)).toEqual([]);
        expect(agents.withChat(id).running).toBe(false);
      }
      expect(asked).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

describe("on a channel that sets it", () => {
  test("a turn that changed nothing: no check, no line, no turn", async () => {
    const { app, asked, turn, cleanup } = setUp("end-check-nothing");
    try {
      const id = await project(app);
      await turn(id, "What's in the intro?");
      await Bun.sleep(300);
      expect(linesOf(app, id)).toEqual([]);
      expect(asked).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("a turn that changed the edit and left nothing wrong: the waiting line while its files are read, then nothing at all", async () => {
    const { app, agents, asked, call, turn, cleanup } = setUp("end-check-clean");
    try {
      // The tape is never read here, so the check waits on it the time it's given, then answers with what's read.
      Object.assign(endCheck.timing, { readEveryMs: 20, readsWithinMs: 600 });
      const id = await project(app);
      const entries = () => agents.withChat(id).entries.length;
      await turn(id, "Add a short B-roll shot", () => broll(app, id, "b", 3));
      const before = entries();
      expect(await until(() => linesOf(app, id).length > 0)).toBe(true);
      // As the page is served it (GET /background), removal's line beside it when there's one.
      const served = await call("GET", `/api/projects/${id}/background`);
      expect(served.lines.map((one) => [one.key, one.label])).toEqual([["end-check", "Checking the edit"]]);
      expect(linesOf(app, id)[0]).toMatchObject({ done: 0, total: 1, unit: "files read" });
      expect(await until(() => linesOf(app, id).length === 0)).toBe(true);
      await Bun.sleep(200);
      expect(asked).toHaveLength(1);
      // Nothing said: not a line of Edit's, not a turn.
      expect(entries()).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("a turn that left a B-roll held too long: exactly one turn, told what's wrong, its prompt nowhere in the chat; that turn's end checks nothing", async () => {
    const { app, agents, asked, ends, turn, cleanup } = setUp("end-check-found");
    try {
      endCheck.timing.readsWithinMs = 0;
      const id = await project(app);
      await turn(id, "Add B-roll over the start", () => broll(app, id, "b", 10));
      expect(await until(() => asked.length === 2)).toBe(true);
      const prompt = asked[1]!;
      expect(prompt).toStartWith(`${EDIT_EVENT} Your turn has ended, and Edit ran the edit's checks again where it changed`);
      expect(prompt).toContain('{"clip":"b","fix":"a new shot every ~3–4 s');
      expect(prompt).toContain('"kind":"long_broll_shot","seconds":10,"start":300}');
      expect(prompt).toContain("tell them in a line or two what you changed");
      // The page and the cloud's copy: Edit's mark for its own turn, never what it was told.
      for (const one of shown(agents, app, id)) {
        expect(one).not.toContain("long_broll_shot");
        expect(one).not.toContain("Your turn has ended");
      }
      const users = agents.withChat(id).entries.filter((one) => one.kind === "user");
      expect(users.map((one) => [one.text, one.by ?? null])).toEqual([["Add B-roll over the start", null], [EDIT_EVENT, "edit"]]);
      // The woken turn leaves another held too long: its end starts no second check.
      await broll(app, id, "b2", 9, 900);
      ends.at(-1)!();
      await until(() => !agents.withChat(id).running);
      await Bun.sleep(300);
      expect(asked).toHaveLength(2);
      expect(linesOf(app, id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("what's wrong with the whole edit (no place on the timeline) is told when the turn brought it, never when it was there before", async () => {
    const { app, asked, turn, cleanup } = setUp("end-check-whole");
    const audit = endCheck.hooks.audit;
    try {
      endCheck.timing.readsWithinMs = 0;
      // The edit as the turn began has none; as it ends, one with no place (and the audit's own, scoped as before).
      const underused = { kind: "windows_underused", screens: 1, at_least: 3, fix: "make a cut-in a Windows screen" };
      let had = false;
      endCheck.hooks.audit = ((app_: App, project: Parameters<typeof audit>[1], rev: number | null) => {
        const real = audit(app_, project, rev);
        const issues = (real.issues ?? []) as unknown[];
        return { ...real, issues: rev === null ? (had ? [underused] : issues) : [...issues, underused] };
      }) as typeof audit;
      const id = await project(app);
      await turn(id, "Add a short B-roll shot", () => broll(app, id, "b", 3));
      expect(await until(() => asked.length === 2)).toBe(true);
      expect(asked[1]).toContain('"kind":"windows_underused"');
      // There before the turn: not the turn's, so nothing is said.
      had = true;
      const other = await project(app);
      await turn(other, "Add a short B-roll shot", () => broll(app, other, "b", 3));
      await Bun.sleep(300);
      expect(asked).toHaveLength(3);
    } finally {
      endCheck.hooks.audit = audit;
      cleanup();
    }
  });

  test("Stop: the line goes and nobody is woken", async () => {
    const { app, agents, asked, call, turn, cleanup } = setUp("end-check-stop");
    try {
      Object.assign(endCheck.timing, { readEveryMs: 20, readsWithinMs: 400 });
      const id = await project(app);
      await turn(id, "Add B-roll over the start", () => broll(app, id, "b", 10));
      expect(await until(() => linesOf(app, id).length > 0)).toBe(true);
      expect((await call("POST", `/api/projects/${id}/background/end-check/stop`)).lines).toEqual([]);
      await Bun.sleep(700);
      expect(asked).toHaveLength(1);
      expect(agents.withChat(id).entries.filter((one) => one.kind === "user")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("a message of the person's while it checks goes first; its end checks again, the turn before it too", async () => {
    const { app, asked, turn, cleanup } = setUp("end-check-message");
    try {
      Object.assign(endCheck.timing, { readEveryMs: 20, readsWithinMs: 400 });
      const id = await project(app);
      await turn(id, "Add B-roll over the start", () => broll(app, id, "b", 10));
      expect(await until(() => linesOf(app, id).length > 0)).toBe(true);
      // Their next message, changing nothing itself: the check gives way at once.
      await turn(id, "And what's the title?", async () => expect(linesOf(app, id)).toEqual([]));
      expect(await until(() => asked.length === 3)).toBe(true);
      expect(asked[1]).toBe("And what's the title?");
      expect(asked[2]).toContain('"clip":"b"');
    } finally {
      cleanup();
    }
  });
});
