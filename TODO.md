# To do

Ideas and next steps that aren't started yet. Newest at the top.

## Still open (from the plans and feedback logs cleared Nov 15)

Paths are relative to `app/`.

- A channel's watermark is set on its page now (uploaded, its own look; Nov 16). V1's dropdown of the Drive Watermarks folder (`apps/server/src/channel_marks.ts` `offerFor`) moves over once every channel's watermark is on its channel.
- A share's export goes up twice in full: the archive (`edit/exports/…`), then the review's `full.mp4`; only the stored copy is deduplicated (`apps/server/src/exports.ts` `heldByReview`, `reviews.ts` `fullBehind`). The relay has no server-side copy.
- One encoder lease with priorities (export > share copy > playback > made ahead > proxies): `apps/server/src/encoder.ts` only counts users; FFmpeg never pauses for an export, and Edit.app's playback doesn't hold off `export_ahead.ts` or `local_previews.ts`.
- While someone watches, their playback comes first: effect renders (`apps/server/src/effects.ts`) and the look Chromes (`effect_looker.ts`) don't wait; only `export_ahead.ts` gives way.
- Check a joined export by decoding, not only by frame count (`crates/edit-engine/src/render.rs` `export_chunked`); its fallback chain (chunked, again, whole native, whole FFmpeg) hides the first cause, and Marc's "joined 33826 frames, not 33786" was never explained.
- `scripts/acceptance.ts --native` stops at "Sign in to Edit": only the Chrome run gets `/api/account`'s `required: false` (`nativeChecks`), so check.yml's `native` job fails the day a Mac runner (`EDIT_MAC_RUNNER`) is enrolled.
- A drag forward in Edit.app past the 2 s a reader reads on is still bound by its seek (20–80 ms a position); a drag back reads pictures decoded behind the playhead (`behind.rs`, Nov 16). A reader kept ahead of a forward drag would hide the rest (`render.rs` `ReaderPool`, `player.rs` `hint`).
- Retire the page player's smooth render, scrub pieces and block cache (`apps/server/src/playback_render.ts`, `playback_stream.ts`, `scrub.ts`, `cloud_blocks.ts`, `export_excerpts.ts`) once browser playback over whole copies alone is measured.
- Measure a cold open on a slow line (JJ's took 6 s to 4 min a file) in Edit.app and the page.
- After a hard crash the old `claude` process isn't ended: `apps/server/src/serve.ts` `endLeftovers` only ends children of the same pid, so an orphan can keep calling the new server's `/mcp`.
- Errors seen in the team's logs, never diagnosed (check the R2 logs first; drop any that no longer occur): `censor: analyse … Input/output error` (`crates/edit-engine/src/censor.rs` `analyse_in_background`), `media: preview copy … Invalid argument` (`apps/server/src/media.ts`), YouTube "ffmpeg exited with code 251" (`youtube.ts`), VideoToolbox "A pixel buffer cannot be appended" (`crates/edit-engine/src/mac_media.m`).
- Plans refused for media that "runs out at" (19 on nightly-58): check whether the agent still hits it, and if so show it each media's length more clearly (`apps/server/src/edit_plan.ts` `runsOut`, `cutin.ts`).
- The live relay still has `DIARIZE = "pyannote"` for builds before Nov 11 (`apps/relay/wrangler.toml`); every Mac is past that, so it can go "off" (keep the code to turn back on).
- The server says "choose Check Claude", a button the page no longer has (it shows Repair or Sign in): `apps/server/src/claude_support.ts`, `agent.ts` `waitForClaudeLogin`.
- `repack_subtitles` loses hand fixes on a re-run: lines deleted and holds lengthened by hand come back; only hand-moved positions are kept (`apps/server/src/subtitles.ts` `repackSubtitles`, `captions.ts` `adjusted`).
- The `countdown` op ends at the frame it counts to; it can't stay up 15 s while counting to a later return (`apps/server/src/intro_graphics.ts` `countdown`).
- Akwe Pro Bold's licence was never verified (its download said personal use): `crates/edit-render/fonts/AkwePro-Bold.otf`, `assets/commentary/README.md`.
- Unsure: blurring the "COURTROOM WATCH" logo leaves a soft blue patch from its box; a solid patch or a crop was left for the team (`apps/server/src/mark_blurs.ts`).
- `broll_recut` and "hold the shot" have never run in a real courtroom edit: check on the next one (`apps/server/src/onscreen.ts`; the repo's `agent/styles/courtroom/notes.md`).
- No auth beyond loopback: any device on the tailnet can drive `/mcp`, `/api/ws` and the changing `/api/*` routes (`apps/server/src/http/host.ts` `checkHost` checks Host and Origin only); a per-install bearer like `remote_support.ts` `requireLocalCli` would close it. Sphe's call.
- Deleting a review link leaves each version's `fullKey`, `preview.key` and `wordsKey` on R2 (accounts repo, `convex/reviewPage.ts` `remove`; `reviews:remove` shows how to queue them).
- No dev review site: links shared from dev open nothing, since feedback.spheceo.com reads prod only; Edit only warns (`apps/server/src/reviews.ts`, `test/reviews_dev_share.test.ts`).
- Idea, needs a trial on JJ's Mac with real bodycam footage: hardware and x264 encoding together for exports (about 1.5–1.8× on the video stage when idle), HEVC speed-over-quality for previews and proxies (`render.rs` chunked export, `mac_media.m` writer).
- Optional: Apple's first-pass words have no pauses (word ends run into the next word, `apps/server/src/mac_speech.ts`); footage Apple hears worst could get Scribe in pieces, or a wider `PAD_MS` (`kept_hearing.ts`).
- Decision for Sphe: Apple's on-device sound classifier behind `listen`, to name music, sirens or shouting (`apps/server/src/listen.ts`; Mac-only native code beside `mac_media.m`, about a day).
- Parked: SAM 2.1 mask tracking as a fallback where the template tracker loses a face (`crates/edit-engine/src/track.rs` `track_region`); 2–3 s a frame on the M1, next step a WebGPU probe in headless Chrome.

## Speaking to the agents: local speech-to-text (future)

Talk to the in-app agents instead of typing a prompt: a mic button in the chat composers (edits, scripts, Ideas, Thumbnails), the words transcribed on the machine itself, so nothing is uploaded, nothing is paid per minute, and the text lands in the box to send or fix first. Not footage: footage and subtitles stay on ElevenLabs Scribe (`transcribe.ts`). What it needs: text back within a moment of stopping (words as you speak, ideally), on every machine the team uses (Apple Silicon Macs first, Linux with or without an NVIDIA card), and the case's names spelled right where it can (the project's cast, `people.ts`). Researched Nov 7, 2026:

- **NVIDIA Parakeet TDT 0.6B v3** (Apache 2.0) is the accurate one: on a Mac through FluidAudio (Core ML on the Neural Engine; a short phrase back in ~0.2 s on an M4) or parakeet-mlx (~0.5 s), on Linux through ONNX on the NVIDIA card. About 1.2 GB, so downloaded the first time someone dictates. Its 120M streaming sibling, Parakeet EOU, gives words as you speak and knows when you've stopped.
- **Moonshine** (MIT for English, small) was built for streaming: words appear as you talk and are seldom revised. Small enough to run on any CPU, so the one model that could serve every machine the same way (through tract, as faces and on-screen text do on Linux).
- **Whisper large-v3-turbo** (MIT, through whisper.cpp or WhisperKit) only if the team dictates in languages Parakeet lacks; it's slower for the same English.
- **Names:** every engine stumbles on names and jargon (bodycam terms, the cast). NeMo's phrase boosting does it for Parakeet on NVIDIA; elsewhere, the agent can be told the cast and fix a misheard name, as it would a typo.
- **Try first:** Moonshine everywhere for its simplicity, against Parakeet on a Mac, with the team's own dictated prompts; keep whichever gets names and speed right.

Sources: [local STT models compared](https://www.onresonant.com/resources/local-stt-models-2026), [Mac engines on 13,000 recordings](https://dicta.to/blog/speech-to-text-engine-comparison-mac-2026/), [Parakeet on the Neural Engine](https://macparakeet-website.pages.dev/blog/whisper-to-parakeet-neural-engine), [speech-swift (Parakeet EOU streaming)](https://github.com/soniqo/speech-swift), [Whisper large-v3 vs turbo](https://vexascribe.com/whisper-large-v3-vs-turbo), [NeMo word boosting](https://docs.nvidia.com/nemo/speech/nightly/asr/asr_customization/word_boosting.html).

## Linux: the thumbnail subject cut-out

On a Mac the thumbnail maker lifts a subject out with Vision's "Copy Subject" (`subject_cutout`, `crates/edit-native/src/media.rs`); on Linux it says "Lifting a subject out needs a Mac." The stand-in: BiRefNet (MIT, the best open background-removal model; ~200 MB, so downloaded the first time someone uses it rather than shipped in the binary), run on the NVIDIA card. Faces (YuNet) and on-screen text already run on Linux the same way, through tract.

## Ideas and thumbnails: a feedback link (future)

A way to send an idea or a thumbnail off to a feedback link — share it outside Edit for review, the way an edit goes to its review link, and have what comes back land where the work is. Not built yet; wanted so ideas and thumbnails can be sent for feedback without a screenshot and a message.

## Thumbnails: frames from YouTube

Give Claude Ideas' `scan_video` and `grab_frames` (`app/apps/server/src/ideas/frames.ts`, through the YouTube proxy) on a thumbnail, so it can pick a base and its subjects from the case's video itself (`docs/thumbnails.md`).
