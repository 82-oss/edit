// Test projects (dev_projects.ts): what a person didn't start from Home's New
// project is marked "dev" when it's made, on every build; a save never changes
// the mark; one is shown when asked for, promoted one at a time, and deleted
// all at once only when the count matches; real projects are never touched.

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import type { Project } from "../src/model.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";

const settings = { width: 1920, height: 1080, fps: 30 };

async function ask(app: Parameters<typeof respond>[0], path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = (await respond(app, buildRouter(), new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("a project made through the API is a test project; one a person starts from Home isn't", async () => {
  const { app, store, cleanup } = fixtureHome("dev-mark");
  try {
    const made = await ask(app, "/api/projects", { name: "Skills check", ...settings });
    const person = await ask(app, "/api/projects", { name: "Cops Found 3 Bodies", ...settings, person: true });
    // The store's own (the Writer's handoff): a person's.
    const handed = store.createAs("From Writer", "bodycam", settings);
    const trial = (made.body.project as Project).id;
    const real = (person.body.project as Project).id;
    expect(store.get(trial)?.project.origin).toBe("dev");
    expect(store.get(real)?.project.origin).toBeUndefined();
    expect(handed.project.origin).toBeUndefined();
    const listed = new Map(store.list().map((summary) => [summary.id, summary]));
    expect(listed.get(trial)?.dev).toBe(true);
    expect(listed.get(trial)?.shown).toBeUndefined();
    expect(listed.get(real)?.dev).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("a save of a whole project keeps whether it's a test project", async () => {
  const { app, store, cleanup } = fixtureHome("dev-keep");
  try {
    const real = store.createAs("Base: Welfare Check", "bodycam", settings);
    const trial = store.createAs("R1: Welfare Check", "bodycam", settings, false, true);
    // The teaching loop's copy: the real base's body saved over the trial's new project.
    const copied = { ...structuredClone(real.project), id: trial.project.id };
    expect((await ask(app, `/api/projects/${trial.project.id}`, { base_rev: trial.rev, project: copied, origin: "copy" }, "PUT")).status).toBe(200);
    expect(store.get(trial.project.id)?.project.origin).toBe("dev");
    // Nor can a save make a real one a test project, or show one.
    const marked = { ...structuredClone(real.project), origin: "dev", shown: true };
    expect((await ask(app, `/api/projects/${real.project.id}`, { base_rev: real.rev, project: marked, origin: "ui" }, "PUT")).status).toBe(200);
    expect(store.get(real.project.id)?.project.origin).toBeUndefined();
    expect(store.get(real.project.id)?.project.shown).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("a test project is brought forth when asked for, and hidden again; a real one can't be", async () => {
  const { app, store, cleanup } = fixtureHome("dev-show");
  try {
    const real = store.createAs("Real", "bodycam", settings);
    const trial = store.createAs("Skills check", "bodycam", settings, false, true);
    expect((await ask(app, `/api/projects/${trial.project.id}/show`, {})).status).toBe(200);
    expect(store.list().find((summary) => summary.id === trial.project.id)).toMatchObject({ dev: true, shown: true });
    expect((await ask(app, `/api/projects/${trial.project.id}/hide`, {})).status).toBe(200);
    expect(store.list().find((summary) => summary.id === trial.project.id)?.shown).toBeUndefined();
    expect((await ask(app, `/api/projects/${real.project.id}/show`, {})).status).toBe(409);
    expect((await ask(app, "/api/projects/p1-nope/show", {})).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("a test project promoted is an ordinary project", async () => {
  const { app, store, cleanup } = fixtureHome("dev-promote");
  try {
    const dev = store.createAs("Became real", "bodycam", settings, false, true);
    await ask(app, `/api/projects/${dev.project.id}/show`, {});
    expect((await ask(app, `/api/projects/${dev.project.id}/promote`, {})).status).toBe(200);
    expect(store.get(dev.project.id)?.project.origin).toBeUndefined();
    expect(store.get(dev.project.id)?.project.shown).toBeUndefined();
    expect(store.list().find((summary) => summary.id === dev.project.id)?.dev).toBeUndefined();
    expect((await ask(app, "/api/projects/p1-nope/promote", {})).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("an older throwaway marked a test project by hand is listed, and deleted, with the rest", async () => {
  const { app, store, cleanup } = fixtureHome("dev-test");
  try {
    const real = store.createAs("Real case", "bodycam", settings);
    const trial = store.createAs("R1: 16-Year-Old Kills Her Best Friend", "interrogation", settings);
    expect((await ask(app, `/api/projects/${trial.project.id}/test`, {})).status).toBe(200);
    expect(store.list().find((summary) => summary.id === trial.project.id)?.dev).toBe(true);
    expect(store.list().find((summary) => summary.id === real.project.id)?.dev).toBeUndefined();
    expect((await ask(app, "/api/projects/p1-nope/test", {})).status).toBe(404);
    expect((await ask(app, "/api/dev-projects/delete", { count: 1 })).body.deleted).toEqual([trial.project.id]);
    expect(store.list().map((summary) => summary.id)).toEqual([real.project.id]);
  } finally {
    cleanup();
  }
});

test("delete all test projects deletes only those, and only when the count is what the confirm showed", async () => {
  const { app, store, home, cleanup } = fixtureHome("dev-delete");
  try {
    const real = store.createAs("Real", "bodycam", settings);
    const first = store.createAs("Trial 1", "bodycam", settings, false, true);
    const second = store.createAs("Trial 2", "interrogation", settings, false, true);
    const promoted = store.createAs("Trial 3", "bodycam", settings, false, true);
    await ask(app, `/api/projects/${promoted.project.id}/promote`, {});

    expect((await ask(app, "/api/dev-projects/delete", {})).status).toBe(400);
    const wrong = await ask(app, "/api/dev-projects/delete", { count: 3 });
    expect(wrong.status).toBe(409);
    expect(store.list()).toHaveLength(4);

    const done = await ask(app, "/api/dev-projects/delete", { count: 2 });
    expect(done.status).toBe(200);
    expect((done.body.deleted as string[]).sort()).toEqual([first.project.id, second.project.id].sort());
    expect(done.body.failed).toEqual([]);
    expect(store.list().map((summary) => summary.id).sort()).toEqual([real.project.id, promoted.project.id].sort());
    // Kept aside in projects/deleted, as Home's Delete does.
    expect(fs.readdirSync(`${home}/projects/deleted`).filter((name) => name.startsWith(first.project.id))).toHaveLength(1);
    // None left: nothing to delete.
    expect((await ask(app, "/api/dev-projects/delete", { count: 1 })).status).toBe(409);
  } finally {
    cleanup();
  }
});
