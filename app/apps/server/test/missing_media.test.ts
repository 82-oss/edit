// An edit's footage that didn't come in (Sphe, Nov 18, as for a script's import): named at the top bar's cloud
// (GET /missing), export and share held with the same note, the agent told with each message, and Go on without it
// remembered per file so it's never asked again and the export goes.

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import * as diag from "../src/diag.ts";
import { exportCloud, ExportRegistry, listExports } from "../src/exports.ts";
import { respond } from "../src/http/server.ts";
import { messageContext } from "../src/media_tools.ts";
import { mediaHooks } from "../src/media.ts";
import * as jobs from "../src/jobs.ts";
import * as missingMedia from "../src/missing_media.ts";
import type { Media } from "../src/model.ts";
import { findAddon, native, useNative, wrap, type Native } from "../src/native/index.ts";
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

test("only footage that truly didn't come in holds an export: never cloud footage not fetched yet, a stand-in or what Edit renders itself", async () => {
  const { app, store, id, cleanup } = await withProject("edit-made-here");
  const asked = mediaHooks.keyAnswers;
  // The cloud has every proxy but one.
  mediaHooks.keyAnswers = async (key) => key !== "edit/proxies/gone.mp4";
  try {
    const own = store.uploadsDir(id);
    const streamed = (key: string) => `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(key)}`;
    const cloudOf = (proxy: string) => ({ source: `drive:${proxy}`, original: `edit/originals/${proxy}`, proxy, size: 1 });
    const kept = [
      // In the cloud, not on this Mac yet: it comes when it's needed.
      { ...media("cloud", join(own, "not-yet.mp4")), cloud: cloudOf("edit/proxies/here.mp4") },
      // Streamed, its proxy in the cloud; a pieced proxy's address is no object of its own.
      { ...media("streamed", streamed("edit/proxies/here.mp4")), cloud: cloudOf("edit/proxies/here.mp4") },
      { ...media("pieced", streamed("edit/pieces/v3/drive/abc/proxy.mp4")), cloud: cloudOf("edit/pieces/v3/drive/abc/proxy.mp4") },
      // Edit's own: an effect's still not rendered yet, a map shot's stand-in and render, smoothed slow motion, a strip with words taken out.
      { ...media("effect", join(own, "board.clear.png")), effect: "board" },
      media("map", join(own, "maps", "map-k1-first.jpg")),
      media("smooth", join(own, "smooth", "c1.mp4")),
      { ...media("strip", join(app.store.cacheDir(), "cleaned", "s.mp4")), cleans: { media: "m1", from: 0, to: 1, box: [0, 0, 1, 1] } },
    ] as Media[];
    // Streamed, but the cloud lacks its proxy: it can't play anywhere.
    const lost = { ...media("lost", streamed("edit/proxies/gone.mp4")), cloud: cloudOf("edit/proxies/gone.mp4") } as Media;
    await store.update(id, "test", (p) => {
      p.media.push(...kept, lost);
      for (const [at, one] of [...kept, lost].entries()) p.clips.push({ type: "video", id: `k${at}`, track: "v1", media: one.id, start: 60 + at * 5, duration: 5, source_in: 0, speed: 1 } as never);
    });
    const { missing } = await missingMedia.missingOf(app.store.home, store.get(id)!.project);
    expect(missing.map((one) => one.id).sort()).toEqual(["lost", "m2"]);
  } finally {
    mediaHooks.keyAnswers = asked;
    cleanup();
  }
});

test("the note's words", () => {
  expect(missingMedia.line([{ name: "a.mp4" }, { name: "b.mp4" }, { name: "c.mp4" }])).toBe("3 files didn't come in: a.mp4, b.mp4 and c.mp4");
});

test("an edit's missing footage waits in the job table, its tries counted there, and the row ends once it's all here", async () => {
  const { app, store, id, cleanup } = await withProject("edit-missing-row");
  try {
    await store.update(id, "test", (p) => {
      p.media.push({ id: "gone", name: "gone.mp4", path: "/nowhere/gone.mp4", kind: "video", duration: 10, width: 64, height: 36, fps: 30, has_audio: false } as Media);
      p.clips.push({ type: "video", id: "gone-clip", track: "v1", media: "gone", start: 300, duration: 30, source_in: 0, speed: 1 } as never);
    });
    const shown = await missingMedia.state(app, id);
    expect(shown.missing.map((one) => one.id)).toContain("gone");
    const key = jobs.keyOf("media", id);
    const row = jobs.get(app.store.home, key)!;
    expect(row).toMatchObject({ state: "waiting", args: { waiting_on: "passing", tries: 0 } });
    expect(row.retry_at! - Date.now()).toBeGreaterThan(55_000);
    // Asked again: still not here, the next try further off.
    await missingMedia.tryAgain(app, id);
    const again = jobs.get(app.store.home, key)!;
    expect(again.args.tries).toBe(1);
    expect(again.retry_at! - Date.now()).toBeGreaterThan(4 * 60_000);
    // Taken out of the edit (and anything else of it not here): nothing missing, the row ends.
    const missingIds = new Set(shown.missing.map((one) => one.id));
    await store.update(id, "test", (p) => void (p.clips = p.clips.filter((clip) => !("media" in clip) || !missingIds.has(String(clip.media)))));
    await missingMedia.tryAgain(app, id);
    expect(jobs.get(app.store.home, key)).toBeUndefined();
  } finally {
    cleanup();
  }
});

// Nov 18, JJ: after "Go on without it" the edit must still play and export. Its export failed on the file it no longer
// had ("the edit uses files that aren't on this machine"): now that footage plays nothing, its time kept.
test("footage gone without plays nothing in what's rendered, its time kept: its pictures empty cards, its sound left out", async () => {
  const { app, store, id, cleanup } = await withProject("edit-playable");
  try {
    await store.update(id, "test", (p) => {
      const audio = p.tracks.find((track) => track.kind === "audio")!.id;
      p.clips.push({ type: "audio", id: "a2", track: audio, media: "m2", start: 30, duration: 30, source_in: 0, speed: 1, volume_db: 0 } as never);
    });
    const before = store.get(id)!.project;
    // Nothing gone without: the same project.
    expect(missingMedia.playable(app.store.home, before)).toBe(before);
    missingMedia.goWithout(app, id, "m2");
    const project = store.get(id)!.project;
    const shown = missingMedia.playable(app.store.home, project);
    expect(shown.clips.map((clip) => [clip.id, clip.type, clip.start, clip.duration])).toEqual([["c1", "video", 0, 30], ["c2", "solid", 30, 30]]);
    expect(shown.clips[1]).toMatchObject({ fill: [0, 0, 0, 0], opacity: 0 });
    expect("media" in shown.clips[1]!).toBe(false);
    // The edit itself is untouched: the person's clips stay.
    expect(store.get(id)!.project.clips.map((clip) => clip.id)).toEqual(["c1", "c2", "a2"]);
    // Its file back here: it plays again.
    fs.mkdirSync(join(store.get(id)!.project.media.find((one) => one.id === "m2")!.path, ".."), { recursive: true });
    fs.writeFileSync(store.get(id)!.project.media.find((one) => one.id === "m2")!.path, "back");
    expect(missingMedia.playable(app.store.home, store.get(id)!.project).clips.map((clip) => clip.type)).toEqual(["video", "video", "audio"]);
  } finally {
    cleanup();
  }
});

const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
const addon = findAddon();
test.skipIf(ffmpeg === null || ffprobe === null || addon === null)("an edit gone on without exports whole on the real engine: the rest plays, the gap its own length", async () => {
  const fixture = fixtureHome("edit-gone-export");
  const { dir, home, store, app } = fixture;
  const before = useNative(wrap(require(addon!) as Native));
  native().init({ home, cacheDir: store.cacheDir(), ffmpeg: ffmpeg!, ffprobe: ffprobe!, log: diag.nativeLog });
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "1";
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const registry = new ExportRegistry(home);
  app.exports = registry;
  try {
    const shot = join(dir, "shot.mp4");
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", shot]);
    expect(made.exitCode).toBe(0);
    const id = store.create("gone", { width: 160, height: 90, fps: 30 }).project.id;
    await store.update(id, "test", (p) => {
      const video = p.tracks[0]!.id;
      const audio = p.tracks.find((track) => track.kind === "audio")!.id;
      p.media.push({ ...media("m1", shot), width: 160, height: 90, duration: 3 }, { ...media("m2", join(dir, "gone", "interview.mp4")), width: 160, height: 90, duration: 3 });
      // The door footage, then the interview that's gone, then the door again: two seconds each.
      for (const [at, one] of ["m1", "m2", "m1"].entries()) {
        p.clips.push({ type: "video", id: `v${at}`, track: video, media: one, start: at * 60, duration: 60, source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as never);
        p.clips.push({ type: "audio", id: `a${at}`, track: audio, media: one, start: at * 60, duration: 60, source_in: 0, speed: 1, volume_db: 0 } as never);
      }
    });
    // Asked about, then gone without: the export goes.
    expect((await missingMedia.missingOf(home, store.get(id)!.project)).missing.map((one) => one.id)).toEqual(["m2"]);
    missingMedia.goWithout(app, id, "m2");
    const out = join(dir, "gone.mp4");
    await registry.start(store, app.library, store.get(id)!.project, native().exportDefaults(), out, { drive: false, keepLocal: true });
    for (let tries = 0; registry.running() && tries < 1200; tries++) await Bun.sleep(50);
    const [record] = listExports(home, id);
    expect(record?.path).toBe(out);
    const probed = Bun.spawnSync([ffprobe!, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out]);
    expect(Math.abs(Number(probed.stdout.toString().trim()) - 6)).toBeLessThan(0.2);
  } finally {
    archive.mockRestore();
    if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
    else process.env.EDIT_LOCAL_EXPORTS = most;
    if (before !== null) useNative(before);
    fixture.cleanup();
  }
}, 120_000);
