// A YouTube import's title, looked up before its download: from YouTube's Data API through the relay (a second), as
// its check is, and once. Until Nov 22 it was asked of yt-dlp through the proxy (17 s to a minute) twice, once by the
// import and once more naming the file, while the bar said "5% Starting." for the whole of it.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as ytWriter from "../../src/writer/youtube.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
});
afterAll(() => {
  restore();
  mock.stop();
});

test("a YouTube video's title comes from the Data API, once, never from yt-dlp through the proxy", async () => {
  const { app, cleanup } = fixtureHome("youtube-title");
  try {
    const id = "TitleOnce01";
    let asked = 0;
    mock.on("GET", "/v1/youtube/check", () => (asked++, Response.json({ videos: { [id]: { title: "The interview", channel: "Someone", durationSeconds: 18, live: "none", ageRestricted: false, privacy: "public" } } })));
    const url = `https://www.youtube.com/watch?v=${id}`;
    expect(await ytWriter.title(app, url)).toBe("The interview");
    expect(await ytWriter.title(app, url)).toBe("The interview");
    expect(asked).toBe(1);
  } finally {
    cleanup();
  }
});
