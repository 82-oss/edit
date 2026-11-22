// A kept effect carries only what its page draws from (effect_kept.ts; Nov 21:
// v1-shorts-blur-bars went into the library with five reference pictures and
// a 14 MB footage.mp4), the agent can take files out of an effect's folder,
// and a slimmer version is kept over a fat one.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import * as cloud from "../src/cloud.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import * as effectKept from "../src/effect_kept.ts";
import * as effects from "../src/effects.ts";
import { dispatch } from "../src/mcp/index.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
  registerEffectTools();
});

afterAll(() => {
  restore();
  mock.stop();
});

afterEach(() => {
  accounts.resetForTests();
  v2cloud.useSkillsForTests([]);
});

async function call(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, args: Record<string, unknown>) {
  return ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    fs.mkdirSync(join(dir, path, ".."), { recursive: true });
    fs.writeFileSync(join(dir, path), body);
  }
}

const kept = async (key: string) => (await v2cloud.version(key))!.version.files!.map((one) => one.path);

test("a kept effect carries what its page loads, not its references, tests or this video's footage; files come out of its folder, and a slimmer version is kept over a fat one", async () => {
  const { app, cleanup } = fixtureHome("effect-kept");
  try {
    const id = app.store.create("Shorts", { width: 1080, height: 1920, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "kept-ch";
    });
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.kept-ch"]);
    v2cloud.useSkillsForTests([{ name: v2cloud.GLOBAL, text: "Edit's own workings.", key: v2cloud.skillKey(v2cloud.GLOBAL) }]);
    const dir = effects.folder(app.store, id, "blur-bars");
    write(dir, {
      "scene.html": '<link rel="stylesheet" href="style.css"><video src="footage.mp4"></video><script src="bars.js"></script>',
      "style.css": "@font-face { font-family: X; src: url(fonts/x.woff2) }",
      "bars.js": "for (let n = 1; n <= 2; n++) load(`img/${n}.png`);",
      "fonts/x.woff2": "font",
      "img/1.png": "one",
      "img/2.png": "two",
      "ref-1.png": "the reference".repeat(100),
      "test.html": "<p>a test page</p>",
      "footage.mp4": "x".repeat(14_000),
    });
    effectKept.noteGiven(dir, { video: "footage.mp4", levels: null, wave: null }, 4, { width: 1920, height: 1080 });
    const keep = { kind: "effect", name: "blur-bars", category: "blur", note: "Blurred bars above and below a Short.", brief: "Bar height and blur at the top." };
    const key = "template:@kept-ch--edit/blur-bars";
    const first = (await call(app, id, "save_to_library", keep)).content[0]!.text!;
    expect(first).toContain("blur-bars is version 1");
    expect(await kept(key)).toEqual([".given.json", "bars.js", "fonts/x.woff2", "img/1.png", "img/2.png", "scene.html", "style.css"]);
    expect(first).toContain("ref-1.png (1 KB)");
    expect(first).toContain("test.html");
    expect(first).toContain("footage.mp4 (14 KB, this video's footage: a project using it gives its own with effect_footage)");
    // The agent says one is needed after all: kept with it.
    expect((await call(app, id, "save_to_library", { ...keep, also: ["ref-1.png"] })).content[0]!.text).toContain("version 2");
    expect(await kept(key)).toContain("ref-1.png");
    expect((await call(app, id, "save_to_library", { ...keep, also: ["nope.png"] })).content[0]!.text).toContain("there's no nope.png");
    // Taken out of the folder; the page itself stays.
    expect((await call(app, id, "remove_effect_files", { name: "blur-bars", paths: ["scene.html"] })).content[0]!.text).toContain("it stays");
    const removed = await call(app, id, "remove_effect_files", { name: "blur-bars", paths: ["ref-1.png", "footage.mp4", "test.html"] });
    expect(removed.isError).toBe(false);
    expect(removed.content[0]!.text).toContain("ref-1.png (1 KB)");
    expect(fs.existsSync(join(dir, "ref-1.png")) || fs.existsSync(join(dir, "footage.mp4"))).toBe(false);
    expect(fs.existsSync(join(dir, effectKept.GIVEN))).toBe(false);
    // Kept again: the slimmer one is the version in use.
    expect((await call(app, id, "save_to_library", keep)).content[0]!.text).toContain("version 3");
    expect(await kept(key)).toEqual(["bars.js", "fonts/x.woff2", "img/1.png", "img/2.png", "scene.html", "style.css"]);
  } finally {
    cleanup();
  }
});

test("an effect kept without its footage tells the project that brings it in to give its own", async () => {
  const { app, cleanup } = fixtureHome("effect-kept-use");
  try {
    const id = app.store.create("Shorts", { width: 1080, height: 1920, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.channel = "use-ch";
    });
    accounts.signedInForTests(["edit.bodycam", "agent.teach", "channel.use-ch"]);
    v2cloud.useSkillsForTests([{ name: v2cloud.GLOBAL, text: "Edit's own workings.", key: v2cloud.skillKey(v2cloud.GLOBAL) }]);
    const dir = effects.folder(app.store, id, "window");
    write(dir, { "scene.html": '<video src="desk.mp4"></video>', "desk.mp4": "y".repeat(55_000) });
    // Noted as before Nov 22, naming this project's media (the M1 trial: a kept effect's named m8, nothing elsewhere).
    fs.writeFileSync(join(dir, effectKept.GIVEN), JSON.stringify({ "desk.mp4": { media: "m2", start: 0, end: 30 } }));
    await call(app, id, "save_to_library", { kind: "effect", name: "window", category: "desktop", note: "A desktop window.", brief: "Its title at the top." });
    expect(await kept("template:@use-ch--edit/window")).toEqual([".given.json", "scene.html"]);
    const used = (await call(app, id, "use_from_library", { kind: "effect", name: "window", as: "window-2" })).content[0]!.text!;
    // What it expects, never where it came from; and the agent gives it this project's itself.
    const brought = fs.readFileSync(join(effects.folder(app.store, id, "window-2"), effectKept.GIVEN), "utf8");
    expect(JSON.parse(brought)).toEqual({ "desk.mp4": { kind: "picture", seconds: 30 } });
    expect(brought).not.toContain("m2");
    expect(used).toContain("(desk.mp4: 30");
    expect(used).toContain('give it this project\'s now with effect_footage, as: "desk", the footage on this timeline it\'s for; ask the person which only when that isn\'t plain, and never leave the tool to them.');
  } finally {
    cleanup();
  }
});
