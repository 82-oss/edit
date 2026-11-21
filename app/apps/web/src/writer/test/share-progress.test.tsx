// @vitest-environment happy-dom
// A script's share shows its steps as the server says them, the way the
// edit's Export dialog does (Sphe, Nov 22: "I don't have a very good
// breakdown in the UI of the progress, as well as I do with the editing"):
// what is happening, one number and bar, each step with its own state; it
// carries on closed and shows where it is opened again; a stop is in words.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "../../lib/account";
import type { Script, Sharing } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

const getScript = vi.fn<(id: string) => Promise<Script>>();
const shareScript = vi.fn<(id: string) => Promise<Script>>();
vi.mock("../api", async (original) => {
  const real = await original<typeof import("../api")>();
  return {
    ...real,
    getScript: (id: string) => getScript(id),
    shareScript: (id: string) => shareScript(id),
    scriptAudit: () => Promise.resolve({ flags: [] }),
    reviewNotes: () => Promise.resolve({ notes: [], blocks: [], approved: null }),
  };
});
const { ReviewDialog } = await import("../review");

const LINK = { reviewId: "r1", token: "t", url: "https://review.test/r/1", version: 1, revision: 3, sharedAt: 1 };
const script = (extra: Partial<Script>) => ({ id: "s1", title: "A case", revision: 4, updatedAt: 1, durationMs: 37 * 60_000 + 32_000, clips: [], review: LINK, ...extra }) as unknown as Script;

/** The share as the server says it 6 minutes in: checked, the script sent, the footage at 46% with about 4 minutes left. */
const RUNNING: Sharing = {
  startedAt: 1,
  stage: "uploading the footage 46%",
  version: 2,
  progress: 0.46,
  leftS: 240,
  steps: [
    { kind: "check", state: "done", seconds: 0.4 },
    { kind: "script", state: "done", total: 2_000_000, seconds: 3 },
    { kind: "footage", state: "current", total: 1_000_000_000, done: 460_000_000, seconds: 200, leftS: 240 },
    { kind: "publish", state: "waiting" },
  ],
};

let root: Root | null = null;
beforeEach(() => {
  useAccount.setState({ account: { person: { email: "a@b.c", name: "A", image: null }, perms: [], admin: true } as never });
  getScript.mockReset();
  shareScript.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const settle = () =>
  act(async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
function show(given: Script, open = true) {
  if (root === null) {
    const container = document.createElement("div");
    container.className = "writer-root";
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(<ReviewDialog open={open} script={given} approved={null} busy={false} onClose={() => {}} onChange={() => {}} onRefresh={() => {}} />));
}
const steps = () => [...document.querySelectorAll(".share-steps li")].map((li) => `${li.getAttribute("data-state")} ${li.querySelector(".step-name")?.textContent} | ${li.querySelector(".step-right")?.textContent}`);
const buttons = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim());
const heading = () => document.querySelector("h2")?.textContent;

describe("a script's share dialog", () => {
  it("draws each step from what the server says, survives a close and reopen, and has nothing to press but Cancel and Close", async () => {
    getScript.mockResolvedValue(script({ sharing: RUNNING }));
    show(script({ sharing: RUNNING }));
    await settle();
    expect(heading()).toBe("Putting v2 on the review link");
    expect(document.querySelector(".share-big")?.textContent).toBe("46%about 4 min left");
    expect(steps()).toEqual([
      "done Its preview in the cloud | under a second",
      "done The script | 3 s",
      "current Footage for the review page · 37:32 | 46% · about 4 min",
      "waiting Publish v2 | ",
    ]);
    // Its own bar under the step under way.
    expect(document.querySelector<HTMLElement>(".share-steps li[data-state=current] .step-bar i")?.style.width).toBe("46%");
    expect(document.body.textContent).toContain("It carries on if you close this.");
    expect(buttons()).toEqual(["Cancel", "Close"]);
    // The link card and the Doc row make way while it runs.
    expect(document.querySelector(".share-card")).toBeNull();

    // Closed, then opened again later: the server has moved on, and the dialog says where it is now.
    show(script({ sharing: RUNNING }), false);
    getScript.mockResolvedValue(script({ sharing: { ...RUNNING, progress: 0.9, leftS: 30, steps: RUNNING.steps!.map((step) => (step.kind === "footage" ? { ...step, done: 900_000_000, leftS: 30 } : step)) } }));
    show(script({ sharing: RUNNING }), true);
    await settle();
    expect(document.querySelector(".share-big")?.textContent).toBe("90%about 30 s left");
    expect(steps()[2]).toBe("current Footage for the review page · 37:32 | 90% · about 30 s");
  });

  it("a step the server can't count says how long it has run, and makes up no percent", async () => {
    const publishing: Sharing = { startedAt: 1, stage: "publishing", version: 3, progress: null, leftS: null, steps: [{ kind: "script", state: "done", total: 4_000, seconds: 1 }, { kind: "publish", state: "current", seconds: 12 }] };
    getScript.mockResolvedValue(script({ sharing: publishing }));
    show(script({ sharing: publishing }));
    await settle();
    expect(document.querySelector(".share-big")).toBeNull();
    expect(steps()).toEqual(["done The script | 1 s", "current Publish v3 | 12 s"]);
  });

  it("a share that stops says where and why in words, no red, and Share again is the one way on", async () => {
    getScript.mockResolvedValue(script({ shareFailed: { error: "preview.mp4 didn't get through (the line dropped). Check the connection, then share again.", at: 5, step: "footage" } }));
    show(script({ sharing: RUNNING }));
    await settle();
    expect(document.querySelector(".share-failed")?.textContent).toBe("Sharing stopped while sending the footage.preview.mp4 didn't get through (the line dropped). Check the connection, then share again.");
    expect(document.querySelector(".bad")).toBeNull();
    expect(buttons()).toContain("Share again");
    expect(buttons()).not.toContain("Retry");
    expect(heading()).toBe("Share");
  });

  it("one that lands lists what each step took, the link beneath", async () => {
    const shared = { at: 9, version: 2, steps: [{ kind: "check" as const, state: "done" as const, seconds: 0.3 }, { kind: "script" as const, state: "done" as const, seconds: 2 }, { kind: "footage" as const, state: "done" as const, skipped: true }, { kind: "publish" as const, state: "done" as const, seconds: 1 }] };
    getScript.mockResolvedValue(script({ review: { ...LINK, version: 2 }, shared }));
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    show(script({ sharing: RUNNING }));
    await settle();
    expect(steps()).toEqual(["done Its preview in the cloud | under a second", "done The script | 2 s", "done Footage for the review page · 37:32 | already there", "done Publish v2 | 1 s"]);
    expect(document.body.textContent).toContain("Up on the link");
    expect(document.querySelector(".share-card")).not.toBeNull();
  });
});
