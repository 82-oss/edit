// The relay's channels route (relay/src/channels.ts): any link to a channel, as pasted, read into its YouTube channel.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readCutOffsWith, useKeys } from "../../../relay/src/auth";
import { channelRefused } from "../../../relay/src/authz";
import { channelVideos, lookupOf, resolveChannel } from "../../../relay/src/channels";
import relay, { type Env } from "../../../relay/src/index";
import { channelCall, followOf } from "../../../relay/src/live_channels";

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

// ---- One channel list for dev and prod (Nov 16), and a channel's own files ----

const CH = "ch-0123456789";
const person = (perms: string[], admin = false) => ({ kind: "person" as const, sub: "s", perms, admin });

describe("a channel's files (its watermark)", () => {
  it("are read by who sees the channel in full, written by a teacher who does", () => {
    const key = `edit/channels/${CH}/watermark/${"a".repeat(64)}.png`;
    expect(channelRefused(person(["use", `channel.${CH}`]), "read", key)).toBeNull();
    expect(channelRefused(person(["use", `channel.${CH}`]), "write", key)).toMatch(/teacher/);
    expect(channelRefused(person(["use", "agent.teach", `channel.${CH}`]), "write", key)).toBeNull();
    // Its label alone: its logo says whose channel it is.
    expect(channelRefused(person(["use", "agent.teach", `channel.${CH}`, `channel.${CH}.label`]), "read", key)).toMatch(/in full/);
    expect(channelRefused(person(["use", "agent.teach"]), "read", key)).toMatch(/in full/);
    expect(channelRefused(person([], true), "write", key)).toBeNull();
    expect(channelRefused(person(["use"]), "read", "edit/channels/")).toMatch(/isn't a channel's/);
    expect(channelRefused(person(["use"]), "read", "edit/originals/x")).toBeNull();
  });
});

describe("the dev relay's channels, on the live relay", () => {
  let TEACHER = "";
  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    useKeys(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "t1", alg: "RS256" }] }));
    readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
    TEACHER = await new SignJWT({ perms: ["use", "agent.teach", `channel.${CH}`], admin: false, name: "Sphe" }).setProtectedHeader({ alg: "RS256", kid: "t1" }).setIssuer("https://accounts.spheceo.com").setAudience("edit").setSubject("person-t").setIssuedAt().setExpirationTime("1h").sign(privateKey);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterAll(() => {
    useKeys(null);
    readCutOffsWith(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is every call on channels and groups, and a channel's files; nothing else", () => {
    expect(channelCall("convex", { path: "channels:listChannels" })).toBe(true);
    expect(channelCall("convex", { path: "groups:makeGroup" })).toBe(true);
    expect(channelCall("convex", { path: "edit:listLibrary" })).toBe(false);
    expect(channelCall("convex", { path: "groups:followLibrary;x" })).toBe(false);
    expect(channelCall("r2/url", { key: `edit/channels/${CH}/watermark/a.png` })).toBe(true);
    expect(channelCall("r2/head", { key: "edit/originals/sha256/a" })).toBe(false);
    expect(channelCall("jobs/drive", { key: `edit/channels/${CH}/x` })).toBe(false);
  });

  it("goes to the live relay with the caller's own sign-in; a group change is then followed in dev's own library", async () => {
    const live: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const LIVE_RELAY = {
      fetch: async (request: Request) => {
        const body = (await request.json()) as Record<string, unknown>;
        live.push({ path: new URL(request.url).pathname, body, auth: request.headers.get("authorization") });
        if (body.path === "groups:listGroups") return Response.json({ status: "success", value: [{ key: "gr-aaaaaaaaaa", channels: [CH, "ch-9999999999"] }] });
        if (body.path === "groups:archiveGroup") return Response.json({ status: "success", value: { key: "gr-aaaaaaaaaa", archived: true } });
        if (new URL(request.url).pathname === "/v1/cloud/r2/url") return Response.json({ url: "https://prod-r2/put", expires: 3600 });
        return Response.json({ status: "success", value: [{ key: CH, title: "Inspector Ted" }] });
      },
    };
    const own: { path: string; args: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { path: string; args: Record<string, unknown> };
      own.push({ path: body.path, args: body.args });
      return Response.json({ status: "success", value: { moved: 0, copied: 2, folded: 0 } });
    });
    const env = { CHANNELS_UPSTREAM: "https://edit-relay.test", LIVE_RELAY, R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "dev", CONVEX_URL: "https://dev.convex.cloud", CONVEX_SERVICE_TOKEN: "dev-service" } as unknown as Env;
    const call = (route: string, body: unknown) => relay.fetch(new Request(`https://relay-dev.test/v1/cloud/${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TEACHER}` }, body: JSON.stringify(body) }), env);
    const listed = await call("convex", { kind: "query", path: "channels:listChannels", args: { archived: true } });
    expect(await listed.json()).toEqual({ status: "success", value: [{ key: CH, title: "Inspector Ted" }] });
    // As Edit sent it: the live relay adds who's asking and its own token.
    expect(live[0]).toEqual({ path: "/v1/cloud/convex", body: { kind: "query", path: "channels:listChannels", args: { archived: true } }, auth: `Bearer ${TEACHER}` });
    expect(own).toEqual([]);
    // A channel's watermark: presigned on prod's R2.
    expect(await (await call("r2/url", { key: `edit/channels/${CH}/watermark/${"a".repeat(64)}.png`, method: "PUT" })).json()).toMatchObject({ url: "https://prod-r2/put" });
    // A group put away: who was in it read first, then dev's library given each a copy.
    await call("convex", { kind: "mutation", path: "groups:archiveGroup", args: { key: "gr-aaaaaaaaaa" } });
    expect(live.slice(2).map((one) => one.body.path)).toEqual(["groups:listGroups", "groups:archiveGroup"]);
    expect(own).toEqual([{ path: "groups:followLibrary", args: { copies: [{ from: "gr-aaaaaaaaaa", to: CH }, { from: "gr-aaaaaaaaaa", to: "ch-9999999999" }], actor: { sub: "person-t", name: "Sphe" }, token: "dev-service" } }]);
    // Everything else stays dev's.
    own.length = 0;
    await call("convex", { kind: "query", path: "edit:listLibrary", args: { kind: "skill" } });
    expect(own.map((one) => one.path)).toEqual(["edit:listLibrary"]);
    expect(live).toHaveLength(4);
  });

  it("follows each group change that moves teaching, from what it was asked and answered", () => {
    expect(followOf("groups:makeGroup", { channels: [CH, "ch-1"], from: CH }, { key: "gr-b" }, [])).toEqual({ moves: [{ from: CH, to: "gr-b" }] });
    expect(followOf("groups:removeChannel", { key: "gr-b", channel: CH }, { archived: false }, [])).toEqual({ copies: [{ from: "gr-b", to: CH }] });
    expect(followOf("groups:removeChannel", { key: "gr-b", channel: CH }, { archived: true }, [{ key: "gr-b", channels: [CH, "ch-1"] }])).toEqual({ copies: [{ from: "gr-b", to: CH }, { from: "gr-b", to: "ch-1" }] });
    expect(followOf("groups:moveIntoGroup", { item: `skill:@${CH}--edit/pins` }, { key: "skill:@gr-b--edit/pins" }, [])).toEqual({ fold: { item: `skill:@${CH}--edit/pins`, into: "gr-b--edit" } });
    expect(followOf("groups:setGroup", { key: "gr-b" }, {}, [])).toBeNull();
    expect(followOf("groups:addChannel", { key: "gr-b", channel: CH }, {}, [])).toBeNull();
  });
});
