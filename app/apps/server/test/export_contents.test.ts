// What a re-export's chunks are keyed by (Nov 23, Boyfriends): a media by what it is, never by where it's read from now.
// Nothing here renders or starts a process.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chunkFolders, contentOf, contentsOf } from "../src/exports.ts";
import { classifyCache } from "../src/ledger.ts";
import type { Media, Project } from "../src/model.ts";

const ORIGINAL = "edit/originals/sha256/ab12/a b.mp4";
const cloud = { source: "sha256:ab12", original: ORIGINAL, proxy: "edit/proxies/sha256/ab12.mp4", size: 1000 };

function media(fields: Partial<Media>): Media {
  return { id: "m1", name: "a.mp4", path: "/nowhere/a.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true, ...fields } as Media;
}

const none = () => null;

test("a graphic is its code, wherever its render is read from and under whatever id", () => {
  const graphic = { effect: "subs-01", effect_key: "c50dece1ca41", stacked_alpha: true };
  const local = contentOf(media({ ...graphic, path: "/home/x/effect-renders/subs-01-c50dece1ca41.mp4" }), none);
  const up = contentOf(media({ ...graphic, id: "m900", path: "http://127.0.0.1:7790/api/cloud/preview?key=edit%2Fexports%2Fp%2Feffect-subs-01.mp4", cloud: { source: "sha256:ff", original: "edit/exports/p/effect-subs-01.mp4", proxy: "edit/exports/p/effect-subs-01.mp4", size: 5 } }), none);
  expect(local).not.toBeNull();
  expect(up).toBe(local);
  // Its code changed: another picture.
  expect(contentOf(media({ ...graphic, effect_key: "000000000000" }), none)).not.toBe(local);
  // Another graphic of the same key, or no longer see-through: not the same either.
  expect(contentOf(media({ ...graphic, effect: "subs-02" }), none)).not.toBe(local);
  expect(contentOf(media({ ...graphic, stacked_alpha: false }), none)).not.toBe(local);
});

test("a graphic with no render yet (its still stands in) is never told by its cloud copy", () => {
  expect(contentOf(media({ effect: "cutin-keys", path: "/m/effect-stills/cutin-keys.clear.png", kind: "image", cloud: { ...cloud, proxy: ORIGINAL } }), () => 1000)).toBeNull();
});

test("footage is its cloud source through its URL, a signed URL or a copy here of its size", () => {
  const preview = contentOf(media({ cloud, path: `http://127.0.0.1:7790/api/cloud/preview?key=${encodeURIComponent(ORIGINAL)}` }), none);
  const signed = contentOf(media({ id: "m7", cloud, path: `https://acct.r2.example/bucket/${ORIGINAL.replace(" ", "%20")}?X-Amz-Signature=1` }), none);
  const here = contentOf(media({ cloud, path: "/cache/cloud/originals/sha256/ab12/a b.mp4" }), () => 1000);
  expect(preview).toBe("cloud:sha256:ab12:1000:1920x1080");
  expect(signed).toBe(preview);
  expect(here).toBe(preview);
});

test("a proxy, a file of another size or a missing one is never taken for the original", () => {
  expect(contentOf(media({ cloud, path: "http://127.0.0.1:7790/api/cloud/preview?key=edit%2Fproxies%2Fsha256%2Fab12.mp4" }), none)).toBeNull();
  expect(contentOf(media({ cloud, path: "/cache/proxy.mp4" }), () => 999)).toBeNull();
  expect(contentOf(media({ cloud, path: "/cache/gone.mp4" }), none)).toBeNull();
  expect(contentOf(media({ path: "/home/x/own.mp4" }), () => 1000)).toBeNull();
  expect(contentOf(media({ cloud: { ...cloud, size: 0 }, path: "/cache/a.mp4" }), () => 0)).toBeNull();
});

test("only what can be told is sent to the engine", () => {
  const project = { media: [media({ id: "a", effect: "x", effect_key: "k" }), media({ id: "b", path: "/own.mp4" })] } as unknown as Project;
  expect(Object.keys(contentsOf(project, none))).toEqual(["a"]);
});

test("a part's chunk folder is the project's to clear, and never the last whole export's", () => {
  const cache = fs.mkdtempSync(join(tmpdir(), "edit-part-folders-"));
  try {
    for (const name of ["p1-2", "p1-2_part-25196-25578", "p1-2_1080x1920-Blur", "p1-2_1080x1920-Blur_part-0-90", "p1-2_playback", "p1-22_part-1-2"]) fs.mkdirSync(join(cache, "export-chunks", name), { recursive: true });
    const found = chunkFolders(cache, "p1-2").map((path) => path.slice(path.lastIndexOf("/") + 1)).sort();
    expect(found).toEqual(["p1-2", "p1-2_1080x1920-Blur", "p1-2_1080x1920-Blur_part-0-90", "p1-2_part-25196-25578"]);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
  expect(classifyCache("export-chunks/p1-2_part-25196-25578/ab.mp4")).toEqual({ kind: "chunks", project: "p1-2", evictable: true });
});
