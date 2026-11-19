// The bad-day footage, made once with FFmpeg's own test pictures and kept in
// ~/.cache/edit-bad-day/footage (made again only when this file's recipe
// changes). Shaped like JJ's Axon files: the index (moov) at the end, a
// keyframe every 8 s, B-frames, AAC sound; 640×360 so the whole set stays
// small. Plus a megabyte of noise named .mp4, and sound alone.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

export interface Clip {
  /** The file's name here and on the stand-in Drive. */
  name: string;
  path: string;
  size: number;
  /** Seconds (0 for the noise). */
  seconds: number;
  md5: string;
}

interface Recipe {
  name: string;
  seconds: number;
  /** Video bitrate (kbit/s); 0 for sound alone. */
  kbps: number;
  /** testsrc2's pattern seed: each recording looks different. */
  look: string;
  tone: number;
}

const RECIPES: Recipe[] = [
  // 150 MB, 10 minutes at ~2 Mbit/s: the cut cases' file (an Axon file, small).
  { name: "Axon_Body_4_Video_2024-01-11_2341_X6031.mp4", seconds: 600, kbps: 1900, look: "testsrc2", tone: 440 },
  // Three short recordings: a case in Script mode.
  { name: "Axon_Body_4_Video_2024-01-11_2341_A1.mp4", seconds: 40, kbps: 1200, look: "testsrc2", tone: 330 },
  { name: "Axon_Body_4_Video_2024-01-11_2343_A2.mp4", seconds: 40, kbps: 1200, look: "smptehdbars", tone: 550 },
  { name: "Axon_Body_4_Video_2024-01-11_2345_A3.mp4", seconds: 40, kbps: 1200, look: "rgbtestsrc", tone: 660 },
  // A second long one for the editor's import: two files.
  { name: "Axon_Body_4_Video_2024-01-11_2350_X6032.mp4", seconds: 120, kbps: 1900, look: "smptehdbars", tone: 500 },
];
const SOUND: Recipe = { name: "Interview_audio_2024-01-12.m4a", seconds: 40, kbps: 0, look: "", tone: 220 };
const NOISE = "BenjaminCunningham_202401112341_02619-0.mp4";
/** What the stand-in voice answers: two seconds of silence as MP3. */
const SPEECH = "speech.mp3";

const recipeHash = createHash("sha256")
  .update(JSON.stringify([RECIPES, SOUND, NOISE, SPEECH, 4]))
  .digest("hex")
  .slice(0, 12);

function ffmpeg(args: string[]): void {
  const run = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], { stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) throw new Error(`ffmpeg failed (${run.exitCode}): ${args.join(" ")}`);
}

function md5(path: string): string {
  const hash = createHash("md5");
  const fd = fs.openSync(path, "r");
  const buffer = Buffer.alloc(1 << 20);
  for (;;) {
    const n = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n));
  }
  fs.closeSync(fd);
  return hash.digest("hex");
}

function make(recipe: Recipe, path: string): void {
  const next = `${path}.making.${recipe.kbps === 0 ? "m4a" : "mp4"}`;
  const sound = ["-f", "lavfi", "-i", `sine=frequency=${recipe.tone}:sample_rate=48000:duration=${recipe.seconds}`];
  if (recipe.kbps === 0) {
    ffmpeg([...sound, "-c:a", "aac", "-b:a", "96k", next]);
  } else {
    // Noise over the pattern so the encoder spends its bitrate (a test pattern alone compresses to nothing).
    const picture = `${recipe.look}=size=640x360:rate=30:duration=${recipe.seconds},noise=alls=24:allf=t`;
    ffmpeg([
      "-f", "lavfi", "-i", picture, ...sound,
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-b:v", `${recipe.kbps}k`, "-maxrate", `${recipe.kbps}k`, "-bufsize", `${recipe.kbps * 2}k`,
      // A keyframe every 8 s exactly, B-frames as Axon's encoder makes them.
      "-g", "240", "-keyint_min", "240", "-sc_threshold", "0", "-bf", "2",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      // No +faststart: the index stays at the end, as Axon's files have it.
      "-movflags", "-faststart", "-threads", "8",
      next,
    ]);
  }
  fs.renameSync(next, path);
}

/** The footage, made if it isn't there yet. */
export function footage(root: string): { clips: Map<string, Clip>; axon: Clip; long2: Clip; recordings: Clip[]; noise: Clip; sound: Clip; speech: Clip } {
  const dir = join(root, "footage", recipeHash);
  fs.mkdirSync(dir, { recursive: true });
  const clips = new Map<string, Clip>();
  const done = join(dir, "made.json");
  if (fs.existsSync(done)) {
    for (const clip of JSON.parse(fs.readFileSync(done, "utf8")) as Clip[]) clips.set(clip.name, clip);
  } else {
    // An older recipe's footage goes.
    for (const old of fs.readdirSync(join(root, "footage"))) if (old !== recipeHash) fs.rmSync(join(root, "footage", old), { recursive: true, force: true });
    const started = Date.now();
    for (const recipe of [...RECIPES, SOUND]) {
      const path = join(dir, recipe.name);
      make(recipe, path);
      clips.set(recipe.name, { name: recipe.name, path, size: fs.statSync(path).size, seconds: recipe.seconds, md5: md5(path) });
    }
    const noise = join(dir, NOISE);
    // A megabyte of noise named .mp4: what an unreadable recording looks like from here.
    const bytes = Buffer.alloc(1 << 20);
    let seed = 1;
    for (let i = 0; i < bytes.length; i++) bytes[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    fs.writeFileSync(noise, bytes);
    clips.set(NOISE, { name: NOISE, path: noise, size: bytes.length, seconds: 0, md5: md5(noise) });
    const speech = join(dir, SPEECH);
    ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "2", "-c:a", "libmp3lame", "-b:a", "64k", speech]);
    clips.set(SPEECH, { name: SPEECH, path: speech, size: fs.statSync(speech).size, seconds: 2, md5: md5(speech) });
    fs.writeFileSync(done, JSON.stringify([...clips.values()], null, 1));
    console.log(`footage made in ${Math.round((Date.now() - started) / 1000)} s (${dir})`);
  }
  const get = (name: string) => clips.get(name) ?? (() => { throw new Error(`no footage ${name}`); })();
  return {
    clips,
    axon: get(RECIPES[0]!.name),
    long2: get(RECIPES[4]!.name),
    recordings: [get(RECIPES[1]!.name), get(RECIPES[2]!.name), get(RECIPES[3]!.name)],
    noise: get(NOISE),
    sound: get(SOUND.name),
    speech: get(SPEECH),
  };
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(process.env.HOME ?? "", ".cache", "edit-bad-day");
  const made = footage(root);
  for (const clip of made.clips.values()) console.log(`${clip.name}  ${(clip.size / 1e6).toFixed(1)} MB  ${clip.seconds} s`);
}
