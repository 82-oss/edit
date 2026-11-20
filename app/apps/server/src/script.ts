// Scripts: read a Google Doc (footage ranges linked to Google
// Drive files and the narration between them), download the footage from
// Drive, and lay the edit out in order: each range as a clip, each narration
// as a cut-in card.
//
// Requests go out through Bun's fetch. Redirects are followed by hand so a Google
// call never leaves https (unless a stand-in over http is set, endpoints.ts),
// as curl's `--proto` / `--proto-redir` held it. Drive's "can't scan this
// file for viruses" page is skipped with `confirm=t`, or by following its form.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { parseTranscript } from "./captions_core.ts";
import { clipFrom, textStyleFrom } from "./clips.ts";
import * as diag from "./diag.ts";
import * as endpoints from "./endpoints.ts";
import { nowMs } from "./files.ts";
import * as framing from "./framing.ts";
import { catchBugsAsync, crashed, isBug } from "./guard.ts";
import { importMade, importPaths } from "./import.ts";
import * as mediaModule from "./media.ts";
import { cloudEnabled } from "./relay.ts";
import type { ClipColor, Media, Project, Script, ScriptBlock, ScriptJob, Style, TextStyle, TrackKind } from "./model.ts";
import { isEssay, NARRATION } from "./model.ts";
import { addTrack, clipOf, duration as projectDuration, fps as fpsOf, freeTrack, freshId, GONE_WITHOUT_NOTE, goneWithout, goneWithoutName, insertTime, marksCut, mediaOf, REUSE_LABEL, reuseCaseLabel, reuseCaseOf, reusedLabel, WHOLE_SOURCE_LABEL, REUSED_SCRIPT_NOTE, reusedScriptBlock } from "./project.ts";
import { fileName, fileStem, extension as pathExtension, join, parent } from "./paths.ts";
import { byteLength, charCount, display, f32, isAlphanumeric, isWhitespace, parseHex, round, splitWhitespace, takeChars, trim } from "./rust.ts";
import * as ranged from "./ranged_download.ts";
import * as reuseCases from "./reuse_cases.ts";
import * as seams from "./seams.ts";
import type { DriveHead, Excerpt, Parsed } from "./seams.ts";
import * as tools from "./tools.ts";
import * as proc from "./effect/proc.ts";
import { runPromise } from "./effect/runtime.ts";
import { retryAfterOf } from "./effect/service.ts";
import { hearsAll, type Transcript, type Word } from "./transcribe.ts";
import * as youtube from "./youtube.ts";
import * as posts from "./posts.ts";
import { LINK_PREFIX as FINISHED_LINK, reviewCode, reviewOf } from "./finished.ts";
import { finishCase, pendingCase } from "./case_insertion.ts";
import * as durableJobs from "./jobs.ts";
import * as failure from "./failure.ts";
import * as steps from "./import_steps.ts";
import * as keyframeIndex from "./keyframe_index.ts";
import { THIS_MACHINE } from "./machine.ts";

export type { DriveHead, Excerpt, Parsed } from "./seams.ts";

/** How long a cut-in card holds when there's no voice-over yet. */
export const CUT_IN_SECONDS = 3.0;

/** Waits (tests make them instant). */
export const timing = {
  sleep: (ms: number) => Bun.sleep(ms),
  now: () => performance.now(),
  /** A download sending nothing for this long is dropped and resumed (a dead connection never ends by itself). */
  stall: 60_000,
  /** The pauses before Edit tries the voice-over again by itself (a file's tries are failure.ts's, from the job table). */
  retryWaits: [60_000, 5 * 60_000],
};

/** Whether a failure may pass if tried again (import_steps.ts `whyOf`: anything but the person's). */
export const passing = steps.passing;

/** The footage files a script names, with what the person knows each by (its case, its file name). */
export function footageLabel(project: Project, file: string): string {
  const blocks = (project.script?.blocks ?? []).filter((block): block is Extract<ScriptBlock, { kind: "footage" }> => block.kind === "footage" && block.file === file);
  const notes = blocks.flatMap((block) => block.notes ?? []);
  const named = notes.find((note) => note.startsWith("Source: "))?.slice("Source: ".length);
  const kase = notes.find((note) => /^Case [^:]+:/.test(note))?.split(":")[0];
  const label = [kase, named].filter(Boolean).join(" · ");
  return label !== "" ? label : (blocks[0]?.url ?? file);
}

function waitingFor(app: App, id: string, file: string): Project {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  if (app.scripts.working(id)) throw new Error("The import is still working: wait for it to finish first.");
  if (laidOut(live.project)) throw new Error("This edit is already laid out: add footage to it with insert_compilation_case, or import it as media.");
  if (!(live.project.script?.blocks ?? []).some((block) => block.kind === "footage" && block.file === file)) throw new Error(`The script has no footage file ${file}.`);
  return live.project;
}

/**
 * Gives footage file `file` another link (a Drive file or a YouTube video of
 * the same recording: the script's times stay as they are), then carries on
 * the import. The person's "do you have a replacement?".
 */
export async function replaceFootage(app: App, id: string, file: string, url: string): Promise<void> {
  waitingFor(app, id, file);
  const replacement = footageFile(url.trim());
  if (replacement === null) throw new Error("Give a link to one video: a Google Drive file or a YouTube video (not a folder or a Doc).");
  await app.store.update(id, "script", (project) => {
    for (const block of project.script?.blocks ?? []) {
      if (block.kind !== "footage" || block.file !== file) continue;
      block.file = replacement;
      block.url = url.trim();
      block.notes = [...(block.notes ?? []), `Replaced: ${file}`];
    }
  });
  void start(app, id, false);
}

/**
 * Goes on without footage file `file`, the person's "proceed without it": its
 * ranges stay in the script, each holding its place in the edit as a black
 * card of its length (`goneWithout`), and the rest is laid out as written.
 * Taking them out of the script (as it did until Nov 19) left JJ's School
 * Bookkeeper a 2:44 edit of its door footage, the 22-minute interview gone.
 */
export async function skipFootage(app: App, id: string, file: string): Promise<void> {
  // "*": every file it couldn't get, in one go (each skip starts the import again, so one at a time the second was refused).
  // Never one still being tried by itself (a dropped connection): that one comes in.
  const job = app.scripts.get(id);
  const askable = (one: { state: string; why?: string }) => one.state === "failed" || (one.state === "waiting" && one.why !== "passing");
  const files = file === "*" ? (job?.files ?? []).filter(askable).map((one) => one.file) : [file];
  if (files.length === 0) throw new Error("Nothing is waiting to be skipped.");
  // One given by name (the agent's tool, an older page) the same: only a file that's the person's to answer, never one
  // still being brought in by itself (Astra's council, Nov 19: the named path never asked).
  const named = file === "*" ? undefined : job?.files.find((one) => one.file === file);
  // By name, only a file that's the person's (failed): one waiting for room, credit or a sign-in comes in by itself too.
  if (named !== undefined && named.state !== "failed") throw new Error("Edit is still bringing this in by itself: it comes in once the connection is back.");
  const project = waitingFor(app, id, files[0]!);
  if (!(project.script?.blocks ?? []).some((block) => block.kind === "footage" && !files.includes(block.file) && !goneWithout(block))) {
    throw new Error("That's the only footage in the script: give another link for it instead.");
  }
  const nameOf = (one: string): string => job?.files.find((entry) => entry.file === one)?.name ?? footageLabel(project, one);
  await app.store.update(id, "script", (edited) => {
    for (const block of edited.script?.blocks ?? []) {
      if (block.kind !== "footage" || !files.includes(block.file) || goneWithout(block)) continue;
      block.notes = [...(block.notes ?? []), `${GONE_WITHOUT_NOTE}${nameOf(block.file)}`];
    }
  });
  diag.info("script", `${project.name}: going on without ${files.map(nameOf).join(", ")}, as asked: ${files.length === 1 ? "its" : "their"} ranges hold their place as black cards`);
  void start(app, id, false);
}

// ---------------------------------------------------------------------------
// Reading the Doc.

/** The document id in a Google Docs link. */
export function docId(url: string): string | null {
  const at = url.indexOf("/document/d/");
  if (at < 0) return null;
  const id = idChars(url.slice(at + "/document/d/".length));
  return id.length > 10 ? id : null;
}

/** The file id in a Google Drive link (`/file/d/ID/…`, `open?id=ID`, `uc?id=ID`). */
export function driveFileId(url: string): string | null {
  if (!url.includes("drive.google.com") && !url.includes("drive.usercontent.google.com")) return null;
  const at = url.indexOf("/file/d/");
  let id: string;
  if (at >= 0) {
    id = idChars(url.slice(at + "/file/d/".length));
  } else {
    const value = query(url, "id");
    if (value === null) return null;
    id = idChars(value);
  }
  return id.length > 10 ? id : null;
}

function idChars(text: string): string {
  let out = "";
  for (const c of text) {
    if (/^[A-Za-z0-9_-]$/.test(c)) out += c;
    else break;
  }
  return out;
}

/**
 * A query parameter's raw value. A query value runs to the next `&` (Docs
 * leaves the `?` inside `q=` unescaped).
 */
export function query(url: string, key: string): string | null {
  const question = url.indexOf("?");
  if (question < 0) return null;
  const search = url.slice(question + 1).split("#")[0]!;
  const needle = `${key}=`;
  let from = 0;
  for (;;) {
    const at = search.indexOf(needle, from);
    if (at < 0) return null;
    const before = at === 0 ? undefined : search[at - 1];
    if (before === undefined || before === "&" || before === "?") {
      return search.slice(at + needle.length).split("&")[0]!;
    }
    from = at + 1;
  }
}

/**
 * Fetches `url` (a Google call), following redirects by hand so none leaves
 * the protocols curl's `--proto` / `--proto-redir` allowed.
 */
async function googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const allowHttp = endpoints.googleProto() === "=http,https";
  let current = url;
  // The sign-in goes only to Google's API, never on to wherever a redirect points.
  const bearer = await bearerFor(url);
  for (let hops = 0; hops <= 50; hops++) {
    const scheme = current.slice(0, current.indexOf(":")).toLowerCase();
    if (!(scheme === "https" || (allowHttp && scheme === "http"))) {
      throw new Error(`Protocol "${scheme}" not supported or disabled in libcurl`);
    }
    const headers = new Headers(init.headers);
    if (bearer !== null && current.startsWith(endpoints.google(GOOGLE_API))) headers.set("authorization", `Bearer ${bearer}`);
    else headers.delete("authorization");
    const response = await fetch(current, { ...init, headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      void response.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    Object.defineProperty(response, "url", { value: current });
    return response;
  }
  throw new Error("Maximum (50) redirects followed");
}

/** A response's body as bytes, giving up past `max` bytes (curl's --max-filesize). */
async function boundedBody(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) {
    void response.body?.cancel();
    throw new Error("Maximum file size exceeded");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body !== null) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > max) throw new Error("Maximum file size exceeded");
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

/** Google's APIs: the only place the team's sign-in is sent. */
const GOOGLE_API = "https://www.googleapis.com/";
/** A Drive file's bytes, read with the sign-in. */
function apiMedia(file: string): string {
  return endpoints.google(`${GOOGLE_API}drive/v3/files/${encodeURIComponent(file)}?alt=media&supportsAllDrives=true`);
}

/** The sign-in's token for a request to Google's API (null: none, or not an API request). */
export async function bearerFor(url: string): Promise<string | null> {
  return url.startsWith(endpoints.google(GOOGLE_API)) ? signedIn() : null;
}

/**
 * The team's Google sign-in (the sound library's, `Library.accessToken`):
 * Docs and Drive files are read with it first, so a file only the team can
 * see imports like a public one. Set by `createApp`; null in a build without
 * the sign-in, which reads public links only.
 */
let googleToken: (() => Promise<string>) | null = null;
export function useGoogleSignIn(token: (() => Promise<string>) | null): void {
  googleToken = token;
}

/** The sign-in's token, or null when there's none to use (never an error: the public link is tried). */
async function signedIn(): Promise<string | null> {
  if (googleToken === null) return null;
  try {
    return await googleToken();
  } catch {
    return null;
  }
}

/** A Doc as the team's sign-in reads it (Drive's HTML export, the same as the public one), or null when it can't. */
async function docSignedIn(id: string): Promise<[html: string, title: string] | null> {
  if ((await signedIn()) === null) return null;
  try {
    const meta = await googleFetch(endpoints.google(`${GOOGLE_API}drive/v3/files/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`), {
      signal: AbortSignal.timeout(30_000),
    });
    if (meta.status !== 200) {
      void meta.body?.cancel();
      return null;
    }
    const name = ((await meta.json()) as { name?: unknown }).name;
    const response = await googleFetch(endpoints.google(`${GOOGLE_API}drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/html`), {
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) {
      void response.body?.cancel();
      return null;
    }
    const body = new TextDecoder().decode(await boundedBody(response, 20_000_000));
    return body.includes("<body") ? [body, typeof name === "string" ? name : ""] : null;
  } catch {
    return null;
  }
}

/**
 * Fetches a Doc as HTML (which keeps each link's target) and its title (the
 * export's file name): with the team's sign-in when it can see it, else as
 * its public link. What went wrong says what to do: sharing only when Google
 * asked for a sign-in, never for a timeout or a busy Google.
 */
export async function fetchDoc(id: string): Promise<[html: string, title: string]> {
  const signed = await docSignedIn(id);
  if (signed !== null) return signed;
  const url = endpoints.google(`https://docs.google.com/document/d/${id}/export?format=html`);
  const problem = "Couldn't read that Google Doc. Share it so anyone with the link can view, or copy all its text (⌘A, ⌘C in the Doc) and paste that here instead.";
  let body: string;
  let code: number;
  let effective: string;
  let disposition: string;
  try {
    const response = await googleFetch(url, { signal: AbortSignal.timeout(30_000) });
    code = response.status;
    effective = response.url;
    disposition = response.headers.get("content-disposition") ?? "";
    body = new TextDecoder().decode(await boundedBody(response, 20_000_000));
  } catch {
    throw new Error("Couldn't reach Google Docs to read the script. Check the internet connection and try again.");
  }
  if (code === 404) throw new Error(`That Google Doc doesn't exist, or ${THIS_MACHINE}'s Google account can't see it. Check the link, or copy all its text (⌘A, ⌘C in the Doc) and paste that here instead.`);
  if (code === 429 || code >= 500) throw new Error("Google Docs is busy right now. Try again in a minute.");
  if (code !== 200 || effective.includes("accounts.google.com") || !body.includes("<body")) throw new Error(problem);
  let title = dispositionName(disposition) ?? "";
  while (title.endsWith(".html")) title = title.slice(0, -".html".length);
  return [body, title];
}

/**
 * One paragraph of the Doc: its text, which ranges of it link where, and the
 * comment markers ([a], [b]…) at their offsets.
 */
interface Para {
  text: string;
  links: [number, number, string][];
  refs: [number, string][];
  /** A Doc heading (Heading 1–6), or a paragraph whose words are all bold. */
  heading: boolean;
  /** How many of its letters are bold. */
  bold: number;
}

function newPara(heading = false): Para {
  return { text: "", links: [], refs: [], heading, bold: 0 };
}

/** Google Docs' HTML export: paragraphs, links, and the comments at the end. */
function readHtml(html: string): [string, Para[], Map<string, string>] {
  let title = "";
  const paras: Para[] = [];
  const comments = new Map<string, string>();
  const addComment = (id: string, text: string) => comments.set(id, (comments.get(id) ?? "") + text);
  let current: Para | null = null;
  let link: [number, string] | null = null;
  let marker = false;
  let comment: string | null = null;
  let inTitle = false;
  let hidden = false;
  let style = "";
  // Docs marks bold with a class whose rule has font-weight:700, on spans.
  let boldClasses: Set<string> | null = null;
  const spans: boolean[] = [];
  let rest = html;
  while (rest !== "") {
    if (rest.startsWith("<")) {
      const open = rest.slice(1);
      const close = open.indexOf(">");
      const tag = close < 0 ? open : open.slice(0, close);
      rest = close < 0 ? "" : open.slice(close + 1);
      const closing = tag.startsWith("/");
      let name = "";
      for (const c of tag.replace(/^\/+/, "")) {
        if (/^[A-Za-z0-9]$/.test(c)) name += c;
        else break;
      }
      name = name.toLowerCase();
      switch (name) {
        case "title":
          inTitle = !closing;
          break;
        case "style":
        case "script":
          hidden = !closing;
          break;
        case "span": {
          if (closing) {
            spans.pop();
            break;
          }
          boldClasses ??= new Set([...style.matchAll(/\.([\w-]+)\{[^}]*font-weight:\s*(?:700|800|900|bold)/g)].map((m) => m[1]!));
          const classes = (attribute(tag, "class") ?? "").split(/\s+/);
          spans.push(classes.some((name) => boldClasses!.has(name)) || /font-weight:\s*(?:700|bold)/.test(attribute(tag, "style") ?? ""));
          break;
        }
        case "p":
        case "li":
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
          if (current !== null) {
            const para: Para = current;
            current = null;
            if (comment !== null) addComment(comment, "\n");
            else paras.push(para);
          }
          if (!closing) current = newPara(name.startsWith("h"));
          break;
        }
        case "br":
          if (current !== null) current.text += "\n";
          break;
        case "a": {
          if (closing) {
            if (marker) {
              marker = false;
            } else if (link !== null && current !== null) {
              const [start, href] = link;
              link = null;
              current.links.push([start, current.text.length, href]);
            } else {
              link = null;
            }
            break;
          }
          const rawHref = attribute(tag, "href");
          const href = rawHref === null ? null : decodeEntities(rawHref);
          const id = attribute(tag, "id");
          if (href !== null && id !== null && href.startsWith("#cmnt_ref")) {
            // A comment's own text starts here (href back to its marker).
            comment = id;
            marker = true;
          } else if (href !== null && id !== null && href.startsWith("#cmnt")) {
            // A comment marker in the text.
            if (current !== null) current.refs.push([current.text.length, href.startsWith("#") ? href.slice(1) : href]);
            marker = true;
          } else if (href !== null && !href.startsWith("#")) {
            const start = current === null ? 0 : current.text.length;
            link = [start, unwrapGoogleRedirect(href)];
          }
          break;
        }
        default:
          break;
      }
    } else {
      const end = rest.indexOf("<");
      const raw = end < 0 ? rest : rest.slice(0, end);
      rest = end < 0 ? "" : rest.slice(end);
      const text = decodeEntities(raw);
      if (hidden) {
        style += text;
        continue;
      }
      if (marker) continue;
      if (inTitle) title += text;
      else if (comment !== null) addComment(comment, text);
      else if (current !== null) {
        current.text += text;
        if (spans.at(-1) === true) current.bold += (text.match(/\p{L}/gu) ?? []).length;
      }
    }
  }
  if (current !== null && comment === null) paras.push(current);
  return [trim(title), paras, comments];
}

/** An attribute's raw value in a tag (` name="…"`). */
function attribute(tag: string, name: string): string | null {
  const needle = ` ${name}="`;
  const at = tag.indexOf(needle);
  if (at < 0) return null;
  const rest = tag.slice(at + needle.length);
  const end = rest.indexOf('"');
  return end < 0 ? null : rest.slice(0, end);
}

/** Docs wraps links as google.com/url?q=<target>. */
function unwrapGoogleRedirect(href: string): string {
  if (href.includes("google.com/url?")) {
    const target = query(href, "q");
    if (target !== null) return percentDecode(target);
  }
  return href;
}

/** `%xx` escapes decoded byte by byte (a `%` not followed by two hex digits stays). */
export function percentDecode(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i]!;
    if (byte === 0x25 && i + 2 < bytes.length) {
      // Not two hex digits (or not even whole characters): a plain `%`.
      const high = bytes[i + 1]!;
      const low = bytes[i + 2]!;
      const decoded = high < 0x80 && low < 0x80 ? parseHex(String.fromCharCode(high, low), 0xff) : null;
      if (decoded !== null) {
        out.push(decoded);
        i += 3;
        continue;
      }
    }
    out.push(byte);
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

/** A decimal or hex number as `u32::from_str` / `from_str_radix` read it (an optional `+`). */
function parseU32(text: string, radix: 10 | 16): number | null {
  if (radix === 16) return parseHex(text);
  if (!/^\+?[0-9]+$/.test(text)) return null;
  const value = Number(text.startsWith("+") ? text.slice(1) : text);
  return value <= 0xffff_ffff ? value : null;
}

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  let out = "";
  let rest = text;
  for (;;) {
    const amp = rest.indexOf("&");
    if (amp < 0) break;
    out += rest.slice(0, amp);
    const after = rest.slice(amp + 1);
    // An entity is short: its `;` comes within the next few bytes.
    const semi = after.indexOf(";");
    if (semi < 0 || byteLength(after.slice(0, semi)) >= 11) {
      out += "&";
      rest = after;
      continue;
    }
    const entity = after.slice(0, semi);
    const tail = after.slice(semi + 1);
    let decoded: string | null = Object.hasOwn(NAMED, entity) ? NAMED[entity]! : null;
    if (decoded === null) {
      let code: number | null = null;
      if (entity.startsWith("#x")) code = parseU32(entity.slice(2), 16);
      if (code === null && entity.startsWith("#")) code = parseU32(entity.slice(1), 10);
      if (code !== null && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) decoded = String.fromCodePoint(code);
    }
    if (decoded !== null) {
      out += decoded === " " ? " " : decoded;
      rest = tail;
    } else {
      out += "&";
      rest = after;
    }
  }
  return out + rest;
}

/** A "mm:ss - mm:ss" (or h:mm:ss) range in text: its span and seconds. */
interface Range {
  start: number;
  end: number;
  from: number;
  to: number;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

function countDigits(text: string, from: number): number {
  let count = 0;
  while (isDigit(text[from + count])) count += 1;
  return count;
}

/** Parses "m:ss" / "mm:ss" / "h:mm:ss" at `at` in `text`: (seconds, characters used). */
function timestamp(text: string, at: number): [number, number] | null {
  const parts: number[] = [];
  let used = 0;
  for (;;) {
    const digits = countDigits(text, at + used);
    if (digits === 0 || digits > 2 || (parts.length > 0 && digits !== 2)) return null;
    parts.push(Number(text.slice(at + used, at + used + digits)));
    used += digits;
    if (parts.length < 3 && text[at + used] === ":" && isDigit(text[at + used + 1])) used += 1;
    else break;
  }
  if (parts.length < 2 || parts.slice(1).some((part) => part >= 60)) return null;
  return [parts.reduce((total, part) => total * 60 + part, 0), used];
}

const DASHES = ["-", "–", "—", "‑", "‐", "−"];

export function findRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let at = 0;
  while (at < text.length) {
    let start = -1;
    for (let index = at; index < text.length; index++) {
      if (isDigit(text[index])) {
        start = index;
        break;
      }
    }
    if (start < 0) break;
    const before = start > 0 ? text[start - 1] : undefined;
    const afterDigit = isDigit(before) || before === ":";
    const first = afterDigit ? null : timestamp(text, start);
    if (first !== null) {
      const [from, used] = first;
      let cursor = start + used;
      const skip = () => {
        for (;;) {
          const c = text.codePointAt(cursor);
          if (c === undefined) return;
          const char = String.fromCodePoint(c);
          if (!(isWhitespace(char) || char === " ")) return;
          cursor += char.length;
        }
      };
      skip();
      const dash = text[cursor];
      if (dash !== undefined && DASHES.includes(dash)) {
        cursor += 1;
        skip();
        const second = timestamp(text, cursor);
        if (second !== null) {
          const [to, used2] = second;
          const end = cursor + used2;
          if (to > from) ranges.push({ start, end, from, to });
          at = end;
          continue;
        }
      }
    }
    at = start + Math.max(countDigits(text, start), 1);
  }
  return ranges;
}

function collapse(text: string): string {
  let out = "";
  text.split("\n").forEach((raw, index) => {
    const line = splitWhitespace(raw).join(" ");
    if (index > 0 && line !== "" && out !== "") out += "\n";
    out += line;
  });
  return trim(out);
}

/**
 * The comments on a stretch of text, minus resolved ones: a reply of
 * "fixed"/"done" closes the note before it.
 */
function notes(refs: [number, string][], comments: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [, id] of refs) {
    const raw = comments.get(id);
    if (raw === undefined) continue;
    const text = collapse(raw);
    if (text === "") continue;
    const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[.!]+$/, "");
    if (["fixed", "done", "resolved", "ok", "okay"].includes(lower)) out.pop();
    else out.push(text);
  }
  return out;
}

/** The label of a footage block that plays a reused video whole (a narration's "Reuse: <link>" note). */
export const REUSE = REUSE_LABEL;

/**
 * A note naming another script: any Google Doc link ("Edit case 2 based on
 * this script here: <Doc>", "Reuse: <Doc>", or the link alone). Scripts carry
 * Doc links only to reuse one (the user, Oct 28: "99% of the time we do not
 * have Google Doc links on scripts. We only include them if it's a reuse
 * case"). The Doc's id, else null.
 */
export function caseScript(note: string): string | null {
  const reuse = /^reuse:\s*(\S+)/i.exec(note)?.[1];
  if (reuse && footageFile(reuse)) return null; // Explicit finished video, not both it and its earlier script.
  const link = /https:\/\/docs\.google\.com\/document\/d\/[\w-]+\S*/.exec(note)?.[0];
  return link === undefined ? null : docId(link);
}

/** How deep reused scripts may nest (a script reusing one that reuses another…). */
const REUSE_DEPTH = 6;

/**
 * Reads the reused scripts a script links in, each where it was linked, at
 * any depth: a reused script's own reused scripts come in too (they were left
 * out without a word, Oct 28). Each block notes the Doc it came from, so it's
 * thrown in as written. A Doc linking back to one already in the chain, or one
 * with no footage ranges (notes, research), is left out and said in
 * `skipped`; one that can't be read stops the import, naming it. `seen`: the
 * Docs above this one (the top script's own id among them).
 */
export async function joinCases(
  parsed: Parsed,
  read: (id: string) => Promise<string | [html: string, title: string]> = fetchDoc,
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): Promise<Parsed> {
  const cases = parsed.cases ?? [];
  delete parsed.cases;
  const reused = parsed.reused ?? [];
  const skipped = parsed.skipped ?? [];
  for (const { after, doc } of [...cases].reverse()) {
    if (seen.has(doc)) {
      skipped.unshift({ doc, why: "it links back to a script already in this one" });
      continue;
    }
    if (depth >= REUSE_DEPTH) {
      skipped.unshift({ doc, why: `reused scripts nest more than ${REUSE_DEPTH} deep` });
      continue;
    }
    let html: string;
    let docTitle = "";
    try {
      const got = await read(doc);
      [html, docTitle] = typeof got === "string" ? [got, ""] : got;
    } catch (error) {
      throw new Error(`Couldn't read the reused script https://docs.google.com/document/d/${doc}/edit: ${diag.messageOf(error)}`);
    }
    const inner = await joinCases(parse(html), read, new Set([...seen, doc]), depth + 1);
    // Its name: the Doc's title, else its first line ("INTERRO Elias Campos - The Interview").
    const title = docTitle || inner.title || inner.heading;
    if (!inner.blocks.some((block) => block.kind === "footage")) {
      skipped.unshift({ doc, ...(title ? { title } : {}), why: "it has no footage ranges, so it isn't a script to reuse" });
      continue;
    }
    for (const block of inner.blocks) {
      // The innermost Doc a block came from is the one it's preserved as.
      if (!(block.notes ?? []).some((note) => note.startsWith(REUSED_SCRIPT_NOTE))) {
        block.notes = [...(block.notes ?? []), `${REUSED_SCRIPT_NOTE}https://docs.google.com/document/d/${doc}/edit`];
      }
      if (block.kind === "footage") { delete block.words; delete block.cut; }
    }
    parsed.blocks.splice(after, 0, ...inner.blocks);
    reused.unshift({ doc, ...(title ? { title } : {}), footage: inner.blocks.filter((block) => block.kind === "footage").length }, ...(inner.reused ?? []));
    skipped.unshift(...(inner.skipped ?? []));
  }
  if (reused.length > 0) parsed.reused = reused;
  if (skipped.length > 0) parsed.skipped = skipped;
  return parsed;
}

/** The script file a footage link names: a Drive file id, or `youtube:<id>`. */
export function footageFile(url: string): string | null {
  const review = reviewCode(url);
  // A finished video of ours by its review link: looked up before the import (compilation_input).
  if (review !== null) return `${FINISHED_LINK}${review}`;
  return driveFileId(url) ?? youtube.fileOf(url) ?? posts.fileOf(url);
}

/** A link's `t=` in seconds: Drive's `91.506`, YouTube's `86`, `86s` or `1m26s`. */
function linkStart(url: string): number | null {
  const t = query(url, "t");
  if (t === null) return null;
  return youtube.videoId(url) !== null ? youtube.startOf(t) : parseF64(t.replace(/s+$/, ""));
}

/**
 * The narration in text beside ranges in one paragraph (a Doc that runs the
 * cut-ins on from the ranges, "…the investigation. (0:42 - 2:52)The
 * investigation proved…"): words, not the brackets and pluses between ranges.
 */
function besideRanges(text: string): string | null {
  const words = text.match(/\p{L}[\p{L}'’]*/gu) ?? [];
  if (words.length < 3) return null;
  const cleaned = collapse(text)
    .replace(/^[\s()[\]+&,]+/u, "")
    .replace(/[\s([+&,]+$/u, "");
  return cleaned === "" ? null : cleaned;
}

/**
 * The kind of video a script's heading names: Writer heads every Doc with its
 * series ("COURT Tim James - …", "INTERRO …", "FOIA …"); null when it doesn't
 * say. (The team, Oct 28: "the script says COURT at the start".)
 */
export function headerStyle(heading: string): Style | null {
  const word = /^\s*([A-Za-z]+)/.exec(heading)?.[1]?.toUpperCase();
  if (word === undefined) return null;
  if (word === "COURT" || word === "COURTROOM") return "courtroom";
  if (word === "INTERRO" || word === "INTERROGATION") return "interrogation";
  if (word === "FOIA" || word === "BODYCAM" || word === "BWC") return "bodycam";
  if (word === "COMMENTARY") return "commentary";
  if (word === "HORROR") return "horror";
  if (word === "SHORT" || word === "SHORTS") return "shorts";
  return null;
}

/**
 * A paragraph's words with its Google Doc links' text taken out: null when
 * what's left is only a label ("The earlier case:", "Reuse", a few words), so
 * a reused script's link is never voiced as narration.
 */
function withoutDocLinks(para: { text: string; links: [number, number, string][] }): string | null {
  const docs = para.links.filter(([, , url]) => docId(url) !== null && footageFile(url) === null);
  if (docs.length === 0) return collapse(para.text);
  let text = "";
  let at = 0;
  for (const [start, end] of [...docs].sort((a, b) => a[0] - b[0])) {
    text += para.text.slice(at, start);
    at = Math.max(at, end);
  }
  text = collapse(text + para.text.slice(at)).replace(/\bhttps?:\/\/docs\.google\.com\/\S+/g, "").trim();
  const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words.length < 5 || /[:\-–—]$/.test(text) ? null : text;
}

/** A script's line giving the narrator's recording: "Voice-over: <link>", "VO - <link>", "Recording: <link>". */
const RECORDING_LINE = /^(voice[\s-]?over|vo|recording|narration)( recording)?\s*[:\-–—]/iu;
/** The note on a script's first narration that carries its recording's link, until the import fetches it. */
export const RECORDING_NOTE = "Voice-over recording: ";

/**
 * The recording a script gave ("Voice-over: <Drive link>"), fetched into the
 * project as audio off the timeline, where the import's next step places it
 * on the cut-ins it reads. Nothing when it's there already.
 */
async function fetchRecording(app: App, id: string): Promise<void> {
  const project = app.store.get(id)?.project;
  if (project === undefined || unplacedAudio(project)) return;
  const note = (project.script?.blocks ?? []).flatMap((block) => block.notes ?? []).find((n) => n.startsWith(RECORDING_NOTE));
  const file = note === undefined ? null : driveFileId(note.slice(RECORDING_NOTE.length));
  if (file === null) return;
  const path = await diag.timeOnAsync("script", "script: the recording", `Drive file ${file}`, () => download(join(app.store.driveDir(), file), file, () => {}));
  const [, ids, errors] = await importPaths(app, id, [path], false, "script");
  if (ids[0] === undefined) throw new Error(errors[0] ?? "the recording didn't import");
}

/** A producer's line about the video, never voiced: "Total time = 29.5min", "Duration: 27m", "Runtime - 12 min". */
const META_LINE = /^(total\s+)?(time|duration|length|run\s?time|word count)\s*[:=\-–—]/iu;

/**
 * A paragraph of narration: a sentence of eight words or more, ended as one.
 * A script whose voice-over opens before its first range (a horror cold open:
 * "In November 2025, a man in his early sixties would start a brand new
 * YouTube channel.") starts there; a title, a "FOIA Kent Police - Mother
 * Finds Out…" heading or "Total Duration: 27m" never does.
 */
function prose(text: string): boolean {
  const words = text.split(/\s+/).filter((word) => /\p{L}/u.test(word));
  return words.length >= 8 && /[.!?…]["'”’)\]]*$/u.test(text);
}

/**
 * A chapter title written on its own line: a Doc heading, or a short line all
 * in bold that doesn't end as a sentence ("The trial", "Case 2: Stephen Clancy
 * Hill", "Ending"). It's shown on screen, never voiced (the horror Doc of Nov 8:
 * "Before the VO: Animation 7 chapter title slide-up 'The trial'").
 */
function chapterTitle(para: Para, text: string): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters === 0 || text.split(/\s+/).length > 12 || /[.!?…]["'”’)\]]*$/u.test(text)) return false;
  return para.heading || para.bold >= letters;
}

/** The note a chapter title leaves on the narration after it. */
export const CHAPTER_NOTE = "Chapter title (on screen, not voiced): ";

/** A narration's link to a finished video of ours whose words are "Reuse" ("(Reuse)", "REUSE"). */
const REUSE_WORD = /^\(?\s*re-?use\s*\)?$/iu;
/** A comment naming which case of a reused video plays: "Case 1", "case 2", "Case #3". */
const CASE_COMMENT = /^case\s*(?:#|no\.?|number)?\s*(\d+)\b/iu;

/** A "(Reuse)" link in a paragraph: where it was, what it plays, and the case its comment names (null: the whole video). */
interface ReuseLink {
  at: number;
  url: string;
  file: string;
  case: number | null;
  note: string | null;
}

/**
 * Takes a paragraph's "(Reuse)" links out of it (Sphe, Nov 16: the team
 * writes a reused case as a "Reuse" link in the narration, with a comment
 * saying which case of that video): the link and its brackets are blanked
 * (so the offsets of what's left hold) and never voiced, and each "Case N"
 * comment on the paragraph goes to the reuse link nearest it.
 */
function takeReuseLinks(para: Para, comments: Map<string, string>): ReuseLink[] {
  const found = para.links.filter(([start, end, url]) => REUSE_WORD.test(para.text.slice(start, end).trim()) && footageFile(url) !== null);
  if (found.length === 0) return [];
  let text = para.text;
  const blank = (from: number, to: number) => {
    text = text.slice(0, from) + " ".repeat(Math.max(0, to - from)) + text.slice(to);
  };
  for (const [start, end] of found) {
    blank(start, end);
    let before = start - 1;
    while (before >= 0 && /\s/u.test(text[before]!)) before--;
    let after = end;
    while (after < text.length && /\s/u.test(text[after]!)) after++;
    if (text[before] === "(" && text[after] === ")") {
      blank(before, before + 1);
      blank(after, after + 1);
    }
  }
  para.text = text;
  para.links = para.links.filter((link) => !found.includes(link));
  const out: ReuseLink[] = found.map(([start, , url]) => ({ at: start, url, file: footageFile(url)!, case: null, note: null }));
  // Each case comment to its nearest reuse link; a link given two keeps the nearer.
  const distance = (at: number, [start, end]: [number, number, string]) => (at < start ? start - at : at > end ? at - end : 0);
  const best = new Map<number, [ref: [number, string], distance: number, number: number, note: string]>();
  for (const ref of para.refs) {
    const note = collapse(comments.get(ref[1]) ?? "").split("\n")[0]!.trim();
    const number = /https?:/u.test(note) ? undefined : CASE_COMMENT.exec(note)?.[1];
    if (number === undefined) continue;
    let nearest = 0;
    found.forEach((link, index) => {
      if (distance(ref[0], link) < distance(ref[0], found[nearest]!)) nearest = index;
    });
    const far = distance(ref[0], found[nearest]!);
    const held = best.get(nearest);
    if (held === undefined || far < held[1]) best.set(nearest, [ref, far, Number(number), note]);
  }
  for (const [index, [ref, , number, note]] of best) {
    out[index]!.case = number;
    out[index]!.note = note;
    para.refs = para.refs.filter((one) => one !== ref);
  }
  return out;
}

/** Reads a script Doc's HTML export into footage ranges and narration. */
export function parse(html: string): Parsed {
  const [title, paras, comments] = readHtml(html);
  // A narration's "(Reuse)" links: never voiced, never a range's file.
  const reuseLinks = new Map(paras.map((para) => [para, takeReuseLinks(para, comments)]));
  // The Doc's first line says which kind of video it is.
  // Its first line of words (a Doc opening on ranges has none to name it by).
  const heading = paras.find((para) => collapse(para.text) !== "" && findRanges(para.text).length === 0 && /[\p{L}]{3}/u.test(para.text));
  const style = heading === undefined ? null : headerStyle(collapse(heading.text));
  // A range without its own link belongs to the last linked file (or the only one).
  const files: [string, string][] = [];
  for (const para of paras) {
    // The recording's line isn't footage.
    if (RECORDING_LINE.test(collapse(para.text))) continue;
    for (const [, , url] of para.links) {
      const id = footageFile(url);
      // A post is only ever where it's linked.
      if (id !== null && posts.urlOf(id) === null) files.push([url, id]);
    }
  }
  const only = new Set(files.map(([, id]) => id)).size === 1 ? (files[0] ?? null) : null;
  let last: [string, string] | null = only;
  const blocks: ScriptBlock[] = [];
  const cases: { after: number; doc: string }[] = [];
  // The voice-over has begun: at the first range, or at the first paragraph of
  // narration before it.
  let started = false;
  // A chapter title's note (and the comments on it), for the next block.
  let pending: string[] = [];
  const take = (found: string[]) => {
    const all = [...pending, ...found];
    pending = [];
    return all;
  };
  // "Reuse: <link>" on a narration: a finished video of ours plays after it,
  // whole (its range is set to the whole file once it's downloaded).
  const reuse = (found: string[]) => {
    for (const note of found) {
      const link = /^reuse:\s*(\S+)/i.exec(note)?.[1];
      const file = link === undefined ? null : footageFile(link);
      if (link === undefined || file === null) continue;
      blocks.push({ kind: "footage", url: link, file, start: 0, end: 1, label: REUSE, notes: [note] });
    }
  };
  // A narration's "(Reuse)" link (before `offset` in its paragraph): that
  // finished video plays after it, whole, or only the case its comment names.
  const reuseAfter = (para: Para, offset = Number.MAX_SAFE_INTEGER) => {
    const due = reuseLinks.get(para) ?? [];
    while (due.length > 0 && due[0]!.at < offset) {
      const link = due.shift()!;
      blocks.push({ kind: "footage", url: link.url, file: link.file, start: 0, end: 1, label: link.case === null ? REUSE : reuseCaseLabel(link.case), notes: link.note === null ? [] : [link.note] });
    }
  };
  // "Edit case 2 based on this script here: <Doc>": that case comes next,
  // and the narration after it is a cut-in of its own.
  let caseBreak = false;
  const caseNotes = (found: string[]) => {
    for (const note of found) {
      const doc = caseScript(note);
      if (doc === null) continue;
      cases.push({ after: blocks.length, doc });
      caseBreak = true;
    }
  };
  // A Google Doc linked in the text itself: a reused script, where the link is
  // (the same Doc twice in a row is one).
  const docLinks = (links: [number, number, string][]) => {
    for (const [, , url] of links) {
      const doc = docId(url);
      if (doc === null || footageFile(url) !== null) continue;
      const previous = cases.at(-1);
      if (previous !== undefined && previous.doc === doc && previous.after === blocks.length) continue;
      cases.push({ after: blocks.length, doc });
      caseBreak = true;
    }
  };
  // Paragraphs of narration one after another are one cut-in; narration
  // written on from ranges starts its own (`own`): a hook paragraph followed
  // by a paragraph that runs the setup on into the hearing is two cut-ins.
  // Ranges given with no link (an intro's "(0:00-0:01) + (0:58-1:03)" whose
  // clips weren't picked yet): said to the next narration, never bound to
  // some other file.
  let unbound: string[] = [];
  const narrate = (text: string, given: string[], own = false) => {
    const titled = pending.length > 0;
    given = take(given);
    own ||= titled;
    const found = unbound.length > 0 ? [`No link given for ${unbound.join(" + ")}: choose those moments from the story's own footage`, ...given] : given;
    unbound = [];
    const previous = blocks[blocks.length - 1];
    const after = caseBreak;
    caseBreak = false;
    if (!own && !after && previous !== undefined && previous.kind === "narration") {
      previous.text += `\n\n${text}`;
      previous.notes = [...(previous.notes ?? []), ...found];
    } else {
      blocks.push({ kind: "narration", text, notes: found });
    }
  };
  // "Voice-over: <Drive link>": the narrator's recording, wherever it's written.
  let recording: string | null = null;
  for (const para of paras) {
    const ranges = findRanges(para.text);
    const drive = para.links.find(([, , url]) => driveFileId(url) !== null);
    if (ranges.length === 0 && drive !== undefined && RECORDING_LINE.test(collapse(para.text))) {
      recording = drive[2];
      continue;
    }
    if (ranges.length === 0) {
      const text = collapse(para.text);
      if (!started && prose(text) && !chapterTitle(para, text)) started = true;
      // A producer's line ("Total time = 29.5min") is never voiced; a chapter
      // title is shown, not voiced: both leave their comments to what's next.
      if (started && text !== "" && (META_LINE.test(text) || chapterTitle(para, text))) {
        if (!META_LINE.test(text)) pending.push(`${CHAPTER_NOTE}${text}`);
        pending.push(...notes(para.refs, comments));
        docLinks(para.links);
        continue;
      }
      // The video opens on the first timestamp or the first narration:
      // anything before it is the Doc's heading (title, "Assets:",
      // durations), never a cut-in.
      // A line of no words ("—", "__") only separates parts of the Doc.
      if (text === "" || !started || !/[\p{L}\p{N}]/u.test(text)) {
        // A reused script linked before the first range opens the video:
        // in the text, or in a comment on it (card 1's Doc: "REUSE"
        // highlighted, the reused script's link in the comment on it; the
        // user, Oct 29: "it seems we missed the reuse comment").
        if (started || blocks.length === 0) {
          docLinks(para.links);
          caseNotes(notes(para.refs, comments));
        }
        // "(Reuse)" on a line of its own, after the narration it follows.
        if (started) reuseAfter(para);
        continue;
      }
      const found = notes(para.refs, comments);
      // A post's link (an Instagram reel, an X video: posts.ts) is never
      // voiced: its words are the line before it, and the post plays where
      // it's linked, whole until it's cut ("Take a look at this:" <link>).
      const postLinks = para.links.filter(([, , url]) => posts.fileOf(url) !== null);
      let said = para.text;
      for (const [start, end] of postLinks) said = said.slice(0, start) + " ".repeat(Math.max(0, end - start)) + said.slice(end);
      said = said.replace(/https?:\/\/\S+/gu, (url) => (posts.fileOf(url) !== null ? " ".repeat(url.length) : url));
      // A reused script's link, alone or under a short label ("Case 2:
      // <link>"), is where that script goes, never words to voice.
      const spoken = /[\p{L}\p{N}]/u.test(said) ? withoutDocLinks({ text: said, links: para.links }) : null;
      if (spoken !== null) narrate(spoken, found);
      for (const [, , url] of postLinks) {
        const file = posts.fileOf(url)!;
        blocks.push({ kind: "footage", url, file, start: 0, end: 1, label: WHOLE_SOURCE_LABEL, notes: spoken === null ? found : [] });
      }
      reuseAfter(para);
      reuse(found);
      caseNotes(found);
      docLinks(para.links);
      continue;
    }
    // Narration written on from the ranges in the same paragraph: before,
    // between and after them, in order.
    const said = (from: number, to: number) => (started ? besideRanges(para.text.slice(from, to)) : null);
    const gaps = ranges.map((range, index) => said(index === 0 ? 0 : ranges[index - 1]!.end, range.start));
    const tail = ranges.length > 0 ? said(ranges[ranges.length - 1]!.end, para.text.length) : null;
    started = true;
    // Doc links in a paragraph of ranges: each after the ranges before it.
    const docsHere = para.links.filter(([, , url]) => docId(url) !== null && footageFile(url) === null);
    let docAt = 0;
    const docsBefore = (offset: number) => {
      const due: [number, number, string][] = [];
      while (docAt < docsHere.length && docsHere[docAt]![0] < offset) due.push(docsHere[docAt++]!);
      docLinks(due);
    };
    ranges.forEach((range, index) => {
      docsBefore(range.start);
      const gap = gaps[index];
      const gapFrom = index === 0 ? 0 : ranges[index - 1]!.end;
      if (gap !== null && gap !== undefined) {
        narrate(gap, notes(para.refs.filter(([at]) => at >= gapFrom && at < range.start), comments), true);
      }
      reuseAfter(para, range.start);
      let linked: [string, string] | null = null;
      for (const [start, end, url] of para.links) {
        if (start < range.end && end > range.start) {
          const id = footageFile(url);
          if (id !== null) {
            linked = [url, id];
            break;
          }
        }
      }
      const chosen: [string, string] | null = linked ?? last;
      if (chosen === null) {
        unbound.push(`(${collapse(para.text.slice(range.start, range.end)).replace(/[‑–—]/g, "-")})`);
        return;
      }
      const [url, file] = chosen;
      last = [url, file];
      // The link's ?t= is the exact start (the text rounds to the second).
      const exact = linkStart(url);
      const start = exact !== null && Math.abs(exact - range.from) <= 2 ? exact : range.from;
      // Its notes: from the range (or the paragraph's start) to the next range or narration.
      const nextGap = gaps[index + 1];
      const next =
        index + 1 < ranges.length
          ? nextGap !== null && nextGap !== undefined
            ? range.end
            : ranges[index + 1]!.start
          : tail !== null
            ? range.end
            : Number.MAX_SAFE_INTEGER;
      const from = index === 0 && (gap === null || gap === undefined) ? 0 : range.start;
      const refs = para.refs.filter(([at]) => at >= from && at < next);
      const rangeNotes = notes(refs, comments);
      // A reused script's link in a range's comment comes after that range.
      const reusedHere = rangeNotes.filter((note) => caseScript(note) !== null);
      const block: ScriptBlock = {
        kind: "footage",
        url,
        file,
        start,
        end: Math.max(range.to, start + 0.1),
        label: collapse(para.text.slice(range.start, range.end)).replace(/[‑–—]/g, "-"),
        notes: take(rangeNotes),
      };
      const words = cueWords(rangeNotes);
      if (words !== null) block.words = words;
      blocks.push(block);
      caseNotes(reusedHere);
    });
    if (tail !== null) {
      const after = ranges[ranges.length - 1]!.end;
      const found = notes(para.refs.filter(([at]) => at >= after), comments);
      narrate(tail, found, true);
      reuse(found);
      caseNotes(found);
    }
    reuseAfter(para);
    docsBefore(Number.MAX_SAFE_INTEGER);
  }
  // A title or comment after the last line stays with the last block.
  const lastBlock = blocks.at(-1);
  if (lastBlock !== undefined && pending.length > 0) lastBlock.notes = [...(lastBlock.notes ?? []), ...take([]).filter((note) => !note.startsWith(CHAPTER_NOTE))];
  if (recording !== null) {
    const narration = blocks.find((block) => block.kind === "narration");
    if (narration !== undefined) narration.notes = [`${RECORDING_NOTE}${recording}`, ...(narration.notes ?? [])];
  }
  const first = heading === undefined ? "" : collapse(heading.text);
  return { title, blocks, ...(cases.length > 0 ? { cases } : {}), ...(style !== null ? { style } : {}), ...(first !== "" ? { heading: first } : {}) };
}

/** `str::parse::<f64>`: the whole text a decimal number (or inf/NaN), else null. */
export function parseF64(text: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
  const lower = text.toLowerCase().replace(/^[+-]/, "");
  if (lower === "inf" || lower === "infinity") return text.startsWith("-") ? -Infinity : Infinity;
  if (lower === "nan") return Number.NaN;
  return null;
}

/**
 * The first and last words of a range's "first words....last words" comment
 * (editors write where a range starts and ends this way), or "first words /
 * last words" (Lauana's scripts, Nov 16: "so I know / hi"; a slash with a
 * space each side, so a date's or a link's never counts, and it wins over a
 * trailing "..." as in "is there / you know...").
 */
export function cueWords(found: string[]): [string, string] | null {
  for (const note of found) {
    // What's said, quoted ("\"that house is horrible\"", or two lines quoted one after the other): from its
    // first word to its last. Lauana's hooks (Nov 16) were cut at the Doc's rounded seconds, a 1 s range for a
    // line said in 1.5, and ended mid-line.
    if (QUOTED.test(note)) {
      const said = quoteCue(note.replace(/["“”]/gu, " "));
      if (said !== null) return said;
    }
    let split = note.indexOf(" / ");
    let width = 3;
    if (split < 0) {
      split = note.indexOf("..");
      width = 2;
    }
    if (split < 0) {
      split = note.indexOf("…");
      width = 1;
    }
    if (split < 0) continue;
    const left = note.slice(0, split).replace(/\.+$/, "");
    const right = note.slice(split + width).replace(/^[.…]+/, "").replace(/[.…]+$/, "");
    const first = splitWhitespace(left)[0];
    const lastWord = splitWhitespace(right).at(-1);
    if (first === undefined || lastWord === undefined) continue;
    return [first, lastWord];
  }
  return null;
}

/** A note that is only what's said, in double quotes (straight or curly), one quote or several. */
const QUOTED = /^\s*["“”][^"“”]+["“”](?:\s*["“”][^"“”]+["“”])*\s*$/u;

/** A quote's first and last words as a range's cue: Writer's commentary
 * excerpts start where their quote does (the team, N3on v1: "there's a second
 * or two of talking beforehand… that's a much more natural point to start"). */
export function quoteCue(quote: string | null | undefined): [string, string] | null {
  const said = splitWhitespace((quote ?? "").replace(/[…]|\.{3}/g, " "));
  const first = said[0];
  const last = said.at(-1);
  return first === undefined || last === undefined ? null : [first, last];
}

const EXPECTED = "Expected words (verify against the recording): ";

// ---------------------------------------------------------------------------
// Precise cuts: the Doc rounds ranges to the second, so each range is cut at
// its first and last words as the transcript times them.

/** Room left before the first word and after the last, so cuts breathe. */
export const WORD_PAD = 0.08;
/**
 * Room where a range meets a cut-in: the footage's own sound finishes before
 * the narration starts, and comes back in its room tone after it (JJ, Oct 30,
 * four times in the 16-Year-Old's notes: "the voiceover starts before the
 * real sound audio is finished… the voiceover doesn't overlap at either end";
 * the fix that held gave every cut-in 0.4 s either side). Transcript times run
 * a little early on a word's tail, so 0.08 s cut voices off under the narration.
 */
export const CUT_IN_PAD = 0.4;

/** The room a footage block gets before its first word and after its last: CUT_IN_PAD beside a cut-in, else WORD_PAD. */
export function padsOf(blocks: ScriptBlock[], index: number): [number, number] {
  const beside = (other: ScriptBlock | undefined) => other !== undefined && other.kind === "narration";
  return [beside(blocks[index - 1]) ? CUT_IN_PAD : WORD_PAD, beside(blocks[index + 1]) ? CUT_IN_PAD : WORD_PAD];
}
/**
 * Speech closer than this to the cut runs straight on: no room is left (it
 * would catch the next word), and the cut goes in the quietest instant
 * within `SETTLE` of the word's edge (transcript times are a little loose).
 */
const RUN_ON = 0.3;
const SETTLE = 0.06;
/**
 * The room a pad stops short of the word beside it: its start (or end) never
 * falls in the range once rounded to frames, give or take transcript times
 * (R3, Nov 1: a range padded to the next word's very start played 0.01–0.04 s
 * of "Okay." and "shit" into a cut-in's room).
 */
const NEIGHBOUR_GAP = 0.1;
/** How far from the written time a cue word may be found. */
const CUE_SEARCH = 3.0;

function normalize(word: string): string {
  let out = "";
  for (const c of word) if (isAlphanumeric(c)) out += c.toLowerCase();
  return out;
}

/** A cue word that's spoken: "*Victim groans*" describes a sound, not a word. */
function spoken(word: string): string | null {
  if (/^[*([]/.test(word) || /[*)\]]$/.test(word)) return null;
  const normal = normalize(word);
  return normal === "" ? null : normal;
}

/**
 * How well a transcript word matches a cue word from the Doc: 0 the same, 1
 * the same word spelt a little differently (a plural or possessive, "priuses"
 * for "Prius", or a letter or two off), null not it. Short words must match
 * exactly.
 */
export function likeness(given: string, cue: string): number | null {
  const word = normalize(given);
  if (word === cue) return 0;
  const shortest = Math.min(charCount(word), charCount(cue));
  if (shortest < 4) return null;
  const stem = (text: string) => {
    let out = text;
    if (out.endsWith("es") && byteLength(out.slice(0, -2)) >= 3) out = out.slice(0, -2);
    if (out.endsWith("s") && byteLength(out.slice(0, -1)) >= 3) out = out.slice(0, -1);
    return out;
  };
  const a = stem(word);
  const b = stem(cue);
  const allowed = shortest >= 8 ? 2 : 1;
  return a === b || a === cue || b === word || editDistance(a, b) <= allowed ? 1 : null;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  const bs = [...b];
  const row = Array.from({ length: bs.length + 1 }, (_, index) => index);
  [...a].forEach((ca, i) => {
    let previous = i;
    let left = i + 1;
    for (let j = 1; j < row.length; j++) {
      const here = row[j]!;
      row[j] = Math.min(previous + (ca !== bs[j - 1] ? 1 : 0), left + 1, here + 1);
      previous = here;
      left = row[j]!;
    }
    row[0] = i + 1;
  });
  return row[row.length - 1] ?? 0;
}

/**
 * The quietest moment between `from` and `to` (seconds) in a media file's
 * peaks (one level per 1/`PEAKS_PER_SECOND` s), nearest `near` among equals.
 */
function quietest(peaks: Uint8Array, from: number, to: number, near: number): number | null {
  const rate = mediaModule.PEAKS_PER_SECOND;
  if (peaks.length === 0) return null;
  const first = Math.trunc(Math.max(Math.ceil(from * rate), 0));
  const last = Math.min(Math.trunc(Math.max(Math.floor(to * rate), 0)), peaks.length - 1);
  let best: [number, number] | null = null;
  for (let index = first; index <= last; index++) {
    const level = peaks[index];
    if (level === undefined) continue;
    const at = index / rate;
    if (best === null || level < best[0] || (level === best[0] && Math.abs(at - near) < Math.abs(best[1] - near))) {
      best = [level, at];
    }
  }
  return best === null ? null : best[1];
}

/**
 * Finds a range's first and last words near where it's written to start and
 * end (the same word, else the closest spelling of it), and returns where to
 * cut: just before the first, just after the last (never into a neighbouring
 * word; when speech runs straight on, right at the word, in the quietest
 * instant `peaks` show there). Times are in the transcript's clock.
 */
/** How far into a range's first or last word a cut may still fall (inside the audit's 0.06 s). */
const EDGE_SLACK = 0.05;

export function align(
  words: Word[],
  peaks: Uint8Array | null,
  cue: [string, string],
  start: number,
  end: number,
  pads: [number, number] = [WORD_PAD, WORD_PAD],
): [number | null, number | null] {
  const nearest = (wanted: string | null, time: number, at: (word: Word) => number): number | null => {
    if (wanted === null) return null;
    let best: [number, number, number] | null = null;
    words.forEach((word, index) => {
      const distance = Math.abs(at(word) - time);
      if (distance > CUE_SEARCH) return;
      const score = likeness(word.text, wanted);
      if (score === null) return;
      if (best === null || score < best[0] || (score === best[0] && distance < best[1])) best = [score, distance, index];
    });
    return best === null ? null : (best as [number, number, number])[2];
  };
  // A range written "…-02:03" ends somewhere in that second.
  const first = nearest(spoken(cue[0]), start, (word) => word.start);
  const last = nearest(spoken(cue[1]), end + 0.5, (word) => word.end);
  let cutIn: number | null = null;
  if (first !== null) {
    const word = words[first]!;
    const previous = first > 0 ? words[first - 1] : undefined;
    const before = previous !== undefined && previous.end <= word.start ? previous.end : null;
    let cut: number;
    if (before !== null && word.start - before < RUN_ON) {
      const found =
        peaks === null
          ? null
          : quietest(peaks, Math.max(word.start - SETTLE, before), word.start + Math.min(SETTLE, word.end - word.start) / 2, word.start);
      cut = found ?? word.start;
    } else {
      cut = Math.max(word.start - pads[0], before === null ? -Number.MAX_VALUE : Math.min(before + NEIGHBOUR_GAP, word.start));
    }
    // Never into the word (the quietest moment can fall after it starts),
    // give or take what transcript times are off by.
    cutIn = Math.max(Math.min(cut, word.start + EDGE_SLACK), 0);
  }
  let cutOut: number | null = null;
  if (last !== null) {
    const word = words[last]!;
    const next = words[last + 1];
    const after = next !== undefined && next.start >= word.end ? next.start : null;
    if (after !== null && after - word.end < RUN_ON) {
      const found =
        peaks === null
          ? null
          : quietest(peaks, word.end - Math.min(SETTLE, word.end - word.start) / 2, Math.min(word.end + SETTLE, after), word.end);
      cutOut = found ?? word.end;
    } else {
      cutOut = Math.min(word.end + pads[1], after === null ? Number.MAX_VALUE : Math.max(after - NEIGHBOUR_GAP, word.end));
    }
    // Never before the word is over (the team: "I'm with you" clipped; the
    // audit's cut_mid_word): a word squeezed to a few hundredths is heard
    // for ~0.2 s, longer by its letters, as the audit hears it.
    const letters = [...word.text].filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
    const heard = word.end - word.start < 0.15 ? word.start + Math.max(0.2, 0.06 * letters) : word.end;
    cutOut = Math.max(cutOut, Math.min(heard - EDGE_SLACK, after ?? Number.MAX_VALUE));
  }
  // Out before in: one side matched the wrong word.
  if (cutIn !== null && cutOut !== null && cutIn >= cutOut) return [null, null];
  return [cutIn, cutOut];
}

// ---------------------------------------------------------------------------
// Downloading from Google Drive.

type FileJob = ScriptJob["files"][number];
type JobState = ScriptJob["state"];

const RUNNING: JobState[] = ["downloading", "transcribing", "placing", "voicing"];

/** What an import waiting by itself waits on (the job table's `waiting_on`): the transcription plan's credit, the encoder, ElevenLabs' voice credit or the day's voice allowance, Google Drive's download limit, or a failure that passes (a dropped connection) tried again. */
export type WaitingOn = "quota" | "encoder" | "voice" | "drive" | "passing" | "room";

/**
 * A job with when it last moved (`moved_ms`: a byte, an excerpt cut, a file's state): the page eases its number only
 * while it moves, and says since when once it hasn't for five minutes (Nov 20: the owner's "imports just freeze out
 * of nowhere" was a bar that read the same moving or not).
 */
type Moving = ScriptJob & { moved_ms?: number };

/** A job as it's always been written: its fields in order, the unset ones left out. */
function shownJob(job: Moving): Moving {
  const files = job.files.map((file) => {
    const shown: Record<string, unknown> = { file: file.file };
    if (file.name !== undefined) shown.name = file.name;
    shown.bytes = file.bytes;
    if (file.total !== undefined) shown.total = file.total;
    shown.state = file.state;
    if (file.error !== undefined) shown.error = file.error;
    if (file.why !== undefined) shown.why = file.why;
    if (file.retry_at !== undefined) shown.retry_at = file.retry_at;
    if (file.tries !== undefined) shown.tries = file.tries;
    if (file.cut !== undefined) shown.cut = file.cut;
    return shown as unknown as FileJob;
  });
  const out: Moving = { state: job.state, files };
  if (job.moved_ms !== undefined) out.moved_ms = job.moved_ms;
  if (job.error !== undefined) out.error = job.error;
  if (job.retry_at !== undefined) out.retry_at = job.retry_at;
  if (job.after !== undefined && job.after.length > 0) out.after = job.after.map((one) => ({ ...one }));
  if (job.done_at !== undefined) out.done_at = job.done_at;
  return out;
}

/** A file's excerpts once fetched, for the ranges they were cut for: a resumed import uses them instead of fetching the file again. */
interface Kept {
  ranges: [number, number][];
  excerpts: Excerpt[];
}

/** What a script import keeps in its job (kind `case`): the job as shown, and each fetched file's excerpts. */
interface CaseArgs {
  request?: string;
  import?: ScriptJob;
  made?: Record<string, Kept>;
}

/**
 * At start, before the job table carries work on: an import left waiting for
 * the person only over files this build doesn't ask about (a step past its
 * time, a cut that came out wrong: `steps.whyOf` now takes them as passing)
 * waits by itself instead, woken at once, so nobody is asked about a file
 * that's there and reads. Nov 19: JJ's Scissors Attack import on nightly-89
 * asked him about MartyBlank_202604201718 ("Finding the excerpt's keyframe
 * took more than 2 min") with "I have a replacement" and "Go on without it".
 * Returns the projects woken.
 */
export function wakeWhatPasses(home: string): string[] {
  const woken: string[] = [];
  for (const durable of durableJobs.list(home, "case")) {
    if (durable.state !== "waiting" || durable.until !== "person") continue;
    const kept = (durable.args as CaseArgs).import;
    if (kept === undefined || !Array.isArray(kept.files)) continue;
    const asked = kept.files.filter((file) => file.state === "failed");
    if (asked.length === 0 || asked.some((file) => !steps.waitsByItself(steps.whyOf(file.error ?? "")))) continue;
    const job = structuredClone(kept);
    for (const file of job.files) {
      if (file.state !== "failed") continue;
      file.state = "waiting";
      file.why = "passing";
      delete file.retry_at;
    }
    delete job.error;
    durableJobs.patch(home, durable.key, { import: job, waiting_on: "passing" });
    durableJobs.settle(home, durable.key, "waiting", { retry_at: nowMs(), step: "trying again by itself" });
    diag.info("script", `${durable.project}: its import waited for the person over ${asked.length === 1 ? "a file" : `${asked.length} files`} this build tries again by itself: woken`);
    woken.push(durable.project);
  }
  return woken;
}

/** How often a file's bytes are written to the job table while only they change (its states are written as they change). */
const KEEP_EVERY_MS = 1000;

/**
 * Script imports, per project: on the page as they change (`script`
 * events), and in the job table (`<home>/jobs.json`, kind `case`) a second
 * or less behind, so a restart shows the same Downloads panel and carries on
 * from what each file has. Only an import running in this process is
 * `running()` or refuses a new `claim`; one read back from the table (a
 * restart cut it short) is shown until its resumer claims it.
 */
export class Jobs {
  private jobs = new Map<string, Moving>();
  private made = new Map<string, Record<string, Kept>>();
  private active = new Set<string>();
  private written = new Map<string, string>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private restored = false;

  constructor(private home: string | null = null) {}

  /** The imports the job table holds, read once (a restart). */
  private restore(): void {
    if (this.restored || this.home === null) return;
    this.restored = true;
    for (const durable of durableJobs.list(this.home, "case")) {
      const args = durable.args as CaseArgs;
      const kept = args.import;
      if (kept === undefined || !Array.isArray(kept.files)) continue;
      const job: Moving = structuredClone(kept);
      // Cut short too often (jobs.ts gave it up): it stopped, and says why; Retry starts it again.
      if (durable.state === "given_up" && RUNNING.includes(job.state)) {
        job.state = "failed";
        job.error = `The import was cut short by restarts (${durable.given_up ?? "given up"}). Retry carries it on from what it has.`;
      }
      asWaiting(job, durable);
      this.jobs.set(durable.project, job);
      if (args.made !== undefined) this.made.set(durable.project, structuredClone(args.made));
      this.written.set(durable.project, signature(job));
    }
  }

  private know(app: App): void {
    if (this.home === null && app.store.home !== undefined) this.home = app.store.home;
    this.restore();
  }

  get(project: string): ScriptJob | null {
    this.restore();
    const job = this.jobs.get(project);
    if (job === undefined) return null;
    // Read back as it was running (a restart cut it short) and not claimed here yet: the table may have put it off
    // since (cut short too often), so it's said as the table holds it, never as "Downloading…" with nothing moving.
    if (!this.active.has(project) && job.state === "downloading") asWaiting(job, durableJobs.get(this.home, durableJobs.keyOf("case", project)));
    return shownJob(job);
  }

  /** Whether any project's import is still working in this process. */
  running(): boolean {
    this.restore();
    return [...this.active].some((project) => RUNNING.includes(this.jobs.get(project)?.state ?? "done"));
  }

  /** Whether `project`'s import is working in this process now. */
  working(project: string): boolean {
    return this.active.has(project) && RUNNING.includes(this.jobs.get(project)?.state ?? "done");
  }

  /** Starts a job for `project` unless one is working here; whether it did. */
  claim(app: App, project: string, job: ScriptJob, request?: string): boolean {
    this.know(app);
    if (this.working(project)) return false;
    this.jobs.set(project, { ...structuredClone(job), moved_ms: nowMs() });
    this.active.add(project);
    durableJobs.begin(this.home, "case", project, { ...(request === undefined ? {} : { request }), import: shownJob(job), made: this.made.get(project) ?? {} });
    this.written.set(project, signature(job));
    app.store.emit({ type: "script", id: project, job: shownJob(job) });
    return true;
  }

  /** Changes `project`'s job (one is made if there's none), says so, and keeps it. */
  set(app: App, project: string, edit: (job: ScriptJob) => void): void {
    this.know(app);
    let job = this.jobs.get(project);
    if (job === undefined) {
      job = { state: "downloading", files: [] };
      this.jobs.set(project, job);
    }
    const was = movesOf(job);
    edit(job);
    this.moved(project, job, was);
    // When it got there, once (Home's New); a sweep's footage coming back isn't the work done again.
    if (job.state === "done" && job.done_at === undefined && job.back !== true) job.done_at = Date.now();
    else if (job.state !== "done" && job.back !== true) delete job.done_at;
    app.store.emit({ type: "script", id: project, job: shownJob(job) });
    this.keep(project);
  }

  /**
   * What moved, told: the job's `moved_ms` (the page's), the table's row a beat (it's still going: jobs.ts `beat`, at
   * most every 30 s), and a step when it got further than it ever had: a file in, or a file's cut begun. A step this
   * row never reached forgives its restarts so far (jobs.ts `step`), so an import a quit or a crash cut short after
   * each file is never put off as crashy (Nov 20: nothing told the table, so each quit added a try and from the third
   * the import waited up to half an hour, its page still on "Downloading…").
   */
  private moved(project: string, job: Moving, was: ReturnType<typeof movesOf>): void {
    const now = movesOf(job);
    if (now.mark === was.mark) return;
    job.moved_ms = nowMs();
    if (this.home === null || !this.active.has(project)) return;
    const key = durableJobs.keyOf("case", project);
    durableJobs.beat(this.home, key);
    const total = job.files.length;
    if (now.done > was.done) durableJobs.step(this.home, key, `${now.done} of ${total} ${total === 1 ? "file" : "files"} in`);
    for (const index of now.cutting) if (!was.cutting.includes(index)) durableJobs.step(this.home, key, `cutting file ${index + 1} of ${total}`);
  }

  /** The excerpts a fetched file gave, kept with the job. */
  keepMade(project: string, file: string, ranges: [number, number][], excerpts: Excerpt[]): void {
    const made = this.made.get(project) ?? {};
    made[file] = { ranges, excerpts };
    this.made.set(project, made);
    this.keep(project, true);
  }

  /** A fetched file's excerpts kept from before, when they were cut for these ranges and are still there. */
  keptMade(project: string, file: string, ranges: [number, number][]): Excerpt[] | null {
    this.restore();
    const kept = this.made.get(project)?.[file];
    if (kept === undefined || JSON.stringify(kept.ranges) !== JSON.stringify(ranges)) return null;
    // On this disk, each must still be here; in the cloud the registry has it.
    if (kept.excerpts.length === 0 || kept.excerpts.some((excerpt) => excerpt.cloud === null && !fs.existsSync(excerpt.path))) return null;
    return structuredClone(kept.excerpts);
  }

  /** The import ended here (done, failed or waiting): its job table entry as `settled` says, the excerpts kept only while it may go on. */
  finish(project: string, settled: { state: "done" | "failed" | "waiting" | "end"; on?: WaitingOn } & durableJobs.Settled): void {
    this.active.delete(project);
    const timer = this.pending.get(project);
    if (timer !== undefined) clearTimeout(timer);
    this.pending.delete(project);
    const job = this.jobs.get(project);
    if (settled.state !== "waiting" && settled.state !== "failed") this.made.delete(project);
    const key = durableJobs.keyOf("case", project);
    if (settled.state === "end") return durableJobs.end(this.home, key);
    const { state, on, ...fields } = settled;
    durableJobs.settle(this.home, key, state, { ...fields, args: { ...fields.args, ...(job === undefined ? {} : { import: shownJob(job) }), made: this.made.get(project) ?? {}, waiting_on: on ?? null } });
    if (job !== undefined) this.written.set(project, signature(job));
  }

  /** Writes the job to the table: at once when a state changed, else within a second (bytes). */
  private keep(project: string, now = false): void {
    if (this.home === null || !this.active.has(project)) return;
    const job = this.jobs.get(project);
    if (job === undefined) return;
    const write = () => {
      this.pending.delete(project);
      const current = this.jobs.get(project);
      if (current === undefined || !this.active.has(project)) return;
      durableJobs.patch(this.home, durableJobs.keyOf("case", project), { import: shownJob(current), made: this.made.get(project) ?? {} });
      this.written.set(project, signature(current));
    };
    if (now || this.written.get(project) !== signature(job)) {
      const timer = this.pending.get(project);
      if (timer !== undefined) clearTimeout(timer);
      write();
      return;
    }
    if (!this.pending.has(project)) {
      const timer = setTimeout(write, KEEP_EVERY_MS);
      timer.unref?.();
      this.pending.set(project, timer);
    }
  }
}

/** What counts as moving: each file's bytes, state and excerpts cut, and the job's state; with the files in and being cut. */
function movesOf(job: ScriptJob): { mark: string; done: number; cutting: number[] } {
  return {
    mark: JSON.stringify([job.state, job.files.map((file) => [file.state, file.bytes, file.cut?.done ?? null])]),
    done: job.files.filter((file) => file.state === "done").length,
    cutting: job.files.flatMap((file, index) => (file.state === "cutting" ? [index] : [])),
  };
}

/**
 * A job read back as running whose row the table holds waiting (put off after being cut short, or settled waiting
 * since): said as waiting, with when it goes again, its files not in yet waiting by themselves on the same time, so the
 * page reads "Trying 3 files again at 14:32" (or "now"), never "Downloading…" with nothing moving for half an hour.
 */
function asWaiting(job: Moving, durable: durableJobs.Job | undefined): void {
  // Only while it was fetching: one cut short laying out or voicing carries on from that state when woken (`start`).
  if (durable === undefined || durable.state !== "waiting" || job.state !== "downloading" || durable.until === "person") return;
  job.state = "waiting";
  if (durable.retry_at !== undefined) job.retry_at = durable.retry_at;
  else delete job.retry_at;
  for (const file of job.files) {
    if (file.state === "done" || file.state === "failed") continue;
    file.state = "waiting";
    file.why ??= "passing";
    if (durable.retry_at !== undefined) file.retry_at = durable.retry_at;
    delete file.cut;
  }
  if (durable.until === "encoder") job.error = "The hardware encoder is busy with an export: the footage waits until it's free.";
  else delete job.error;
}

/** What's worth writing at once: the job's and each file's state, and what follows. */
function signature(job: ScriptJob): string {
  return JSON.stringify([job.state, job.error ?? null, job.retry_at ?? null, job.files.map((file) => [file.file, file.state, file.why ?? null, file.retry_at ?? null, file.cut?.done ?? null]), job.after ?? null]);
}

/** Asks for the first byte: the final headers say whether Drive will send the file (and its name and size) or a page instead. */
async function probe(url: string, scratch: string): Promise<DriveHead> {
  let response: Response;
  try {
    response = await googleFetch(url, { headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(60_000) });
  } catch {
    fs.rmSync(scratch, { force: true });
    return { status: 0, html: false, name: null, total: null };
  }
  void response.body?.cancel();
  fs.rmSync(scratch, { force: true });
  const status = response.status;
  const header = (name: string) => {
    const value = response.headers.get(name);
    return value === null ? null : trim(value);
  };
  let total: number | null = null;
  const range = header("content-range");
  if (range !== null) {
    const after = range.split("/").at(-1);
    total = after !== undefined && /^\d+$/.test(trim(after)) ? Number(trim(after)) : null;
  }
  if (total === null && status === 200) {
    const length = header("content-length");
    total = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  }
  const disposition = header("content-disposition");
  return {
    status,
    html: (header("content-type") ?? "").startsWith("text/html"),
    name: disposition === null ? null : dispositionName(disposition),
    total,
  };
}

export function dispositionName(value: string): string | null {
  const star = value.split("filename*=")[1];
  if (star !== undefined) {
    const encoded = trim(star.split(";")[0]!).replace(/^"+|"+$/g, "");
    return percentDecode(encoded.split("''")[1] ?? encoded);
  }
  const plain = value.split("filename=")[1];
  if (plain === undefined) return null;
  const name = trim(plain.split(";")[0]!).replace(/^"+|"+$/g, "");
  return name === "" ? null : name;
}

/** A file name safe to write: no separators or leading dots. */
export function safeName(name: string): string {
  const cleaned = trim(name.replace(/[/\\:\0]/g, "_")).replace(/^\.+/, "");
  return cleaned === "" ? "footage.mp4" : cleaned;
}

/** The download link behind Drive's "can't scan for viruses" page, if this is that page. */
export function confirmLink(page: string): string | null {
  const at = page.indexOf('id="download-form"');
  if (at < 0) return null;
  let form = page.slice(at);
  const close = form.indexOf(">");
  if (close < 0) return null;
  const tag = form.slice(0, close);
  const rawAction = attribute(tag, "action");
  if (rawAction === null) return null;
  const action = decodeEntities(rawAction);
  // A Drive upload can itself contain HTML. Never let its form direct a
  // download at an arbitrary URL, local file or service on the editor's network.
  if (action !== "https://drive.usercontent.google.com/download") return null;
  form = form.split("</form>")[0]!;
  const fields: string[] = [];
  for (const input of form.split("<input").slice(1)) {
    if (!input.includes('type="hidden"')) continue;
    const name = attribute(input, "name");
    if (name === null) continue;
    fields.push(`${name}=${decodeEntities(attribute(input, "value") ?? "")}`);
  }
  return endpoints.google(`${action}?${fields.join("&")}`);
}

/**
 * Drive's page as an error: its download limit waits by itself (tried again
 * once Google allows it, `retryAfterMs` when it said when); a file nobody
 * shared is the person's.
 */
function pageError(problem: string, retryAfterMs: number | null = null): Error {
  if (problem === DRIVE_LIMIT) return new steps.DriveLimit(problem, retryAfterMs);
  return problem === "Google Drive sent a page instead of the file." ? new Error(problem) : new steps.NeedsPerson(problem);
}

const DRIVE_LIMIT = "Google Drive's download limit for this file is used up for today.";

export function pageProblem(page: string): string {
  if (page.includes("Too many users") || page.includes("quota")) return DRIVE_LIMIT;
  if (page.includes("accounts.google.com") || page.includes("ServiceLogin")) {
    return "This Drive file isn't shared. Set it so anyone with the link can view.";
  }
  return "Google Drive sent a page instead of the file.";
}

/**
 * Stops a download left running by an earlier (Rust) server, which would
 * write over the resumed one. Only a curl writing into this folder is touched.
 */
async function stopStale(dir: string): Promise<void> {
  let pid: number;
  try {
    const text = trim(fs.readFileSync(join(dir, ".pid"), "utf8"));
    if (!/^\d+$/.test(text)) return;
    pid = Number(text);
  } catch {
    return;
  }
  fs.rmSync(join(dir, ".pid"), { force: true });
  try {
    const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
    const command = new TextDecoder().decode(ps.stdout);
    if (command.includes("curl") && command.includes(dir)) {
      process.kill(pid);
      await timing.sleep(300);
    }
  } catch {
    // Gone already.
  }
}

const downloads = new Map<string, Promise<unknown>>();

/** Runs `work` once nothing else holds `key` (one download per folder at a time). */
async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = downloads.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(work);
  const held = run.catch(() => undefined);
  downloads.set(key, held);
  try {
    return await run;
  } finally {
    if (downloads.get(key) === held) downloads.delete(key);
  }
}

/** Statuses curl's `--retry` asks again after. */
const TRANSIENT = [408, 429, 500, 502, 503, 504, 522, 524];

/**
 * Downloads one Drive file into `dir` (resuming a partial download), calling
 * `progress(bytes, total, name)` as it goes. Finished files are reused.
 */
export function download(
  dir: string,
  file: string,
  progress: (bytes: number, total: number | null, name: string) => void,
): Promise<string> {
  return exclusive(dir, async () => {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const done = join(dir, trim(fs.readFileSync(join(dir, ".done"), "utf8")));
      if (fs.existsSync(done)) return done;
    } catch {
      // Not downloaded yet.
    }
    const [url, head] = await resolve(file, join(dir, ".probe"));
    const name = safeName(head.name ?? `${file}.mp4`);
    const part = join(dir, ".download");
    await stopStale(dir);
    const sizeOf = () => {
      try {
        return fs.statSync(part).size;
      } catch {
        return 0;
      }
    };
    // A big one in parts at once (ranged_download.ts: 70 MB/s from Drive here, one connection 12-16), begun so or begun now.
    let failure: string | null;
    if (head.total !== null && head.total >= ranged.ranged.from && (ranged.partlyDone(part) || sizeOf() === 0)) {
      const total = head.total;
      failure = await ranged.download({ url, size: total, dest: part, fetch: googleFetch, onBytes: (bytes) => progress(bytes, total, name) }).then(
        () => null,
        (error: unknown) => diag.messageOf(error),
      );
    } else {
      failure = await fetchResuming(url, part, () => progress(sizeOf(), head.total, name));
    }
    const size = sizeOf();
    if (failure !== null) throw new Error(`Download stopped (${failure}). It resumes where it left off when you retry.`);
    if ((head.total !== null && head.total !== size) || ranged.partlyDone(part)) throw new Error("The download ended early. Retry to resume it.");
    progress(size, head.total, name);
    const path = join(dir, name);
    fs.renameSync(part, path);
    fs.writeFileSync(join(dir, ".done"), name);
    return path;
  });
}

/**
 * `curl -L --fail -C - --retry 5 --retry-delay 3 -o part url`: appends what's
 * left to `part`, asking again after a dropped connection or a busy answer.
 * What went wrong in curl's words (without "curl: "), or null when it's all there.
 */
async function fetchResuming(url: string, part: string, tick: () => void): Promise<string | null> {
  let failure: string | null = null;
  const sizeNow = () => {
    try {
      return fs.statSync(part).size;
    } catch {
      return 0;
    }
  };
  let lastHave = sizeNow();
  for (let attempt = 0; attempt <= 5; attempt++) {
    if (attempt > 0) await timing.sleep(3000);
    const have = sizeNow();
    // A try that got further doesn't count against the five: a long download
    // over a shaky connection keeps resuming as long as it moves.
    if (attempt > 0 && have > lastHave) attempt = 1;
    lastHave = have;
    // Nothing for a minute: dropped and resumed (a dead connection otherwise waits for ever, the bar frozen).
    const stalled = new AbortController();
    let idle = setTimeout(() => stalled.abort(), timing.stall);
    const moved = () => {
      clearTimeout(idle);
      idle = setTimeout(() => stalled.abort(), timing.stall);
    };
    let response: Response;
    try {
      response = await googleFetch(url, have > 0 ? { headers: { range: `bytes=${have}-` }, signal: stalled.signal } : { signal: stalled.signal });
    } catch (error) {
      clearTimeout(idle);
      failure = stalled.signal.aborted ? `(28) Google Drive sent nothing for ${timing.stall / 1000} s` : `(7) ${diag.messageOf(error)}`;
      continue;
    }
    if (have > 0 && response.status === 416) {
      clearTimeout(idle);
      void response.body?.cancel();
      return null;
    }
    if (response.status >= 400) {
      clearTimeout(idle);
      void response.body?.cancel();
      failure = `(22) The requested URL returned error: ${response.status}`;
      if (TRANSIENT.includes(response.status)) continue;
      return failure;
    }
    if (have > 0 && response.status !== 206) {
      clearTimeout(idle);
      void response.body?.cancel();
      return "(33) HTTP server doesn't seem to support byte ranges. Cannot resume.";
    }
    const out = fs.openSync(part, have > 0 ? "a" : "w");
    const timer = setInterval(() => {
      try {
        tick();
      } catch {
        // Progress is only shown.
      }
    }, 400);
    try {
      if (response.body !== null) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          fs.writeSync(out, chunk);
          moved();
        }
      }
      return null;
    } catch (error) {
      failure = stalled.signal.aborted ? `(28) Google Drive sent nothing for ${timing.stall / 1000} s` : `(56) ${diag.messageOf(error)}`;
    } finally {
      clearTimeout(idle);
      clearInterval(timer);
      fs.closeSync(out);
    }
  }
  return failure;
}

/**
 * What Drive serves for a file: the URL that downloads it (past the "can't
 * scan for viruses" page) and its headers (name, size). `scratch` is a file
 * the first-byte probe may write (removed again).
 */
export async function resolve(file: string, scratch: string): Promise<[url: string, head: DriveHead]> {
  const signed = await resolveSignedIn(file);
  if (signed !== null) return signed;
  let url = endpoints.google(`https://drive.usercontent.google.com/download?id=${file}&export=download&confirm=t`);
  let head = await probe(url, scratch);
  if (head.html) {
    let page = "";
    let hint: number | null = null;
    try {
      const response = await googleFetch(url, { signal: AbortSignal.timeout(30_000) });
      hint = retryAfterOf(response.headers);
      page = new TextDecoder().decode(await boundedBody(response, 5_000_000));
    } catch {
      page = "";
    }
    const link = confirmLink(page);
    if (link === null) throw pageError(pageProblem(page), hint);
    url = link;
    head = await probe(url, scratch);
    if (head.html) throw pageError(pageProblem(""));
  }
  if (head.status === 403 || head.status === 401) {
    throw new steps.NeedsPerson("This Drive file isn't shared. Set it so anyone with the link can view.");
  }
  if (head.status === 404) throw new steps.NeedsPerson("Google Drive can't find this file (deleted, or in the trash).");
  if (head.status >= 400 || head.status === 0) throw new Error(`Google Drive answered ${head.status}.`);
  return [url, head];
}

/**
 * A Drive file as the team's sign-in sees it: its name and size from the API
 * and its bytes from `alt=media` (no virus-scan page, no public-link quota,
 * and a file shared only with the team works). Null when the sign-in can't
 * see it (or there's none): the public link is tried as before.
 */
async function resolveSignedIn(file: string): Promise<[url: string, head: DriveHead] | null> {
  if ((await signedIn()) === null) return null;
  try {
    const response = await googleFetch(endpoints.google(`${GOOGLE_API}drive/v3/files/${encodeURIComponent(file)}?fields=name,size,mimeType&supportsAllDrives=true`), {
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) {
      void response.body?.cancel();
      return null;
    }
    const meta = (await response.json()) as { name?: unknown; size?: unknown; mimeType?: unknown };
    // A Google Doc or a folder has no bytes to download.
    if (typeof meta.mimeType === "string" && meta.mimeType.startsWith("application/vnd.google-apps.")) return null;
    const size = typeof meta.size === "string" && /^\d+$/.test(meta.size) ? Number(meta.size) : null;
    return [apiMedia(file), { status: 200, html: false, name: typeof meta.name === "string" ? meta.name : null, total: size }];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Excerpts: police footage runs for hours and a script uses minutes of it.
// Only what the script uses (with room to trim) becomes media, so proxies stay
// small. Cut losslessly from a keyframe, so timing is exact.

/** Footage kept either side of a range, for trimming. */
const HANDLE_SECONDS = 10.0;
/** Ranges closer than this share one excerpt. */
const MERGE_SECONDS = 120.0;

/**
 * Runs a tool to the end within `ms` (import_steps.ts `LIMITS`): its stdout
 * and stderr, and whether it succeeded. Past its time its whole process
 * group is ended and it fails with `StepTimedOut` (a passing failure: the
 * file lands in failed and Retry works), never leaving the import running
 * with nothing moving.
 */
async function runTool(command: string[], ms: number, what: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const [program = "", ...args] = command;
  try {
    const done = await runPromise(proc.capture(program, args, ms));
    return { ok: done.exitCode === 0, stdout: new TextDecoder().decode(done.stdout), stderr: done.stderr };
  } catch (error) {
    if ((error as { _tag?: unknown } | null)?._tag === "ProcessTimedOut") throw new steps.StepTimedOut(what, ms, false);
    throw error;
  }
}

/** `runTool` for work read over the network: run for as long as `progress()` moves (import_steps `whileMoving`), never stopped by a clock. */
async function runMoving(command: string[], what: string, progress: () => number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const [program = "", ...args] = command;
  return steps.whileMoving(what, progress, async (signal) => {
    const done = await runPromise(proc.capture(program, args, 24 * 3600_000), { signal });
    return { ok: done.exitCode === 0, stdout: new TextDecoder().decode(done.stdout), stderr: done.stderr };
  });
}

/**
 * Seconds of a file (or a presigned URL's object). Over the network a read that comes back empty or fails is asked
 * once more a moment later: a connection the Mac's sleep (or a frozen process) left dead answers nothing the first
 * time (the bad-day run's frozen-cut, Nov 19: "couldn't read the footage in the cloud" straight after the wake).
 */
export async function durationOf(path: string): Promise<number> {
  if (!tools.isUrl(path)) return durationOnce(path);
  try {
    return await durationOnce(path);
  } catch (error) {
    if (error instanceof steps.StepTimedOut) throw error;
    await timing.sleep(2_000);
    return durationOnce(path);
  }
}

async function durationOnce(path: string): Promise<number> {
  let output: { stdout: string };
  try {
    output = await runTool(
      [tools.ffprobe(), "-v", "error", "-protocol_whitelist", tools.protocols(path), "-show_entries", "format=duration", "-of", "csv=p=0", ...tools.urlArgs(path), path],
      steps.probeLimit(path),
      "Reading the footage's length",
    );
  } catch (error) {
    if (error instanceof steps.StepTimedOut) throw error;
    throw new Error(`ffprobe: ${diag.messageOf(error)}`);
  }
  const seconds = parseF64(trim(output.stdout));
  if (seconds === null) throw new Error(tools.isUrl(path) ? "couldn't read the footage in the cloud" : `couldn't read ${path}`);
  return seconds;
}

/**
 * The last keyframe at or before `time` (an excerpt must start on one to be
 * cut without re-encoding): from an MP4's or MOV's index, read once a file
 * (`keyframe_index`), else by ffprobe reading the pictures before it.
 */
export async function keyframeBefore(path: string, time: number): Promise<number> {
  const indexed = await keyframeIndex.keyframeTimes(path);
  if (indexed !== null) return indexed.findLast((pts) => pts <= time + 1e-6) ?? 0;
  for (const window of [20.0, 120.0, 600.0]) {
    const from = Math.max(time - window, 0);
    let text = "";
    try {
      const output = await runTool([
        tools.ffprobe(),
        "-v",
        "error",
        "-protocol_whitelist",
        tools.protocols(path),
        "-select_streams",
        "v:0",
        "-skip_frame",
        "nokey",
        "-show_entries",
        // Its presentation time, or FFmpeg's best guess where there's none: a DVR's AVI has no times on its pictures
        // (pts N/A, a keyframe every 3 s), so every excerpt of JJ's CH03 recordings was cut from the file's start (Nov 20).
        "frame=best_effort_timestamp_time",
        "-of",
        "csv=p=0",
        "-read_intervals",
        `${display(from)}%${display(time + 0.001)}`,
        ...tools.urlArgs(path),
        path,
      ], steps.probeLimit(path), "Finding the excerpt's keyframe");
      // FFprobe couldn't read it (a dropped line, a cloud address gone stale): a failure of its own, tried again, never
      // "no keyframe", which cut from the file's start and sent a long wrong excerpt up at 8 Mbit/s (Nov 20).
      if (!output.ok) throw new Error(`Finding the excerpt's keyframe: the footage couldn't be read (${diag.gist(output.stderr.trim() || "ffprobe failed")})`);
      text = output.stdout;
    } catch (error) {
      // Stuck reading the footage is a failure of its own (tried again), never "no keyframe": that would cut from the start.
      if (error instanceof steps.StepTimedOut || (error instanceof Error && error.message.startsWith("Finding the excerpt's keyframe:"))) throw error;
      text = "";
    }
    let best: number | null = null;
    for (const line of text.split("\n")) {
      const pts = parseF64(trim(line).replace(/,+$/, ""));
      if (pts === null || !(pts <= time + 1e-6)) continue;
      best = best === null ? pts : Math.max(best, pts);
    }
    if (best !== null) return best;
    if (from === 0) break;
  }
  return 0;
}

/** Merged, padded spans of a file that `ranges` (seconds) need. */
export function spans(ranges: [number, number][], duration: number): [number, number][] {
  const sorted = ranges
    .map(([from, to]): [number, number] => [Math.max(from - HANDLE_SECONDS, 0), Math.min(to + HANDLE_SECONDS, duration)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && from - last[1] < MERGE_SECONDS) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** An f64's bits as 16 hex digits (`{:016x}` of `to_bits`). */
function bitsHex(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

let nextCut = 0;

/**
 * The extension of an excerpt cut from a file with `ext`: its own, unless its
 * container can't hold copied picture with AAC sound (a DVD's VOB or another
 * MPEG program stream, WebM), then MP4, which takes their picture as it is;
 * or sound alone in a container that can't hold AAC (a WAV, AIFF, FLAC, MP3,
 * Ogg), then M4A. The cut always encodes the sound as AAC, and AAC written
 * into a .wav reads back as garbage (Nov 1: a µ-law 911 call's 0–55 s excerpt
 * came out a 27.6 s .wav no proxy could decode, so that import waited all day
 * on "1 of 12 files couldn't be downloaded").
 */
export function excerptExtension(ext: string): string {
  const lower = ext.toLowerCase();
  if (["vob", "mpg", "mpeg", "m2p", "ps", "dat", "webm", "ogv"].includes(lower)) return "mp4";
  if (["wav", "wave", "aif", "aiff", "aifc", "flac", "mp3", "ogg", "oga", "opus", "wma", "amr", "au", "snd", "ac3", "dts"].includes(lower)) return "m4a";
  return ext;
}

/**
 * Cuts the parts of `source` that `ranges` need into excerpt files beside it
 * (reused if already cut). Footage mostly used anyway stays whole. Picture is
 * copied from a keyframe; sound is re-encoded so it starts on that same
 * instant (copied audio would begin earlier and shift everything).
 */
export async function excerpts(source: string, ranges: [number, number][], onCut: (done: number, total: number) => void = () => {}): Promise<Excerpt[]> {
  const duration = await durationOf(source);
  const needed = spans(ranges, duration);
  const used = needed.reduce((total, [from, to]) => total + (to - from), 0);
  if (needed.length === 0 || used >= duration * 0.6) return [{ path: source, from: 0, to: duration, cloud: null }];
  const dir = join(parent(source) ?? ".", "excerpts");
  fs.mkdirSync(dir, { recursive: true });
  const stem = takeChars(fileStem(source) ?? "footage", 20);
  const sourceKey = mediaModule.mediaKey(source);
  const ext = excerptExtension(pathExtension(source) ?? "mp4");
  const out: Excerpt[] = [];
  onCut(0, needed.length);
  for (const [from, to] of needed) {
    const start = await keyframeBefore(source, from);
    const path = join(dir, `${stem} ${clock(start)}-${clock(to)}-${sourceKey}-${bitsHex(start)}-${bitsHex(to)}.${ext}`);
    if (!fs.existsSync(path)) {
      const partial = join(dir, `.cutting-${process.pid}-${nowMs()}-${nextCut++}.${ext}`);
      fs.closeSync(fs.openSync(partial, "wx"));
      try {
        await cut(source, start, to, partial);
        fs.renameSync(partial, path);
      } finally {
        fs.rmSync(partial, { force: true });
      }
    }
    out.push({ path, from: start, to, cloud: null });
    onCut(out.length, needed.length);
  }
  return out;
}

/**
 * Cuts `start`..`to` seconds of `source` (a file or a presigned URL: FFmpeg
 * seeks before reading, so only that stretch is fetched) into `out`: picture
 * copied from the keyframe at `start`, sound re-encoded to start with it.
 */
export async function cut(source: string, start: number, to: number, out: string): Promise<void> {
  let output: { ok: boolean; stderr: string };
  // From the cloud's address: cut for as long as the excerpt's file grows. From a file here: within a fixed time.
  const remote = tools.isUrl(source);
  try {
    const command = [
      tools.ffmpeg(),
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      display(start),
      "-protocol_whitelist",
      tools.protocols(source),
      ...tools.urlArgs(source),
      "-i",
      source,
      "-t",
      display(to - start),
      // The picture if there is one: a police call is sound only (Tarrytown_PD_call.m4a).
      "-map",
      "0:v:0?",
      "-map",
      "0:a?",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      out,
    ];
    output = remote ? await runMoving(command, "Cutting an excerpt", () => steps.sizeOf(out)) : await runTool(command, steps.LIMITS.cut(to - start), "Cutting an excerpt");
  } catch (error) {
    fs.rmSync(out, { force: true });
    if (error instanceof steps.StepTimedOut || error instanceof failure.StoodStill) throw error;
    throw new Error(`ffmpeg: ${diag.messageOf(error)}`);
  }
  if (!output.ok) {
    // FFmpeg's words, without the URL (a credential) it may repeat.
    diag.warn("script", `cutting an excerpt: ${diag.scrub(trim(output.stderr))}`);
    fs.rmSync(out, { force: true });
    // A full disk is a wait of its own, said as such (failure.ts `room`), never a cut that "couldn't" be made.
    if (/No space left on device/iu.test(output.stderr)) {
      // How much the cut needs, from the footage's bit rate (asked only now), so the line can say it.
      const need = await bitRateOf(source).then((rate) => (rate === null ? 0 : Math.ceil(((to - start) * rate) / 8 / 1e6) * 1e6), () => 0);
      throw new failure.NoRoom(need, need > 0 ? `Needs ${need >= 1e9 ? `${(need / 1e9).toFixed(1)} GB` : `${Math.round(need / 1e6)} MB`} free on this computer to cut the footage's excerpts: make room, and Edit goes on by itself.` : "This computer is out of room to cut the footage's excerpts: make room, and Edit goes on by itself.");
    }
    throw new Error("Couldn't cut an excerpt from the footage.");
  }
  const problem = await excerptProblem(source, start, to, out);
  if (problem !== null) {
    fs.rmSync(out, { force: true });
    diag.warn("script", `cutting an excerpt: ${problem}`);
    throw new Error(`The excerpt cut from the footage came out wrong (${problem}).`);
  }
}

/**
 * Why a fresh excerpt isn't the stretch it was cut from, or null: it reads
 * back as long as was asked (or up to the footage's end). Nov 1: a 911 call's
 * 0–55 s excerpt was AAC in a .wav, read back as 27.6 s and undecodable, and
 * was used as footage until its import stopped on it; any cut that can't hold
 * what was cut now stops here, saying so, before it's used or uploaded.
 */
export async function excerptProblem(source: string, start: number, to: number, out: string): Promise<string | null> {
  const asked = to - start;
  const got = await secondsOf(out);
  if (got === null) return "it can't be read back";
  const leeway = Math.max(0.5, asked * 0.02);
  // Copied picture runs on past the end by its reorder delay: FFmpeg stops at the last frame decoded by then, and with
  // B-frames frames shown later come with it (Nov 18, JJ's Axon bodycam MartyBlank_202604201718: a 0.6 s delay, its
  // 29.2 s excerpt read 29.8 s, all 895 frames sound, and was refused as wrong twice; longer ones passed on 2%).
  if (got > asked + leeway && got > asked + leeway + (await pictureDelay(out))) return `it runs ${got.toFixed(1)} s, not ${asked.toFixed(1)} s`;
  if (got >= asked - leeway) return null;
  // Shorter than asked is right only when the footage itself ends sooner.
  const whole = await secondsOf(source);
  if (whole !== null && whole - start <= got + leeway) return null;
  return `it runs ${got.toFixed(1)} s, not ${asked.toFixed(1)} s`;
}

/** The footage's bit rate in bits a second (its container's), or null. */
async function bitRateOf(path: string): Promise<number | null> {
  const output = await runTool([tools.ffprobe(), "-v", "error", "-protocol_whitelist", tools.protocols(path), "-show_entries", "format=bit_rate", "-of", "csv=p=0", ...tools.urlArgs(path), path], steps.probeLimit(path), "Reading the footage's bit rate");
  const rate = parseF64(trim(output.stdout));
  return rate !== null && rate > 0 ? rate : null;
}

/** How far a cut's copied picture is shown after it's decoded (its first frame's pts less its dts), 0 with none. */
async function pictureDelay(path: string): Promise<number> {
  try {
    const output = await runTool(
      [tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time", "-read_intervals", "%+#1", "-of", "csv=p=0", path],
      steps.LIMITS.probe,
      "Reading the excerpt's first frame",
    );
    const [pts, dts] = trim(output.stdout).split("\n")[0]!.split(",").map((part) => parseF64(trim(part)));
    return pts !== null && pts !== undefined && dts !== null && dts !== undefined ? Math.max(0, pts - dts) : 0;
  } catch {
    return 0;
  }
}

/** `durationOf`, null when it can't be read (or reads as nothing). */
const secondsOf = (path: string): Promise<number | null> =>
  durationOf(path).then(
    (seconds) => (Number.isFinite(seconds) && seconds > 0 ? seconds : null),
    () => null,
  );

/** `1h02m03s`: a time in an excerpt's name. */
export function clock(seconds: number): string {
  const whole = Math.max(round(seconds), 0) || 0;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(whole / 3600)}h${two(Math.floor(whole / 60) % 60)}m${two(whole % 60)}s`;
}

/** The ranges (seconds) a project's script plays from one file. */
function fileRanges(project: Project, file: string): [number, number][] {
  return (project.script?.blocks ?? []).flatMap((block): [number, number][] =>
    block.kind === "footage" && block.file === file ? [[reuseCaseOf(block.label) !== null ? 0 : block.start, reusedLabel(block.label) || block.label === WHOLE_SOURCE_LABEL ? Number.MAX_SAFE_INTEGER : block.end]] : [],
  );
}

// ---------------------------------------------------------------------------
// The import: download every file, then lay the edit out.

/** Footage files the script needs that aren't media in the project yet, in script order. */
function missingFiles(project: Project): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of project.script?.blocks ?? []) {
    if (block.kind !== "footage") continue;
    if (block.media !== undefined && block.media !== null && mediaOf(project, block.media) !== undefined) continue;
    // Gone without: nothing to fetch, its card holds its place.
    if (goneWithout(block)) continue;
    if (seen.has(block.file)) continue;
    seen.add(block.file);
    out.push(block.file);
  }
  return out;
}

/** Whether the script still has footage to fetch or blocks to place. */
export function unfinished(project: Project): boolean {
  const script = project.script;
  if (script === undefined || script === null) return false;
  // Laid out once (every range is placed in one go, after the downloads): finished,
  // whatever's been removed or never came since. Only a Re-cut lays it out again.
  if (pendingCase(project)) return true;
  if (laidOut(project)) return unvoiced(project);
  // Only blocks never placed: one placed and since removed was removed on purpose.
  return missingFiles(project).length > 0 || script.blocks.some((block) => !placed(project, block));
}

/**
 * Whether the import already laid the script out: any block placed. The audit
 * (Oct 23): a resume after a restart, with the job only in memory, rebuilt a
 * finished edit; the project itself says it's done, on every Mac.
 */
export function laidOut(project: Project): boolean {
  return (project.script?.blocks ?? []).some((block) => placed(project, block));
}

/**
 * Whether a block was ever put on the timeline (since removed counts: on
 * purpose). A cut-in whose card id was cleared (cover_cut_in once did) but
 * whose voice-over is on the timeline was placed.
 */
export function placed(project: Project, block: ScriptBlock): boolean {
  if (block.kind === "footage") return isSome(block.clip);
  return isSome(block.clip) || (isSome(block.voiceover) && clipOf(project, block.voiceover) !== undefined);
}

function isSome<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/** Audio in the project that isn't on the timeline: a voice-over recording given with the script. */
function unplacedAudio(project: Project): boolean {
  const used = new Set(project.clips.flatMap((clip) => ("media" in clip && typeof clip.media === "string" ? [clip.media] : [])));
  return project.media.some((media) => media.kind === "audio" && !used.has(media.id));
}

/** What the agent is asked once a script is first laid out. */
export const RESEARCH =
  "The script is imported and laid out. Research the case now (RESEARCH in your house style): start from the script and the transcripts, find the news articles about this case, check each matches and save it, then collect images of the scene, the people involved and the vehicles, and weed out anything off-target so only real candidates wait for review. Don't change the timeline. Finish with a short summary: the key facts the articles add, how many articles you saved and how many images are waiting.";

// Transfer slots are independent from local media work and cloud exports.
// Across projects, at most three downloads (Drive→R2 jobs, or to this Mac) at once. Local
// excerpt encodes keep a lane of their own rather than fighting for the Mac.
const cloudDownloads = new mediaModule.Semaphore(3);
/**
 * One file's excerpts cut at a time per project (each cut reads its file a few spans at once: cloud_media
 * `EXCERPTS_AT_ONCE`). Nov 20: one lane for every project, held through a whole file's cuts and each excerpt's upload
 * at 8 Mbit/s, while the file waiting for it kept its download slot: one slow file held every project's import on
 * "cutting" for hours, and three such files stopped every download on the Mac. A lane per project keeps a project's
 * own files from splitting its line three ways, and never holds another project's import; a file lets go of its
 * download slot before it waits here. (Cutting under the lane with the uploads outside it would keep one lane for
 * all, but the cut and the upload are one call in cloud_media `driveExcerpts`.)
 */
const cutLanes = new Map<string, mediaModule.Semaphore>();
function cutLane(project: string): mediaModule.Semaphore {
  let lane = cutLanes.get(project);
  if (lane === undefined) cutLanes.set(project, (lane = new mediaModule.Semaphore(1)));
  return lane;
}

/** A copy of an original Script mode keeps on this Mac (`copy`, held until released), or its download under way here (`landing`). */
export type CopyHere = { copy: { path: string; key: string; name: string; size: number; release: () => void } } | { landing: { path: string; size: number; name: string; done: Promise<string> } };
/** Where Edit mode finds those copies: writer/streamed.ts sets it (Script mode's own). */
export const copiesHere: { find: (source: string) => CopyHere | null } = { find: () => null };

/**
 * Downloads the script's footage and lays the edit out. Safe to call again:
 * files the job kept are reused, unfinished downloads resume, and placed
 * blocks are skipped. A laid-out edit whose voice-over or research a restart
 * cut short carries on with those. Returns the work started (tests wait on
 * it), or null when there's nothing to start.
 */
export function start(app: App, projectId: string, recut: boolean): Promise<void> | null {
  const live = app.store.get(projectId);
  if (live === null) return null;
  // A finished import is never resumed (only a Re-cut lays it out again).
  const inserting = pendingCase(live.project);
  if (recut && inserting) throw new Error("Finish the pending case insertion before Re-cut.");
  const prior = app.scripts.get(projectId);
  if (!recut && laidOut(live.project) && !inserting) {
    // Laid out before a restart cut its voice-over short, or with cut-ins its voice-over never voiced (a spent
    // ElevenLabs quota, Nov 8, where Retry was refused and only a Re-cut of the whole edit was left): only what
    // follows the layout.
    const resume = prior !== null && prior.state === "voicing";
    if (!(resume || unvoiced(live.project)) || app.scripts.working(projectId)) return null;
    if (!app.scripts.claim(app, projectId, { ...(prior ?? { files: [] }), state: "voicing" })) return null;
    return catchBugsAsync("the script import", () => followOn(app, projectId, null, recut, timing.now())).catch((error: unknown) => {
      app.scripts.set(app, projectId, (job) => {
        job.state = "done";
        job.after = afterLine(job.after, "voiceover", "failed", isBug(error) ? crashed("the voice-over", error) : diag.messageOf(error));
      });
      app.scripts.finish(projectId, { state: "done" });
    });
  }
  // The job belongs to the script it started with: one attached since stops it.
  const source = live.project.script?.source ?? null;
  const files = missingFiles(live.project);
  const before = new Map((prior?.files ?? []).map((file) => [file.file, file]));
  // Each file as far as the job got it: one fetched keeps its excerpts (nothing fetched again), one part-way shows its bytes and resumes.
  const fetched: ([string, Excerpt[]] | undefined)[] = files.map((file) => {
    const kept = app.scripts.keptMade(projectId, file, fileRanges(live.project, file));
    return kept === null || recut ? undefined : [file, kept];
  });
  const job: ScriptJob = {
    state: "downloading",
    files: files.map((file, index) => {
      const was = before.get(file);
      const row: FileJob = { file, bytes: was?.bytes ?? 0, state: fetched[index] !== undefined ? "done" : "queued" };
      if (was?.name !== undefined) row.name = was.name;
      if (was?.total !== undefined) row.total = was.total;
      // A file not in yet keeps its tries, so its next wait grows (1, 5, 15, then every 30 minutes; verify.md finding 2).
      if (fetched[index] === undefined && was?.tries !== undefined) row.tries = was.tries;
      return row;
    }),
  };
  if (!app.scripts.claim(app, projectId, job, inserting ? inserting.id : undefined)) return null;
  // Every import is kept until it ends, so one a restart cuts off (an update,
  // a crash) carries on by itself when Edit is back: the first horror import
  // (Nov 4) was cut off by a restart and left its project empty, its first
  // message waiting for good.
  const id = projectId;
  let settled = false;
  const finish = (how: Parameters<typeof app.scripts.finish>[1]) => {
    settled = true;
    app.scripts.finish(id, how);
  };
  const work = async () => {
    // As tokio::spawn: the job runs after the caller has answered with it (files still queued).
    await Promise.resolve();
    const began = timing.now();
    const title = app.store.get(id)?.project.name ?? id;
    const fresh = fetched.filter((one) => one === undefined).length;
    diag.info("script", `${title}: getting ${files.length} footage ${files.length === 1 ? "file" : "files"} ready (${cloudEnabled() ? "from the cloud" : `to ${THIS_MACHINE}`})${fresh < files.length ? `, ${files.length - fresh} kept from before` : ""}`);
    const errors: (unknown | undefined)[] = new Array(files.length);
    const fetchOne = async (index: number, file: string) => {
      // Its download slot, let go as soon as it no longer brings bytes (its original in hand, or waiting on another's
      // download or cut), so a file waiting never holds the Mac's downloads (Nov 20).
      const letGo = await cloudDownloads.acquire();
      try {
        await fetchHolding(index, file, letGo);
      } finally {
        letGo();
      }
    };
    const fetchHolding = async (index: number, file: string, letGo: () => void) => {
      app.scripts.set(app, id, (job) => {
        const entry = job.files[index];
        if (entry === undefined) return;
        entry.state = "downloading";
        delete entry.error;
        delete entry.why;
        delete entry.retry_at;
      });
      errors[index] = undefined;
      const fileBegan = timing.now();
      // A YouTube file waiting a wave of refusals out says when it goes again (a downloading file with a `retry_at`): nothing for the person to do.
      const video = youtube.idOf(file);
      const stopWatching =
        video === null
          ? () => {}
          : youtube.onWaiting((key, at) => {
              if (key !== video) return;
              app.scripts.set(app, id, (job) => {
                const entry = job.files[index];
                if (entry === undefined || entry.state !== "downloading") return;
                if (at === null) delete entry.retry_at;
                else entry.retry_at = at;
              });
            });
      try {
        if (file.startsWith("sha256:") && !cloudEnabled()) throw new steps.NeedsPerson("A shared folder master needs Edit's cloud connection. Sign in and retry.");
        if (reviewOf(file) !== null && !cloudEnabled()) throw new steps.NeedsPerson("A finished video from its review link needs Edit's cloud connection: sign in to Edit.");
        const [bytes, name, cut] = cloudEnabled() ? await footageToCloud(app, id, index, file, letGo) : await footageToDisk(app, id, index, file);
        const ranges = fileRanges(app.store.get(id)?.project ?? live.project, file);
        app.scripts.keepMade(id, file, ranges, cut);
        app.scripts.set(app, id, (job) => {
          const entry = job.files[index];
          if (entry === undefined) return;
          entry.state = "done";
          entry.bytes = bytes;
          entry.total = bytes;
          delete entry.cut;
          if (name === null) delete entry.name;
          else entry.name = name;
        });
        fetched[index] = [file, cut];
        diag.info("script", `${title}: file ${index + 1} of ${files.length} ready (${name ?? file}, ${cut.length} ${cut.length === 1 ? "piece" : "excerpts"}, ${diag.human(timing.now() - fileBegan)})`);
      } catch (error) {
        if (isBug(error)) throw error;
        const why = steps.whyOf(error);
        diag.warn("script", `${title}: file ${index + 1} of ${files.length} (${file}) failed after ${diag.human(timing.now() - fileBegan)} (${why}): ${diag.messageOf(error)}`);
        errors[index] = error;
        app.scripts.set(app, id, (job) => {
          const entry = job.files[index];
          if (entry === undefined) return;
          entry.state = "failed";
          entry.error = diag.messageOf(error);
          entry.why = why;
          // Its tries so far: the next one's wait grows with them (failure.ts `nextTry`).
          entry.tries = (entry.tries ?? 0) + 1;
          delete entry.cut;
        });
      } finally {
        stopWatching();
      }
    };
    const toFetch = (index: number) => fetched[index] === undefined;
    // A few at once (ten files took the sum of their times, the bar sitting on the first).
    await Promise.all(files.map((file, index) => (toFetch(index) ? fetchOne(index, file) : Promise.resolve())));
    // Still missing: the edit isn't laid out with a hole in it. Nothing sleeps in here between tries (it did, a minute
    // and then five, while the import counted as working and every answer was refused): each file is settled at
    // once by failure.ts and the import waits in the job table, woken at its soonest try, at once when the
    // connection is back (jobs.wakePassing), or by the person's answer.
    const missing = files.flatMap((_, index) => (toFetch(index) ? [index] : []));
    if (missing.length > 0 && !inserting) {
      const whys = missing.map((index) => steps.whyOf(errors[index] ?? ""));
      // Only the person's (a file deleted, never shared, a private video) is asked about: another link, or go on
      // without it. Anything else waits by itself, woken by the job table: credit, Drive's download limit, the encoder,
      // a full disk, and whatever passes (a dropped connection, a busy Google, a step that stood still), tried again
      // after 1, 5 and 15 minutes then every 30 until it comes in (Nov 18, JJ's School Bookkeeper: his Wi-Fi dropped
      // for a minute, the interview's file was handed to him as "couldn't be downloaded", and his "Go on without it" lost it).
      const byItself = whys.every(steps.waitsByItself);
      const now = nowMs();
      // Each file's own time (credit's half hour, the day's reset, Google's, a passing one's next try); the import is woken at the soonest.
      const triesOf = (index: number) => Math.max((app.scripts.get(id)?.files[index]?.tries ?? 1) - 1, 0);
      const fileAt = missing.map((index, n) => (steps.waitsByItself(whys[n]!) ? failure.nextTry(whys[n]!, triesOf(index), now, errors[index]) : null));
      const times = fileAt.filter((at): at is number => at !== null);
      const retryAt = times.length > 0 ? Math.min(...times) : null;
      const asked = whys.filter((why) => !steps.waitsByItself(why)).length;
      app.scripts.set(app, id, (job) => {
        job.state = "waiting";
        for (const [n, index] of missing.entries()) {
          const entry = job.files[index];
          if (entry === undefined) continue;
          const at = fileAt[n];
          // The person's (and Edit's own bug) stays `failed` (what the page asks about); the rest wait by themselves.
          if (steps.waitsByItself(whys[n]!)) {
            entry.state = "waiting";
            if (at !== null && at !== undefined) entry.retry_at = at;
            else delete entry.retry_at;
          } else delete entry.retry_at;
        }
        if (byItself) job.error = waitingLine(whys, missing.length, files.length, retryAt, missing.map((index) => errors[index]));
        else job.error = `${asked} of ${files.length} footage files couldn't be downloaded`;
        if (retryAt !== null) job.retry_at = retryAt;
        else delete job.retry_at;
      });
      diag.warn("script", `${title}: ${byItself ? "waiting by itself" : "waiting for the person"}: ${missing.length} of ${files.length} files couldn't be downloaded (${diag.human(timing.now() - began)})`);
      finish(
        byItself
          ? retryAt === null
            ? { state: "waiting", step: "waiting for the encoder", until: "encoder", on: "encoder" }
            : whys.includes("quota")
              ? { state: "waiting", step: "waiting for credit", retry_at: retryAt, on: "quota" }
              : whys.includes("limit")
                ? { state: "waiting", step: "waiting for Google Drive", retry_at: retryAt, on: "drive" }
                : whys.includes("room")
                  ? // The room it needs kept, so the table looks at the disk before cutting again (Fable's last look, Nov 19:
                    // it cut into a full disk every five minutes on JJ's Mac, verify.md finding 5's own case).
                    { state: "waiting", step: "waiting for room", retry_at: retryAt, on: "room", args: { room_bytes: roomNeeded(app, id, files, missing, errors) } }
                  : { state: "waiting", step: "trying again by itself", retry_at: retryAt, on: "passing", args: { room_bytes: 0 } }
          : // The person's file waits for them; one passing beside it is still tried again by itself.
            whys.includes("passing") && retryAt !== null
            ? { state: "waiting", step: "waiting for the person", retry_at: retryAt }
            : { state: "waiting", step: "waiting for the person", until: "person" },
      );
      return;
    }
    const done = fetched.filter((file): file is [string, Excerpt[]] => file !== undefined);
    app.scripts.set(app, id, (job) => {
      job.state = "placing";
      delete job.error;
      delete job.retry_at;
    });
    let result: string | null = null;
    let late: string[] = [];
    try {
      if ((app.store.get(id)?.project.script?.source ?? null) !== source) throw new Error("another script was attached while this one was importing: this import stops");
      if (inserting && done.length !== files.length) throw new Error("The new case is not fully downloaded. Retry it; the existing edit has not been moved.");
      late = await diag.timeAsync("script", "script: lay out", () => place(app, id, done, recut));
    } catch (error) {
      if (isBug(error)) throw error;
      if (error instanceof CreditWait) {
        // The words decide every cut: laid out once the plan has credit again, tried every half hour.
        const at = steps.retryAt("quota", nowMs())!;
        app.scripts.set(app, id, (job) => {
          job.state = "waiting";
          job.error = error.message;
          job.retry_at = at;
        });
        diag.warn("script", `${title}: waiting for the transcription plan's credit: ${error.message}`);
        finish({ state: "waiting", step: "waiting for credit", retry_at: at, on: "quota" });
        return;
      }
      result = diag.messageOf(error);
    }
    if (result !== null) {
      app.scripts.set(app, id, (job) => {
        job.state = "failed";
        job.error = result!;
      });
      diag.warn("script", `${title}: import stopped: ${result} in ${diag.human(timing.now() - began)}`);
      finish({ state: "failed", error: result });
      return;
    }
    // Laid out: the import's part is done. What follows has its own lines, never failing it.
    if (late.length > 0) {
      app.scripts.set(app, id, (job) => {
        job.after = afterLine(job.after, "words", "waiting", `Laid out without words for ${late.length === 1 ? late[0] : `${late.length} files (${late.slice(0, 3).join(", ")}${late.length > 3 ? "…" : ""})`}: their cuts are the Doc's times. Transcription is still running.`);
      });
      diag.warn("script", `${title}: laid out without words for ${late.join(", ")}: transcription still running after ${Math.round(steps.LIMITS.transcript / 60_000)} min`);
    }
    await followOn(app, id, inserting ? inserting.id : null, recut, began);
    settled = true;
  };
  // A crash fails the import instead of leaving it mid-way for good.
  return catchBugsAsync("the script import", work).catch((error: unknown) => {
    const message = isBug(error) ? crashed("the script import", error) : diag.messageOf(error);
    app.scripts.set(app, id, (job) => {
      job.state = "failed";
      job.error = message;
    });
    if (!settled) finish({ state: "failed", error: message });
  });
}

/** Thrown by `place` when footage waits for its words on the transcription plan's credit. */
class CreditWait extends Error {}

/** The import's line while it waits by itself. */
/**
 * The room an editor import waits for: each file's `NoRoom` speaks for one excerpt, and a file's excerpts are cut a few
 * at once, so it's that times the file's ranges, summed over the files, with a fifth more for the disk's own overhead
 * (bad-day no-room, Nov 20: 12 MB said, 12 MB free, two excerpts cut at once into it every five minutes).
 */
function roomNeeded(app: App, id: string, files: string[], missing: number[], errors: unknown[]): number {
  const project = app.store.get(id)?.project;
  const total = missing.reduce((sum, index) => sum + roomFor([errors[index]]) * Math.max(1, project === undefined ? 1 : fileRanges(project, files[index]!).length), 0);
  return Math.ceil(total * 1.2);
}

/** The most room any of these failures says it needs (a `NoRoom`, or one it caused), in bytes; 0 when none says. */
export function roomFor(errors: unknown[]): number {
  let most = 0;
  for (const error of errors) {
    for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
      if (at instanceof failure.NoRoom) most = Math.max(most, at.needBytes);
    }
  }
  return most;
}

function waitingLine(whys: steps.Why[], missing: number, total: number, retryAt: number | null, errors: unknown[] = []): string {
  const files = `${missing} of ${total} footage files`;
  if (whys.includes("quota")) return `The transcription plan is out of credit: ${files} wait for it${retryAt === null ? "" : `; Edit tries again at ${clockTime(retryAt)}`}.`;
  if (whys.includes("limit")) {
    const one = whys.filter((why) => why === "limit").length === 1;
    return `Google Drive's download limit is used up for today for ${one ? "a footage file" : "some footage files"}: Edit tries again by itself${retryAt === null ? "" : ` at ${when(retryAt)}`}. To go on sooner, replace ${one ? "it" : "them"} with a copy's link (Make a copy in Drive).`;
  }
  if (whys.includes("encoder")) return `The hardware encoder is busy with an export: ${files} wait until it's free.`;
  if (whys.includes("room")) {
    // The room asked for, when a cut said it ("Needs about 85 MB free on this computer…").
    const needs = errors.map((error) => (error instanceof failure.NoRoom && error.needBytes > 0 ? error.message : null)).find((said) => said !== null);
    return `${needs ?? "This computer is out of room."} ${files} wait, and Edit tries again by itself once there's room${retryAt === null ? "" : ` (next at ${clockTime(retryAt)})`}.`;
  }
  // Whatever passes (a dropped connection, a busy Google): tried again by itself, nothing for the person to do.
  return `Trying ${missing === 1 ? "a file" : `${missing} files`} again${retryAt === null ? "" : ` at ${clockTime(retryAt)}`}`;
}

const clockTime = steps.clock;

/** "14:30", or "Tue 14:30" when it isn't today. */
function when(ms: number): string {
  const today = new Date(ms).toDateString() === new Date(nowMs()).toDateString();
  return today ? clockTime(ms) : `${new Date(ms).toLocaleDateString([], { weekday: "short" })} ${clockTime(ms)}`;
}

/** One follow-on's line, set (the others kept, in their order). */
function afterLine(after: ScriptJob["after"], step: NonNullable<ScriptJob["after"]>[number]["step"], state: NonNullable<ScriptJob["after"]>[number]["state"], note?: string): NonNullable<ScriptJob["after"]> {
  const out = (after ?? []).filter((one) => one.step !== step);
  out.push(note === undefined ? { step, state } : { step, state, note });
  const order = ["words", "reuse", "recording", "voiceover", "research"];
  return out.sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
}

/**
 * What follows the layout: the team's recording placed, the voice-over
 * spoken and split across the cut-ins, the case's research. Each says how it
 * went on its own line of the job (`after`); none fails the import, which
 * ends done: the edit is laid out and plays.
 */
async function followOn(app: App, id: string, inserting: string | null, recut: boolean, began: number): Promise<void> {
  const title = app.store.get(id)?.project.name ?? id;
  app.scripts.set(app, id, (job) => {
    job.state = "voicing";
  });
  const say = (step: NonNullable<ScriptJob["after"]>[number]["step"], state: NonNullable<ScriptJob["after"]>[number]["state"], note?: string) =>
    app.scripts.set(app, id, (job) => {
      job.after = afterLine(job.after, step, state, note);
    });
  // A kind of video narrated by the team's recording: the one given with
  // the script (audio in the project, not on the timeline) is placed on
  // the cut-ins it reads; only what it doesn't read is voiced, as a stand-in.
  if (inserting === null && NARRATION[app.store.get(id)?.project.style ?? "bodycam"] === "recording") {
    try {
      await fetchRecording(app, id);
    } catch (error) {
      if (isBug(error)) throw error;
      diag.warn("script", `${title}: getting the voice-over recording: ${diag.messageOf(error)}`);
    }
  }
  const project = app.store.get(id)?.project;
  if (inserting === null && project !== undefined && NARRATION[project.style] === "recording" && unplacedAudio(project)) {
    say("recording", "running");
    try {
      await diag.timeAsync("script", "script: place the recording", () => seams.voiceover.place(app, id, null));
      say("recording", "done");
    } catch (error) {
      if (isBug(error)) throw error;
      diag.warn("script", `${title}: placing the voice-over recording: ${diag.messageOf(error)}`);
      say("recording", "failed", `The team's recording couldn't be placed: ${diag.messageOf(error)}`);
    }
  }
  // Laid out: the cut-ins get their voice-over, spoken and split across them.
  // A courtroom video's too (the team couldn't get one made for Judge EXPLODES,
  // Oct 22): a recording added later takes its place (place_voiceovers).
  // Tried again by itself after a pause (a dropped connection to the voice
  // service). ElevenLabs out of credit, or the day's voice allowance used up,
  // isn't asked again minutes later (a spent quota was asked twice more, Nov 8):
  // the import waits for it, woken by the job table every half hour (the
  // allowance: at its reset), and carries on with the cut-ins still unvoiced;
  // the takes already spoken are kept (voiceover.ts `generateMissing`).
  say("voiceover", "running");
  let credit: { at: number; line: string } | null = null;
  // One voice-over at a time: past its half hour the next try waits on the one still running rather than starting a
  // second beside it (Nov 20: `bounded` can't stop the voice service's calls, so a second paid voice-over began next to
  // the first). It's let go once it ends either way.
  let speaking: Promise<unknown> | null = null;
  const speak = (): Promise<unknown> => {
    if (speaking !== null) return speaking;
    const run = (inserting !== null ? seams.voiceover.generateCase(app, id, inserting) : seams.voiceover.generate(app, id, true)).finally(() => {
      if (speaking === run) speaking = null;
    });
    run.catch(() => {});
    speaking = run;
    return run;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await diag.timeAsync("script", "script: voice-over", () => steps.bounded("the voice-over", steps.LIMITS.voiceover, () => speak()));
      say("voiceover", "done");
      break;
    } catch (error) {
      if (isBug(error)) throw error;
      const said = `The voice-over couldn't be made: ${diag.messageOf(error)}`;
      if (inserting === null && voiceCredit(error)) {
        const at = steps.retryAt("quota", nowMs(), error)!;
        credit = { at, line: voiceWaits(error, at) };
        diag.warn("script", `${title}: ${said} (the edit is laid out; the voice-over waits and is tried again at ${new Date(at).toLocaleString()})`);
        say("voiceover", "waiting", credit.line);
        break;
      }
      const wait = timing.retryWaits[attempt];
      if (wait === undefined || /used up|allowance|budget|quota/i.test(diag.messageOf(error))) {
        diag.warn("script", `${title}: ${said} (the edit is laid out; Make the voice-over again from the agent)`);
        say("voiceover", "failed", said);
        break;
      }
      diag.warn("script", `${title}: ${said}; trying again in ${diag.human(wait)}`);
      await timing.sleep(wait);
    }
  }
  app.scripts.set(app, id, (job) => {
    if (credit !== null) {
      job.state = "waiting";
      job.error = credit.line;
      job.retry_at = credit.at;
      return;
    }
    job.state = "done";
    delete job.error;
    delete job.retry_at;
  });
  if (credit === null) diag.info("script", `${title}: import done in ${diag.human(timing.now() - began)}`);
  // A new edit starts with the case's research, so the articles and images
  // are waiting by the time the editing gets to them. Not a Short: it shows
  // only its own footage (no maps, photos or articles to wait for). Once: a
  // voice-over carried on after its wait doesn't ask again.
  const home = app.store.home;
  const now = app.store.get(id);
  const researched = seams.research.articles(home, id).length > 0 || seams.research.items(home, id).length > 0 || app.scripts.get(id)?.after?.some((line) => line.step === "research" && line.state === "done") === true;
  if (!recut && inserting === null && !researched && !(now !== null && now !== undefined && isEssay(now.project.style)) && now?.project.style !== "shorts") {
    try {
      await seams.agentPanel(app).send(id, RESEARCH, null, null);
      say("research", "done", "The agent is researching the case.");
    } catch (error) {
      diag.warn("script", `research didn't start for ${id}: ${diag.messageOf(error)}`);
      say("research", "failed", `The research didn't start: ${diag.messageOf(error)}`);
    }
  }
  if (credit !== null) {
    app.scripts.finish(id, { state: "waiting", step: "waiting for voice credit", retry_at: credit.at, on: "voice" });
    return;
  }
  app.scripts.finish(id, { state: "done" });
}

/** ElevenLabs out of credit, or the day's voice allowance used up: what waits for it rather than failing. */
function voiceCredit(error: unknown): boolean {
  return /exceeds your quota|quota_exceeded|credits remaining|insufficient.credits|out of credit|voice (allowance|budget)[^.]*used up/i.test(diag.messageOf(error));
}

/** The voice-over's line while it waits (the person's and the agent's): which service, who adds credit, when Edit tries again. */
function voiceWaits(error: unknown, at: number): string {
  if (/voice (allowance|budget)[^.]*used up/i.test(diag.messageOf(error))) return `Today's voice-over allowance is used up: the cut-ins left wait for it, and Edit voices them by itself at ${when(at)}, when it resets.`;
  return `ElevenLabs is out of credit: an admin adds credit, and Edit voices the cut-ins left by itself (tried again at ${when(at)}).`;
}

/** Retry, another link, skip, a remote resume or unstick, or the job table waking it: one way to carry an import on. What it did, in a word. */
export function carryOn(app: App, id: string): "started" | "working" | "finished" | "nothing" {
  if (app.scripts.working(id)) return "working";
  const live = app.store.get(id);
  if (live === null) return "nothing";
  if (!unfinished(live.project) && app.scripts.get(id)?.state !== "voicing") {
    // Waited on the voice-over's credit, and its cut-ins were voiced or changed meanwhile: nothing waits any more.
    if (app.scripts.get(id)?.state === "waiting" && laidOut(live.project)) {
      app.scripts.set(app, id, (job) => {
        job.state = "done";
        delete job.error;
        delete job.retry_at;
      });
    }
    return "finished";
  }
  return start(app, id, false) !== null ? "started" : "nothing";
}

/**
 * Whether a laid-out script still has cut-ins the import never voiced (its
 * voice-over failed: the Doc of Nov 8 stopped at a spent ElevenLabs quota):
 * untouched import cards with no voice-over, never one edited on purpose.
 */
export function unvoiced(project: Project): boolean {
  return laidOut(project) && seams.voiceover.narrationRecovery(project).some((line) => line.state === "missing");
}

/** A file's download progress, into its row of the job (a few times a second). */
function fileProgress(app: App, id: string, index: number): (bytes: number, total: number | null, name: string) => void {
  let last = timing.now() - 1000;
  return (bytes, total, name) => {
    if (timing.now() - last < 350) return;
    last = timing.now();
    app.scripts.set(app, id, (job) => {
      const entry = job.files[index];
      if (entry === undefined) return;
      entry.bytes = bytes;
      if (total === null) delete entry.total;
      else entry.total = total;
      entry.name = name;
    });
  };
}

/** Says how many of a file's excerpts are cut. */
function cutProgress(app: App, id: string, index: number): (done: number, total: number) => void {
  return (done, total) =>
    app.scripts.set(app, id, (job) => {
      const entry = job.files[index];
      if (entry !== undefined) entry.cut = { done, total };
    });
}

function setFileState(app: App, id: string, index: number, state: FileJob["state"]): void {
  app.scripts.set(app, id, (job) => {
    const entry = job.files[index];
    if (entry !== undefined) entry.state = state;
  });
}

/** What a fetched footage file gave: its bytes, its name and the excerpts the script plays from. */
type Fetched = [bytes: number, name: string | null, cut: Excerpt[]];

/** Downloads a Drive file to this machine and cuts the script's excerpts from it. */
async function footageToDisk(app: App, id: string, index: number, file: string): Promise<Fetched> {
  const progress = fileProgress(app, id, index);
  const video = youtube.idOf(file);
  const post = posts.urlOf(file);
  const path = await diag.timeOnAsync("script", "script: download", post !== null ? `post ${post}` : video === null ? `Drive file ${file}` : `YouTube video ${video}`, async () => {
    if (post !== null) return (await posts.download(app.store.home, post, join(app.store.driveDir(), "posts"), progress)).path;
    if (video !== null) {
      const dir = join(app.store.driveDir(), "youtube", video);
      return (await youtube.download(app.store.home, video, dir, progress)).path;
    }
    const dir = join(app.store.driveDir(), file);
    return download(dir, file, progress);
  });
  // Then only the parts the script uses become media.
  setFileState(app, id, index, "cutting");
  const live = app.store.get(id);
  const ranges = live === null ? [] : fileRanges(live.project, file);
  const cutUp = await diag.timeOnAsync("script", "script: cut excerpts", path, () => excerpts(path, ranges, cutProgress(app, id, index)));
  let bytes = 0;
  try {
    bytes = fs.statSync(path).size;
  } catch {
    bytes = 0;
  }
  return [bytes, fileName(path), cutUp];
}

/**
 * Cloud mode: streams the Drive file to R2 (never to this disk; skipped when
 * the registry has it already), then cuts the script's excerpts from R2 and
 * keeps only their proxies here (`cloud_media`). A copy Script mode keeps on
 * this Mac is cut from first, its upload going on behind (`scriptModeCopy`).
 * `letGo` lets go of the file's download slot once its bytes are in hand.
 */
async function footageToCloud(app: App, id: string, index: number, file: string, letGo: () => void = () => {}): Promise<Fetched> {
  const progress = fileProgress(app, id, index);
  const live = app.store.get(id);
  if (live !== null && live !== undefined && isEssay(live.project.style) && youtube.idOf(file) !== null) {
    const cut = await seams.cloudMedia.youtubeExcerpts(app.store.home, app.store.cacheDir(), file, fileRanges(live.project, file), progress);
    return [cut.reduce((n, one) => n + (one.cloud?.cloud?.size ?? 0), 0), cut[0]?.cloud?.name ?? file, cut];
  }
  const scratch = seams.cloudMedia.scratchDir(app.store.cacheDir());
  const shared = file.startsWith("sha256:");
  const expectedKey = live?.project.script?.blocks.find((block) => block.kind === "footage" && block.file === file)?.notes?.find((note) => note.startsWith("Shared original: "))?.slice("Shared original: ".length);
  // Script mode's copy here first: a recording it brought down, or a folder case's master it joined (Start the edit
  // sends that up behind the edit: writer/handoff.ts `nameShared`).
  const held = reviewOf(file) !== null || posts.urlOf(file) !== null ? null : await scriptModeCopy(file, progress, letGo);
  if (held !== null) progress(held.size, held.size, held.name);
  const [original, local]: [Original, string | null] =
    held !== null
      ? [{ file, source: sourceOf(file), key: held.key, name: held.name, size: held.size }, null]
      : shared
      ? [await seams.cloudMedia.registeredOriginal(file, expectedKey), null]
      : reviewOf(file) !== null
        ? await diag.timeOnAsync("script", "script: finished video to cloud", file, () => seams.cloudMedia.reviewOriginal(file, scratch, progress))
        : posts.urlOf(file) !== null
        ? await diag.timeOnAsync("script", "script: post to cloud", file, () => seams.cloudMedia.postOriginal(app.store.home, file, scratch, progress))
        : youtube.idOf(file) !== null
      ? await diag.timeOnAsync("script", "script: youtube to cloud", file, () =>
          seams.cloudMedia.youtubeOriginal(app.store.home, file, scratch, progress),
        )
      : [
          await diag.timeOnAsync("script", "script: download to cloud", `Drive file ${file}`, () =>
            seams.cloudMedia.driveOriginal(file, scratch, progress),
          ),
          null,
        ];
  // Its bytes are in: the slot goes to the next file's download before this one waits for its turn to be cut.
  letGo();
  try {
    const live = app.store.get(id);
    const ranges = live === null ? [] : fileRanges(live.project, file);
    const cache = app.store.cacheDir();
    // This very original on this Mac (Script mode brought it down, an earlier import here): its excerpts are cut from
    // that copy, in seconds, never read back from the cloud's address (honest council change 8a, Nov 19: cutting over
    // JJ's line is where Edit's three time limits stopped his files).
    const here = held?.path ?? local ?? seams.cloudMedia.localOriginal(cache, original.key, true);
    if (here !== null && local === null) diag.info("script", `${original.name}: cut from its copy on ${THIS_MACHINE}${held !== null ? " (Script mode's; its upload goes on behind)" : ""}`);
    // In line behind this project's other file being cut: said as waiting its turn, its bytes kept, never "cutting"
    // with no count.
    setFileState(app, id, index, "queued");
    const cutUp = await diag.timeOnAsync("script", "script: cloud excerpts", original.key, () =>
      cutLane(id).with(() => {
        setFileState(app, id, index, "cutting");
        return seams.cloudMedia.driveExcerpts(cache, original, ranges, here, cutProgress(app, id, index));
      }),
    );
    return [original.size, original.name, cutUp];
  } finally {
    held?.release();
    // A YouTube download is on R2 now: its copy here goes.
    if (local !== null) fs.rmSync(parent(local) ?? local, { recursive: true, force: true });
  }
}

type Original = Awaited<ReturnType<typeof seams.cloudMedia.driveOriginal>>;

/** The registry's source for a footage file: a YouTube video or a shared master by its own name, a Drive file by its id. */
const sourceOf = (file: string): string => (youtube.idOf(file) !== null || file.startsWith("sha256:") ? file : `drive:${file}`);

/**
 * Script mode's whole copy of this file's original on this Mac (writer/streamed.ts), held while it's cut from; null when
 * there's none. One still coming down there is waited for while it grows (its download slot let go: those are Script
 * mode's bytes, in its own slot), for as long as it moves: still for five minutes, the file fails as passing and waits
 * in the table, never for ever inside the import. On an 8 Mbit/s line (~1 MB/s down on a bad day) a recording grows
 * every few seconds, so five minutes without a byte is a line that's gone, or a lid closed (the clock starts again
 * after a wake: `whileMoving`). Its download failing there, the file is fetched as before.
 */
async function scriptModeCopy(file: string, progress: (bytes: number, total: number | null, name: string) => void, letGo: () => void): Promise<{ path: string; key: string; name: string; size: number; release: () => void } | null> {
  const source = sourceOf(file);
  let found = copiesHere.find(source);
  if (found !== null && "landing" in found) {
    const { path, size, name, done } = found.landing;
    letGo();
    diag.info("script", `${name}: coming down for Script mode on ${THIS_MACHINE}; cut from that copy once it's whole`);
    await steps.whileMoving(
      `Script mode's download of ${name}`,
      () => {
        const at = steps.sizeOf(path);
        progress(at, size, name);
        return at;
      },
      () => done.then(
        () => undefined,
        () => undefined,
      ),
    );
    found = copiesHere.find(source);
  }
  return found !== null && "copy" in found ? found.copy : null;
}

/**
 * Imports the excerpts, transcribes the footage, finds each range's exact
 * cut from its cue words, and puts every block it can on the timeline.
 * `recut` first clears what an earlier layout placed.
 */
async function place(app: App, id: string, done: [string, Excerpt[]][], recut: boolean): Promise<string[]> {
  // Excerpts on this disk are imported as files; cloud ones come made.
  const all = done.flatMap(([, cutUp]) => cutUp);
  const made = all.filter((excerpt) => excerpt.cloud !== null);
  const paths = all.filter((excerpt) => excerpt.cloud === null);
  if (paths.length > 0) {
    const [, , errors] = await importPaths(
      app,
      id,
      paths.map((excerpt) => excerpt.path),
      false,
      "script",
    );
    if (errors[0] !== undefined) throw new Error(errors[0]);
  }
  if (made.length > 0) {
    await importMade(
      app,
      id,
      made.map((excerpt) => excerpt.cloud!),
      false,
      "script",
    );
  }
  const files = new Map(done);
  const [live] = await app.store.update(id, "script", (project) => {
    // Which media each range plays from.
    const byPath = new Map(project.media.map((media) => [media.path, media.id]));
    const inserting = pendingCase(project);
    for (const block of project.script?.blocks ?? []) {
      if (block.kind !== "footage") continue;
      if (inserting && placed(project, block)) continue;
      // Scripts read before cue words existed get them from their notes.
      if (block.words === undefined || block.words === null) {
        const words = cueWords(block.notes ?? []);
        if (words === null) delete block.words;
        else block.words = words;
      }
      const found = (files.get(block.file) ?? []).find(
        (excerpt) => excerpt.from <= block.start + 1e-6 && block.end <= excerpt.to + 1e-6,
      );
      if (found === undefined) continue;
      // A reused video plays to its end (a case of it, until it's found in it).
      if ((reusedLabel(block.label) || block.label === WHOLE_SOURCE_LABEL) && found.from === 0) block.end = found.to;
      const mediaId = byPath.get(found.path);
      if (mediaId === undefined) continue;
      block.media = mediaId;
      if (found.from > 0) block.media_start = found.from;
      else delete block.media_start;
    }
  });

  app.scripts.set(app, id, (job) => {
    job.state = "transcribing";
  });
  const said: Unheard = { late: [], credit: [] };
  const heard = await transcripts(app, live.project, undefined, false, said);
  // The plan out of credit: the words decide every cut, so it waits for them (the job table tries again).
  if (said.credit.length > 0) throw new CreditWait(`The transcription plan is out of credit: ${said.credit.length === 1 ? "1 file waits" : `${said.credit.length} files wait`} for ${said.credit.length === 1 ? "its" : "their"} words before the edit is laid out; Edit tries again every ${Math.round(steps.QUOTA_RETRY_MS.value / 60_000)} min.`);

  const cases = await reusedCases(app, live.project);
  if (cases.size > 0) {
    const problems = [...cases.values()].flatMap((one) => ("problem" in one ? [one.problem] : []));
    app.scripts.set(app, id, (job) => {
      job.after = afterLine(job.after, "reuse", problems.length > 0 ? "failed" : "done", problems.length > 0 ? problems.join(" ") : undefined);
    });
  }

  app.scripts.set(app, id, (job) => {
    job.state = "placing";
  });
  await app.store.update(id, "script", (project) => {
    const inserting = pendingCase(project);
    const previous = new Set(project.clips.map((clip) => clip.id));
    const blocks = project.script?.blocks ?? [];
    // A reused video's case plays where it was found in it; not found, the whole video.
    for (const [index, found] of cases) {
      const block = blocks[index];
      if (block === undefined || block.kind !== "footage" || reuseCaseOf(block.label) === null || !isSome(block.media)) continue;
      if (inserting && placed(project, block)) continue;
      const media = mediaOf(project, block.media);
      if (media === undefined) continue;
      [block.start, block.end] = "span" in found ? found.span : [0, media.duration];
      delete block.cut;
    }
    for (const [index, block] of blocks.entries()) {
      if (inserting && placed(project, block)) continue;
      if (block.kind !== "footage" || reusedScriptBlock(block) || !isSome(block.words)) continue;
      const media = isSome(block.media) ? heard.get(block.media) : undefined;
      if (media === undefined) continue;
      const offset = block.media_start ?? 0;
      const [cutIn, cutOut] = align(media.words, media.peaks, block.words, block.start - offset, block.end - offset, padsOf(blocks, index));
      if (cutIn !== null || cutOut !== null) {
        block.cut = [cutIn === null ? block.start : cutIn + offset, cutOut === null ? block.end : cutOut + offset];
      } else {
        delete block.cut;
      }
    }
    // Only a Re-cut lays a script out again (it clears the trims and the rest:
    // never on a resume). A range out of order is the Re-cut's to fix.
    if (recut) clearLayout(project);
    else if (outOfOrder(project)) throw new Error("some ranges came in after the rest was laid out: Re-cut to lay the script out again (it starts the layout over)");
    layOut(project);
    if (inserting) finishCase(project, previous);
  });
  return said.late;
}

/**
 * Whether laying out now would put a range after blocks that follow it in the
 * script: one ready to place (its media in) before a block already placed.
 */
export function outOfOrder(project: Project): boolean {
  let waiting = false;
  for (const block of project.script?.blocks ?? []) {
    if (block.kind === "footage" && !isSome(block.clip) && isSome(block.media) && mediaOf(project, block.media) !== undefined) waiting = true;
    else if (waiting && (isSome(block.clip) || (block.kind === "narration" && isSome(block.voiceover)))) return true;
  }
  return false;
}

/**
 * Re-finds every placed range's first and last words (after matching improves
 * or a transcript arrives) and moves its clip's in and out points to them.
 * Everything after a clip that changes length moves with it, so the timeline
 * stays butted; effects ending on its cut (a shake into a cut-in) keep ending
 * on it. Returns what changed.
 */
export async function realign(app: App, id: string, span: [number, number] | null = null, only: ReadonlySet<string> | null = null): Promise<unknown[]> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  // Only the ranges placed in `span` (timeline frames), or whose clips are `only`, when given: the rest of the edit stays as it is.
  const within = (block: ScriptBlock): boolean => {
    if (only !== null && !(isSome(block.clip) && only.has(block.clip))) return false;
    if (span === null) return true;
    const clip = isSome(block.clip) ? clipOf(live.project, block.clip) : undefined;
    return clip !== undefined && clip.start >= span[0] && clip.start < span[1];
  };
  // Ranges named by clip (a Doc pulled again) that have no words get them from what's said in them, as an export notes them.
  const heard = await transcripts(app, live.project, within, only !== null);
  const [, changed] = await app.store.update(id, "agent", (project) => {
    const fps = fpsOf(project);
    const changed: unknown[] = [];
    if (!isSome(project.script)) return changed;
    const blocks = structuredClone(project.script.blocks);
    for (const [index, block] of blocks.entries()) {
      let cue = block.kind === "footage" ? cueOf(block) : null;
      if (block.kind !== "footage" || reusedScriptBlock(block) || !isSome(block.media) || !isSome(block.clip) || !within(block)) continue;
      const media = heard.get(block.media);
      if (media === undefined) continue;
      const offset = block.media_start ?? 0;
      // Its cut only: the words stay the Doc's (none), so a Doc pulled again sees the range unchanged.
      if (cue === null && only !== null) cue = spokenCue(media.words, block.start - offset, block.end - offset);
      if (cue === null) continue;
      const [cutIn, cutOut] = align(media.words, media.peaks, cue, block.start - offset, block.end - offset, padsOf(blocks, index));
      // Never past the media's end: a range the Doc made longer than the footage downloaded plays to its end.
      const limit = mediaOf(project, block.media)?.duration;
      const found: [number, number] = [cutIn === null ? block.start : cutIn + offset, Math.min(cutOut === null ? block.end : cutOut + offset, limit === undefined ? Infinity : limit + offset)];
      if (cutIn !== null || cutOut !== null) block.cut = found;
      else delete block.cut;
      const original = clipOf(project, block.clip);
      if (original === undefined) continue;
      const clip = structuredClone(original);
      if (clip.type !== "video") continue;
      const sourceIn = clip.source_in;
      const speed = clip.speed;
      // The clip plays seconds of the media, which begins `offset` into the file.
      const newIn = found[0] - offset;
      const newOut = found[1] - offset;
      const oldOut = sourceIn + (clip.duration / fps) * speed;
      if (Math.abs(newIn - sourceIn) < 0.5 / fps && Math.abs(newOut - oldOut) < 0.5 / fps) continue;
      const length = Math.trunc(Math.max(round(((newOut - newIn) / speed) * fps), 1));
      const delta = length - clip.duration;
      const oldEnd = clip.start + clip.duration;
      for (const other of project.clips) {
        const partner = other.id === clip.id || (isSome(clip.link) && other.link === clip.link);
        if (partner) {
          if (other.type === "video" || other.type === "audio") other.source_in = newIn;
          other.duration = length;
        } else if (other.start >= oldEnd || marksCut(other, oldEnd)) {
          other.start += delta;
        } else if (delta < 0 && other.start >= clip.start && other.start + other.duration > oldEnd + delta) {
          // Over a clip that got shorter (a teaser's subtitle): it ends with it,
          // or, starting in the part cut away, moves up with what follows, so it
          // never overlaps the next one moved up (realign once refused on that).
          const newEnd = oldEnd + delta;
          if (other.start >= newEnd) other.start += delta;
          else other.duration = Math.max(newEnd - other.start, 1);
        }
      }
      changed.push({
        clip: clip.id,
        first_word_found: cutIn !== null,
        frames_longer: delta,
        last_word_found: cutOut !== null,
        now: [newIn, newOut],
        range: block.label,
        seconds: [sourceIn, oldOut],
      });
    }
    project.script.blocks = blocks;
    return changed;
  });
  return changed;
}

/** The first and last words said in a stretch of a media (any word it touches, as an export notes a range), bare and lowercased. */
function spokenCue(words: Word[], from: number, to: number): [string, string] | null {
  const inside = words.filter((word) => word.start < to && word.end > from);
  const bare = (word: Word) => word.text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || word.text;
  return inside.length === 0 ? null : [bare(inside[0]!), bare(inside.at(-1)!)];
}

/** A footage range's cue words: the Doc's, else its Writer quote's (scripts handed over before quotes became cues). */
function cueOf(block: ScriptBlock): [string, string] | null {
  if (block.kind !== "footage" || reusedScriptBlock(block)) return null;
  if (isSome(block.words)) return block.words;
  const note = (block.notes ?? []).find((one) => one.startsWith(EXPECTED));
  return note === undefined ? null : quoteCue(note.slice(EXPECTED.length));
}

/** What's said in a media file, and how loud it is moment to moment. */
interface Heard {
  words: Word[];
  peaks: Uint8Array | null;
}

/**
 * Transcribes each media the script plays (through Edit's relay) and waits for
 * the words. Media without sound, or whose transcription fails, are left out:
 * their ranges keep the times the Doc wrote.
 */
/** What `transcripts` couldn't hear: still being heard when its wait ran out (`late`), or refused for the plan's credit (`credit`), by name. */
interface Unheard {
  late: string[];
  credit: string[];
}

async function transcripts(app: App, project: Project, within: (block: ScriptBlock) => boolean = () => true, wordless = false, unheard: Unheard = { late: [], credit: [] }): Promise<Map<string, Heard>> {
  const used = new Set<string>();
  for (const block of project.script?.blocks ?? []) {
    if (pendingCase(project) && placed(project, block)) continue;
    if (!within(block)) continue;
    if (block.kind === "footage" && isSome(block.media) && (wordless || cueOf(block) !== null)) used.add(block.media);
  }
  const media = project.media.filter((item) => used.has(item.id) && item.has_audio);
  // Listening for the case's names (names.ts: the script's narration and any research).
  const names = await seams.research.caseNames(app, project);
  for (const item of media) app.media.transcribe(item.path, true, names);
  const out = new Map<string, Heard>();
  const started = timing.now();
  /** Waits for a file's transcript and reads its words (null when it failed or took too long). */
  const heard = async (item: Media): Promise<(Heard & Pick<Transcript, "model" | "heard">) | null> => {
    for (;;) {
      const stage = app.media.status(item.path).transcript;
      if (stage === "ready") {
        let transcript: Transcript | null = null;
        try {
          transcript = parseTranscript(fs.readFileSync(app.media.paths(item.path).transcript, "utf8"));
        } catch {
          return null;
        }
        let peaks: Uint8Array | null = null;
        try {
          peaks = new Uint8Array(fs.readFileSync(app.media.paths(item.path).peaks));
        } catch {
          peaks = null;
        }
        return { words: transcript.words, peaks, model: transcript.model, ...(transcript.heard !== undefined ? { heard: transcript.heard } : {}) };
      }
      // Waiting on the plan's credit (media.ts tries it again by itself): the layout waits with it.
      if (stage === "waiting") {
        unheard.credit.push(item.name);
        return null;
      }
      if (stage === "failed") {
        const why = app.media.status(item.path).transcript_error;
        if (why !== undefined && steps.whyOf(why) === "quota") unheard.credit.push(item.name);
        return null;
      }
      if (timing.now() - started > steps.LIMITS.transcript) {
        unheard.late.push(item.name);
        return null;
      }
      await timing.sleep(2000);
    }
  };
  for (const item of media) {
    const found = await heard(item);
    if (found === null) continue;
    // Rough words (captions or Apple's, here or from Script mode) where a range is cut: Scribe hears the ranges
    // the script keeps, only those (media.ts `refine`), before they're cut on, else a range is cut at rough times
    // (card 1's teasers, Oct 29: captions had "pregnant" missing, "vitals" nine seconds late).
    const ranges = (project.script?.blocks ?? []).flatMap((block): [number, number][] =>
      block.kind === "footage" && block.media === item.id && within(block) && cueOf(block) !== null ? [[block.start - (block.media_start ?? 0), block.end - (block.media_start ?? 0)]] : [],
    );
    if (found.heard !== undefined && !hearsAll(found, ranges)) {
      try {
        if (await app.media.refine(item.path, ranges, names)) {
          const again = await heard(item);
          if (again !== null) {
            out.set(item.id, { words: again.words, peaks: again.peaks });
            continue;
          }
        }
      } catch (error) {
        const why = diag.messageOf(error);
        if (steps.whyOf(why) === "quota") unheard.credit.push(item.name);
        diag.warn("script", `${item.name}: the ranges it keeps weren't heard exactly (${why}); cut on its rough words`);
      }
    }
    out.set(item.id, { words: found.words, peaks: found.peaks });
  }
  return out;
}

/**
 * Where each reused video's case plays (reuse_cases.ts), by block index: its
 * span of the video, or why it wasn't found. The video's words are heard for
 * it (captions first, as every transcript); the video was downloaded whole
 * (`fileRanges`), so its media starts at the file's start.
 */
async function reusedCases(app: App, project: Project): Promise<Map<number, Awaited<ReturnType<typeof reuseCases.findCase>>>> {
  const out = new Map<number, Awaited<ReturnType<typeof reuseCases.findCase>>>();
  const blocks = project.script?.blocks ?? [];
  const wanted = new Set(blocks.filter((block) => block.kind === "footage" && reuseCaseOf(block.label) !== null && isSome(block.media) && !(pendingCase(project) && placed(project, block))));
  if (wanted.size === 0) return out;
  const heard = await transcripts(app, project, (block) => wanted.has(block), true);
  for (const [index, block] of blocks.entries()) {
    if (!wanted.has(block) || block.kind !== "footage") continue;
    const number = reuseCaseOf(block.label)!;
    const media = mediaOf(project, block.media!);
    if (media === undefined) continue;
    if ((block.media_start ?? 0) !== 0) {
      out.set(index, { problem: `Case ${number} of “${media.name}” wasn't found: only part of the video was downloaded. The whole of that part plays there; trim it to the case on the timeline.` });
      continue;
    }
    const words = heard.get(media.id);
    out.set(
      index,
      await diag.timeOnAsync("script", "script: a reused video's case", `${block.file} case ${number}`, () =>
        reuseCases.findCase(
          { home: app.store.home, file: block.file, name: media.name, words: words?.words ?? null, peaks: words?.peaks ?? null, length: media.duration, shots: (from, to) => reuseCases.shotChanges(media.path, from, to) },
          number,
        ),
      ),
    );
  }
  return out;
}

/** Takes the script's clips (and their linked partners) off the timeline so it can be laid out again. */
function clearLayout(project: Project): void {
  const script = project.script;
  if (!isSome(script)) return;
  const placedClips = new Set<string>();
  for (const block of script.blocks) {
    if (block.kind === "narration" && isSome(block.voiceover)) {
      placedClips.add(block.voiceover);
      delete block.voiceover;
    }
    if (isSome(block.clip)) {
      placedClips.add(block.clip);
      delete block.clip;
    }
  }
  const links = new Set(
    project.clips.filter((clip) => placedClips.has(clip.id) && isSome(clip.link)).map((clip) => clip.link as string),
  );
  project.clips = project.clips.filter((clip) => !placedClips.has(clip.id) && !(isSome(clip.link) && links.has(clip.link)));
}

/** The cut-in card's text: sized so long narration still fits on screen. */
export function cutInStyle(width: number, height: number, text: string): TextStyle {
  const k = f32(f32(height) / 1080);
  const maxWidth = f32(f32(width) * 0.62);
  const chars = f32(Math.max(charCount(text), 1));
  const fit = f32(Math.sqrt(f32(f32(f32(0.75 * f32(height)) * maxWidth) / chars)));
  const size = round(Math.min(Math.max(fit, f32(22 * k)), f32(46 * k)));
  return textStyleFrom({
    font: "Geist",
    weight: 500,
    size,
    color: [1, 1, 1, 1],
    tracking: 0,
    line_height: 1.4,
    glow: { enabled: false, color: null, radius: 46, strength: 0.5 },
    max_width: round(maxWidth),
    align: "center",
  });
}

const FILE_COLORS: ClipColor[] = ["blue", "cyan", "green", "orange", "pink", "yellow"];

function tracksOf(project: Project, kind: TrackKind): string[] {
  return project.tracks.filter((track) => track.kind === kind).map((track) => track.id);
}

/** Places every block not on the timeline yet, in script order, after what's there. */
export function layOut(project: Project): void {
  const script: Script | undefined = project.script;
  if (!isSome(script)) return;
  while (tracksOf(project, "video").length < 2) addTrack(project, "video");
  if (tracksOf(project, "audio").length === 0) addTrack(project, "audio");
  const [lower, upper] = tracksOf(project, "video");
  const audio = tracksOf(project, "audio")[0];
  if (lower === undefined || upper === undefined || audio === undefined) return;
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  const colors = new Map<string, ClipColor>();
  let cursor = projectDuration(project);
  let cutIns = 0;
  // Cut-ins (numbered from 1) whose voice-over is on the timeline: placed.
  const voiced = new Set<number>();
  script.blocks
    .filter((block) => block.kind === "narration")
    .forEach((block, index) => {
      if (block.kind === "narration" && isSome(block.voiceover) && clipOf(project, block.voiceover) !== undefined) {
        voiced.add(index + 1);
      }
    });
  for (const block of script.blocks) {
    if (block.kind === "footage") {
      // Placed once already: gone means removed on purpose (a cut-in card
      // replaced by B-roll), so it isn't put back. A re-cut clears these first.
      if (isSome(block.clip)) continue;
      const offset = block.media_start ?? 0;
      // The transcript's cut when there is one, else the Doc's times.
      const [start, end] = block.cut ?? [block.start, block.end];
      const media = isSome(block.media) ? mediaOf(project, block.media) : undefined;
      if (media === undefined) {
        // A range whose file the person went on without: a black card of the Doc's length holds its place, so the
        // story around it stays as written and plays and exports (no media to read).
        if (!goneWithout(block)) continue;
        const length = Math.max(Math.trunc(round((end - start) * fps)), 0);
        if (length <= 0) continue;
        let shade = colors.get(block.file);
        if (shade === undefined) {
          shade = FILE_COLORS[colors.size % FILE_COLORS.length]!;
          colors.set(block.file, shade);
        }
        const id = freshId(project, "c");
        project.clips.push(
          clipFrom({ id, track: lower, start: cursor, duration: length, color: shade, name: `${goneWithoutName(block) ?? "Footage"} · didn't come in`, type: "solid", fill: [0, 0, 0, 1], opacity: 1 }),
        );
        block.clip = id;
        cursor += length;
        continue;
      }
      const from = Math.min(Math.max(start - offset, 0), media.duration);
      const to = Math.min(end - offset, media.duration);
      if (to <= from) continue;
      let color = colors.get(block.file);
      if (color === undefined) {
        color = FILE_COLORS[colors.size % FILE_COLORS.length]!;
        colors.set(block.file, color);
      }
      const length = Math.max(Math.trunc(round((to - from) * fps)), 1);
      const link = media.has_audio ? freshId(project, "l") : null;
      const id = freshId(project, "c");
      project.clips.push(
        media.kind === "audio"
          ? // A sound-only file (a police call) has no picture: a black card
            // holds its place for the picture made over it (the call look).
            clipFrom({
              id,
              track: lower,
              start: cursor,
              duration: length,
              color,
              ...(link !== null ? { link } : {}),
              name: `${media.name} · sound only`,
              type: "solid",
              fill: [0, 0, 0, 1],
              opacity: 1,
            })
          : clipFrom({
              id,
              track: lower,
              start: cursor,
              duration: length,
              color,
              ...(link !== null ? { link } : {}),
              type: "video",
              media: media.id,
              source_in: from,
              speed: 1,
              // Filling the frame: a 3:2 tape or a 4:3 interview never sits in black bars.
              transform: { ...framing.fill(project, media), rotation: 0 },
            }),
      );
      if (media.has_audio) {
        project.clips.push(
          clipFrom({
            id: freshId(project, "c"),
            track: audio,
            start: cursor,
            duration: length,
            color,
            ...(link !== null ? { link } : {}),
            type: "audio",
            media: media.id,
            source_in: from,
            speed: 1,
          }),
        );
      }
      block.clip = id;
      cursor += length;
    } else {
      cutIns += 1;
      if (isSome(block.clip) || voiced.has(cutIns)) continue;
      const length = Math.max(Math.trunc(round(CUT_IN_SECONDS * fps)), 1);
      const link = freshId(project, "l");
      const card = freshId(project, "c");
      project.clips.push(
        clipFrom({
          id: card,
          track: lower,
          start: cursor,
          duration: length,
          color: "purple",
          name: `Cut-in ${cutIns}`,
          link,
          type: "solid",
          fill: [0, 0, 0, 1],
          opacity: 1,
        }),
      );
      project.clips.push(
        clipFrom({
          id: freshId(project, "c"),
          track: upper,
          start: cursor,
          duration: length,
          color: "purple",
          link,
          type: "text",
          text: block.text,
          style: cutInStyle(width, height, block.text),
        }),
      );
      block.clip = card;
      cursor += length;
    }
  }
}

/**
 * A cut-in the script didn't have, added at the cut at frame `at`: the time
 * opened there (everything after moves on), the black card with its words
 * placed in it, and a narration block for it in the script before the first
 * range after the cut, so generate_voiceover voices it like the others. Card
 * 1's bridge from its reused case into the next had no way in (Oct 29: the
 * agent "can't voice a new narration"). The card's id.
 */
export function addCutIn(project: Project, text: string, at: number): string {
  const script = project.script;
  if (!isSome(script)) throw new Error("this project has no script to add a cut-in to");
  const words = text.trim();
  if (words === "") throw new Error("text is the cut-in's narration, word for word");
  const footage = project.clips.filter((clip) => clip.type === "video" && tracksOf(project, "video")[0] === clip.track);
  if (at !== 0 && !footage.some((clip) => clip.start + clip.duration === at) && !footage.some((clip) => clip.start === at)) {
    throw new Error("at must be a cut on the footage track (a frame where one clip ends or starts)");
  }
  const fps = fpsOf(project);
  const length = Math.max(Math.trunc(round(CUT_IN_SECONDS * fps)), 1);
  insertTime(project, at, length, new Set(), new Set());
  const { width, height } = project.settings;
  const link = freshId(project, "l");
  const card = freshId(project, "c");
  project.clips.push(clipFrom({ id: card, track: freeTrack(project, "video", at, at + length), start: at, duration: length, color: "purple", name: "Cut-in (added)", link, type: "solid", fill: [0, 0, 0, 1], opacity: 1 }));
  project.clips.push(clipFrom({ id: freshId(project, "c"), track: freeTrack(project, "video", at, at + length), start: at, duration: length, color: "purple", link, type: "text", text: words, style: cutInStyle(width, height, words) }));
  // In the script before the first block placed after the cut.
  const startOf = (block: ScriptBlock) => {
    const id = block.kind === "narration" ? (block.voiceover ?? block.clip) : block.clip;
    const clip = isSome(id) ? clipOf(project, id) : undefined;
    return clip === undefined ? null : clip.start;
  };
  const index = script.blocks.findIndex((block) => {
    const start = startOf(block);
    return start !== null && start >= at + length;
  });
  const block: ScriptBlock = { kind: "narration", text: words, notes: ["Added cut-in"], clip: card };
  if (index < 0) script.blocks.push(block);
  else script.blocks.splice(index, 0, block);
  return card;
}

/** Attaches a Doc's script to a project (replacing any before). */
export function attach(project: Project, source: string, parsed: Parsed): void {
  project.script = { source, blocks: parsed.blocks };
}

/** How much a script holds, for the import dialog's preview. */
export function summary(parsed: Parsed): {
  files: number;
  footage: number;
  narration: number;
  seconds: number;
  title: string;
  whole?: number;
  reused?: Parsed["reused"];
  skipped?: Parsed["skipped"];
  style?: Style;
  finished?: string[];
  cardScript?: Parsed["cardScript"];
} {
  const files: string[] = [];
  let footage = 0;
  let narration = 0;
  let seconds = 0;
  let whole = 0;
  // Finished videos by their review link, by name (compilation_input's note).
  const finished = [
    ...new Set(parsed.blocks.flatMap((block) => (block.notes ?? []).filter((note) => note.startsWith("Finished video: ")).map((note) => note.slice("Finished video: ".length).replace(/, played as it is$/, "")))),
  ];
  for (const block of parsed.blocks) {
    if (block.kind === "footage") {
      footage += 1;
      if (reusedLabel(block.label) || block.label === WHOLE_SOURCE_LABEL) whole++;
      else seconds += block.end - block.start;
      if (!files.includes(block.file)) files.push(block.file);
    } else {
      narration += 1;
      seconds += CUT_IN_SECONDS;
    }
  }
  return {
    files: files.length,
    footage,
    narration,
    seconds,
    title: parsed.title,
    ...(whole ? { whole } : {}),
    ...(parsed.reused?.length ? { reused: parsed.reused } : {}),
    ...(parsed.skipped?.length ? { skipped: parsed.skipped } : {}),
    ...(parsed.style ? { style: parsed.style } : {}),
    ...(finished.length > 0 ? { finished } : {}),
    ...(parsed.cardScript ? { cardScript: parsed.cardScript } : {}),
  };
}
