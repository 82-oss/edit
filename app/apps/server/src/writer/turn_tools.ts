// The tools a script's chat turn works with, as Edit's agent has its own: the
// review's feedback (Sphe, Nov 20: "Do you see any feedback?", "Can you
// please just apply the feedback?" should have the agent pull it, then "here
// are the things I need to fix… bangs them out… done"), and research the
// reviewers ask for: the web, other channels' videos on the case ("Red File
// has covered this case, just to see what details they've been giving the
// viewers") and pictures of it ("find a lot of assets and images surrounding
// the case"), which go on the script as notes for the editor.
//
// A revision (revise.ts, commentary.ts) still answers once with its edits;
// these run before that answer. They are served over MCP on Edit's own
// server (`/mcp/writer-turn/<token>`, a random token per turn), as the
// build's are (build.ts). The notes a turn pulled are settled on the review
// after its edits are saved (fixing.ts `settle`).

import * as fs from "node:fs";

import type { Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { empty, json } from "../http/errors.ts";
import { readJson, type Router } from "../http/router.ts";
import { native } from "../native/index.ts";
import { join, parent } from "../paths.ts";
import * as research from "../research.ts";
import * as youtube from "../youtube.ts";
import * as youtubeResearch from "../youtube_research.ts";
import { toolsAddress } from "./build.ts";
import * as fixing from "./fixing.ts";
import * as reviews from "./reviews.ts";
import * as store from "./store.ts";

/** One turn's tools: its script, and the review notes it has taken to fix. */
export interface Session {
  data: string;
  id: string;
  /** Notes a Ready for changes already took for this turn: pull_feedback hands these on and takes no others. */
  given: string[] | null;
  /** The notes pull_feedback handed on, by id. */
  pulled: Map<string, reviews.Note>;
}

const sessions = new Map<string, Session>();

/** Opens a turn's tools; `close` with the token when the turn ends. */
export function open(data: string, id: string, given: string[] | null = null): [string, string, Session] {
  const token = crypto.randomUUID();
  const session: Session = { data, id, given, pulled: new Map() };
  sessions.set(token, session);
  return [token, toolsAddress(`/mcp/writer-turn/${token}`), session];
}

export function close(token: string): void {
  sessions.delete(token);
}

/** What the revision's system prompt says of the tools. */
export const TOOLS_NOTE = `TOOLS. Before your answer you can use these tools; then the answer carries your edits as usual.
- pull_feedback: the open notes reviewers left on the script's review link. Call it first whenever the producer mentions feedback, notes, comments or the review ("do you see any feedback?", "apply the feedback", "fix the notes"). It takes the notes for you to fix. Then list for yourself what each note asks and do every one in this same answer: one set of edits covering them all, using the tools below where a note needs research. In feedback, give one entry per note it handed you: its id; outcome "changed" (your edits carry it out), "answered" (a question, or a fact that checks out, answered with no change needed) or "open" (it can't be done, and said says why); and said, one or two sentences to the reviewer on what you did (no IDs: name places by their words). A note is open only when no tool and no edit can do it.
- search_web, read_page: research on the web: news reports, court records, the case's facts and dates.
- search_youtube, read_youtube: find videos on YouTube and read what's said in them (their captions), e.g. another channel's video on this case ("Red File Stephanie Lazarus") to see which details they give their viewers. Use the facts that hold up; never copy their wording. Bringing footage into the script is the footage search's job, not yours.
- find_images: pictures of the case (its people, places, evidence, documents, news photos), shown to you as a numbered sheet with each one's link and page. The editor places pictures: each picture worth showing goes on the script as a note for the editor on the words it belongs under: "edit: show this photo of Sherri Rasmussen <image link> (from <page link>)". Only pictures of this case (their page is about it) and never stock. A reviewer asking for assets, images or visuals is asking for these notes, as many as the script can use, spread through it.
A fact you add from the web or a video comes from a page or video you read in this turn; say where in your reply.`;

type Args = Record<string, unknown>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const TOOLS = [
  { name: "pull_feedback", description: "The open notes reviewers left on this script's review link (feedback.spheceo.com), taken for you to fix: each with its id, who left it, where it is (the words it's on), what kind of note it is and what that lets you change, the replies under it, and its words. Fix them all in this answer and report each in feedback.", inputSchema: { type: "object", properties: {} } },
  { name: "search_web", description: "Search the web privately from this machine. Returns titles, links and snippets.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "read_page", description: "The readable text of a web page (a news story from search_web).", inputSchema: { type: "object", properties: { url: { type: "string" }, limit: { type: "integer", description: "Characters, 500 to 60,000 (default 12,000)." } }, required: ["url"] } },
  { name: "search_youtube", description: "Search YouTube: each video's title, channel, link, length and views. Name the channel in the query for its video on the case (\"Red File Stephanie Lazarus\"); results vary, so when a named channel's video isn't among them, search again with other words (the channel with the victim's name, the case's headline words, count 15) before saying it isn't there.", inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", description: "Videos, 1 to 15 (default 8)." } }, required: ["query"] } },
  { name: "read_youtube", description: "A YouTube video's details and what's said in it (its captions, with times), without downloading it. phrase narrows it to the lines with those words.", inputSchema: { type: "object", properties: { url: { type: "string" }, phrase: { type: "string" } }, required: ["url"] } },
  { name: "find_images", description: "Image search (Bing, privately from this machine), stock left out: a numbered contact sheet of what each query finds, with each picture's link and its page's. Put every query in one call; make them specific (names with the place, \"<name> 1986\", the street, the department, the court).", inputSchema: { type: "object", properties: { queries: { type: "array", items: { type: "string" }, maxItems: 6 }, per_query: { type: "integer", description: "Pictures per query, 1 to 12 (default 8)." } }, required: ["queries"] } },
];

/** The tools' MCP endpoint (JSON-RPC over HTTP, JSON answers), one turn per token. */
export function routes(router: Router<App>): void {
  router.post("/mcp/writer-turn/{token}", async (context) => {
    const token = context.params.token ?? "";
    const body = await readJson<unknown>(context);
    const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map((message) => answerTo(token, message)))).filter((one) => one !== null);
    if (answers.length === 0) return empty(202);
    return json(Array.isArray(body) ? answers : answers[0]);
  });
}

/** One JSON-RPC message to a turn's tools, answered (null for a notification). */
export async function answerTo(token: string, message: unknown): Promise<unknown> {
  if (typeof message !== "object" || message === null) return null;
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const failure = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  const session = sessions.get(token);
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "writer", version: "1" } });
    case "ping":
      return reply({});
    case "tools/list":
      return session === undefined ? failure(-32001, "This turn has ended.") : reply({ tools: TOOLS });
    case "tools/call": {
      if (session === undefined) return id === undefined ? null : failure(-32001, "This turn has ended.");
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (typeof params?.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Args;
      try {
        return reply({ content: await call(session, name, args) });
      } catch (error) {
        diag.warn("writer", `${session.id}: ${name} failed: ${diag.messageOf(error)}`);
        return reply({ content: [{ type: "text", text: diag.messageOf(error) }], isError: true });
      }
    }
    default:
      return id === undefined ? null : failure(-32601, `Writer has no method ${String(method)}.`);
  }
}

const said = (value: string): Content[] => [{ type: "text", text: value }];
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const count = (value: unknown, fallback: number, low: number, high: number): number => (typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), low), high) : fallback);
const homeOf = (session: Session): string => parent(session.data) ?? session.data;

async function call(session: Session, name: string, args: Args): Promise<Content[]> {
  switch (name) {
    case "pull_feedback":
      return said(await pullFeedback(session));
    case "search_web": {
      const query = str(args.query);
      if (query === null) throw new Error("query is required");
      const found = await research.searchWeb(query);
      return said(found.length === 0 ? "nothing found" : found.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join("\n"));
    }
    case "read_page": {
      const url = str(args.url);
      if (url === null) throw new Error("url is required");
      return said(await research.readPage(url, count(args.limit, 12_000, 500, 60_000)));
    }
    case "search_youtube": {
      const query = str(args.query);
      if (query === null) throw new Error("query is required");
      const videos = await youtubeResearch.search(homeOf(session), query, count(args.count, 8, 1, 15));
      if (videos.length === 0) return said("nothing found");
      const length = (seconds: unknown) => (typeof seconds === "number" ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}` : "?");
      return said(videos.map((video, index) => `${index + 1}. ${String(video.title)} · ${String(video.channel)} · ${length(video.duration)}${typeof video.views === "number" ? ` · ${video.views.toLocaleString("en-US")} views` : ""}\n   ${video.url}`).join("\n"));
    }
    case "read_youtube":
      return said(await readYoutube(session, args));
    case "find_images":
      return findImages(session, args);
    default:
      throw new Error(`There's no tool ${name} here.`);
  }
}

/** The most of a video's captions one answer carries (about an hour of talk). */
const CAPTION_CHARS = 60_000;

async function readYoutube(session: Session, args: Args): Promise<string> {
  const url = str(args.url);
  const id = url === null ? null : youtube.videoId(url);
  if (id === null) throw new Error("url must be a YouTube video");
  const [source] = await youtubeResearch.source(homeOf(session), id, join(homeOf(session), "cache", "youtube-research", id));
  const words = (str(args.phrase) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const lines = source.lines.filter((line) => words.length === 0 || words.some((word) => line.text.toLowerCase().includes(word)));
  const clock = (at: number) => `${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}`;
  let body = "";
  let shown = 0;
  for (const line of lines) {
    const next = `[${clock(line.at)}] ${line.text.replace(/\s+/g, " ")}\n`;
    if (body.length + next.length > CAPTION_CHARS) break;
    body += next;
    shown++;
  }
  const description = typeof source.description === "string" ? source.description.trim().slice(0, 1_500) : "";
  const head = `${String(source.title)} · ${String(source.channel)}${typeof source.date === "string" ? ` · uploaded ${source.date.slice(0, 4)}-${source.date.slice(4, 6)}-${source.date.slice(6, 8)}` : ""}\n${source.url}${description !== "" ? `\n\nDescription: ${description}` : ""}`;
  if (source.lines.length === 0) return `${head}\n\nThis video has no English captions to read.`;
  const more = lines.length > shown ? `\n(${lines.length - shown} more lines: narrow it with phrase)` : "";
  return `${head}\n\nWhat's said${words.length > 0 ? ` (the lines with "${words.join(" ")}")` : ""}:\n${body}${more}`;
}

/** Pictures on one sheet, at most: a bigger search goes over several. */
const SHEET_MAX = 36;

async function findImages(session: Session, args: Args): Promise<Content[]> {
  const queries = Array.isArray(args.queries) ? args.queries.flatMap((one) => (str(one) !== null ? [str(one)!] : [])).slice(0, 6) : [];
  if (queries.length === 0) throw new Error("queries: one or more image searches");
  const per = count(args.per_query, 8, 1, 12);
  const folder = join(homeOf(session), "cache", "found-images");
  fs.mkdirSync(folder, { recursive: true });
  const seen = new Set<string>();
  const found: research.Item[] = [];
  const missed: string[] = [];
  // Three searches at a time, as collect_images asks them.
  for (let at = 0; at < queries.length; at += 3) {
    const rounds = await Promise.allSettled(
      queries.slice(at, at + 3).map(async (query) => {
        const hits = (await research.imageSearch(query, per * 2)).filter(([image]) => !seen.has(image));
        const kept: research.Item[] = [];
        for (let from = 0; from < hits.length && kept.length < per; from += 8) {
          const got = await Promise.all(hits.slice(from, from + 8).map((hit) => research.download(folder, hit, query).catch(() => null)));
          for (const item of got) {
            if (item === null || kept.length >= per || seen.has(item.image)) continue;
            seen.add(item.image);
            kept.push(item);
          }
        }
        return kept;
      }),
    );
    rounds.forEach((round, index) => {
      if (round.status === "fulfilled") found.push(...round.value);
      else missed.push(`${queries[at + index]}: ${diag.messageOf(round.reason)}`);
    });
  }
  const failed = missed.length > 0 ? `\nSearches that failed: ${missed.join("; ")}` : "";
  if (found.length === 0) return said(`No usable pictures found.${failed}`);
  const shown = found.slice(0, SHEET_MAX);
  const thumbs = await Promise.all(shown.map(async (item) => (await research.thumbnail(item.file)) ?? { width: 320, height: 240, pixels: Buffer.alloc(320 * 240 * 4) }));
  const list = shown.map((item, index) => `${index + 1}. ${item.title || "(untitled)"} · ${item.width}×${item.height} · searched "${item.query}"\n   image: ${item.image}\n   page: ${item.page}`).join("\n");
  const caption = `${shown.length} pictures, numbered left to right then down:\n${list}${found.length > shown.length ? `\n(${found.length - shown.length} more not shown: search fewer at a time)` : ""}${failed}`;
  try {
    const sheet = await native().composeSheet(thumbs, { labels: shown.map((_, index) => String(index + 1)) }, "png");
    return [{ type: "image", data: Buffer.from(sheet.data).toString("base64"), mimeType: sheet.mime }, { type: "text", text: caption }];
  } catch (error) {
    // No sheet (the native part missing): the list alone still names each one.
    diag.warn("writer", `${session.id}: the found pictures' sheet failed: ${diag.messageOf(error)}`);
    return said(caption);
  }
}

async function pullFeedback(session: Session): Promise<string> {
  const { data, id } = session;
  const dir = store.scriptDir(data, id);
  const script: Script = store.read(dir);
  if (!script.review) return "This script hasn't been shared for review, so there's no feedback on a review link. Say so.";
  const approved = reviews.approval(data, id);
  if (approved !== null) return `v${approved.version} of the script was approved, so its notes aren't fixed. Say so: the producer can take the approval back from Share.`;
  let taken: string[];
  if (session.given !== null) taken = session.given.filter((one) => !session.pulled.has(one));
  else {
    await reviews.poll(data).catch((error: unknown) => diag.warn("writer", `${id}: reading the review's notes before pulling them: ${diag.messageOf(error)}`));
    const open = reviews.openNotes(data, id).filter((one) => !session.pulled.has(one));
    if (open.length === 0) return session.pulled.size > 0 ? "No other notes are open: you have them all." : `No notes are open on the review (${script.review.url}). Say so.`;
    taken = await reviews.claim(open, true);
    reviews.markTried(data, taken);
    if (taken.length === 0) return `The review's ${open.length} open ${open.length === 1 ? "note is" : "notes are"} being fixed by another run just now: leave ${open.length === 1 ? "it" : "them"} to it, and say so.`;
  }
  const notes = taken.flatMap((one) => reviews.note(data, one) ?? []).sort((a, b) => a.createdAt - b.createdAt);
  for (const note of notes) session.pulled.set(note.id, note);
  if (notes.length === 0) return "No notes are open on the review. Say so.";
  diag.info("writer", `${id}: the chat's agent pulled ${notes.length} review ${notes.length === 1 ? "note" : "notes"}`);
  return fixing.brief(data, script, notes);
}
