// The relay's channels route (relay/src/channels.ts): any link to a channel, as pasted, read into its YouTube channel.

import { afterEach, describe, expect, it, vi } from "vitest";
import { channelVideos, lookupOf, resolveChannel } from "../../../relay/src/channels";

const ID = "UC" + "x".repeat(22);

describe("a pasted link", () => {
  it("is read as an id, a handle, a user, a video or a name to search", () => {
    expect(lookupOf(ID)).toEqual({ by: "id", value: ID });
    expect(lookupOf(`https://www.youtube.com/channel/${ID}/videos`)).toEqual({ by: "id", value: ID });
    expect(lookupOf("@DrInsanity")).toEqual({ by: "forHandle", value: "@DrInsanity" });
    expect(lookupOf("https://www.youtube.com/@DrInsanity/videos")).toEqual({ by: "forHandle", value: "@DrInsanity" });
    expect(lookupOf("youtube.com/@DrInsanity")).toEqual({ by: "forHandle", value: "@DrInsanity" });
    expect(lookupOf("https://m.youtube.com/@DrInsanity/shorts?si=abc")).toEqual({ by: "forHandle", value: "@DrInsanity" });
    expect(lookupOf("DrInsanity")).toEqual({ by: "forHandle", value: "@DrInsanity" });
    expect(lookupOf("https://www.youtube.com/user/drinsanity")).toEqual({ by: "forUsername", value: "drinsanity" });
    expect(lookupOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toEqual({ by: "video", value: "dQw4w9WgXcQ" });
    expect(lookupOf("https://youtu.be/dQw4w9WgXcQ")).toEqual({ by: "video", value: "dQw4w9WgXcQ" });
    expect(lookupOf("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toEqual({ by: "video", value: "dQw4w9WgXcQ" });
    expect(lookupOf("https://www.youtube.com/c/DrInsanity")).toEqual({ by: "search", value: "DrInsanity" });
    expect(lookupOf("Dr Insanity")).toEqual({ by: "search", value: "Dr Insanity" });
    expect(() => lookupOf("")).toThrow("Paste a link");
    expect(() => lookupOf("https://example.com/@x")).toThrow("isn't a YouTube link");
    expect(() => lookupOf("https://www.youtube.com/results?search_query=x")).toThrow("isn't to a channel");
  });
});

describe("resolving it", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks YouTube for the channel (a video's, by its channel) and keeps what mamagi takes", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      asked.push(`${url.pathname.split("/").pop()} ${[...url.searchParams].filter(([key]) => key !== "key" && key !== "part").map(([key, value]) => `${key}=${value}`).join("&")}`);
      if (url.pathname.endsWith("/videos")) return Response.json({ items: [{ snippet: { channelId: ID } }] });
      return Response.json({
        items: [{
          id: ID,
          snippet: { title: "Dr Insanity", description: "Bodycam breakdowns.", customUrl: "@drinsanity", publishedAt: "2019-01-01T00:00:00Z", thumbnails: { high: { url: "https://yt3.ggpht.com/a" } } },
          statistics: { subscriberCount: "1200000", videoCount: "310", viewCount: "900000000", hiddenSubscriberCount: false },
          contentDetails: { relatedPlaylists: { uploads: "UU" + "x".repeat(22) } },
          brandingSettings: { image: { bannerExternalUrl: "https://yt3.ggpht.com/b" } },
        }],
      });
    });
    const found = await resolveChannel("https://youtu.be/dQw4w9WgXcQ", { YOUTUBE_API_KEY: "k" });
    expect(asked).toEqual(["videos id=dQw4w9WgXcQ", `channels id=${ID}`]);
    expect(found).toEqual({ youtubeId: ID, handle: "drinsanity", title: "Dr Insanity", description: "Bodycam breakdowns.", avatar: "https://yt3.ggpht.com/a", banner: "https://yt3.ggpht.com/b", uploads: "UU" + "x".repeat(22), subscribers: 1200000, videos: 310, views: 900000000, publishedAt: "2019-01-01T00:00:00Z" });
  });

  it("says when there's no such channel, or no key", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ items: [] }));
    await expect(resolveChannel("@nobody", { YOUTUBE_API_KEY: "k" })).rejects.toThrow("No channel found");
    await expect(resolveChannel("@nobody", {})).rejects.toThrow("not configured");
  });
});

describe("a channel's videos", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("are its most viewed by YouTube's search, or its newest from its uploads, each with its numbers and length", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      const path = url.pathname.split("/").pop();
      asked.push(path ?? "");
      if (path === "channels") return Response.json({ items: [{ id: ID, snippet: { title: "Dr Insanity" }, contentDetails: { relatedPlaylists: { uploads: "UU" + "x".repeat(22) } } }] });
      if (path === "search") return Response.json({ items: [{ id: { videoId: "aaaaaaaaaaa" } }, { id: { videoId: "bbbbbbbbbbb" } }] });
      if (path === "playlistItems") return Response.json({ items: [{ contentDetails: { videoId: "bbbbbbbbbbb" } }] });
      return Response.json({
        items: [
          { id: "bbbbbbbbbbb", snippet: { title: "Second", publishedAt: "2026-01-02T00:00:00Z", thumbnails: { high: { url: "https://i.ytimg.com/b.jpg" } } }, statistics: { viewCount: "10" }, contentDetails: { duration: "PT45S" } },
          { id: "aaaaaaaaaaa", snippet: { title: "First" }, statistics: { viewCount: "2000000", likeCount: "9" }, contentDetails: { duration: "PT1H2M3S" } },
        ],
      });
    });
    const top = await channelVideos(ID, "top", 10, { YOUTUBE_API_KEY: "k" });
    expect(top.channel).toEqual({ youtubeId: ID, title: "Dr Insanity" });
    // In the order YouTube ranked them, not the order the details came back in.
    expect(top.videos.map((one) => one.id)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(top.videos[0]).toEqual({ id: "aaaaaaaaaaa", title: "First", seconds: 3723, views: 2000000, likes: 9 });
    expect(top.videos[1]?.thumbnail).toBe("https://i.ytimg.com/b.jpg");
    expect(asked).toEqual(["channels", "search", "videos"]);
    asked.length = 0;
    const recent = await channelVideos(ID, "recent", 10, { YOUTUBE_API_KEY: "k" });
    expect(recent.videos.map((one) => one.seconds)).toEqual([45]);
    expect(asked).toEqual(["channels", "playlistItems", "videos"]);
  });
});
