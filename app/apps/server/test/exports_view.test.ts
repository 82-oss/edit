// Home's Exports (exports_view.ts): this computer's exports whose files are
// still here, newest first, a file gone never listed; and "Exported" on a
// project's row from an export finished since the view was last opened, until
// it's opened again.

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import * as exportsView from "../src/exports_view.ts";
import { respond } from "../src/http/server.ts";
import { projectStatus } from "../src/reviews.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome, write } from "./helpers/home.ts";

test("lists what's still here, says what's new since the view was opened, and opening it clears that", async () => {
  const { app, home, dir, cleanup } = fixtureHome("exports-view");
  try {
    const one = app.store.create("Cops Found 3 Bodies", { width: 1920, height: 1080, fps: 30 }).project.id;
    const two = app.store.create("Real Crimes", { width: 1920, height: 1080, fps: 30 }).project.id;
    // The first look starts the view's clock: exports from before aren't new.
    const start = exportsView.viewedAt(home, 1_000);
    expect(start).toBe(1_000);
    const file = (name: string) => `${dir}/out/${name}.mp4`;
    write(file("old"), "x".repeat(10));
    write(file("new"), "x".repeat(20));
    write(file("part"), "x".repeat(5));
    fs.writeFileSync(
      `${home}/exports.json`,
      JSON.stringify({
        [one]: [
          { path: file("old"), name: "old.mp4", finished_ms: 500, frames: 900, whole: true },
          { path: file("gone"), name: "gone.mp4", finished_ms: 2_500, frames: 30, whole: true },
          { path: file("new"), name: "new.mp4", finished_ms: 3_000, frames: 62_070, whole: true },
        ],
        [two]: [{ path: file("part"), name: "part.mp4", finished_ms: 4_000, frames: 300, whole: false }],
      }),
    );
    const listed = exportsView.exportsHere(app);
    // Newest first; the file gone from this computer is nowhere.
    expect(listed.map((row) => row.path)).toEqual([file("part"), file("new"), file("old")]);
    expect(listed[1]).toMatchObject({ project: one, name: "Cops Found 3 Bodies", seconds: 2069, bytes: 20, whole: true, on_review: false, channel: null });
    // Home's "Exported": a whole export since the view was opened (a part isn't the video).
    expect([...exportsView.exportedSince(app)]).toEqual([one]);
    expect((await projectStatus(app))[one]?.exported_new).toBe(true);
    expect((await projectStatus(app))[two]?.exported_new).toBe(false);
    // Opening the view: nothing finished before it is new any more.
    const router = buildRouter();
    const ask = async (method: string, path: string) => (await respond(app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700" } }), null))!;
    const viewed = (await (await ask("POST", "/api/exports/viewed")).json()) as { viewed_ms: number };
    expect(viewed.viewed_ms).toBeGreaterThan(4_000);
    expect(exportsView.exportedSince(app).size).toBe(0);
    const answer = (await (await ask("GET", "/api/exports/list")).json()) as { viewed_ms: number; exports: { path: string }[] };
    expect(answer.viewed_ms).toBe(viewed.viewed_ms);
    expect(answer.exports.length).toBe(3);
  } finally {
    cleanup();
  }
});
