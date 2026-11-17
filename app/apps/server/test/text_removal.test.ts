// text_removal.ts and clean_strips.ts: what re-uploaders burned into footage
// (subtitles, labels) taken out of its picture by Vmake, only what it took out
// pasted back, the camera's own stamp kept as it was. The planning (handles,
// pieces of ≤300 s, cleaned pieces reused), the camera's text and its bar on
// real reads (Tulsa's Axon stamp under "Actual case footage", Nov 17; "SWAT
// Faces Off"'s Motorola bar under an "OFFICER 11" label), the strip's pixels,
// the strips laid over the footage's clips on every save, and a run with a
// stand-in provider: kept pieces never paid for twice, a failed piece left
// blurred, an account that can't be used stopping every send at once.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import * as burned from "../src/burned_subtitles.ts";
import { enforceCleanStrips, NAME, strippedFrames } from "../src/clean_strips.ts";
import type { Media, Project, VideoClip } from "../src/model.ts";
import { native, useNative, type Native, type ScreenText } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import { join } from "../src/paths.ts";
import * as tr from "../src/text_removal.ts";
import * as tools from "../src/tools.ts";
import * as removal from "../src/removal_lesson.ts";
import { EDIT_EVENT } from "../src/edit_event.ts";
import * as asks from "../src/removal_asks.ts";
import * as removalSchedule from "../src/removal_schedule.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { dispatch } from "../src/mcp/index.ts";
import * as wm from "../src/watermark_removal.ts";
import type { WatermarkRemoved } from "../src/native/index.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { classify, signOss, signSdk, VmakeError } from "../src/vmake_api.ts";
import { fixtureHome, scratch } from "./helpers/home.ts";

let before: Native | null = null;
afterEach(() => {
  if (before !== null) useNative(before);
  before = null;
  tr.useProvider(undefined);
  tr.useShelf(null);
  tr.reset();
  asks.reset();
  removalSchedule.reset();
  removalSchedule.reset();
  wm.useEngine(null);
  wm.useShelf(null);
  wm.reset();
  v2cloud.useSkillsForTests([]);
});

// ---------------------------------------------------------------------------
// Pieces

test("what's sent: their seconds on the timeline, a second's handle each side, in pieces of at most 300 s on frames, less what's kept", () => {
  // Two stretches close enough that their handles meet are one piece.
  expect(tr.piecesFor([[10, 20], [21.5, 30]], 600, 30, []).send).toEqual([[9, 31]]);
  // The file's ends hold the handles in.
  expect(tr.piecesFor([[0.2, 5]], 5.5, 30, []).send).toEqual([[0, 5.5]]);
  // A long stretch: equal pieces, none over 300 s, each starting on a frame.
  const long = tr.piecesFor([[0, 700]], 900, 29.97, []).send;
  expect(long.length).toBe(3);
  expect(long.every(([a, b]) => b - a <= tr.PIECE_SECONDS)).toBe(true);
  expect(long[0]![0]).toBe(0);
  expect(long[2]![1]).toBe(701);
  for (const [a] of long) expect(Math.abs(a * 29.97 - Math.round(a * 29.97))).toBeLessThan(0.05);
  // Kept already: used, not sent; what's left beside it is sent, at least 2 s; a sliver is the kept one's handle.
  const kept: tr.Cached = { from: 9, to: 31, provider: "vmake-api", key: "edit/cleaned/x/9000-31000.vmake-api.mp4" };
  expect(tr.piecesFor([[10, 30]], 600, 30, [kept])).toEqual({ send: [], use: [kept] });
  expect(tr.piecesFor([[10, 40]], 600, 30, [kept]).send).toEqual([[31, 41]]);
  expect(tr.piecesFor([[10, 30.8]], 600, 30, [kept]).send).toEqual([[31, 33]]);
  expect(tr.piecesFor([[10, 30.3]], 600, 30, [kept]).send).toEqual([]);
  // Another file's piece names parse back.
  expect(tr.parseName("edit/cleaned/ab/9000-31000.vmake-web.mp4")).toEqual({ from: 9, to: 31, provider: "vmake-web" });
});

test("paid by the file (the website's plan): nearby stretches go as one piece with the seconds between, as few of at most 300 s as fit, never across what's cleaned already", () => {
  // A compilation's file: 12 short stretches of their text over 20 minutes, 12 files apart; packed, 4.
  const stretches = Array.from({ length: 12 }, (_, at): [number, number] => [at * 100 + 10, at * 100 + 18]);
  expect(tr.piecesFor(stretches, 1300, 30, []).send.length).toBe(12);
  const packed = tr.piecesFor(stretches, 1300, 30, [], true).send;
  expect(packed).toEqual([[9, 219], [309, 519], [609, 819], [909, 1119]]);
  expect(packed.every(([a, b]) => b - a <= tr.PIECE_SECONDS)).toBe(true);
  // A long stretch stays in pieces of at most 300 s.
  expect(tr.piecesFor([[0, 700]], 900, 30, [], true).send.every(([a, b]) => b - a <= tr.PIECE_SECONDS)).toBe(true);
  // What another Mac cleaned already is reused, and a piece never reaches across it (it'd clean those seconds twice).
  const kept: tr.Cached = { from: 109, to: 119, provider: "vmake-web", key: "edit/cleaned/x/109000-119000.vmake-web.mp4" };
  const around = tr.piecesFor([[10, 18], [110, 118], [210, 218]], 1300, 30, [kept], true);
  expect(around).toEqual({ send: [[9, 19], [209, 219]], use: [kept] });
  // The API is paid by the second: never packed.
  expect(tr.piecesFor([[10, 18], [110, 118]], 1300, 30, []).send).toEqual([[9, 19], [109, 119]]);
});

// ---------------------------------------------------------------------------
// The camera's own text, on real reads

/** Edit's own OCR (PaddleOCR on mandalorian, Nov 17) of Tulsa's Axon footage under "Actual case footage". */
const TULSA: Record<number, ScreenText[]> = {
  2: [
    { b: [0.665, 0.013, 0.905, 0.05], t: "2025-02-07_14:28:20_-0600" },
    { b: [0.035, 0.054, 0.345, 0.124], t: "Actual case footage" },
    { b: [0.667, 0.048, 0.873, 0.074], t: "AXON B0DY 3 X60AB071C" },
    { b: [0.514, 0.663, 0.602, 0.715], t: "dose" },
    { b: [0.399, 0.743, 0.604, 0.807], t: "of.crime" },
  ],
  5: [
    { b: [0.666, 0.017, 0.904, 0.048], t: "2025-02-07_14:28:23-0600" },
    { b: [0.034, 0.05, 0.344, 0.126], t: "Actual case footage" },
    { b: [0.666, 0.046, 0.871, 0.078], t: "AXON B0DY 3 X60A8071C" },
    { b: [0.395, 0.913, 0.631, 0.963], t: "[Officer unintelligible]" },
  ],
  8: [
    { b: [0.666, 0.015, 0.904, 0.049], t: "2025-02-07 14:28:26 -0600" },
    { b: [0.035, 0.052, 0.345, 0.125], t: "Actual case footage" },
    { b: [0.667, 0.047, 0.872, 0.076], t: "AXON BODY 3 X60A8071C" },
  ],
};

/** The same of "SWAT Faces Off Against Killer 43 Years Later": Motorola's bar, a re-uploader's "OFFICER 11" over its left end. */
const MOTOROLA: ScreenText[] = [
  { b: [0.161, 0.011, 0.229, 0.043], t: "LUTIONS" },
  { b: [0.709, 0.007, 0.871, 0.039], t: "11/18/2024 12:16:31" },
  { b: [0.877, 0.007, 0.981, 0.039], t: "BWC2-101947" },
  { b: [0.018, 0.028, 0.154, 0.072], t: "OFFICER 11" },
  { b: [0, 0.394, 0.159, 0.526], t: "RAGIAL" },
];

const inside = (box: [number, number, number, number], line: ScreenText) => line.b[0] >= box[0] && line.b[1] >= box[1] && line.b[2] <= box[2] && line.b[3] <= box[3];
const kept = (boxes: [number, number, number, number][], line: ScreenText) => boxes.some((box) => inside(box, line));

async function grey(file: string, width: number, height: number): Promise<Uint8Array> {
  return tools.run([tools.ffmpeg(), "-v", "error", "-i", file, "-frames:v", "1", "-vf", `scale=${width}:${height},format=gray`, "-f", "rawvideo", "-"]);
}

test("Motorola's stamp bar is found, its clock reads as one, and its own text is kept while OFFICER 11 over it isn't", async () => {
  const frame = join(import.meta.dir, "fixtures", "motorola-strip-officer-label.jpg");
  const bar = tr.findBar([await grey(frame, 480, 270)], 480, 270);
  expect(bar).not.toBeNull();
  expect(bar!.edge).toBe("top");
  expect(bar!.to).toBeGreaterThan(0.035);
  expect(bar!.to).toBeLessThan(0.05);
  const { parseClock } = await import("../src/camera_clock.ts");
  // Month first, as US cameras write it; and as a Mac's Vision reads it, its colons dots.
  for (const read of ["11/18/2024 12:16:31", "11/18/2024 12..16..31", "11/18/2024 12'.16.'31", "1l/18/2024 12:16:3l"]) expect(parseClock(read)).toEqual({ day: 20045, second: 12 * 3600 + 16 * 60 + 31, seconds: true });
  const boxes = tr.cameraText([MOTOROLA, MOTOROLA, MOTOROLA], bar);
  for (const own of ["11/18/2024 12:16:31", "BWC2-101947", "LUTIONS"]) expect(kept(boxes, MOTOROLA.find((line) => line.t === own)!)).toBe(true);
  // The re-uploader's label reaches below the bar: theirs, not the camera's; nor is the tyre's word.
  const officer = MOTOROLA.find((line) => line.t === "OFFICER 11")!;
  expect(boxes.some((box) => box[0] < officer.b[2] && officer.b[0] < box[2] && box[1] < officer.b[3] && officer.b[1] < box[3])).toBe(false);
  expect(kept(boxes, MOTOROLA.find((line) => line.t === "RAGIAL")!)).toBe(false);
  // Planning reads no frames: a clock at the picture's edge stands for its row, the same boxes.
  expect(tr.cameraText([MOTOROLA, MOTOROLA, MOTOROLA], null)).toEqual(boxes);
  // OFFICER 11 is a label of theirs that stays put: the file is sent.
  const seconds = [1, 5, 9, 13, 17];
  expect(tr.labelSpans(Object.fromEntries(seconds.map((second) => [second, MOTOROLA])), seconds, 20, boxes)).toEqual([[0, 20]]);
  // A synthetic bar the same way: dark see-through rows over a moving picture, in every frame.
  const frames = [0, 1, 2].map((shift) => {
    const out = new Uint8Array(480 * 270);
    for (let y = 0; y < 270; y++) for (let x = 0; x < 480; x++) out[y * 480 + x] = Math.round((110 + 70 * Math.sin((x + 0.7 * y + 40 * shift) / 23) + 30 * Math.cos((x - y + 25 * shift) / 13)) * (y < 12 ? 0.45 : 1));
    return out;
  });
  expect(tr.findBar(frames, 480, 270)).toEqual({ edge: "top", from: 0, to: 0.044 });
  // No bar: a picture alone.
  expect(tr.findBar(frames.map((frame) => frame.map((value, at) => (at < 12 * 480 ? Math.round(value / 0.45) : value))), 480, 270)).toBeNull();
});

test("Axon's stamp and its logo are kept, Tulsa's 'Actual case footage' isn't, and it makes the file one to send", () => {
  const seconds = [2, 5, 8];
  const frames = seconds.map((second) => TULSA[second]!);
  const boxes = tr.cameraText(frames, null);
  for (const frame of frames) {
    for (const line of frame) expect(kept(boxes, line)).toBe(/^(2025|AXON)/u.test(line.t));
  }
  // Room for the triangle right of the date line (x 0.945–0.985 of the picture).
  expect(Math.max(...boxes.map((box) => box[2]))).toBeGreaterThan(0.96);
  expect(tr.labelSpans(TULSA, seconds, 10, boxes)).toEqual([[0, 10]]);
  // A clock and its stamp alone: nothing of theirs to take out.
  const stampOnly = Object.fromEntries(seconds.map((second) => [second, TULSA[second]!.filter((line) => /^(2025|AXON)/u.test(line.t))]));
  expect(tr.labelSpans(stampOnly, seconds, 10, boxes)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Vmake's API: signatures and whose a failure is

test("the engine's learned mark is a box the automatic look leaves alone (Vmake leaves a see-through watermark to the engine)", () => {
  const model = JSON.stringify({ version: 1, width: 1280, height: 720, gamma: 2.2, white: 1, at: [495, 470], matte_width: 290, matte_height: 120, matte: "", strength: 0.3, frames: 2000 });
  const box = tr.markBox(model)!;
  [0.3867, 0.6528, 0.6133, 0.8194].forEach((share, at) => expect(box[at]).toBeCloseTo(share, 3));
  expect(tr.markBox("{}")).toBeNull();
  expect(tr.markBox("not json")).toBeNull();
});

test("Vmake's signatures match its Python SDK's, and a refusal is the account's or the piece's", () => {
  const at = new Date(Date.UTC(2026, 10, 17, 8, 0, 0));
  // Worked out by the SDK's own sign.py and alibabacloud_oss_v2's v4.py with these inputs (Nov 17).
  expect(signSdk({ ak: "AKID", sk: "SECRET" }, "GET", "https://openapi.starii.com/api/sdk/task/status?task_id=ab+c&z=1&a=2", { Host: "openapi.starii.com", "User-Agent": "action-api-sdk-v2.0.1" }, "", at).Authorization).toBe(
    "Bearer U0RLLUhNQUMtU0hBMjU2IEFjY2Vzcz1BS0lELCBTaWduZWRIZWFkZXJzPWhvc3Q7dXNlci1hZ2VudDt4LXNkay1kYXRlLCBTaWduYXR1cmU9MTUxNDU1YjNmNDcxODM1MjYyNjcwYzY2ZDgzYmNlNWMwZTAzNjQ4ZTQ3MWM5ZThlMmYzZTBiZTc1MTM5MmNmMA==",
  );
  expect(signOss({ access_key: "AKID", secret_key: "SECRET", session_token: "TOKEN" }, "ap-southeast-1", "kapkap-common", "skill_upload/abc d", { "Content-Type": "video/mp4", "Content-Length": "10" }, at).Authorization).toBe(
    "OSS4-HMAC-SHA256 Credential=AKID/20261117/ap-southeast-1/oss/aliyun_v4_request,Signature=b7ce8c5fcc0a09201ceadca5a16c72ca2f6a68b56a90c96551576112a2ac6097",
  );
  const whose = (said: string, quota = false, status: number | null = null) => {
    const error = classify(said, quota, status);
    return error.scope === "account" ? error.reason : "piece";
  };
  // Vmake's own words (Nov 17): bad keys.
  expect(whose("invalid or inactive AK/SK")).toBe("keys_refused");
  expect(whose("sign not equals client")).toBe("keys_refused");
  expect(whose("insufficient balance", true)).toBe("out_of_credits");
  expect(whose("Daily upload limit reached, try again tomorrow", true)).toBe("daily_limit");
  expect(whose("This account has been suspended")).toBe("closed");
  expect(whose("Your Pro subscription has expired")).toBe("lapsed");
  expect(whose("session expired, please log in again")).toBe("signed_out");
  expect(whose("forbidden", false, 403)).toBe("keys_refused");
  // Anything else from taking the quota is still the account's; from a task, the piece's.
  expect(whose("permission denied for SKM0005", true)).toBe("refused");
  expect(whose("the task gave no video")).toBe("piece");
  expect(tr.accountLine("closed")).toBe("Taking their text out is off: Vmake says this account is closed. Their subtitles stay blurred until it's sorted.");
  expect(tr.accountLine("daily_limit")).toBe("Taking their text out is paused: the day's Vmake allowance is used up; it carries on tomorrow.");
});

// ---------------------------------------------------------------------------
// The strip's pixels

/** Raw RGB frames of `file` (`frames` of them) at its size. */
async function rgb(file: string, width: number, height: number, frame: number, matrix = "bt709"): Promise<Uint8Array> {
  return tools.run([tools.ffmpeg(), "-v", "error", "-i", file, "-vf", `select=eq(n\\,${frame}),scale=in_range=tv:out_range=pc:in_color_matrix=${matrix},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]).then((bytes) => (bytes.length === width * height * 3 ? bytes : new Uint8Array(0)));
}

/**
 * A see-through picture (a moving pattern), a re-uploader's label (white
 * block letters, still) at the top left and the camera's stamp at the top
 * right; "Vmake's" result: the label gone, the stamp redrawn (lighter) and the
 * whole picture a little changed, as Smart Pro re-renders it.
 */
async function footagePair(dir: string): Promise<{ original: string; cleaned: string }> {
  const original = join(dir, "original.mp4");
  const cleaned = join(dir, "cleaned.mp4");
  const base = "testsrc2=size=320x180:rate=30:duration=2,format=yuv420p,drawbox=x=220:y=6:w=90:h=14:color=0x202020@1:t=fill";
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `${base},drawbox=x=10:y=40:w=80:h=24:color=white:t=fill,drawbox=x=16:y=46:w=68:h=12:color=black:t=fill`, "-c:v", "libx264", "-qp", "0", original]);
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `${base},drawbox=x=220:y=6:w=90:h=14:color=0x909090@1:t=fill,eq=brightness=0.02`, "-c:v", "libx264", "-qp", "0", cleaned]);
  return { original, cleaned };
}

test("the strip is Vmake's picture where it took the label out, see-through elsewhere and over the camera's stamp, with no ghost", async () => {
  const { dir, cleanup } = scratch("strip");
  try {
    const { original, cleaned } = await footagePair(dir);
    const out = join(dir, "strip.mp4");
    // The stamp's box (shares): kept as it was.
    const stamp: [number, number, number, number] = [0.68, 0.02, 0.98, 0.13];
    const made = await tr.makeStrip(original, cleaned, { width: 320, height: 180, fps: 30 }, [stamp], out);
    expect(made).not.toBeNull();
    const [x0, y0, x1, y1] = made!.box;
    // Cropped to what was taken out (the label and a feathered margin), not the stamp nor the whole frame.
    expect(x0 * 320).toBeLessThan(10);
    expect(x1 * 320).toBeGreaterThan(90);
    expect(x1 * 320).toBeLessThan(140);
    expect(y1 * 180).toBeLessThan(100);
    const [w, h] = [Math.round((x1 - x0) * 320), Math.round((y1 - y0) * 180)];
    const strip = await rgb(out, w, h * 2, 30);
    // Footage under 720 lines untagged is BT.601's; the strip is written as BT.709.
    const clean = await rgb(cleaned, 320, 180, 30, "bt601");
    expect(strip.length).toBe(w * h * 2 * 3);
    const alphaAt = (x: number, y: number) => strip[((h + y) * w + x) * 3]!;
    const pictureAt = (x: number, y: number, c: number) => strip[(y * w + x) * 3 + c]!;
    // Inside the label, wholly Vmake's picture: alpha full, the colour Vmake's (premultiplied by 1).
    const [lx, ly] = [50 - Math.round(x0 * 320), 52 - Math.round(y0 * 180)];
    expect(alphaAt(lx, ly)).toBeGreaterThanOrEqual(252);
    for (let c = 0; c < 3; c++) expect(Math.abs(pictureAt(lx, ly, c) - clean[(52 * 320 + 50) * 3 + c]!)).toBeLessThanOrEqual(6);
    // Away from it (the re-render's small change everywhere), the original: nothing.
    const [fx, fy] = [Math.min(w - 1, 130 - Math.round(x0 * 320)), Math.min(h - 1, 90 - Math.round(y0 * 180))];
    if (fx >= 0 && fy >= 0) expect(alphaAt(fx, fy)).toBeLessThanOrEqual(3);
    // The strip ends before the stamp: kept as the original whatever Vmake did there.
    expect(x1).toBeLessThanOrEqual(stamp[0] + 0.01);
    // Kept even where Vmake redrew it and nothing says to keep it: the stamp's box is the only difference.
    const unkept = await tr.makeStrip(original, cleaned, { width: 320, height: 180, fps: 30 }, [], join(dir, "unkept.mp4"));
    expect(unkept!.box[2]).toBeGreaterThan(0.9);
    // Nothing taken out: no strip.
    expect(await tr.makeStrip(original, original, { width: 320, height: 180, fps: 30 }, [], join(dir, "none.mp4"))).toBeNull();
  } finally {
    cleanup();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// In the project

function footageProject(): Project {
  return {
    version: 1,
    id: "p",
    name: "p",
    style: "bodycam",
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "m", name: "tape", path: "/tape.mp4", kind: "video", duration: 600, width: 1280, height: 720, fps: 30, has_audio: true },
      { id: "s", name: "tape · their text out 9–31 s", path: "/strip.mp4", kind: "video", duration: 22, width: 1280, height: 640, fps: 30, has_audio: false, stacked_alpha: true, cleans: { media: "m", from: 9, to: 31, box: [0, 0, 1, 0.9] } },
    ],
    tracks: [
      { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
      { id: "v2", kind: "video", hidden: false, muted: false, locked: false },
      { id: "t1", kind: "video", hidden: false, muted: false, locked: false, subtitles: true },
    ],
    clips: [
      // 12–22 s of the tape at 0, pushing in, fading in.
      { id: "c1", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 10, fade_out: 0, type: "video", media: "m", source_in: 12, speed: 1, transform: { x: 40, y: 0, scale: 1.1, rotation: 0 }, opacity: 1, keyframes: { scale: [{ frame: 0, value: 1.1, ease: "linear" }, { frame: 299, value: 1.3, ease: "linear" }] } },
      // 25–40 s of it later: only up to 31 s is cleaned.
      { id: "c2", track: "v1", start: 300, duration: 450, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 25, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 },
      // A picture on the track above.
      { id: "b", track: "v2", start: 0, duration: 60, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 100, speed: 1, transform: { x: 500, y: 0, scale: 0.3, rotation: 0 }, opacity: 1 },
      // The blur standing in until it's done, on c1.
      { id: "blur", track: "v2", start: 100, duration: 200, color: "blue", fade_in: 0, fade_out: 0, type: "adjustment", name: `${burned.UNTIL_REMOVED} · c1`, blur: { radius: 35, x: 0, y: 400, width: 900, height: 120, feather: 10 } },
    ],
    next_id: 10,
    remove_burned: true,
  } as unknown as Project;
}

test("a strip is laid over each clip of its footage it covers, stuck to it, just above it; re-cuts follow, a save changes nothing, the blur gives way", () => {
  const project = footageProject();
  enforceCleanStrips(null, project);
  const overlays = project.clips.filter((clip): clip is VideoClip => (clip.name ?? "").startsWith(NAME));
  expect(overlays.length).toBe(2);
  const [one, two] = overlays.sort((a, b) => a.start - b.start);
  // c1: the whole clip (12–22 s is inside 9–31 s), its own fade, the strip's 3 s in, stuck to c1, on a lane just above v1.
  expect(one).toMatchObject({ start: 0, duration: 300, media: "s", source_in: 3, speed: 1, parent: "c1", fade_in: 10, name: `${NAME} · c1` });
  const lane = project.tracks.findIndex((track) => track.id === one!.track);
  expect(project.tracks[lane - 1]!.id).toBe("v1");
  expect(project.tracks[lane + 1]!.id).toBe("v2");
  // Placed over the footage at rest: the strip's picture is the box's (the top 90%), its scale the footage's on screen.
  expect(one!.transform.x).toBeCloseTo(40, 3);
  expect(one!.transform.y).toBeCloseTo(-0.05 * 720 * 1.5 * 1.1, 1);
  expect(one!.transform.scale).toBeCloseTo((1280 * 1.5 * 1.1) / (1280 * Math.min(1920 / 1280, 1080 / 640)), 4);
  // c2: 25–31 s only, from its start.
  expect(two).toMatchObject({ start: 300, duration: 180, source_in: 16, parent: "c2", track: one!.track });
  // The blur on c1 is gone where the strip covers it; onTimeline no longer shows theirs there.
  expect(project.clips.find((clip) => clip.id === "blur")).toBeUndefined();
  expect(strippedFrames(project).get("c1")).toEqual([[0, 300]]);
  // Saved again: nothing changes (no new ids, no new lane).
  const again = structuredClone(project);
  enforceCleanStrips(project, again);
  expect(again).toEqual(project);
  // A re-cut: c1 trimmed to start at 20 s of the tape, moved; its strip follows.
  const cut = structuredClone(project);
  const c1 = cut.clips.find((clip) => clip.id === "c1") as VideoClip;
  c1.source_in = 20;
  c1.start = 30;
  c1.duration = 250;
  enforceCleanStrips(project, cut);
  const followed = cut.clips.filter((clip): clip is VideoClip => (clip.name ?? "").startsWith(NAME) && clip.parent === "c1");
  expect(followed.map((clip) => [clip.start, clip.duration, clip.source_in])).toEqual([[30, 250, 11]]);
  expect(cut.tracks.length).toBe(project.tracks.length);
  // The strip gone (taken out of the project): the overlays and their lane go with it.
  const gone = structuredClone(project);
  gone.media = gone.media.filter((media) => media.id !== "s");
  enforceCleanStrips(project, gone);
  expect(gone.clips.some((clip) => (clip.name ?? "").startsWith(NAME))).toBe(false);
  expect(gone.tracks.map((track) => track.id)).toEqual(["v1", "v2", "t1"]);
});

// ---------------------------------------------------------------------------
// A run, with a stand-in for Vmake

/** The fixture's addon, reading `reads` off every file (as Paddle or Vision would). */
function reading(reads: Record<number, ScreenText[]>): void {
  const raw = createStub() as unknown as Record<string, unknown>;
  const current = native() as unknown as Record<string, unknown>;
  for (const key of Object.keys(current)) raw[key] = current[key];
  raw.stub = false;
  // What Vmake gave back reads clean (`stillShows` finds nothing of theirs left).
  raw.screenTextDetect = async (source: string, _size: [number, number], indexes: number[]) => Object.fromEntries(indexes.map((index) => [index, source.includes(".vmake-") ? [] : (reads[index] ?? reads[Number(Object.keys(reads)[0])] ?? [])]));
  raw.screenTextCached = () => reads;
  before = useNative(raw as unknown as Native);
}

/** A stand-in for Vmake: the label's box filled with the picture's grey (what Smart Pro would leave), or `fail` thrown. */
function standIn(log: string[], fail: (call: number) => VmakeError | null = () => null, id: tr.ProviderId = "vmake-api", gate: Promise<void> = Promise.resolve()): tr.Provider {
  return {
    id,
    price: (seconds) => `≈ $${Math.round(seconds * 0.027)}`,
    async remove(input, out, seconds) {
      log.push(`remove ${Math.round(seconds)}`);
      await gate;
      const error = fail(log.filter((one) => one.startsWith("remove")).length);
      if (error !== null) throw error;
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-i", input, "-vf", "drawbox=x=8:y=38:w=84:h=28:color=0x7f7f7f@1:t=fill", "-c:v", "libx264", "-qp", "0", out]);
      return { credits: Math.round(seconds * 4) };
    },
    async check() {
      log.push("check");
    },
  };
}

async function labelledFootage(dir: string, seconds: number): Promise<string> {
  const file = join(dir, "tape.mp4");
  await tools.run([
    tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x7f7f7f:size=320x180:rate=30:duration=${seconds},format=yuv420p,noise=alls=12:allf=t,drawbox=x=10:y=40:w=80:h=24:color=white:t=fill`,
    "-c:v", "libx264", "-qp", "0", file,
  ]);
  return file;
}

/** A channel's removal lesson, as teach_removal keeps it, for the projects of channel ch-taught. */
function teach(remove: Partial<Record<removal.Kind, boolean>>, examples: removal.Example[] = [], when: Partial<Record<removal.Kind, removal.When>> = {}): void {
  const lesson = removal.changed(null, remove, examples, false, when);
  v2cloud.useSkillsForTests([{ name: removal.SKILL, key: v2cloud.ownKey("skill", "ch-taught--edit", removal.SKILL), text: removal.write(lesson) }]);
}

/** A project of channel ch-taught with `file` on its timeline, its words read (a label that stays put). */
async function labelledProject(app: App, file: string, duration: number, name = "p"): Promise<string> {
  const live = app.store.create(name, { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project) as Project;
  const media: Media = { id: "m", name: "tape", path: file, kind: "video", duration, width: 320, height: 180, fps: 30, has_audio: false };
  project.media = [media];
  project.clips = [{ id: "f", track: "v1", start: 0, duration: Math.round(duration * 30), color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }];
  project.channel = "ch-taught";
  await app.store.replace(project.id, null, project, "test");
  await burned.warm(app.media, media);
  return project.id;
}

const LABEL: ScreenText = { t: "Actual case footage", b: [0.03, 0.22, 0.28, 0.36] };

test("a run takes the label out through the provider, lays the strip, keeps the piece, and never pays for it twice", async () => {
  const { app, dir, store, home, cleanup } = fixtureHome("removal-run");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true });
  const log: string[] = [];
  tr.useProvider(standIn(log));
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = await labelledFootage(dir, 8);
    const id = await labelledProject(app, file, 8);
    const offered = await tr.status(app, id);
    expect(offered).toEqual({ line: "Take their text out of 8 s of footage: ≈ $0", action: "remove", running: null });
    await tr.begin(app, id);
    await tr.settled(id);
    expect(log).toEqual(["remove 8"]);
    const project = store.get(id)!.project;
    const strip = project.media.find((media) => media.cleans != null);
    expect(strip).toMatchObject({ stacked_alpha: true, has_audio: false, cleans: { media: "m", from: 0, to: 8 } });
    expect(fs.existsSync(strip!.path)).toBe(true);
    expect(project.clips.filter((clip) => (clip.name ?? "").startsWith(NAME)).map((clip) => (clip as VideoClip).parent)).toEqual(["f"]);
    // Done: nothing more to offer; the run is kept with what it spent.
    expect((await tr.status(app, id)).line).toBeNull();
    const record = JSON.parse(fs.readFileSync(join(home, "text-removal.json"), "utf8")) as { runs: { seconds: number; credits: number; estimate: number }[] };
    expect(record.runs.at(-1)).toMatchObject({ seconds: 8, credits: 32, estimate: 32 });
    // The same footage in another project (a reused case): the kept piece, nothing sent.
    const other = await labelledProject(app, file, 8, "q");
    await tr.ensure(app, other);
    await tr.settled(other);
    expect(log).toEqual(["remove 8"]);
    expect(store.get(other)!.project.media.some((media) => media.cleans != null)).toBe(true);
  } finally {
    cleanup();
  }
}, 120_000);

test("a piece Vmake fails stays blurred and is said; an account it refuses stops every send at once, is kept, and is asked again later", async () => {
  const { app, dir, store, home, cleanup } = fixtureHome("removal-fail");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true });
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = await labelledFootage(dir, 8);
    // A piece's failure: sent once more, then given up on, their label blurred, said.
    const log: string[] = [];
    tr.useProvider(standIn(log, () => new VmakeError("Vmake's task gave no video", "piece")));
    const id = await labelledProject(app, file, 8);
    await tr.begin(app, id);
    await tr.settled(id);
    expect(log).toEqual(["remove 8", "remove 8"]);
    expect(store.get(id)!.project.media.some((media) => media.cleans != null)).toBe(false);
    expect(tr.piecesOf(id).map((one) => [one.state, one.tries])).toEqual([["failed", 2]]);
    expect(store.get(id)!.project.clips.filter((clip) => (clip.name ?? "").startsWith(burned.UNTIL_REMOVED)).length).toBeGreaterThan(0);
    expect(await tr.status(app, id)).toEqual({ line: "Vmake couldn't clean one piece; their text stays blurred there.", action: null, running: null });
    // The account's: two files of footage, the first refused, the second never sent.
    const second = join(dir, "second.mp4");
    fs.copyFileSync(file, second);
    await store.update(id, "test", (project) => {
      project.media.push({ ...project.media[0]!, id: "m2", name: "second", path: second });
      project.clips.push({ ...structuredClone(project.clips[0]!), id: "g", start: 240, media: "m2" } as VideoClip);
    });
    await burned.warm(app.media, store.get(id)!.project.media.find((media) => media.id === "m2")!);
    const refused: string[] = [];
    tr.useProvider(standIn(refused, () => new VmakeError("Vmake's quota: insufficient balance", "account", "out_of_credits")));
    await tr.begin(app, id);
    await tr.settled(id);
    expect(refused.filter((one) => one.startsWith("remove"))).toEqual(["remove 8"]);
    const line = "Taking their text out is off: the Vmake account is out of credits. Their subtitles stay blurred until it's sorted.";
    expect(await tr.status(app, id)).toEqual({ line, action: "retry", running: null });
    // Pressed again before an hour: nothing sent, still off (kept in the home, so a restart keeps it too).
    await tr.begin(app, id);
    await tr.settled(id);
    expect(refused.filter((one) => one.startsWith("remove")).length).toBe(1);
    expect(JSON.parse(fs.readFileSync(join(home, "text-removal.json"), "utf8")).accounts["vmake-api"].reason).toBe("out_of_credits");
    // An hour on, it's offered again; the person's retry checks the account first.
    expect(tr.blocked(home, "vmake-api", Date.now() + tr.RECHECK_MS + 1)).toBeNull();
    const back: string[] = [];
    tr.useProvider(standIn(back));
    await tr.begin(app, id, true);
    await tr.settled(id);
    expect(back[0]).toBe("check");
    // The second file only: the first was given up on (it stays blurred, never sent again here).
    expect(back.filter((one) => one.startsWith("remove")).length).toBe(1);
    expect(store.get(id)!.project.media.filter((media) => media.cleans != null).map((media) => media.cleans!.media)).toEqual(["m2"]);
  } finally {
    cleanup();
  }
}, 120_000);

// ---------------------------------------------------------------------------
// What a channel is taught to take out (removal_lesson.ts) and what that sends

test("a removal lesson reads back as kept, changes part by part, and says where each part goes", () => {
  const actual: removal.Example = { kind: "text", action: "remove", text: "Actual case footage", box: [0.03, 0.05, 0.35, 0.13], from: { source: "drive:abc", at: 5 } };
  const stamp: removal.Example = { kind: "stamp", action: "keep", text: "AXON BODY 3", box: [0.66, 0.01, 0.97, 0.09] };
  const lesson = removal.changed(null, { subtitles: true, text: true }, [actual, stamp]);
  const kept = removal.write(lesson);
  expect(kept.split("\n")[0]).toBe(`Take their subtitles and their labels and other text out of the footage's picture wherever a file has them, by itself as footage is cut; the camera's stamp and "AXON BODY 3" always kept.`);
  expect(removal.parse(kept)).toEqual(lesson);
  // When each part runs, said in the first line: by itself after import, or only when someone asks.
  const timed = removal.changed(lesson, { watermarks: true }, [], false, { watermarks: "asked" });
  expect(removal.summary(timed)).toBe(`Take their subtitles and their labels and other text out of the footage's picture wherever a file has them, by itself as footage is cut; their watermarks out only when someone asks; the camera's stamp and "AXON BODY 3" always kept.`);
  expect(removal.summary(removal.changed(null, { watermarks: true }, [], false, { watermarks: "asked" }))).toBe("Take their watermarks out of the footage's picture only when someone asks; the camera's stamp always kept.");
  expect(removal.parse(removal.write(timed))!.when).toEqual({ subtitles: "automatic", watermarks: "asked", text: "automatic" });
  // A lesson kept before timings read back: every part by itself, as it ran.
  expect(removal.parse(`x\n<removal>{"remove":{"subtitles":true},"examples":[]}</removal>`)!.when).toEqual({ subtitles: "automatic", watermarks: "automatic", text: "automatic" });
  // Hand-written words, or broken data, are no lesson: nothing is taken out.
  expect(removal.parse("Take their subtitles out")).toBeNull();
  expect(removal.parse("x <removal>{oops</removal>")).toBeNull();
  // Part by part: what's given changes, the rest stays; the same frame's example replaced, or all cleared.
  const later = removal.changed(lesson, { text: false, watermarks: true }, [{ ...actual, text: "Actual footage" }]);
  expect(later.remove).toEqual({ subtitles: true, watermarks: true, text: false });
  expect(later.examples.map((one) => one.text)).toEqual(["AXON BODY 3", "Actual footage"]);
  expect(removal.changed(later, {}, [], true).examples).toEqual([]);
  // Where each part goes: Vmake for subtitles and text, the local step for watermarks, nothing untaught.
  expect(removal.kinds(null)).toEqual({ vmake: [], local: [] });
  expect(removal.kinds(removal.changed(null, { subtitles: true }, []))).toEqual({ vmake: ["subtitles"], local: [] });
  expect(removal.kinds(removal.changed(null, { watermarks: true }, []))).toEqual({ vmake: [], local: ["watermarks"] });
  expect(removal.kinds(removal.changed(null, { subtitles: true, text: true, watermarks: true }, []))).toEqual({ vmake: ["subtitles", "text"], local: ["watermarks"] });
  expect(removal.takesOut(removal.changed(null, { subtitles: false }, []))).toBe(false);
  // The paste-back's reach: only their subtitles' band when that's all; everywhere but it for text alone; the keep examples always kept.
  const band: burned.Band = [0.2, 0.8, 0.8, 0.92];
  const near: [number, number, number, number] = [0.17, 0.77, 0.83, 0.95];
  const round = (boxes: number[][]) => boxes.map((box) => box.map((value) => Math.round(value * 1000) / 1000));
  expect(round(tr.keptFor(removal.changed(null, { subtitles: true }, []), band))).toEqual(round(tr.outside(near)));
  expect(round(tr.keptFor(removal.changed(null, { text: true }, []), band))).toEqual([near]);
  expect(tr.keptFor(removal.changed(null, { subtitles: true, text: true }, [stamp]), band)).toEqual([stamp.box!]);
  // Taught words: a label of theirs counts the first time it's read; words it keeps never count, staying put or not.
  const once = { 3: [{ t: "Actual case footage", b: [0.03, 0.05, 0.35, 0.13] }] } as Record<number, ScreenText[]>;
  expect(tr.labelSpans(once, [1, 3, 5, 7], 8, [])).toEqual([]);
  expect(tr.labelSpans(once, [1, 3, 5, 7], 8, [], removal.exampleWords(lesson))).toEqual([[1.5, 4.5]]);
  const credit = Object.fromEntries([1, 3, 5, 7].map((second) => [second, [{ t: "Bodycam Watch exclusive", b: [0.6, 0.85, 0.95, 0.9] }]])) as Record<number, ScreenText[]>;
  expect(tr.labelSpans(credit, [1, 3, 5, 7], 8, [])).toEqual([[0, 8]]);
  expect(tr.labelSpans(credit, [1, 3, 5, 7], 8, [], { remove: [], keep: ["Bodycam Watch exclusive"] })).toEqual([]);
});

/** A stand-in for the watermark engine: each cell a small stacked strip, its mark all but gone. */
function engine(calls: string[]): wm.Engine {
  return {
    async learn(_source, _size, _duration, hint) {
      calls.push(`learn ${JSON.stringify(hint)}`);
      return JSON.stringify({ version: 1, stand: "in" });
    },
    async remove(piece): Promise<WatermarkRemoved | null> {
      calls.push(`remove ${piece.from}-${piece.to}`);
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:size=64x128:rate=30:duration=${piece.to - piece.from}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", piece.out]);
      return { region: [0.37, 0.61, 0.63, 0.84], frames: Math.round((piece.to - piece.from) * 30), marked: 1, filled: 0.9, left: 0.05, took: 1 };
    },
  };
}

test("what's sent follows the lesson: untaught nothing, subtitles alone not their labels, watermarks alone to the engine and never Vmake", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-lessons");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  const log: string[] = [];
  tr.useProvider(standIn(log, () => null, "vmake-web"));
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  const calls: string[] = [];
  wm.useEngine(engine(calls));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = await labelledFootage(dir, 8);
    const id = await labelledProject(app, file, 8);
    // Untaught: nothing said, nothing sent, nothing learned.
    await removalSchedule.ensure(app, id);
    await tr.settled(id);
    await wm.settled();
    expect(await removalSchedule.statusOf(app, id)).toEqual({ line: null, action: null, running: null });
    expect([log, calls]).toEqual([[], []]);
    // Taught their subtitles alone: this footage shows a label, no subtitles, so nothing.
    teach({ subtitles: true });
    expect((await tr.plan(app, store.get(id)!.project)).files).toEqual([]);
    // Their text: the label's file is the one to send.
    teach({ text: true });
    expect((await tr.plan(app, store.get(id)!.project)).files.map((one) => [one.media.id, one.send])).toEqual([["m", [[0, 8]]]]);
    // Their watermark alone, with an example of it: the mark learned from it once, the timeline's cells done here, Vmake never asked.
    const source = `sha256:${await cloudMedia.sha256File(file)}`;
    teach({ watermarks: true }, [{ kind: "watermarks", action: "remove", box: [0.3, 0.6, 0.7, 0.85], from: { source, at: 4 } }]);
    expect((await tr.plan(app, store.get(id)!.project)).files).toEqual([]);
    await removalSchedule.ensure(app, id);
    await wm.settled();
    expect(calls).toEqual([`learn ${JSON.stringify([0.3, 0.6, 0.7, 0.85])}`, "remove 0-8"]);
    expect(log).toEqual([]);
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(1);
  } finally {
    cleanup();
  }
}, 120_000);

test("a part taught to run only when asked does nothing until the agent starts it on what the person pointed to; then it's counted, checked and waited for as any", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-asked");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true, watermarks: true }, [], { text: "asked", watermarks: "asked" });
  const log: string[] = [];
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  tr.useProvider(standIn(log, () => null, "vmake-web", gate));
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  const calls: string[] = [];
  wm.useEngine(engine(calls));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  const call = async (args: Record<string, unknown>) =>
    ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: id, ...args } } }, null)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
  let id = "";
  try {
    const file = await labelledFootage(dir, 8);
    id = await labelledProject(app, file, 8);
    // Taught, not asked: no file looked at, nothing sent, nothing said, nothing for an export to wait for.
    await removalSchedule.ensure(app, id);
    await tr.settled(id);
    await wm.settled();
    expect([log, calls]).toEqual([[], []]);
    expect((await tr.plan(app, store.get(id)!.project)).files).toEqual([]);
    expect(await removalSchedule.statusOf(app, id)).toEqual({ line: null, action: null, running: null });
    await removalSchedule.waitForPieces(app, id, 200);
    // Asked with nowhere said: the agent is told what to give.
    expect((await call({})).content[0]!.text).toContain("say where");
    // The person points at the footage: both parts waiting for an ask start on it.
    const said = await call({ media: ["m"] });
    expect(said.isError).toBe(false);
    expect(said.content[0]!.text).toContain("Taking their watermarks, their labels and other text out of tape");
    while (removalSchedule.progressOf(id).out === 0 || log.length === 0) await Bun.sleep(20);
    expect((await removalSchedule.statusOf(app, id)).background?.label).toMatch(/^Removing their (text|watermarks)/u);
    expect(await removalSchedule.waitForPieces(app, id, 200).catch((error: unknown) => String(error))).toContain("still rendering");
    const waited = removalSchedule.waitForPieces(app, id, 60_000);
    open();
    await waited;
    await tr.settled(id);
    await wm.settled();
    expect(calls).toEqual(["learn null", "remove 0-8"]);
    expect(log.filter((one) => one.startsWith("remove")).length).toBe(1);
    expect(store.get(id)!.project.media.filter((media) => media.cleans != null).map((media) => media.cleans!.what ?? "text").sort()).toEqual(["text", "watermark"]);
    // Kept across a restart of the server: what was asked still covers this footage.
    asks.reset();
    expect(asks.scope(removal.lessonOf(store.get(id)!.project), app.store.home, id, "text", "m", [[0, 8]])).toEqual([[0, 8]]);
  } finally {
    cleanup();
  }
}, 120_000);

test("asked for a stretch of the timeline, only those seconds of the footage there; a part never taught can be asked for too", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-asked-span");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL], 9: [LABEL], 11: [LABEL] });
  v2cloud.useSkillsForTests([]);
  const log: string[] = [];
  tr.useProvider(standIn(log, () => null, "vmake-web"));
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = await labelledFootage(dir, 30);
    const id = await labelledProject(app, file, 30);
    // The timeline's 2–6 s are the footage's 2–6 s.
    const project = store.get(id)!.project;
    expect([...removalSchedule.shownBetween(project, 2, 6)]).toEqual([["m", [[2, 6]]]]);
    // Untaught: nothing until asked; asked for their text from 2 to 6 s: that stretch (with its handle) alone.
    await removalSchedule.ensure(app, id);
    await tr.settled(id);
    expect(log).toEqual([]);
    const said = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: id, kinds: ["text"], from: 2, to: 6 } } }, null)) as { result: { isError: boolean } };
    expect(said.result.isError).toBe(false);
    await tr.settled(id);
    expect(log).toEqual(["remove 6"]);
    const strips = store.get(id)!.project.media.filter((media) => media.cleans != null);
    expect(strips.map((media) => [media.cleans!.from, media.cleans!.to])).toEqual([[1, 7]]);
  } finally {
    cleanup();
  }
}, 120_000);

test("after a restart the work resumes by itself, with no edit (Nov 17, Sphe's M4): a cell cut short by the stop is done again, kept ones never twice; a retry runs their watermarks' work too", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-resume");
  reading({});
  const calls: string[] = [];
  let stopping = true;
  const base = engine(calls);
  // The server stopping mid-cell: FFmpeg killed under it, and nothing more done before it's gone.
  wm.useEngine({
    ...base,
    remove: async (piece, progress) => {
      if (!stopping) return base.remove(piece, progress);
      calls.push(`remove ${piece.from}-${piece.to}`);
      await Bun.sleep(1e9);
      return null;
    },
  });
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  tr.useProvider(null);
  try {
    const file = await labelledFootage(dir, 40);
    const id = await labelledProject(app, file, 40);
    teach({ watermarks: true });
    await removalSchedule.ensure(app, id);
    while (calls.length < 2) await Bun.sleep(20);
    expect(calls).toEqual(["learn null", "remove 0-30"]);
    // The restart: nothing in memory (the stopped server's queue gone), nothing edited since.
    stopping = false;
    wm.reset();
    v2cloud.forgetSkills();
    teach({ watermarks: true });
    expect(await removalSchedule.resume(app)).toBe(1);
    await wm.settled();
    // Its mark was kept by the file (not looked for again); both cells done now.
    expect(calls).toEqual(["learn null", "remove 0-30", "remove 0-30", "remove 30-40"]);
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(2);
    // Another restart: the kept cells are laid already, nothing is made again.
    wm.reset();
    await removalSchedule.resume(app);
    await wm.settled();
    expect(calls.length).toBe(4);
    // The line's retry (or a yes) with their watermarks alone taught and no Vmake here: the engine's work, not a refusal.
    wm.reset();
    const strips = store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").map((media) => media.id);
    await store.update(id, "test", (p) => {
      p.media = p.media.filter((media) => !strips.includes(media.id));
    });
    expect(await tr.begin(app, id, true)).toEqual({ line: null, action: null, running: null });
    await wm.settled();
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(2);
    expect(calls.length).toBe(4);
    // Untaught, or an old project: nothing resumes.
    v2cloud.useSkillsForTests([]);
    expect(await removalSchedule.resume(app)).toBe(0);
  } finally {
    cleanup();
  }
}, 120_000);

test("a run in the background: the chat row's numbers while it's out, then the agent woken with what it did once any turn under way ends, as Edit's own event; Stop sends nothing more", async () => {
  const { app, dir, cleanup } = fixtureHome("removal-row");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true });
  const log: string[] = [];
  let open = () => {};
  let gate = new Promise<void>((resolve) => (open = resolve));
  tr.useProvider({ ...standIn(log, () => null, "vmake-web"), remove: async (...args) => (await gate, standIn(log, () => null, "vmake-web").remove(...args)) });
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  const sent: string[] = [];
  let running = true;
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running }), send: async (_project: string, text: string) => void sent.push(text) };
  const before = { ...removalSchedule.timing };
  removalSchedule.timing.watchMs = 40;
  removalSchedule.timing.wakeEveryMs = 40;
  try {
    const file = await labelledFootage(dir, 8);
    const id = await labelledProject(app, file, 8);
    await removalSchedule.ensure(app, id);
    while (removalSchedule.progressOf(id).out === 0) await Bun.sleep(20);
    // The row's numbers, its Details, no line at the top.
    const said = await removalSchedule.statusOf(app, id);
    expect(said.line).toBeNull();
    expect(said.background).toMatchObject({ label: "Removing their text", done: 0, total: 1, left_s: null });
    expect(removalSchedule.pieceRows(id)).toEqual([expect.objectContaining({ key: "text:m@0", what: "text", name: "tape", from: 0, to: 8 })]);
    open();
    await tr.settled(id);
    // Done while the agent's turn runs: it waits for the turn to end, then one turn of Edit's own.
    await Bun.sleep(300);
    expect(sent).toEqual([]);
    running = false;
    const until = Date.now() + 10_000;
    while (sent.length === 0 && Date.now() < until) await Bun.sleep(20);
    expect(sent.length).toBe(1);
    expect(sent[0]).toStartWith(`${EDIT_EVENT} Taking their text out of the footage is done: 1 piece cleaned.`);
    expect(sent[0]).toContain("- tape: text 0–8 s");
    expect(sent[0]).toContain("lay OUR subtitles");
    await Bun.sleep(200);
    expect(sent.length).toBe(1);
    // Stopped mid-run (another project): the piece under way comes back and stays, nothing more goes, nobody is woken.
    gate = new Promise<void>((resolve) => (open = resolve));
    fs.mkdirSync(join(dir, "b"), { recursive: true });
    const other = await labelledProject(app, await labelledFootage(join(dir, "b"), 9), 9, "q");
    await removalSchedule.ensure(app, other);
    while (removalSchedule.progressOf(other).out === 0) await Bun.sleep(20);
    removalSchedule.stop(app, other);
    expect(asks.isStopped(app.store.home, other)).toBe(true);
    open();
    await tr.settled(other);
    await removalSchedule.ensure(app, other);
    await tr.settled(other);
    await Bun.sleep(300);
    expect(sent.length).toBe(1);
    expect(removalSchedule.progressOf(other).out).toBe(0);
    expect((await removalSchedule.statusOf(app, other)).background).toBeUndefined();
  } finally {
    Object.assign(removalSchedule.timing, before);
    cleanup();
  }
}, 120_000);

test("two runs done while the person's turn runs: one turn of Edit's own once it ends, telling of both", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-wake-once");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL], 9: [LABEL], 11: [LABEL] });
  teach({ text: true });
  const log: string[] = [];
  tr.useProvider(standIn(log, () => null, "vmake-web"));
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  const sent: string[] = [];
  let running = true;
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running }), send: async (_project: string, text: string) => void sent.push(text) };
  const before = { ...removalSchedule.timing };
  removalSchedule.timing.watchMs = 30;
  removalSchedule.timing.wakeEveryMs = 30;
  try {
    const file = await labelledFootage(dir, 30);
    const id = await labelledProject(app, file, 30);
    await store.update(id, "test", (p) => {
      (p.clips[0] as VideoClip).duration = 240;
    });
    const done = async (count: number) => {
      const until = Date.now() + 20_000;
      while (log.length < count && Date.now() < until) await Bun.sleep(20);
      await tr.settled(id);
      await Bun.sleep(200);
    };
    await removalSchedule.ensure(app, id);
    await done(1);
    // The clip grows: a second run, done while the turn still runs.
    await store.update(id, "agent", (p) => {
      (p.clips[0] as VideoClip).duration = 360;
    });
    await removalSchedule.ensure(app, id);
    await done(2);
    expect(sent).toEqual([]);
    running = false;
    const until = Date.now() + 10_000;
    while (sent.length === 0 && Date.now() < until) await Bun.sleep(20);
    await Bun.sleep(200);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("2 pieces cleaned");
  } finally {
    Object.assign(removalSchedule.timing, before);
    cleanup();
  }
}, 120_000);

test("the website's pieces go three at once once Vmake has taken the first (Nov 17, Sphe's M4: the first was waited on to its end, ~7 min, alone); a provider that never says it began keeps the first alone to its end", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-parallel");
  // A label on screen the whole 800 s: three pieces of at most 300 s.
  reading(Object.fromEntries(Array.from({ length: 400 }, (_, at) => [at * 2 + 1, [LABEL]])));
  teach({ text: true });
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  const file = join(dir, "long.mp4");
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x7f7f7f:size=160x90:rate=10:duration=800,format=yuv420p,drawbox=x=5:y=20:w=40:h=12:color=white:t=fill", "-c:v", "libx264", "-preset", "ultrafast", file]);
  const timeline = (says: boolean) => {
    const seen: number[] = [];
    let active = 0;
    let first = true;
    const provider: tr.Provider = {
      id: "vmake-web",
      price: () => "",
      async remove(input, out, _seconds, _signal, _whole, begun) {
        active += 1;
        seen.push(active);
        const mine = first;
        first = false;
        // Uploaded and applied a moment in; processing takes a while longer.
        await Bun.sleep(150);
        if (says) begun?.();
        await Bun.sleep(mine ? 600 : 300);
        fs.copyFileSync(input, out);
        active -= 1;
        return { credits: null };
      },
      async check() {},
    };
    return { provider, seen };
  };
  try {
    const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    const media: Media = { id: "m", name: "long", path: file, kind: "video", duration: 800, width: 160, height: 90, fps: 10, has_audio: false };
    project.media = [media];
    project.clips = [{ id: "f", track: "v1", start: 0, duration: 800 * 30, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as VideoClip];
    project.channel = "ch-taught";
    await app.store.replace(project.id, null, project, "test");
    await burned.warm(app.media, media);
    expect((await tr.plan(app, store.get(project.id)!.project)).files[0]!.send.length).toBe(3);
    // The website: the first alone until it's taken, then the other two beside it (three at once).
    const site = timeline(true);
    tr.useProvider(site.provider);
    await tr.ensure(app, project.id);
    await tr.settled(project.id);
    expect(site.seen).toEqual([1, 2, 3]);
    // Never said: the first to its end, then the rest.
    tr.reset();
    tr.useShelf(tr.shelfIn(join(dir, "shelf2"), () => false));
    await app.store.update(project.id, "test", (p) => {
      p.media = p.media.filter((one) => one.cleans == null);
    });
    const api = timeline(false);
    tr.useProvider(api.provider);
    await tr.ensure(app, project.id);
    await tr.settled(project.id);
    expect(api.seen).toEqual([1, 1, 2]);
  } finally {
    cleanup();
  }
}, 180_000);

test("removal starts by itself as soon as edits rest (no button on the website's plan); a longer clip sends only its new seconds", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-timing");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL], 9: [LABEL], 11: [LABEL] });
  teach({ text: true });
  const log: string[] = [];
  tr.useProvider(standIn(log, () => null, "vmake-web"));
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  removalSchedule.timing.restMs = 50;
  removalSchedule.start(app);
  try {
    const file = await labelledFootage(dir, 30);
    const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    const media: Media = { id: "m", name: "tape", path: file, kind: "video", duration: 30, width: 320, height: 180, fps: 30, has_audio: false };
    project.media = [media];
    project.channel = "ch-taught";
    await app.store.replace(project.id, null, project, "test");
    await burned.warm(app.media, media);
    // The first cut: 0–8 s of the tape on the timeline.
    await store.update(project.id, "agent", (p) => {
      p.clips = [{ id: "f", track: "v1", start: 0, duration: 240, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as VideoClip];
    });
    const until = Date.now() + 30_000;
    while (!store.get(project.id)!.project.media.some((one) => one.cleans != null) && Date.now() < until) await Bun.sleep(100);
    await tr.settled(project.id);
    expect(log).toEqual(["remove 9"]);
    // The clip extended to 12 s: only what's new goes.
    await store.update(project.id, "agent", (p) => {
      (p.clips[0] as VideoClip).duration = 360;
    });
    const later = Date.now() + 30_000;
    while (store.get(project.id)!.project.media.filter((one) => one.cleans != null).length < 2 && Date.now() < later) await Bun.sleep(100);
    await tr.settled(project.id);
    expect(log).toEqual(["remove 9", "remove 4"]);
    expect(await removalSchedule.statusOf(app, project.id)).toEqual({ line: null, action: null, running: null });
  } finally {
    removalSchedule.timing.restMs = 2000;
    cleanup();
  }
}, 120_000);

test("the agent looks at each piece and rejects one that isn't clean: done once more, then blurred and said; an export waits for pieces still out", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-check");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true });
  const log: string[] = [];
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  tr.useProvider(standIn(log, () => null, "vmake-web", gate));
  tr.useShelf(tr.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = await labelledFootage(dir, 8);
    const id = await labelledProject(app, file, 8);
    await removalSchedule.ensure(app, id);
    // While the piece is out: the line counts it, a quick export look says "still rendering", the export's step says how far.
    while (removalSchedule.progressOf(id).out === 0) await Bun.sleep(20);
    expect(await removalSchedule.statusOf(app, id)).toEqual({ line: null, action: null, running: { done: 0, total: 1 }, background: { label: "Removing their text", done: 0, total: 1, started_at: expect.any(Number), left_s: null } });
    expect(removalSchedule.exportLine(id)).toBe("Removing their text · 0 of 1 pieces");
    expect(await removalSchedule.waitForPieces(app, id, 200).catch((error: unknown) => String(error))).toContain("still rendering");
    const waited = removalSchedule.waitForPieces(app, id, 60_000);
    open();
    await waited;
    await tr.settled(id);
    expect(tr.piecesOf(id).map((one) => one.state)).toEqual(["check"]);
    const call = async (args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "check_removal", arguments: { project_id: id, ...args } } }, null)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    const looked = await call({});
    expect(looked.isError).toBe(false);
    expect(looked.content[0]!.text).toContain("text:m@0 · tape 0–8 s · text · check");
    expect(looked.content.some((one) => one.type === "image")).toBe(true);
    // Rejected: sent again; rejected again: given up on, blurred, said.
    const key = tr.piecesOf(id)[0]!.key;
    await call({ reject: [{ piece: key, why: "a ghost of the label" }] });
    await tr.settled(id);
    expect(log).toEqual(["remove 8", "remove 8"]);
    await call({ reject: [{ piece: key, why: "still a ghost" }] });
    await tr.settled(id);
    expect(log.length).toBe(2);
    expect(tr.piecesOf(id)[0]).toMatchObject({ state: "failed", why: "still a ghost" });
    expect(store.get(id)!.project.media.some((media) => media.cleans != null)).toBe(false);
    expect(store.get(id)!.project.clips.some((clip) => (clip.name ?? "").startsWith(burned.UNTIL_REMOVED))).toBe(true);
    expect((await removalSchedule.statusOf(app, id)).line).toBe("Vmake couldn't clean one piece; their text stays blurred there.");
  } finally {
    cleanup();
  }
}, 120_000);
