// A channel given is all a person needs to work on that channel (Sphe, Nov 21:
// "a channel I've given a person access to should be all they need"), on the
// relay as in Edit (apps/server/src/kinds.ts, writer/can.ts, ideas/routes.ts):
// its edits, scripts, ideas and thumbnails by the channel alone, in full or by
// its label; work of no channel by its kind, as before; a channel's own files
// by their own rule. Against a stand-in Convex.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { mayVoice, readCutOffsWith, useKeys, type Caller } from "../../../relay/src/auth";
import { channelRefused, ideaRefused, mayWork, shapeOf } from "../../../relay/src/authz";
import { forgetProjects } from "../../../relay/src/cloud";
import { mayIdeas } from "../../../relay/src/ideas";
import relay, { type Env } from "../../../relay/src/index";
import { forgetScripts, mayReadScript } from "../../../relay/src/writer_cloud";

const X = "inspectorted1";
const Y = "drinsanity";
const tokens: Record<string, string> = {};
/** Who's asking: only channel x, only its label, only a kind (each of edits, scripts, ideas), both, an admin. */
const PEOPLE: Record<string, { perms: string[]; admin?: boolean }> = {
  channel: { perms: ["use", `channel.${X}`] },
  label: { perms: ["use", `channel.${X}.label`] },
  editor: { perms: ["use", "edit.bodycam"] },
  writer: { perms: ["use", "scripts.interrogation"] },
  ideas: { perms: ["use", "ideas.interrogation"] },
  subtitler: { perms: ["use", "video.subtitles"] },
  admin: { perms: ["use"], admin: true },
};

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  useKeys(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "t1", alg: "RS256" }] }));
  readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
  for (const [name, claims] of Object.entries(PEOPLE)) {
    tokens[name] = await new SignJWT({ perms: claims.perms, admin: claims.admin === true, name })
      .setProtectedHeader({ alg: "RS256", kid: "t1" })
      .setIssuer("https://accounts.spheceo.com")
      .setAudience("edit")
      .setSubject(`person-${name}`)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  useKeys(null);
  readCutOffsWith(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  forgetProjects();
  forgetScripts();
});

const env = {
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "AKID",
  R2_SECRET_ACCESS_KEY: "SECRET",
  R2_BUCKET: "bucket",
  CONVEX_URL: "https://example.convex.cloud/",
  CONVEX_SERVICE_TOKEN: "service-token",
} as Env;

/** A stand-in Convex holding these projects, scripts and ideas (by id); anything else answers `{ok: 1}`. */
function convexWith(rows: { projects?: Record<string, unknown>; scripts?: Record<string, unknown>; ideas?: Record<string, unknown> }) {
  const reached: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("cloudflarestorage.com")) return new Response(null, { status: 204 });
    const sent = JSON.parse(String(init?.body ?? "{}")) as { path: string; args: Record<string, string> };
    reached.push(sent.path);
    const value =
      sent.path === "edit:getProject" ? (rows.projects?.[sent.args.projectId!] ?? null)
      : sent.path === "edit:listProjects" ? Object.values(rows.projects ?? {})
      : sent.path === "writer:getScript" ? (rows.scripts?.[sent.args.scriptId!] ?? null)
      : sent.path === "writer:listScripts" ? Object.values(rows.scripts ?? {})
      : sent.path === "ideas:get" ? (rows.ideas?.[sent.args.ideaId!] ?? null)
      : sent.path === "ideas:list" ? Object.values(rows.ideas ?? {})
      : { ok: 1 };
    return Response.json({ status: "success", value });
  });
  return reached;
}

const post = (path: string, body: unknown, who: string) =>
  relay.fetch(new Request(`https://relay.test${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens[who]}` }, body: JSON.stringify(body) }), env);
const get = (path: string, who: string) => relay.fetch(new Request(`https://relay.test${path}`, { headers: { authorization: `Bearer ${tokens[who]}` } }), env);
const edit = (path: string, args: Record<string, unknown>, who: string) => post("/v1/cloud/convex", { kind: path === "edit:commitProject" ? "mutation" : "query", path, args }, who);
const writer = (route: string, body: unknown, who: string) => post(`/v1/cloud/writer/${route}`, body, who);
const ideas = (path: string, kind: string, args: Record<string, unknown>, who: string) => post("/v1/ideas/convex", { kind, path, args }, who);
const person = (perms: string[], admin = false): Caller => ({ kind: "person", sub: "s", perms, admin });

describe("a channel's projects: the channel alone (Nov 21)", () => {
  it("the kinds rule: a channel's by the channel (in full or by its label), any other by its kind, an admin all", () => {
    const onX = shapeOf({ style: "bodycam", channel: X });
    const subtitledOnX = shapeOf({ style: "bodycam", subtitles: true, channel: X });
    const onY = shapeOf({ style: "bodycam", channel: Y });
    const none = shapeOf({ style: "bodycam" });
    const footage = shapeOf({ style: "bodycam", footageOnly: true });
    const given = (name: string) => new Set(PEOPLE[name]!.perms);
    expect([onX, subtitledOnX, onY, none, footage].map((shape) => mayWork(shape, given("channel")))).toEqual([true, true, false, false, false]);
    expect([onX, subtitledOnX, onY, none, footage].map((shape) => mayWork(shape, given("label")))).toEqual([true, true, false, false, false]);
    expect([onX, subtitledOnX, onY, none, footage].map((shape) => mayWork(shape, given("editor")))).toEqual([false, false, false, true, true]);
    expect([onX, onY, none].map((shape) => mayWork(shape, new Set(["use", "edit.bodycam", `channel.${X}`])))).toEqual([true, false, true]);
    expect([onX, subtitledOnX, onY, none, footage].every((shape) => mayWork(shape, null))).toBe(true);
  });

  it("saved, opened and listed on the relay by the same rule", async () => {
    const projects = {
      px: { projectId: "px", summary: { style: "bodycam", channel: X }, createdBy: { sub: "person-channel" } },
      py: { projectId: "py", summary: { style: "bodycam", channel: Y } },
      pn: { projectId: "pn", summary: { style: "bodycam" } },
    };
    convexWith({ projects });
    const commit = (projectId: string, summary: unknown, who: string) => edit("edit:commitProject", { projectId, baseRev: 0, summary }, who);
    for (const who of ["channel", "label"]) {
      expect((await commit("new1", { style: "bodycam", footageOnly: true, channel: X }, who)).status).toBe(200);
      expect((await commit("px", { style: "interrogation", channel: X }, who)).status).toBe(200);
      expect((await commit("new2", { style: "bodycam", channel: Y }, who)).status).toBe(403);
      expect((await commit("new3", { style: "bodycam" }, who)).status).toBe(403);
      expect((await commit("new4", { style: "bodycam", footageOnly: true }, who)).status).toBe(403);
      // Never over another's, nor moved off the channel into work of no channel.
      expect((await commit("pn", { style: "bodycam", channel: X }, who)).status).toBe(403);
      expect((await commit("px", { style: "bodycam" }, who)).status).toBe(403);
      expect((await edit("edit:getProject", { projectId: "px" }, who)).status).toBe(200);
      expect((await edit("edit:getProject", { projectId: "py" }, who)).status).toBe(403);
      expect((await edit("edit:getProject", { projectId: "pn" }, who)).status).toBe(403);
      const listed = (await (await edit("edit:listProjects", {}, who)).json()) as { value: { projectId: string }[] };
      expect(listed.value.map((card) => card.projectId)).toEqual(["px"]);
    }
    // Only the kind: no-channel work as before, no channel's.
    expect((await commit("new5", { style: "bodycam" }, "editor")).status).toBe(200);
    expect((await commit("new6", { style: "bodycam", channel: X }, "editor")).status).toBe(403);
    expect((await edit("edit:getProject", { projectId: "px" }, "editor")).status).toBe(403);
    expect((await edit("edit:getProject", { projectId: "pn" }, "editor")).status).toBe(200);
    // An admin: everything.
    for (const id of ["px", "py", "pn"]) expect((await edit("edit:getProject", { projectId: id }, "admin")).status).toBe(200);
    expect((await commit("py", { style: "bodycam", channel: Y }, "admin")).status).toBe(200);
  });

  it("a channel's project's own files (its review's, its chat) by the channel too", async () => {
    convexWith({ projects: { px: { projectId: "px", summary: { style: "bodycam", channel: X } }, pn: { projectId: "pn", summary: { style: "bodycam" } } } });
    const url = (key: string, who: string, method = "GET") => post("/v1/cloud/r2/url", { key, method }, who);
    expect((await url("edit/reviews/px/v1/video.mp4", "channel")).status).toBe(200);
    expect((await url("edit/chats/px.json", "label", "PUT")).status).toBe(200);
    expect((await url("edit/reviews/pn/v1/video.mp4", "channel")).status).toBe(403);
    expect((await url("edit/reviews/px/v1/video.mp4", "editor")).status).toBe(403);
    expect((await url("edit/reviews/pn/v1/video.mp4", "editor")).status).toBe(200);
  });
});

describe("a channel's scripts: the channel alone (Nov 21)", () => {
  const scripts = {
    sx: { scriptId: "sx", summary: { kind: "interrogation", channel: X } },
    cx: { scriptId: "cx", summary: { sourceKind: "commentary", channel: X } },
    sy: { scriptId: "sy", summary: { kind: "interrogation", channel: Y } },
    sn: { scriptId: "sn", summary: { kind: "interrogation" } },
  };
  const commit = (scriptId: string, summary: unknown, who: string) => writer("convex", { kind: "mutation", path: "writer:commitScript", args: { scriptId, summary } }, who);

  it("made, saved, read and listed by who holds the channel, in full or by its label", async () => {
    convexWith({ scripts });
    for (const who of ["channel", "label"]) {
      expect((await commit("new1", { kind: "interrogation", channel: X }, who)).status).toBe(200);
      expect((await commit("new2", { sourceKind: "commentary", channel: X }, who)).status).toBe(200);
      expect((await commit("sx", { kind: "courtroom", compilation: true, channel: X }, who)).status).toBe(200);
      expect((await commit("new3", { kind: "interrogation", channel: Y }, who)).status).toBe(403);
      expect((await commit("new4", { kind: "interrogation" }, who)).status).toBe(403);
      // A commit that says nothing of what it is makes a script of no channel: a kind of script, as before.
      expect((await writer("convex", { kind: "mutation", path: "writer:commitScript", args: { scriptId: "new5" } }, who)).status).toBe(403);
      expect((await commit("sn", { kind: "interrogation", channel: X }, who)).status).toBe(403);
      expect((await commit("sx", { kind: "interrogation" }, who)).status).toBe(403);
      expect((await writer("r2/url", { key: "writer/scripts/sx/body/1-ff.json" }, who)).status).toBe(200);
      expect((await writer("r2/url", { key: "writer/scripts/cx/body/2-ff.json", method: "PUT" }, who)).status).toBe(200);
      expect((await writer("r2/url", { key: "writer/scripts/sy/body/1-ff.json" }, who)).status).toBe(403);
      expect((await writer("r2/url", { key: "writer/scripts/sn/body/1-ff.json" }, who)).status).toBe(403);
      expect((await writer("r2/url", { key: "writer/scripts/sn/body/2-ff.json", method: "PUT" }, who)).status).toBe(403);
      // Its footage, as anyone who writes scripts.
      expect((await writer("convex", { kind: "mutation", path: "edit:putMedia", args: { source: "drive:a" } }, who)).status).toBe(200);
      const listed = (await (await writer("convex", { kind: "query", path: "writer:listScripts" }, who)).json()) as { value: { scriptId: string }[] };
      expect(listed.value.map((row) => row.scriptId)).toEqual(["sx", "cx"]);
      expect((await writer("convex", { kind: "query", path: "writer:getScript", args: { scriptId: "sy" } }, who)).status).toBe(403);
      // Restoring an archived script: its own channel's, never another's.
      expect((await writer("convex", { kind: "mutation", path: "writer:clearRestore", args: { scriptId: "sx" } }, who)).status).toBe(200);
      expect((await writer("convex", { kind: "mutation", path: "writer:clearRestore", args: { scriptId: "sn" } }, who)).status).toBe(403);
    }
  });

  it("only the kind: scripts of no channel as before, none of a channel's; an admin all", async () => {
    convexWith({ scripts });
    expect((await commit("new1", { kind: "interrogation" }, "writer")).status).toBe(200);
    expect((await commit("sn", { kind: "interrogation" }, "writer")).status).toBe(200);
    expect((await commit("new2", { kind: "interrogation", channel: X }, "writer")).status).toBe(403);
    expect((await commit("sx", { kind: "interrogation", channel: X }, "writer")).status).toBe(403);
    expect((await writer("r2/url", { key: "writer/scripts/sn/body/1-ff.json" }, "writer")).status).toBe(200);
    expect((await writer("r2/url", { key: "writer/scripts/sx/body/1-ff.json" }, "writer")).status).toBe(403);
    const listed = (await (await writer("convex", { kind: "query", path: "writer:listScripts" }, "writer")).json()) as { value: { scriptId: string }[] };
    expect(listed.value.map((row) => row.scriptId)).toEqual(["sn"]);
    // An editor of the style sees no channel's script either (Edit's list offers it only to who holds the channel).
    expect(mayReadScript(scripts.sx.summary, person(["use", "edit.interrogation"]))).toBe(false);
    expect(mayReadScript(scripts.sn.summary, person(["use", "edit.interrogation"]))).toBe(true);
    for (const id of ["sx", "sy", "sn", "cx"]) expect((await writer("r2/url", { key: `writer/scripts/${id}/body/1-ff.json` }, "admin")).status).toBe(200);
    expect((await commit("sy", { kind: "interrogation", channel: Y }, "admin")).status).toBe(200);
  });
});

describe("a channel's ideas and thumbnails: the channel alone (Nov 21)", () => {
  const rows = {
    ix: { ideaId: "ix", workspace: "interrogation", summary: { title: "x", channel: X } },
    ixb: { ideaId: "ixb", workspace: "bodycam", summary: { title: "x", channel: X } },
    iy: { ideaId: "iy", workspace: "interrogation", summary: { title: "y", channel: Y } },
    in: { ideaId: "in", workspace: "interrogation", summary: { title: "none" } },
  };
  const commit = (ideaId: string, summary: unknown, who: string, workspace = "interrogation") => ideas("ideas:commit", "mutation", { ideaId, workspace, baseRev: 0, body: {}, summary }, who);
  const listed = async (who: string) => ((await (await ideas("ideas:list", "query", {}, who)).json()) as { value: { ideaId: string }[] }).value.map((row) => row.ideaId);

  it("worked on by who holds the channel, whatever workspace they hold; no channel's by its workspace", async () => {
    convexWith({ ideas: rows });
    for (const who of ["channel", "label"]) {
      expect((await commit("i-new", { title: "a", channel: X }, who)).status).toBe(200);
      expect((await commit("ix", { title: "a", channel: X }, who)).status).toBe(200);
      expect((await commit("i-new", { title: "a", channel: Y }, who)).status).toBe(403);
      expect((await commit("i-new", { title: "a" }, who)).status).toBe(403);
      expect((await commit("in", { title: "a", channel: X }, who)).status).toBe(403);
      expect((await commit("ix", { title: "a" }, who)).status).toBe(403);
      expect((await ideas("ideas:get", "query", { ideaId: "ixb" }, who)).status).toBe(200);
      expect((await ideas("ideas:get", "query", { ideaId: "iy" }, who)).status).toBe(403);
      expect((await ideas("ideas:get", "query", { ideaId: "in" }, who)).status).toBe(403);
      expect((await ideas("ideas:remove", "mutation", { ideaId: "ix" }, who)).status).toBe(200);
      expect((await ideas("ideas:remove", "mutation", { ideaId: "in" }, who)).status).toBe(403);
      expect(await listed(who)).toEqual(["ix", "ixb"]);
      // Thumbnails pass the relay's gate (Convex keeps each to its channel or workspace).
      expect((await ideas("thumbnails:list", "query", {}, who)).status).toBe(200);
    }
    // Only the workspace: its own no-channel ideas, no channel's.
    expect((await commit("i-new", { title: "a" }, "ideas")).status).toBe(200);
    expect((await commit("i-new", { title: "a", channel: X }, "ideas")).status).toBe(403);
    expect((await ideas("ideas:get", "query", { ideaId: "ix" }, "ideas")).status).toBe(403);
    expect(await listed("ideas")).toEqual(["in"]);
    // Someone with neither works on no ideas at all.
    expect((await ideas("ideas:list", "query", {}, "editor")).status).toBe(403);
    expect(await listed("admin")).toEqual(["ix", "ixb", "iy", "in"]);
  });

  it("their pictures, and the team's thumbnail pictures, for who works on ideas at all, a channel given included", () => {
    expect(mayIdeas(person(["use", `channel.${X}`]))).toBe(true);
    expect(mayIdeas(person(["use", `channel.${X}.label`]))).toBe(true);
    expect(mayIdeas(person(["use", "edit.bodycam"]))).toBe(false);
    expect(ideaRefused(person(["use", `channel.${X}`]), "edit/ideas/ix/a.png")).toBeNull();
    expect(ideaRefused(person(["use", `channel.${X}.label`]), "edit/thumbnails/t1/a.png")).toBeNull();
    expect(ideaRefused(person(["use", "edit.bodycam"]), "edit/ideas/ix/a.png")).toMatch(/can't work on ideas/);
    expect(ideaRefused(person(["use"], true), "edit/ideas/ix/a.png")).toBeNull();
  });
});

describe("what comes with a channel's work, and what doesn't (Nov 21)", () => {
  it("imports from Trello and YouTube, and voice-overs, for who holds a channel; never for `use` or subtitles alone", async () => {
    for (const perms of [["use", `channel.${X}`], ["use", `channel.${X}.label`], ["use", "edit.bodycam"]]) expect(mayVoice(person(perms))).toBe(true);
    for (const perms of [["use"], ["use", "video.subtitles"], ["use", "scripts.foia"]]) expect(mayVoice(person(perms))).toBe(false);
    // On the route itself: refused before Trello is asked.
    vi.stubGlobal("fetch", async () => Response.json({ id: "c", name: "Case", desc: "", url: "", attachments: [] }));
    const trello = { ...env, TRELLO_API_KEY: "k", TRELLO_TOKEN: "t" } as Env;
    const asked = (who: string) => relay.fetch(new Request("https://relay.test/v1/trello/card?card=AbC123x", { headers: { authorization: `Bearer ${tokens[who]}` } }), trello);
    for (const who of ["channel", "label", "editor", "writer", "admin"]) expect((await asked(who)).status).toBe(200);
    for (const who of ["ideas", "subtitler"]) expect((await asked(who)).status).toBe(403);
    for (const who of ["ideas", "subtitler"]) expect((await get("/v1/youtube/check?ids=dQw4w9WgXcQ", who)).status).toBe(403);
    // Cleaning footage on RunPod (removal runs on channels' edits): past the gate (off on this relay) for who holds a channel.
    for (const who of ["channel", "label", "editor"]) expect((await post("/v1/remover/jobs", {}, who)).status).toBe(503);
    for (const who of ["writer", "ideas", "subtitler"]) expect((await post("/v1/remover/jobs", {}, who)).status).toBe(403);
  });

  it("a channel's own files keep their rule: read in full, written by a teacher, never by its label alone", () => {
    const key = `edit/channels/${X}/watermark/${"a".repeat(64)}.png`;
    expect(channelRefused(person(["use", `channel.${X}`]), "read", key)).toBeNull();
    expect(channelRefused(person(["use", `channel.${X}`]), "write", key)).toMatch(/teacher/);
    expect(channelRefused(person(["use", `channel.${X}.label`]), "read", key)).toMatch(/in full/);
    expect(channelRefused(person(["use", "edit.bodycam"]), "read", key)).toMatch(/in full/);
  });
});
