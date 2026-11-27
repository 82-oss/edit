// A Reuse link to someone else's upload is a source played whole (reuse_owner.ts): Nov 27's three compilations.

import { afterEach, expect, test } from "bun:test";

import { useChannelsForTests, type Channel } from "../src/channels.ts";
import { reusedMedia, REUSE_LABEL, WHOLE_SOURCE_LABEL } from "../src/project.ts";
import { check, hooks, NOT_OURS_NOTE, ours } from "../src/reuse_owner.ts";
import { fixtureHome } from "./helpers/home.ts";

const WIDE = { width: 1920, height: 1080, fps: 30 };
const ourChannel = { key: "ch-cc", youtubeId: "UCcc", handle: "cuffedandcaught", title: "Cuffed & Caught" } as unknown as Channel;
const asked = hooks.uploader;
afterEach(() => {
  hooks.uploader = asked;
  useChannelsForTests([]);
});

test("one of the team's channels by @handle or by name; anyone else's isn't", () => {
  const team = [{ handle: "cuffedandcaught", title: "Cuffed & Caught" }];
  expect(ours({ name: "Cuffed & Caught", handle: "CuffedAndCaught" }, team)).toBe(true);
  expect(ours({ name: "cuffed & caught", handle: null }, team)).toBe(true);
  expect(ours({ name: "Midwest Patrol", handle: "MidwestPatrol" }, team)).toBe(false);
});

test("a Reuse link to Midwest Patrol's upload becomes a source played whole; one to ours stays a reuse", async () => {
  useChannelsForTests([ourChannel]);
  hooks.uploader = async (id) => (id === "AN1DSo3bYWg" ? { name: "Midwest Patrol", handle: "MidwestPatrol" } : { name: "Cuffed & Caught", handle: "cuffedandcaught" });
  const { app, cleanup } = fixtureHome("reuse-owner");
  try {
    const id = app.store.create("At Work", WIDE).project.id;
    await app.store.update(id, "test", (p) => {
      p.script = {
        blocks: [
          { kind: "footage", url: "https://www.youtube.com/watch?v=AN1DSo3bYWg", file: "youtube:AN1DSo3bYWg", start: 0, end: 1076, label: REUSE_LABEL, notes: [], media: "m11" },
          { kind: "footage", url: "https://youtu.be/OURS0000001", file: "youtube:OURS0000001", start: 0, end: 900, label: REUSE_LABEL, notes: [], media: "m12" },
        ],
      } as unknown as NonNullable<typeof p.script>;
    });
    expect(await check(app, id)).toBe(1);
    const project = app.store.get(id)!.project;
    const [theirs, mine] = project.script!.blocks as unknown as { label: string; notes: string[] }[];
    expect(theirs!.label).toBe(WHOLE_SOURCE_LABEL);
    expect(theirs!.notes).toEqual([`${NOT_OURS_NOTE}Midwest Patrol (@MidwestPatrol)`]);
    expect(mine!.label).toBe(REUSE_LABEL);
    // Removal and subtitles now treat the Midwest Patrol video as footage, and still leave ours.
    expect([...reusedMedia(project)]).toEqual(["m12"]);
    // Asked once: a second plan changes nothing.
    expect(await check(app, id)).toBe(0);
  } finally {
    cleanup();
  }
});

test("nothing changes when YouTube can't say or the team's channels aren't known", async () => {
  const { app, cleanup } = fixtureHome("reuse-owner-unknown");
  try {
    const id = app.store.create("Gen Alpha", WIDE).project.id;
    await app.store.update(id, "test", (p) => {
      p.script = { blocks: [{ kind: "footage", url: "https://www.youtube.com/watch?v=UNKNOWN0001", file: "youtube:UNKNOWN0001", start: 0, end: 10, label: REUSE_LABEL, notes: [], media: "m1" }] } as unknown as NonNullable<typeof p.script>;
    });
    hooks.uploader = async () => ({ name: "Someone", handle: "someone" });
    expect(await check(app, id)).toBe(0);
    useChannelsForTests([ourChannel]);
    hooks.uploader = async () => null;
    expect(await check(app, id)).toBe(0);
    hooks.uploader = async () => {
      throw new Error("offline");
    };
    expect(await check(app, id)).toBe(0);
    expect((app.store.get(id)!.project.script!.blocks[0] as unknown as { label: string }).label).toBe(REUSE_LABEL);
  } finally {
    cleanup();
  }
});
