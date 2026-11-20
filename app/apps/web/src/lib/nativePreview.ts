/**
 * Edit.app's native preview (crates/edit-window/src/preview.rs): the engine draws the viewer's
 * picture in a layer under the page, from the Mac's video decoder, where the
 * page decoded and drew every frame in WebKit. Only in Edit.app's window (a
 * browser has no window to ask). At rest the page owns the playhead and asks
 * for each frame; playing is the window's, on its speaker's clock (the sound
 * mixed there as the export mixes it), and the page follows its position.
 * The page keeps everything over the picture, and goes back to drawing it
 * itself if the window can't.
 */

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const invoke = (): Invoke | null => {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
};

/** Whether this page is in Edit.app's window, which can draw the preview itself. */
export const nativeAvailable = (): boolean => invoke() !== null && /Mac/.test(navigator.platform);

/**
 * How long the window may take to answer before the page counts it as not answering (ms): a quick ask (where it is,
 * a pause, a hint, the speed, the volume, its place, sources, a patch) 3 s, and one that may read or decode first (its
 * open, the whole edit, a frame, a play's start, its close) 10 s, past a cold first frame (1.5–3 s through R2 on an
 * 8 Mbit/s line). Until Nov 20 nothing bounded them: a read stuck in the window queued every Position, Pause and Frame
 * behind it for good, none of it counted as a failure, so the page never fell back to its own player (5 failures:
 * playback.ts `nativeFailed`).
 */
export const nativeTiming = { quickMs: 3_000, slowMs: 10_000 };
const SLOW = new Set(["preview_open", "preview_project", "preview_frame", "preview_play", "preview_close"]);

/** The window didn't answer in its time (`nativeTiming`). */
export class NativeTimeout extends Error {}

/** `promise`, or a rejection with `error()` once `ms` have passed without it settling. */
export function bounded<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const call = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  const run = invoke();
  if (run === null) throw new Error("not in Edit.app");
  const ms = SLOW.has(command) ? nativeTiming.slowMs : nativeTiming.quickMs;
  // Asked now, in this same turn (a jump's frame is asked at once, a close as the player is let go), then bounded.
  return bounded(Promise.resolve(run(command, args)), ms, () => new NativeTimeout(`the window didn't answer ${command} in ${ms / 1000} s`));
};

/**
 * How long before the window's sources are asked again after the server didn't answer them (`attempt`: 0 the first
 * time): 1, 2, 4, 8, then every 15 s. Until Nov 20 a failed ask was never asked again, so the window had no picture
 * until the next edit.
 */
export function sourcesRetryMs(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt));
}

/** Seconds `from..to` of a streamed source in a file here (a pieced proxy's piece): the window reads it instead. */
export interface NativeExcerpt { from: number; to: number; path: string }

/** A frame's answer: the revision on screen, whether it was drawn (else on screen already, or a newer ask took its place) and where its time went (ms). */
export interface NativeDrawn {
  revision: number;
  drawn: boolean;
  skipped: boolean;
  ms: number;
  decode: number;
  composite: number;
  present: number;
  opens: number;
  seeks: number;
  ffmpeg: number;
}

/**
 * Where the window's player is: the playhead (a frame and a fraction), whether it's playing and whether it
 * reached the end since the last ask, and how playing went since then: frames drawn, frames the clock passed
 * undrawn, slow draws (over 33 ms), their times (ms), the speaker's output calls that ran short of sound, and
 * why the sound went silent when it did.
 */
export interface NativeWhere {
  frame: number;
  playing: boolean;
  ended: boolean;
  drawn: number;
  skipped: number;
  slow: number;
  draws: number[];
  starved: number;
  /** The sound went silent since the last ask, and why (a file that won't open: gone from this Mac). */
  problem?: string;
  /**
   * Held for its footage (`hint` with `hold`): seconds of playing from there it has read through the server (10 once
   * all are, or all to the end). Absent when it isn't held, and in a window from before it said.
   */
  ahead?: number;
  /** Seconds of sound in its speaker, mixed and not yet heard (absent with no speaker, or a window from before). */
  sound?: number;
}

/**
 * The window has one player, opened by whichever screen shows a picture (the
 * editor's viewer, the script's monitor) and closed as it leaves. A close
 * still under way gives the page its background back when it ends, so an open
 * waits for it: opened sooner, the layer would be painted over.
 */
let closing: Promise<unknown> = Promise.resolve();

export const nativePreview = {
  /** Opens the layer (hidden until placed); false when this Mac's window can't. */
  open: async (): Promise<boolean> => {
    await closing;
    return (await call("preview_open")) === true;
  },
  /** Where the viewer is, in the page's points, the radius of its top corners, and whether the layer shows. */
  place: (rect: { x: number; y: number; width: number; height: number }, radius: number, visible: boolean): Promise<unknown> =>
    call("preview_place", { ...rect, radius, visible }),
  /**
   * The whole edit at `revision` as the page's engine takes it, what each media is decoded from, local excerpts of
   * streamed ones, and the media cache; resolves with the revision the window now draws, rejects with why it refused.
   */
  project: async (json: string, revision: number, sources: Record<string, string>, sounds: Record<string, string>, excerpts: Record<string, NativeExcerpt[]>, cache: string): Promise<number> =>
    Number(await call("preview_project", { json, revision, sources, sounds, excerpts, cache })),
  /** Where each media is read from now (a cloud preview's whole copy came down), without the edit; rejects in a window without it. */
  sources: (sources: Record<string, string>, sounds: Record<string, string>, excerpts: Record<string, NativeExcerpt[]>, cache: string): Promise<unknown> =>
    call("preview_sources", { sources, sounds, excerpts, cache }),
  /** What changed since `base` (lib/patch.ts), making `revision`; rejects when the window isn't at `base` or it doesn't fit. */
  patch: async (base: number, revision: number, patch: string): Promise<number> => Number(await call("preview_patch", { base, revision, patch })),
  /** Draws `frame`; settles once it's on screen, saying how. */
  frame: async (frame: number): Promise<NativeDrawn> => (await call("preview_frame", { frame })) as NativeDrawn,
  /** Plays from `frame` on the window's clock; rejects when there's nothing to play ("at the end"). */
  play: (frame: number): Promise<unknown> => call("preview_play", { frame }),
  /** Stops playing; the frame the playhead rests on (null: it wasn't playing). */
  pause: async (): Promise<number | null> => { const at = await call("preview_pause"); return typeof at === "number" ? at : null; },
  /** Where the player is, and how playing went since the last ask. */
  position: async (): Promise<NativeWhere> => (await call("preview_position")) as NativeWhere,
  /**
   * The playhead is about to land on `frame`: its pictures are made ready. `hold`: a play from there is held for its
   * footage: the window stops, draws it, mixes its sound and reads the seconds after it, and `position` says how far
   * (`ahead`, `sound`) until it's played (a window from before only makes its pictures ready).
   */
  hint: (frame: number, hold = false): Promise<unknown> => call("preview_hint", hold ? { frame, hold } : { frame }),
  /** The playing speed (1, or 2 for Script mode's 2×): the sound sped with it, its pitch kept; playing carries on from where it is. */
  rate: (rate: number): Promise<unknown> => call("preview_rate", { rate }),
  /** How loud the speaker is, 0 to 1, at once. */
  volume: (level: number): Promise<unknown> => call("preview_volume", { level }),
  close: (): Promise<unknown> => {
    const closed = call("preview_close");
    closing = closed.catch(() => {});
    return closed;
  },
};

/** One play on the window's clock, as it went: what the line in the log says (`playLine`). */
export interface NativeRun {
  /** Where it began (the edit's frame) and the edit's rate. */
  from: number;
  fps: number;
  /** Frames the window showed, passed over, and drew late (over a frame's time). */
  shown: number;
  skipped: number;
  slow: number;
  /** The longest a frame took to draw (ms), and how often the speaker ran out of sound. */
  longest: number;
  starved: number;
}

/**
 * The log's line for a play of two seconds or more (shorter ones are a tap):
 * how it went, so a hitch is in a teammate's report without asking them (Nov 10:
 * the window wrote nothing about its plays). A warning when it shows: frames
 * passed over (more than 1 in 100), a frame held a tenth of a second, the sound
 * short; null for a short one. `where`: the editor's viewer or the script's
 * monitor, both the window's one player.
 */
export function playLine(run: NativeRun, where = "in the window"): { level: "info" | "warn"; text: string } | null {
  if (run.shown < run.fps * 2) return null;
  const at = Math.floor(run.from / run.fps);
  const clock = `${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`;
  const seconds = (run.shown + run.skipped) / run.fps;
  const bad = run.skipped * 100 > run.shown || run.longest >= 100 || run.starved > 0;
  const text =
    `played ${seconds.toFixed(1)} s from ${clock} ${where}: ${run.shown} frames shown, ${run.skipped} passed over, ` +
    `${run.slow} drawn late, the longest ${Math.round(run.longest)} ms; ${run.starved > 0 ? `the sound ran short ${run.starved}×` : "the sound never ran short"}`;
  return { level: bad ? "warn" : "info", text };
}

/** A play's run so far, with what the window said while it played (`preview_position`). */
export function heardRun(run: NativeRun, at: NativeWhere): void {
  run.shown += at.drawn;
  run.skipped += at.skipped;
  run.slow += at.slow;
  run.starved += at.starved;
  for (const ms of at.draws) run.longest = Math.max(run.longest, ms);
}
