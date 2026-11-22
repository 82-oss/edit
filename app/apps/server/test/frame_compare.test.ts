// The lettered grid look_at_effect lays over a comparison (Sphe, Nov 13, of a
// 3D map's angle: "temporarily throw a grid on screen").

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { framesOf, gridCell, gridImage, labelFont } from "../src/frame_compare.ts";
import * as tools from "../src/tools.ts";

test("a point's cell: 12 columns lettered, rows kept near square", () => {
  expect(gridCell(0, 0, 1920, 1080)).toBe("A1");
  expect(gridCell(700, 500, 1920, 1080)).toBe("E4");
  expect(gridCell(1919, 1079, 1920, 1080)).toBe("L7");
  expect(gridCell(1079, 1919, 1080, 1920)).toBe("L21");
});

test("the grid is see-through but for its lines and labels", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "grid-"));
  try {
    const file = await gridImage(640, 360, dir, labelFont(dir));
    // A PNG with an alpha channel (colour type 6), as wide and high as the frame.
    const head = fs.readFileSync(file);
    expect(head.readUInt32BE(16)).toBe(640);
    expect(head.readUInt32BE(20)).toBe(360);
    expect(head[25]).toBe(6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reference streamed from the cloud whose read drops is read again once, and its frame comes (Nov 21: look_at_effect beside one failed with FFmpeg's \"Nothing was written into output file\", then worked)", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "frames-of-"));
  try {
    const source = join(dir, "ref.mp4");
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=4", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", source]);
    const bytes = fs.readFileSync(source);
    // As Edit's /api/cloud/preview when a range read from the cloud drops: the first read gives its header, and its frames' range fails.
    let reads = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const from = Number(/bytes=(\d+)-/u.exec(request.headers.get("range") ?? "")?.[1] ?? 0);
        if (from === 0) reads++;
        if (reads === 1 && from >= 4096) return new Response("the cloud read dropped", { status: 503 });
        const body = reads === 1 ? bytes.subarray(from, 4096) : bytes.subarray(from);
        return new Response(body, { status: from > 0 ? 206 : 200, headers: { "accept-ranges": "bytes", "content-range": `bytes ${from}-${from + body.length - 1}/${bytes.length}` } });
      },
    });
    try {
      const frames = await framesOf(`http://127.0.0.1:${server.port}/ref.mp4`, 2, 1, 30, 320, 240, dir, "ref");
      expect(reads).toBe(2);
      expect(frames).toHaveLength(1);
    } finally {
      void server.stop(true);
    }
    // Past its end: nothing, without an error.
    expect(await framesOf(source, 9, 1, 30, 320, 240, dir, "past")).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
