import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { agentInstructions } from "../src/agent.ts";
import * as effects from "../src/effects.ts";
import * as fonts from "../src/fonts.ts";
import runtimeText from "../src/effect_runtime.html" with { type: "text" };
import { fingerprint } from "../src/hash.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { HQ_TOOLS, NOT_IN_HQ, toolsFor, TOOLS } from "../src/mcp/registry.ts";
import * as playing from "../src/playing.ts";
import * as tools from "../src/tools.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as seams from "../src/seams.ts";
import * as cloudProjects from "../src/cloud_projects.ts";
import * as relay from "../src/relay.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";

registerEffectTools();
registerEditingTools();
afterAll(() => effects.closeChrome());

/** A page that keeps the contract: a bar that crosses the frame in two seconds, and a count of the frame. */
const GOOD = `<!doctype html>
<html><body style="margin:0;background:#101418;overflow:hidden">
<div id="bar" style="position:absolute;top:500px;left:0;width:80px;height:80px;background:#e0343c"></div>
<div id="n" style="position:absolute;left:40px;top:40px;font:700 64px sans-serif;color:#fff"></div>
<script>
window.duration = 2;
window.ready = Promise.resolve();
window.seek = (t) => {
  document.getElementById("bar").style.transform = "translateX(" + Math.round((t / 2) * 1840) + "px)";
  document.getElementById("n").textContent = String(Math.round(t * 30));
};
</script></body></html>`;

function hq(name: string, size = { width: 1920, height: 1080 }) {
  const home = fixtureHome(name);
  const live = home.app.store.create("Welfare check", { ...size, fps: 30 });
  return { ...home, id: live.project.id };
}

function write(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, files: Record<string, string>): string {
  const dir = effects.folder(app.store, project, name);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(join(dir, file, ".."), { recursive: true });
    fs.writeFileSync(join(dir, file), text);
  }
  return dir;
}

async function get(app: ReturnType<typeof fixtureHome>["app"], path: string): Promise<Response> {
  return (await respond(app, buildRouter(), new Request(`http://127.0.0.1:7700${path}`, { headers: { host: "127.0.0.1:7700" } }), null))!;
}

test("an effect's page is served shut in: no origin, no network, only its own folder, Edit's runtime ahead of its code", async () => {
  const { app, cleanup, id } = hq("effects-serve");
  try {
    write(app, id, "bar", { "scene.html": GOOD, "img/a.txt": "beside it" });
    // The list the viewer asks for: the effects with a page, each with its page's address.
    fs.mkdirSync(effects.folder(app.store, id, "half-written"), { recursive: true });
    const listed = (await (await get(app, `/api/projects/${id}/effects`)).json()) as { effects: effects.Effect[] };
    expect(listed.effects.map((effect) => effect.name)).toEqual(["bar"]);
    expect(listed.effects[0]!.changed).toBeGreaterThan(0);
    const address = listed.effects[0]!.page;
    expect(address).toMatch(new RegExp(`^/api/effects/[0-9a-f]{32}/${id}/bar/scene\\.html$`));
    const base = address.slice(0, -"scene.html".length);

    const page = await get(app, address);
    expect(page.status).toBe(200);
    const policy = page.headers.get("content-security-policy")!;
    expect(policy).toContain("sandbox allow-scripts;");
    expect(policy).not.toContain("allow-same-origin");
    // Its own folder only, on a loopback name with its siblings (a map spreads its tiles over t0…t7.localhost).
    expect(policy).toContain(`connect-src http://127.0.0.1:7700${base} https://127.0.0.1:7700${base} http://*.localhost:7700${base};`);
    // With its scheme, both of them: WebKit matches a source without one to nothing for a page with no origin (Nov 11, Edit.app's window).
    expect(policy).toContain(`img-src http://127.0.0.1:7700${base} https://127.0.0.1:7700${base} http://*.localhost:7700${base} data: blob:`);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const text = await page.text();
    expect(text.startsWith('<!doctype html>\n<style>\n@font-face { font-family: "Geist"; font-weight: 400; src: url(edit-fonts/Geist-Regular.ttf); }')).toBe(true);
    // Edit's faces, served as if in its folder, for the page alone.
    const face = await get(app, `${base}edit-fonts/ReenieBeanie.ttf`);
    expect(face.status).toBe(200);
    expect(face.headers.get("access-control-allow-origin")).toBe("null");
    expect(face.headers.get("content-security-policy")).toBe(policy);
    expect((await face.arrayBuffer()).byteLength).toBeGreaterThan(30_000);
    // Commentary's face is among them (its graphics are set in it); the renderer's 9 MB fallback isn't.
    expect((await get(app, `${base}edit-fonts/AkwePro-Bold.otf`)).status).toBe(200);
    expect((await get(app, `${base}edit-fonts/NotoSansJP-Bold.ttf`)).status).toBe(404);
    expect(text.indexOf("window.__edit")).toBeLessThan(text.indexOf("window.duration = 2"));
    // A file beside it, with the same walls.
    const beside = await get(app, `${base}img/a.txt`);
    expect(await beside.text()).toBe("beside it");
    expect(beside.headers.get("content-security-policy")).toBe(policy);
    // The page's own loads come as a stranger's would (no origin, marked cross-site, no Referer): let in for an
    // effect's files, whose address holds the key, and for nothing else of the app.
    const asked = (path: string, headers: Record<string, string>) => respond(app, buildRouter(), new Request(`http://127.0.0.1:7700${path}`, { headers: { host: "127.0.0.1:7700", ...headers } }), null);
    const fromThePage = { "sec-fetch-site": "cross-site" };
    expect((await asked(`${base}img/a.txt`, fromThePage))!.status).toBe(200);
    expect((await asked(`${base}img/a.txt`, { ...fromThePage, origin: "null" }))!.status).toBe(200);
    expect((await asked(`/api/projects/${id}`, { ...fromThePage, origin: "null" }))!.status).toBe(403);
    expect((await asked(`/api/projects/${id}/effects`, fromThePage))!.status).toBe(403);
    // Another site's page: refused with its own origin, and it can't name the address without the key.
    expect((await asked(`${base}img/a.txt`, { origin: "https://elsewhere.example" }))!.status).toBe(403);
    expect((await asked(`/api/effects/${"0".repeat(32)}/${id}/bar/img/a.txt`, fromThePage))!.status).toBe(403);
    expect((await get(app, `/api/effects/${"0".repeat(32)}/${id}/bar/img/a.txt`)).status).toBe(404);
    // Framed by Edit's viewer alone; every other answer of Edit's is framed by nobody.
    expect(policy).toContain("frame-ancestors 'self'");
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect((await asked(`/api/projects/${id}`, {}))!.headers.get("x-frame-options")).toBe("DENY");
    // Every file of its folder may be read by the page (which has no origin): a font, and a picture's pixels too.
    write(app, id, "bar", { "fonts/hand.ttf": "font", "img/photo.jpg": "photo" });
    expect((await get(app, `${base}fonts/hand.ttf`)).headers.get("access-control-allow-origin")).toBe("null");
    expect((await get(app, `${base}img/photo.jpg`)).headers.get("access-control-allow-origin")).toBe("null");
    // Nothing from outside the folder: not by a path, and not by a link in it.
    fs.writeFileSync(join(effects.root(app.store, id), "secret.txt"), "another effect's");
    expect((await get(app, `${base}..%2Fsecret.txt`)).status).toBe(404);
    fs.symlinkSync(join(effects.root(app.store, id), "secret.txt"), join(effects.folder(app.store, id, "bar"), "link.txt"));
    expect((await get(app, `${base}link.txt`)).status).toBe(404);
    expect((await get(app, base.replace("/bar/", "/Bad Name/") + "scene.html")).status).toBe(404);
    expect((await get(app, base.replace(id, "nope") + "scene.html")).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("a map is there in every effect as if in its folder: the helper, a place, and nothing deeper but the map's", async () => {
  const { app, cleanup, id } = hq("effects-map");
  try {
    write(app, id, "aerial", { "scene.html": GOOD, "edit-map/own.txt": "the effect's own" });
    const listed = (await (await get(app, `/api/projects/${id}/effects`)).json()) as { effects: effects.Effect[] };
    const base = listed.effects[0]!.page.slice(0, -"scene.html".length);
    const policy = (await get(app, `${base}scene.html`)).headers.get("content-security-policy")!;
    const helper = await get(app, `${base}edit-map/map.js`);
    expect(helper.status).toBe(200);
    expect(helper.headers.get("content-type")).toContain("text/javascript");
    expect(helper.headers.get("content-security-policy")).toBe(policy);
    expect(helper.headers.get("access-control-allow-origin")).toBe("null");
    const code = await helper.text();
    expect(code).toContain("window.EditMap");
    expect(code).not.toContain("<script>");
    // A file of the effect's own by the name is never shadowed.
    expect(await (await get(app, `${base}edit-map/own.txt`)).text()).toBe("the effect's own");
    // A place needs saying.
    const unsaid = await get(app, `${base}edit-map/place`);
    expect(unsaid.status).toBe(400);
    expect(((await unsaid.json()) as { error: string }).error).toContain("which place");
    // Deeper than an effect's own three parts is the map's alone, and Cesium's files stay in its own folder.
    expect((await get(app, `${base}img/a/b/c.png`)).status).toBe(404);
    expect((await get(app, `${base}edit-map/cesium/..%2F..%2Fsecret`)).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("a font the project fetched is there in its effects by name: declared ahead of the page's code, its file served as if in the folder", async () => {
  // Sphe, Nov 12: fonts the agent pulls, beyond Edit's own faces (fonts.ts).
  const { app, cleanup, id } = hq("effects-fonts");
  try {
    write(app, id, "bar", { "scene.html": GOOD });
    const dir = join(fonts.projectDir(app.store, id), "caveat");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "Caveat-400.ttf"), "font");
    fs.writeFileSync(join(dir, "font.json"), JSON.stringify({ family: "Caveat", faces: [{ weight: 400, style: "normal", file: "Caveat-400.ttf" }], source: "Google Fonts" }));
    const address = ((await (await get(app, `/api/projects/${id}/effects`)).json()) as { effects: effects.Effect[] }).effects[0]!.page;
    const text = await (await get(app, address)).text();
    expect(text).toContain('@font-face { font-family: "Caveat"; font-weight: 400; font-style: normal; src: url(edit-fonts/caveat/Caveat-400.ttf); }');
    const file = await get(app, `${address.slice(0, -"scene.html".length)}edit-fonts/caveat/Caveat-400.ttf`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("font");
    expect((await get(app, `${address.slice(0, -"scene.html".length)}edit-fonts/caveat/nope.ttf`)).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("an effect's key is its code's content: the same files with other times (fetched onto another computer) are the same version, and a font-free one has no font part", () => {
  const { app, cleanup, id } = hq("effects-key");
  try {
    const dir = write(app, id, "bar", { "scene.html": GOOD, ".beneath.json": "{\"key\":\"k\"}" });
    const faces = effects.FONTS.filter((font) => font.later !== true).map((font) => `@font-face { font-family: "${font.family}"; font-weight: ${font.weight}; src: url(edit-fonts/${font.file}); }`).join("\n");
    const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
    const key = effects.list(app.store, id)[0]!.key;
    expect(key).toBe(fingerprint([runtimeText as unknown as string, faces, "content", "1920x1080@30", `.beneath.json ${sha("{\"key\":\"k\"}")}`, `scene.html ${sha(GOOD)}`]));
    // Fetched again (V2's cloud writes every file anew) or touched: the same version, so its render plays.
    fs.utimesSync(join(dir, "scene.html"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(effects.list(app.store, id)[0]!.key).toBe(key);
    // What's beneath it is made again from the timeline on each computer, and a write cut short isn't code: neither changes it.
    fs.writeFileSync(join(dir, "beneath.mp4"), "a picture beneath");
    fs.writeFileSync(join(dir, "beneath.mp4.partial.mp4"), "half of one");
    expect(effects.list(app.store, id)[0]!.key).toBe(key);
    // A change to the code is a new version.
    fs.writeFileSync(join(dir, "scene.html"), GOOD.replace("#e0343c", "#34e03c"));
    expect(effects.list(app.store, id)[0]!.key).not.toBe(key);
  } finally {
    cleanup();
  }
});

test("a render saved under the key from before Nov 16 (the files' times) is taken as its code's: its key written anew, nothing drawn again", async () => {
  const { app, cleanup, id } = hq("effects-old-key");
  try {
    const dir = write(app, id, "bar", { "scene.html": GOOD });
    const stat = fs.statSync(join(dir, "scene.html"));
    const faces = effects.FONTS.filter((font) => font.later !== true).map((font) => `@font-face { font-family: "${font.family}"; font-weight: ${font.weight}; src: url(edit-fonts/${font.file}); }`).join("\n");
    const before = fingerprint([runtimeText as unknown as string, faces, "1920x1080@30", `scene.html ${stat.size} ${Math.floor(stat.mtimeMs)}`]);
    expect(effects.list(app.store, id)[0]!.old).toBe(before);
    fs.writeFileSync(join(app.store.uploadsDir(id), "bar-render.mp4"), "the render");
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.media.push({ id: "m1", name: "bar", path: join(app.store.uploadsDir(id), "bar-render.mp4"), kind: "video", duration: 2, width: 1920, height: 1080, fps: 30, has_audio: false, effect: "bar", effect_key: before });
      project.tracks.push({ id: "t1", kind: "video", name: "V1" } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: "m1", source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    // Rendered already: an export needn't wait (it would have waited for a new render of the same code, in Chrome).
    expect(effects.renderLine(app, id, "bar")).toContain("Its render is of this code");
    expect(effects.notReady(app.store, app.store.get(id)!.project)).toBeNull();
    await seams.broll.waitForMaps(app, id, 10);
    const media = app.store.get(id)!.project.media.find((one) => one.id === "m1")!;
    expect(media.effect_key).toBe(effects.list(app.store, id)[0]!.key);
    expect(media.path.endsWith("bar-render.mp4")).toBe(true);
  } finally {
    cleanup();
  }
});

test("what of Edit's own every render's key has (its runtime and faces) is pinned: a change to it draws every effect of every project again", () => {
  // Changing effect_runtime.html or Edit's faces changes every effect's key, so every computer that opens a V2 project
  // draws all its effects again (Nov 17: a different build's keys did that to Cops Found 3 Bodies). Do it only when
  // the picture an effect draws changes, then put the new value here; what changes no picture goes in
  // effect_watch.html, which is no part of a key.
  expect(effects.RENDERER).toBe("c5cddc666fd4");
});

test("a render made on another computer whose code comes down on a first open is its code's, whatever key that computer gave it: never swapped for the clear still (kenobi, Nov 17)", async () => {
  const { app, cleanup, id } = hq("effects-first-open");
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  // A key of another computer's (before Nov 16 a key had the files' times): nothing here can make it again.
  const theirs = "0123456789ab";
  const item = v2cloud.effectKey(id, "bar");
  const version = { key: item, n: 3, files: [{ path: "scene.html", sha256: sha(GOOD), size: GOOD.length }], reason: "rendered", from: null, source: theirs, at: 0, by: null };
  const spies = [
    spyOn(relay, "cloudEnabled").mockReturnValue(true),
    spyOn(v2cloud, "versions").mockResolvedValue([version]),
    spyOn(v2cloud, "fetchInto").mockImplementation(async (_key, n, dir) => {
      expect(n).toBe(3);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, "scene.html"), GOOD);
      return version;
    }),
  ];
  try {
    const render = join(app.store.uploadsDir(id), "bar-render.mp4");
    fs.mkdirSync(join(render, ".."), { recursive: true });
    fs.writeFileSync(render, "the render");
    const cloud = { source: "sha256:feed", original: `edit/exports/${id}/effect-bar-${theirs}.mp4`, proxy: `edit/exports/${id}/effect-bar-${theirs}.mp4`, size: 10 };
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.media.push({ id: "m1", name: "bar", path: render, kind: "video", duration: 2, width: 1920, height: 1080, fps: 30, has_audio: false, effect: "bar", effect_key: theirs, cloud } as (typeof project.media)[number]);
      project.tracks.push({ id: "t1", kind: "video", name: "V1" } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: "m1", source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    expect(fs.existsSync(effects.folder(app.store, id, "bar"))).toBe(false);
    await effects.bringUpToDate(app, id);
    expect(fs.readFileSync(join(effects.folder(app.store, id, "bar"), "scene.html"), "utf8")).toBe(GOOD);
    const media = app.store.get(id)!.project.media.find((one) => one.id === "m1")!;
    expect(media.kind).toBe("video");
    expect(media.path).toBe(render);
    expect(media.cloud).toEqual(cloud);
    // Its key written as this computer's, nothing drawn again.
    expect(media.effect_key).toBe(effects.list(app.store, id)[0]!.key);
    expect(effects.notReady(app.store, app.store.get(id)!.project)).toBeNull();
  } finally {
    for (const spy of spies) spy.mockRestore();
    cleanup();
  }
});

test("while an effect's new code renders, the cloud keeps its last render: the clear still is this computer's alone, and the team never sees the effect blank (Nov 17)", async () => {
  const { app, cleanup, id } = hq("effects-kept-render");
  try {
    write(app, id, "bar", { "scene.html": GOOD });
    const render = join(app.store.uploadsDir(id), "bar-render.mp4");
    fs.mkdirSync(join(render, ".."), { recursive: true });
    fs.writeFileSync(render, "the render");
    const cloud = { source: "sha256:feed", original: `edit/exports/${id}/effect-bar-aaaaaaaaaaaa.mp4`, proxy: `edit/exports/${id}/effect-bar-aaaaaaaaaaaa.mp4`, size: 10 };
    // Its render is of code since changed here (the key of older code).
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.media.push({ id: "m1", name: "bar", path: render, kind: "video", duration: 2, width: 1920, height: 1080, fps: 30, has_audio: false, effect: "bar", effect_key: "aaaaaaaaaaaa", stacked_alpha: true, cloud } as (typeof project.media)[number]);
      project.tracks.push({ id: "t1", kind: "video", name: "V1" } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: "m1", source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await effects.bringUpToDate(app, id);
    const project = app.store.get(id)!.project;
    const here = project.media.find((one) => one.id === "m1")!;
    // Here, the clear still, so the page playing live isn't drawn over its old render.
    expect(here.path.endsWith("bar.clear.png")).toBe(true);
    expect(here.effect_key).toBeUndefined();
    // What every push sends: the render, as it was.
    const sent = cloudProjects.hooks.outgoing(app, id, project).media.find((one) => one.id === "m1")!;
    expect(sent).toMatchObject({ path: render, kind: "video", width: 1920, height: 1080, fps: 30, effect_key: "aaaaaaaaaaaa", stacked_alpha: true, cloud });
    // The project here is as it was: only what's sent differs.
    expect(app.store.get(id)!.project.media.find((one) => one.id === "m1")!.path.endsWith("bar.clear.png")).toBe(true);
    // An effect made longer than its old render goes as the still: nothing new rather than a clip past its media's end.
    await app.store.update(id, "test", (edited) => {
      edited.media.find((one) => one.id === "m1")!.duration = 5;
    });
    const longer = app.store.get(id)!.project;
    expect(cloudProjects.hooks.outgoing(app, id, longer).media.find((one) => one.id === "m1")!.path.endsWith("bar.clear.png")).toBe(true);
  } finally {
    cleanup();
  }
});

test("the agent's file tools are allowed in the effects folder and nowhere else, and only an HQ project's chat has them", () => {
  const { app, cleanup, id } = hq("effects-rules");
  try {
    const dir = effects.workshop(app.store, id);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(effects.fileRules(dir)).toEqual([`Read(/${dir}/**)`, `Edit(/${dir}/**)`, `Write(/${dir}/**)`]);
    expect(effects.FILE_TOOLS).not.toContain("Bash");
    const project = app.store.get(id)!.project;
    const plain = agentInstructions(project);
    expect(plain).toContain("you have no shell or files");
    for (const tool of HQ_TOOLS) expect(plain).not.toContain(`- ${tool}(`);
    const made = agentInstructions({ ...project, hq: true });
    expect(made).toContain("the project's effects folder; you have no shell");
    expect(made).toContain("THIS IS AN EDIT V2 VIDEO");
    for (const tool of HQ_TOOLS) expect(made).toContain(`- ${tool}(`);
    expect(toolsFor(false).length).toBe(TOOLS.length - HQ_TOOLS.length);
    // Every tool but the house's skills, sound effects and looks (it has its own) and other niches'.
    expect(toolsFor(true).map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name).filter((name) => !NOT_IN_HQ.includes(name)));
    for (const kept of ["cover_cut_in", "caption_speakers", "add_subtitles", "track_region", "capture_evidence", "set_keyframes", "pull_script", "add_sound_effect", "add_from_library"]) expect(NOT_IN_HQ).not.toContain(kept);
  } finally {
    cleanup();
  }
});

test("an effect's tools are refused outside an HQ project, and an export waits for an effect's render", async () => {
  const { app, cleanup, id } = hq("effects-refused");
  try {
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    const refused = await call("look_at_effect", { name: "bar" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("Edit V2");
    const listed = (await dispatch(app, { id: 1, method: "tools/list" }, id)) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.some((tool) => tool.name === "look_at_effect")).toBe(false);
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.media.push({ id: "m1", name: "bar", path: "/nowhere/bar.png", kind: "image", duration: 2, width: 1920, height: 1080, fps: 0, has_audio: false, effect: "bar" });
    });
    const now = (await dispatch(app, { id: 1, method: "tools/list" }, id)) as { result: { tools: { name: string }[] } };
    expect(now.result.tools.some((tool) => tool.name === "look_at_effect")).toBe(true);
    // In the media but on no clip: nothing of it is exported, so nothing to wait for.
    expect(effects.onTimeline(app.store.get(id)!.project)).toEqual([]);
    await seams.broll.waitForMaps(app, id, 10);
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1" } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: "m1", source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    expect(effects.onTimeline(app.store.get(id)!.project)).toEqual(["bar"]);
    // Its code isn't on this computer and it was never rendered: an export can't have it, and says so.
    await expect(seams.broll.waitForMaps(app, id, 10)).rejects.toThrow("The bar effect was made on another computer and never rendered there");
    // Rendered on that computer (its media is the render): exported as it is.
    await app.store.update(id, "test", (project) => {
      project.media[0]!.effect_key = "abc";
    });
    await seams.broll.waitForMaps(app, id, 10);
  } finally {
    cleanup();
  }
});

const chrome = seams.broll.chrome();

test.skipIf(chrome === null)("look draws the page in Chrome: its length, the stills asked for, a frame's cost, and what the page gets wrong", async () => {
  const { app, cleanup, id } = hq("effects-look");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "bar", { "scene.html": GOOD });
    const look = await effects.look(app, id, "bar", [0, 1]);
    expect(look.duration).toBe(2);
    expect(look.problems).toEqual([]);
    expect(look.errors).toEqual([]);
    expect(look.stills.map((still) => still.time)).toEqual([0, 1]);
    expect(look.stills[0]!.mime).toBe("image/jpeg");
    // Two different moments, two different pictures; the same moment again, the same picture.
    expect(Buffer.from(look.stills[0]!.picture).equals(Buffer.from(look.stills[1]!.picture))).toBe(false);
    const again = await effects.look(app, id, "bar", [1]);
    expect(Buffer.from(again.stills[0]!.picture).equals(Buffer.from(look.stills[1]!.picture))).toBe(true);
    // Unmeasured (a stretch's frames): no cost, the same picture.
    const unmeasured = await effects.look(app, id, "bar", [1], 960, false);
    expect(unmeasured.stills[0]!.cost).toBe(0);
    expect(Buffer.from(unmeasured.stills[0]!.picture).equals(Buffer.from(look.stills[1]!.picture))).toBe(true);
    expect(look.interval).toBeGreaterThan(1);
    expect(look.stills[0]!.cost).toBeGreaterThan(1);
    // With no moments asked for: six, spread over its length.
    expect((await effects.look(app, id, "bar", null)).stills.map((still) => still.time)).toEqual([0.17, 0.5, 0.83, 1.17, 1.5, 1.83]);

    // The walls hold in a real browser: the app's own address and its cookies and storage are out of the page's reach.
    write(app, id, "walls", {
      "scene.html": `<!doctype html><body><script>
        const tried = [];
        try { tried.push("cookie " + document.cookie.length); } catch { tried.push("no cookies"); }
        try { tried.push("storage " + localStorage.length); } catch { tried.push("no storage"); }
        window.seek = () => {};
        window.ready = fetch("/api/projects").then(() => tried.push("reached the app"), () => tried.push("no network")).then(() => { window.duration = tried.join(", ") === "no cookies, no storage, no network" ? 3 : 99; });
      </script></body>`,
    });
    const walls = await effects.look(app, id, "walls", []);
    expect(walls.duration).toBe(3);
    // A length set while it loads is its length: nothing is said of one missing before `ready`.
    expect(walls.problems).toEqual([]);

    // And what's in its own folder does load there: a picture and a font, from inside the walls.
    const loads = write(app, id, "loads", {
      "scene.html": `<!doctype html><head><style>@font-face { font-family: Hand; src: url(fonts/hand.ttf); }</style></head><body><img id="dot" src="img/dot.png"><script>
        window.seek = () => {};
        const dot = document.getElementById("dot");
        // Its own font, and one of Edit's (there as if in its folder: Reenie Beanie, the house marker).
        window.ready = Promise.all([dot.decode().then(() => dot.naturalWidth, () => 0), document.fonts.load("40px Hand").then((found) => found.length, () => 0), document.fonts.load("40px 'Reenie Beanie'").then((found) => found.length, () => 0)])
          .then(([picture, font, house]) => { window.duration = picture === 1 && font === 1 && house === 1 ? 5 : 99; });
      </script></body>`,
    });
    fs.mkdirSync(join(loads, "img"), { recursive: true });
    fs.writeFileSync(join(loads, "img/dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    fs.mkdirSync(join(loads, "fonts"), { recursive: true });
    fs.copyFileSync(join(import.meta.dir, "../../../crates/edit-render/fonts/VT323-Regular.ttf"), join(loads, "fonts/hand.ttf"));
    expect((await effects.look(app, id, "loads", [])).duration).toBe(5);

    // A page on its own clock, with no length, that reaches for the network and throws: each said.
    write(app, id, "wrong", {
      "scene.html": `<!doctype html><body><img id="far" src="https://example.com/a.png"><script>
        window.ready = fetch("/api/projects").then(() => "reached the app", () => "kept out").then((said) => { document.title = said; });
        window.seek = (t) => { if (t > 1) throw new Error("no second " + t); };
        requestAnimationFrame(() => { document.body.dataset.ran = "yes"; });
      </script></body>`,
    });
    const wrong = await effects.look(app, id, "wrong", [0.5, 1.5]);
    expect(wrong.duration).toBe(0);
    expect(wrong.problems.join("\n")).toContain("requestAnimationFrame was called");
    expect(wrong.problems.join("\n")).toContain("no window.duration");
    expect(wrong.errors.join("\n")).toContain("no second 1.5");
    // What its walls refused is said, not just a blank page: the picture off the network, the call to the app.
    expect(wrong.errors.join("\n")).toContain("refused to load a.png (img-src)");
    expect(wrong.errors.join("\n")).toContain("(connect-src)");
    const tool = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "wrong", times: [0.5] } } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    expect(tool.isError).toBe(false);
    expect(tool.content.filter((part) => part.type === "image").length).toBe(1);
    expect(tool.content.at(-1)!.text).toContain("BREAKS THE EFFECT CONTRACT");
    await expect(effects.add(app, id, "wrong")).rejects.toThrow("isn't ready for the timeline");
    // A page whose WebGL wouldn't start (this computer's browser, Nov 25 under WSL): the agent is told it's not its code
    // to fix and that what's there stays, never to fix it first.
    write(app, id, "glless", {
      "scene.html": `<!doctype html><body><script>
        const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return /webgl/.test(kind) ? null : real.call(this, kind, ...rest); };
        window.duration = 1; window.seek = () => {};
        window.ready = Promise.reject(new Error("The browser supports WebGL, but initialization failed."));
      </script></body>`,
    });
    const glless = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "glless", times: [0.5] } } }, id)) as { result: { content: { type: string; text?: string }[] } }).result.content.at(-1)!.text!;
    expect(glless).toContain(effects.NO_WEBGL_LINE);
    expect(glless).toContain("window.ready was rejected: The browser supports WebGL, but initialization failed.");
    expect(glless).not.toContain("fix these first");
    // A page's own canvas asked for WebGL after 2D gets none on any computer: its code's to fix, said as before (here
    // the browser gives a fresh canvas WebGL).
    write(app, id, "glmisused", {
      "scene.html": `<!doctype html><body><script>
        const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return /webgl/.test(kind) ? (this.dataset.used === "2d" ? null : {}) : (this.dataset.used = "2d", real.call(this, kind, ...rest)); };
        window.duration = 1; window.seek = () => {};
        const c = document.createElement("canvas"); c.getContext("2d");
        window.ready = c.getContext("webgl") ? Promise.resolve() : Promise.reject(new Error("Error creating WebGL context."));
      </script></body>`,
    });
    const misused = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "glmisused", times: [0.5] } } }, id)) as { result: { content: { type: string; text?: string }[] } }).result.content.at(-1)!.text!;
    expect(misused).toContain("fix these first");
    expect(misused).not.toContain(effects.NO_WEBGL_LINE);
    // Another error naming WebGL, on a browser that has none, is still its code's ("WebGLRenderer is not defined").
    write(app, id, "glunbound", {
      "scene.html": `<!doctype html><body><script>
        const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return /webgl/.test(kind) ? null : real.call(this, kind, ...rest); };
        window.duration = 1; window.seek = () => {};
        window.ready = Promise.resolve().then(() => new WebGLRenderer());
      </script></body>`,
    });
    const unbound = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "glunbound", times: [0.5] } } }, id)) as { result: { content: { type: string; text?: string }[] } }).result.content.at(-1)!.text!;
    expect(unbound).toContain("WebGLRenderer is not defined");
    expect(unbound).toContain("fix these first");
    expect(unbound).not.toContain(effects.NO_WEBGL_LINE);
    // One whose window.ready never settles once WebGL fails (a look that rejects): told the same.
    write(app, id, "glhang", {
      "scene.html": `<!doctype html><body><script>
        window.duration = 1; window.seek = () => {};
        const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return /webgl/.test(kind) ? null : real.call(this, kind, ...rest); };
        window.ready = new Promise(() => {});
        setTimeout(() => { throw new Error("The browser supports WebGL, but initialization failed."); });
      </script></body>`,
    });
    const quiet = effects.waits.quietMs;
    effects.waits.quietMs = 1_500;
    try {
      const hung = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "glhang", times: [0.5] } } }, id)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
      expect(hung.isError).toBe(true);
      expect(hung.content.at(-1)!.text).toContain(effects.NO_WEBGL_LINE);
      expect(hung.content.at(-1)!.text).toContain("this computer's browser couldn't start WebGL");
      expect(hung.content.at(-1)!.text).not.toContain("must be in its own folder");
    } finally {
      effects.waits.quietMs = quiet;
    }
    await expect(effects.look(app, id, "nowhere", [0])).rejects.toThrow('no effect "nowhere"');
    // A big screenshot (full-size noise, megabytes of PNG) reaches its page by a fetch, not in the call: a JPEG as any.
    write(app, id, "noise", {
      "scene.html": `<!doctype html><body style="margin:0"><canvas id="c" width="1920" height="1080"></canvas><script>
        const c = document.getElementById("c").getContext("2d");
        window.duration = 1; window.ready = Promise.resolve();
        window.seek = () => { const d = c.createImageData(1920, 1080); let x = 7; for (let i = 0; i < d.data.length; i++) { x = (x * 1103515245 + 12345) >>> 0; d.data[i] = i % 4 === 3 ? 255 : x >>> 24; } c.putImageData(d, 0, 0); };
      </script></body>`,
    });
    const noise = await effects.look(app, id, "noise", [0], 0, false);
    expect(noise.errors).toEqual([]);
    expect(noise.stills[0]!.mime).toBe("image/jpeg");
    expect(noise.stills[0]!.picture.length).toBeGreaterThan(100_000);
    expect(noise.stills[0]!.seeThrough).toBe(false);
  } finally {
    effects.closeChrome();
    await server.stop(true);
    cleanup();
  }
}, 120_000);

test.skipIf(chrome === null)("a look goes on through a play, below it: its Chrome and everything under it started below the person's work and put in the background while the play lasts, nothing waited for, and no frame's cost measured beside it (Sphe, Nov 17)", async () => {
  const { app, cleanup, id } = hq("effects-below");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const background = playing.belowHooks.background;
  const stale = playing.hooks.staleMs;
  const set: [number, boolean][] = [];
  playing.reset();
  playing.belowHooks.background = async (pid, on) => {
    set.push([pid, on]);
  };
  playing.hooks.staleMs = 600_000;
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "bar", { "scene.html": GOOD });
    effects.closeChrome();
    const before = await effects.look(app, id, "bar", [1]);
    expect(before.measured).toBe(true);
    expect(before.stills[0]!.cost).toBeGreaterThan(1);
    // This test's own Chrome (another file's may be running beside it), and everything under it.
    const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,ni=,command="]).stdout.toString().split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line)).filter((match) => match !== null).map((match) => ({ pid: Number(match![1]), ppid: Number(match![2]), nice: Number(match![3]), command: match![4]! }));
    const root = rows.find((row) => row.ppid === process.pid && row.command.includes("edit-effect-"))!.pid;
    const tree = playing.treesOf([root], new Map(rows.map((row) => [row.pid, row.ppid])));
    expect(tree.length).toBeGreaterThan(1);
    // On Linux the tree runs at background work's nice, children too.
    if (process.platform === "linux") for (const pid of tree) expect(rows.find((row) => row.pid === pid)!.nice).toBe(tools.BACKGROUND_NICE);
    // A play: the whole tree goes below it.
    playing.note("p", true);
    await playing.belowSettled();
    const lowered = set.filter(([, on]) => on).map(([pid]) => pid);
    expect(lowered).toContain(root);
    expect(lowered.length).toBeGreaterThan(1);
    // A look meanwhile isn't held up, and says its cost wasn't measured rather than the play's.
    const during = await effects.look(app, id, "bar", [1]);
    expect(during.measured).toBe(false);
    expect(during.stills[0]!.cost).toBe(0);
    expect(Buffer.from(during.stills[0]!.picture).equals(Buffer.from(before.stills[0]!.picture))).toBe(true);
    const tool = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "bar", times: [1] } } }, id)) as { result: { content: { type: string; text?: string }[] } }).result;
    const said = tool.content.map((part) => part.text ?? "").join("\n");
    expect(said).toContain("wasn't measured: someone was watching a play on this computer");
    expect(said).not.toContain("WON'T PLAY LIVE");
    // The play stops: back at full speed, and measured again.
    set.length = 0;
    playing.note("p", false);
    await playing.belowSettled();
    expect(set.filter(([, on]) => !on).map(([pid]) => pid)).toContain(root);
    expect(set.some(([, on]) => on)).toBe(false);
    expect((await effects.look(app, id, "bar", [1])).measured).toBe(true);
  } finally {
    playing.belowHooks.background = background;
    playing.hooks.staleMs = stale;
    playing.reset();
    effects.closeChrome();
    void server.stop(true);
    cleanup();
  }
});

test("the processes kept below a play are each tree under them, its root first", () => {
  const listed = new Map([
    [10, 1],
    [11, 10],
    [12, 10],
    [13, 12],
    [20, 1],
    [21, 20],
  ]);
  expect(playing.treesOf([10], listed).sort()).toEqual([10, 11, 12, 13]);
  // One gone is nothing.
  expect(playing.treesOf([10, 99], listed).sort()).toEqual([10, 11, 12, 13]);
  expect(playing.treesOf([], listed)).toEqual([]);
  // Started niced on Linux; on a Mac as it is, below only while a play is watched.
  expect(playing.belowCommand(["/bin/true"])).toEqual(process.platform === "darwin" ? ["/bin/true"] : ["/usr/bin/nice", "-n", String(tools.BACKGROUND_NICE), "/bin/true"]);
});

test("a sound's levels: how loud each frame is, and in which band", () => {
  const rate = 24000;
  // One second of a loud 1 kHz tone, then one of silence.
  const samples = new Float32Array(rate * 2);
  for (let at = 0; at < rate; at++) samples[at] = 0.5 * Math.sin((2 * Math.PI * 1000 * at) / rate);
  const levels = effects.levelsOf(samples, rate, 30);
  expect(levels.frames).toBe(60);
  expect(levels.rms.length).toBe(60);
  expect(levels.rms[10]!).toBeGreaterThan(0.8);
  expect(levels.rms[45]).toBe(0);
  // The tone is loudest in the band holding 1 kHz (the bands run 40 Hz to 12 kHz, spaced as the ear hears).
  const bands = levels.bands[10]!;
  expect(bands.length).toBe(16);
  const loudest = bands.indexOf(Math.max(...bands));
  const edge = (band: number) => 40 * Math.pow(12_000 / 40, band / 16);
  expect(edge(loudest) <= 1000 && 1000 < edge(loudest + 1)).toBe(true);
  expect(Math.max(...levels.bands[45]!)).toBe(0);
});

test.skipIf(chrome === null)("a look again at an effect whose code hasn't changed draws on its page as loaded, and says what a fresh page would; looks at two effects go side by side", async () => {
  const { app, cleanup, id } = hq("effects-kept");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // Its page says, as it loads, when it loaded (the same words twice: the same page); a CSS animation runs on its own
    // clock (the runtime checks that at a page's first seek alone); a second past 1.5 throws.
    const kept = (stamp: string) => `<!doctype html><body style="margin:0;background:#123">
<div id="spin" style="animation: spin 1s infinite linear;width:40px;height:40px;background:#e0343c;opacity:0"></div>
<style>@keyframes spin { to { transform: rotate(1turn); } }</style>
<script>
window.duration = 2;
window.ready = Promise.resolve();
window.seek = (t) => { if (t > 1.5) throw new Error("no second " + t); document.body.style.background = "rgb(" + Math.round(t * 100) + ",20,30)"; };
</script>
<script>throw new Error("${stamp} loaded at " + performance.timeOrigin);</script></body>`;
    write(app, id, "kept", { "scene.html": kept("first") });
    write(app, id, "bar", { "scene.html": GOOD });
    const one = await effects.look(app, id, "kept", [1.8]);
    expect(one.errors.join("\n")).toContain("first loaded at");
    expect(one.errors.join("\n")).toContain("no second 1.8");
    // Every seek threw, so the runtime hasn't looked for a running animation yet.
    expect(one.problems).toEqual([]);
    expect(effects.ANIMATION).toStartWith("A CSS animation");
    const two = await effects.look(app, id, "kept", [0.5]);
    // The same page (its load's words, word for word), saying its load's error and its animation again, and not the
    // second the look before asked for.
    expect(two.errors).toEqual(one.errors.filter((error) => !error.includes("no second")));
    expect(two.problems).toEqual([effects.ANIMATION]);
    expect(Buffer.from(two.stills[0]!.picture).equals(Buffer.from(one.stills[0]!.picture))).toBe(false);
    // Its code changed: a fresh page.
    write(app, id, "kept", { "scene.html": kept("second") });
    const three = await effects.look(app, id, "kept", [0.5]);
    expect(three.errors.join("\n")).toContain("second loaded at");
    expect(three.errors.join("\n")).not.toContain("first loaded at");
    // The same moment of the same code: the same picture, on a kept page or a fresh one.
    expect(Buffer.from(three.stills[0]!.picture).equals(Buffer.from(two.stills[0]!.picture))).toBe(true);
    // Two effects at once, each its own.
    const [bar, again] = await Promise.all([effects.look(app, id, "bar", [1]), effects.look(app, id, "kept", [0.5])]);
    expect(bar.duration).toBe(2);
    expect(bar.errors).toEqual([]);
    expect(again.errors).toEqual(three.errors);
    // The runtime said the animation at that page's first seek alone: the kept page says it again.
    expect(three.problems).toEqual([effects.ANIMATION]);
    expect(again.problems).toEqual([effects.ANIMATION]);
    expect(Buffer.from(again.stills[0]!.picture).equals(Buffer.from(three.stills[0]!.picture))).toBe(true);
  } finally {
    effects.closeChrome();
    void server.stop(true);
    cleanup();
  }
});

test("a render's failure is the computer's at that moment (tried again at once), the disk's (what to free), or the code's (the agent's to fix)", () => {
  expect(effects.failureKind(new Error("Rendering an effect: Chrome didn't start."))).toBe("passing");
  expect(effects.failureKind(new Error("Chrome closed"))).toBe("passing");
  expect(effects.failureKind(new Error("Chrome Page.captureScreenshot timed out"))).toBe("passing");
  expect(effects.failureKind(new Error("its page threw at 1.20 s: the map lost its drawing (WebGL context lost)"))).toBe("passing");
  expect(effects.failureKind(Object.assign(new Error("write"), { code: "ENOSPC" }))).toBe("disk");
  expect(effects.failureKind(new Error("its frames didn't join into a video: No space left on device"))).toBe("disk");
  // The encoder's moment, never the page's code (Nov 22: NVENC refusing a session on a shared card).
  expect(effects.failureKind(new Error("its frames didn't join into a video: h264_nvenc: OpenEncodeSessionEx failed: out of memory (10): (no details)"))).toBe("passing");
  expect(effects.failureKind(new Error("its page threw at 1.20 s: TypeError: x is undefined"))).toBe("code");
  expect(effects.failureKind(new Error("its page has no window.duration"))).toBe("code");
  // The browser's WebGL not starting is this computer's (Nov 25, WSL): never the agent's code to change, nor a lesser look.
  // Known by what Edit's runtime adds once a fresh canvas got no WebGL here, never by the page's words alone.
  const noWebgl = "its window.ready was rejected: The browser supports WebGL, but initialization failed. (this computer's browser has no WebGL)";
  expect(effects.failureKind(new Error(noWebgl))).toBe("passing");
  expect(effects.failureKind(new Error("its page threw at 0.00 s: Error creating WebGL context."))).toBe("code");
  expect([effects.noWebgl(noWebgl), effects.noWebgl("its page threw at 1.20 s: TypeError: gl is null")]).toEqual([true, false]);
  expect(effects.NO_WEBGL_LINE).toContain("no other look in its place");
  // The network's (Sphe's M4, Nov 17): the relay unreachable, the map helper's tiles asked for and never answered.
  expect(effects.failureKind(new effects.NetworkDown("date-tulsa's page got nowhere for 15 s waiting on the network"))).toBe("network");
  expect(effects.failureKind(new Error("its window.ready was rejected: the map's tiles stopped coming: none came in 15 s, 3 asked for and unanswered (Edit's server or its relay isn't answering)"))).toBe("network");
  expect(effects.failureKind(new Error("its window.ready was rejected: could not reach Edit's relay: getaddrinfo ETIMEOUT"))).toBe("network");
  expect(effects.failureKind(new Error("its window.ready was rejected: the map's tiles were refused: today's maps are used up"))).toBe("code");
  // What a render asks of the disk before it draws: two chunks of its frames (two seconds each at 1080p, in whole
  // half-second keyframe intervals) and those chunks' video twice; the whole video's room is asked at the join.
  const hd = { width: 1920, height: 1080, fps: 30 };
  expect(effects.chunkFrames(hd)).toBe(60);
  expect(effects.chunkFrames({ width: 3840, height: 2160, fps: 30 })).toBe(15);
  expect(effects.chunkFrames({ width: 1920, height: 1080, fps: 25 })).toBe(52);
  // A 12 s board: about 0.4 GB (1.6 GB until Nov 17, every frame kept until the end).
  const board = effects.renderBytes(hd, 360, 12);
  expect(board / 1e9).toBeGreaterThan(0.35);
  expect(board / 1e9).toBeLessThan(0.45);
  // A minute-long one well under a gigabyte, where it took 7.4 GB (kenobi, Nov 17: "free about 8 GB").
  expect(effects.renderBytes(hd, 1800, 60) / 1e9).toBeLessThan(0.8);
  // An hour of subtitles asks no more before it draws (it asked ~30 GB: Sphe's M4 edits refused with 20 GB free, Nov 18).
  expect(effects.renderBytes(hd, 132_000, 4400)).toBe(effects.renderBytes(hd, 1800, 60));
  // Frames left to draw fewer than two chunks: only those.
  expect(effects.renderBytes(hd, 10, 12)).toBeLessThan(board - 100 * 1920 * 1080 * 1.5);
});

test("a render's error says where it was thrown when its first line is only its kind", async () => {
  const { firstLines } = await import("../src/effects.ts");
  expect(firstLines("Error\n    at render (map.js:12:3)\n    at x")).toBe("Error at render (map.js:12:3)");
  expect(firstLines("TypeError: x is undefined\n    at y")).toBe("TypeError: x is undefined");
});

test("a sound's wave for a page: thinned to WAVE_RATE, its loudest at ±127, as a script", async () => {
  const { waveScript, WAVE_RATE } = await import("../src/effects.ts");
  const rate = 24000;
  const samples = new Float32Array(rate).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 200 * i) / rate));
  const script = waveScript("call", samples, rate);
  const window: Record<string, any> = {};
  runInNewContext(script, { window, atob: (text: string) => Buffer.from(text, "base64").toString("binary") });
  const wave = window.waves.call;
  expect(wave.rate).toBe(WAVE_RATE);
  expect(wave.samples.length).toBe(WAVE_RATE);
  expect(Math.max(...wave.samples)).toBe(127);
  expect(wave.peak).toBeGreaterThan(0.45);
});

test("FFmpeg's reason is kept, not the knock-on last line every failure ends with (as the engine's ffmpeg_said)", () => {
  const stderr = [
    "[h264_nvenc @ 0x575839865f00] No capable devices found",
    "[vost#0:0/h264_nvenc @ 0x575839865a80] [enc:h264_nvenc @ 0x575839865e80] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.",
    "[vf#0:0 @ 0x575839866400] Error sending frames to consumers: Generic error in an external library",
    "[vf#0:0 @ 0x575839866400] Task finished with error code: -542398533 (Generic error in an external library)",
    "[vost#0:0/h264_nvenc @ 0x575839865a80] [enc:h264_nvenc @ 0x575839865e80] Could not open encoder before EOF",
    "[out#0/mp4 @ 0x575839864f40] Nothing was written into output file, because at least one of its streams received no packets.",
    "",
  ].join("\n");
  expect(tools.ffmpegSaid(stderr)).toBe("h264_nvenc: No capable devices found; Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.");
  expect(tools.ffmpegSaid("[out#0/mp4 @ 0x1] Nothing was written into output file.\n")).toBe("Nothing was written into output file.");
  expect(tools.ffmpegSaid("")).toBeNull();
  expect(tools.saidOf(Object.assign(new Error("last line"), { stderr }))).toStartWith("h264_nvenc: No capable devices found");
  expect(tools.saidOf(new Error("plain"))).toBe("plain");
});
