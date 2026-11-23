import { expect, test } from "bun:test";

import { Turns, type Asking, type Turn } from "../src/render_turns.ts";

class Dropped extends Error {}

function setup(slice = 30_000, age = 300_000) {
  let now = 0;
  const hooks = { sliceMs: slice, ageMs: age, now: () => now };
  const turns = new Turns(hooks, () => new Dropped());
  return { turns, tick: (ms: number) => (now += ms) };
}

function asking(project: string, over: Partial<{ urgent: boolean; stale: boolean }> = {}): Asking & { set: (what: { urgent?: boolean; stale?: boolean }) => void } {
  const state = { urgent: false, stale: false, ...over };
  return { project, urgent: () => state.urgent, stale: () => state.stale, set: (what) => Object.assign(state, what) };
}

/** The turn a take answers, once it does (null while it waits). */
function track(promise: Promise<Turn>) {
  const seen = { turn: null as Turn | null, error: null as unknown };
  promise.then(
    (turn) => (seen.turn = turn),
    (error: unknown) => (seen.error = error),
  );
  return seen;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("one render holds the slot; another project's render nobody waits on gets it once the holder has had its slice, at the holder's next chunk", async () => {
  const { turns, tick } = setup();
  const a = track(turns.take(asking("A")));
  await settle();
  expect(a.turn).not.toBeNull();
  expect(a.turn!.shouldYield()).toBe(false);
  const b = track(turns.take(asking("B")));
  await settle();
  expect(b.turn).toBeNull();
  tick(10_000);
  expect(a.turn!.shouldYield()).toBe(false);
  tick(20_000);
  expect(a.turn!.shouldYield()).toBe(true);
  // A gives way and asks again: B goes, then A once B is done (round robin), and B waited 30 s.
  a.turn!.release();
  const again = track(turns.take(asking("A")));
  await settle();
  expect(b.turn).not.toBeNull();
  expect(b.turn!.waited).toBe(30_000);
  expect(again.turn).toBeNull();
  b.turn!.release();
  await settle();
  expect(again.turn).not.toBeNull();
});

test("a render someone waits on gets the slot at the next chunk of one nobody waits on, its own project's too (a short export behind the same video's long graphic, Nov 23)", async () => {
  const { turns } = setup();
  const a = track(turns.take(asking("A")));
  await settle();
  const same = asking("A");
  const next = track(turns.take(same));
  expect(a.turn!.shouldYield()).toBe(false);
  same.set({ urgent: true });
  expect(a.turn!.shouldYield()).toBe(true);
  a.turn!.release();
  await settle();
  expect(next.turn).not.toBeNull();
});

test("a render someone waits on gets the slot at the next chunk of another project's that nobody waits on; the same project's never takes it from one that's waited on too", async () => {
  const { turns, tick } = setup();
  const a = track(turns.take(asking("A", { urgent: true })));
  await settle();
  const same = track(turns.take(asking("A", { urgent: true })));
  tick(1_000);
  expect(a.turn!.shouldYield()).toBe(false);
  const b = asking("B");
  track(turns.take(b));
  expect(a.turn!.shouldYield()).toBe(false);
  b.set({ urgent: true });
  // Of the same standing: at the end of its slice.
  expect(a.turn!.shouldYield()).toBe(false);
  tick(30_000);
  expect(a.turn!.shouldYield()).toBe(true);
  expect(same.turn).toBeNull();
});

test("a render waited on holds the slot against renders nobody waits on, until one of them has waited long enough to count as waited on", async () => {
  const { turns, tick } = setup(30_000, 300_000);
  const a = track(turns.take(asking("A", { urgent: true })));
  await settle();
  track(turns.take(asking("B")));
  tick(60_000);
  expect(a.turn!.shouldYield()).toBe(false);
  tick(240_000);
  // B has waited 5 minutes: as good as waited on, and A has had its slice.
  expect(a.turn!.shouldYield()).toBe(true);
});

test("among projects of the same standing, the one served longest ago goes next (round robin), then the one asking first", async () => {
  const { turns, tick } = setup();
  const a1 = track(turns.take(asking("A")));
  await settle();
  const a2 = track(turns.take(asking("A")));
  tick(1);
  const b1 = track(turns.take(asking("B")));
  tick(1);
  const c1 = track(turns.take(asking("C")));
  a1.turn!.release();
  await settle();
  // A was just served: B (asked before C) goes.
  expect(b1.turn).not.toBeNull();
  b1.turn!.release();
  await settle();
  expect(c1.turn).not.toBeNull();
  expect(a2.turn).toBeNull();
  c1.turn!.release();
  await settle();
  expect(a2.turn).not.toBeNull();
});

test("a render whose code changed while it waited is dropped before it's given the slot, and doesn't make the holder give way", async () => {
  const { turns, tick } = setup(0);
  const a = track(turns.take(asking("A")));
  await settle();
  const b = asking("B");
  const seen = track(turns.take(b));
  b.set({ stale: true });
  tick(1);
  expect(a.turn!.shouldYield()).toBe(false);
  await settle();
  expect(seen.error).toBeInstanceOf(Dropped);
  const c = asking("C");
  const later = track(turns.take(c));
  c.set({ stale: true });
  a.turn!.release();
  await settle();
  expect(later.error).toBeInstanceOf(Dropped);
  expect(turns.waiting()).toBe(0);
});
