// Maps in coded effects (effect_map.ts, effect_map.html, map_tiles.ts). Nov 17, Sphe's M4 busy with an import,
// downloads and censor checks: every map date title failed "the map's tiles didn't come in time", find() having given
// a place's heights a fixed 15 s while the tiles were still coming. A wait now goes on while tiles keep coming, a
// refusal says what it is, and tiles are kept on disk as long as Google allows, so a second look is read off it.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import * as devtools from "../src/chrome_devtools.ts";
import * as effectMap from "../src/effect_map.ts";
import * as mapTiles from "../src/map_tiles.ts";
import * as relay from "../src/relay.ts";
import * as seams from "../src/seams.ts";
import * as storage from "../src/storage.ts";

// ── The tiles kept on disk ──

const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-map-tiles-"));
const RELAY_BEFORE = process.env.EDIT_RELAY_URL;
const TOKEN_BEFORE = process.env.EDIT_RELAY_TOKEN;
const freeBefore = storage.diskHooks.free;
/** What the stand-in relay was asked, by path. */
const asked = new Map<string, number>();
let cacheControl = "private, max-age=14400, must-revalidate, no-transform";
let slowMs = 0;
let relayServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  relayServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      asked.set(url.pathname, (asked.get(url.pathname) ?? 0) + 1);
      if (slowMs > 0) await Bun.sleep(slowMs);
      if (url.pathname.endsWith("/refused.glb")) return Response.json({ error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" } }, { status: 403 });
      return new Response(`tile ${url.pathname} ${url.searchParams.get("session")}`, { headers: { "content-type": "model/gltf-binary", "cache-control": cacheControl, etag: "CIHB7tcG" } });
    },
  });
  process.env.EDIT_RELAY_URL = `http://127.0.0.1:${relayServer.port}`;
  process.env.EDIT_RELAY_TOKEN = "test-token";
  storage.diskHooks.free = () => 100e9;
});

afterAll(() => {
  void relayServer.stop(true);
  if (RELAY_BEFORE === undefined) delete process.env.EDIT_RELAY_URL;
  else process.env.EDIT_RELAY_URL = RELAY_BEFORE;
  if (TOKEN_BEFORE === undefined) delete process.env.EDIT_RELAY_TOKEN;
  else process.env.EDIT_RELAY_TOKEN = TOKEN_BEFORE;
  storage.diskHooks.free = freeBefore;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  asked.clear();
  cacheControl = "private, max-age=14400, must-revalidate, no-transform";
  slowMs = 0;
  fs.rmSync(dir, { recursive: true, force: true });
  mapTiles.forgetSizes();
});

const tileAt = (path: string, session = "s1") => new URL(`http://127.0.0.1:7700/v1/3dtiles/datasets/x/files/${path}?session=${session}&key=relay`);
const ask = (url: URL) => relay.forwardTiles(new Request(url.toString(), { headers: { origin: "http://t3.localhost:7700" } }), url, dir);

test("a tile is kept as long as Google's answer allows, and a second look reads it off the disk", async () => {
  const first = await ask(tileAt("a.glb"));
  expect(first.status).toBe(200);
  expect(await first.text()).toBe("tile /v1/3dtiles/datasets/x/files/a.glb s1");
  // Another session's asking (a restart, the next two hours) is the same tile.
  const again = await ask(tileAt("a.glb", "s2"));
  expect(again.status).toBe(200);
  expect(await again.text()).toBe("tile /v1/3dtiles/datasets/x/files/a.glb s1");
  expect(again.headers.get("content-type")).toBe("model/gltf-binary");
  expect(again.headers.get("etag")).toBe("CIHB7tcG");
  expect(again.headers.get("access-control-allow-origin")).toBe("http://t3.localhost:7700");
  expect(Number(/max-age=(\d+)/.exec(again.headers.get("cache-control") ?? "")?.[1])).toBeGreaterThan(14000);
  expect(asked.get("/v1/3dtiles/datasets/x/files/a.glb")).toBe(1);
});

test("a tile past its max-age is asked again, and one Google says not to keep never is", async () => {
  await ask(tileAt("b.glb"));
  const now = Date.now();
  expect(mapTiles.read(dir, tileAt("b.glb"), now + 14_399_000)).not.toBeNull();
  expect(mapTiles.read(dir, tileAt("b.glb"), now + 14_401_000)).toBeNull();
  await ask(tileAt("b.glb"));
  expect(asked.get("/v1/3dtiles/datasets/x/files/b.glb")).toBe(2);

  cacheControl = "no-store";
  await ask(tileAt("c.glb"));
  await ask(tileAt("c.glb"));
  expect(asked.get("/v1/3dtiles/datasets/x/files/c.glb")).toBe(2);
  expect(mapTiles.maxAgeOf("private, max-age=14400, must-revalidate")).toBe(14400);
  expect(mapTiles.maxAgeOf("private, no-cache, max-age=60")).toBeNull();
  expect(mapTiles.maxAgeOf(null)).toBeNull();
});

test("pages asking for one tile at once wait on the one fetch, and a refusal is passed on, not kept", async () => {
  slowMs = 150;
  const answers = await Promise.all([ask(tileAt("d.glb")), ask(tileAt("d.glb", "s2")), ask(tileAt("d.glb"))]);
  expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
  expect(await Promise.all(answers.map((answer) => answer.text()))).toEqual(Array(3).fill("tile /v1/3dtiles/datasets/x/files/d.glb s1"));
  expect(asked.get("/v1/3dtiles/datasets/x/files/d.glb")).toBe(1);

  slowMs = 0;
  const refused = await ask(tileAt("refused.glb"));
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("API key not valid");
  await ask(tileAt("refused.glb"));
  expect(asked.get("/v1/3dtiles/datasets/x/files/refused.glb")).toBe(2);
});

test("past the most kept, the least lately used tiles go first", async () => {
  const now = Date.now();
  const body = new Uint8Array(1000);
  const headers = new Headers({ "cache-control": "max-age=14400" });
  for (let n = 0; n < 4; n++) mapTiles.keep(dir, tileAt(`${n}.glb`), headers, body, now + n);
  // The first is looked at again: the second is now the one used longest ago.
  expect(mapTiles.read(dir, tileAt("0.glb"), now + 10)).not.toBeNull();
  const most = mapTiles.limits.mostBytes;
  mapTiles.limits.mostBytes = 4500;
  try {
    mapTiles.keep(dir, tileAt("4.glb"), headers, body, now + 20);
  } finally {
    mapTiles.limits.mostBytes = most;
  }
  const kept = [0, 1, 2, 3, 4].filter((n) => mapTiles.read(dir, tileAt(`${n}.glb`), now + 30) !== null);
  expect(kept).toContain(0);
  expect(kept).toContain(4);
  expect(kept).not.toContain(1);
  expect(fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(join(dir, name)).size, 0)).toBeLessThanOrEqual(4500 * 0.8);
});

test("the disk short of its floor keeps nothing", async () => {
  storage.diskHooks.free = () => storage.CACHE_FLOOR_BYTES - 1;
  try {
    await ask(tileAt("e.glb"));
    await ask(tileAt("e.glb"));
  } finally {
    storage.diskHooks.free = () => 100e9;
  }
  expect(asked.get("/v1/3dtiles/datasets/x/files/e.glb")).toBe(2);
});

// ── The helper's waits, in Chrome, on a stand-in Cesium ──

/**
 * Cesium as far as the helper uses it: its tileset's root asked for, and a
 * place's heights found by walking `LEVELS` levels of tiles one after
 * another, as Google's tree is walked to a point.
 */
const CESIUM = `
window.Cesium = (() => {
  const LEVELS = 6;
  const get = (url) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", url);
    request.responseType = "arraybuffer";
    request.onload = () => (request.status < 300 ? resolve(request.response) : reject({ statusCode: request.status }));
    request.onerror = () => reject({ statusCode: 0 });
    request.send();
  });
  const event = () => { const heard = []; return { addEventListener: (one) => heard.push(one), raise: () => heard.forEach((one) => one()) }; };
  const C = {
    Resource: function (options) { this.url = options.url; },
    GoogleMaps: {},
    Credit: function () {},
    RequestScheduler: {},
    Color: { BLACK: {} },
    PostProcessStage: function () {},
    JulianDate: { fromIso8601: () => ({}) },
    Math: { toRadians: (d) => (d * Math.PI) / 180, toDegrees: (r) => (r * 180) / Math.PI },
    Cartographic: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    HeadingPitchRange: function () {},
    Matrix4: { IDENTITY: {} },
  };
  const tiles = () => C.GoogleMaps.mapTilesApiEndpoint.url + "v1/3dtiles/";
  C.CesiumWidget = function (holder) {
    this.canvas = document.createElement("canvas");
    holder.appendChild(this.canvas);
    this.resize = () => {};
    const scene = {
      camera: { setView() {}, lookAt() {}, lookAtTransform() {}, positionCartographic: { height: 0 } },
      postProcessStages: { add() {}, fxaa: {} },
      screenSpaceCameraController: {},
      primitives: { add: (tileset) => (scene.tileset = tileset) },
      initializeFrame() {},
      render() {},
      sampleHeightMostDetailed: async (points) => {
        for (let level = 0; level < LEVELS; level++) {
          await get(tiles() + "datasets/x/files/level-" + level + ".glb?session=s1");
          scene.tileset.tileLoad.raise();
        }
        return points.map(() => ({ height: 12 }));
      },
    };
    this.scene = scene;
  };
  C.createGooglePhotorealistic3DTileset = async () => {
    await get(tiles() + "root.json?key=relay");
    return { tileLoad: event(), tilesLoaded: true };
  };
  return C;
})();
`;

/** The page: a map opened and a place found, as a map date title does. */
const PAGE = `<!doctype html><html><body>
<script src="edit-map/map.js?stall=2000"></script>
<script>
window.result = (async () => {
  const started = performance.now();
  try {
    const map = await EditMap.open({ tone: "natural" });
    const place = await map.find("Hymon Circle, Bunnell, FL");
    return { ground: place.ground, ms: performance.now() - started };
  } catch (error) {
    return { error: String((error && error.message) || error), ms: performance.now() - started };
  }
})();
</script></body></html>`;

/** How the stand-in tiles answer: in time, slowly, a byte at a time, never, or refused. */
let mode: "slow" | "trickle" | "stuck" | "unconfigured" | "google-key" = "slow";
let pages: ReturnType<typeof Bun.serve> | null = null;
const chrome = seams.broll.chrome();

function servePages(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const cors = { "access-control-allow-origin": "*" };
      if (url.pathname === "/fx/scene.html") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/fx/edit-map/cesium/Cesium.js") return new Response(CESIUM, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/fx/edit-map/place") return Response.json({ lat: 29.47, lon: -81.26, address: "Hymon Circle, Bunnell, FL" });
      if (url.pathname.startsWith("/fx/edit-map/v1/3dtiles/")) {
        const root = url.pathname.endsWith("/root.json");
        if (mode === "unconfigured" && root) return Response.json({ error: "Maps are not configured on the relay yet." }, { status: 503, headers: cors });
        if (root) return Response.json({ root: {} }, { headers: cors });
        const level = Number(/level-(\d+)/.exec(url.pathname)?.[1] ?? 0);
        if (mode === "google-key" && level === 2) return Response.json({ error: { code: 403, message: "API key not valid. Please pass a valid API key.", status: "PERMISSION_DENIED" } }, { status: 403, headers: cors });
        if (mode === "stuck" && level === 2) return new Promise<Response>(() => {});
        if (mode === "trickle" && level === 2) {
          // One tile coming over 3.5 s, past the 2 s stall, its bytes arriving all the while.
          let sent = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              await Bun.sleep(500);
              controller.enqueue(new Uint8Array(4096).fill(sent));
              if (++sent === 7) controller.close();
            },
          });
          return new Response(body, { headers: { ...cors, "content-type": "model/gltf-binary" } });
        }
        // Each level 0.9 s: the place's heights take 5.4 s in all, well past the 2 s stall.
        await Bun.sleep(900);
        return new Response(new Uint8Array(64), { headers: { ...cors, "content-type": "model/gltf-binary" } });
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "fx") {
        const served = await effectMap.serve(null as never, request, parts.slice(1));
        if (served !== null) return served;
      }
      return new Response("not found", { status: 404 });
    },
  });
}

afterAll(() => void pages?.stop(true));

async function findPlace(): Promise<{ ground?: number; error?: string; ms: number }> {
  pages ??= servePages();
  const page = await devtools.open({ profile: "edit-map-test-", width: 320, height: 180, gpu: false, what: "Testing the map" });
  try {
    await page.call("Page.navigate", { url: `http://127.0.0.1:${pages.port}/fx/scene.html` });
    return await page.evaluate("new Promise((done) => { const wait = () => (window.result ? window.result.then(done) : setTimeout(wait, 50)); wait(); })", 30_000);
  } finally {
    page.close();
  }
}

test.skipIf(chrome === null)("a place's heights wait as long as their tiles keep coming, however long that is", async () => {
  mode = "slow";
  const slow = await findPlace();
  expect(slow.error).toBeUndefined();
  expect(slow.ground).toBe(12);
  expect(slow.ms).toBeGreaterThan(5000);

  // A tile whose bytes take longer than the stall to arrive is still coming.
  mode = "trickle";
  const trickle = await findPlace();
  expect(trickle.error).toBeUndefined();
  expect(trickle.ground).toBe(12);
}, 60_000);

test.skipIf(chrome === null)("tiles that stop coming are given up on after the stall, saying so", async () => {
  mode = "stuck";
  const stuck = await findPlace();
  expect(stuck.error).toBe("the map's tiles stopped coming: none came in 2 s, 1 asked for and unanswered (Edit's server or its relay isn't answering)");
  expect(stuck.ms).toBeLessThan(10_000);
}, 60_000);

test.skipIf(chrome === null)("a refusal says what it is, at once, never as a timeout", async () => {
  mode = "unconfigured";
  const unconfigured = await findPlace();
  expect(unconfigured.error).toBe("the map's tiles were refused: Maps are not configured on the relay yet.");

  mode = "google-key";
  const key = await findPlace();
  expect(key.error).toBe("Google refused the map's key (Google: API key not valid. Please pass a valid API key.)");
  // Refused as it came (two levels in), not after the stall.
  expect(key.ms).toBeLessThan(2000 + 2 * 900 + 1000);
}, 60_000);
