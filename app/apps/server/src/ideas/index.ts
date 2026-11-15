// Ideas, started with the server: a run this Mac had going when Edit stopped
// is carried on (serve.ts's resumer, `resumeRun`) when Edit is back soon.
// Before Edit restarts itself, its runs stop without an ending, to be carried
// on after it. Nothing else runs in the background.

import type { App } from "../app.ts";
import type * as jobs from "../jobs.ts";
import * as update from "../update.ts";
import { prepareRestart, resumeRun as resumeOne } from "./run.ts";

export function start(_app: App): void {
  // Registered before serve.ts's own, which stops every program Edit started (Claude Code among them) after it.
  update.onPrepare(() => prepareRestart());
}

/** A run a restart cut short: carried on, its ending saved, or marked stopped (serve.ts's resumer for `idea`). */
export function resumeRun(app: App, job: jobs.Job): Promise<void> {
  return resumeOne({ home: app.store.home, port: app.port }, job);
}
