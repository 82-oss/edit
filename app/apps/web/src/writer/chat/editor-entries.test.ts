import { describe, expect, it } from "vitest";

import type { ChatTurn } from "../types";
import { scriptEntries } from "./editor-entries";

describe("scriptEntries", () => {
  it("shapes a script conversation as the editor chat's entries", () => {
    const chat: ChatTurn[] = [
      { role: "producer", text: "Tighten the intro", at: 1000 },
      {
        role: "editor",
        text: "Done. Shorter now.",
        at: 2000,
        workedMs: 90_000,
        trace: [{ at: 0, calls: [{ id: "c1", tool: "read_transcript", label: "Read the transcript", state: "done" }] }],
      },
      { role: "editor", text: "Reset the script?", at: 3000, reset: "pending" },
    ];
    const entries = scriptEntries(chat);
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool", "assistant"]);
    expect(entries[1]).toMatchObject({ tool: "read_transcript", text: "Read the transcript", status: "done", updated: 92_000 });
    expect(entries[2]).toMatchObject({ text: "Done. Shorter now." });
  });

  it("keeps a failed turn's tools beside its error", () => {
    const chat: ChatTurn[] = [
      {
        role: "editor",
        text: "The build stopped",
        at: 5000,
        failed: true,
        trace: [{ at: 0, calls: [{ id: "c1", tool: "build_script", label: "", state: "error" }] }],
      },
    ];
    const entries = scriptEntries(chat);
    expect(entries.map((entry) => entry.kind)).toEqual(["tool", "error"]);
    expect(entries[0]).toMatchObject({ status: "failed" });
  });

  it("shows the live turn's reasoning, words and tools in the order they happened, stamped when it was sent (Sphe, Nov 18: the thinking showed late)", () => {
    const parts = [
      { kind: "thinking" as const, text: "The intro should open on the call.", active: false },
      { kind: "tools" as const, calls: [{ id: "c1", tool: "add_section", label: "Writing the intro", state: "done" as const }] },
      { kind: "text" as const, text: "Here's the opening." },
      { kind: "thinking" as const, text: "Now the body", active: true },
    ];
    const entries = scriptEntries([], { text: "Here's the opening.", trace: [], parts }, "Build the script.", 1_000);
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "thinking", "tool", "assistant", "thinking"]);
    expect(entries.every((entry) => entry.at === 1_000)).toBe(true);
    expect(entries.at(-1)).toMatchObject({ kind: "thinking", status: "running" });
  });
});
