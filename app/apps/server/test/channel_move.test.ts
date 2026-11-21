// Today's kind of edit (V1) moved onto a channel from Home, made that
// channel's Edit V2 project (channel_move.ts, Sphe, Nov 21): proven the same
// video, not trusted to be. A project shaped like the team's V1 edits (footage
// cut with its sound, a cut-in card and its voice-over, an evidence board's
// framed photo moving in, a title, subtitles, a look over a stretch, music
// and a sound effect, a script link) is moved through the route; the saved
// project is equal to the one before in every field but `hq`, `channel` and `removal_held`,
// its export plans are the same, and with the real engine built its frames
// are the same bytes. Then what's refused, and what must be right after: a
// new conversation, removal not started by itself, the move never undone.

import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import { Agents } from "../src/agent.ts";
import * as changes from "../src/changes.ts";
import * as channels from "../src/channels.ts";
import * as cloud from "../src/cloud.ts";
import { readOnly } from "../src/cloud_projects.ts";
import * as claude from "../src/claude.ts";
import { planExport } from "../src/exports.ts";
import { respond } from "../src/http/server.ts";
import * as jobs from "../src/jobs.ts";
import { dispatch } from "../src/mcp/index.ts";
import type { Clip, ExportOptions, Project } from "../src/model.ts";
import { findAddon, native, useNative, wrap, type Native } from "../src/native/index.ts";
import * as removalAsks from "../src/removal_asks.ts";
import * as removal from "../src/removal_lesson.ts";
import { buildRouter } from "../src/routes.ts";
import { jsonForSerde } from "../src/rust.ts";
import { editSide } from "../src/script_sync.ts";
import { stableStringify } from "../src/stable.ts";
import { Store } from "../src/store.ts";
import * as tools from "../src/tools.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

afterEach(() => {
  accounts.resetForTests();
  v2cloud.useSkillsForTests([]);
  channels.useChannelsForTests([]);
  mock.cloud.convex.channels = [];
});

const CHANNEL = {
  key: "ch-cuffed", youtubeId: "UC" + "c".repeat(22), handle: "cuffed", title: "Cuffed & Caught", description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0,
  narration: { kind: "voice" as const, id: "v-andrew", name: "Andrew" }, compilation: true, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, archived: false, addedBy: null, at: 0,
};
const AWAY = { ...CHANNEL, key: "ch-away", youtubeId: "UC" + "d".repeat(22), title: "Put Away", archived: true };

/** The real engine, when it's built here (crates/edit-native): the plans and frames below are its own. */
const addon = findAddon();

/** A fixture home with Edit V2 on (or off), the channels in the cloud, and someone signed in with `perms`. */
function home(name: string, { v2 = true, perms = ["edit.courtroom", "channel.ch-cuffed"] }: { v2?: boolean; perms?: string[] } = {}) {
  const made = fixtureHome(name);
  if (addon !== null) {
    useNative(wrap(require(addon) as Native));
    native().init({ home: made.home, cacheDir: join(made.home, "cache"), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe(), log: () => {} });
  }
  if (v2) fs.writeFileSync(join(made.home, "beta.json"), JSON.stringify({ v2: true }));
  mock.cloud.convex.channels = [CHANNEL, AWAY];
  channels.useChannelsForTests([CHANNEL, AWAY] as never);
  accounts.signedInForTests(perms);
  changes.start(made.app);
  const router = buildRouter();
  const ask = async (method: string, path: string) => {
    const response = (await respond(made.app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" }), null))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { ...made, ask };
}

/** Its footage, a photo, a voice-over and music, made by FFmpeg from its own test sources (nothing downloaded). */
async function files(dir: string): Promise<Record<string, string>> {
  const out = { a: join(dir, "a.mp4"), b: join(dir, "b.mp4"), photo: join(dir, "photo.png"), voice: join(dir, "voice.wav"), music: join(dir, "music.m4a") };
  const ff = (...args: string[]) => tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...args]);
  fs.mkdirSync(dir, { recursive: true });
  await ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out.a);
  await ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out.b);
  await ff("-f", "lavfi", "-i", "smptebars=size=400x300", "-frames:v", "1", out.photo);
  await ff("-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=3", out.voice);
  await ff("-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=10", "-c:a", "aac", out.music);
  return out;
}

/** A courtroom V1 edit as the house's tools leave one, saved through the store like any. */
async function v1Edit(made: ReturnType<typeof home>): Promise<string> {
  const paths = await files(join(made.home, "media", "fixture"));
  const id = made.store.createAs("Mom Sentenced", "courtroom", { width: 640, height: 360, fps: 30 }).project.id;
  await made.store.update(id, "ui-test", (project: Project) => {
    const [v1, v2, v3] = project.tracks.filter((track) => track.kind === "video").map((track) => track.id);
    const [a1, a2] = project.tracks.filter((track) => track.kind === "audio").map((track) => track.id);
    project.tracks.push({ id: "subs", kind: "video", name: "Subtitles", hidden: false, muted: false, locked: false } as unknown as Project["tracks"][number]);
    project.tracks.push({ id: "music", kind: "audio", name: "Music", hidden: false, muted: false, locked: false } as unknown as Project["tracks"][number]);
    project.media.push(
      media({ id: "ma", name: "Bodycam A", path: paths.a!, kind: "video", duration: 6, width: 640, height: 360, fps: 30, has_audio: true }),
      media({ id: "mb", name: "Bodycam B", path: paths.b!, kind: "video", duration: 6, width: 640, height: 360, fps: 30, has_audio: true }),
      media({ id: "mp", name: "Evidence photo", path: paths.photo!, kind: "image", duration: 0, width: 400, height: 300 }),
      media({ id: "mv", name: "Voice-over", path: paths.voice!, kind: "audio", duration: 3, has_audio: true }),
      media({ id: "mm", name: "Tension bed", path: paths.music!, kind: "audio", duration: 10, has_audio: true, library: "music" } as never),
    );
    const clips: Record<string, unknown>[] = [
      // The footage, picture and sound linked, the second cut in with a fade.
      { id: "c1", type: "video", track: v1, start: 0, duration: 90, media: "ma", source_in: 0, link: "l1", name: "Bodycam A" },
      { id: "c2", type: "audio", track: a1, start: 0, duration: 90, media: "ma", source_in: 0, link: "l1", volume_db: -2 },
      { id: "c3", type: "video", track: v1, start: 90, duration: 90, media: "mb", source_in: 1, link: "l2", fade_in: 6 },
      { id: "c4", type: "audio", track: a1, start: 90, duration: 90, media: "mb", source_in: 1, link: "l2", mutes: [{ from: 2, to: 2.4 }] },
      // A cut-in: the black card, its words, and its voice-over.
      { id: "c5", type: "solid", track: v1, start: 180, duration: 60, fill: [0, 0, 0, 1], name: "Cut-in 1" },
      { id: "c6", type: "text", track: v2, start: 180, duration: 60, text: "THREE WEEKS LATER", style: { size: 48, weight: 800 }, name: "Cut-in 1 · words" },
      { id: "c7", type: "audio", track: a2, start: 182, duration: 58, media: "mv", source_in: 0, name: "Voice-over" },
      // The evidence board: the photo framed, pushing in.
      { id: "c8", type: "video", track: v2, start: 30, duration: 60, media: "mp", source_in: 0, frame: { width: 10, color: [1, 1, 1, 1], shadow: 0.5 }, transform: { x: 0.1, y: -0.05, scale: 0.6, rotation: -3 }, keyframes: { scale: [{ frame: 0, value: 0.5, ease: "out" }, { frame: 30, value: 0.6 }] }, name: "Evidence board · photo" },
      // The title, a look over a stretch, and the subtitles.
      { id: "c9", type: "text", track: v3, start: 0, duration: 45, text: "THE SENTENCING", style: { size: 64, weight: 900 }, transform: { x: 0, y: 0.3, scale: 1, rotation: 0 }, name: "Title" },
      { id: "c10", type: "adjustment", track: v3, start: 120, duration: 30, grade: { exposure: -0.3, contrast: 1.2, saturation: 0.4, temperature: 0, vignette: 0.5 }, blur: { radius: 6 } },
      { id: "c11", type: "text", track: "subs", start: 95, duration: 40, text: "You have the right to remain silent.", name: "Subtitle · 1" },
      { id: "c12", type: "text", track: "subs", start: 140, duration: 35, text: "Anything you say can be used.", name: "Subtitle · 2" },
      // Music under it all, and a hit at the cut.
      { id: "c13", type: "audio", track: "music", start: 0, duration: 240, media: "mm", source_in: 0, volume_db: -18, fade_out: 30 },
    ];
    project.clips.push(...clips.map((one) => clip(one) as Clip));
    project.script = { source: "writer:s-mom", blocks: [{ kind: "footage", url: "https://example.com/a", file: `sha256:${"a".repeat(64)}`, start: 0, end: 3, label: "00:00 - 00:03", media: "ma", clip: "c1", origin: "sc1" }, { kind: "narration", text: "Three weeks later.", clip: "c5", voiceover: "c7", origin: "sc2" }] } as unknown as Project["script"];
    project.people = [{ id: "pp1", name: "Judge Ross", label: "Judge:", role: "leader", color: "#f2d03b" }];
    project.note = "goes on Cuffed & Caught";
  });
  return id;
}

const ALL_BUT_KIND = (project: Project) => stableStringify({ ...project, hq: undefined, channel: undefined, removal_held: undefined });

/** The export plans the share and the dialog ask for: the whole edit, a stretch, a 9:16 cut, sound alone. */
function plans(project: Project): unknown[] {
  const base = native().exportDefaults();
  const asked: ExportOptions[] = [
    { ...base, preset: "youtube", range: null, chapters: [] } as ExportOptions,
    { ...base, range: [30, 150] } as ExportOptions,
    { ...base, shape: "vertical", fill: "blur" } as unknown as ExportOptions,
    { ...base, format: "wav" } as unknown as ExportOptions,
  ];
  return asked.map((options) => {
    try {
      return planExport(project, options, null);
    } catch (error) {
      return { refused: String(error) };
    }
  });
}

test("a V1 edit moved onto a channel is that channel's Edit V2 project, the same in every field but those two, with the same export plans and frames", async () => {
  const made = home("move-identical");
  try {
    const id = await v1Edit(made);
    const before = made.store.get(id)!;
    expect(before.project.hq).toBeUndefined();
    const planned = plans(before.project);
    const frames = [0, 45, 60, 100, 130, 200, 239];
    const render = async (project: Project) => (await native().renderFrames({ project: { json: jsonForSerde(project) }, frames, maxSide: 640, priority: "agent", encode: "png" })).map((one) => Buffer.from(one.data).toString("base64"));
    const real = addon !== null;
    const pictures = real ? await render(before.project) : [];
    const seen: Record<string, unknown>[] = [];
    const off = made.store.subscribe((event) => void seen.push(event));

    const answer = await made.ask("POST", `/api/channels/ch-cuffed/projects/${id}`);
    off();
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ project: { id, channel: "ch-cuffed", hq: true, rev: before.rev + 1 } });
    const after = made.store.get(id)!;
    expect(after.rev).toBe(before.rev + 1);
    expect(after.project.hq).toBe(true);
    expect(after.project.channel).toBe("ch-cuffed");
    // Everything else as it was, the style among it: not a clip, track, medium, setting, script link, person or note.
    expect(after.project.style).toBe("courtroom");
    expect(ALL_BUT_KIND(after.project)).toBe(ALL_BUT_KIND(before.project));
    // As saved on disk too: a fresh read of the file is the same.
    const reread = Store.open(made.home).get(id)!.project;
    expect(ALL_BUT_KIND(reread)).toBe(ALL_BUT_KIND(before.project));
    expect([reread.hq, reread.channel, reread.removal_held]).toEqual([true, "ch-cuffed", true]);
    // One save, the person's (nothing of Edit's after it: no pass ran, nothing laid).
    expect(seen.filter((event) => event.type === "project").map((event) => [event.origin, event.rev])).toEqual([["ui-home", before.rev + 1]]);
    expect(seen.some((event) => event.type === "agent")).toBe(false);
    // The script link in step: every script clip's edit side is what was agreed before.
    for (const origin of ["sc1", "sc2"]) expect(editSide(after.project, origin)).toEqual(editSide(before.project, origin));
    // Home lists it as the channel's V2 project.
    const listed = made.store.list().find((one) => one.id === id)!;
    expect([listed.hq, listed.channel]).toEqual([true, "ch-cuffed"]);
    // The export plans the same (the engine never reads `hq` or `channel`), and with the real engine the frames byte for byte.
    expect(plans(after.project)).toEqual(planned);
    if (real) {
      expect(planned.every((one) => !("refused" in (one as object)))).toBe(true);
      expect(await render(after.project)).toEqual(pictures);
      expect(pictures.length).toBe(frames.length);
    }
  } finally {
    made.cleanup();
  }
}, 60_000);

test("the move is refused with Edit V2 off, for a channel put away, not given or not there, while work runs, and while another computer holds it", async () => {
  const off = home("move-off", { v2: false });
  try {
    const id = off.store.createAs("V1", "courtroom", { width: 640, height: 360, fps: 30 }).project.id;
    expect(await off.ask("POST", `/api/channels/ch-cuffed/projects/${id}`)).toEqual({ status: 400, body: { error: "Channels are Edit V2's: turn it on in Settings → Beta." } });
    expect(off.store.get(id)!.project.hq).toBeUndefined();
  } finally {
    off.cleanup();
  }
  const made = home("move-refused", { perms: ["edit.courtroom", "channel.ch-cuffed", "channel.ch-away"] });
  try {
    const id = made.store.createAs("V1", "courtroom", { width: 640, height: 360, fps: 30 }).project.id;
    const was = made.store.get(id)!.rev;
    const move = (key = "ch-cuffed") => made.ask("POST", `/api/channels/${key}/projects/${id}`);
    expect(await move("ch-away")).toEqual({ status: 400, body: { error: "Put Away was put away: an admin can bring it back (add it again), or pick another channel." } });
    expect((await move("ch-nobody")).body.error).toBe("That channel isn't in Edit, or isn't shown to your account: pick another, or ask an admin to give it to you.");
    expect((await made.ask("POST", "/api/channels/ch-cuffed/projects/p-not-here")).status).toBe(404);
    // An export, then a share, waiting in the job table; and footage coming in on its page.
    const job = jobs.begin(made.home, "export", id, {});
    expect(await move()).toEqual({ status: 409, body: { error: "An export is under way on this edit: move it once it's done." } });
    jobs.end(made.home, job);
    const share = jobs.begin(made.home, "share", id, {});
    const turn = jobs.begin(made.home, "turn", id, {});
    expect((await move()).body.error).toBe("A share and an agent turn are under way on this edit: move it once they're done.");
    jobs.end(made.home, share);
    jobs.end(made.home, turn);
    // Another computer editing it: its words, and nothing saved.
    made.store.attachCloud({ mayWrite: async () => Promise.reject(new Error(readOnly("marc-mbp"))), wrote: () => {}, created: () => {} });
    const held = await move();
    expect(held.status).toBe(409);
    expect(String(held.body.error)).toContain("is editing this project, so it's read-only here");
    expect(made.store.get(id)!.rev).toBe(was);
    expect(made.store.get(id)!.project.hq).toBeUndefined();
    // Removal wasn't left held for it either.
    expect(removalAsks.isStopped(made.home, id)).toBe(false);
  } finally {
    made.cleanup();
  }
  // A channel this person hasn't been given.
  const other = home("move-not-given", { perms: ["edit.courtroom"] });
  // The fresh token asked for first (tokenCarries) says the same: still not given.
  const renew = spyOn(accounts, "renew").mockResolvedValue();
  try {
    const id = other.store.createAs("V1", "courtroom", { width: 640, height: 360, fps: 30 }).project.id;
    expect(await other.ask("POST", `/api/channels/ch-cuffed/projects/${id}`)).toEqual({ status: 403, body: { error: "Cuffed & Caught isn't given to your account yet: ask an admin to give it to you on accounts.spheceo.com." } });
    expect(other.store.get(id)!.project.hq).toBeUndefined();
  } finally {
    renew.mockRestore();
    other.cleanup();
  }
});

test("after the move its agent starts a new conversation with V2's instructions and tools, and the chat stays readable", async () => {
  const made = home("move-new-chat");
  try {
    const id = made.store.createAs("V1", "courtroom", { width: 640, height: 360, fps: 30 }).project.id;
    const agents = new Agents(made.store, made.home, 7700);
    made.app.agents = agents;
    const asked: claude.Options[] = [];
    agents.findClaude = async () => "/test/claude";
    agents.claudeQuery = async (params) => {
      asked.push(params.options);
      async function* messages() {
        yield { type: "system", subtype: "init", session_id: `session-${asked.length}` };
        yield { type: "result", subtype: "success", is_error: false, usage: {} };
      }
      return Object.assign(messages(), { interrupt: async () => undefined, close: () => {} }) as unknown as claude.Query;
    };
    await agents.send(id, "Tighten the intro", "opus", "low");
    for (let i = 0; i < 50 && agents.turn(id).running; i++) await Bun.sleep(10);
    expect(asked[0]!.resume).toBeUndefined();
    expect(String(asked[0]!.systemPrompt)).not.toContain("THIS IS AN EDIT V2 VIDEO");
    // The V1 conversation goes on as one.
    await agents.send(id, "And the outro", null, null);
    for (let i = 0; i < 50 && agents.turn(id).running; i++) await Bun.sleep(10);
    expect(asked[1]!.resume).toBe("session-1");

    expect((await made.ask("POST", `/api/channels/ch-cuffed/projects/${id}`)).status).toBe(200);
    // Kept as a new conversation across a restart: the chat file says so.
    const saved = JSON.parse(fs.readFileSync(made.store.chatPath(id), "utf8")) as { thread: unknown; model: unknown; effort: unknown; entries: { kind: string; text: string }[] };
    expect([saved.thread, saved.model, saved.effort]).toEqual([null, null, null]);
    expect(saved.entries.filter((one) => one.kind === "user").map((one) => one.text)).toEqual(["Tighten the intro", "And the outro"]);

    await agents.send(id, "Make the evidence board", null, null);
    for (let i = 0; i < 50 && agents.turn(id).running; i++) await Bun.sleep(10);
    const next = asked[2]!;
    expect(next.resume).toBeUndefined();
    expect(String(next.systemPrompt)).toContain("THIS IS AN EDIT V2 VIDEO");
    // V2's own model and level, not the ones picked in the V1 chat.
    expect(next.effort).toBe("high");
    expect(next.cwd).toBe(fs.realpathSync(join(made.home, "media", id, "effects")));
    // Its old messages still there to read, the new one after them.
    expect(agents.turn(id).entries.filter((one) => one.kind === "user").map((one) => one.text)).toEqual(["Tighten the intro", "And the outro", "Make the evidence board"]);
  } finally {
    made.cleanup();
  }
});

test("a channel taught to take another channel's text out doesn't start on a moved edit by itself; one made on the channel does", async () => {
  const made = home("move-removal");
  try {
    v2cloud.useSkillsForTests([{ name: removal.SKILL, key: v2cloud.ownKey("skill", "ch-cuffed--edit", removal.SKILL), text: removal.write(removal.changed(null, { watermarks: true, subtitles: true }, [], false, {})) }]);
    const id = made.store.createAs("V1", "courtroom", { width: 640, height: 360, fps: 30 }).project.id;
    const lesson = removal.lessonOf({ channel: "ch-cuffed" });
    expect(removal.takesOut(lesson)).toBe(true);
    expect((await made.ask("POST", `/api/channels/ch-cuffed/projects/${id}`)).status).toBe(200);
    // What resume, an edit's rest and an export's wait each ask first: nothing runs by itself here.
    expect(removalAsks.inForce(removal.lessonOf(made.store.get(id)!.project), made.home, id)).toBeNull();
    // Held in the project, not in a file on the computer that moved it: another computer opening it reads the same.
    expect(made.store.get(id)!.project.removal_held).toBe(true);
    expect(fs.existsSync(join(made.home, "removal-stopped.json"))).toBe(false);
    // A project made on the channel the usual way: in force.
    const fresh = made.store.createAs("V2", "bodycam", { width: 640, height: 360, fps: 30 }, true).project.id;
    expect(removal.takesOut(removalAsks.inForce(lesson, made.home, fresh))).toBe(true);
    // Asked for in the chat (start_removal), it runs on the moved edit as on any.
    removalAsks.add(made.home, id, { at: Date.now(), kinds: ["watermarks"], media: "all" });
    expect(removalAsks.inForce(lesson, made.home, id)?.remove.watermarks).toBe(true);
  } finally {
    made.cleanup();
  }
});

test("the move is the person's change in the history; undo_changes never takes it back, and an undo across it keeps it a V2 project", async () => {
  const made = home("move-undo");
  // Taught something, so its agent's tools change the edit (teaching_gate.ts): an untaught channel's refuse first.
  v2cloud.useSkillsForTests([{ name: "pacing", key: v2cloud.ownKey("skill", "ch-cuffed--edit", "pacing"), text: "Hold on faces." }]);
  try {
    const id = made.store.createAs("V1", "courtroom", { width: 640, height: 360, fps: 30 }).project.id;
    const [renamed] = await made.store.update(id, "ui-test", (project) => {
      project.name = "Renamed in V1";
    });
    expect((await made.ask("POST", `/api/channels/ch-cuffed/projects/${id}`)).status).toBe(200);
    const moved = made.store.get(id)!.rev;
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await dispatch(made.app, { id: 1, method: "tools/call", params: { name, arguments: args } }, id)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
    expect((await call("edit_history", {})).content[0]!.text).toContain(`- rev ${moved}, `);
    expect((await call("edit_history", {})).content[0]!.text).toMatch(new RegExp(`rev ${moved}, [0-9:]+, the person: hq, channel`));
    const refused = await call("undo_changes", { revs: [moved] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain(`rev ${moved} moved this project onto its channel, which isn't an edit and isn't undone`);
    expect(made.store.get(id)!.rev).toBe(moved);
    // Back to before the rename: the name goes back, the project stays the channel's V2 project.
    expect((await call("undo_changes", { back_to: renamed.rev - 1 })).isError).toBe(false);
    const now = made.store.get(id)!.project;
    expect(now.name).toBe("V1");
    expect([now.hq, now.channel]).toEqual([true, "ch-cuffed"]);
  } finally {
    made.cleanup();
  }
});

test("reviews and exports already made are untouched by the move", async () => {
  const made = home("move-reviews");
  try {
    const id = made.store.createAs("V1", "courtroom", { width: 640, height: 360, fps: 30 }).project.id;
    const reviews = JSON.stringify({ cursor: 0, shared: { [id]: { link: "https://review.example/r1" } }, notes: {}, shareWatermark: { [id]: "pic-si" } });
    const exportsList = JSON.stringify({ [id]: [{ path: "/tmp/a.mp4", at: 1 }] });
    fs.writeFileSync(join(made.home, "reviews.json"), reviews);
    fs.writeFileSync(join(made.home, "exports.json"), exportsList);
    expect((await made.ask("POST", `/api/channels/ch-cuffed/projects/${id}`)).status).toBe(200);
    expect(fs.readFileSync(join(made.home, "reviews.json"), "utf8")).toBe(reviews);
    expect(fs.readFileSync(join(made.home, "exports.json"), "utf8")).toBe(exportsList);
  } finally {
    made.cleanup();
  }
});
