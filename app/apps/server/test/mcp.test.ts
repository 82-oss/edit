import { expect, test } from "bun:test";

import { dispatch, HQ_TOOLS, NOT_IN_HQ, INSTRUCTIONS, registerTool, targetProject, text, toolReference, TOOLS, toolsFor } from "../src/mcp/index.ts";
import { handlerFor, unregisterTool, unregistered } from "../src/mcp/registry.ts";
import { stableStringify } from "../src/stable.ts";
import { fixtureHome } from "./helpers/home.ts";

test("a_scoped_chat_reads_another_project_but_never_edits_it_or_answers_for_it", () => {
  const own = "p1";
  expect(targetProject(own, null, "apply_edit_plan")).toBe(own);
  expect(targetProject(own, "p1", "apply_edit_plan")).toBe(own);
  expect(targetProject(own, "", "get_edit_context")).toBe(own);
  // Reading the reference edit reads the reference, not its own project.
  expect(targetProject(own, "p2", "get_edit_context")).toBe("p2");
  expect(targetProject(own, "p2", "get_project")).toBe("p2");
  let refused = "";
  try {
    targetProject(own, "p2", "apply_edit_plan");
  } catch (error) {
    refused = (error as Error).message;
  }
  expect(refused).toContain("p1");
  expect(refused).toContain("p2");
  // Unscoped (an outside MCP client): whatever it names.
  expect(targetProject(null, "p2", "delete_clips")).toBe("p2");
  expect(targetProject(null, null, "delete_clips")).toBeNull();
});

test("tool_reference_is_one_short_line_per_tool", () => {
  // What every chat is shown; an Edit V2 project's has the effects' three tools as well.
  const reference = toolReference(toolsFor(false));
  expect(reference.trimEnd().split("\n").length).toBe(TOOLS.length - HQ_TOOLS.length);
  expect(toolReference(toolsFor(true)).trimEnd().split("\n").length).toBe(TOOLS.length - NOT_IN_HQ.length);
  // Edit V2's own twelve (effects, sounds, V2's cloud), in its chat alone, whose prompt has none of the house's instructions;
  // start_removal's marks, unmark and blur mode (Nov 18: the agent's in and out points, the tracked blur) a few words more;
  // addons and set_addon (Nov 21: a channel's add-ons, set through the agent) a line each; note_lesson's line gone from
  // the house's list alone (Nov 21: the lessons inbox removed; V2's never had it), so the gap is that line wider;
  // remove_effect_files and save_to_library's also (Nov 22: a kept effect carries only what its page loads) a line more;
  // draft_teaching and teach_drafted (Nov 22: the hidden teaching draft) two lines.
  expect(toolReference(toolsFor(true)).length).toBeLessThan(reference.length + 3_450);
  expect(reference).toContain("- apply_edit_plan(base_rev: integer, operations: array, ");
  // Commentary's posts, video references and shot checks, Edit Script and the team's effects, came in Oct 26;
  // read_upload (any file dropped in, Oct 31) one short line more (note_lesson, the lessons inbox of Nov 1, came and went: Nov 21),
  // use_found's not_a_person flag (Nov 2: found pictures must name the case) a few words, pull_feedback
  // (Nov 2: "implement the new feedback" from the review) one short line, the sheets' detail (Nov 2: sheets sized
  // for the model's eyes) a few words on three tools, wait (Nov 2: background work waited for once) one line,
  // listen (Nov 2: what's heard over a stretch) another, report_problem (Nov 2: the agent files a bug) another,
  // import_link (Nov 11: a video linked in the person's message) another, contact_sheet's times (Nov 11: any moments side by side) a few words,
  // set_in_out and set_ranges (Nov 13: in and out points are a stretch marked to export) a few more,
  // add_subtitles' and repack_subtitles' burned_in (Nov 16: footage with its own subtitles burned in) a few more,
  // find_camera_time (Nov 17: a time on a bodycam's clock as the footage's seconds) one short line,
  // start_removal's marks and sections (Nov 18–19: the agent marks where their text is) a few words.
  expect(reference.length).toBeLessThan(22_700);
});

test("every tool takes project_id; the instructions list the skills", () => {
  // other_channels (Nov 14): a channel's agent reaching into another channel; find_camera_time (Nov 17); teach_removal and check_removal (Nov 17); start_removal (Nov 17);
  // addons and set_addon (Nov 21); note_lesson gone (Nov 21: Sphe, "completely remove the lessons inbox system"); remove_effect_files, draft_teaching and teach_drafted (Nov 22).
  expect(TOOLS.length).toBe(131);
  for (const tool of TOOLS) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties.project_id).toEqual({
      description: "Defaults to the project open in the UI.",
      type: "string",
    });
  }
  expect(INSTRUCTIONS.startsWith("Edit is a local video editor.")).toBe(true);
  expect(INSTRUCTIONS).toContain("- final-pass: The last review of a whole edit and the fixes it finds.");
  expect(unregistered()).not.toContain("list_projects");
});

test("JSON-RPC: initialize, ping, tools/list, notifications and unknown methods", async () => {
  const { app, cleanup } = fixtureHome("mcp-rpc");
  try {
    const init = (await dispatch(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, null)) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string; capabilities: unknown };
    };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("edit");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.result.instructions).toBe(INSTRUCTIONS);
    const old = (await dispatch(app, { id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, null)) as {
      result: { protocolVersion: string };
    };
    expect(old.result.protocolVersion).toBe("2025-06-18");
    expect(await dispatch(app, { id: "x", method: "ping" }, null)).toEqual({ jsonrpc: "2.0", id: "x", result: {} });
    expect(await dispatch(app, { method: "notifications/initialized" }, null)).toBeNull();
    expect(await dispatch(app, { id: 3, method: "resources/list" }, null)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "unknown method resources/list" },
    });
    const listed = (await dispatch(app, { id: 4, method: "tools/list" }, null)) as { result: { tools: unknown[] } };
    // The effects' tools are listed only to a chat in a project made the new way (test/effects.test.ts).
    expect(listed.result.tools).toEqual(toolsFor(false));
  } finally {
    cleanup();
  }
});

test("tools/call: the project preamble, errors as content, and registered handlers", async () => {
  const { app, store, cleanup } = fixtureHome("mcp-call");
  try {
    const call = async (name: string, args: Record<string, unknown> = {}, scope: string | null = null) =>
      (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, scope)) as {
        result: { content: { type: string; text: string }[]; isError: boolean };
      };
    // No projects yet: list_projects still answers; anything else says why.
    expect((await call("list_projects")).result).toEqual({ content: [{ type: "text", text: "[]" }], isError: false });
    expect((await call("get_edit_context")).result).toEqual({
      content: [{ type: "text", text: "no projects yet; create one in the UI first" }],
      isError: true,
    });
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    // A declared tool no package has registered yet says so (packages register theirs as they land).
    const waiting = unregistered()[0];
    if (waiting !== undefined) expect((await call(waiting)).result.content[0]!.text).toBe(`${waiting} is not available`);
    expect((await call("no_such_tool")).result.content[0]!.text).toBe("unknown tool no_such_tool");
    expect((await call("delete_clips", { project_id: "p2" }, id)).result.content[0]!.text).toBe(
      `this chat works on project ${id} only: delete_clips can't touch p2 (get_edit_context and get_project can read it)`,
    );
    // These tools' own handlers step aside while the test's stand in.
    const own = new Map(["markers", "tidy_tracks"].map((name) => [name, handlerFor(name)]));
    for (const name of own.keys()) unregisterTool(name);
    registerTool("markers", ({ projectId, args }) => text(stableStringify({ project: projectId, args })));
    try {
      expect((await call("markers", { b: 1, a: 2 })).result).toEqual({
        content: [{ type: "text", text: `{"args":{"a":2,"b":1},"project":"${id}"}` }],
        isError: false,
      });
      expect(() => registerTool("markers", () => [])).toThrow("tool markers is registered twice");
    } finally {
      unregisterTool("markers");
    }
    expect(() => registerTool("not_declared", () => [])).toThrow("tool not_declared isn't declared in tools.json");
    // A bug in a tool is reported as one, and the server carries on.
    registerTool("tidy_tracks", () => {
      const nothing = undefined as unknown as { here: string };
      return text(nothing.here);
    });
    try {
      const crashed = (await call("tidy_tracks")).result;
      expect(crashed.isError).toBe(true);
      expect(crashed.content[0]!.text).toMatch(/^tool tidy_tracks crashed \(.*\); this is a bug in Edit$/);
    } finally {
      unregisterTool("tidy_tracks");
      for (const [name, before] of own) {
        if (before !== undefined) registerTool(name, before.handler, { noProject: before.noProject });
      }
    }
  } finally {
    cleanup();
  }
});

test("stableStringify sorts keys at every depth, as serde_json's maps", () => {
  expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null }, "10": 0, "2": 0 })).toBe(
    '{"10":0,"2":0,"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
  );
  expect(stableStringify({ b: [], a: {} }, 2)).toBe('{\n  "a": {},\n  "b": []\n}');
  expect(stableStringify({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
});
