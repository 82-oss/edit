// Edit's rules with a number in them, held against the team's real Macs and against every state a Mac can be in
// (Nov 19: Edit kept a tenth of every disk free, which counted JJ's 494 GB Mac with 41 GB free as full; no audit
// worked the number out for a real machine). Fable's checks (rust-question.md section 5):
// - every free space from empty to full, not just today's: work is admitted, or refused with a line whose number is
//   enough (free that much and it's admitted);
// - rules of scale: more free room never gives a worse answer, and a bigger disk with the same free room never does;
// - the team's Macs, as their reports said on Nov 19, and the work they do (a 2 GB edit, JJ's 5.5 GB Midland file, a
//   53 GB case), each printed as a plain line a person can read before a number ships.

import { afterEach, expect, test } from "bun:test";

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
