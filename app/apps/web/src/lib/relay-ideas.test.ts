// Ideas on Edit's relay (apps/relay/src/ideas.ts): who may, the Convex calls,
// YouTube's details, and the Interrogation board's Trello (and a channel's
// own board, Nov 18), read and written only where ideas go, against stand-ins for Trello, YouTube and Convex.

import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readCutOffsWith, useKeys } from "../../../relay/src/auth";
import { approvedList, BOARD, BODYCAM_BOARD, coverWaits, described, holdsApproved, isoSeconds, NO_BOARD, outlier, resetForTests, savedBoardOf, titleOf, trelloLink, youtubeIds } from "../../../relay/src/ideas";
import relay, { type Env } from "../../../relay/src/index";

const ISSUER = "https://accounts.example.test";
let privateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});

beforeEach(() => {
  useKeys(createLocalJWKSet({ keys: [jwk] }));
  resetForTests();
  coverWaits.ms = [1, 1];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  useKeys(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const token = (claims: Record<string, unknown> = {}) =>
  new SignJWT({ email: "sphe@gmail.com", name: "Sphe", perms: ["use", "ideas.interrogation"], admin: false, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience("edit")
    .setSubject("person-1")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);

const env = (extra: Partial<Env> = {}) =>
  ({ ACCOUNTS_ISSUER: ISSUER, TRELLO_API_KEY: "tk", TRELLO_TOKEN: "tt", YOUTUBE_API_KEY: "yk", CONVEX_URL: "https://convex.test", CONVEX_SERVICE_TOKEN: "s".repeat(40), ...extra }) as Env;

async function ask(path: string, init: { method?: string; body?: unknown; claims?: Record<string, unknown>; bearer?: string | null } = {}, given: Env = env()) {
  const bearer = init.bearer === undefined ? await token(init.claims) : init.bearer;
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return relay.fetch(
    new Request(`https://relay.test${path}`, {
      method: init.method ?? (body === undefined ? "GET" : "POST"),
      headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), "content-type": "application/json", ...(body === undefined ? {} : { "content-length": String(body.length) }) },
      ...(body === undefined ? {} : { body }),
    }),
    given,
  );
}

const LANE = BOARD.lanes[0]!;
const BOARD_ID = "b".repeat(24);
const card = (id: string, fields: Record<string, unknown>) => ({ id: id.padEnd(24, "0"), name: "", desc: "", url: `https://trello.com/c/${id}`, shortUrl: `https://trello.com/c/${id}`, idList: LANE.id, idLabels: [], closed: false, dateLastActivity: "2026-10-30T10:00:00.000Z", attachments: [], ...fields });

/** A stand-in Trello (and YouTube, and Convex): every call is kept, answers by route. */
function stand(routes: Record<string, (url: URL, init: RequestInit) => unknown>) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, url, init });
    const path = `${method} ${url.host}${url.pathname}`;
    for (const [pattern, answer] of Object.entries(routes)) {
      if (new RegExp(`^${pattern}$`).test(path)) {
        const value = answer(url, init);
        return value instanceof Response ? value : Response.json(value);
      }
    }
    return new Response(`no stand-in for ${path}`, { status: 599 });
  });
  return calls;
}

describe("who may work on ideas", () => {
  it("answers someone with ideas.interrogation or an admin, and refuses everyone else", async () => {
    stand({ "GET api.trello.com/1/boards/CJiVnylO/lists": () => [] });
    expect((await ask("/v1/ideas/lanes")).status).toBe(200);
    expect((await ask("/v1/ideas/lanes", { claims: { perms: ["use"], admin: true } })).status).toBe(200);
    const refused = await ask("/v1/ideas/lanes", { claims: { perms: ["use", "edit.interrogation", "scripts.interrogation"] } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("Interrogation or bodycam ideas");
    expect((await ask("/v1/ideas/lanes", { bearer: null })).status).toBe(401);
  });

  it("a workspace is its own board and capability: bodycam ideas go to Raw Channels' Ideas - Sphe", async () => {
    const bodycam = { claims: { perms: ["use", "ideas.bodycam"] } };
    const lanes = await ask("/v1/ideas/lanes?workspace=bodycam", bodycam);
    expect(lanes.status).toBe(200);
    expect(await lanes.json()).toMatchObject({ board: { name: "Raw Channels" }, lanes: [{ key: "sphe", name: "Ideas - Sphe" }] });
    // Only their own workspace: Interrogation's board (the default) is refused them.
    const other = await ask("/v1/ideas/lanes", bodycam);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toContain("Interrogation ideas");
    expect((await ask("/v1/ideas/lanes?workspace=courtroom", { claims: { perms: ["use"], admin: true } })).status).toBe(400);
  });

  it("keeps an idea's pictures on R2 to people who work on ideas", async () => {
    const r2 = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" };
    const key = "edit/ideas/i1793450000000-abc/thumb.jpg";
    const put = await ask("/v1/cloud/r2/url", { body: { method: "PUT", key }, claims: { perms: ["use", "ideas.interrogation"] } }, env(r2));
    expect(put.status).toBe(200);
    const editor = await ask("/v1/cloud/r2/url", { body: { method: "GET", key }, claims: { perms: ["use", "edit.interrogation"] } }, env(r2));
    expect(editor.status).toBe(403);
  });
});

describe("the ideas functions", () => {
  it("calls only ideas:*, with the service token, and names who changed and started an idea from the token", async () => {
    const calls = stand({ "POST convex.test/api/(query|mutation)": () => ({ status: "success", value: { rev: 1 } }) });
    const committed = await ask("/v1/ideas/convex", { body: { kind: "mutation", path: "ideas:commit", args: { ideaId: "i1-abcd", workspace: "interrogation", baseRev: 0, body: {}, summary: {}, by: "Someone else", actor: { sub: "forged", name: "Forged" } } } });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toEqual({ status: "success", value: { rev: 1 } });
    const sent = JSON.parse(String(calls.at(-1)!.init.body)) as { path: string; args: Record<string, unknown> };
    expect(sent.path).toBe("ideas:commit");
    expect(sent.args).toMatchObject({ by: "Sphe", actor: { sub: "person-1", name: "Sphe", email: "sphe@gmail.com" }, token: "s".repeat(40) });
    expect((await ask("/v1/ideas/convex", { body: { kind: "mutation", path: "edit:deleteProject", args: {} } })).status).toBe(403);
    expect((await ask("/v1/ideas/convex", { body: { kind: "mutation", path: "ideas:list", args: {} } })).status).toBe(403);
  });

  it("a thumbnail's workspace goes to Convex only once it takes it, with who's asking", async () => {
    const calls = stand({ "POST convex.test/api/(query|mutation)": () => ({ status: "success", value: { rev: 1 } }) });
    const commit = { kind: "mutation", path: "thumbnails:commit", args: { thumbId: "t1", baseRev: 0, body: {}, summary: {}, by: "x", workspace: "bodycam" } };
    await ask("/v1/ideas/convex", { body: commit });
    expect(JSON.parse(String(calls.at(-1)!.init.body)).args.workspace).toBeUndefined();
    await ask("/v1/ideas/convex", { body: commit }, env({ CONVEX_CALLER: "1" } as Partial<Env>));
    expect(JSON.parse(String(calls.at(-1)!.init.body)).args).toMatchObject({ workspace: "bodycam", caller: { sub: "person-1", admin: false } });
  });

  it("keeps each workspace's ideas to who works in it (Nov 4: a bodycam person read and changed Interrogation's)", async () => {
    const rows = [{ ideaId: "i1", workspace: "interrogation" }, { ideaId: "i2", workspace: "bodycam" }, { ideaId: "i3" }];
    const calls = stand({
      "POST convex.test/api/query": (_url, init) => {
        const sent = JSON.parse(String(init.body)) as { path: string; args: { ideaId?: string } };
        if (sent.path === "ideas:list") return { status: "success", value: rows };
        const row = rows.find((one) => one.ideaId === sent.args.ideaId);
        return { status: "success", value: row === undefined ? null : { body: { workspace: row.workspace }, rev: 1 } };
      },
      "POST convex.test/api/mutation": () => ({ status: "success", value: { rev: 2 } }),
    });
    const bodycam = { perms: ["use", "ideas.bodycam"] };
    const convex = (path: string, kind: string, args: Record<string, unknown>, claims: Record<string, unknown> = bodycam) => ask("/v1/ideas/convex", { body: { kind, path, args }, claims });
    // Listed: only bodycam's (an idea without a workspace is Interrogation's).
    const listed = (await (await convex("ideas:list", "query", {})).json()) as { value: { ideaId: string }[] };
    expect(listed.value.map((row) => row.ideaId)).toEqual(["i2"]);
    // Opened, changed, moved into, or removed: refused outside bodycam, and nothing changes.
    expect((await convex("ideas:get", "query", { ideaId: "i1" })).status).toBe(403);
    expect((await convex("ideas:get", "query", { ideaId: "i3" })).status).toBe(403);
    expect((await convex("ideas:get", "query", { ideaId: "i2" })).status).toBe(200);
    expect((await convex("ideas:commit", "mutation", { ideaId: "i1", workspace: "bodycam", baseRev: 1, body: {} })).status).toBe(403);
    expect((await convex("ideas:commit", "mutation", { ideaId: "i2", workspace: "interrogation", baseRev: 1, body: {} })).status).toBe(403);
    expect((await convex("ideas:remove", "mutation", { ideaId: "i3" })).status).toBe(403);
    expect(calls.filter((call) => call.url.pathname === "/api/mutation")).toHaveLength(0);
    // Its own: changed, and a new one started there.
    expect((await convex("ideas:commit", "mutation", { ideaId: "i2", workspace: "bodycam", baseRev: 1, body: {} })).status).toBe(200);
    expect((await convex("ideas:commit", "mutation", { ideaId: "i9", workspace: "bodycam", baseRev: 0, body: {} })).status).toBe(200);
    // An admin sees every workspace.
    const all = (await (await convex("ideas:list", "query", {}, { perms: ["use"], admin: true })).json()) as { value: unknown[] };
    expect(all.value).toHaveLength(3);
  });
});

describe("YouTube's details", () => {
  it("reads the video, its channel's recent long uploads for the outlier score, and never shows the key", async () => {
    const calls = stand({
      "GET www.googleapis.com/youtube/v3/videos": (url) =>
        url.searchParams.get("id") === "abcdefghijk"
          ? { items: [{ id: "abcdefghijk", snippet: { title: "Mom Interrogated", description: "x".repeat(900), channelTitle: "Red Thread", channelId: "UC1", publishedAt: "2026-10-01T00:00:00Z", thumbnails: { high: { url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" }, maxres: { url: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg" } } }, statistics: { viewCount: "300000" }, contentDetails: { duration: "PT1H2M3S" } }] }
          : { items: [...Array(8).keys()].map((n) => ({ id: `v${n}`, statistics: { viewCount: String((n + 1) * 10_000) }, contentDetails: { duration: n === 0 ? "PT45S" : "PT20M" } })) },
      "GET www.googleapis.com/youtube/v3/channels": () => ({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }),
      "GET www.googleapis.com/youtube/v3/playlistItems": () => ({ items: [...Array(8).keys()].map((n) => ({ contentDetails: { videoId: `v${n}` } })) }),
    });
    const answer = await ask("/v1/ideas/youtube?id=abcdefghijk");
    expect(answer.status).toBe(200);
    const video = (await answer.json()) as Record<string, unknown>;
    // The Short (45 s) is left out: medians of 20k…80k is 50k, 300k / 50k = 6x.
    expect(video).toMatchObject({ title: "Mom Interrogated", channel: "Red Thread", views: 300000, durationSeconds: 3723, thumbnail: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg", outlier: "6x" });
    expect((video.description as string).length).toBe(800);
    expect(JSON.stringify(video)).not.toContain("yk");
    expect(calls.every((one) => one.url.searchParams.get("key") === "yk")).toBe(true);
    expect((await ask("/v1/ideas/youtube?id=nope")).status).toBe(400);
  });

  it("checks Script mode's pasted links in one call, for whoever edits or writes scripts (Sphe, Nov 18: checks took too long)", async () => {
    const calls = stand({
      "GET www.googleapis.com/youtube/v3/videos": () => ({
        items: [
          { id: "abcdefghijk", snippet: { title: "Verdict", channelTitle: "Court TV", liveBroadcastContent: "none" }, contentDetails: { duration: "PT4M3S" }, status: { privacyStatus: "public" } },
          { id: "lmnopqrstuv", snippet: { title: "Sentencing", channelTitle: "News", liveBroadcastContent: "upcoming" }, contentDetails: { duration: "P0D", contentRating: { ytRating: "ytAgeRestricted" } }, status: { privacyStatus: "unlisted" } },
        ],
      }),
    });
    const writer = { claims: { perms: ["use", "scripts.interrogation"] } };
    const answer = await ask("/v1/youtube/check?ids=abcdefghijk,lmnopqrstuv,zzzzzzzzzzz", writer);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      videos: {
        abcdefghijk: { title: "Verdict", channel: "Court TV", durationSeconds: 243, live: "none", ageRestricted: false, privacy: "public" },
        lmnopqrstuv: { title: "Sentencing", channel: "News", durationSeconds: 0, live: "upcoming", ageRestricted: true, privacy: "unlisted" },
        zzzzzzzzzzz: null,
      },
    });
    // One call for all of them.
    expect(calls.length).toBe(1);
    expect((await ask("/v1/youtube/check?ids=abcdefghijk", { claims: { perms: ["use", "ideas.bodycam"] } })).status).toBe(403);
    expect((await ask("/v1/youtube/check?ids=nope", writer)).status).toBe(400);
  });

  it("searches YouTube for a script's footage, best first with each one's length, for whoever edits or writes scripts (Sphe, Nov 18)", async () => {
    const calls = stand({
      "GET www.googleapis.com/youtube/v3/search": () => ({ items: [{ id: { videoId: "lmnopqrstuv" } }, { id: { videoId: "abcdefghijk" } }, { id: { channelId: "UC1" } }] }),
      "GET www.googleapis.com/youtube/v3/videos": () => ({
        items: [
          { id: "abcdefghijk", snippet: { title: "Bodycam", channelTitle: "Police", publishedAt: "2024-01-02T00:00:00Z", description: "d".repeat(900), liveBroadcastContent: "none" }, contentDetails: { duration: "PT12M" } },
          { id: "lmnopqrstuv", snippet: { title: "Trial Day 3", channelTitle: "Court TV", liveBroadcastContent: "none" }, contentDetails: { duration: "PT5H1S", contentRating: { ytRating: "ytAgeRestricted" } } },
        ],
      }),
    });
    const writer = { claims: { perms: ["use", "scripts.interrogation"] } };
    const answer = await ask("/v1/youtube/search?q=esparza%20trial%20day%203&max=10", writer);
    expect(answer.status).toBe(200);
    const { videos } = (await answer.json()) as { videos: Record<string, unknown>[] };
    expect(videos.map((one) => one.id)).toEqual(["lmnopqrstuv", "abcdefghijk"]);
    expect(videos[0]).toMatchObject({ title: "Trial Day 3", channel: "Court TV", durationSeconds: 18001, live: "none", ageRestricted: true });
    expect((videos[1]!.description as string).length).toBe(500);
    const search = calls.find((one) => one.url.pathname.endsWith("/search"))!;
    expect(search.url.searchParams.get("q")).toBe("esparza trial day 3");
    expect(search.url.searchParams.get("maxResults")).toBe("10");
    expect(search.url.searchParams.get("safeSearch")).toBe("none");
    expect((await ask("/v1/youtube/search?q=x", { claims: { perms: ["use", "ideas.bodycam"] } })).status).toBe(403);
    expect((await ask("/v1/youtube/search?q=", writer)).status).toBe(400);
  });

  it("says so when the relay has no key, or the video isn't there", async () => {
    stand({ "GET www.googleapis.com/youtube/v3/videos": () => ({ items: [] }) });
    expect((await ask("/v1/ideas/youtube?id=abcdefghijk", {}, env({ YOUTUBE_API_KEY: undefined }))).status).toBe(503);
    expect((await ask("/v1/ideas/youtube?id=abcdefghijk")).status).toBe(404);
  });

  it("counts the outlier score and a duration as Sphe Research did", () => {
    expect(outlier(100, [10, 20, 30, 40])).toBe("unknown");
    expect(outlier(150, [10, 20, 30, 40, 50])).toBe("5x");
    expect(isoSeconds("PT20M5S")).toBe(1205);
    expect(isoSeconds("P1DT1S")).toBe(86_401);
    expect(isoSeconds("soon")).toBeNull();
  });
});

describe("the board", () => {
  const lists = [
    { id: LANE.id, name: LANE.name, closed: false, pos: 1 },
    { id: BOARD.approved.id, name: BOARD.approved.name, closed: false, pos: 2 },
    { id: "c".repeat(24), name: "Comp Ideas", closed: false, pos: 3 },
    { id: "d".repeat(24), name: "Uploaded (SI", closed: false, pos: 4 },
  ];

  it("finds a video already on the board in a card's name, description (escaped) or attachments, archived cards too", async () => {
    stand({
      "GET api.trello.com/1/boards/CJiVnylO/lists": () => lists,
      "GET api.trello.com/1/boards/CJiVnylO/cards": () => [
        card("a1", { name: "Killer Realizes", desc: "Case: [https://youtu.be/XfGOTlci\\_-Q](https://youtu.be/XfGOTlci\\_-Q)", idList: "d".repeat(24) }),
        card("a2", { name: "Old one", closed: true, attachments: [{ id: "x", name: "link", url: "https://www.youtube.com/watch?feature=share&v=abcdefghijk" }] }),
      ],
    });
    const answer = await ask("/v1/ideas/trello/duplicates", { body: { ids: ["XfGOTlci_-Q", "abcdefghijk", "zzzzzzzzzzz"] } });
    const { found } = (await answer.json()) as { found: Record<string, { name: string; list: string; closed: boolean }> };
    expect(found["XfGOTlci_-Q"]).toMatchObject({ name: "Killer Realizes", list: "Uploaded (SI", closed: false });
    expect(found.abcdefghijk).toMatchObject({ name: "Old one", closed: true });
    expect(found.zzzzzzzzzzz).toBeUndefined();
    expect((await ask("/v1/ideas/trello/duplicates", { body: { ids: ["../../x"] } })).status).toBe(400);
  });

  it("reads the approved titles from every list from Approved on, without case numbers, pictures or links", async () => {
    stand({
      "GET api.trello.com/1/boards/CJiVnylO/lists": () => lists,
      "GET api.trello.com/1/boards/CJiVnylO/cards": () => [
        card("b1", { name: "745) Killer Mom Realizes She's Been Exposed After 26 Years", idList: BOARD.approved.id, idAttachmentCover: "att1", attachments: [{ id: "att1", url: "https://trello.com/1/cards/b/attachments/att1/download/a.png", previews: [{ url: "https://p/small", width: 150 }, { url: "https://p/big", width: 1280 }, { url: "https://p/huge", width: 3000 }] }] }),
        card("b2", { name: "Uploaded Title", idList: "d".repeat(24), dateLastActivity: "2026-10-31T10:00:00.000Z" }),
        card("b3", { name: "Still An Idea", idList: "c".repeat(24) }),
        card("b4", { name: "image.png", idList: BOARD.approved.id }),
      ],
    });
    const { titles } = (await (await ask("/v1/ideas/trello/approved")).json()) as { titles: { title: string; list: string; cover: string | null }[] };
    expect(titles.map((one) => one.title)).toEqual(["Uploaded Title", "Killer Mom Realizes She's Been Exposed After 26 Years"]);
    expect(titles[1]!.cover).toBe("https://p/big");
    // Raw Channels names its approved lists: Ted's and Sams's pipeline, never another channel's uploads or footage sourcing.
    expect(approvedList(BODYCAM_BOARD, { id: "68e2cb0bfd3cf343f0b69629", name: "Uploaded (ted) 🟦" })).toBe(true);
    expect(approvedList(BODYCAM_BOARD, { id: "6aa86135f4525effb72a4333", name: "Uploaded (Penguin)  🟧" })).toBe(false);
    expect(approvedList(BODYCAM_BOARD, { id: "69f376f8bb97f92be025964e", name: "Channels to source footage from" })).toBe(false);
    expect(holdsApproved("Repackaging (JJ)")).toBe(false);
    expect(holdsApproved("Script - Genius")).toBe(true);
    expect(titleOf("12) A Title")).toBe("A Title");
  });

  it("says where sent cards are, and lists the lanes' cards waiting on changes with their comments", async () => {
    stand({
      "GET api.trello.com/1/boards/CJiVnylO/lists": () => lists,
      "GET api.trello.com/1/boards/CJiVnylO/cards": () => [
        card("c1", { name: "Needs work", idLabels: [BOARD.changesRequired[0]] }),
        card("c2", { name: "Done already", idLabels: [BOARD.changesRequired[0], BOARD.changesMade[0]] }),
        card("c3", { name: "Approved one", idList: BOARD.approved.id }),
      ],
      "GET api.trello.com/1/cards/c1[0-9]+/actions": () => [{ id: "m1", date: "2026-10-30T09:00:00.000Z", data: { text: "new title please, the GPS angle" }, memberCreator: { fullName: "Mari" } }],
    });
    const { places } = (await (await ask("/v1/ideas/trello/where", { body: { cards: ["c3".padEnd(24, "0"), "c1".padEnd(24, "0"), "f".repeat(24)] } })).json()) as { places: Record<string, { list: string; approved: boolean; changes: boolean; missing: boolean }> };
    expect(places["c3".padEnd(24, "0")]).toMatchObject({ list: BOARD.approved.name, approved: true, changes: false });
    expect(places["c1".padEnd(24, "0")]).toMatchObject({ list: LANE.name, approved: false, changes: true });
    expect(places["f".repeat(24)]).toMatchObject({ missing: true });
    const { cards } = (await (await ask("/v1/ideas/trello/changes")).json()) as { cards: { name: string; comments: { text: string; author: string }[] }[] };
    expect(cards.map((one) => one.name)).toEqual(["Needs work"]);
    expect(cards[0]!.comments).toEqual([{ id: "m1", text: "new title please, the GPS angle", author: "Mari", at: "2026-10-30T09:00:00.000Z" }]);
  });

  it("fetches only a Trello card's attachments, with the key as OAuth and not in the URL", async () => {
    const calls = stand({ "GET trello.com/1/cards/.*": () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }) });
    const url = `https://trello.com/1/cards/${"a".repeat(24)}/attachments/${"b".repeat(24)}/download/x.png`;
    const answer = await ask(`/v1/ideas/trello/image?url=${encodeURIComponent(url)}`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/png");
    expect(String((calls[0]!.init.headers as Record<string, string>).authorization)).toContain('oauth_consumer_key="tk"');
    expect(calls[0]!.url.search).toBe("");
    expect((await ask(`/v1/ideas/trello/image?url=${encodeURIComponent("https://evil.test/x.png")}`)).status).toBe(400);
  });
});

describe("sending an idea", () => {
  const listOk = () => ({ id: LANE.id, name: LANE.name, idBoard: BOARD_ID, closed: false });

  it("checks the lane, makes the card at the top, uploads its pictures, writes them into the description and sets the cover", async () => {
    let previewsAsked = 0;
    const calls = stand({
      "GET api.trello.com/1/boards/CJiVnylO": () => ({ id: BOARD_ID }),
      [`GET api.trello.com/1/lists/${LANE.id}`]: listOk,
      [`GET api.trello.com/1/lists/${LANE.id}/cards`]: () => [],
      "POST api.trello.com/1/cards": (url) => ({ id: "e".repeat(24), name: url.searchParams.get("name"), idList: url.searchParams.get("idList"), url: "https://trello.com/c/long", shortUrl: "https://trello.com/c/new" }),
      "GET api.trello.com/1/cards/e+/attachments": () => [],
      "GET i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg": () => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "image/jpeg" } }),
      "POST api.trello.com/1/cards/e+/attachments": () => ({ id: "f".repeat(24), name: "thumbnail", url: "https://trello.com/1/cards/e/attachments/f/download/thumbnail.jpg", previews: [] }),
      "GET api.trello.com/1/cards/e+/attachments/f+": () => ({ id: "f".repeat(24), previews: ++previewsAsked > 1 ? [{ url: "https://p" }] : [] }),
      "PUT api.trello.com/1/cards/e+": () => ({}),
    });
    const desc = "Titles:\n- Killer Realizes His Story Collapsed\n- Killer Thinks He Got Away\nThumbnail Guide:\nwe use the interrogation room and have the suspect in the middle\n[image]\nCase:\nhttps://www.youtube.com/watch?v=abcdefghijk";
    const answer = await ask("/v1/ideas/trello/send", { body: { lane: "sphe", name: "Killer Realizes His Story Collapsed", desc, images: [{ name: "thumbnail", url: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg" }] } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ cardId: "e".repeat(24), url: "https://trello.com/c/new", created: true, lane: "sphe", list: LANE.name });
    const created = calls.find((one) => one.method === "POST" && one.url.pathname === "/1/cards")!;
    expect(created.url.searchParams.get("idList")).toBe(LANE.id);
    expect(created.url.searchParams.get("pos")).toBe("top");
    const upload = calls.find((one) => one.method === "POST" && one.url.pathname.endsWith("/attachments"))!;
    expect(upload.init.body).toBeInstanceOf(FormData);
    const puts = calls.filter((one) => one.method === "PUT");
    expect(puts[0]!.url.searchParams.get("desc")).toBe(
      "Titles:\n\n- Killer Realizes His Story Collapsed\n- Killer Thinks He Got Away\n\nThumbnail Guide:\n\nwe use the interrogation room and have the suspect in the middle\n\n![thumbnail](https://trello.com/1/cards/e/attachments/f/download/thumbnail.jpg)\n\nCase:\n\nhttps://www.youtube.com/watch?v=abcdefghijk",
    );
    expect(puts.at(-1)!.url.searchParams.get("idAttachmentCover")).toBe("f".repeat(24));
  });

  it("finishes the card a send began when tried again, and refuses a lane that isn't one or a list renamed", async () => {
    const calls = stand({
      "GET api.trello.com/1/boards/CJiVnylO": () => ({ id: BOARD_ID }),
      [`GET api.trello.com/1/lists/${LANE.id}`]: listOk,
      [`GET api.trello.com/1/cards/${"e".repeat(24)}`]: () => ({ id: "e".repeat(24), name: "Old Name", idList: LANE.id, url: "u", shortUrl: "s" }),
      "GET api.trello.com/1/cards/e+/attachments": () => [],
      "PUT api.trello.com/1/cards/e+": () => ({}),
    });
    const again = await ask("/v1/ideas/trello/send", { body: { lane: "sphe", cardId: "e".repeat(24), name: "New Name", desc: "Titles:\n- New Name" } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);
    expect(calls.some((one) => one.method === "POST")).toBe(false);
    expect((await ask("/v1/ideas/trello/send", { body: { lane: "ready-for-script", name: "X", desc: "" } })).status).toBe(400);
    stand({ "GET api.trello.com/1/boards/CJiVnylO": () => ({ id: BOARD_ID }), [`GET api.trello.com/1/lists/${LANE.id}`]: () => ({ ...listOk(), name: "Something Else" }) });
    expect((await ask("/v1/ideas/trello/send", { body: { lane: "sphe", name: "X", desc: "" } })).status).toBe(409);
  });

  it("refuses pictures from anywhere but the idea's own folder, Trello or YouTube's thumbnails", async () => {
    stand({ "GET api.trello.com/1/boards/CJiVnylO": () => ({ id: BOARD_ID }), [`GET api.trello.com/1/lists/${LANE.id}`]: listOk });
    for (const image of [{ name: "x", url: "http://169.254.169.254/latest" }, { name: "x", key: "edit/originals/drive/x/y.mp4" }, { name: "x", key: "edit/ideas/../reports/x" }])
      expect((await ask("/v1/ideas/trello/send", { body: { lane: "sphe", name: "X", desc: "", images: [image] } })).status).toBe(400);
  });

  it("writes a card's changes back and labels it Changes Made, only on a card in a lane or waiting on changes", async () => {
    const id = "a".repeat(24);
    const calls = stand({
      "GET api.trello.com/1/boards/CJiVnylO": () => ({ id: BOARD_ID }),
      [`GET api.trello.com/1/cards/${id}`]: () => ({ id, name: "Old", idList: "z".repeat(24), idBoard: BOARD_ID, idLabels: [BOARD.changesRequired[0]], url: "u", shortUrl: "s" }),
      [`GET api.trello.com/1/cards/${id}/attachments`]: () => [],
      [`PUT api.trello.com/1/cards/${id}`]: () => ({}),
      [`POST api.trello.com/1/cards/${id}/idLabels`]: () => [],
    });
    const answer = await ask("/v1/ideas/trello/update", { body: { cardId: id, name: "Better Title", desc: "Titles:\n- Better Title" } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ cardId: id, url: "s", labelled: true });
    expect(calls.find((one) => one.url.pathname.endsWith("/idLabels"))!.url.searchParams.get("value")).toBe(BOARD.madeLabel);
    stand({
      "GET api.trello.com/1/boards/CJiVnylO": () => ({ id: BOARD_ID }),
      [`GET api.trello.com/1/cards/${id}`]: () => ({ id, name: "Scripted", idList: "z".repeat(24), idBoard: BOARD_ID, idLabels: [], url: "u" }),
    });
    expect((await ask("/v1/ideas/trello/update", { body: { cardId: id, name: "X", desc: "" } })).status).toBe(409);
  });

  it("lays a description out as the board writes it", () => {
    expect(described("Titles:\n- A\n[image]\nCase:\nhttps://x", [{ name: "a [1]", url: "https://t/a" }, { name: "b", url: "https://t/b" }])).toBe("Titles:\n\n- A\n\n![a 1](https://t/a)\n\nCase:\n\nhttps://x\n\n![b](https://t/b)");
    expect(youtubeIds("https://youtu.be/abcdefghijk and https://www.youtube.com/shorts/ABCDEFGHIJK?x=1")).toEqual(["abcdefghijk", "ABCDEFGHIJK"]);
  });
});

describe("a channel's own board (Nov 18)", () => {
  const TED = "inspector-ted";
  const TED_BOARD = "7".repeat(24);
  const TED_LANE = { id: "8".repeat(24), name: "Ideas - Ted" };
  const BODYCAM_ID = "9".repeat(24);
  const tedRow = (trello: unknown = { boardId: TED_BOARD, name: "Ted's Board", url: "https://trello.com/b/tedboard", lanes: [TED_LANE] }) => ({ key: TED, name: "Inspector Ted", trello });
  const ted = { perms: ["use", "ideas.bodycam", `channel.${TED}`] };
  /** Convex with the one channel row, and the two workspace boards' ids on Trello. */
  const routes = (row: unknown = tedRow()) => ({
    "POST convex.test/api/query": (_url: URL, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { path: string; args: { key?: string } };
      return { status: "success", value: sent.path === "channels:getChannel" && sent.args.key === TED ? row : null };
    },
    "GET api.trello.com/1/boards/CJiVnylO": () => ({ id: BOARD_ID }),
    "GET api.trello.com/1/boards/v3lybcjY": () => ({ id: BODYCAM_ID }),
    [`GET api.trello.com/1/boards/${TED_BOARD}`]: () => ({ id: TED_BOARD }),
  });

  it("reads the channel's board from its row, without a caller, and sends only to its saved lanes", async () => {
    const calls = stand({
      ...routes(),
      [`GET api.trello.com/1/lists/${TED_LANE.id}`]: () => ({ ...TED_LANE, idBoard: TED_BOARD, closed: false }),
      [`GET api.trello.com/1/lists/${TED_LANE.id}/cards`]: () => [],
      "POST api.trello.com/1/cards": (url) => ({ id: "e".repeat(24), name: url.searchParams.get("name"), idList: url.searchParams.get("idList"), url: "u", shortUrl: "s" }),
      "GET api.trello.com/1/cards/e+/attachments": () => [],
      "PUT api.trello.com/1/cards/e+": () => ({}),
    });
    const lanes = await ask(`/v1/ideas/lanes?channel=${TED}`, { claims: ted }, env({ CONVEX_CALLER: "1" } as Partial<Env>));
    expect(lanes.status).toBe(200);
    expect(await lanes.json()).toEqual({ board: { id: TED_BOARD, name: "Ted's Board" }, lanes: [{ key: TED_LANE.id, ...TED_LANE }], approved: null });
    const read = JSON.parse(String(calls.find((one) => one.url.host === "convex.test")!.init.body)) as { path: string; args: Record<string, unknown> };
    expect(read).toMatchObject({ path: "channels:getChannel", args: { key: TED, token: "s".repeat(40) } });
    expect(read.args.caller).toBeUndefined();
    const sent = await ask("/v1/ideas/trello/send", { body: { channel: TED, lane: TED_LANE.id, name: "A Title", desc: "Titles:\n- A Title" }, claims: ted });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ lane: TED_LANE.id, list: TED_LANE.name, created: true });
    expect(calls.find((one) => one.method === "POST" && one.url.pathname === "/1/cards")!.url.searchParams.get("idList")).toBe(TED_LANE.id);
    // The workspace's lanes are not the channel's.
    expect((await ask("/v1/ideas/trello/send", { body: { channel: TED, lane: "sphe", name: "A Title", desc: "" }, claims: ted })).status).toBe(400);
  });

  it("refuses who can't see the channel, and a channel with no board; the channel alone is enough, a label too, its board's name left out", async () => {
    stand(routes());
    const refused = await ask(`/v1/ideas/lanes?channel=${TED}`, { claims: { perms: ["use", "ideas.bodycam", "channel.other"] } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("That channel isn't available");
    // The channel given is all its board takes (Nov 21): no `ideas.*` beside it.
    expect((await ask(`/v1/ideas/lanes?channel=${TED}`, { claims: { perms: ["use", `channel.${TED}`] } })).status).toBe(200);
    expect((await ask("/v1/ideas/lanes?channel=../x", { claims: ted })).status).toBe(400);
    const label = await ask(`/v1/ideas/lanes?channel=${TED}`, { claims: { perms: ["use", "ideas.interrogation", `channel.${TED}.label`] } });
    expect(label.status).toBe(200);
    expect(await label.json()).toMatchObject({ board: { id: TED_BOARD, name: "" }, lanes: [{ key: TED_LANE.id }] });
    expect(await (await ask(`/v1/ideas/trello/channel?channel=${TED}`, { claims: { perms: ["use", "ideas.interrogation", `channel.${TED}.label`] } })).json()).toEqual({ board: { boardId: TED_BOARD, name: "", url: "", lanes: [TED_LANE] } });
    stand(routes(tedRow(null)));
    const none = await ask(`/v1/ideas/trello/approved?channel=${TED}`, { claims: ted });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toBe(NO_BOARD);
    expect(savedBoardOf({ boardId: "nope", lanes: [] })).toBeNull();
    expect(savedBoardOf({ boardId: TED_BOARD, name: "B", url: "u", lanes: [{ id: "x", name: "bad" }, TED_LANE] })!.lanes).toEqual([TED_LANE]);
  });

  it("reads its changes labels off the board by name, labels a card Changes made, and never counts a lane as approved", async () => {
    const id = "a".repeat(24);
    const labels = [{ id: "1".repeat(24), name: "Changes Required" }, { id: "2".repeat(24), name: "Changes made" }];
    const calls = stand({
      ...routes(),
      [`GET api.trello.com/1/boards/${TED_BOARD}/labels`]: () => labels,
      [`GET api.trello.com/1/boards/${TED_BOARD}/lists`]: () => [{ ...TED_LANE, closed: false, pos: 1 }, { id: "3".repeat(24), name: "Scripting", closed: false, pos: 2 }],
      [`GET api.trello.com/1/boards/${TED_BOARD}/cards`]: () => [card("w1", { name: "Waiting", idList: TED_LANE.id, idLabels: [labels[0]!.id] }), card("s1", { name: "Scripted Title", idList: "3".repeat(24) })],
      "GET api.trello.com/1/cards/w1[0-9]+/actions": () => [],
      [`GET api.trello.com/1/cards/${id}`]: () => ({ id, name: "Old", idList: "z".repeat(24), idBoard: TED_BOARD, idLabels: [labels[0]!.id], url: "u", shortUrl: "s" }),
      [`GET api.trello.com/1/cards/${id}/attachments`]: () => [],
      [`PUT api.trello.com/1/cards/${id}`]: () => ({}),
      [`POST api.trello.com/1/cards/${id}/idLabels`]: () => [],
    });
    const { cards } = (await (await ask(`/v1/ideas/trello/changes?channel=${TED}`, { claims: ted })).json()) as { cards: { name: string }[] };
    expect(cards.map((one) => one.name)).toEqual(["Waiting"]);
    const { titles } = (await (await ask(`/v1/ideas/trello/approved?channel=${TED}`, { claims: ted })).json()) as { titles: { title: string }[] };
    expect(titles.map((one) => one.title)).toEqual(["Scripted Title"]);
    const updated = await ask("/v1/ideas/trello/update", { body: { channel: TED, cardId: id, name: "Better", desc: "" }, claims: ted });
    expect(await updated.json()).toMatchObject({ labelled: true });
    expect(calls.find((one) => one.url.pathname.endsWith("/idLabels"))!.url.searchParams.get("value")).toBe(labels[1]!.id);
    // A card of another board's is refused, as on a workspace's.
    stand({ ...routes(), [`GET api.trello.com/1/cards/${id}`]: () => ({ id, name: "X", idList: TED_LANE.id, idBoard: BOARD_ID, url: "u" }) });
    expect((await ask(`/v1/ideas/trello/card?channel=${TED}&card=${id}`, { claims: ted })).status).toBe(403);
  });

  it("a board without changes labels has nothing waiting on changes, and an update never labels", async () => {
    const id = "a".repeat(24);
    const calls = stand({
      ...routes(),
      [`GET api.trello.com/1/boards/${TED_BOARD}/labels`]: () => [{ id: "1".repeat(24), name: "Urgent" }],
      [`GET api.trello.com/1/boards/${TED_BOARD}/cards`]: () => [card("w1", { idList: TED_LANE.id, idLabels: ["1".repeat(24)] })],
      [`GET api.trello.com/1/cards/${id}`]: () => ({ id, name: "Old", idList: TED_LANE.id, idBoard: TED_BOARD, idLabels: [], url: "u", shortUrl: "s" }),
      [`GET api.trello.com/1/cards/${id}/attachments`]: () => [],
      [`PUT api.trello.com/1/cards/${id}`]: () => ({}),
    });
    expect(await (await ask(`/v1/ideas/trello/changes?channel=${TED}`, { claims: ted })).json()).toEqual({ cards: [] });
    expect(await (await ask("/v1/ideas/trello/update", { body: { channel: TED, cardId: id, name: "Better", desc: "" }, claims: ted })).json()).toMatchObject({ labelled: false });
    expect(calls.some((one) => one.url.pathname.endsWith("/idLabels"))).toBe(false);
  });

  it("a channel on a workspace's board takes that board's own lanes, approved lists and labels", async () => {
    stand(routes(tedRow({ boardId: BODYCAM_ID, name: "Raw Channels", url: "https://trello.com/b/v3lybcjY", lanes: [] })));
    expect(await (await ask(`/v1/ideas/lanes?channel=${TED}`, { claims: ted })).json()).toEqual({ board: { id: "v3lybcjY", name: "Raw Channels" }, lanes: BODYCAM_BOARD.lanes, approved: BODYCAM_BOARD.approved });
  });

  it("the dev relay reads the board from the live relay, with the caller's own sign-in", async () => {
    let asked: Request | null = null;
    const live = { fetch: async (request: Request) => ((asked = request), relay.fetch(request, env())) };
    stand(routes());
    const devEnv = env({ CHANNELS_UPSTREAM: "https://live.test", LIVE_RELAY: live, CONVEX_URL: "https://dev-convex.test" } as Partial<Env>);
    const lanes = await ask(`/v1/ideas/lanes?channel=${TED}`, { claims: ted }, devEnv);
    expect(lanes.status).toBe(200);
    expect(await lanes.json()).toMatchObject({ board: { id: TED_BOARD, name: "Ted's Board" } });
    expect(new URL(asked!.url).pathname).toBe("/v1/ideas/trello/channel");
    expect(asked!.headers.get("authorization")).toMatch(/^Bearer /);
    // Refused on the live relay: refused here, as it said.
    const other = await ask(`/v1/ideas/lanes?channel=${TED}`, { claims: { perms: ["use", "ideas.bodycam", "channel.other"] } }, devEnv);
    expect(other.status).toBe(403);
  });

  it("reads a pasted link into its board and the lists ideas go to, for a teacher", async () => {
    expect(trelloLink("https://trello.com/b/AbCd1234/teds-board")).toEqual({ board: "AbCd1234" });
    expect(trelloLink("trello.com/b/AbCd1234")).toEqual({ board: "AbCd1234" });
    expect(trelloLink(" AbCd1234 ")).toEqual({ board: "AbCd1234" });
    expect(trelloLink("https://trello.com/c/XyZ98765/12-a-card")).toEqual({ card: "XyZ98765" });
    expect(trelloLink("https://evil.test/b/AbCd1234")).toBeNull();
    const board = { id: TED_BOARD, name: "Ted's Board", url: "https://trello.com/b/AbCd1234/teds-board", shortUrl: "https://trello.com/b/AbCd1234", closed: false, lists: [
      { id: "3".repeat(24), name: "Scripting", closed: false, pos: 3 },
      { id: TED_LANE.id, name: "Ideas - Ted ", closed: false, pos: 1 },
      { id: "4".repeat(24), name: "Repackaging (JJ)", closed: false, pos: 2 },
      { id: "5".repeat(24), name: "Old drafts", closed: true, pos: 4 },
    ] };
    const calls = stand({ ...routes(), "GET api.trello.com/1/boards/AbCd1234": () => board, "GET api.trello.com/1/cards/XyZ98765": () => ({ idBoard: TED_BOARD }), [`GET api.trello.com/1/boards/${TED_BOARD}`]: () => board, "GET api.trello.com/1/boards/Gone1234": () => new Response("unauthorized permission requested", { status: 401 }) });
    const teacher = { perms: ["use", "agent.teach"] };
    const found = await ask(`/v1/ideas/trello/board?url=${encodeURIComponent("https://trello.com/b/AbCd1234/teds-board")}`, { claims: teacher });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ id: TED_BOARD, name: "Ted's Board", url: "https://trello.com/b/AbCd1234", lists: [TED_LANE, { id: "4".repeat(24), name: "Repackaging (JJ)" }, { id: "3".repeat(24), name: "Scripting" }], lanes: [TED_LANE, { id: "4".repeat(24), name: "Repackaging (JJ)" }] });
    expect(calls.find((one) => one.url.pathname === "/1/boards/AbCd1234")!.url.searchParams.get("lists")).toBe("open");
    expect(await (await ask(`/v1/ideas/trello/board?url=${encodeURIComponent("https://trello.com/c/XyZ98765/12-a-card")}`, { claims: teacher })).json()).toMatchObject({ id: TED_BOARD });
    expect((await ask("/v1/ideas/trello/board?url=AbCd1234", { claims: { perms: ["use", "ideas.bodycam"] } })).status).toBe(403);
    expect((await ask("/v1/ideas/trello/board?url=not%20a%20link", { claims: teacher })).status).toBe(400);
    const gone = await ask("/v1/ideas/trello/board?url=Gone1234", { claims: teacher });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: string }).error).toContain("Edit can't open that Trello board");
    stand({ ...routes(), "GET api.trello.com/1/boards/AbCd1234": () => ({ ...board, closed: true }) });
    expect((await ask("/v1/ideas/trello/board?url=AbCd1234", { claims: teacher })).status).toBe(409);
    // A workspace's board: its own lanes.
    stand({ ...routes(), "GET api.trello.com/1/boards/v3lybcjY": () => ({ id: BODYCAM_ID, name: "Raw Channels", url: "u", closed: false, lists: [{ id: BODYCAM_BOARD.lanes[0]!.id, name: "Ideas - Sphe", closed: false, pos: 1 }, { id: "6".repeat(24), name: "Ideas - Ted", closed: false, pos: 2 }] }) });
    expect(await (await ask("/v1/ideas/trello/board?url=v3lybcjY", { claims: teacher })).json()).toMatchObject({ lanes: [{ id: BODYCAM_BOARD.lanes[0]!.id, name: "Ideas - Sphe" }] });
  });
});
