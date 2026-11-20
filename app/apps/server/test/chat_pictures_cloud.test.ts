// An agent chat's pictures go to the cloud with the chat (chat_pictures.ts,
// chat_sync.ts), so a project's answers show them on any computer (Sphe,
// Nov 18: a shared project's pictures were broken, even back on its own Mac).

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import { CHAT_PICTURES, chatPictureAddress, keepPicture, pictureKey } from "../src/chat_pictures.ts";
import { schedulePush } from "../src/chat_sync.ts";
import { respond } from "../src/http/server.ts";
import { join } from "../src/paths.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !done(); tries++) await Bun.sleep(25);
  expect(done()).toBe(true);
}

const picture = (fixture: Fixture, address: string) =>
  respond(fixture.app, buildRouter(), new Request(`http://localhost:7700${address}`, { headers: { host: "localhost:7700" } }), null);

test("a picture kept on one computer is shown on another, from the cloud; one the cloud hasn't is 404", async () => {
  const here = fixtureHome("pictures-here");
  const there = fixtureHome("pictures-there");
  try {
    const folder = join(here.store.uploadsDir("p1"), CHAT_PICTURES);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const address = chatPictureAddress("p1", folder, keepPicture(folder, bytes, "png"), [])!;
    const name = address.split("/").pop()!;
    await until(() => mock.objects.has(pictureKey("p1", name)));

    const response = (await picture(there, address))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    // Kept here now: the next look is the disk's.
    expect(fs.existsSync(join(there.store.uploadsDir("p1"), CHAT_PICTURES, name))).toBe(true);

    expect((await picture(there, "/api/projects/p1/chat-pictures/0123456789abcdef.png"))!.status).toBe(404);
    expect((await picture(there, "/api/projects/p1/chat-pictures/..%2Fx.png"))!.status).toBe(404);
  } finally {
    here.cleanup();
    there.cleanup();
  }
});

test("a pushed chat takes its pictures this computer has that the cloud hasn't", async () => {
  const fixture = fixtureHome("pictures-push");
  try {
    const folder = join(fixture.store.uploadsDir("p2"), CHAT_PICTURES);
    // Kept before pictures were shared: only on this disk.
    const name = keepPicture(folder, new Uint8Array([9, 8, 7]), "jpg").split("/").pop()!;
    fs.mkdirSync(join(fixture.home, "projects"), { recursive: true });
    fs.writeFileSync(fixture.store.chatPath("p2~review"), JSON.stringify({ savedAt: 1, entries: [{ text: `Here: ![the frame](/api/projects/p2/chat-pictures/${name}) and ![gone](/api/projects/p2/chat-pictures/fedcba9876543210.png)` }] }));
    expect(mock.objects.has(pictureKey("p2", name))).toBe(false);
    schedulePush(fixture.store, "p2~review");
    await until(() => mock.objects.has("edit/chats/p2~review.json") && mock.objects.has(pictureKey("p2", name)));
    expect(mock.objects.has(pictureKey("p2", "fedcba9876543210.png"))).toBe(false);
  } finally {
    fixture.cleanup();
  }
});
