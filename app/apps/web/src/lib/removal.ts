// The chat's waiting row for a removal under way (RemovalRow.tsx), and how a
// turn Edit started on a background event reads (Sphe, Nov 17: like T3's
// background task, "◌ Waiting · <name>  1m 32s  Details  Stop").

import type { RemovalRun } from "./api";

/** What a turn of Edit's own starts with (the server's edit_event.ts). */
export const EDIT_EVENT = "(Edit, background)";

/** The row's words: "Removing their text · 12 of 81". */
export const runLine = (run: RemovalRun) => `${run.label} · ${run.done} of ${run.total}`;

/** "4 min left", "under a minute left", or nothing until the pace is known. */
export function leftLine(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${minutes} min left` : `about ${Math.round(minutes / 6) / 10} h left`;
}

/** A turn's message of Edit's own: its first line as the chat shows it (the prefix off). */
export function eventLine(text: string): string {
  const first = text.startsWith(EDIT_EVENT) ? text.slice(EDIT_EVENT.length).trim() : text.trim();
  return first.split("\n")[0]!.trim();
}
