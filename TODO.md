# To do

The one list of work that isn't done. On Nov 21 every plan, review, council, feedback log and topic doc in the repo was checked against the code; what was built was deleted, and what wasn't is here. An item is deleted from this file when it's done. The files it came from are in git history (`git log --all -- docs/plans docs/feedback docs/fix-next.md`).

Paths are relative to `app/`. Items are grouped by area, not ordered inside a group; "Do first" is the order, and its items appear again in their groups with the detail.

## Pick up here (left Nov 21, 16:00, when the Linux machine was needed)

Sphe's plan for the nightly: cut it once the V1 kinds are on channels, courtroom and Shorts first (their graphics recreated), commentary's and horror's graphics in the nightly after. Nothing below is a release until he says go. Delete this section as each line is done.

1. **The Mac's pass on main** was run on e7ff7d80 (Nov 21, 17:00): everything it could try in the real window passed or failed only where main already did, but for two things, both fixed since (the Check's type file, 5683d3f0; a short file just imported shown as failed while its upload ended, 9a15c7eb). Not run again on the commits after. Its other findings are under Playback and Exports below.
2. **One player on a Mac** is ready to be judged: branch `one-player-mac` (b38c7f73), with the audit's playback fixes on it (P11a, P11b, P11c, P2, P1). Measured on the MacBook Air against main: Play on a cold open 1.24 s every time (main 1.40 s, sometimes 2.9 s), full screen keeps playing (main froze about 10 s), 0.1 sound dropouts a cut (main 6.8), the page 156 MB after a minute of play (main 393). Worse: Script mode's first picture 1.1 s later, and about 0.2 s more held at a cut. Before main: a pull request so the Check runs, a rebase (conflicts likely in `playback.ts`, `Viewer.tsx`), an hour on a teammate's Mac, and Sphe's call on keeping the page's player as the last resort when the window refuses to open its own. Of the audit's fixes on it, the sound clock's (an engine that stops on an output device change is started again, and a dead speaker replaced) could not be provoked on the MacBook Air's built-in speakers: someone has to plug headphones in mid-play. The cold-open stop (P11c) is proven by its tests only: in the window the gap it needs is 20 to 30 ms.
3. **The four kinds on channels.** Make the placeholder channels Courtroom, Shorts and Horror (names agreed; they're in the one channel list dev and prod share) and use InternetJanitor for commentary; set each one's add-ons (the lists are in `docs/v1-to-v2.md`); move each kind's teaching from `agent/` into its lanes; recreate V1's graphics frame by frame as V2 effects, courtroom's six and Shorts' one or two before the nightly, commentary's 21 and horror's 13 after; carry it to prod.
4. **The lessons inbox**: save the agreed lessons to their lanes (courtroom's and Shorts' once those channels exist), close the 67 already covered, then take the inbox out of the code. The removal is written and proven (V2 agents' tools and instructions byte for byte the same; V1 loses only `note_lesson` and is told nothing is kept for later videos) on the branch `remove-lessons-inbox` (1908d471), not on main: closing the notes needs the `edit lessons` command it removes, so transfer and close first, then merge it. Sphe to say which nightly: after it, V1's agents keep nothing of lasting feedback.
5. **Before tagging**: `bun run mamagi:deploy` in the accounts repo (its `c63c14f`, a channel given is all a person needs; on dev already, the relay's half ships with the tag), a green Check, and the screenshot of player, chat and timeline on a real project Sphe asked for.

## Do first

What can still make an import or an export look frozen, or playback slow to start, on JJ's 8 Mbit/s line and on Macs short of disk.

1. **Prove the nightly on the team's Macs** (hours, no code). Once JJ is on it: read his report and its `[thread]` lines, time a cold open and Play on one of his projects in Edit.app, count wake lines against `pmset -g log` after a real lid close, and write down what failed and why. Nothing else shows the playback complaint is gone.

Also found while checking, not from the old files: every call to the cloud's records waits up to 120 s and is tried three times (`cloud.ts`), so when the relay hangs instead of refusing, work behind `getRecord` holds for up to six minutes. And before a deleted review link clears its `full.mp4` from R2, it must skip one an export's record points at (`exports.ts` `heldByReview`), or that export loses its only cloud copy.

## Imports and Script mode

- **A YouTube import through Script mode says "5% Starting." for the whole download**, about a minute, and an 18-second clip took 49 s, 35 of them fetching captions through the proxy.
- **Originals going up aren't uploads "behind"** (`cloud_media.ts` `runUpload`), so they never give way to a play or an import's downloads, and a Script import has no running row for the upload pacing to see (`cloud.ts` `forPerson`).
- **Room is asked for before the work is known to fit** (`storage.ts` `admit`): an import too big for the disk gives up kept copies and is still refused.
- **Restoring an archived project's excerpts still cuts straight from R2** (`cloud_media.ts` `restoreHere`, `remake`), with the waste the import's cuts no longer have.
- **Two fetch paths where one was planned**: fetch to disk first when there's room, one function with a "room here?" branch. `footageToDisk` and `footageToCloud` are still two (`script.ts`), and `cutsBetterHere` / `wholeHere` and the fallback in `driveExcerpts` remain (`cloud_media.ts`).
- **One bad-day case is a stub**: `resume-download` throws "isn't written yet" (`scripts/bad-day/cases/stubs.ts`).
- **"Go on without" lives in a file on one Mac** (`missing_media.ts`, `footage-gone-without.json`); it was meant to move into the project, which needs a field on edit-core's Media.
- **An unknown failure stops Script mode's import as if it were the person's to fix** (`writer/imports.ts` `known ?? "person"`); shares read only `failure.surely` too (`reviews.ts`).
- **An export waits only on errors known to pass**; room, quota and unrecognised failures still end failed with Retry (`exports.ts`, `failure.surely(...) === "passing"`).
- **A share carried on from an older build loses "Exported as the edit is now"** (`serve.ts`: the share gets `note`, not `said`); no test reads that note.
- **The editor's import stops for a file that's really gone** (Script mode goes on without it). Needs "Use another link" to work on an edit already laid out.
- **Left from the AVI fix**: a big upload doesn't give way to an import's downloads, and an import that keeps failing the same files doesn't lay out the rest.
- **A local-file import with the relay down**: `putHashed` waits for the registry before anything else (`cloud_media.ts` `getRecord`); no bad-day case covers it.
- **The footage dialog can still say "Only 2.0 of the 2.0 GB fits"** when the bytes are down but files aren't all here (`footage_ready.ts`).
- **The relay answers 401 to a token whose `kid` is missing when its re-read of the keys fails** (`apps/relay/src/auth.ts`).
- **Checked true in the Nov 21 code audit, not yet fixed** (each was read against the code by a second reviewer): "Make the edit with their parts black" also blacks files that are only waiting (`script.ts` `askable`); deleting a script doesn't stop its downloads (`writer/imports.ts`); a folder case's master is never stamped after one failed upload or a restart mid-upload (`writer/handoff.ts`); the loopback reader's layout fetch has no time limit (`cloud_media.ts`, add `AbortSignal.timeout(30_000)`); a blocks file says no room after room has come back (`cloud_blocks.ts`); two waiters on one proxy encode, and the loser deletes the winner's proxy (`makeProxy`); a frame rate with no bound (1000/90000) is not refused at import. Not true, so not to be "fixed": the claims of a fetch waiting for good (Bun gives up on a silent connection at 300 s, timed). Left from the fixes of that day: a piece already made whose upload keeps failing still waits only a minute each time (`cloud_media.ts` `makeEveryPiece`'s upload loop); the editor's Drive downloads don't renew a sign-in that runs out (`script.ts` `googleFetch`; Script mode's do now); a Drive import carried on from "importing" whose downloads were deleted meanwhile ends as the person's instead of downloading again (`drive_import.ts`); with no cloud a Drive import removes its own footage once "uploaded" (`finish`: tests only, a Drive import needs the sign-in).
- **Once every Mac has the build with the job table**: delete `wakeWhatPasses` and `carryOnOlder` (`serve.ts`, `script.ts`, `seams.ts`, `writer/missing.ts`), `ChooseRecordings.tsx`, the old going-on-without file's reader and `jobs.ts`'s pre-Nov-8 rows.
- **Stale comments and names**: `import_steps.ts`'s header still describes `RETRY_WAITS` and "every step is bounded", and keeps `whyOf`, `passing`, `QUOTA_RETRY_MS`, `LIMIT_RETRY_MS` as aliases; `cloud_media.ts` "an hour and then a day later"; `remote_control.ts` names `busy.wouldLose`; `cache_cleanup.ts` and `writer/storage.ts` still say "15 GB or a tenth of the disk" (it's a flat 15 GB, `storage.ts`).

## Exports and shares

- **An export sat at "67%" for 58 s while cutting footage, with no words in the page's top bar** (the MacBook Air, Nov 21; a 10:41 edit, 1 min 45 s in all).
- **The export's log never names the encoder** ("native video").
- **Two shares still upload twice**: one that follows a plain export already running, and one of an export archived earlier (the cloud has no copy-in-place).
- **A plain export whose cloud copy is put off isn't protected from the cleaner** (only a share's is, `exports.ts` `beingRead`).
- **Voice-overs made before Nov 21 on a channel project keep the style's voice** until their words change (`voice.ts` `forProject` reuses one made from the same words).
- **A share's review copy isn't uploaded ahead of the share**, and it's still 3 Mbit/s (`reviews.ts`).
- **One encoder lease with priorities** (export > share copy > playback > made ahead > proxies): `encoder.ts` only counts users. Done so far: a person's Export takes the encoder from smooth playback's render.
- **A real export doesn't use fewer encoders while something plays**, and exports made ahead have no byte quota. Whether to keep exports made ahead at all waits on a week's count of how often one is used.
- **A joined export is checked by frame count only** (`crates/edit-engine/src/render.rs` `export_chunked`); its fallback chain (chunked, again, whole native, whole FFmpeg) hides the first cause, and Marc's "joined 33826 frames, not 33786" was never explained.
- **Planning a long edit off the thread needs the addon rebuilt**: `export_plan_async` is written in Rust (`crates/edit-native/src/export.rs`) and `native/index.ts` uses it when the addon has it; until a build carries it the plan is the synchronous call (716 ms for a 2-hour edit), made once a revision.
- **The engine's own waits have no deadlines**: a dead VideoToolbox session or a lost GPU after a lid close can leave a render thread waiting for good. Edit drops such a job after a minute and starts a fresh one; the Rust side should end it itself (`wait()` settling within seconds of `cancel()`, `recv_timeout` in the stage loops, deadlines on AVAssetWriter's finish and cancel).
- **"What's beneath title-card" never renders on Linux** ("When Cops Rescue Boyfriends…", 17 times, once at every start). An 8-frame export fails four ways in two seconds, no frame reaching the encoder; a size the encoders refuse (odd, or under NVENC's smallest) is the first thing to look at, and the engine keeps only FFmpeg's last line, which hides the reason. Not seen on a Mac.
- **Checked true in the Nov 21 code audit, not yet fixed**: a bad cached chunk is reused for three days (`render.rs`: check reused chunks on the second try, put the encoder in the key; half a day); Drive's `curl` has no stall limit (`drive.ts`: `--speed-limit`, and "too slow" among `failure.ts`'s passing errors); the page is told "failed" while the export waits to go again by itself (`exports.ts`); `dropKept` can take an export another is copying chunks from (`filePins`); old progress is carried into an export started within 15 s of a cancel (`export_steps.ts`); four small guards in the Rust mix (a worker's panic spins `render_kept_in`, identical minutes share a `.partial`, workers lack `with_decoders`, a panic in `export_chunked` stops Cancel reaching the mix). Left from the fixes of that day: a share's graphics waits still poll in memory after a Cancel until their 20 minutes are up (`seams.ts`'s waits take no signal); marked stretches' sound and join take no Cancel and their real error is dropped (`ranges.ts`); a second click on Export while it waits for graphics orphans the first wait (`routes.ts` `whenReady`).
- **Idea, needs a trial on JJ's Mac**: hardware and x264 encoding together for exports (about 1.5 to 1.8 times on the video stage when idle), HEVC speed-over-quality for previews and proxies.

## Playback

- **Full screen in Edit.app freezes on "Loading frame…" for about 10 s on main** (the MacBook Air, Nov 21, both passes): the page's own player takes it. Fixed on `one-player-mac`, where the window's player does.
- **Once, entering full screen paused the play** (the MacBook Air, Nov 21; not seen again in two more tries).
- **A second scrub drew two positions late** (356 and 160 ms, both decoding forward across a cut; the rest about 16 ms).
- **Edit.app's player, from the Nov 20 audit**: long videos' sound always streams (seen on the MacBook Air, Nov 21: 20 minutes of sound read over HTTP for four minutes with the file on the Mac); the window's read-ahead is skipped for any file that has excerpts; the sound clock isn't restarted after an output device change or a wake; one failing sound part silences the rest of a play.
- **The first picture from a fresh decoder takes 181 to 378 ms on the MacBook Air** (4 of 5 runs, Nov 21), against the 100 ms mark of `scripts/acceptance.ts --native`.
- **One local proxy by rule, never uploaded** (the local-first plan's step 3, never built). Measured Nov 18 on an M1: a file whose keyframes are at most about 2 s apart plays as the original (jumps 33 to 54 ms); everything else, which is every YouTube download (keyframes 4 to 7 s apart, up to 13.5 s) and long-GOP Drive exports, jumps at 140 to 600 ms under an agent's load. The rule: probe keyframe spacing at import (`ffprobe -skip_frame nokey`); files over 2 s get one proxy at 720p, a keyframe every second, no B-frames, about 1.8 Mbit/s, made at 5 to 17 times real time and kept on the Mac only. Today's proxy is up to 1080p at 4 Mbit/s, made in pieces and uploaded (`proxy_pieces.ts`, `crates/edit-native/src/media.rs`). A 113-minute source is 1.81 GB as the original against 6 to 9 GB of preview copies. Not yet measured: capping a 60 fps source's proxy at 30 fps, phone HEVC and 4K footage, the 2.1 to 2.4 s first seek.
- **One player on a Mac** (Sphe's go, Nov 21; being built and measured on the MacBook Air, branch `one-player-mac`, not on main): in Edit.app only the native player plays and the page's own never starts; the page's stays for the browser and Linux. Both of the Nov 21 playback bugs were in the hand-over between the two. Open before it can land: in Script mode the page draws first at 2.9 s and the window takes over at 15.2 s.
- **One player, and the old layers retired**: full screen still uses the page's player (`apps/web/src/components/Viewer.tsx`), and the page player's smooth render, scrub pieces, stitched stream, block cache and export excerpts are all still here (`playback_render.ts`, `playback_stream.ts`, `scrub.ts`, `cloud_blocks.ts`, `export_excerpts.ts`, `native_preview.ts` `joined/` and `native2/`). They go once playing from files on the Mac is proven on a real Mac.
- **A drag forward in Edit.app is bound by its seek** (20 to 80 ms a position) past the 2 s a reader reads on; a reader kept ahead of a forward drag would hide it (`render.rs` `ReaderPool`, `player.rs` `hint`).
- **The agent's own previews run at normal priority while someone watches** (`render_frame`, `look_at_media`'s decodes); only the effects' Chromes and the looks' FFmpegs are below a play (`playing.ts` `keepBelow`).
- **A cold open on a slow line was never measured in Edit.app or the page** (JJ's took 6 s to 4 min a file); bad-day's `cold-open-play` covers the server's side only.
- **V2: the viewer doesn't measure what it draws.** The Mac viewer should time its own drawing of an effect and play the render where the web view can't keep up; the only cost check is measured in Chrome (`effect_tools.ts`). Also never checked on a Mac: a stacked-alpha render in the native player, and an effect with moving footage.
- **A strip the native reader refuses isn't remembered** ("No native video track"), so it falls back to FFmpeg on every read. Unconfirmed whether it still happens.
- **Checked true in the Nov 21 code audit, not yet fixed** (the page's player; none matter in Edit.app once one player lands): sound ending before its picture gives an error every 4 s for good (`decodeAudio`; first to fix, 30 min); a failed or short smooth chunk is answered 200 and cached for good; the 10 s watchdog ends a worker that is only waiting on a slow read; readiness polling stops on a project switch until the next play; a `<video>` error leaves "playing" frozen until Play is pressed again. In the window: a player thread's panic skips the view's teardown; stale read-ahead opens can evict the reader that's playing; `mix_live`'s FFmpegs aren't ended on cancel.
- **Nobody has listened to 2× speed's sound.**

## The server's thread, start and crashes

- **Still synchronous on the thread**: a file under 32 MiB is read with `fs.readSync` as it uploads (`cloud.ts` `fileSource`); a media's whole transcript is read and parsed at `watch.ts` (megabytes for hours of footage); every render serialises the whole edit to start (`native/index.ts` `ExportStart.project` takes only JSON).
- **A tool call can't be cancelled**: `mcp/registry.ts` `ToolCall` carries no signal, so `review_motion` can't stop its sample when the request goes.
- **As Edit starts it answers nothing for 3 to 8 s** on a home with long edits ("last started: GET /api/projects/{id}/text-removal"). Read the `[thread]` lines of a start.
- **A Nov 4 `.partial` file in `cloud/sound` is never swept**: eviction skips partial files and the other sweep doesn't match that path (`cache_cleanup.ts`).
- **Prod Linux Edit holds about 9.5 GB while blurring two projects**, and the blur's Rust threads take the whole CPU quota; it should cap its own threads.
- **78 of the server's 358 modules can't be the first one imported** (import rings, older than Nov 21: the server's own start order is safe, a test or script that starts elsewhere meets "Cannot access … before initialization"). Two edges were cut on Nov 21 (`semaphore.ts`, `addons.ts`'s `from` hooks); `routes.ts` still takes `Semaphore` through `media.ts`.
- **A crash in the Rust addon takes the whole server down**: it runs inside the server's process.
- **After a hard crash the old `claude` process isn't ended** (`serve.ts` `endLeftovers` ends only children of the same pid), so an orphan can keep calling the new server's `/mcp`.

## Still to prove on real Macs

From the Nov 19 council's list; none can be shown in a harness. A real lid close, with wake lines counted against `pmset -g log`. JJ's real line and 6 GB files. Disks over days, and a nearly full Mac. Being signed out for real with work waiting. The encoder shared by an export and an import. Marc moved from nightly-84 and JJ from 96. The relay's sign-in change live. A weekly count of what failed and why, from every Mac's report (`[thread]` lines included).

## Tests and checks

- **Two tests fail every Linux build**, so a stable release can't pass its Linux check: `apps/server/test/export_ahead.test.ts` (no "chunks … already made" line in the last 400 log lines) and `proxy_pieces.test.ts` (the PSNR compare of piece 1 reports 31 frames, not 30).
- **No release check runs an old client against the new relay.**
- **Errors seen in the team's logs, never diagnosed** (check the R2 logs first; drop any that no longer occur): `censor: analyse … Input/output error`, `media: preview copy … Invalid argument`, YouTube "ffmpeg exited with code 251", VideoToolbox "A pixel buffer cannot be appended".
- **Plans refused for media that "runs out at"** (19 on nightly-58): check whether the agent still hits it (`edit_plan.ts` `runsOut`).

## The in-app agent

- **Making V2 the only mode** has its own file, `docs/v1-to-v2.md`: what of `agent/` is in the channels, what V2 can't do yet, and the order of steps.
- **A channel that turns `court-script` off keeps its courtroom scripts' pages and voice names as courtroom** while their builds go plain (`writer/pages.ts`, `naming.ts` read the stored kind).
- **The end-of-turn check** (`end_check.ts`, the `end-check` add-on) has not run in a real Edit yet: try it once in dev on a channel with it set. Known: the person gets a second "Changes are done" notice after the fix turn (removal's wake does the same); a file that can never be read keeps the line up its full 60 s; findings with no place on the timeline (an intro without captions) are never reported; each audit runs on the server's thread, as every change's does.
- **V1 still compacts its conversation at 180k** (`claude.ts`; V2 uses 1M). Measure first.
- **`repack_subtitles` loses hand fixes on a re-run**: lines deleted and holds lengthened by hand come back (`subtitles.ts`, `captions.ts` `adjusted`).
- **The server says "choose Check Claude"**, a button the page no longer has (`agent.ts` `waitForClaudeLogin`).
- **Text removal, from the Boyfriends edit**: the bottom ARRESTFLIX mark is never found; a short "No" in the 0.80× copy reads as no words; a subtitle under the glitch transition isn't planned. All wait on the bake-off of mark finders.
- **Cuffed & Caught's cleanup**: a new render after the strip-stacking fix was never checked on prod.

## The cloud and storage

- **R2 cleanup, all waiting on Sphe's go** (Nov 11 audit; run it again first: `scripts/r2-audit/list.ts`, `bodies.ts`, `analyze.py`, `report.py`): Repack's and old Writer's prefixes (536 GB), orphans (58 GB), superseded review versions (239 GB), lifecycle rules on the temporary prefixes. The bucket was 1,122 GB, $26 to $34 a month.
- **The footage sweep is off** (accounts repo, `convex/footage.ts` `SWEEP = { clear: false }`); to turn on about Dec 15, once every Mac can bring footage back.
- **Deleting a review link leaves each version's `fullKey`, `preview.key` and `wordsKey` on R2** (accounts repo, `convex/reviewPage.ts` `remove`).
- **The live relay still diarizes with pyannote** (`apps/relay/wrangler.toml` `DIARIZE`); every Mac is past the builds that needed it.

## For Sphe to decide

- **Where `tailscale serve` is on, any device on the tailnet can drive Edit** (`/mcp`, `/api/ws` and the changing routes; `apps/server/src/http/host.ts` `checkHost` checks Host and Origin only). Today that's one machine and every device on the tailnet is Sphe's. A per-install bearer would close it if that changes.
- **The bake-off**: Edit against Claude Desktop plus Premiere on the same cases, judged blind. Never run.
- **One record for a script** instead of Writer's script and the project's `script.blocks` (about a week).
- **V2**: a Git mirror of the effects library; a sandboxed shell for the agent against one tool per job; a stage view while the agent makes a graphic; a graphics craft skill.
- **Settings**: Updates › Channel shows a disabled "Stable · Soon" (`AppMenu.tsx`). Hide it? Update by itself when idle? (The Beta › Edit V2 switch is in `docs/v1-to-v2.md`.)
- **Akwe Pro Bold's licence** was never verified; its download page said personal use (`crates/edit-render/fonts/AkwePro-Bold.otf`).
- **"COURTROOM WATCH"**: blurring the logo leaves a soft blue patch; a solid patch or a crop (`mark_blurs.ts`).
- **Apple's on-device sound classifier** behind `listen`, to name music, sirens or shouting (about a day). And Apple's first-pass words have no pauses: Scribe in pieces for what Apple hears worst, or a wider `PAD_MS` (`kept_hearing.ts`).
- **Looks from the team's Oct moodboard not built as features** (in V2 the agent can write each as an effect): brand sting, floor-plan reconstruction, who's-where dots, suspect card, focus blur, people as cards, picture in picture, three frames, CCTV grade, paper viewers.

## Wishes, not started

- **Finds in each channel's ideas lane**: watched channels checked daily, a speed score for a video rising fast, Make it or Skip, similar finds grouped, skips teaching the scout. Only the competitor list per channel exists. With it: push an idea to the board at a set time.
- **Speaking to the agents**: a mic button in the chat boxes, transcribed on the machine. Researched Nov 7: try Moonshine (MIT, small, runs on any CPU, words as you speak) against NVIDIA Parakeet TDT 0.6B v3 (Apache 2.0, the accurate one: FluidAudio or parakeet-mlx on a Mac, ONNX on an NVIDIA card; about 1.2 GB, downloaded on first use) with the team's own prompts; names need the project's cast (`people.ts`).
- **A feedback link for ideas and thumbnails**, as an edit has its review link.
- **Thumbnails: frames from YouTube**: give Claude Ideas' `scan_video` and `grab_frames` (`ideas/frames.ts`) on a thumbnail.
