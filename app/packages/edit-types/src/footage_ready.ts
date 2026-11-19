// Whether a project's footage is on this Mac enough to play smoothly from the
// start, and how far its coming here has got (Sphe, Nov 17: opening a project
// whose footage is on someone else's Mac must never drop you into stuttering
// playback without a word). The server works it out (footage_ready.ts); the
// page shows the dialog over the project while it isn't, and the top bar's
// cloud while the rest still comes (apps/web/src/components/FootageReady.tsx).

export type FootageStepState = "done" | "current" | "waiting";

export interface FootageStep {
  /** The start of the edit (its first minutes, what a play from 0:00 needs), the rest of the footage, the graphics (effects' renders). */
  kind: "start" | "rest" | "graphics";
  state: FootageStepState;
  /** Seconds it has left; null with no measured speed yet. */
  left_s: number | null;
  /** Over, but some of it can't come here (the disk's room, a fetch failing): that part plays from the cloud. */
  streams?: boolean;
}

export interface FootageReady {
  /** It plays smoothly from the start now: the dialog opens the project by itself. */
  ready: boolean;
  /** Everything that can come here is here: the corner card goes. */
  done: boolean;
  /** Whose Mac the edit was made on, as people see it ("Lauana's Mac"); null when not known. */
  made_on: string | null;
  /** Seconds of the edit the first step brings (whole minutes; the edit's length when it's all of it). */
  head_s: number;
  /** The edit's length in seconds. */
  length_s: number;
  bytes_done: number;
  bytes_total: number;
  files_done: number;
  files_total: number;
  /** Bytes a second footage comes down at here, measured; null before any is. */
  speed_bps: number | null;
  /** Seconds until it plays smoothly from the start (the dialog's time). */
  ready_in_s: number | null;
  /** Seconds until everything is here (the corner card's time). */
  left_s: number | null;
  steps: FootageStep[];
  /** Said plainly when the disk can't hold it all ("Only 4.2 of the 9.4 GB fits on this Mac…"); null when it can. */
  room: string | null;
  /** Said plainly when it can't become smooth here (it doesn't fit, and the link is too slow to stream it): Open now is the way on. */
  cant: string | null;
}

/**
 * How far a project's footage has got coming down to this Mac, on Home's line while it does (Sphe, Nov 18: progress
 * that carries on after leaving the editor should be seen there too). The server's `footageReady.coming`.
 */
export interface FootageComing {
  files_done: number;
  files_total: number;
  bytes_done: number;
  bytes_total: number;
  /** Seconds until all of it is here; null with no measured speed. */
  left_s: number | null;
}

/**
 * An edit's footage that isn't here and can't play (Sphe, Nov 18): files gone from this machine with no cloud copy, or
 * footage whose cloud proxy is gone. The top bar's cloud says it, with Retry now and Go on without it; export and share
 * wait for it. The server's `missing_media.ts`.
 */
export interface EditMissing {
  /** Files the timeline uses. */
  used: number;
  /** Those not here, less the ones the person went on without; `asked` when only the person can put it right (a file gone from this machine with no cloud copy), so Retry is worth pressing. */
  missing: { id: string; name: string; path: string; asked?: boolean }[];
}
