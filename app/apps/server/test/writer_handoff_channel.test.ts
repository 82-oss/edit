// writer_handoff.ts: an edit made from a channel's script is that channel's
// V2 edit on every computer. Nov 21 (docs/v1-to-v2.md, step 1): with Edit V2
// off on a Mac, Start edit on a channel's script quietly made a V1 edit with a
// style guessed from the script, out of its channel, its teaching and its tools.

import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import * as script from "../src/script.ts";
import * as writerStore from "../src/writer/store.ts";
import { importScript } from "../src/writer_handoff.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
let started: ReturnType<typeof spyOn>;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  // The import after the project is made (footage, words, layout) isn't what's tested here.
  started = spyOn(script, "start").mockImplementation(() => null);
});

afterAll(() => {
  started.mockRestore();
  restore();
  mock.stop();
});

afterEach(() => {
  mock.cloud.convex.channels = [];
  accounts.resetForTests();
});

const CHANNEL = {
  key: "ch-ted", youtubeId: "UC" + "t".repeat(22), handle: "inspectorted", title: "Inspector Ted", description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0,
  narration: { kind: "voice" as const, id: "v123", name: "Andrew" }, compilation: false, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, archived: false, addedBy: null, at: 0,
};

let next = 0;
/** A finished Writer script on this computer, a channel's when `channel` is given; an interrogation by its category. */
function written(home: string, channel?: string): string {
  next += 1;
  const id = `6b1f0c2e-3a4d-4e5f-9a8b-7c6d5e4f3a${String(next).padStart(2, "0")}`;
  const dir = writerStore.scriptDir(writerStore.dataDir(home), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "script.json"), JSON.stringify({
    id, title: `Case ${next}`, kind: "interrogation", ...(channel !== undefined ? { channel } : {}), sourceKind: "youtube", sourceUrl: "https://youtu.be/dslLBsHkVzE",
    status: "ready", stage: "ready", revision: 1, updatedAt: 1, durationMs: 20_000, originalPath: join(dir, "proxy.mp4"),
    clips: [{ id: "c1", startMs: 1_000, endMs: 4_000 }], words: [],
  }));
  return id;
}

const v2 = (home: string, on: boolean) => fs.writeFileSync(join(home, "beta.json"), JSON.stringify({ v2: on }));

test("a channel's script makes that channel's V2 edit with Edit V2 off on this computer, as it does with it on", async () => {
  const { app, cleanup } = fixtureHome("handoff-channel");
  try {
    mock.cloud.convex.channels = [CHANNEL];
    for (const on of [false, true]) {
      v2(app.store.home, on);
      const made = await importScript(app, written(app.store.home, CHANNEL.key));
      const project = app.store.get(made.project)!.project;
      // Narrated by a voice: bodycam (channels.styleOf), never the script's category's interrogation.
      expect({ on, hq: project.hq, channel: project.channel, style: project.style }).toEqual({ on, hq: true, channel: CHANNEL.key, style: "bodycam" });
    }
  } finally {
    cleanup();
  }
});

test("a script with no channel makes today's kind of edit, Edit V2 on or off", async () => {
  const { app, cleanup } = fixtureHome("handoff-no-channel");
  try {
    for (const on of [false, true]) {
      v2(app.store.home, on);
      const made = await importScript(app, written(app.store.home));
      const project = app.store.get(made.project)!.project;
      expect({ on, hq: project.hq ?? false, channel: project.channel ?? null, style: project.style }).toEqual({ on, hq: false, channel: null, style: "interrogation" });
    }
  } finally {
    cleanup();
  }
});

test("a channel's script whose channel can't be read is refused in words that say what to do, and nothing is made, never a V1 edit", async () => {
  const { app, cleanup } = fixtureHome("handoff-channel-refused");
  try {
    v2(app.store.home, false);
    const before = app.store.list().length;
    // Signed out: the channel can't be read.
    const back = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
    try {
      await expect(importScript(app, written(app.store.home, CHANNEL.key))).rejects.toThrow("This script is a channel's: sign in to Edit on this computer, then start its edit again.");
    } finally {
      back();
    }
    // Not given to this person, or gone: said without its key.
    const gone = importScript(app, written(app.store.home, CHANNEL.key));
    await expect(gone).rejects.toThrow("This script's channel isn't in Edit, or isn't shown to your account: ask an admin to give it to you, then start its edit again.");
    // Put away.
    mock.cloud.convex.channels = [{ ...CHANNEL, archived: true }];
    await expect(importScript(app, written(app.store.home, CHANNEL.key))).rejects.toThrow("Inspector Ted was put away: an admin can bring it back (add it again), then start its edit again.");
    expect(app.store.list().length).toBe(before);
  } finally {
    cleanup();
  }
});
