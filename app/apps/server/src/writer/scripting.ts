// Claude's work on a script, each run as a job (jobs.ts): writing it,
// changing it on the producer's request, and hearing a captioned script's
// chosen footage exactly before cutting it again. Each reads the script
// again before saving, so what the producer edited meanwhile stays, and
// says in the chat what it did or why it couldn't.

import type { Clip, Focus, Kind, Research, Script, StampedDate } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import * as lanes from "../lanes.ts";
import * as styles from "../script_styles.ts";
import * as otherProjects from "../other_projects.ts";
import { join } from "../paths.ts";
import { probe as probeFile } from "../media.ts";
import { isFile } from "../paths.ts";
import * as build from "./build.ts";
import * as casefiles from "./casefiles.ts";
import * as chat from "./chat.ts";
import * as house from "./house.ts";
import * as cloud from "./cloud.ts";
import * as commentary from "./commentary.ts";
import { checkClips } from "./edits.ts";
import * as exact from "./exact.ts";
import { afterCredit, creditBack, footageFor, footagePath, soon as hearSoon, unsigned } from "./exact_after.ts";
import { checkStopped, type Job, type Outcome, named } from "./jobs.ts";
import * as lessonNote from "./lesson_note.ts";
import { lessonsText } from "./lessons.ts";
import * as media from "./media.ts";
import * as missingFootage from "./missing.ts";
import { nameVoices } from "./naming.ts";
import { clock, ensureIds } from "./paragraphs.ts";
import { compile, isTaught, type Plan } from "./plan.ts";
import * as research from "./research.ts";
import * as reuse from "./reuse.ts";
import { revise, type Tools } from "./revise.ts";
import * as fixing from "./fixing.ts";
import * as reviews from "./reviews.ts";
import * as turnTools from "./turn_tools.ts";
import * as stamp from "./stamp.ts";
import * as store from "./store.ts";
import { keepPeaks, readPeaks } from "./tidy.ts";
import * as versions from "./versions.ts";
import { THIS_MACHINE } from "../machine.ts";
import { kindOf } from "../failure.ts";

const CHANGED = "The script changed while Claude was editing it, so nothing was applied. Ask again.";

/** The footage's 20 ms peaks, kept beside the script once read: transcription saves them, and a script made before that reads them once from its footage. */
export async function peaksOf(dir: string, script: Script, signal?: AbortSignal): Promise<Float32Array> {
  const kept = readPeaks(dir);
  if (kept !== null) return kept;
  let read: Float32Array;
  try {
    read = await media.peaks(footagePath(dir, script), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return new Float32Array();
  }
  if (read.length > 0) keepPeaks(dir, read);
  return read;
}

/** Each recording's date stamp, read off its footage here or the cloud's preview; none when neither is to hand. */
async function footageStamps(data: string, dir: string, script: Script, signal?: AbortSignal): Promise<StampedDate[]> {
  const original = script.originalPath !== "" && isFile(script.originalPath);
  let footage: string | null = original ? script.originalPath : isFile(store.proxyPath(dir)) ? store.proxyPath(dir) : null;
  if (footage === null) footage = await cloud.previewUrl(data, script.id).catch(() => null);
  if (footage === null) return [];
  const size = await probeFile(footage).then((probe) => [probe.width ?? 0, probe.height ?? 0] as [number, number]).catch(() => [0, 0] as [number, number]);
  if (size[0] === 0 || size[1] === 0) return [];
  return await stamp.stampsOf(script, footage, size, signal);
}

/** The research the page lists: the case folder's PDFs first, then what was searched for. */
export function researchShown(dir: string): Research | null {
  const found = research.load(dir);
  if (found === null && !(casefiles.load(dir)?.read.length ?? 0)) return null;
  return casefiles.withDocuments(dir, found ?? { articles: [], queries: [], at: 0 });
}

/** Looks for the case's news again. */
export async function researchAgain(data: string, id: string, signal?: AbortSignal): Promise<Research> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (script.words.length === 0) throw new Error("Transcribe the footage before researching it.");
  return casefiles.withDocuments(dir, await research.run(script, dir, signal));
}

/** Saves the script after Claude's work on it, as a version of Claude's. */
function save(dir: string, before: Script, after: Script): void {
  after.revision++;
  after.updatedAt = Date.now();
  store.write(dir, after);
  versions.keep(dir, "claude", before, after);
}

/** Says a failure in the chat too (not a stop), then throws it. */
function failed(dir: string, job: Job, error: unknown): never {
  if (!job.signal.aborted) chat.add(dir, "editor", diag.messageOf(error), null, true);
  throw error;
}

/** Reused cases brought in whose moments weren't picked yet, picked before Claude's turn as Repack does; a failure leaves them out. */
async function pickReused(dir: string, script: Script, job: Job): Promise<Script> {
  if (!(script.parts ?? []).some((part) => part.reuse && !part.highlights)) return script;
  job.stage("Picking the reused cases' moments");
  await reuse.pickMissing(dir, job.signal).catch((error: unknown) => {
    if (job.signal.aborted) throw error;
  });
  return store.read(dir);
}

/**
 * Claude plans the whole script and the timeline is replaced with it. The
 * script is read again afterwards, so an edit made during the build to
 * anything but the timeline stays.
 */
/**
 * A build note that names one of the channel's script styles ("…in the Dr Insanity style") writes the script in it
 * from now on (script_styles.ts), as its default would be without one.
 */
async function styleNamed(dir: string, script: Script, note: string): Promise<Script> {
  if (!script.channel || note.trim() === "") return script;
  await lanes.refresh();
  const named = styles.namedIn(lanes.lessonsOf({ channel: script.channel, lane: "script" }), note);
  if (named === null || named.name === script.style) return script;
  diag.info("writer", `${named.title} style asked for in the note: ${script.title} is written in it`);
  return store.update(dir, (now) => void (now.style = named.name), true);
}

/**
 * A build note that asks to start from another channel's style ("start from Female Felons' script style") brings that
 * channel's Script lane into this one's own first, as the chat's other_channels would with bring "all", so the script
 * is written from it. A script's chat only opens once it's built, and an untaught channel's first script was written
 * plain before (Nov 25). `report`: what it brought (or why not), heading the build's report; `writer`: Edit's word to
 * the writer that the style asked for is the one it's given (the first build after one said "I don't have that style").
 * Both "" when the note asks none.
 */
/** The lessons of a style not brought, each with why, as the bring's report says it (CodeRabbit on #10). */
export function whyHeld(held: string[], unread: string[]): string {
  const own = held.filter((name) => !unread.includes(name));
  return [own.length > 0 ? `${own.join(", ")}, held back for this channel's own` : "", unread.length > 0 ? `${unread.join(", ")}, which couldn't be read just now` : ""].filter((part) => part !== "").join("; and ");
}

async function bringAsked(script: Script, note: string, job: Job): Promise<{ report: string; writer: string }> {
  const none = { report: "", writer: "" };
  if (!script.channel || script.commentary || note.trim() === "") return none;
  await lanes.refresh();
  const from = lanes.styleAskedFrom(script.channel, note);
  if (from === null) return none;
  const theirs = `${from.title}${/s$/i.test(from.title) ? "'" : "'s"}`;
  job.stage(`Bringing in ${theirs} script style`);
  try {
    const { said, brought, here, held, unread } = await lanes.otherChannelsOutcome(script.channel, "script", { channel: from.key, bring: "all" });
    diag.info("writer", `${named(script.id, script.title)}: ${from.title}'s script style asked for in the note: ${said.split("\n")[0]}`);
    // Only what was brought is said to be here: a lesson held back (it clashes with this channel's, or this channel has
    // its own of that name) is named, so the writer never takes this channel's for it.
    const writer =
      held.length === 0
        ? `(Edit's note: ${theirs} script style was brought into this channel's own before this build, so this channel's style you're given is the one asked for. Write from it, and don't say it's missing.)`
        : brought.length === 0 && here.length === 0
          ? `(Edit's note: ${theirs} script style was asked for, but none of it came into this channel's own: ${whyHeld(held, unread)}. Write from the style you're given, and say in your report that ${theirs} style wasn't brought.)`
          : `(Edit's note: ${theirs} script style was brought into this channel's own before this build, all but ${whyHeld(held, unread)}. Write from the style you're given.)`;
    return { report: `From ${from.title}: ${said}`, writer };
  } catch (error) {
    checkStopped(job);
    diag.warn("writer", `${named(script.id, script.title)}: ${from.title}'s script style wasn't brought in: ${diag.messageOf(error)}`);
    return { report: `${theirs} script style wasn't brought in: ${diag.messageOf(error)}`, writer: "" };
  }
}

/**
 * A build's note within its limit, checked before a style it asks for is brought, so nothing is kept for a build that
 * can't run (CodeRabbit on #10). A commentary's note keeps its own, longer limit (commentary.ts) and brings no style
 * (Codex on #10).
 */
export function checkBuildNote(script: Script, note: string): void {
  if (!script.commentary) build.checkNote(note);
}

export async function buildOnce(app: App, data: string, id: string, note: string, kind: Kind | undefined, job: Job): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  try {
    checkBuildNote(store.read(dir), note);
  } catch (error) {
    failed(dir, job, error);
  }
  const brought = await bringAsked(store.read(dir), note, job);
  let script = await styleNamed(dir, store.read(dir), note);
  if (script.commentary) return buildCommentary(data, dir, script, note, job);
  if (kind !== undefined && kind !== script.kind) {
    script.kind = kind;
    store.write(dir, script);
  }
  // Names for the voices, then the news about the case. Neither is needed to write the script, so neither can stop it.
  if (Object.keys(script.speakers ?? {}).length === 0) {
    job.stage("Naming the speakers");
    try {
      await nameVoices(script, false, job.signal);
      // Only the names and suspects are this step's to write.
      const now = store.read(dir);
      now.speakers = script.speakers ?? {};
      if (script.suspects) now.suspects = script.suspects;
      store.write(dir, now);
      script = now;
    } catch (error) {
      checkStopped(job);
      diag.warn("writer", `${named(id, script.title)}: the speakers weren't named: ${diag.messageOf(error)}`);
    }
  }
  // Only the producer's brief kept from the import isn't a search yet: the news is still looked for beside it.
  const searched = (found: Research) => found.queries.length > 0 || found.articles.some((article) => article.outlet !== research.BRIEF);
  const kept = research.load(dir);
  let found: Research;
  if (kept !== null && (kept.articles.length > 0 || kept.problem === undefined) && searched(kept)) found = kept;
  // The case folder's incident report gives the facts, as in Repack: no search.
  else if (casefiles.load(dir)?.read.some((document) => document.incidentReport)) found = { articles: [], queries: [], at: Date.now(), problem: "not searched: the case folder's incident report gives the facts." };
  else {
    job.stage("Researching the case");
    found = await research.run(script, dir, job.signal);
  }
  found = casefiles.withDocuments(dir, found);
  found = await withNoteDocs(note, found, id, script.title);
  found = await withNoteProjects(app, note, found, id, script.title, job.signal);
  // The day the camera burned into its picture: the case opening's verified date when no report gives one.
  job.stage("Reading the footage's date");
  const stamps = await footageStamps(data, dir, script, job.signal);
  if (stamps.length > 0) found = { ...found, stamps };
  script = await pickReused(dir, script, job);
  // The sound, so pauses with speech the transcript missed are kept.
  const peaks = await peaksOf(dir, script, job.signal);
  job.stage("Writing the script");
  if (!job.asked) chat.asked(dir, note.trim() === "" ? "Build the script." : `Build the script. ${note.trim()}`, job.resumed);
  let built: build.Built;
  try {
    // Its progress kept beside it, so a restart carries on from the last phase done, not from the outline.
    // Footage not in the case is said with the producer's note, so the writer never writes around it unsaid (missing.ts).
    built = await build.buildFast(script, withMissing(brought.writer === "" ? note : `${note.trim()}\n\n${brought.writer}`, script), found, peaks, job.signal, job.stage, join(dir, ".build-progress.json"));
  } catch (error) {
    failed(dir, job, error);
  }
  let report = `${brought.report === "" ? "" : `${brought.report}\n\n`}${built.report.trim()}\n\n${researchLine(found)}`;
  checkStopped(job);
  const now = store.read(dir);
  const before = structuredClone(now);
  let clips = built.clips;
  if (exact.wanted(now)) {
    let said: string;
    [clips, said] = await cutExactly(app, data, dir, now, built.plan, clips, peaks, job);
    report = `${report}\n\n${said}`;
  }
  try {
    now.clips = checkClips(clips, now.durationMs);
  } catch (error) {
    failed(dir, job, error);
  }
  now.proposals = [];
  const muted = house.withMuteNotes(now);
  if (muted > 0) report = `${report}\n\nMute notes for the editor on ${muted} footage clip${muted === 1 ? "" : "s"} (sex and rape-type words).`;
  now.builtAt ??= Date.now();
  save(dir, before, now);
  chat.add(dir, "editor", report, built.costUsd);
  return [report, built.costUsd];
}

/** `said` with what footage isn't in the case (missing.ts `forWriter`), as Edit's note after it. */
export function withMissing(said: string, script: Script): string {
  const note = missingFootage.forWriter(script);
  return note === "" ? said : `${said.trim()}${said.trim() === "" ? "" : "\n\n"}(Edit's note on the footage: ${note})`;
}

/**
 * Fresh eyes for a script (loop 7, Nov 2; Edit mode's FRESH_EYES, agent.ts):
 * once a build is saved, a second Opus turn reads it as the team reviews it,
 * with only the script, its sources and the house rules, and fixes what it
 * finds, saved narration written straight in. Off for a build asked with
 * review: false.
 */
export function freshEyesRequest(courtroom: boolean, taught = false): string {
  // A channel's script is read against what the channel was taught, nothing of the house's (formats.ts `taught`).
  if (taught) return "Read this script once more with fresh eyes, as the team reviews it before recording, against everything this channel has been taught, and fix what falls short of it. Change only what needs it; keep what already works, and say in a few lines what you changed and why.";
  const blocks = courtroom
    ? "Every footage block: as the courtroom shape paces it (tight early, relaxed later), no cut-in after less than about a minute of footage, no crumbs."
    : "Every footage block: none past about three minutes (break it where the conversation turns, with a cut-in that adds what the footage can't), no cut-in after less than about a minute of footage, no crumbs, no procedure or sound-only stretch holding the picture back.";
  const opening = courtroom ? "The intro clips: the moments the title promises?" : "The very first clip: the title's moment, with picture?";
  return `Read this script once more with fresh eyes, as the team reviews it before recording, and fix what they would flag. ${opening} ${blocks} Every cut-in: does it turn what the viewer just saw rather than describe it again, carry what the footage can't show (the people's life, the motive, what changed), introduce anyone it speaks of? The format's shape and guides hold throughout. Change only what needs it; keep what already works, and say in a few lines what you changed and why.`;
}

/** Said when a channel's script is asked to build with nothing to go on: it was taught nothing and told nothing. */
export const UNTAUGHT = "This channel's scripts aren't taught yet. Tell the agent how to write this one.";
export const UNREAD = "This channel's lessons couldn't be read just now. Try again in a moment.";

/**
 * Why a channel's script can't build now, or null: a channel's script is
 * written only from what it was taught (formats.ts `taught`), so with nothing
 * taught it waits for the person to say what to write (Sphe, Nov 18: "a blank
 * project that says, 'You haven't taught it yet'"); a note says it, and builds.
 */
export async function needsTeaching(script: Script, note: string): Promise<string | null> {
  if (script.commentary || !isTaught(script)) return null;
  const state = await lanes.teachingOf(script.channel!, "script");
  if (state === "unknown") return UNREAD;
  return state === "untaught" && note.trim() === "" ? UNTAUGHT : null;
}

// On by default since loop 7 S2–S3 (four builds with and without: fewer flags, less re-telling, crumbs merged, for about two minutes); a build may ask without it (review: false).
export const scriptFreshEyes = (asked: boolean | undefined): boolean => asked ?? true;

/** How the builder is given what the producer's note points at (a Doc, another project), before its name. */
const REFERENCE = "The producer's reference";

/**
 * The build report's line on its research: the news reports counted, and the
 * producer's references said by name, never counted as reports (Nov 24 trial
 * of #8: "Research: 1 report (Another of the team's projects the producer's
 * note points at: follow what…)" beside "There was no research on this case").
 */
export function researchLine(found: Research): string {
  const references = found.articles.filter((article) => article.title.startsWith(REFERENCE));
  const news = found.articles.filter((article) => !references.includes(article));
  const said = news.length === 0 ? `Research: ${found.problem ?? "nothing found."}` : `Research: ${news.length} ${news.length === 1 ? "report" : "reports"} (${news.map((article) => article.outlet).join(", ")}).`;
  if (references.length === 0) return said;
  const named = references.map((article) => (article.title === `${REFERENCE} (not read)` ? `${article.url} (couldn't be read)` : article.title.slice(REFERENCE.length + 2)));
  return `${said}\n\nYour ${references.length === 1 ? "reference" : "references"}: ${named.join("; ")}.`;
}

/**
 * A Google Doc the build's note links to, read with the team's sign-in and
 * given to the builder beside the research (Republican Chairman, Nov 1: "you
 * can basically look at this script right here and more or less take direct
 * inspiration from it, in particular when it comes to the intro since this is
 * the same case: <Doc>"; the build answered "I couldn't open your reference
 * doc"). One that can't be read is said so to the builder, which tells the producer.
 */
export async function withNoteDocs(note: string, found: Research, id: string, title: string): Promise<Research> {
  const links = [...new Set(note.match(/https:\/\/docs\.google\.com\/document\/d\/[\w-]+[^\s)]*/gu) ?? [])].slice(0, 3);
  if (links.length === 0) return found;
  const articles = [...found.articles];
  for (const link of links) {
    try {
      const [name, text] = await commentary.fetchSource(link);
      articles.push({ title: `${REFERENCE}: ${name}`, outlet: "A Doc the producer's note links to (follow the note on what to take from it)", published: null, url: link, summary: [...text.trim()].slice(0, 20_000).join(""), facts: [] });
    } catch (error) {
      diag.warn("writer", `${named(id, title)}: the note's Doc ${link} couldn't be read: ${diag.messageOf(error)}`);
      articles.push({ title: `${REFERENCE} (not read)`, outlet: "A Doc the producer's note links to", published: null, url: link, summary: `This Doc couldn't be read (${diag.messageOf(error)}). Say so in the report, with the reason.`, facts: [] });
    }
  }
  return { ...found, articles };
}

/**
 * Another of the team's projects the build's note points at ("build it out
 * like the Kimberly script", other_projects.ts `pointedAt`), given to the
 * builder beside the research as the producer's reference, as a linked Doc
 * is: every phase of the build reads it. Its case is another's: its shape and
 * what was asked there, never its facts. Not read, the build goes on without it.
 */
export async function withNoteProjects(app: App, note: string, found: Research, id: string, title: string, signal?: AbortSignal): Promise<Research> {
  let pointed: { one: otherProjects.Other; text: string }[];
  try {
    pointed = await otherProjects.pointedAt(app.store, note, id, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    diag.warn("writer", `${named(id, title)}: which project the note points at couldn't be read: ${diag.messageOf(error)}`);
    return found;
  }
  if (pointed.length === 0) return found;
  diag.info("writer", `${named(id, title)}: the note points at ${pointed.map(({ one }) => `${one.kind} ${one.id}`).join(", ")}`);
  const articles = pointed.map(({ one, text }) => ({
    title: `${REFERENCE}: the ${one.kind} "${one.title}"`,
    outlet: "Another of the team's projects the producer's note points at: follow what they asked for there and how it's built, as the note says; its case is another's, so never take its facts, names or words",
    published: null,
    url: "",
    summary: text,
    facts: [],
  }));
  return { ...found, articles: [...found.articles, ...articles] };
}

/**
 * A build, then (unless asked not to) the fresh read. A build is saved only
 * at its end, so one a restart cut off is written again whole; once it's
 * saved, it's kept (`built`), and a restart during the fresh read carries on
 * with the fresh read alone.
 */
export async function buildAndReview(app: App, data: string, id: string, note: string, kind: Kind | undefined, review: boolean, job: Job): Promise<Outcome> {
  const saved = job.resumed ? (job.kept?.built as { report?: unknown; cost?: unknown } | undefined) : undefined;
  const [report, cost]: Outcome = typeof saved?.report === "string" && typeof saved.cost === "number" ? [saved.report, saved.cost] : await buildOnce(app, data, id, note, kind, job);
  if (!review) return [report, cost];
  job.keep?.({ built: { report, cost } });
  checkStopped(job);
  job.stage("Reading it with fresh eyes");
  try {
    const built = store.read(store.scriptDir(data, id));
    const [again, more] = await reviseWith(data, id, freshEyesRequest(built.kind === "courtroom", isTaught(built)), chat.FRESH_EYES, { selected: [], picked: null, playheadMs: null }, true, job, { given: null, tools: false });
    return [`${report}\n\nFresh eyes: ${again}`, cost + more];
  } catch (error) {
    checkStopped(job);
    diag.warn("writer", `${named(id, store.read(store.scriptDir(data, id)).title)}: the fresh read didn't finish: ${diag.messageOf(error)}`);
    return [report, cost];
  }
}

/** A commentary is written from its sources alone: no speakers to name or case to research. */
async function buildCommentary(data: string, dir: string, script: Script, note: string, job: Job): Promise<Outcome> {
  job.stage("Writing the script");
  const built = await commentary.build(dir, script, note, lessonsText(data), job.signal);
  checkStopped(job);
  // Sources added or renamed during the build stay; the script is replaced.
  const now = store.read(dir);
  const before = structuredClone(now);
  if (now.commentary) now.commentary.draft = built.draft;
  now.builtAt ??= Date.now();
  save(dir, before, now);
  return [built.report, built.costUsd];
}

/**
 * A script built before its rough footage was heard exactly (or whose
 * hearing waited for the plan's credit), heard and cut again: the same words
 * and narration, read back from its clips, with the producer's clip notes
 * kept. POST /api/scripts/{id}/exact; also tried by itself every 30 minutes
 * while the credit is out (exact_after.ts `afterCredit`).
 */
export async function exactOnce(app: App, data: string, id: string, job: Job): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (!exact.wanted(script)) throw new Error("Only footage with rough words (YouTube's captions or Apple's) needs hearing exactly.");
  if (!script.clips.some((clip) => clip.kind === "cut-in")) throw new Error("Build the script first.");
  const before = structuredClone(script);
  const peaks = await peaksOf(dir, script, job.signal);
  const [clips, said] = await cutExactly(app, data, dir, script, exact.planOf(script), before.clips, peaks, job);
  exact.keepNotes(before.words, before.clips, script.words, clips);
  checkStopped(job);
  if (store.read(dir).revision !== before.revision) throw new Error("The script changed while its footage was heard, so nothing was applied. Try again.");
  script.clips = checkClips(clips, script.durationMs);
  save(dir, before, script);
  chat.add(dir, "editor", said);
  return [said, 0];
}

/**
 * A rough script's chosen footage heard exactly, then the same plan cut
 * again on those times, without any piece that has no sound. Hearing that
 * fails leaves the rough cut, and says so: plainly when the transcription
 * plan is out of credit, which Edit then waits for and tries again itself.
 */
async function cutExactly(app: App, data: string, dir: string, script: Script, plan: Plan, clips: Clip[], peaks: ArrayLike<number>, job: Job): Promise<[Clip[], string]> {
  // Footage cleared from this Mac once the cloud held it is read from the cloud's preview, a stretch at a time.
  const source = await footageFor(app, data, dir, script.id, job);
  if ("away" in source) return [clips, `The footage isn't on ${THIS_MACHINE} and couldn't be read from the cloud (${source.away}), so its cuts follow the rough words. Build again to try once more.`];
  const words = script.words;
  const wanted = exact.stretches(script, clips).reduce((sum, [from, to]) => sum + to - from, 0);
  let heard: exact.Report;
  try {
    heard = await exact.run(script, dir, source.footage, clips, job.stage, job.signal);
  } catch (error) {
    checkStopped(job);
    const why = unsigned(diag.messageOf(error));
    const name = named(script.id, script.title);
    if (kindOf(error) === "quota") {
      diag.warn("writer", `${name}: heard roughly; the exact hearing of ${exact.share(wanted, script.durationMs)} waits for the transcription plan's credit: ${why}`);
      afterCredit(data, script.id);
      return [clips, `Heard roughly; the exact hearing waits for the transcription plan's credit (${clock(wanted)} of the chosen footage to hear). Edit tries again every 30 minutes by itself.`];
    }
    diag.warn("writer", `${name}: the chosen footage couldn't be heard exactly: ${why}`);
    return [clips, `The chosen footage couldn't be heard exactly (${why}), so its cuts follow the rough words. Build again to try once more.`];
  }
  creditBack(data, script.id);
  diag.info("writer", `${named(script.id, script.title)}: heard exactly ${exact.share(heard.heardMs, heard.footageMs)} of the footage in ${heard.stretches} stretches (${heard.retimed} retimed, ${heard.added} added, ${heard.respelled} respelled, ${heard.relabelled} relabelled)`);
  let cut: Clip[];
  try {
    // The plan named places in the words as they were; the hearing added words since.
    cut = compile(script, exact.replan(plan, words, script.words), peaks, false).clips;
  } catch (error) {
    diag.warn("writer", `${named(script.id, script.title)}: the plan didn't cut again on the exact times: ${diag.messageOf(error)}`);
    cut = exact.remapFrom(words, clips, script.words, script.durationMs);
  }
  const silent = new Set(exact.silent(cut, peaks));
  return [cut.filter((_, index) => !silent.has(index)), exact.said(heard, silent.size)];
}

/**
 * A turn with the chat's tools (turn_tools.ts): `work` gets their address and
 * whether it has taken review notes (its fixes for them are written straight
 * in). The notes it pulled are settled on the review after it saves; a turn
 * that fails or starts over lets them go, unfixed.
 */
async function withTools<T extends Outcome>(data: string, id: string, turn: fixing.Turn | undefined, work: (tools: Tools | undefined, settle: (before: Script, feedback: fixing.Feedback[]) => Promise<string>) => Promise<T>): Promise<T> {
  // A pass of Edit's own (the fresh read) works from what it has.
  if (turn?.tools === false) return work(undefined, async () => "");
  const [token, url, session] = turnTools.open(data, id, turn?.given ?? null);
  let settled = false;
  const settle = async (before: Script, feedback: fixing.Feedback[]): Promise<string> => {
    settled = true;
    if (session.pulled.size === 0) return "";
    const done = await fixing.settle(data, id, before, store.read(store.scriptDir(data, id)), [...session.pulled.values()], feedback);
    if (turn) turn.settled = done;
    const open = done.lines.filter((line) => line.startsWith("Left "));
    return open.length === 0 ? "" : `\n\n${open.length === 1 ? "One note is still open on the review" : `${open.length} notes are still open on the review`}, with why under ${open.length === 1 ? "it" : "each"}.`;
  };
  try {
    return await work({ url, pulled: () => session.pulled.size > 0 }, settle);
  } finally {
    turnTools.close(token);
    if (!settled && session.pulled.size > 0) {
      const ids = [...session.pulled.keys()];
      await reviews.release(ids).catch((error: unknown) => diag.warn("writer", `${id}: letting go of ${ids.length} review notes after the turn: ${diag.messageOf(error)}`));
    }
  }
}

/** Claude revises a built script on the producer's request (`said` is what the chat shows of it); `direct` (a fix from a review) writes saved narration straight in rather than proposing it. `turn`: the review notes a Ready for changes took for it. */
export async function reviseWith(data: string, id: string, request: string, said: string, focus: Focus, direct: boolean, job: Job, turn?: fixing.Turn): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  let script = store.read(dir);
  if (script.commentary) return reviseCommentary(data, dir, script, request, said, job, turn);
  if (!script.clips.some((clip) => clip.kind === "cut-in")) throw new Error("Build the script first; then ask for changes.");
  const earlier = chat.recent(dir);
  if (!job.asked) chat.asked(dir, said, job.resumed);
  script = await pickReused(dir, script, job);
  const peaks = await peaksOf(dir, script, job.signal);
  const found = casefiles.withDocuments(dir, research.load(dir) ?? { articles: [], queries: [], at: 0 });
  return withTools(data, id, turn, async (tools, settle) => {
    let done: Awaited<ReturnType<typeof revise>>;
    try {
      done = await revise(script, withMissing(request, script), focus, earlier, found, peaks, direct, job.signal, tools);
    } catch (error) {
      failed(dir, job, error);
    }
    checkStopped(job);
    const noted = await lessonNote.keep(script, done.lesson, data);
    // Starting over waits for the producer to confirm it in the chat.
    if (done.startOver) {
      chat.askReset(dir, done.answer + noted, done.costUsd);
      return [done.answer + noted, done.costUsd];
    }
    // Edits made by hand while Claude worked would be lost: ask again instead.
    const now = store.read(dir);
    if (now.revision !== script.revision) failed(dir, job, new Error(CHANGED));
    const before = structuredClone(now);
    const clips = done.clips;
    try {
      now.clips = checkClips(clips, now.durationMs);
    } catch (error) {
      failed(dir, job, new Error(`Claude's edits left the timeline unusable (${diag.messageOf(error)}), so nothing was applied. Ask again.`));
    }
    now.corrections = done.corrections;
    now.proposals = done.proposals;
    // Footage a revision brings in gets the editor's mute notes too (loop 7: the fresh read's new clips had none).
    house.withMuteNotes(now);
    save(dir, before, now);
    const open = await settle(before, done.feedback);
    const answer = done.answer + noted + open;
    chat.add(dir, "editor", answer, done.costUsd);
    // Footage it brought in is heard exactly after it's done, its cuts moved onto those times a moment later (exact_after.ts).
    hearSoon(data, id);
    return [answer, done.costUsd];
  });
}

/** A change to a written commentary: Opus edits the paragraphs the request is about and nothing else, written straight in (undo and the versions bring back what was there). */
export async function reviseCommentary(data: string, dir: string, given: Script, request: string, said: string, job: Job, turn?: fixing.Turn): Promise<Outcome> {
  // Edits name paragraphs by id: a script never shared gets them now.
  const script = structuredClone(given);
  if (script.commentary?.draft && ensureIds(script.commentary.draft)) store.write(dir, script);
  if (!job.asked) chat.asked(dir, said, job.resumed);
  return withTools(data, script.id, turn, async (tools, settle) => {
    let done: commentary.Revised;
    try {
      done = await commentary.revise(dir, script, request, lessonsText(data), job.signal, tools);
    } catch (error) {
      failed(dir, job, error);
    }
    checkStopped(job);
    const noted = await lessonNote.keep(script, done.lesson, data);
    if (done.startOver) {
      chat.askReset(dir, done.answer + noted, done.costUsd);
      return [done.answer + noted, done.costUsd];
    }
    const now = store.read(dir);
    if (now.revision !== script.revision) failed(dir, job, new Error(CHANGED));
    const before = structuredClone(now);
    if (now.commentary && JSON.stringify(now.commentary.draft) !== JSON.stringify(done.draft)) {
      now.commentary.draft = done.draft;
      save(dir, before, now);
    }
    const open = await settle(before, done.feedback);
    const answer = done.answer + noted + open;
    chat.add(dir, "editor", answer, done.costUsd);
    return [answer, done.costUsd];
  });
}
