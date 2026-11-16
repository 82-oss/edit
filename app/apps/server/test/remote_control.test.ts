// remote_control.ts: what an admin asks of a teammate's Edit from afar (Sphe,
// Nov 15: "we need to have FULL remote control"), always said on their screen.

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import * as jobs from "../src/jobs.ts";
import { helpNow, kindsOf, run, shell } from "../src/remote_control.ts";
import { fixtureHome } from "./helpers/home.ts";

test("work is held by name: agents, exports, imports, all, or job kinds; anything else is refused", () => {
  expect(kindsOf(["agents"])).toEqual(["turn", "fix", "idea", "thumbnail", "writer"]);
  expect(kindsOf(["exports,imports"]).sort()).toEqual(["archive", "case", "drive", "export", "footage", "full", "script", "share", "upload"]);
  expect(kindsOf(["smooth"])).toEqual(["smooth"]);
  expect(kindsOf(["all"])).toContain("turn");
  expect(() => kindsOf(["everything"])).toThrow(/isn't work Edit can hold/);
});

test("held work isn't started again after a restart, nor woken, until it's released", async () => {
  const { app, cleanup } = fixtureHome("remote-hold");
  try {
    const home = app.store.home;
    const started: string[] = [];
    jobs.begin(home, "turn", "p1", {});
    jobs.begin(home, "export", "p1", {});
    expect(await run(app, JSON.stringify({ do: "hold", what: ["agents"] }), "Sphe")).toContain("Held from starting again: turn");
    expect(jobs.held(home)).toContain("turn");
    const resumers = { turn: (job: jobs.Job) => void started.push(job.key), export: (job: jobs.Job) => void started.push(job.key) };
    await jobs.resume(home, resumers);
    expect(started).toEqual([jobs.keyOf("export", "p1")]);
    expect(await run(app, JSON.stringify({ do: "release" }), "Sphe")).toContain("Released and started again");
    expect(started).toEqual([jobs.keyOf("export", "p1"), jobs.keyOf("turn", "p1")]);
    expect(jobs.held(home)).toEqual([]);
    expect(await run(app, JSON.stringify({ do: "release" }), "Sphe")).toBe("Nothing was held.");
  } finally {
    cleanup();
  }
});

test("the help dialog: up with who and why, every change a step in it, through restarts (a file), then closed", async () => {
  const { app, cleanup } = fixtureHome("remote-help");
  try {
    const heard: Record<string, unknown>[] = [];
    app.store.subscribe((event) => void heard.push(event));
    await run(app, JSON.stringify({ do: "help", message: "Fixing your export" }), "Sphe");
    expect(helpNow(app.store.home)).toMatchObject({ by: "Sphe", message: "Fixing your export", steps: [] });
    expect(heard.at(-1)).toMatchObject({ type: "remote-help", help: { by: "Sphe" } });
    await run(app, JSON.stringify({ do: "say", message: "Back in a minute" }), "Sphe");
    expect(helpNow(app.store.home)!.steps.map((step) => step.text)).toEqual(["Back in a minute"]);
    await run(app, JSON.stringify({ do: "help-end" }), "Sphe");
    expect(helpNow(app.store.home)!.ended!.message).toBe("All done. You can carry on.");
    // Outside a dialog, a line on their screen.
    fs.rmSync(`${app.store.home}/remote-help.json`);
    await run(app, JSON.stringify({ do: "say", message: "Your export is fixed" }), "Sphe");
    expect(heard.at(-1)).toEqual({ type: "remote-say", by: "Sphe", text: "Your export is fixed" });
    // A dialog nobody ended goes after three hours.
    fs.writeFileSync(`${app.store.home}/remote-help.json`, JSON.stringify({ by: "Sphe", message: "", started: Date.now() - 4 * 3600_000, steps: [] }));
    expect(helpNow(app.store.home)).toBeNull();
  } finally {
    cleanup();
  }
});

test("a shell command: its output and exit, stopped at its time limit", async () => {
  expect(await shell("echo hello; echo oops >&2; exit 3")).toBe("exit 3\n\nstdout:\nhello\n\n\nstderr:\noops\n");
  expect(await shell("sleep 5", 1)).toContain("stopped after 1 s");
  // A child left running with the pipes open doesn't hold the answer (every later command waited behind it).
  const started = Date.now();
  expect(await shell("sleep 30 & echo left")).toContain("stdout:\nleft");
  expect(Date.now() - started).toBeLessThan(5_000);
  await expect(shell("  ")).rejects.toThrow(/needs a command/);
});

test("a request that isn't JSON, says nothing, or isn't known is refused in words", async () => {
  const { app, cleanup } = fixtureHome("remote-bad");
  try {
    await expect(run(app, "nope", "Sphe")).rejects.toThrow(/isn't JSON/);
    await expect(run(app, "{}", "Sphe")).rejects.toThrow(/says nothing to do/);
    await expect(run(app, JSON.stringify({ do: "reboot" }), "Sphe")).rejects.toThrow(/isn't something this build does/);
    await expect(run(app, JSON.stringify({ do: "call", path: "/etc/passwd" }), "Sphe")).rejects.toThrow(/one of Edit's routes/);
    await expect(run(app, JSON.stringify({ do: "agent", project: "p404", prompt: "hi" }), "Sphe")).rejects.toThrow(/no project p404/);
  } finally {
    cleanup();
  }
});
