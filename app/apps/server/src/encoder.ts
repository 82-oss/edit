// Who is using the hardware encoder on this computer right now, and who goes first (Nov 8 audit, items D and F; the
// lease, Nov 22). Exports, review copies and smooth renders run in the engine or FFmpeg; proxies, Writer's preview
// pieces and the like are FFmpeg run from here. Neither side knew of the other, so on JJ's Mac an export and 56 Writer
// pieces shared the encoder and the pieces' pace judge stopped them as "too slow", which was only the export's share.
//
// Every use has a tier, first to last: a person's Export, a share's review copy, smooth playback's render (and what's
// made for the page), then proxies and other background encodes. Work holds the encoder while it runs (`hold`), or
// says so through `register` when only its own module knows (the export registry). Work of the last tier takes its
// turn (`turn`) before each piece it encodes: it waits while anything above it holds the encoder, so it gives way at
// its next piece and is never stopped mid-file. A hold may say how it gives way (`giveWay`), and is asked to when work
// above it takes the encoder. While a play is watched an export runs one fewer at once (`exportsAtOnce`), so the play
// keeps an engine of its own. `shared(self)` is whether anything else holds it now, which a pace judge or a timeout
// reads before it calls a slow encode stuck.

import * as diag from "./diag.ts";
import * as playing from "./playing.ts";

/** Who goes first, first to last. */
export const TIERS = ["export", "share", "playback", "background"] as const;
export type Tier = (typeof TIERS)[number];

const rank = (tier: Tier): number => TIERS.indexOf(tier);

/** Encodes started from here, by token: what each is ("an import's proxy"), its tier, and how it gives way. */
const held = new Map<number, { what: string; tier: Tier; giveWay: (() => void) | undefined; asked: boolean }>();
/** Work other modules know about (an export running), each saying what it is or null, with its tier. */
const sources = new Set<{ what: () => string | null; tier: Tier }>();
/** Turns waiting, each looked at again when a hold ends and every `hooks.pollMs` (a source can't say it ended). */
const waiting = new Set<() => void>();
let next = 1;
let poll: ReturnType<typeof setInterval> | undefined;

/** How often waiting turns look again (tests set it), and the longest one waits for a hold that never lets go. */
export const hooks = { pollMs: 2000, longestWaitMs: 60 * 60_000 };

/**
 * Notes `what` (of `tier`: background by default) as using the encoder until the function returned is called; its
 * token, for `shared(token)`. Holds below it that say how they give way are asked to (once).
 */
export function hold(what: string, tier: Tier = "background", giveWay?: () => void): { token: number; release: () => void } {
  const token = next++;
  held.set(token, { what, tier, giveWay, asked: false });
  askBelow(tier);
  return {
    token,
    release: () => {
      if (held.delete(token)) looked();
    },
  };
}

/** Adds work only its own module knows about (the export registry: a person's Export by default); undone by the function returned. */
export function register(what: () => string | null, tier: Tier = "export"): () => void {
  const source = { what, tier };
  sources.add(source);
  return () => {
    sources.delete(source);
    looked();
  };
}

/** What uses the encoder now, other than `self` (a token from `hold`), with each one's tier. */
function using(self?: number): { what: string; tier: Tier }[] {
  const out: { what: string; tier: Tier }[] = [];
  for (const [token, one] of held) if (token !== self) out.push({ what: one.what, tier: one.tier });
  for (const source of sources) {
    try {
      const what = source.what();
      if (what !== null) out.push({ what, tier: source.tier });
    } catch {
      // A source that can't say isn't counted.
    }
  }
  return out;
}

/** What uses the encoder now, other than `self` (a token from `hold`). */
export function others(self?: number): string[] {
  return using(self).map((one) => one.what);
}

/** Whether anything other than `self` uses the encoder now. */
export function shared(self?: number): boolean {
  return others(self).length > 0;
}

/** Whether anything at all uses it (a wait for the encoder ends when this is false). */
export function busy(): boolean {
  return others().length > 0;
}

/** What holds the encoder now at `tier` exactly (the export registry orders its own exports and smooth renders, and asks only of the rest). */
export function holding(tier: Tier): string[] {
  return using().filter((one) => one.tier === tier).map((one) => one.what);
}

/** What uses the encoder now that goes before `tier`: what work of that tier waits for. */
export function above(tier: Tier): string[] {
  return using().filter((one) => rank(one.tier) < rank(tier)).map((one) => one.what);
}

/**
 * The encoder for `what` (of `tier`) once nothing above it holds it: held from then until released. Work of the last
 * tier asks before each piece, so it gives way at its next one. A hold above that never lets go is waited out for
 * `hooks.longestWaitMs` at most, then said and gone past. A stopped wait (`signal`) throws its reason.
 */
export async function turn(what: string, tier: Tier = "background", signal?: AbortSignal): Promise<{ token: number; release: () => void }> {
  const began = Date.now();
  let said = false;
  for (;;) {
    signal?.throwIfAborted();
    const first = above(tier);
    if (first.length === 0) break;
    if (Date.now() - began >= hooks.longestWaitMs) {
      diag.warn("encoder", `${what} waited ${Math.round((Date.now() - began) / 60_000)} min for ${first.join(", ")}; it goes beside it`);
      break;
    }
    if (!said) diag.info("encoder", `${what} waits for ${first.join(", ")}`);
    said = true;
    await new Promise<void>((resolve) => {
      const wake = () => {
        waiting.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      waiting.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
      if (poll === undefined) {
        poll = setInterval(looked, hooks.pollMs);
        poll.unref?.();
      }
    });
  }
  return hold(what, tier);
}

/** Told when a hold or a source ends (a queue of its own, as the export registry's, looks again). */
const releases = new Set<() => void>();
export function onRelease(listener: () => void): () => void {
  releases.add(listener);
  return () => void releases.delete(listener);
}

/** Every waiting turn looks again (a hold ended, a source may have). */
function looked(): void {
  for (const listener of [...releases]) {
    try {
      listener();
    } catch (error) {
      diag.warn("encoder", `after a release: ${diag.messageOf(error)}`);
    }
  }
  for (const wake of [...waiting]) wake();
  if (waiting.size === 0 && poll !== undefined) {
    clearInterval(poll);
    poll = undefined;
  }
}

/** Holds below `tier` that say how they give way are asked to, once each. */
function askBelow(tier: Tier): void {
  for (const one of held.values()) {
    if (one.asked || one.giveWay === undefined || rank(one.tier) <= rank(tier)) continue;
    one.asked = true;
    try {
      one.giveWay();
    } catch (error) {
      diag.warn("encoder", `${one.what} giving way: ${diag.messageOf(error)}`);
    }
  }
}

/** How many exports run at once on a computer with room for `most`: one fewer while a play is watched, never none. */
export function exportsAtOnce(most: number): number {
  return playing.isPlaying() ? Math.max(1, most - 1) : most;
}

/** Tests: every hold, source and wait forgotten. */
export function reset(): void {
  held.clear();
  sources.clear();
  looked();
  waiting.clear();
}
