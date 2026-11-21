// The shape of a new edit on a channel comes from its add-ons (slice 9, Sphe,
// Nov 21: "for this channel we want 9:16 (for shorts for example) or, we want
// long form and short form. Meaning when you create a project in this channel
// because of the add-on it literally changes the ui and allows you two
// paths"). `short-form` set "short": every edit made there is a 9:16 Short,
// from New edit and from a script; "both": long form unless a Short is asked;
// nothing set: what it always made, the same project. The page reads which
// forms a channel offers off its row, and its add-ons by name off its page.
// A Short made on a channel is its footage's own sound, as V1's Short is: no
// recording fetched or placed at its import, a Short's checks, no research.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import * as addons from "../src/addons.ts";
import { audit, hooks } from "../src/edit_plan.ts";
import { respond } from "../src/http/server.ts";
import type { Project, Style } from "../src/model.ts";
import { buildRouter } from "../src/routes.ts";
import * as script from "../src/script.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import * as writerStore from "../src/writer/store.ts";
import { importScript } from "../src/writer_handoff.ts";
import { fixtureHome } from "./helpers/home.ts";
import { project as newProject, stubNative } from "./helpers/model.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
let started: ReturnType<typeof spyOn>;
let renewed: ReturnType<typeof spyOn>;
const saved = { ...hooks };

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  // The import after an edit is made (footage, words, layout) isn't what's tested here.
  started = spyOn(script, "start").mockImplementation(() => null);
  renewed = spyOn(accounts, "renew").mockImplementation(async () => {});
  stubNative();
  hooks.oneColourPerPerson = () => [];
  hooks.textOnFaces = () => [];
  hooks.picturesOnFaces = () => [];
});

afterAll(() => {
  Object.assign(hooks, saved);
  started.mockRestore();
  renewed.mockRestore();
  v2cloud.useSkillsForTests([]);
  restore();
  mock.stop();
});

afterEach(() => {
  mock.cloud.convex.channels = [];
  v2cloud.useSkillsForTests([]);
  accounts.resetForTests();
});

const lanes = { ideas: "", thumbnails: "", script: "", edit: "" };
function channel(key: string, title: string, narration: { kind: "voice"; id: string; name: string } | { kind: "recorded" } = { kind: "voice", id: "v123", name: "Andrew" }) {
  return { key, youtubeId: "UC" + key.padEnd(22, "x").slice(0, 22), handle: key, title, description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0, narration, compilation: false, lanes, archived: false, addedBy: null, at: 0 };
}
/** Nothing set: every channel today. */
const PLAIN = channel("ch-ted", "Inspector Ted");
/** Every edit a Short. */
const SHORTS = channel("ch-shorts", "Shorts Placeholder");
/** Long form or short form. */
const BOTH = channel("ch-both", "Snax Dirt");
/** Every edit a Short, narrated by the team's recording (its projects' style interrogation). */
const TAPED = channel("ch-taped", "Courtroom Shorts", { kind: "recorded" });
const ALL = [PLAIN, SHORTS, BOTH, TAPED];

const FORMAT = { width: 1920, height: 1080, fps: 30 };
const WIDE = { width: 1920, height: 1080, fps: 30 };
const TALL = { width: 1080, height: 1920, fps: 30 };

/** `short-form` at a channel's edit lane, as the tool that sets add-ons keeps it. */
function shortForm(key: string, forms: "short" | "both"): v2cloud.Skill {
  return { name: addons.skillOf("short-form"), text: addons.write("short-form", true, { forms }), key: v2cloud.ownKey("skill", v2cloud.laneKey(key, "edit"), addons.skillOf("short-form")), latest: 1 };
}

/** The channels as the cloud has them, given to this person, with their add-ons in the library. */
function setUp(home: string): void {
  fs.writeFileSync(join(home, "beta.json"), JSON.stringify({ v2: true }));
  mock.cloud.convex.channels = ALL;
  accounts.signedInForTests(["use", "cloud", ...ALL.map((one) => `channel.${one.key}`)]);
  v2cloud.useSkillsForTests([shortForm(SHORTS.key, "short"), shortForm(BOTH.key, "both"), shortForm(TAPED.key, "short")]);
}

function routes(app: Parameters<typeof respond>[0]) {
  const router = buildRouter();
  return async (method: string, path: string, body?: unknown) => {
    const response = (await respond(app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), null))!;
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
}

let next = 0;
/** A finished Writer script of the channel's on this computer. */
function written(home: string, key: string): string {
  next += 1;
  const id = `8d3a1e4f-5c6f-4a71-9cad-9e8f7a6b5c${String(next).padStart(2, "0")}`;
  const dir = writerStore.scriptDir(writerStore.dataDir(home), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "script.json"), JSON.stringify({
    id, title: `Case ${next}`, kind: "interrogation", channel: key, sourceKind: "youtube", sourceUrl: "https://youtu.be/dslLBsHkVzE",
    status: "ready", stage: "ready", revision: 1, updatedAt: 1, durationMs: 20_000, originalPath: join(dir, "proxy.mp4"),
    clips: [{ id: "c1", startMs: 1_000, endMs: 4_000 }], words: [],
  }));
  return id;
}

const frame = (project: Project) => ({ width: project.settings.width, height: project.settings.height, fps: project.settings.fps });

describe("New edit on a channel", () => {
  test("nothing set: the edit is what it always was, a frame sent or none, and its row and the route say nothing new", async () => {
    const { app, store, cleanup } = fixtureHome("addons-forms-plain");
    try {
      setUp(app.store.home);
      const call = routes(app);
      // As the page sent it before (a frame), and as it sends it now (none): the same project.
      const before = await call("POST", "/api/projects", { name: "Ted's case", style: "bodycam", channel: PLAIN.key, ...FORMAT, person: true });
      const now = await call("POST", "/api/projects", { name: "Ted's case", style: "bodycam", channel: PLAIN.key, person: true });
      expect([before.status, now.status]).toEqual([200, 200]);
      const [a, b] = [before, now].map((one) => store.get((one.body.project as { id: string }).id)!.project);
      expect(frame(a!)).toEqual(WIDE);
      const { id: _a, ...restA } = a!;
      const { id: _b, ...restB } = b!;
      expect(restB).toEqual(restA);
      // As createChannelProject made it before add-ons: the store's new project, given the channel.
      const old = store.createAs("Ted's case", "bodycam", FORMAT, true).project;
      const { id: _c, origin: _o, ...restOld } = { ...old, channel: PLAIN.key };
      const { origin: _p, ...restNew } = restA;
      expect(restNew).toEqual(restOld);
      // A frame asked by hand on a channel without the add-on is still what's made, as before.
      const odd = await call("POST", "/api/projects", { name: "Square", channel: PLAIN.key, width: 1080, height: 1080, fps: 25 });
      expect(frame(store.get((odd.body.project as { id: string }).id)!.project)).toEqual({ width: 1080, height: 1080, fps: 25 });
      // A Short asked for where none is made: refused in words, nothing made.
      const count = store.list().length;
      expect(await call("POST", "/api/projects", { name: "x", channel: PLAIN.key, form: "short" })).toEqual({ status: 400, body: { error: "Inspector Ted doesn't make Shorts: its edits are long form." } });
      expect((await call("POST", "/api/projects", { name: "x", channel: PLAIN.key, form: "sideways" })).body).toEqual({ error: 'form is "long" or "short"' });
      expect(store.list().length).toBe(count);
    } finally {
      cleanup();
    }
  });

  test('"short": every edit is a 9:16 Short, whatever frame a page sends; long form is refused', async () => {
    const { app, store, cleanup } = fixtureHome("addons-forms-short");
    try {
      setUp(app.store.home);
      const call = routes(app);
      for (const sent of [{}, FORMAT]) {
        const made = await call("POST", "/api/projects", { name: "A Short", channel: SHORTS.key, ...sent });
        expect(made.status).toBe(200);
        const project = store.get((made.body.project as { id: string }).id)!.project;
        expect({ frame: frame(project), style: project.style, channel: project.channel, hq: project.hq }).toEqual({ frame: TALL, style: "bodycam", channel: SHORTS.key, hq: true });
      }
      expect(await call("POST", "/api/projects", { name: "x", channel: SHORTS.key, form: "long" })).toEqual({ status: 400, body: { error: "Shorts Placeholder makes Shorts only." } });
    } finally {
      cleanup();
    }
  });

  test('"both": long form unless a Short is asked', async () => {
    const { app, store, cleanup } = fixtureHome("addons-forms-both");
    try {
      setUp(app.store.home);
      const call = routes(app);
      const made = async (body: Record<string, unknown>) => frame(store.get(((await call("POST", "/api/projects", { name: "Snax", channel: BOTH.key, ...body })).body.project as { id: string }).id)!.project);
      expect(await made({})).toEqual(WIDE);
      expect(await made({ form: "long" })).toEqual(WIDE);
      expect(await made({ form: "short" })).toEqual(TALL);
      // The page never sends a frame; one sent by an old page doesn't decide.
      expect(await made({ form: "short", ...FORMAT })).toEqual(TALL);
    } finally {
      cleanup();
    }
  });
});

describe("an edit from a channel's script", () => {
  test("takes the channel's form: a Short on a channel making Shorts, long or Short as asked on one offering both, long with nothing set", async () => {
    const { app, store, cleanup } = fixtureHome("addons-forms-handoff");
    try {
      setUp(app.store.home);
      const of = async (key: string, asked: Record<string, unknown> = {}) => frame(store.get((await importScript(app, written(app.store.home, key), asked)).project)!.project);
      expect(await of(PLAIN.key)).toEqual(WIDE);
      expect(await of(SHORTS.key)).toEqual(TALL);
      expect(await of(BOTH.key)).toEqual(WIDE);
      expect(await of(BOTH.key, { form: "short" })).toEqual(TALL);
      await expect(of(PLAIN.key, { form: "short" })).rejects.toThrow("Inspector Ted doesn't make Shorts: its edits are long form.");
    } finally {
      cleanup();
    }
  });
});

describe("what the page reads", () => {
  test("the channels' rows: a channel's forms only where it isn't long form alone; nothing else changes", async () => {
    const { app, cleanup } = fixtureHome("addons-forms-rows");
    try {
      setUp(app.store.home);
      const rows = (await routes(app)("GET", "/api/channels")).body.channels as Record<string, unknown>[];
      const by = (key: string) => rows.find((one) => one.key === key)!;
      expect(by(PLAIN.key)).not.toHaveProperty("forms");
      expect(by(PLAIN.key)).not.toHaveProperty("scripts");
      expect(by(SHORTS.key).forms).toEqual(["short"]);
      expect(by(BOTH.key).forms).toEqual(["long", "short"]);
      // Everything else on a row is the channel's as the cloud keeps it.
      const { forms: _, ...rest } = by(BOTH.key);
      expect(Object.keys(rest).sort()).toEqual(Object.keys(by(PLAIN.key)).sort());
    } finally {
      cleanup();
    }
  });

  test("the channel's page: the add-ons set for it by their plain names, none for a channel with nothing set", async () => {
    const { app, cleanup } = fixtureHome("addons-forms-page");
    try {
      setUp(app.store.home);
      const call = routes(app);
      const page = async (key: string) => (await call("GET", `/api/channels/${key}`)).body.addons;
      // What every channel runs unset isn't named: the same four on every page would say nothing.
      expect(await page(PLAIN.key)).toEqual({ edit: [], script: [] });
      expect(await page(SHORTS.key)).toEqual({ edit: ["Shorts"], script: [] });
      expect(await page(BOTH.key)).toEqual({ edit: ["Shorts"], script: [] });
    } finally {
      cleanup();
    }
  });
});

describe("a Short made on a channel does what V1's Short does", () => {
  /** A V1 Short, and a channel's as New edit makes it: the channel narration's style, 9:16. */
  const v1Short = () => {
    const p = newProject("v1-short", TALL);
    p.style = "shorts";
    return p;
  };
  const channelShort = (key: string, style: Style) => {
    const p = newProject("channel-short", TALL);
    p.style = style;
    p.channel = key;
    p.hq = true;
    return p;
  };
  const longOn = (key: string, style: Style) => {
    const p = newProject("channel-long", WIDE);
    p.style = style;
    p.channel = key;
    p.hq = true;
    return p;
  };

  test("its import: no one narrates it, so the team's recording is neither fetched nor placed, and no research turn", () => {
    const { app, cleanup } = fixtureHome("addons-forms-narration");
    try {
      setUp(app.store.home);
      expect(script.narrationOf(v1Short())).toBe("none");
      // Recorded narration: the channel's long edits get the team's recording, its Shorts none.
      expect(script.narrationOf(channelShort(TAPED.key, "interrogation"))).toBe("none");
      expect(script.narrationOf(channelShort(SHORTS.key, "bodycam"))).toBe("none");
      expect(script.narrationOf(longOn(BOTH.key, "interrogation"))).toBe("recording");
      expect(script.narrationOf(longOn(BOTH.key, "bodycam"))).toBe("house");
      // A channel without the add-on keeps its narration whatever its frame (a moved V1 edit with an odd frame).
      expect(script.narrationOf(channelShort(PLAIN.key, "interrogation"))).toBe("recording");
      for (const p of [v1Short(), channelShort(TAPED.key, "interrogation"), channelShort(SHORTS.key, "bodycam"), channelShort(BOTH.key, "bodycam")]) {
        expect([p.channel ?? null, addons.has(p, "case-research")]).toEqual([p.channel ?? null, false]);
      }
    } finally {
      cleanup();
    }
  });

  test("Start the edit: the same add-ons and the same checks answer its plans", () => {
    const { app, cleanup } = fixtureHome("addons-forms-checks");
    try {
      setUp(app.store.home);
      const edit = (p: Project) => addons.NAMES.filter((name) => addons.CATALOGUE[name].lane === "edit" && addons.has(p, name));
      const kinds = (p: Project) => (audit(p).issues as { kind: string }[]).map((issue) => issue.kind).sort();
      const v1 = v1Short();
      for (const p of [channelShort(TAPED.key, "interrogation"), channelShort(SHORTS.key, "bodycam"), channelShort(BOTH.key, "bodycam")]) {
        expect([p.channel, edit(p)]).toEqual([p.channel, edit(v1)]);
        expect([p.channel, kinds(p)]).toEqual([p.channel, kinds(v1)]);
      }
      expect(edit(v1)).toEqual(["short-form"]);
      expect(kinds(v1).some((kind) => kind.startsWith("short_"))).toBe(true);
      // A long edit on the channel offering both runs its narration's list, never a Short's.
      expect(edit(longOn(BOTH.key, "bodycam"))).toEqual(addons.v1Of("bodycam"));
    } finally {
      cleanup();
    }
  });
});
