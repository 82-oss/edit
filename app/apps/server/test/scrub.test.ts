import { expect, spyOn, test } from "bun:test";

import * as encoder from "../src/encoder.ts";
import type { Media, Project } from "../src/model.ts";
import { makePiece, PIECE, pieceKey, piecesOf } from "../src/scrub.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";

test("the scrub tier is made for the stretches the timeline shows, in pieces of the source, each once", () => {
  const project = {
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "a", name: "a.mp4", path: "x", kind: "video", duration: 3600, width: 1920, height: 1080, fps: 30, has_audio: true },
      { id: "s", name: "s.wav", path: "y", kind: "audio", duration: 3600, width: 0, height: 0, fps: 0, has_audio: true },
    ],
    clips: [
      // 290–310 s of a: across pieces 0 and 1.
      { id: "c1", track: "v1", type: "video", media: "a", source_in: 290, start: 0, duration: 600 },
      // 1210 s on, 10 s: piece 4.
      { id: "c2", track: "v1", type: "video", media: "a", source_in: 1210, start: 600, duration: 300 },
      { id: "c3", track: "a1", type: "audio", media: "s", source_in: 0, start: 0, duration: 900 },
    ],
  } as unknown as Project;
  expect([...(piecesOf(project, 0, 900).get("a") ?? [])].sort()).toEqual([0, 1, 4]);
  expect(piecesOf(project, 0, 900).has("s")).toBe(false);
  // Only what frames 600–900 show.
  expect([...(piecesOf(project, 600, 900).get("a") ?? [])]).toEqual([4]);
  expect(PIECE).toBe(300);
  expect(pieceKey("edit/proxies/drive/abc.mp4", 3)).toBe("edit/scrub/proxies/drive/abc.mp4/3.mp4");
});


// Nov 22: a strip waited only for an export rendering here, five hours at most; it's made for the page, so it takes its
// turn after a person's Export and a share's review copy (encoder.ts's playback tier).
test("a scrub strip takes its turn on the encoder after a share's review copy", async () => {
  const { app, cleanup } = fixtureHome("scrub-turn");
  const was = encoder.hooks.pollMs;
  encoder.hooks.pollMs = 20;
  const ran: string[][] = [];
  const run = spyOn(tools, "run").mockImplementation(async (command: string[]) => {
    ran.push(command);
    throw new Error("no ffmpeg here");
  });
  const copy = encoder.hold("a share's review copy", "share");
  try {
    const media = { id: "m1", name: "cam", path: "/nowhere.mp4", kind: "video", duration: 30, cloud: { proxy: "edit/proxies/drive/abc.mp4" } } as unknown as Media;
    const piece = makePiece(app, media, 0);
    await Bun.sleep(100);
    expect(ran).toEqual([]);
    copy.release();
    expect(await piece).toBeNull();
    expect(ran).toHaveLength(1);
    expect(encoder.busy()).toBe(false);
  } finally {
    copy.release();
    run.mockRestore();
    encoder.hooks.pollMs = was;
    cleanup();
  }
});
