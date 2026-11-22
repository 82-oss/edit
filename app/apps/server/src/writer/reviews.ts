// Sharing a script for review on a Repack link (feedback.spheceo.com), and
// the notes reviewers leave there. Every call to Repack's `reviews:*`
// functions is here; the relay adds `app: "writer"` to each, so a script's
// review is the same one it was in Writer.
//
// Share snapshots script.json to R2 and publishes its blocks (blocks.ts);
// sharing again publishes the next version under the same link. While Edit
// runs it asks for changed notes every 45 seconds and keeps them in
// `reviews/notes.json` beside `scripts/` (each Mac its own copy).
//
// Notes are fixed when a reviewer clicks "Ready for changes", by the one
// computer an admin chose on accounts.spheceo.com's Fixing page: Edit checks
// in (`reviews:checkIn`) every 45 seconds, every 15 on the fixing computer;
// there it takes each waiting request (`reviews:takeFix`), fixes the notes
// (fixing.ts) and shares the next version. Fixing by hand works anywhere.

import * as fs from "node:fs";

import type { Script, ShareFailed, ShareStep, Sharing } from "@edit/types/writer";

import type { App } from "../app.ts";
import { creator, email } from "../accounts.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import * as machine from "../machine.ts";
import * as outages from "../outages.ts";
import { isFile, join } from "../paths.ts";
import * as relay from "../relay.ts";
import { blocksOf, outline, targetMs, type Block, type Range } from "./blocks.ts";
import * as cloud from "./cloud.ts";
import * as commentary from "./commentary.ts";
import * as fixing from "./fixing.ts";
import * as footage from "./footage.ts";
import { importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import { ensureIds } from "./paragraphs.ts";
import { audit } from "./plan.ts";
import * as store from "./store.ts";
import { THIS_MACHINE } from "../machine.ts";

const POLL_MS = 45_000;
/** How often the fixing computer checks for "Ready for changes"; others check in at POLL_MS. */
const CHECK_IN_CHOSEN_MS = 15_000;
/** The most a version's page data may be (Repack's cap is 512 KB). */
const META_BYTES = 480_000;
/** The text each block was last shared with, beside the script. */
const SHARED_TEXT = "review-text.json";

/** A reviewer's note, or a reply to one, as Script mode keeps it. */
export interface Note {
  id: string;
  reviewId: string;
  scriptId?: string | null;
  version: number;
  parentId?: string | null;
  /** `{kind: "text", blockId, start, end, quote}`, as the page sends it. */
  anchor: unknown;
  text: string;
  author: string;
  /** `open` or `done`. */
  status: string;
  doneInVersion?: number | null;
  changedRanges: Range[];
  fixSummary?: string | null;
  /** Someone (a Mac's run) has taken it to fix. */
  attempted: boolean;
  /** Written by an app, not a reviewer. */
  fromApp: boolean;
  deleted?: boolean;
  /** What the reviewer means it to change: wording, fact, cut, pacing, question, fyi, editor, suggestion. */
  intent?: string;
  scope?: string;
  suggestion?: string;
  /** A suggestion's replacement words ("" deletes them). */
  replacement?: string;
  context?: unknown;
  group?: string;
  outcome?: string;
  /** On a footage clip: `cut`, `extend` or `restore`. */
  action?: string;
  confirmed: boolean;
  confirmedBy?: string;
  notFixedAt?: number;
  notFixedVersion?: number;
  attemptAt?: number;
  createdAt: number;
  updatedAt: number;
}

export const isRoot = (note: Note): boolean => note.parentId == null;
export const isSuggestion = (note: Note): boolean => note.intent === "suggestion" || note.replacement !== undefined;
export const isOpen = (note: Note): boolean => note.status !== "done";
/** Open and nobody's to fix: never taken, or sent back as not fixed since it was. */
export const untaken = (note: Note): boolean => isOpen(note) && (!note.attempted || (note.notFixedAt !== undefined && (note.attemptAt === undefined || note.notFixedAt > note.attemptAt)));

/** A note as Repack sends it. */
export function noteOf(value: Record<string, unknown>): Note | null {
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  const number = (key: string) => (typeof value[key] === "number" ? Math.trunc(value[key] as number) : undefined);
  const id = text("_id") ?? text("id") ?? text("noteId");
  const reviewId = text("reviewId");
  if (id === undefined || reviewId === undefined) return null;
  const object = (key: string) => (typeof value[key] === "object" && value[key] !== null && !Array.isArray(value[key]) ? (value[key] as Record<string, unknown>) : null);
  const notFixed = object("notFixed");
  const attempt = object("attempt");
  const confirmed = object("confirmed");
  const note: Note = {
    id,
    reviewId,
    scriptId: text("sourceId") ?? null,
    version: Math.max(number("version") ?? 1, 1),
    parentId: text("parentId") ?? null,
    anchor: value.anchor ?? null,
    text: text("text") ?? "",
    author: text("author") ?? "Reviewer",
    status: text("status") ?? "open",
    doneInVersion: number("doneInVersion") ?? null,
    changedRanges: Array.isArray(value.changedRanges) ? (value.changedRanges as Range[]) : [],
    fixSummary: text("fixSummary") ?? null,
    attempted: attempt !== null,
    fromApp: value.fromApp === true,
    deleted: value.deleted === true,
    confirmed: confirmed !== null,
    createdAt: number("createdAt") ?? 0,
    updatedAt: number("updatedAt") ?? number("createdAt") ?? 0,
  };
  const intent = text("intent");
  if (intent !== undefined && intent.trim() !== "") note.intent = intent;
  for (const key of ["scope", "suggestion", "replacement", "outcome"] as const) if (text(key) !== undefined) note[key] = text(key);
  const group = text("group");
  if (group) note.group = group;
  const action = text("action");
  if (action !== undefined && action.trim() !== "") note.action = action;
  if (object("context") !== null) note.context = value.context;
  if (typeof confirmed?.by === "string") note.confirmedBy = confirmed.by;
  if (typeof notFixed?.at === "number") note.notFixedAt = Math.trunc(notFixed.at);
  if (typeof notFixed?.version === "number") note.notFixedVersion = Math.trunc(notFixed.version);
  if (typeof attempt?.at === "number") note.attemptAt = Math.trunc(attempt.at);
  return note;
}

/** A review's approved version: the link takes no more notes, and Repack deletes the other versions' files (their notes stay). */
export interface Approval {
  version: number;
  by: string;
  at: number;
}

export function approvalOf(value: unknown): Approval | null {
  if (typeof value !== "object" || value === null || typeof (value as { version?: unknown }).version !== "number") return null;
  const given = value as { version: number; by?: unknown; at?: unknown };
  return { version: Math.trunc(given.version), by: typeof given.by === "string" ? given.by : "", at: typeof given.at === "number" ? Math.trunc(given.at) : 0 };
}

// ---- The contract: Repack's reviews:* functions ----

async function call(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await cloud.convex(kind, path, args);
  if (!answer.ok) throw new Error(`The cloud refused ${path}: ${String(answer.data.message ?? answer.code)}`);
  return (answer.value ?? {}) as Record<string, unknown>;
}

/** Who shares, claims and replies, as Repack shows it. */
const by = (): string => `Edit on ${machine.name()}`;

/** Every note and reply written or changed after `cursor` (Repack numbers each write), and the cursor to ask from next. */
async function changes(cursor: number): Promise<[Note[], number]> {
  const notes: Note[] = [];
  let at = cursor;
  // A page at a time, while Repack says there's more.
  for (let page = 0; page < 50; page++) {
    const value = await call("query", "reviews:changes", { cursor: at });
    notes.push(...(Array.isArray(value.notes) ? (value.notes as Record<string, unknown>[]) : []).flatMap((note) => noteOf(note) ?? []));
    if (typeof value.cursor === "number") at = Math.trunc(value.cursor);
    if (value.more !== true) break;
  }
  return [notes, at];
}

/** Takes notes to fix: the ids this Mac got (not replies, done, or under another run's claim). Once a computer is chosen to fix, Repack gives notes only to it, unless they're fixed by hand (`manual`). */
export async function claim(noteIds: string[], manual: boolean): Promise<string[]> {
  const value = await call("mutation", "reviews:claim", { noteIds: noteIds.slice(0, 100), by: by(), machine: machine.id(), manual });
  return (Array.isArray(value.claimed) ? value.claimed : []).filter((id): id is string => typeof id === "string");
}

/** Lets go of notes a run couldn't get to, so a later run may take them. */
export const release = async (noteIds: string[]): Promise<void> => void (await call("mutation", "reviews:release", { noteIds, by: by() }));

/** Approves the script's latest shared version: the link takes no more notes; every note stays. */
export async function approve(data: string, scriptId: string): Promise<Approval> {
  const script = store.read(store.scriptDir(data, scriptId));
  if (!script.review) throw new Error("Share the script before approving it.");
  const value = await call("mutation", "reviews:approve", { sourceId: scriptId, version: script.review.version, by: by() });
  const approval = approvalOf(value.approved);
  if (approval === null) throw new Error("Repack approved it but didn't say which version.");
  diag.info("writer", `${jobs.named(scriptId, script.title)}: v${approval.version} approved`);
  change(data, (known) => void (known.approved[scriptId] = approval));
  return approval;
}

/** Takes an approval back: the link takes notes again (deleted files stay deleted). */
export async function unapprove(data: string, scriptId: string): Promise<void> {
  await call("mutation", "reviews:unapprove", { sourceId: scriptId });
  change(data, (known) => void delete known.approved[scriptId]);
}

export const approval = (data: string, scriptId: string): Approval | null => load(data).approved[scriptId] ?? null;

export async function resolve(noteId: string, version: number, ranges: Range[], summary: string, outcome?: "accepted" | "rejected"): Promise<void> {
  await call("mutation", "reviews:resolve", { noteId, version, changedRanges: ranges, fixSummary: summary, ...(outcome ? { outcome } : {}) });
}

/** What a note left from Edit says beyond its text: the words it's on, its intent, and a suggestion's replacement. */
export interface NoteDetails {
  anchor?: Record<string, unknown> | null;
  intent?: string | null;
  replacement?: string | null;
}

/** A note left from Edit on the script's latest review version, as a reviewer leaves one, fixed on Ready for changes like any other. */
export async function addNote(data: string, id: string, given: string, details: NoteDetails): Promise<void> {
  const text = given.trim();
  if (text === "" && details.intent !== "suggestion") throw new Error("Write the note first.");
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const link = script.review;
  if (!link) throw new Error("Share the script for review first: notes live on its review page.");
  const args: Record<string, unknown> = { reviewId: link.reviewId, version: link.version, text };
  if (details.anchor) {
    await sharedTextFromCloud(dir, id, link);
    args.anchor = sharedAnchor(dir, link, script.revision, details.anchor);
  }
  if (details.intent) args.intent = details.intent;
  if (details.replacement != null) args.replacement = details.replacement;
  // Signed with the person's name, as a reply is; a Repack from before `author` refuses it, and then it goes unsigned.
  const author = (creator()?.name ?? "").trim();
  if (author !== "") {
    try {
      await call("mutation", "reviews:note", { ...args, author: [...author].slice(0, 200).join("") });
      await poll(data).catch(() => false);
      return;
    } catch (error) {
      if (!diag.messageOf(error).includes("author")) throw error;
    }
  }
  await call("mutation", "reviews:note", args);
  await poll(data).catch(() => false);
}

/** A person's word on a fix: confirmed, or sent back (the note opens again), with what still isn't right as a reply. */
export async function check(data: string, noteId: string, verdict: string, given: string | null): Promise<void> {
  if (verdict !== "confirmed" && verdict !== "notFixed") throw new Error("A fix is confirmed or sent back.");
  const author = [...(creator()?.name ?? "Edit")].slice(0, 200).join("");
  const text = given?.trim() ?? "";
  try {
    await call("mutation", "reviews:check", { noteId, author, verdict, ...(text !== "" ? { text } : {}) });
  } catch (error) {
    const message = diag.messageOf(error);
    throw new Error(message.includes("Could not find public function") || message.includes("reviews:check") ? "Checking a fix from Edit needs Repack's latest update; do it on the review page for now." : message);
  }
  await poll(data).catch(() => false);
}

/** How a "Ready for changes" on the script's review is going, and whether the fixing computer is on: the review page's own shapes, or nulls. */
export async function fixState(scriptId: string): Promise<{ fix: unknown; computer: unknown }> {
  try {
    const value = await call("query", "reviews:get", { sourceId: scriptId });
    return { fix: value.fix ?? null, computer: value.computer ?? null };
  } catch {
    return { fix: null, computer: null };
  }
}

type SharedText = { version: number; blocks: Record<string, string> };

function readShared(dir: string): SharedText | null {
  try {
    return JSON.parse(fs.readFileSync(join(dir, SHARED_TEXT), "utf8")) as SharedText;
  } catch {
    return null;
  }
}

/** The shared text for a version shared before it was kept here: read from the snapshot each share puts up. */
async function sharedTextFromCloud(dir: string, id: string, link: NonNullable<Script["review"]>): Promise<void> {
  if (readShared(dir)?.version === link.version) return;
  const bytes = await cloud.getBytes(`writer/reviews/${id}/v${link.version}/script.json`).catch(() => null);
  if (bytes === null) return;
  try {
    const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Script;
    writeAtomic(join(dir, SHARED_TEXT), JSON.stringify({ version: link.version, blocks: Object.fromEntries(blocksOf(snapshot).map((block) => [block.id, block.text])) }));
  } catch {
    // An unreadable snapshot: the anchor is checked against the script as shared, below.
  }
}

/**
 * A comment's words named in the shared version's text, as the review page
 * anchors them: where they were picked when that text still reads so, else
 * where the same words are found once in the block as shared.
 */
export function sharedAnchor(dir: string, link: NonNullable<Script["review"]>, revision: number, anchor: Record<string, unknown>): Record<string, unknown> {
  const block = typeof anchor.blockId === "string" ? anchor.blockId : "";
  const quote = typeof anchor.quote === "string" ? anchor.quote : "";
  const [start, end] = [Number(anchor.start ?? 0), Number(anchor.end ?? 0)];
  const shared = readShared(dir);
  const text = shared?.version === link.version ? shared.blocks[block] : undefined;
  if (text === undefined) {
    // Shared before the text was kept: only the script as it was shared can be named.
    if (revision === link.revision) return anchor;
    throw new Error(`Share again to comment on these words: v${link.version} on the review page is from before the script's latest edits.`);
  }
  const at = (from: number) => text.slice(from, from + quote.length) === quote;
  let found: number | null = null;
  if (end === start + quote.length && at(start)) found = start;
  else {
    const hits: number[] = [];
    for (let from = text.indexOf(quote); from >= 0 && quote !== ""; from = text.indexOf(quote, from + 1)) hits.push(from);
    if (hits.length === 1) found = hits[0]!;
  }
  if (found === null || quote === "") throw new Error(`Those words aren't on the review page as v${link.version} reads. Share again to comment on them.`);
  return { kind: "text", blockId: block, start: found, end: found + quote.length, quote };
}

/** A reply under a note, signed with `author`. */
export async function replyAs(data: string, noteId: string, given: string, author: string): Promise<void> {
  const text = given.trim();
  if (text === "") throw new Error("Write the reply first.");
  await call("mutation", "reviews:reply", { noteId, text, author });
  await poll(data).catch(() => false);
}

export const reply = (data: string, noteId: string, text: string): Promise<void> => replyAs(data, noteId, text, creator()?.name || "Edit");

/** Deletes a note left from Edit (never a reviewer's), with its replies. */
export async function deleteNote(data: string, noteId: string): Promise<void> {
  await call("mutation", "reviews:deleteNote", { noteId });
  await poll(data).catch(() => false);
}

// ---- Sharing ----

/**
 * A share refused before it began: not ready, its preview still going up.
 * Said in its own words alone, never as a share that "stopped while"
 * something (Nov 22, a MacBook Air in the real window: "Sharing stopped
 * while checking its preview in the cloud" read as if it broke partway).
 */
export class ShareRefused extends Error {
  override readonly name = "ShareRefused";
}

const PREVIEW_GOING_UP = "Its preview is still going up to the cloud. Share it again once it's there.";

/** The review page plays the preview from the cloud, so sharing waits until that preview is verified there. */
async function previewInCloud(data: string, id: string, dir: string, script: Script): Promise<void> {
  if (script.commentary) return;
  const kept = cloud.fileKey(data, id, "proxy.mp4");
  if (kept !== null) {
    let found: number | null;
    try {
      found = await cloud.head(kept.key);
    } catch (error) {
      throw new Error(`Couldn't verify its preview in the cloud (${diag.messageOf(error)}). Check the connection, then share again.`);
    }
    // The cloud's can be an earlier preview while this Mac's new one goes up beside the words (writer/cloud.ts footageFirst).
    if (found !== kept.size || !cloud.sameAsHere(data, id, "proxy.mp4")) throw new ShareRefused(PREVIEW_GOING_UP);
  } else if (isFile(store.proxyPath(dir))) throw new ShareRefused(PREVIEW_GOING_UP);
}

/** A commentary's paragraphs get the ids notes anchor to; refused when there's nothing to share. */
function shareable(dir: string, script: Script): Block[] {
  if (script.status !== "ready") throw new ShareRefused("Share a script once its import has finished.");
  if (script.commentary) {
    if (!script.commentary.draft) throw new ShareRefused("Write the script before sharing it.");
    if (ensureIds(script.commentary.draft)) store.write(dir, script);
  }
  const found = blocksOf(script);
  if (found.length === 0) throw new ShareRefused("There's nothing in the script to share yet.");
  return found;
}

const keepShared = (dir: string, version: number, found: Block[]) => writeAtomic(join(dir, SHARED_TEXT), JSON.stringify({ version, blocks: Object.fromEntries(found.map((block) => [block.id, block.text])) }));

/** Publishes the script as it stands: its first version, or the next under the same link. */
export async function share(app: App, data: string, id: string): Promise<Script> {
  if (jobs.running(id)) throw new Error("Claude is still working on this script. Share it when that's done.");
  return shareNext(app, data, id);
}

/**
 * The shares running now, by script, and the last one that failed: a share
 * runs on its own, as an edit's does, so the person can close the dialog and
 * share other scripts meanwhile (JJ, Nov 1: "can we at least have the feature
 * of exporting multiple scripts at once then? so we're not freezed on that
 * screen and cant do anything else").
 */
const sharing = new Map<string, Running>();
const shareFailed = new Map<string, ShareFailed>();
/**
 * How a share waits for its preview to go up from here (`previewUp`): how often it looks again, how long it waits for
 * the sync to take the preview up when nothing is sending it yet, and the most it waits at all.
 */
export const previewWait = { everyMs: 5_000, graceMs: 60_000, mostMs: 3 * 60 * 60_000 };

/**
 * `previewInCloud`, waited for while the preview is still going up from this computer: the share's first step, and it
 * carries on by itself once the preview is there (Nov 22: it was refused, "Share it again once it's there", and the
 * person had to come back and press it again). Refused as before when nothing is putting it up, or after
 * `previewWait.mostMs`; the share's Cancel ends the wait.
 */
async function previewUp(data: string, id: string, dir: string, script: Script, signal?: AbortSignal): Promise<void> {
  const began = Date.now();
  for (;;) {
    try {
      await previewInCloud(data, id, dir, script);
      return;
    } catch (error) {
      if (!(error instanceof ShareRefused) || error.message !== PREVIEW_GOING_UP) throw error;
      const waited = Date.now() - began;
      if (waited > previewWait.mostMs || (!cloud.footageGoing(data, id, "proxy.mp4") && waited >= previewWait.graceMs)) throw error;
      const step = sharing.get(id)?.steps.find((one) => one.kind === "check");
      if (step !== undefined && step.waits !== true) {
        step.waits = true;
        mark(id, "waiting for its preview to go up");
        diag.info("writer", `${jobs.named(id, script.title)}: its preview is still going up to the cloud; the share waits for it`);
      }
      cloud.syncSoon();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, previewWait.everyMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      halt(id);
    }
  }
}

/** The last share of each script that landed here, with its steps' times, for the dialog's "done" (cleared by the next share). */
const landed = new Map<string, { at: number; version: number; steps: ShareStep[] }>();
/** A share the person stopped. The step it's in lets go, and nothing is published. */
const dropped = new Set<string>();
/** Each running share's Cancel, which aborts its transfers at once (`cancelShare`). */
const shareAbort = new Map<string, AbortController>();
/** Refusals that last only while the preview goes up: the data folder to look in, so the line goes once the sync has it up. */
const waitingPreview = new Map<string, string>();
/** A refusal's line goes by itself after this, whatever it said: true or not by then, it isn't said for ever. */
const REFUSAL_FOR_MS = 5 * 60_000;

/**
 * A share's steps as they go (Sphe, Nov 22: a script's share should show its
 * progress "as well as I do with the editing"): each one's start and end,
 * and for one that moves bytes its real total and how many have gone, with
 * the first reading kept so its rate is measured from its own bytes (an
 * upload resuming from parts already up starts high, and that start isn't
 * speed).
 */
type Step = { kind: ShareStep["kind"]; state: ShareStep["state"]; total?: number; done?: number; startedAt?: number; endedAt?: number; first?: { at: number; done: number }; skipped?: boolean; waits?: boolean };
type Running = { startedAt: number; stage: string; name?: string; version?: number; steps: Step[] };

/** The stage word each step prints, as the export queue and older pages read it. */
const STAGE: Record<ShareStep["kind"], string> = {
  check: "checking the preview",
  script: "uploading the script",
  fetch: "bringing its preview here",
  footage: "uploading the footage",
  publish: "publishing",
};

/** A rate is said only after this long of a step's own bytes: the first seconds of a transfer are its handshake, not its speed. */
const RATE_AFTER_MS = 3_000;

/** A share stopped on purpose: not a failure, and not kept on the script. */
export class ShareCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "ShareCancelled";
  }
}

function halt(id: string): void {
  if (dropped.has(id)) throw new ShareCancelled();
}

/** Stops a running script share. It stays on the queue, saying "cancelling", until the step it's in lets go. */
export function cancelShare(id: string): boolean {
  const running = sharing.get(id);
  if (running === undefined) return false;
  dropped.add(id);
  sharing.set(id, { ...running, stage: "cancelling" });
  shareAbort.get(id)?.abort(new ShareCancelled());
  return true;
}

/** Where a running share has got to, for the dialog's progress line. No-op once it has finished. */
function mark(id: string, stage: string) {
  const running = sharing.get(id);
  if (running !== undefined && running.stage !== stage && running.stage !== "cancelling") running.stage = stage;
}

/** The steps a share will go through, and the version it makes. No-op when it isn't one started here (a fix's share). */
function plan(id: string, version: number, steps: { kind: ShareStep["kind"]; total?: number }[]) {
  const running = sharing.get(id);
  if (running === undefined) return;
  running.version = version;
  running.steps = steps.map((one) => ({ kind: one.kind, state: "waiting", ...(one.total === undefined ? {} : { total: one.total }) }));
}

/** The step under way now: the one before it is done, and the stage word follows. */
function begin(id: string, kind: ShareStep["kind"]) {
  const running = sharing.get(id);
  if (running === undefined) return;
  mark(id, STAGE[kind]);
  // A step this share doesn't have (a commentary has no preview to check) leaves the others as they are.
  const at = running.steps.findIndex((one) => one.kind === kind);
  if (at < 0) return;
  const now = Date.now();
  for (const one of running.steps.slice(0, at)) if (one.state !== "done") Object.assign(one, { state: "done", endedAt: now, startedAt: one.startedAt ?? now });
  const step = running.steps[at]!;
  if (step.state === "waiting") Object.assign(step, { state: "current", startedAt: now });
}

/** Bytes a step has moved of its total, as the transfer says them. */
function moved(id: string, kind: ShareStep["kind"], done: number, total: number) {
  const running = sharing.get(id);
  const step = running?.steps.find((one) => one.kind === kind);
  if (running === undefined || step === undefined) return;
  if (total > 0) step.total = total;
  step.done = Math.max(0, Math.min(done, step.total ?? done));
  step.first ??= { at: Date.now(), done: step.done };
  if (kind === "footage" && total > 0) mark(id, `${STAGE.footage} ${Math.round((step.done / total) * 100)}%`);
}

/** A step done with nothing to move: the review link already had this preview. */
function skip(id: string, kind: ShareStep["kind"]) {
  begin(id, kind);
  const step = sharing.get(id)?.steps.find((one) => one.kind === kind);
  if (step !== undefined) Object.assign(step, { state: "done", skipped: true, endedAt: Date.now() });
}

/** A step as the page reads it: its seconds so far or in all, and its time left from its measured rate. */
function shown(step: Step, now: number): ShareStep {
  const out: ShareStep = { kind: step.kind, state: step.state };
  if (step.total !== undefined) out.total = step.total;
  if (step.state === "current" && step.done !== undefined) out.done = step.done;
  if (step.skipped === true) out.skipped = true;
  if (step.waits === true && step.state === "current") out.waits = true;
  if (step.startedAt !== undefined && step.state !== "waiting") out.seconds = Math.max(0, ((step.state === "done" ? (step.endedAt ?? now) : now) - step.startedAt) / 1000);
  if (step.state === "current" && step.first !== undefined && step.done !== undefined && step.total !== undefined && now - step.first.at >= RATE_AFTER_MS && step.done > step.first.done) {
    const rate = (step.done - step.first.done) / (now - step.first.at);
    out.leftS = Math.max(0, (step.total - step.done) / rate / 1000);
  }
  return out;
}

/**
 * The whole share 0–1 by the bytes it moves (the footage is nearly all of
 * them), null for one that moves none worth counting (a commentary's
 * script); its time left once the step under way has a measured rate and no
 * step still to come moves bytes (publishing is one call).
 */
function overall(steps: ShareStep[]): { progress: number | null; leftS: number | null } {
  const counted = steps.filter((one) => one.total !== undefined && one.skipped !== true);
  if (!steps.some((one) => (one.kind === "footage" || one.kind === "fetch") && one.total !== undefined && one.skipped !== true)) return { progress: null, leftS: null };
  const total = counted.reduce((sum, one) => sum + (one.total ?? 0), 0);
  const done = counted.reduce((sum, one) => sum + (one.state === "done" ? (one.total ?? 0) : one.state === "current" ? (one.done ?? 0) : 0), 0);
  const current = steps.find((one) => one.state === "current");
  const after = current === undefined ? [] : steps.slice(steps.indexOf(current) + 1).filter((one) => one.total !== undefined && one.skipped !== true);
  const leftS = current?.leftS !== undefined && after.length === 0 ? current.leftS : null;
  return { progress: total > 0 ? Math.min(1, done / total) : null, leftS };
}

/** The script's name on the shared queue, once the share has read it. */
function titleShare(id: string, title: string) {
  const running = sharing.get(id);
  const name = title.trim() || "Script";
  if (running !== undefined && running.name !== name) running.name = name;
}

const counted = (progress: number | null): { progress: number; counted: boolean } => ({ progress: progress ?? 0, counted: progress !== null });

/** Script shares running now, for the export queue beside the edit exports. Finished shares leave; a script has no file to keep. */
export function shareQueue(): { id: string; name: string; stage: string; progress: number; counted: boolean; startedAt: number }[] {
  const now = Date.now();
  return [...sharing.entries()].map(([id, one]) => ({
    id,
    name: one.name?.trim() || "Script",
    stage: one.stage,
    // The bytes' share when it moves footage, the script's row's own number; none before bytes are counted, as the row
    // says its step in words (Nov 22: the queue guessed 47% from the stage's name while the row said 0%).
    ...counted(one.stage === "cancelling" ? null : overall(one.steps.map((step) => shown(step, now))).progress),
    startedAt: one.startedAt,
  }));
}

/** A script's share as it stands now, for its detail and its row: under way with its steps, or the last that failed or landed. */
export function shareState(id: string, now = Date.now()): { sharing?: Sharing; shareFailed?: ShareFailed; shared?: { at: number; version: number; steps: ShareStep[] } } {
  const running = sharing.get(id);
  if (running !== undefined) {
    const steps = running.steps.map((step) => shown(step, now));
    const whole = overall(steps);
    return { sharing: { startedAt: running.startedAt, stage: running.stage, ...(running.version === undefined ? {} : { version: running.version }), steps, progress: whole.progress, leftS: whole.leftS } };
  }
  const failed = shareFailed.get(id);
  // A refusal goes once it's no longer true: the preview the sync was putting up is up (the ledger says the cloud has
  // this Mac's), or a few minutes have passed for the others.
  if (failed?.why === "refused") {
    const data = waitingPreview.get(id);
    const up = data !== undefined && (cloud.fileKey(data, id, "proxy.mp4")?.key ?? "") !== "" && cloud.sameAsHere(data, id, "proxy.mp4");
    if (up || now - failed.at > REFUSAL_FOR_MS) {
      shareFailed.delete(id);
      waitingPreview.delete(id);
      return landed.has(id) ? { shared: landed.get(id)! } : {};
    }
  }
  if (failed !== undefined) return { shareFailed: failed };
  const done = landed.get(id);
  return done === undefined ? {} : { shared: done };
}

/** The share itself (tests give their own). */
export const shareWork = { run: (app: App, data: string, id: string): Promise<Script> => shareNext(app, data, id) };

/** Starts sharing a script; refused at once when it's already being shared or Claude is on it. Settles when the share does. */
export function startShare(app: App, data: string, id: string): Promise<Script> {
  if (sharing.has(id)) return Promise.reject(new Error("This script is already being shared: it carries on if you close this."));
  if (removing.has(id)) return Promise.reject(new Error("This script's review link is being deleted: share it again once that's done."));
  if (jobs.running(id)) return Promise.reject(new Error("Claude is still working on this script. Share it when that's done."));
  sharing.set(id, { startedAt: Date.now(), stage: STAGE.check, steps: [] });
  shareAbort.set(id, new AbortController());
  shareFailed.delete(id);
  waitingPreview.delete(id);
  landed.delete(id);
  // The lists hear it at once: Home's row says it's sharing without waiting for its next look.
  store.libraryChanged();
  return shareWork
    .run(app, data, id)
    .then((script) => {
      if (dropped.has(id)) throw new ShareCancelled();
      const running = sharing.get(id);
      if (running !== undefined && running.steps.length > 0) {
        const now = Date.now();
        for (const step of running.steps) if (step.state !== "done") Object.assign(step, { state: "done", endedAt: now, startedAt: step.startedAt ?? now });
        landed.set(id, { at: now, version: script.review?.version ?? running.version ?? 1, steps: running.steps.map((step) => shown(step, now)) });
      }
      return script;
    })
    .catch((error: unknown) => {
      // Cancelled: said as the edit's Export says its own ("Cancelled", Share again), until the next share; not a failure,
      // so nothing logs or counts it (Nov 22, a MacBook Air in the real window: the row went back to "Start edit").
      if (dropped.has(id) || error instanceof ShareCancelled) {
        shareFailed.set(id, { error: "Cancelled.", at: Date.now(), why: "cancelled" });
        throw new ShareCancelled();
      }
      if (error instanceof ShareRefused) {
        shareFailed.set(id, { error: error.message, at: Date.now(), why: "refused" });
        if (error.message === PREVIEW_GOING_UP) waitingPreview.set(id, data);
        throw error;
      }
      const step = sharing.get(id)?.steps.find((one) => one.state === "current")?.kind;
      shareFailed.set(id, { error: diag.messageOf(error), at: Date.now(), ...(step === undefined ? {} : { step }) });
      throw error;
    })
    .finally(() => {
      sharing.delete(id);
      dropped.delete(id);
      shareAbort.delete(id);
      // The lists hear it: Home's row and the open script stop saying "Sharing".
      store.libraryChanged();
    });
}

/** Shares the next version, also from inside the fix that made it (still the script's running job). */
export async function shareNext(app: App, data: string, id: string): Promise<Script> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  titleShare(id, script.title);
  const found = shareable(dir, script);
  halt(id);
  const next = (script.review?.version ?? 0) + 1;
  const snapshot = JSON.stringify(script);
  // The steps it will go through, with the bytes each moves: the preview's size from this Mac's copy, else as the cloud keeps it.
  const isFootage = !script.commentary;
  const here = isFootage && isFile(store.proxyPath(dir));
  const previewBytes = !isFootage ? undefined : here ? fs.statSync(store.proxyPath(dir)).size : cloud.fileKey(data, id, "proxy.mp4")?.size;
  const sized = (kind: ShareStep["kind"]) => (previewBytes === undefined ? { kind } : { kind, total: previewBytes });
  plan(id, next, [...(isFootage ? [{ kind: "check" as const }] : []), { kind: "script", total: Buffer.byteLength(snapshot) }, ...(isFootage && !here ? [sized("fetch")] : []), ...(isFootage ? [sized("footage")] : []), { kind: "publish" }]);
  begin(id, "check");
  // The share's Cancel stops its transfers at once (none from a fix's own share, which has no Cancel).
  const signal = shareAbort.get(id)?.signal;
  await previewUp(data, id, dir, script, signal);
  halt(id);
  // The review's id is Repack's to give, on the first publish: snapshots are kept by the script's id instead.
  const key = `writer/reviews/${id}/v${next}/script.json`;
  begin(id, "script");
  halt(id);
  await cloud.putBytes(key, snapshot, undefined, signal);
  halt(id);
  const meta = await metaOf(data, id, script, found, {
    begin: (kind) => begin(id, kind),
    skip: (kind) => skip(id, kind),
    moved: (kind, done, total) => {
      halt(id);
      moved(id, kind, done, total);
    },
    signal,
  });
  halt(id);
  begin(id, "publish");
  let value: Record<string, unknown>;
  try {
    value = await call("mutation", "reviews:publish", { sourceId: id, title: script.title, kind: "script", key, meta, sourceRev: script.revision, by: by() });
  } catch (error) {
    diag.error("writer", `${jobs.named(id, script.title)}: couldn't share: ${diag.messageOf(error)}`);
    throw error;
  }
  if (typeof value.reviewId !== "string" || typeof value.url !== "string") throw new Error("Repack published the review but sent no link.");
  const version = typeof value.version === "number" ? Math.trunc(value.version) : 1;
  diag.info("writer", `${jobs.named(id, script.title)}: shared as v${version} (${found.length} blocks) at ${value.url}`);
  // What the team would flag, said where a share by the fixing computer is seen.
  const flags = script.commentary ? commentary.checks(dir, script)[1] : audit(script);
  if (flags.length > 0) diag.warn("writer", `${jobs.named(id, script.title)}: v${version} shared with ${flags.length} things the team would flag: ${flags.map((flag) => [...flag].slice(0, 160).join("")).join(" | ")}`);
  const now = store.read(dir);
  now.review = { reviewId: value.reviewId, token: typeof value.token === "string" ? value.token : "", url: value.url, version, revision: script.revision, sharedAt: Date.now() };
  store.write(dir, now);
  keepShared(dir, version, found);
  change(data, (known) => {
    known.links[value.reviewId as string] = id;
    // A version shared after an approval is the next round, unapproved.
    delete known.approved[id];
  });
  // A commentary's review page plays its clips from stretches put up beside it.
  if (now.commentary) footage.soon(app, data, id);
  pollSoon();
  return now;
}

/** Makes the script as it is now the review's only version, v1, on the same link (`reviews:compress`): later versions go, every note moves onto v1. */
export async function compress(app: App, data: string, id: string): Promise<Script> {
  if (jobs.running(id)) throw new Error("Claude is still working on this script. Make it v1 when that's done.");
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const link = script.review;
  if (!link) throw new Error("Share the script first: there's no review to make v1.");
  const found = shareable(dir, script);
  await previewInCloud(data, id, dir, script);
  const key = `writer/reviews/${id}/v1/script.json`;
  await cloud.putBytes(key, JSON.stringify(script));
  const meta = await metaOf(data, id, script, found);
  let answer: Record<string, unknown>;
  try {
    answer = await call("mutation", "reviews:compress", { sourceId: id, key, meta, sourceRev: script.revision, by: by() });
  } catch (error) {
    throw new Error(diag.messageOf(error).includes("Could not find public function") ? "Making a review v1 needs Repack's latest update." : diag.messageOf(error));
  }
  const removed = (Array.isArray(answer.removed) ? answer.removed : []).filter((one): one is number => typeof one === "number");
  diag.info("writer", `${jobs.named(id, script.title)}: made v1 on the same link (${found.length} blocks, revision ${script.revision}), removing v${removed.join(", v")} at ${link.url}`);
  const now = store.read(dir);
  now.review = { ...link, version: 1, revision: script.revision, sharedAt: Date.now() };
  store.write(dir, now);
  keepShared(dir, 1, found);
  if (now.commentary) footage.soon(app, data, id);
  change(data, (known) => void delete known.approved[id]);
  pollSoon();
  return now;
}

/** Scripts whose review link is being deleted now: no share starts meanwhile. */
const removing = new Set<string>();

/**
 * Deletes the script's review link for good (Sphe, Nov 1: "we need to be
 * able to delete a review link"): Repack's review, every version, note and
 * reply (`reviews:remove`; the link opens nothing after), its files under
 * `writer/reviews/<id>/`, and what this Mac kept of it. The script keeps its
 * words and its own version history; sharing again makes a new link, v1.
 * Refused while it's being shared or Claude is on it.
 */
export async function removeLink(data: string, id: string): Promise<Script> {
  if (sharing.has(id)) throw new Error("This script is being shared now: delete the link once that's done.");
  if (removing.has(id)) throw new Error("This script's review link is already being deleted.");
  if (jobs.running(id)) throw new Error("Claude is still working on this script. Delete the link when that's done.");
  const dir = store.scriptDir(data, id);
  const link = store.read(dir).review;
  if (!link) throw new Error("This script has no review link to delete.");
  removing.add(id);
  try {
    let answer: Record<string, unknown>;
    try {
      answer = await call("mutation", "reviews:remove", { sourceId: id });
    } catch (error) {
      throw new Error(diag.messageOf(error).includes("Could not find public function") ? "Deleting a review link needs the cloud's latest update." : diag.messageOf(error));
    }
    const keys = (Array.isArray(answer.keys) ? answer.keys : []).filter((key): key is string => typeof key === "string");
    const deleted = await cloud.removeUnder(`writer/reviews/${id}/`, keys).catch((error: unknown) => {
      diag.warn("writer", `${id}: the deleted review's files: ${diag.messageOf(error)}; Repack's cleanup deletes them`);
      return 0;
    });
    const now = store.read(dir);
    delete now.review;
    store.write(dir, now);
    fs.rmSync(join(dir, SHARED_TEXT), { force: true });
    forget(data, id, link.reviewId);
    shareFailed.delete(id);
    const notes = typeof answer.notes === "number" ? answer.notes : 0;
    diag.info("writer", `${jobs.named(id, now.title)}: review link deleted (${link.url}, ${answer.removed === true ? `${link.version > 1 ? `v1 to v${link.version}` : "v1"}, ${notes} notes and replies` : "already gone from Repack"}; ${deleted} files deleted)`);
    store.libraryChanged();
    return now;
  } finally {
    removing.delete(id);
  }
}

/** What this Mac kept of a script's deleted review: its notes, their tries, its link and its approval. */
function forget(data: string, scriptId: string, reviewId: string): void {
  change(data, (known) => {
    for (const [noteId, kept] of Object.entries(known.notes)) {
      if (kept.reviewId !== reviewId && (kept.scriptId ?? known.links[kept.reviewId]) !== scriptId) continue;
      delete known.notes[noteId];
      delete known.tried[noteId];
      delete known.attempts[noteId];
    }
    delete known.links[reviewId];
    delete known.approved[scriptId];
  });
}

/** A share's steps as metaOf goes through them (shareNext's; compress follows none). */
type Track = { begin: (kind: ShareStep["kind"]) => void; skip: (kind: ShareStep["kind"]) => void; moved: (kind: ShareStep["kind"], done: number, total: number) => void; signal?: AbortSignal | undefined };

/**
 * What the review page shows and plays: the blocks, the outline rail with
 * running times against the format's target, and the preview the clips play
 * from. Word timings that would take it past Repack's cap go in a file of
 * their own (`wordsKey`).
 */
async function metaOf(data: string, id: string, script: Script, found: Block[], track?: Track): Promise<Record<string, unknown>> {
  const isFootage = !script.commentary;
  const meta: Record<string, unknown> = { format: isFootage ? "footage" : "commentary", revision: script.revision, outline: outline(script, found) };
  const target = targetMs(script);
  if (target !== null) {
    meta.targetMs = target[1];
    meta.targetRangeMs = [target[0], target[2]];
  }
  if (isFootage) {
    // The preview the clips play from, put under the review (the review page serves only writer/reviews/ keys); sent again only when it changed.
    if (!isFile(store.proxyPath(store.scriptDir(data, id)))) track?.begin("fetch");
    const proxy = await cloud.fetchPreview(data, id, (done, total) => track?.moved("fetch", done, total), track?.signal);
    const size = fs.statSync(proxy).size;
    const key = `writer/reviews/${id}/preview.mp4`;
    // Its step from the look at what the link has: that look is part of sending it (or finding it there already).
    track?.begin("footage");
    if ((await cloud.head(key)) !== size) {
      await cloud.putFile(id, key, proxy, (done, total) => track?.moved("footage", done, total), track?.signal);
    } else track?.skip("footage");
    meta.preview = { key, durationMs: script.durationMs, sizeBytes: size };
  }
  meta.blocks = found;
  if (JSON.stringify(meta).length > META_BYTES) {
    const words = Object.fromEntries(found.flatMap((block) => (block.words && block.words.length > 0 ? [[block.id, block.words]] : [])));
    const key = `writer/reviews/${id}/${crypto.randomUUID()}/words.json`;
    await cloud.putBytes(key, JSON.stringify(words), undefined, track?.signal);
    meta.blocks = found.map(({ words: _words, ...rest }) => rest);
    meta.wordsKey = key;
    if (JSON.stringify(meta).length > META_BYTES) throw new Error("This script is too long to share in one review page.");
  }
  return meta;
}

// ---- What this Mac knows ----

interface Known {
  /** Where `reviews:changes` carries on from. */
  cursor: number;
  notes: Record<string, Note>;
  /** Review id → script id. */
  links: Record<string, string>;
  /** Notes this Mac has started fixing, so a run is never repeated. */
  tried: Record<string, number>;
  /** How many runs each note has had here. */
  attempts: Record<string, number>;
  /** Script id → its approved version, as Repack's reviews:open says. */
  approved: Record<string, Approval>;
}

const knownPath = (data: string) => join(data, "reviews", "notes.json");

function load(data: string): Known {
  try {
    const kept = JSON.parse(fs.readFileSync(knownPath(data), "utf8")) as Partial<Known>;
    return { cursor: kept.cursor ?? 0, notes: kept.notes ?? {}, links: kept.links ?? {}, tried: kept.tried ?? {}, attempts: kept.attempts ?? {}, approved: kept.approved ?? {} };
  } catch {
    return { cursor: 0, notes: {}, links: {}, tried: {}, attempts: {}, approved: {} };
  }
}

/** Changes what's known (one change at a time: JavaScript runs them in turn). */
function change(data: string, edit: (known: Known) => void): void {
  const known = load(data);
  edit(known);
  fs.mkdirSync(join(data, "reviews"), { recursive: true });
  writeAtomic(knownPath(data), JSON.stringify(known));
}

/** Every script's link, read from the scripts themselves: for a review shared on another Mac. */
function scanLinks(data: string): Record<string, string> {
  const links: Record<string, string> = {};
  for (const id of store.ids(data)) {
    try {
      const slim = JSON.parse(fs.readFileSync(join(store.scriptDir(data, id), "script.json"), "utf8")) as { id: string; review?: { reviewId?: string } };
      if (slim.review?.reviewId) links[slim.review.reviewId] = slim.id;
    } catch {
      // Not readable: passed over.
    }
  }
  return links;
}

/** Open notes per script, for the cards' badges; approvals; whether this Mac fixes. */
export function counts(data: string): { open: Record<string, number>; approved: Record<string, Approval>; fixesHere: boolean } {
  const known = load(data);
  const open: Record<string, number> = {};
  for (const note of Object.values(known.notes).filter((one) => isRoot(one) && isOpen(one))) {
    const script = note.scriptId ?? known.links[note.reviewId];
    if (script !== undefined) open[script] = (open[script] ?? 0) + 1;
  }
  return { open, approved: known.approved, fixesHere: chosen };
}

/** A script's notes, oldest first, with their replies. */
export function notesOf(data: string, scriptId: string): Note[] {
  const known = load(data);
  return Object.values(known.notes)
    .filter((note) => (note.scriptId ?? known.links[note.reviewId]) === scriptId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** A note fixed here: done in the next version, with what changed. */
export function markFixed(data: string, noteId: string, version: number, ranges: Range[], summary: string): void {
  change(data, (known) => {
    const note = known.notes[noteId];
    if (note) Object.assign(note, { status: "done", doneInVersion: version, changedRanges: ranges, fixSummary: summary, updatedAt: Date.now() });
  });
}

export function markTried(data: string, noteIds: string[]): void {
  change(data, (known) => {
    for (const id of noteIds) {
      known.tried[id] = Date.now();
      known.attempts[id] = (known.attempts[id] ?? 0) + 1;
    }
  });
}

/** A script's open notes, for fixing them by hand. */
export const openNotes = (data: string, scriptId: string): string[] => notesOf(data, scriptId).filter((note) => isRoot(note) && isOpen(note)).map((note) => note.id);
export const note = (data: string, id: string): Note | null => load(data).notes[id] ?? null;
/** The replies under a note, oldest first. */
export const replies = (data: string, id: string): Note[] => Object.values(load(data).notes).filter((one) => one.parentId === id).sort((a, b) => a.createdAt - b.createdAt);

// ---- Asking for changes, and fixing ----

let pollNow = false;
export const pollSoon = (): void => void (pollNow = true);
/** This Mac is the fixing computer, as the last check-in said. */
let chosen = false;

/** Asks for changed notes while Edit runs, checks in as this computer, and on the fixing computer takes each "Ready for changes". */
export function start(app: App, data: string): void {
  let lastPoll = 0;
  let lastCheck = 0;
  let busyNow = false;
  setInterval(() => {
    if (busyNow || !relay.cloudEnabled()) return;
    busyNow = true;
    // Both are background rounds: skipped while the relay is down, but for one probe at a time (outages.ts).
    void (async () => {
      if (pollNow || Date.now() - lastPoll >= POLL_MS) {
        pollNow = false;
        lastPoll = Date.now();
        await outages.background("relay", () => poll(data)).catch((error: unknown) => diag.warn("writer", `review notes: ${diag.messageOf(error)}`));
      }
      if (Date.now() - lastCheck >= (chosen ? CHECK_IN_CHOSEN_MS : POLL_MS)) {
        lastCheck = Date.now();
        await outages.background("relay", () => checkIn(app, data)).catch((error: unknown) => diag.warn("writer", `checking in for fixing: ${diag.messageOf(error)}`));
      }
    })().finally(() => (busyNow = false));
  }, 3_000);
}

/** One round of changes; says whether anything changed. */
export async function poll(data: string): Promise<boolean> {
  // Approvals, made here or on Repack's page: only reviews:open carries them.
  const listed = await call("query", "reviews:open", {}).then((value) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : null), () => null);
  const rows = listed ?? [];
  const approved: Record<string, Approval> = {};
  for (const row of rows) {
    const found = approvalOf(row.approved);
    if (typeof row.sourceId === "string" && found !== null) approved[row.sourceId] = found;
  }
  let moved = false;
  change(data, (known) => {
    moved = JSON.stringify(known.approved) !== JSON.stringify(approved);
    known.approved = approved;
    // A review link deleted (here, on another Mac or on Repack's page): its notes go from the badges too. Only from a whole list (it's capped at 1000).
    if (listed === null || listed.length >= 1000) return;
    const alive = new Set(listed.flatMap((row) => (typeof row.reviewId === "string" ? [row.reviewId] : [])));
    for (const [noteId, kept] of Object.entries(known.notes)) {
      if (alive.has(kept.reviewId)) continue;
      delete known.notes[noteId];
      delete known.tried[noteId];
      delete known.attempts[noteId];
      moved = true;
    }
  });
  const cursor = load(data).cursor;
  const [notes, next] = await changes(cursor);
  if (notes.length === 0 && next === cursor) return moved;
  diag.info("writer", `${notes.length} notes changed on review links (${notes.filter((one) => isRoot(one) && !one.deleted).length} notes, ${notes.filter((one) => !isRoot(one)).length} replies, ${notes.filter((one) => one.deleted).length} deleted)`);
  const before = load(data);
  const scanned = notes.some((one) => !one.scriptId && before.links[one.reviewId] === undefined) ? scanLinks(data) : {};
  let changed = moved;
  change(data, (known) => {
    Object.assign(known.links, scanned);
    for (const given of notes) {
      // Deleted by its guest: gone, with its replies, never a phantom open note.
      if (given.deleted) {
        const count = Object.keys(known.notes).length;
        for (const [id, kept] of Object.entries(known.notes)) if (id === given.id || kept.parentId === given.id) delete known.notes[id];
        delete known.tried[given.id];
        changed ||= Object.keys(known.notes).length !== count;
        continue;
      }
      const one = { ...given, scriptId: given.scriptId ?? known.links[given.reviewId] ?? null };
      delete one.deleted;
      const kept = known.notes[one.id];
      const same = kept !== undefined && kept.updatedAt === one.updatedAt && kept.status === one.status;
      // Sent back as not fixed (or opened again): a new note to fix.
      const reopened = kept !== undefined && ((!isOpen(kept) && isOpen(one)) || kept.notFixedAt !== one.notFixedAt);
      if (reopened && untaken(one)) delete known.tried[one.id];
      if (!same) {
        known.notes[one.id] = one;
        changed = true;
      }
    }
    known.cursor = next;
  });
  return changed;
}

/** Says this Mac is open (for accounts' Fixing page) and, on the fixing computer, takes each waiting "Ready for changes" whose script is here. */
async function checkIn(app: App, data: string): Promise<void> {
  let answer: Record<string, unknown>;
  try {
    answer = await call("mutation", "reviews:checkIn", { machine: machine.id(), name: machine.name(), email: email() });
  } catch (error) {
    // The relay gone: said once, by outages.ts (the round that called this is quiet then).
    if (outages.quiet(error, ["relay"])) throw error;
    diag.warn("writer", `checking in for fixing: ${diag.messageOf(error)}`);
    return;
  }
  const now = answer.chosen === true;
  if (now !== chosen) diag.info("writer", now ? `${THIS_MACHINE} is the fixing computer: it takes Ready for changes` : `${THIS_MACHINE} isn't the fixing computer`);
  chosen = now;
  if (!chosen) return;
  const requests = (Array.isArray(answer.requests) ? answer.requests : []) as Record<string, unknown>[];
  if (requests.length === 0) return;
  // The notes it fixes are read from what this Mac has heard: hear them first.
  await poll(data).catch(() => false);
  for (const request of requests) {
    if (typeof request.reviewId !== "string" || typeof request.sourceId !== "string") continue;
    await take(app, data, request.reviewId, request.sourceId, typeof request.title === "string" ? request.title : "");
  }
}

/** Why each request waits, as last said. */
const waiting = new Map<string, string>();

/** Takes one request and starts its fix, or says why it couldn't. */
async function take(app: App, data: string, reviewId: string, scriptId: string, title: string): Promise<void> {
  const name = jobs.named(scriptId, title);
  let here = false;
  try {
    here = store.read(store.scriptDir(data, scriptId)).status === "ready";
  } catch {
    here = false;
  }
  // A script this Mac hasn't got yet (the sync brings it) or is busy with waits for a later check-in.
  if (!here || jobs.running(scriptId) || importing(scriptId)) {
    const why = `${name}: Ready for changes waits: the script ${here ? "is busy" : `isn't on ${THIS_MACHINE} yet`}`;
    // Said once, not at every check-in.
    if (waiting.get(reviewId) !== why) diag.info("writer", why);
    waiting.set(reviewId, why);
    return;
  }
  waiting.delete(reviewId);
  let taken: Record<string, unknown>;
  try {
    taken = await call("mutation", "reviews:takeFix", { machine: machine.id(), reviewId });
  } catch (error) {
    diag.warn("writer", `${name}: couldn't take Ready for changes: ${diag.messageOf(error)}`);
    return;
  }
  if (taken.ok !== true) {
    diag.info("writer", `${name}: Ready for changes not taken (${String(taken.reason ?? "?")})`);
    return;
  }
  const notes = (Array.isArray(taken.noteIds) ? taken.noteIds : []).filter((one): one is string => typeof one === "string");
  diag.info("writer", `${name}: Ready for changes: fixing ${notes.length} ${notes.length === 1 ? "note" : "notes"}`);
  markTried(data, notes);
  try {
    // A fix as a job on the script; the next version is shared after (fixing.ts).
    jobs.start(data, scriptId, title || store.read(store.scriptDir(data, scriptId)).title, { kind: "review", notes, ready: reviewId }, (job) => fixing.run(app, data, scriptId, notes, reviewId, job));
  } catch (error) {
    await progress(reviewId, { state: "failed", error: diag.messageOf(error) });
  }
}

/** How a "Ready for changes" is going, for its review page: `state` fixing, sharing, done or failed. Best effort. */
export async function progress(reviewId: string, given: { state?: string; stage?: string; done?: number; total?: number; error?: string }): Promise<void> {
  try {
    await call("mutation", "reviews:fixProgress", { machine: machine.id(), reviewId, ...given });
  } catch (error) {
    diag.warn("writer", `saying how the fix is going: ${diag.messageOf(error)}`);
  }
}
