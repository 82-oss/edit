import { afterEach, expect, test } from "bun:test";

import * as playing from "../src/playing.ts";

const realNow = playing.hooks.now;
afterEach(() => {
  playing.hooks.now = realNow;
  playing.reset();
});

test("footage someone waits on holds the link like a play: background work waits (whenIdle), the footage's own only for a play (whenNotPlaying), and a hold nobody renews ends by itself", async () => {
  let idled = 0;
  const off = playing.onIdle(() => idled++);
  try {
    playing.holdLink("p1", 600);
    expect(playing.isIdle()).toBe(false);
    expect(playing.isPlaying()).toBe(false);
    expect(await playing.whenNotPlaying()).toBe(true);
    // A play beside it: both wait; the play ends, the hold still holds.
    playing.note("p1", true);
    let notPlaying = false;
    void playing.whenNotPlaying().then(() => (notPlaying = true));
    playing.note("p1", false);
    await Bun.sleep(playing.hooks.pollMs + 10);
    expect(notPlaying).toBe(true);
    expect(playing.isIdle()).toBe(false);
    expect(idled).toBe(0);
    // Not asked again: over after its time, and what waited is told.
    await Bun.sleep(450);
    expect(playing.linkHeld()).toBe(false);
    expect(playing.isIdle()).toBe(true);
    expect(idled).toBe(1);
    // Let go at once by Open now.
    playing.holdLink("p2", 60_000);
    expect(playing.isIdle()).toBe(false);
    playing.releaseLink("p2");
    expect(playing.isIdle()).toBe(true);
    expect(idled).toBe(2);
  } finally {
    off();
  }
});

test("a play held on its spinner is a play to the CPU work (subtitle reads, censor checks, renders wait: whenIdle) but shows nothing, so the footage's fills run as at rest (Nov 20)", async () => {
  const shown: boolean[] = [];
  const off = playing.onShowChange((now) => shown.push(now));
  try {
    playing.note("p", true, true);
    expect(playing.isPlaying()).toBe(true);
    expect(playing.isIdle()).toBe(false);
    expect(playing.showing()).toBe(false);
    let idle = false;
    void playing.whenIdle().then(() => (idle = true));
    // The hold over, the play shown: still not idle.
    playing.note("p", true);
    expect(playing.showing()).toBe(true);
    await Bun.sleep(playing.hooks.pollMs + 10);
    expect(idle).toBe(false);
    playing.note("p", false);
    await Bun.sleep(playing.hooks.pollMs + 10);
    expect(idle).toBe(true);
    expect(playing.showing()).toBe(false);
    expect(shown).toEqual([true, false]);
  } finally {
    off();
  }
});

test("a quick write to one project waits only on that project's own play or footage, never on another project's (Nov 27: one page's play held all four projects' finished removal pieces)", async () => {
  playing.note("other", true);
  expect(playing.isIdle()).toBe(false);
  expect(playing.busyWith("mine")).toBe(false);
  expect(await playing.whenProjectIdle("mine")).toBe(true);
  playing.note("mine", true);
  expect(playing.busyWith("mine")).toBe(true);
  let laid = false;
  void playing.whenProjectIdle("mine").then(() => (laid = true));
  await Bun.sleep(playing.hooks.pollMs + 10);
  expect(laid).toBe(false);
  playing.note("mine", false);
  await Bun.sleep(playing.hooks.pollMs + 10);
  expect(laid).toBe(true);
  // Footage waited on for that project holds its writes too.
  playing.holdLink("mine", 600);
  expect(playing.busyWith("mine")).toBe(true);
  playing.releaseLink("mine");
  expect(playing.busyWith("mine")).toBe(false);
  // A stop gives up the wait.
  playing.note("mine", true);
  expect(await playing.whenProjectIdle("mine", () => true)).toBe(false);
});

test("background work gives way to a play for at most its limit, then goes on through it", async () => {
  let now = 1_000;
  playing.hooks.now = () => now;
  playing.note("p", true);
  let went = false;
  void playing.whenIdle(() => false, 5_000).then(() => (went = true));
  await Bun.sleep(playing.hooks.pollMs + 10);
  expect(went).toBe(false);
  now += 5_001;
  // The play is renewed (still playing) but the limit has passed.
  playing.note("p", true);
  await Bun.sleep(playing.hooks.pollMs + 10);
  expect(went).toBe(true);
});
