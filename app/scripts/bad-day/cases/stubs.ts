// The cases for change 8 of final.md, their spec written and not run yet
// (`stub: true`): each is written when its change is made, and must fail
// on the code before it.

import type { Case } from "./index.ts";

const stub = (name: string, change: string, spec: string): Case => ({
  name,
  change,
  spec,
  stub: true,
  async run() {
    throw new Error(`${name} isn't written yet`);
  },
});

// `handoff-no-refetch` and `upload-behind` are written (handoff.ts, Nov 21).
export const stubs: Case[] = [
  stub(
    "resume-download",
    "8",
    "A 150 MB file at 8 Mbit/s, the line cut five times and Edit killed once. Checks: bytes fetched are at most the file plus a little for each cut; the file's checksum is right; " +
      "the excerpts match a clean run's, by length and by first, middle and last frame.",
  ),
];
