// V2's niches on the page: New project's pills (falling back to Bodycam HQ),
// what a niche may be like, and its page's knowledge grouped.

import { expect, test, vi } from "vitest";

vi.mock("./api", () => ({ request: vi.fn() }));

const { chainOf, groupKnowledge, likeOptions, v2Choices } = await import("./niches");
import type { Knowledge, Niche } from "./niches";

const niche = (key: string, like: string | null = null, kind: Niche["kind"] = "bodycam"): Niche => ({ key, name: key.toUpperCase(), description: `${key} videos`, like, kind });

test("New project offers the niches of a kind the person edits", () => {
  const niches = [niche("bodycam-hq"), niche("interrogation-hq", "bodycam-hq", "interrogation")];
  expect(v2Choices(niches, ["bodycam", "interrogation"]).map((one) => one.niche)).toEqual(["bodycam-hq", "interrogation-hq"]);
  expect(v2Choices(niches, ["interrogation"]).map((one) => one.key)).toEqual(["interrogation-hq"]);
});

test("with no niches to be had, Bodycam HQ is offered as before (no niche sent)", () => {
  expect(v2Choices(null, ["bodycam"])).toEqual([expect.objectContaining({ key: "bodycam-hq", name: "Bodycam HQ", niche: null, kind: "bodycam" })]);
  expect(v2Choices([], ["bodycam"])).toHaveLength(1);
  expect(v2Choices([niche("court", null, "courtroom")], ["bodycam"])).toEqual([expect.objectContaining({ niche: null })]);
  expect(v2Choices(null, ["courtroom"])).toEqual([]);
});

test("a niche can't be like one that's already like it", () => {
  const niches = [niche("a"), niche("b", "a"), niche("c", "b"), niche("d")];
  expect(chainOf("c", niches)).toEqual(["c", "b", "a"]);
  expect(likeOptions("a", niches).map((one) => one.key)).toEqual(["d"]);
  expect(likeOptions("c", niches).map((one) => one.key)).toEqual(["a", "b", "d"]);
  // A loop already in the cloud doesn't hang.
  expect(chainOf("x", [niche("x", "y"), niche("y", "x")])).toEqual(["x", "y"]);
});

test("a niche's page groups what its agent knows by kind, then where it comes from, its own first", () => {
  const item = (kind: Knowledge["kind"], name: string, origin: string, own = false): Knowledge => ({ kind, key: `${kind}:${name}`, name, note: null, category: null, origin, own });
  const sections = groupKnowledge([
    item("skill", "global", "V2's house, every niche's"),
    item("font", "Geist", "V2's house, every niche's"),
    item("skill", "cut-ins", "from Bodycam HQ (this niche is like it)"),
    item("skill", "calls", "this niche's own", true),
    item("skill", "maps", "from Bodycam HQ (this niche is like it)"),
  ]);
  expect(sections.map((one) => [one.title, one.count])).toEqual([
    ["Lessons", 4],
    ["Fonts", 1],
  ]);
  expect(sections[0]!.groups.map((one) => [one.origin, one.items.map((item) => item.name)])).toEqual([
    ["this niche's own", ["calls"]],
    ["V2's house, every niche's", ["global"]],
    ["from Bodycam HQ (this niche is like it)", ["cut-ins", "maps"]],
  ]);
});
