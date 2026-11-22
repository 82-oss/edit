// Work under way on a project in the background, for the line at the foot of
// its chat (web RemovalRow.tsx): a dashed ring, "Waiting · <what> · 12 of 25
// pieces · 18m 04s", Stop, a thin line of how far. It was removal's alone
// (removal_schedule.ts); since Nov 21 anything that runs on after the agent's
// turn registers here instead of drawing a row of its own (Sphe, of the
// end-of-turn check: "similar again to the UI of the subtitles removal thing
// … I like this UI and only this UI").
//
// Each kind registers once, as its module loads: how to read its line for a
// project (null when nothing of it is under way) and how the person's Stop
// ends it. Both lines at once are each shown, the older first: each is real
// work with its own Stop, and a line that hid another would hide what Stop
// stops.

import type { App } from "./app.ts";
import { ApiError, json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";

/** One line: what, how far (`total` 0: nothing to count, so no count and no bar), since when. */
export interface Line {
  label: string;
  done: number;
  total: number;
  started_at: number;
  /** What's counted ("pieces" when not said). */
  unit?: string;
}

interface Kind {
  line: (app: App, id: string) => Line | null;
  stop: (app: App, id: string) => void;
  /** Whether it's under way for the project or still to start the agent's turn on what it did (its line gone meanwhile). */
  underWay: (id: string) => boolean;
}

const kinds = new Map<string, Kind>();

/** A kind of background work: its line for a project, and its Stop. Registered again under the same key, the newer wins. */
export function provide(key: string, kind: Kind): void {
  kinds.set(key, kind);
}

/**
 * Whether anything is under way for the project that may still start the agent again: the person is told their
 * changes are done only after it (agent.ts `settled`; the M1 trial, Nov 22: told before the check had finished).
 */
export function underWay(id: string): boolean {
  for (const kind of kinds.values()) if (kind.underWay(id)) return true;
  return false;
}

/** The project's lines under way, the older first, each with its kind's key (its Stop's address). */
export function linesOf(app: App, id: string): (Line & { key: string })[] {
  const out: (Line & { key: string })[] = [];
  for (const [key, kind] of kinds) {
    const line = kind.line(app, id);
    if (line !== null) out.push({ key, ...line });
  }
  return out.sort((a, b) => a.started_at - b.started_at);
}

export function routes(router: Router<App>): void {
  router.get("/api/projects/{id}/background", ({ app, params }) => {
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    return json({ lines: linesOf(app, id) });
  });
  router.post("/api/projects/{id}/background/{key}/stop", ({ app, params }) => {
    const id = params.id ?? "";
    if (app.store.get(id) === null) throw new ApiError(404, "no such project");
    const kind = kinds.get(params.key ?? "");
    if (kind === undefined) throw new ApiError(404, "nothing of that kind runs in the background");
    kind.stop(app, id);
    return json({ lines: linesOf(app, id) });
  });
}
