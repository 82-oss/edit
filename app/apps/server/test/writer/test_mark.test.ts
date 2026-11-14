// Test scripts (writer/store.ts TEST_FILE; Sphe, Nov 14: "there are a lot of dev scripts that also need to go
// through the hiding"): one a person didn't start is marked when it's made, in a file of its own, listed with the
// mark, kept when an import writes the script back, brought forth, and cleared.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as commentary from "../../src/writer/commentary.ts";
import * as store from "../../src/writer/store.ts";

const ID = "5c2f2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function made(): { data: string; dir: string; script: Script } {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-test-mark-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  const script = { id: ID, title: "L7 trooper_ctl: CORRUPT Trooper", sourceKind: "youtube", sourceUrl: "", originalPath: join(dir, "original.mp4"), status: "processing", stage: "downloading", progress: 8, error: null, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [], kind: "courtroom" } as unknown as Script;
  store.write(dir, script);
  return { data, dir, script };
}

const listed = (data: string) => store.list(data).find((one) => one.id === ID);

test("a test script is listed as one, kept so when an import writes it back, shown when asked, and promoted", () => {
  const { data, dir, script } = made();
  expect(listed(data)?.test).toBeUndefined();
  store.writeTest(dir, true);
  expect(listed(data)).toMatchObject({ test: true });
  expect(listed(data)?.shown).toBeUndefined();
  // The import still running writes the script it holds: the mark stays.
  store.write(dir, { ...script, progress: 40 });
  expect(store.summary(store.read(dir), dir).test).toBe(true);
  store.writeTest(dir, true, true);
  expect(listed(data)).toMatchObject({ test: true, shown: true });
  // Promoted: a file saying so (the clearing syncs too), and no mark.
  store.writeTest(dir, false);
  expect(fs.existsSync(join(dir, store.TEST_FILE))).toBe(true);
  expect(listed(data)?.test).toBeUndefined();
  expect(listed(data)?.shown).toBeUndefined();
});

test("only a script this computer has is marked; a real one never gets a file", () => {
  const { data, dir } = made();
  store.writeTest(dir, false);
  expect(fs.existsSync(join(dir, store.TEST_FILE))).toBe(false);
  expect(() => store.writeTest(store.scriptDir(data, "9b1f2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"), true)).toThrow("isn't on this computer");
});

test("a commentary is a test script unless a person started it", async () => {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-test-mark-"));
  const trial = await commentary.create(data, "Skills check", [], undefined, true);
  const real = await commentary.create(data, "Real Crimes Behind Adult Videos", [], undefined);
  expect(store.readTest(store.scriptDir(data, trial.id)).test).toBe(true);
  expect(store.readTest(store.scriptDir(data, real.id)).test).toBe(false);
});
