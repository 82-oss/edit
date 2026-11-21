// @vitest-environment happy-dom
// An idea's "Write the script": New project opens on the idea's channel. Nov 21 (docs/v1-to-v2.md, step 1): it was
// handed only the title, footage and kind, and an idea made for a channel became a script with none.
import { describe, expect, it } from "vitest";

import type { Idea } from "../lib/ideas";
import { scriptStart } from "./page";

const idea = (given: Partial<Idea> = {}): Idea =>
  ({
    id: "i1", workspace: "bodycam", sources: [{ kind: "youtube", url: "https://youtu.be/abc123" }], steer: "", wantsSummary: false, niche: null,
    titles: [{ text: "Suspect Chase" }], main: "Suspect Chase", thumbnailGuide: "", guideBy: "claude", base: null, images: [], summary: "", footage: [], notes: "",
    status: "ready", skipped: null, duplicate: null, card: null, changes: null, run: null, chat: [], createdAt: 0, createdBy: "", updatedAt: 0,
    ...given,
  }) as unknown as Idea;

describe("Write the script from an idea", () => {
  it("opens New project on the idea's channel", () => {
    expect(scriptStart(idea({ channel: "ch-ted" }))).toEqual({ title: "Suspect Chase", text: "https://youtu.be/abc123", style: "bodycam", channel: "ch-ted" });
  });

  it("an idea with no channel opens on none, as before", () => {
    expect(scriptStart(idea())).toEqual({ title: "Suspect Chase", text: "https://youtu.be/abc123", style: "bodycam" });
  });
});
