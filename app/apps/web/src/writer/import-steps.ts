import type { ImportProgress } from "./types";
import { timeOfDay } from "../lib/import_progress";
import { THIS_MACHINE } from "../lib/platform";

/** An import's steps, in order, as imports.ts reports them (its stage, and the words of its detail). */
export const STEPS: { key: string; label: string; hint: string }[] = [
  { key: "download", label: "Download", hint: `The footage comes down from YouTube, Drive or ${THIS_MACHINE}.` },
  { key: "preview", label: "Preview", hint: "Joined into one timeline and cut to a 480p preview the editors play." },
  { key: "research", label: "Research", hint: "The article and any case files are read for names and facts." },
  { key: "transcribe", label: "Transcribe", hint: "Every recording is heard and its words timed." },
  { key: "watch", label: "Check speakers", hint: "The footage is watched to check who says each line. Saved checks are reused after a restart." },
  { key: "speakers", label: "Name speakers", hint: "Each voice gets a name or a role." },
];

export function stepOf(item: Pick<ImportProgress, "stage" | "detail">): string {
  const said = `${item.stage} ${item.detail}`.toLowerCase();
  if (/who speaks|saved checks/.test(said)) return "watch";
  if (/naming the speakers|speaker/.test(said)) return "speakers";
  if (/transcrib|hearing|who speaks|heard/.test(said)) return "transcribe";
  if (/research|pdf|article|case file/.test(said)) return "research";
  if (/preview|joining|cutting|processing/.test(said)) return "preview";
  return "download";
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s` : `${seconds} s`;
}

/**
 * An import's percentage as shown: the server's number, eased a few points
 * ahead of it only while the server is moving (a byte, a frame or a step in
 * the last `MOVING_MS`), so a long step that reports no percent of its own
 * still shows life (the user, Oct 30: "we always get stuck at 60% visually").
 * It never goes back and never past 99. Nov 20: it crept to 99 on a log curve
 * whatever the server did, so an import waiting on a dropped line for an hour
 * read as nearly done ("Imports just freeze out of nowhere"): now a number the
 * server didn't move stays where it is, and the line says since when
 * (`stillLine`).
 */
const CREEP = new Map<string, { said: number; from: number; since: number; shown: number }>();
const SCALE = 4;
const MINUTE = 60_000;
/** The server moved this recently: the number may ease ahead of what it said. */
const MOVING_MS = 20_000;
/** At most this many points ahead of the server's own number. */
const AHEAD = 4;
/** Not moved for this long: the import's line says nothing has come in since (a slow line still moves bytes every few seconds). */
export const STILL_MS = 5 * 60_000;
/** Kept on this browser, so a reload carries on rather than dropping back to the server's number. */
const KEPT = "edit.import.creep";
function kept(id: string): { said: number; from: number; since: number; shown: number } | undefined {
  try {
    const one = (JSON.parse(localStorage.getItem(KEPT) ?? "{}") as Record<string, { said: number; from: number; since: number }>)[id];
    return one === undefined ? undefined : { ...one, shown: one.from };
  } catch {
    return undefined;
  }
}
function keep(id: string, entry: { said: number; from: number; since: number }): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEPT) ?? "{}") as Record<string, { said: number; from: number; since: number }>;
    all[id] = entry;
    // Only the last few imports.
    const ids = Object.keys(all).slice(-12);
    localStorage.setItem(KEPT, JSON.stringify(Object.fromEntries(ids.map((key) => [key, all[key]]))));
  } catch {
    // Private mode or full: kept for this page only.
  }
}
/** `said` as shown for import `id`; `movedAt`: when the server last saw it move (none known: it never eases ahead). */
export function creeping(id: string, said: number, now = Date.now(), movedAt?: number): number {
  let seen = CREEP.get(id);
  if (seen === undefined) {
    seen = kept(id);
    if (seen !== undefined) CREEP.set(id, seen);
  }
  if (!Number.isFinite(said)) said = 0;
  if (seen !== undefined && !Number.isFinite(seen.shown)) seen = undefined;
  if (seen === undefined || seen.said !== said) {
    const from = Math.max(said, seen?.shown ?? 0);
    CREEP.set(id, { said, from, since: now, shown: from });
    keep(id, { said, from, since: now });
    return from;
  }
  // Still on the server: where it is.
  if (movedAt === undefined || !Number.isFinite(movedAt) || now - movedAt > MOVING_MS) return seen.shown;
  // A clock read before `since` (the dialog's, ticking once a second, or one from before it opened) creeps nothing:
  // log1p of under -1 is NaN, and it stuck (JJ, Nov 10: "NaN%" on a 9-hour import's dialog).
  const ahead = seen.from + SCALE * Math.log1p(Math.max(0, now - seen.since) / MINUTE);
  seen.shown = Math.max(seen.shown, Math.min(99, said + AHEAD, ahead));
  return seen.shown;
}

/**
 * The line an import shows once the server hasn't seen it move for `STILL_MS` (no byte, frame or step), in place of
 * its own: since when, and that Edit keeps at it by itself; null while it moves, or when the server didn't say.
 */
export function stillLine(movedAt: number | undefined, now = Date.now()): string | null {
  if (movedAt === undefined || !Number.isFinite(movedAt) || now - movedAt < STILL_MS) return null;
  return `Nothing has come in since ${timeOfDay(movedAt)}. Edit keeps trying by itself.`;
}
