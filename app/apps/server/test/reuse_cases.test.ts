// A reused video's case: the Doc's "(Reuse)" link with its "Case N" comment
// (script.ts parse), and the case found in the video (reuse_cases.ts).

import { afterAll, expect, test } from "bun:test";

import type { ScriptBlock, Word } from "../src/model.ts";
import { reusedLabel, reuseCaseOf } from "../src/project.ts";
import { findCase, linesOf, type Ask, type Video } from "../src/reuse_cases.ts";
import { parse, REUSE } from "../src/script.ts";
import { compare } from "../src/script_pull.ts";
import { scratch } from "./helpers/home.ts";

const yt = (id: string) => `https://www.google.com/url?q=https://www.youtube.com/watch?v%3D${id}&amp;sa=D`;
const range = `<p><span>(</span><a href="https://www.google.com/url?q=https://youtu.be/rangeVideo1?t%3D10&amp;sa=D">0:10 - 0:20</a><span>)</span></p>`;
const comment = (n: number, text: string) => `<div><p><a href="#cmnt_ref${n}" id="cmnt${n}">[${n}]</a><span>${text}</span></p></div>`;
const ref = (n: number) => `<sup><a href="#cmnt${n}" id="cmnt_ref${n}">[${n}]</a></sup>`;
const doc = (body: string) => `<html><body>${range}${body}</body></html>`;
const kinds = (blocks: ScriptBlock[]) => blocks.map((block) => (block.kind === "footage" ? block.label : "narration"));

test("a narration's (Reuse) link with a Case comment plays that case after it, never voiced", () => {
  const blocks = parse(doc(`<p><span>Up next, officers walked into a house that hid something dark&hellip; (</span><a href="${yt("finishedAA1")}">Reuse</a>${ref(1)}<span>)</span></p>${comment(1, "Case 1")}`)).blocks;
  expect(kinds(blocks)).toEqual(["0:10 - 0:20", "narration", "Reuse (case 1)"]);
  expect(blocks[1]).toMatchObject({ kind: "narration", text: "Up next, officers walked into a house that hid something dark…", notes: [] });
  expect(blocks[2]).toMatchObject({ kind: "footage", url: "https://www.youtube.com/watch?v=finishedAA1", file: "youtube:finishedAA1", start: 0, notes: ["Case 1"] });
  expect(reuseCaseOf((blocks[2] as { label: string }).label)).toBe(1);
  expect(reusedLabel((blocks[2] as { label: string }).label)).toBe(true);
});

test("two reuses in a row, a comment on the paragraph, and none: each its own case, or the whole video", () => {
  const blocks = parse(
    doc(
      `<p><span>Up next, a call about a house that nobody had entered in years&hellip; (</span><a href="${yt("finishedAA1")}">reuse</a><span>)</span></p>` +
        `<p><span>Last up, a welfare check that turned into something far worse&hellip; </span><a href="${yt("finishedBB2")}">(REUSE)</a>${ref(2)}</p>` +
        `<p><span>And finally, one more case that we have already covered before&hellip; (</span><a href="${yt("finishedCC3")}">Reuse</a><span>)</span></p>` +
        comment(2, "case #2"),
    ),
  ).blocks;
  expect(kinds(blocks)).toEqual(["0:10 - 0:20", "narration", REUSE, "narration", "Reuse (case 2)", "narration", REUSE]);
  expect(blocks.filter((block) => block.kind === "narration").map((block) => (block as { text: string }).text)).toEqual([
    "Up next, a call about a house that nobody had entered in years…",
    "Last up, a welfare check that turned into something far worse…",
    "And finally, one more case that we have already covered before…",
  ]);
  expect((blocks[4] as { file: string }).file).toBe("youtube:finishedBB2");
});

test("two reuse links in one paragraph pair with the comment nearest each", () => {
  const blocks = parse(
    doc(
      `<p><span>Up next, two cases we covered before, one after the other in this video (</span><a href="${yt("finishedAA1")}">Reuse</a>${ref(1)}<span>) and then (</span><a href="${yt("finishedBB2")}">Reuse</a>${ref(2)}<span>).</span></p>` +
        comment(1, "Case 3") +
        comment(2, "Case 1"),
    ),
  ).blocks;
  expect(kinds(blocks)).toEqual(["0:10 - 0:20", "narration", "Reuse (case 3)", "Reuse (case 1)"]);
  expect(blocks.slice(2).map((block) => (block as { file: string }).file)).toEqual(["youtube:finishedAA1", "youtube:finishedBB2"]);
});

test("a Reuse: <link> comment still plays the whole video", () => {
  const blocks = parse(doc(`<p><span>Up next, another officer who was never meant to be there that night.</span>${ref(1)}</p>${comment(1, "Reuse: https://www.youtube.com/watch?v=finishedAA1")}`)).blocks;
  expect(kinds(blocks)).toEqual(["0:10 - 0:20", "narration", REUSE]);
  expect(blocks[2]).toMatchObject({ file: "youtube:finishedAA1", start: 0, notes: ["Reuse: https://www.youtube.com/watch?v=finishedAA1"] });
});

test("a Doc pull never takes a found case for a range the Doc changed", () => {
  const was: ScriptBlock[] = [{ kind: "footage", url: "u", file: "youtube:finishedAA1", start: 412.3, end: 1210.8, label: "Reuse (case 2)", clip: "c1" }];
  const now: ScriptBlock[] = [{ kind: "footage", url: "u", file: "youtube:finishedAA1", start: 0, end: 1, label: "Reuse (case 2)" }];
  expect(compare(was, now, "doc")).toMatchObject({ ranges: [], added: [], removed: [] });
});

// ---------------------------------------------------------------------------
// The finder, on a canned transcript and a stubbed Claude.

/** Words with times, one sentence per entry: [start, end, speaker, text]. */
function said(...lines: [number, number, string, string][]): Word[] {
  return lines.flatMap(([start, end, speaker, text]) => {
    const each = text.split(" ");
    const step = (end - start) / each.length;
    return each.map((word, index) => ({ text: word, start: start + index * step, end: start + (index + 1) * step - 0.02, speaker }));
  });
}

const WORDS = said(
  [0, 4, "narrator", "We begin with the case of a house nobody entered."], // 0: transition
  [5, 9, "narrator", "On January 23rd officers arrived at the door."], // 1: case 1 starts
  [9.5, 14, "officer", "Police department, open the door please."],
  [14.2, 18, "officer", "We are coming in now, step back."], // 3: case 1 ends
  [20, 24, "narrator", "Up next, a welfare check goes badly wrong."], // 4: transition
  [24.1, 30, "narrator", "In March deputies were sent to an apartment downtown."], // 5: case 2 starts
  [31, 36, "officer", "Sheriff's office, is anyone home in there?"], // 6: case 2 ends
  [38, 42, "narrator", "Thanks for watching, see you in the next one."], // 7: outro
);
const LENGTH = 44;
/** Peaks: loud while a word is said, quiet between, quietest at 4.6 s and 18.3 s. */
function peaks(): Uint8Array {
  const out = new Uint8Array(LENGTH * 100).fill(40);
  for (const word of WORDS) out.fill(200, Math.floor(word.start * 100), Math.ceil(word.end * 100));
  out[460] = 2;
  out[1830] = 2;
  return out;
}

const answer = { cases: [
  { number: 1, first_line: 1, last_line: 3, about: "the house", sure: true },
  { number: 2, first_line: 5, last_line: 6, about: "the apartment", sure: true },
] };

const homes: { cleanup(): void }[] = [];
afterAll(() => homes.forEach((home) => home.cleanup()));

function video(file: string, ask: Ask, shots: number[] = []): Video {
  const home = scratch("reuse-cases");
  homes.push(home);
  return { home: home.dir, file, name: "The House", words: WORDS, peaks: peaks(), length: LENGTH, shots: async (from, to) => shots.filter((at) => at >= from && at <= to), ask };
}

test("the transcript is shown a sentence a line", () => {
  expect(linesOf(WORDS).map((line) => line.text.split(" ")[0])).toEqual(["We", "On", "Police", "We", "Up", "In", "Sheriff's", "Thanks"]);
});

test("a case's edges land on a shot change in the pause, else the pause's quietest moment, never in a word", async () => {
  let asked = 0;
  let prompt = "";
  const ask: Ask = async (_, given) => {
    asked++;
    prompt = given;
    return answer;
  };
  // Shot changes: one inside the pause before case 2 (23.9 is mid-word, so not it), one after case 2's end.
  const given = video("youtube:finishedAA1", ask, [3.5, 4.4, 19.0, 23.9, 24.05, 36.6]);
  const one = await findCase(given, 1);
  // Start: the pause after "entered." (3.98) up to "On" (5): the shot at 4.4. End: after "now," … "back." (17.98): the shot at 19.0.
  expect(one).toEqual({ span: [4.4, 19.0], about: "the house" });
  const two = await findCase(given, 2);
  // Start: the pause 23.98–24.1 holds the shot at 24.05. End: after "there?" (35.98): the shot at 36.6.
  expect(two).toEqual({ span: [24.05, 36.6], about: "the apartment" });
  expect(asked).toBe(1);
  expect(prompt).toContain("1 [0:05.0] narrator: On January 23rd officers arrived at the door.");

  // No shots: the quietest moment of each pause, within reach of its word.
  const quiet = await findCase({ ...video("youtube:finishedBB2", ask), shots: async () => [] }, 1);
  expect("span" in quiet && quiet.span[0]).toBeCloseTo(4.6, 5);
  expect("span" in quiet && quiet.span[1]).toBeCloseTo(18.3, 5);
});

test("the answer is kept: the same video's other case, or the import again, never asks again", async () => {
  let asked = 0;
  const ask: Ask = async () => {
    asked++;
    return answer;
  };
  const given = video("youtube:finishedCC3", ask);
  await Promise.all([findCase(given, 1), findCase(given, 2)]);
  await findCase(given, 2);
  expect(asked).toBe(1);
});

test("a case that isn't there, or isn't clear, plays the whole video and says which", async () => {
  const missing = await findCase(video("youtube:finishedDD4", async () => answer), 3);
  expect(missing).toEqual({ problem: "Case 3 of “The House” wasn't found: it has 2 cases. The whole video plays there; trim it to the case on the timeline." });
  const unsure = await findCase(video("youtube:finishedEE5", async () => ({ cases: [{ ...answer.cases[0], sure: false }] })), 1);
  expect(unsure).toEqual({ problem: "Case 1 of “The House” wasn't found: where it starts and ends isn't clear. The whole video plays there; trim it to the case on the timeline." });
  // An answer that doesn't hold together (out of order) is never kept, and asked again next time.
  let asked = 0;
  const bad = video("youtube:finishedFF6", async () => {
    asked++;
    return asked === 1 ? { cases: [answer.cases[1], answer.cases[0]] } : answer;
  });
  expect(await findCase(bad, 1)).toEqual({ problem: "Case 1 of “The House” wasn't found: its cases couldn't be read from it. The whole video plays there; trim it to the case on the timeline." });
  expect("span" in (await findCase(bad, 1))).toBe(true);
  const unheard = await findCase({ ...video("youtube:finishedGG7", async () => answer), words: null }, 1);
  expect(unheard).toEqual({ problem: "Case 1 of “The House” wasn't found: its words couldn't be heard. The whole video plays there; trim it to the case on the timeline." });
});
