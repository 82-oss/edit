// The chat's waiting row for a removal under way (RemovalRow.tsx; Sphe, Nov
// 17, like T3's background task: "◌ Waiting · <what> · 12 of 25 pieces ·
// 18m 04s  Stop").

import type { RemovalRun } from "./api";

/** The row's words: "Removing their text and watermarks · 12 of 25 pieces". */
export const runLine = (run: RemovalRun) => `${run.label} · ${run.done} of ${run.total} pieces${run.free_left !== undefined ? ` · ${run.free_left} free ${run.free_left === 1 ? "file" : "files"} left today` : ""}`;
