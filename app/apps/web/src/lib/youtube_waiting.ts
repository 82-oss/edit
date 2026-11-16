// What waits on YouTube turning Edit away (the server's youtube.ts `waiting`):
// a download waiting a wave of refusals out, an idea waiting to read its case.
// Asked every 10 s while a window shows the chip.

import { create } from "zustand";

export interface YoutubeWaiting {
  /** How many things wait, and when the soonest goes again (ms); null when nothing does. */
  waiting: { count: number; until: number } | null;
}

export const useYoutubeWaiting = create<YoutubeWaiting>(() => ({ waiting: null }));

const POLL_MS = 10_000;
let timer: ReturnType<typeof setTimeout> | undefined;

async function poll() {
  try {
    const response = await fetch("/api/youtube/waiting", { signal: AbortSignal.timeout(5_000) });
    if (response.ok) useYoutubeWaiting.setState((await response.json()) as YoutubeWaiting, true);
  } catch {
    // The server is away; the chip keeps what it last knew.
  }
  timer = setTimeout(() => void poll(), POLL_MS);
}

/** Mount once: keeps what waits on YouTube fresh. */
export function watchYoutubeWaiting() {
  if (timer === undefined) void poll();
}
