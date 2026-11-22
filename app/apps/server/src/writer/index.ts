// Script mode (Writer, merged into Edit on Oct 29 2026): starting it with the
// server. Every start carries on the imports and Claude's jobs that died with
// the server (an update, a crash), and before Edit restarts itself the jobs
// are stopped where they are, to carry on after it.
//
// Where Script mode lives: this folder is the server (routes.ts is its whole
// HTTP API under /api/writer/, each route checked by can.ts; store.ts keeps
// scripts at <home>/writer/scripts/<id>/script.json beside their files);
// apps/web/src/writer/ is the page (script-mode.tsx); packages/edit-types/
// src/writer.ts the shared types; agent/writer/ the script guides; test/
// writer/ its tests. Its cloud is Edit's relay (/v1/cloud/writer/*,
// apps/relay/src/writer_cloud.ts) over Convex `writer:*` and R2
// `writer/scripts/<id>/`. The sign-in, Claude, hearing, YouTube, Drive, logs
// and updates are Edit's own. An edit made from a script and the script
// follow each other through ../script_sync.ts.


import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import * as durable from "../jobs.ts";
import * as paid from "../paid.ts";
import * as update from "../update.ts";
import * as scriptSync from "../script_sync.ts";
import * as archive from "./archive.ts";
import * as build from "./build.ts";
import * as cloud from "./cloud.ts";
import { readSettings } from "../cloud_projects.ts";
import * as machine from "../machine.ts";
import { holderFor } from "../sync_core.ts";
import * as reviews from "./reviews.ts";
import * as drive from "./drive.ts";
import * as handoff from "./handoff.ts";
import { join } from "../paths.ts";
import * as jobs from "./jobs.ts";
import * as missing from "./missing.ts";
import * as storage from "./storage.ts";
import * as store from "./store.ts";
import * as streamed from "./streamed.ts";

/** Background work Script mode's parts start with the server (the cloud, review polling…). */
export const starters: ((app: App) => void)[] = [];

export function start(app: App, options: { trials?: boolean } = {}): void {
  const data = store.dataDir(app.store.home);
  drive.hooks.accessToken = () => app.library.accessToken();
  build.usePort(app.port);
  // Every save names a Drive folder case's master in Edit's originals, so Start the edit finds it on any Mac;
  // scripts saved before that (Nov 4) are named once now, before anything else writes them.
  store.hooks.withSharedKeys = handoff.withSharedKeys;
  handoff.stampAll(data);
  // And a master named while it went up whose upload a restart or a failed try came between: named once it's up.
  void handoff.settlePending(data);
  // Claude's jobs are written down in Edit's job table, so a restart carries them on (work.ts), and stopped where they are before Edit restarts itself.
  jobs.useHome(app.store.home);
  holdBeforeRestart();
  // A trial server (EDIT_TRIALS=1) writes and builds scripts as any Edit does, but takes
  // none of the team's work: no review notes fixed, no archives
  // acted on (Oct 31: with Script mode off there, a script's builds called the tools on :7700
  // and its Drive reads had no token).
  if (options.trials === true) {
    adoptCutImports(app.store.home, data);
    for (const id of store.ids(data)) jobs.markInterrupted(data, id);
    streamed.start(app);
    missing.start(app, data);
    cloud.start(data, holderFor(app.store.home, readSettings(app.store.home).holder ?? machine.name()));
    storage.start(data, join(app.store.home, "projects"), app.store.cacheDir());
    scriptSync.start(app);
    return;
  }
  adoptCutImports(app.store.home, data);
  for (const id of store.ids(data)) jobs.markInterrupted(data, id);
  // Originals an import kept here going up behind it (streamed.ts), carried on.
  streamed.start(app);
  // Footage that didn't come in, tried again by itself (and imports an older Edit paused on it, carried on).
  missing.start(app, data);
  cloud.start(data, holderFor(app.store.home, readSettings(app.store.home).holder ?? machine.name()));
  reviews.start(app, data);
  // Idle scripts' footage left to the cloud as room runs short.
  storage.start(data, join(app.store.home, "projects"), app.store.cacheDir());
  // Each script and the edit made from it kept in step.
  scriptSync.start(app);
  // Archives and restores heard from the cloud, acted on every 20 s.
  setInterval(() => archive.react(app, data), 20_000);
  for (const begin of starters) {
    try {
      begin(app);
    } catch (error) {
      diag.warn("writer", diag.messageOf(error));
    }
  }
}

/** How long paid requests in flight get to be answered before the jobs are stopped for a restart (serve.ts waits as long). */
const PAID_WAIT_MS = 120_000;

let holding = false;

/**
 * Before Edit restarts itself (an update, remote support's restart): once the
 * paid requests in flight are answered and kept, Claude's jobs on scripts are
 * stopped where they are, each left running in the job table and on its
 * script, so the next run carries it on (work.ts) and none says it failed.
 * Runs before serve.ts's own preparing, which stops the imports and every
 * program Edit started.
 */
function holdBeforeRestart(): void {
  if (holding) return;
  holding = true;
  update.onPrepare(async () => {
    await paid.settle(PAID_WAIT_MS);
    const held = await jobs.holdForRestart();
    if (held.length > 0) diag.info("update", `stopped Claude on ${held.length} script(s) before restarting: they carry on after it`);
  });
}

/**
 * Imports a restart or an update cut off carry on from the job table, as any long work does (honest council change
 * 7c, Nov 19): each has its row there from its start to "ready", and the table's one resumer (serve.ts `script`)
 * starts it again once the sign-in is back. One an older build left importing with no row of its own is given one
 * now, so it's carried on the same way. The timer that did this in memory (`carryOn`, its own tries and waits) is gone.
 */
export function adoptCutImports(home: string, data: string): void {
  for (const id of store.ids(data)) {
    let importing = false;
    try {
      importing = store.read(store.scriptDir(data, id)).status === "processing";
    } catch {
      continue;
    }
    if (!importing) continue;
    const key = durable.keyOf("script", id);
    const listed = durable.get(home, key);
    if (listed !== undefined && durable.live(listed)) continue;
    durable.begin(home, "script", id, { waiting_on: "import" }, "", "importing");
    diag.info("writer", `${id}: an import a restart cut off, carried on from the job table`);
  }
}

