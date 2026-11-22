// Exports made ahead, before anyone asked, are gone (Nov 22). Builds before then made a project's export in the
// background once its edits rested, with its next share's settings, into `<cache>/ahead/<id>.mp4`, for the export
// someone asked for to copy its chunks from. Counted over 14 days of the team's logs (Nov 8–22): of 114 started, 59
// finished (about 400 minutes of the Macs' encoders); of 45 exports someone asked for, 17 came after a finished one, 4
// of those copied a real share of their chunks from it (1 whole, 3 a third to nine tenths), at most about 12 minutes
// saved in all, and 10 copied nothing (made with other settings than the Export asked for, or the edit changed since). They held disks too: 8.6 GB for one project on Sphe's Linux Edit, more than its footage, and JJ's Mac was too
// full to keep its pieces. The chunks an export keeps for the next export of the same edit stay (exports.ts
// `lastChunks`): that is what makes an export of a slightly changed edit fast.
//
// What's left: the files those builds made go, once, as the server starts.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { join } from "./paths.ts";

/** Removes the exports made ahead by builds before Nov 22 (`<cache>/ahead`), off the server's thread. */
export async function removeLeftovers(cache: string): Promise<number> {
  const folder = join(cache, "ahead");
  let bytes = 0;
  try {
    for (const name of await fs.promises.readdir(folder)) bytes += (await fs.promises.stat(join(folder, name)).catch(() => null))?.size ?? 0;
  } catch {
    return 0;
  }
  await fs.promises.rm(folder, { recursive: true, force: true });
  return bytes;
}

/** As the server starts (serve.ts): what earlier builds made ahead goes. */
export function start(app: App): void {
  void removeLeftovers(app.store.cacheDir()).then(
    (bytes) => {
      if (bytes > 0) diag.info("export", `removed the exports made ahead by an earlier build: ${(bytes / 1e9).toFixed(1)} GB`);
    },
    (error: unknown) => diag.warn("export", `removing the exports made ahead by an earlier build: ${diag.messageOf(error)}`),
  );
}
