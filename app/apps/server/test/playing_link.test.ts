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
