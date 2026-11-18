// What each person has opened, and when (Sphe, Nov 18): Home's New (done
// since you last opened it) and Changed (changed since, by someone or
// something else). The person's own across their computers, kept in mamagi
// (`edit:listSeen`, `edit:markSeen`, through the relay, which names whose
// marks they are from their token); the web marks an edit, a script or an idea
// as it's opened and again as it's left (lib/seen.ts).
//
// An older mamagi or relay without them (a nightly out before they're
// deployed) is never an error: Home then shows neither, a mark goes nowhere,
// and the log says so once.
//
//   GET  /api/seen              {on, seen: {key: at}}: on false when they can't be read (signed out, or not there yet)
//   POST /api/seen {key, at?}   {ok}: marked (at: when, else now)

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";

const KEY = /^(edit|script|idea):[A-Za-z0-9_-]{1,120}$/;

export const isKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key);

export interface Seen {
  /** Whether the marks could be read: false signed out, or with a mamagi or relay that doesn't have them yet. */
  on: boolean;
  /** When they last opened each, by key. */
  seen: Record<string, number>;
}

const OFF: Seen = { on: false, seen: {} };

/** Whether a failure was logged since the marks last worked: said once, not every poll. */
let warned = false;

function failed(doing: string, error: unknown): void {
  if (warned) return;
  warned = true;
  diag.warn("seen", `seen: ${doing}: ${diag.messageOf(error)} (Home shows no New or Changed until it answers)`);
}

/** The signed-in person's marks; OFF when they can't be read. */
export async function list(): Promise<Seen> {
  if (!cloud.enabled()) return OFF;
  try {
    const rows = await cloud.query("edit:listSeen", {});
    const seen: Record<string, number> = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const { key, at } = (row ?? {}) as { key?: unknown; at?: unknown };
      if (isKey(key) && typeof at === "number") seen[key] = at;
    }
    warned = false;
    return { on: true, seen };
  } catch (error) {
    failed("listing", error);
    return OFF;
  }
}

/** Marks `key` seen by the signed-in person at `at` (now, when not given); whether it was. */
export async function mark(key: string, at?: number): Promise<boolean> {
  if (!cloud.enabled()) return false;
  try {
    await cloud.mutation("edit:markSeen", at === undefined ? { key } : { key, at });
    warned = false;
    return true;
  } catch (error) {
    failed(`marking ${key}`, error);
    return false;
  }
}

export function routes(router: Router<App>): void {
  router
    .get("/api/seen", async () => json(await list()))
    .post("/api/seen", async (context: RouteContext<App>) => {
      const body = await readJson<{ key?: unknown; at?: unknown }>(context);
      if (!isKey(body.key)) throw bad("key is edit:, script: or idea: and an id.");
      const at = typeof body.at === "number" && Number.isFinite(body.at) ? body.at : undefined;
      return json({ ok: await mark(body.key, at) });
    });
}
