// The lettered grid look_at_effect lays over a comparison (Sphe, Nov 13, of a
// 3D map's angle: "temporarily throw a grid on screen").

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gridCell, gridImage, labelFont } from "../src/frame_compare.ts";

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
