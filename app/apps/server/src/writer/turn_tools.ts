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
import * as lanes from "../lanes.ts";
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
import * as styles from "../script_styles.ts";
import * as store from "./store.ts";

/** One turn's tools: its script, and the review notes it has taken to fix. */
export interface Session {
  data: string;
  id: string;
  /** Notes a Ready for changes already took for this turn: pull_feedback hands these on and takes no others. */
  given: string[] | null;
  /** The notes pull_feedback handed on, by id. */
  pulled: Map<string, reviews.Note>;
  /** A channel's script: its Script lane, which the lane's tools (remember, read_skill, other_channels) keep and read. */
  place: lanes.Place | null;
}

const sessions = new Map<string, Session>();

/** Opens a turn's tools; `close` with the token when the turn ends. */
export function open(data: string, id: string, given: string[] | null = null): [string, string, Session] {
  const token = crypto.randomUUID();
  let channel: string | null = null;
  try {
    channel = store.read(store.scriptDir(data, id)).channel ?? null;
  } catch {
    // Unreadable now: the turn reads it again and says so.
  }
  const session: Session = { data, id, given, pulled: new Map(), place: channel === null ? null : { channel, lane: "script" } };
  sessions.set(token, session);
  return [token, toolsAddress(`/mcp/writer-turn/${token}`), session];
}

export function close(token: string): void {
  sessions.delete(token);
}

/** What the revision's system prompt says of the tools. */
export const TOOLS_NOTE = `TOOLS. Before your answer you can use these tools; then the answer carries your edits as usual.
- pull_feedback: the open notes reviewers left on the script's review link. Call it first whenever the producer mentions feedback, notes, comments or the review ("do you see any feedback?", "apply the feedback", "fix the notes"). It takes the notes for you to fix, and your edits for them are written straight into the script, saved narration too: say you changed it, never that you proposed it. Then list for yourself what each note asks and do every one in this same answer: one set of edits covering them all, using the tools below where a note needs research. In feedback, give one entry per note it handed you: its id; outcome "changed" (your edits carry it out), "answered" (a question, or a fact that checks out, answered with no change needed) or "open" (it can't be done, and said says why); and said, one or two sentences to the reviewer on what you did (no IDs: name places by their words). A note is open only when no tool and no edit can do it.
- search_web, read_page: research on the web: news reports, court records, the case's facts and dates.
- search_youtube, read_youtube: find videos on YouTube and read what's said in them (their captions), e.g. another channel's video on this case ("Red File Stephanie Lazarus") to see which details they give their viewers. Use the facts that hold up; never copy their wording. Bringing footage into the script is the footage search's job, not yours.
- find_images: pictures of the case (its people, places, evidence, documents, news photos), shown to you as a numbered sheet with each one's link and page. The editor places pictures: each picture worth showing goes on the script as a note for the editor on the words it belongs under: "edit: show this photo of Sherri Rasmussen <image link> (from <page link>)". Only pictures of this case (their page is about it) and never stock. A reviewer asking for assets, images or visuals is asking for these notes, as many as the script can use, spread through it.
A fact you add from the web or a video comes from a page or video you read in this turn; say where in your reply.\n- A channel's script also has remember, read_skill and other_channels: its lessons (below, where it has them).\n- And use_style: which of the channel's script styles this script is written in, when the producer names one ("do this one in the Dr Insanity style", "go back to the default"), or makes one the channel's default. Its guide comes back: write what's asked in it. A new style is learned from videos, a Doc or a script pasted in when the producer's message brings them and asks for it; asked to learn one with nothing to learn from, ask for the links.`;

type Args = Record<string, unknown>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** A channel's script's: its style (script_styles.ts). */
const USE_STYLE = {
  name: "use_style",
  description: "Which of this channel's script styles this script is written in, from now on: style is its name as the instructions list it, or \"default\" for the channel's default. default: true also makes it the channel's default (what a script is written in when none is named), when the producer asks for that. Answers with the style's guide and examples.",
  inputSchema: { type: "object", properties: { style: { type: "string" }, default: { type: "boolean" }, reason: { type: "string", description: "What the producer said, quoted" } }, required: ["style"] },
};

const TOOLS = [
  { name: "pull_feedback", description: "The open notes reviewers left on this script's review link (feedback.spheceo.com), taken for you to fix: each with its id, who left it, where it is (the words it's on), what kind of note it is and what that lets you change, the replies under it, and its words. Fix them all in this answer and report each in feedback. done: true reads back the notes already fixed instead, each with what was done, taking nothing (for \"remember all of this for the future\").", inputSchema: { type: "object", properties: { done: { type: "boolean" } } } },
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
      return session === undefined ? failure(-32001, "This turn has ended.") : reply({ tools: session.place === null ? TOOLS : [...TOOLS, ...lanes.toolsFor("script"), USE_STYLE] });
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
      return said(args.done === true ? await doneFeedback(session) : await pullFeedback(session));
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
    case "remember":
    case "read_skill":
    case "other_channels":
      if (session.place === null) throw new Error("This script isn't a channel's, so it has no lessons to keep or read.");
      return said(await lanes.call(name, args, session.place));
    case "use_style":
      if (session.place === null) throw new Error("This script isn't a channel's, so it has no styles.");
      return said(await useStyle(session, session.place, args));
    default:
      throw new Error(`There's no tool ${name} here.`);
  }
}

/** Writes the script in one of its channel's styles from now on (and makes it the default, when asked); its guide, said back. */
async function useStyle(session: Session, place: lanes.Place, args: Args): Promise<string> {
  await lanes.refresh();
  const lessons = lanes.lessonsOf(place);
  const all = styles.stylesIn(lessons);
  const asked = str(args.style) ?? "";
  const dir = store.scriptDir(session.data, session.id);
  if (/^(default|none|the default)$/iu.test(asked)) {
    store.update(dir, (now) => void delete now.style, true);
    const fallback = lanes.chosenStyle(place, null);
    return fallback === null ? "This script is written in no style of its own now: the channel's lessons alone. The channel has no default style." : `This script is written in the channel's default style now, ${fallback.title}:\n\n${styles.prompt(fallback, all, true)}`;
  }
  const wanted = styles.nameFor(asked);
  const found = all.find((one) => one.name === wanted || one.name === asked || one.title.toLowerCase() === asked.toLowerCase());
  if (found === undefined) throw new Error(all.length === 0 ? "This channel has no script styles yet. One is learned from videos, a Doc or a script pasted in: ask the producer for the links." : `No style ${asked}: this channel's are ${all.map((one) => `${one.title} (${one.name.slice(styles.PREFIX.length)})`).join(", ")}.`);
  store.update(dir, (now) => void (now.style = found.name), true);
  let made = "";
  if (args.default === true) {
    // Kept where the style is: a channel's own style is that channel's default, never its group's.
    await lanes.keepDefaultStyle(place.channel, found.name, str(args.reason) ?? "said in the script's chat", lanes.styleScope(place.channel, found.name));
    await lanes.refresh();
    made = " It's the channel's default now: scripts that name no style are written in it.";
  }
  const isDefault = lanes.defaultStyle(place) === found.name;
  return `This script is written in ${found.title} from now on.${made} Say so in your reply.\n\n${styles.prompt(found, all, isDefault)}`;
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

/** The review's notes already fixed, each with what was done for it: read back, taking nothing (teaching.ts ROUND_RULE). */
async function doneFeedback(session: Session): Promise<string> {
  const { data, id } = session;
  const script: Script = store.read(store.scriptDir(data, id));
  if (!script.review) return "This script hasn't been shared for review, so no review notes were fixed on it.";
  await reviews.poll(data).catch((error: unknown) => diag.warn("writer", `${id}: reading the review's notes back: ${diag.messageOf(error)}`));
  const notes = reviews.notesOf(data, id).filter((note) => reviews.isRoot(note) && !note.fromApp && !note.deleted && note.status === "done");
  if (notes.length === 0) return "No notes on this script's review have been fixed yet.";
  return fixing.doneBrief(data, script, notes);
}
