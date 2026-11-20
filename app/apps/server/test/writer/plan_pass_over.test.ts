// Nov 20: the Claude plan at its limit held a Script import silently for up to twelve hours (`ask` waits up to six for
// its reset, `askPatiently` twice) on "Reading who says each line: 3 of 12". Who says each line is an extra the import
// finishes without, so a plan at its limit is passed over at once and said, as a failure already was.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Script } from "@edit/types/writer";

import * as planLimit from "../../src/plan_limit.ts";
import * as captionTurns from "../../src/writer/caption_turns.ts";
import * as claude from "../../src/writer/claude.ts";
import { readTurns } from "../../src/writer/imports.ts";
import { parse } from "../../src/writer/captions.ts";

const asked = captionTurns.asking.ask;
afterEach(() => {
  captionTurns.asking.ask = asked;
  planLimit.reset();
});

function captioned(): Script {
  const transcript = parse({ events: [
    { tStartMs: 500, dDurationMs: 500, segs: [{ utf8: ">> Where?" }] },
    { tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: ">> Here." }] },
  ] });
  const script: Script = { id: "plan1", title: "Interview", sourceKind: "youtube", sourceUrl: "https://youtu.be/aaaaaaaaaaa", originalPath: "", status: "processing", stage: "", progress: 90, error: null, durationMs: 3000, revision: 1, createdAt: 0, updatedAt: 0, words: [], clips: [], overview: [], proxyPath: null };
  script.words = transcript.words.map((one, index) => ({ id: `w-${index}`, text: one.text, startMs: Math.trunc(one.start * 1000), endMs: Math.trunc(one.end * 1000), speaker: one.speaker! }));
  return script;
}

test("the plan already at its limit: who says each line is passed over at once, and said", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-pass-over-"));
  try {
    planLimit.note("You've hit your limit · resets 11pm", Date.now());
    let asks = 0;
    captionTurns.asking.ask = (signal) => async (_kept, schema, prompt) => {
      asks++;
      return [await claude.structured("claude-opus-5-5", "", schema, prompt, signal), false];
    };
    const script = captioned();
    const began = Date.now();
    expect(await readTurns(script, dir, () => {}, undefined, true)).toBe(false);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(asks).toBe(0);
    expect(script.notes?.some((one) => one.startsWith("Who says each line waits for your Claude plan (back at"))).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the plan used up as it asks: the rest is passed over within a second, never waited out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-pass-over-"));
  try {
    captionTurns.asking.ask = (signal) => async (_kept, schema, prompt) => {
      // The first question finds the plan used up (as Claude Code says it), and asks again as askPatiently does.
      planLimit.note("You've hit your limit · resets 11pm", Date.now());
      return [await claude.structured("claude-opus-5-5", "", schema, prompt, signal), false];
    };
    const script = captioned();
    const began = Date.now();
    expect(await readTurns(script, dir, () => {}, undefined, true)).toBe(false);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(script.notes?.some((one) => one.startsWith("Who says each line waits for your Claude plan"))).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
