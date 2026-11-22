import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const window = vi.hoisted(() => ({ full: false, refuse: false, calls: [] as boolean[] }));
vi.mock("./nativePreview", () => ({
  nativePreview: {
    fullscreen: vi.fn(async (on: boolean) => { window.calls.push(on); if (window.refuse) throw new Error("not allowed"); window.full = on; }),
    isFullscreen: vi.fn(async () => window.full),
  },
}));
vi.mock("./diagnostics", () => ({ note: vi.fn() }));

describe("Edit.app's window full screen", () => {
  let fs: typeof import("./windowFullscreen").windowFullscreen;
  let classes: Set<string>;
  beforeEach(async () => {
    vi.resetModules();
    Object.assign(window, { full: false, refuse: false, calls: [] });
    classes = new Set();
    vi.stubGlobal("document", { documentElement: { classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) } } });
    ({ windowFullscreen: fs } = await import("./windowFullscreen"));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("puts the window itself in full screen with the viewer filling it, so the window's player goes on drawing, and back", async () => {
    const heard = vi.fn();
    fs.subscribe(heard);
    await fs.set(true);
    expect(window.calls).toEqual([true]);
    expect(fs.get()).toBe(true);
    expect(classes.has("viewer-full")).toBe(true);
    expect(heard).toHaveBeenCalled();
    await fs.set(false);
    expect(window.calls).toEqual([true, false]);
    expect(classes.has("viewer-full")).toBe(false);
  });

  it("comes back with the window when it leaves full screen by itself, but not while its animation runs", async () => {
    vi.useFakeTimers();
    await fs.set(true);
    window.full = false;
    await fs.check();
    expect(fs.get()).toBe(true);
    vi.advanceTimersByTime(2000);
    await fs.check();
    expect(fs.get()).toBe(false);
    expect(classes.has("viewer-full")).toBe(false);
  });

  it("stays out when the window refuses, and says so in the log", async () => {
    window.refuse = true;
    await fs.set(true);
    expect(fs.get()).toBe(false);
    expect(classes.has("viewer-full")).toBe(false);
  });
});
