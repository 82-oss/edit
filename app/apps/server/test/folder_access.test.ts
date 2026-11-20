// Folders the system may ask about (folder_access.ts): kenobi, Nov 17, Edit's
// cache on a removable drive, macOS asking, and the server held in a sync
// mkdir until it was quit. Each test stands in for macOS's question with a
// probe that doesn't answer until the test says so, and checks that the
// server keeps answering while the work that reads the place waits.

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as folderAccess from "../src/folder_access.ts";
import { exportRoots, readExportFolder } from "../src/export_folder.ts";
import { respond } from "../src/http/server.ts";
import { importPaths } from "../src/import.ts";
import { buildRouter } from "../src/routes.ts";
import { Store } from "../src/store.ts";
import { fixtureHome, scratch } from "./helpers/home.ts";

const original = { ...folderAccess.hooks };
const originalWait = folderAccess.ROUTE_WAIT_MS.value;
const originalShown = folderAccess.SHOWN_AFTER_MS.value;

/** A probe per place that answers only when told: `answer(root)` grants, `answer(root, "EPERM")` refuses. */
function heldProbe() {
  const asked: string[] = [];
  const open = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  folderAccess.hooks.probe = (root) =>
    new Promise<void>((resolve, reject) => {
      asked.push(root);
      open.set(root, { resolve, reject });
    });
  return {
    asked,
    answer(root: string, code?: string) {
      const one = open.get(root);
      if (one === undefined) throw new Error(`${root} wasn't asked about`);
      open.delete(root);
      if (code === undefined) one.resolve();
      else one.reject(Object.assign(new Error(code), { code }));
    },
  };
}

/** The request, or "still waiting" when it hasn't answered within `ms`. */
async function within(ms: number, request: Promise<Response | undefined>): Promise<Response | "still waiting"> {
  const answer = await Promise.race([request, Bun.sleep(ms).then(() => "still waiting" as const)]);
  if (answer === undefined) throw new Error("no response");
  return answer;
}

function ask(app: Parameters<typeof respond>[0], path: string, init: RequestInit = {}) {
  return respond(app, buildRouter(), new Request(`http://localhost:7700${path}`, { ...init, headers: { host: "localhost:7700", "content-type": "application/json" } }), null);
}

beforeEach(() => {
  folderAccess.resetForTests();
});

afterEach(() => {
  Object.assign(folderAccess.hooks, original);
  folderAccess.ROUTE_WAIT_MS.value = originalWait;
  folderAccess.SHOWN_AFTER_MS.value = originalShown;
  folderAccess.resetForTests();
});

test("the places that may ask: volumes, network mounts, Desktop, Documents, Downloads, iCloud and cloud folders; never the data folder or the system's", () => {
  folderAccess.hooks.platform = "darwin";
  folderAccess.hooks.home = () => "/Users/kenobi";
  const { rootOf } = folderAccess;
  expect(rootOf("/Volumes/Edit Drive/edit-cache/ab/preview.mp4")).toBe("/Volumes/Edit Drive");
  expect(rootOf("/Volumes/NAS")).toBe("/Volumes/NAS");
  expect(rootOf("/Network/Servers/nas/x")).toBe("/Network/Servers");
  expect(rootOf("/Users/kenobi/Desktop/case.mp4")).toBe("/Users/kenobi/Desktop");
  expect(rootOf("/Users/kenobi/Downloads")).toBe("/Users/kenobi/Downloads");
  expect(rootOf("/Users/kenobi/Documents/../Documents/a")).toBe("/Users/kenobi/Documents");
  expect(rootOf("/Users/kenobi/Library/Mobile Documents/com~apple~CloudDocs/a.mp4")).toBe("/Users/kenobi/Library/Mobile Documents");
  expect(rootOf("/Users/kenobi/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/x.mp4")).toBe("/Users/kenobi/Library/CloudStorage/GoogleDrive-a@b.c");
  expect(rootOf("/Users/kenobi/.edit/cache/ab")).toBeNull();
  expect(rootOf("/Users/kenobi/Movies/Edit/a.mp4")).toBeNull();
  expect(rootOf("/Users/kenobi/DesktopOld/a")).toBeNull();
  expect(rootOf("/Applications/Edit.app")).toBeNull();
  expect(rootOf("/tmp/x")).toBeNull();
  expect(rootOf("http://127.0.0.1:7700/api/cloud/x")).toBeNull();
  folderAccess.hooks.platform = "linux";
  expect(rootOf("/media/sphe/Drive/a.mp4")).toBe("/media/sphe/Drive");
  expect(rootOf("/run/media/sphe/Drive/a.mp4")).toBe("/run/media/sphe/Drive");
  expect(rootOf("/mnt/nas/footage/a.mp4")).toBe("/mnt/nas");
  expect(rootOf("/home/sphe/.edit/cache")).toBeNull();
  expect(rootOf("/Volumes/Drive/a")).toBeNull();
});

test("a cache made a link to a drive is found on the drive, without looking at the drive", () => {
  const { dir, cleanup } = scratch("access-link");
  try {
    folderAccess.hooks.platform = "darwin";
    folderAccess.hooks.home = () => "/Users/kenobi";
    const home = nodePath.join(dir, "home");
    fs.mkdirSync(home);
    fs.symlinkSync("/Volumes/Edit Drive/edit-cache", nodePath.join(home, "cache"));
    // A link to a link, relative: followed too.
    fs.symlinkSync("home/cache", nodePath.join(dir, "again"));
    expect(folderAccess.placeOf(nodePath.join(home, "cache", "ab", "preview.mp4"))).toBe("/Volumes/Edit Drive/edit-cache/ab/preview.mp4");
    expect(folderAccess.placeOf(nodePath.join(dir, "again", "x"))).toBe("/Volumes/Edit Drive/edit-cache/x");
    expect(folderAccess.placeOf(nodePath.join(home, "projects"))).toBe(nodePath.join(home, "projects"));
    expect(folderAccess.unanswered([nodePath.join(home, "cache")])).toEqual(["/Volumes/Edit Drive"]);
    expect(folderAccess.unanswered([nodePath.join(home, "projects")])).toEqual([]);
  } finally {
    cleanup();
  }
});

test("the data folder opens with its cache on a drive that isn't plugged in, or that macOS hasn't been asked about", () => {
  const { dir, cleanup } = scratch("access-open");
  try {
    folderAccess.hooks.platform = "darwin";
    const home = nodePath.join(dir, "home");
    fs.mkdirSync(home);
    fs.symlinkSync("/Volumes/Unplugged/edit-cache", nodePath.join(home, "cache"));
    const store = Store.open(home);
    expect(store.cacheDir()).toBe(nodePath.join(fs.realpathSync(home), "cache"));
    expect(fs.existsSync(nodePath.join(home, "projects"))).toBe(true);
    // A link to a folder that's gone, where nothing asks: a warning, not a server that won't start.
    folderAccess.hooks.platform = "linux";
    const other = nodePath.join(dir, "other");
    fs.mkdirSync(other);
    fs.symlinkSync(nodePath.join(dir, "gone", "deeper", "cache"), nodePath.join(other, "cache"));
    expect(() => Store.open(other)).not.toThrow();
  } finally {
    cleanup();
  }
});

test("while macOS asks about the cache's drive, the server answers and the routes that read it wait, then go on", async () => {
  const { app, home, cleanup } = fixtureHome("access-routes");
  try {
    folderAccess.hooks.platform = "darwin";
    folderAccess.hooks.home = () => "/Users/kenobi";
    fs.rmSync(nodePath.join(home, "cache"), { recursive: true, force: true });
    fs.symlinkSync("/Volumes/Edit Drive/edit-cache", nodePath.join(home, "cache"));
    const probe = heldProbe();
    expect(folderAccess.useDataFolder(home)).toEqual(["/Volumes/Edit Drive"]);
    const seen: folderAccess.Waiting[][] = [];
    folderAccess.onChange((waiting) => seen.push(waiting));
    folderAccess.ROUTE_WAIT_MS.value = 400;
    folderAccess.SHOWN_AFTER_MS.value = 50;
    // The project list reads the cache's places as it loads: it waits, asking once.
    const listing = ask(app, "/api/projects");
    // Every other request is answered meanwhile.
    const health = await within(300, ask(app, "/api/health"));
    expect(health).not.toBe("still waiting");
    expect((health as Response).status).toBe(200);
    const access = await within(300, ask(app, "/api/access"));
    expect((access as Response).status).toBe(200);
    expect(await within(100, listing)).toBe("still waiting");
    expect(probe.asked).toEqual(["/Volumes/Edit Drive"]);
    // Asked for longer than its wait: a 503 that says what to do, to ask again soon.
    const late = (await listing)!;
    expect(late.status).toBe(503);
    expect(late.headers.get("retry-after")).toBe("2");
    expect(((await late.json()) as { error: string }).error).toBe("Waiting for macOS: allow Edit to use “Edit Drive”.");
    expect(folderAccess.waiting(Date.now() + 2_000).map((one) => one.name)).toEqual(["Edit Drive"]);
    expect(seen.at(-1)?.map((one) => one.root)).toEqual(["/Volumes/Edit Drive"]);
    // Another request while it's still asked: no second question.
    const again = ask(app, "/api/projects");
    await Bun.sleep(20);
    expect(probe.asked).toEqual(["/Volumes/Edit Drive"]);
    // The person allows it: what waited goes on, and nothing waits after.
    probe.answer("/Volumes/Edit Drive");
    expect(((await again)!).status).toBe(200);
    expect(folderAccess.stateOf("/Volumes/Edit Drive/edit-cache")).toBe("granted");
    expect(folderAccess.waiting(Date.now() + 2_000)).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
    const after = await within(100, ask(app, "/api/projects"));
    expect((after as Response).status).toBe(200);
  } finally {
    cleanup();
  }
});

test("the start's work that reads the data folder is waited for by routes, as its places are", async () => {
  const { app, cleanup } = fixtureHome("access-hold");
  try {
    let begin: () => void = () => {};
    folderAccess.hold(new Promise<void>((resolve) => (begin = resolve)));
    const listing = ask(app, "/api/projects");
    expect((await within(200, ask(app, "/api/health"))) as Response).toHaveProperty("status", 200);
    expect(await within(100, listing)).toBe("still waiting");
    begin();
    expect(((await listing)!).status).toBe(200);
  } finally {
    cleanup();
  }
});

test("a project's routes wait for its footage's drive; a refusal answers at once, and is never asked again", async () => {
  const { app, home, cleanup } = fixtureHome("access-project");
  try {
    folderAccess.hooks.platform = "darwin";
    const probe = heldProbe();
    fs.writeFileSync(nodePath.join(home, "projects", "kenobi1.json"), JSON.stringify({ id: "kenobi1", media: [{ path: "/Volumes/Footage/bodycam.mp4" }, { path: "http://127.0.0.1:7700/api/cloud/x" }] }));
    const opening = ask(app, "/api/projects/kenobi1");
    expect((await within(200, ask(app, "/api/projects/other/frame/0"))) as Response).not.toBe("still waiting");
    expect(await within(100, opening)).toBe("still waiting");
    expect(probe.asked).toEqual(["/Volumes/Footage"]);
    probe.answer("/Volumes/Footage", "EPERM");
    const opened = (await opening)!;
    expect(opened.status).not.toBe(503);
    expect(folderAccess.stateOf("/Volumes/Footage/bodycam.mp4")).toBe("refused");
    await ask(app, "/api/projects/kenobi1");
    expect(probe.asked).toEqual(["/Volumes/Footage"]);
  } finally {
    cleanup();
  }
});

test("an import from a drive waits for macOS's answer before looking at the file; an unplugged drive is asked again later", async () => {
  const { app, store, cleanup } = fixtureHome("access-import");
  try {
    folderAccess.hooks.platform = "darwin";
    const probe = heldProbe();
    const project = store.create("Kenobi", { width: 1920, height: 1080, fps: 30 } as Parameters<Store["create"]>[1]).project;
    let settled = false;
    const importing = importPaths(app, project.id, ["/Volumes/Footage/bodycam.mp4"], false, "test").finally(() => (settled = true));
    await Bun.sleep(50);
    expect(settled).toBe(false);
    expect(probe.asked).toEqual(["/Volumes/Footage"]);
    probe.answer("/Volumes/Footage", "ENOENT");
    const [, added, errors] = await importing;
    expect(added).toEqual([]);
    expect(errors).toEqual(["/Volumes/Footage/bodycam.mp4 is not a supported local media file"]);
    expect(folderAccess.stateOf("/Volumes/Footage")).toBe("gone");
    // Plugged back in later: asked again, not taken as gone for good.
    const now = Date.now;
    Date.now = () => now() + 31_000;
    try {
      expect(folderAccess.ready("/Volumes/Footage/bodycam.mp4")).toBe(false);
    } finally {
      Date.now = now;
    }
  } finally {
    cleanup();
  }
});

test("the export folder saved on a drive isn't looked at while macOS is asked about it; saving one there waits for the answer", async () => {
  const { app, home, cleanup } = fixtureHome("access-exports");
  try {
    folderAccess.hooks.platform = "darwin";
    const probe = heldProbe();
    fs.writeFileSync(nodePath.join(home, "export-folder.json"), JSON.stringify({ path: "/Volumes/Exports/Edit" }));
    // Read as saved (a look would hold the server), and asked about meanwhile.
    expect(readExportFolder(home)).toMatchObject({ path: "/Volumes/Exports/Edit", chosen: true });
    expect(probe.asked).toEqual(["/Volumes/Exports"]);
    // The cleaner and the storage list read the export folders synchronously: that one's left out until it answers.
    expect(exportRoots(home)).not.toContain("/Volumes/Exports/Edit");
    folderAccess.ROUTE_WAIT_MS.value = 200;
    // The export routes wait on the saved folder's drive.
    const activity = ask(app, "/api/exports/folder");
    expect(await within(100, activity)).toBe("still waiting");
    probe.answer("/Volumes/Exports");
    expect(((await activity)!).status).toBe(200);
    // Answered, it's looked at as before (here there's no such folder, so it's the suggestion again).
    expect(readExportFolder(home).chosen).toBe(false);
    // A new folder picked on another drive: its save waits on that drive.
    const saving = (await ask(app, "/api/exports/folder", { method: "POST", body: JSON.stringify({ path: "/Volumes/Other/Exports" }) }))!;
    expect(saving.status).toBe(503);
    expect(((await saving.json()) as { error: string }).error).toBe("Waiting for macOS: allow Edit to use “Other”.");
    expect(probe.asked).toEqual(["/Volumes/Exports", "/Volumes/Other"]);
  } finally {
    cleanup();
  }
});

test("a place that never answers is given up on after its time, so the start's resume goes on; one that answers in time is waited for (Nov 20)", async () => {
  const probe = heldProbe();
  const began = Date.now();
  expect(await folderAccess.reachRootsWithin(["/Volumes/Dead"], 200)).toBe(false);
  expect(Date.now() - began).toBeGreaterThanOrEqual(190);
  expect(probe.asked).toEqual(["/Volumes/Dead"]);
  const asked = folderAccess.reachRootsWithin(["/Volumes/Alive"], 5_000);
  await Bun.sleep(20);
  probe.answer("/Volumes/Alive");
  expect(await asked).toBe(true);
});
