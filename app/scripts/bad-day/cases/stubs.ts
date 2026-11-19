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

export const stubs: Case[] = [
  stub(
    "handoff-no-refetch",
    "8",
    "A three-recording case imported in Script mode, then 'Start the edit' in the same run. Check: the editor's import fetches no original from the stand-in cloud.",
  ),
  stub(
    "resume-download",
    "8",
    "A 150 MB file at 8 Mbit/s, the line cut five times and Edit killed once. Checks: bytes fetched are at most the file plus a little for each cut; the file's checksum is right; " +
      "the excerpts match a clean run's, by length and by first, middle and last frame.",
  ),
  stub(
    "upload-behind",
    "8",
    "The way up held to 1 Mbit/s. Checks: the edit is laid out while the original is still going up; with the line then cut, an export of that edit still finishes from the files here.",
  ),
];
