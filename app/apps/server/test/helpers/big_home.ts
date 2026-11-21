// A home the size of a working one, for the cleaner's hold of the server's thread (clean_thread.test.ts): about
// 14,000 cached files by default across many projects (Sphe's Linux Edit, Nov 21: 2,417 media-key folders, 5,200
// cloud copies, a 10 MB project among 22, 1,145 media, 1,300 history saves), each kind the cleaner looks at, and
// projects in each state, so a pass short of room takes every step of its order.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Store } from "../../src/store.ts";

const DAY = 24 * 3600 * 1000;

/** How many of each; `scale` 1 is about 14,000 files. */
export interface Shape {
  projects: number;
  /** Media of each project: half local footage (keyed by the native `mediaKey`), half cloud. */
  media: number;
  /** Legacy media-key folders no project uses (their previews go). */
  unusedFolders: number;
  /** Blocks of each cloud proxy. */
  blocks: number;
  history: number;
  /** One project's file is about this big (bytes of cuts). */
  bigProject: number;
  /** Script mode's scripts, each script.json about `scriptBytes` (the largest four times it). */
  scripts: number;
  scriptBytes: number;
}

export function shapeOf(scale = 1): Shape {
  return {
    projects: Math.round(40 * scale),
    media: 28,
    unusedFolders: Math.round(1200 * scale),
    blocks: 6,
    history: Math.round(1300 * scale),
    bigProject: 10_000_000,
    scripts: Math.round(30 * scale),
    scriptBytes: 2_000_000,
  };
}

export interface BigHome {
  /** How many files were written. */
  files: number;
  ids: string[];
  /** The project made through the store, whose file the others copy (its id is the clock's). */
  template: string;
  /** Each local footage's media-key folder name, and what it is (`footage/<name>`): two homes' trees compare by it. */
  labels: Map<string, string>;
}

/**
 * Writes the home under `store.home` (and its local footage under `footage`). States, by project index: every fifth
 * done (left 8 days), every fifth in work (opened yesterday), the rest idle (4 to 6 days), so with the disk short a
 * pass takes nobody's copies, then the idle projects whole, oldest first.
 */
export async function bigHome(store: Store, footage: string, shape: Shape, now = Date.now()): Promise<BigHome> {
  const home = store.home;
  const cache = store.cacheDir();
  const old = (now - 20 * DAY) / 1000;
  let files = 0;
  const made = new Set<string>();
  const put = (path: string, bytes: number, at = old) => {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!made.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    fs.writeFileSync(path, bytes === 0 ? "" : Buffer.alloc(bytes));
    fs.utimesSync(path, at, at);
    files += 1;
    return path;
  };
  // The project file's shape from the store itself; its copies written straight (thousands through the store are slow).
  const template = store.create("template", { width: 1920, height: 1080, fps: 30 });
  const base = structuredClone(template.project);
  const ids: string[] = [];
  const opened: Record<string, number> = {};
  for (let p = 0; p < shape.projects; p += 1) {
    const id = `p${1_700_000_000_000 + p}-${p}`;
    ids.push(id);
    const media: unknown[] = [];
    for (let m = 0; m < shape.media; m += 1) {
      const name = `f${p}x${m}`;
      if (m % 2 === 0) {
        // Local footage: its media-key folder holds previews, thumbnails, paid analysis.
        const path = put(join(footage, `${name}.mp4`), 10);
        media.push({ id: `m${m}`, name: `${name}.mp4`, path, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: true });
        continue;
      }
      const drive = `${name}DriveFile`;
      const proxy = `edit/proxies/drive/${drive}.mp4`;
      const original = `edit/originals/drive/${drive}/${name}.mp4`;
      media.push({ id: `m${m}`, name: `${name}.mp4`, path: `/nowhere/${name}.mp4`, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: true,
        cloud: { source: `drive:${drive}`, original, proxy, size: 3000 } });
      // Every fourth one played before its proxy was whole: a legacy preview in the media-key folder of its playback
      // address, and now and then the older keys its analysis was carried from.
      if (m % 4 === 1) {
        const { native } = await import("../../src/native/index.ts");
        const { playbackPath } = await import("../../src/cloud_playback.ts");
        const folder = join(cache, native().mediaKey(playbackPath(proxy, 1)));
        put(join(folder, "preview.mp4"), 300);
        put(join(folder, "transcript.json"), 30);
        if (m % 8 === 1) {
          fs.mkdirSync(join(folder, "watch"), { recursive: true });
          fs.writeFileSync(join(folder, "watch", "keys.json"), JSON.stringify({ keys: [createHash("sha1").update(`unused${(p * 7 + m) % 50}`).digest("hex").slice(0, 16)] }));
        }
      }
      const block = join(cache, "cloud", "blocks", createHash("sha1").update(proxy).digest("hex"));
      put(join(block, "meta.json"), 0);
      for (let b = 0; b < shape.blocks; b += 1) put(join(block, String(b)), 1000);
      put(join(cache, "cloud", "sound", "originals", "drive", drive, `${name}.mp4.mov`), 1000);
      put(join(cache, "cloud", "scrub", "drive", drive, "scrub.mp4"), 500);
      put(join(cache, "cloud", original.slice("edit/".length)), 3000);
    }
    const project = { ...structuredClone(base), id, name: `Project ${p}`, media } as Record<string, unknown>;
    // A long edit's file: many small objects, as a timeline is (one long string parses many times faster).
    if (p === 0) project.cuts = Array.from({ length: Math.round(shape.bigProject / 60) }, (_, c) => ({ id: `c${c}`, from: c / 30, to: (c + 1) / 30, media: "m1" }));
    const file = join(home, "projects", `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(project));
    const state = p % 5;
    const last = state === 0 ? now - 8 * DAY : state === 1 ? now - DAY : now - (4 + (p % 3)) * DAY - p * 60_000;
    opened[id] = last;
    fs.utimesSync(file, last / 1000, last / 1000);
    // Its export's leftover chunks, a few days old, and a share's review pieces.
    for (let c = 0; c < 4; c += 1) put(join(cache, "export-chunks", id, `${c}.mp4`), 200);
    put(join(cache, "export-chunks", id, "sound", "0.aac"), 100);
    put(join(cache, "export-chunks", id, "manifest-v1.json"), 10);
    put(join(cache, "playback", `${id}.mp4`), 700);
    for (let h = 0; h < Math.ceil(shape.history / shape.projects); h += 1) put(join(home, "projects", "history", id, `${1_700_000_000_000 + h}.json`), 50, (now - (h + 1) * DAY) / 1000);
  }
  fs.writeFileSync(join(home, "opened.json"), JSON.stringify(opened));
  // The template is a project too (in work: opened now).
  // Media-key folders: those of local footage are found by the native key; the rest are nobody's.
  const { native } = await import("../../src/native/index.ts");
  const labels = new Map<string, string>();
  for (const id of ids) {
    const project = JSON.parse(fs.readFileSync(join(home, "projects", `${id}.json`), "utf8")) as { media: { path: string; cloud?: unknown }[] };
    for (const one of project.media) {
      if (one.cloud !== undefined) continue;
      const key = native().mediaKey(one.path);
      labels.set(key, `footage/${one.path.slice(footage.length + 1)}`);
      const folder = join(cache, key);
      for (const name of ["preview.mp4", "thumbs.jpg", "peaks.bin", "transcript.json"]) put(join(folder, name), 100);
    }
  }
  for (let u = 0; u < shape.unusedFolders; u += 1) {
    const folder = join(cache, createHash("sha1").update(`unused${u}`).digest("hex").slice(0, 16));
    for (const name of ["preview.mp4", "thumbs.jpg", "peaks.bin", "transcript.json"]) put(join(folder, name), 100);
    // A half-written file a day old goes wherever it is.
    if (u % 7 === 0) put(join(folder, "preview.partial.mp4"), 50);
  }
  // Nobody's cloud copies (footage no project here uses any more).
  for (let n = 0; n < Math.round(shape.unusedFolders / 2); n += 1) put(join(cache, "cloud", "proxies", "drive", `goneFile${n}x.mp4`), 800);
  // A few exports, kept by export_retention's rules.
  const exportsDir = join(home, "exports");
  const records: Record<string, unknown[]> = {};
  for (const id of ids.slice(0, 5)) {
    records[id] = [0, 1, 2].map((v) => {
      const finished = now - (30 - v * 10) * DAY;
      const path = put(join(exportsDir, `${id}-v${v}.mp4`), 2000, finished / 1000);
      return { path, name: `${id}-v${v}.mp4`, finished_ms: finished };
    });
  }
  fs.writeFileSync(join(home, "exports.json"), JSON.stringify(records));
  // Script mode's scripts (writer/store.ts): every other one's original a YouTube download in the media, which the
  // cleaner would take as no project's were it not a script's; the rest a recording on the person's disk.
  for (let n = 0; n < shape.scripts; n += 1) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const original = n % 2 === 0 ? put(join(home, "media", "drive", "youtube", `video${n}xx`, "video.mp4"), 4000) : join(footage, `recording${n}.mp4`);
    const words = Math.round((n === 0 ? 6 : 1) * shape.scriptBytes / 40);
    const script = { id, title: `Script ${n}`, revision: 1, sourceKind: "youtube", originalPath: original, words: Array.from({ length: words }, (_, w) => ({ w: "word", s: w, e: w + 1 })) };
    put(join(home, "writer", "scripts", id, "script.json"), 0);
    fs.writeFileSync(join(home, "writer", "scripts", id, "script.json"), JSON.stringify(script));
  }
  // A YouTube download no script nor project uses: it goes.
  put(join(home, "media", "drive", "youtube", "unusedVideo", "video.mp4"), 4000);
  return { files, ids, labels, template: template.project.id };
}

/** Every file under `dir`, relative, sorted, with each media-key folder named by `labels`: what a pass left. */
export function tree(dir: string, labels = new Map<string, string>()): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const one of names) {
      const path = join(at, one.name);
      if (one.isDirectory()) walk(path);
      else out.push(path.slice(dir.length + 1).replace(/(^|\/)([0-9a-f]{16})(?=\/)/, (_whole, before: string, key: string) => `${before}${labels.get(key) ?? key}`));
    }
  };
  walk(dir);
  return out.sort();
}
