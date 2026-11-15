// Test projects (Oct 31 2026; by who made it since Nov 14). A project a person
// didn't start from Home's New project (one a coding agent, a script, a trial
// or the teaching loop made through the API) is marked `origin: "dev"` when
// it's made (`Store.createAs`), on every build, dev or released, and Home
// hides it, with no switch to show them (Sphe, Nov 14: "these trials and tests
// are necessary, but I shouldn't see them"). One is brought forth when asked
// for: shown on Home, still marked Test. One that became real work is
// promoted: the mark goes and it's an ordinary project. Each route works on a
// project only the cloud has too (it's brought here first), so a test project
// made on another machine or server is marked and shown the same way.
//
//   POST /api/projects/{id}/show      {ok}: a test project brought forth
//   POST /api/projects/{id}/hide      {ok}: hidden again with the rest
//   POST /api/projects/{id}/promote   {ok}: the mark cleared, a real project
//   POST /api/projects/{id}/test      {ok}: marked a test project by hand (one
//     made before the mark, or one made in the window by an agent)

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { ApiError, json } from "./http/errors.ts";
import type { RouteContext, Router } from "./http/router.ts";
import * as seams from "./seams.ts";

/** `id` here, brought from the cloud when only the cloud has it (why it couldn't be, a 409); 404 when neither has it. */
async function here(app: App, id: string): Promise<void> {
  if (app.store.get(id) === null) await seams.cloudProjects.fetch(app, id);
  if (app.store.get(id) === null) throw new ApiError(404, "no such project");
}

/** Clears `id`'s test mark: it's a real project now. */
export async function promote(app: App, id: string): Promise<void> {
  await here(app, id);
  await app.store.update(id, "promote", (project) => {
    delete project.origin;
    delete project.shown;
  });
}

/** Marks `id` a test project by hand: hidden with the rest, deleted with them. */
export async function markTest(app: App, id: string): Promise<void> {
  await here(app, id);
  await app.store.update(id, "test", (project) => {
    project.origin = "dev";
    delete project.shown;
  });
}

/** Brings test project `id` forth on Home (`shown`), or hides it again. */
export async function show(app: App, id: string, shown: boolean): Promise<void> {
  await here(app, id);
  if (app.store.get(id)?.project.origin !== "dev") throw new ApiError(409, "not a test project: it's on Home already");
  await app.store.update(id, shown ? "show" : "hide", (project) => {
    if (shown) project.shown = true;
    else delete project.shown;
  });
}

/** `{ok}` once `change` is done; what stopped it a 409 (a 404 or 409 of its own as it is). */
async function done(change: () => Promise<void>): Promise<Response> {
  try {
    await change();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, diag.messageOf(error));
  }
  return json({ ok: true });
}

export function routes(router: Router<App>): void {
  router
    .post("/api/projects/{id}/promote", ({ app, params }: RouteContext<App>) => done(() => promote(app, params.id!)))
    .post("/api/projects/{id}/test", ({ app, params }: RouteContext<App>) => done(() => markTest(app, params.id!)))
    .post("/api/projects/{id}/show", ({ app, params }: RouteContext<App>) => done(() => show(app, params.id!, true)))
    .post("/api/projects/{id}/hide", ({ app, params }: RouteContext<App>) => done(() => show(app, params.id!, false)));
}
