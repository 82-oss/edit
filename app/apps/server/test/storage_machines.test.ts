// Edit's rules with a number in them, held against the team's real Macs and against every state a Mac can be in
// (Nov 19: Edit kept a tenth of every disk free, which counted JJ's 494 GB Mac with 41 GB free as full; no audit
// worked the number out for a real machine). Fable's checks (rust-question.md section 5):
// - every free space from empty to full, not just today's: work is admitted, or refused with a line whose number is
//   enough (free that much and it's admitted);
// - rules of scale: more free room never gives a worse answer, and a bigger disk with the same free room never does;
// - the team's Macs, as their reports said on Nov 19, and the work they do (a 2 GB edit, JJ's 5.5 GB Midland file, a
//   53 GB case), each printed as a plain line a person can read before a number ships.

import { afterEach, expect, test } from "bun:test";

import * as localFirst from "../src/local_first.ts";
import * as storage from "../src/storage.ts";

const GB = 1e9;

/** The team's Macs (their reports, Nov 19). Marc's disk size isn't in his report: the Air's 494 GB, assumed. */
const MACS = [
  { who: "JJ's MacBook Pro", disk: 494 * GB, free: 41 * GB },
  { who: "Marc's MacBook Air", disk: 494 * GB, free: 113 * GB },
  { who: "Sphe's M4 Air", disk: 245 * GB, free: 17 * GB },
  { who: "kenobi (the test M1)", disk: 245 * GB, free: 24 * GB },
];
/** The work the team does: an edit's footage, JJ's biggest file this week, a two-hour compilation, a 53 GB case. */
const WORK = [2 * GB, 5.5 * GB, 12 * GB, 53 * GB];
const DISKS = [128, 245, 256, 494, 512, 1000, 2000].map((size) => size * GB);

const real = { ...storage.diskHooks };
afterEach(() => {
  Object.assign(storage.diskHooks, real);
  storage.resetRoom();
});

function onDisk(disk: number, free: number): void {
  storage.resetRoom();
  storage.diskHooks.free = () => free;
  storage.diskHooks.total = () => disk;
  storage.diskHooks.makeRoom = () => 0;
}

const admitted = (disk: number, free: number, bytes: number) => (onDisk(disk, free), storage.admit("/d", bytes, "This import") === null);
const kept = (disk: number, free: number, bytes: number) => (onDisk(disk, free), storage.roomFor("/d", bytes));

test("rules of scale: more free room never gives a worse answer, and a bigger disk with the same free room never does", () => {
  for (const ask of [admitted, kept]) {
    for (const bytes of WORK) {
      for (const disk of DISKS) {
        let before = false;
        for (let free = 0; free <= Math.min(disk, 150 * GB); free += GB) {
          const now = ask(disk, free, bytes);
          expect([ask.name, bytes, disk, free, before && !now]).toEqual([ask.name, bytes, disk, free, false]);
          before = now;
        }
      }
      for (let free = 0; free <= 150 * GB; free += 5 * GB) {
        let before = false;
        for (const disk of DISKS.filter((one) => one >= free)) {
          const now = ask(disk, free, bytes);
          expect([ask.name, bytes, free, disk, before && !now]).toEqual([ask.name, bytes, free, disk, false]);
          before = now;
        }
      }
    }
  }
});

test("from an empty disk to a full one, work is admitted or refused with a line whose number is enough", () => {
  for (const disk of DISKS) {
    for (const bytes of WORK) {
      for (let free = 0; free <= Math.min(disk, 80 * GB); free += GB) {
        onDisk(disk, free);
        const line = storage.admit("/d", bytes, "This import");
        if (line === null) continue;
        const needs = Number(/needs about ([\d.]+) GB free/u.exec(line)?.[1] ?? Number.NaN) * GB;
        expect([disk, free, bytes, Number.isFinite(needs)]).toEqual([disk, free, bytes, true]);
        // Do what it says (have that much free) and the work goes on.
        expect([disk, free, bytes, admitted(disk, needs + 0.05 * GB, bytes)]).toEqual([disk, free, bytes, true]);
      }
    }
  }
});

test("on the team's Macs: what Edit keeps free, and whether each kind of work is kept or streamed, said in plain words", () => {
  const lines: string[] = [];
  for (const mac of MACS) {
    const keep = storage.keepFreeFor(mac.disk);
    expect([mac.who, keep <= 15 * GB]).toEqual([mac.who, true]);
    const fits = WORK.filter((bytes) => kept(mac.disk, mac.free, bytes)).map((bytes) => `${bytes / GB} GB`);
    lines.push(`${mac.who}: keeps ${keep / GB} GB free, has ${mac.free / GB}; keeps here: ${fits.length > 0 ? fits.join(", ") : "nothing (it streams)"}`);
  }
  // JJ's 2 GB edit and his 5.5 GB recording are kept on his Mac (the old rule kept nothing there).
  expect(kept(494 * GB, 41 * GB, 5.5 * GB)).toBe(true);
  console.log(lines.join("\n"));
});

// Nov 25: a local-first project's YouTube download is kept whole here beside its working copy only with room for the
// copy over what Edit keeps free (script.ts `originalHere`); short, it goes on today's path (up, cut, let go here).
test("on the team's Macs: a YouTube download kept whole beside its working copy, or sent on today's path", () => {
  const lines: string[] = [];
  const sources = [30 * 60, 2 * 3600];
  for (const mac of MACS) {
    const whole = sources.filter((seconds) => kept(mac.disk, mac.free, localFirst.workingRoom(seconds))).map((seconds) => `${seconds / 60} min`);
    lines.push(`${mac.who}: has ${mac.free / GB} GB free; a working copy is about ${(localFirst.workingRoom(30 * 60) / GB).toFixed(2)} GB for 30 min, ${(localFirst.workingRoom(7200) / GB).toFixed(1)} GB for 2 h; kept whole: ${whole.length > 0 ? whole.join(", ") : "none (today's path)"}`);
  }
  // JJ, Marc and kenobi keep a two-hour source whole; Sphe's M4 (17 GB free, 15 kept) keeps a 30-minute one and sends a
  // two-hour one on today's path; a Mac at the 15 GB Edit keeps free sends everything on today's path.
  for (const who of ["JJ's MacBook Pro", "Marc's MacBook Air", "kenobi (the test M1)"]) {
    const mac = MACS.find((one) => one.who === who)!;
    expect([who, kept(mac.disk, mac.free, localFirst.workingRoom(7200))]).toEqual([who, true]);
  }
  expect(kept(245 * GB, 17 * GB, localFirst.workingRoom(30 * 60))).toBe(true);
  expect(kept(245 * GB, 17 * GB, localFirst.workingRoom(7200))).toBe(false);
  expect(kept(245 * GB, 15 * GB, localFirst.workingRoom(30 * 60))).toBe(false);
  console.log(lines.join("\n"));
});

/**
 * The footage of the project open here is work (Nov 20): kept down to the work's floor and a gigabyte, every other
 * copy down to the cache's 15 GB. The team's Macs as their reports said (Sphe's M4 ran at 12–18 GB free all week, so
 * every open project streamed for the whole session), an 8 GB M1 and a nearly full disk.
 */
const OPEN_MACS = [
  { who: "JJ's MacBook Pro", disk: 494 * GB, free: 41 * GB, memory: 16 * 2 ** 30 },
  { who: "Sphe's M4 Air at its lowest", disk: 245 * GB, free: 12 * GB, memory: 16 * 2 ** 30 },
  { who: "Sphe's M4 Air at its highest", disk: 245 * GB, free: 18 * GB, memory: 16 * 2 ** 30 },
  { who: "an 8 GB M1", disk: 245 * GB, free: 10 * GB, memory: 8 * 2 ** 30 },
  { who: "a nearly full disk", disk: 245 * GB, free: 4 * GB, memory: 16 * 2 ** 30 },
];
const FOOTAGE = [2 * GB, 5.5 * GB, 12 * GB];

test("an open project's footage is kept down to the work's floor, every other copy to the cache's; more free room never keeps less, and the open project is never worse off", () => {
  storage.openHooks.now = () => 1_000_000;
  try {
    storage.noteOpenFootage("open", ["edit/proxies/open.mp4"]);
    // On this machine: the open project's floor is the work's and a gigabyte, the rest the cache's.
    expect(storage.footageFloor("/d", "edit/proxies/open.mp4")).toBe(storage.CACHE_FLOOR_BYTES);
    expect(storage.footageFloor("/d", "edit/proxies/other.mp4")).toBe(storage.cacheFloor("/d"));
    expect(storage.footageFloor("/d", "edit/proxies/open.mp4")).toBeLessThanOrEqual(storage.footageFloor("/d", "edit/proxies/other.mp4"));
    // Closed for longer than ten minutes (the editor says nothing of it): back to the cache's floor.
    storage.openHooks.now = () => 1_000_000 + 11 * 60_000;
    expect(storage.footageFloor("/d", "edit/proxies/open.mp4")).toBe(storage.cacheFloor("/d"));
    // Still open by the editor's word (opened.ts): kept as work.
    storage.openHooks.isOpen = (id) => id === "open";
    expect(storage.footageFloor("/d", "edit/proxies/open.mp4")).toBe(storage.CACHE_FLOOR_BYTES);
  } finally {
    storage.openHooks.now = () => Date.now();
    storage.openHooks.isOpen = () => false;
  }
  // Rules of scale, on Macs of 8 GB and of more: more free room never keeps less of either.
  for (const memory of [8 * 2 ** 30, 16 * 2 ** 30]) {
    const open = storage.cacheFloorBytesFor(memory);
    expect(open).toBeLessThanOrEqual(storage.keepFreeFor(245 * GB));
    let before = -1;
    for (let free = 0; free <= 150 * GB; free += GB) {
      const kept = Math.max(0, free - open);
      expect([memory, free, kept >= before]).toEqual([memory, free, true]);
      before = kept;
    }
  }
  const lines: string[] = [];
  for (const mac of OPEN_MACS) {
    const open = storage.cacheFloorBytesFor(mac.memory);
    const other = storage.keepFreeFor(mac.disk);
    const roomOpen = Math.max(0, mac.free - open);
    const roomOther = Math.max(0, mac.free - other);
    const fits = (room: number) => FOOTAGE.filter((bytes) => bytes <= room).map((bytes) => `${bytes / GB} GB`);
    const said = (room: number) => (fits(room).length > 0 ? `${fits(room).join(", ")} fit` : "nothing (it streams)");
    lines.push(`${mac.who} (${mac.disk / GB} GB disk, ${mac.free / GB} free): the open project's footage kept down to ${open / GB} GB free, ${(roomOpen / GB).toFixed(1)} GB of room, ${said(roomOpen)}; other projects' down to ${other / GB} GB, ${(roomOther / GB).toFixed(1)} GB, ${said(roomOther)}`);
  }
  // The M4 at its lowest keeps an open project's whole 2 GB and 5.5 GB edits (it kept none before).
  expect(Math.max(0, 12 * GB - storage.cacheFloorBytesFor(16 * 2 ** 30))).toBeGreaterThanOrEqual(5.5 * GB);
  console.log(lines.join("\n"));
});

test("whole copies' fills beside a play, by the line's measured speed: four at rest and while a play holds, fewer while one is shown, the next minute's files always", async () => {
  const { fillsWhilePlaying } = await import("../src/cloud_blocks.ts");
  const lines: string[] = [];
  let before = -1;
  for (const mbit of [0, 4, 8, 20, 50, 200]) {
    const playing = fillsWhilePlaying(mbit === 0 ? null : mbit * 1e6);
    // A faster line never gets fewer.
    expect([mbit, playing >= before]).toEqual([mbit, true]);
    before = playing;
    lines.push(`${mbit === 0 ? "not measured" : `${mbit} Mbit/s`}: at rest 4 fills, held on its spinner 4, playing ${playing}${playing === 0 ? " (only the next minute's files, one at a time)" : " (and the next minute's files, at least one)"}`);
  }
  console.log(lines.join("\n"));
});
