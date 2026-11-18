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
import * as tools from "./tools.ts";

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
  settleBelow();
  for (const listener of listeners) listener(now);
  idleChanged();
}

// ---------------------------------------------------------------------------
// The link is the person's
//
// While someone waits on a project's footage to open it (footage_ready.ts: its dialog, then its corner card until
// the footage is here or they press Open now), the link is theirs as much as during a play: on kenobi (Nov 17, 1
// MB/s) thumbnail strips, effect renders and backfill uploads took half of it while the dialog waited. Background
// work gives way to it through the same gate as to a play (`whenIdle`, `isIdle`); the footage itself (whole copies,
// its blocks, a long video's pieces) gives way only to a play (`isPlaying`, `whenNotPlaying`).

/** Each project whose footage someone waits on, and until when that holds (its page asks again within it). */
const holds = new Map<string, number>();
const idleListeners = new Set<() => void>();
let idleWas = true;
let holdTimer: ReturnType<typeof setTimeout> | undefined;

/** Someone waits on project `id`'s footage for `ms` more (asked again while they do). */
export function holdLink(id: string, ms: number): void {
  const fresh = !holds.has(id);
  holds.set(id, hooks.now() + ms);
  if (fresh) diag.info("playback", `${id}: its footage is waited on: background work gives way to it`);
  idleChanged();
}

/** Nobody waits on project `id`'s footage now (it's here, or Open now was pressed). */
export function releaseLink(id: string): void {
  if (!holds.delete(id)) return;
  diag.info("playback", `${id}: its footage isn't waited on now: background work carries on`);
  idleChanged();
}

/** Whether someone waits on a project's footage on this Mac now. */
export function linkHeld(): boolean {
  const now = hooks.now();
  for (const [id, until] of holds) if (until <= now) holds.delete(id);
  return holds.size > 0;
}

/** Whether background work may take the link and the CPU now: nothing plays, and nobody waits on footage. */
export function isIdle(): boolean {
  return !isPlaying() && !linkHeld();
}

/** Told each time background work may go on again (a play stopped, footage no longer waited on). */
export function onIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => idleListeners.delete(listener);
}

function idleChanged(): void {
  const now = isIdle();
  clearTimeout(holdTimer);
  // A hold nobody renews ends by itself.
  if (holds.size > 0) {
    holdTimer = setTimeout(idleChanged, Math.max(10, Math.min(...holds.values()) - hooks.now()));
    (holdTimer as { unref?: () => void }).unref?.();
  }
  if (now === idleWas) return;
  idleWas = now;
  if (now) for (const listener of idleListeners) listener();
}

/**
 * Resolves once nothing plays and nobody waits on footage (at once when so); false when `stop()` gave up first.
 * Background work waits here between its steps, never in the middle of a write.
 */
export async function whenIdle(stop: () => boolean = () => false): Promise<boolean> {
  while (!isIdle() && !stop()) await new Promise((resolve) => setTimeout(resolve, hooks.pollMs));
  return !stop();
}

/** Resolves once nothing plays: for the footage being waited on itself, which gives way only to a play. */
export async function whenNotPlaying(stop: () => boolean = () => false): Promise<boolean> {
  while (isPlaying() && !stop()) await new Promise((resolve) => setTimeout(resolve, hooks.pollMs));
  return !stop();
}

// ---------------------------------------------------------------------------
// Kept below a play

/**
 * Processes whose work goes on through a play, below it (Sphe, Nov 17: the
 * agent previews its work "while we watch the video smoothly, as if it's not
 * even happening"): the effects' Chromes, the agent's looks and the renders.
 * On a Mac the whole of each one's tree is put in macOS's background state
 * while a play is watched (efficiency cores only, its disk and network behind
 * everything else; `taskpolicy -b -p`) and taken out of it when the play stops
 * (`-B`), so it runs at full speed when nobody's watching: a utility QoS clamp
 * held all the time cost a WebGL page 60 frames a second down to 14 on an idle
 * M1 (Nov 17), the background state 6. On Linux each is started niced
 * (`belowCommand`), which costs nothing while nothing else wants the CPU.
 * Nothing waits: a look goes on through a long watch.
 */
const below = new Set<number>();
/** The state last set on the trees (true: in the background), and the work setting it. */
let belowSet = false;
let belowLine: Promise<void> = Promise.resolve();

export const belowHooks = {
  /** Puts one process in the background state, or takes it out; null where there's no such state (Linux: nice alone, at the start). */
  background: process.platform === "darwin" ? darwinBackground : (null as ((pid: number, on: boolean) => Promise<void>) | null),
  /** Every process and its parent, as `ps` lists them. */
  list: listProcesses,
};

/**
 * `command` started below the person's own work: on Linux at
 * `tools.BACKGROUND_NICE` (`tools.lowPriority`), which every process it starts
 * inherits; on a Mac as it is (it goes below only while a play is watched).
 */
export function belowCommand(command: readonly string[]): string[] {
  return process.platform === "darwin" ? [...command] : tools.lowPriority(command);
}

const TASKPOLICY = "/usr/sbin/taskpolicy";

/**
 * Keeps process `pid` and everything it starts below a play from now on
 * (into the background state at once when one plays); the answer lets it go.
 */
export function keepBelow(pid: number): () => void {
  below.add(pid);
  if (belowSet) settleBelow(true);
  return () => {
    below.delete(pid);
  };
}

/** Sets every tree kept below to the state a play asks for now (`fresh`: the trees are set again even if the state stands). */
function settleBelow(fresh = false): void {
  const background = belowHooks.background;
  if (background === null || (below.size === 0 && !belowSet)) return;
  if (was === belowSet && !fresh) return;
  belowLine = belowLine.then(async () => {
    const on = was;
    const roots = [...below];
    belowSet = on;
    if (roots.length === 0) return;
    try {
      const pids = treesOf(roots, await belowHooks.list());
      await Promise.all(pids.map((pid) => background(pid, on).catch(() => {})));
      diag.info("playback", `${pids.length} process${pids.length === 1 ? "" : "es"} of the agent's previews ${on ? "put below the play" : "back at full speed"}`);
    } catch (error) {
      diag.warn("playback", `putting the agent's previews ${on ? "below the play" : "back"}: ${diag.messageOf(error)}`);
    }
  });
}

/** `roots` and every process under them, from `listed` (pid → parent). */
export function treesOf(roots: readonly number[], listed: ReadonlyMap<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of listed) children.set(parent, [...(children.get(parent) ?? []), pid]);
  const out: number[] = [];
  const seen = new Set<number>();
  const next = roots.filter((root) => listed.has(root));
  while (next.length > 0) {
    const pid = next.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    next.push(...(children.get(pid) ?? []));
  }
  return out;
}

async function listProcesses(): Promise<Map<number, number>> {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  const out = new Map<number, number>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (match !== null) out.set(Number(match[1]), Number(match[2]));
  }
  return out;
}

async function darwinBackground(pid: number, on: boolean): Promise<void> {
  const child = Bun.spawn([TASKPOLICY, on ? "-b" : "-B", "-p", String(pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await child.exited;
}

/** For tests. */
export function reset(): void {
  plays.clear();
  clearTimeout(timer);
  was = false;
  holds.clear();
  clearTimeout(holdTimer);
  idleWas = true;
  below.clear();
  belowSet = false;
}

/** For tests: once the trees kept below are set as a play asks. */
export function belowSettled(): Promise<void> {
  return belowLine;
}
