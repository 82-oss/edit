// The agent's clips never take a name Edit's removal owns ("Text blur · …", "Subtitles removed · …", "Watermark
// removed · …"): removal takes away what it didn't lay under them (Nov 25, Boyfriends: the agent's logo blurs went at
// once). Its own clips under those names (a cut's second half) stay the agent's to move, and Edit's saves are as before.

import { expect, test } from "bun:test";

import { reservedNameRefusal } from "../src/clean_strips.ts";
import type { Clip, Project } from "../src/model.ts";
import { fixtureHome } from "./helpers/home.ts";

const blur = (id: string, name: string, start = 0): Clip =>
  ({ id, track: "v2", type: "adjustment", name, start, duration: 30, fade_in: 0, fade_out: 0, opacity: 1, color: "blue", grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 }, blur: { radius: 28, x: 0, y: 0, width: 100, height: 60, feather: 8, shape: "rect" } }) as unknown as Clip;

const withClips = (project: Project, clips: Clip[]): Project => ({
  ...project,
  tracks: project.tracks.some((track) => track.id === "v2") ? project.tracks : ([...project.tracks, { id: "v2", kind: "video", hidden: false, muted: false, locked: false }] as Project["tracks"]),
  clips,
});

test("a new clip under a name removal owns is refused; one already there under that name, or any other name, isn't", () => {
  const { store, cleanup } = fixtureHome("reserved-names");
  try {
    const before = withClips(store.create("p", { width: 1920, height: 1080, fps: 30 }).project, [blur("c1", "Text blur · c9")]);
    // Edit's own, moved or cut in two: the same name as one before.
    expect(reservedNameRefusal(before, withClips(before, [blur("c1", "Text blur · c9", 10), blur("c2", "Text blur · c9", 40)]))).toBeNull();
    // Anything named otherwise.
    expect(reservedNameRefusal(before, withClips(before, [...before.clips, blur("c3", "Logo blur · c12")]))).toBeNull();
    // A new one under removal's names, or one renamed into them.
    for (const [name, type] of [["Text blur · c12", "adjustment"], ["Subtitles removed · c12", "video"], ["Watermark removed · c12", "video"]]) {
      const clip = { ...blur("c3", name!), type } as unknown as Clip;
      expect(reservedNameRefusal(before, withClips(before, [...before.clips, clip]))).toContain(`"${name}" is a name Edit's removal keeps`);
    }
    expect(reservedNameRefusal(before, withClips(before, [blur("c1", "Text blur · c12")]))).toContain("Logo blur");
    // Only on the clips removal lays them on: a text clip so named is the agent's own, never taken away.
    const callout = { ...blur("c4", "Text blur · demo"), type: "text", text: "demo" } as unknown as Clip;
    expect(reservedNameRefusal(before, withClips(before, [...before.clips, callout]))).toBeNull();
  } finally {
    cleanup();
  }
});

test("the store refuses the agent's save of such a clip, and only the agent's", async () => {
  const { store, cleanup } = fixtureHome("reserved-names-store");
  try {
    const live = store.create("p", { width: 1920, height: 1080, fps: 30 });
    const id = live.project.id;
    const added = withClips(live.project, [blur("c50", "Text blur · c12")]);
    // The agent's whole-project save (apply_edit_plan) and its read-modify-write (its tools).
    expect(await store.replace(id, live.rev, added, "agent").then(() => "saved", (error: unknown) => String(error))).toContain("is a name Edit's removal keeps");
    expect(await store.update(id, "agent", (project) => Object.assign(project, withClips(project, [blur("c50", "Text blur · c12")]))).then(() => "saved", (error: unknown) => String(error))).toContain("is a name Edit's removal keeps");
    expect(store.get(id)!.rev).toBe(live.rev);
    // Removal's own saves lay its blurs as before.
    await store.update(id, "text removal", (project) => Object.assign(project, withClips(project, [blur("c50", "Text blur · c12")])));
    expect(store.get(id)!.project.clips.map((clip) => clip.name)).toEqual(["Text blur · c12"]);
    // The agent's undo or a kept version brought back (changes.ts) is the edit as it was, removal's own clips with it.
    await store.update(id, "agent", (project) => Object.assign(project, withClips(project, [])));
    await store.update(id, "agent", (project) => Object.assign(project, withClips(project, [blur("c50", "Text blur · c12")])), undefined, { restore: true });
    expect(store.get(id)!.project.clips.map((clip) => clip.name)).toEqual(["Text blur · c12"]);
  } finally {
    cleanup();
  }
});
