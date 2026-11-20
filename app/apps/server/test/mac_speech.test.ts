import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import * as macSpeech from "../src/mac_speech.ts";
import { scratch } from "./helpers/home.ts";

const dir = scratch("mac-speech");
afterAll(() => dir.cleanup());

// macOS 26 is Darwin 25: there, a checkout builds edit-speech on demand.
const mac26 = process.platform === "darwin" && Number(os.release().split(".")[0]) >= 25;
const built = await macSpeech.available();
// Hearing needs Apple's model, downloaded on first use: not something GitHub's
// virtual Mac can be counted on for, so there only the build is checked.
const here = built && process.env.GITHUB_ACTIONS === undefined;

test.skipIf(!mac26)("on macOS 26 edit-speech builds and is available", () => {
  expect(built).toBe(true);
});

test("with no helper, on-device speech isn't available and hearing says why", async () => {
  macSpeech.timing.helper = `${dir.dir}/no-such-edit-speech`;
  try {
    expect(await macSpeech.available()).toBe(false);
    macSpeech.timing.helper = null;
    expect(await macSpeech.available()).toBe(false);
    await expect(macSpeech.hear(`${dir.dir}/a.wav`, `${dir.dir}/a.json`)).rejects.toThrow(/macOS 26/u);
  } finally {
    macSpeech.timing.helper = undefined;
  }
});

// A stand-in helper that says what the real one says while the model comes down, then answers two words.
test.skipIf(!mac26)("what the helper says as it goes reaches the caller line by line, the model's download first", async () => {
  const fake = `${dir.dir}/fake-edit-speech`;
  fs.writeFileSync(fake, '#!/bin/sh\necho "speech: downloading the en-US model" >&2\nsleep 0.1\necho "speech: model 40%" >&2\necho "speech: model installed" >&2\necho "speech: read 50%" >&2\nprintf \'{"words":[{"text":"Hello","start":0,"end":0.4},{"text":"there.","start":0.5,"end":0.9}],"language":"en-US","ms":120,"model":"apple-speech","seconds":1}\'\n');
  fs.chmodSync(fake, 0o755);
  macSpeech.timing.helper = fake;
  try {
    const said: string[] = [];
    const heard = await macSpeech.hear(`${dir.dir}/any.wav`, `${dir.dir}/fake.json`, undefined, (line) => said.push(line));
    expect(said).toEqual(["downloading the en-US model", "model 40%", "model installed", "read 50%"]);
    expect(heard.words.map((word) => word.text)).toEqual(["Hello", "there."]);
  } finally {
    macSpeech.timing.helper = undefined;
  }
});

test.skipIf(!here)("a spoken clip is heard on this Mac as timed words, written as Edit's transcript", async () => {
  const clip = `${dir.dir}/spoken.aiff`;
  const said = Bun.spawnSync(["say", "-o", clip, "The officer knocked on the door and asked the man to step outside."]);
  expect(said.exitCode).toBe(0);
  const target = `${dir.dir}/out/spoken.json`;
  const heard = await macSpeech.hear(clip, target);
  expect(heard.model).toBe(macSpeech.MODEL);
  expect(macSpeech.MODEL).toBe("apple-speech");
  expect(heard.language).toBe("en-US");
  const text = heard.words.map((word) => word.text.toLowerCase().replace(/[^a-z]/gu, "")).join(" ");
  expect(text).toContain("officer knocked on the door");
  for (const [index, word] of heard.words.entries()) {
    expect(word.speaker).toBeUndefined();
    expect(word.end).toBeGreaterThanOrEqual(word.start);
    if (index > 0) expect(word.start).toBeGreaterThanOrEqual(heard.words[index - 1]!.start);
  }
  expect(heard.words.at(-1)!.start).toBeGreaterThan(heard.words[0]!.start);
  const saved = JSON.parse(fs.readFileSync(target, "utf8"));
  expect(saved.model).toBe("apple-speech");
  expect(saved.words).toEqual(heard.words);
}, 120_000);

test.skipIf(!here)("an unreadable file is refused with the helper's reason", async () => {
  const bad = `${dir.dir}/bad.wav`;
  fs.writeFileSync(bad, "not sound");
  await expect(macSpeech.hear(bad, `${dir.dir}/bad.json`)).rejects.toThrow(/can't read bad\.wav/u);
  expect(fs.existsSync(`${dir.dir}/bad.json`)).toBe(false);
}, 60_000);

test.skipIf(!here)("an aborted hearing stops and rejects", async () => {
  const clip = `${dir.dir}/long.aiff`;
  Bun.spawnSync(["say", "-o", clip, "One two three four five six seven eight nine ten. ".repeat(6)]);
  const controller = new AbortController();
  const heard = macSpeech.hear(clip, `${dir.dir}/long.json`, controller.signal);
  setTimeout(() => controller.abort(), 300);
  await expect(heard).rejects.toThrow();
  expect(fs.existsSync(`${dir.dir}/long.json`)).toBe(false);
}, 60_000);

// Nov 20: a helper stuck (its first model download with the Wi-Fi gone) held every Script import behind it.
test("a helper that hangs is stopped after the quiet limit with a passing error, and the next hearing in the queue goes", async () => {
  const failure = await import("../src/failure.ts");
  const wake = await import("../src/wake.ts");
  const hung = `${dir.dir}/hung-edit-speech`;
  fs.writeFileSync(hung, '#!/bin/sh\necho "speech: downloading the en-US model" >&2\nexec sleep 600\n');
  fs.chmodSync(hung, 0o755);
  const good = `${dir.dir}/good-edit-speech`;
  fs.writeFileSync(good, '#!/bin/sh\nprintf \'{"words":[{"text":"Hello","start":0,"end":0.4}],"language":"en-US","ms":10,"seconds":1}\'\n');
  fs.chmodSync(good, 0o755);
  const before = { ...macSpeech.LIMITS };
  macSpeech.LIMITS.quietMs = 400;
  macSpeech.timing.helper = hung;
  try {
    const began = Date.now();
    const first = macSpeech.hear(`${dir.dir}/none.wav`, `${dir.dir}/hung.json`);
    // A wake while it hangs starts its clock again: not stopped for the time the lid was shut.
    await Bun.sleep(250);
    wake.woke(15 * 60_000);
    const error = await first.then(() => null, (failed: unknown) => failed);
    expect(error).toBeInstanceOf(failure.StoodStill);
    expect(failure.kindOf(error)).toBe("passing");
    expect(Date.now() - began).toBeGreaterThanOrEqual(600);
    macSpeech.timing.helper = good;
    const heard = await macSpeech.hear(`${dir.dir}/none.wav`, `${dir.dir}/good.json`);
    expect(heard.words.map((word) => word.text)).toEqual(["Hello"]);
  } finally {
    Object.assign(macSpeech.LIMITS, before);
    macSpeech.timing.helper = undefined;
  }
}, 20_000);

const ffmpeg = Bun.which("ffmpeg");
test.skipIf(ffmpeg === null)("a helper that keeps talking but never finishes is stopped at twice the audio's length (at least the floor)", async () => {
  const failure = await import("../src/failure.ts");
  const chatty = `${dir.dir}/chatty-edit-speech`;
  fs.writeFileSync(chatty, '#!/bin/sh\nwhile true; do echo "speech: read 1%" >&2; sleep 0.1; done\n');
  fs.chmodSync(chatty, 0o755);
  const audio = `${dir.dir}/short.wav`;
  expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=0.2", audio]).exitCode).toBe(0);
  const before = { ...macSpeech.LIMITS };
  Object.assign(macSpeech.LIMITS, { quietMs: 5_000, leastMs: 700, perAudio: 2 });
  macSpeech.timing.helper = chatty;
  try {
    const error = await macSpeech.hear(audio, `${dir.dir}/chatty.json`).then(() => null, (failed: unknown) => failed);
    expect(error).toBeInstanceOf(failure.StepTimedOut);
    expect(failure.kindOf(error)).toBe("passing");
  } finally {
    Object.assign(macSpeech.LIMITS, before);
    macSpeech.timing.helper = undefined;
  }
}, 20_000);
