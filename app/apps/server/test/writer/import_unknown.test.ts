// What a Script import's failure is decides whether it waits or stops (writer/imports.ts). Until Nov 22 a failure
// nothing recognised stopped the import as the person's to fix, with "The import stopped"; the editor's import waits
// those out. Now it waits too, and the import's own refusals the person answers are said as theirs.

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import * as jobs from "../../src/jobs.ts";
import * as macSpeech from "../../src/mac_speech.ts";
import * as tools from "../../src/tools.ts";
import { timing } from "../../src/transcribe.ts";
import * as drive from "../../src/writer/drive.ts";
import * as imports from "../../src/writer/imports.ts";
import * as store from "../../src/writer/store.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

const FOLDER = "1UnknownFailureFolder0001";
const URL_ = `https://drive.google.com/drive/folders/${FOLDER}`;
let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  timing.instant = true;
  tools.forget();
  macSpeech.timing.helper = null;
  drive.hooks.accessToken = async () => "mock-access-token";
});
afterAll(() => {
  macSpeech.timing.helper = undefined;
  restore();
  mock.stop();
});

test("a Script import failing for something nobody has named waits and is tried again by itself, rather than stopping as the person's", async () => {
  const { app, cleanup } = fixtureHome("import-unknown");
  const listed = spyOn(drive, "recordings").mockRejectedValue(new Error("something nobody has seen before"));
  try {
    const data = store.dataDir(app.store.home);
    const script = await imports.fromDrive(app, data, URL_, null, null, null);
    expect(script.status).toBe("processing");
    expect(script.error).toBeNull();
    expect(jobs.get(app.store.home, jobs.keyOf("script", script.id))).toMatchObject({ state: "waiting" });
  } finally {
    listed.mockRestore();
    cleanup();
  }
});

test("a Script import of a Drive folder with no recordings stops as the person's to answer, Try again still offered", async () => {
  const { app, cleanup } = fixtureHome("import-no-recordings");
  const listed = spyOn(drive, "recordings").mockResolvedValue(["Empty folder", []]);
  try {
    const data = store.dataDir(app.store.home);
    await imports.fromDrive(app, data, URL_, null, null, null).catch(() => null);
    const [id] = store.ids(data);
    const script = store.read(store.scriptDir(data, id!));
    expect(script.status).toBe("error");
    expect(script.error).toContain("No recordings are left");
    expect(script.stuckOn).toBeUndefined();
    expect(fs.existsSync(store.scriptDir(data, id!))).toBe(true);
  } finally {
    listed.mockRestore();
    cleanup();
  }
});
