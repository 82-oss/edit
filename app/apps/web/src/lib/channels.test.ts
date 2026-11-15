import { describe, expect, it } from "vitest";

import { channelsOf, groupTitle, type Channel, type Group } from "./channels";

const channel = (key: string, title: string): Channel => ({ key, youtubeId: null, handle: null, title, description: "", avatar: null, banner: null, subscribers: null, videos: null, views: null, narration: null, compilation: false, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, at: 0 });
const group = (...keys: string[]): Group => ({ key: "gr-0123456789", lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, channels: keys });

describe("a group by its channels (Sphe, Nov 15: no name to type)", () => {
  const all = [channel("a", "Sam's Bodycam"), channel("b", "Inspector Ted"), channel("c", "Snax Dirt")];
  it("joins two with &, three or more with commas and &", () => {
    expect(groupTitle(group("a", "b"), all)).toBe("Sam's Bodycam & Inspector Ted");
    expect(groupTitle(group("a", "b", "c"), all)).toBe("Sam's Bodycam, Inspector Ted & Snax Dirt");
  });
  it("names only the channels this person sees, by what they see (a label for a label-only one)", () => {
    expect(groupTitle(group("a", "x"), [channel("a", "Bodycam 1")])).toBe("Bodycam 1");
    expect(channelsOf(group("b", "a"), all).map((one) => one.key)).toEqual(["b", "a"]);
  });
});
