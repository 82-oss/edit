// @vitest-environment happy-dom
// Home's New and Changed (seen-status.ts, seen.ts): what each says from when
// the person last opened a thing and what its row carries, and nothing at all
// while the marks can't be read (an older mamagi or relay than this Edit).

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSeen, markSeen, seenKeyOf, useSeen, watchSeen } from "./seen";
import { editWork, ideaWork, MARKS_FROM, newOrChanged, scriptWork, SETTLE_MS } from "./seen-status";
import { navigate } from "./route";

const T = MARKS_FROM + 10 * 86_400_000;
const work = (over: Partial<Parameters<typeof newOrChanged>[0]> = {}) => ({ mine: true, busy: false, doneAt: T, changedAt: T, ...over });

describe("New and Changed", () => {
  it("New: your own work, done, not opened since it was done; opening it while it imported doesn't count", () => {
    expect(newOrChanged(work(), null)).toBe("new");
    expect(newOrChanged(work(), T - 60_000)).toBe("new");
    expect(newOrChanged(work(), T + 1)).toBe(null);
    // A teammate's finished work isn't yours to look at.
    expect(newOrChanged(work({ mine: false }), null)).toBe(null);
    // Not done, or done before the marks were kept.
    expect(newOrChanged(work({ doneAt: null }), null)).toBe(null);
    expect(newOrChanged(work({ doneAt: MARKS_FROM - 1, changedAt: MARKS_FROM - 1 }), null)).toBe(null);
  });

  it("Changed: something you opened, changed after you last did, by someone or something else", () => {
    const seen = T + 60_000;
    expect(newOrChanged(work({ changedAt: seen + SETTLE_MS + 1 }), seen)).toBe("changed");
    // Your own last save landing just after you left is yours.
    expect(newOrChanged(work({ changedAt: seen + 5_000 }), seen)).toBe(null);
    // Never opened: nothing changed for you (a teammate's work you've never looked at).
    expect(newOrChanged(work({ mine: false, changedAt: T + 3_600_000 }), null)).toBe(null);
    expect(newOrChanged(work({ mine: false, changedAt: seen + SETTLE_MS + 1 }), seen)).toBe("changed");
    // New wins: done and changed since, it's new to you.
    expect(newOrChanged(work({ doneAt: seen + 120_000, changedAt: seen + 120_000 }), seen)).toBe("new");
  });

  it("neither while it's still going, or while the marks can't be read", () => {
    expect(newOrChanged(work({ busy: true }), null)).toBe(null);
    expect(newOrChanged(work(), null, false)).toBe(null);
    expect(newOrChanged(work({ changedAt: T + 3_600_000 }), T, false)).toBe(null);
  });

  it("an edit: done once imported (else when started), changed here or by another computer's commit", () => {
    const id = `p${T}-abc`;
    const base = { id, mine: true, modifiedMs: T + 1000, cloud: null, status: { importing: null, working: false } };
    expect(editWork(base)).toEqual({ mine: true, busy: false, doneAt: T, changedAt: T + 1000 });
    expect(editWork({ ...base, status: { importing: null, working: false, imported_ms: T + 500 } }).doneAt).toBe(T + 500);
    expect(editWork({ ...base, status: { importing: { state: "downloading" }, working: false } })).toMatchObject({ busy: true, doneAt: null });
    expect(editWork({ ...base, status: { importing: null, working: true } }).busy).toBe(true);
    // This computer's own commit is its file's write; another's counts.
    expect(editWork({ ...base, cloud: { updated_ms: T + 9000, updated_here: true } }).changedAt).toBe(T + 1000);
    expect(editWork({ ...base, cloud: { updated_ms: T + 9000, updated_here: false } }).changedAt).toBe(T + 9000);
    // Only in the cloud.
    expect(editWork({ ...base, modifiedMs: null, status: undefined, cloud: { updated_ms: T + 9000, updated_here: false } })).toEqual({ mine: true, busy: false, doneAt: T, changedAt: T + 9000 });
  });

  it("a script: done once its first build is saved; an idea once repackaged", () => {
    expect(scriptWork({ mine: true, built: true, builtAt: T, updatedAt: T + 5, busy: false })).toEqual({ mine: true, busy: false, doneAt: T, changedAt: T + 5 });
    expect(scriptWork({ mine: true, built: false, updatedAt: T, busy: false }).doneAt).toBe(null);
    // Built before builds were stamped: never New.
    expect(scriptWork({ mine: true, built: true, updatedAt: T, busy: false }).doneAt).toBe(null);
    expect(ideaWork({ mine: true, run: "running", updatedAt: T }).busy).toBe(true);
    expect(ideaWork({ mine: true, run: "done", repackagedAt: T, updatedAt: T }).doneAt).toBe(T);
  });
});

describe("the marks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useSeen.setState({ on: false, seen: {} });
  });

  it("an older mamagi or relay: Home gets none, a mark that fails is dropped quietly", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? Promise.reject(new Error("refused")) : Response.json({ on: false, seen: {} })));
    vi.stubGlobal("fetch", fetcher);
    await loadSeen();
    expect(useSeen.getState().on).toBe(false);
    expect(() => markSeen("edit:p1")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The server down altogether: the last answer stays.
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    await expect(loadSeen()).resolves.toBeUndefined();
  });

  it("an open edit, script or idea is marked as it's opened and as it's left, and a mark made here outlives an older list", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") sent.push((JSON.parse(String(init.body)) as { key: string }).key);
      return Response.json({ on: true, seen: { "edit:p1": 5 } });
    }));
    expect(seenKeyOf("/p/p1793450000000-abc")).toBe("edit:p1793450000000-abc");
    expect(seenKeyOf("/scripts/0f3a-9")).toBe("script:0f3a-9");
    expect(seenKeyOf("/ideas/i1")).toBe("idea:i1");
    expect(seenKeyOf("/ideas")).toBe(null);
    navigate("/");
    const stop = watchSeen();
    navigate("/p/p1");
    navigate("/ideas/i1");
    navigate("/");
    stop();
    expect(sent).toEqual(["edit:p1", "edit:p1", "idea:i1", "idea:i1"]);
    await loadSeen();
    expect(useSeen.getState().on).toBe(true);
    expect(useSeen.getState().seen["edit:p1"]).toBeGreaterThan(5);
  });
});
