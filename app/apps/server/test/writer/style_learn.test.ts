// writer/style_learn.ts: a channel's script style learned from what a message
// brings (Sphe, Nov 24): which messages may ask for it, the references read
// from it, and a video rebuilt as the script it was made from (narration and
// clips in turn, the channel's furniture left out, measured), kept so it's
// never heard twice. YouTube, Scribe and Claude stand in.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import type * as transcribe from "../../src/transcribe.ts";
import * as learn from "../../src/writer/style_learn.ts";
import { fixtureHome } from "../helpers/home.ts";

const real = { ...learn.hooks };
afterEach(() => {
  Object.assign(learn.hooks, real);
});

test("a message may ask to learn a style when it asks for a way of writing and brings something to learn it from", () => {
  expect(learn.mayAsk("Learn the writing style from this https://youtu.be/5kFYKil24A0?si=GHgV9")).toBe(true);
  expect(learn.mayAsk("write it like Dr Insanity does https://www.youtube.com/@DrInsanity")).toBe(true);
  expect(learn.mayAsk(`Here's a Dr Insanity script, pick up the style:\n${"The detective leans in. ".repeat(80)}`)).toBe(true);
  // Footage, research or a style asked for with nothing to learn it from: not here.
  expect(learn.mayAsk("add this bodycam https://youtu.be/5kFYKil24A0")).toBe(false);
  expect(learn.mayAsk("write this one in the Dr Insanity style")).toBe(false);
  expect(learn.mayAsk("tighten the intro")).toBe(false);
});

test("a message's references: each video once, a channel, a Doc, and a long paste as a script, in order", () => {
  const pasted = "The detective leans in. ".repeat(80).trim();
  const { references, words } = learn.referencesIn(
    `Learn this style from https://youtu.be/5kFYKil24A0?si=x and https://www.youtube.com/watch?v=5kFYKil24A0, https://www.youtube.com/@DrInsanity and https://docs.google.com/document/d/abc123/edit.\n${pasted}`,
  );
  expect(references).toEqual([
    { kind: "video", id: "5kFYKil24A0" },
    { kind: "channel", url: "https://www.youtube.com/@DrInsanity" },
    { kind: "page", url: "https://docs.google.com/document/d/abc123/edit" },
    { kind: "text", text: expect.stringContaining("The detective leans in.") },
  ]);
  // The learner reads what was asked, and that a script was pasted, not the paste twice.
  expect(words).toContain("Learn this style from");
  expect(words).toContain("pasted a script");
  expect(words).not.toContain(pasted);
  // The ask after the paste, and a paste of one long paragraph.
  const lines = Array.from({ length: 30 }, (_, at) => `Line ${at}: the detective leans in and waits for him to talk.`).join("\n");
  expect(learn.split(`${lines}\nThat's a Dr Insanity script: write ours in this style.`)).toEqual(["That's a Dr Insanity script: write ours in this style.", lines]);
  expect(learn.mayAsk(`${lines}\nThat's a Dr Insanity script: write ours in this style.`)).toBe(true);
  expect(learn.mayAsk(`${lines}\nTighten the intro.`)).toBe(false);
  expect(learn.split(`Pick up the style: ${pasted}`)[1]).toContain("Pick up the style");
});

const word = (text: string, start: number, speaker: string): transcribe.Word => ({ text, start, end: start + 0.3, speaker });
const said = (text: string, start: number, speaker: string): transcribe.Word[] => text.split(" ").map((one, at) => word(one, start + at * 0.4, speaker));

test("a video's words are lines at each change of voice, pause or 45 words", () => {
  const lines = learn.linesOf([...said("He thought he was smart.", 0, "a"), ...said("Where were you?", 3, "b"), ...said("At home.", 5, "c"), ...said("Notice the pause.", 9, "a")]);
  expect(lines.map((one) => [one.n, one.voice, one.text])).toEqual([
    [1, "a", "He thought he was smart."],
    [2, "b", "Where were you?"],
    [3, "c", "At home."],
    [4, "a", "Notice the pause."],
  ]);
  expect(learn.linesOf(said(Array.from({ length: 50 }, (_, at) => `w${at}`).join(" "), 0, "a"))).toHaveLength(2);
});

const DETAILS: learn.Details = { title: "The Liar's Tell", channel: "Dr Insanity", seconds: 600, chapters: [{ at: 0, title: "Intro" }], description: "" };

test("a video is rebuilt as narration and clips in turn, its furniture left out and its pacing measured", () => {
  const lines = learn.linesOf([
    ...said("This is the moment he knew he was caught.", 0, "n"),
    ...said("Where were you that night?", 5, "d"),
    ...said("I was at home the whole time I swear.", 8, "s"),
    ...said("Notice how fast he answers.", 20, "n"),
    ...said("This video is sponsored by a VPN.", 40, "n"),
    ...said("Who else was there?", 60, "d"),
  ]);
  const marked = learn.markedOf(
    { narrator: "Dr Insanity, a calm analyst", voices: [{ voice: "d", who: "Detective" }, { voice: "s", who: "Suspect" }], narration: [{ from: 1, to: 1 }, { from: 4, to: 5 }], furniture: [{ from: 5, to: 5, what: "sponsor read" }] },
    lines.length,
  );
  const text = learn.rebuild(DETAILS, "https://youtu.be/x", lines, marked, true);
  expect(text).toContain('Dr Insanity, "The Liar\'s Tell" (10:00)');
  expect(text).toContain("[0:00] NARRATION\nThis is the moment he knew he was caught.");
  expect(text).toContain("CLIP");
  expect(text).toContain("Detective, Suspect");
  expect(text).toContain("Notice how fast he answers.");
  expect(text).not.toContain("sponsored");
  expect(text).toContain("Left out, the channel's own: sponsor read at 0:40.");
  expect(text).toContain("opens on narration, first clip at 0:05");
  expect(text).toContain("Chapters: 0:00 Intro");
  // From captions, it says so.
  expect(learn.rebuild(DETAILS, "https://youtu.be/x", lines, marked, false)).toContain("From YouTube's captions");
});

test("marks out of range are dropped, and a video with no narration isn't one to learn from", () => {
  expect(learn.markedOf({ narrator: "x", voices: [], narration: [{ from: 3, to: 99 }, { from: 9, to: 2 }], furniture: [] }, 5).narration).toEqual([{ from: 3, to: 5 }]);
  expect(() => learn.markedOf({ narrator: "x", voices: [], narration: [], furniture: [] }, 5)).toThrow("no narration");
});

test("a video is heard and marked once: the next style from it reads it back", async () => {
  const { app, cleanup } = fixtureHome("style-reference");
  try {
    let heard = 0;
    let marks = 0;
    learn.hooks.details = async () => DETAILS;
    learn.hooks.words = async () => {
      heard++;
      return [[...said("This is the moment he knew he was caught and he could not hide it anymore.", 0, "n"), ...Array.from({ length: 12 }, (_, at) => said(`Line ${at} of the interview right here.`, 10 + at * 4, at % 2 === 0 ? "d" : "s")).flat()], true];
    };
    learn.hooks.mark = async (_system, prompt) => {
      marks++;
      expect(prompt).toContain("L1 [0:00] voice n: This is the moment");
      return [{ narrator: "the host", voices: [{ voice: "d", who: "Detective" }, { voice: "s", who: "Suspect" }], narration: [{ from: 1, to: 1 }], furniture: [] }, 0.12];
    };
    const stages: string[] = [];
    const [read, cost] = await learn.readVideo(app.store.home, "5kFYKil24A0", new AbortController().signal, (text) => stages.push(text));
    expect(read.about).toBe('Dr Insanity, "The Liar\'s Tell" (10:00) https://youtu.be/5kFYKil24A0');
    expect(read.text).toContain("NARRATION");
    expect(cost).toBe(0.12);
    expect(stages.some((one) => one.includes("Telling the narrator"))).toBe(true);
    const [again, more] = await learn.readVideo(app.store.home, "5kFYKil24A0", new AbortController().signal, () => {});
    expect(again).toEqual(read);
    expect(more).toBe(0);
    expect([heard, marks]).toEqual([1, 1]);
    expect(fs.existsSync(`${app.store.home}/cache/style-references/5kFYKil24A0/reference.json`)).toBe(true);
  } finally {
    cleanup();
  }
});
