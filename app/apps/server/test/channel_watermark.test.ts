// A channel's watermark (Sphe, Nov 16: "show watermarks when available for
// that specific channel"): linked to the channel by its picture's Drive id,
// never its name. What the Export dialog is offered (GET /api/watermarks), and
// what an export of a channel's project carries; a project of no channel (V1)
// keeps the folder's pictures to pick from.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as channelMarks from "../src/channel_marks.ts";
import * as channels from "../src/channels.ts";
import { respond } from "../src/http/server.ts";
import * as reviews from "../src/reviews.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";

const lanes = { ideas: "", thumbnails: "", script: "", edit: "" };
const channel = (key: string, title: string, watermark?: string | null): channels.Channel => ({
  key, youtubeId: null, handle: null, title, description: "", avatar: null, banner: null, uploads: null, subscribers: null, videos: null, views: null, country: null, publishedAt: null, fetchedAt: 0,
  narration: null, compilation: false, lanes, archived: false, addedBy: null, at: 0, ...(watermark === undefined ? {} : { watermark }),
});
const SI = channel("ch-6efba6498c", "Sam's Interrogations", "pic-si");
const GTA = channel("ch-bcbfe704b8", "GTA 6 Channel", null);
// A mamagi before watermarks says nothing of it: none.
const OLD = channel("ch-0c19c2bb19", "Sam's Bodycam");
const PICTURES = [
  channelMarks.channelOf({ id: "pic-si", name: "SI_watermark.png" }),
  channelMarks.channelOf({ id: "pic-ted", name: "InspectorTed_watermark_under.png" }),
  channelMarks.channelOf({ id: "pic-sb", name: "SB_watermark.png" }),
];

afterEach(() => {
  channels.useChannelsForTests([]);
  channelMarks.usePicturesForTests([]);
});

function home(name: string) {
  const fixture = fixtureHome(name);
  const router = buildRouter();
  const ask = async (method: string, path: string, body?: unknown) => {
    const response = (await respond(fixture.app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const project = async (title: string, key?: string) => {
    const id = fixture.app.store.create(title, { width: 1920, height: 1080, fps: 30 }).project.id;
    if (key !== undefined)
      await fixture.app.store.update(id, "test", (one) => {
        one.channel = key;
      });
    return id;
  };
  return { ...fixture, ask, project };
}

test("the dialog of a channel's project is offered its channel's logo alone, by the channel's name now; one with none is offered nothing", async () => {
  const { ask, project, cleanup } = home("watermark-offer");
  try {
    channels.useChannelsForTests([SI, GTA, OLD]);
    channelMarks.usePicturesForTests(PICTURES);
    const si = await project("Interrogation", SI.key);
    expect((await ask("GET", `/api/watermarks?project=${si}`)).body).toEqual({ channel: { key: SI.key, name: "Sam's Interrogations" }, channels: [{ id: "pic-si", code: "SI", name: "Sam's Interrogations" }] });
    // Renamed: the same logo, under its name now.
    channels.useChannelsForTests([{ ...SI, title: "Sam's Interrogation Room" }, GTA, OLD]);
    expect((await ask("GET", `/api/watermarks?project=${si}`)).body).toMatchObject({ channels: [{ id: "pic-si", name: "Sam's Interrogation Room" }] });
    // The GTA 6 project that was offered Sams Interrogations (Nov 16): nothing now; nor a channel from before watermarks.
    expect((await ask("GET", `/api/watermarks?project=${await project("GTA", GTA.key)}`)).body).toEqual({ channel: { key: GTA.key, name: "GTA 6 Channel" }, channels: [] });
    expect((await ask("GET", `/api/watermarks?project=${await project("Bodycam", OLD.key)}`)).body).toMatchObject({ channels: [] });
    // Its picture gone from the folder: nothing, rather than a logo that can't be fetched.
    channelMarks.usePicturesForTests(PICTURES.filter((one) => one.id !== "pic-si"));
    expect((await ask("GET", `/api/watermarks?project=${si}`)).body).toMatchObject({ channels: [] });
    // A channel this computer can't read is said, not taken for a project of no channel.
    channels.useChannelsForTests([]);
    expect((await ask("GET", `/api/watermarks?project=${si}`)).status).toBe(400);
  } finally {
    cleanup();
  }
});

test("a project of no channel (V1) picks from every picture in the folder as before, a linked one named by its channel", async () => {
  const { ask, project, cleanup } = home("watermark-v1");
  try {
    channelMarks.usePicturesForTests(PICTURES);
    const v1 = await project("Bodycam");
    // No channels read (V2 off, or none seen): the files' names, nothing to start on but the first.
    expect((await ask("GET", `/api/watermarks?project=${v1}`)).body).toEqual({
      channel: null,
      channels: [{ id: "pic-ted", code: "InspectorTed", name: "Inspector Ted" }, { id: "pic-sb", code: "SB", name: "SB" }, { id: "pic-si", code: "SI", name: "SI" }],
      usual: null,
    });
    // A picture linked to a channel this person sees: named by it, and the one to start on.
    channels.useChannelsForTests([SI, GTA]);
    expect((await ask("GET", "/api/watermarks")).body).toMatchObject({ channels: [{ name: "Inspector Ted" }, { name: "Sam's Interrogations" }, { name: "SB" }], usual: "pic-si" });
    // Seen by its label alone: its logo isn't named by it.
    channels.useChannelsForTests([{ ...SI, title: "Channel 3", masked: true }]);
    expect((await ask("GET", "/api/watermarks")).body).toMatchObject({ channels: [{ name: "Inspector Ted" }, { name: "SB" }, { name: "SI" }], usual: null });
  } finally {
    cleanup();
  }
});

test("a V1 dialog starts on the picture picked most on this computer", () => {
  channels.useChannelsForTests([SI]);
  expect(channelMarks.offerFor(null, PICTURES, ["pic-sb", "pic-ted", "pic-sb", "gone"]).usual).toBe("pic-sb");
  expect(channelMarks.offerFor(null, PICTURES, []).usual).toBe("pic-si");
});

test("an export of a channel's project carries its channel's logo or none, whatever was sent or kept; V1's the one picked", async () => {
  const { app, ask, project, home: dir, cleanup } = home("watermark-export");
  const asked: (string | undefined)[] = [];
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, start: async (..._args: unknown[]) => (asked.push((_args[5] as { watermark?: string }).watermark), "/tmp/out.mp4") };
  try {
    channels.useChannelsForTests([SI, GTA]);
    const si = await project("Interrogation", SI.key);
    const gta = await project("GTA", GTA.key);
    const v1 = await project("Bodycam");
    const markOf = async (id: string, watermark?: string) => {
      asked.length = 0;
      expect((await ask("POST", `/api/projects/${id}/export`, { drive: false, keepLocal: true, ...(watermark === undefined ? {} : { watermark }) })).status).toBe(200);
      expect(asked.length).toBe(1);
      return asked[0];
    };
    expect(await markOf(si, "pic-si")).toBe("pic-si");
    // Another channel's logo sent for it: its own goes on instead.
    expect(await markOf(si, "pic-ted")).toBe("pic-si");
    expect(await markOf(si)).toBeUndefined();
    expect(await markOf(gta, "pic-si")).toBeUndefined();
    expect(await markOf(v1, "pic-ted")).toBe("pic-ted");
    // The review's watermark, as the dialog and Home's Share read it: a GTA project's kept Sams Interrogations is none.
    fs.writeFileSync(nodePath.join(dir, "reviews.json"), JSON.stringify({ cursor: 0, shared: {}, notes: {}, shareWatermark: { [gta]: "pic-si", [si]: "pic-ted", [v1]: "pic-sb" } }));
    expect(reviews.view(app, gta)).toMatchObject({ watermark: null });
    expect(reviews.view(app, si)).toMatchObject({ watermark: "pic-si" });
    expect(reviews.view(app, v1)).toMatchObject({ watermark: "pic-sb" });
    expect(channels.watermarkFor({ channel: SI.key }, undefined)).toBeUndefined();
  } finally {
    cleanup();
  }
});
