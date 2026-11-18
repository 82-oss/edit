// An edit's footage that didn't come in (Sphe, Nov 18, as for a script's import): named at the top bar's cloud
// (GET /missing), export and share held with the same note, the agent told with each message, and Go on without it
// remembered per file so it's never asked again and the export goes.

import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { ExportRegistry } from "../src/exports.ts";
import { respond } from "../src/http/server.ts";
import { messageContext } from "../src/media_tools.ts";
import * as missingMedia from "../src/missing_media.ts";
import type { Media } from "../src/model.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };
const media = (id: string, path: string): Media => ({ id, name: `${id}.mp4`, path, kind: "video", duration: 5, width: 1920, height: 1080, fps: 30, has_audio: true }) as Media;

afterEach(() => missingMedia.stop());
afterAll(() => missingMedia.stop());

async function withProject(name: string) {
  const fixture = fixtureHome(name);
  const here = join(fixture.dir, "here.mp4");
  fs.writeFileSync(here, "footage");
  const id = fixture.store.create("p", SETTINGS).project.id;
  await fixture.store.update(id, "test", (p) => {
    p.media.push(media("m1", here), media("m2", join(fixture.dir, "gone", "CH03.mp4")), media("m3", join(fixture.dir, "unused.mp4")));
    p.clips.push({ type: "video", id: "c1", track: "v1", media: "m1", start: 0, duration: 30, source_in: 0, speed: 1 } as never, { type: "video", id: "c2", track: "v1", media: "m2", start: 30, duration: 30, source_in: 0, speed: 1 } as never);
  });
  return { ...fixture, id };
}

const ask = async (app: Parameters<typeof respond>[0], method: string, path: string) => {
  const answer = (await respond(app, buildRouter(), new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700" } }), null))!;
  return (await answer.json()) as { used: number; missing: { id: string; name: string }[] };
};

test("footage the timeline uses that isn't here is named, holds the export, and is told to the agent; Go on without it is remembered", async () => {
  const { app, store, id, cleanup } = await withProject("edit-missing");
  try {
    const said = await ask(app, "GET", `/api/projects/${id}/missing`);
    expect(said.used).toBe(2);
    expect(said.missing.map((one) => one.id)).toEqual(["m2"]);
    const project = store.get(id)!.project;
    expect(await missingMedia.held(app.store.home, project)).toBe("The export waits: 1 file didn't come in: m2.mp4. Retry it at the cloud in the top bar, or go on without it there.");
    // The export itself waits, whoever asks for it.
    await expect(new ExportRegistry(app.store.home).start(app.store, app.library, project, app.native.exportDefaults(), join(app.store.home, "out.mp4"))).rejects.toThrow("1 file didn't come in: m2.mp4");
    expect(await messageContext(app, id, null, false)).toContain("FOOTAGE MISSING: 1 file didn't come in: m2.mp4");
    // Retry now: still not here, still said.
    expect((await ask(app, "POST", `/api/projects/${id}/missing/retry`)).missing.map((one) => one.id)).toEqual(["m2"]);

    const after = await ask(app, "POST", `/api/projects/${id}/missing/m2/without`);
    expect(after.missing).toEqual([]);
    expect(missingMedia.waived(app.store.home, id)).toEqual(["m2"]);
    expect(await missingMedia.held(app.store.home, store.get(id)!.project)).toBeNull();
    // The agent still knows the gap is there, so it isn't cut around unsaid.
    const told = await messageContext(app, id, null, false);
    expect(told).not.toContain("FOOTAGE MISSING");
    expect(told).toContain("went on without m2.mp4");
    // Asked again: never named again.
    expect((await ask(app, "GET", `/api/projects/${id}/missing`)).missing).toEqual([]);
  } finally {
    cleanup();
  }
});

test("a project whose footage is all here says nothing and holds nothing", async () => {
  const { app, store, id, cleanup } = await withProject("edit-whole");
  try {
    await store.update(id, "test", (p) => {
      p.clips = p.clips.filter((clip) => clip.id !== "c2");
    });
    expect((await ask(app, "GET", `/api/projects/${id}/missing`)).missing).toEqual([]);
    expect(await missingMedia.held(app.store.home, store.get(id)!.project)).toBeNull();
    expect(await missingMedia.forAgent(app.store.home, store.get(id)!.project)).toBe("");
  } finally {
    cleanup();
  }
});

test("the note's words", () => {
  expect(missingMedia.line([{ name: "a.mp4" }, { name: "b.mp4" }, { name: "c.mp4" }])).toBe("3 files didn't come in: a.mp4, b.mp4 and c.mp4");
  expect([0, 1, 2, 3].map(missingMedia.delayAfter)).toEqual([60_000, 300_000, 900_000, 3_600_000]);
});
