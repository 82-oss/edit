# Honest council · Claude Fable 5.2 · Nov 19, 2026

Read only. I changed no code, committed nothing, released nothing, restarted nothing, and ran no tests or builds.

What I read: the git history, the code on main at `0e3dcd9f`, this machine's Claude transcripts (Nov 7 to 19; there are none here from before the Linux machine), the agents' memory notes, and JJ's and Marc's shipped logs and latest reports. **(seen)** means I read it today and say where. **(inferred)** means it is my conclusion from what I read.

## The verdict

**Keep Edit. Don't rewrite all of it. Freeze it for three weeks.** Edit isn't unstable because of what it's built on. It's unstable because it has never held still: no core file has gone more than five days without a change, the team was sent 89 builds in 30 days, and nothing between a commit and JJ's Mac ever runs Edit the way JJ does (hours of real footage, a slow line that drops, an update in the middle of a job). Two parts should be replaced, mostly by deleting what's there: footage read through the cloud, and the dozens of separate rules for work that fails or is cut short. If three frozen weeks with a real gate don't bring the team's breakages down to about one a week, stop building the editor and keep only Script mode and the agent's skills.

## 1. The verdict in full

**Option (b), and it only works with (a).** Confidence: about 80% that a ground-up rewrite (c) would not make Edit stable, and about 65% that the plan in section 6 reaches its bar in four weeks. On (d) I can't give a number, because code can't answer it (claim 3).

**1. Edit has already been rewritten, over and over. (seen)**
- The server went from Rust to Bun and TypeScript in two days: 126 commits on Oct 17, shipped on Oct 18 in `9e938507` (46,724 lines removed).
- Script mode was a separate app, brought in whole on Oct 29 (`7ca0ea86`, 20,243 lines added, steps 1 to 4 the same day).
- Playback has had four designs in a month (memory note `audit-nov-2026`). Three are still in the code side by side: the page's own decoder (`web/src/lib/playback.ts`, 2,560 lines), smooth renders (`playback_render.ts`) and the native player (`player.rs`, 1,609 lines). Script mode has its own player code as well (three files, 1,582 lines, under `web/src/writer/`).
- Built, then removed: Modal (62 commits, Oct 19 to Nov 3), Bodycam HQ (53 commits, Nov 10 to 14), V2's niches (Nov 13 to 14), Vmake (30 commits, Nov 17 to 19; `d3e14fcd` removed 6,863 lines).
- Footage went cloud-first in October and local-first on Nov 18.

**2. So another rewrite, run the same way, would give the same result. (inferred)** The question "are we too careful to say rewrite?" has it backwards. Rewriting is what Edit does every week. What it has never done is stand still while people use it.

**3. Edit is worth something to the person who uses it most, and I can't tell you whether it beats the alternative. (seen, then a gap)** JJ's latest report lists 56 edits made since Oct 26, about 50 different videos, and 123 scripts. From Nov 16 to 19 his log shows 14 script builds, 70 script revisions and at least 813 agent tool calls. Against that, Marc's Mac had Premiere open and Edit untouched for 16 hours (his latest report), and on Nov 16 the team asked whether Claude Desktop alone would do. The bake-off suggested that day (memory note `edit-vs-claude-desktop`) has no record of being run. It should be run: it is the only evidence that can settle (d).

**What would change my mind**
- Toward (d): the same three real cases are made in Edit and in Claude Desktop plus Premiere, and Edit doesn't win on hands-on time at equal quality.
- Toward (c): the three weeks pass, the gate in section 6 is green, and the team still loses work every week.
- On the order of the causes: the "socket connection was closed unexpectedly" errors turn out to be Edit reusing dead connections, not the line. Marc gets them too. One day of logging would tell.

**Where I disagree with how the question was put**
- *"Nearing two months."* The first build reached the team on Oct 21, 29 days ago. The server is 32 days old, Script mode inside Edit is 21 and V2 is nine. None of it has had a quiet week.
- *"Bugs no model catches."* Several were caught and then treated as items on a list (claims 15 to 18).
- *"The project was lost."* JJ's script was never at risk. What he lost was three hours and his trust (claim 4).

## 2. The Wi-Fi incident, end to end

**4. What happened, from JJ's own log (his clock, Nov 18, nightly-87). (seen)**

| Time | Log |
|---|---|
| 21:05:07 | The editor's import starts: "getting 2 footage files ready (from the cloud)" |
| 21:05 to 21:56 | The relay or R2 is "unreachable" 11 times |
| 21:28:09 | The door footage is ready, after 23 min 02 s |
| 21:30:54 | The interview fails after 25 min 46 s: "Finding the excerpt's keyframe took more than 2 min and was stopped". Tried again in 1 min |
| 21:34:58 | The same failure. Tried again in 5 min |
| 21:58:16 | It fails on "could not reach Edit's relay: The socket connection was closed unexpectedly". Then: "waiting for the person: 1 of 2 files couldn't be downloaded (53 min 09 s)" |
| 22:01:29 | The import carries on with one file. JJ has pressed "Go on without it" |
| 22:05:24 | "deleted from the cloud". JJ has deleted the 2:44 edit |
| 22:06:09 | He starts again. The interview fails twice more: a cut that "can't be read back", then the relay |
| 00:01:47 | "import done" |

That is three hours to bring two recordings into an edit. The next day, at his request, V2 was switched off on his Mac (memory note `nightly-check-is-jjs-mac`).

**5. It was only partly Wi-Fi. (seen)** The interview's first two failures were Edit's own two-minute limit on finding a keyframe in a long file read over the network. `6e1275e3`, the fix, tells the story as a dropped connection and doesn't mention them. They were fixed in `30a17052` only after the same limit stopped JJ again on nightly-89, on another video. The fix was written from the last line of the log, not from the whole of it.

**6. Why it was possible: four things, each working as written. (seen)**
- **Footage goes through the cloud.** `script.ts` `footageToCloud` streams the file to R2, "never to this disk", then cuts its excerpts from R2. On JJ's line that is 23 to 26 minutes a file, with the relay in the path the whole time.
- **Trouble that passes was handed to a person.** `import_steps.ts` named all three failures "passing", correctly. The rule for "passing" was two tries (`RETRY_WAITS`, 1 and 5 minutes), then ask. That design dates from `d2bca5aa` (Oct 28): "Edit tries it again by itself first, then asks".
- **The answer offered destroyed work.** "Go on without it" took the file's 19 ranges out of the script (`skipFootage`, the line `6e1275e3` removes). Nothing could bring them back, and nothing said what the button would do.
- **The same rule lives in two places.** Sphe's Nov 18 rule, "an import never stops or asks a question because of one file", went into Script mode's import that evening (`writer/missing.ts`, in nightly-87). The editor's import is a separate one in `script.ts`, and it kept the old rule. JJ hit it on that build within hours.

**7. The class: something temporary gets written down as a fact, or handed to a person as a decision. (inferred; each case seen)**
- A full disk: blank stills were pushed to the cloud for a team project (memory note `prod-checks-take-the-lock`, Nov 17).
- YouTube refusing a Mac: ten of JJ's ideas were "skipped: YouTube has no English captions" (`a41d04d7`).
- A blip while fetching channels: an edit was made with no channel, and no channel could take it afterwards (`9f4c76b6`).
- A sign-in being renewed: "Sign in to Edit (401)" was kept as a project's error. It's on Marc's Mac now: he is on nightly-84, and the fix shipped in 87.
- Three restarts: a job is "given up". Marc's archive still is.
- A slow Vmake job: abandoned and paid for again (session `11180ec8`, Nov 17 16:05).
- A paused import synced to another Mac: that Mac carried it on (`a0e76d76`; Sphe's Linux Edit took two of JJ's).
- A project opened on a new Mac: everything was rendered again and pushed (the same memory note).

**8. How many more places have the shape. (seen)**
- Six separate "go on without" paths: `script.ts`, `writer/missing.ts`, `writer/imports.ts`, `missing_media.ts`, `archive.ts`, `posts.ts`.
- About 40 separately named retry and wait constants across some 30 files.
- Eighteen kinds of job, each with its own way of starting again (`serve.ts` `resumeJobs`), and beside them Script mode's retries on timers held in memory (`writer/missing.ts` `due`).

## 3. Root causes

**9. Edit never holds still. About a quarter of the pain. (seen; the share is my estimate)** There were 1,732 commits in 30 days. In the 11 days since the Nov 8 audit told Sphe to stop adding beside what's there, the server grew from 104,675 lines to 141,097, with 80 files added and 9 deleted. The twelve core files I checked each changed on 13 to 28 of the last 31 days. The code that worked last week is not the code running this week.

**10. The team is the test. This breaks nothing by itself, but it decides who finds out. (seen)**
- There are 89 nightly tags between Oct 21 and Nov 19 (`git tag`). The one-a-day rule was added on Nov 8 (`7663d407`). Of the 19 builds from nightly-72 on, 18 were forced past it. JJ's Mac ran 13 different builds in 9 days.
- The check before a release runs signed out, with no relay, on FFmpeg's test patterns, and plays for three seconds (the header of `app/scripts/acceptance.ts`).
- The test Mac before each release was dropped on Nov 18: "watch JJ's Mac after each release" (memory note `nightly-check-is-jjs-mac`).
- Check passed on 85 of its last 200 runs; 53 failed and 62 were cancelled (`gh run list`, today).
- `2388963a` is titled "exports.ts parses again" and carries 24 files, among them both new missing-footage features. It landed 33 minutes before nightly-87 was tagged.

**11. Every step of the day crosses a slow line that fails. About 30%. (seen; share estimated)** From Nov 16 to 19, 14%, 7%, 19% and 23% of the minutes JJ's Edit was active had a network failure in them, in 13 to 18 different hours each day. Of his 11,063 warnings and errors, 6,742 come from the cloud code. The lock on his own project failed to renew 119 times. Playback, imports, share waits, false sign-in errors and lock trouble all come from here. The Nov 18 plan to keep footage on the Mac is right. So far it is being added for new channel projects beside the cloud path, not in place of it.

**12. Long work has many owners, inside one process that every update restarts. About 20%. (seen; share estimated)** There is a job table (`jobs.ts`), and it is good. Beside it, the editor's import keeps its own state, Script mode has its own jobs and timers, and removal and effect renders are in no table at all (`jobs.ts` has no kind for them; yesterday's audit, finding 5). The one server process holds about 565 module-level maps, sets and variables, 184 timers, and 123 differently named JSON files of state and cache. JJ's Mac started Edit 21 times in 9 days. Sooner or later an update cuts every hour-long job, and each kind picks itself up by its own rules.

**13. Trouble is recorded as fact. Few cases, but most of the big ones. (inferred from claim 7)**

**14. How work reaches the agents. This is why the others keep growing back. (seen)**
- A screenshot becomes a prompt, and the prompt becomes the narrowest fix. Sphe, Nov 8: "maybe 80% of the fixes, or maybe even 95% of the fixes that have come through over the past month, have been the result of the team members sending me screenshots of things breaking" (session `8844f266`, 18:36).
- Several sessions commit to main from one checkout. `3038ff96` and `2388963a` repair lines that landed in the wrong place.
- Nothing says what must always hold. `AGENTS.md` has principles and no rules of that kind. `app/AGENTS.md` had grown to 181 KB and was deleted this morning (`d90335e7`).
- The Nov 8 audit said all of this ("Adding beside instead of replacing… Fixing from the symptom… No invariants written down… No acceptance before shipping"), and Sphe agreed. Edit V2 started two days later (`46ac98ee`).

## 4. Why the audits miss what the team hits

**15. They read code, and the failures aren't in the code. (seen, then inferred)** Each audit read files and diffs by area: six reviewers over 81 commits on Nov 13; 158 commits and then five audits by area on Nov 16; twelve findings with hours beside each on Nov 18. The incident in section 2 needed a 2.5-hour recording, a slow line, a two-minute limit, a dropping connection, a two-try rule and a button, all at once. No file holds that. Each piece is correct by its own comment, and every test passes. A reviewer asked "is there a bug in this code?" answers with what one file can show, and that is the four out of ten.

| | The checks before a release | JJ's day |
|---|---|---|
| Footage | FFmpeg test patterns, seconds long | 2.5-hour recordings, files of 6 GB |
| Network | none: signed out, no relay | 8 Mbit/s up, failing in 7 to 23% of active minutes |
| One job | seconds | 25 minutes to 3 hours |
| Restarts under it | none | 21 starts in 9 days |

**16. The tests replay the last incident. (seen)** There are 1,566 server tests, and 61% of the commits that touch source touch a test. The test added for JJ's incident hands the import an error with his log's exact words, through a stand-in for the cloud, and checks that it now waits. It proves the fix. It could not have found the failure.

**17. Findings are fixed as instances. (seen)** The Nov 18 council answer from this same model (`council-fable.md`, item 3) saw imports that stop and ask. It read that as a wait to remove and never asked what the button does. The fix went into one import of two.

**18. Edit already reports failures that nobody reads. (seen)** `certificate verify failed` is in JJ's log from Nov 11. The in-app agent filed it as a problem on Nov 13 and twice on Nov 16. It was fixed on Nov 17 (`710a7068`), after Sphe's own M4 hit it.

**19. What would have caught it before JJ. (inferred)**
- **A bad-day run.** One real Mac on a line held to 8 Mbit/s that drops for a minute now and then, three of JJ's own cases, and the whole daily path with one sleep and one update in the middle. It passes when the edit matches the one made on a good line and no question was asked. The interview would have failed on its first try, with no Wi-Fi drop needed.
- **A census of questions.** List every place Edit asks a person something after a failure. For each, ask whether trouble that passes can lead here, and whether any answer deletes anything. "Go on without it" fails both in five minutes of reading.
- **A sweep for the class.** Before an incident is closed, find every other place with its shape.
- **A daily read** of the team's logs and the agent's own reports.

## 5. What to keep
- **Script mode.** It is most of what JJ does.
- **The agent's tools, skills and lessons** (127 tools, and 71 files of instructions and skills under `agent/`). This is the part Claude Desktop alone doesn't have.
- **The Rust engine and the native player.** It can play cleanly on JJ's Mac: "991 frames shown, 0 passed over, the longest 28 ms" (his log). The bad plays beside that one are what step 4 is for (inferred).
- **The diagnostics:** plain-English logs sent every five minutes, each Mac's report, and the agent's own problem reports. Every number here came from them.
- **The job table,** and the way `import_steps.ts` sorts a failure into four kinds. They are the start of what section 6 asks for.
- **A test with every fix, and commit messages that tell the incident.**

## 6. The plan

Three weeks with no new features. The team stays on one pinned build (JJ's, with Marc moved onto it) and gets only fixes for lost work. Everything else goes to Sphe's Macs first, then to the team once a week.

| Step | What | Days |
|---|---|---|
| 1 | The bad-day run from claim 19, as the gate for every build the team gets | 2 to 3 |
| 2 | The census of questions. Every answer that's left keeps the work, and trouble that passes never asks | 1 to 2 |
| 3 | One rule for failure and one job table for all long work: both imports, exports, uploads, shares, removal and effect renders. The 40 constants go. An update waits until nothing is running | 5 to 6 |
| 4 | Footage on the Mac for every project in work; the cloud is the backup and the way to another Mac. Script mode hands the editor files, not cloud addresses. Then delete smooth renders, the block cache, scrub pieces and Script mode's own player code | 6 to 8, on the Mac |
| 5 | In `AGENTS.md`, a short list of rules that must always hold. One branch per agent task, merged only on a green Check. The daily read | 1 to 2 |

Steps 1 and 2 come first because they are cheap and they stop the worst kind of incident. Step 4 is the riskiest and goes through the gate in pieces.

**Stable is measured weekly, from logs Edit already sends:**
- imports, exports and shares that finish with no person and no remote fix: 95%, then 99%
- questions asked because of trouble that passes: 0
- work done again by hand: 0
- jobs given up, or stuck for over an hour: 0
- builds the team receives: 1
- breakages the team reports: at most 1

I don't have today's number for the first of these. Counting it is the first job.

## 7. What I'd cut
- **Playback through the cloud,** once step 4 lands. `TODO.md` already lists the files.
- **V1 and V2 side by side.** One is the team's and the other is a lab on Sphe's Macs. JJ went back to V1 today, so for now the team's is V1.
- **The live lock between Macs.** One Mac owns a project and hands it over on purpose. Sphe, Nov 16: "it's been one person doing them". The cross-Mac incidents I found (claim 7) all began on Sphe's own test machines.
- **Work done ahead on a guess,** until it's measured to save time on the pinned build. On Nov 17 nine exports made ahead cost 80 minutes of encoding and saved none (`council-fable.md`, item 1), and JJ's Mac held 31.6 GB of export chunks (memory note `nightly-88-plan`).
- **Anything that only runs on Sphe's machines,** as a team feature: the subtitle removal that needs a Linux machine (`cf6dbde6`), and Sphe's Linux Edit acting on the team's projects.
- **Forced builds.** A rule overridden 18 times in 19 isn't a rule.

## 8. What I didn't check
I ran nothing. I read three days of JJ's log closely and Marc's only in summary. I didn't pull the M4's log, the Mac's own Claude sessions, the Codex sessions or the team's Discord. The shares in section 3 are estimates. I read about fifteen source files, in full or in part, out of 362 in the server.
