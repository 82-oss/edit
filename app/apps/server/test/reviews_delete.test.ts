// Deleting a review link for good (Sphe, Nov 1: "we need to be able to
// delete a review link"), for an edit and for a script: Repack's review goes
// (`reviews:remove`), its files under the review's prefix go from R2, and
// what this Mac kept of it is forgotten; a link deleted elsewhere is
// forgotten at the next look.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as reviews from "../src/reviews.ts";
import * as scriptReviews from "../src/writer/reviews.ts";
import * as store from "../src/writer/store.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

type Call = { path: string; args: Record<string, unknown> };

/** The relay as Edit (or Script mode, under `writer/`) calls it: Convex's answers, and R2's objects listed and deleted. */
function relay(base: string, answers: Record<string, (args: Record<string, unknown>) => unknown>, objects: Set<string>): Call[] {
  const calls: Call[] = [];
  mock.on("POST", `${base}/convex`, (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    calls.push({ path, args });
    const answer = answers[path];
    return Response.json({ status: "success", value: answer ? answer(args) : null });
  });
  mock.on("POST", `${base}/r2/list`, (request) => {
    const { prefix } = request.json<{ prefix: string }>();
    return Response.json({ objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: 1 })) });
  });
  mock.on("POST", `${base}/r2/delete`, (request) => {
    const { keys } = request.json<{ keys: string[] }>();
    for (const key of keys) objects.delete(key);
    return Response.json({ ok: true, deleted: keys.length });
  });
  return calls;
}

test("an edit's review link is deleted: Repack's review, its files on R2 and what this Mac kept; its exports stay", async () => {
  const { app, home, cleanup } = fixtureHome("review-delete");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  const other = app.store.createAs("Other", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  try {
    const version = { n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] };
    const note = (noteId: string, project: string) => ({ id: noteId, reviewId: "r", project, version: 1, ms: 0, endMs: null, text: "Cut", author: "Marc", status: "open", parentId: null, createdAt: 1, updatedAt: 1 });
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({
      cursor: 3,
      shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [version] }, [other]: { reviewId: "r2", url: "https://feedback.test/r/y", versions: [version] } },
      notes: { n1: note("n1", id), n2: note("n2", other) },
    }));
    const objects = new Set([`edit/reviews/${id}/t/video.mp4`, `edit/reviews/${id}/t/poster.jpg`, `edit/reviews/${id}/t/words.json`, `edit/reviews/${other}/t/video.mp4`]);
    const calls = relay("/v1/cloud", { "reviews:remove": () => ({ removed: true, versions: 1, notes: 1, keys: [`edit/reviews/${id}/t/video.mp4`, `edit/reviews/${id}/t/poster.jpg`] }) }, objects);
    expect(await reviews.removeLink(app, id)).toEqual({ removed: true, versions: 1, notes: 1, files: 3 });
    expect(calls).toEqual([{ path: "reviews:remove", args: { sourceId: id } }]);
    // Its files went, everything under its prefix; the other project's stayed.
    expect([...objects]).toEqual([`edit/reviews/${other}/t/video.mp4`]);
    const view = reviews.view(app, id) as { review: unknown; notes: unknown[] };
    expect([view.review, view.notes]).toEqual([null, []]);
    expect((reviews.view(app, other) as { notes: unknown[] }).notes).toHaveLength(1);
    // Nothing left to delete says so.
    await expect(reviews.removeLink(app, id)).rejects.toThrow("no review link");
  } finally {
    cleanup();
  }
});

// Found Nov 22: a share's export is kept in the cloud once, as its review's full-quality download (exports.ts
// `heldByReview`, its own archive removed as the same bytes), and deleting the link deleted every file under the
// review's prefix (and Repack queued the version's keys for its cleanup): that export lost its only cloud copy.
test("deleting a review link never takes an export's only cloud copy: one still here goes up again as its own first", async () => {
  const { app, home, dir, cleanup } = fixtureHome("review-delete-held");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  try {
    const full = `edit/reviews/${id}/t/full.mp4`;
    const file = path.join(dir, "Judge.mp4");
    fs.writeFileSync(file, "the export's bytes");
    const record = { path: file, name: "Judge.mp4", finished_ms: 1, seconds: 1, bytes: fs.statSync(file).size, frames: 300, whole: true, start: 0, format: "h264", timeline: "t", cloudKey: full };
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ [id]: [record] }));
    const version = { n: 1, timeline: "t", path: file, fps: 30, durationMs: 10_000, clips: [] };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [version] } } }));
    const objects = new Set([`edit/reviews/${id}/t/video.mp4`, full]);
    relay("/v1/cloud", { "reviews:remove": () => ({ removed: true, versions: 1, notes: 0, keys: [`edit/reviews/${id}/t/video.mp4`, full] }) }, objects);
    await reviews.removeLink(app, id);
    expect([...objects]).toEqual([]);
    // The export no longer points at the deleted copy, and its own archive is listed to go up from the file here.
    const records = JSON.parse(fs.readFileSync(`${home}/exports.json`, "utf8")) as Record<string, { path: string; cloudKey?: string }[]>;
    expect(records[id]![0]!.cloudKey).toBeUndefined();
    const jobs = await import("../src/jobs.ts");
    const archive = jobs.list(home, "archive").find((job) => job.args.output === file);
    expect(archive?.args.key).toBe(`edit/exports/${id}/Judge.mp4`);
  } finally {
    await Bun.sleep(50);
    cleanup();
  }
});

test("a review link that is an export's only copy anywhere (not on this computer) isn't deleted: it says so, nothing goes", async () => {
  const { app, home, cleanup } = fixtureHome("review-delete-only-copy");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  try {
    const full = `edit/reviews/${id}/t/full.mp4`;
    const record = { path: "/gone/Judge.mp4", name: "Judge.mp4", finished_ms: 1, seconds: 1, bytes: 10, frames: 300, whole: true, start: 0, format: "h264", timeline: "t", cloudKey: full };
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ [id]: [record] }));
    const version = { n: 1, timeline: "t", path: "/gone/Judge.mp4", fps: 30, durationMs: 10_000, clips: [] };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [version] } } }));
    const objects = new Set([full]);
    const calls = relay("/v1/cloud", { "reviews:remove": () => ({ removed: true, versions: 1, notes: 0, keys: [full] }) }, objects);
    await expect(reviews.removeLink(app, id)).rejects.toThrow('This link is the only copy in the cloud of the export "Judge.mp4", which isn\'t on this computer any more. Delete that export first if it isn\'t needed, then delete the link.');
    expect(calls).toEqual([]);
    expect([...objects]).toEqual([full]);
    expect((reviews.view(app, id) as { review: unknown }).review).not.toBeNull();
  } finally {
    cleanup();
  }
});

test("an edit's link deleted on another Mac or Repack's page is forgotten at the next look; one still on Repack stays", async () => {
  const { app, home, cleanup } = fixtureHome("review-delete-elsewhere");
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  const kept = app.store.createAs("Kept", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  try {
    const version = { n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "u1", versions: [version] }, [kept]: { reviewId: "r2", url: "u2", versions: [version] } } }));
    relay("/v1/cloud", { "reviews:changes": () => ({ notes: [], cursor: 0, more: false }), "reviews:open": () => [{ sourceId: kept, reviewId: "r2", approved: null }] }, new Set());
    await reviews.poll(app);
    expect((reviews.view(app, id) as { review: unknown }).review).toBeNull();
    expect((reviews.view(app, kept) as { review: { url: string } | null }).review?.url).toBe("u2");
  } finally {
    cleanup();
  }
});

test("a script's review link is deleted: Repack's review, its files under writer/reviews/<id>/, the script's link and the notes kept here", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "writer-review-delete-"));
  const id = "aee1652a-0000-4000-8000-000000000001";
  const dir = store.scriptDir(data, id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "script.json"), JSON.stringify({ id, title: "TEST share", status: "ready", clips: [], review: { reviewId: "r1", token: "t", url: "https://feedback.test/r/t", version: 2, revision: 4, sharedAt: 1 } }));
    fs.writeFileSync(path.join(dir, "review-text.json"), "{}");
    fs.mkdirSync(path.join(data, "reviews"), { recursive: true });
    const note = { id: "n1", reviewId: "r1", scriptId: id, version: 2, text: "Cut", author: "Ana", status: "open", createdAt: 1, updatedAt: 1 };
    fs.writeFileSync(path.join(data, "reviews", "notes.json"), JSON.stringify({ cursor: 0, notes: { n1: note, n2: { ...note, id: "n2", reviewId: "r9", scriptId: "s9" } }, links: { r1: id, r9: "s9" }, tried: { n1: 1 }, attempts: { n1: 1 }, approved: {} }));
    const objects = new Set([`writer/reviews/${id}/v1/script.json`, `writer/reviews/${id}/v2/script.json`, `writer/reviews/${id}/preview.mp4`, "writer/reviews/s9/v1/script.json"]);
    const calls = relay("/v1/cloud/writer", { "reviews:remove": () => ({ removed: true, versions: 2, notes: 1, keys: [`writer/reviews/${id}/v2/script.json`] }) }, objects);
    const after = await scriptReviews.removeLink(data, id);
    expect(calls).toEqual([{ path: "reviews:remove", args: { sourceId: id } }]);
    expect(after.review).toBeUndefined();
    expect(store.read(dir).review).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "review-text.json"))).toBe(false);
    expect([...objects]).toEqual(["writer/reviews/s9/v1/script.json"]);
    expect(scriptReviews.notesOf(data, id)).toEqual([]);
    expect(scriptReviews.notesOf(data, "s9")).toHaveLength(1);
    expect(scriptReviews.counts(data).open).toEqual({ s9: 1 });
    await expect(scriptReviews.removeLink(data, id)).rejects.toThrow("no review link");
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("a script's notes go from the badges when its link was deleted elsewhere", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "writer-review-gone-"));
  try {
    fs.mkdirSync(path.join(data, "reviews"), { recursive: true });
    const note = { id: "n1", reviewId: "r1", scriptId: "s1", version: 1, text: "Cut", author: "Ana", status: "open", createdAt: 1, updatedAt: 1 };
    fs.writeFileSync(path.join(data, "reviews", "notes.json"), JSON.stringify({ cursor: 5, notes: { n1: note, n2: { ...note, id: "n2", reviewId: "r2", scriptId: "s2" } }, links: {}, tried: {}, attempts: {}, approved: {} }));
    relay("/v1/cloud/writer", { "reviews:open": () => [{ sourceId: "s2", reviewId: "r2", approved: null }], "reviews:changes": () => ({ notes: [], cursor: 5, more: false }) }, new Set());
    expect(await scriptReviews.poll(data)).toBe(true);
    expect(scriptReviews.counts(data).open).toEqual({ s2: 1 });
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});
