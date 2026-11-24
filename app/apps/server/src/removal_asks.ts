// What someone asked to have taken out of a project's footage (Sphe, Nov 17:
// "remove watermarks only when we ask"): a part the channel's lesson says
// runs only when asked (removal_lesson.ts `when: "asked"`) does nothing at all
// (no file looked at, nothing done) until the agent's start_removal says what
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
import * as removalHeld from "./removal_held.ts";
import * as removal from "./removal_lesson.ts";

export type Spans = [number, number][];
/** Their watermark marked where it sits: a file's source seconds [from, to) and its box there (shares of the file's picture). */
export type BoxMark = [number, number, [number, number, number, number]];

export interface Ask {
  at: number;
  kinds: removal.Kind[];
  /** "all": the whole project, as it grows; else each footage file's source seconds, or "all" it shows. */
  media: "all" | Record<string, Spans | "all">;
  /**
   * The agent's in and out points (start_removal `marks`, `unmark`): the stretches of footage it looked at and found
   * their text in, for a channel taught to take it out. Only marked seconds get the tracked blur there.
   */
  mark?: "add" | "remove";
  /** With a mark: their watermark's box over each file's marked seconds (start_removal `marks` with `box`). */
  boxes?: Record<string, BoxMark[]>;
}

const fileOf = (home: string) => join(home, "removal-asks.json");
const stopFileOf = (home: string) => join(home, "removal-stopped.json");
const partsFileOf = (home: string) => join(home, "removal-parts-stopped.json");
type PartsStopped = Record<string, Partial<Record<removal.Kind, number>>>;
let kept: { home: string; asks: Record<string, Ask[]>; stopped: Record<string, number>; parts: PartsStopped } | null = null;

function read<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function loaded(home: string): NonNullable<typeof kept> {
  if (kept?.home !== home) {
    kept = { home, asks: read<Record<string, Ask[]>>(fileOf(home)) ?? {}, stopped: read<Record<string, number>>(stopFileOf(home)) ?? {}, parts: read<PartsStopped>(partsFileOf(home)) ?? {} };
  }
  return kept;
}

const all = (home: string) => loaded(home).asks;

function keep(file: string, value: unknown): void {
  try {
    writeAtomic(file, JSON.stringify(value));
  } catch (error) {
    diag.warn("removal", `keeping what was asked: ${diag.messageOf(error)}`);
  }
}

/**
 * Whether the person stopped project `id`'s removal (the chat's Stop): what
 * runs by itself doesn't any more, and what was asked before it is done
 * with; an ask after it runs on just what it names (Sphe, Nov 17: stop the
 * whole video, then clean only the intro and the first case's start), the
 * agent's marks too (Nov 19: marks made after a Stop did nothing). An edit
 * moved onto a channel says the same of itself, on every computer
 * (`Project.removal_held`, Nov 21): nothing by itself, what's asked for runs.
 */
export function isStopped(home: string, id: string): boolean {
  return loaded(home).stopped[id] !== undefined || removalHeld.held(home, id);
}

/** The asks that count: those since the person's Stop, if any. */
export function liveAsks(home: string, id: string): Ask[] {
  const stopped = loaded(home).stopped[id];
  return asksOf(home, id).filter((ask) => stopped === undefined || ask.at > stopped);
}

/** The chat's Stop, kept across restarts; `false`: going again (an ask). */
export function setStopped(home: string, id: string, stopped: boolean): void {
  const state = loaded(home).stopped;
  if (stopped) state[id] = Date.now();
  else if (state[id] === undefined) return;
  else delete state[id];
  keep(stopFileOf(home), state);
}

/**
 * One part of project `id`'s removal stopped, the rest going on (Nov 24, the Trooper edit: once its watermark removal
 * had started nothing could stop just that, and the whole Stop took the cleaning of their captions with it): that part
 * no longer runs by itself, and what was asked of it before is done with; an ask of it after runs what it names.
 */
export function stopParts(home: string, id: string, kinds: removal.Kind[]): void {
  const state = loaded(home).parts;
  const now = Date.now();
  state[id] = { ...state[id], ...Object.fromEntries(kinds.map((kind) => [kind, now])) };
  keep(partsFileOf(home), state);
}

/** When part `kind` of project `id` was stopped alone, if it was. */
const partStoppedAt = (home: string, id: string, kind: removal.Kind): number | undefined => loaded(home).parts[id]?.[kind];

/** Whether part `kind` of project `id` was stopped alone (it doesn't run by itself there). */
export function isPartStopped(home: string, id: string, kind: removal.Kind): boolean {
  return partStoppedAt(home, id, kind) !== undefined;
}

/** Whether `ask` still counts for part `kind`: made after that part was stopped alone, if it was. */
const liveFor = (home: string, id: string, kind: removal.Kind, ask: Ask): boolean => ask.at > (partStoppedAt(home, id, kind) ?? 0);

/** What's been asked for in project `id`. */
export function asksOf(home: string, id: string): Ask[] {
  return all(home)[id] ?? [];
}

/** Keeps an ask for project `id`. */
export function add(home: string, id: string, ask: Ask): void {
  const asks = all(home);
  asks[id] = [...(asks[id] ?? []), ask].slice(-50);
  keep(fileOf(home), asks);
}

/**
 * Whether `ask` asks for what it names: an ask does; the agent's marks say
 * where their text is, not that it's asked for, but marks made after the
 * person's Stop are the agent starting those seconds again (Nov 19).
 */
const asking = (home: string, id: string, ask: Ask, kind?: removal.Kind): boolean =>
  ask.mark === undefined || (ask.mark === "add" && (isStopped(home, id) || (kind !== undefined && isPartStopped(home, id, kind))));

/** The parts asked for in project `id`. */
export function askedKinds(home: string, id: string): removal.Kind[] {
  return removal.KINDS.filter((kind) => liveAsks(home, id).some((ask) => asking(home, id, ask, kind) && ask.kinds.includes(kind) && liveFor(home, id, kind, ask)));
}

/** The footage files named in what was asked since the Stop (not the whole project). */
export function pointedAt(home: string, id: string): Set<string> {
  const out = new Set<string>();
  for (const ask of liveAsks(home, id)) if (asking(home, id, ask) && ask.media !== "all") for (const media of Object.keys(ask.media)) out.add(media);
  return out;
}

/** The lesson as it applies to project `id` now: the parts running by themselves (unless stopped), and those asked for. */
export function inForce(lesson: removal.Lesson | null, home: string, id: string): removal.Lesson | null {
  const running = isStopped(home, id) || lesson === null ? null : removal.only(lesson, removal.KINDS.filter((kind) => !isPartStopped(home, id, kind)));
  return removal.inForce(running, askedKinds(home, id), lesson);
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
 * itself, else only what was asked for or marked (after a Stop, the seconds
 * the agent marked since).
 */
export function scope(lesson: removal.Lesson | null, home: string, id: string, kind: removal.Kind, media: string, shown: Spans): Spans {
  if (lesson?.remove[kind] === true && lesson.when[kind] === "automatic" && !isStopped(home, id) && !isPartStopped(home, id, kind)) return shown;
  const out: Spans = [];
  for (const ask of liveAsks(home, id)) {
    if (!asking(home, id, ask, kind) || !ask.kinds.includes(kind) || !liveFor(home, id, kind, ask)) continue;
    const given = ask.media === "all" ? "all" : ask.media[media];
    if (given === undefined) continue;
    out.push(...(given === "all" ? shown : intersect(shown, given)));
  }
  return merged(out);
}

function minus(spans: Spans, holes: Spans): Spans {
  let out = merged(spans);
  for (const [a, b] of holes) out = out.flatMap(([x, y]): Spans => (b <= x || a >= y ? [[x, y]] : ([[x, Math.min(y, a)], [Math.max(x, b), y]] as Spans).filter(([p, q]) => q > p)));
  return out;
}

/** Whether the agent took every stretch detection proposes (start_removal `marks: "proposed"`) in project `id`. */
export function marksProposed(home: string, id: string): boolean {
  return asksOf(home, id).some((ask) => ask.mark === "add" && ask.media === "all");
}

/**
 * The source seconds of each footage file the agent marked in project `id`
 * (its marks in order, an unmark taking its seconds back out); a mark of
 * everything proposed takes `proposed`'s seconds (detection's, by file).
 * `grow` widens the marks (text_removal: to the shots they're in); seconds
 * unmarked and not marked again stay out of them.
 */
export function marked(home: string, id: string, proposed: Map<string, Spans> = new Map(), grow: (media: string, spans: Spans) => Spans = (_media, spans) => spans): Map<string, Spans> {
  // The person's Stop doesn't undo them: they say where their text is, not what runs (asks' `scope` says that).
  const out = new Map<string, Spans>();
  const unmarked = new Map<string, Spans>();
  for (const ask of asksOf(home, id)) {
    if (ask.mark === undefined) continue;
    if (ask.media === "all") {
      if (ask.mark === "add") for (const [media, spans] of proposed) out.set(media, merged([...(out.get(media) ?? []), ...spans]));
      continue;
    }
    for (const [media, given] of Object.entries(ask.media)) {
      if (given === "all") continue;
      const was = out.get(media) ?? [];
      out.set(media, ask.mark === "add" ? merged([...was, ...given]) : minus(was, given));
      if (ask.mark === "remove") unmarked.set(media, merged([...(unmarked.get(media) ?? []), ...given]));
    }
  }
  for (const [media, spans] of out) out.set(media, minus(grow(media, spans), minus(unmarked.get(media) ?? [], spans)));
  return out;
}

/** Their watermark's boxes the agent marked in project `id`, by file (an unmark takes its seconds back out of them too). */
export function markedBoxes(home: string, id: string): Map<string, BoxMark[]> {
  const out = new Map<string, BoxMark[]>();
  for (const ask of asksOf(home, id)) {
    if (ask.mark === "add") for (const [media, boxes] of Object.entries(ask.boxes ?? {})) out.set(media, [...(out.get(media) ?? []), ...boxes]);
    if (ask.mark !== "remove" || ask.media === "all") continue;
    for (const [media, given] of Object.entries(ask.media)) {
      const was = out.get(media);
      if (was === undefined) continue;
      if (given === "all") out.delete(media);
      else out.set(media, was.flatMap(([from, to, box]) => minus([[from, to]], given).map(([a, b]): BoxMark => [a, b, box])));
    }
  }
  return out;
}

/** For tests: nothing remembered here (the file stays). */
export function reset(): void {
  kept = null;
}
