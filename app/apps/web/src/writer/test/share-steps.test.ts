import { describe, expect, it } from "vitest";

import { nowWords, stepName, stepRight } from "../share-steps";

// Nov 22: a script shared while its preview still went up was refused; the share waits for it now as its first step.
describe("a share waiting for its preview to go up", () => {
  it("says so as its first step and on its row, with how long it has waited", () => {
    const waiting = { kind: "check" as const, state: "current" as const, waits: true, seconds: 42 };
    expect(stepName(waiting)).toBe("Its preview going up to the cloud");
    expect(stepRight(waiting)).toBe("42 s");
    expect(nowWords({ startedAt: 1, stage: "waiting for its preview to go up", steps: [waiting, { kind: "publish", state: "waiting" }] })).toBe("Waiting for its preview to go up");
    // A check that didn't wait reads as before.
    expect(stepName({ kind: "check", state: "done", seconds: 0.4 })).toBe("Its preview in the cloud");
    expect(nowWords({ startedAt: 1, steps: [{ kind: "check", state: "current" }] })).toBe("Checking its preview");
  });
});
