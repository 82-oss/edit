// Loaded before every test file (bunfig.toml): a run never uses this Mac's
// own Chrome sign-in to YouTube (youtube_signin.ts); tests that want one turn
// it on against a stand-in Chrome folder.
process.env.EDIT_YOUTUBE_SIGNIN = "0";
// Nor the live relay: a test without its own mock relay (mocks/server.ts useEnv) asks a closed port, so a
// relay check it makes (voices.ts' pyannote flag, Nov 9: the live relay's "on" sent a captions test to Scribe)
// is "unreachable", never production's answer.
process.env.EDIT_RELAY_URL ??= "http://127.0.0.1:9";
// A busy model is asked again after a pause (cast.ts): none in tests.
import { busyTiming } from "../src/cast.ts";
busyTiming.waitMs = 0;
// CI's Macs are virtual: Chrome on their paravirtual graphics card draws a frame 2.5-3.5x slower than on the CPU
// (Nov 16: a screenshot 280-330 ms against 130, a full-size JPEG 276 ms against 76; the effects tests ~4 minutes
// of Check). A team Mac's card is what Edit draws on, so only tests there draw on the CPU.
import { drawing } from "../src/chrome_devtools.ts";
if (process.env.CI === "true" && process.platform === "darwin") drawing.gpu = false;
// Edit asks Claude (ai_claude.ts, watch.ts); in tests the mock server's
// stand-in model answers instead (mocks/model.ts).
import { standIn } from "../src/ai_claude.ts";
import { post as standInPost } from "./mocks/model.ts";
standIn.post = standInPost;
// A lesson is checked against what's taught by a model (teaching_conflicts.ts): none in tests unless one says so.
import { hooks as teachingConflictHooks } from "../src/teaching_conflicts.ts";
teachingConflictHooks.ask = async () => ({ conflicts: [] });
// Every temporary folder a run makes is inside one of its own, removed when the run ends (Nov 13: runs had
// left 7,600 folders, 4.3 GB, in a /tmp that's memory on the Linux machine). One a killed run left goes the
// next time, once a day old.
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
const RUNS = "edit-test-run-";
const shared = os.tmpdir();
for (const name of fs.readdirSync(shared)) {
  if (!name.startsWith(RUNS)) continue;
  try {
    if (Date.now() - fs.statSync(join(shared, name)).mtimeMs > 24 * 3600_000) fs.rmSync(join(shared, name), { recursive: true, force: true });
  } catch {
    // Another run's, going now.
  }
}
const own = fs.mkdtempSync(join(shared, RUNS));
process.env.TMPDIR = own;
process.on("exit", () => fs.rmSync(own, { recursive: true, force: true }));
