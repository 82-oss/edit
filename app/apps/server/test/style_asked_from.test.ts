// A first build's note that asks to start from another channel's style names that channel (lanes.ts `styleAskedFrom`):
// Nov 25, Daily Interrogation's first script was to start from Female Felons' script style, before any chat existed.

import { afterEach, describe, expect, test } from "bun:test";

import * as channels from "../src/channels.ts";
import { styleAskedFrom } from "../src/lanes.ts";

const channel = (key: string, title: string, handle: string | null = null, archived = false) => ({ key, title, handle, archived });

afterEach(() => channels.useChannelsForTests([]));

describe("styleAskedFrom", () => {
  test("names another channel by its title or @handle beside the word style", () => {
    channels.useChannelsForTests([channel("ch-daily", "Daily Interrogation", "dailyinterrogation"), channel("ch-ff", "Female Felons", "femalefelons")] as never);
    expect(styleAskedFrom("ch-daily", "Start from Female Felons’ script style, then write it.")?.key).toBe("ch-ff");
    expect(styleAskedFrom("ch-daily", "Write it in @femalefelons's style")?.key).toBe("ch-ff");
    // No "style": a channel named for something else (its facts, its video) brings nothing.
    expect(styleAskedFrom("ch-daily", "Female Felons covered this case too, check what they said.")).toBeNull();
    // Its own name, or nothing named.
    expect(styleAskedFrom("ch-daily", "Daily Interrogation style, keep it tight.")).toBeNull();
    expect(styleAskedFrom("ch-daily", "A calm style, please.")).toBeNull();
  });

  test("the longest title wins, a put-away channel is never meant, and a title must stand as words", () => {
    channels.useChannelsForTests([channel("ch-mine", "Mine"), channel("ch-int", "Interrogations"), channel("ch-sam", "Sam's Interrogations"), channel("ch-away", "Female Felons", null, true), channel("ch-ted", "Ted")] as never);
    expect(styleAskedFrom("ch-mine", "Use Sam's Interrogations' style.")?.key).toBe("ch-sam");
    expect(styleAskedFrom("ch-mine", "Use the Interrogations style.")?.key).toBe("ch-int");
    expect(styleAskedFrom("ch-mine", "Start from Female Felons' style.")).toBeNull();
    expect(styleAskedFrom("ch-mine", "A muted style, as discussed.")).toBeNull();
  });
});
