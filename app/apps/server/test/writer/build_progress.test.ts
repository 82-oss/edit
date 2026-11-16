// A fast build carries on after a restart from the last phase it finished (Nov 16: JJ's Edit restarted while Claude
// reviewed a joined script, and the build began again from the outline).

import { expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script, Word } from "@edit/types/writer";

import * as realClaude from "../../src/writer/claude.ts";

const asked: string[] = [];
// The real one kept first (a mocked module's own names are the stand-ins), and used whenever this test isn't running:
// the mock is the whole run's.
const real = { ask: realClaude.ask };
const standIn = { on: false };
void mock.module("../../src/writer/claude.ts", () => ({
  ...realClaude,
  // Claude stands in: it answers each phase without calling a tool, so only what's asked is seen.
  ask: async (question: realClaude.Question) => {
    if (!standIn.on) return real.ask(question);
    asked.push(question.label);
    return { structured: null, text: null, session: null, costUsd: 0.5, result: {} };
  },
}));

const build = await import("../../src/writer/build.ts");

function script(): Script {
  const words: Word[] = Array.from({ length: 40 }, (_, index) => ({ id: `w${index}`, text: index % 5 === 4 ? "end." : `word${index}`, startMs: index * 1000, endMs: index * 1000 + 800 }));
  return { id: "s1", title: "A case", sourceKind: "youtube", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 40_000, words, clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null };
}

const outline = { sections: [{ title: "All", plan: "the whole case", footageSeconds: 30 }], opening: null, report: "One case." };
const items = [
  { kind: "clip", firstWordId: "w0", lastWordId: "w4" },
  { kind: "cut-in", narration: "An intro." },
  { kind: "clip", firstWordId: "w5", lastWordId: "w9" },
  { kind: "cut-in", narration: "A middle." },
  { kind: "clip", firstWordId: "w0", lastWordId: "w9" },
  { kind: "cut-in", narration: "The outro." },
];

test("a build with its sections kept from before a restart only finishes: no outline or section is asked again, and its progress goes once it ends", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-build-progress-"));
  const at = join(dir, ".build-progress.json");
  standIn.on = true;
  try {
    const one = script();
    fs.writeFileSync(at, JSON.stringify({ key: build.progressKey(one, "", null), at: Date.now(), cost: 3, outline, sections: [{ items, note: null }] }));
    asked.length = 0;
    const done = await build.buildFast(one, "", null, [], undefined, () => {}, at);
    expect(asked.some((label) => label.includes("outlining") || label.includes("section"))).toBe(false);
    expect(asked.some((label) => label.includes("finishing"))).toBe(true);
    expect(done.clips.length).toBeGreaterThan(0);
    // What was spent before the restart is counted.
    expect(done.costUsd).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(at)).toBe(false);

    // Another build's progress (a different note) isn't taken: it outlines afresh.
    fs.writeFileSync(at, JSON.stringify({ key: build.progressKey(one, "something else", null), at: Date.now(), cost: 0, outline, sections: [{ items, note: null }] }));
    asked.length = 0;
    await build.buildFast(one, "", null, [], undefined, () => {}, at).catch(() => null);
    expect(asked[0]).toContain("outlining");
    expect(fs.existsSync(at)).toBe(false);
  } finally {
    standIn.on = false;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
