import { describe, expect, it } from "vitest";

import { importProgress, timeOfDay } from "./import_progress";
import type { ScriptJob } from "./types";

describe("a script import's lines", () => {
  it("waiting by itself says the server's words, with nothing to press", () => {
    const job: ScriptJob = {
      state: "waiting",
      error: "The transcription plan is out of credit: 1 of 2 footage files wait for it; Edit tries again at 14:30.",
      files: [
        { file: "a", bytes: 10, total: 10, state: "done" },
        { file: "b", bytes: 5, total: 10, state: "waiting", why: "quota", retry_at: 1 },
      ],
    };
    expect(importProgress(job).line).toBe(job.error);
  });

  it("a YouTube file waiting out YouTube turning Edit away says when it goes again, and a file tried again by itself says when", () => {
    const at = new Date(2026, 10, 16, 14, 5).getTime();
    const parked: ScriptJob = { state: "downloading", files: [{ file: "youtube:abcdefghijk", bytes: 0, state: "downloading", retry_at: at }, { file: "b", bytes: 10, total: 10, state: "done" }] };
    expect(importProgress(parked, at - 60_000).line).toBe(`YouTube turned Edit away · trying again at ${timeOfDay(at)}`);
    const again: ScriptJob = { state: "downloading", files: [{ file: "a", bytes: 0, state: "failed", why: "passing", retry_at: at }, { file: "b", bytes: 10, total: 10, state: "done" }] };
    expect(importProgress(again, at - 60_000).line).toBe(`Trying a file again at ${timeOfDay(at)}`);
    // While another file still comes down, the import says that.
    const busy: ScriptJob = { state: "downloading", files: [{ file: "a", bytes: 0, state: "failed", why: "passing", retry_at: at }, { file: "b", bytes: 5, total: 10, state: "downloading" }] };
    expect(importProgress(busy).line).toBe("Downloading footage · file 1 of 2");
  });

  it("a dropped connection waits by itself, said as a try again with its time, never as the person's", () => {
    const at = new Date(2026, 10, 18, 22, 11).getTime();
    const job: ScriptJob = {
      state: "waiting",
      error: "Trying a file again at 22:11",
      retry_at: at,
      files: [
        { file: "a", bytes: 10, total: 10, state: "done" },
        { file: "b", bytes: 0, state: "waiting", why: "passing", retry_at: at, error: "could not reach Edit's relay: The socket connection was closed unexpectedly." },
      ],
    };
    expect(importProgress(job, at - 60_000).line).toBe(`Trying a file again at ${timeOfDay(at)}`);
  });

  it("waiting on the person still asks for them", () => {
    const job: ScriptJob = { state: "waiting", files: [{ file: "a", bytes: 0, state: "failed", why: "person", error: "This Drive file isn't shared." }] };
    expect(importProgress(job).line).toBe("One file can’t be downloaded");
  });

  it("a time to try again at that has passed reads now, never an hour gone (Nov 20)", () => {
    const at = new Date(2026, 10, 20, 14, 30).getTime();
    const waiting: ScriptJob = { state: "waiting", retry_at: at, files: [{ file: "a", bytes: 0, state: "waiting", why: "passing", retry_at: at }] };
    expect(importProgress(waiting, at - 60_000).line).toBe(`Trying a file again at ${timeOfDay(at)}`);
    expect(importProgress(waiting, at + 60 * 60_000).line).toBe("Trying a file again now");
    const parked: ScriptJob = { state: "downloading", files: [{ file: "youtube:abcdefghijk", bytes: 0, state: "downloading", retry_at: at }] };
    expect(importProgress(parked, at + 1).line).toBe("YouTube turned Edit away · trying again now");
    const again: ScriptJob = { state: "downloading", files: [{ file: "a", bytes: 0, state: "failed", why: "passing", retry_at: at }, { file: "b", bytes: 10, total: 10, state: "done" }] };
    expect(importProgress(again, at).line).toBe("Trying a file again now");
  });

  it("downloading with nothing moved for five minutes says since when, not Downloading footage for good (Nov 20)", () => {
    const moved = new Date(2026, 10, 20, 14, 2).getTime();
    const job = { state: "downloading", moved_ms: moved, files: [{ file: "a", bytes: 5, total: 10, state: "downloading" }] } as ScriptJob & { moved_ms: number };
    expect(importProgress(job, moved + 60_000).line).toBe("Downloading footage");
    expect(importProgress(job, moved + 5 * 60_000).line).toBe(`Nothing has come in since ${timeOfDay(moved)} · Edit keeps trying by itself`);
  });
});
