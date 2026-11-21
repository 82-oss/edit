import { describe, expect, it } from "vitest";

import { adjustment, audio, bigProject, media, projectOf, solid, text, track, video } from "./timelineFixture";
import { blockAt, layoutOf, shownName } from "./timelineRows";

// A small project with one of everything the real channel projects hold (Nov 21: 45, 1,355 and 3,173 clips).
function everything() {
  const tracks = [track("v1", "video"), track("v2", "video"), track("v3", "video"), track("v4", "video"), track("subs", "video", true), track("a1", "audio"), track("a2", "audio"), track("a3", "audio")];
  const footage = media("foot", { name: "Interrogation.mp4" });
  const stacked = media("card", { name: "card", effect: "card", effect_key: "k1", stacked_alpha: true, has_audio: false, duration: 6 });
  const plain = media("map", { name: "map", effect: "map", effect_key: "k2", has_audio: false });
  const strip = media("strip", { name: "Interrogation.mp4 · their subtitles out", has_audio: false, cleans: { media: "foot", from: 10, to: 20, box: [0, 0.8, 1, 1] } });
  const music = media("music", { kind: "audio", name: "Tension.wav", library: "music", width: 0, height: 0 });
  const sfx = media("whoosh", { kind: "audio", name: "Whoosh.wav", library: "sfx", width: 0, height: 0 });
  const take = media("take", { kind: "audio", name: "Story (voice-over) - Cut-in 3.mp3", width: 0, height: 0 });
  const read = media("read", { kind: "audio", name: "narration.mp3", width: 0, height: 0 });
  const shutter = media("shutter", { kind: "audio", name: "shutter.wav", width: 0, height: 0 });
  const clips = [
    video("c1", "v1", 0, 300, "foot", { source_in: 12 }),
    audio("c2", "a1", 0, 300, "foot", { source_in: 12 }),
    video("c3", "v2", 100, 60, "foot", { name: "Cut-in 1 · B-roll: the kitchen camera" }),
    video("c4", "v3", 20, 90, "strip", { parent: "c1", name: "Subtitles removed · c16" }),
    adjustment("c5", "v3", 200, 30, { name: "Text blur · c568", blur: { radius: 28, x: -5, y: 421, width: 626, height: 83 } }),
    adjustment("c6", "v4", 100, 60, { name: "Cut-in 1 · B-roll look" }),
    adjustment("c7", "v4", 170, 20, { name: "Key line blur", blur: { radius: 28, width: 3400, height: 2200 } }),
    video("c8", "v4", 10, 40, "card", { name: "Name pop-up" }),
    video("c9", "v4", 30, 40, "map", { name: "Date map" }),
    solid("c10", "v3", 160, 6, { name: "Flash" }),
    text("c11", "v3", 50, 40, "Look what it's doing to me.", { name: "Caption · Denae (Suspect)" }),
    text("c12", "subs", 0, 40, "You cheated and I found", { name: "Subtitle · Michael", opacity: 0 }),
    text("c13", "subs", 40, 30, "out", { name: "Subtitle · Michael", opacity: 1 }),
    audio("c14", "a2", 0, 200, "music", { volume_db: -18 }),
    audio("c15", "a3", 90, 10, "whoosh"),
    audio("c16", "a3", 120, 50, "take"),
    audio("c17", "a3", 180, 60, "read"),
    audio("c18", "a2", 210, 5, "shutter"),
  ];
  const script = { blocks: [{ kind: "narration", text: "Then", voiceover: "c17" }] };
  return projectOf({ tracks, media: [footage, stacked, plain, strip, music, sfx, take, read, shutter], clips, script });
}

describe("the V2 timeline's rows", () => {
  it("sorts each clip by what it is, as the model says it, and draws only the rows with something in them", () => {
    const layout = layoutOf(everything());
    const ids = Object.fromEntries(layout.rows.map((row) => [row.kind, row.blocks.map((block) => block.clip.id)]));
    expect(layout.rows.map((row) => row.label)).toEqual(["Subtitles", "Graphics", "Captions", "Cut-ins", "Footage", "Looks", "Footage sound", "Voice-over", "Music", "Sound effects"]);
    // Subtitles at opacity 0 (drawn by an effect) are the words all the same.
    expect(ids.subtitles).toEqual(["c12", "c13"]);
    // Coded effects (a stacked one too) and generated pictures are graphics.
    expect(ids.graphics).toEqual(["c8", "c9", "c10"]);
    expect(ids.captions).toEqual(["c11"]);
    expect(ids.cutins).toEqual(["c3"]);
    expect(ids.footage).toEqual(["c1"]);
    // A grade over the whole picture is a look, and so is a blur of the whole of it; a blur of a box isn't.
    expect(ids.looks).toEqual(["c6", "c7"]);
    expect(ids.footsound).toEqual(["c2"]);
    // A voice-over by its take's name and by the script's narration, not by being an audio file.
    expect(ids.voiceover).toEqual(["c16", "c17"]);
    expect(ids.music).toEqual(["c14"]);
    // The library's sound effects, and any other sound file.
    expect(ids.sfx).toEqual(["c15", "c18"]);
  });

  it("draws a removal strip and a blur of a box on the footage they cover, not as rows of their own", () => {
    const layout = layoutOf(everything());
    const covers = Object.fromEntries(layout.covers.map((cover) => [cover.clip.id, cover]));
    expect(Object.keys(covers).sort()).toEqual(["c4", "c5"]);
    // The strip on its parent; the blur, which has none, on the footage under it.
    expect(covers.c4!.host?.clip.id).toBe("c1");
    expect(covers.c5!.host?.clip.id).toBe("c1");
    // Named without the clip ids Edit puts in names.
    expect(covers.c4!.name).toBe("Subtitles removed");
    expect(covers.c5!.name).toBe("Text blur");
    expect(shownName("Burned-in cover · extension of c205")).toBe("Burned-in cover");
  });

  it("stacks clips that overlap within a row into lanes, and finds the one under a frame", () => {
    const layout = layoutOf(everything());
    const graphics = layout.rows.find((row) => row.kind === "graphics")!;
    // The pop-up (10–50) and the map (30–70) overlap; the flash (160) fits back in the first lane.
    expect(graphics.lanes).toBe(2);
    expect(graphics.blocks.map((block) => block.lane)).toEqual([0, 1, 0]);
    expect(blockAt(graphics, 1, 40)?.clip.id).toBe("c9");
    expect(blockAt(graphics, 0, 40)?.clip.id).toBe("c8");
    expect(blockAt(graphics, 0, 60)).toBeNull();
    // Subtitles are their words.
    expect(layout.rows[0]!.blocks[0]!.name).toBe("You cheated and I found");
  });

  it("an empty edit has no rows", () => {
    expect(layoutOf(projectOf({ tracks: [], media: [], clips: [] })).rows).toEqual([]);
  });

  it("sorts a project the size of the biggest real one: every clip in a row or on its footage", () => {
    const project = bigProject();
    expect(project.clips.length).toBe(3173);
    const layout = layoutOf(project);
    const placed = layout.rows.reduce((sum, row) => sum + row.blocks.length, 0) + layout.covers.length;
    expect(placed).toBe(3173);
    expect(layout.rows.find((row) => row.kind === "subtitles")!.blocks.length).toBe(2028);
    expect(layout.covers.every((cover) => cover.host !== null)).toBe(true);
  });
});
