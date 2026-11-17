// Maps in coded effects (Edit V2). An effect page that wants the real world
// loads `edit-map/map.js` as if it were in its own folder, and gets Google's
// Photorealistic 3D Tiles in CesiumJS with the camera wholly its own: it aims
// it inside seek(t) like anything else it draws (Sphe, Nov 12: "give the
// agents as much access as possible… whatever it wants to do with the map").
//
//     edit-map/map.js            the helper (effect_map.html): EditMap.open(), find(), look(), fly(), screen(), draw()
//     edit-map/cesium/…          CesiumJS's build, fetched once from jsDelivr and kept in `<cache>/cesium-<version>/`
//     edit-map/v1/3dtiles/…      the tiles, through the relay with this Edit's sign-in (relay.forwardTiles), as V1's map page has them,
//                                kept in `<cache>/map-tiles/` as long as Google allows (map_tiles.ts), so a second look is read off the disk
//     edit-map/place?q=…         where a place is and its building's outline (broll.ts `findPlace`: Google, through the relay, asked once)
//
// All of it is under the effect's own folder, so the page's walls stay as
// they are (effects.ts `policy`): it reaches the network only through Edit,
// and the key never leaves the relay. In the viewer the map plays live,
// sharpening as its tiles come in; the stills and the render wait for every
// tile a frame needs (the helper's draw()), as V1's map render does.

import fs from "node:fs";
import { dirname, join, sep } from "node:path";
import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import helperText from "./effect_map.html" with { type: "text" };
import { serveFile } from "./http/files.ts";
import * as mapTiles from "./map_tiles.ts";
import * as relay from "./relay.ts";
import * as seams from "./seams.ts";

/** The CesiumJS V1's map page uses too (map_page.html). */
export const CESIUM = "1.146.0";
const CDN = `https://cdn.jsdelivr.net/npm/cesium@${CESIUM}/Build/Cesium/`;

/** The helper's code, its <script> tags off (kept as .html like the runtime, so it's text to the server's build). */
const HELPER = (helperText as unknown as string).replace(/^\s*<script>\s*/, "").replace(/\s*<\/script>\s*$/, "");

const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  wasm: "application/wasm",
  css: "text/css; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ktx2: "image/ktx2",
};

/** Cesium's files being fetched now, so two pages asking at once fetch each once. */
const fetching = new Map<string, Promise<void>>();

function cesiumDir(app: App): string {
  return join(app.store.cacheDir(), `cesium-${CESIUM}`);
}

/** One of Cesium's build files on disk, fetched from jsDelivr the first time. */
async function cesiumFile(app: App, path: string): Promise<string | null> {
  const dir = cesiumDir(app);
  const local = join(dir, ...path.split("/"));
  if (!local.startsWith(dir + sep)) return null;
  if (fs.existsSync(local)) return local;
  let pending = fetching.get(local);
  if (pending === undefined) {
    pending = (async () => {
      const answer = await fetch(`${CDN}${path}`, { signal: AbortSignal.timeout(60_000) });
      if (answer.status === 404) return;
      if (!answer.ok) throw new Error(`jsDelivr answered ${answer.status} for ${path}`);
      const bytes = new Uint8Array(await answer.arrayBuffer());
      fs.mkdirSync(dirname(local), { recursive: true });
      const temp = `${local}.${process.pid}.partial`;
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, local);
    })().finally(() => fetching.delete(local));
    fetching.set(local, pending);
  }
  await pending;
  return fs.existsSync(local) ? local : null;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A file under an effect's `edit-map/` (its parts after it), or null when it's
 * none of the map's. The caller adds the effect's own headers (its policy, and
 * that a page with no origin may read it).
 */
export async function serve(app: App, request: Request, parts: string[]): Promise<Response | null> {
  if (parts[0] !== "edit-map" || parts.length < 2) return null;
  const rest = parts.slice(1);
  if (rest.length === 1 && rest[0] === "map.js") {
    return new Response(HELPER, { headers: { "content-type": TYPES.js!, "cache-control": "no-store" } });
  }
  if (rest[0] === "cesium" && rest.length > 1) {
    const path = rest.slice(1).join("/");
    let local: string | null;
    try {
      local = await cesiumFile(app, path);
    } catch (error) {
      diag.warn("effects", `map library ${path}: ${diag.messageOf(error)}`);
      return json({ error: `couldn't fetch the map library (${diag.messageOf(error)})` }, 502);
    }
    if (local === null) return json({ error: "no such file" }, 404);
    const response = serveFile(request, local);
    response.headers.set("content-type", TYPES[local.split(".").pop() ?? ""] ?? "application/octet-stream");
    // A pinned version's files never change.
    response.headers.set("cache-control", "max-age=31536000, immutable");
    return response;
  }
  if (rest[0] === "v1" && rest[1] === "3dtiles") {
    const url = new URL(request.url);
    return relay.forwardTiles(request, new URL(`/${rest.join("/")}${url.search}`, url), mapTiles.folderOf(app.store));
  }
  if (rest.length === 1 && rest[0] === "place") {
    const asked = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if (asked === "") return json({ error: "say which place: edit-map/place?q=<an address or a name>" }, 400);
    try {
      return json(await seams.broll.findPlace(app, asked));
    } catch (error) {
      // The network's (the relay unreachable or slow) is a 502, as a tile's is: the page's wait says it for what it is.
      const said = diag.messageOf(error);
      return json({ error: said }, said.startsWith(relay.UNREACHABLE) ? 502 : 422);
    }
  }
  return null;
}
