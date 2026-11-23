// What an export waits on is always being done (Nov 23, Sphe's Linux prod Edit). No Chrome, FFmpeg or graphics card:
// Chrome's opening is a fake, so nothing here draws.
import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import * as devtools from "../src/chrome_devtools.ts";
import * as effects from "../src/effects.ts";
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
