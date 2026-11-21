import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { folderId, importDrive, importKey, removeStagedCopy, resumeImport } from "../src/drive_import.ts";
import * as failure from "../src/failure.ts";
import * as importing from "../src/import.ts";
import * as jobs from "../src/jobs.ts";
import * as uploads from "../src/uploads.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

test("folderId reads a Drive folder link", () => {
  expect(folderId("https://drive.google.com/drive/folders/1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ")).toBe("1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ");
  expect(folderId("https://example.com/folders/1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ")).toBeNull();
});

test("removeStagedCopy deletes only Edit's staging copies under the uploads root", () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/edit-stage-`);
  try {
    const root = `${dir}/media/p1`;
    const staged = `${root}/drive/abc/file.mp4`;
    fs.mkdirSync(`${root}/drive/abc`, { recursive: true });
    fs.writeFileSync(staged, "x");
    const outside = `${dir}/Movies/file.mp4`;
    fs.mkdirSync(`${dir}/Movies`, { recursive: true });
    fs.writeFileSync(outside, "x");
    expect(removeStagedCopy(outside, root)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(removeStagedCopy(staged, root)).toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Footage from a Drive link is a job (Sphe, Nov 10: an update goes through at any time, and what it cuts carries
// on): a restart meanwhile carries it on by itself, the footage placed on the timeline once.
const ffmpeg = Bun.which("ffmpeg");

test.skipIf(ffmpeg === null)("a Drive import a restart cut short carries on by itself and places its footage once", async () => {
  const mock = MockServer.start();
  const restore = mock.useEnv();
  const fx = fixtureHome("drive-import-resume");
  try {
    const source = `${fx.dir}/source.mp4`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x36:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-c:a", "aac", source]);
    expect(made.exitCode).toBe(0);
    mock.driveFile("1AbCdEfGhIjKlMnOp", new Uint8Array(fs.readFileSync(source)), "Bodycam 1.mp4");
    const url = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view";
    const id = fx.app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    const home = fx.app.store.home;
    const footage = () => jobs.list(home, "footage");

    const [, added, errors] = await importDrive(fx.app, id, url, true, "");
    expect(errors).toEqual([]);
    expect(added.length).toBe(1);
    const placed = fx.app.store.get(id)!.project.clips.length;
    expect(placed).toBe(2);
    expect(footage()).toEqual([]);
    expect(uploads.list(fx.app.store.uploadsDir(id)).map((one) => one.media)).toEqual(added);

    // Cut after its footage was added, before it was written down: carried on, it isn't placed or noted again.
    jobs.begin(home, "footage", id, { url, place: true, origin: "" }, importKey(id, url).split(":").at(-1)!, "importing");
    resumeImport(fx.app, footage()[0]!);
    for (let i = 0; i < 200 && footage().length > 0; i++) await Bun.sleep(25);
    expect(footage()).toEqual([]);
    expect(fx.app.store.get(id)!.project.clips.length).toBe(placed);
    expect(fx.app.store.get(id)!.project.media.length).toBe(1);
    expect(uploads.list(fx.app.store.uploadsDir(id)).length).toBe(1);

    // Cut before its footage was placed (the person cleared the timeline): placed once, as at first.
    await fx.app.store.update(id, "test", (project) => {
      project.clips = [];
    });
    jobs.begin(home, "footage", id, { url, place: true, origin: "" }, importKey(id, url).split(":").at(-1)!, "downloading");
    resumeImport(fx.app, footage()[0]!);
    for (let i = 0; i < 200 && footage().length > 0; i++) await Bun.sleep(25);
    expect(fx.app.store.get(id)!.project.clips.length).toBe(placed);

    // Cut once it was all done but crossed off: only crossed off.
    jobs.begin(home, "footage", id, { url, place: true, origin: "", media: added, paths: [], whole: false }, importKey(id, url).split(":").at(-1)!, "added");
    resumeImport(fx.app, footage()[0]!);
    expect(footage()).toEqual([]);
    expect(fx.app.store.get(id)!.project.clips.length).toBe(placed);
  } finally {
    fx.cleanup();
    restore();
    mock.stop();
  }
}, 60_000);

test("a Drive import whose download drops waits in the table and is tried again by itself, never ended with only a log line (Nov 20)", async () => {
  const mock = MockServer.start();
  const restore = mock.useEnv();
  const fx = fixtureHome("drive-import-drop");
  const waits = failure.PASSING_WAITS.value;
  failure.PASSING_WAITS.value = [0, 0, 0];
  try {
    let asked = 0;
    mock.on("GET", "/drive.usercontent.google.com/download", () => {
      asked += 1;
      return new Response("upstream connect error or disconnect/reset before headers. reset reason: connection reset", { status: 503 });
    });
    const url = "https://drive.google.com/file/d/1DropDropDropDropDrop/view";
    const id = fx.app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    const home = fx.app.store.home;
    const key = importKey(id, url);
    // Cut short by a restart mid-download, then the line drops as it carries on.
    jobs.begin(home, "footage", id, { url, place: true, origin: "" }, key.split(":").at(-1)!, "downloading");
    resumeImport(fx.app, jobs.get(home, key)!);
    for (let i = 0; i < 200 && jobs.get(home, key)?.state === "running"; i++) await Bun.sleep(25);
    const row = jobs.get(home, key)!;
    expect(row).toMatchObject({ state: "waiting", put_off: 1 });
    expect(typeof row.retry_at).toBe("number");
    // Its wait over, the table's resumer carries it on: tried again, and waits again while the line is down.
    const before = asked;
    jobs.useResumers(home, { footage: (job) => resumeImport(fx.app, job) });
    await jobs.wake(home, ["footage"]);
    for (let i = 0; i < 200 && jobs.get(home, key)?.put_off !== 2; i++) await Bun.sleep(25);
    expect(asked).toBeGreaterThan(before);
    expect(jobs.get(home, key)).toMatchObject({ state: "waiting", put_off: 2 });
  } finally {
    failure.PASSING_WAITS.value = waits;
    fx.cleanup();
    restore();
    mock.stop();
  }
}, 60_000);

// Nov 21 (audit I4): a file that came down and didn't come in ended the import whatever stopped it, and after a
// restart nothing was shown at all; the download of a file that failed stayed on the disk until the project went.

/** A two-second video, the bytes a Drive file holds. */
function video(dir: string): Uint8Array {
  const source = `${dir}/source.mp4`;
  const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x36:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-c:a", "aac", source]);
  expect(made.exitCode).toBe(0);
  return new Uint8Array(fs.readFileSync(source));
}

/** Its downloads (Drive's download address, the first byte's look included). */
const downloads = (mock: MockServer) => mock.calls("/drive.usercontent.google.com/download").length;

/** Each file sent to the cloud as a copy beside it (not the download itself), after `fails` have failed first. */
function cloudThat(dir: string, fails: unknown[]) {
  const asked: string[] = [];
  importing.hooks.importLocal = async (_cache, path, probe, name) => {
    asked.push(path);
    const failing = fails.shift();
    if (failing !== undefined) throw failing;
    const kept = `${dir}/in-the-cloud-${asked.length}.mp4`;
    fs.copyFileSync(path, kept);
    return { path: kept, name, probe, cloud: null };
  };
  return asked;
}

test.skipIf(ffmpeg === null)("a resumed Drive import whose file fails to come in for a dropped line waits, and gets it on the next try from its download: nothing downloaded twice, nothing left staged", async () => {
  const mock = MockServer.start();
  const restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  const fx = fixtureHome("drive-import-retry");
  const importLocal = importing.hooks.importLocal;
  const waits = failure.PASSING_WAITS.value;
  failure.PASSING_WAITS.value = [0, 0, 0];
  try {
    mock.driveFile("1RetryRetryRetryRetry", video(fx.dir), "Bodycam 1.mp4");
    const url = "https://drive.google.com/file/d/1RetryRetryRetryRetry/view";
    const id = fx.app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    const home = fx.app.store.home;
    const key = importKey(id, url);
    const asked = cloudThat(fx.dir, [new Error("could not reach Edit's relay: The socket connection was closed unexpectedly")]);
    // Cut short by a restart, then carried on: its file comes down, and the line drops as it goes to the cloud.
    jobs.begin(home, "footage", id, { url, place: true, origin: "" }, key.split(":").at(-1)!, "downloading");
    resumeImport(fx.app, jobs.get(home, key)!);
    for (let i = 0; i < 400 && jobs.get(home, key)?.state === "running"; i++) await Bun.sleep(25);
    const row = jobs.get(home, key)!;
    // Before: the row was crossed off and nothing said so.
    expect(row).toMatchObject({ state: "waiting", put_off: 1 });
    const staged = asked[0]!;
    expect(row.args.retry).toEqual([staged]);
    expect(fx.app.store.get(id)!.project.media.length).toBe(0);
    const downloaded = downloads(mock);
    expect(downloaded).toBeGreaterThan(0);

    // Its wait over, the table carries it on: the same download imported, placed once, noted once, the row crossed off.
    jobs.useResumers(home, { footage: (job) => resumeImport(fx.app, job) });
    await jobs.wake(home, ["footage"]);
    for (let i = 0; i < 400 && jobs.get(home, key) !== undefined; i++) await Bun.sleep(25);
    expect(jobs.get(home, key)).toBeUndefined();
    expect(asked).toEqual([staged, staged]);
    expect(downloads(mock)).toBe(downloaded);
    expect(fx.app.store.get(id)!.project.media.length).toBe(1);
    expect(fx.app.store.get(id)!.project.clips.length).toBe(2);
    expect(uploads.list(fx.app.store.uploadsDir(id)).filter((one) => one.media !== null).length).toBe(1);
    // Up in the cloud, its staged copy goes, as for an import that never failed.
    for (let i = 0; i < 200 && fs.existsSync(staged); i++) await Bun.sleep(25);
    expect(fs.existsSync(staged)).toBe(false);
  } finally {
    importing.hooks.importLocal = importLocal;
    failure.PASSING_WAITS.value = waits;
    fx.cleanup();
    restore();
    mock.stop();
  }
}, 60_000);

test.skipIf(ffmpeg === null)("a Drive import whose file only the person can change is said as before and ends, its download not left behind", async () => {
  const mock = MockServer.start();
  const restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  const fx = fixtureHome("drive-import-person");
  const importLocal = importing.hooks.importLocal;
  try {
    mock.driveFile("1PersonPersonPersonP", video(fx.dir), "Bodycam 2.mp4");
    const url = "https://drive.google.com/file/d/1PersonPersonPersonP/view";
    const id = fx.app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    const asked = cloudThat(fx.dir, [new failure.NeedsPerson("Bodycam 2.mp4 has no bytes")]);
    const [, added, errors] = await importDrive(fx.app, id, url, true, "");
    expect(added).toEqual([]);
    expect(errors).toEqual(["Bodycam 2.mp4 couldn't go to the cloud: Bodycam 2.mp4 has no bytes"]);
    expect(jobs.list(fx.app.store.home, "footage")).toEqual([]);
    // Before: the download stayed until the project was deleted.
    expect(asked.length).toBe(1);
    expect(fs.existsSync(asked[0]!)).toBe(false);
  } finally {
    importing.hooks.importLocal = importLocal;
    fx.cleanup();
    restore();
    mock.stop();
  }
}, 60_000);

test.skipIf(ffmpeg === null)("a live Drive import whose file fails for a dropped line says it's tried again, and its row waits", async () => {
  const mock = MockServer.start();
  const restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  const fx = fixtureHome("drive-import-live-retry");
  const importLocal = importing.hooks.importLocal;
  try {
    mock.driveFile("1LiveLiveLiveLiveLive", video(fx.dir), "Bodycam 3.mp4");
    const url = "https://drive.google.com/file/d/1LiveLiveLiveLiveLive/view";
    const id = fx.app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    const asked = cloudThat(fx.dir, [new Error("could not reach Edit's relay: The socket connection was closed unexpectedly")]);
    const [, added, errors] = await importDrive(fx.app, id, url, true, "");
    expect(added).toEqual([]);
    expect(errors).toEqual(["Bodycam 3.mp4 couldn't go to the cloud: could not reach Edit's relay: The socket connection was closed unexpectedly (tried again by itself)"]);
    expect(jobs.get(fx.app.store.home, importKey(id, url))).toMatchObject({ state: "waiting", args: { retry: [asked[0]] } });
    expect(fs.existsSync(asked[0]!)).toBe(true);
  } finally {
    importing.hooks.importLocal = importLocal;
    fx.cleanup();
    restore();
    mock.stop();
  }
}, 60_000);
