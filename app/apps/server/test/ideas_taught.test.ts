// A channel's idea (Edit V2) is written only from what the channel was taught,
// and uses the channel's own Trello board once one is pasted on its page (Sphe,
// Nov 18): with nothing taught it waits to be told how; a card stays on the
// board it went to.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import type { Channel } from "../src/channels.ts";
import * as channels from "../src/channels.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { whereOf } from "../src/ideas/board.ts";
import { isTaught, needsTeaching, UNTAUGHT } from "../src/ideas/run.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

afterEach(() => {
  v2cloud.useSkillsForTests([]);
  channels.useChannelsForTests([]);
});

const channel = (key: string, trello: Channel["trello"] = null) => ({ key, title: key, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, trello }) as unknown as Channel;
const board = { boardId: "a".repeat(24), name: "Felons Ideas", url: "https://trello.com/b/abc/felons-ideas", lanes: [{ id: "b".repeat(24), name: "Ideas" }] };
const card = { cardId: "c".repeat(24), url: "", lane: "x", list: "Ideas", sentAt: 0, sentBy: "Sphe" };

test("a channel's idea waits to be told how while its ideas aren't taught; an angle tells it; a taught channel or none never waits", async () => {
  v2cloud.useSkillsForTests([]);
  expect(isTaught({ channel: "ch-f" })).toBe(true);
  expect(await needsTeaching({ channel: "ch-f", steer: "" })).toBe(UNTAUGHT);
  expect(await needsTeaching({ channel: "ch-f", steer: "Lead with the betrayal." })).toBeNull();
  expect(await needsTeaching({ steer: "" })).toBeNull();
  v2cloud.useSkillsForTests([{ name: "titles", text: "Short titles.", key: v2cloud.ownKey("skill", v2cloud.laneKey("ch-f", "ideas"), "titles") }]);
  expect(await needsTeaching({ channel: "ch-f", steer: "" })).toBeNull();
  v2cloud.useSkillsForTests([], [], false);
  expect(await needsTeaching({ channel: "ch-f", steer: "" })).toContain("couldn't be read");
});

test("an idea's board: its channel's own once pasted, its workspace's until then, and a card stays where it went", () => {
  channels.useChannelsForTests([channel("ch-f", board), channel("ch-g")]);
  expect(whereOf({ workspace: "interrogation", channel: "ch-f", card: null })).toEqual({ workspace: "interrogation", channel: "ch-f" });
  expect(whereOf({ workspace: "bodycam", channel: "ch-g", card: null })).toEqual({ workspace: "bodycam", channel: null });
  expect(whereOf({ workspace: "interrogation", channel: "ch-f", card })).toEqual({ workspace: "interrogation", channel: null });
  expect(whereOf({ workspace: "interrogation", channel: "ch-f", card: { ...card, channel: "ch-f" } })).toEqual({ workspace: "interrogation", channel: "ch-f" });
});
