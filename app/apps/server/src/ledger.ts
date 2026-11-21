// The one ledger of Edit's bytes on this computer, by project and kind, per
// disk (the local-first plan's first step, Nov 18: storage had five owners,
// a budget of a quarter of free space capped at 50 GB, and no answer to "how
// much does this project hold here"). Built from what's on the disks: off
// the server's thread when the server starts and at each of the cleaner's
// passes (`walk`), synchronously only where a caller already walked
// (`walkSync`, the cleaner's tests); kept up as Edit writes a big file
// (`note`) and as the cleaner removes one (`forget`). A file with two names
// (a proxy hard-linked as its preview) is one file, counted once wherever it
// is counted. The cleaner (cache_cleanup.ts) says whose each file is from the
// projects' media and evicts by project state from it; admission
// (storage.ts `admit`) asks the cleaner for room from it before work starts.

import * as fs from "node:fs";

import { join } from "./paths.ts";

/**
 * What a file is to a project: its `original` (a copy of the full-quality file), its `proxy` (what plays: a whole
 * proxy, its blocks, a legacy preview), its `pieces` (a long video's pieced proxy, the window's cuts and joins), its
 * `excerpts` (an export's stretches of originals), its cleaned `strips` (paid removal), its `effects` (renders), its
 * export `chunks` (and a share's review pieces), its `ahead` export, `derived` (sound copies, scrub copies, smooth
 * playback renders, review copies), or `other` (Edit's own state, paid analysis, fonts, tiles).
 */
export type Kind = "original" | "proxy" | "pieces" | "excerpts" | "strips" | "effects" | "chunks" | "ahead" | "derived" | "other";

export const KINDS: readonly Kind[] = ["original", "proxy", "pieces", "excerpts", "strips", "effects", "chunks", "ahead", "derived", "other"];

/**
 * How readily a kind leaves a project that isn't in work: 0 its derived copies (made again from what's here or in
 * the cloud), 1 its proxies and renders' copies (fetched again to play), 2 its originals (only a done project's, only
 * once R2 has said it holds them). Null: never by project (paid results, Edit's own state).
 */
export function tierOf(kind: Kind): 0 | 1 | 2 | null {
  switch (kind) {
    case "ahead":
    case "chunks":
    case "pieces":
    case "excerpts":
    case "derived":
      return 0;
    case "proxy":
    case "effects":
      return 1;
    case "original":
      return 2;
    default:
      return null;
  }
}

export interface Entry {
  path: string;
  bytes: number;
  /** `dev:ino`: the file, whichever of its names this is. */
  file: string;
  /** The disk it's on (`stat.dev`). */
  disk: number;
  kind: Kind;
  /** When it was last written (ms). */
  at: number;
  /** The project its folder names (`export-chunks/<id>`, `ahead/<id>.mp4`…), else null: the cleaner works out whose it is. */
  project: string | null;
  /** Whether the cleaner may take it for a project's state: only Edit's own copies, never a project's own media or a file of the person's. */
  evictable: boolean;
  /** The projects using it, as the cleaner last worked out (empty: none here, or not known yet). */
  owners: string[];
}

/** What a path under a root is. */
export interface Class {
  kind: Kind;
  project: string | null;
  evictable: boolean;
}

/** A project id from a folder or file name (exports.ts and the engine write them with anything but `[A-Za-z0-9_-]` as `_`). */
const ID = /^[A-Za-z0-9_-]+$/;

/** What a file at `relative` under the cache is. */
export function classifyCache(relative: string): Class {
  const parts = relative.split("/");
  const [top, second, third] = parts;
  const own = (kind: Kind, project: string | null = null): Class => ({ kind, project: project !== null && ID.test(project) ? project : null, evictable: true });
  const keep = (kind: Kind): Class => ({ kind, project: null, evictable: false });
  if (top === "cloud") {
    switch (second) {
      case "originals":
        return own("original");
      case "proxies":
      case "blocks":
        return own("proxy");
      case "pieces":
        return own("pieces");
      case "excerpts":
        return own("excerpts");
      case "sound":
      case "scrub":
        return own("derived");
      case "exports": {
        // `exports/playback/<id>/…` (smooth playback's), `exports/<id>/effect-…` (an effect's render).
        if (third === "playback") return own("derived", parts[3] ?? null);
        if (parts.length >= 4 && (parts[3] ?? "").startsWith("effect-")) return own("effects", third ?? null);
        return own("derived", third ?? null);
      }
      default:
        // tmp (files on their way up), local-originals.json.
        return keep("other");
    }
  }
  if (top === "export-chunks" && second !== undefined && parts.length >= 3) {
    // `<id>_playback` is smooth playback's chunks of the same project (playback_stream.ts).
    const id = second.replace(/_playback$/, "");
    // Its manifest and plan say where the last export's chunks are: nothing to free, and what a re-export reads.
    if (parts.length === 3 && /^(manifest|plan)-v\d+\.json$/.test(third ?? "")) return keep("other");
    return own("chunks", id);
  }
  if (top === "ahead" && second !== undefined) return own("ahead", second.replace(/\.mp4(\.json)?$/, ""));
  if (top === "playback" && second !== undefined) return own("derived", second.replace(/\.mp4$/, ""));
  if ((top === "reviews" || top === "range-exports") && second !== undefined && parts.length >= 3) return own("derived", second);
  if (top === "cleaned" || top === "watermarks") return keep("strips");
  if (top !== undefined && /^[0-9a-f]{16}$/.test(top) && parts.length === 2 && /^preview/.test(second ?? "")) return own("proxy");
  return keep("other");
}

/** What a file at `relative` under `<home>/media` is: Edit's own downloads of originals, else a project's own media (never evicted by state). */
export function classifyMedia(relative: string): Class {
  const download = /^(?:([A-Za-z0-9_-]+)\/)?drive\/(?:youtube\/)?[A-Za-z0-9_-]{6,}\/[^/]+$/.exec(relative);
  if (download !== null && download[1] !== "drive") return { kind: "original", project: download[1] ?? null, evictable: true };
  const [project, folder] = relative.split("/");
  const id = project !== undefined && ID.test(project) ? project : null;
  if (folder === "effect-renders") return { kind: "effects", project: id, evictable: false };
  if (folder === "smooth") return { kind: "derived", project: id, evictable: false };
  return { kind: "other", project: id, evictable: false };
}

/**
 * What a file at `relative` under Script mode's scripts (`<home>/writer/scripts`, writer/store.ts) is: a recording's
 * whole copy kept in a script's `.originals/<folder>/` (writer/streamed.ts) is an original Edit may give up for room,
 * by Script mode's own word only (`scriptCopies`: once the cloud has it, never while it's cut from); a copy read for one
 * piece (`.originals/read-here/`) is the import's, and anything else there (`held.json`) Edit's own state.
 */
export function classifyScripts(relative: string): Class {
  const parts = relative.split("/");
  if (parts.length === 4 && parts[1] === ".originals" && parts[2] !== "read-here") return { kind: "original", project: null, evictable: true };
  return { kind: parts[1] === ".originals" && parts[2] === "read-here" ? "original" : "other", project: null, evictable: false };
}

/** Only a script's `.originals/` is walked: its own footage, preview and words are Script mode's (writer/storage.ts). */
function inScriptsOriginals(relative: string, folder: boolean): boolean {
  const parts = relative.split("/");
  return folder ? parts.length === 1 || parts[1] === ".originals" : parts.length >= 3 && parts[1] === ".originals";
}

/** A root the ledger keeps, and how its files are told apart. */
export interface Root {
  dir: string;
  classify: (relative: string) => Class;
  /** Which folders are walked and which files kept (by their path under `dir`); all when unset. */
  enter?: (relative: string, folder: boolean) => boolean;
}

/** Script mode's scripts in a data folder (writer/store.ts `scriptsRoot`, named here so the ledger imports nothing of Script mode's). */
export const scriptsOf = (home: string): string => join(home, "writer", "scripts");

/**
 * The roots of a data folder: its cache, its media, and the recordings Script mode keeps here (Nov 21: they were
 * removed the moment they were up, and Start the edit read each back over the line; now they stay until the disk
 * needs the room, so they're counted, and given up, with the rest).
 */
export function rootsOf(home: string, cache: string): Root[] {
  return [
    { dir: cache, classify: classifyCache },
    { dir: join(home, "media"), classify: classifyMedia },
    { dir: scriptsOf(home), classify: classifyScripts, enter: inScriptsOriginals },
  ];
}

/**
 * Script mode's word on its copies (writer/streamed.ts sets it): with the disk `short()` of what's wanted, the copies
 * the cloud holds and nothing cuts from, given up oldest-unused first until it isn't, each told to `took` (its folder
 * and bytes); with `dryRun`, only told. The cleaner asks (cache_cleanup.ts); nothing is given up while unset.
 */
export const scriptCopies = {
  letGo: (_short: () => number, _took: (path: string, bytes: number) => void, _dryRun: boolean): void => {},
};

function entryOf(root: Root, path: string, stat: fs.Stats): Entry {
  const sort = root.classify(path.slice(root.dir.length + 1));
  return { path, bytes: stat.size, file: `${stat.dev}:${stat.ino}`, disk: stat.dev, kind: sort.kind, at: stat.mtimeMs, project: sort.project, evictable: sort.evictable, owners: sort.project === null ? [] : [sort.project] };
}

/** Every file under `roots`, read on this thread (a caller that walks anyway; tests). */
export function walkSync(roots: Root[]): Entry[] {
  const out: Entry[] = [];
  for (const root of roots) {
    const stack = [root.dir];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      let names: string[];
      try {
        names = fs.readdirSync(at);
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(at, name);
        try {
          const stat = fs.lstatSync(path);
          if (root.enter !== undefined && !root.enter(path.slice(root.dir.length + 1), stat.isDirectory())) continue;
          if (stat.isDirectory()) stack.push(path);
          else if (stat.isFile()) out.push(entryOf(root, path, stat));
        } catch {
          // Gone meanwhile.
        }
      }
    }
  }
  return out;
}

/** Folders read at once by `walk`. */
const WALK_AT_ONCE = 8;

/**
 * Every file under `roots`, read off the server's thread (fs.promises, a few folders at a time): 15,000 files in a
 * dev cache never hold a request up, where the cleaner's walk of them on the thread stalled every request while the
 * disk was short (Astra's audit, Nov 18).
 */
export async function walk(roots: Root[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const root of roots) {
    const queue = [root.dir];
    const one = async (dir: string) => {
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(dir, name);
        try {
          const stat = await fs.promises.lstat(path);
          if (root.enter !== undefined && !root.enter(path.slice(root.dir.length + 1), stat.isDirectory())) continue;
          if (stat.isDirectory()) queue.push(path);
          else if (stat.isFile()) out.push(entryOf(root, path, stat));
        } catch {
          // Gone meanwhile.
        }
      }
    };
    while (queue.length > 0) await Promise.all(queue.splice(0, WALK_AT_ONCE).map(one));
  }
  return out;
}

/** Bytes by kind, each file once. */
export interface Totals {
  bytes: number;
  files: number;
  kinds: Record<Kind, number>;
}

function emptyTotals(): Totals {
  return { bytes: 0, files: 0, kinds: Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<Kind, number> };
}

function add(totals: Totals, entry: Entry): void {
  totals.bytes += entry.bytes;
  totals.files += 1;
  totals.kinds[entry.kind] += entry.bytes;
}

/** The ledger itself: one per server (`ledger`). */
export class Ledger {
  private entries = new Map<string, Entry>();
  private roots: Root[] = [];
  /** When it was last built from the disks (0: never). */
  builtAt = 0;

  /** The roots it keeps (set once the data folder is known). */
  useRoots(roots: Root[]): void {
    this.roots = roots;
  }

  /** Every file, as last built and kept up since. */
  replace(entries: Entry[], at = Date.now()): void {
    this.entries = new Map(entries.map((entry) => [entry.path, entry]));
    this.builtAt = at;
  }

  /** Built again from the disks, off the thread. */
  async rebuild(): Promise<Entry[]> {
    const entries = await walk(this.roots);
    // What a cleaner pass worked out about whose each file is stays until it works it out again.
    for (const entry of entries) {
      const was = this.entries.get(entry.path);
      if (was !== undefined && was.file === entry.file && entry.project === null) entry.owners = was.owners;
    }
    this.replace(entries);
    return entries;
  }

  /** Whether it keeps the files under `dir` (its roots were set for that data folder). */
  covers(dir: string): boolean {
    return this.builtAt > 0 && this.roots.some((root) => root.dir === dir);
  }

  all(): Entry[] {
    return [...this.entries.values()];
  }

  get(path: string): Entry | undefined {
    return this.entries.get(path);
  }

  /** A file just written (a download landed, a copy made): counted now, not at the next build. Whose it is comes at the cleaner's next pass. */
  note(path: string): void {
    const root = this.roots.find((one) => path.startsWith(`${one.dir}/`));
    if (root === undefined) return;
    try {
      const stat = fs.lstatSync(path);
      if (!stat.isFile()) return;
      const entry = entryOf(root, path, stat);
      const was = this.entries.get(path);
      if (was !== undefined && was.file === entry.file && entry.project === null) entry.owners = was.owners;
      this.entries.set(path, entry);
    } catch {
      this.entries.delete(path);
    }
  }

  /** A file or a folder removed: it and everything under it. */
  forget(path: string): void {
    if (this.entries.delete(path)) return;
    const under = `${path}/`;
    for (const key of this.entries.keys()) if (key.startsWith(under)) this.entries.delete(key);
  }

  /** Each disk's bytes, each file once however many names it has. */
  disks(): Map<number, Totals> {
    const out = new Map<number, Totals>();
    const seen = new Set<string>();
    for (const entry of this.entries.values()) {
      if (seen.has(entry.file)) continue;
      seen.add(entry.file);
      let totals = out.get(entry.disk);
      if (totals === undefined) out.set(entry.disk, (totals = emptyTotals()));
      add(totals, entry);
    }
    return out;
  }

  /** Each project's bytes (a file two projects use counts in both, once in each); "" for files no project here uses. */
  projects(): Map<string, Totals> {
    const out = new Map<string, Totals>();
    const seen = new Set<string>();
    for (const entry of this.entries.values()) {
      for (const owner of entry.owners.length === 0 ? [""] : entry.owners) {
        const key = `${owner}\n${entry.file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let totals = out.get(owner);
        if (totals === undefined) out.set(owner, (totals = emptyTotals()));
        add(totals, entry);
      }
    }
    return out;
  }

  /** "28.1 GB: originals 2.2, proxies 4.9, …" for the log. */
  summary(disk?: number): string {
    const all = this.disks();
    const totals = emptyTotals();
    for (const [at, one] of all) {
      if (disk !== undefined && at !== disk) continue;
      totals.bytes += one.bytes;
      totals.files += one.files;
      for (const kind of KINDS) totals.kinds[kind] += one.kinds[kind];
    }
    const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
    const kinds = KINDS.filter((kind) => totals.kinds[kind] >= 50_000_000).map((kind) => `${kind} ${gb(totals.kinds[kind])}`);
    return `${gb(totals.bytes)} GB in ${totals.files} files${kinds.length > 0 ? `: ${kinds.join(", ")}` : ""}`;
  }
}

export const ledger = new Ledger();
