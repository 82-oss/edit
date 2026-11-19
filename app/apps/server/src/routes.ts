// The server's generic handlers (health, diagnostics, setup, the file browser,
// updates, projects, imports and uploads, media files, frames, exports) and
// `buildRouter`, which puts them together with every package's routes.

import * as windowFocus from "./window_focus.ts";
import * as linuxDesktop from "./linux_desktop.ts";
import * as accounts from "./accounts.ts";
import * as fs from "node:fs";
import * as folders from "./folders.ts";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import * as folderAccess from "./folder_access.ts";
import { importDrive } from "./drive_import.ts";
import * as remoteActions from "./remote_actions.ts";
import * as youtube from "./youtube.ts";
import * as youtubeSignIn from "./youtube_signin.ts";
import * as problemReports from "./problem_reports.ts";
import * as remoteControl from "./remote_control.ts";
import { cloudKeyFor, deleteExport, listExports } from "./exports.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as localPreviews from "./local_previews.ts";
import { nativeSources } from "./native_preview.ts";
import { PLAYBACK_ROUTE, previewable } from "./cloud_playback.ts";
import { ioMessage } from "./files.ts";
import { ApiError, bad, json, notFound } from "./http/errors.ts";
import { serveFile } from "./http/files.ts";
import { badShape, pathEndingAt, readJson, showPath, type RouteContext, type Router } from "./http/router.ts";
import { baseRouter } from "./http/server.ts";
import { importPaths } from "./import.ts";
import { routes as mediaRoutes } from "./media_tools.ts";
import { Semaphore } from "./media.ts";
import type { ExportOptions, Project, Style } from "./model.ts";
import { withProjectAsync } from "./native/index.ts";
import * as patches from "./patch.ts";
import { canonical, expandHome, extension, fileName, fileStem, isFile, join } from "./paths.ts";
import { DEFAULT_SETTINGS, SHORTS_SETTINGS } from "./project.ts";
import * as seams from "./seams.ts";
import { readExportFolder, saveExportFolder } from "./export_folder.ts";
import { defaultExportPath } from "./server_seam.ts";
import { UpdateError } from "./store.ts";
import * as missingMedia from "./missing_media.ts";
import * as archive from "./archive.ts";
import * as avatars from "./avatars.ts";
import * as kinds from "./kinds.ts";
import * as reset from "./reset.ts";
import * as firstPrompt from "./first_prompt.ts";
import * as uploads from "./uploads.ts";
import * as playbackRender from "./playback_render.ts";
import * as playbackReady from "./playback_ready.ts";
import * as footageReady from "./footage_ready.ts";
import * as scrub from "./scrub.ts";
import * as ranges from "./ranges.ts";
import * as storyboard from "./storyboard.ts";
import * as reviews from "./reviews.ts";
import * as tools from "./tools.ts";
import * as writerHandoff from "./writer_handoff.ts";
import * as writer from "./writer/routes.ts";
import * as writerReviews from "./writer/reviews.ts";
import * as ideas from "./ideas/routes.ts";
import * as thumbnails from "./thumbnails/routes.ts";
import * as later from "./later.ts";
import * as seen from "./seen.ts";
import * as exportsView from "./exports_view.ts";
import * as editNotes from "./edit_notes.ts";
import * as localFiles from "./local_files.ts";
import * as lessonInbox from "./lesson_inbox.ts";
import * as memory from "./memory.ts";
// The agent's report_problem tool (registered as it loads).
import "./agent_reports.ts";
import * as presence from "./presence.ts";
import * as channels from "./channels.ts";
import * as devProjects from "./dev_projects.ts";
import * as channelMarks from "./channel_marks.ts";
import * as beta from "./beta.ts";
import * as effects from "./effects.ts";
import * as exportSteps from "./export_steps.ts";
import * as removalSchedule from "./removal_schedule.ts";
import * as watermarkRemoval from "./watermark_removal.ts";
import * as effectCloud from "./effect_cloud.ts";
import { BUILD, VERSION } from "./version.ts";
import { jsonForSerde } from "./rust.ts";
import * as remoteSupport from "./remote_support.ts";

type Context = RouteContext<App>;

/**
 * Every route the server answers: the generic ones, every package's routes
 * in it (the library, drive, agent and map routes are one `media_tools`
 * call; captions, watch and transcribe are `captions.routes`).
 */
export function buildRouter(): Router<App> {
  const router = baseRouter()
    .get("/api/health", health)
    .get("/api/diagnostics", diagnostics)
    // The Logs window: the lines after `since` (ms), and the log file shown in Finder.
    .get("/api/logs", ({ query }) => {
      const since = Number(query.get("since") ?? 0) || 0;
      return json({ lines: diag.lines(2000).filter((line) => line.at > since) });
    })
    .post("/api/logs/reveal", async ({ app }) => {
      await localFiles.reveal(join(app.store.home, "logs", "edit.log"));
      return json({ ok: true });
    })
    .get("/api/setup", setup);
  seams.cloudProjects.routes(router);
  // Before /api/projects/{id}: /api/projects/status is its own.
  reviews.routes(router);
  editNotes.routes(router);
  localFiles.routes(router);
  playbackRender.routes(router);
  playbackReady.routes(router);
  footageReady.routes(router);
  scrub.routes(router);
  ranges.routes(router);
  storyboard.routes(router);
  firstPrompt.routes(router);
  reset.routes(router);
  accounts.routes(router);
  remoteSupport.routes(router);
  remoteControl.routes(router);
  windowFocus.routes(router);
  linuxDesktop.routes(router);
  writerHandoff.routes(router);
  writer.routes(router);
  ideas.routes(router);
  thumbnails.routes(router);
  later.routes(router);
  seen.routes(router);
  exportsView.routes(router);
  lessonInbox.routes(router);
  presence.routes(router);
  memory.routes(router);
  devProjects.routes(router);
  channels.routes(router);
  channelMarks.routes(router);
  beta.routes(router);
  effects.routes(router);
  removalSchedule.routes(router);
  watermarkRemoval.routes(router);
  archive.routes(router);
  avatars.routes(router);
  router
    .post("/api/diagnostics/client", clientLog)
    .post("/api/diagnostics/timings", clientTimings)
    .get("/api/update", updateStatus)
    .post("/api/update", updateInstall)
    .put("/api/update/channel", updateChannel)
    .get("/api/projects", listProjects)
    .post("/api/projects", createProject)
    .get("/api/projects/{id}", getProject)
    .put("/api/projects/{id}", putProject)
    .delete("/api/projects/{id}", deleteProject)
    .post("/api/projects/{id}/import", importMedia)
    .post("/api/projects/{id}/import-drive", importDriveMedia)
    .post("/api/projects/{id}/upload", uploadMedia, { bodyLimit: null })
    // The files uploaded that aren't media (the media panel's Files), and one of them.
    .get("/api/projects/{id}/files", ({ app, params }) => {
      liveOr404(app, params.id!);
      const kept = uploads.list(app.store.uploadsDir(params.id!)).filter((entry) => entry.file !== null && fs.existsSync(entry.file));
      return json({ files: kept.map((entry) => ({ name: entry.name, at: entry.at, size: fs.statSync(entry.file!).size })) });
    })
    .get("/api/projects/{id}/files/{name}", (context) => {
      liveOr404(context.app, context.params.id!);
      const wanted = decodeURIComponent(context.params.name ?? "");
      const found = uploads.list(context.app.store.uploadsDir(context.params.id!)).reverse().find((entry) => entry.file !== null && entry.name === wanted && fs.existsSync(entry.file));
      if (found === undefined) throw notFound(`no file ${wanted}`);
      return serveFile(context.request, found.file!);
    })
    .get("/api/projects/{id}/media-status", mediaStatus)
;
  missingMedia.routes(router);
  mediaRoutes(router);
  seams.research.routes(router);
  seams.captions.routes(router);
  seams.subtitles.routes(router);
  router
    .get(PLAYBACK_ROUTE, async ({ request, query }) => {
      const key = query.get("key") ?? "";
      if (!cloud.validKey(key) || !previewable(key)) throw bad("invalid cloud preview key");
      // Read now (a jump to footage not here yet): its whole copy comes down next. A background render's reads don't count.
      if (query.get("behind") !== "1") localPreviews.hurry(key);
      const response = await cloudMedia.streamFromCloud(request, { proxy: key }, "proxy");
      if (response === null) throw new ApiError(503, "cloud previews need Edit's cloud connection");
      // FFmpeg seeks by reopening the loopback HTTP input. Closing each
      // range avoids its stale keep-alive connection on a backward seek.
      response.headers.set("connection", "close");
      return response;
    })
    .get("/api/projects/{id}/media/{media}/{kind}", mediaFile)
    .get("/api/projects/{id}/native-sources", (context) => nativeSources(context.app, liveOr404(context.app, context.params.id!).project))
    .get("/api/projects/{id}/frame/{frame}", framePng)
    .post("/api/projects/{id}/export", startExport)
    .post("/api/projects/{id}/export/cancel", cancelExport)
    .post("/api/projects/{id}/export/retry", retryExport)
    .get("/api/projects/{id}/exports", projectExports)
    // Problem reports (problem_reports.ts): the Macs' own and the agent's, pulled by an admin.
    // Every Mac's latest report (problem_reports.latest), whether it's on or not.
    .get("/api/reports/latest", async ({ app }) => {
      try {
        return json({ reports: await problemReports.latest(app.store.home) });
      } catch (error) {
        throw bad(diag.messageOf(error));
      }
    })
    .get("/api/reports", async ({ app, query }) => {
      const days = Number(query.get("days") ?? "7");
      try {
        return json({ reports: await problemReports.pull(app.store.home, Number.isFinite(days) ? days : 7) });
      } catch (error) {
        throw bad(diag.messageOf(error));
      }
    })
    // The YouTube sign-in from Chrome (youtube_signin.ts): how it stands, and a check that brings up the Mac's Keychain dialog.
    .get("/api/youtube/sign-in", () => json(youtubeSignIn.status()))
    // What waits on YouTube turning Edit away, for the window's "Waiting on YouTube" chip (youtube.ts `waiting`).
    .get("/api/youtube/waiting", () => json({ waiting: youtube.waiting() }))
    .post("/api/youtube/sign-in/check", async ({ app }) => json(await youtubeSignIn.check(app.store.home)))
    .post("/api/projects/{id}/exports/delete", deleteProjectExport);
  router
    .get("/api/exports/activity", ({ app }) => {
      const visible = new Set(app.store.visible().map(project => project.id));
      // Every export from the moment it's asked for (one waiting for its graphics too), each going one with its steps.
      const edits = exportSteps.activity(app, visible);
      // Script shares join the same queue. Only the ones running: a share has no file, and a settled one is not kept (it would linger in this process and show up in the activity check).
      const shares = writerReviews.shareQueue().filter(share => writer.seesScript(writer.dataOf(app), share.id)).map(share => ({
        id: share.id,
        name: share.name,
        path: "",
        state: "running" as const,
        progress: share.progress,
        updated_ms: share.startedAt,
        kind: "script" as const,
        stage: share.stage,
      }));
      const rank = (state: string) => (state === "running" || state === "queued" ? 0 : 1);
      return json([...edits, ...shares].sort((a, b) => rank(a.state) - rank(b.state) || b.updated_ms - a.updated_ms));
    })
    .get("/api/exports/folder", ({ app }) => json(readExportFolder(app.store.home)))
    // The places macOS is being asked about now (folder_access.ts), also sent as `access` events as they change.
    .get("/api/access", () => json({ waiting: folderAccess.waiting() }))
    .post("/api/exports/folder", setExportFolder)
    .get("/api/exports/file", exportedFile);
  seams.script.routes(router);
  folders.routes(router);
  return router;
}

// ---------------------------------------------------------------------------
// Request helpers

/** axum's `Query` rejection: plain text, 400. */
function badQuery(why: string): ApiError {
  return new ApiError(400, `Failed to deserialize query string: ${why}`, true);
}

/** A `u32` query value (`?max=`), absent as null. */
function u32Query(context: Context, name: string): number | null {
  const value = context.query.get(name);
  if (value === null) return null;
  if (!/^\+?\d+$/.test(value)) {
    throw badQuery(value === "" ? "cannot parse integer from empty string" : "invalid digit found in string");
  }
  const number = Number(value.replace(/^\+/, ""));
  if (number > 0xffff_ffff) throw badQuery("number too large to fit in target type");
  return number;
}

/** A `u64` query value, absent as null. */
function u64Query(context: Context, name: string): number | null {
  const value = context.query.get(name);
  if (value === null) return null;
  if (!/^\+?\d+$/.test(value)) {
    throw badQuery(value === "" ? "cannot parse integer from empty string" : "invalid digit found in string");
  }
  return Number(value.replace(/^\+/, ""));
}

function requiredQuery(context: Context, name: string): string {
  const value = context.query.get(name);
  if (value === null) throw badQuery(`missing field \`${name}\``);
  return value;
}

/** A JSON body as an object (axum's 422 when it's another kind of value). */
async function body(context: Context): Promise<Record<string, unknown>> {
  const value = await readJson<unknown>(context);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badShape(`invalid type: ${kindOf(value)}, expected a struct`);
  }
  return value as Record<string, unknown>;
}

/** `Option<Json<T>>`: no JSON content type is no body (the defaults); one is read as `Json`. */
async function optionalBody(context: Context): Promise<Record<string, unknown> | null> {
  if (context.request.headers.get("content-type") === null) return null;
  return body(context);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "sequence";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return "map";
}

/** What serde says it expected of a JSON kind ("a string"; numbers by their Rust type: "u32"). */
type Expected = "string" | "boolean" | "u32" | "u64" | "f64";

const EXPECTED: Record<Expected, string> = { string: "a string", boolean: "a boolean", u32: "u32", u64: "u64", f64: "f64" };

function field<T>(object: Record<string, unknown>, name: string, kind: Expected, required: true): T;
function field<T>(object: Record<string, unknown>, name: string, kind: Expected, required?: false): T | null;
function field<T>(object: Record<string, unknown>, name: string, kind: Expected, required = false): T | null {
  const value = object[name];
  const expected = EXPECTED[kind];
  if (value === undefined || value === null) {
    if (required && value === undefined) throw badShape(`missing field \`${name}\``);
    if (required) throw badShape(`${name}: invalid type: null, expected ${expected}`);
    return null;
  }
  const js = kind === "string" || kind === "boolean" ? kind : "number";
  if (typeof value !== js) throw badShape(`${name}: invalid type: ${kindOf(value)}, expected ${expected}`);
  if ((kind === "u32" || kind === "u64") && !Number.isInteger(value)) {
    throw badShape(`${name}: invalid type: ${kindOf(value)}, expected ${expected}`);
  }
  if ((kind === "u32" || kind === "u64") && ((value as number) < 0 || (kind === "u32" && (value as number) > 0xffff_ffff))) {
    throw badShape(`${name}: invalid value: ${kindOf(value)}, expected ${expected}`);
  }
  return value as T;
}

function liveOr404(app: App, id: string) {
  const live = app.store.get(id);
  if (live === null) throw notFound("no such project");
  // A kind of video the signed-in person can't work on (kinds.ts): hidden, not read-only.
  const why = app.store.unavailable(id);
  if (why !== null) throw new ApiError(403, why);
  return live;
}

// ---------------------------------------------------------------------------
// Server

/** Who answers, and what it's in the middle of (the dev server's runner waits for that before a restart). */
function health({ app }: Context): Response {
  let busy: string[] = [];
  try {
    busy = remoteActions.busyWith(app);
  } catch {
    // A test's stubbed services: nothing of theirs is running.
  }
  return json({ machine: app.machine, name: "edit", version: VERSION, busy });
}

/** The first line `<tool> -version` prints, or null. */
function toolVersion(tool: string): string | null {
  try {
    const output = Bun.spawnSync([tool, "-version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const first = output.stdout.toString().split("\n")[0];
    return first === undefined ? null : first.replace(/\r$/, "");
  } catch {
    return null;
  }
}

/** Everything a problem report needs from the server side. */
function diagnostics({ app }: Context): Response {
  const version = toolVersion(tools.ffmpeg());
  return json({
    ffmpeg: version === null ? null : `${version} (${tools.bundled() ? "shipped with Edit" : "from PATH"})`,
    home: app.store.home,
    lines: diag.lines(400),
    machine: app.machine,
    os: `${diag.osName()} ${diag.archName()}`,
    timings: diag.timings(),
    uptime: diag.human(diag.uptime()),
    version: BUILD,
    claude: seams.agentPanel(app).claudeSetup?.() ?? null,
  });
}

/** What this machine still needs before everything in Edit works. */
async function setup({ app }: Context): Promise<Response> {
  let ffmpeg = false;
  try {
    ffmpeg = Bun.spawnSync([tools.ffmpeg(), "-version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    ffmpeg = false;
  }
  let agent: Record<string, unknown>;
  try {
    agent = (await app.agents.status()) as Record<string, unknown>;
  } catch {
    agent = { ready: false, state: "missing" };
  }
  let chrome = false;
  try {
    chrome = seams.broll.chrome() !== null;
  } catch {
    chrome = false;
  }
  const loggedOut = agent.state === "logged_out";
  const checks: Record<string, unknown>[] = [];
  checks.push(
    {
      fix: "curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | sh",
      id: "ffmpeg",
      ok: ffmpeg,
      title: "FFmpeg",
      why: "Importing footage, previews and export. Reinstalling Edit brings it back.",
    },
    {
      fix: loggedOut ? "claude auth login" : "curl -fsSL https://claude.ai/install.sh | bash && claude auth login",
      id: "claude",
      ok: agent.ready === true,
      title: loggedOut ? "Claude Code sign-in" : "Claude Code",
      why: "The agent panel (on your own Claude plan or API key).",
    },
    {
      fix: "https://www.google.com/chrome/",
      id: "chrome",
      ok: chrome,
      title: "Google Chrome (or Chromium)",
      why: "Map shots and research.",
    },
  );
  return json({ checks });
}

/**
 * The window's playback timings (each wait for a frame, smooth or live; the
 * script player's starts and stalls), kept with the server's as "ui: <name>"
 * so a Mac's report and remote ask show how playback goes there.
 */
async function clientTimings(context: Context): Promise<Response> {
  const given = (await body(context)) as { timings?: unknown };
  const list = Array.isArray(given.timings) ? given.timings.slice(0, 40) : [];
  for (const one of list) {
    const { name, ms } = (one ?? {}) as { name?: unknown; ms?: unknown };
    if (typeof name !== "string" || !/^(preview|script preview): [\w ,()]{1,80}$/u.test(name) || !Array.isArray(ms)) continue;
    for (const sample of ms.slice(0, 200)) {
      if (typeof sample === "number" && Number.isFinite(sample) && sample >= 0 && sample <= 3_600_000) diag.record("ui", `ui: ${name}`, sample, null);
    }
  }
  return json({ ok: true });
}

/** The UI's own problems, kept with the server's so one report has both. */
async function clientLog(context: Context): Promise<Response> {
  const given = await body(context);
  const level = field<string>(given, "level", "string", true);
  const message = [...field<string>(given, "message", "string", true)].slice(0, 2000).join("");
  if (level === "error") diag.error("ui", message);
  else if (level === "warn") diag.warn("ui", message);
  else diag.info("ui", message);
  return json({ ok: true });
}

async function updateStatus({ app }: Context): Promise<Response> {
  return json(await app.updater.status());
}

/** Nightly or Stable (Settings → Updates). */
async function updateChannel(context: Context): Promise<Response> {
  const channel = field<string>(await body(context), "channel", "string") ?? "";
  try {
    return json(await context.app.updater.setChannel(channel));
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
}

/** Downloads the newest release and restarts into it. */
async function updateInstall({ app }: Context): Promise<Response> {
  return json(await installUpdate(app));
}

/** Shared by the local update route and an explicitly enabled remote request. */
export async function installUpdate(app: App, remote = false) {
  // Nothing holds an update but, asked from afar, an agent turn someone may be watching as it's written (Sphe, Nov 10:
  // "be able to update mid import"): every other kind of work carries on from the job table after the restart.
  const turns = () => (app.agents as { hasRunningTurns?: () => boolean }).hasRunningTurns?.() === true;
  const busy = () => (remote && turns() ? ["an agent turn"] : []);
  const now = busy();
  if (now.length > 0) throw new ApiError(409, `${now.join(", ")} ${now.length === 1 ? "is" : "are"} running; update when it's done`);
  try {
    // Rechecked just before the restart: work of that kind may have started while it downloaded.
    return await app.updater.install(() => busy().length === 0);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
}

// ---------------------------------------------------------------------------
// Projects

function listProjects({ app }: Context): Response {
  return json({ projects: app.store.visible() });
}

const STYLES: Style[] = ["bodycam", "interrogation", "courtroom", "commentary", "horror", "shorts"];

async function createChannelProject(context: Context, given: Record<string, unknown>, name: string, key: string, settings: { width: number; height: number; fps: number }): Promise<Response> {
  const channel = await channels.channelFor(key, context.app.store.home);
  if (channel === null) throw bad("channel is a channel's key");
  const style = channels.styleOf(channel);
  if (!kinds.mayStart(style)) throw new ApiError(403, kinds.cantMake(`edit.${style}`));
  // A channel given (or added) since this token was issued: a fresh one first, and a plain refusal before anything is made.
  if (!(await channels.tokenCarries([channel.key], context.app.store.home))) throw new ApiError(403, `${channel.title} isn't given to your account yet: ask an admin to give it to you on accounts.spheceo.com.`);
  const compilation = field<boolean>(given, "compilation", "boolean");
  const person = devProjects.madeForPerson(context.request, field<boolean>(given, "person", "boolean"));
  let live;
  try {
    live = context.app.store.createAs(name, style, settings, true, !person);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  try {
    live = (
      await context.app.store.update(live.project.id, "channel", (project) => {
        project.channel = channel.key;
        if (compilation !== null && compilation !== channel.compilation) project.compilation = compilation;
      })
    )[0];
  } catch (error) {
    // Refused on its channel: no untitled project left behind with none.
    context.app.store.delete(live.project.id);
    throw error;
  }
  context.app.store.setActive(live.project.id);
  return json({ rev: live.rev, project: live.project });
}

async function createProject(context: Context): Promise<Response> {
  const given = await body(context);
  const name = field<string>(given, "name", "string", true);
  const style = given.style === undefined ? "bodycam" : given.style;
  if (typeof style !== "string" || !STYLES.includes(style as Style)) {
    throw badShape(`style: unknown variant \`${String(style)}\`, expected one of \`bodycam\`, \`interrogation\`, \`courtroom\`, \`commentary\`, \`shorts\``);
  }
  const size = (key: "width" | "height" | "fps") => {
    const value = field<number>(given, key, "u32");
    // A Short is 9:16 unless asked otherwise.
    if (value === null) return style === "shorts" ? SHORTS_SETTINGS[key] : DEFAULT_SETTINGS[key];
    return value;
  };
  const settings = { width: size("width"), height: size("height"), fps: size("fps") };
  // A channel's (Nov 14, channels.ts): a V2 project of that channel, its kind of video from who narrates the channel's
  // videos, and whether it's a compilation only when it isn't what the channel's usually are.
  const channelKey = field<string>(given, "channel", "string");
  if (channelKey !== null) return createChannelProject(context, given, name!, channelKey, settings);
  // Edit V2 without a channel (scripts and tests; Home makes V2 edits for a channel): only with the beta on, bodycam
  // alone, taught nothing but the global skill.
  const hq = field<boolean>(given, "hq", "boolean") === true;
  if (hq && !beta.read(context.app.store.home).v2) throw bad("Edit V2 is off: turn it on in Settings → Beta.");
  if (hq && style !== "bodycam") throw bad("Only a bodycam project can be Edit V2 without a channel.");
  if (!kinds.mayStart(style as Style)) throw new ApiError(403, kinds.cantMake(`edit.${style}`));
  let live;
  try {
    // A test project unless a person started it from Home (`person`): what a coding agent, a script or a trial makes
    // is hidden on Home (Sphe, Nov 14: "projects created by me should by default just be at the forefront, but all
    // projects created by you should be test projects"). One made through remote control is the person's at that Mac.
    const person = devProjects.madeForPerson(context.request, field<boolean>(given, "person", "boolean"));
    live = context.app.store.createAs(name, style as Style, settings, hq, !person);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  context.app.store.setActive(live.project.id);
  return json({ rev: live.rev, project: live.project });
}

/** Projects whose older smoothed renders were looked for this run (once each). */
const smoothChecked = new Set<string>();

function getProject({ app, params }: Context): Response {
  const id = params.id!;
  const live = liveOr404(app, id);
  app.store.setActive(id);
  // Slow motion an older smoother rendered (flickering made frames, Nov 5) is smoothed again, in the background.
  if (!smoothChecked.has(id)) {
    smoothChecked.add(id);
    void seams.broll.smoothStaleAgain(app, id).catch((error: unknown) => diag.warn("broll", `smoothing ${id} again: ${diag.messageOf(error)}`));
  }
  for (const media of live.project.media) {
    // Cloud media are streamed inputs (a loopback URL, never a file here):
    // they still need their thumbnails and waveforms made from that stream
    // (media.ts `process`: no local preview is made for them), or the
    // timeline shows plain blocks for every cloud clip, for good.
    if (!isFile(media.path) && media.cloud == null) continue;
    app.media.ensure(media.path, {
      kind: media.kind,
      duration: media.duration,
      width: media.width,
      height: media.height,
      fps: media.fps,
      has_audio: media.has_audio,
    });
  }
  return json({ rev: live.rev, project: live.project });
}

/** The footage the timeline plays that isn't here and can't be fetched: the editor says so. */
async function putProject(context: Context): Promise<Response> {
  const given = await body(context);
  const baseRev = field<number>(given, "base_rev", "u64");
  // The UI sends what changed (patch.ts) against the revision it has.
  if (given.project === undefined && given.patch !== undefined) {
    const live = liveOr404(context.app, context.params.id!);
    if (baseRev !== null && live.rev !== baseRev) {
      return json({ error: "conflict", rev: live.rev, project: live.project }, 409);
    }
    try {
      given.project = patches.apply(live.project, given.patch as patches.Patch);
    } catch (error) {
      throw bad(`that change doesn't fit the project: ${diag.messageOf(error)}`);
    }
  }
  if (given.project === undefined) throw badShape("missing field `project`");
  if (typeof given.project !== "object" || given.project === null || Array.isArray(given.project)) {
    throw badShape(`project: invalid type: ${kindOf(given.project)}, expected struct Project`);
  }
  const origin = field<string>(given, "origin", "string") ?? "";
  try {
    const live = await context.app.store.replace(context.params.id!, baseRev, given.project as Project, origin);
    return json({ rev: live.rev });
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    // Read as a Project before anything else, as axum's extractor did (only looked at
    // when the save fails, so a good save doesn't parse the project twice).
    if (error.kind === "invalid" || error.kind === "conflict") projectShape(context.app, given.project);
    switch (error.kind) {
      case "not_found":
        throw notFound("no such project");
      case "invalid":
        throw bad(error.message);
      // A cloud project someone else is editing (`cloud_projects`).
      case "refused":
        throw new ApiError(423, error.message);
      case "conflict":
        return json({ error: "conflict", rev: error.live?.rev, project: error.live?.project }, 409);
    }
  }
}

/**
 * A PUT's project that serde couldn't read as a Project, refused as axum's
 * Json extractor refused it (before the revision is looked at): 422, the path
 * serde_path_to_error gives ("project.clips[0].start"; inside a clip's
 * flattened content, the clip) and the place in the body (withPosition).
 */
function projectShape(app: App, project: unknown): void {
  const text = JSON.stringify(project);
  const problem = app.native.projectLoad(text).problem;
  const prefix = "it can't be read: ";
  if (problem === undefined || !problem.startsWith(prefix)) return;
  const placed = /^([\s\S]*) at line 1 column (\d+)$/.exec(problem.slice(prefix.length));
  if (placed === null) return;
  // serde's column counts bytes; the scan counts characters.
  const end = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, Number(placed[2]))).length;
  const path = pathEndingAt(text, end) ?? [];
  throw badShape(`${showPath(["project", ...path])}: ${placed[1]}`);
}

async function deleteProject({ app, params }: Context): Promise<Response> {
  const id = params.id!;
  // A cloud project goes from the cloud first (refused while someone else
  // edits it or the cloud can't be reached); one only there, only there.
  const local = app.store.get(id) !== null;
  const why = app.store.unavailable(id);
  if (why !== null) throw new ApiError(403, why);
  let inCloud = false;
  if (app.store.cloud() !== null) {
    try {
      inCloud = await seams.cloudProjects.delete(app, id);
    } catch (error) {
      throw new ApiError(409, diag.messageOf(error));
    }
  }
  // Its effects' renders in the cloud (effect_cloud.ts) go with it: made again from their code if it's ever brought back.
  const renders = app.store.get(id)?.project.media.map((media) => media.cloud?.original) ?? [];
  void effectCloud.forgetProject(app, id, renders).catch((error: unknown) => diag.warn("effects", `${id}: its renders in the cloud: ${diag.messageOf(error)}`));
  if (!local && inCloud) return json({ ok: true });
  if (app.store.delete(id)) return json({ ok: true });
  throw notFound("no such project");
}

// ---------------------------------------------------------------------------
// Media in

async function importMedia(context: Context): Promise<Response> {
  const given = await body(context);
  const paths = given.paths;
  if (paths === undefined) throw badShape("missing field `paths`");
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    throw badShape("paths: invalid type, expected a sequence of strings");
  }
  const place = field<boolean>(given, "place", "boolean") ?? false;
  const origin = field<string>(given, "origin", "string") ?? "";
  if (paths.length === 0) throw bad("no paths");
  const id = context.params.id!;
  let imported;
  try {
    imported = await importPaths(context.app, id, paths as string[], place, origin);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  const [rev, added, errors] = imported;
  const project = context.app.store.get(id)?.project ?? null;
  // What the person added, for the agent's context (uploads.ts).
  try {
    const dir = context.app.store.uploadsDir(id);
    for (const mediaId of added) uploads.remember(dir, { at: Date.now(), name: project?.media.find((one) => one.id === mediaId)?.name ?? mediaId, media: mediaId, file: null });
  } catch (error) {
    diag.warn("upload", `noting what was added: ${diag.messageOf(error)}`);
  }
  return json({ rev, added, errors, project });
}

/** Footage from a Google Drive folder or file link (drive_import.ts): downloaded, then imported as `import` does. */
async function importDriveMedia(context: Context): Promise<Response> {
  const given = await body(context);
  const url = field<string>(given, "url", "string", true);
  const place = field<boolean>(given, "place", "boolean") ?? true;
  const origin = field<string>(given, "origin", "string") ?? "";
  const id = context.params.id!;
  liveOr404(context.app, id);
  let imported;
  try {
    // A job of its own (drive_import.ts), which notes what was added before it ends, so a restart meanwhile carries it on.
    imported = await importDrive(context.app, id, url, place, origin);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  const [rev, added, errors] = imported;
  return json({ rev, added, errors, project: context.app.store.get(id)?.project ?? null });
}

/** `dir/name`, or `dir/name-2.ext`, `-3`… if taken (made empty, so two uploads never pick one name). */
export async function reserveUpload(dir: string, name: string): Promise<string> {
  const stem = fileStem(name) ?? "upload";
  const ext = extension(name) ?? "";
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? name : ext === "" ? `${stem}-${n}` : `${stem}-${n}.${ext}`);
    try {
      const handle = await fs.promises.open(candidate, "wx");
      await handle.close();
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

/** Streams a file from the browser's device to disk, then imports it. The body is never buffered, so multi-GB footage is fine. */
async function uploadMedia(context: Context): Promise<Response> {
  const { app, params } = context;
  const id = params.id!;
  const given = requiredQuery(context, "name");
  const size = u64Query(context, "size");
  const origin = context.query.get("origin") ?? "";
  liveOr404(app, id);
  const name = fileName(given)?.trim() ?? "";
  if (name === "" || name.startsWith(".")) throw bad("invalid file name");
  let dir: string;
  try {
    dir = app.store.uploadsDir(id);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw bad(ioMessage(error));
  }
  const limit = 100 * 1024 ** 3;
  if (size !== null && (size === 0 || size > limit)) {
    throw new ApiError(413, `upload must be between 1 and ${limit} bytes`);
  }
  let target: string;
  try {
    target = await reserveUpload(dir, name);
  } catch (error) {
    throw bad(ioMessage(error));
  }
  const temporary = `${target}.uploading`;
  let keepTarget = false;
  try {
    try {
      await uploads.receive(context.request, temporary, size, limit);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw bad(`upload of ${name} failed: ${error instanceof Error && "code" in error ? ioMessage(error) : diag.messageOf(error)}`);
    }
    // Any file (Oct 31): media as it is or converted (a HEIC a PNG, a WMV an MP4), anything else kept as the project's file.
    const how = await uploads.plan(target, join(dir, "converted"));
    if ("file" in how) {
      const files = join(dir, "files");
      fs.mkdirSync(files, { recursive: true });
      let kept = join(files, name);
      for (let n = 2; fs.existsSync(kept); n++) kept = join(files, name.replace(/(\.[^.]+)?$/, (ext) => ` ${n}${ext}`));
      fs.renameSync(target, kept);
      keepTarget = true;
      uploads.remember(dir, { at: Date.now(), name, media: null, file: kept });
      const live = app.store.get(id);
      return json({ rev: live?.rev ?? 0, added: [], project: live?.project ?? null, file: name });
    }
    let imported;
    try {
      imported = await importPaths(app, id, [how.media], false, origin === "" ? "upload" : origin);
    } catch (error) {
      throw bad(diag.messageOf(error));
    }
    const [rev, added, errors] = imported;
    const first = errors[0];
    if (first !== undefined) throw bad(first);
    const project = app.store.get(id)?.project ?? null;
    // Converted: the media is the copy Edit reads; the dropped file isn't kept beside it.
    keepTarget = how.from === undefined;
    if (added[0] !== undefined) uploads.remember(dir, { at: Date.now(), name, media: added[0], file: null, ...(how.from === undefined ? {} : { from: how.from }) });
    // Cloud mode: footage that went up (edited from its proxy now) needs no
    // copy here. Sounds and pictures stay where they are (`cloud_media`).
    const media = added[0] === undefined ? undefined : project?.media.find((item) => item.id === added[0]);
    if (media?.cloud !== undefined && media.cloud !== null && fs.existsSync(how.media) && media.path !== canonical(how.media)) {
      // Once it's gone up (the import answered before the upload finished);
      // kept while it hasn't, as the only copy of the original.
      seams.cloudMedia.removeWhenUploaded(canonical(how.media));
    }
    return json({ rev, added, project });
  } finally {
    if (!keepTarget) fs.rmSync(target, { force: true });
  }
}

/** A file's version: its length and modification time (a remade preview is a new stamp). */
export function fileStamp(path: string): string | null {
  try {
    const meta = fs.statSync(path, { bigint: true });
    return `${meta.size.toString(16)}-${(meta.mtimeNs / 1_000_000n).toString(16)}`;
  } catch {
    return null;
  }
}

function mediaStatus({ app, params }: Context): Response {
  const live = liveOr404(app, params.id!);
  const statuses: Record<string, unknown> = {};
  for (const media of [...live.project.media].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const status = app.media.status(media.path) as unknown as Record<string, unknown>;
    // Which version of each preview file is there: the client puts it in the
    // file's URL, so the browser can keep what it read for good.
    const paths = app.media.paths(media.path);
    statuses[media.id] = { ...status, stamps: { light: fileStamp(paths.light), preview: fileStamp(paths.proxyDone) } };
  }
  return json({ media: statuses });
}

async function mediaFile(context: Context): Promise<Response> {
  const { app, params } = context;
  const live = liveOr404(app, params.id!);
  const media = live.project.media.find((item) => item.id === params.media);
  if (media === undefined) throw notFound("no such media");
  const kind = params.kind!;
  // Cloud playback always reads R2, even while an obsolete local preview exists.
  if (cloudMedia.streamKey(media.cloud, kind) !== null) {
    const streamed = await cloudMedia.streamFromCloud(context.request, media.cloud, kind);
    if (streamed === null) throw new ApiError(503, "cloud previews need Edit's cloud connection");
    return streamed;
  }
  const source = media.path;
  const paths = app.media.paths(source);
  // `v=<preview|light>~<stamp>`: the URL names one version of the file, so
  // when it's that version the browser may keep it (no round trip to check).
  const raw = context.url.search.replace(/^\?/, "");
  const named = raw
    .split("&")
    .find((pair) => pair.startsWith("v="))
    ?.slice(2)
    .replaceAll("%7E", "~")
    .replaceAll("%7e", "~");
  let lasting = false;
  const tilde = named?.indexOf("~") ?? -1;
  if (named !== undefined && tilde >= 0) {
    const which = named.slice(0, tilde);
    const stamp = named.slice(tilde + 1);
    if (which === "light" && kind === "light") lasting = fileStamp(paths.light) === stamp;
    else if (which === "preview" && (kind === "proxy" || kind === "audio")) lasting = fileStamp(paths.proxyDone) === stamp;
  }
  let file: string;
  switch (kind) {
    // Until the proxy exists, stream the original (fine for H.264/HEVC MP4/MOV).
    // One URL, one file: the page names the preview it reads (`v=preview~…`),
    // else it reads the source, even once a preview appears under it (the
    // page's cached blocks of one file read as another's stalled its decoder).
    case "proxy":
    case "audio": {
      const proxy = kind === "proxy" ? paths.proxy : paths.audio;
      // ("preview" with no stamp: a status that came without one, as nightly-17 served it.)
      const preview = named === undefined || named === "preview" || named.startsWith("preview~");
      file = preview && isFile(paths.proxyDone) && isFile(proxy) ? proxy : source;
      break;
    }
    // Only once it exists: the client asks for it by name when it's ready, so
    // one URL never serves two different files.
    case "light":
      file = paths.light;
      break;
    case "thumbs":
      file = paths.thumbs;
      break;
    case "peaks":
      file = paths.peaks;
      break;
    case "transcript":
      // Transcripts from before speaker names get them now.
      try {
        seams.speakers.ensure(app, source);
      } catch (error) {
        diag.warn("speakers", `${source}: ${diag.messageOf(error)}`);
      }
      file = paths.transcript;
      break;
    default:
      throw notFound("unknown media file");
  }
  if (!isFile(file)) {
    // Not on this Mac yet: its bytes come from R2 through here, and its proxy
    // comes down now, ahead of the project's others.
    const streamed = await cloudMedia.streamFromCloud(context.request, media.cloud, kind).catch((error: unknown) => {
      diag.warn("cloud", `streaming ${media.name}: ${diag.messageOf(error)}`);
      return null;
    });
    if (streamed !== null) return streamed;
    throw notFound("not ready");
  }
  let response = serveFile(context.request, file);
  if (kind === "peaks") {
    // Bun names an octet-stream file in a content-disposition header; tower's ServeFile
    // doesn't. The peaks are small: sent as bytes, the header stays out.
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/octet-stream");
    const body = response.body === null ? null : new Uint8Array(await response.arrayBuffer());
    response = new Response(body, { status: response.status, headers });
  }
  // Never the original standing in while the preview is missing.
  const keep = lasting && file !== media.path && response.status >= 200 && response.status < 300;
  response.headers.set("cache-control", keep ? "private, max-age=31536000, immutable" : "no-cache");
  return response;
}

// ---------------------------------------------------------------------------
// Frames and exports

/**
 * The UI's frame renders in flight. The renderer refuses past 8 waiting, and
 * the home screen asks for every project's cover at once: the rest wait here.
 */
const uiFrames = new Semaphore(4);

async function framePng(context: Context): Promise<Response> {
  const { app, params } = context;
  const text = params.frame!.replace(/(\.png)+$/, "");
  if (!/^[+-]?\d+$/.test(text)) throw bad("frame must be a number");
  const frame = Number(text);
  const max = u32Query(context, "max");
  const live = liveOr404(app, params.id!);
  let images;
  try {
    await seams.cloudMedia.restoreStills(app, live.project);
    images = await withProjectAsync(
      live.project.id,
      live.rev,
      () => jsonForSerde(live.project),
      (project) =>
        uiFrames.with(() => app.native.renderFrames({ project, frames: [frame], maxSide: max ?? 0, priority: "ui", encode: "png" })),
    );
  } catch (error) {
    throw new ApiError(500, diag.messageOf(error));
  }
  const image = images[0];
  if (image === undefined) throw new ApiError(500, "the frame didn't render");
  // `v` names the project's version (its modified time): a picture of it can
  // be kept, so a revisit renders nothing.
  const headers: Record<string, string> = { "content-type": "image/png" };
  if (context.query.has("v")) headers["cache-control"] = "private, max-age=86400";
  return new Response(image.data, { headers });
}

async function startExport(context: Context): Promise<Response> {
  const { app, params } = context;
  const id = params.id!;
  const given = (await optionalBody(context)) ?? {};
  const path = field<string>(given, "path", "string");
  const drive = field<boolean>(given, "drive", "boolean");
  // The Share dialog's Export: the file on this computer and nowhere else (no copy for the cloud).
  const keepLocal = field<boolean>(given, "keepLocal", "boolean");
  // A channel's watermark over it (channel_marks.ts): its picture's id in the Watermarks folder.
  const watermark = field<string>(given, "watermark", "string");
  const asked = given.options;
  if (asked !== undefined && (typeof asked !== "object" || asked === null || Array.isArray(asked))) {
    throw badShape(`options: invalid type: ${kindOf(asked)}, expected struct ExportOptions`);
  }
  const options: ExportOptions = { ...app.native.exportDefaults(), ...((asked ?? {}) as Partial<ExportOptions>) };
  if (options.wait_for_smoothing) {
    let done = true;
    try {
      done = await seams.broll.waitForSmoothing(id, 120_000);
    } catch (error) {
      if (!seams.isUnavailable(error)) throw error;
    }
    if (!done) {
      throw bad(
        "optional optical flow is still running; export the current timeline with wait_for_smoothing false or wait for it to finish",
      );
    }
  }
  const output = path !== null && path.trim() !== "" ? expandHome(path) : defaultExportPath(app.store, liveOr404(app, id).project);
  // A path given on a drive or in Desktop: macOS may ask first, and the export writes there synchronously.
  await folderAccess.reachForRoute([output]);
  // Taken once what it shows is ready (the edit as it is then), however long its effects and map shots take.
  // A channel's project carries its channel's own logo, or none (channels.watermarkFor).
  const mark = await channels.watermarkOf(liveOr404(app, id).project, watermark === null || watermark === "" ? undefined : watermark);
  return whenReady(app, id, app.native.withExtension(output, options.format), () =>
    app.exports.start(app.store, app.library, liveOr404(app, id).project, options, output, { ...(drive === null ? {} : { drive }), ...(keepLocal === true ? { keepLocal: true } : {}), ...(mark === undefined ? {} : { watermark: mark }) }),
  );
}

/** How long an export asked for here waits for its effects' renders and map shots: as long as a share waits (reviews.ts `exportStep`). */
const READY_WAIT_MS = 20 * 60_000;
/** Waited for in the request before the rest goes on in the background. */
const READY_QUICK_MS = 5000;

/**
 * Starts an export (`go`, which answers its file) once what it shows is
 * ready: a coded effect rendered from its code, a map shot made (broll.ts
 * `waitForMaps`), else it would go out as their stand-ins. Most are ready at
 * once; one still rendering is waited for as a share waits, in the
 * background, the export's row saying so, and the export starts when it's
 * done (or says why it can't). The answer is the file (`expected` while it
 * waits), and `started` when it went on waiting.
 */
async function whenReady(app: App, id: string, expected: string, go: () => Promise<string>): Promise<Response> {
  // What it waits on is what isn't rendered now: its steps count those (export_steps.ts).
  effects.noteWait(app, id);
  // In the Exports queue from now, with its graphics' steps, until it starts.
  const held = exportSteps.waitBegins(id, expected);
  const wait = (limit: number) =>
    seams.broll.waitForMaps(app, id, limit).catch((error: unknown) => {
      if (!seams.isUnavailable(error)) throw error;
    });
  let waiting = false;
  try {
    await wait(READY_QUICK_MS);
  } catch (error) {
    // Only what's still being made is waited for; a render that failed says why at once.
    if (!/still rendering|waiting behind/.test(diag.messageOf(error))) {
      exportSteps.waitEnds(id, held);
      throw bad(diag.messageOf(error));
    }
    waiting = true;
  }
  if (!waiting) {
    try {
      // Cancelled in its first seconds: nothing to start.
      if (held.cancelled) return json({ path: expected, cancelled: true });
      return json({ path: await go() });
    } catch (error) {
      throw bad(diag.messageOf(error));
    } finally {
      exportSteps.waitEnds(id, held);
    }
  }
  const row = (state: "queued" | "failed", extra: Record<string, unknown>) => app.store.emit({ type: "export", id, state, progress: 0, path: expected, ...extra });
  // How far its effects' renders are, said as they go (Sphe, Nov 16: "I don't know how long that's going to take").
  let said = "";
  const tell = () => {
    const line = effects.renderingLine(id) ?? removalSchedule.exportLine(id) ?? "waiting for its effects to render";
    if (line !== said) row("queued", { waiting: (said = line) });
  };
  tell();
  const ticking = setInterval(() => {
    if (held.cancelled) {
      clearInterval(ticking);
      return;
    }
    tell();
  }, 1000);
  void (async () => {
    try {
      await wait(READY_WAIT_MS);
      clearInterval(ticking);
      // Cancelled while it waited: nothing to start.
      if (held.cancelled) return;
      await go();
      exportSteps.waitEnds(id, held);
    } catch (error) {
      clearInterval(ticking);
      exportSteps.waitEnds(id, held);
      if (held.cancelled) return;
      const said = diag.messageOf(error);
      diag.warn("export", `${id}: ${said}`);
      row("failed", { error: said });
    }
  })();
  return json({ path: expected, started: true });
}

function cancelExport({ app, params }: Context): Response {
  const id = params.id!;
  // Still waiting for its graphics: it never starts (the renders go on: the edit plays them).
  if (exportSteps.cancelWait(id)) {
    app.store.emit({ type: "export", id, state: "cancelled", progress: 0 });
    return json({ cancelled: true });
  }
  return json({ cancelled: app.exports.cancel(id) });
}

/** Runs a failed or cancelled export again, the way it was started. A share's export is shared again. */
async function retryExport({ app, params }: Context): Promise<Response> {
  const id = params.id!;
  liveOr404(app, id);
  const held = app.exports.replay?.(id) ?? null;
  // A share that failed after its export carries on from where it stopped; its export isn't made again.
  let again: Promise<{ url: string; version: number }> | null = null;
  try {
    again = reviews.retryShare(app, id);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  if (again === null && held === null) throw bad("nothing to retry");
  if (again !== null || held?.extra.share === true) {
    const started = again ?? reviews.exportAndShare(app, id, held!.options, held!.extra.replace === true, held!.extra.note, held!.extra.watermark);
    started.catch((error: unknown) => {
      const message = diag.messageOf(error);
      if (message === "the share was cancelled" || message === "the export was cancelled") return;
      diag.warn("review", `sharing ${id} again: ${message}`);
    });
    const first = await Promise.race([
      started.then((done) => ({ done })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]).catch((error: unknown) => {
      throw bad(diag.messageOf(error));
    });
    return json(first === null ? { started: true } : first.done);
  }
  // Waited for as the first try was: what it shows ready, then the edit as it is.
  return whenReady(app, id, held!.output, () => app.exports.start(app.store, app.library, liveOr404(app, id).project, held!.options, held!.output, held!.extra));
}

/** The project's exports, newest first (this machine's: each downloads from Edit, on the Mac or over Tailscale). */
function projectExports({ app, params }: Context): Response {
  return json(listExports(app.store.home, params.id!));
}

/** Deletes one of the project's exports (its file and its place on the list). */
async function deleteProjectExport(context: Context): Promise<Response> {
  const given = await body(context);
  const path = field<string>(given, "path", "string", true);
  try {
    deleteExport(context.app.store.home, context.params.id!, path);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  return json(listExports(context.app.store.home, context.params.id!));
}

/** Saves the exports folder. Future exports go there. */
async function setExportFolder(context: Context): Promise<Response> {
  const given = await body(context);
  const path = field<string>(given, "path", "string", true);
  // A folder on a drive, or Desktop's: macOS may ask first, and saving looks at it synchronously.
  await folderAccess.reachForRoute([expandHome(path.trim())]);
  try {
    return json(saveExportFolder(context.app.store.home, path));
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
}

/** A finished export, downloaded to the device the editor is open on. */
async function exportedFile(context: Context): Promise<Response> {
  const path = requiredQuery(context, "path");
  if (!context.app.exports.exported(path)) throw notFound("not an export from this session");
  const name = fileName(path)?.replaceAll('"', "'") ?? "export";
  if (!isFile(path)) {
    // Archived after upload: hand out the verified cloud copy instead.
    const key = cloudKeyFor(context.app.store.home, path);
    if (key !== null) return Response.redirect(await cloud.presign(key, "GET"), 302);
    throw notFound("not an export from this session");
  }
  const response = serveFile(context.request, path);
  response.headers.set("content-disposition", `attachment; filename="${name}"`);
  return response;
}

