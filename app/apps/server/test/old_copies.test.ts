// old_copies.ts: the "(conflicted copy)" edits and scripts made before Nov 15,
// folded into their originals (Sphe: "eradicate conflicted copies as a whole").

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Script } from "@edit/types/writer";

import * as changes from "../src/changes.ts";
import * as jobs from "../src/jobs.ts";
import type { Project } from "../src/model.ts";
import { fold } from "../src/old_copies.ts";
import * as seams from "../src/seams.ts";
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

const day = (ms: number): string => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const keptWith = (home: string, original: string): Project[] => {
  const dir = path.join(home, "projects", "kept", original);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Project) : [];
};

test("an old edit copy nobody worked in is kept aside with its original; one worked in stays a project; one whose original is gone gets its name back", async () => {
  const { app, cleanup } = fixtureHome("old-copies-edits");
  try {
    changes.start(app);
    const original = app.store.create("Case", SETTINGS_1080).project.id;
    const copy = app.store.create("Case (conflicted copy)", SETTINGS_1080).project.id;
    const worked = app.store.create("Case (conflicted copy)", SETTINGS_1080).project.id;
    // The person added a clip to it since it was made.
    await app.store.update(worked, "ui-abc", (project) => void (project.name = "Case (conflicted copy)"));
    await app.store.update(worked, "ui-abc", (project) => void project.clips.push({ id: "c1", type: "solid", track: "v1", start: 0, duration: 30, fill: [0, 0, 0, 1], opacity: 1, color: "blue", fade_in: 0, fade_out: 0 } as never));
    const orphan = app.store.create("Gone (conflicted copy) (conflicted copy)", SETTINGS_1080).project.id;
    expect(await fold(app)).toBe(3);
    expect(app.store.get(copy)).toBeNull();
    // Kept once, by the copy's id, where neither the history's rotation nor the cache cleaner goes.
    expect(fs.readdirSync(path.join(app.store.home, "projects", "kept", original))).toEqual([`${copy}.json`]);
    expect(keptWith(app.store.home, original).map((project) => project.name)).toEqual(["Case (conflicted copy)"]);
    expect(app.store.kept(original)).toMatchObject([{ name: copy, why: "copy" }]);
    expect(app.store.get(worked)!.project.name).toBe(`Case (kept ${day(Date.now())})`);
    expect(app.store.get(worked)!.project.clips).toHaveLength(1);
    expect(app.store.get(orphan)!.project.name).toBe("Gone");
    // Nothing left to fold.
    expect(await fold(app)).toBe(0);
  } finally {
    cleanup();
  }
});

test("an old edit copy with work running or to carry on waits for the next start", async () => {
  const { app, cleanup } = fixtureHome("old-copies-busy");
  try {
    app.store.create("Case", SETTINGS_1080);
    const copy = app.store.create("Case (conflicted copy)", SETTINGS_1080).project.id;
    const key = jobs.begin(app.store.home, "export", copy, {});
    expect(await fold(app)).toBe(0);
    expect(app.store.get(copy)!.project.name).toBe("Case (conflicted copy)");
    jobs.end(app.store.home, key);
    expect(await fold(app)).toBe(1);
    expect(app.store.get(copy)).toBeNull();
  } finally {
    cleanup();
  }
});

test("an old edit copy's original is looked for in the cloud too; a refused delete keeps nothing yet, and an unread cloud waits", async () => {
  const { app, cleanup } = fixtureHome("old-copies-cloud");
  const saved = { ...seams.cloudProjects };
  try {
    app.store.attachCloud({ mayWrite: async () => {}, wrote: () => {}, created: () => {} });
    const copy = app.store.create("Remote (conflicted copy)", SETTINGS_1080).project.id;
    const edited = app.store.create("Remote (conflicted copy)", SETTINGS_1080).project.id;
    let cloud: { id: string; name: string; rev: number }[] | Error = new Error("Can't reach the cloud");
    const deletes: string[] = [];
    let refuse = true;
    seams.cloudProjects.listed = async () => {
      if (cloud instanceof Error) throw cloud;
      return cloud;
    };
    seams.cloudProjects.synced = (_app, id) => ({ rev: 1, dirty: id === "none" });
    seams.cloudProjects.delete = async (_app, id) => {
      if (refuse) throw new Error("Can't delete it: kenobi is editing it.");
      deletes.push(id);
      return true;
    };
    // The cloud's list can't be read: nothing is done (the original could be there).
    expect(await fold(app)).toBe(0);
    expect(app.store.get(copy)!.project.name).toBe("Remote (conflicted copy)");
    // The original only in the cloud; the edited copy saved there again since it went up.
    cloud = [
      { id: "p1700000000000-1", name: "Remote", rev: 9 },
      { id: copy, name: "Remote (conflicted copy)", rev: 1 },
      { id: edited, name: "Remote (conflicted copy)", rev: 4 },
    ];
    // Its delete refused: it stays, and nothing is kept for it yet.
    expect(await fold(app)).toBe(1);
    expect(app.store.get(copy)!.project.name).toBe("Remote (conflicted copy)");
    expect(app.store.kept("p1700000000000-1")).toEqual([]);
    // Worked in (rev 4): never given the original's name, never deleted.
    expect(app.store.get(edited)!.project.name).toBe(`Remote (kept ${day(Date.now())})`);
    refuse = false;
    expect(await fold(app)).toBe(1);
    expect(deletes).toEqual([copy]);
    expect(app.store.get(copy)).toBeNull();
    expect(app.store.kept("p1700000000000-1")).toMatchObject([{ name: copy, why: "copy" }]);
    expect(app.store.list().map((summary) => summary.name)).toEqual([`Remote (kept ${day(Date.now())})`]);
  } finally {
    Object.assign(seams.cloudProjects, saved);
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
