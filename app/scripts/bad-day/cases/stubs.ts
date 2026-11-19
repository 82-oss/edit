// The cases for changes 7 and 8 of final.md, their spec written and not run
// yet (`stub: true`): each is written when its change is made, and must fail
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
    "wifi-drop-editor-import",
    "7",
    "The night of Nov 18. Two files; the line drops for a scaled 90 s during the second, through the last quick try. Then, one run for each, every answer in the census " +
      "(final.md change 9) is sent to the server as if its button had been pressed, shown or not. Checks: nothing is asked; no answer changes the ranges; the import finishes within seconds of the line coming back.",
  ),
  stub(
    "wifi-drop-script-import",
    "7",
    "The same for a three-recording case in Script mode, with a kill in the middle. Checks: no 'import stopped'; the retry survives the kill; the case is whole at the end.",
  ),
  stub(
    "kill-three-times",
    "7",
    "Edit is killed three times in a row at each step of an import, an export and a share. Checks: nothing is given up; every piece of work is listed once; " +
      "nothing already fetched is fetched again; nothing paid is sent twice (the stand-ins count hearings, voices and model calls).",
  ),
  stub(
    "share-drop",
    "7",
    "The line drops during a share's upload. Checks: the share waits and its link comes by itself; nothing says 'stopped'; the bytes sent are at most the file plus one part for each drop.",
  ),
  stub(
    "upload-failed-then-update",
    "7",
    "A share fails at its upload; Edit starts as a newer build. Checks: no chunk is rendered again; the share goes up from the export it has.",
  ),
  stub("awake-and-busy", "7", "During each kind of work, the one answer to 'what is running' (busy.ts) names it; when nothing runs, it is empty."),
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
