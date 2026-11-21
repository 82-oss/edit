// The chat's waiting row for work under way in the background (RemovalRow.tsx;
// Sphe, Nov 17, like T3's background task: "◌ Waiting · <what> · 12 of 25
// pieces · 18m 04s  Stop"): removal's, and a channel's end-of-turn check's.

import type { BackgroundLine } from "./api";

/** The row's words: "Removing their text and watermarks · 12 of 25 pieces"; just what, when there's nothing to count. */
export const runLine = (run: Omit<BackgroundLine, "key">) => (run.total > 0 ? `${run.label} · ${run.done} of ${run.total} ${run.unit ?? "pieces"}` : run.label);
