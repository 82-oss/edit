// Ideas, started with the server: a run this Mac had going when Edit stopped
// is carried on (serve.ts's resumer, `resumeRun`) when Edit is back soon.
// Before Edit restarts itself, its runs stop without an ending, to be carried
// on after it. Changes made here that the cloud hasn't got yet go up behind
// (cloud.ts, team_docs.ts).

import type { App } from "../app.ts";
import type * as jobs from "../jobs.ts";
import * as update from "../update.ts";
import * as cloud from "./cloud.ts";
import { prepareRestart, resumeRun as resumeOne } from "./run.ts";

export function start(app: App): void {
  // Each idea kept here as well as in the cloud (team_docs.ts): what a restart left unsent goes up now.
  cloud.useHome(app.store.home ?? null);
  // Registered before serve.ts's own, which stops every program Edit started (Claude Code among them) after it.
  update.onPrepare(() => prepareRestart());
}

/** A run a restart cut short: carried on, its ending saved, or marked stopped (serve.ts's resumer for `idea`). */
export function resumeRun(app: App, job: jobs.Job): Promise<void> {
  return resumeOne({ home: app.store.home, port: app.port }, job);
}
