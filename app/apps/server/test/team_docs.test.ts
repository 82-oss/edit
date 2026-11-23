// team_docs.ts: the team's documents (ideas, thumbnails) kept here first and
// pushed behind, against a stand-in cloud that can be out of reach, refuse,
// or be changed by "another Mac" between reads.

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import { merge3, TeamDocs, timing } from "../src/team_docs.ts";
import { scratch } from "./helpers/home.ts";

type Doc = { id: string; updatedAt?: number; titles: string[]; chat: string[]; note?: string; holder?: string | null };
type Row = { id: string; rev: number; updatedAt: number; title: string };

class Conflict extends Error {}
class Missing extends Error {}
const unreachable = () => Object.assign(new Error("could not reach Edit's relay"), { _tag: "ServiceUnreachable" });
const forbidden = () => Object.assign(new Error("not allowed"), { _tag: "ServiceRefused", status: 403 });

/** The stand-in cloud: rev'd bodies, refusing a stale rev as mamagi does. */
const cloud = new Map<string, { body: Doc; rev: number }>();
let down = false;
let refuse = false;
let asks = 0;

const spec = {
  kind: "test-docs",
  fetch: async (id: string) => {
    asks++;
    if (down) throw unreachable();
    const found = cloud.get(id);
    return found === undefined ? null : structuredClone(found);
  },
  list: async (): Promise<Row[]> => {
    if (down) throw unreachable();
    return [...cloud.values()].map(({ body, rev }) => ({ id: body.id, rev, updatedAt: body.updatedAt ?? 0, title: body.titles[0] ?? "" }));
  },
  commit: async (body: Doc, baseRev: number) => {
    if (down) throw unreachable();
    if (refuse) throw forbidden();
    const now = cloud.get(body.id)?.rev ?? 0;
    if (now !== baseRev) throw new Conflict(`now at ${now}`);
    cloud.set(body.id, { body: structuredClone(body), rev: now + 1 });
    return now + 1;
  },
  remove: async (id: string) => void cloud.delete(id),
  isConflict: (error: unknown) => error instanceof Conflict,
  isMissing: (error: unknown) => error instanceof Missing,
  missing: () => new Missing("This one was deleted."),
  rowOf: (body: Doc, rev: number) => ({ id: body.id, rev, updatedAt: body.updatedAt ?? 0, title: body.titles[0] ?? "" }),
};

/** Another Mac's change, straight to the cloud. */
function theirs(id: string, change: (doc: Doc) => void): void {
  const found = cloud.get(id)!;
  const body = structuredClone(found.body);
  change(body);
  cloud.set(id, { body, rev: found.rev + 1 });
}

let docs: TeamDocs<Doc, Row>;
let home: string;
let cleanup: () => void;
const saved = { ...timing };

beforeEach(() => {
  Object.assign(timing, { freshMs: 2_000, peekMs: 50, settleMs: 0, retryMs: [5, 10, 20] });
  cloud.clear();
  down = false;
  refuse = false;
  asks = 0;
  ({ dir: home, cleanup } = scratch("team-docs"));
  docs = new TeamDocs<Doc, Row>(spec);
  docs.useHome(home);
});

afterEach(() => {
  docs.forget();
  cleanup();
  Object.assign(timing, saved);
});

const seed = (id: string, body: Partial<Doc> = {}) => cloud.set(id, { body: { id, titles: [], chat: [], ...body }, rev: 1 });

test("read from the copy here: the cloud asked only when it's old, and out of reach the copy answers; one never seen needs the cloud", async () => {
  seed("a", { titles: ["First"] });
  expect((await docs.get("a"))!.body.titles).toEqual(["First"]);
  await docs.get("a");
  expect(asks).toBe(1);
  down = true;
  timing.freshMs = 0;
  expect((await docs.get("a"))!.body.titles).toEqual(["First"]);
  await expect(docs.get("never-seen")).rejects.toThrow("could not reach");
});

test("a change is made here at once with the cloud out of reach, and goes up by itself once it's back", async () => {
  seed("a");
  await docs.get("a");
  down = true;
  const { body } = await docs.change("a", "Sphe", (doc) => void doc.titles.push("Made offline"));
  expect(body.titles).toEqual(["Made offline"]);
  expect((await docs.get("a"))!.body.titles).toEqual(["Made offline"]);
  expect(cloud.get("a")!.body.titles).toEqual([]);
  expect(docs.waiting()).toBe(1);
  down = false;
  for (let tries = 0; tries < 200 && docs.waiting() > 0; tries++) await Bun.sleep(5);
  expect(cloud.get("a")).toMatchObject({ rev: 2, body: { titles: ["Made offline"] } });
});

test("overtaken by another Mac's change, the one made here is made again on top: neither lost", async () => {
  seed("a", { titles: ["One"] });
  await docs.get("a");
  theirs("a", (doc) => doc.chat.push("their turn"));
  await docs.change("a", "Sphe", (doc) => void doc.titles.push("Two"), { settleMs: 1_000 });
  expect(cloud.get("a")).toMatchObject({ rev: 3, body: { titles: ["One", "Two"], chat: ["their turn"] } });
  expect((await docs.get("a"))!).toMatchObject({ rev: 3, body: { titles: ["One", "Two"], chat: ["their turn"] } });
});

test("a run's lease taken on another Mac meanwhile: the change waiting on the cloud is refused, and undone here", async () => {
  seed("a", { holder: null });
  await docs.get("a");
  theirs("a", (doc) => void (doc.holder = "other-mac"));
  const take = (doc: Doc) => {
    if (doc.holder !== null && doc.holder !== "this-mac") throw new Error(`held on ${doc.holder}`);
    doc.holder = "this-mac";
  };
  await expect(docs.change("a", "Sphe", take, { settleMs: 1_000 })).rejects.toThrow("held on other-mac");
  expect((await docs.get("a"))!.body.holder).toBe("other-mac");
  expect(cloud.get("a")!.body.holder).toBe("other-mac");
});

test("a lease is decided on the cloud's newest copy, not on one here that still shows another Mac's run that has ended", async () => {
  seed("a", { holder: "other-mac" });
  await docs.get("a");
  theirs("a", (doc) => void (doc.holder = null));
  const take = (doc: Doc) => {
    if (doc.holder !== null && doc.holder !== "this-mac") throw new Error(`held on ${doc.holder}`);
    doc.holder = "this-mac";
  };
  expect((await docs.change("a", "Sphe", take, { settleMs: 1_000 })).body.holder).toBe("this-mac");
  expect(cloud.get("a")!.body.holder).toBe("this-mac");
});

test("a refusal (no permission) undoes the change here and says it to a caller that waits", async () => {
  seed("a", { titles: ["Kept"] });
  await docs.get("a");
  refuse = true;
  await expect(docs.change("a", "Sphe", (doc) => void doc.titles.push("Refused"), { settleMs: 1_000 })).rejects.toThrow("not allowed");
  expect((await docs.get("a"))!.body.titles).toEqual(["Kept"]);
  expect(docs.waiting()).toBe(0);
});

test("a refusal after the page has gone on is there for the page to say, once; one a caller heard isn't", async () => {
  seed("a", { titles: ["Kept"] });
  await docs.get("a");
  refuse = true;
  await expect(docs.change("a", "Sphe", (doc) => void doc.titles.push("Heard"), { settleMs: 1_000 })).rejects.toThrow("not allowed");
  expect(docs.takeUndone("a")).toBe(false);
  await docs.change("a", "Sphe", (doc) => void doc.titles.push("Gone on"));
  await docs.settled();
  expect((await docs.get("a"))!.body.titles).toEqual(["Kept"]);
  expect(docs.takeUndone("a")).toBe(true);
  expect(docs.takeUndone("a")).toBe(false);
});

test("changes a restart left unsent go up at the next start, merged with what changed there meanwhile, field by field", async () => {
  seed("a", { titles: ["One"], chat: ["hello"] });
  await docs.get("a");
  down = true;
  await docs.change("a", "Sphe", (doc) => {
    doc.titles.push("Mine");
    doc.chat.push("my turn");
  });
  docs.forget();
  // Meanwhile on another Mac: a note, and a turn of theirs in the same chat.
  theirs("a", (doc) => {
    doc.note = "theirs";
    doc.chat.push("their turn");
  });
  down = false;
  const again = new TeamDocs<Doc, Row>(spec);
  again.useHome(home);
  for (let tries = 0; tries < 200 && again.waiting() > 0; tries++) await Bun.sleep(5);
  expect(cloud.get("a")!.body).toMatchObject({ titles: ["One", "Mine"], note: "theirs", chat: ["hello", "their turn", "my turn"] });
  again.forget();
});

test("the list is the cloud's with what's here ahead of it; one deleted in the cloud goes from here too", async () => {
  seed("a", { titles: ["A"], updatedAt: 1 });
  seed("b", { titles: ["B"], updatedAt: 2 });
  expect((await docs.list()).map((row) => row.title)).toEqual(["B", "A"]);
  await docs.get("a");
  down = true;
  await docs.change("a", "Sphe", (doc) => void (doc.titles = ["A renamed"]));
  await docs.create({ id: "c", titles: ["C made here"], chat: [] }, "Sphe");
  timing.freshMs = 0;
  const shown = (await docs.list()).map((row) => row.title);
  expect(shown.slice(0, 2).sort()).toEqual(["A renamed", "C made here"]);
  expect(shown[2]).toBe("B");
  // Back: b deleted by another Mac, a and c go up.
  down = false;
  cloud.delete("b");
  for (let tries = 0; tries < 200 && docs.waiting() > 0; tries++) await Bun.sleep(5);
  await docs.get("b");
  expect((await docs.list()).map((row) => row.title).sort()).toEqual(["A renamed", "C made here"]);
  expect(cloud.get("c")!.body.titles).toEqual(["C made here"]);
  expect(fs.readdirSync(`${home}/team-docs/test-docs`).sort()).toEqual(["_list.json", "a.json", "c.json"]);
});

test("a merge: each field changed here taken over theirs, a list changed on both sides keeping both", () => {
  const base = { id: "a", titles: ["one", "two"], chat: ["hi"], note: "old", main: "one" };
  const mine = { id: "a", titles: ["one", "three"], chat: ["hi", "mine"], note: "old", main: "three" };
  const theirs = { id: "a", titles: ["one", "two", "four"], chat: ["hi", "theirs"], note: "new", main: "one" };
  expect(merge3(base, mine, theirs)).toEqual({ id: "a", titles: ["one", "four", "three"], chat: ["hi", "theirs", "mine"], note: "new", main: "three" });
});
