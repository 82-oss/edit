// Home's New and Changed (Sphe, Nov 18: status "shows only what needs you"),
// from when the person last opened each thing (lib/seen.ts) and what its row
// already carries; apart from the hooks so it's checked on its own
// (seen-status.test.ts).
//
// New: their own work, done (an edit's import finished, a script's first
// build saved, an idea repackaged), not opened since it was done. Opening it
// while it imported doesn't count: that mark is older than the done.
//
// Changed: something they've opened before, changed since they last did. Their
// own changes never count, because every one is made while it's open and an
// open thing is marked as it's opened, every minute while it stays open, and as
// it's left (Home's own changes, a rename or a note, mark it too): what moved
// after the last mark was someone or something else (the agent working on in
// the background, a teammate, a review fix). Only the last moment of their own
// work can land just after that mark (a save, the cloud's copy of it), so a
// change within SETTLE_MS of it is theirs.

/** A change this soon after a mark is the person's own last save landing (here, then in the cloud). */
export const SETTLE_MS = 30_000;

/** Done before the marks were kept (Nov 18): never New. */
export const MARKS_FROM = Date.UTC(2026, 10, 18);

export type Fresh = "new" | "changed" | null;

export interface Work {
  /** Started by this person: only their own finished work is New. */
  mine: boolean;
  /** Still going (an import, a build, the agent's turn, a run): its own status says so; neither until it settles. */
  busy: boolean;
  /** When it was done (null: not done, or not known). */
  doneAt: number | null;
  /** When it last changed. */
  changedAt: number;
}

/** New, Changed or neither, for `work` the person last opened at `seen` (null: never, or the marks can't be read). */
export function newOrChanged(work: Work, seen: number | null, on = true): Fresh {
  if (!on || work.busy) return null;
  if (work.mine && work.doneAt !== null && work.doneAt >= MARKS_FROM && (seen === null || seen < work.doneAt)) return "new";
  if (seen !== null && work.changedAt > seen + SETTLE_MS) return "changed";
  return null;
}

/** When a project was started, from its id ("p<ms>-…"); null for one named otherwise. */
export function startedOf(id: string): number | null {
  const at = Number(/^p(\d{12,})-/u.exec(id)?.[1] ?? NaN);
  return Number.isFinite(at) ? at : null;
}

/**
 * An edit: done once its import is (when it got there here, else when it was
 * started: one made without an import, or imported on another computer);
 * changed when its file here was written, or the cloud's copy committed by
 * another computer (this one's commits are its file's writes, landing later).
 */
export function editWork(given: {
  id: string;
  mine: boolean;
  /** Its file here last written (null: only in the cloud). */
  modifiedMs: number | null;
  cloud: { updated_ms: number; updated_here?: boolean } | null;
  status: { importing: unknown; working: boolean; imported_ms?: number | null } | undefined;
}): Work {
  const elsewhere = given.cloud !== null && given.cloud.updated_here !== true ? given.cloud.updated_ms : 0;
  return {
    mine: given.mine,
    busy: given.status !== undefined && (given.status.importing !== null || given.status.working),
    doneAt: given.status?.importing != null ? null : (given.status?.imported_ms ?? startedOf(given.id)),
    changedAt: Math.max(given.modifiedMs ?? 0, elsewhere),
  };
}

/** A script with no edit yet: done once its first build is saved; changed when the cloud's copy is. */
export function scriptWork(given: { mine: boolean; built: boolean; builtAt?: number; updatedAt: number; busy: boolean }): Work {
  return { mine: given.mine, busy: given.busy, doneAt: given.built && given.builtAt !== undefined ? given.builtAt : null, changedAt: given.updatedAt };
}

/** An idea: done once repackaged (while that's its last run); changed when it is. */
export function ideaWork(given: { mine: boolean; run: string | null; repackagedAt?: number; updatedAt: number }): Work {
  return { mine: given.mine, busy: given.run === "running" || given.run === "queued", doneAt: given.repackagedAt ?? null, changedAt: given.updatedAt };
}
