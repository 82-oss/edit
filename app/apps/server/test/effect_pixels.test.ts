import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import * as effects from "../src/effects.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";

registerEffectTools();
registerEditingTools();
afterAll(() => effects.closeChrome());

const chrome = seams.broll.chrome();

/**
 * A page that reads its footage's pixels `how` (a 2D canvas's getImageData, WebGL's texImage2D, a VideoFrame) and
 * paints the pixel it read over the whole frame, blue if the read threw; its video in its markup or made by its code
 * and never put on the page, neither asking for CORS (the page doesn't know it has no origin).
 */
const reader = (how: string, made: boolean) => `<!doctype html><body style="margin:0;background:#000">
${made ? "" : '<video id="v" src="shot.mp4" muted playsinline style="display:none"></video>'}
<canvas id="c" width="1920" height="1080" style="position:absolute;inset:0"></canvas><script>
let v = document.getElementById("v");
if (!v) { v = document.createElement("video"); v.muted = true; v.src = "shot.mp4"; }
const out = document.getElementById("c").getContext("2d");
window.duration = 1;
window.ready = new Promise((resolve) => v.addEventListener("loadeddata", resolve, { once: true }));
async function read() {
  if (${JSON.stringify(how)} === "2d") { const c = document.createElement("canvas"); c.width = 64; c.height = 36; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(v, 0, 0, 64, 36); return [...x.getImageData(32, 18, 1, 1).data]; }
  if (${JSON.stringify(how)} === "webgl") { const c = document.createElement("canvas"); const g = c.getContext("webgl2"); const t = g.createTexture(); g.bindTexture(g.TEXTURE_2D, t); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, v); const f = g.createFramebuffer(); g.bindFramebuffer(g.FRAMEBUFFER, f); g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t, 0); const o = new Uint8Array(4); g.readPixels(320, 180, 1, 1, g.RGBA, g.UNSIGNED_BYTE, o); return [...o]; }
  const frame = new VideoFrame(v); const b = new Uint8Array(frame.allocationSize({ format: "RGBA" })); await frame.copyTo(b, { format: "RGBA" }); const at = (180 * 640 + 320) * 4; frame.close(); return [...b.slice(at, at + 4)];
}
window.seek = (t) => new Promise((resolve) => { v.addEventListener("seeked", async () => { let p; try { p = await read(); } catch (e) { p = [0, 0, 255]; } out.fillStyle = "rgb(" + p[0] + "," + p[1] + "," + p[2] + ")"; out.fillRect(0, 0, 1920, 1080); resolve(); }, { once: true }); v.currentTime = 0.5 + t * 0.1; });
</script></body>`;

function write(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, files: Record<string, string>): void {
  const dir = effects.folder(app.store, project, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(join(dir, file), text);
}

/** A picture's average colour, as RGB. */
function colour(path: string): number[] {
  return [...Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout];
}

function near(got: number[], want: number[]): void {
  expect(got.length).toBe(3);
  for (const [at, value] of want.entries()) expect(Math.abs(got[at]! - value)).toBeLessThan(10);
}

test.skipIf(chrome === null)("an effect reads the pixels of footage it's given: through a 2D canvas, WebGL and a VideoFrame, in a look and a render", async () => {
  const home = fixtureHome("effect-pixels");
  const { app, cleanup, dir: scratch } = home;
  const id = app.store.create("Pixels", { width: 1920, height: 1080, fps: 30 }).project.id;
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // Footage of one known colour.
    const clip = join(scratch, "clip.mp4");
    expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xC83214:s=640x360:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]).exitCode).toBe(0);
    await app.store.update(id, "test", (project) => {
      project.media.push({ id: "m9", name: "clip.mp4", path: clip, kind: "video", duration: 3, width: 640, height: 360, fps: 30, has_audio: false });
    });
    const red = [0xc8, 0x32, 0x14];
    for (const how of ["2d", "webgl", "frame"]) {
      for (const made of [false, true]) {
        const name = `read-${how}${made ? "-made" : ""}`;
        await effects.giveFootage(app, id, name, "m9", 0, 3, "shot");
        fs.writeFileSync(join(effects.folder(app.store, id, name), "scene.html"), reader(how, made));
        const look = await effects.look(app, id, name, [0.2]);
        expect(look.errors).toEqual([]);
        const still = join(scratch, `${name}.still`);
        fs.writeFileSync(still, look.stills[0]!.picture);
        near(colour(still), red);
      }
    }
    // And rendered: every frame of it the footage's colour.
    const added = await effects.add(app, id, "read-webgl");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 30, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await seams.broll.waitForMaps(app, id, 90_000);
    const rendered = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    expect(rendered.kind).toBe("video");
    near(colour(rendered.path), red);
    // A seek whose promise never settles, its handler having thrown: said with what the page said, the code's to fix.
    effects.waits.seekMs = 2_000;
    try {
      write(app, id, "stuck", {
        "scene.html": `<!doctype html><body><script>window.duration = 1; window.ready = Promise.resolve();
          window.seek = () => new Promise(() => { setTimeout(() => { throw new Error("The canvas has been tainted"); }); });</script></body>`,
      });
      const error = await effects.look(app, id, "stuck", [0.2]).then(() => null, (thrown: unknown) => thrown);
      expect(String(error)).toContain("seek(0.20) never finished in 2 s, after it said: Uncaught Error: The canvas has been tainted");
      expect(effects.failureKind(error)).toBe("code");
    } finally {
      effects.waits.seekMs = 60_000;
    }
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 240_000);
