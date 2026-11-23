// What an export waits on is always being done (Nov 23, Sphe's Linux prod Edit). No Chrome, FFmpeg or graphics card:
// Chrome's opening is a fake, so nothing here draws.
import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import * as devtools from "../src/chrome_devtools.ts";
import { beneathKey } from "../src/effect_inputs.ts";
import * as effects from "../src/effects.ts";
import type { Media, Project } from "../src/model.ts";
import { fixtureHome } from "./helpers/home.ts";

const opening = spyOn(devtools, "open");
afterAll(() => opening.mockRestore());

function code(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, text: string): void {
  const dir = effects.folder(app.store, project, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "scene.html"), text);
}

test("a render whose code changed and came back to the same version is drawn again, never left waiting on itself", async () => {
  const { app, cleanup } = fixtureHome("effect-render-self-wait");
  const id = app.store.create("Boyfriends", { width: 1920, height: 1080, fps: 30 }).project.id;
  try {
    code(app, id, "holder", "<p>holder</p>");
    code(app, id, "cutin", "<p>one</p>");
    let letGo = (_error: Error) => {};
    const opened: string[] = [];
    opening.mockImplementation((() => {
      opened.push("open");
      // The first holds the slot until it's let go; every later one fails as a page's code would.
      if (opened.length === 1) return new Promise((_resolve, reject) => (letGo = reject));
      return Promise.reject(new Error("its page is broken"));
    }) as unknown as typeof devtools.open);

    const holder = effects.renderNow(app, id, "holder");
    holder.catch(() => {});
    while (opened.length === 0) await Bun.sleep(5);
    // Queued behind it at this version; the code changes while it waits, so it's dropped when the slot comes free.
    const cutin = effects.renderNow(app, id, "cutin");
    cutin.catch(() => {});
    code(app, id, "cutin", "<p>two</p>");
    letGo(new Error("its page is broken"));
    await holder.catch(() => {});
    // Back to the version it was asked for, while it waits for the code to settle.
    await Bun.sleep(100);
    code(app, id, "cutin", "<p>one</p>");

    const ended = await Promise.race([cutin.then(() => "done", () => "failed"), Bun.sleep(20_000).then(() => "still waiting")]);
    expect(ended).toBe("failed");
    expect(opened.length).toBe(2);
    expect(effects.renderingLine(id)).toBeNull();
  } finally {
    cleanup();
  }
}, 30_000);

// ---------------------------------------------------------------------------
// What's beneath a graphic is keyed by what the graphics below it are.

function stack(): Project {
  const track = (id: string) => ({ id, kind: "video", name: id, hidden: false, muted: false, locked: false });
  const clip = (id: string, on: string, media: string, start: number, duration: number) => ({ id, type: "video", track: on, start, duration, media, source_in: 0, speed: 1 });
  const media = (id: string, effect?: string) => ({ id, name: id, path: `/here/${id}.mp4`, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: false, ...(effect === undefined ? {} : { effect, effect_key: `render-of-${effect}` }) });
  return {
    id: "p",
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks: [track("t1"), track("t2"), track("t3")],
    media: [media("footage"), media("m-low", "low"), media("m-top", "top")],
    clips: [clip("c0", "t1", "footage", 0, 900), clip("c1", "t2", "m-low", 0, 300), clip("c2", "t3", "m-top", 0, 300)],
  } as unknown as Project;
}

const codes = (low: string) => (name: string) => (name === "low" ? low : `code-of-${name}`);
const lowOf = (project: Project) => project.media.find((one) => one.id === "m-low")!;

test("what's beneath a graphic keeps its key when the one below it gets a new media, goes up to the cloud or sits on its placeholder", () => {
  const before = stack();
  const key = beneathKey(before, "top", codes("v1"));
  expect(key).not.toBeNull();

  // The same graphic as a new media.
  const renamed = structuredClone(before);
  lowOf(renamed).id = "m-low-2";
  (renamed.clips.find((one) => one.id === "c1") as unknown as { media: string }).media = "m-low-2";
  expect(beneathKey(renamed, "top", codes("v1"))).toBe(key);

  // Its render's upload lands: a cloud source where there was a path.
  const uploaded = structuredClone(before);
  lowOf(uploaded).cloud = { source: "sha256:0123456789abcdef" } as NonNullable<Media["cloud"]>;
  expect(beneathKey(uploaded, "top", codes("v1"))).toBe(key);

  // Back on its clear still while it's drawn again, then its render of the same code.
  const placeholder = structuredClone(before);
  lowOf(placeholder).path = "/here/effect-stills/low.clear.png";
  lowOf(placeholder).kind = "image";
  delete lowOf(placeholder).effect_key;
  expect(beneathKey(placeholder, "top", codes("v1"))).toBe(key);

  // Its code changing is what changes it.
  expect(beneathKey(before, "top", codes("v2"))).not.toBe(key);
  // And so does the footage under them.
  const recut = structuredClone(before);
  recut.clips.find((one) => one.id === "c0")!.start = 5;
  expect(beneathKey(recut, "top", codes("v1"))).not.toBe(key);
});

test("two graphics over each other's clips count each other without what's beneath them, so neither changes the other's key for ever", () => {
  const crossed = stack();
  // A second clip of the top graphic, under the low one.
  crossed.clips.push({ ...structuredClone(crossed.clips.find((one) => one.id === "c2")!), id: "c3", track: "t1", start: 0, duration: 300 } as (typeof crossed.clips)[number]);
  const asked: [string, boolean][] = [];
  beneathKey(crossed, "low", (name, whole) => {
    asked.push([name, whole]);
    return "code";
  });
  expect(asked).toEqual([["top", false]]);
});

test("graphics are taken lowest lane first, whatever order their media are in", () => {
  const project = stack();
  project.media.reverse();
  expect(effects.lowestFirst(project)).toEqual(["low", "top"]);
});

// ---------------------------------------------------------------------------
// An export of part of the video waits for the graphics of that part.

test("an export of a range waits for and starts only the graphics it shows, and those they're drawn over; a whole export all of them", async () => {
  const { app, cleanup } = fixtureHome("effect-render-range");
  const id = app.store.create("Boyfriends", { width: 1920, height: 1080, fps: 30 }).project.id;
  try {
    const clip = (clipId: string, track: string, media: string, start: number, duration: number) => ({ id: clipId, type: "video", track, start, duration, media, source_in: 0, speed: 1 });
    const media = (mediaId: string, effect: string) => ({ id: mediaId, name: effect, path: `/nowhere/${effect}.png`, kind: "image", duration: 10, width: 1920, height: 1080, fps: 0, has_audio: false, effect });
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      for (const track of ["t1", "t2"]) project.tracks.push({ id: track, kind: "video", name: track, hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.media.push(media("m1", "under") as never, media("m2", "over") as never, media("m3", "later") as never);
      project.clips.push(clip("c1", "t1", "m1", 500, 300) as never, clip("c2", "t2", "m2", 0, 900) as never, clip("c3", "t1", "m3", 17_592, 300) as never);
    });
    for (const name of ["under", "over", "later"]) code(app, id, name, `<p>${name}</p>`);
    // `over` draws what's beneath it, over a span `under` is in, though `under` isn't in the range asked for.
    fs.writeFileSync(join(effects.folder(app.store, id, "over"), effects.BENEATH_MARK), JSON.stringify({ key: "x" }));
    fs.writeFileSync(join(effects.folder(app.store, id, "over"), "beneath.mp4"), "");

    effects.noteWait(app, id, [0, 400]);
    expect(effects.graphicsOf(app, id).map((one) => one.name).sort()).toEqual(["over", "under"]);

    // Nothing in the range to wait for: at once, with `later` not drawn.
    const opened: string[] = [];
    opening.mockImplementation((() => {
      opened.push("open");
      return Promise.reject(new Error("its page is broken"));
    }) as unknown as typeof devtools.open);
    await effects.waitForRenders(app, id, 5_000, undefined, [10_000, 10_100]);
    expect(opened.length).toBe(0);

    // In the range: the graphic under it goes first, and `later`, after its range, is never asked for.
    await expect(effects.waitForRenders(app, id, 5_000, undefined, [0, 400])).rejects.toThrow("The under effect didn't render");
    expect(opened.length).toBe(1);

    // The whole video waits on `later` too.
    effects.noteWait(app, id);
    expect(effects.graphicsOf(app, id).map((one) => one.name).sort()).toEqual(["later", "over", "under"]);
  } finally {
    cleanup();
  }
}, 30_000);
