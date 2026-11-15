import { describe, expect, it } from "vitest";

import { bannerUrl, channelsOf, groupTitle, narrationShort, rowsOf, taughtWords, type Channel, type Group } from "./channels";

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

describe("Channels' table (Sphe, Nov 15: a group is one row, its channels not under it)", () => {
  const grouped = (key: string, title: string, group: string): Channel => ({ ...channel(key, title), group });
  it("puts each group first, once, then every other channel by itself", () => {
    const all = [channel("c", "InternetJanitor"), grouped("a", "Inspector Ted", "gr-0123456789"), grouped("b", "Sam's Bodycam", "gr-0123456789")];
    const rows = rowsOf(all, [group("a", "b")]);
    expect(rows.map((row) => [row.kind, row.key])).toEqual([["group", "gr-0123456789"], ["channel", "c"]]);
  });
  it("shows a group whose other channels this person doesn't see as the one channel", () => {
    const rows = rowsOf([grouped("a", "Inspector Ted", "gr-0123456789")], [group("a", "x")]);
    expect(rows.map((row) => row.kind)).toEqual(["channel"]);
  });
  it("says what each lane was taught in words", () => {
    expect(taughtWords({ ideas: 0, thumbnails: 0, script: 3, edit: 17 })).toBe("Script 3 · Edit 17");
    expect(taughtWords({ ideas: 0, thumbnails: 0, script: 0, edit: 0 })).toBe("Nothing yet");
  });
  it("names a voice by its first name, and a banner by its desktop band", () => {
    expect(narrationShort({ kind: "voice", id: "v", name: "Andrew - Smooth audio books" })).toBe("Andrew");
    expect(narrationShort({ kind: "recorded" })).toBe("Recorded");
    expect(bannerUrl("https://yt3.googleusercontent.com/abc")).toMatch(/=w2120-fcrop64=/);
    expect(bannerUrl(null)).toBeNull();
  });
});
