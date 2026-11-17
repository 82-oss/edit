// An export's steps as the Export dialog and the Exports queue show them
// (Sphe, Nov 17: "the steps, each with its own progress"): the graphics that
// must render first, the video, then where it goes (saved here, or the review
// copy and its upload). The server says where each stands and how long it
// has left (export_steps.ts, from this computer's measured speeds); the pages
// only lay it out (apps/web/src/lib/export-steps.ts).

export type StepState = "done" | "current" | "waiting";

export interface ExportStep {
  kind: "graphic" | "video" | "copy" | "upload" | "save";
  state: StepState;
  /** A graphic's place on the timeline ("41:12"), the video's length ("1:48:29"), the folder it's saved to ("~/Movies/Edit"); else "". */
  label: string;
  /** A graphic that's more than a picture: a map, a sound. */
  what?: "map" | "sound";
  /** The current step's share done (0–1), when it's measured. */
  progress: number | null;
  /** Seconds it has left (all of it, for one still to come); null until there's a basis for it. */
  left_s: number | null;
  /** The current step's wait, in a few words ("waiting for the encoder"). */
  note?: string;
}

export interface ExportSteps {
  /** Saved on this computer, or sent for feedback. */
  where: "here" | "feedback";
  steps: ExportStep[];
  /** In line behind another export: nothing of it has started. */
  queued: boolean;
  /** Seconds since it was asked for. */
  elapsed_s: number;
  /** Seconds left of all of it, null until every step still to come has a basis. */
  left_s: number | null;
  /** The whole job, 0–1, by time: elapsed over elapsed and left (by its steps when untimed). */
  progress: number;
}

/** One job in the queue as the overall reads it. */
export interface QueueJob {
  state: string;
  progress: number;
  steps?: ExportSteps | null;
}

const going = (job: QueueJob) => job.state === "queued" || job.state === "running";

/**
 * The queue's one number and time: every job queued or running, each
 * weighted by how long it takes in all (elapsed and left), so a long export
 * waiting on 27 graphics counts for more than a short one. A job with no time
 * yet weighs what the timed ones do on average (1 when none is timed); the
 * time left is said only once every job has one.
 */
export function overall(jobs: readonly QueueJob[]): { progress: number; left_s: number | null } {
  const active = jobs.filter(going);
  if (active.length === 0) return { progress: 0, left_s: null };
  const timed = active.map((job) => (job.steps && job.steps.left_s !== null ? job.steps.elapsed_s + job.steps.left_s : null));
  const known = timed.filter((one): one is number => one !== null);
  const usual = known.length > 0 ? Math.max(1, known.reduce((sum, one) => sum + one, 0) / known.length) : 1;
  let weight = 0;
  let done = 0;
  active.forEach((job, at) => {
    const share = job.steps ? job.steps.progress : job.state === "queued" ? 0 : job.progress;
    const w = Math.max(timed[at] ?? usual, 1);
    weight += w;
    done += w * Math.min(1, Math.max(0, share));
  });
  const left = active.every((job) => job.steps && job.steps.left_s !== null) ? active.reduce((sum, job) => sum + job.steps!.left_s!, 0) : null;
  return { progress: weight > 0 ? done / weight : 0, left_s: left };
}
