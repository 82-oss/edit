// Starting the server: the log, FFmpeg, the store and the
// addon, the data folder's lock, the hosts it answers to, the App with every
// package's services, the speaker watcher, cloud projects, Ctrl-C, and one
// listener per address `bindAddresses` gives.

import { TIMING } from "./sync_core.ts";
import * as writerLocks from "./writer/locks.ts";
import type { Server } from "bun";
import * as fs from "node:fs";

import * as accounts from "./accounts.ts";
import { keepAwakeWhile } from "./awake.ts";
import { resumeImport } from "./drive_import.ts";
import { createApp, hostname, type App } from "./app.ts";
import { pauseForExports, setListening, smoothsFast } from "./broll.ts";
import { makeRoomAsync, startCleaning } from "./cache_cleanup.ts";
import * as cloud from "./cloud.ts";
import { setSmoothByDefault } from "./cutin.ts";
import * as diag from "./diag.ts";
import * as folderAccess from "./folder_access.ts";
import { savedExportFolder } from "./export_folder.ts";
import * as modelChoice from "./model_choice.ts";
import * as lastRun from "./last_run.ts";
import * as logShip from "./log_ship.ts";
import { agentHooks } from "./agent.ts";
import * as scriptSync from "./script_sync.ts";
import { registerEditingTools, unfinishedNote } from "./edit_tools.ts";
import { archiveGoing, archiveJob, dropLeftSnapshot, ExportRegistry, room as exportRoom, resumeSnapshot, type ExportRecord, type StartExtra } from "./exports.ts";
import * as encoder from "./encoder.ts";
import * as jobs from "./jobs.ts";
import * as missingMediaTries from "./missing_media.ts";
import * as outages from "./outages.ts";
import * as relay from "./relay.ts";
import * as storage from "./storage.ts";
import * as wake from "./wake.ts";
import type { ExportOptions } from "./model.ts";
import { listen } from "./http/server.ts";
import { registerEffectTools } from "./effect_tools.ts";
import { registerChannelTools } from "./channel_tools.ts";
import * as changes from "./changes.ts";
import * as busy from "./busy.ts";
import * as effects from "./effects.ts";
import { prepareShell } from "./chrome_devtools.ts";
import { messageContext, registerMediaTools } from "./media_tools.ts";
import { allowedHosts } from "./http/host.ts";
import { encodersListed, initNative, native } from "./native/index.ts";
import { join } from "./paths.ts";
import * as archive from "./archive.ts";
import * as firstPrompt from "./first_prompt.ts";
import * as researchCloud from "./research_cloud.ts";
import * as playbackRender from "./playback_render.ts";
import * as endCheck from "./end_check.ts";
import * as hqEars from "./hq_ears.ts";
import * as houseWordsPass from "./house_words_pass.ts";
import * as agentSessions from "./agent_sessions.ts";
import * as effectCloud from "./effect_cloud.ts";
import * as exportAhead from "./export_ahead.ts";
import * as removalSchedule from "./removal_schedule.ts";
import * as remoteAsk from "./remote_ask.ts";
import * as reviews from "./reviews.ts";
import * as retryAfterUpdate from "./retry_after_update.ts";
import { warm as warmRife } from "./rife.ts";
import { buildRouter, carryOnAsked } from "./routes.ts";
import * as seams from "./seams.ts";
import { Store } from "./store.ts";
import * as tools from "./tools.ts";
import * as update from "./update.ts";
import * as paidWork from "./paid.ts";
import { windowPid } from "./window.ts";
import * as exactAfter from "./writer/exact_after.ts";
import * as writer from "./writer/index.ts";
import * as writerImports from "./writer/imports.ts";
import * as writerMissing from "./writer/missing.ts";
import * as writerStore from "./writer/store.ts";
import * as ideas from "./ideas/index.ts";
import * as thumbnails from "./thumbnails/index.ts";
import * as oldCopies from "./old_copies.ts";
import { BUILD, NIGHTLY, RELEASE } from "./version.ts";
import { transcriptWords } from "./sound_room.ts";

/** A place to listen: an IP and port, as Rust's SocketAddr shows it ("127.0.0.1:7700", "[::1]:7700"). */
export interface Address {
  ip: string;
  port: number;
  v6: boolean;
}

export function showAddress(address: Address): string {
  return address.v6 ? `[${address.ip}]:${address.port}` : `${address.ip}:${address.port}`;
}

/** `text` as Rust parses a SocketAddr: `a.b.c.d:port` or `[v6]:port`; null otherwise (a host name, say). */
export function parseSocketAddr(text: string): Address | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(text);
  if (v4 !== null) {
    const parts = v4.slice(1, 5).map(Number);
    const port = Number(v4[5]);
    if (parts.some((part, index) => part > 255 || (v4[index + 1]!.length > 1 && v4[index + 1]!.startsWith("0")))) {
      return null;
    }
    if (port > 65535) return null;
    return { ip: parts.join("."), port, v6: false };
  }
  const v6 = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(text);
  if (v6 !== null && v6[1]!.includes(":") && Number(v6[2]) <= 65535) {
    return { ip: v6[1]!, port: Number(v6[2]), v6: true };
  }
  return null;
}

/**
 * Where to listen: the address asked for, else 127.0.0.1 alone. Never this
 * machine's Tailscale IP by itself (Nov 4, the security audit): the API has no
 * sign-in of its own, so a listener there let any device on the tailnet run
 * the agent (a shell on this Mac) and use this person's account. Another
 * device reaches Edit through `tailscale serve --bg http://127.0.0.1:7700`,
 * which the owner turns on and Tailscale's own access rules guard.
 */
export function bindAddresses(host: string | null, port: number): Address[] {
  if (host !== null) {
    const parsed = parseSocketAddr(`${host}:${port}`);
    return parsed === null ? [] : [parsed];
  }
  return [{ ip: "127.0.0.1", port, v6: false }];
}

const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

function run(binary: string, args: string[]): string | null {
  try {
    const output = Bun.spawnSync([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return output.stdout.toString();
  } catch {
    return null;
  }
}

/** This machine's Tailscale IPv4 address, if Tailscale runs. */
export function tailscaleIp(): string | null {
  for (const binary of TAILSCALE) {
    const first = run(binary, ["ip", "-4"])?.split("\n")[0]?.trim();
    if (first !== undefined && parseSocketAddr(`${first}:0`) !== null) return first;
  }
  return null;
}

/** This machine's Tailscale DNS name (lowercase, no trailing dot), if Tailscale runs. */
export function tailscaleName(): string | null {
  for (const binary of TAILSCALE) {
    const out = run(binary, ["status", "--json"]);
    if (out === null) continue;
    try {
      const status = JSON.parse(out) as { Self?: { DNSName?: unknown } };
      const name = status.Self?.DNSName;
      if (typeof name !== "string") continue;
      const trimmed = name.replace(/\.+$/, "").toLowerCase();
      if (trimmed !== "") return trimmed;
    } catch {
      continue;
    }
  }
  return null;
}

/** "edit: <why>" on stderr, exit 2. */
export function fail(message: string): never {
  console.error(`edit: ${message}`);
  process.exit(2);
}

/** Opens the store and starts listening. */
/**
 * Ends the work a restart left running under this process: a reload (bun
 * --watch) and an update's exec keep the process id, so the agent's
 * `claude` and FFmpeg the last run started are still its
 * children, working for nobody (and, run as the server exits, what it leaves). Their turns and jobs are resumed afresh, so
 * the old ones went on in parallel (Oct 30: a review fix's agent ran twice
 * on one project, both editing it). Nothing of this run has started yet.
 */
export function endLeftovers(pid = process.pid): string[] {
  const listed = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
  const ended: string[] = [];
  for (const line of new TextDecoder().decode(listed.stdout).split("\n")) {
    const found = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (found === null || Number(found[2]) !== pid) continue;
    const program = /(?:^|\/)(claude|ffmpeg|edit-ffmpeg|ffprobe|edit-ffprobe)(?:\s|$)/.exec(found[3]!)?.[1] ?? null;
    if (program === null) continue;
    try {
      process.kill(Number(found[1]), "SIGTERM");
      ended.push(program);
    } catch {
      // Gone already.
    }
  }
  return ended;
}

/** How long a restart waits for paid requests in flight (a transcription piece is at most ~90 s of audio). */
const PAID_WAIT_MS = 120_000;

/**
 * Stops every process this one started, and theirs, before Edit restarts
 * itself: asked to end, then made to after `graceMs`. The window is left
 * (the restart closes it last). What each was doing is a job that carries
 * on after the restart from what it kept. Answers the programs stopped.
 */
export async function stopChildren(graceMs = 3_000, pid = process.pid): Promise<string[]> {
  const listed = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
  const rows = new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .flatMap((line) => {
      const found = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return found === null ? [] : [{ pid: Number(found[1]), parent: Number(found[2]), command: found[3]! }];
    });
  const kept = windowPid();
  const under = new Set<number>();
  const visit = (parent: number) => {
    for (const row of rows) {
      if (row.parent !== parent || row.pid === kept || under.has(row.pid)) continue;
      under.add(row.pid);
      visit(row.pid);
    }
  };
  visit(pid);
  under.delete(process.pid);
  const names = rows.filter((row) => under.has(row.pid)).map((row) => (/^\S*?([^/\s]+)(?:\s|$)/.exec(row.command)?.[1] ?? "?"));
  const signal = (name: NodeJS.Signals) => {
    for (const one of under) {
      try {
        process.kill(one, name);
      } catch {
        under.delete(one);
      }
    }
  };
  signal("SIGTERM");
  const until = Date.now() + graceMs;
  while (under.size > 0 && Date.now() < until) {
    await Bun.sleep(100);
    for (const one of [...under]) {
      try {
        process.kill(one, 0);
      } catch {
        under.delete(one);
      }
    }
  }
  signal("SIGKILL");
  return names;
}

/** The data folder's lock for the life of this process, so a second Edit on the same folder is noticed. */
function holdDataLock(home: string): void {
  try {
    if (!native().holdLock(join(home, "server.lock"))) diag.warn("edit", `another Edit is using ${home}`);
  } catch {
    // No addon: nothing to lock with.
  }
}

export function start(home: string, host: string | null, port: number): { app: App; servers: Server<unknown>[] } | null {
  // The data folder itself on a drive or in Documents (EDIT_HOME, --home): everything reads it, so the start
  // waits for its place to answer, off the event loop, rather than in a sync call that holds the process.
  const asked = folderAccess.unanswered([home]);
  if (asked.length > 0) {
    console.log(`edit: ${folderAccess.waitingLine(asked)}`);
    void folderAccess.reachRoots(asked).then(() => startHere(home, host, port));
    return null;
  }
  return startHere(home, host, port);
}

function startHere(home: string, host: string | null, port: number): { app: App; servers: Server<unknown>[] } {
  diag.open(home);
  lastRun.begin(home);
  const ended = endLeftovers();
  if (ended.length > 0) diag.info("edit", `ended ${ended.length} process(es) the last run left (${[...new Set(ended)].join(", ")}): their work starts again`);
  // And on the way out: a quit, Edit.app closed or a server stopped leaves its FFmpeg and `claude` running for
  // nobody, with a new process id the next start can't tell apart (the 10-hour trial, Nov 4: a sound copy and a
  // thumbnail pass went on reading 58 GB beside the restarted server's own). Their jobs start again with the next run.
  process.on("exit", () => {
    endLeftovers();
  });
  for (const [tool, path] of [
    ["ffmpeg", tools.ffmpeg()],
    ["ffprobe", tools.ffprobe()],
  ] as const) {
    let found = false;
    try {
      Bun.spawnSync([path, "-version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      found = true;
    } catch {
      found = false;
    }
    if (!found) diag.warn("edit", `${tool} not found; importing and export need FFmpeg`);
  }
  diag.info("edit", `FFmpeg: ${tools.ffmpeg()} (${tools.bundled() ? "shipped with Edit" : "from PATH"})`);
  let store: Store;
  try {
    store = Store.open(home);
  } catch (error) {
    fail(`${home}: ${diag.messageOf(error)}`);
  }
  initNative({
    home: store.home,
    cacheDir: store.cacheDir(),
    ffmpeg: tools.ffmpeg(),
    ffprobe: tools.ffprobe(),
  });
  holdDataLock(store.home);
  cloud.keepUploadJournalsIn(join(store.home, "uploads"));
  modelChoice.use(store.home);
  const ip = tailscaleIp();
  const app = createApp({
    store,
    port,
    allowedHosts: allowedHosts({ host, tailscale: [ip, tailscaleName()] }),
    machine: hostname() ?? "this machine",
    services: { exports: new ExportRegistry(home), updater: new update.Updater(home) },
  });
  seams.cloudMedia.configurePlayback(app);
  // The places macOS is being asked about (folder_access.ts), for the page's one line while it asks.
  folderAccess.onChange((waiting) => app.store.emit({ type: "access", waiting }));
  // Every save gives footage's sounds their crossfade room from the file's words (sound_room.ts).
  const words = transcriptWords();
  store.setWords((media) => words(app.media.paths(media.path).transcript));
  // The data folder's cache or media made a link to another drive, or the folder itself on one: macOS may ask
  // the person before Edit reads it, and a sync read waits inside the system call, holding the whole server
  // (kenobi, Nov 17: "Edit would like to access files on a removable volume", and nothing answered until Edit
  // was quit). Those places are looked at first off the event loop (folder_access.ts): the server listens
  // meanwhile, and the work below, which reads them, starts once they've answered. Usually there are none,
  // and it all starts here as before.
  const asked = folderAccess.useDataFolder(store.home);
  // The export folder saved on a drive or in Desktop: asked about now, off the event loop, not first in an export's sync mkdir.
  const exportFolder = savedExportFolder(store.home);
  if (exportFolder !== null) void folderAccess.reach([exportFolder]);
  let signedIn: Promise<unknown> = Promise.resolve();
  const background = () => {
    // Smoothing waits while an export runs (previews and proxies do in the addon).
    pauseForExports(() => app.exports.localRunning?.() ?? app.exports.running());
    // Slowed cut-in shots are smoothed unless asked not to, where it takes seconds.
    setSmoothByDefault(app.native.smoothSupported());
    // The encoders are listed once now, off the thread (Nov 21): the first export plan of a process listed them by
    // running FFmpeg synchronously, 0.7 s of nothing else answered, whoever asked first.
    void encodersListed();
    // On Linux, RIFE on the GPU (rife.ts), looked for at start (a two-frame check, its programs awaited: Nov 21, run
    // synchronously two seconds in it kept the server's thread for as long as RIFE took to answer, 14 s seen).
    if (process.platform === "linux") {
      void warmRife(app.store.home).then(
        () => setSmoothByDefault(smoothsFast(app)),
        (error: unknown) => diag.warn("broll", `looking for RIFE: ${diag.messageOf(error)}`),
      );
    }
    // The cache kept by each project's state; a project with an effect rendering or removal pieces out is in work.
    busy.registerProjectWork((id) => effects.renderingLine(id) !== null || removalSchedule.progressOf(id).out > 0);
    startCleaning(app);
    exportRoom.make = (wanted) => makeRoomAsync(app, wanted).then(() => {});
    seams.broll.stopLeftoverMaps?.();
    // Tools register here; the subtitles' and captions' register as their modules load (through seams).
    registerEditingTools();
    registerMediaTools();
    registerEffectTools();
    registerChannelTools();
    // The Chrome effects, thumbnails and pages are drawn in, out of the Dock: on a Mac, Edit's own headless shell, fetched
    // in the background the first time and brought up to Chrome's stable release daily (chrome_devtools.ts).
    prepareShell(store.home);
    // Coded effects (Edit V2): rendered as their code settles, and those left undone when Edit last closed.
    effects.start(app);
    changes.start(app);
    // A whole edit that ends with fixable flags gets one follow-up from Edit.
    agentHooks.unfinished = (project) => unfinishedNote(app, project);
    // The script's comments, written on any Mac, reach the edit before each agent turn.
    agentHooks.beforeTurn = (project) => scriptSync.catchUpComments(app, project);
    // An Edit V2 chat's queued message reads what's at its playhead, and takes the team's notes, as it goes.
    agentHooks.messageContext = (project, playhead) => messageContext(app, project, playhead, true);
    seams.speakers.watch(app);
    // Cloud projects (on with the built-in token): sync, locks, and letting them go on the way out.
    // Signed in before: the access token renewed quietly, before the cloud's first call.
    // The sign-in restored before anything resumes (below): a smoothing resumed
    // at once read its footage before it, got "Sign in to Edit", and kept its
    // shot unsmoothed (the full run-through, Oct 28).
    optional("accounts", () => {
      signedIn = accounts.start(app);
    });
    optional("cloud", () => seams.cloudProjects.start(app));
    // A trial server (EDIT_TRIALS=1, the teaching loop's: app/scripts/trial-server.sh) signs in and syncs
    // cloud projects but takes no team work: this Mac's id is the one Ready for changes is asked of, and two servers on
    // it would both fix the same review notes and Writer jobs (Oct 31, the user: a server for training
    // agents and trials that other sessions' saves never restart).
    const trials = process.env.EDIT_TRIALS === "1";
    if (trials) diag.info("edit", "a trial server: no review fixes, Writer folder or archives, idea runs or remote support here");
    // Repack reviews of exports: their notes followed, and fixed by the agent once they settle.
    if (!trials) optional("review", () => reviews.start(app));
    // What failed on the build before, tried again once on this one, when the Mac is idle.
    if (!trials) optional("retry after update", () => retryAfterUpdate.start(app));
    // Smooth playback: the open edit rendered small in the background, out of the way of exports.
    optional("playback", () => playbackRender.start(app));
    optional("hq ears", () => hqEars.start(app));
    optional("house words", () => houseWordsPass.start(app));
    // A channel's end-of-turn check (its add-on end-check): the edit's checks where a turn changed it, in the background.
    optional("end check", () => endCheck.start(app));
    // The agent's old Claude Code sessions (a chat's left ones, one-off questions) removed from this computer.
    if (!trials) optional("agent sessions", () => void agentSessions.start(app));
    // Effect render files nothing plays from any more (replaced by one in the cloud, or of an effect gone).
    optional("effect renders", () => void effectCloud.start(app));
    // Exports made ahead: once a project's edits rest, its next share's export is made in the background, so the share reuses it.
    if (!trials) optional("export ahead", () => exportAhead.start(app));
    // Their see-through watermark out of the footage on the timeline, free, as soon as edits rest (a channel taught its mark).
    // What a channel is taught to take out of its footage (their subtitles, text, watermark), as soon as edits rest.
    optional("removal", () => removalSchedule.start(app));
    // Projects archived on Repack: their big files freed here, and restores asked for done.
    if (!trials) optional("archive", () => archive.start(app));
    // Script mode: Writer's scripts on this Mac brought in once, and its background work.
    optional("writer", () => writer.start(app, { trials }));
    // Ideas: runs this Mac had going when it stopped, marked stopped in the cloud.
    if (!trials) optional("ideas", () => ideas.start(app));
    if (!trials) optional("thumbnails", () => thumbnails.start(app));
    // The "(conflicted copy)" edits and scripts made before Nov 15, folded into their originals' history.
    if (!trials) optional("old copies", () => oldCopies.start(app));
    // A new project's first message, sent to its agent once its import is done.
    // Kept on a trial server too: its prompts are its own projects' (first-prompts.json in its home).
    optional("first prompt", () => firstPrompt.start(app));
    // Research goes to the cloud, so the project opened on another Mac has it.
    optional("research cloud", () => researchCloud.start(app));
  };
  if (asked.length === 0) background();
  let quitting = false;
  const quit = (code: number) => {
    // A second signal, or a cloud push that never answers, doesn't hold Edit open: Edit.app's window
    // kills what's left after 6 s (crates/edit-window), and macOS 27 shows Edit "running in background" meanwhile.
    if (quitting) process.exit(code);
    quitting = true;
    lastRun.quitting();
    // TIMING.QUIT_BUDGET: one cloud call fits (sync_core.ts); a push left over is sent by the next start.
    setTimeout(() => process.exit(code), TIMING.QUIT_BUDGET).unref();
    // The agents first: a turn left running goes on editing (and spending) with no Edit to answer it.
    try {
      app.agents.shutdown?.();
    } catch (error) {
      diag.warn("agent", `on the way out: ${diag.messageOf(error)}`);
    }
    void (async () => {
      try {
        // Edits' and scripts' locks let go together, inside the quit budget; the log's last lines go up beside them (at most 3 s).
        await Promise.all([seams.cloudProjects.shutdown(), writerLocks.releaseAll(), logShip.finish()]);
      } catch (error) {
        if (!seams.isUnavailable(error)) diag.warn("cloud", `on the way out: ${diag.messageOf(error)}`);
      }
      process.exit(code);
    })();
  };
  // Before Edit restarts itself (an update, remote support's restart): what can stop cleanly does, and the rest
  // carries on after it as after a quit (Sphe, Nov 10: updates shouldn't wait for an import to finish).
  update.onPrepare(async () => {
    // Paid requests in flight are answered and kept first, so none is paid for twice (paid.ts).
    if (!(await paidWork.settle(PAID_WAIT_MS))) diag.warn("update", `restarting with ${paidWork.count()} paid request(s) still unanswered after ${PAID_WAIT_MS / 1000} s`);
    try {
      app.agents.shutdown?.("Edit is updating. This turn carries on by itself once it's back, in a few seconds.");
    } catch (error) {
      diag.warn("agent", `before the update: ${diag.messageOf(error)}`);
    }
    // Script imports interrupted, so they stay importing and carry on at the next start (writer/imports.ts stopAll);
    // then the job table kept as it is, so nothing the stop below makes fail is written down as failed (jobs.freeze).
    const imports = await writerImports.stopAll().catch((error: unknown) => (diag.warn("writer", `stopping the imports before the update: ${diag.messageOf(error)}`), 0));
    if (imports > 0) diag.info("update", `${imports} script import(s) stopped before restarting: they carry on after it`);
    jobs.freeze();
    // Saves pushed and locks let go, within the quit's budget.
    await Promise.race([Promise.all([seams.cloudProjects.shutdown(), writerLocks.releaseAll()]).catch(() => undefined), Bun.sleep(TIMING.QUIT_BUDGET)]);
    // Every program this run started stops before the new run starts its own on the same files.
    const stopped = await stopChildren();
    if (stopped.length > 0) diag.info("update", `stopped ${stopped.length} process(es) before restarting (${[...new Set(stopped)].join(", ")}): their work carries on after it`);
    jobs.plannedRestart(app.store.home);
  });
  process.on("SIGINT", () => quit(130));
  process.on("SIGTERM", () => quit(143));
  // A promise nobody waited on that failed: said in the log, where it used to go unseen (the audit, Oct 23).
  process.on("unhandledRejection", (reason) => diag.error("server", `unhandled failure: ${diag.messageOf(reason)}${reason instanceof Error && reason.stack ? `\n${reason.stack}` : ""}`));
  // A throw nobody caught (a timer's, a stream's): said in the log, and Edit carries on, as for a
  // promise. It stopped the server, and Edit.app's window keeps no stderr, so nothing said why.
  process.on("uncaughtException", (error) => diag.error("server", `uncaught failure: ${diag.messageOf(error)}${error.stack ? `\n${error.stack}` : ""}`));
  const router = buildRouter();
  remoteAsk.useRouter(router);
  const servers: Server<unknown>[] = [];
  for (const address of bindAddresses(host, port)) {
    const shown = showAddress(address);
    try {
      servers.push(listen(app, router, address.ip, address.port) as Server<unknown>);
      console.log(`edit: http://${shown}`);
      // The first address is where map pages reach this server .
      if (servers.length === 1) setListening(address.ip, address.port);
    } catch (error) {
      console.error(`edit: could not bind ${shown}: ${diag.messageOf(error)}`);
    }
  }
  if (servers.length === 0) fail(`nothing to listen on (is port ${port} taken?)`);
  console.log(`edit: data in ${home}`);
  // What runs now, the one answer (busy.ts `runningNow`): Script mode's imports, Claude's runs and shares keep it awake too.
  keepAwakeWhile(() => busy.runningNow(app)[0] ?? null);
  // Once listening (the agents reach Edit's MCP on this port) and signed in
  // again (or 20 s on, signed out): the jobs and agent turns a restart cut short.
  // An export holds the hardware encoder (encoder.ts): an import's encode beside it isn't called stuck, and one that waits for it is woken when it ends.
  encoder.register(() => (app.exports.running() ? "an export" : null));
  const afterListen = () => {
    // First start of each installed nightly only (also works when an older
    // updater installed this build). Ordinary launches do no maintenance.
    if (RELEASE && NIGHTLY !== null && !process.env.CI && process.env.EDIT_CLAUDE_MAINTENANCE !== "0") seams.agentPanel(app).claudeSupport?.afterNightly(BUILD);
    void Promise.race([signedIn.catch(() => undefined), Bun.sleep(20_000)]).then(() => resumeJobs(app));
    wakeAfterTrouble(app);
  };
  if (asked.length === 0) afterListen();
  else {
    diag.info("edit", `waiting for ${asked.join(", ")} to answer (macOS may be asking) before reading Edit's cache and media there`);
    folderAccess.hold(
      folderAccess.reachRoots(asked).then(async () => {
        try {
          await fs.promises.mkdir(join(store.home, "cache"), { recursive: true });
        } catch (error) {
          diag.warn("store", `the cache folder: ${diag.messageOf(error)}`);
        }
        try {
          background();
          afterListen();
        } catch (error) {
          diag.error("edit", `starting once ${asked.join(", ")} answered: ${diag.messageOf(error)}`);
        }
      }),
    );
  }
  if (update.enabled()) {
    void update
      .check(update.readChannel(home))
      .then((release) => {
        if (release !== null) {
          console.log(
            `edit: ${release.tag} is out (this is ${update.BUILD}); update from the editor or run \`edit update\``,
          );
        }
      })
      .catch(() => {});
  }
  return { app, servers };
}

/** Runs a package's start-up step, whose service may not be available (then it's skipped, quietly). */
function optional(area: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    if (!seams.isUnavailable(error)) diag.warn(area, diag.messageOf(error));
  }
}

/**
 * When the trouble is over, the work waiting on it goes at once (honest council changes 2e and 6, Nov 19): the
 * machine woke (wake.ts), so the sign-in is renewed first and only then is what fell due started (each try used to
 * land in the same second as the renewal, with no token); or the relay or R2 answered again after an outage.
 */
function wakeAfterTrouble(app: App): void {
  // Work waiting for room starts again only once there's room for what it needs (jobs.ts `due`).
  // The same rule as the line it said ("needs about N GB free": storage.admit), so doing what it says is enough.
  jobs.roomCheck.has = (bytes) => storage.admit(app.store.cacheDir(), bytes, "This work") === null;
  wake.onWake((sleptMs) => {
    // Nothing that fell due is woken until the sign-in is back (its first tries can fail: the network comes back
    // seconds after a wake), up to two minutes; the table's own timer holds meanwhile (jobs.holdWaking).
    const renewed = (async () => {
      // Renewed only when the token is near its end: swapping a good sign-in at every wake, while the network is least
      // sure, is a chance to lose it (verify.md finding 10).
      if (!accounts.hasSession() || accounts.tokenLeftMs() > accounts.WAKE_RENEW_UNDER_MS) return;
      const until = Date.now() + 120_000;
      for (;;) {
        await accounts.renew().catch(() => undefined);
        if (accounts.accessToken() !== null || Date.now() > until || !accounts.hasSession()) return;
        await Bun.sleep(5_000);
      }
    })();
    jobs.holdWaking(app.store.home, renewed);
    void renewed.then(() => jobs.wakePassing(app.store.home, `the machine woke after ${diag.human(sleptMs)}`));
  });
  outages.onBack((destination) => void jobs.wakePassing(app.store.home, `${destination === "relay" ? "Edit's relay" : "R2"} answers again`));
  // And while the relay is down it's asked every few seconds whether it answers yet (its /health, 2.5 s at most), so
  // that wake comes within seconds of the line coming back, not at some request's next try (outages.ts `lookers`).
  outages.lookers.relay = () => relay.answers(2_500);
  // Someone signed in (or back in): work waiting on a sign-in goes now, not at its next look (verify.md finding 4).
  // Only when there was no good token before: a routine renewal ends no wait (Nov 20: each one woke every waiting
  // job and spent the passing schedule's tries, three in six seconds on the fault-injection run).
  accounts.onSessionChange((what) => {
    if (what === "signed-in" && accounts.hasSession()) void jobs.wakePassing(app.store.home, "signed in");
  });
}

/**
 * Starts again everything a restart cut short (jobs.ts), from the one table:
 * exports, archives, shares, fixes, agent turns, Ideas and Thumbnails runs,
 * uploads, smoothing, watches and map renders.
 */
/** How long resuming waits for the jobs' folders to answer before it goes on without them. */
const RESUME_FOLDERS_MS = 60_000;

async function resumeJobs(app: App): Promise<void> {
  // A job reads its files synchronously as it starts (an upload's original, an export's folder, its project's
  // footage): the places those are in that macOS may ask about answer first, off the event loop.
  try {
    const left = jobs.list(app.store.home).filter(jobs.live);
    const paths = left.flatMap((job) => {
      const footage = app.store.footageOf(job.project);
      return [...(Array.isArray(footage) ? footage : footage.media.map((media) => media.path)), ...absolutePaths(job.args)];
    });
    const roots = folderAccess.unanswered(paths);
    if (roots.length > 0) {
      diag.info("jobs", `resuming once ${roots.join(", ")} answer${roots.length === 1 ? "s" : ""} (macOS may be asking)`);
      // At most a minute (Nov 20: one hung network mount held every resume and wake of the run): a minute is long
      // enough for someone at the Mac to answer macOS's question; after it, the work goes on and what's there waits.
      if (!(await folderAccess.reachRootsWithin(roots, RESUME_FOLDERS_MS))) diag.warn("jobs", `${roots.join(", ")} didn't answer within ${RESUME_FOLDERS_MS / 1000} s (a drive gone, or macOS still asking): resuming the work anyway; what's there waits for it`);
    }
  } catch (error) {
    diag.warn("jobs", `looking at the jobs' folders before resuming them: ${diag.messageOf(error)}`);
  }
  const project = (id: string) => {
    const live = app.store.get(id);
    if (live === null) throw new jobs.Gone("the project is gone");
    return live.project;
  };
  // Imports an older build left asking the person about files this one tries again by itself: woken first.
  try {
    seams.script.wakeWhatPasses(app.store.home);
  } catch (error) {
    diag.warn("jobs", `looking at imports waiting for the person: ${diag.messageOf(error)}`);
  }
  void jobs.resume(app.store.home, {
    case: (job) => {
      project(job.project);
      // Carried on from what the job kept (script.carryOn: the same way Retry, a remote resume and unstick do). Nothing left to do: crossed off.
      const did = seams.script.carryOn(app, job.project);
      if (did === "finished" || did === "nothing") throw new jobs.Gone("its import has nothing left to do");
    },
    export: async (job) => {
      // An Export that was waiting for its graphics, or a batch of marked stretches, when Edit stopped: carried on as it
      // was asked (routes.ts; Nov 21: both lived in memory, and after an update the export someone asked for was gone).
      if (await carryOnAsked(app, job)) return;
      const { options, output, drive, keepLocal, share, note, watermark, replace } = job.args as unknown as { options: ExportOptions; output: string } & StartExtra;
      // The timeline it was started with, not edits made since.
      const current = project(job.project);
      const kept = resumeSnapshot(app.store.home, job.project, job.args);
      // Its kept timeline unreadable: made from the edit as it is now, and said so, never swapped silently.
      const asNow = kept === null ? "Exported as the edit is now: the timeline it was started with couldn't be read after the restart." : null;
      if (asNow !== null) diag.warn("export", `${job.project} (key ${job.key}): ${asNow}`);
      const asked = kept ?? current;
      const said = asNow === null ? note : note === undefined ? asNow : `${note} · ${asNow}`;
      // A share's export is its share's: the share job carries it on (and starts it again under this key).
      if (share === true) {
        const owner = jobs.get(app.store.home, jobs.keyOf("share", job.project));
        if (owner !== undefined && jobs.live(owner)) {
          // Its kept timeline goes with it (the share keeps its own), where it stayed in jobs/ for good.
          dropLeftSnapshot(app.store.home, job.project, job.args);
          throw new jobs.Gone("its share carries it on");
        }
        // From a build before shares were jobs: listed as a share now, at its export.
        void reviews
          .resumeShare(app, job.project, asked, options, { ...(replace === true ? { replace } : {}), ...(note === undefined ? {} : { note }), ...(watermark === undefined ? {} : { watermark }) })
          .catch((error: unknown) => diag.warn("review", `sharing ${job.project} after the restart (key ${job.key}): ${diag.messageOf(error)}`));
        return;
      }
      await app.exports.start(app.store, app.library, asked, options, output, { drive, ...(keepLocal === true ? { keepLocal } : {}), ...(said === undefined ? {} : { note: said }), ...(watermark === undefined ? {} : { watermark }) });
    },
    archive: async (job) => {
      // The export finished before the restart: only its upload is done again.
      const { output, key, record } = job.args as { output: string; key: string; record: ExportRecord };
      // Crossed off once it's up (or its file gone), put off and tried again by itself when it isn't, as after its export (exports.ts archiveJob).
      await archiveJob(app.store.home, job.key, () => app.exports.sendUp?.(app.store.home, job.project, output, key, record) ?? archiveGoing(app.store.home, job.project, output, key, record));
    },
    drive: (job) => {
      const { path } = job.args as { path: string };
      if (!fs.existsSync(path)) throw new jobs.Gone(`${path} is gone`);
      seams.drive.start(app.store, app.library, project(job.project), path);
    },
    smooth: (job) => {
      const { clip } = job.args as { clip: string };
      if (!project(job.project).clips.some((one) => one.id === clip)) throw new jobs.Gone("the clip is gone");
      seams.broll.smoothInBackground(app, job.project, [clip]);
    },
    watch: (job) => {
      project(job.project);
      seams.watch.watchInBackground(app, job.project);
    },
    upload: (job) => {
      seams.cloudMedia.resumeUpload(app.store.home, job.args);
    },
    full: (job) => {
      // A review version's full-quality file for its Download button: the rest of its parts, from its export here or
      // fetched back from its cloud copy (gone only when it's neither: reviews.resumeFull).
      const { path } = job.args as { path: string };
      void reviews.resumeFull(app.store.home, job).catch(settleBehind(app.store.home, job.key, "review", `${job.project}: its full-quality file`, () => reviews.fullGone(app.store.home, path)));
    },
    share: (job) => reviews.resumeShareJob(app, job),
    fix: (job) => reviews.resumeFix(app, job),
    turn: (job) => {
      if (app.agents.resumeTurn === undefined) throw new jobs.Gone("no agent panel here");
      app.agents.resumeTurn(job);
    },
    // A Writer script's import, or its chosen footage's exact hearing (writer/exact_after.ts), that waited on the transcription plan's credit: tried again (it waits again if there's still none).
    script: async (job) => {
      const data = writerStore.dataDir(app.store.home);
      if (!writerStore.ids(data).includes(job.project)) throw new jobs.Gone("the script is gone");
      if (job.args.waiting_on === "exact") {
        jobs.end(app.store.home, job.key);
        exactAfter.soon(data, job.project);
        return;
      }
      if (writerImports.importing(job.project)) return;
      // Its row stays from start to "ready" (the import ends it, or waits in it again); one that can't even start waits too.
      void writerImports.resume(app, data, job.project, { kind: "retry" }).catch((error: unknown) => {
        diag.warn("writer", `trying ${job.project}'s import again: ${diag.messageOf(error)}`);
        if (writerImports.importing(job.project)) return;
        try {
          jobs.wait(app.store.home, job.key, error);
          // Its row failed (the same refusal four times): the script says it stopped, never "Importing" for ever (Nov 20).
          const after = jobs.get(app.store.home, job.key);
          if (after === undefined || after.state === "failed") {
            writerStore.update(writerStore.scriptDir(data, job.project), (script) => {
              if (script.status !== "processing") return;
              script.status = "error";
              script.error = diag.messageOf(error);
            }, true);
          }
        } catch (failed) {
          diag.warn("writer", `settling ${job.project}'s import: ${diag.messageOf(failed)}`);
        }
      });
    },
    // An edit's footage that isn't here: fetched again from where it came from.
    media: (job) => {
      project(job.project);
      void missingMediaTries.tryAgain(app, job.project).catch(settleBehind(app.store.home, job.key, "cloud", `${job.project}: trying its missing footage again`, () => app.store.get(job.project) === null));
    },
    // A script's recordings that didn't come in: every one tried now (its row woke at the soonest's time, or as the connection came back).
    missing: (job) => {
      const data = writerStore.dataDir(app.store.home);
      if (!writerStore.ids(data).includes(job.project)) throw new jobs.Gone("the script is gone");
      void writerMissing.tryAgain(job.project, true).catch(settleBehind(app.store.home, job.key, "writer", `${job.project}: trying its missing recordings again`, () => !writerStore.ids(data).includes(job.project)));
    },
    // Claude on a Writer script (a build, a revision, review fixes…): started again from what it was started with and kept.
    writer: async (job) => (await import("./writer/work.ts")).carryOn(app, job),
    idea: (job) => ideas.resumeRun(app, job),
    thumbnail: (job) => thumbnails.resumeRun(app, job),
    // Footage from a Drive link into an edit: downloaded on from what came down, then added.
    // From its last step (drive_import.resumeImport): what the cut import already put on the timeline isn't put there twice.
    footage: (job) => {
      project(job.project);
      resumeImport(app, job);
    },
    // Smooth playback renders are made again when wanted; listed only so a restart or an update waits for them.
    playback: () => {
      throw new jobs.Gone("made again when it's wanted");
    },
    map: (job) => {
      const { first } = job.args as { first: string };
      if (!seams.broll.resumeMap?.(app, job.project, first)) throw new jobs.Gone("its stand-in or job file is gone");
    },
  });
}

/**
 * Settles a row whose work a resumer left going in the background, once that work fails (Nov 20: a `void` promise
 * with no catch left its row "running" for the rest of the run, nothing trying it again): crossed off when what it
 * needs is gone, else it waits by what the failure is, unless its own work settled it first.
 */
function settleBehind(home: string, key: string, area: string, what: string, gone: () => boolean): (error: unknown) => void {
  return (error) => {
    diag.warn(area, `${what}: ${diag.messageOf(error)}`);
    try {
      if (error instanceof jobs.Gone || gone()) jobs.end(home, key);
      else if (jobs.get(home, key)?.state === "running") jobs.wait(home, key, error);
    } catch (failed) {
      diag.warn("jobs", `settling ${key}: ${diag.messageOf(failed)}`);
    }
  };
}

/** The absolute paths among a job's arguments (two levels down: `options.output` too). */
function absolutePaths(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return value.startsWith("/") ? [value] : [];
  if (depth >= 2 || value === null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap((one) => absolutePaths(one, depth + 1));
}
