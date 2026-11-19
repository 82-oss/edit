// The machine woke (honest council change 2e, Nov 19): a one-second beat, and
// a gap between beats over ten seconds means it slept or was frozen. On a Mac
// that's the lid; the network comes back seconds after it. JJ's Script import
// tried a recording in the same second as the sign-in's renewal each time his
// Mac woke, got no token, and failed on "need you signed in" (13 times, hourly).
// Now the one signal goes out, and what listens renews the sign-in first and
// only then starts the work that fell due (serve.ts).

import * as diag from "./diag.ts";

/** A gap between beats longer than this is a sleep or a freeze (tests shorten it). */
export const GAP_MS = { value: 10_000 };
const BEAT_MS = 1_000;

const listeners = new Set<(sleptMs: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let last = Date.now();

/** `listener` hears of every wake from now (how long the machine was gone); returns how to stop. */
export function onWake(listener: (sleptMs: number) => void): () => void {
  listeners.add(listener);
  start();
  return () => void listeners.delete(listener);
}

/** Tells every listener, as a wake does (tests, and `beat`). */
export function woke(sleptMs: number): void {
  diag.info("wake", `the machine was away for ${diag.human(sleptMs)}`);
  for (const listener of listeners) {
    try {
      listener(sleptMs);
    } catch (error) {
      diag.warn("wake", diag.messageOf(error));
    }
  }
}

/** Processor time used by this process, in ms, at the last beat. */
let cpu = 0;
const cpuMs = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};

function start(): void {
  if (timer !== null) return;
  last = Date.now();
  cpu = cpuMs();
  timer = setInterval(() => {
    const now = Date.now();
    const used = cpuMs();
    const gap = now - last;
    const busy = used - cpu;
    last = now;
    cpu = used;
    // Asleep or frozen, the process used almost no processor time across the gap; a server that was only busy (a
    // long synchronous step) used most of it, and isn't a wake (verify.md finding 10: 10–12 s stalls taken as sleeps).
    if (gap > GAP_MS.value && busy < gap * 0.25) woke(gap);
    else if (gap > GAP_MS.value) diag.info("wake", `the server was busy for ${diag.human(gap)} (${Math.round(busy)} ms of processor time): not a sleep`);
  }, BEAT_MS);
  timer.unref?.();
}

/** Tests: no beat, no listeners. */
export function stopForTests(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  listeners.clear();
}
