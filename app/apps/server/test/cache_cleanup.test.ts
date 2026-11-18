import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { createHash } from "node:crypto";

import { cleanCache, cleanCloudPreviews, cleanPass, ownerToken } from "../src/cache_cleanup.ts";
import { ledger } from "../src/storage.ts";
import { pin } from "../src/export_excerpts.ts";
import { forget, markOpened } from "../src/opened.ts";
import { PLAYBACK_ROUTE, playbackPath } from "../src/cloud_playback.ts";
import * as localPreviews from "../src/local_previews.ts";
import { nativeSources } from "../src/native_preview.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

test("the cache loses rebuildable files of media nobody uses and old half-written ones, never paid analysis or what's in use", async () => {
  const { dir, app, store, cleanup } = fixtureHome("cache-clean");
  try {
    const cache = store.cacheDir();
    const footage = `${dir}/used.mp4`;
    fs.writeFileSync(footage, "x");
    const live = store.create("p", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project);
    project.media = [{ id: "m1", name: "used.mp4", path: footage, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
    await store.replace(project.id, null, project, "test");
    const usedKey = app.native.mediaKey(footage);
    const old = Date.now() - 3 * 24 * 3600 * 1000;
    const put = (path: string, bytes: number, at = old) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, Buffer.alloc(bytes));
      fs.utimesSync(path, at / 1000, at / 1000);
    };
    // Used: everything stays but an old half-written file.
    put(`${cache}/${usedKey}/preview.mp4`, 10);
    put(`${cache}/${usedKey}/preview.partial.mp4.sb-a0dac0bf-H5wfgu`, 20);
    // Nobody's: the previews go, the transcript and watch answers stay.
    const gone = "0123456789abcdef";
    put(`${cache}/${gone}/preview.mp4`, 30);
    put(`${cache}/${gone}/preview-light.mp4`, 40);
    put(`${cache}/${gone}/thumbs.jpg`, 5);
    put(`${cache}/${gone}/transcript.json`, 7);
    put(`${cache}/${gone}/watch/abc.json`, 3);
    // Nobody's but touched just now: stays.
    put(`${cache}/fedcba9876543210/preview.mp4`, 50, Date.now());
    // An export's leftover chunks go after a few days (a share's review pieces too); its manifest and fresh ones stay.
    const p = project.id;
    put(`${cache}/export-chunks/${p}/0123.mp4`, 11);
    put(`${cache}/export-chunks/${p}/4567.mp4`, 13, Date.now());
    put(`${cache}/export-chunks/${p}/manifest-v1.json`, 2);
    put(`${cache}/export-chunks/${p}/sound/89ab.aac`, 17);
    put(`${cache}/export-chunks/${p}/sound/cdef.aac`, 19, Date.now());
    put(`${cache}/export-chunks/${p}/review/0a1b.mp4`, 23);
    put(`${cache}/export-chunks/${p}/review/2c3d.mp4`, 29, Date.now());
    // A failed share's review copy goes after a few days; its poster and a fresh one stay.
    put(`${cache}/reviews/${p}/old.mp4`, 7);
    put(`${cache}/reviews/${p}/old.jpg`, 3);
    put(`${cache}/reviews/${p}/new.mp4`, 9, Date.now());
    const dry = cleanCache(app, true);
    expect(dry.bytes).toBe(20 + 30 + 40 + 5 + 11 + 17 + 23 + 7);
    expect(fs.existsSync(`${cache}/${gone}/preview.mp4`)).toBe(true);
    const done = cleanCache(app, false);
    expect(fs.existsSync(`${cache}/export-chunks/${p}/0123.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/export-chunks/${p}/4567.mp4`)).toBe(true);
    expect(fs.existsSync(`${cache}/export-chunks/${p}/sound/89ab.aac`)).toBe(false);
    expect(fs.existsSync(`${cache}/export-chunks/${p}/sound/cdef.aac`)).toBe(true);
    expect(fs.existsSync(`${cache}/export-chunks/${p}/manifest-v1.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/reviews/${p}/old.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/reviews/${p}/old.jpg`)).toBe(true);
    expect(fs.existsSync(`${cache}/reviews/${p}/new.mp4`)).toBe(true);
    expect(fs.existsSync(`${cache}/export-chunks/${p}/review/0a1b.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/export-chunks/${p}/review/2c3d.mp4`)).toBe(true);
    expect(done.bytes).toBe(153);
    expect(fs.existsSync(`${cache}/${usedKey}/preview.mp4`)).toBe(true);
    expect(fs.existsSync(`${cache}/${usedKey}/preview.partial.mp4.sb-a0dac0bf-H5wfgu`)).toBe(false);
    expect(fs.existsSync(`${cache}/${gone}/preview.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/${gone}/transcript.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/${gone}/watch/abc.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/fedcba9876543210/preview.mp4`)).toBe(true);
  } finally {
    cleanup();
  }
});

test("a Drive download goes days after its last export, never one a project uses or a file of the user's", async () => {
  const { dir, app, store, cleanup } = fixtureHome("cache-drive");
  try {
    const cache = store.cacheDir();
    const live = store.create("p", { width: 1920, height: 1080, fps: 30 });
    const uploads = store.uploadsDir(live.project.id);
    const make = (path: string) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, "video");
      return path;
    };
    const old = make(`${uploads}/drive/1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ/Old.mp4`);
    const fresh = make(`${uploads}/drive/1v-D25jVesJWbr72fktxOvccIIeX11aHz/Fresh.mp4`);
    const theirs = make(`${dir}/Movies/drive/1abcdefghijk/Mine.mp4`);
    const inUse = make(`${uploads}/drive/1zzzzzzzzzzzz/Used.mp4`);
    const project = structuredClone(live.project);
    project.media = [{ id: "m1", name: "Used.mp4", path: inUse, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
    await store.replace(project.id, null, project, "test");
    for (const [key, path] of [["a", old], ["b", fresh], ["c", theirs], ["d", inUse]] as const) {
      cloudMedia.rememberLocalOriginal(cache, `edit/originals/sha256/${key}/x.mp4`, path);
    }
    // Four days pass for all but the fresh one, which an export just read.
    const later = Date.now() + 4 * 24 * 3600 * 1000;
    const known = cloudMedia.readLocalOriginals(cache);
    known["edit/originals/sha256/b/x.mp4"]!.used_ms = later;
    cloudMedia.writeLocalOriginals(cache, known);
    cleanCache(app, false, later);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(theirs)).toBe(true);
    expect(fs.existsSync(inUse)).toBe(true);
    expect(Object.keys(cloudMedia.readLocalOriginals(cache)).sort()).toEqual(["edit/originals/sha256/b/x.mp4", "edit/originals/sha256/c/x.mp4", "edit/originals/sha256/d/x.mp4"]);
  } finally {
    cleanup();
  }
});

test("legacy previews by project state: a project left 9 days lets its go at any pass, one left 5 days only for room, one saved today never; paid analysis stays", async () => {
  const { dir, app, store, cleanup } = fixtureHome("cache-limit");
  try {
    const cache = store.cacheDir();
    const day = 24 * 3600 * 1000;
    const projects = store.home + "/projects";
    // Three projects, saved 9, 5 and 0 days ago, each with its own footage.
    const keys: string[] = [];
    for (const [name, daysAgo] of [["oldest", 9], ["older", 5], ["recent", 0]] as const) {
      const footage = `${dir}/${name}.mp4`;
      fs.writeFileSync(footage, name);
      const live = store.create(name, { width: 1920, height: 1080, fps: 30 });
      const project = structuredClone(live.project);
      project.media = [{ id: "m1", name: `${name}.mp4`, path: footage, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
      await store.replace(project.id, null, project, "test");
      const at = (Date.now() - daysAgo * day) / 1000;
      fs.utimesSync(`${projects}/${project.id}.json`, at, at);
      const key = app.native.mediaKey(footage);
      keys.push(key);
      fs.mkdirSync(`${cache}/${key}`, { recursive: true });
      fs.writeFileSync(`${cache}/${key}/preview.mp4`, Buffer.alloc(1000));
      fs.writeFileSync(`${cache}/${key}/preview.done`, "");
      // Made when the project was (a preview made just now is never trimmed).
      for (const made of ["preview.mp4", "preview.done"]) fs.utimesSync(`${cache}/${key}/${made}`, at, at);
      fs.writeFileSync(`${cache}/${key}/transcript.json`, Buffer.alloc(10));
    }
    const [oldest, older, recent] = keys as [string, string, string];
    // Plenty of room: the one left 9 days (let go, as a done one is) gives its previews up; the others keep theirs.
    const dry = cleanCache(app, true, Date.now(), { freeBytes: 0, free: 1e12 });
    expect(dry.bytes).toBe(1000);
    expect(fs.existsSync(`${cache}/${oldest}/preview.mp4`)).toBe(true);
    cleanCache(app, false, Date.now(), { freeBytes: 0, free: 1e12 });
    expect(fs.existsSync(`${cache}/${oldest}/preview.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/${oldest}/preview.done`)).toBe(false);
    expect(fs.existsSync(`${cache}/${oldest}/transcript.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/${older}/preview.mp4`)).toBe(true);
    // Room wanted: the one left 5 days (idle) gives its up too, never the one in work.
    cleanCache(app, false, Date.now(), { freeBytes: 2e12, free: 1e12 });
    expect(fs.existsSync(`${cache}/${older}/preview.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/${older}/transcript.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/${recent}/preview.mp4`)).toBe(true);
  } finally {
    cleanup();
  }
});

test("with a project's footage missing, no media folder is taken for unused; a hard-linked preview counts once", async () => {
  const { dir, app, store, cleanup } = fixtureHome("cache-unplugged");
  try {
    const cache = store.cacheDir();
    const live = store.create("Case", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project);
    project.media = [{ id: "m1", name: "a.mp4", path: "/Volumes/LaCie/gone/a.mp4", kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
    await store.replace(project.id, null, project, "test");
    // Some folder no project's key names: with a file missing, it may be that one's.
    const stray = `${cache}/0123456789abcdef`;
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(`${stray}/preview.mp4`, Buffer.alloc(500));
    fs.linkSync(`${stray}/preview.mp4`, `${stray}/proxy.mp4`);
    const old = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(`${stray}/preview.mp4`, old, old);
    expect(cleanCache(app, true).files).toBe(0);
    expect(fs.existsSync(`${stray}/preview.mp4`)).toBe(true);
    // The footage back: now it's plainly unused, and its 500 bytes are counted once.
    project.media = [];
    await store.replace(project.id, null, project, "test");
    const report = cleanCache(app, true);
    expect(report.bytes).toBe(500);
    void dir;
  } finally {
    cleanup();
  }
});

test("copies no project uses go for room, oldest first; recent ones stay", () => {
  const { app, store, cleanup } = fixtureHome("cache-cloud");
  try {
    const cache = store.cacheDir();
    const old = (Date.now() - 5 * 24 * 3600 * 1000) / 1000;
    const put = (path: string, bytes: number, at?: number) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, Buffer.alloc(bytes));
      if (at !== undefined) fs.utimesSync(path, at, at);
    };
    put(`${cache}/cloud/proxies/drive/old.mp4`, 1000, old);
    put(`${cache}/cloud/proxies/drive/new.mp4`, 1000);
    // Room enough: nothing.
    expect(cleanCache(app, true, Date.now(), { freeBytes: 0, free: 1e12 }).bytes).toBe(0);
    const dry = cleanCache(app, true, Date.now(), { freeBytes: 1e12 + 1500, free: 1e12 });
    expect(dry.bytes).toBe(1000);
    expect(fs.existsSync(`${cache}/cloud/proxies/drive/old.mp4`)).toBe(true);
    cleanCache(app, false, Date.now(), { freeBytes: 1e12 + 1500, free: 1e12 });
    expect(fs.existsSync(`${cache}/cloud/proxies/drive/old.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/cloud/proxies/drive/new.mp4`)).toBe(true);
  } finally { cleanup(); }
});

test("cloud-only cleanup verifies R2 and removes legacy previews and their aliases; the whole proxy copy, paid analysis and pending uploads stay", async () => {
  const { app, store, cleanup } = fixtureHome("cache-streamed");
  try {
    const cache = store.cacheDir();
    const key = "edit/proxies/sha256/abc.mp4";
    const local = cloudMedia.localPath(cache, key);
    fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(local, "video");
    const alias = app.native.mediaKey(local);
    const legacy = "0123456789abcdef";
    const put = (name: string, bytes: string) => {
      fs.mkdirSync(name.slice(0, name.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(name, bytes);
    };
    put(`${cache}/${alias}/preview.mp4`, "preview");
    put(`${cache}/${alias}/transcript.json`, '{"words":[]}');
    put(`${cache}/${alias}/watch/keys.json`, JSON.stringify({ keys: [legacy] }));
    put(`${cache}/${legacy}/preview-light.mp4`, "light");
    put(`${cache}/${legacy}/watch/answer.json`, "paid answer");
    const id = store.create("cloud", { width: 1920, height: 1080, fps: 30 }).project.id;
    await store.update(id, "test", (project) => {
      project.media.push({ id: "m1", name: "clip", path: local, kind: "video", duration: 1, fps: 30, width: 2, height: 2, has_audio: false,
        cloud: { source: "sha256:abc", original: "edit/originals/sha256/abc/a.mov", proxy: key, size: 10 } });
    });
    const head = async () => ({ size: 5 });
    // The two legacy previews; never the whole copy, though R2 has it at its size.
    expect((await cleanCloudPreviews(app, true, head)).files).toBe(2);
    // A missing cloud copy, or an unreachable cloud, is not permission to delete.
    expect((await cleanCloudPreviews(app, false, async () => null)).files).toBe(0);
    expect((await cleanCloudPreviews(app, false, async () => { throw new Error("offline"); })).files).toBe(0);
    // An unreadable jobs file: any copy might be an upload's, so nothing goes.
    fs.writeFileSync(`${store.home}/jobs.json`, "{");
    expect((await cleanCloudPreviews(app, false, head)).files).toBe(0);
    fs.writeFileSync(`${store.home}/jobs.json`, JSON.stringify([{ kind: "upload", args: { local } }]));
    expect((await cleanCloudPreviews(app, false, head)).files).toBe(2);
    expect(fs.existsSync(`${cache}/${alias}/preview.mp4`) || fs.existsSync(`${cache}/${legacy}/preview-light.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/${legacy}/watch/answer.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/${alias}/transcript.json`)).toBe(true);
    const target = app.media.paths(playbackPath(key, app.port)).transcript;
    expect(fs.readFileSync(target, "utf8")).toBe('{"words":[]}');
    fs.writeFileSync(`${store.home}/jobs.json`, "[]");
    expect((await cleanCloudPreviews(app, false, head)).files).toBe(0);
    expect(fs.existsSync(local)).toBe(true);
  } finally { cleanup(); }
});

test("a whole preview the native player reads stays through every clean with room; short of it, the idle project gives its up, never the one in work, and the player streams it and fetches it again", async () => {
  const { app, store, cleanup } = fixtureHome("cache-native-copies");
  const fetched: string[] = [];
  const fetch = spyOn(localPreviews.hooks, "fetch").mockImplementation(async (key) => { fetched.push(key); });
  try {
    const cache = store.cacheDir();
    const hour = 3600 * 1000;
    const old = (Date.now() - 5 * 24 * hour) / 1000;
    const ids: Record<string, string> = {};
    const copies: Record<string, string> = {};
    const proxies: Record<string, string> = {};
    for (const name of ["open", "stale"]) {
      const id = store.create(name, { width: 1920, height: 1080, fps: 30 }).project.id;
      const proxy = `edit/proxies/drive/${name}File01.mp4`;
      await store.update(id, "test", (project) => {
        project.media.push({ id: "m1", name: `${name}.mp4`, path: playbackPath(proxy, app.port), kind: "video", duration: 1, fps: 30, width: 2, height: 2, has_audio: false,
          cloud: { source: `drive:${name}File01`, original: `edit/originals/drive/${name}File01/${name}.mp4`, proxy, size: 1000 } });
        project.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "m1", start: 0, duration: 30, source_in: 0 }));
      });
      const local = cloudMedia.localPath(cache, proxy);
      fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(local, Buffer.alloc(1000));
      fs.utimesSync(local, old, old);
      ids[name] = id;
      copies[name] = local;
      proxies[name] = proxy;
    }
    const sources = async (name: string) =>
      ((await (await nativeSources(app, store.get(ids[name]!)!.project)).json()) as { sources: Record<string, string> }).sources.m1;
    // The native player reads both from here.
    expect(await sources("open")).toBe(copies.open!);
    expect(await sources("stale")).toBe(copies.stale!);
    markOpened(store.home, ids.open!, Date.now() - hour);
    markOpened(store.home, ids.stale!, Date.now() - 72 * hour);
    // Not saved since it was last opened, three days ago.
    const days = (Date.now() - 72 * hour) / 1000;
    fs.utimesSync(`${store.home}/projects/${ids.stale!}.json`, days, days);
    // R2 has both at their size, and the disk has room: both stay.
    expect((await cleanCloudPreviews(app, false, async () => ({ size: 1000 }))).files).toBe(0);
    expect(cleanCache(app, false, Date.now(), { freeBytes: 0, free: 1e12 }).files).toBe(0);
    expect(fs.existsSync(copies.open!) && fs.existsSync(copies.stale!)).toBe(true);
    // Short of room: the one opened three days ago (idle) goes; the one open an hour ago (in work) stays, however short.
    const heard: unknown[] = [];
    const stop = store.subscribe((event) => heard.push(event));
    const report = cleanCache(app, false, Date.now(), { freeBytes: 2e12, free: 1e12 });
    stop();
    // The window reading it hears so (its page asks for its sources again), not at its next jump.
    expect(heard).toContainEqual({ type: "native-sources", id: ids.stale });
    expect(heard).not.toContainEqual({ type: "native-sources", id: ids.open });
    expect(report.removed).toContain(copies.stale!);
    expect(fs.existsSync(copies.stale!)).toBe(false);
    expect(fs.existsSync(copies.open!)).toBe(true);
    // Gone from under it: the player is handed the stream, not the dead path, and the whole file comes down again.
    expect(fetched).toEqual([]);
    expect(await sources("stale")).toBe(`http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(proxies.stale!)}`);
    expect(fetched).toEqual([proxies.stale!]);
    expect(await sources("open")).toBe(copies.open!);
  } finally { fetch.mockRestore(); localPreviews.reset(); forget(store.home); cleanup(); }
});

test("short of room, a proxy made here whose upload hasn't landed stays", () => {
  const { app, store, cleanup } = fixtureHome("cache-pending-proxy");
  try {
    const cache = store.cacheDir();
    const old = (Date.now() - 5 * 24 * 3600 * 1000) / 1000;
    const local = cloudMedia.localPath(cache, "edit/proxies/sha256/up.mp4");
    fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(local, Buffer.alloc(1000));
    fs.utimesSync(local, old, old);
    const limits = { freeBytes: 2e12, free: 1e12 };
    fs.writeFileSync(`${store.home}/jobs.json`, JSON.stringify([{ kind: "upload", args: { local } }]));
    cleanCache(app, false, Date.now(), limits);
    expect(fs.existsSync(local)).toBe(true);
    fs.writeFileSync(`${store.home}/jobs.json`, "[]");
    cleanCache(app, false, Date.now(), limits);
    expect(fs.existsSync(local)).toBe(false);
  } finally { cleanup(); }
});

test("a missing cloud proxy does not block orphan cleanup, but a missing local-only file still protects its previews", async () => {
  const { app, store, cleanup } = fixtureHome("cache-cloud-missing");
  try {
    const id = store.create("cloud", { width: 2, height: 2, fps: 30 }).project.id;
    await store.update(id, "test", (project) => {
      project.media.push({ id: "m1", name: "cloud", path: "/not/here.mp4", kind: "video", duration: 1, fps: 30, width: 2, height: 2, has_audio: false,
        cloud: { source: "sha256:abc", original: "edit/originals/sha256/abc/a.mov", proxy: "edit/proxies/sha256/abc.mp4", size: 1 } });
    });
    const path = `${store.cacheDir()}/0123456789abcdef/preview.mp4`;
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, "video");
    const old = (Date.now() - 5 * 86400_000) / 1000;
    fs.utimesSync(path, old, old);
    expect(cleanCache(app, true).files).toBe(1);
    await store.update(id, "test", (project) => { delete project.media[0]!.cloud; });
    expect(cleanCache(app, true).files).toBe(0);
  } finally { cleanup(); }
});

test("smoothed shots, YouTube downloads and library sounds nobody uses go after two days; used ones, a script's original and new ones stay", async () => {
  const { app, store, cleanup } = fixtureHome("cache-generated");
  try {
    const live = store.create("p", { width: 1920, height: 1080, fps: 30 });
    const media = `${app.store.home}/media`;
    const make = (path: string) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, "video");
      return path;
    };
    const oldSmooth = make(`${media}/${live.project.id}/smooth/Shot 0h0m1s-0h0m3s-0.5x-ab12.mp4`);
    const usedSmooth = make(`${media}/${live.project.id}/smooth/Shot 0h0m4s-0h0m6s-0.5x-cd34.mp4`);
    const youtube = make(`${media}/drive/youtube/jNQXAC9IVRw/Me at the zoo [jNQXAC9IVRw].mp4`);
    const scriptOriginal = make(`${media}/drive/youtube/dQw4w9WgXcQ/Song [dQw4w9WgXcQ].mp4`);
    const sound = make(`${app.store.home}/library/music/0123456789ab/Bed.mp3`);
    const theirs = make(`${media}/${live.project.id}/My cut.mp4`);
    const project = structuredClone(live.project);
    project.media = [{ id: "m1", name: "Shot", path: usedSmooth, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
    await store.replace(project.id, null, project, "test");
    // A script whose original is the shared YouTube download itself.
    const scriptDir = `${app.store.home}/writer/scripts/4f6c2a1e-0b7d-4c3e-9a5f-2d8e1b6c7a90`;
    make(`${scriptDir}/x`);
    fs.writeFileSync(`${scriptDir}/script.json`, JSON.stringify({ id: "4f6c2a1e-0b7d-4c3e-9a5f-2d8e1b6c7a90", title: "S", originalPath: scriptOriginal, words: [], clips: [] }));
    cleanCache(app, false, Date.now() + 3600 * 1000);
    expect([oldSmooth, youtube, sound].map((path) => fs.existsSync(path))).toEqual([true, true, true]);
    cleanCache(app, false, Date.now() + 3 * 24 * 3600 * 1000);
    expect([oldSmooth, usedSmooth, youtube, scriptOriginal, sound, theirs].map((path) => fs.existsSync(path))).toEqual([false, true, false, true, false, true]);
  } finally {
    cleanup();
  }
});

test("cloud copies go by project state: a done project's at any pass; for room, footage nobody uses, then an idle project's; an edit in progress keeps its own until the disk is all but full", async () => {
  const { app, store, cleanup } = fixtureHome("cache-by-project");
  try {
    const cache = store.cacheDir();
    const hour = 3600 * 1000;
    const old = (Date.now() - 5 * 24 * hour) / 1000;
    const put = (path: string, bytes: number) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, Buffer.alloc(bytes));
      fs.utimesSync(path, old, old);
    };
    const ids: Record<string, string> = {};
    for (const name of ["open", "stale", "done", "agent"]) {
      const live = store.create(name, { width: 1920, height: 1080, fps: 30 });
      const project = structuredClone(live.project);
      const proxy = `edit/proxies/drive/${name}File01.mp4`;
      project.media = [{ id: "m1", name: `${name}.mp4`, path: `/nowhere/${name}.mp4`, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: true,
        cloud: { source: `drive:${name}File01`, original: `edit/originals/drive/${name}File01/${name}.mp4`, proxy, size: 1 } }];
      await store.replace(project.id, null, project, "test");
      ids[name] = project.id;
      // Its sound copy and two blocks of its proxy (one folder named by the key, one from before keys were kept).
      put(`${cache}/cloud/sound/originals/drive/${name}File01/${name}.mp4.mov`, 1000);
      put(`${cache}/cloud/blocks/${createHash("sha1").update(proxy).digest("hex")}/0`, 1000);
    }
    put(`${cache}/cloud/sound/originals/drive/nobodysFile1/x.mp4.mov`, 1000);
    // Opened here 1 hour and 3 days ago; "done" was opened 2 hours ago but is marked done. "agent" was opened 3 days
    // ago too, and the agent has saved it since, an hour ago, with the editor closed (JJ's day, Nov 10).
    markOpened(store.home, ids.open!, Date.now() - hour);
    markOpened(store.home, ids.stale!, Date.now() - 72 * hour);
    markOpened(store.home, ids.done!, Date.now() - 2 * hour);
    markOpened(store.home, ids.agent!, Date.now() - 72 * hour);
    const at = (hours: number) => (Date.now() - hours * hour) / 1000;
    for (const [name, hours] of [["open", 1], ["stale", 72], ["done", 2], ["agent", 1]] as const) {
      fs.utimesSync(`${store.home}/projects/${ids[name]!}.json`, at(hours), at(hours));
    }
    const done = new Set([ids.done!]);
    const gone = (name: string) => !fs.existsSync(`${cache}/cloud/sound/originals/drive/${name}File01/${name}.mp4.mov`);
    // Plenty of room: only the done project's go (closed two hours ago, marked done: it isn't in work for its open).
    let report = cleanCache(app, false, Date.now(), { freeBytes: 0, free: 1e12 }, done);
    expect(report.bytes).toBe(2000);
    expect(gone("done")).toBe(true);
    expect(gone("stale") || gone("open") || gone("agent")).toBe(false);
    expect(fs.existsSync(`${cache}/cloud/sound/originals/drive/nobodysFile1/x.mp4.mov`)).toBe(true);
    // Short by a little: only the footage nobody uses.
    report = cleanCache(app, false, Date.now(), { freeBytes: 1e12 + 500, free: 1e12 }, done);
    expect(report.bytes).toBe(1000);
    expect(fs.existsSync(`${cache}/cloud/sound/originals/drive/nobodysFile1/x.mp4.mov`)).toBe(false);
    expect(gone("stale")).toBe(false);
    // Short by more: the stale one's, whole (its sound copy and its proxy's blocks); never the one open an hour ago,
    // nor the one the agent worked on an hour ago (by its open alone it went with the stale one, and came down again
    // when it was opened).
    report = cleanCache(app, false, Date.now(), { freeBytes: 2e12, free: 1e12 }, done);
    expect(report.bytes).toBe(2000);
    expect(gone("stale")).toBe(true);
    expect(fs.existsSync(`${cache}/cloud/blocks/${createHash("sha1").update("edit/proxies/drive/staleFile01.mp4").digest("hex")}/0`)).toBe(false);
    expect(gone("open")).toBe(false);
    expect(gone("agent")).toBe(false);
    expect(fs.existsSync(`${cache}/cloud/blocks/${createHash("sha1").update("edit/proxies/drive/openFile01.mp4").digest("hex")}/0`)).toBe(true);
    // Under the cache's hard floor: an edit opened an hour ago gives its copies back too (not one open now).
    report = cleanCache(app, false, Date.now(), { freeBytes: 1e9, free: 0 }, done);
    expect(gone("open")).toBe(true);
    // A block whose meta says its key is known by it.
    expect(ownerToken("edit/sound/originals/drive/abcFile01/x.mp4.mov")).toBe("drive/abcFile01");
    expect(ownerToken("edit/excerpts/drive/abcFile01/0-1000.mov")).toBe("drive/abcFile01");
    expect(ownerToken("edit/pieces/drive/abcFile01/video/3.m4s")).toBe("drive/abcFile01");
    expect(ownerToken("edit/pieces/v3/sha256/abcFile01/audio/3.m4s")).toBe("sha256/abcFile01");
    expect(ownerToken("edit/exports/playback/p123/abc.mp4")).toBe("playback:p123");
    // An effect's render is its project's too; the project's other exports aren't a copy kept here.
    expect(ownerToken("edit/exports/p123/effect-board-0123456789ab.mp4")).toBe("playback:p123");
    expect(ownerToken("edit/exports/p123/final.mp4")).toBe(null);
    expect(ownerToken("edit/reviews/p/x.mp4")).toBe(null);
  } finally { forget(store.home); cleanup(); }
});

test("short of room, an excerpt an export is reading stays; it goes once let go", () => {
  const { app, store, cleanup } = fixtureHome("cache-pinned");
  try {
    const cache = store.cacheDir();
    const old = (Date.now() - 5 * 24 * 3600 * 1000) / 1000;
    const path = `${cache}/cloud/excerpts/originals/drive/nobodysFile1/x.mp4/cells-30-30.000/0.mp4`;
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, Buffer.alloc(1000));
    fs.utimesSync(path, old, old);
    const release = pin([path]);
    cleanCache(app, false, Date.now(), { freeBytes: 2e12, free: 1e12 });
    expect(fs.existsSync(path)).toBe(true);
    release();
    cleanCache(app, false, Date.now(), { freeBytes: 2e12, free: 1e12 });
    expect(fs.existsSync(path)).toBe(false);
  } finally { cleanup(); }
});

test("exports made ahead: one a Mac, the one made last, stays under three days old; older or more go, never the one being made again", () => {
  const { app, store, cleanup } = fixtureHome("cache-ahead");
  try {
    const cache = store.cacheDir();
    const day = 24 * 3600 * 1000;
    const made = (id: string, at: number) => {
      fs.mkdirSync(`${cache}/ahead`, { recursive: true });
      for (const path of [`${cache}/ahead/${id}.mp4`, `${cache}/ahead/${id}.mp4.json`]) {
        fs.writeFileSync(path, "x");
        fs.utimesSync(path, at / 1000, at / 1000);
      }
    };
    const now = Date.now();
    made("newest", now - 1000);
    made("second", now - 2000);
    made("third", now - 3000);
    made("old", now - 4 * day);
    made("remaking", now - 5 * day);
    // Being made again: it copies its unchanged chunks out of its last one.
    (app.exports as unknown as { aheadFor: () => string | null }).aheadFor = () => "remaking";
    cleanCache(app, false);
    const left = fs.readdirSync(`${cache}/ahead`).filter((name) => name.endsWith(".mp4")).sort();
    expect(left).toEqual(["newest.mp4", "remaking.mp4"]);
    expect(fs.existsSync(`${cache}/ahead/third.mp4.json`)).toBe(false);
  } finally {
    cleanup();
  }
});

// Sphe's M4, Nov 17: Retry's room-making ("freed 7.31 GB for work that needs 15.6 GB free") took the export made ahead
// that it would have copied all 88 chunks from, and rendered every one again.
test("the export made ahead an export is about to copy from stays through room-making, and goes once it's let go", () => {
  const { app, store, cleanup } = fixtureHome("cache-ahead-held");
  try {
    const cache = store.cacheDir();
    fs.mkdirSync(`${cache}/ahead`, { recursive: true });
    const file = `${cache}/ahead/p1.mp4`;
    const old = (Date.now() - 3600_000 * 60) / 1000;
    for (const path of [file, `${file}.json`]) {
      fs.writeFileSync(path, "x".repeat(1000));
      fs.utimesSync(path, old, old);
    }
    const release = pin([file, `${file}.json`]);
    // Short of room, as an export short of it asks.
    cleanCache(app, false, Date.now(), { freeBytes: 2e12, free: 1e12 });
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.json`)).toBe(true);
    release();
    cleanCache(app, false, Date.now(), { freeBytes: 2e12, free: 1e12 });
    expect(fs.existsSync(file)).toBe(false);
  } finally {
    cleanup();
  }
});

// Nov 16 audit: past a fixed 100 MB the cleaner took whole projects' history folders, all 30 saves of each (a
// reset's "edit before" among them).
test("project history past its gigabyte loses the oldest saves across projects, each project keeping its newest three", () => {
  const { app, store, cleanup } = fixtureHome("cache-history");
  try {
    const history = `${store.home}/projects/history`;
    const MB = 1_000_000;
    const save = (id: string, at: number) => {
      const path = `${history}/${id}/${at}.json`;
      fs.mkdirSync(`${history}/${id}`, { recursive: true });
      fs.writeFileSync(path, "");
      // Sparse: its size counts, the disk holds nothing.
      fs.truncateSync(path, 50 * MB);
      fs.utimesSync(path, at / 1000, at / 1000);
      return path;
    };
    const day = 24 * 3600_000;
    const t0 = Date.now() - 60 * day;
    // An old project's four saves (its last a reset's "edit before"), then a busy one's thirty.
    const quiet = [0, 1, 2, 3].map((n) => save("p-quiet", t0 + n * 60_000));
    const busy = Array.from({ length: 30 }, (_, n) => save("p-busy", t0 + day + n * 600_000));
    // 1.7 GB against 1 GB: 0.7 GB, the 14 oldest saves that may go.
    cleanCache(app, false, Date.now(), { freeBytes: 0, free: 1e12 });
    expect(quiet.filter((path) => fs.existsSync(path))).toEqual(quiet.slice(1));
    expect(busy.filter((path) => fs.existsSync(path))).toEqual(busy.slice(13));
  } finally {
    cleanup();
  }
});

/** A cloud project here with one footage file: its proxy's sound copy (derived) and a block of its proxy (proxy). */
async function cloudProject(store: ReturnType<typeof fixtureHome>["store"], name: string, opened: number | null, extra: Partial<{ original: string }> = {}) {
  const cache = store.cacheDir();
  const old = (Date.now() - 20 * 24 * 3600 * 1000) / 1000;
  const put = (path: string, bytes: number) => {
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, Buffer.alloc(bytes));
    fs.utimesSync(path, old, old);
    return path;
  };
  const live = store.create(name, { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project);
  const proxy = `edit/proxies/drive/${name}File01.mp4`;
  const original = extra.original ?? `edit/originals/drive/${name}File01/${name}.mp4`;
  project.media = [{ id: "m1", name: `${name}.mp4`, path: `/nowhere/${name}.mp4`, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: true,
    cloud: { source: `drive:${name}File01`, original, proxy, size: 1000 } }];
  await store.replace(project.id, null, project, "test");
  const files = {
    sound: put(`${cache}/cloud/sound/originals/drive/${name}File01/${name}.mp4.mov`, 1000),
    block: put(`${cache}/cloud/blocks/${createHash("sha1").update(proxy).digest("hex")}/0`, 1000),
    original: put(`${cache}/cloud/${original.slice("edit/".length)}`, 3000),
  };
  if (opened !== null) markOpened(store.home, project.id, opened);
  const at = (opened ?? Date.now() - 30 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(`${store.home}/projects/${project.id}.json`, at, at);
  return { id: project.id, files, here: () => Object.fromEntries(Object.entries(files).map(([kind, path]) => [kind, fs.existsSync(path)])) };
}

test("short of room, idle projects go whole, the one worked on longest ago first, each its derived copies before its proxies; none in work, and never their originals", async () => {
  const { store, app, cleanup } = fixtureHome("cache-whole-projects");
  try {
    const day = 24 * 3600 * 1000;
    const older = await cloudProject(store, "older", Date.now() - 5 * day);
    const newer = await cloudProject(store, "newer", Date.now() - 4 * day);
    const working = await cloudProject(store, "working", Date.now() - 1 * day);
    // Room enough: nothing goes from any of them (idle isn't let go).
    expect(cleanCache(app, false, Date.now(), { freeBytes: 0, free: 1e12 }).files).toBe(0);
    // 1.5 KB short: the older project's sound copy, then (still short) its proxy's blocks. The newer one keeps all.
    let report = cleanCache(app, false, Date.now(), { freeBytes: 1e12 + 1500, free: 1e12 });
    expect(report.bytes).toBe(2000);
    expect(older.here()).toEqual({ sound: false, block: false, original: true });
    expect(newer.here()).toEqual({ sound: true, block: true, original: true });
    // 0.5 KB short: the newer one's sound copy alone is enough; its blocks stay.
    report = cleanCache(app, false, Date.now(), { freeBytes: 1e12 + 500, free: 1e12 });
    expect(newer.here()).toEqual({ sound: false, block: true, original: true });
    // However short (but over the hard floor): the one in work keeps everything, and idle originals stay.
    cleanCache(app, false, Date.now(), { freeBytes: 9e12, free: 1e12 });
    expect(working.here()).toEqual({ sound: true, block: true, original: true });
    expect(older.here().original && newer.here().original).toBe(true);
    // The ledger is what's left.
    expect(ledger.get(older.files.sound)).toBeUndefined();
    expect(ledger.get(working.files.sound)?.owners).toEqual([working.id]);
  } finally {
    forget(store.home);
    cleanup();
  }
});

test("a done project's footage goes at any pass, its originals only once R2 has them at their size; never a file from someone's disk, nor one still going up", async () => {
  const { dir, store, app, cleanup } = fixtureHome("cache-done-originals");
  try {
    const cache = store.cacheDir();
    const day = 24 * 3600 * 1000;
    // Left 8 days: let go as done.
    const left = await cloudProject(store, "left", Date.now() - 8 * day);
    // Its Drive download (Edit's own copy of the original) and a file of the person's that is another's original.
    const download = `${store.home}/media/drive/leftFile01/left.mp4`;
    fs.mkdirSync(download.slice(0, download.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(download, Buffer.alloc(3000));
    const theirs = `${dir}/Their footage.mp4`;
    fs.writeFileSync(theirs, Buffer.alloc(3000));
    const old = (Date.now() - 20 * day) / 1000;
    for (const path of [download, theirs]) fs.utimesSync(path, old, old);
    cloudMedia.writeLocalOriginals(cache, {
      "edit/originals/drive/leftFile01/left2.mp4": { path: download, size: 3000, mtime_ms: old * 1000, used_ms: Date.now() },
      "edit/originals/sha256/abc/theirs.mp4": { path: theirs, size: 3000, mtime_ms: old * 1000 },
    });
    // A pass with no word from R2: its copies go, its originals stay.
    cleanCache(app, false, Date.now(), { freeBytes: 0, free: 1e12 });
    expect(left.here()).toEqual({ sound: false, block: false, original: true });
    expect(fs.existsSync(download)).toBe(true);
    // R2 holds a different size: still kept.
    const asked: string[] = [];
    await cleanPass(app, Date.now(), async (key) => (asked.push(key), { size: 2999 }));
    expect(left.here().original).toBe(true);
    expect(fs.existsSync(download)).toBe(true);
    expect(asked).toContain("edit/originals/drive/leftFile01/left.mp4");
    expect(asked).toContain("edit/originals/drive/leftFile01/left2.mp4");
    // R2 holds them at their size: they go; the person's file is never asked about nor touched.
    await cleanPass(app, Date.now(), async () => ({ size: 3000 }));
    expect(left.here().original).toBe(false);
    expect(fs.existsSync(download)).toBe(false);
    expect(fs.existsSync(theirs)).toBe(true);
    // Another done project whose original is still going up (a pending upload): in work, all of it stays.
    const going = await cloudProject(store, "going", Date.now() - 9 * day);
    fs.writeFileSync(`${store.home}/jobs.json`, JSON.stringify([{ key: "upload:-:x", kind: "upload", project: "-", state: "running", args: { file: "/Users/x/going.mp4", originalKey: "edit/originals/drive/goingFile01/going.mp4" } }]));
    await cleanPass(app, Date.now(), async () => ({ size: 3000 }));
    expect(going.here()).toEqual({ sound: true, block: true, original: true });
    // Up: let go with the rest.
    fs.writeFileSync(`${store.home}/jobs.json`, "[]");
    await cleanPass(app, Date.now(), async () => ({ size: 3000 }));
    expect(going.here()).toEqual({ sound: false, block: false, original: false });
  } finally {
    forget(store.home);
    cleanup();
  }
});

test("marked done on Home, a project closed lately lets its footage go; open now or with work running for it, it keeps it", async () => {
  const { store, app, cleanup } = fixtureHome("cache-done-open");
  try {
    const hour = 3600 * 1000;
    const closed = await cloudProject(store, "closed", Date.now() - 2 * hour);
    const open = await cloudProject(store, "open", Date.now() - 60_000);
    const busy = await cloudProject(store, "busy", Date.now() - 2 * hour);
    // An export of it waits in the job table.
    fs.writeFileSync(`${store.home}/jobs.json`, JSON.stringify([{ key: `export:${busy.id}:`, kind: "export", project: busy.id, state: "waiting", args: {} }]));
    const done = new Set([closed.id, open.id, busy.id]);
    cleanCache(app, false, Date.now(), { freeBytes: 0, free: 1e12 }, done);
    expect(closed.here()).toEqual({ sound: false, block: false, original: true });
    expect(open.here()).toEqual({ sound: true, block: true, original: true });
    expect(busy.here()).toEqual({ sound: true, block: true, original: true });
  } finally {
    forget(store.home);
    cleanup();
  }
});

test("a file two projects use goes only once neither is in work, and with the later one; it's freed once", async () => {
  const { store, app, cleanup } = fixtureHome("cache-shared");
  try {
    const day = 24 * 3600 * 1000;
    const cache = store.cacheDir();
    // Two projects cut from the same Drive file: one idle, one in work.
    const idle = await cloudProject(store, "same", Date.now() - 5 * day);
    const live = store.create("again", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project);
    project.media = structuredClone(store.get(idle.id)!.project.media);
    await store.replace(project.id, null, project, "test");
    markOpened(store.home, project.id, Date.now() - day);
    cleanCache(app, false, Date.now(), { freeBytes: 9e12, free: 1e12 });
    expect(idle.here()).toEqual({ sound: true, block: true, original: true });
    // The second one idle too, and older than the first: the file goes with the first (the later), once.
    const opened = JSON.parse(fs.readFileSync(`${store.home}/opened.json`, "utf8")) as Record<string, number>;
    fs.writeFileSync(`${store.home}/opened.json`, JSON.stringify({ ...opened, [project.id]: Date.now() - 6 * day }));
    const at = (Date.now() - 6 * day) / 1000;
    fs.utimesSync(`${store.home}/projects/${project.id}.json`, at, at);
    forget(store.home);
    const report = cleanCache(app, false, Date.now(), { freeBytes: 1e12 + 1500, free: 1e12 });
    expect(report.bytes).toBe(2000);
    expect(idle.here()).toEqual({ sound: false, block: false, original: true });
    void cache;
  } finally {
    forget(store.home);
    cleanup();
  }
});
