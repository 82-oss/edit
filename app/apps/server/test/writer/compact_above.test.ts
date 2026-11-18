import { expect, test } from "bun:test";

import { compactAbove } from "../../src/writer/claude.ts";

test("a usual script question keeps Claude Code's 180k compaction", () => {
  expect(compactAbove({ prompt: "x".repeat(200_000), system: "s" })).toEqual({});
});

test("a long case's prompt compacts only past itself and room to work, at most the whole window", () => {
  // ~320k tokens of transcript (26 h of talk): compacting at 180k would summarise the words away.
  const big = compactAbove({ prompt: "x".repeat(1_120_000), system: "" });
  expect(Number(big.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW)).toBe(470_000);
  expect(big.env?.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe("900000");
  const huge = compactAbove({ prompt: "x".repeat(5_000_000), system: "" });
  expect(Number(huge.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW)).toBe(1_000_000);
});
