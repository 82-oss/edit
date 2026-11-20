// Linux's slow-motion smoothing (rife.ts): RIFE's frames land where they play.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { forgetForTests, rife, smooth, warm } from "../src/rife.ts";
import * as tools from "../src/tools.ts";

const home = fs.mkdtempSync(join(os.tmpdir(), "rife-"));
const gpu = process.platform === "linux" ? await warm(home) : null;

// Nov 21: the look ran its three programs with spawnSync the first time anything asked (broll.ts's smoothing key,
// whether smoothing is offered), and nothing else in Edit ran until RIFE answered (14 s in the bad-day sandbox).
test("RIFE is looked for off the server's thread: asked before the look is done it's null and runs nothing; after it, what the look found", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "rife-look-"));
  try {
    forgetForTests();
    // A RIFE that takes a second to answer, and says it ran.
    const ran = join(dir, "ran");
    const program = join(dir, "rife-ncnn-vulkan");
    fs.writeFileSync(program, `#!/bin/sh\ntouch '${ran}'\nsleep 1\necho '[0 NVIDIA GeForce RTX 4060]  queueC=2[8]  queueG=0[16]'\n`, { mode: 0o755 });
    const fake = { program, model: join(dir, "rife-v4.6") };
    // Asked before any look: nothing run, null at once.
    expect(rife(dir)).toBeNull();
    expect(fs.existsSync(ran)).toBe(false);
    // The look runs beside the thread: its timers keep their turns meanwhile.
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 50);
    const began = performance.now();
    const looking = warm(dir, fake);
    expect(performance.now() - began).toBeLessThan(100);
    expect(rife(dir)).toBeNull();
    expect(await looking).toEqual(fake);
    clearInterval(tick);
    expect(ticks).toBeGreaterThanOrEqual(10);
    expect(fs.existsSync(ran)).toBe(true);
    expect(rife(dir)).toEqual(fake);
    // Looked at once: a second warm is the first's answer.
    expect(await warm(dir)).toEqual(fake);
  } finally {
    forgetForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(gpu === null)("a stretch slowed to a half at 30 fps comes out twice as long, every frame there, in H.264 at the picture's size", async () => {
  try {
    const source = join(home, "moving.mp4");
    // 25 fps of moving pattern, 3 s.
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=3", "-c:v", "libx264", "-preset", "ultrafast", source]);
    const out = join(home, "smoothed.mp4");
    await smooth(gpu!, source, 1, 1.2, 0.5, 30, 1920, 1080, out, join(home, "work"), 120_000);
    const probe = new TextDecoder().decode(
      await tools.run([tools.ffprobe(), "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height,codec_name,r_frame_rate", "-of", "csv=p=0", out]),
    );
    // 1.2 s of source slowed to a half is 2.4 s, at 30 fps: 72 frames; kept at the source's size (it's smaller than the frame).
    expect(probe.trim()).toBe("h264,640,360,30/1,72");
    // Seekable as the previews are (tools.seekable): a keyframe every half second, no B-frames.
    const kinds = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "v", "-show_entries", "frame=pict_type", "-of", "csv=p=0", out]));
    const types = kinds.trim().split("\n").map((line) => line.trim().replace(/,$/, ""));
    expect(types.filter((type) => type === "B")).toEqual([]);
    expect([0, 15, 30, 45, 60].every((n) => types[n] === "I")).toBe(true);
    expect(fs.existsSync(join(home, "work"))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
