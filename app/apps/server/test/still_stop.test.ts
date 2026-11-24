// found.ts `stillClean` and a Stop: a stretch waiting for its turn at the still clean (an 8 GB Mac has one) that
// the person stopped meanwhile is never started (Nov 24, the M1 Air: two of Trooper's stopped stretches still took
// the Mac's only still-clean turn, one twice, minutes each, while the stretch wanted waited behind them).

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { App } from "../src/app.ts";
import * as found from "../src/found.ts";
import { useNative, type Native, type StillAnswer } from "../src/native/index.ts";

let previous: Native | null = null;
let dir = "";

afterEach(() => {
  useNative(previous);
  if (dir !== "") fs.rmSync(dir, { recursive: true, force: true });
});

const request = (from: number) => ({ input: "/nowhere.mp4", input_args: [], from, fps: 30, width: 1920, height: 1080, matrix: "bt709", masks: [], out: path.join(dir, `${from}.mp4`), beneath: [] });

test("a stretch stopped while it waits for the still clean is never started; one still wanted is", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-still-stop-"));
  const app = { store: { cacheDir: () => dir } } as unknown as App;
  // The finder has read the file (no boxes needed: the stand-in engine doesn't read them).
  const file = path.join(dir, "cleaned", "found", "drive-still.v1.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, fps: 30, width: 1920, height: 1080, covered: [[0, 600]], masks: [] }));

  const started: number[] = [];
  let release: () => void = () => {};
  const first = new Promise<void>((resolve) => (release = resolve));
  previous = useNative({
    stillClean: async (job: string): Promise<StillAnswer> => {
      const from = (JSON.parse(job) as { from: number }).from;
      started.push(from);
      // The video's first stretch makes its room plate; the rest of the video waits for it (found.ts `plating`).
      if (from === 10) await first;
      return { still: true, box: null };
    },
  } as unknown as Native);

  const making = found.stillClean(app, "drive:still", [], request(10));
  let wanted = true;
  const stopped = found.stillClean(app, "drive:still", [], request(20), () => wanted);
  const kept = found.stillClean(app, "drive:still", [], request(30), () => true);
  await Bun.sleep(20);
  expect(started).toEqual([10]);
  // The person's Stop, while the stretch from 20 s waits.
  wanted = false;
  release();
  expect(await making).toEqual({ ok: true, box: null, inferred: 0 });
  expect(await stopped).toBeNull();
  expect(await kept).toEqual({ ok: true, box: null, inferred: 0 });
  expect(started).toEqual([10, 30]);
});
