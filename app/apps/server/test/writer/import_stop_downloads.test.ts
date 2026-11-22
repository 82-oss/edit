// Deleting a script stops its import (imports.ts `stop`), and with it the recordings still coming down: the import's
// fiber was interrupted but its Drive downloads were promises it never told, so they ran on to the end (Nov 21 audit).

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as macSpeech from "../../src/mac_speech.ts";
import * as tools from "../../src/tools.ts";
import { timing } from "../../src/transcribe.ts";
import * as drive from "../../src/writer/drive.ts";
import * as imports from "../../src/writer/imports.ts";
import * as store from "../../src/writer/store.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

const FOLDER = "1StopDownloadsFolder00001";
const FILE = "1StopDownloadsFile0000001";
const SIZE = 50_000_000;
let mock: MockServer;
let restore: () => void;
let sent = 0;
let cancelled = false;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  timing.instant = true;
  tools.forget();
  macSpeech.timing.helper = null;
  drive.hooks.accessToken = async () => "mock-access-token";
  mock.on("GET", `/www.googleapis.com/drive/v3/files/${FOLDER}`, () => Response.json({ name: "Stopped case" }));
  mock.on("GET", "/www.googleapis.com/drive/v3/files", (request) =>
    Response.json({ files: (request.query.get("q") ?? "").includes(FOLDER) ? [{ id: FILE, name: "Recording 1.mp4", mimeType: "video/mp4", size: String(SIZE) }] : [] }),
  );
  // A slow recording: a little every 50 ms, for far longer than the test.
  mock.on("GET", `/www.googleapis.com/drive/v3/files/${FILE}`, (request) => {
    if (request.query.get("alt") !== "media") return Response.json({ id: FILE, name: "Recording 1.mp4", size: String(SIZE) });
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          sent += 1000;
          controller.enqueue(new Uint8Array(1000));
        }, 50);
      },
      cancel() {
        cancelled = true;
        clearInterval(timer);
      },
    });
    return new Response(body, { headers: { "content-type": "video/mp4", "content-length": String(SIZE) } });
  });
});
afterAll(() => {
  macSpeech.timing.helper = undefined;
  restore();
  mock.stop();
});

test("a stopped import (its script deleted) stops the recordings it was downloading", async () => {
  const { app, cleanup } = fixtureHome("import-stop-downloads");
  try {
    const data = store.dataDir(app.store.home);
    const script = await imports.fromDrive(app, data, `https://drive.google.com/drive/folders/${FOLDER}`, null, null, null, null, "started");
    for (let i = 0; i < 200 && sent === 0; i++) await Bun.sleep(25);
    expect(sent).toBeGreaterThan(0);
    expect(await imports.stop(script.id)).toBe(true);
    for (let i = 0; i < 40 && !cancelled; i++) await Bun.sleep(25);
    expect(cancelled).toBe(true);
  } finally {
    cleanup();
  }
}, 30_000);
