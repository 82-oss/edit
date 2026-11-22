import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { dirname } from "node:path";

import { registerEditingTools, zoomSource } from "../src/edit_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";

registerEditingTools();

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

function still(path: string, size: string): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=10:duration=1`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path]).exitCode).toBe(0);
}

// A zoom reads the lightest file here that holds its region at the size it's shown, the original only past that
// (the MacBook Air, Nov 22: every look decoded the 4K originals; at the agent's sizes the 720p copy looks the same,
// zoomed onto a badge only its lettering is softer).
test("a zoom reads the lightest preview that holds its region, the original past it, and says so", async () => {
  fixture = fixtureHome("look-sources");
  const { app } = fixture;
  const id = app.store.create("Phone", { width: 1920, height: 1080, fps: 30 }).project.id;
  const original = `${fixture.dir}/phone.mp4`;
  still(original, "3840x2160");
  const media = { id: "m1", name: "phone.mp4", path: original, kind: "video" as const, duration: 1, width: 3840, height: 2160, fps: 30, has_audio: false };
  await app.store.update(id, "test", (project) => void project.media.push(media));
  const pick = async (width: number, shown: number) => (await zoomSource(app, media, { width }, 3840, shown)).path;
  // Nothing lighter made yet: the original.
  expect(await pick(1920, 480)).toBe(original);
  const paths = app.media.paths(original);
  still(paths.proxy, "1920x1080");
  // A preview still being made isn't read.
  expect(await pick(1920, 960)).toBe(original);
  fs.writeFileSync(paths.proxyDone, "");
  still(paths.light, "1280x720");
  expect(await pick(1920, 480)).toBe(paths.light);
  expect(await pick(1920, 960)).toBe(paths.proxy);
  // A badge: 480 px of a 4K frame is 160 in the light preview, 240 in the preview.
  expect(await pick(480, 480)).toBe(original);
  const look = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_media", arguments: { media_id: "m1", times: [0.2, 0.5, 0.8], zoom: { x: 0, y: 0, width: 1920, height: 1080 } } } }, id)) as {
    result: { content: { type: string; text?: string }[]; isError: boolean };
  };
  expect(look.result.isError, look.result.content.map((part) => part.text).join(" ")).toBe(false);
  expect(look.result.content.find((part) => part.text?.includes("zoomed"))!.text).toContain("zoomed to 1920×1080 at 0,0 (from its 1280×720 preview");
  const badge = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_media", arguments: { media_id: "m1", times: [0.5], zoom: { x: 100, y: 100, width: 480, height: 270 } } } }, id)) as {
    result: { content: { type: string; text?: string }[]; isError: boolean };
  };
  expect(badge.result.isError).toBe(false);
  expect(badge.result.content.find((part) => part.text?.includes("zoomed"))!.text).not.toContain("preview");
}, 60_000);
