# Is Edit fixable as it stands? · Claude Fable 5.1 · Nov 19, 2026

Read only. I changed no code, committed nothing, released nothing, restarted nothing. Evidence: the repo at `0e3dcd9f` and its history; Sphe's own messages streamed out of the 126 Claude Code sessions and 6 Codex sessions on this machine (2,083 messages, Nov 7–19; earlier sessions lived on the Mac and aren't here); the three Macs' latest reports and the problem-report inbox; JJ's shipped log for the last 7 days; the Nov 18 audit and the two earlier council answers. **[seen]** marks something read off the code, a log or a commit; **[inferred]** marks my reasoning from those. The appendix says how to reproduce each number.

## The verdict, for a tired reader

Keep Edit. Don't rewrite the app, the shell, the engine or the agent. Do rewrite the one thing every incident has run through: how Edit runs long work and decides what a failure means. Today imports, exports, uploads, removal and renders each carry their own idea of "transient", "gone", "needs a person", "idle" and "retry", and the biggest job exists twice (Edit's Script import and Script mode's own), so JJ's lost project was not a bug in a file but that design meeting a Wi-Fi drop, and the Nov 19 fix repaired one of the two imports while the other asked JJ the same question the same night and is still looping on a false sign-in today. The other half is process: 16 nightlies in four days, every one tagged "Forced" past your own one-a-day rule, with the team as the only test ring. Two to three weeks of one work spine plus a release ring, with features frozen, would change the next month more than the last 1,700 commits did. A rewrite of the whole app would throw away what works and rebuild the same failures in new code.

## 1. The verdict in full

**1.1 Choice: (b), rewrite specific subsystems, together with the process change of (a).** [inferred from §2–§4]

What gets rewritten, and into what:

- **One work runtime** for every long job (import, export, share upload, archive, download, removal piece, effect render, Drive copy): a durable record, steps that can be run twice without harm, one failure vocabulary (transient · needs a person · out of credit · waiting on a shared resource · gone), one retry schedule, one derived answer to "in work / idle / may sleep / may update / may clean". The pieces exist as fragments: `jobs.ts` (Nov 8), `import_steps.ts`'s `whyOf`, `outages.ts` (Nov 18), `writer/missing.ts`'s own timer, and 20 files with their own retry constants. The rewrite is making them one thing and moving every caller onto it, deleting each module's own copy as it moves.
- **One import.** Edit's Script import (`script.ts`, 3,564 lines) and Script mode's own import (`writer/imports.ts` + `writer/missing.ts`) do the same job under different rules. One goes.
- **The footage path**, as decided Nov 18 (local while in work, cloud as the library), finished by deleting pieced proxies, the stitched stream, blocks and lanes, and the page player on Macs. I'm confirming that decision and ranking it *after* the spine, because downloads and uploads are jobs and will otherwise grow their own retries again.

Not rewritten: Tauri, Bun, the Rust engine and native player, the agent and its tools, channels and lessons, the relay, the review link, remote diagnostics (§5).

**1.2 Confidence.** About 70% that (b) with (a) gets the team to a boring Edit within a month. About 20% that (a) alone would, if the ring and the fault tests were truly enforced. Under 10% that (c) or (d) is right today.

**1.3 What would change my mind.**
- Toward (c), a new architecture: if, after the spine lands and nightlies go through a ring, JJ's shipped log still shows the same classes for two weeks (imports asking a person, work given up after restarts, false sign-ins).
- Toward (d), stop and use something else: a fair bake-off, same footage and brief, Claude Desktop against Edit, blind judging, where Claude Desktop matches the output with less hands-on time. The Nov 16 call settled this by argument, not by measurement [seen: memory note `edit-vs-claude-desktop`].
- Toward (a) alone: a week of fault-injection runs on kenobi or the M4 showing the existing retry and wait code holds once the UI stops offering destructive answers.

**1.4 Where I disagree with your framing.**
- *"Footage in the cloud caused the majority of the issues."* Half right. It explains playback and much of storage. It does not explain JJ's lost project (a Drive download fails the same way on a Wi-Fi drop wherever footage lives), Marc's archive given up for days, false sign-ins, duplicate paid sends, or YouTube refusals. Disks also filled in the local era, Oct 18–21 [seen: `review-fable.md`].
- *"Tauri with a non-native player."* The player on Macs has been native since Nov 6 (`docs/preview.md`). The page player is a fallback. Replacing the shell touches none of the failing parts.
- *"Never going to be stable."* I see no evidence the design can't be stable. I see evidence it can't be stable *at this process*. The failure classes are few (§3) and most incidents map onto them.
- *"No model catches these bugs."* Partly wrong. The Nov 18 council (Fable 5.2, item 3 and "What to delete") named the import's mid-way question as something to remove, hours before it cost JJ a project [seen: `council-fable.md`]. The Nov 18 audit named three definitions of idle and independent retry storms (items 5 and 8). What failed was turning findings into gates, and fixing a class in every copy of it.
- *"Maybe we're too careful."* The shipping is the opposite of careful: 16 forced nightlies in four days. The caution is in the audits' *scope* (code at rest), not in what reaches the team.

## 2. Case study: JJ's Wi-Fi, traced end to end

**2.1 What happened** [seen: JJ's shipped log; `6e1275e3`'s message and diff]

1. Nov 18, Script import "School Bookkeeper", nightly-87. His Wi-Fi dropped. The interview's Drive file failed on `could not reach Edit's relay: The socket connection was closed unexpectedly`.
2. `import_steps.ts` tried again after 1 and 5 minutes (`RETRY_WAITS = [60_000, 5 * 60_000]`). Both tries fell inside the outage.
3. The old rule in `script.ts`: `byItself = whys.every(why => why === "quota" || "encoder" || "limit")`. A "passing" failure past its two tries was therefore **the person's**. The job went to "waiting for the person"; the gate read "Waiting for you: one file couldn't be downloaded · Edit couldn't reach the internet" with two buttons, "I have a replacement" and "Go on without it" (`WaitingFiles.tsx` before the fix).
4. Wi-Fi back, JJ pressed "Go on without it". `skipFootage` ran `blocks.filter(block => !files.includes(block.file))`: the interview's 19 ranges were deleted from the script, the layout ran on what was left, 2:44 of door footage for a 25-minute edit. He deleted the project and started over.

**2.2 Why it was possible.** Four decisions, each reasonable alone:
1. A network error is classified by exhaustion, not by kind: after N tries anything becomes "the person's".
2. The only answers offered for "a file didn't come in" were *replace* or *discard*. There was no *wait*.
3. "Go on without" meant *delete from the script*: a destructive edit of the one thing the import exists to make, with no undo offered (project history keeps a version every 10 minutes, and the person was told nothing of it).
4. The button did not say what it would do.

**2.3 The class.** A transient fault turned into a terminal state, then handed to a person as a choice whose destructive branch is unlabeled. Not a network bug, not an import bug. A missing fault model, plus a UI that asks people to decide things a machine should wait out.

**2.4 How many other places have the same shape** [seen unless marked]

- **Script mode's own import, the same night.** `2026-11-18 18:37:56 WARN [writer] downloading IMG_1496.MOV from Google Drive failed (try 1): The socket connection was closed unexpectedly`, then `18:38:01 WARN [writer] "Perfect" Church Mom … paused after 3569 s … for a choice: 745) Killer Mom … couldn't be imported; the other 2 are ready. Go on without it, try it again, or cancel.` That is `writer/imports.ts` and `writer/missing.ts`, not `script.ts`. `6e1275e3` and `30a17052` touched zero files under `writer/` (`git show --stat`). The fix repaired one of two imports.
- **The same import then looped on a false sign-in.** `19:52:04 ERROR [writer] … video 1 … didn't come through: The sound library and Google Drive need you signed in to Edit.`, then `still didn't come in (try 6 … try 13): … need you signed in to Edit.; next try in 60 min`, every hour through Nov 19 10:21, while his report says he is signed in and admin. Mechanism: `library.ts:236` throws when `relay.token()` is null; `accounts.ts:123` returns null (and starts a renewal) whenever the token is within 30 s of expiring; `writer/missing.ts` retries at 1, 5, 15 minutes and then hourly. An hourly retry that once lands in that 30-second window stays locked to an hourly token for as long as both run **[inferred: the mechanism is in the code and fits the cadence; I did not reproduce it]**. `3eccb6ee` ("no false Sign in to Edit after a Mac sleeps", Nov 18) changed accounts, cloud_projects, reviews, exports and others. Not `library.ts`, not `writer/`.
- **Marc, today** (his report, 11:43Z): project p1794971933004-17806 "cloud error: Sign in to Edit (401)" while signed in; `archive:p1794249007710-7117 … given up: cut short by 3 restarts in a row (unstick starts it again)`, for days; import "Kai Cenat" `waiting (9 of 18 footage files couldn't be downloaded)` since Nov 10 (his agent's report that day: "The import is still working: wait for it to finish first"). Three transients made terminal or made a person's. He is on nightly-84 with Premiere open.
- **JJ, today, nightly-90:** `Needs attention: Script "Mom Of 4 …": its import stopped (Could not read BenjaminCunningham_202401112341_02619-0.)`. `joinPreview` throws for the whole case when one recording can't be probed (`writer/imports.ts:1530`). The Nov 18 council named exactly this; nightly-87's tag says "Script imports finish with what they have".
- **Exports cut short by restarts**, five rounds: `1f177323` (Oct 29), `2f3d00d3` (Nov 3), `9048f83a` (Nov 4), `edc5737e` (Nov 8), `3eccb6ee` (Nov 18).
- **Vmake:** a card not found after an update was a failure, so paid work was sent again (memory `overnight-nov-17-jj-imports`, 22:29; audit item 3). Vmake was deleted today (`d3e14fcd`) rather than fixed.
- **YouTube's bot refusal** taken as permanent across callers, breaking ideas, captions and footage together on Nov 16, until `471b2142`.
- **The cache cleaner** deleting what's in use or sparing what isn't, seven rounds: `636528e5` (Oct 23), `650da222` (Nov 8), `2cdcea1d` (Nov 13), `2f2f93ac` (Nov 15), `331c1723` (Nov 17), `6e2fd4b5` and `0482e10d` (Nov 18).

Modules deciding on their own what a connection failure is: 17 files match the error strings themselves. One shared classifier (`import_steps.passing`) exists and only imports use it. `outages.ts` (Nov 18) knows "relay down" for background pollers only. 20 files define their own retry constants, with at least seven different schedules (1/5 min; 1/5/15 min then hourly; 10 min; 30 min; an hour then a day; 15 s doubling to 5 min; "asking again in 1 s").

## 3. Root causes

**R1. There is no fault model. Every module decides alone what a failure means and what to do next.** Evidence: §2.4; 2,038 catch blocks in `server/src`; 17 home-made network classifiers; 20 retry schedules; three definitions of idle (audit item 5: `serve.ts:477`, `awake.ts`, `busy.ts:24`); a job table that says "given up" for a restart. Pain share **[inferred]**: the largest. Of the team-visible incidents I can list from the reports and transcripts since Nov 7 (imports waiting on a person, stuck exports and archives, false sign-ins, duplicate sends, "given up" jobs, YouTube refusals), about half are this.

**R2. The same job is built more than once, and a fix lands in one copy.** Two Script imports (`script.ts`; `writer/imports.ts` + `missing.ts`); three ways to draw a frame (page engine, native player, export) and five places a picture can come from (`docs/preview.md`); two editors (V1 niche, V2 channel) with their own rules and agents; several ledgers (`jobs.json` as "the one table" since Nov 8, yet `app.scripts.set` writes 22 times in `script.ts`, Writer has its `script.json`, plus `held-work.json`, `writer-imports.json`; 40+ distinct state files named in `src`). The cost on record: the Writer import asking after `6e1275e3` (§2.4); the Nov 11 crossfade shipped in nightly-72 on every cut and re-shipped as 73 (`aa02da20`, `bf2d8659`); "conflicted copy" removed Nov 15 then re-fixed under review (`15f1eb3f`). Pain share: this is why fixes "don't stick". A class fixed in one copy comes back from the other.

**R3. The footage path was built as caches on caches, reversed four times in a month.** Oct 21 cloud on by default → Oct 29 "everything on the cloud" → Nov 2 work back on the Macs → Nov 3 pieced proxies → Nov 6 native player → Nov 16 blocks, three lanes, hedged reads → Nov 18 local-first decided. `cloud_media.ts`: 87 commits in 30 days, 3,311 lines. The window's copies 30× too big filled the M4 three times in one night (nightly-85's reason); 309 "no space left" lines on the M4 in three hours (audit item 1). Pain share: nearly all of playback and storage, two of your three persistent areas. The Nov 18 decision is right; it only sticks if R1 and R2 aren't rebuilt under new names on the way.

**R4. One process, no fault boundary, heavy work on the main thread.** The Rust addon runs inside the Bun server: a SIGABRT in it ended the M4's server on Nov 18 and a SIGSEGV ended Marc's on Nov 11 (crash lists). Cache sizing walks the whole tree synchronously on the request thread (audit item 7); room-making blocked the server about 9 s on kenobi (plan log). 29 `setInterval` pollers in the server. Pain share: the "stuck / hang / froze" class, 252 commit subjects in 30 days.

**R5. The team is the test ring.**
- Tests stand in for everything external: 90 of 243 server test files use mocks or spies; the relay is a local `Bun.serve` in 14; no test mentions two Macs or Wi-Fi; 24 touch a dropped connection, all at the unit level. `acceptance.ts` runs signed out, with no relay, on FFmpeg's synthetic footage. 1,565 server tests and 572 web tests, and none can see the Wi-Fi incident, because it is a composition of a timer, a UI and a layout.
- "Checked:" clauses in 103 commit bodies name unit suites, tsc and oxlint; 5 name a Mac or real footage.
- `docs/dev.md` has a by-hand Mac checklist whose item 6 is "Wi-Fi off mid-upload & mid-save". There is no record it ran before 87. 87's tag: "Forced: … JJ is away and needs them".
- Check on main: Nov 18, 56 runs, 17 green, 11 red, 28 cancelled; Nov 19 so far 19 runs, 5 green, 10 red (`gh run list`). Nov 4–18: 299 runs, 125 green (audit).
- Releases: nightlies 75–90, 16 in four days, every annotation after 75 begins "Forced:". Marc is on 84, the M4 on 85, JJ on 90. Nothing is staged: a nightly reaches whoever updates first.
- The commit stream: 1,726 commits in 30 days, 57 a day, 185 hours with four or more commits, two author identities from parallel agent sessions in one checkout. On Nov 18 that broke main twice: hunks staged at the wrong spot, `exports.ts` not parsing (`3038ff96`, `2388963a`; memory `shared-index-partial-staging`).

Pain share: R5 multiplies R1–R4. It is why the team meets every regression first and why each incident costs a nightly.

**R6. The way work is asked for.** Overnight mandates ("please ensure both edits are done … this is what i want to wake up to", session 0c144bab, Nov 17 19:17); "fix this quick and ship a nightly" (Nov 11, `aa02da20`); "skip the testing, and we just get the nightly out" (Nov 16, memory `after-nightly-76`); five whole-codebase audits in eleven days, each asked before a nightly (sessions 8844f266 Nov 8 17:58, 15952640 Nov 12 16:13, a70b703c Nov 13 17:58, 0e6b1276 Nov 16 04:47, 0c144bab Nov 18 04:18); "It literally has been overnight, and you're still not done" (Nov 19 04:26). The agents did what was asked, and what was asked was speed. The code's own map, `app/AGENTS.md`, was the most-edited file in the repo (208 changes in 30 days) and was deleted today as "bloated" (`d90335e7`). This is not blame. It is a root cause with the same standing as the code, and the cheapest one to change.

## 4. Why the audits miss what the team hits

**4.1 What the audits looked at.** Code at rest and logs after the fact, each asked for "bugs, regressions, issues" with a nightly pending. They answered the question asked: a ranked list of code-path defects, each fixable in a day. The Nov 18 audit is good at that (disk admission, Vmake duplicates, three idles). The Nov 18 council was asked "what would feel smoother" and gave a list of improvements; its best finding (delete the mid-import question) sat at rank 3 under "smoother", not as a release gate.

**4.2 Where the team's failures come from.** Time (an import of 48 recordings over hours), environment (8 Mbit/s Wi-Fi that drops, sleep, a disk at its floor, an update mid-job), concurrency (an agent and a person on one project, two projects' renders, two Macs), and what a person does with the message Edit shows. None of these is visible in a file. All of them are visible in a *run* with faults injected, or in a real user's first hour on a new build.

**4.3 Why a list of ten doesn't help.** Each item is fixed in one place and shipped the same day with ten other changes, forced. The class survives in the other copy (R2) and the next nightly is the next test (R5). The team feels "fixed again, broke again". Your "4 out of 10 significance" is accurate: the method can only see what a file shows.

**4.4 What would have caught the Wi-Fi incident before JJ did.**
1. A fault-injection run of the `dev.md` checklist before 87, on kenobi or the M4: start a Drive import of three files, cut the network for 90 s during the second, restore it, then press every button the UI offers. "Go on without it" deleting 19 ranges shows in two minutes.
2. A rule you can grep for: a button that discards data says what it discards, and the discard is undoable. "Go on without it" failed both. The Nov 18 council's "delete the mid-import question" was the same finding in product words.
3. A property test on `layOut`: the laid-out length equals the ranges' length, cards included; a missing file makes a card, never a shorter edit. The old `skipFootage` fails it.
4. One failure vocabulary enforced by types. `Why` existed; the bug was `byItself` treating "passing" as the person's. The test "a passing failure never becomes the person's" (now in `import_jobs.test.ts`) could have existed on Nov 4 when "Go on without them" was first built (`268f4bc0`).

None of these is deep. All of them require running the product under its real conditions, which no audit did.

## 5. What to keep (the team relies on it; it is the quality and the speed)

- **The agent, its tools and the taught channels** (`agent/`, `edit_tools.ts`, lessons, groups). This is the product. 49 projects on JJ's Mac; two two-hour compilations built overnight Nov 17–18. Nothing off the shelf does this, and the Nov 16 call rested Edit's case on exactly these limbs.
- **The hearing pipeline**: free first words, the agent's cut, Scribe only on what's kept (`b0b2a729`). Measured and cheap.
- **The Rust engine and the native player**: 4,810 of 4,824 frames drawn, draw p99 13 ms, 0 underruns on Cops Realize (`docs/preview.md`); exports in 15–24 s with chunks ready. Finish "one player"; don't touch the engine.
- **Remote diagnostics**: `remote.ts`, logs shipped every 5 minutes, latest reports, crashes, agent-filed problem reports. This review exists because of it. It is the beginning of the release ring.
- **`jobs.ts`'s idea**: one durable table, steps written before they run, resumers that check outputs. Make it the only one.
- **The share and review link** and the Repack review flow.
- **The commit-message culture.** The long incident narratives are the best failure log I have seen in a codebase; §2 was written from them. Keep them; shorten subjects, since `nightly-notes` reads the first clause.
- **The storage ledger and floor** shipped in 86 (`6e2fd4b5`): the right shape.

## 6. The plan

Principle: production never stops. The team stays on 90, then 91 with the Phase 0 fixes, for the duration. Nothing new on screen until the spine lands. Days are agent-days at this team's pace with **one** stream of work on main, not six.

**Phase 0 · stop the bleeding (2 days, first)**
1. A release ring: a nightly installs on the M4 (or kenobi) and runs a real import, a real open, a real export and a Wi-Fi-off minute before any teammate's Edit sees it. "Forced" leaves the vocabulary; the one-a-day rule is enforced by the script, not by memory.
2. One stream on main: parallel sessions work in worktrees and land by PR; no two sessions commit from one checkout.
3. The live twin of the Wi-Fi bug: `writer/missing.ts` never asks for a dropped socket; `library.ts` waits for a renewal instead of throwing; `joinPreview` drops an unreadable recording with a note instead of stopping the case. Ship as 91, through the ring.
4. Delete every mid-job question whose answers are "replace or discard": the import's choice, "Go on without", Retry for what Edit can retry itself.

**Phase 1 · the work spine (6–10 days)**
- One module owns the job record (`jobs.ts`), the failure vocabulary (`whyOf` generalised and typed, no error-string matching outside it), the retry schedule, the "needs a person" gate (only for gone / needs sign-in / credit with no admin), and the derived truths "in work", "may sleep", "may update", "may clean".
- Port in this order: Script mode's import (it becomes Edit's import), exports and the share pipeline, uploads and downloads (`cloud.ts`, `writer/cloud.ts`), removal pieces, effect renders. Delete each module's own retry, idle and state as it moves.
- A fault-injection suite run by a script on a Mac: network off 90 s during each job kind; sleep 10 minutes; kill -9 mid-step; disk at the floor; update mid-job; two projects at once. Gate: no job lost, no duplicate paid send, no person asked for a transient, every job listed once after a restart.
- Measured on JJ's Mac through the shipped log rather than kenobi (your Nov 18 17:14 call: "the Kenobi test can just be you monitoring JJ's Mac").

**Phase 2 · local-first media, as decided (1–2 weeks, under way)**
- Step 3 of `plan.md`, with downloads and uploads as spine jobs. Then delete pieced proxies, the stitched stream, blocks and lanes, native2 copies, the page player on Macs. Measure first play, 20 distant jumps, scrub and an export with a cold cache on an 8 GB M1 and on JJ's line.

**Phase 3 · one truth for scripts and projects (about a week)**
- Writer's script and the project's `script.blocks` become one record. Home and the lists answer from disk and refresh behind (council-fable item 8). The lock lease and sync loop stay.

**What "stable" is measured by**, weekly, from the shipped logs and reports, posted to the team:

| Measure | Now [seen] | Stable |
|---|---|---|
| Script imports that finish without a person | JJ: two of the imports in his last 7 days needed him (one asked, one stopped); Marc: one waiting 9 days | all, unless a file is truly gone |
| Work lost to a restart, update or sleep | Marc's archive "given up"; five rounds of export fixes | none |
| WARN+ERROR lines per Mac-day | JJ about 860 (3,440 in four days, audit) | under 100 |
| Nightlies a week, and forced | 16 in four days, 16 forced | at most 5, none forced |
| Check green on main | Nov 18: 17 of 56 runs | over 90% |
| Team-visible incidents a week (reports, and Discord relayed by Sphe) | more than 10 in Nov 16–19 (transcripts) | at most 1 |
| "No space left" on a team Mac | 309 lines on the M4 in three hours | none |

**Size, honestly.** Phases 0 and 1 are two weeks of one focused stream, three if the fault suite is built properly. Phase 2 is the plan's own one to two weeks. Features stop meanwhile; that is the cost. The alternative is the last month: a nightly per incident, and the team's trust.

## 7. What to cut

- **The second import** (`writer/imports.ts`'s own download, retry and question path) once the spine's import serves Script mode.
- **Mid-job questions**: "Go on without it", "I have a replacement", Retry for what Edit can retry, the import's "choice". Edit waits, tells, and goes on with cards.
- **The page player on Macs**, the smooth-render path, scrub pieces, the block cache, pieced proxies, the stitched loopback stream (`TODO.md` lists them). Linux keeps a minimal viewer for development.
- **Export-ahead** until storage is boring, or only on settled edits with a byte cap (partly done, `f663f77a`).
- **V1 and V2 as two editors.** One editor; a channel without teaching gets the house lessons. Two rule sets for the agent is R2 in product form.
- **The Updates channel UI and the Update button**: update when idle, through the ring.
- **Settings that encode a decision the code should make**: the Beta switch, the watermark choice on a V1 share.
- **Kenobi as the canary**, for a one-day soak on the M4 plus JJ's log.
- **Features during the spine.** Nothing new on screen for two weeks, including "and more".
- **Whole-codebase audits before a nightly.** Replace them with the fault-injection run and the 300-word team note `nightly-report` already writes.
- **Parallel agent streams on main.** One at a time on main; the others in worktrees.
- **Vmake**: already gone today. Don't bring a paid outside step back without a durable job record under it.

## Appendix · how I got the numbers

All from `/home/spheg/Documents/code/edit` on `0e3dcd9f`, Nov 19, 13:50–14:40 SAST. Nothing heavy ran; transcripts were streamed with `jq` under `systemd-run --scope -p MemoryMax=3G`.

- Commits: `git log --since=30.days --format='%h %ad %s' --date=short | wc -l` → 1,732; all: 2,188; first `42c45393` Jul 17.
- Churn: `git log --since=30.days --name-only --format= | sort | uniq -c | sort -rn | head -60` → `app/AGENTS.md` 208, `Home.tsx` 151, `edit_tools.ts` 125, `routes.ts` 110, `reviews.ts` 105, `seams.ts` 94, `cloud_media.ts` 87, `agent.ts` 80, `serve.ts` 77.
- Sizes: `git log --since=30.days --format='%h' --shortstat` → median 63 lines a commit, mean 259; 209 commits of 500+ lines; 263 touching 10+ files; 288 touching server and web; 93 touching server, web and crates or relay.
- Subject words (30 days): "again" 395, "never" 335, "still" 241, stuck/hang/froze 252, network words 171, "restart" 87; 27 subjects reverting or putting back; 25 subjects fixing CI.
- Lines changed: src 305,891, test 81,194, docs 48,249 (`--numstat`). The three named areas (import, cloud footage and playback, storage, export) by filename: 65,273 of 294,511 src lines, 22%, a conservative match.
- Code: `server/src` 275 files, 107,552 lines; `script.ts` 3,564, `cloud_media.ts` 3,311, `edit_tools.ts` 3,217. 2,038 `catch`; 29 `setInterval`; 17 files matching connection-error strings (`socket connection was closed|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|ETIMEDOUT|could not reach|isOffline`); 20 files defining `RETRY|RETRIES|BACKOFF|TRIES|ATTEMPTS` constants; 40+ distinct `*.json` state names.
- Tests: 243 server test files, 1,565 `test(`/`it(`; 91 web test files; 90 server test files with mock/spy; 14 with `Bun.serve`; 0 with "two Macs" or "Wi-Fi"; `acceptance.ts` header for what it checks.
- "Checked:" clauses: 103 bodies; 5 naming kenobi, M4, a Mac, real footage or prod.
- Tags: `git tag -n3 nightly-7[5-9] nightly-8? nightly-90`: 16 tags Nov 16–19, each annotated "Forced: …".
- CI: `gh run list --workflow=check.yml --limit 100 --json conclusion,createdAt`, grouped by day.
- Transcripts: `~/.claude/projects/-home-spheg-Documents-code-edit/*.jsonl`, `type=="user"` text entries only → 2,083 messages Nov 7–19; quotes cited by session prefix and timestamp. Codex: 6 sessions; the one started 13:50 today is another reviewer's and was not read.
- Macs (read-only): `bun apps/server/scripts/remote.ts devices | reports 14 | latest <mac> | crashes <mac> days=14 | logs mathiass-macbook-pro since=7d grep=…`. JJ's log is kept at `/tmp/edit-remote/mathiass-macbook-pro-log-1795089482848.log`.
- Case study: `git show 6e1275e3 -- app/apps/server/src/script.ts app/apps/server/src/import_steps.ts app/apps/web/src/components/WaitingFiles.tsx`; `git show --stat 6e1275e3 30a17052 | grep writer/` → 0; `writer/missing.ts` DELAYS_MS and HOURLY_MS; `library.ts:236`; `accounts.ts:123–130`; `writer/imports.ts:1530`.
