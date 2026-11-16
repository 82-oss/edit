// writer/stamp.ts: the date a camera burned into its picture, for the case opening's verified date.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script, Word } from "@edit/types/writer";

import { findAddon, useNative, wrap, type Native } from "../../src/native/index.ts";
import { createStub } from "../../src/native/stub.ts";
import { evidence } from "../../src/writer/plan.ts";
import { dateIn, spoken, stampsOf, stampText } from "../../src/writer/stamp.ts";

let before: Native | null = null;
afterEach(() => {
  useNative(before);
  before = null;
});

function script(parts?: Script["parts"]): Script {
  const words: Word[] = Array.from({ length: 10 }, (_, index) => ({ id: `w${index}`, text: `word${index}`, startMs: index * 1000, endMs: index * 1000 + 800 }));
  return { id: "s1", title: "A case", sourceKind: "drive", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 60_000, words, clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null, kind: "foia", ...(parts ? { parts } : {}) };
}

test("a date is read off a camera's overlay in the ways cameras and OCR write it, and only a real day", () => {
  // JJ's Motorola bodycam, as PaddleOCR read it off the 480p preview (a space inside the day).
  expect(dateIn("08/1 4/2025 16:13:33")).toEqual({ date: "2025-08-14", shown: "08/14/2025" });
  expect(dateIn("08/14/2025 16:16:58")!.date).toBe("2025-08-14");
  expect(dateIn("2025-08-14T16:16:58Z AXON BODY 3")!.date).toBe("2025-08-14");
  expect(dateIn("AUG 14 2025 16:16")!.date).toBe("2025-08-14");
  expect(dateIn("14 Aug 2025")!.date).toBe("2025-08-14");
  // A day before the month only when the first number can't be a month.
  expect(dateIn("14/08/2025")!.date).toBe("2025-08-14");
  expect(dateIn("03/04/2024")!.date).toBe("2024-03-04");
  // Not a date: a unit number, a time, a day that doesn't exist, one in the future, one before bodycams.
  for (const text of ["BWL7-030069", "16:13:33", "MOTOROLA SOLUTIONS", "02/30/2025", "08/14/2999", "01/01/1970"]) expect(dateIn(text)).toBeNull();
  expect(spoken("2025-08-14")).toBe("August 14, 2025");
});

test("each recording's stamp is the day most of its frames show, read near its start", async () => {
  const raw = createStub() as unknown as Record<string, unknown>;
  raw.stub = false;
  const asked: number[][] = [];
  // Recording 1 (0-40 s) on Aug 14, one frame misread; recording 2 (40-60 s) on Aug 15.
  raw.screenTextDetect = async (_source: string, _size: [number, number], indexes: number[]) => {
    asked.push(indexes);
    const line = (t: string) => [{ b: [0.7, 0, 0.84, 0.04], t }, { b: [0.03, 0.01, 0.23, 0.04], t: "MOTOROLA SOLUTIONS" }];
    return Object.fromEntries(indexes.map((index) => [index, index < 40 ? line(index === 10 ? "08/1 1/2025 16:13:43" : "08/1 4/2025 16:13:33") : line("08/15/2025 09:01:02")]));
  };
  before = useNative(wrap(raw as unknown as Native));
  const two = script([
    { title: "Body 1", startMs: 0, durationMs: 40_000, audio: true },
    { title: "Body 2", startMs: 40_000, durationMs: 20_000, audio: true },
  ]);
  const stamps = await stampsOf(two, "/footage.mp4", [854, 480]);
  expect(asked).toEqual([[2, 10, 30, 42, 50]]);
  expect(stamps).toEqual([
    { recording: 1, date: "2025-08-14", shown: "08/14/2025" },
    { recording: 2, date: "2025-08-15", shown: "08/15/2025" },
  ]);
  // The writer's evidence says each, and that it's the verified date for the case opening.
  const text = evidence(two, { articles: [], queries: [], at: 0, stamps });
  expect(text).toContain("FOOTAGE DATE STAMP");
  expect(text).toContain("Recording 1: August 14, 2025");
  expect(text).toContain("a verified date for each recording's case opening");
  // One day for all is said once; none, nothing.
  const one = stampText([{ recording: 1, date: "2025-08-14", shown: "08/14/2025" }], 1)!;
  expect(one).toContain('August 14, 2025 (the picture shows "08/14/2025")');
  expect(one).toContain('a verified date for the case opening ("On August 14, 2025, …")');
  // A compilation's parts are its videos.
  expect(stampText([{ recording: 2, date: "2025-08-14", shown: "08/14/2025" }, { recording: 3, date: "2024-01-02", shown: "01/02/2024" }], 3, "Video")).toContain("Video 3: January 2, 2024");
  expect(evidence(script(), { articles: [], queries: [], at: 0 })).not.toContain("DATE STAMP");
  // A reading that throws leaves no stamp, and never stops the build.
  raw.screenTextDetect = async () => {
    throw new Error("no picture");
  };
  useNative(wrap(raw as unknown as Native));
  expect(await stampsOf(script(), "/footage.mp4", [854, 480])).toEqual([]);
});

const ffmpeg = Bun.which("ffmpeg");
const addon = findAddon();
test.skipIf(ffmpeg === null || addon === null)("a bodycam's date overlay is read off real footage", async () => {
  before = useNative(wrap(require(addon!) as Native));
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-stamp-"));
  try {
    const font = join(import.meta.dir, "../../../../crates/edit-render/fonts/Arimo-Bold.ttf");
    const footage = join(dir, "body.mp4");
    // A Motorola-like overlay over a moving picture, at the preview's 854×480.
    const overlay = `drawtext=fontfile=${font}:text='MOTOROLA SOLUTIONS':x=20:y=6:fontsize=16:fontcolor=white,drawtext=fontfile=${font}:text='08/14/2025 16\\:13\\:33':x=600:y=6:fontsize=16:fontcolor=white`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=854x480:rate=30:duration=12", "-vf", `drawbox=x=0:y=0:w=854:h=28:color=black@0.6:t=fill,${overlay}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", footage]);
    expect(made.exitCode).toBe(0);
    const stamps = await stampsOf({ ...script(), durationMs: 12_000 }, footage, [854, 480]);
    expect(stamps.map((one) => one.date)).toEqual(["2025-08-14"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
