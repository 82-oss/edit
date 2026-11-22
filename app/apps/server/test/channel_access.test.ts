// A channel given to a person is all they need to work on it (Sphe, Nov 21):
// its edits, scripts (a commentary too), ideas and thumbnails, made, opened and
// worked on with no kind of video or script beside it (kinds.ts, writer/can.ts,
// ideas/routes.ts). Work with no channel keeps the kinds rule, and a channel
// not given stays closed.

import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Idea } from "@edit/types/ideas";

import * as accounts from "../src/accounts.ts";
import * as addons from "../src/addons.ts";
import * as ideasCloud from "../src/ideas/cloud.ts";
import * as teamDocs from "../src/team_docs.ts";
import * as thumbsCloud from "../src/thumbnails/cloud.ts";
import { mayIdea, mayIdeas } from "../src/ideas/routes.ts";
import * as run from "../src/ideas/run.ts";
import { respond } from "../src/http/server.ts";
import * as kinds from "../src/kinds.ts";
import type { Style } from "../src/model.ts";
import { buildRouter } from "../src/routes.ts";
import * as script from "../src/script.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import * as can from "../src/writer/can.ts";
import * as writerStore from "../src/writer/store.ts";
import { importScript } from "../src/writer_handoff.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
let started: ReturnType<typeof spyOn>;
let renewed: ReturnType<typeof spyOn>;

const ideaRows = new Map<string, { body: Idea; rev: number; workspace: string }>();
const thumbRows = new Map<string, { body: Record<string, unknown>; rev: number; workspace: string }>();

const savedSettle = teamDocs.timing.settleMs;

beforeAll(() => {
  teamDocs.timing.settleMs = 5_000;
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  // The import after an edit is made (footage, words, layout) isn't what's tested here.
  started = spyOn(script, "start").mockImplementation(() => null);
  // A fresh token asked for a channel the person wasn't given (channels.ts tokenCarries) carries the same grants: here
  // there's no kept sign-in, and a renewal without one signs the person out, which counts as everything.
  renewed = spyOn(accounts, "renew").mockImplementation(async () => {});
  // mamagi's ideas and thumbnails, in memory (what it refuses is its own, outside this test).
  mock.on("POST", "/v1/ideas/convex", (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    const ok = (value: unknown) => Response.json({ status: "success", value });
    if (path === "ideas:list") return ok([...ideaRows.entries()].map(([ideaId, row]) => ({ ideaId, rev: row.rev, workspace: row.workspace, summary: ideasCloud.summarize(row.body), updatedAt: 0, updatedBy: "Test", createdBy: null })));
    if (path === "ideas:get") {
      const row = ideaRows.get(args.ideaId as string);
      return ok(row === undefined ? null : { body: row.body, rev: row.rev });
    }
    if (path === "ideas:commit") {
      const id = args.ideaId as string;
      const rev = (ideaRows.get(id)?.rev ?? 0) + 1;
      ideaRows.set(id, { body: args.body as Idea, rev, workspace: args.workspace as string });
      return ok({ rev });
    }
    if (path === "thumbnails:list") return ok([...thumbRows.entries()].map(([thumbId, row]) => ({ thumbId, rev: row.rev, workspace: row.workspace, summary: args.summary ?? (row.body.summary as unknown) ?? { title: row.body.title, channel: row.body.channel }, updatedAt: 0, updatedBy: "Test", createdBy: null })));
    if (path === "thumbnails:commit") {
      const id = args.thumbId as string;
      const rev = (thumbRows.get(id)?.rev ?? 0) + 1;
      thumbRows.set(id, { body: { ...(args.body as Record<string, unknown>), summary: args.summary }, rev, workspace: (args.workspace as string) ?? "interrogation" });
      return ok({ rev });
    }
    return Response.json({ status: "error", errorMessage: `not in this test: ${path}` });
  });
  mock.on("GET", "/v1/ideas/youtube", () => Response.json({ title: "Dad Realizes", description: "", channel: "Interrogation Core", views: 65000, outlier: "1.5x", publishedAt: null, durationSeconds: 3000, thumbnail: null }));
});

afterAll(() => {
  teamDocs.timing.settleMs = savedSettle;
  started.mockRestore();
  renewed.mockRestore();
  restore();
  mock.stop();
});

afterEach(() => {
  mock.cloud.convex.channels = [];
  ideaRows.clear();
  thumbRows.clear();
  ideasCloud.forget();
  thumbsCloud.forget();
  v2cloud.useSkillsForTests([]);
  accounts.resetForTests();
});

const lanes = { ideas: "", thumbnails: "", script: "", edit: "" };
const TED = {
  key: "ch-ted", youtubeId: "UC" + "t".repeat(22), handle: "inspectorted", title: "Inspector Ted", description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0,
  narration: { kind: "voice" as const, id: "v123", name: "Andrew" }, compilation: false, lanes, archived: false, addedBy: null, at: 0,
};
/** A channel in Edit that this person wasn't given. */
const OTHER = { ...TED, key: "ch-other", youtubeId: "UC" + "o".repeat(22), handle: "other", title: "Other Channel" };

/** Holding the channel, and no kind of video, script or idea. */
const CHANNEL_ONLY = ["use", "cloud", `channel.${TED.key}`];

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

let next = 0;
/** A Writer script on this computer: a case's footage, or (`commentary`) an essay with a draft and one evidence source. */
function written(home: string, given: { channel?: string; commentary?: boolean; kind?: string } = {}): string {
  next += 1;
  const id = `7c2f0d3e-4b5e-4f60-8b9c-8d7e6f5a4b${String(next).padStart(2, "0")}`;
  const dir = writerStore.scriptDir(writerStore.dataDir(home), id);
  fs.mkdirSync(dir, { recursive: true });
  const base = { id, title: `Case ${next}`, ...(given.channel !== undefined ? { channel: given.channel } : {}), status: "ready", stage: "ready", revision: 1, updatedAt: 1, durationMs: 0, originalPath: "", sourceUrl: "", words: [], clips: [], overview: [], progress: 100, error: null, createdAt: 0, proxyPath: null };
  const body = given.commentary
    ? {
        ...base,
        sourceKind: "commentary",
        kind: "interrogation",
        commentary: {
          pacing: "channel",
          sources: [
            { id: "S1", title: "The brief", role: "brief", origin: "pasted", chars: 9, timed: false, preview: "", addedAt: 0 },
            { id: "S2", title: "The lawsuit", role: "evidence", origin: "https://example.com/lawsuit", chars: 9, timed: false, preview: "", addedAt: 0 },
          ],
          draft: { open: [], sections: [{ heading: "Intro", paragraphs: [{ id: "pa", pieces: [{ kind: "say", text: "He was the most hated man online." }] }] }], checks: [], report: "", writtenAt: 1 },
        },
      }
    : { ...base, kind: given.kind ?? "interrogation", sourceKind: "youtube", sourceUrl: "https://youtu.be/dslLBsHkVzE", durationMs: 20_000, clips: [{ id: "c1", startMs: 1_000, endMs: 4_000 }] };
  fs.writeFileSync(join(dir, "script.json"), JSON.stringify(body));
  return id;
}

function routes(app: Parameters<typeof respond>[0]) {
  const router = buildRouter();
  return async (method: string, path: string, body?: unknown) => {
    const response = (await respond(app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), null))!;
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
}

const on = (home: string) => fs.writeFileSync(join(home, "beta.json"), JSON.stringify({ v2: true }));

test("the rule: a channel's work is the channel's alone; work of no channel is still by kind", () => {
  const given = new Set(CHANNEL_ONLY);
  const shape = (style: Style, channel: string | null, subtitles = false) => ({ style, subtitles, footageOnly: false, channel });
  expect(kinds.mayWork(shape("bodycam", TED.key), given)).toBe(true);
  expect(kinds.mayWork(shape("interrogation", TED.key), given)).toBe(true);
  expect(kinds.mayWork(shape("commentary", TED.key, true), given)).toBe(true);
  expect(kinds.mayWork(shape("bodycam", TED.key), new Set(["use", `channel.${TED.key}.label`]))).toBe(true);
  expect(kinds.mayWork(shape("bodycam", OTHER.key), given)).toBe(false);
  expect(kinds.mayWork(shape("bodycam", OTHER.key), new Set(["use", "edit.bodycam", `channel.${TED.key}`]))).toBe(false);
  expect(kinds.mayWork(shape("bodycam", null), given)).toBe(false);
  expect(kinds.mayWork({ style: "bodycam", subtitles: false, footageOnly: true, channel: null }, given)).toBe(false);
  // Scripts, ideas and thumbnails alike.
  expect(can.sees({ sourceKind: "youtube", channel: TED.key }, given)).toBe(true);
  expect(can.sees({ sourceKind: "commentary", channel: TED.key }, given)).toBe(true);
  expect(can.sees({ sourceKind: "youtube", channel: OTHER.key }, given)).toBe(false);
  expect(can.sees({ sourceKind: "youtube", kind: "interrogation" }, given)).toBe(false);
  expect(can.sees({ sourceKind: "commentary" }, given)).toBe(false);
  expect(mayIdeas(given)).toBe(true);
  expect(mayIdeas(new Set(["use", "edit.bodycam"]))).toBe(false);
  expect(mayIdea({ workspace: "interrogation", channel: TED.key }, given)).toBe(true);
  expect(mayIdea({ workspace: "interrogation", channel: OTHER.key }, new Set(["use", "ideas.interrogation"]))).toBe(false);
  expect(mayIdea({ workspace: "bodycam" }, given)).toBe(false);
});

test("an edit: made on the channel with no kind of video, opened, listed, changed and refused nowhere; V1 and another channel's still refused", async () => {
  const { app, store, cleanup } = fixtureHome("channel-access-edit");
  try {
    on(app.store.home);
    mock.cloud.convex.channels = [TED, OTHER];
    const call = routes(app);
    accounts.signedInForTests(CHANNEL_ONLY);
    const made = await call("POST", "/api/projects", { name: "Ted's case", channel: TED.key, ...SETTINGS });
    expect(made.status).toBe(200);
    const id = (made.body.project as { id: string }).id;
    expect({ channel: store.get(id)!.project.channel, hq: store.get(id)!.project.hq }).toEqual({ channel: TED.key, hq: true });
    expect((await call("GET", `/api/projects/${id}`)).status).toBe(200);
    expect(((await call("GET", "/api/projects")).body.projects as { id: string }[]).map((one) => one.id)).toContain(id);
    // The agent's changes, and the person's.
    await store.update(id, "agent", (project) => void (project.name = "Ted's case, cut"));
    expect(store.get(id)!.project.name).toBe("Ted's case, cut");
    expect(store.unavailable(id)).toBeNull();

    // Today's kinds of edit, and another channel's: refused, nothing made.
    const before = store.list().length;
    expect(await call("POST", "/api/projects", { name: "x", style: "bodycam", ...SETTINGS })).toEqual({ status: 403, body: { error: kinds.cantMake("edit.bodycam") } });
    expect((await call("POST", "/api/projects", { name: "x", channel: OTHER.key, ...SETTINGS })).status).toBe(403);
    expect(store.list().length).toBe(before);
    accounts.resetForTests();
    const v1 = store.createAs("A V1 bodycam edit", "bodycam", SETTINGS).project.id;
    accounts.signedInForTests(CHANNEL_ONLY);
    expect((await call("GET", `/api/projects/${v1}`)).status).toBe(403);
  } finally {
    cleanup();
  }
});

test("an edit from a channel's script, footage or commentary, with no kind of video; V1 scripts still by kind", async () => {
  const { app, store, cleanup } = fixtureHome("channel-access-handoff");
  try {
    on(app.store.home);
    mock.cloud.convex.channels = [TED, OTHER];
    accounts.signedInForTests(CHANNEL_ONLY);
    const footage = await importScript(app, written(app.store.home, { channel: TED.key }));
    expect(store.get(footage.project)!.project).toMatchObject({ channel: TED.key, hq: true, style: "bodycam" });
    expect(store.unavailable(footage.project)).toBeNull();
    await expect(importScript(app, written(app.store.home))).rejects.toThrow(kinds.cantMake("edit.interrogation"));
    await expect(importScript(app, written(app.store.home, { channel: OTHER.key }))).rejects.toThrow("isn't given to your account");
  } finally {
    cleanup();
  }
});

test("a script: a channel's footage script and a commentary made on it, opened and listed; V1 kinds and another channel's still refused", async () => {
  const { app, cleanup } = fixtureHome("channel-access-script");
  try {
    on(app.store.home);
    mock.cloud.convex.channels = [TED, OTHER];
    const call = routes(app);
    accounts.signedInForTests(CHANNEL_ONLY);
    // A commentary on the channel (Nov 21: commentary's home is the InternetJanitor channel), with no commentary grant.
    // Only on a channel whose add-on writes them (Sphe, Nov 21: what New script offers comes from the channel's add-ons).
    const both = addons.write("essay-script", true, { scripts: "both" });
    v2cloud.useSkillsForTests([{ name: addons.skillOf("essay-script"), text: both, key: v2cloud.ownKey("skill", v2cloud.laneKey(TED.key, "script"), addons.skillOf("essay-script")), latest: 1 }]);
    const essay = await call("POST", "/api/writer/scripts/commentary", { title: "Why he's hated", links: [], channel: TED.key });
    expect(essay.status).toBe(200);
    expect(essay.body).toMatchObject({ channel: TED.key, sourceKind: "commentary" });
    const essayId = essay.body.id as string;
    expect((await call("GET", `/api/writer/scripts/${essayId}`)).status).toBe(200);
    const footage = written(app.store.home, { channel: TED.key });
    expect((await call("GET", `/api/writer/scripts/${footage}`)).status).toBe(200);
    const listed = ((await call("GET", "/api/writer/scripts")).body as unknown as { id: string }[]).map((one) => one.id);
    expect(listed).toEqual(expect.arrayContaining([essayId, footage]));

    // A V1 interrogation script and a V1 commentary, and another channel's: not theirs.
    const v1 = written(app.store.home);
    const elsewhere = written(app.store.home, { channel: OTHER.key });
    for (const one of [v1, elsewhere]) expect((await call("GET", `/api/writer/scripts/${one}`)).body).toEqual({ error: can.NOT_AVAILABLE });
    expect(listed).not.toContain(v1);
    expect((await call("POST", "/api/writer/scripts/commentary", { title: "V1", links: [] })).body).toEqual({ error: can.refusal(can.COMMENTARY) });
    expect((await call("POST", "/api/writer/scripts/commentary", { title: "Theirs", links: [], channel: OTHER.key })).status).toBe(403);
  } finally {
    cleanup();
  }
});

test("an idea and a thumbnail: made on the channel with no ideas grant, opened and listed; V1 ideas and another channel's still refused", async () => {
  const { app, cleanup } = fixtureHome("channel-access-ideas");
  try {
    on(app.store.home);
    mock.cloud.convex.channels = [TED, OTHER];
    const call = routes(app);
    accounts.signedInForTests(CHANNEL_ONLY);
    const made = await call("POST", "/api/ideas", { links: "https://www.youtube.com/watch?v=JcAHmNKiHic", channel: TED.key });
    expect(made.status).toBe(200);
    const [idea] = made.body.ideas as { id: string }[];
    expect(idea).toBeDefined();
    expect(ideaRows.get(idea!.id)!.body.channel).toBe(TED.key);
    expect((await call("GET", `/api/ideas/${idea!.id}`)).status).toBe(200);
    expect(((await call("GET", "/api/ideas")).body.ideas as { id: string }[]).map((one) => one.id)).toEqual([idea!.id]);

    // A V1 idea, and another channel's, kept by someone else.
    const v1 = run.fresh("i-v1", "Sam", { workspace: "bodycam", sources: [], steer: "", wantsSummary: false });
    const theirs = run.fresh("i-other", "Sam", { workspace: "interrogation", channel: OTHER.key, sources: [], steer: "", wantsSummary: false });
    ideaRows.set(v1.id, { body: v1, rev: 1, workspace: "bodycam" });
    ideaRows.set(theirs.id, { body: theirs, rev: 1, workspace: "interrogation" });
    expect((await call("GET", `/api/ideas/${v1.id}`)).status).toBe(403);
    expect((await call("GET", `/api/ideas/${theirs.id}`)).status).toBe(403);
    expect(((await call("GET", "/api/ideas")).body.ideas as { id: string }[]).map((one) => one.id)).toEqual([idea!.id]);
    expect((await call("POST", "/api/ideas", { links: "https://www.youtube.com/watch?v=JcAHmNKiHic" })).status).toBe(403);
    expect((await call("POST", "/api/ideas", { links: "https://www.youtube.com/watch?v=JcAHmNKiHic", channel: OTHER.key })).status).toBe(403);

    // A thumbnail.
    const thumb = await call("POST", "/api/thumbnails", { title: "Ted's thumbnail", channel: TED.key });
    expect(thumb.status).toBe(200);
    expect(((await call("GET", "/api/thumbnails")).body.thumbnails as { id: string }[]).map((one) => one.id)).toEqual([thumb.body.id as string]);
    expect((await call("POST", "/api/thumbnails", { title: "Theirs", channel: OTHER.key })).status).toBe(403);
  } finally {
    cleanup();
  }
});

test("no channel given, nothing of a channel's: someone with every kind and no channel still sees none of it", async () => {
  const { app, cleanup } = fixtureHome("channel-access-none");
  try {
    on(app.store.home);
    mock.cloud.convex.channels = [TED];
    const call = routes(app);
    accounts.signedInForTests(["use", "cloud", "edit.bodycam", "edit.interrogation", "scripts.interrogation", "scripts.commentary", "ideas.interrogation"]);
    const footage = written(app.store.home, { channel: TED.key });
    expect((await call("GET", `/api/writer/scripts/${footage}`)).body).toEqual({ error: can.NOT_AVAILABLE });
    expect((await call("POST", "/api/projects", { name: "x", channel: TED.key, ...SETTINGS })).status).toBe(403);
    expect((await call("POST", "/api/writer/scripts/commentary", { title: "x", links: [], channel: TED.key })).status).toBe(403);
    await expect(importScript(app, written(app.store.home, { channel: TED.key }))).rejects.toThrow("isn't given to your account");
  } finally {
    cleanup();
  }
});
