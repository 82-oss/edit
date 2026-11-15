// Thumbnails, started with the server: a turn this Mac had going when Edit
// stopped is carried on (serve.ts's resumer, `resumeRun`) when Edit is back
// soon. Before Edit restarts itself, its turns stop without an ending, to be
// carried on after it.

import type { App } from "../app.ts";
import * as openart from "./openart.ts";
import type * as jobs from "../jobs.ts";
import * as update from "../update.ts";
import { contextOf } from "./routes.ts";
import { prepareRestart, resumeRun as resumeOne } from "./run.ts";

export function start(app: App): void {
  openart.useHome(app.store.home);
  // Registered before serve.ts's own, which stops every program Edit started (Claude Code among them) after it.
  update.onPrepare(() => prepareRestart());
}

/** A run a restart cut short: carried on, its ending saved, or marked stopped (serve.ts's resumer for `thumbnail`); who holds it and who asked are its job's. */
export function resumeRun(app: App, job: jobs.Job): Promise<void> {
  return resumeOne(contextOf(app), job);
}
