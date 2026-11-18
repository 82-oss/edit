// What exports leave in the server's memory once they're done (Linux: glibc's malloc kept it, src/lib.rs `ALLOCATOR`).
import { beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { cache, ffmpeg, hasGpu, home, native } from "./native";

let gpu = false;
beforeAll(async () => {
  gpu = await hasGpu();
}, 30_000);

/** This process's own memory (not the files it maps), in MB. */
const anon = () => Number(/RssAnon:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))![1]) / 1024;

/**
 * Nov 19: the Linux prod Edit's server grew to 10.3 GB while its agents rendered effects, nearly all of it memory
 * the exports had freed. Each export's threads had kept it in an arena of their own. Four exports at once, four
 * times, here: glibc kept 816 MB of them, mimalloc 12.
 */
test("exports done hand their memory back (Linux)", async () => {
  if (process.platform !== "linux" || !gpu) return;
  const footage = join(home, "memory.mp4");
  expect(ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12", "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", footage])).toBe(true);
  const media = { id: "m", name: "m", path: footage, kind: "video", duration: 12, width: 1280, height: 720, fps: 30, has_audio: false };
  const exportOnce = (id: string, from: number) => {
    const clips = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, track: "v1", type: "video", media: "m", source_in: (from + i * 2.3) % 9, start: i * 15, duration: 15 }));
    const project = { version: 1, id, name: id, settings: { width: 1280, height: 720, fps: 30 }, media: [media], tracks: [{ id: "v1", kind: "video" }], clips };
    const input = { json: JSON.stringify(project) };
    const options = { ...native.exportDefaults(), hardware: false, audio: false, loudness: null };
    const { plan } = native.exportPlan(input, options);
    const output = join(home, `${id}.mp4`);
    return native.ExportJob.start({ project: input, options, plan, output, cacheDir: cache }, () => {})
      .wait()
      .finally(() => rmSync(output, { force: true }));
  };
  const before = anon();
  for (let round = 0; round < 4; round++) {
    await Promise.all(Array.from({ length: 4 }, (_, j) => exportOnce(`p-memory-${round}-${j}`, round + j)));
  }
  Bun.gc(true);
  expect(anon() - before).toBeLessThan(150);
}, 300_000);
