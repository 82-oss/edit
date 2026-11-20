// The server's one thread. Everything Edit answers waits its turn on it: a
// page, the player's reads, a progress line, a timer, the events socket. Work
// that keeps it for seconds is felt everywhere at once, as a freeze "out of
// nowhere" (Nov 20, Sphe's Linux Edit: `GET /api/health` took 27.6 s with
// nothing listed as running; Script mode's cloud round was writing its whole
// ledger once a script, 20 to 30 seconds of every minute, and had since Oct
// 29; joining a cloud file's whole copy held it for the length of the file).
//
// Two things live here:
// - `breather`: a long loop over many small synchronous steps gives the rest
//   of Edit its turn every few milliseconds. An `await` on something already
//   settled does NOT do that (it goes on in the same turn), which is how a
//   loop of awaits froze the server.
// - `note` and `held`: work that may take the thread says what it is as it
//   starts, and a hold of two seconds or more is logged with the last thing
//   that said so, and kept for this Mac's report, so the next freeze names
//   itself instead of being found by a person.

import * as diag from "./diag.ts";

/**
 * A breath for a loop: `await breathe()` in each pass returns at once until `everyMs` has gone by since the last
 * breath, then lets everything waiting on the thread go first (a turn of the event loop, not a microtask).
 */
export function breather(everyMs = 8): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < everyMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = performance.now();
  };
}

/** What last said it was starting on the thread, and when. */
let last: { what: string; at: number } | null = null;

/** Work that may keep the thread says what it is, as it starts (cheap: a variable). */
export function note(what: string): void {
  last = { what, at: performance.now() };
}

/** A hold of the thread: when it ended, how long nothing else ran, and what had last said it was starting. */
export interface Hold {
  at: number;
  ms: number;
  /** Processor time the whole process used meanwhile (its other threads' too). */
  busyMs: number;
  during: string | null;
}

/** A gap between beats this long is a hold worth saying (a page's ask already feels late at half of it). */
export const HELD_MS = 2_000;
const KEPT = 50;
const holds: Hold[] = [];

/**
 * The thread was kept for `ms` (wake.ts's beat found the gap and that it wasn't a sleep): logged with what last said
 * it was starting, and kept for the report.
 */
export function held(ms: number, busyMs: number): Hold {
  const during = last === null ? null : last.what;
  const hold: Hold = { at: Date.now(), ms, busyMs, during };
  holds.push(hold);
  if (holds.length > KEPT) holds.shift();
  diag.warn("thread", `the server's thread was held for ${diag.human(ms)} (${Math.round(busyMs)} ms of processor time): nothing else in Edit ran meanwhile${during === null ? "" : `; last started: ${during}`}`);
  return hold;
}

/** The holds of the last `withinMs`, oldest first. */
export function recentHolds(withinMs = 3_600_000): Hold[] {
  const since = Date.now() - withinMs;
  return holds.filter((hold) => hold.at >= since);
}

/** This Mac's holds in a line for its report, or null when there were none in the last hour. */
export function report(): string | null {
  const recent = recentHolds();
  if (recent.length === 0) return null;
  const longest = recent.reduce((most, hold) => (hold.ms > most.ms ? hold : most));
  return `Edit's server answered nothing ${recent.length} time${recent.length === 1 ? "" : "s"} in the last hour for 2 s or more (${diag.human(recent.reduce((sum, hold) => sum + hold.ms, 0))} in all; the longest ${diag.human(longest.ms)}${longest.during === null ? "" : `, last started: ${longest.during}`}).`;
}

/** Tests: nothing noted or kept. */
export function resetForTests(): void {
  last = null;
  holds.length = 0;
}
