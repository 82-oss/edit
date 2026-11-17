// The chat's waiting row for a removal under way (RemovalRow.tsx), and how a
// turn Edit started on a background event reads (Sphe, Nov 17: like T3's
// background task, "◌ Waiting · <name>  1m 32s  Details  Stop").

import type { RemovalPiece, RemovalRun } from "./api";
import type { StepRow } from "./export-steps";

/** What a turn of Edit's own starts with (the server's edit_event.ts). */
export const EDIT_EVENT = "(Edit, background)";

/** The row's words: "Removing their text and watermarks · 12 of 25 pieces". */
export const runLine = (run: RemovalRun) => `${run.label} · ${run.done} of ${run.total} pieces`;

/** "4 min left", "under a minute left", or nothing until the pace is known. */
export function leftLine(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${minutes} min left` : `about ${Math.round(minutes / 6) / 10} h left`;
}

const STATE: Record<string, { state: StepRow["state"]; word: string }> = {
  queued: { state: "waiting", word: "waiting" },
  held: { state: "waiting", word: "waiting for the account" },
  running: { state: "current", word: "being cleaned" },
  check: { state: "done", word: "cleaned" },
  done: { state: "done", word: "cleaned, checked" },
  none: { state: "done", word: "no mark there" },
  failed: { state: "done", word: "not clean" },
};

/** Each piece as a step row: its file and seconds, what it takes out, how it came out and why. */
export function pieceRows(pieces: RemovalPiece[]): StepRow[] {
  const order = (piece: RemovalPiece) => (piece.state === "running" ? 0 : piece.state === "queued" || piece.state === "held" ? 2 : 1);
  return [...pieces]
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name) || a.from - b.from)
    .map((piece) => {
      const known = STATE[piece.state] ?? { state: "waiting" as const, word: piece.state };
      // Its words whole on every row (a step row says a note only while it's under way): what it takes out, and the check's why.
      const why = piece.why ? ` · ${piece.state === "failed" ? (piece.what === "watermark" ? "left: " : "blurred: ") : ""}${piece.why}` : "";
      return {
        key: piece.key,
        state: known.state,
        text: `${piece.name} · ${Math.round(piece.from)}–${Math.round(piece.to)} s · ${piece.what === "watermark" ? "watermark" : "their text"}${why}`,
        progress: null,
        right: known.word,
      };
    });
}

/** A turn's message of Edit's own: its first line as the chat shows it (the prefix off). */
export function eventLine(text: string): string {
  const first = text.startsWith(EDIT_EVENT) ? text.slice(EDIT_EVENT.length).trim() : text.trim();
  return first.split("\n")[0]!.trim();
}
