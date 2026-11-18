// What Edit.app's native preview decodes each picture from (routes.ts `nativeSources`).

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { cleanCache } from "../src/cache_cleanup.ts";
import { localPath } from "../src/cloud_media.ts";
import { pin } from "../src/file_pins.ts";
import { PLAYBACK_ROUTE } from "../src/cloud_playback.ts";
import * as localPreviews from "../src/local_previews.ts";
import { hooks, nativeSources, reset } from "../src/native_preview.ts";
import * as player from "../src/player.ts";
import * as pieces from "../src/proxy_pieces.ts";
import * as storage from "../src/storage.ts";
import { spyOn } from "bun:test";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

test("the native preview reads a media's made preview, else its footage; a cloud one's copy here, else its footage here, else the loopback stream", async () => {
  const { dir, app, store, cleanup } = fixtureHome("native-sources");
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    for (const name of ["made.mp4", "making.mp4", "still.png"]) fs.writeFileSync(`${dir}/${name}`, "x");
    await store.update(id, "test", (p) => {
      p.media.push(media({ id: "made", name: "made.mp4", path: `${dir}/made.mp4`, kind: "video", duration: 1, has_audio: true }));
      p.media.push(media({ id: "making", name: "making.mp4", path: `${dir}/making.mp4`, kind: "video", duration: 1, has_audio: true }));
      p.media.push(media({ id: "still", name: "still.png", path: `${dir}/still.png`, kind: "image", duration: 1 }));
      p.media.push(media({ id: "song", name: "song.mp3", path: `${dir}/song.mp3`, kind: "audio", duration: 1 }));
      p.media.push({ ...media({ id: "here", name: "here.mp4", path: "https://r2.example/a", kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/aa/here.mp4" } } as never);
      p.media.push({ ...media({ id: "there", name: "there.mp4", path: "https://r2.example/b", kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/bb/there.mp4" } } as never);
      p.media.push({ ...media({ id: "footage", name: "made.mp4", path: `${dir}/made.mp4`, kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/cc/footage.mp4" } } as never);
      p.media.push({ ...media({ id: "unshown", name: "unshown.mp4", path: "https://r2.example/c", kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/dd/unshown.mp4" } } as never);
      // Listed before "there" in the media, but played after it: fetched after it.
      p.media.unshift({ ...media({ id: "later", name: "later.mp4", path: "https://r2.example/d", kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/ee/later.mp4" } } as never);
      p.clips.push(clip({ id: "c0", type: "video", track: "v1", media: "later", start: 300, duration: 30, source_in: 0 }));
      p.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "there", start: 0, duration: 30, source_in: 0 }));
    });
    // One preview made, the other on its way.
    const made = app.media.paths(`${dir}/made.mp4`);
    fs.mkdirSync(made.proxy.slice(0, made.proxy.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(made.proxy, "preview");
    fs.writeFileSync(made.proxyDone, "");
    // One cloud preview whole on this Mac.
    const here = localPath(store.cacheDir(), "edit/proxies/aa/here.mp4");
    fs.mkdirSync(here.slice(0, here.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(here, "copy");
    // A streamed one's whole preview comes down behind it.
    const fetched: string[] = [];
    const fetch = spyOn(localPreviews.hooks, "fetch").mockImplementation(async (key) => { fetched.push(key); });
    fs.writeFileSync(made.audio, "sound");
    const answer = (await (await nativeSources(app, store.get(id)!.project)).json()) as { cache: string; sources: Record<string, string>; sounds: Record<string, string>; of: Record<string, string>; coming: boolean };
    fetch.mockRestore();
    // Copies the timeline plays still come down: the page asks again in a while.
    expect(answer.coming).toBe(true);
    // Whole copies in playhead order: the footage the timeline plays first comes first; and the project is the window's now.
    expect(fetched).toEqual(["edit/proxies/bb/there.mp4", "edit/proxies/ee/later.mp4"]);
    expect(player.isNative(id)).toBe(true);
    // The sound the window mixes while it plays: a made preview's sound file, a cloud copy's own (the sound is in it), else the footage or the stream.
    expect(answer.sounds).toEqual({
      made: made.audio,
      making: `${dir}/making.mp4`,
      song: `${dir}/song.mp3`,
      here,
      there: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/bb/there.mp4")}`,
      later: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/ee/later.mp4")}`,
      footage: `${dir}/made.mp4`,
      unshown: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/dd/unshown.mp4")}`,
    });
    expect(answer.cache).toBe(store.cacheDir());
    expect(answer.sources).toEqual({
      made: made.proxy,
      making: `${dir}/making.mp4`,
      still: `${dir}/still.png`,
      here,
      there: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/bb/there.mp4")}`,
      later: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/ee/later.mp4")}`,
      footage: `${dir}/made.mp4`,
      // In the project but on no clip: streamed if ever asked, never fetched.
      unshown: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/dd/unshown.mp4")}`,
    });
    // What each is in the edit they were made from: the page leaves out one its own edit has otherwise (playback.ts).
    const project = store.get(id)!.project;
    expect(answer.of).toEqual(Object.fromEntries(project.media.map((media) => [media.id, `${media.kind}:${media.path}`])));
  } finally {
    cleanup();
  }
});

test("footage that's its own proxy (an original of 256 MB or less) comes down whole too, so it isn't streamed for good", async () => {
  const { app, store, cleanup } = fixtureHome("native-sources-own");
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const own = "edit/originals/sha256/ab/map.mp4";
    await store.update(id, "test", (p) => {
      p.media.push({ ...media({ id: "map", name: "map.mp4", path: "https://r2.example/map", kind: "video", duration: 8 }), cloud: { proxy: own } } as never);
      p.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "map", start: 0, duration: 30, source_in: 0 }));
    });
    const fetched: string[] = [];
    const fetch = spyOn(localPreviews.hooks, "fetch").mockImplementation(async (key, local) => {
      fetched.push(key);
      fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(local, "copy");
    });
    const answer = async () => (await (await nativeSources(app, store.get(id)!.project)).json()) as { sources: Record<string, string>; coming: boolean };
    try {
      const first = await answer();
      expect(first.sources.map).toBe(`http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(own)}`);
      expect(first.coming).toBe(true);
      await Bun.sleep(10);
      expect(fetched).toEqual([own]);
      const second = await answer();
      expect(second.sources.map).toBe(localPath(store.cacheDir(), own));
      // Nothing left to come down: the page stops asking.
      expect(second.coming).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  } finally {
    cleanup();
  }
});

test("a pieced proxy's pieces here that the timeline plays are cut into files the window reads instead of the stream; the rest stream", async () => {
  const { app, store, cleanup } = fixtureHome("native-sources-pieces");
  reset();
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const key = pieces.proxyKeyOf("drive:longFile0001");
    const base = pieces.baseOf(key)!;
    const cache = store.cacheDir();
    // A two-hour file: 120 pieces; the second one here, which the clip plays, and the sixth, which nothing plays.
    const layout = { ...pieces.plan("drive:longFile0001", "edit/originals/drive/longFile0001/long.mp4", 7200, 30, 1920, 1080, true), head: 1, total: 1 };
    const write = (path: string, text: string) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, text);
    };
    write(localPath(cache, `${base}/layout.json`), JSON.stringify(layout));
    write(localPath(cache, `${base}/video/1.m4s`), "piece");
    write(localPath(cache, `${base}/video/5.m4s`), "piece");
    write(localPath(cache, `${base}/head.mp4`), "head");
    await store.update(id, "test", (p) => {
      p.media.push({ ...media({ id: "long", name: "long.mp4", path: "https://r2.example/long", kind: "video", duration: 7200 }), cloud: { proxy: key } } as never);
      p.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "long", start: 0, duration: 30, source_in: 65 }));
    });
    const url = `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(key)}`;
    const cuts: [string, string, string][] = [];
    const cutting = spyOn(hooks, "cut").mockImplementation(async (head, video, out) => {
      cuts.push([head, video, out]);
      write(out, "cut");
    });
    const ask = async () => (await (await nativeSources(app, store.get(id)!.project)).json()) as { sources: Record<string, string>; excerpts: Record<string, unknown>; coming: boolean };
    try {
      const first = await ask();
      expect(first.sources.long).toBe(url);
      expect(first.excerpts).toEqual({});
      // The piece played isn't cut yet: asked again.
      expect(first.coming).toBe(true);
      await Bun.sleep(10);
      const file = localPath(cache, `${base}/native2/1.mp4`);
      // Only what the timeline plays is cut, from this Mac's own files of the piece: a cut piece is a second copy of its minute.
      expect(cuts).toEqual([[localPath(cache, `${base}/head.mp4`), localPath(cache, `${base}/video/1.m4s`), file]]);
      const second = await ask();
      expect(second.sources.long).toBe(url);
      expect(second.excerpts).toEqual({ long: [{ from: 60, to: 120, path: file }] });
      // Every piece played is cut: still streamed, but nothing more comes, so the page stops asking.
      expect(second.coming).toBe(false);
    } finally {
      cutting.mockRestore();
    }
  } finally {
    reset();
    cleanup();
  }
});

// The real cut, where the test above stands in for it: nothing made the pieces' folder, so on a real Mac every cut
// failed ("Error opening output files: No such file or directory", JJ's Mac, Nov 10) while that test passed.
test.skipIf(Bun.which("ffmpeg") === null)("a piece is cut into a folder nothing has made yet, and lands whole: its own frames, from time 0", async () => {
  const { dir, cleanup } = fixtureHome("native-sources-cut");
  try {
    // A fragmented video of three one-second fragments, split as a pieced proxy keeps it: its head, then each fragment.
    const footage = `${dir}/footage.mp4`;
    const made = Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=d=3:s=160x90:r=30", "-g", "30", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov+default_base_moof", footage]);
    expect(made.exitCode).toBe(0);
    const bytes = fs.readFileSync(footage);
    const boxes: { type: string; at: number; size: number }[] = [];
    for (let at = 0; at < bytes.length; ) {
      const size = bytes.readUInt32BE(at);
      boxes.push({ type: bytes.toString("latin1", at + 4, at + 8), at, size });
      at += size;
    }
    const moov = boxes.find((box) => box.type === "moov")!;
    const head = `${dir}/head.mp4`;
    fs.writeFileSync(head, bytes.subarray(0, moov.at + moov.size));
    const moofs = boxes.filter((box) => box.type === "moof");
    expect(moofs.length).toBe(3);
    // The second fragment: its moof and mdat.
    const second = `${dir}/1.m4s`;
    fs.writeFileSync(second, bytes.subarray(moofs[1]!.at, moofs[2]!.at));
    const out = `${dir}/pieces/youtube/abc/native/1.mp4`;
    await hooks.cut(head, second, out);
    expect(fs.readdirSync(`${dir}/pieces/youtube/abc/native`)).toEqual(["1.mp4"]);
    // Its one second alone, starting at 0 (Nov 18: cut from the stream, a piece held every frame before it too).
    const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v", "-count_packets", "-show_entries", "stream=nb_read_packets:format=start_time,duration", "-of", "json", out]);
    const read = JSON.parse(probe.stdout.toString()) as { streams: { nb_read_packets: string }[]; format: { start_time: string; duration: string } };
    expect(Number(read.streams[0]!.nb_read_packets)).toBe(30);
    expect(Number(read.format.start_time)).toBe(0);
    expect(Number(read.format.duration)).toBeCloseTo(1, 1);
    // One that fails leaves nothing the window would take for a piece.
    await expect(hooks.cut(head, `${dir}/missing.m4s`, `${dir}/pieces/youtube/abc/native/2.mp4`)).rejects.toThrow();
    expect(fs.readdirSync(`${dir}/pieces/youtube/abc/native`)).toEqual(["1.mp4"]);
  } finally {
    cleanup();
  }
});

test("as a streamed preview's whole copy lands, the window's pages hear it and ask again, at once", async () => {
  const { app, store, cleanup } = fixtureHome("native-sources");
  const realFetch = localPreviews.hooks.fetch;
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    await store.update(id, "test", (p) => {
      p.media.push({ ...media({ id: "a", name: "a.mp4", path: "https://r2.example/a", kind: "video", duration: 1 }), cloud: { proxy: "edit/proxies/aa/a.mp4" } } as never);
      p.media.push({ ...media({ id: "b", name: "b.mp4", path: "https://r2.example/b", kind: "video", duration: 1 }), cloud: { proxy: "edit/proxies/bb/b.mp4" } } as never);
      p.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "a", start: 0, duration: 30, source_in: 0 }));
      p.clips.push(clip({ id: "c2", type: "video", track: "v1", media: "b", start: 30, duration: 30, source_in: 0 }));
    });
    const finish: (() => void)[] = [];
    localPreviews.hooks.fetch = (_key, local) => new Promise<void>((resolve) => finish.push(() => {
      fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(local, "copy");
      resolve();
    }));
    const heard: unknown[] = [];
    const stop = store.subscribe((event) => heard.push(event));
    await nativeSources(app, store.get(id)!.project);
    expect(finish.length).toBe(2);
    // Both land within a moment: told once, a moment after the first (not every 15 s, nor once each).
    finish[0]!();
    finish[1]!();
    await Bun.sleep(450);
    expect(heard.filter((event) => (event as { type: string }).type === "native-sources")).toEqual([{ type: "native-sources", id }]);
    stop();
  } finally {
    localPreviews.hooks.fetch = realFetch;
    localPreviews.reset();
    reset();
    cleanup();
  }
});

/** A two-hour pieced proxy whose piece 1 is here (its head, its picture: 26 bytes), played by a clip at 1:05. */
async function piecedProject(name: string) {
  const fixture = fixtureHome(name);
  const { app, store } = fixture;
  const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
  // Its own file (layouts are kept in memory by key).
  const source = `drive:${name.replace(/[^A-Za-z0-9]/g, "")}`;
  const key = pieces.proxyKeyOf(source);
  const base = pieces.baseOf(key)!;
  const cache = store.cacheDir();
  const layout = { ...pieces.plan(source, `edit/originals/${source.replace(":", "/")}/long.mp4`, 7200, 30, 1920, 1080, true), head: 1000, total: 1 };
  write(localPath(cache, `${base}/layout.json`), JSON.stringify(layout));
  write(localPath(cache, `${base}/video/1.m4s`), "x".repeat(26));
  write(localPath(cache, `${base}/head.mp4`), "head");
  await store.update(id, "test", (p) => {
    p.media.push({ ...media({ id: "long", name: "long.mp4", path: "https://r2.example/long", kind: "video", duration: 7200 }), cloud: { proxy: key } } as never);
    p.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "long", start: 0, duration: 30, source_in: 65 }));
  });
  const ask = async () => (await (await nativeSources(app, store.get(id)!.project)).json()) as { excerpts: Record<string, { path: string }[]>; coming: boolean };
  return { ...fixture, base, cache, ask };
}

function write(path: string, text: string): void {
  fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  fs.writeFileSync(path, text);
}

test("a piece the window cut the old way (from the stream, every frame before it too) is never read again: it's cut anew and the old copies go, the cleaner taking every other one but the pieces themselves", async () => {
  reset();
  storage.resetRoom();
  const free = spyOn(storage.diskHooks, "free").mockReturnValue(100e9);
  const { app, base, cache, ask, cleanup } = await piecedProject("native-sources-old-cuts");
  const cutting = spyOn(hooks, "cut").mockImplementation(async (_head, _video, out) => write(out, "cut"));
  try {
    // Nov 17–18, Sphe's M4: an upgraded Mac keeps its old copies, 955 MB for a minute (sparse here).
    const old = localPath(cache, `${base}/native/1.mp4`);
    write(old, "");
    fs.truncateSync(old, 955_000_000);
    write(localPath(cache, `${base}/native/7.mp4`), "old");
    const first = await ask();
    expect(first.excerpts).toEqual({});
    expect(first.coming).toBe(true);
    await Bun.sleep(10);
    const cut = localPath(cache, `${base}/native2/1.mp4`);
    expect(cutting).toHaveBeenCalledTimes(1);
    expect((await ask()).excerpts.long!.map((one) => one.path)).toEqual([cut]);
    // Its own old copies gone as soon as it's asked for, the pieces beside them kept.
    expect(fs.existsSync(localPath(cache, `${base}/native`))).toBe(false);
    for (const kept of ["layout.json", "head.mp4", "video/1.m4s", "native2/1.mp4"]) expect(fs.existsSync(localPath(cache, `${base}/${kept}`))).toBe(true);
    // Another long video's (no project opened it since), unversioned or v3: the cleaner takes them, whatever their
    // age and however much room the cache has, but a pinned one (an export reading it) and its folder stay.
    const other = pieces.baseKey("youtube:abcdefghijk");
    const older = "edit/pieces/drive/fiveMinutePieces01";
    for (const one of [`${other}/native/0.mp4`, `${other}/native/1.mp4`, `${other}/head.mp4`, `${other}/video/0.m4s`, `${other}/audio/0.m4s`, `${other}/joined/0.m4s`, `${older}/native/3.mp4`, `${older}/video/3.m4s`]) write(localPath(cache, one), "x");
    const unpin = pin([localPath(cache, `${other}/native/1.mp4`)]);
    try {
      const report = cleanCache(app, false, Date.now(), { cacheBytes: 1e15, freeBytes: 0 });
      expect(report.removed.sort()).toEqual([localPath(cache, `${other}/native/0.mp4`), localPath(cache, `${older}/native`), localPath(cache, `${older}/native/3.mp4`)].sort());
      for (const kept of [`${other}/native/1.mp4`, `${other}/head.mp4`, `${other}/video/0.m4s`, `${other}/audio/0.m4s`, `${other}/joined/0.m4s`, `${older}/video/3.m4s`, `${base}/native2/1.mp4`]) expect(fs.existsSync(localPath(cache, kept))).toBe(true);
    } finally {
      unpin();
    }
    // Unpinned, the next pass takes it and its folder.
    cleanCache(app, false, Date.now(), { cacheBytes: 1e15, freeBytes: 0 });
    expect(fs.existsSync(localPath(cache, `${other}/native`))).toBe(false);
  } finally {
    cutting.mockRestore();
    free.mockRestore();
    reset();
    cleanup();
  }
});

test("a piece is cut only with room for it on the disk (its claim counted against every other write), else it streams on; unmeasured, it waits too", async () => {
  reset();
  storage.resetRoom();
  let freeNow = storage.CACHE_FLOOR_BYTES + 10;
  const free = spyOn(storage.diskHooks, "free").mockImplementation(() => freeNow);
  const { base, cache, ask, cleanup } = await piecedProject("native-sources-no-room");
  const cutting = spyOn(hooks, "cut").mockImplementation(async (_head, _video, out) => write(out, "cut"));
  try {
    // The fragment (26 bytes) and a head (1,000) don't fit over the cache's floor: streamed, asked again later.
    let answer = await ask();
    await Bun.sleep(10);
    expect(cutting).not.toHaveBeenCalled();
    expect(answer.excerpts).toEqual({});
    expect(answer.coming).toBe(true);
    // Another write under way takes the room it would have.
    freeNow = storage.CACHE_FLOOR_BYTES + 2_000;
    const other = storage.claim(1_500);
    answer = await ask();
    await Bun.sleep(10);
    expect(cutting).not.toHaveBeenCalled();
    other.release();
    // The disk's free space not measurable: not taken for endless room.
    freeNow = Number.POSITIVE_INFINITY;
    await ask();
    await Bun.sleep(10);
    expect(cutting).not.toHaveBeenCalled();
    // With room, at the page's next ask, it's cut.
    freeNow = storage.CACHE_FLOOR_BYTES + 2_000;
    await ask();
    await Bun.sleep(10);
    expect(cutting).toHaveBeenCalledTimes(1);
    answer = await ask();
    expect(answer.excerpts.long!.map((one) => one.path)).toEqual([localPath(cache, `${base}/native2/1.mp4`)]);
    expect(answer.coming).toBe(false);
    expect(storage.claimedBytes()).toBe(0);
  } finally {
    cutting.mockRestore();
    free.mockRestore();
    storage.resetRoom();
    reset();
    cleanup();
  }
});

test("a cut claims what it writes while it runs, and lets it go when it fails", async () => {
  reset();
  storage.resetRoom();
  const free = spyOn(storage.diskHooks, "free").mockReturnValue(100e9);
  const { ask, cleanup } = await piecedProject("native-sources-claim");
  const during: number[] = [];
  const cutting = spyOn(hooks, "cut").mockImplementation(async () => {
    during.push(storage.claimedBytes());
    throw new Error("ffmpeg died");
  });
  try {
    await ask();
    await Bun.sleep(10);
    // The fragment and one head (the pieced proxy's is here already).
    expect(during).toEqual([26 + 1000]);
    expect(storage.claimedBytes()).toBe(0);
    // Failed lately: streamed, not asked about again for a while.
    const answer = await ask();
    expect(answer.excerpts).toEqual({});
    expect(answer.coming).toBe(false);
  } finally {
    cutting.mockRestore();
    free.mockRestore();
    storage.resetRoom();
    reset();
    cleanup();
  }
});
