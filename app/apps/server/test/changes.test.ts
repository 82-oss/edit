// Every change kept so the agent can undo any of them (changes.ts): who made
// each, one undone alone, one refused where a later change touched the same
// thing, everything after a revision, an undo itself undone, and what's kept
// read back after a restart.

import { expect, test } from "bun:test";

import * as changes from "../src/changes.ts";
import { dispatch } from "../src/mcp/index.ts";
import { agentCalls } from "../src/store.ts";
import { fixtureHome } from "./helpers/home.ts";

async function call(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, args: Record<string, unknown>) {
  return ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
}

const solid = (id: string, start: number, opacity = 1) => ({ id, type: "solid", track: "v1", start, duration: 30, fill: [0, 0, 0, 1], opacity, color: "blue", fade_in: 0, fade_out: 0 }) as never;

test("the agent undoes any change: one alone, never over a later one to the same thing, back to a revision, and its own undo", async () => {
  const { app, cleanup } = fixtureHome("changes");
  try {
    changes.start(app);
    const id = app.store.create("Undo", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const rev = () => app.store.get(id)!.rev;
    const clips = () => app.store.get(id)!.project.clips.map((clip) => `${clip.id}:${(clip as { opacity?: number }).opacity}`).join(" ");
    // The agent adds c1 then c2 (in its tool calls); the person adds c3; the agent changes c1.
    const asAgent = <T>(tool: string, work: () => Promise<T>) => agentCalls.run({ active: true, tool }, work);
    await asAgent("add_clip", () => app.store.update(id, "agent", (project) => void project.clips.push(solid("c1", 0))));
    const afterC1 = rev();
    await asAgent("add_clip", () => app.store.update(id, "agent", (project) => void project.clips.push(solid("c2", 30))));
    const afterC2 = rev();
    await app.store.update(id, "ui-abc123", (project) => void project.clips.push(solid("c3", 60)));
    await asAgent("update_clip", () => app.store.update(id, "agent", (project) => void ((project.clips.find((one) => one.id === "c1") as unknown as { opacity: number }).opacity = 0.5)));
    const lastRev = rev();
    expect(clips()).toBe("c1:0.5 c2:1 c3:1");
    const listed = (await call(app, id, "edit_history", { count: 4 })).content[0]!.text!;
    expect(listed).toContain(`rev ${lastRev}`);
    expect(listed).toContain("you (update_clip)");
    expect(listed).toContain("the person: clips: 1 added or changed (c3)");
    // c2's adding alone: nothing since touched c2.
    expect((await call(app, id, "undo_changes", { revs: [afterC2] })).content[0]!.text).toContain(`Undone: rev ${afterC2}`);
    expect(clips()).toBe("c1:0.5 c3:1");
    // c1's adding alone: refused, its opacity was changed since.
    const refused = await call(app, id, "undo_changes", { revs: [afterC1] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain(`rev ${lastRev} (you) changed the same clips:c1`);
    // The undo itself undone: c2 back.
    const undoRev = rev();
    await call(app, id, "undo_changes", { revs: [undoRev] });
    expect(clips()).toBe("c1:0.5 c2:1 c3:1");
    // Back to just after c1 was added: c2, c3 and the change to c1 go.
    await call(app, id, "undo_changes", { back_to: afterC1 });
    expect(clips()).toBe("c1:1");
    // Kept on disk: read back after a restart.
    changes.forgetForTests();
    expect((await call(app, id, "edit_history", {})).content[0]!.text).toContain(`rev ${afterC1}`);
  } finally {
    cleanup();
  }
});

test("a version kept aside is listed with the changes and brought back as the edit, the project staying itself, and undone like any change", async () => {
  const { app, cleanup } = fixtureHome("changes-kept");
  try {
    changes.start(app);
    const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.clips.push(solid("ours", 0));
    });
    // This computer's version, overtaken (cloud_projects keepOurs), and an old "(conflicted copy)" folded in (old_copies).
    const ours = app.store.get(id)!.project;
    const overtaken = app.store.keepAside(id, ours);
    const copy = app.store.keepAside(id, { ...structuredClone(ours), id: "p1762500000000-7", name: "Case (conflicted copy)", clips: [solid("copy1", 0), solid("copy2", 30)] }, "p1762500000000-7");
    expect(app.store.keepAside(id, { ...structuredClone(ours), name: "again" }, "p1762500000000-7")).toBe(copy);
    expect(app.store.kept(id).map((one) => [one.name, one.why])).toEqual([["p1762500000000-7", "copy"], [overtaken, "overtaken"]]);
    // The cloud's version comes in over it.
    await app.store.update(id, "cloud", (project) => {
      project.clips = [solid("theirs", 0)];
    });
    const listed = (await call(app, id, "edit_history", {})).content[0]!.text!;
    expect(listed).toContain("Versions kept aside");
    expect(listed).toContain(`- ${overtaken}, `);
    expect(listed).toContain("this computer's version, which another computer's overtook (“Case”, 1 clips)");
    expect(listed).toContain("- p1762500000000-7, ");
    // The kept one became "again" (its name kept once, by the copy's id: rewritten, never a second file).
    expect(listed).toContain("an old “(conflicted copy)” of it, folded in (“again”, 1 clips)");
    const clips = () => app.store.get(id)!.project.clips.map((clip) => clip.id).join(" ");
    expect(clips()).toBe("theirs");
    const answer = await call(app, id, "undo_changes", { kept: overtaken });
    expect(answer.isError).toBe(false);
    expect(answer.content[0]!.text).toContain(`Brought back kept version ${overtaken}`);
    expect(clips()).toBe("ours");
    expect(app.store.get(id)!.project).toMatchObject({ id, name: "Case", hq: true });
    // One new change: undone, the cloud's is back.
    await call(app, id, "undo_changes", { revs: [app.store.get(id)!.rev] });
    expect(clips()).toBe("theirs");
    // A copy's kept version keeps the project's own id and name.
    await call(app, id, "undo_changes", { kept: "p1762500000000-7" });
    expect(app.store.get(id)!.project).toMatchObject({ id, name: "Case" });
    const missing = await call(app, id, "undo_changes", { kept: "123" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("no kept version");
  } finally {
    cleanup();
  }
});
