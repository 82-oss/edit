// camera_clock.ts: a time on the camera's own clock (Sphe, Nov 17: "could i
// give the agent a bodycam timestamp on the top right and tell it to cut from
// there?") as the footage's seconds, exact to the frame that second begins on:
// clocks read in their many forms, stretches split at a cut, a misread
// dropped, a time cut out said with what's near, and on real frames drawn by
// FFmpeg, the frame itself.

import { afterEach, expect, test } from "bun:test";

import * as clock from "../src/camera_clock.ts";
import type { ScreenText } from "../src/native/index.ts";
import { findAddon, native, useNative, wrap, type Native } from "../src/native/index.ts";
import { join } from "../src/paths.ts";
import * as tools from "../src/tools.ts";
import { scratch } from "./helpers/home.ts";

const hooks = { ...clock.hooks };
let before: Native | null = null;
afterEach(() => {
  Object.assign(clock.hooks, hooks);
  clock.reset();
  if (before !== null) useNative(before);
  before = null;
});

const day = (text: string) => Math.round(Date.parse(`${text}T00:00:00Z`) / 86_400_000);
const at = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;

test("a clock is read in the forms cameras show it, OCR's slips and all", () => {
  const cases: [string, number | null, number][] = [
    ["2023-05-14 T14:32:05 Z", day("2023-05-14"), at(14, 32, 5)],
    ["2023-05-14 T14:32:05Z AXON BODY 3 X81234567", day("2023-05-14"), at(14, 32, 5)],
    ["2019-03-02 T21:14:56 -0800", day("2019-03-02"), at(21, 14, 56)],
    ["05/14/2023 02:32:05 PM", day("2023-05-14"), at(14, 32, 5)],
    ["Room 1 05/04/22 12:03:42", day("2022-05-04"), at(12, 3, 42)],
    ["14 MAY 2023 14:32:05", day("2023-05-14"), at(14, 32, 5)],
    ["MAY 14, 2023 12:00:01 AM", day("2023-05-14"), at(0, 0, 1)],
    ["14.05.2023 14:32:05", day("2023-05-14"), at(14, 32, 5)],
    // Glued by the reader, and its usual slips.
    ["2019-07-3000:23:33", day("2019-07-30"), at(0, 23, 33)],
    ["2023-05-14 T14:3O:O5 Z", day("2023-05-14"), at(14, 30, 5)],
    ["14;32;05", null, at(14, 32, 5)],
    // Apple Vision's reads of a drawn Axon clock on kenobi (Nov 17): colons as ".." or "'.", T as "Ttr", the date its own box.
    ["T14..32..02", null, at(14, 32, 2)],
    ["Ttr14..32..00", null, at(14, 32, 0)],
    ["Ttr14..32..06 Z", null, at(14, 32, 6)],
    ["T14'.32.'00", null, at(14, 32, 0)],
    ["2023.05.14 T14..32..04", day("2023-05-14"), at(14, 32, 4)],
    ["12023-05-14 T14'.32.'04", day("2023-05-14"), at(14, 32, 4)],
    // CI's macOS runner (Nov 17): a dot inside the seconds, and a comma before the date.
    ["T14.'40:.1.2", null, at(14, 40, 12)],
    [",'2023-05-14 T14.'40:.10", day("2023-05-14"), at(14, 40, 10)],
    ["2:32:05 PM", null, at(14, 32, 5)],
    ["2..32..05 PM", null, at(14, 32, 5)],
  ];
  for (const [text, wantDay, second] of cases) expect(clock.parseClock(text), text).toEqual({ day: wantDay, second, seconds: true });
  // Not clocks: no seconds, out of range, words.
  for (const text of ["at 12:30 we left", "25:61:00", "AXON BODY 3 X81234567", "D:oo:os:24", "2023.05.14", "X81.234567", "05.14.2023", ""]) expect(clock.parseClock(text), text).toBeNull();
  // An asked time may stop at the minute.
  expect(clock.parseClock("2:32 PM", true)).toEqual({ day: null, second: at(14, 32, 0), seconds: false });
  expect(clock.clockText({ day: day("2023-05-14"), second: at(14, 32, 5), seconds: true })).toBe("2023-05-14 14:32:05");
  // Without a date on either side, the time of day the nearer way round midnight.
  expect(clock.between({ day: null, second: at(23, 59, 58), seconds: true }, { day: null, second: at(0, 0, 3), seconds: true })).toBe(5);
});

const FPS = 30;
const CLOCK_BOX: [number, number, number, number] = [0.8, 0.02, 0.98, 0.05];

/**
 * A 60 s bodycam compilation at 30 fps: 0–30 s from 14:32:00.41, a title card
 * 30–40 s, 40–60 s from 14:50:10.75 (all 2023-05-14), with a stopwatch of its
 * own in the top left; the frame at 13.5 s misread.
 */
function bodycam(frame: number): ScreenText[] {
  const shown = (base: number) => {
    const second = Math.floor(base);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `2023-05-14 T${pad(Math.floor(second / 3600))}:${pad(Math.floor(second / 60) % 60)}:${pad(second % 60)} Z`;
  };
  const timer: ScreenText = { t: `00:00:${String(Math.floor(frame / FPS) % 60).padStart(2, "0")}`, b: [0, 0, 0.05, 0.02] };
  if (frame === 405) return [{ t: "2023-05-14 T14:38:13 Z", b: CLOCK_BOX }, timer];
  let text: string | null = null;
  if (frame < 900) text = shown(at(14, 32, 0) + 0.41 + frame / FPS);
  else if (frame >= 1200) text = shown(at(14, 50, 10) + 0.75 + (frame - 1200) / FPS);
  if (text === null) return [{ t: "CASE 2: THE TRAFFIC STOP", b: [0.3, 0.45, 0.7, 0.55] }];
  return [{ t: text, b: CLOCK_BOX }, { t: "AXON BODY 3 X81234567", b: [0.78, 0.055, 0.98, 0.08] }, timer];
}

/** The engine stood in for: `frames` per file, read as screen_text.rs would (the frame nearest each time, the words inside the region). */
function stand(files: Record<string, (frame: number) => ScreenText[]>): { reads: number } {
  const count = { reads: 0 };
  const inside = (box: number[], region: number[]) => box[0]! >= region[0]! && box[1]! >= region[1]! && box[2]! <= region[2]! && box[3]! <= region[3]!;
  clock.hooks.readAt = async (input, _size, fps, region, times) => {
    count.reads += times.length;
    return times.map((time) => files[input]!(Math.floor(time * fps + 0.5)).filter((line) => inside(line.b, region)));
  };
  clock.hooks.detect = async (input, _size, seconds) => Object.fromEntries(seconds.map((second) => [second, files[input]!(second * FPS)]));
  clock.hooks.cached = () => null;
  return count;
}

const reader: clock.Reader = { analysisInput: async (source) => source };
const media = (id: string, path: string): clock.Footage => ({ id, name: `${id}.mp4`, path, kind: "video", duration: 60, width: 1920, height: 1080, fps: FPS });

test("a camera time is the frame its second begins on, in the stretch that holds it; a cut-out time says what's near", async () => {
  const count = stand({ "/cam.mp4": bodycam, "/map.mp4": () => [] });
  const found = await clock.find(reader, [media("m1", "/cam.mp4"), media("m2", "/map.mp4")], ["14:32:05", "2:50:20 PM", "2023-05-14 14:50:10", "14:32:35", "2023-05-15 14:32:05", "14:32"]);
  const [first, second, opening, cutOut, otherDay, minute] = found.results;
  // 14:32:05 begins 4.59 s in: frame 138 (frame 137 still shows :04), until 14:32:06 at frame 168.
  expect(first!.found).toEqual([{ media: "m1", name: "m1.mp4", at: 4.6, until: 5.6, clock: "2023-05-14 14:32:05", within: 0 }]);
  // After the title card: 14:50:20 at frame 1478.
  expect(second!.found).toEqual([{ media: "m1", name: "m1.mp4", at: 49.267, until: 50.267, clock: "2023-05-14 14:50:20", within: 0 }]);
  // A second the stretch opens inside: its first frame.
  expect(opening!.found.map((hit) => [hit.at, hit.until])).toEqual([[40, 40.267]]);
  // 14:32:35 was cut (the stretch ends at :30): not found, with the stretches either side.
  expect(cutOut!.found).toEqual([]);
  expect(cutOut!.nearest!.map((span) => [span.clock_to.slice(11), span.away])).toEqual([
    ["14:32:28", -7],
    ["14:50:29", 1055],
  ]);
  expect(otherDay!.found).toEqual([]);
  // To the minute: the frame its :00 begins on (the file's first, already showing it).
  expect(minute!.found.map((hit) => hit.at)).toEqual([0]);
  expect(minute!.note).toContain("to the minute");
  // The misread at 13.5 s split nothing; the map has no clock.
  expect(found.no_clock).toEqual(["m2.mp4"]);
  // Kept: asking again reads nothing new.
  const reads = count.reads;
  const again = await clock.find(reader, [media("m1", "/cam.mp4")], ["14:32:05"]);
  expect(again.results[0]!.found[0]!.at).toBe(4.6);
  expect(count.reads).toBe(reads);
});

test("a clock too small for the 960-wide read is found at the file's own size", async () => {
  stand({ "/cam.mp4": bodycam });
  // The finding read sees no words at all (Vision's fast level on a small stamp).
  clock.hooks.detect = async (_input, _size, seconds) => Object.fromEntries(seconds.map((second) => [second, []]));
  const found = await clock.find(reader, [media("m1", "/cam.mp4")], ["14:32:05"]);
  expect(found.no_clock).toEqual([]);
  expect(found.results[0]!.found.map((hit) => hit.at)).toEqual([4.6]);
});

test("Vision's reads, the date and the time in boxes side by side and no colons, find the same frames", async () => {
  const vision = (frame: number): ScreenText[] =>
    bodycam(frame).flatMap((line): ScreenText[] => {
      const parts = /^(\d{4})-(\d{2})-(\d{2}) T(\d{2}):(\d{2}):(\d{2}) Z$/u.exec(line.t);
      if (parts === null) return line.t.startsWith("AXON") ? [{ t: "X81.234567", b: [0.914, 0.056, 0.983, 0.074] }] : [line];
      // Seconds in the teens with a dot inside, as CI's Mac read "T14.'40:.1.2".
      const seconds = parts[6]!.startsWith("1") ? `${parts[6]![0]}.${parts[6]![1]}` : parts[6];
      const time: ScreenText = { t: `Ttr${parts[4]}..${parts[5]}..${seconds}`, b: [0.906, 0.022, 0.971, 0.041] };
      // The date box now and then not read at all.
      if (frame % 7 === 3) return [time];
      return [{ t: `${parts[1]}.${parts[2]}.${parts[3]}`, b: [0.831, 0.022, 0.902, 0.041] }, time];
    });
  stand({ "/cam.mp4": vision });
  const found = await clock.find(reader, [media("m1", "/cam.mp4")], ["2023-05-14 14:32:05", "14:50:20", "14:50:17"]);
  expect(found.results.map((result) => result.found.map((hit) => [hit.at, hit.until, hit.clock]))).toEqual([
    [[4.6, 5.6, "2023-05-14 14:32:05"]],
    [[49.267, 50.267, "2023-05-14 14:50:20"]],
    [[46.267, 47.267, "2023-05-14 14:50:17"]],
  ]);
});

test("stretches split at a jump in the clock, and a lone misread is dropped", () => {
  const read = (frame: number, second: number): clock.Read => ({ frame, clock: { day: 1, second, seconds: true }, text: "" });
  const reads = [read(0, 100), read(90, 103), read(180, 999), read(270, 109), read(360, 500), read(450, 503)];
  expect(clock.stretchesOf(reads, 30).map((stretch) => stretch.map((one) => one.frame))).toEqual([
    [0, 90, 270],
    [360, 450],
  ]);
  expect(() => clock.parseClock("nope", true)).not.toThrow();
});

test("an asked time that isn't one is refused in a line", async () => {
  stand({});
  await expect(clock.find(reader, [], ["half past two"])).rejects.toThrow('"half past two" isn\'t a time');
});

// ---------------------------------------------------------------------------
// Real frames

// Edit's own FFmpeg (a Homebrew one may have no drawtext: kenobi's 8.1.2 hasn't).
const ffmpeg = (() => {
  const path = tools.ffmpeg();
  const filters = Bun.spawnSync([path, "-hide_banner", "-filters"]);
  return filters.exitCode === 0 && filters.stdout.toString().includes(" drawtext ") ? path : null;
})();
const addon = findAddon();
test.skipIf(ffmpeg === null || addon === null)("on real frames drawn with a ticking Axon clock and a cut, the answer is the frame itself", async () => {
  before = useNative(wrap(require(addon!) as Native));
  const { dir, cleanup } = scratch("camera-clock-real");
  try {
    const font = join(import.meta.dir, "../../../crates/edit-render/fonts/Arimo-Bold.ttf");
    // Part one from 14:31:59.63 (10 s), then a cut to 14:40:10.00 (6 s); 2023-05-14, 30 fps, 1280x720.
    const part = (path: string, seconds: number, base: number) => {
      const stamp = (y: number, text: string) => `drawtext=fontfile=${font}:fontsize=18:fontcolor=white:borderw=2:bordercolor=black:x=w-tw-20:y=${y}:text='${text}'`;
      const made = Bun.spawnSync([
        ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
        "-vf", [stamp(16, `%{pts\\:gmtime\\:${base}\\:%Y-%m-%d T%H\\\\\\:%M\\\\\\:%S} Z`), stamp(40, "AXON BODY 3 X81234567")].join(","),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", path,
      ]);
      expect(made.exitCode, made.stderr.toString()).toBe(0);
    };
    const base = Date.UTC(2023, 4, 14, 14, 31, 59) / 1000;
    part(join(dir, "a.mp4"), 10, base + 0.63);
    part(join(dir, "b.mp4"), 6, Date.UTC(2023, 4, 14, 14, 40, 10) / 1000);
    const list = join(dir, "list.txt");
    await Bun.write(list, `file '${join(dir, "a.mp4")}'\nfile '${join(dir, "b.mp4")}'\n`);
    const path = join(dir, "axon.mp4");
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", path]).exitCode).toBe(0);
    expect(typeof native().screenTextAt).toBe("function");
    // What the reader saw, said with a failure (Vision on CI's Macs reads differently from PaddleOCR here).
    const seen: string[] = [];
    clock.hooks.readAt = async (input, size, fps, region, times) => {
      const lines = await hooks.readAt(input, size, fps, region, times);
      times.forEach((time, index) => seen.push(`${time.toFixed(3)} ${JSON.stringify((lines[index] ?? []).map((line) => line.t))}`));
      return lines;
    };
    const cam: clock.Footage = { id: "m1", name: "axon.mp4", path, kind: "video", duration: 16, width: 1280, height: 720, fps: 30 };
    const found = await clock.find(reader, [cam], ["14:32:05", "14:40:13", "14:40:10", "14:35:00"]);
    // 14:32:05 begins 5.37 s in (frame 162, as 161 is 5.367 s, still :04); 14:40:13 at 13 s (frame 390); 14:40:10 at the cut, 10 s.
    const said = () => [...seen].sort().join("\n");
    expect(found.results.map((result) => result.found.map((hit) => [hit.at, hit.until, hit.within])), said()).toEqual([[[5.4, 6.4, 0]], [[13, 14, 0]], [[10, 11, 0]], []]);
    expect(found.results[0]!.found[0]!.clock).toBe("2023-05-14 14:32:05");
    expect(found.results[3]!.nearest!.length).toBe(2);
  } finally {
    cleanup();
  }
}, 240_000);
