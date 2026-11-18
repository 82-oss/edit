// writer/finder.ts: Script mode's agent finds more of a case's footage on
// YouTube when asked (Sphe, Nov 18): the searches planned, the results ranked
// and filtered, each likely video checked by its captions, the clearly right
// ones added (at most 8 an ask unless more are asked for), never what the
// case has already, and the chat told what came in with its moment and the
// maybes left out. YouTube, its captions, Claude and the adding stand in.

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { Part, Script } from "@edit/types/writer";

import * as chat from "../../src/writer/chat.ts";
import * as finder from "../../src/writer/finder.ts";
import type { Candidate, Hit, Reading } from "../../src/writer/finder.ts";
import type * as claude from "../../src/writer/claude.ts";
import * as jobs from "../../src/writer/jobs.ts";
import * as store from "../../src/writer/store.ts";
import { fixtureHome } from "../helpers/home.ts";

const ID = "7a1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4b";
const MIN = 60_000;
const hit = (id: string, title: string, durationMs = 20 * MIN, extra: Partial<Hit> = {}): Hit => ({ id: id.padEnd(11, "x"), title, channel: "Court TV", durationMs, ...extra });
const vid = (id: string) => id.padEnd(11, "x");

const real = { ...finder.hooks };
beforeEach(() => {
  finder.resetForTests();
  jobs.resetForTests();
});
afterEach(() => {
  Object.assign(finder.hooks, real);
});

test("a message is read for an ask for footage only when it may be one", () => {
  expect(finder.mayAsk("Could you research and find more footage for this case? More courtroom footage, more bodycam footage on YouTube.")).toBe(true);
  expect(finder.mayAsk("get the sentencing video")).toBe(true);
  expect(finder.mayAsk("look for the 911 call")).toBe(true);
  expect(finder.mayAsk("tighten the pacing in the intro")).toBe(false);
  expect(finder.mayAsk("fix the spelling of Esparza")).toBe(false);
});

test("results are ranked by how high and how often the searches found them and the case's names, with what's in, live, Shorts and the far too long left out", () => {
  const already = new Set([`youtube:${vid("have")}`]);
  const ranked = finder.rank(
    [
      [hit("have", "Esparza bodycam"), hit("other", "Some other arrest"), hit("named", "Esparza trial day 3"), hit("short", "Esparza #shorts", 40_000)],
      [hit("named", "Esparza trial day 3"), hit("live", "Esparza trial LIVE", 3 * 3_600_000, { live: "live" }), hit("long", "Esparza family vlog", 4 * 3_600_000)],
      [hit("day", "Esparza Trial Day 1 full", 6 * 3_600_000), hit("many", "Top 10 craziest Esparza moments"), hit("huge", "Esparza trial", 11 * 3_600_000)],
    ],
    already,
    ["Marco Esparza", "Fresno"],
  );
  const ids = ranked.map((one) => one.id);
  // In already, live, a Short, over three hours without being a court day, and over ten hours: never read.
  for (const gone of ["have", "live", "short", "long", "huge"]) expect(ids).not.toContain(vid(gone));
  // Found by two searches and named: first. A whole trial day is kept however long. A many-case title comes last.
  expect(ids[0]).toBe(vid("named"));
  expect(ranked[0]!.searches).toBe(2);
  expect(ids).toContain(vid("day"));
  expect(ids.at(-1)).toBe(vid("many"));
});

const candidate = (id: string, title: string, durationMs = 20 * MIN): Candidate => ({ ...hit(id, title, durationMs), score: 1, searches: 1 });
const reading = (id: string, verdict: Reading["verdict"], label: string, sameAs = ""): Reading => ({ id: vid(id), verdict, label, why: `${label} of the case`, moments: [{ fromMs: 60_000, toMs: 120_000, what: "on the stand" }], sameAs });

test("the clearly right ones are added up to the cap, a repeat of what's in or of one chosen is skipped, and the rest are maybes", () => {
  const candidates = [candidate("a", "Trial day 3"), candidate("b", "Trial Day 3!"), candidate("c", "Bodycam arrest"), candidate("d", "Sentencing"), candidate("e", "Interrogation"), candidate("f", "Lookalike"), candidate("g", "Unsure")];
  const readings = new Map([
    [vid("a"), reading("a", "add", "Trial day 3")],
    // The same title uploaded twice.
    [vid("b"), reading("b", "add", "Trial day 3")],
    // The case's own bodycam, already Recording 1.
    [vid("c"), reading("c", "add", "Bodycam", "Bodycam 1")],
    [vid("d"), reading("d", "add", "Sentencing")],
    [vid("e"), reading("e", "add", "Interrogation")],
    [vid("f"), reading("f", "skip", "")],
    [vid("g"), reading("g", "maybe", "News")],
  ]);
  const picked = finder.choose(candidates, readings, 2);
  expect(picked.add.map(([one]) => one.id)).toEqual([vid("a"), vid("d")]);
  // Past the cap, and not sure.
  expect(picked.maybe.map(([one]) => one.id)).toEqual([vid("e"), vid("g")]);
  expect(picked.maybe[0]![1].why).toContain("past this ask's 2");
  expect(picked.skipped).toBe(3);
});

test("a whole trial day's captions are cut to fit, still spread over the whole video", () => {
  const lines = Array.from({ length: 20_000 }, (_, at) => ({ ms: at * 1_000, text: "word ".repeat(30).trim() }));
  const text = finder.fitted(lines, 100_000);
  expect(text.length).toBeLessThanOrEqual(110_000);
  expect(text).toContain("[0:00]");
  expect(text.split("\n").at(-1)!.startsWith("[5:")).toBe(true);
});

/** A script with one recording (its own bodycam) and the case already built or not. */
function aScript(fx: ReturnType<typeof fixtureHome>, built: boolean): { data: string; dir: string } {
  const data = store.dataDir(fx.app.store.home);
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, {
    id: ID, title: "Marco Esparza", sourceKind: "youtube", sourceUrl: `https://www.youtube.com/watch?v=${vid("have")}`, originalPath: "", parts: [{ title: "Bodycam 1", startMs: 0, durationMs: 10 * MIN, audio: false, url: `https://www.youtube.com/watch?v=${vid("have")}` }],
    status: "ready", stage: "", progress: 100, error: null, durationMs: 10 * MIN, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null,
    speakers: {}, words: [], clips: built ? [{ id: "c0", kind: "cut-in", startMs: 0, endMs: 0, narration: "It began." }] : [],
  } as unknown as Script);
  return { data, dir };
}

const answer = (structured: Record<string, unknown>, costUsd = 0.01): claude.Answer => ({ structured, text: null, session: null, costUsd, result: {}, replies: 1, biggestReply: 0 });

/** Stand-ins: the plan, a search a query, captions (none for `quiet`), each video's reading, and the adding. */
function standIn(plan: Record<string, unknown>, verdicts: Record<string, Reading["verdict"]>, quiet: string[] = []) {
  const asked: claude.Question[] = [];
  const searched: string[] = [];
  const adds: { url: string; title: string; ms: number }[][] = [];
  const pool = Object.keys(verdicts).map((id, at) => hit(id, `Esparza ${id} ${at}`, (20 + at) * MIN));
  finder.hooks.search = async (_app, query) => {
    searched.push(query);
    return [hit("have", "Esparza bodycam"), ...pool];
  };
  finder.hooks.captions = async (_app, id) => {
    if (quiet.includes(id)) throw new Error("It has no English captions.");
    return [{ ms: 0, text: "Marco Esparza is on the stand" }, { ms: 75_000, text: "and he says" }];
  };
  finder.hooks.ask = async (question) => {
    asked.push(question);
    if (question.label.includes("planning")) return answer(plan, 0.05);
    const id = Object.keys(verdicts).find((one) => question.prompt.includes(vid(one)) || question.prompt.includes(`Esparza ${one} `))!;
    return answer({ verdict: verdicts[id], label: `Trial ${id}`, why: "Esparza's own trial.", sameAs: "", moments: [{ from: "1:12", to: "1:31", what: `${id} on the stand` }] });
  };
  finder.hooks.add = async (_app, dir, videos) => {
    adds.push(videos);
    const now = store.read(dir);
    const out = new Map<string, { number: number; part: Part }>();
    for (const one of videos) {
      const part: Part = { title: one.title, startMs: now.durationMs, durationMs: one.ms, audio: false, url: one.url };
      now.parts = [...(now.parts ?? []), part];
      now.durationMs += one.ms;
      out.set(one.url, { number: now.parts.length, part });
    }
    store.write(dir, now);
    return out;
  };
  return { asked, searched, adds };
}

const jobOf = (stages: string[] = [], kept?: Record<string, unknown>, keep?: (what: Record<string, unknown>) => void) => ({ id: ID, signal: new AbortController().signal, stage: (text: string) => void stages.push(text), ...(kept ? { kept, resumed: true } : {}), ...(keep ? { keep } : {}) });
const NO_FOCUS = { selected: [], picked: null, playheadMs: null };
const REQUEST = "Could you research and find more footage for this case? More courtroom footage, more bodycam footage on YouTube.";

test("an ask finds, checks and adds the clearly right videos, at most 8, and says each with its moment, the hours, and the maybes", async () => {
  const fx = fixtureHome("writer-finder");
  try {
    const { data, dir } = aScript(fx, true);
    const verdicts: Record<string, Reading["verdict"]> = Object.fromEntries([..."abcdefghij"].map((id) => [id, "add" as const]));
    verdicts.k = "skip";
    verdicts.m = "maybe";
    // Clearly right by its title, but YouTube has no captions for it to be checked by.
    verdicts.n = "add";
    const seen = standIn({ find: true, count: 8, queries: ["Marco Esparza trial", "Marco Esparza bodycam", "marco esparza TRIAL"], looking: "court and bodycam", place: false }, verdicts, [vid("n")]);
    const stages: string[] = [];
    let kept: Record<string, unknown> = {};
    const [said, cost] = await finder.findFootage(fx.app, data, ID, { request: REQUEST, focus: NO_FOCUS }, jobOf(stages, undefined, (what) => (kept = what)));
    // Two searches: the third was the first again.
    expect(seen.searched).toEqual(["Marco Esparza trial", "Marco Esparza bodycam"]);
    // The case's own bodycam (Recording 1) is never read or added; ten were clearly right, eight came in.
    expect(seen.asked.some((one) => one.prompt.includes(`Video: "Esparza bodycam"`))).toBe(false);
    expect(seen.adds).toHaveLength(1);
    expect(seen.adds[0]).toHaveLength(8);
    expect(seen.adds[0]!.every((one) => one.url.startsWith("https://www.youtube.com/watch?v=") && one.ms >= 20 * MIN)).toBe(true);
    expect(store.read(dir).parts).toHaveLength(9);
    // The chat: each with its recording and moment, the hours to hear, and the maybes (past the cap, unsure, no captions).
    expect(said).toContain("Added 8 videos to the footage (");
    expect(said).toContain("hours for Scribe to hear):");
    expect(said).toMatch(/- Recording 2: Trial \w — \w on the stand, 1:12–1:31 \(Court TV, \d+:\d\d\)\. Esparza's own trial\./u);
    expect(said).toContain("Maybes I didn't add:");
    expect(said).toContain("past this ask's 8");
    expect(said).toContain("no captions to check it by");
    expect(said).toContain("From 2 YouTube searches");
    expect(chat.read(dir).map((turn) => [turn.role, turn.text])).toEqual([["producer", REQUEST], ["editor", said]]);
    expect(cost).toBeGreaterThan(0.05);
    expect(stages[0]).toBe("Reading the ask");
    expect(stages.some((one) => one.startsWith("Searching YouTube"))).toBe(true);

    // Cut off by a restart after choosing: carried on, it adds what it chose without searching again.
    seen.searched.length = 0;
    seen.asked.length = 0;
    fs.writeFileSync(`${dir}/chat.json`, JSON.stringify(chat.read(dir).slice(0, 1)));
    await finder.findFootage(fx.app, data, ID, { request: REQUEST, focus: NO_FOCUS }, jobOf([], kept));
    expect(seen.searched).toEqual([]);
    expect(seen.asked).toEqual([]);
    expect(seen.adds).toHaveLength(2);
    expect(chat.read(dir).filter((turn) => turn.role === "producer")).toHaveLength(1);
  } finally {
    fx.cleanup();
  }
});

test("more than 8 when the producer asks for more, and nothing claimed when nothing's sure", async () => {
  const fx = fixtureHome("writer-finder-count");
  try {
    const { data, dir } = aScript(fx, true);
    const verdicts = Object.fromEntries([..."abcdefghijkl"].map((id) => [id, "add" as const]));
    const seen = standIn({ find: true, count: 12, queries: ["Esparza sentencing"], looking: "sentencing", place: false }, verdicts);
    await finder.findFootage(fx.app, data, ID, { request: "find 12 more videos of the trial", focus: NO_FOCUS }, jobOf());
    expect(seen.adds[0]).toHaveLength(12);

    standIn({ find: true, count: 8, queries: ["Esparza 911 call"], looking: "the 911 call", place: false }, { x: "maybe", y: "skip" });
    const [said] = await finder.findFootage(fx.app, data, ID, { request: "find the 911 call", focus: NO_FOCUS }, jobOf());
    expect(said).toStartWith("I didn't find a video I'm sure is this case's own footage, so nothing was added.");
    expect(store.read(dir).parts).toHaveLength(13);
  } finally {
    fx.cleanup();
  }
});

test("a message that isn't an ask for footage goes on as the revision or first build it was", async () => {
  const fx = fixtureHome("writer-finder-not");
  try {
    const { data } = aScript(fx, false);
    const seen = standIn({ find: false, count: 8, queries: [], looking: "", place: false }, {});
    // Not built and not a build: the revision it was handed to says so (and nothing was searched).
    await expect(finder.findFootage(fx.app, data, ID, { request: "use more of the court footage", focus: NO_FOCUS }, jobOf())).rejects.toThrow("Build the script first");
    expect(seen.searched).toEqual([]);
  } finally {
    fx.cleanup();
  }
});
