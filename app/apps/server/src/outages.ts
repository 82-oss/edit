// Background checks paused while a part of Edit's cloud can't be reached
// (GPT 6.2 Astra's audit of four days of the team's logs, Nov 18: with the
// network or the relay down, every poller asked again on its own; JJ's Mac
// logged ~2,300 connection and timeout warnings, review polls waiting 120 s
// each, and Marc's a failed reviews query, a failed check-in and the review
// caller saying so, all in one millisecond).
//
// Each destination (the relay, which every Convex call and presigned URL goes
// through, and R2's transfers) keeps one health, told how every request to
// it went: relay.ts' `noteUnreachable`/`noteAnswered`, cloud.ts' transfers.
// After FAILURES connection failures or timeouts in a row it's down, said once.
// From then the low-priority pollers that run their round through
// `background` skip it (no request, no warning) until a probe is due: 15 s,
// doubling to 5 min, with jitter. One round at a time is let through as the
// probe. Any answer from the destination, the probe's or anyone's, ends the
// outage for every poller, said once with how long it lasted and how many
// rounds were skipped.
//
// Only background rounds are ever skipped. A person's request, an export or a
// share, an upload, a project's or a script's sync, lock renewals and
// releases, and remote support's acknowledgements never go through
// `background`: they're tried as always, failures said as always, and their
// answers count towards the health like any.

import * as diag from "./diag.ts";
import { isTemporary } from "./effect/service.ts";

export type Destination = "relay" | "r2";

const NAMES: Record<Destination, string> = { relay: "Edit's relay", r2: "R2" };

/** What tests change. */
export const timing = {
  /** Connection failures or timeouts in a row that make an outage. */
  failures: 3,
  /** The first probe's wait, doubled after each failed probe, up to `maxMs`. */
  firstMs: 15_000,
  maxMs: 5 * 60_000,
  /** Each wait is ± this share of itself, so Macs that went down together don't probe together. */
  jitter: 0.2,
  now: (): number => Date.now(),
  random: (): number => Math.random(),
};

interface Health {
  /** Connection failures or timeouts in a row. */
  inRow: number;
  /** Requests that said how they went (any outcome): tells a probe that reached the destination from one that didn't. */
  outcomes: number;
  /** When the outage began; null while it answers. */
  since: number | null;
  wait: number;
  probeAt: number;
  probing: boolean;
  skipped: number;
}

const healths = new Map<Destination, Health>();

function of(destination: Destination): Health {
  let health = healths.get(destination);
  if (health === undefined) {
    health = { inRow: 0, outcomes: 0, since: null, wait: timing.firstMs, probeAt: 0, probing: false, skipped: 0 };
    healths.set(destination, health);
  }
  return health;
}

const jittered = (ms: number): number => Math.round(ms * (1 - timing.jitter + 2 * timing.jitter * timing.random()));

/** A request to `destination` couldn't reach it (no network, refused, timed out); `said` is why. */
export function failed(destination: Destination, said: string): void {
  const health = of(destination);
  health.outcomes += 1;
  health.inRow += 1;
  if (health.since !== null || health.inRow < timing.failures) return;
  const now = timing.now();
  Object.assign(health, { since: now, wait: timing.firstMs, probeAt: now + jittered(timing.firstMs), probing: false, skipped: 0 });
  diag.warn("cloud", `${NAMES[destination]} unreachable: background checks paused (${diag.scrub(said).slice(0, 300)})`);
}

/** Told as an outage ends (`answered`): the work waiting on it is woken at once (serve.ts), not at its next try. */
const backs = new Set<(destination: Destination) => void>();
export function onBack(listener: (destination: Destination) => void): () => void {
  backs.add(listener);
  return () => void backs.delete(listener);
}

/** `destination` answered a request (any status): an outage is over, for everyone. */
export function answered(destination: Destination): void {
  const health = of(destination);
  health.outcomes += 1;
  health.inRow = 0;
  if (health.since === null) return;
  const lasted = diag.human(timing.now() - health.since);
  diag.info("cloud", `${NAMES[destination]} reachable again after ${lasted}: background checks resumed (${health.skipped} skipped meanwhile)`);
  Object.assign(health, { since: null, probing: false, skipped: 0 });
  for (const listener of backs) {
    try {
      listener(destination);
    } catch (error) {
      diag.warn("cloud", diag.messageOf(error));
    }
  }
}

/** Whether `destination` is in an outage now. */
export function down(destination: Destination): boolean {
  return of(destination).since !== null;
}

/**
 * Whether `error` is a request that couldn't get through while one of
 * `destinations` (any, by default) is down: said once by the outage, so the
 * caller says nothing, and a round going through several stops there.
 */
export function quiet(error: unknown, destinations: readonly Destination[] = ["relay", "r2"]): boolean {
  return destinations.some(down) && (isTemporary(error) || offline(error));
}

/** Script mode's cloud says the connection failed its own way (writer/cloud.ts' `Problem`, `offline`). */
function offline(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { offline?: unknown }).offline === true;
}

/**
 * One round of a low-priority poller that reaches `to`: run as always while
 * they answer; while one is down, skipped (undefined) unless a probe is due
 * and none is going, when this round is the probe. A round failing because a
 * destination is down is quiet (undefined); any other failure is thrown, for
 * the caller to say as before. Never for foreground or data-protecting work.
 */
export async function background<T>(to: Destination | readonly Destination[], run: () => Promise<T>): Promise<T | undefined> {
  const destinations: readonly Destination[] = typeof to === "string" ? [to] : to;
  const out = destinations.filter(down);
  if (out.some((one) => of(one).probing || timing.now() < of(one).probeAt)) {
    for (const one of out) of(one).skipped += 1;
    return undefined;
  }
  const before = out.map((one) => of(one).outcomes);
  for (const one of out) of(one).probing = true;
  try {
    return await run();
  } catch (error) {
    if (quiet(error, destinations)) return undefined;
    throw error;
  } finally {
    out.forEach((one, at) => {
      const health = of(one);
      // Answered meanwhile (a new outage since has its own probe), or nothing of the round reached it: the next round probes.
      if (!health.probing) return;
      health.probing = false;
      if (health.since === null || health.outcomes === before[at]) return;
      health.wait = Math.min(health.wait * 2, timing.maxMs);
      health.probeAt = timing.now() + jittered(health.wait);
    });
  }
}

/** Tests: every destination answering, nothing counted. */
export function forgetForTests(): void {
  healths.clear();
}
