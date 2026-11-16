// A question waiting for the Claude plan's reset says so as its run's stage
// (Nov 16 audit: Ideas, Thumbnails and Script builds waited silently, up to two
// resets), and gives the stage back once the wait is over.

import { afterEach, expect, test } from "bun:test";

import * as planLimit from "../../src/plan_limit.ts";
import { ask, sayingWaits, waitingLine, type Question } from "../../src/writer/claude.ts";

afterEach(() => planLimit.reset());

const question = (signal: AbortSignal, extra: Partial<Question> = {}): Question => ({ model: "claude-opus-5-5", system: "", prompt: "", label: "test", signal, ...extra });

test("a question waiting for the plan's reset tells its run, then gives the stage back", async () => {
  planLimit.note("You've hit your 5-hour limit");
  const until = planLimit.until()!;
  expect(waitingLine(until)).toMatch(/^Waiting for your Claude plan \(back at .+\)$/);
  const told: (string | null)[] = [];
  const stop = new AbortController();
  const asked = ask(question(stop.signal, { waiting: (line) => void told.push(line) }));
  await Bun.sleep(20);
  expect(told).toEqual([waitingLine(until)]);
  stop.abort();
  await expect(asked).rejects.toThrow("Stopped by you");
  expect(told).toEqual([waitingLine(until), null]);
});

test("a run's questions made deep inside it (a Script build's) tell the wait set around the run", async () => {
  planLimit.note("You've hit your 5-hour limit");
  const told: (string | null)[] = [];
  const stop = new AbortController();
  const asked = sayingWaits((line) => void told.push(line), () => ask(question(stop.signal)));
  await Bun.sleep(20);
  expect(told[0]).toStartWith("Waiting for your Claude plan");
  stop.abort();
  await expect(asked).rejects.toThrow("Stopped by you");
  expect(told.at(-1)).toBeNull();
});
