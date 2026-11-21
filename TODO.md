# To do

The one list of work that isn't done. On Nov 21 every plan, review, council, feedback log and topic doc in the repo was checked against the code; what was built was deleted, and what wasn't is here. An item is deleted from this file when it's done. The files it came from are in git history (`git log --all -- docs/plans docs/feedback docs/fix-next.md`).

Paths are relative to `app/`. Items are grouped by area, not ordered inside a group; "Do first" is the order.

## Do first

Filled in by the Nov 21 review of this list (below).

## Imports and Script mode

- **Script mode deletes its local copy once it's uploaded**, so Start the edit reads every recording back over the network (`apps/server/src/writer/streamed.ts` `settle`, then `drop`). The copy should be kept as the local original while there's room.
- **Two fetch paths where one was planned**: fetch to disk first when there's room, one function with a "room here?" branch. `footageToDisk` and `footageToCloud` are still two (`script.ts`), `cutsBetterHere` / `wholeHere` and the fallback in `driveExcerpts` remain (`cloud_media.ts`), and the ledger doesn't cover Script mode's footage (`ledger.ts` `rootsOf`).
- **Three bad-day cases are stubs**: `handoff-no-refetch`, `resume-download`, `upload-behind` throw "isn't written yet" (`scripts/bad-day/cases/stubs.ts`). They wait on the two items above.
- **Cloud cuts run three at once whatever the source** (`cloud_media.ts` `EXCERPTS_AT_ONCE`); over the network they were meant to go one at a time.
- **An excerpt cut over the network fetches two to five times what it needs** (bad-day `no-room` fails its bytes bound on both machines: about 100 MB fetched for 20 MB of excerpts). FFmpeg's reads are open-ended ranges: each cut opens the file twice, drops each read after 2 to 3 MB and reads about 4 MB past the excerpt's end. Bounded ranges would stop it.
- **Two fixed clocks remain on network work**: `LIMITS.relayCopy` is a total deadline beside its stall rule (`cloud_media.ts`; the Mac takes over when it trips, so nothing fails), and the remote probe is a fixed 15 minutes (`import_steps.ts`).
- **"Go on without" lives in a file on one Mac** (`missing_media.ts`, `footage-gone-without.json`); it was meant to move into the project, which needs a field on edit-core's Media.
- **A failed Drive upload ends its job** with no wait (`drive.ts`, emits "failed" then `jobs.end`). A footage import from a Drive link already waits.
- **An unknown failure stops Script mode's import as if it were the person's to fix** (`writer/imports.ts` `known ?? "person"`); shares read only `failure.surely` too (`reviews.ts`).
- **An export waits only on errors known to pass**; room, quota and unrecognised failures still end failed with Retry (`exports.ts`, `failure.surely(...) === "passing"`).
- **A file that's the person's to fix is never looked at again in the editor's import** (`script.ts` deletes its `retry_at`): if JJ shares the file in Drive, nothing happens until he presses Try again. A cheap "is it shared now?" check every 30 minutes was planned.
- **Every wake retries all missing recordings, not only those due** (`serve.ts` calls `writerMissing.tryAgain(project, true)`; `writer/missing.ts` skips `nextAt` when `all`). A recording at Drive's daily limit is asked for whenever a neighbour's minute is up.
- **Footage gone without is retried for good**, whatever the project's state or the failure's kind (`missing_media.ts`).
- **After an update every failed export and share is retried**, not only the broken ones (`retry_after_update.ts`). Low impact: chunks are kept.
- **A share carried on from an older build loses "Exported as the edit is now"** (`serve.ts`: the share gets `note`, not `said`); no test reads that note.
- **The editor's import stops for a file that's really gone** (Script mode goes on without it). Needs "Use another link" to work on an edit already laid out.
- **"Skip all" is looser than skipping by name**: it also skips files waiting on room, credit or a sign-in (`script.ts`, the `*` path).
- **Left from the AVI fix**: a big upload doesn't give way to an import's downloads, and an import that keeps failing the same files doesn't lay out the rest.
- **A local-file import with the relay down**: `putHashed` waits for the registry before anything else (`cloud_media.ts` `getRecord`); no bad-day case covers it.
- **A deleted script's original may keep uploading**: an upload already under way, or the relay's own Drive-to-R2 copy, was never tested.
- **Disk claims are one total for the whole process with no disk attached, and a disk whose free space can't be read counts as endless** (`storage.ts` claims, `admit`).
- **Uploads aren't paced to leave room on the line** (nothing in `cloud.ts`, `uploads.ts`, `cloud_media.ts`, `writer/cloud.ts`). On JJ's 8 Mbit/s uplink a share's upload starves everything else.
- **Saved files are trusted as read**: `jobs.json`'s shape isn't checked, which matters for rows written by nightly-84.
- **The footage dialog can still say "Only 2.0 of the 2.0 GB fits"** when the bytes are down but files aren't all here (`footage_ready.ts`).
- **The relay answers 401 to a token whose `kid` is missing when its re-read of the keys fails** (`apps/relay/src/auth.ts`).
- **Once every Mac has the build with the job table**: delete `wakeWhatPasses` and `carryOnOlder` (`serve.ts`, `script.ts`, `seams.ts`, `writer/missing.ts`), `ChooseRecordings.tsx`, the old going-on-without file's reader and `jobs.ts`'s pre-Nov-8 rows.
- **Stale comments and names**: `import_steps.ts`'s header still describes `RETRY_WAITS` and "every step is bounded", and keeps `whyOf`, `passing`, `QUOTA_RETRY_MS`, `LIMIT_RETRY_MS` as aliases; `cloud_media.ts` "an hour and then a day later"; `remote_control.ts` names `busy.wouldLose`; `cache_cleanup.ts` and `writer/storage.ts` still say "15 GB or a tenth of the disk" (it's a flat 15 GB, `storage.ts`).

## Exports and shares

- **A share's export goes up twice in full**: the archive (`edit/exports/…`), then the review's `full.mp4` (`exports.ts` `heldByReview`, `reviews.ts` `fullBehind`). The relay has no server-side copy. With it: the review copy isn't uploaded ahead of the share, and it's still 3 Mbit/s (`reviews.ts`).
- **One encoder lease with priorities** (export > share copy > playback > made ahead > proxies): `encoder.ts` only counts users. Done so far: a person's Export takes the encoder from smooth playback's render.
- **An export made ahead doesn't step aside for a live play** (it checks only before it starts, `export_ahead.ts`), a real export doesn't use fewer encoders while something plays, and exports made ahead have no byte quota. Whether to keep exports made ahead at all waits on a week's count of how often one is used.
- **A joined export is checked by frame count only** (`crates/edit-engine/src/render.rs` `export_chunked`); its fallback chain (chunked, again, whole native, whole FFmpeg) hides the first cause, and Marc's "joined 33826 frames, not 33786" was never explained.
- **Planning a long edit is a synchronous native call** (`exportPlan`: 716 ms on the server's thread for a 2-hour edit; callers in `effect_inputs.ts`, `playback_render.ts`, `motion_review.ts`). Planned once a revision now; the call itself should be asynchronous in Rust.
- **The engine's own waits have no deadlines**: a dead VideoToolbox session or a lost GPU after a lid close can leave a render thread waiting for good. Edit drops such a job after a minute and starts a fresh one; the Rust side should end it itself (`wait()` settling within seconds of `cancel()`, `recv_timeout` in the stage loops, deadlines on AVAssetWriter's finish and cancel).
- **"What's beneath title-card" never renders on Linux** ("When Cops Rescue Boyfriends…", 17 times, once at every start). An 8-frame export fails four ways in two seconds, no frame reaching the encoder; a size the encoders refuse (odd, or under NVENC's smallest) is the first thing to look at, and the engine keeps only FFmpeg's last line, which hides the reason. Not seen on a Mac.
- **The server aborted once as it stopped mid-export**; release symbols are kept to place the next one (`Cargo.toml`), nothing since.
- **`review_motion` works on the server's thread**: FFmpeg through `Bun.spawnSync` and `exportPlan`, and its saved-answer check runs only after it has taken the one slot (`motion_review.ts`).
- **`pmset` is a `spawnSync` on the server's thread once a minute** (`export_ahead.ts`, 2 s timeout): against "no synchronous program" in `docs/dev.md`.
- **Idea, needs a trial on JJ's Mac**: hardware and x264 encoding together for exports (about 1.5 to 1.8 times on the video stage when idle), HEVC speed-over-quality for previews and proxies.

## Playback

- **Edit.app's player, from the Nov 20 audit**: long videos' sound always streams (it could come from the piece here); the window's read-ahead is skipped for any file that has excerpts; the sound clock isn't restarted after an output device change or a wake; one failing sound part silences the rest of a play.
- **The first picture from a fresh decoder takes 181 to 228 ms on the MacBook Air** (3 of 3 runs, Nov 21), against the 100 ms mark of `scripts/acceptance.ts --native`.
- **One local proxy by rule, never uploaded** (the local-first plan's step 3, never built). Measured Nov 18 on an M1: a file whose keyframes are at most about 2 s apart plays as the original (jumps 33 to 54 ms); everything else, which is every YouTube download (keyframes 4 to 7 s apart, up to 13.5 s) and long-GOP Drive exports, jumps at 140 to 600 ms under an agent's load. The rule: probe keyframe spacing at import (`ffprobe -skip_frame nokey`); files over 2 s get one proxy at 720p, a keyframe every second, no B-frames, about 1.8 Mbit/s, made at 5 to 17 times real time and kept on the Mac only. Today's proxy is up to 1080p at 4 Mbit/s, made in pieces and uploaded (`proxy_pieces.ts`, `crates/edit-native/src/media.rs`). A 113-minute source is 1.81 GB as the original against 6 to 9 GB of preview copies. Not yet measured: capping a 60 fps source's proxy at 30 fps, phone HEVC and 4K footage, the 2.1 to 2.4 s first seek.
- **One player, and the old layers retired**: full screen still uses the page's player (`apps/web/src/components/Viewer.tsx`), and the page player's smooth render, scrub pieces, stitched stream, block cache and export excerpts are all still here (`playback_render.ts`, `playback_stream.ts`, `scrub.ts`, `cloud_blocks.ts`, `export_excerpts.ts`, `native_preview.ts` `joined/` and `native2/`). They go once playing from files on the Mac is proven on a real Mac.
- **A drag forward in Edit.app is bound by its seek** (20 to 80 ms a position) past the 2 s a reader reads on; a reader kept ahead of a forward drag would hide it (`render.rs` `ReaderPool`, `player.rs` `hint`).
- **The agent's own previews run at normal priority while someone watches** (`render_frame`, `look_at_media`'s decodes); only the effects' Chromes and the looks' FFmpegs are below a play (`playing.ts` `keepBelow`).
- **A cold open on a slow line was never measured in Edit.app or the page** (JJ's took 6 s to 4 min a file); bad-day's `cold-open-play` covers the server's side only.
- **V2: the viewer doesn't measure what it draws.** The Mac viewer should time its own drawing of an effect and play the render where the web view can't keep up; the only cost check is measured in Chrome (`effect_tools.ts`). Also never checked on a Mac: a stacked-alpha render in the native player, and an effect with moving footage.
- **A strip the native reader refuses isn't remembered** ("No native video track"), so it falls back to FFmpeg on every read. Unconfirmed whether it still happens.
- **Nobody has listened to 2× speed's sound.**

## The server's thread, start and crashes

- **As Edit starts it answers nothing for 3 to 8 s** on a home with long edits ("last started: GET /api/projects/{id}/text-removal"). Read the `[thread]` lines of a start.
- **The hourly cache clean keeps the thread about 3 s** on a home of 14,000 cached files (`cache_cleanup.ts` `cleanCache` or `cleanExports`; each names itself in the `[thread]` line).
- **A Nov 4 `.partial` file in `cloud/sound` is never swept**: eviction skips partial files and the other sweep doesn't match that path (`cache_cleanup.ts`).
- **Prod Linux Edit holds about 9.5 GB while blurring two projects**, and the blur's Rust threads take the whole CPU quota; it should cap its own threads.
- **A crash in the Rust addon takes the whole server down**: it runs inside the server's process.
- **After a hard crash the old `claude` process isn't ended** (`serve.ts` `endLeftovers` ends only children of the same pid), so an orphan can keep calling the new server's `/mcp`.

## Still to prove on real Macs

From the Nov 19 council's list; none can be shown in a harness. A real lid close, with wake lines counted against `pmset -g log`. JJ's real line and 6 GB files. Disks over days, and a nearly full Mac. Being signed out for real with work waiting. The encoder shared by an export and an import. Marc moved from nightly-84 and JJ from 96. The relay's sign-in change live. A weekly count of what failed and why, from every Mac's report (`[thread]` lines included).

## Tests and checks

- **Two tests fail every Linux build**, so a stable release can't pass its Linux check: `apps/server/test/export_ahead.test.ts` (no "chunks … already made" line in the last 400 log lines) and `proxy_pieces.test.ts` (the PSNR compare of piece 1 reports 31 frames, not 30).
- **No release check runs an old client against the new relay.**
- **No check that a failure path never deletes someone's work** (a test or grep flagging removal of blocks, clips or media outside an explicit delete).
- **No lint against the `!` shortcut in new code** (`.oxlintrc.json`).
- **Errors seen in the team's logs, never diagnosed** (check the R2 logs first; drop any that no longer occur): `censor: analyse … Input/output error`, `media: preview copy … Invalid argument`, YouTube "ffmpeg exited with code 251", VideoToolbox "A pixel buffer cannot be appended".
- **Plans refused for media that "runs out at"** (19 on nightly-58): check whether the agent still hits it (`edit_plan.ts` `runsOut`).

## The in-app agent

- **Most of `agent/` is not in any channel.** Checked Nov 21 against prod's channels. Moved, word for word, and no longer read from the repo by channel projects: the writer guides `cut-in`, `judgment`, `house`, `foia`, `compilation`, and both ideas guides. Moved only as a short rewrite: the ten house edit skills. Not moved at all: `writer/courtroom.md`, `writer/commentary.md`, `thumbnails/guide.md` (every Thumbnails lane is empty), `skills/subtitle-video.md`, most of `skills/resume-edit.md`, `shared/names-first.md`, and all 45 files of `styles/` (no courtroom, horror, shorts or commentary channel exists). None of it can be deleted while V1 is in use: 105 of 116 edit projects, 113 of 126 scripts and all 42 ideas have no channel, and JJ and Marc made V1 work on Nov 18 to 20. Deleting `agent/writer` today stops Edit from starting.
- **Channel projects still read three repo files**: `instructions.md` (sent whole to every session, with a list of skills for a tool channel projects don't have, `mcp/index.ts`), `writer/commentary.md` (`writer/commentary.ts`, even when the script has a channel) and `thumbnails/guide.md` (`thumbnails/run.ts`).
- **A channel project's voice-over may take its voice from the project's style, not the channel's narration voice** (`styles.ts` → `voiceover.ts`; projects default to `bodycam`). Not traced.
- **A rejected edit plan says only "revision conflict … refresh get_edit_context"** (`edit_tools.ts`), with no span of what changed.
- **V1 still compacts its conversation at 180k** (`claude.ts`; V2 uses 1M). Measure first.
- **Tools don't forgive near-misses**: an unknown tool gets no suggestion (`mcp/index.ts`), `report_problem` requires `tool` (`agent_reports.ts`), rectangles aren't clamped.
- **`repack_subtitles` loses hand fixes on a re-run**: lines deleted and holds lengthened by hand come back (`subtitles.ts`, `captions.ts` `adjusted`).
- **The `countdown` op ends at the frame it counts to**; it can't stay up while counting to a later return (`intro_graphics.ts`).
- **`broll_recut` and "hold the shot" have never run in a real courtroom edit** (`onscreen.ts`).
- **The server says "choose Check Claude"**, a button the page no longer has (`agent.ts` `waitForClaudeLogin`).
- **Text removal, from the Boyfriends edit**: the bottom ARRESTFLIX mark is never found; a short "No" in the 0.80× copy reads as no words; a subtitle under the glitch transition isn't planned. All wait on the bake-off of mark finders.
- **Cuffed & Caught's cleanup**: a new render after the strip-stacking fix was never checked on prod.
- **The two skills that run the agent tell coding agents to write a file per project in `docs/feedback/`** (`.agents/skills/in-app-agent`, `teaching-loop`). If this list is to stay the only one, they should add open items here instead.

## The cloud and storage

- **R2 cleanup, all waiting on Sphe's go** (Nov 11 audit; run it again first: `scripts/r2-audit/list.ts`, `bodies.ts`, `analyze.py`, `report.py`): Repack's and old Writer's prefixes (536 GB), orphans (58 GB), superseded review versions (239 GB), lifecycle rules on the temporary prefixes. The bucket was 1,122 GB, $26 to $34 a month.
- **The footage sweep is off** (accounts repo, `convex/footage.ts` `SWEEP = { clear: false }`); to turn on about Dec 15, once every Mac can bring footage back.
- **Deleting a review link leaves each version's `fullKey`, `preview.key` and `wordsKey` on R2** (accounts repo, `convex/reviewPage.ts` `remove`).
- **The live relay still diarizes with pyannote** (`apps/relay/wrangler.toml` `DIARIZE`); every Mac is past the builds that needed it.
- **V1's watermark dropdown** (`channel_marks.ts` `offerFor`) goes once every channel has its watermark on its page.
- **Lists aren't served from this Mac**: `/api/ideas` asks the relay on every call (`ideas/routes.ts`).
- **No dev review site**: links shared from dev open nothing; Edit only warns (`reviews.ts`).
- **No auth beyond loopback**: any device on the tailnet can drive `/mcp`, `/api/ws` and the changing routes (`http/host.ts` `checkHost` checks Host and Origin only). A per-install bearer would close it.

## For Sphe to decide

- **The bake-off**: Edit against Claude Desktop plus Premiere on the same cases, judged blind. Never run.
- **One record for a script** instead of Writer's script and the project's `script.blocks` (about a week).
- **V2**: a Git mirror of the effects library; a sandboxed shell for the agent against one tool per job; a stage view while the agent makes a graphic; a graphics craft skill.
- **Settings**: Updates › Channel shows a disabled "Stable · Soon" (`AppMenu.tsx`), and Beta › Edit V2 is still a switch (`lib/beta.ts`). Hide them? Update by itself when idle?
- **Akwe Pro Bold's licence** was never verified; its download page said personal use (`crates/edit-render/fonts/AkwePro-Bold.otf`).
- **"COURTROOM WATCH"**: blurring the logo leaves a soft blue patch; a solid patch or a crop (`mark_blurs.ts`).
- **Apple's on-device sound classifier** behind `listen`, to name music, sirens or shouting (about a day). And Apple's first-pass words have no pauses: Scribe in pieces for what Apple hears worst, or a wider `PAD_MS` (`kept_hearing.ts`).
- **Looks from the team's Oct moodboard not built as features** (in V2 the agent can write each as an effect): brand sting, floor-plan reconstruction, who's-where dots, suspect card, focus blur, people as cards, picture in picture, three frames, CCTV grade, paper viewers.

## Wishes, not started

- **Finds in each channel's ideas lane**: watched channels checked daily, a speed score for a video rising fast, Make it or Skip, similar finds grouped, skips teaching the scout. Only the competitor list per channel exists. With it: push an idea to the board at a set time.
- **Speaking to the agents**: a mic button in the chat boxes, transcribed on the machine. Researched Nov 7: try Moonshine (MIT, small, runs on any CPU, words as you speak) against NVIDIA Parakeet TDT 0.6B v3 (Apache 2.0, the accurate one: FluidAudio or parakeet-mlx on a Mac, ONNX on an NVIDIA card; about 1.2 GB, downloaded on first use) with the team's own prompts; names need the project's cast (`people.ts`).
- **Linux: the thumbnail subject cut-out** with BiRefNet (MIT, about 200 MB, downloaded on first use); today it says "Lifting a subject out needs a Mac" (`crates/edit-native/src/media.rs`).
- **A feedback link for ideas and thumbnails**, as an edit has its review link.
- **Thumbnails: frames from YouTube**: give Claude Ideas' `scan_video` and `grab_frames` (`ideas/frames.ts`) on a thumbnail.
- **Parked**: SAM 2.1 mask tracking where the template tracker loses a face (`crates/edit-engine/src/track.rs`).
