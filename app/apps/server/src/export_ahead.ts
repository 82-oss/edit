// Exports made ahead, before anyone asks (Nov 6 plan, "exports ready before
// Export is pressed"): JJ's full exports took 15–33 minutes, 2.5–16.5 of them
// cutting the footage from the cloud and most of the rest the Mac's one video
// encoder, while re-exporting an edit whose chunks were made took 2 min 47 s
// (Cops Realize, Nov 6: 31 min 52 s the first time). So once a project's
// edits rest, its export is made here in the background with the settings its
// next share uses (reviews' `shareOptions`, the YouTube preset, and the
// watermark the dialog will offer: `nextWatermark`, its channel's for a
// channel's project even before its first share) into `<cache>/ahead/<id>.mp4`;
// its manifest then names that file, and the export or share someone asks for
// copies every chunk that didn't change out of it and renders only the rest.
//
// It takes the encoder only when nothing else wants it (exports.ts
// `startAhead`: no export rendering or waiting, room for it now) and gives it
// up to anything that asks: an export or share (of any project), or smooth
// playback for someone watching; what it made is kept and it carries on from
// there next time. Nothing lists it, nothing waits on it, and it never keeps
// the Mac awake. Not on battery, not while the project's slowed shots are
// still being smoothed, its footage cleaned or its effects rendered (each
// would change the picture), and not for an edit its last export already shows.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as channels from "./channels.ts";
import * as diag from "./diag.ts";
import * as effects from "./effects.ts";
import { aheadFile, type ExportRegistry, listExports, optionsKey, timelineHash, withWatermarkKey } from "./exports.ts";
import type { ExportOptions, Project } from "./model.ts";
import { native } from "./native/index.ts";
import * as playing from "./playing.ts";
import { duration } from "./project.ts";
import * as removalSchedule from "./removal_schedule.ts";
import { nextWatermark, read as reviewState } from "./reviews.ts";
import * as seams from "./seams.ts";
import { THE_MACHINE } from "./machine.ts";
import * as tools from "./tools.ts";

/**
 * How long a project's edits rest before its export is made ahead, and how long a play goes on before one being made
 * stops for it (`playMs`; tests make them quick). `pmset` is the program asked about the battery (tests: a stand-in).
 */
export const hooks = { restMs: 2 * 60_000, playMs: 5_000, pmset: "pmset", onBattery: (): Promise<boolean> | boolean => onBattery() };

type Ahead = Pick<ExportRegistry, "startAhead" | "aheadFor" | "stopAhead">;

/**
 * The settings `project`'s next share or export exports with (reviews.exportAndShare, the dialog's: the house YouTube
 * export at the edit's own size and shape), and the watermark it carries (reviews.nextWatermark, the dialog's too).
 */
export function nextShare(home: string, project: Pick<Project, "id" | "style" | "channel">): { options: ExportOptions; watermark: string | undefined } {
  const state = reviewState(home);
  const settings = state.shareOptions?.[project.id] ?? {};
  const options = { ...native().exportDefaults(), ...settings, preset: "youtube", range: null, chapters: [] } as ExportOptions;
  return { options, watermark: nextWatermark(home, project, state) };
}

/** Whether `project`'s export made ahead, or its last export, already shows it as `options` (with `watermark`) would. */
export function upToDate(home: string, cache: string, project: Project, options: ExportOptions, watermark: string | undefined): boolean {
  const timeline = timelineHash(project);
  const wanted = withWatermarkKey(optionsKey(options), watermark);
  try {
    const made = JSON.parse(fs.readFileSync(`${aheadFile(cache, project.id)}.json`, "utf8")) as { timeline?: string; options?: string };
    if (made.timeline === timeline && made.options === wanted && fs.existsSync(aheadFile(cache, project.id))) return true;
  } catch {
    // None made ahead.
  }
  // Exported as it is since its last change: nothing to make (its record doesn't keep its options, so any whole export of this picture counts).
  return listExports(home, project.id).some((one) => one.whole && one.timeline === timeline);
}

/** Whether this machine runs on its battery now (pmset; Linux's power supplies); false when it can't tell. */
async function onBattery(): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const supplies = fs.readdirSync("/sys/class/power_supply");
      const read = (name: string, what: string) => fs.readFileSync(`/sys/class/power_supply/${name}/${what}`, "utf8").trim();
      return supplies.some((name) => name.startsWith("BAT") && read(name, "status") === "Discharging");
    } catch {
      return false;
    }
  }
  if (process.platform !== "darwin") return false;
  // Asked once a minute at most: every project's rest ends here.
  if (battery !== null && Date.now() - battery.at < 60_000) return battery.on;
  asking ??= pmsetSaysBattery().then((on) => {
    battery = { on, at: Date.now() };
    return on;
  }).finally(() => {
    asking = null;
  });
  return asking;
}

/** pmset's last answer, and when; the ask under way. */
let battery: { on: boolean; at: number } | null = null;
let asking: Promise<boolean> | null = null;

/**
 * Whether pmset says this Mac draws from its battery. Asked off the server's thread (Nov 21: `spawnSync` once a
 * minute waited up to its 2 s on it, every page and play with it); a pmset that fails, or hasn't answered in 2 s and
 * is ended, is "can't tell" (false), as before.
 */
export async function pmsetSaysBattery(): Promise<boolean> {
  try {
    const out = new TextDecoder().decode(await tools.run([hooks.pmset, "-g", "batt"], { timeoutMs: 2000 }));
    return out.includes("'Battery Power'");
  } catch {
    return false;
  }
}

function agentsWorking(app: App): boolean {
  return (app.agents as { hasRunningTurns?: () => boolean }).hasRunningTurns?.() === true;
}

/** Makes `id`'s export ahead if it's worth it now; why not, when it isn't (for the log and tests). */
export async function tryNow(app: App, id: string): Promise<string | null> {
  const registry = app.exports as Partial<Ahead>;
  if (registry.startAhead === undefined) return "no exports here";
  const nothing = (live: ReturnType<App["store"]["get"]>): string | null => {
    if (live === null) return "gone";
    if (duration(live.project) <= 0 || !live.project.clips.some((clip) => clip.type === "video")) return "nothing to export";
    return null;
  };
  const before = nothing(app.store.get(id));
  if (before !== null) return before;
  if (await hooks.onBattery()) return "on battery";
  // The one wait (pmset, off the thread): the edit as it is once it's answered.
  const live = app.store.get(id);
  if (live === null) return "gone";
  const after = nothing(live);
  if (after !== null) return after;
  const project = live.project;
  // Its footage downloads and encoding would slow every agent's frames (Nov 6: four review fixes, each look at the edit 1–3 minutes).
  if (agentsWorking(app)) return "an agent is working";
  let pending: string[] = [];
  try {
    pending = seams.broll.smoothingPending(id, project);
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  if (pending.length > 0) return "slowed shots still smoothing";
  // Its picture is still changing: each cleaned piece and each effect's render lands in it, and an export made of it
  // now is thrown away (Nov 18, Sphe's M4: 7–8 GB made ahead of an edit still being cleaned, twice in a night).
  if (removalSchedule.progressOf(id).out > 0) return "its footage still being cleaned";
  if (effects.notReady(app.store, project) !== null) return "its effects still rendering";
  // It reads every original from R2: not while a play or footage someone waits on has the link (playing.ts).
  if (!playing.isIdle()) return "the link is the person's";
  // A channel's project whose channel isn't read yet: its watermark isn't known, and one made without it is wasted.
  if (typeof project.channel === "string" && project.channel !== "" && channels.channelOf(project) === null) {
    void channels.refresh();
    return "its channel not read yet";
  }
  const { options, watermark } = nextShare(app.store.home, project);
  if (upToDate(app.store.home, app.store.cacheDir(), project, options, watermark)) return "up to date";
  let other: string | null;
  try {
    other = registry.aheadFor!();
  } catch (error) {
    if (seams.isUnavailable(error)) return "no exports here";
    throw error;
  }
  if (other !== null) return other === id ? "already making it" : "making another's";
  return registry.startAhead(app.store, app.library, project, options, aheadFile(app.store.cacheDir(), id), watermark) ? null : `${THE_MACHINE} is busy`;
}

/**
 * Footage someone waits on to open a project (footage_ready.ts): an export being made ahead stops, as it does when its
 * edit changes (what it made is kept, and reused), and is looked at again after another rest.
 */
export function giveWay(app: App): void {
  stopMaking(app, "while footage is waited on");
}

/** The export being made ahead, if one is, stops `why` and is looked at again after another rest. */
function stopMaking(app: App, why: string): void {
  const registry = app.exports as Partial<Ahead> | undefined;
  let making: string | null = null;
  try {
    making = registry?.aheadFor?.() ?? null;
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  if (making === null) return;
  diag.info("export", `${making}: making its export ahead stops ${why}`);
  void registry?.stopAhead?.(making);
  changed(app, making);
}

/**
 * A play that goes on stops the export being made ahead (Nov 21: it looked only before it started that nobody played,
 * then kept the encoder, the decoders and the link to R2 through a play begun after). Not at the play's first word: a
 * press of Play and Pause within `hooks.playMs` leaves it be. Stopped, it keeps every chunk it finished (the engine's
 * chunk folder, which its next run and the export someone asks for copy from) and loses the chunk it was on, or its
 * join and sound if it had got that far; it's looked at again after another rest, and waits while the play goes on
 * ("the link is the person's").
 */
export function watchPlays(app: App): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = playing.onChange((now) => {
    clearTimeout(timer);
    timer = undefined;
    if (!now) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (playing.isPlaying()) stopMaking(app, "for a play");
    }, hooks.playMs);
    timer.unref?.();
  });
  return () => {
    clearTimeout(timer);
    off();
  };
}

/** Projects whose edits are resting, each with its timer. */
const resting = new Map<string, ReturnType<typeof setTimeout>>();

/** `id` changed (or its agent's turn ended): its export is made ahead once it rests, after an older one of it stops. */
function changed(app: App, id: string): void {
  const timer = resting.get(id);
  if (timer !== undefined) clearTimeout(timer);
  const registry = app.exports as Partial<Ahead>;
  // Being made of an older picture, or of any while an agent works: stopped (what it made is kept, and reused by the next).
  const making = registry.aheadFor?.() ?? null;
  if (making !== null && (making === id || agentsWorking(app))) void registry.stopAhead?.(making);
  const wait = (): void => {
    const later = setTimeout(async () => {
      resting.delete(id);
      let why: string | null;
      try {
        why = await tryNow(app, id);
      } catch (error) {
        diag.warn("export", `${id}: making its export ahead: ${diag.messageOf(error)}`);
        return;
      }
      if (why === null) diag.info("export", `${app.store.get(id)?.project.name ?? id}: making its export ahead, for the next export or share`);
      // Busy, smoothing or making another's: looked at again after another rest.
      else if (why === `${THE_MACHINE} is busy` || why === "slowed shots still smoothing" || why === "its footage still being cleaned" || why === "its effects still rendering" || why === "making another's" || why === "an agent is working" || why === "the link is the person's" || why === "its channel not read yet") wait();
    }, hooks.restMs);
    later.unref?.();
    resting.set(id, later);
  };
  wait();
}

/** Watches this Mac's edits: an agent's turn, or a change made here (not one pulled from another Mac's cloud copy). Never on a trial server. */
export function start(app: App): void {
  if (process.env.EDIT_TRIALS === "1") return;
  watchPlays(app);
  app.store.subscribe((event) => {
    if (event.type === "project" && typeof event.id === "string" && event.origin !== "cloud") changed(app, event.id);
    else if (event.type === "agent" && event.event === "status" && event.running === false && typeof event.project === "string") changed(app, event.project.split("~")[0]!);
  });
}
