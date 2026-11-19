import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { Ledger, classifyCache, classifyMedia, rootsOf, walk, walkSync } from "../src/ledger.ts";
import * as storage from "../src/storage.ts";
import { fixtureHome } from "./helpers/home.ts";

const GB = 1e9;

/** Runs `body` with this disk's free space and size, the cleaner's room-making stood in for. */
function onDisk<T>(disk: { free: () => number; total: number; makeRoom?: (wanted: number) => number }, body: () => T): T {
  const realFree = storage.diskHooks.free;
  const realTotal = storage.diskHooks.total;
  const realRoom = storage.diskHooks.makeRoom;
  storage.resetRoom();
  storage.diskHooks.free = disk.free;
  storage.diskHooks.total = () => disk.total;
  storage.diskHooks.makeRoom = disk.makeRoom ?? (() => 0);
  try {
    return body();
  } finally {
    storage.diskHooks.free = realFree;
    storage.diskHooks.total = realTotal;
    storage.diskHooks.makeRoom = realRoom;
    storage.resetRoom();
  }
}

test("Edit keeps a tenth of the disk free, at least 15 GB and at most 20 GB; copies kept to play sooner stop there, never under the cache's hard floor", () => {
  // A 128 GB Mac 15 GB; kenobi's 245 GB 20 GB (a tenth would be 24.5); JJ's 494 GB and a 2 TB disk 20 GB (a tenth
  // counted JJ's 41 GB free as full, Nov 19); a disk of unknown size the 15 GB.
  onDisk({ free: () => 100 * GB, total: 128 * GB }, () => {
    expect(storage.keepFreeBytes("/x")).toBe(15 * GB);
    expect(storage.cacheFloor("/x")).toBe(15 * GB);
  });
  onDisk({ free: () => 100 * GB, total: 245 * GB }, () => expect(storage.keepFreeBytes("/x")).toBe(20 * GB));
  onDisk({ free: () => 100 * GB, total: 494 * GB }, () => expect(storage.keepFreeBytes("/x")).toBe(20 * GB));
  onDisk({ free: () => 100 * GB, total: 2000 * GB }, () => expect(storage.keepFreeBytes("/x")).toBe(20 * GB));
  onDisk({ free: () => 100 * GB, total: Number.NaN }, () => expect(storage.keepFreeBytes("/x")).toBe(15 * GB));
  // A whole copy on the M4 with 17 GB free of 245: short by 3 GB plus its size, so it streams.
  onDisk({ free: () => 17 * GB, total: 245 * GB }, () => expect(storage.spare("/x", 0, storage.cacheFloor("/x"))).toBe(-3 * GB));
  // The hard floors stay what writes in flight keep.
  expect(storage.CACHE_FLOOR_BYTES).toBe(storage.WORK_FLOOR_BYTES + 1 * GB);
  expect(storage.cacheFloor("/x")).toBeGreaterThanOrEqual(storage.CACHE_FLOOR_BYTES);
});

test("the disk's room: what's free less every write's claim and a new one's need, over its floor; the cleaner asked at most every few minutes", () => {
  onDisk({ free: () => 3 * GB, total: 100 * GB }, () => {
    expect(storage.spare("/x", 1 * GB)).toBe(1 * GB);
    const one = storage.claim(0.5 * GB);
    expect(storage.spare("/x", 1 * GB)).toBe(0.5 * GB);
    // Its own claim isn't counted against it, and it shrinks as it writes.
    expect(storage.spare("/x", 1 * GB, storage.FREE_FLOOR_BYTES, one)).toBe(1 * GB);
    one.bytes = 0.1 * GB;
    expect(storage.claimedBytes()).toBe(0.1 * GB);
    one.release();
    expect(storage.claimedBytes()).toBe(0);
    // Work that fills the disk as it goes leaves room for macOS's swap files too, and copies kept only to play
    // sooner a gigabyte more again, for work that can't stream (kenobi, Nov 17: a swap file took 0.9 GB at once).
    expect(storage.WORK_FLOOR_BYTES).toBe(storage.FREE_FLOOR_BYTES + storage.SWAP_ROOM_BYTES);
    expect(storage.SWAP_ROOM_BYTES).toBeGreaterThanOrEqual(1 * GB);
    expect(storage.spare("/x", 1 * GB, storage.CACHE_FLOOR_BYTES)).toBe(3 * GB - 1 * GB - storage.CACHE_FLOOR_BYTES);
  });
  const asked: number[] = [];
  onDisk({ free: () => 3 * GB, total: 100 * GB, makeRoom: (wanted) => (asked.push(wanted), 7) }, () => {
    expect(storage.askForRoom(4 * GB, 1_000_000)).toBe(7);
    expect(storage.askForRoom(4 * GB, 1_060_000)).toBe(0);
    expect(storage.askForRoom(4 * GB, 1_000_000 + 5 * 60_000)).toBe(7);
  });
  expect(asked).toEqual([4 * GB, 4 * GB]);
});

test("work asked for evicts to keep what Edit keeps free, and is refused only past the writes' floor, in one line with the numbers", () => {
  // Room to spare: nothing asked of the cleaner.
  let asked: number[] = [];
  onDisk({ free: () => 100 * GB, total: 128 * GB, makeRoom: (wanted) => (asked.push(wanted), 0) }, () => {
    expect(storage.admit("/x", 5 * GB, "This import")).toBeNull();
  });
  expect(asked).toEqual([]);
  // 12 GB free for a 5 GB export: the cleaner is asked for 20 GB free (5 GB and the 15 GB kept), frees nothing, and
  // the export still goes ahead (as it did before the floor): only the writes' floor refuses.
  onDisk({ free: () => 12 * GB, total: 128 * GB, makeRoom: (wanted) => (asked.push(wanted), 0) }, () => {
    expect(storage.admit("/x", 5 * GB, "This export")).toBeNull();
  });
  expect(asked).toEqual([20 * GB]);
  // 6 GB free for 9 GB: the cleaner frees 2 GB of projects not in work, still short: refused with the numbers, once.
  asked = [];
  let free = 6 * GB;
  onDisk({ free: () => free, total: 128 * GB, makeRoom: (wanted) => (asked.push(wanted), (free += 2 * GB), 2 * GB) }, () => {
    const said = storage.admit("/x", 9 * GB, "This import", "import it again");
    expect(said).toBe(`This import needs about ${Math.round(9 + storage.WORK_FLOOR_BYTES / GB)} GB free and this ${process.platform === "darwin" ? "Mac" : "computer"} has 8.0 GB. Free some space, then import it again.`);
    // What every write under way still has to write counts against it.
    free = 30 * GB;
    const writing = storage.claim(22 * GB);
    expect(storage.admit("/x", 9 * GB, "This import")).not.toBeNull();
    writing.release();
    expect(storage.admit("/x", 9 * GB, "This import")).toBeNull();
  });
  expect(asked[0]).toBe(9 * GB + 15 * GB);
  // A disk whose free space can't be read refuses nothing.
  onDisk({ free: () => Number.POSITIVE_INFINITY, total: Number.NaN }, () => expect(storage.admit("/x", 1e15, "This import")).toBeNull());
});

test("the ledger: each file once by disk and by project, kept up as files are written and removed, and built off the thread as on it", async () => {
  const { store, cleanup } = fixtureHome("ledger");
  try {
    const home = store.home;
    const cache = store.cacheDir();
    const put = (path: string, bytes: number) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, Buffer.alloc(bytes));
      return path;
    };
    const proxy = put(`${cache}/cloud/proxies/drive/AbcFile0001.mp4`, 1000);
    // The legacy preview of the same file under its media key: one file with two names.
    fs.mkdirSync(`${cache}/0123456789abcdef`, { recursive: true });
    fs.linkSync(proxy, `${cache}/0123456789abcdef/preview.mp4`);
    put(`${cache}/cloud/originals/drive/AbcFile0001/a.mp4`, 5000);
    put(`${cache}/export-chunks/p1-2/0123.mp4`, 300);
    put(`${cache}/export-chunks/p1-2/manifest-v1.json`, 10);
    put(`${cache}/export-chunks/p1-2_playback/0.mp4`, 30);
    put(`${cache}/ahead/p1-2.mp4`, 700);
    put(`${cache}/cloud/exports/p1-2/effect-board-0123456789ab.mp4`, 70);
    put(`${cache}/cloud/pieces/v3/drive/AbcFile0001/native2/1.mp4`, 40);
    put(`${cache}/cleaned/p1-2-m1-0-1000.strip.mp4`, 90);
    put(`${home}/media/drive/AbcFile0001/a.mp4`, 5000);
    put(`${home}/media/p1-2/effect-renders/board.mp4`, 80);
    const roots = rootsOf(home, cache);
    const entries = walkSync(roots);
    // Off the thread, the same files.
    expect((await walk(roots)).map((one) => one.path).sort()).toEqual(entries.map((one) => one.path).sort());
    const ledger = new Ledger();
    ledger.useRoots(roots);
    ledger.replace(entries);
    const [disk] = [...ledger.disks().values()];
    // 1000 once (two names), 5000 + 5000, 300 + 10 + 30 + 700 + 70 + 40 + 90 + 80.
    expect(disk!.bytes).toBe(1000 + 10_000 + 1320);
    expect(disk!.kinds.proxy).toBe(1000);
    expect(disk!.kinds.original).toBe(10_000);
    expect(disk!.kinds.chunks).toBe(330);
    expect(disk!.kinds.ahead).toBe(700);
    expect(disk!.kinds.effects).toBe(150);
    expect(disk!.kinds.pieces).toBe(40);
    expect(disk!.kinds.strips).toBe(90);
    // By project: what a folder names is that project's at once; the rest waits for the cleaner to say whose.
    const projects = ledger.projects();
    expect(projects.get("p1-2")!.bytes).toBe(300 + 30 + 700 + 70 + 80);
    // A file two projects use counts in each, once in each, and once on the disk.
    for (const entry of ledger.all()) if (entry.path === proxy || entry.path.endsWith("/preview.mp4")) entry.owners = ["p1-2", "p9-9"];
    expect(ledger.projects().get("p9-9")!.bytes).toBe(1000);
    expect(ledger.projects().get("p1-2")!.bytes).toBe(300 + 30 + 700 + 70 + 80 + 1000);
    expect([...ledger.disks().values()][0]!.bytes).toBe(1000 + 10_000 + 1320);
    // Removed: a file, then a folder and all under it.
    fs.rmSync(`${cache}/ahead/p1-2.mp4`);
    ledger.forget(`${cache}/ahead/p1-2.mp4`);
    ledger.forget(`${cache}/export-chunks`);
    expect([...ledger.disks().values()][0]!.bytes).toBe(1000 + 10_000 + 1320 - 700 - 340);
    expect(ledger.projects().get("p1-2")!.bytes).toBe(70 + 80 + 1000);
    // Written: counted at once, and again with its new size.
    const landed = put(`${cache}/cloud/proxies/drive/NewFile0001.mp4`, 400);
    ledger.note(landed);
    expect([...ledger.disks().values()][0]!.kinds.proxy).toBe(1400);
    fs.writeFileSync(landed, Buffer.alloc(600));
    ledger.note(landed);
    expect([...ledger.disks().values()][0]!.kinds.proxy).toBe(1600);
    // Outside its roots: not Edit's to count.
    ledger.note("/etc/hosts");
    expect(ledger.get("/etc/hosts")).toBeUndefined();
    expect(ledger.summary()).toContain("GB in");
  } finally {
    cleanup();
  }
});

test("what each file is: originals, proxies and derived copies are Edit's to take by state; paid strips, renders a project plays and a person's files never", () => {
  expect(classifyCache("cloud/originals/drive/x/a.mp4")).toEqual({ kind: "original", project: null, evictable: true });
  expect(classifyCache("cloud/blocks/0a1b/12")).toMatchObject({ kind: "proxy", evictable: true });
  expect(classifyCache("cloud/sound/originals/drive/x/a.mp4.mov")).toMatchObject({ kind: "derived", evictable: true });
  expect(classifyCache("cloud/excerpts/originals/drive/x/a.mp4/cells/0.mp4")).toMatchObject({ kind: "excerpts", evictable: true });
  expect(classifyCache("cloud/exports/p1-2/effect-board-0123.mp4")).toEqual({ kind: "effects", project: "p1-2", evictable: true });
  expect(classifyCache("cloud/exports/playback/p1-2/a.mp4")).toEqual({ kind: "derived", project: "p1-2", evictable: true });
  expect(classifyCache("cloud/tmp/up.mp4")).toMatchObject({ kind: "other", evictable: false });
  expect(classifyCache("export-chunks/p1-2/manifest-v1.json")).toMatchObject({ kind: "other", evictable: false });
  expect(classifyCache("export-chunks/p1-2/review/ab.mp4")).toEqual({ kind: "chunks", project: "p1-2", evictable: true });
  expect(classifyCache("export-chunks/p1-2_playback/0.mp4")).toEqual({ kind: "chunks", project: "p1-2", evictable: true });
  expect(classifyCache("ahead/p1-2.mp4.json")).toEqual({ kind: "ahead", project: "p1-2", evictable: true });
  expect(classifyCache("playback/p1-2.mp4")).toEqual({ kind: "derived", project: "p1-2", evictable: true });
  expect(classifyCache("cleaned/x.strip.mp4")).toMatchObject({ kind: "strips", evictable: false });
  expect(classifyCache("0123456789abcdef/preview.mp4")).toMatchObject({ kind: "proxy", evictable: true });
  expect(classifyCache("0123456789abcdef/transcript.json")).toMatchObject({ kind: "other", evictable: false });
  expect(classifyMedia("drive/1AbCdEfGhIj/a.mp4")).toEqual({ kind: "original", project: null, evictable: true });
  expect(classifyMedia("p1-2/drive/1AbCdEfGhIj/a.mp4")).toEqual({ kind: "original", project: "p1-2", evictable: true });
  expect(classifyMedia("drive/youtube/jNQXAC9IVRw/zoo.mp4")).toMatchObject({ kind: "original", evictable: true });
  expect(classifyMedia("p1-2/effect-renders/board.mp4")).toEqual({ kind: "effects", project: "p1-2", evictable: false });
  expect(classifyMedia("p1-2/My cut.mp4")).toMatchObject({ evictable: false });
  expect(classifyMedia("p1-2/smooth/Shot.mp4")).toMatchObject({ evictable: false });
});
