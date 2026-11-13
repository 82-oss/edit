import { beforeEach, describe, expect, it, vi } from "vitest";

describe("the player's volume", () => {
  beforeEach(() => {
    vi.resetModules();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
  });

  it("mutes and comes back where it was, never at nothing, and is kept", async () => {
    const { gainOf, setLevel, toggleMute, useVolume } = await import("./volume");
    expect(useVolume.getState()).toEqual({ level: 1, muted: false });
    setLevel(0.5);
    expect(gainOf(useVolume.getState())).toBeCloseTo(0.25);
    toggleMute();
    expect(gainOf(useVolume.getState())).toBe(0);
    toggleMute();
    expect(useVolume.getState()).toEqual({ level: 0.5, muted: false });
    setLevel(0);
    expect(useVolume.getState().muted).toBe(true);
    toggleMute();
    expect(useVolume.getState()).toEqual({ level: 0.5, muted: false });
    vi.resetModules();
    expect((await import("./volume")).useVolume.getState()).toEqual({ level: 0.5, muted: false });
  });
});
