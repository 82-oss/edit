import { describe, expect, it } from "vitest";

import type { AgentEntry } from "./agent";
import { landedIds, type Pending } from "./sentNow";

const pending = (id: string, text: string, newest: number, state: Pending["state"] = "sending", resends = false): Pending =>
  ({ id, chat: "idea:1", composer: "idea:1", text, at: 0, files: [], quotes: [], queued: false, state, offline: false, cancelled: false, newest, resends, deliver: async () => {} }) as Pending;
const user = (id: string, text: string, at: number, send_id?: string): AgentEntry => ({ id, kind: "user", text, at, ...(send_id === undefined ? {} : { send_id }) });

describe("which messages sent here a chat has", () => {
  it("knows the editor's by its id alone, in the conversation or the queue", () => {
    const sent = [pending("a", "same words", 5, "sent", true), pending("b", "same words", 5, "sent", true)];
    expect(landedIds(sent, [user("u1", "same words", 9)])).toEqual(new Set());
    expect(landedIds(sent, [user("u1", "same words", 9, "b")], [{ send_id: "a" }])).toEqual(new Set(["a", "b"]));
  });

  it("knows an idea's or a thumbnail's (no ids) by its words in a newer message, each message claimed once", () => {
    const sent = [pending("a", "again", 5), pending("b", "again", 5)];
    // An older message with the same words isn't it; one newer is the first's, a second the second's.
    expect(landedIds(sent, [user("t0", "again", 5)])).toEqual(new Set());
    expect(landedIds(sent, [user("t0", "again", 5), user("t1", "again", 6)])).toEqual(new Set(["a"]));
    expect(landedIds(sent, [user("t1", "again", 6), user("t2", "again", 7)])).toEqual(new Set(["a", "b"]));
  });

  it("knows one in a chat kept to its last turns, which dropped its oldest for it (Nov 5, a thumbnail's 80)", () => {
    const after = [user("turn-2", "message 2", 3), user("turn-4", "message 4", 5)];
    expect(landedIds([pending("a", "message 4", 3)], after)).toEqual(new Set(["a"]));
    expect(landedIds([pending("a", "message 4", 3)], after.slice(0, 1))).toEqual(new Set());
  });

  it("takes a newer message with other words as it only once the server has answered (it may say it its own way)", () => {
    expect(landedIds([pending("a", "make it pop", 5)], [user("t1", "Make it pop.", 6)])).toEqual(new Set());
    expect(landedIds([pending("a", "make it pop", 5, "sent")], [user("t1", "Make it pop.", 6)])).toEqual(new Set(["a"]));
  });
});
