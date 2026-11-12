// Bodycam HQ copying a reference, held to it by Edit (hq_reference.ts): Nov 13,
// the agent built four graphics from a reference, never compared one beside it,
// and ended listing where they differed; its maps were satellite pictures laid
// flat, though edit-map's 3D city was in its notes.

import { expect, test } from "bun:test";

import type { Entry } from "../src/agent.ts";
import { DIFFERS, mapImagery, personSaid, referenceCheck } from "../src/hq_reference.ts";
import type { Project } from "../src/model.ts";

const project = {
  settings: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m1", kind: "video" }, { id: "ref", kind: "video" }, { id: "fx", kind: "video", effect: "map-intro", duration: 10 }],
  clips: [{ id: "c1", type: "video", media: "m1", start: 0 }, { id: "c2", type: "video", media: "fx", start: 300 }],
} as unknown as Project;

let n = 0;
const tool = (name: string, input: Record<string, unknown>, status = "done"): Entry => ({ id: `e${n++}`, kind: "tool", tool: name, text: "", detail: JSON.stringify(input), status, at: 0, updated: 0 });
const said = (kind: string, text: string): Entry => ({ id: `e${n++}`, kind, text, at: 0, updated: 0 });
const asked = said("user", "Recreate this intro frame by frame: https://youtu.be/x");
const studied = tool("look_at_media", { media_id: "ref", start: 84, end: 98, count: 24 });
const wrote = tool("Write", { file_path: "/home/x/.edit/media/p1/effects/map-intro/scene.html", content: "…" });

test("the turn that built from a reference and compared nothing beside it is sent back, naming each graphic", () => {
  const left = referenceCheck([asked, studied, wrote, tool("look_at_effect", { name: "map-intro", times: [1, 4, 8] }), said("assistant", "Done.")], project);
  expect(left).not.toBeNull();
  expect(left!.note).toContain("map-intro (10 s): never compared beside the reference since its last change");
  expect(left!.note).toContain("look_at_effect beside");
  expect(left!.count).toBe(1);
});

test("compared beside it all along its length after its last change, it's done; a change after the comparing opens it again", () => {
  const compared = [
    tool("look_at_effect", { name: "map-intro", beside: { media_id: "ref", start: 84 }, times: [0, 2, 4, 6, 8, 9.5] }),
    tool("look_at_effect", { name: "map-intro", beside: { media_id: "ref", start: 84 }, every_frame: true, start: 3, end: 3.8 }),
  ];
  // Placing it changes no frame of it.
  expect(referenceCheck([asked, studied, wrote, ...compared, tool("add_effect", { name: "map-intro" }), said("assistant", "Matched.")], project)).toBeNull();
  const changedAfter = referenceCheck([asked, studied, wrote, ...compared, tool("Edit", { file_path: "map-intro/scene.html", old_string: "a", new_string: "b" }), said("assistant", "Done.")], project);
  expect(changedAfter?.note).toContain("never compared beside the reference since its last change");
});

test("a part left uncompared is named by its seconds", () => {
  const half = tool("look_at_effect", { name: "map-intro", beside: { media_id: "ref", start: 84 }, times: [0, 2, 4] });
  expect(referenceCheck([asked, studied, wrote, half, said("assistant", "Done.")], project)?.note).toContain("not compared beside the reference at 5 s–10 s");
});

test("a closing list of where it differs from the reference is sent back too", () => {
  const full = tool("look_at_effect", { name: "map-intro", beside: { media_id: "ref", start: 84 }, times: [0, 2, 4, 6, 8, 9.5] });
  const left = referenceCheck([asked, studied, wrote, full, said("assistant", "It follows the reference's look rather than matching it frame for frame. Where it differs from the reference: the aerials lie flat.")], project);
  expect(left?.note).toContain("Close each of those gaps now");
  expect(DIFFERS.test("All done: the board, the map and the call are in.")).toBe(false);
});

test("no reference studied (footage of the edit only), or no graphic changed: nothing to hold it to", () => {
  const ownFootage = tool("look_at_media", { media_id: "m1", times: [3] });
  expect(referenceCheck([asked, ownFootage, wrote, said("assistant", "Done.")], project)).toBeNull();
  expect(referenceCheck([asked, studied, said("assistant", "The reference opens on a map at night.")], project)).toBeNull();
});

test("a map site's picture of a place is told apart from other pages", () => {
  for (const url of [
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=-82.98,39.93,-82.96,39.93&f=image",
    "https://www.google.com/maps/@39.9338,-82.9770658,170a,35y,0h,62t/data=!3m1!1e3",
    "https://maps.googleapis.com/maps/api/staticmap?center=x&maptype=satellite",
    "https://earth.google.com/web/@39.93,-82.97",
    "https://www.bing.com/maps?cp=39.9~-82.9&style=a",
    "https://tile.openstreetmap.org/17/1/2.png",
  ]) expect(mapImagery(url)).toBe(true);
  for (const url of ["https://nominatim.openstreetmap.org/search?q=726+E+Moler+St&format=json", "https://www.google.com/search?q=moler+st", "https://youtu.be/s6CXNbzKlks", "https://www.dispatch.com/story/news/crime/2024/12/10/x"]) expect(mapImagery(url)).toBe(false);
});

test("another kind of map is let through only on the person's own words", () => {
  const entries = [said("user", "For this one just use a flat satellite photo of the street, no 3D"), said("user", "(Edit, automatically) use a flat satellite photo")];
  expect(personSaid(entries, "just use a flat satellite photo of the street")).toBe(true);
  expect(personSaid(entries, "Just use a FLAT satellite photo, of the street")).toBe(true);
  expect(personSaid([entries[1]!], "use a flat satellite photo")).toBe(false);
  expect(personSaid(entries, "satellite")).toBe(false);
  expect(personSaid(entries, "the person wants a satellite map")).toBe(false);
});
