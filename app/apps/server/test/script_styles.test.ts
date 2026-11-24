// script_styles.ts and its place in a channel's Script lane (Sphe, Nov 24):
// many styles a channel, each a `style-<name>` lesson with its guide and its
// references as examples; a script written in the one it names, else the
// channel's default, and only that one in its writer's instructions.

import { afterEach, expect, test } from "bun:test";

import * as channels from "../src/channels.ts";
import * as lanes from "../src/lanes.ts";
import * as styles from "../src/script_styles.ts";
import * as v2cloud from "../src/v2_cloud.ts";

const CHANNEL = {
  key: "tedcases", youtubeId: "UC" + "a".repeat(22), handle: "inspectorted", title: "Inspector Ted", description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0,
  narration: { kind: "voice" as const, id: "v123", name: "House" }, compilation: false, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, archived: false, addedBy: null, at: 0,
};

const insanity = styles.compose("Dr Insanity", "Calm, clinical voice. Open on the suspect's worst line.", ['Dr Insanity, "The Killer Who…" (39:50) https://youtu.be/abc\n[0:00] NARRATION\nThis is the moment he knew.']);
const classic = styles.compose("Classic", "Plain storytelling.", []);
const lesson = (name: string, text: string, note?: string) => ({ name, text, key: `skill:@tedcases--script/${name}`, ...(note ? { note } : {}) });

afterEach(() => {
  v2cloud.useSkillsForTests([]);
  channels.useChannelsForTests([]);
});

test("a style is kept as its title, its guide and its examples, newest first, and read back the same", () => {
  const text = styles.compose("Dr Insanity", "The guide.", ["second ref\nwords", "first ref\nwords"]);
  const read = styles.parse({ name: "style-dr-insanity", text });
  expect(read).toEqual({ name: "style-dr-insanity", title: "Dr Insanity", guide: "The guide.", examples: ["second ref\nwords", "first ref\nwords"] });
  // Past its most, the oldest examples give way; the guide stays whole, and one example alone too long is cut.
  const long = styles.compose("Long", "The guide.", ["a".repeat(6_000), "b".repeat(6_000)], 9_000);
  expect(long.length).toBeLessThanOrEqual(9_000);
  expect(styles.parse({ name: "style-long", text: long }).examples).toHaveLength(2);
  expect(long).toContain("the rest left out for room");
  expect(styles.nameFor("Dr. Insanity")).toBe("style-dr-insanity");
  expect(styles.nameFor("default")).toBe("");
});

test("a script is written in the style it names, else the channel's default, else its only style when nothing else is taught", () => {
  const both = [lesson("style-dr-insanity", insanity, "A script style"), lesson("style-classic", classic, "A script style")];
  expect(styles.chosen(both, "style-classic")?.title).toBe("Classic");
  expect(styles.chosen(both, "Dr Insanity")?.title).toBe("Dr Insanity");
  // Two styles and no default: a script that names none has none.
  expect(styles.chosen(both, null)).toBeNull();
  expect(styles.chosen([...both, lesson("style-default", "style-classic")], null)?.title).toBe("Classic");
  // A default naming a style that's gone is no default.
  expect(styles.defaultIn([...both, lesson("style-default", "style-gone")])).toBeNull();
  // Taught by a reference alone: that style is the channel's.
  expect(styles.defaultIn([both[0]!])).toBe("style-dr-insanity");
  // With other lessons beside it, it's written in only when asked for.
  expect(styles.defaultIn([both[0]!, lesson("names-first", "Names first.")])).toBeNull();
  // A style picked that's been put away falls back to the default.
  expect(styles.chosen([...both, lesson("style-default", "style-classic")], "style-gone")?.title).toBe("Classic");
});

test("a build note names a style by its title or its name", () => {
  const both = [lesson("style-dr-insanity", insanity), lesson("style-classic", classic)];
  expect(styles.namedIn(both, "Write this one in the Dr Insanity style please")?.name).toBe("style-dr-insanity");
  expect(styles.namedIn(both, "dr-insanity style")?.name).toBe("style-dr-insanity");
  expect(styles.namedIn(both, "keep it classic")?.name).toBe("style-classic");
  expect(styles.namedIn(both, "tighten the intro")).toBeNull();
  // A word inside another isn't the name.
  expect(styles.namedIn(both, "neoclassical")).toBeNull();
  // Named only to be turned away, it isn't asked for; two asked for at once is none.
  expect(styles.namedIn(both, "Use Classic, not Dr Insanity")?.name).toBe("style-classic");
  expect(styles.namedIn(both, "rather than the Dr Insanity style, keep it classic")?.name).toBe("style-classic");
  expect(styles.namedIn(both, "mix Dr Insanity and Classic")).toBeNull();
  const nested = [lesson("style-dry", styles.compose("Dry", "Flat.", [])), lesson("style-dry-wit", styles.compose("Dry Wit", "Flat, with jokes.", []))];
  expect(styles.namedIn(nested, "in the dry wit style")?.name).toBe("style-dry-wit");
  // Each said on its own: two, so none.
  expect(styles.namedIn(nested, "use Dry and Dry Wit")).toBeNull();
  // A short name counts only said as a style.
  const tv = [lesson("style-tv", styles.compose("TV", "Broadcast.", [])), ...both];
  expect(styles.namedIn(tv, "Write this in the TV style")?.name).toBe("style-tv");
  expect(styles.namedIn(tv, "it was on TV last night")).toBeNull();
});

test("a channel whose scripts are taught in words on its page has no default style by itself", () => {
  const only = [lesson("style-dr-insanity", insanity)];
  expect(styles.defaultIn(only)).toBe("style-dr-insanity");
  expect(styles.defaultIn(only, true)).toBeNull();
  expect(styles.defaultIn([...only, lesson("style-default", "style-dr-insanity")], true)).toBe("style-dr-insanity");
  channels.useChannelsForTests([{ ...CHANNEL, lanes: { ...CHANNEL.lanes, script: "short, plain sentences" } }]);
  v2cloud.useSkillsForTests([lesson("style-dr-insanity", insanity, "A script style")]);
  expect(lanes.section("tedcases", "script", "none", false, null)).not.toContain("THIS SCRIPT'S STYLE");
  expect(lanes.section("tedcases", "script", "none", false, "style-dr-insanity")).toContain("THIS SCRIPT'S STYLE: Dr Insanity.");
});

test("a style kept for one channel of a group is that channel's: its default is kept there, and a style kept for the group never takes its examples", () => {
  channels.useChannelsForTests([{ ...CHANNEL, group: "gr-ted" } as typeof CHANNEL], [{ key: "gr-ted", lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, channels: ["tedcases"] } as never]);
  v2cloud.useSkillsForTests([{ ...lesson("style-dr-insanity", insanity, "A script style"), latest: 3 }]);
  expect(lanes.styleScope("tedcases", "style-dr-insanity")).toBe("channel");
  expect(lanes.styleAt("tedcases", "style-dr-insanity", "channel")?.latest).toBe(3);
  expect(lanes.styleAt("tedcases", "style-dr-insanity")).toBeUndefined();
  expect(lanes.defaultScope("tedcases", "style-dr-insanity")).toBe("channel");
  // A group's style is the group's default, unless the channel keeps a default of its own.
  v2cloud.useSkillsForTests([{ ...lesson("style-classic", classic), key: "skill:@gr-ted--script/style-classic" }]);
  expect(lanes.defaultScope("tedcases", "style-classic")).toBeUndefined();
  v2cloud.useSkillsForTests([{ ...lesson("style-classic", classic), key: "skill:@gr-ted--script/style-classic" }, lesson("style-default", "style-classic")]);
  expect(lanes.defaultScope("tedcases", "style-classic")).toBe("channel");
});

test("a script's writer reads its own style whole and only the others' names, beside the channel's lessons", () => {
  channels.useChannelsForTests([CHANNEL]);
  v2cloud.useSkillsForTests([
    lesson("names-first", "Say the suspect's name first."),
    lesson("style-dr-insanity", insanity, "A script style"),
    lesson("style-classic", classic, "A script style"),
    lesson("style-default", "style-classic"),
  ]);
  const picked = lanes.section("tedcases", "script", "none", false, "style-dr-insanity");
  expect(picked).toContain("- names-first: Say the suspect's name first.");
  expect(picked).toContain("THIS SCRIPT'S STYLE: Dr Insanity.");
  expect(picked).toContain("Calm, clinical voice.");
  expect(picked).toContain("This is the moment he knew.");
  expect(picked).toContain("never copied");
  expect(picked).not.toContain("Plain storytelling.");
  expect(picked).toContain("The channel's other script styles, not this script's unless the producer asks for one: Classic.");
  // Neither a style nor the default is a lesson or a part of its own.
  expect(picked).not.toContain("- style-default");
  expect(picked).not.toContain("## style-dr-insanity");
  // Naming none: the default.
  const fallback = lanes.section("tedcases", "script", "none", false, null);
  expect(fallback).toContain("THIS SCRIPT'S STYLE: Classic (the channel's default).");
  expect(fallback).not.toContain("Calm, clinical voice.");
  // The other lanes never see a script's styles.
  expect(lanes.section("tedcases", "ideas")).not.toContain("SCRIPT'S STYLE");
});

test("a channel with no styles is said as before", () => {
  channels.useChannelsForTests([CHANNEL]);
  v2cloud.useSkillsForTests([lesson("names-first", "Say the suspect's name first.")]);
  const text = lanes.section("tedcases", "script", "none", false, "style-dr-insanity");
  expect(text).toContain("- names-first");
  expect(text).not.toContain("STYLE:");
  expect(text).not.toContain("other script styles");
});
