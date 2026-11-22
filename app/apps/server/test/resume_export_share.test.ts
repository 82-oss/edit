// A share's export cut short by a restart, from a build before shares were jobs: carried on as a share now
// (serve.ts `resumeExport`), with what the export said of itself.

import { expect, spyOn, test } from "bun:test";

import * as jobs from "../src/jobs.ts";
import * as reviews from "../src/reviews.ts";
import { resumeExport } from "../src/serve.ts";
import { fixtureHome } from "./helpers/home.ts";

test("a share carried on from an older build keeps \"Exported as the edit is now\" when its timeline couldn't be read", async () => {
  const { app, store, cleanup } = fixtureHome("resume-export-share");
  const resumed = spyOn(reviews, "resumeShare").mockResolvedValue(undefined);
  try {
    const id = store.create("Carried", { width: 64, height: 36, fps: 30 }).project.id;
    // Its kept timeline is gone: no snapshot to read.
    const job = { key: jobs.keyOf("export", id), kind: "export", project: id, args: { options: { format: "h264" }, output: "/x/carried.mp4", share: true, note: "the fix of note 3", snapshot: "/nowhere/snapshot.json" }, state: "running", attempts: 0, started_ms: 1, updated_ms: 1 } as unknown as jobs.Job;
    await resumeExport(app, job, (one) => store.get(one)!.project);
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(resumed.mock.calls[0]![4]).toMatchObject({ note: "the fix of note 3 · Exported as the edit is now: the timeline it was started with couldn't be read after the restart." });
  } finally {
    resumed.mockRestore();
    cleanup();
  }
});
