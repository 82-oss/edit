// What a person reads when a service outside Edit runs out (Nov 16 audit):
// the service by name, that an admin adds credit, and that Edit carries on by
// itself; and the agent's own lines for the Claude plan and a busy Claude.

import { expect, test } from "bun:test";

import { explain } from "@edit/types/problems";

import * as steps from "../src/import_steps.ts";

test("a provider's credit running out names the provider, never the plain fallback", () => {
  // ElevenLabs' words as the relay passes them on (relay/src/index.ts elevenError, relay.ts failure).
  const voice = explain("ElevenLabs: This request exceeds your quota of 1334160. You have 15 credits remaining, while 1048 credits are required for this request. (quota_exceeded) (401)", "make the voice-over");
  expect(voice).toMatchObject({ title: "ElevenLabs is out of credit", fix: "An admin needs to add credit. Edit carries on by itself once it's back.", known: true });
  expect(explain('transcription failed (401): {"detail":{"status":"quota_exceeded","message":"This request exceeds your quota of 0."}}').title).toBe("ElevenLabs is out of credit");
  // Edit's own line while footage waits on the plan reads the same.
  expect(explain(steps.hearingWaits("This request exceeds your quota of 0. You have 0 credits remaining.", Date.now())).title).toBe("ElevenLabs is out of credit");
  const art = explain("OpenArt: Insufficient credits for this generation");
  expect(art).toMatchObject({ title: "OpenArt is out of credit", known: true });
  expect(art.fix).toContain("An admin needs to add OpenArt credit");
  expect(explain("OpenArt is low on credit for Nano Banana Pro: an admin needs to add OpenArt credit, then ask for the picture again.").title).toBe("OpenArt is out of credit");
});

test("Google Drive's download limit says Edit tries again by itself, and a copy's link goes on sooner", () => {
  const said = explain("Google Drive's download limit for this file is used up for today.");
  expect(said.title).toBe("Google Drive won't share that file again today");
  expect(said.fix).toContain("Edit tries again by itself");
  expect(said.fix).toContain("copy's link");
});

test("the agent's lines for the Claude plan and a busy Claude read as their own titles", () => {
  expect(explain("Your Claude plan is used up until 11:51 PM. Your message goes then.", "carry on")).toEqual({
    title: "Your Claude plan is used up",
    fix: "It's back at 11:51 PM. Your message goes then.",
    details: "Your Claude plan is used up until 11:51 PM. Your message goes then.",
    known: true,
  });
  expect(explain("Your Claude plan is used up until Tue 9:01 AM. Send your message again then.", "carry on")).toMatchObject({ title: "Your Claude plan is used up", fix: "It's back at Tue 9:01 AM. Send your message again then." });
  expect(explain("Claude is busy. Trying again in 20 s (1 of 3).", "carry on")).toMatchObject({ title: "Claude is busy", fix: "Edit is trying again by itself in 20 s.", known: true });
});
