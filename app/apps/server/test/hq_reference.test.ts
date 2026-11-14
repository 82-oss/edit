// Edit V2's maps (hq_reference.ts): Nov 13, its maps were satellite
// pictures laid flat, though edit-map's 3D city was in its notes.

import { expect, test } from "bun:test";

import type { Entry } from "../src/agent.ts";
import { mapImagery, personSaid } from "../src/hq_reference.ts";

let n = 0;
const said = (kind: string, text: string): Entry => ({ id: `e${n++}`, kind, text, at: 0, updated: 0 });

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
