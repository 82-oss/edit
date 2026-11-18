// Home's Done (Oct 31 2026): what someone marked done by hand, the team's, in
// mamagi's editLater (`edit:listLater`, `setLater`, `clearLater`, through the
// relay, which names who did it from their token), by key: an edit, a
// script, an idea or a board card. Later's setting aside went on Nov 18
// (Sphe); a row still set aside from before is left out, so it shows in its
// list again, and the next mark or move back replaces it.
//
//   GET  /api/later                     {entries}: what's marked done
//   POST /api/later {key, done: true}   marked done (in Done until moved back)
//   POST /api/later {key, back: true}   moved back out of Done

import type { LaterEntry, LaterKey } from "@edit/types/later";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { ApiError, bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";

const KEY = /^(edit|script|idea|card):[A-Za-z0-9_-]{1,120}$/;

export const isKey = (key: unknown): key is LaterKey => typeof key === "string" && KEY.test(key);

/** What's marked done. */
export async function list(): Promise<LaterEntry[]> {
  if (!cloud.enabled()) return [];
  const rows = await cloud.query("edit:listLater", {});
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown): LaterEntry[] => {
    if (typeof row !== "object" || row === null) return [];
    const { key, at, by, done } = row as Record<string, unknown>;
    if (!isKey(key) || typeof at !== "number" || done !== true) return [];
    const who = typeof by === "object" && by !== null ? (by as Record<string, unknown>) : null;
    return [{ key, until: null, done: true, at, by: who && typeof who.name === "string" ? { sub: String(who.sub ?? ""), name: who.name, picture: typeof who.picture === "string" ? who.picture : null } : null }];
  });
}

/** Marks `key` done: in Done until someone moves it back. */
export async function markDone(key: LaterKey): Promise<void> {
  await cloud.mutation("edit:setLater", { key, done: true });
}

/** Moves `key` back out of Done. */
export async function moveBack(key: LaterKey): Promise<void> {
  await cloud.mutation("edit:clearLater", { key });
}

export function routes(router: Router<App>): void {
  router
    .get("/api/later", async () => {
      try {
        return json({ entries: await list() });
      } catch (error) {
        diag.warn("later", `done: list: ${error instanceof Error ? error.message : String(error)}`);
        throw new ApiError(502, `Done didn't load: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
    .post("/api/later", async (context: RouteContext<App>) => {
      if (!cloud.enabled()) throw new ApiError(409, "Sign in to mark things done: Done is the team's, kept in the cloud.");
      const body = await readJson<{ key?: unknown; back?: unknown; done?: unknown }>(context);
      if (!isKey(body.key)) throw bad("key is edit:, script:, idea: or card: and an id.");
      if (body.back !== true && body.done !== true) throw bad("say done: true, or back: true.");
      try {
        if (body.back === true) await moveBack(body.key);
        else await markDone(body.key);
      } catch (error) {
        diag.warn("later", `done: ${body.back === true ? "move back" : "mark done"} ${body.key}: ${error instanceof Error ? error.message : String(error)}`);
        throw new ApiError(502, `Done didn't take it: ${error instanceof Error ? error.message : String(error)}`);
      }
      return json(body.back === true ? { key: body.key, back: true } : { key: body.key, done: true });
    });
}
