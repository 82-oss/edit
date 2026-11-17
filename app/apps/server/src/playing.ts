// Whether a person is watching a play on this Mac: the page's player or
// Edit.app's window. Background work that takes the disk, the CPU or the link
// (whole copies coming down, burned-in subtitle reads, censor checks,
// thumbnails, a smooth-playback render's chunks) gives way while it is, and
// carries on once it stops (kenobi, Nov 17: a cold play of Cops Found 3 Bodies
// on an M1 passed over 515 frames in 23 s while 73 subtitle reads, 46 censor
// checks and every whole copy ran beside it, the load at 16.7 on 8 cores).
//
// The page says so (`POST …/playback/warm` with `playing`): at a play, every
// few seconds while it plays, and at a pause. A play nobody has spoken of for
// `STALE_MS` is over (a page closed mid-play never says it paused).

import * as diag from "./diag.ts";

/** A play last heard of this long ago is over (the page says so every 5 s while it plays). */
export const hooks = { staleMs: 12_000, pollMs: 250, now: () => Date.now() };

/** Each project playing, and when its page last said so. */
const plays = new Map<string, number>();
const listeners = new Set<(playing: boolean) => void>();
let was = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Project `id`'s page says it plays now (`playing`), or that it stopped. */
export function note(id: string, playing: boolean): void {
  if (playing) plays.set(id, hooks.now());
  else plays.delete(id);
  changed();
}

/** Whether anything plays on this Mac now. */
export function isPlaying(): boolean {
  const now = hooks.now();
  for (const [id, at] of plays) if (now - at >= hooks.staleMs) plays.delete(id);
  return plays.size > 0;
}

/** Told each time playing starts or stops (true: it started). */
export function onChange(listener: (playing: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  const now = isPlaying();
  clearTimeout(timer);
  // A play nobody speaks of again ends by itself.
  if (now) {
    const oldest = Math.min(...plays.values());
    timer = setTimeout(changed, Math.max(10, oldest + hooks.staleMs - hooks.now()));
    (timer as { unref?: () => void }).unref?.();
  }
  if (now === was) return;
  was = now;
  // Said in the log, so what gave way to a play can be checked against it.
  diag.info("playback", now ? "a play started: background work gives way" : "the play stopped: background work carries on");
  for (const listener of listeners) listener(now);
}

/**
 * Resolves once nothing plays (at once when nothing does); false when `stop()` gave up first. Background work
 * waits here between its steps, never in the middle of a write.
 */
export async function whenIdle(stop: () => boolean = () => false): Promise<boolean> {
  while (isPlaying() && !stop()) await new Promise((resolve) => setTimeout(resolve, hooks.pollMs));
  return !stop();
}

/** For tests. */
export function reset(): void {
  plays.clear();
  clearTimeout(timer);
  was = false;
}
