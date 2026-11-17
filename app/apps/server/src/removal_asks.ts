// What someone asked to have taken out of a project's footage (Sphe, Nov 17:
// "remove watermarks only when we ask"): a part the channel's lesson says
// runs only when asked (removal_lesson.ts `when: "asked"`) does nothing at all
// (no file looked at, nothing sent) until the agent's start_removal says what
// the person pointed to: the whole project (as it grows), some footage files
// (what the timeline shows of them), or seconds of them. A part not taught at
// all can be asked for too: the person asked.
//
// Asks are kept per project in `<home>/removal-asks.json`, so a restart picks
// the work up again; the workers read them through `scope` and `inForce`.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";
import * as removal from "./removal_lesson.ts";

export type Spans = [number, number][];

export interface Ask {
  at: number;
  kinds: removal.Kind[];
  /** "all": the whole project, as it grows; else each footage file's source seconds, or "all" it shows. */
  media: "all" | Record<string, Spans | "all">;
}

const fileOf = (home: string) => join(home, "removal-asks.json");
let kept: { home: string; asks: Record<string, Ask[]> } | null = null;

function all(home: string): Record<string, Ask[]> {
  if (kept?.home === home) return kept.asks;
  let asks: Record<string, Ask[]> = {};
  try {
    asks = JSON.parse(fs.readFileSync(fileOf(home), "utf8")) as Record<string, Ask[]>;
  } catch {
    /* None asked yet. */
  }
  kept = { home, asks };
  return asks;
}

/** What's been asked for in project `id`. */
export function asksOf(home: string, id: string): Ask[] {
  return all(home)[id] ?? [];
}

/** Keeps an ask for project `id`. */
export function add(home: string, id: string, ask: Ask): void {
  const asks = all(home);
  asks[id] = [...(asks[id] ?? []), ask].slice(-50);
  try {
    writeAtomic(fileOf(home), JSON.stringify(asks));
  } catch (error) {
    diag.warn("removal", `keeping what was asked: ${diag.messageOf(error)}`);
  }
}

/** The parts asked for in project `id`. */
export function askedKinds(home: string, id: string): removal.Kind[] {
  return removal.KINDS.filter((kind) => asksOf(home, id).some((ask) => ask.kinds.includes(kind)));
}

/** The lesson as it applies to project `id` now: the parts running by themselves, and those asked for. */
export function inForce(lesson: removal.Lesson | null, home: string, id: string): removal.Lesson | null {
  return removal.inForce(lesson, askedKinds(home, id));
}

const intersect = (a: Spans, b: Spans): Spans => a.flatMap(([x, y]) => b.flatMap(([u, v]): Spans => (Math.min(y, v) > Math.max(x, u) ? [[Math.max(x, u), Math.min(y, v)]] : [])));

function merged(spans: Spans): Spans {
  const out: Spans = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The seconds of footage file `media` that part `kind` covers, of `shown`
 * (what the timeline shows of it): all of them for a part taught to run by
 * itself, else only what was asked for.
 */
export function scope(lesson: removal.Lesson | null, home: string, id: string, kind: removal.Kind, media: string, shown: Spans): Spans {
  if (lesson?.remove[kind] === true && lesson.when[kind] === "automatic") return shown;
  const out: Spans = [];
  for (const ask of asksOf(home, id)) {
    if (!ask.kinds.includes(kind)) continue;
    const given = ask.media === "all" ? "all" : ask.media[media];
    if (given === undefined) continue;
    out.push(...(given === "all" ? shown : intersect(shown, given)));
  }
  return merged(out);
}

/** For tests: nothing remembered here (the file stays). */
export function reset(): void {
  kept = null;
}
