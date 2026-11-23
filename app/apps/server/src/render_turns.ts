/**
 * The effects' render slot: one render draws at a time on this Mac (an 8 GB
 * Mac holds one render's Chromes), but renders take turns at a chunk's end
 * (effects.ts `drawAndJoin`), so one project's half-hour render no longer
 * holds every other project's for as long as it runs (Sphe's M4, Nov 18: a
 * 17,460-frame render blocked ~30 short ones of another project for most of
 * an hour, and a title-card export gave up after 10 minutes behind it).
 *
 * Who goes next: a render someone waits on now (an export, a tool) ahead of
 * the rest, and one waiting longer than `ageMs` counts as waited on, so a long
 * render still finishes; among equals, the project served longest ago (round
 * robin across projects), then the one asking first. A render whose code
 * changed since it asked is dropped before it's given the slot. The render
 * drawing gives way at a chunk's end to another project's that goes ahead of
 * it, at once when that one is waited on and it isn't, else once it has held
 * the slot `sliceMs` (each change of render loads its pages again: turns at
 * every chunk would spend a long render's time loading). Within a project a
 * render gives way only to one someone waits on when nobody waits on it: a
 * 65-second export sat behind the same video's quarter-hour graphic, which it
 * doesn't show (Nov 23).
 */

/** A render asking for the slot. */
export interface Asking {
  project: string;
  /** Someone waits on it now (an export, a tool): ahead of renders nobody waits on. */
  urgent: () => boolean;
  /** Its code changed since it asked: dropped, never drawn. */
  stale: () => boolean;
}

/** A render's turn with the slot. */
export interface Turn {
  /** How long it waited in the line for this turn (ms). */
  waited: number;
  /** Whether it should give the slot up now (at a chunk's end): another project's render goes ahead of it. */
  shouldYield: () => boolean;
  /** Gives the slot up (once; again is nothing). */
  release: () => void;
}

interface Waiter {
  asking: Asking;
  since: number;
  grant: (turn: Turn) => void;
  fail: (error: Error) => void;
}

export interface TurnHooks {
  /** How long a render holds the slot before another project's of the same standing gets it. */
  sliceMs: number;
  /** How long a render nobody waits on waits before it counts as waited on. */
  ageMs: number;
  now: () => number;
}

export class Turns {
  private readonly line: Waiter[] = [];
  private held: { asking: Asking; at: number; first: boolean } | null = null;
  /** Each project's last turn, by count: the lowest went longest ago. */
  private readonly served = new Map<string, number>();
  private count = 0;

  constructor(
    private readonly hooks: TurnHooks,
    /** The error a render dropped as stale is failed with. */
    private readonly dropped: () => Error,
  ) {}

  /** Waits for the slot: answers with the turn, or fails with `dropped()` once its code changes while it waits. */
  take(asking: Asking): Promise<Turn> {
    return new Promise<Turn>((grant, fail) => {
      this.line.push({ asking, since: this.hooks.now(), grant, fail });
      this.next();
    });
  }

  /** How many renders wait for the slot. */
  waiting(): number {
    return this.line.length;
  }

  private first(waiter: Waiter, now: number): boolean {
    return waiter.asking.urgent() || now - waiter.since >= this.hooks.ageMs;
  }

  private dropStale(): void {
    for (let at = this.line.length - 1; at >= 0; at--) {
      const waiter = this.line[at]!;
      let stale = false;
      try {
        stale = waiter.asking.stale();
      } catch {
        // Unreadable now: left to fail its own way when drawn.
      }
      if (!stale) continue;
      this.line.splice(at, 1);
      waiter.fail(this.dropped());
    }
  }

  /** The waiter that goes next among `among`, or null. */
  private best(among: Waiter[], now: number): Waiter | null {
    let found: Waiter | null = null;
    let rank: [number, number, number] = [0, 0, 0];
    for (const waiter of among) {
      const mine: [number, number, number] = [this.first(waiter, now) ? 0 : 1, this.served.get(waiter.asking.project) ?? -1, waiter.since];
      if (found === null || mine[0] < rank[0] || (mine[0] === rank[0] && (mine[1] < rank[1] || (mine[1] === rank[1] && mine[2] < rank[2])))) {
        found = waiter;
        rank = mine;
      }
    }
    return found;
  }

  private next(): void {
    if (this.held !== null) return;
    this.dropStale();
    const now = this.hooks.now();
    const waiter = this.best(this.line, now);
    if (waiter === null) return;
    this.line.splice(this.line.indexOf(waiter), 1);
    const held = { asking: waiter.asking, at: now, first: this.first(waiter, now) };
    this.held = held;
    this.served.set(waiter.asking.project, ++this.count);
    let released = false;
    waiter.grant({
      waited: now - waiter.since,
      shouldYield: () => !released && this.shouldYield(held),
      release: () => {
        if (released) return;
        released = true;
        if (this.held === held) this.held = null;
        this.next();
      },
    });
  }

  private shouldYield(held: { asking: Asking; at: number; first: boolean }): boolean {
    this.dropStale();
    const now = this.hooks.now();
    if (!held.asking.urgent() && this.line.some((waiter) => waiter.asking.project === held.asking.project && waiter.asking.urgent())) return true;
    const rival = this.best(
      this.line.filter((waiter) => waiter.asking.project !== held.asking.project),
      now,
    );
    if (rival === null) return false;
    const theirs = this.first(rival, now) ? 0 : 1;
    const mine = held.first || held.asking.urgent() ? 0 : 1;
    if (theirs !== mine) return theirs < mine;
    return now - held.at >= this.hooks.sliceMs;
  }
}
