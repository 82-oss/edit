// Edit's rules with a number in them, held against the team's real Macs (Nov 19: Edit kept a tenth of every disk
// free, which counted JJ's 494 GB Mac with 41 GB free as full; no audit worked the number out for a real machine).
// Each Mac as its report and the team said it on Nov 19. Add a rule here whenever it has a number a Mac must meet.

import { expect, test } from "bun:test";

import { keepFreeFor } from "../src/storage.ts";

const GB = 1e9;

/** The team's Macs: disk size and what was free on Nov 19 (their reports). Marc's disk size is the Air's 512 GB, assumed. */
const MACS = [
  { who: "JJ's MacBook Pro", disk: 494 * GB, free: 41 * GB },
  { who: "Marc's MacBook Air", disk: 494 * GB, free: 113 * GB },
  { who: "Sphe's M4 Air", disk: 245 * GB, free: 17 * GB },
  { who: "kenobi (the test M1)", disk: 245 * GB, free: 24 * GB },
];

test("Edit keeps free a sensible amount on every Mac of the team's: never more than 20 GB, never under 15 GB", () => {
  for (const mac of MACS) {
    const keep = keepFreeFor(mac.disk);
    expect([mac.who, keep >= 15 * GB && keep <= 20 * GB]).toEqual([mac.who, true]);
  }
});

test("on the Macs with room, a typical case's footage fits: JJ's 2 GB edit and his 5.5 GB Midland recording", () => {
  for (const mac of MACS.filter((one) => one.free >= 40 * GB)) {
    const room = mac.free - keepFreeFor(mac.disk);
    expect([mac.who, room >= 2 * GB, room >= 5.5 * GB]).toEqual([mac.who, true, true]);
  }
  // The old rule (a tenth, at least 15 GB) left JJ's Mac nothing: this is what it got wrong.
  expect(41 * GB - Math.max(15 * GB, 494 * GB * 0.1)).toBeLessThan(0);
});

test("a disk whose size is unknown keeps 15 GB", () => {
  expect(keepFreeFor(Number.NaN)).toBe(15 * GB);
  expect(keepFreeFor(0)).toBe(15 * GB);
});
