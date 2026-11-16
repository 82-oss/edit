import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import * as effects from "../src/effects.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";

// look_at_effect every_frame, in a file of its own beside effects.test.ts: its ~150 frames in Chrome are CI's Mac's
// slowest test (Nov 16: 221 s), and a file is what the server tests' two halves are balanced by.
registerEffectTools();
registerEditingTools();
afterAll(() => effects.closeChrome());

const chrome = seams.broll.chrome();

function hq(name: string, size: { width: number; height: number }) {
  const home = fixtureHome(name);
  const live = home.app.store.create("Welfare check", { ...size, fps: 30 });
  return { ...home, id: live.project.id };
}

function write(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, files: Record<string, string>): string {
  const dir = effects.folder(app.store, project, name);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(join(dir, file, ".."), { recursive: true });
    fs.writeFileSync(join(dir, file), text);
  }
  return dir;
}

// At a third of HD: what's checked is which frames and sheets come back, not their pixels.
test.skipIf(chrome === null)("look_at_effect every_frame: numbered sheets, the looker's reading of a long stretch, beside a reference and zoomed", async () => {
  const { app, cleanup, id } = hq("effects-every", { width: 640, height: 360 });
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // Every frame of a stretch, tiled into numbered sheets: what only moves between frames shows there (Sphe, Nov 12: a board's
    // handwriting shimmered as it drifted, in no single still). At most 48 a look, and where to carry on is said.
    write(app, id, "counter", {
      "scene.html": `<!doctype html><body style="margin:0;background:#222"><canvas id="c" width="640" height="360"></canvas><script>
        const c = document.getElementById("c").getContext("2d");
        window.duration = 3; window.ready = Promise.resolve();
        window.seek = (t) => { c.fillStyle = "#222"; c.fillRect(0, 0, 640, 360); c.fillStyle = "#fff"; c.font = "100px monospace"; c.fillText(String(Math.round(t * 30)), 66, 200); };
      </script></body>`,
    });
    // How long each look takes, said in the log: CI's Mac draws in Chrome many times slower than a desk's Mac.
    const timed = async <T,>(what: string, look: Promise<T>): Promise<T> => {
      const began = performance.now();
      try {
        return await look;
      } finally {
        console.log(`every_frame test: ${what} in ${Math.round(performance.now() - began)} ms`);
      }
    };
    const every = async (args: Record<string, unknown>) => timed(JSON.stringify(args), dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", every_frame: true, ...args } } }, id)).then((answer) => (answer as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result);
    let lapped = performance.now();
    const lap = (what: string) => {
      console.log(`every_frame test: ${what} in ${Math.round(performance.now() - lapped)} ms`);
      lapped = performance.now();
    };
    const half = await every({ start: 0, end: 0.5 });
    expect(half.isError, half.content.map((part) => part.text).join(" ")).toBe(false);
    expect(half.content.filter((part) => part.type === "image").length).toBe(1);
    expect(half.content.find((part) => part.text?.includes("every frame"))!.text).toContain("every frame, 0–14");
    // A long stretch is read by the looker (effect_looker.ts): the agent gets its words and the frames it picks.
    const asked: { input: { type: string }[] }[] = [];
    let answer: () => string = () => JSON.stringify({ motion: "The number counts up by one each frame.", problems: [{ frames: "30–31", what: "It skips back a frame." }], frames: [30, 31, 99] });
    (app.agents as unknown as { ask: (...args: unknown[]) => Promise<string> }).ask = async (_model, _effort, _instructions, input) => {
      asked.push({ input: input as { type: string }[] });
      return answer();
    };
    const long = await every({ start: 0, end: 2 });
    expect(asked.length).toBe(1);
    expect(asked[0]!.input.filter((part) => part.type === "image").length).toBe(3);
    expect(long.content.filter((part) => part.type === "image").length).toBe(1);
    const said = long.content.map((part) => part.text ?? "").join("\n");
    expect(said).toContain("every frame 0–47 (0.00–1.57 s), looked at frame by frame for you");
    expect(said).toContain("- 30–31: It skips back a frame.");
    expect(said).toContain("frames 30, 31,");
    expect(long.content.at(-1)!.text).toContain("Frames 48–59 are left: look again with start 1.600");
    // Every frame when asked for, and when the looker can't answer: the looker's least, 24 frames, two sheets.
    expect((await every({ start: 0, end: 0.8, detail: "full" })).content.filter((part) => part.type === "image").length).toBe(2);
    expect(asked.length).toBe(1);
    answer = () => {
      throw new Error("no Claude Code here");
    };
    expect((await every({ start: 0, end: 0.8 })).content.filter((part) => part.type === "image").length).toBe(2);
    expect(asked.length).toBe(2);
    lapped = performance.now();
    const full = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", times: [1], detail: "full" } } }, id)) as { result: { content: { type: string; text?: string; mimeType?: string }[] } }).result;
    lap("full");
    expect(full.content.find((part) => part.type === "image")!.mimeType).toBe("image/jpeg");
    expect(full.content.find((part) => part.text?.includes("at full size"))).toBeDefined();
    // Beside a reference, zoomed: each of its frames paired with the reference's at the same moment, cropped to one region (Sphe, Nov 12).
    const reference = join(app.store.cacheDir(), "reference.mp4");
    lap("reference");
    expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3:decimals=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", reference]).exitCode).toBe(0);
    await app.store.update(id, "test", (project) => {
      project.media.push({ id: "ref", name: "reference.mp4", path: reference, kind: "video", duration: 3, width: 640, height: 360, fps: 30, has_audio: false });
    });
    const paired = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", every_frame: true, start: 0.5, end: 0.8, beside: { media_id: "ref", start: 1 }, zoom: { x: 30, y: 60, width: 320, height: 180 } } } }, id)) as { result: { content: { type: string; text?: string; data?: string }[]; isError: boolean } }).result;
    lap("paired");
    expect(paired.isError, paired.content.map((part) => part.text).join(" ")).toBe(false);
    const sheetsOut = paired.content.filter((part) => part.type === "image");
    expect(sheetsOut.length).toBe(2);
    expect(paired.content.find((part) => part.text?.includes("beside ref"))!.text).toContain("zoomed to 320×180 at 30,60");
    if (process.env.EDIT_KEEP_SHEET) fs.writeFileSync(process.env.EDIT_KEEP_SHEET, Buffer.from(sheetsOut[0]!.data!, "base64"));
    const one = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", times: [1], zoom: { x: 0, y: 0, width: 320, height: 180 } } } }, id)) as { result: { content: { type: string }[]; isError: boolean } }).result;
    lap("one");
    expect(one.isError).toBe(false);
    expect(one.content.filter((part) => part.type === "image").length).toBe(1);
    const nowhere = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", times: [1], beside: { media_id: "nope", start: 0 } } } }, id)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
    lap("nowhere");
    expect(nowhere.isError).toBe(true);
    // And footage zoomed: a region of the media's own frames.
    const zoomed = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_media", arguments: { media_id: "ref", times: [0.5, 2], zoom: { x: 300, y: 130, width: 240, height: 135 } } } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    lap("zoomed");
    expect(zoomed.isError, zoomed.content.map((part) => part.text).join(" ")).toBe(false);
    expect(zoomed.content.filter((part) => part.type === "image").length).toBe(1);
    // Past the reference's end a pair is still a pair (black on its side), and frames over a look's most are said, not dropped.
    const past = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", every_frame: true, start: 0, end: 1, beside: { media_id: "ref", start: 2.5 }, zoom: { x: 0, y: 0, width: 320, height: 180 } } } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    lap("past");
    expect(past.isError, past.content.map((part) => part.text).join(" ")).toBe(false);
    expect(past.content.filter((part) => part.type === "image").length).toBe(3);
    expect(past.content.at(-1)!.text).toContain("Frames 24–29 are left: look again with start 0.800");
    const stretch = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_media", arguments: { media_id: "ref", every_frame: true, start: 0, end: 1, zoom: { x: 300, y: 130, width: 240, height: 135 } } } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    lap("stretch");
    expect(stretch.isError, stretch.content.map((part) => part.text).join(" ")).toBe(false);
    expect(stretch.content.at(-1)!.text).toContain("Frames 24–29 are left: look again with start 0.800");
  } finally {
    effects.closeChrome();
    await server.stop(true);
    cleanup();
  }
}, 240_000);
