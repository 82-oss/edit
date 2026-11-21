import { describe, expect, it } from "vitest";

import { editStyles, makesVideos, writesScripts, type Account } from "./account";

const signedIn = (perms: string[], admin = false) => ({ person: { email: "a@b.c", name: "A", image: null }, perms, admin }) as unknown as Account;

describe("what the signed-in person may do", () => {
  it("someone who only writes scripts makes no videos, so Home sends them to Scripts", () => {
    const writer = signedIn(["use", "scripts.foia-compilation"]);
    expect([makesVideos(writer), writesScripts(writer)]).toEqual([false, true]);
    expect(editStyles(writer)).toEqual(new Set());
  });

  it("`use` alone opens nothing; an admin and nobody signed in have everything", () => {
    expect([makesVideos(signedIn(["use", "cloud"])), writesScripts(signedIn(["use", "cloud"]))]).toEqual([false, false]);
    expect([makesVideos(signedIn(["use"], true)), writesScripts(signedIn(["use"], true)), editStyles(signedIn(["use"], true))]).toEqual([true, true, null]);
    expect([makesVideos(null), writesScripts(null)]).toEqual([true, true]);
    expect([makesVideos(signedIn(["use", "video.subtitles"])), editStyles(signedIn(["use", "edit.bodycam"]))]).toEqual([true, new Set(["bodycam"])]);
  });
});

// Sphe, Nov 21: "a channel I've given a person access to should be all they need".
describe("a channel given", () => {
  it("is all it takes for Home's edits, scripts and ideas with Edit V2 on; with it off, only today's kinds count", async () => {
    const { makesIdeas } = await import("./ideas");
    const channelOnly = signedIn(["use", "cloud", "channel.ch-ted"]);
    expect([makesVideos(channelOnly), writesScripts(channelOnly), makesIdeas(channelOnly)]).toEqual([true, true, true]);
    expect([makesVideos(signedIn(["use", "channel.ch-ted.label"])), writesScripts(signedIn(["use", "channel.ch-ted.label"]))]).toEqual([true, true]);
    expect([makesVideos(channelOnly, false), writesScripts(channelOnly, false), makesIdeas(channelOnly, false)]).toEqual([false, false, false]);
    // No full edits of any style beside it: the kinds of V1 stay theirs to be given.
    expect(editStyles(channelOnly)).toEqual(new Set());
    expect([makesVideos(signedIn(["use", "edit.bodycam"]), false), writesScripts(signedIn(["use", "scripts.interrogation"]), false)]).toEqual([true, true]);
  });
});
