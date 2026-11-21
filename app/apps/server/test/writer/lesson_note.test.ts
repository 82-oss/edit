// Script mode's lessons (writer/lesson_note.ts): a revision's answer carries
// an optional lesson; a script without a channel, or a V1 lesson for every
// script, is kept nowhere since the team's lessons inbox went (Sphe, Nov 21),
// and the reply says so; none adds nothing. A channel's lesson going to its
// Script lane is v2_cloud.test.ts's.

import { expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import { keep, LESSON_RULE, LESSON_SCHEMA, lessonOf } from "../../src/writer/lesson_note.ts";

test("a revision's lesson with nowhere to go is said not kept; none adds nothing", async () => {
  const script = { id: "s1793450000000", title: "Predator Tutor", kind: "interrogation" } as Script;
  const plan = { edits: [], answer: "Done.", lesson: { lesson: "Openings start on the confession, not the arrest.", quote: "we always open on the confession", from: "JJ", scope: "style" } };
  expect(await keep(script, lessonOf(plan))).toContain("isn't a channel's, so nothing is kept");
  expect(await keep(script, lessonOf({ edits: [], answer: "Done." }))).toBe("");
  // A V1 channel's script: only a lesson of how that channel does its scripts has a place (its lane).
  expect(await keep({ ...script, channel: "some-ch" }, { lesson: "Every script opens cold.", quote: "always open cold", scope: "house" })).toContain("stays this script's");
  // The schema the model answers to has it optional, and the rule names it, with no inbox.
  expect(LESSON_SCHEMA.required).toEqual(["lesson", "quote", "scope"]);
  expect(LESSON_RULE).toContain("leave lesson out");
  expect(LESSON_RULE).not.toContain("inbox");
});
