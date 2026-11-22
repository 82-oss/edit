// Work that used to keep the server's one thread while a program ran (Nov 21: motion review's FFmpeg and plan, pmset,
// the watcher's request and its contact sheets, the Chromes' `ps`): each runs here against a stand-in program that
// takes 1.5 s, while a timer on the event loop beats every 50 ms. Held, the longest gap between beats is the whole
// 1.5 s; free, it's a beat or two. The bar (750 ms) is more than ten beats and half the stand-in's time, so a slow CI
// Mac passes and the synchronous code doesn't.

import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import * as aiClaude from "../src/ai_claude.ts";
import * as devtools from "../src/chrome_devtools.ts";
import * as ahead from "../src/export_ahead.ts";
import { forgetPlans } from "../src/exports.ts";
import { handlerFor } from "../src/mcp/registry.ts";
import "../src/motion_review.ts";
import * as playing from "../src/playing.ts";
import * as thumbnails from "../src/thumbnails/render.ts";
import * as tools from "../src/tools.ts";
import * as claude from "../src/writer/claude.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

const SLOW = 1.5;
const HELD_MS = 750;

const bin = fs.mkdtempSync(join(os.tmpdir(), "thread-free-"));
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

/** A stand-in program in `bin`: `body` after the shell line. */
function program(name: string, body: string): string {
  const path = join(bin, name);
  fs.writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

/** `work` run while the event loop beats every 50 ms: the longest gap between beats, how long it took, and its outcome. */
async function beating<T>(work: () => Promise<T>): Promise<{ gap: number; ms: number; value: T | undefined; error: Error | undefined }> {
  let last = performance.now();
  let gap = 0;
  const beat = (): void => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  };
  const timer = setInterval(beat, 50);
  const started = performance.now();
  let value: T | undefined;
  let error: Error | undefined;
  try {
    value = await work();
  } catch (thrown) {
    error = thrown as Error;
  }
  const ms = performance.now() - started;
  beat();
  clearInterval(timer);
  return { gap, ms, value, error };
}

/** FFmpeg's stand-in: 1.5 s, then a picture where its last argument (`…-%02d.jpg`) says the first goes. */
const SLOW_FFMPEG = `sleep ${SLOW}\nfor a; do last="$a"; done\nprintf x > "$(printf "$last" 1)"`;

function withFfmpeg<T>(path: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.EDIT_FFMPEG;
  process.env.EDIT_FFMPEG = path;
  tools.forget();
  return work().finally(() => {
    if (before === undefined) delete process.env.EDIT_FFMPEG;
    else process.env.EDIT_FFMPEG = before;
    tools.forget();
  });
}

test("review_motion: the sample's frames are cut off the thread, its plan is the one kept for the revision, and a question already answered is answered while an export runs", async () => {
  const fixture = fixtureHome("motion-thread");
  const { app, store, native, home } = fixture;
  forgetPlans();
  let exporting = false;
  (app as unknown as { exports: unknown }).exports = { running: () => exporting };
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => ({
    cancel: () => {},
    wait: async () => {
      fs.writeFileSync(job.output, "sample");
      return { seconds: 1, bytes: 6 };
    },
  }));
  const ask = spyOn(claude, "askPatiently").mockResolvedValue({ text: "", structured: { summary: "Smooth; sound wasn't checked.", issues: [] } } as unknown as claude.Answer);
  try {
    const id = store.create("Cops", { width: 64, height: 36, fps: 30 }).project.id;
    fs.writeFileSync(`${home}/shot.mp4`, "footage");
    await store.update(id, "test", (p) => {
      p.media.push(media({ id: "m1", name: "shot.mp4", path: `${home}/shot.mp4`, kind: "video", duration: 10 }));
      p.clips.push(clip({ id: "shot", track: p.tracks[0]!.id, start: 0, duration: 60, type: "video", media: "m1", source_in: 0 }));
    });
    const review = async (question: string) => handlerFor("review_motion")!.handler({ app, args: { start: 0, end: 1, question }, projectId: id, scope: null });
    await withFfmpeg(program("ffmpeg", SLOW_FFMPEG), async () => {
      const first = await beating(() => review("Does the move stall?"));
      expect(first.error).toBeUndefined();
      expect(first.ms).toBeGreaterThan(SLOW * 1000 - 100);
      expect(first.gap).toBeLessThan(HELD_MS);
      expect(JSON.stringify(first.value)).toContain("Smooth");
      // Another question of the same sample: planned once for this revision, not again.
      expect((await beating(() => review("Is the text legible?"))).error).toBeUndefined();
      expect(plan).toHaveBeenCalledTimes(1);
    });
    // Answered before: at once, while an export runs, and without another look.
    exporting = true;
    const asked = ask.mock.calls.length;
    const again = await review("Does the move stall?");
    expect(JSON.stringify(again)).toContain("Smooth");
    expect(ask.mock.calls.length).toBe(asked);
    // Not answered yet: still refused while the export runs.
    expect(await review("Anything else?").then(() => "answered", (error: Error) => error.message)).toBe("an export is running; wait for it before reviewing a sample");
  } finally {
    ask.mockRestore();
    render.mockRestore();
    plan.mockRestore();
    forgetPlans();
    fixture.cleanup();
  }
});

// Nov 21 audit: a tool call carried no signal, so review_motion's sample rendered on after the agent's request went.
test("review_motion stops its sample's render when the call that asked for it goes", async () => {
  const fixture = fixtureHome("motion-cancel");
  const { app, store, native, home } = fixture;
  forgetPlans();
  (app as unknown as { exports: unknown }).exports = { running: () => false };
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  let cancelled = false;
  const render = spyOn(native.ExportJob, "start").mockImplementation(() => {
    let stop: (error: Error) => void = () => {};
    const ended = new Promise<{ seconds: number; bytes: number }>((_, reject) => (stop = reject));
    return {
      cancel: () => {
        cancelled = true;
        stop(new Error("cancelled"));
      },
      wait: () => ended,
    };
  });
  try {
    const id = store.create("Cops", { width: 64, height: 36, fps: 30 }).project.id;
    fs.writeFileSync(`${home}/shot.mp4`, "footage");
    await store.update(id, "test", (p) => {
      p.media.push(media({ id: "m1", name: "shot.mp4", path: `${home}/shot.mp4`, kind: "video", duration: 10 }));
      p.clips.push(clip({ id: "shot", track: p.tracks[0]!.id, start: 0, duration: 60, type: "video", media: "m1", source_in: 0 }));
    });
    const gone = new AbortController();
    const asked = handlerFor("review_motion")!.handler({ app, args: { start: 0, end: 1, question: "Does it stall?" }, projectId: id, scope: null, signal: gone.signal });
    const settled = Promise.resolve(asked).then(() => "answered", () => "stopped");
    for (let i = 0; i < 100 && render.mock.calls.length === 0; i++) await Bun.sleep(10);
    gone.abort();
    expect(await Promise.race([settled, Bun.sleep(2_000).then(() => "still rendering")])).toBe("stopped");
    expect(cancelled).toBe(true);
  } finally {
    render.mockRestore();
    plan.mockRestore();
    forgetPlans();
    fixture.cleanup();
  }
});

test("export ahead: pmset is asked off the thread, and one that hangs is 'can't tell' after its 2 s", async () => {
  const before = ahead.hooks.pmset;
  try {
    ahead.hooks.pmset = program("pmset", `sleep ${SLOW}\necho "Now drawing from 'Battery Power'"`);
    const slow = await beating(() => ahead.pmsetSaysBattery());
    expect(slow.value).toBe(true);
    expect(slow.ms).toBeGreaterThan(SLOW * 1000 - 100);
    expect(slow.gap).toBeLessThan(HELD_MS);
    ahead.hooks.pmset = program("pmset-hung", "sleep 30");
    const hung = await beating(() => ahead.pmsetSaysBattery());
    expect(hung.value).toBe(false);
    expect(hung.ms).toBeLessThan(10_000);
    expect(hung.gap).toBeLessThan(HELD_MS);
  } finally {
    ahead.hooks.pmset = before;
  }
});

test("export ahead: a play that goes on stops the export being made ahead; a press of Play and Pause doesn't", async () => {
  const fixture = fixtureHome("ahead-play");
  const before = { playMs: ahead.hooks.playMs, restMs: ahead.hooks.restMs };
  const stopped: string[] = [];
  let making: string | null = "p1";
  (fixture.app as unknown as { exports: unknown }).exports = {
    running: () => false,
    aheadFor: () => making,
    stopAhead: async (id?: string) => {
      stopped.push(id ?? "all");
      making = null;
    },
    startAhead: () => false,
  };
  ahead.hooks.playMs = 200;
  ahead.hooks.restMs = 3_600_000;
  playing.reset();
  const off = ahead.watchPlays(fixture.app);
  try {
    // Played for a moment, then paused: left to finish.
    playing.note("p1", true);
    await Bun.sleep(50);
    playing.note("p1", false);
    await Bun.sleep(600);
    expect(stopped).toEqual([]);
    // A play that goes on past the grace: stopped (what it made is kept), and looked at again after a rest.
    playing.note("p1", true);
    await Bun.sleep(100);
    expect(stopped).toEqual([]);
    await Bun.sleep(700);
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    expect(stopped[0]).toBe("p1");
    // Nothing being made ahead: a play stops nothing.
    playing.note("p1", false);
    stopped.length = 0;
    playing.note("p1", true);
    await Bun.sleep(600);
    expect(stopped).toEqual([]);
  } finally {
    off();
    playing.reset();
    ahead.hooks.playMs = before.playMs;
    ahead.hooks.restMs = before.restMs;
    fixture.cleanup();
  }
});

test("the watcher's request to Claude: its video read, written and cut into contact sheets off the thread, the sheets named in the prompt", async () => {
  const folder = fs.mkdtempSync(join(bin, "request-"));
  const body = join(folder, "request.json");
  fs.writeFileSync(body, JSON.stringify({
    messages: [
      { role: "system", content: "Watch." },
      { role: "user", content: [{ type: "text", text: "Who speaks?" }, { type: "file", file: { filename: "window.mp4", file_data: `data:video/mp4;base64,${Buffer.from("not really a video").toString("base64")}` } }] },
    ],
  }));
  const stand = aiClaude.standIn.post;
  aiClaude.standIn.post = null;
  const ask = spyOn(claude, "askPatiently").mockResolvedValue({ text: "answered", structured: null } as unknown as claude.Answer);
  try {
    await withFfmpeg(program("ffmpeg-sheets", SLOW_FFMPEG), async () => {
      const run = await beating(() => aiClaude.post(body));
      expect(run.error).toBeUndefined();
      expect(run.value).toEqual({ choices: [{ message: { content: "answered" } }] });
      expect(run.ms).toBeGreaterThan(SLOW * 1000 - 100);
      expect(run.gap).toBeLessThan(HELD_MS);
      const prompt = (ask.mock.calls[0]![0] as { prompt: string }).prompt;
      expect(prompt).toContain("Who speaks?");
      expect(prompt).toMatch(/Sheet 1 \(.*sheets-0-01\.jpg\): seconds 0 to 11/);
    });
    // FFmpeg failing is the same words as before.
    await withFfmpeg(program("ffmpeg-fails", "echo broken >&2\nexit 1"), async () => {
      expect(await aiClaude.post(body).then(() => "answered", (error: Error) => error.message)).toBe("the video's frames couldn't be taken");
    });
  } finally {
    ask.mockRestore();
    aiClaude.standIn.post = stand;
  }
});

test("a Chrome's start and the thumbnails' Chrome list the processes left running off the thread", async () => {
  const home = fs.mkdtempSync(join(bin, "home-"));
  // A stand-in headless shell: it says its DevTools port is 1 (nothing answers there), so its start fails at once.
  const shell = join(home, "bin", "chrome-headless-shell", "1.0.0", `chrome-headless-shell-${devtools.SHELL_PLATFORM}`, "chrome-headless-shell");
  fs.mkdirSync(join(shell, ".."), { recursive: true });
  fs.writeFileSync(shell, `#!/bin/sh\nfor a; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}";; esac; done\nprintf '1\\n' > "$d/DevToolsActivePort"\n`, { mode: 0o755 });
  const wanted = devtools.shellHooks.wanted;
  const ps = devtools.psHooks.program;
  devtools.shellHooks.wanted = true;
  devtools.findShell(home);
  devtools.psHooks.program = program("ps", `sleep ${SLOW}`);
  try {
    expect(devtools.headlessBinary()).toBe(shell);
    const opened = await beating(() => devtools.open({ profile: `edit-thread-free-${process.pid}-`, width: 64, height: 36, what: "Looking at a stand-in" }));
    expect(opened.error).toBeDefined();
    // Both of its lists (orphans, then the profiles no Chrome uses) waited for.
    expect(opened.ms).toBeGreaterThan(2 * SLOW * 1000 - 200);
    expect(opened.gap).toBeLessThan(HELD_MS);
    const drawn = await beating(() => thumbnails.graphic("http://127.0.0.1:1", "<div></div>", 64, 36));
    expect(drawn.error).toBeDefined();
    expect(drawn.gap).toBeLessThan(HELD_MS);
  } finally {
    devtools.psHooks.program = ps;
    devtools.shellHooks.wanted = wanted;
    devtools.findShell(join(home, "none"));
  }
});
