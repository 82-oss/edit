import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import { resolveProposals } from "../../src/writer/edits.ts";
import * as store from "../../src/writer/store.ts";

const ID = "5c3431b7-51fb-404a-90aa-87b728c08f93";

function made(): string {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-proposal-notes-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  const note = { id: "n1", text: "edit: charges on screen", at: 0, anchor: { start: 20, end: 41, quote: "kidnapping and murder" } };
  const script = {
    id: ID, title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "ready", progress: 100, error: null, durationMs: 10_000, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [],
    clips: [{ id: "c1", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He said he was home." }],
    proposals: [{ id: "p1", cutIn: "c1", before: "He said he was home.", after: "He was charged with kidnapping and murder.", at: 0, notes: [note] }],
  } as unknown as Script;
  store.write(dir, script);
  return data;
}

// Codex on #11: a note on words only a proposed rewrite has goes on the cut-in with it, never before, and never if it's declined.
test("a proposal's notes come onto its cut-in when it's accepted, and go when it's declined", () => {
  const accepted = resolveProposals(made(), ID, 1, ["p1"], true);
  expect(accepted.clips[0]!.narration).toBe("He was charged with kidnapping and murder.");
  expect(accepted.clips[0]!.notes?.map((note) => note.anchor?.quote)).toEqual(["kidnapping and murder"]);
  const declined = resolveProposals(made(), ID, 1, ["p1"], false);
  expect(declined.clips[0]!.narration).toBe("He said he was home.");
  expect(declined.clips[0]!.notes).toBeUndefined();
  expect(declined.proposals).toEqual([]);
});
