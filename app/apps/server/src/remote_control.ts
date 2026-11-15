// Full remote control of a teammate's Edit (Sphe, Nov 15: "WHATEVER the issue
// someone has is, we're able to figure it out, fix it for them or update
// instantly… we need to have FULL remote control"). An admin's request comes
// as a `run` command (remote_support.ts; mamagi's editSupport:requestRun,
// admins only), its JSON carried out here:
//
//   ask      a read-only question, with no length limit (remote_ask.ts)
//   call     any of Edit's own API routes, as this Mac (cancel an export, change a setting, …)
//   agent    a message to a project's agent, shown in their chat as the admin's
//   sh       a shell command on the Mac, for what's outside Edit (time-limited, its output scrubbed)
//   help     a dialog over the whole window: who's working on their Edit, why, each step as it goes,
//            through restarts, until "help-end" (or three hours)
//   say      a line on their screen
//   restart  now, whatever runs: everything carries on after it (busy.wouldLose is empty
//            since Nov 10), but what's `hold`-ed (agents, exports, imports, or job kinds)
//   update   the newest build now, the same way
//   hold / release   work kept from starting again, and let go (jobs.ts `held`)
//   open     the window brought to the front
//
// Whatever changes something is said on their screen (the help dialog's steps,
// or a notice outside one), so nothing is done to their Edit unseen. Answers go
// up beside the problem reports, which only an admin reads.

import * as fs from "node:fs";
import * as os from "node:os";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import * as jobs from "./jobs.ts";
import { join } from "./paths.ts";
import { sendAnswer, respondTo } from "./remote_ask.ts";
import { restartSelf } from "./update.ts";
import * as windowFocus from "./window_focus.ts";

/** What an admin asks, as the run's JSON. */
export type Request =
  | { do: "ask"; question: string }
  | { do: "call"; method?: string; path: string; body?: unknown }
  | { do: "agent"; project: string; prompt: string }
  | { do: "sh"; command: string; seconds?: number }
  | { do: "help"; message?: string }
  | { do: "help-end"; message?: string }
  | { do: "say"; message: string }
  | { do: "restart"; hold?: string[] }
  | { do: "update"; hold?: string[] }
  | { do: "hold"; what: string[] }
  | { do: "release" }
  | { do: "open" };

/** The work an admin holds back by name, as the job table's kinds. */
export const GROUPS: Record<string, jobs.Kind[]> = {
  agents: ["turn", "fix", "idea", "thumbnail", "writer"],
  exports: ["export", "archive", "share", "full"],
  imports: ["case", "drive", "footage", "script", "upload"],
};

const ALL_KINDS: jobs.Kind[] = ["export", "archive", "drive", "smooth", "watch", "upload", "map", "case", "full", "share", "fix", "turn", "idea", "thumbnail", "playback", "script", "footage", "writer"];

/** "agents,exports" or job kinds → the kinds; anything else is refused by name. */
export function kindsOf(names: readonly string[]): jobs.Kind[] {
  const out = new Set<jobs.Kind>();
  for (const raw of names.flatMap((one) => one.split(",")).map((one) => one.trim().toLowerCase()).filter(Boolean)) {
    if (raw === "all") for (const kind of ALL_KINDS) out.add(kind);
    else if (GROUPS[raw] !== undefined) for (const kind of GROUPS[raw]) out.add(kind);
    else if ((ALL_KINDS as string[]).includes(raw)) out.add(raw as jobs.Kind);
    else throw new Error(`"${raw}" isn't work Edit can hold: agents, exports, imports, all, or a job kind (${ALL_KINDS.join(", ")})`);
  }
  return [...out];
}

// ---------------------------------------------------------------- the help dialog

export interface Help {
  /** Who is working on their Edit. */
  by: string;
  /** Why, in the admin's words. */
  message: string;
  started: number;
  /** What's been done, as it's done. */
  steps: { at: number; text: string }[];
  /** How it ended, for the moment it's shown before going (help-end). */
  ended?: { at: number; message: string };
}

/** A help dialog nobody ended goes after this long. */
const HELP_MS = 3 * 3600_000;
/** An ended one stays this long, so its last words are read. */
const ENDED_MS = 8_000;

const helpPath = (home: string) => join(home, "remote-help.json");

export function helpNow(home: string, now = Date.now()): Help | null {
  try {
    const help = JSON.parse(fs.readFileSync(helpPath(home), "utf8")) as Help;
    if (now - help.started > HELP_MS || (help.ended !== undefined && now - help.ended.at > ENDED_MS)) {
      fs.rmSync(helpPath(home), { force: true });
      return null;
    }
    return help;
  } catch {
    return null;
  }
}

function setHelp(app: App, help: Help | null): void {
  if (help === null) fs.rmSync(helpPath(app.store.home), { force: true });
  else fs.writeFileSync(helpPath(app.store.home), JSON.stringify(help));
  app.store.emit({ type: "remote-help", help });
}

/** A step said on their screen: in the help dialog when one is up, else as a notice. */
function tell(app: App, by: string, text: string): void {
  const help = helpNow(app.store.home);
  if (help !== null && help.ended === undefined) {
    setHelp(app, { ...help, steps: [...help.steps, { at: Date.now(), text }].slice(-30) });
    return;
  }
  app.store.emit({ type: "remote-say", by, text });
}

// ---------------------------------------------------------------- carrying out

/** The longest a shell command may take. */
const SH_MAX_S = 600;
/** What's kept of a command's or a call's output. */
const OUTPUT_MAX = 1_000_000;

/** Carries out `payload` (a run's JSON) for `by` (the admin's name); the outcome's words. */
export async function run(app: App, payload: string, by: string): Promise<string> {
  const began = performance.now();
  let request: Request;
  try {
    request = JSON.parse(payload) as Request;
  } catch {
    throw new Error("The request isn't JSON.");
  }
  if (request === null || typeof request !== "object" || typeof request.do !== "string") throw new Error("The request says nothing to do.");
  const who = by.trim() || "An admin";
  diag.info("remote", `${who} asked: ${request.do}`);
  switch (request.do) {
    case "ask":
      return sendAnswer(app, request.question, await respondTo(app, String(request.question ?? "help")), began);
    case "call": {
      const method = (request.method ?? "GET").toUpperCase();
      if (typeof request.path !== "string" || !request.path.startsWith("/api/")) throw new Error("A call is to one of Edit's routes: /api/…");
      if (method !== "GET") tell(app, who, `${who} changed something in Edit (${method} ${request.path.split("?")[0]})`);
      const answer = await fetch(`http://127.0.0.1:${app.port}${request.path}`, {
        method,
        headers: request.body === undefined ? {} : { "content-type": "application/json" },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(120_000),
      });
      const text = (await answer.text()).slice(0, OUTPUT_MAX);
      return sendAnswer(app, `${method} ${request.path}`, `HTTP ${answer.status}\n\n${text}`, began);
    }
    case "agent": {
      if (typeof request.project !== "string" || typeof request.prompt !== "string" || request.prompt.trim() === "") throw new Error("agent needs a project and what to say.");
      const live = app.store.get(request.project);
      if (live === null) throw new Error(`There's no project ${request.project} on this Mac.`);
      tell(app, who, `${who} asked the agent on "${live.project.name}" for something`);
      // Said as theirs in the chat, so the person (and the agent) see whose it is.
      const text = `${who} (from afar): ${request.prompt.trim()}`;
      const answer = await fetch(`http://127.0.0.1:${app.port}/api/projects/${encodeURIComponent(request.project)}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!answer.ok) throw new Error(`The agent didn't take it: HTTP ${answer.status} ${(await answer.text()).slice(0, 300)}`);
      return `Sent to the agent on "${live.project.name}". Read its answer with: ask project ${request.project}`;
    }
    case "sh":
      return sendAnswer(app, `sh: ${request.command}`, await shell(String(request.command ?? ""), request.seconds), began);
    case "help": {
      const help: Help = { by: who, message: (request.message ?? "").trim().slice(0, 600), started: Date.now(), steps: [] };
      setHelp(app, help);
      windowFocus.focus();
      return `The help dialog is up on ${app.machine}.`;
    }
    case "help-end": {
      const help = helpNow(app.store.home);
      if (help === null) return "There was no help dialog up.";
      setHelp(app, { ...help, ended: { at: Date.now(), message: (request.message ?? "").trim().slice(0, 600) || "All done. You can carry on." } });
      setTimeout(() => setHelp(app, null), ENDED_MS).unref?.();
      return "The help dialog is closing.";
    }
    case "say": {
      if (typeof request.message !== "string" || request.message.trim() === "") throw new Error("say needs something to say.");
      tell(app, who, request.message.trim().slice(0, 600));
      return "Said.";
    }
    case "hold": {
      const kinds = jobs.hold(app.store.home, kindsOf(request.what ?? []));
      return `Held from starting again: ${kinds.join(", ") || "nothing"}. Running work isn't stopped: restart with hold to stop it, release to let it go.`;
    }
    case "release": {
      const kinds = await jobs.release(app.store.home);
      if (kinds.length > 0) tell(app, who, `${who} let your work carry on`);
      return kinds.length === 0 ? "Nothing was held." : `Released and started again: ${kinds.join(", ")}.`;
    }
    case "restart": {
      const held = request.hold && request.hold.length > 0 ? jobs.hold(app.store.home, kindsOf(request.hold)) : jobs.held(app.store.home);
      tell(app, who, `${who} is restarting Edit: it's back in a few seconds${held.length > 0 ? "" : ", and everything carries on"}`);
      setTimeout(() => void restartSelf(), 3_000).unref?.();
      return `Restarting in 3 s.${held.length > 0 ? ` Held (release starts them): ${held.join(", ")}.` : " Everything carries on after it."}`;
    }
    case "update": {
      const status = (await app.updater.status()) as { enabled?: boolean; latest?: string | null; phase?: string };
      if (!status.enabled) throw new Error("This build can't update itself.");
      if (!status.latest) throw new Error("There's no newer build.");
      if (status.phase !== "idle") throw new Error(`An update is under way already (${status.phase}).`);
      const held = request.hold && request.hold.length > 0 ? jobs.hold(app.store.home, kindsOf(request.hold)) : jobs.held(app.store.home);
      tell(app, who, `${who} is updating Edit to ${status.latest}: it restarts by itself${held.length > 0 ? "" : ", and everything carries on"}`);
      // After the outcome has gone back: the install ends in a restart.
      setTimeout(() => {
        void app.updater.install(() => true).catch((error: unknown) => {
          diag.error("remote", `the update an admin asked for failed: ${diag.messageOf(error)}`);
          tell(app, who, `The update didn't go through: ${diag.messageOf(error)}`);
        });
      }, 2_000).unref?.();
      return `Updating to ${status.latest}.${held.length > 0 ? ` Held (release starts them): ${held.join(", ")}.` : ""} devices shows the build once it's back.`;
    }
    case "open":
      windowFocus.focus();
      return windowFocus.attached() ? "Brought to the front." : "No window is open to bring forward (Edit's server runs without one).";
    default:
      throw new Error(`"${(request as { do: string }).do}" isn't something this build does (it may be older: update it first).`);
  }
}

/** A shell command on this Mac, as the person: its output and exit, stopped after `seconds` (60 by default). */
export async function shell(command: string, seconds = 60): Promise<string> {
  if (command.trim() === "") throw new Error("sh needs a command.");
  const limit = Math.min(SH_MAX_S, Math.max(1, Math.round(seconds)));
  const program = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const child = Bun.spawn([program, "-lc", command], { cwd: os.homedir(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, limit * 1000);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  const parts = [`exit ${timedOut ? `(stopped after ${limit} s)` : code}`];
  if (out !== "") parts.push(`stdout:\n${out.slice(-OUTPUT_MAX)}`);
  if (err !== "") parts.push(`stderr:\n${err.slice(-OUTPUT_MAX / 4)}`);
  return parts.join("\n\n");
}

export function routes(router: Router<App>): void {
  // The help dialog as it stands, for a page that opens while one is up (then it hears "remote-help").
  router.get("/api/remote-help", ({ app }) => json({ help: helpNow(app.store.home) }));
}
