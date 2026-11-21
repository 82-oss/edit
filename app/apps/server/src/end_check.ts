// The add-on `end-check`, "Check when a turn ends" (Sphe, Nov 21: "at the end
// of its turn the add-on runs in the background … it picks up a change was
// made and checks then informs the agent before the turn is done"). Off on
// every channel and every V1 project until a channel sets it.
//
// When an Edit V2 turn the person started ends having changed the edit, Edit
// runs the edit's audit (edit_tools.ts `audited`: every check that runs after
// each change here, the house's and the channel's add-ons') over the whole
// edit, waits (a minute at most) for its checks to read the files the turn
// put on the timeline, and keeps what's wrong where the turn changed it (`scopedAudit`, as each plan's own answer
// is scoped to that plan): the fixable kinds only (`FIXABLE`, what the team
// would catch and an agent can fix). Meanwhile its line is the chat's waiting
// row (background.ts), the same as removal's.
//
//   - Nothing found: the line goes, and nothing is said to anyone ("very
//     smart", of showing nothing on a clean result).
//   - Something found: the agent is started again with it, as Edit's own
//     event, the prompt never in the chat, live, after a reload or on another
//     computer (Sphe: "I do not want to see a prompt that has been sent to
//     the agents on the chat … it just triggers the agent, and then the
//     agents will respond"). Its turn's only entry of its own is Edit's
//     event mark (`EDIT_EVENT`, shown as no message at all, agent.ts `by`);
//     what it was told goes as the turn's context, which the model reads and
//     the chat never keeps (agent.ts `send`'s `context`). Its answer says
//     what it fixed: no other UI for that ("only this UI").
//
// One check per turn the person started: the woken turn, removal's and any
// other Edit starts are never checked, so a fix never loops. A turn that
// starts while a check runs (a message of the person's, a queued one) drops
// it: theirs goes first, and its end checks again from the earliest turn not
// yet checked. Stop ends it and wakes nobody. A restart forgets it: nothing
// is carried on or said.

import * as addons from "./addons.ts";
import type { App } from "./app.ts";
import * as background from "./background.ts";
import * as diag from "./diag.ts";
import { EDIT_EVENT } from "./edit_event.ts";
import { audited, changedSpan, clipSpans, FIXABLE, scopedAudit } from "./edit_tools.ts";
import type { Project } from "./model.ts";
import { fps as fpsOf } from "./project.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";
import * as thread from "./thread.ts";

export const NAME = "end-check";

/** How often the audit is read again while its checks read files; how long that's waited on before what's read answers. */
export const timing = { readEveryMs: 5_000, readsWithinMs: 60_000, sleep: (ms: number): Promise<void> => Bun.sleep(ms) };

/** The most of what was found the agent is told, a line each; the rest are counted (review_edit lists every one). */
const MOST_TOLD = 40;

interface Check {
  startedAt: number;
  /** Files read of those its checks were waiting on. */
  done: number;
  total: number;
}

/** The project as it was when the earliest turn not yet checked began. */
const began = new Map<string, { rev: number; project: Project }>();
/** The check under way, by project. */
const checks = new Map<string, Check>();

/** Its line under the chat while it runs. */
function lineOf(_app: App, id: string): background.Line | null {
  const check = checks.get(id);
  return check === undefined ? null : { label: "Checking the edit", done: check.done, total: check.total, started_at: check.startedAt, unit: "files read" };
}

/** The person's Stop: the check ends where it is, nobody is woken, and what the turns did isn't checked later. */
export function stop(_app: App, id: string): void {
  if (checks.delete(id)) diag.info("end check", `${id}: stopped by the person`);
  began.delete(id);
}

background.provide(NAME, { line: lineOf, stop });

/**
 * What's wrong where the edit changed since `from`, as the audit gives it (fixable kinds only), and how many of the
 * files the turn's changed clips play its checks are still reading (pictures, censors): until read, it says nothing of
 * them. Files only elsewhere on the timeline aren't waited for: what's said is only of where the turn worked.
 */
export function found(app: App, from: Project, live: { rev: number; project: Project }): { issues: Record<string, unknown>[]; reading: number } {
  thread.note(`end check: the audit of ${live.project.id}`);
  const audit = audited(app, live.project, live.rev);
  const [before, after] = [clipSpans(from), clipSpans(live.project)];
  const scoped = scopedAudit(audit, changedSpan(before, after), fpsOf(live.project));
  const issues = (scoped.issues as Record<string, unknown>[]).filter((issue) => FIXABLE.includes(String(issue.kind)));
  const touched = new Set(
    live.project.clips.flatMap((clip) => {
      if (before.get(clip.id)?.[2] === after.get(clip.id)?.[2] || !("media" in clip)) return [];
      const media = live.project.media.find((one) => one.id === clip.media);
      return media === undefined ? [] : [media.name, media.id];
    }),
  );
  const names = (value: unknown) => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && touched.has(one)) : []);
  return { issues, reading: new Set([...names(audit.picture_check_pending), ...names(audit.censor_check_pending)]).size };
}

/** What a check reads of the edit (a test holds it while files are read). */
export const hooks = { found };

/** What the woken turn reads after Edit's event mark (never shown): what was found, and what to do. */
export function wakeText(issues: readonly Record<string, unknown>[]): string {
  const told = issues.slice(0, MOST_TOLD).map((issue) => `- ${stableStringify(issue)}`);
  const more = issues.length - told.length;
  return (
    ` Your turn has ended, and Edit ran the edit's checks again where it changed (this channel's "${addons.CATALOGUE[NAME].title}" add-on). These are still wrong there, as the audit gives them (its frames; review_edit gives the same):\n` +
    `${told.join("\n")}${more > 0 ? `\n- and ${more} more there (review_edit lists them)` : ""}\n\n` +
    "Fix each one now, as its fix says or the next best way; leave one only when it can't be done in this video. " +
    "The person didn't see this message, only your work: when you're done, tell them in a line or two what you changed and why (what was wrong, and where in the video), or in a line why you left one."
  );
}

/** A turn of the project's starts: a check under way gives way to it, and the project as it is now is kept, unless an earlier turn's is. */
function turnStarts(app: App, id: string): void {
  if (checks.delete(id)) diag.info("end check", `${id}: a turn started, so the check waits for its end`);
  if (began.has(id)) return;
  const live = app.store.get(id);
  // Kept for every V2 turn, whether or not the add-on reads as on yet (one set in this very turn runs at its end): only
  // a reference to the version already there, let go when the turn ends.
  if (live === null || live.project.hq !== true) return;
  began.set(id, { rev: live.rev, project: live.project });
}

/** A turn of the project's ended: its check starts when the person started it, the add-on is on and the edit changed. */
function turnEnds(app: App, id: string): void {
  const from = began.get(id);
  const live = app.store.get(id);
  if (from === undefined || live === null || live.project.hq !== true || !addons.has(live.project, NAME)) {
    began.delete(id);
    return;
  }
  const panel = seams.agentPanel(app);
  const turn = panel.turn?.(id);
  if (turn?.running === true) return;
  const entries = (turn?.entries ?? []) as readonly { kind?: string; by?: string; status?: string }[];
  // Edit's own turn (this check's wake, removal's): only a turn the person started is checked, so a fix never loops.
  if (entries.findLast((one) => one.kind === "user")?.by === "edit") return;
  // Stopped or failed: nothing more is asked of it now; the next turn's end checks what this one did too.
  const last = entries.at(-1);
  if (last?.kind === "error" && last.status !== "done") return;
  // A message queued behind it goes now: its end checks both.
  if (((panel as { withChat?: (id: string) => { queue: readonly unknown[] } }).withChat?.(id).queue.length ?? 0) > 0) return;
  if (live.rev === from.rev) {
    began.delete(id);
    return;
  }
  void run(app, id, from.project);
}

async function run(app: App, id: string, from: Project): Promise<void> {
  const check: Check = { startedAt: Date.now(), done: 0, total: 0 };
  checks.set(id, check);
  const on = () => checks.get(id) === check;
  try {
    const until = Date.now() + timing.readsWithinMs;
    let result: ReturnType<typeof found> | null = null;
    for (;;) {
      // Out of the turn's own end first (the status event this runs in), and its line served before the audit runs.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const live = app.store.get(id);
      if (live === null || !on()) return;
      result = hooks.found(app, from, live);
      check.total = Math.max(check.total, check.done + result.reading);
      check.done = check.total - result.reading;
      if (result.reading === 0 || Date.now() >= until) break;
      await timing.sleep(timing.readEveryMs);
      if (!on()) return;
    }
    if (!on() || result === null) return;
    checks.delete(id);
    if (result.issues.length === 0) {
      began.delete(id);
      diag.info("end check", `${id}: nothing wrong where the turn changed the edit`);
      return;
    }
    const panel = seams.agentPanel(app);
    const running = () => panel.turn?.(id).running === true;
    // A turn started as it finished (a message of the person's): theirs goes first, and its end checks again.
    if (running()) return;
    await app.store.mayWrite(id);
    if (running()) return;
    // Let go only now: the woken turn's start keeps the edit as it is then, and is never checked itself.
    began.delete(id);
    const kinds = [...new Set(result.issues.map((issue) => String(issue.kind)))].join(", ");
    diag.info("end check", `${id}: ${result.issues.length} wrong where the turn changed the edit (${kinds}); the agent is told`);
    await panel.send(id, EDIT_EVENT, null, null, wakeText(result.issues));
  } catch (error) {
    if (on()) checks.delete(id);
    diag.warn("end check", `${id}: ${diag.messageOf(error)}`);
  }
}

/** Checks each Edit V2 turn the person started, on a channel with the add-on on, as it ends. */
export function start(app: App): void {
  app.store.subscribe((event) => {
    if (event.type !== "agent" || event.event !== "status" || typeof event.project !== "string") return;
    // A sub-agent's chat (`<id>~review`, V1's fresh-eyes pass) is never one.
    if (event.project.includes("~")) return;
    if (event.running === true) turnStarts(app, event.project);
    else if (event.running === false) turnEnds(app, event.project);
  });
}

/** For tests. */
export function reset(): void {
  began.clear();
  checks.clear();
}
