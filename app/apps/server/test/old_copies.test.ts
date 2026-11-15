// old_copies.ts: the "(conflicted copy)" edits and scripts made before Nov 15,
// folded into their originals (Sphe: "eradicate conflicted copies as a whole").

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Script } from "@edit/types/writer";

import type { Project } from "../src/model.ts";
import { fold } from "../src/old_copies.ts";
import { OLD_COPY } from "../src/sync_core.ts";
import * as scripts from "../src/writer/store.ts";
import * as versions from "../src/writer/versions.ts";
import { fixtureHome } from "./helpers/home.ts";

const SETTINGS_1080 = { width: 1920, height: 1080, fps: 30 };
const script = (id: string, title: string, updatedAt: number): Script => ({ id, title, status: "ready", error: null, clips: [], createdAt: updatedAt, updatedAt, revision: 1 }) as unknown as Script;

test("the old suffixes, once or more, and nothing else", () => {
  for (const name of ["Case (conflicted copy)", "Case (conflicted copy) (conflicted copy)", "Case (conflicted copy) (restored copy)"]) expect(name.replace(OLD_COPY, "")).toBe("Case");
  expect(OLD_COPY.test("Case (copy)")).toBe(false);
});

test("an old edit copy goes into its original's history; one whose original is gone gets its name back", async () => {
  const { app, cleanup } = fixtureHome("old-copies-edits");
  try {
    const original = app.store.create("Case", SETTINGS_1080).project.id;
    const copy = app.store.create("Case (conflicted copy)", SETTINGS_1080).project.id;
    const orphan = app.store.create("Gone (conflicted copy) (conflicted copy)", SETTINGS_1080).project.id;
    expect(await fold(app)).toBe(2);
    expect(app.store.list().map((summary) => summary.name).sort()).toEqual(["Case", "Gone"]);
    expect(app.store.get(copy)).toBeNull();
    expect(app.store.get(orphan)!.project.name).toBe("Gone");
    const history = path.join(app.store.home, "projects", "history", original);
    const kept = fs.readdirSync(history).map((name) => JSON.parse(fs.readFileSync(path.join(history, name), "utf8")) as Project);
    expect(kept.map((project) => project.name)).toContain("Case (conflicted copy)");
    // Nothing left to fold.
    expect(await fold(app)).toBe(0);
  } finally {
    cleanup();
  }
});

test("an old script copy becomes a Not synced version of its original and is deleted everywhere", async () => {
  const { app, cleanup } = fixtureHome("old-copies-scripts");
  try {
    const data = scripts.dataDir(app.store.home);
    const put = (one: Script) => {
      const dir = scripts.scriptDir(data, one.id);
      fs.mkdirSync(dir, { recursive: true });
      scripts.write(dir, one);
    };
    const now = Date.now() - 60_000;
    put(script("aaaaaaaa-0000-4000-8000-000000000001", "Predator Tutor", now));
    put(script("aaaaaaaa-0000-4000-8000-000000000002", "Predator Tutor (conflicted copy)", Date.UTC(2026, 10, 7)));
    put(script("aaaaaaaa-0000-4000-8000-000000000003", "Kroger (restored copy)", now));
    expect(await fold(app)).toBe(2);
    expect(scripts.list(data).map((row) => row.title).sort()).toEqual(["Kroger", "Predator Tutor"]);
    const listed = versions.list(scripts.scriptDir(data, "aaaaaaaa-0000-4000-8000-000000000001"));
    expect(listed).toMatchObject([{ author: "kept", summary: "A conflicted copy from 7 Nov, kept here" }]);
    // Its delete goes to the cloud with the next round, as the script page's Delete does.
    expect(JSON.parse(fs.readFileSync(path.join(data, "cloud", "deleted.json"), "utf8"))).toEqual(["aaaaaaaa-0000-4000-8000-000000000002"]);
  } finally {
    cleanup();
  }
});
