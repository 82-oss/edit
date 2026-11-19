// The question census (honest council change 9, Nov 19): every place the server parks work waiting for a person is
// listed here, each with what it asks and why only a person can answer it. A new one fails this test until it's added
// to the list on purpose, so no question about trouble that passes arrives unseen. Trouble that passes never parks
// for a person: it waits in the job table by failure.ts's rule (failure.test.ts).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** Every place work is parked for a person, by file and the words that park it. */
const CENSUS: { file: string; parks: string; asks: string }[] = [
  // Q1: the editor's import, a file that's really the person's (deleted, never shared, private, not a video); both answers keep the work.
  { file: "script.ts", parks: `until: "person"`, asks: "Use another link · Make the edit with its parts black" },
  // Q6: a fact about the footage, never a failure: no sound, or the hearing answered with no words.
  { file: "writer/imports.ts", parks: `pause(dir, script, { kind: "no_speech"`, asks: "Open without a transcript · Cancel" },
  { file: "writer/imports.ts", parks: `pause(dir, script, { kind: "no_speech"`, asks: "Open without a transcript · Cancel (no words heard)" },
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("every place the server parks work for a person is on the census, and nothing else parks", () => {
  const found: { file: string; parks: string }[] = [];
  for (const path of sources(SRC)) {
    const file = path.slice(SRC.length + 1);
    // The table itself only says what `until: "person"` means.
    if (file === "jobs.ts") continue;
    const text = fs.readFileSync(path, "utf8");
    for (const parks of [`until: "person"`, `pause(dir, script, { kind: "no_speech"`]) {
      let at = text.indexOf(parks);
      while (at >= 0) {
        // In a comment it parks nothing.
        const line = text.slice(text.lastIndexOf("\n", at) + 1, at);
        if (!line.trimStart().startsWith("//") && !line.trimStart().startsWith("*")) found.push({ file, parks });
        at = text.indexOf(parks, at + parks.length);
      }
    }
  }
  expect(found.sort((a, b) => `${a.file}${a.parks}`.localeCompare(`${b.file}${b.parks}`))).toEqual(
    CENSUS.map(({ file, parks }) => ({ file, parks })).sort((a, b) => `${a.file}${a.parks}`.localeCompare(`${b.file}${b.parks}`)),
  );
});
