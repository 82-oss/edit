// A channel's project speaks in its channel's narration voice (Nov 21: every voice-over took the voice of the
// project's style, so a channel set up with its own narrator was voiced by the courtroom's or the house's). A
// project of no channel, or of a channel whose narration is recorded or not set, keeps its style's voice.

import { afterEach, expect, test } from "bun:test";

import * as channels from "../src/channels.ts";
import type { Project } from "../src/model.ts";
import { voiceFor } from "../src/styles.ts";
import * as voiceover from "../src/voiceover.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

const CHANNEL = {
  key: "drinsanity", youtubeId: "UC" + "a".repeat(22), handle: "drinsanity", title: "Dr Insanity", description: "", avatar: null, banner: null, uploads: null, subscribers: 1, videos: 1, views: 1, country: null, publishedAt: null, fetchedAt: 0,
  narration: { kind: "voice" as const, id: "v-channel", name: "Doc" }, compilation: false, lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, archived: false, addedBy: null, at: 0,
};
const RECORDED = { ...CHANNEL, key: "jcs", title: "JCS", narration: { kind: "recorded" as const } };
const UNSET = { ...CHANNEL, key: "unset", title: "Unset", narration: null };

afterEach(() => channels.useChannelsForTests([]));

test("a channel with a voice gives that voice; recorded, unset, unknown or no channel give the style's", async () => {
  channels.useChannelsForTests([CHANNEL, RECORDED, UNSET]);
  const courtroom = voiceFor("courtroom");
  expect(courtroom).not.toBeNull();
  expect(await channels.voiceOf({ style: "courtroom", channel: "drinsanity" })).toBe("v-channel");
  expect(await channels.voiceOf({ style: "bodycam", channel: "drinsanity" })).toBe("v-channel");
  expect(await channels.voiceOf({ style: "courtroom", channel: "jcs" })).toBe(courtroom);
  expect(await channels.voiceOf({ style: "courtroom", channel: "unset" })).toBe(courtroom);
  expect(await channels.voiceOf({ style: "courtroom", channel: "gone" })).toBe(courtroom);
  expect(await channels.voiceOf({ style: "courtroom" })).toBe(courtroom);
  expect(await channels.voiceOf({ style: "bodycam" })).toBeNull();
});

/** A project with two cut-ins, of `channel` when given, and the voice its voice-over was made with. */
async function voicedWith(channel: string | undefined, run: (app: ReturnType<typeof fixtureHome>["app"], id: string) => Promise<unknown>): Promise<(string | null)[]> {
  const given: (string | null)[] = [];
  const stand = {
    forProject: (_name: string, _source: string, _lines: unknown, voice: string | null = null) => (given.push(voice), { id: "vo", lines: [] }),
    create: (_name: string, _source: string | null, _lines: unknown, voice: string | null = null) => (given.push(voice), { id: "vo", lines: [{ id: "l1", label: "Cut-in 1", text: "" }] }),
    list: () => [],
    generate: async () => {},
    chosenTakes: () => [],
    save: () => {},
  };
  const fixture = fixtureHome("channel-voice", { services: { voices: stand as never } });
  try {
    const id = fixture.store.create("Case", { width: 640, height: 360, fps: 30 }).project.id;
    await fixture.store.update(id, "test", (project: Project) => {
      project.style = "courtroom";
      if (channel !== undefined) project.channel = channel;
      // Cut-in 1's voice-over placed (what a revoice needs), as an import on another machine left it.
      if (!project.tracks.some((track) => track.kind === "audio")) project.tracks.push({ id: "a1", kind: "audio", hidden: false, muted: false, locked: false });
      const audio = project.tracks.find((track) => track.kind === "audio")!.id;
      project.media.push(media({ id: "vo-media", name: "Narration", path: "/tmp/vo.wav", kind: "audio", duration: 5, has_audio: true }));
      project.clips.push(clip({ id: "vo-clip", track: audio, start: 0, duration: 30, name: "Voice-over", type: "audio", media: "vo-media", source_in: 0 }));
      project.script = { blocks: [{ kind: "narration", text: "Then it happened.", voiceover: "vo-clip" }, { kind: "narration", text: "And then this." }] } as Project["script"];
    });
    // Each call goes on to place what was spoken, which this stand-in never made: only the voice it was given matters.
    await run(fixture.app, id).catch(() => {});
    return given;
  } finally {
    fixture.cleanup();
  }
}

test("the voice-over of a channel's project is made in the channel's voice, and of a project of no channel in its style's", async () => {
  channels.useChannelsForTests([CHANNEL, RECORDED]);
  const courtroom = voiceFor("courtroom");
  for (const [channel, voice] of [["drinsanity", "v-channel"], ["jcs", courtroom], [undefined, courtroom]] as const) {
    expect(await voicedWith(channel, (app, id) => voiceover.generate(app, id))).toEqual([voice]);
    expect(await voicedWith(channel, (app, id) => voiceover.revoice(app, id, 1, "New words."))).toEqual([voice]);
  }
});
