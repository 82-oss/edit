// One case of a finished video of ours, found in it. The team writes a reused
// case as a "(Reuse)" link in a script's narration with a comment naming the
// case ("Case 1"): the new script's narration is the transition into it, and
// only that case plays after it (Sphe, Nov 16: "something to go through the
// video and detect when case 1 starts and when case 1 ends in a very clean
// way"). Claude reads the video's words with their times and says where each
// case begins (after the old video's own transition into it: "We begin with
// the case of…", "Up next…", "Last up…") and ends (before the next one's, or
// the outro); each edge then moves to a clean cut near it: a shot change in
// the pause between words, else the quietest moment of that pause, never into
// a word. Claude's answer is kept per video, so a second reuse of it, or the
// import again, never asks again.

import * as fs from "node:fs";

import * as aiClaude from "./ai_claude.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { PEAKS_PER_SECOND } from "./media.ts";
import type { Word } from "./model.ts";
import { join } from "./paths.ts";
import { fixed, serdeParse } from "./rust.ts";
import { stableStringify } from "./stable.ts";
import * as tools from "./tools.ts";

/** A case of the video as Claude found it: seconds from its first word to its last. */
export interface Case {
  number: number;
  start: number;
  end: number;
  /** A few words naming it. */
  about: string;
  sure: boolean;
}

/** A line of the transcript shown to Claude: a sentence, or speech up to a pause or another voice. */
export interface Line {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

/** Speech stopping this long (seconds) starts a new line. */
const PAUSE = 0.8;
/** A line runs at most this many words. */
const LONGEST = 40;

/** The transcript as lines: each a sentence, or what's said up to a pause, another voice, or LONGEST words. */
export function linesOf(words: Word[]): Line[] {
  const out: Line[] = [];
  let current: Word[] = [];
  const close = () => {
    if (current.length === 0) return;
    out.push({ start: current[0]!.start, end: current.at(-1)!.end, speaker: current[0]!.speaker ?? null, text: current.map((word) => word.text.trim()).join(" ") });
    current = [];
  };
  for (const word of words) {
    const last = current.at(-1);
    if (last !== undefined && (word.start - last.end >= PAUSE || (word.speaker ?? null) !== (last.speaker ?? null) || current.length >= LONGEST)) close();
    current.push(word);
    if (/[.!?…]["'”’)\]]*$/u.test(word.text.trim())) close();
  }
  close();
  return out;
}

/** `m:ss.s` */
function stamp(seconds: number): string {
  const tenths = Math.max(Math.round(seconds * 10), 0);
  return `${Math.floor(tenths / 600)}:${fixed((tenths % 600) / 10, 1).padStart(4, "0")}`;
}

const SYSTEM = `You find where each case starts and ends in a finished true-crime compilation video of ours, from its transcript.

The video tells several cases, one after another. A narrator opens each with a transition ("We begin with the case of…", "Up next…", "Our next case…", "Last up…"): a teaser line or two that announces the case before telling it. Then the case itself plays: the narrator's setup of the facts (a date, a place, what officers were called for), the footage's own voices, and narration cut in between. After the last case comes an outro (thanks for watching, subscribe, other videos). The video may open on a hook or intro before the first case's transition.

For each case, in order, give:
- first_line: the case's first line, just after its transition. The transition is never part of the case (it's replaced by a new one); the case's own setup narration is.
- last_line: the case's last line, just before the next case's transition, or before the outro after the last case.
- about: a few words naming the case.
- sure: false when the transcript leaves either edge unclear.

Number the cases from 1 in the order they play. A hook or intro before the first transition, the transitions and the outro belong to no case.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cases"],
  properties: {
    cases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "first_line", "last_line", "about", "sure"],
        properties: { number: { type: "integer" }, first_line: { type: "integer" }, last_line: { type: "integer" }, about: { type: "string" }, sure: { type: "boolean" } },
      },
    },
  },
};

/** Asks Claude the question (system, user text, schema) and returns its JSON answer. */
export type Ask = (system: string, prompt: string, schema: Record<string, unknown>) => Promise<unknown>;

/** How long Claude may take over one video's cases. */
const ASK_MS = 5 * 60_000;

/** Claude Opus, through Edit's small-question path (ai_claude.ts). */
const askClaude =
  (home: string): Ask =>
  async (system, prompt, schema) => {
    const dir = join(home, "reuse-cases");
    fs.mkdirSync(dir, { recursive: true });
    const scratch = join(dir, `.request-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(scratch, stableStringify({ messages: [{ role: "system", content: system }, { role: "user", content: prompt }], response_format: { type: "json_schema", json_schema: { name: "cases", strict: true, schema } }, reasoning: { effort: "medium" } }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        aiClaude.post(scratch, undefined, "Claude opus finding a reused video's cases"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Claude took too long")), ASK_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      const content = (response as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
      return typeof content === "string" ? serdeParse(content.replace(/^```(json)?|```$/g, "").trim()) : null;
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  };

/** Claude's answer read against the lines it was shown: the cases in order, each inside the video, or why it doesn't hold. */
export function readAnswer(answer: unknown, lines: Line[]): Case[] | string {
  const given = (answer as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(given)) return "the answer has no cases";
  const out: Case[] = [];
  for (const one of given as Record<string, unknown>[]) {
    const [number, first, last] = [one?.number, one?.first_line, one?.last_line];
    if (!Number.isInteger(number) || !Number.isInteger(first) || !Number.isInteger(last)) return "a case's lines aren't numbers";
    const [from, to] = [lines[first as number], lines[last as number]];
    if (from === undefined || to === undefined) return `case ${number as number}'s lines aren't in the transcript`;
    if ((first as number) > (last as number) || from.start >= to.end) return `case ${number as number} ends before it starts`;
    const previous = out.at(-1);
    if (previous !== undefined && ((number as number) !== previous.number + 1 || from.start < previous.end)) return "the cases aren't in order";
    if (previous === undefined && number !== 1) return "the cases don't start at 1";
    out.push({ number: number as number, start: from.start, end: to.end, about: typeof one.about === "string" ? one.about : "", sure: one.sure !== false });
  }
  return out;
}

/** Where a video's cases are kept (by its file: `youtube:<id>`, a Drive id, `sha256:<hash>`). */
const keptAt = (home: string, file: string) => join(home, "reuse-cases", `${file.replace(/[^\w.-]/gu, "_")}.json`);

function kept(home: string, file: string): Case[] | null {
  try {
    const value = JSON.parse(fs.readFileSync(keptAt(home, file), "utf8")) as { version?: unknown; cases?: unknown };
    return value.version === 1 && Array.isArray(value.cases) ? (value.cases as Case[]) : null;
  } catch {
    return null;
  }
}

/** Asks under way, by file: two reuses of one video ask once. */
const asking = new Map<string, Promise<Case[]>>();

/** A video's cases: kept, else asked of Claude from its words (and kept; a failure is asked again next time). */
export async function casesOf(home: string, file: string, words: Word[], length: number, ask: Ask = askClaude(home)): Promise<Case[]> {
  const known = kept(home, file);
  if (known !== null) return known;
  let running = asking.get(file);
  if (running === undefined) {
    running = (async () => {
      const lines = linesOf(words);
      const prompt = `The video runs ${stamp(length)}. Its transcript, one line per sentence or stretch of speech, as <line> [<time>] <voice>: <words>:\n\n${lines.map((line, index) => `${index} [${stamp(line.start)}] ${line.speaker ?? "?"}: ${line.text}`).join("\n")}`;
      const cases = readAnswer(await ask(SYSTEM, prompt, SCHEMA), lines);
      if (typeof cases === "string") throw new Error(cases);
      fs.mkdirSync(join(home, "reuse-cases"), { recursive: true });
      writeAtomic(keptAt(home, file), JSON.stringify({ version: 1, cases }, null, 1));
      diag.info("script", `${file}: ${cases.length} cases found (${cases.map((one) => `${one.number} ${stamp(one.start)}-${stamp(one.end)}${one.sure ? "" : " unsure"}`).join(", ")})`);
      return cases;
    })().finally(() => asking.delete(file));
    asking.set(file, running);
  }
  return running;
}

/**
 * How far (seconds) an edge may move from the case's first or last word to
 * land on a clean cut: a shot change, else the pause's quietest moment. It
 * never moves into a word: the start stays after the word before the case,
 * the end before the word after it.
 */
export const NEAR = 2;
/** Air kept before a case's first word and after its last when the cut is a pause's. */
const BREATH = 0.12;
/** How far into a pause from its word the quiet cut is looked for. */
const QUIET = 0.4;

/** The quietest moment in `from`–`to` (seconds) of `peaks`, nearest `near` among equals; null without peaks there. */
function quietest(peaks: Uint8Array | null, from: number, to: number, near: number): number | null {
  if (peaks === null || peaks.length === 0 || to < from) return null;
  const first = Math.max(Math.ceil(from * PEAKS_PER_SECOND), 0);
  const last = Math.min(Math.floor(to * PEAKS_PER_SECOND), peaks.length - 1);
  let best: [level: number, at: number] | null = null;
  for (let index = first; index <= last; index++) {
    const level = peaks[index]!;
    const at = index / PEAKS_PER_SECOND;
    if (best === null || level < best[0] || (level === best[0] && Math.abs(at - near) < Math.abs(best[1] - near))) best = [level, at];
  }
  return best === null ? null : best[1];
}

/** Shot changes (seconds) between two times: the scan a window around an edge gets. */
export type Shots = (from: number, to: number) => Promise<number[]>;

/** Where a case cleanly starts and ends: its first and last words found in `words`, each edge snapped. */
export async function snap(found: Case, words: Word[], peaks: Uint8Array | null, length: number, shots: Shots): Promise<[number, number]> {
  const first = words.findIndex((word) => word.start >= found.start - 0.01);
  let last = -1;
  for (let index = words.length - 1; index >= 0; index--) {
    if (words[index]!.end <= found.end + 0.01) {
      last = index;
      break;
    }
  }
  if (first < 0 || last < first) return [found.start, found.end];
  // The start: in the pause between the transition's last word and the case's first.
  const begins = words[first]!.start;
  const before = first > 0 ? words[first - 1]!.end : 0;
  let start = begins;
  if (before < begins) {
    const lo = Math.max(before, begins - NEAR);
    const shot = (await shots(lo, begins)).filter((at) => at >= lo && at <= begins).at(-1);
    start = shot ?? quietest(peaks, Math.max(lo, begins - QUIET), begins, begins - BREATH) ?? Math.max(lo, begins - BREATH);
  }
  // The end: in the pause between the case's last word and the next.
  const ends = words[last]!.end;
  const after = last + 1 < words.length ? words[last + 1]!.start : length;
  let end = ends;
  if (after > ends) {
    const hi = Math.min(after, ends + NEAR);
    const shot = (await shots(ends, hi)).find((at) => at >= ends && at <= hi);
    end = shot ?? quietest(peaks, ends, Math.min(hi, ends + QUIET), ends + BREATH) ?? Math.min(hi, ends + BREATH);
  }
  return [Math.max(start, 0), Math.min(end, length)];
}

/** What a scene change scores (FFmpeg's `scene`, 0–1) to count as a shot change: as B-roll's exact cuts (broll.ts). */
const SCENE = 0.25;

/** The shot changes in `from`–`to` (seconds) of `source`, to the frame; none when FFmpeg couldn't look. */
export async function shotChanges(source: string, from: number, to: number): Promise<number[]> {
  const start = Math.max(from - 0.1, 0);
  const remote = tools.isUrl(source) ? ["-protocol_whitelist", tools.protocols(source), ...tools.urlArgs(source)] : [];
  const command = [tools.ffmpeg(), "-hide_banner", "-loglevel", "info", ...remote, "-ss", fixed(start, 3), "-t", fixed(to - start + 0.1, 3), "-i", source, "-an", "-vf", `scale=160:-2,select='gte(scene,${SCENE})',metadata=print`, "-f", "null", "-"];
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 30_000);
    const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
    return [...stderr.matchAll(/pts_time:([\d.]+)/gu)].map((match) => start + Number(match[1]));
  } catch (error) {
    diag.warn("script", `shot changes in ${source}: ${diag.messageOf(error)}`);
    return [];
  }
}

/** What the finder needs of the downloaded video. */
export interface Video {
  home: string;
  /** The script block's file (`youtube:<id>`…): what the answer is kept by. */
  file: string;
  /** Its name, for a problem. */
  name: string;
  words: Word[] | null;
  peaks: Uint8Array | null;
  length: number;
  shots: Shots;
  ask?: Ask;
}

/** Where case `number` plays in the video (seconds), or why it wasn't found, said plainly (the whole video plays instead). */
export async function findCase(video: Video, number: number): Promise<{ span: [number, number]; about: string } | { problem: string }> {
  const missed = (why: string) => ({ problem: `Case ${number} of “${video.name}” wasn't found: ${why}. The whole video plays there; trim it to the case on the timeline.` });
  if (video.words === null || video.words.length === 0) return missed("its words couldn't be heard");
  let cases: Case[];
  try {
    cases = await casesOf(video.home, video.file, video.words, video.length, video.ask);
  } catch (error) {
    diag.warn("script", `${video.file}: finding its cases: ${diag.messageOf(error)}`);
    return missed("its cases couldn't be read from it");
  }
  const found = cases.find((one) => one.number === number);
  if (found === undefined) return missed(cases.length === 0 ? "no cases were found in it" : `it has ${cases.length === 1 ? "1 case" : `${cases.length} cases`}`);
  if (!found.sure) return missed("where it starts and ends isn't clear");
  const span = await snap(found, video.words, video.peaks, video.length, video.shots);
  return { span, about: found.about };
}
