# The final audit: what to change, in order · Claude Fable 5.2 · Nov 19, 2026

Read only. I changed no code, committed nothing, released nothing, restarted nothing and touched no running server. I read the brief, the five answers and my two, the code at `7b59f4e2`, and the copies of JJ's and Marc's logs already on this machine. I ran a few small probes to learn what this machine allows for the tests (section 3). They wrote only to my scratch folder, which I emptied. To count lines I made one temporary copy of JJ's log under `~/.cache`, and deleted it.

**(seen)** means I read it today, and where. **(inferred)** means it's my conclusion. Times from JJ's log are on his clock.

The order of work is Sphe's: this audit, then the main agent makes every change, then the quick tests, then I check the work, then Sphe, only when real Macs are the one way forward.

## 1. What I'd add or change in my own audit

**What the others saw that I missed**
- **Fable 5.1:** the false sign-in loop on JJ's Mac, and where it comes from (`accounts.ts:123`, `library.ts:236`). I can add the cause. It isn't chance. Each hourly try lands in the same second as the sign-in's renewal, because both wake together when his Mac wakes: renewal 09:18:40.3 and try 12 at 09:18:41.2; renewal 10:21:10.9 and try 13 at 10:21:11.0 **(seen, his log)**. The try asks for the token without waiting, gets none, and fails. A frozen process shows this in a minute (change 2).
- **Astra:** "Go on without it" still has a side door (a file given by name), and the agent's tool still says the ranges "left the script". Also: an export a restart cut short is made from today's edit when its kept timeline can't be read, and says nothing (`serve.ts:594`) **(seen)**.
- **Gemini and Muse:** one unreadable recording stops a whole Script import and hides why (`writer/imports.ts:1530`). Missing footage has three copies of one rule, with three ways of remembering it.
- **Nobody named this:** Edit has two readers of "what does this failure mean", and they disagree on anything they don't know. `service.kindOf` calls it "later", so Script mode stops and waits for a person. `import_steps.whyOf` calls it "passing", so the editor's import waits by itself **(seen: `effect/service.ts:81`, `import_steps.ts:136`)**. That is why the same dropped line stops one import and not the other.

**What I got wrong**
- **"The third limit."** It isn't a limit to raise. In JJ's log, ten tries of a file were stopped by one of Edit's own time limits in two days. Five were the keyframe search, on the night of Nov 18. Five were the cut, all on "Genius" Killer's first file, between 11:09 and 13:25 today, each after 15 to 18 minutes. Each stop throws the bytes away and starts from nothing: about 85 minutes of his line today. On nightly-90 the fallback then says "There isn't room on this Mac for … (5.5 GB)". So that file goes round and can't finish **(seen)**.
- **Removal and effect renders in the job table.** Not now. They are made again from the edit whenever it rests, they are in none of the incidents here, and another session has 19 uncommitted removal files in this checkout. They join only the one answer to "what is running" (change 7i).
- **"A short run on small files proves nothing."** Too strong. Edit's limits are sums of seconds and bytes. A small file on a line slowed to match trips the same rule in a minute. What a small run can't show is section 4.
- **Exports made ahead.** I said cut them. Today I can't show it either way: JJ's log has 47 starts and 21 finishes, and no share on nightly-90 to count reuse from. It stays, and gets counted on a Mac.

**Where I think the others are wrong**
- **Gemini: SQLite for all state, worker processes, Ideas and Thumbnails split out.** No incident in the team's logs comes from a torn file or from two Edits on one folder: "another Edit is using" appears 0 times in JJ's 535 log pieces and Marc's 138 **(seen)**. It's a second rewrite on top of this one. Not now.
- **Muse: "a blink becomes can't save".** The code allows the save and queues it when the relay can't be reached (`cloud_projects.ts` `mayWrite`: "Unreachable, it's allowed and queued") **(seen)**. Their "offline-first authority" step isn't needed for what the team hit.
- **Astra: rewrite the Script handoff and layout around new IDs.** The handoff failed on one rule (skip deleted ranges). That rule is gone, and change 4 shuts the side door. The layout is in no incident.
- **Fable 5.1: "one import goes".** The two imports do different jobs. One hears and joins a case for writing. The other cuts a written script's ranges. What must be one is what they share: how a source is fetched, what a failure means, and where the work is written down (changes 6, 7, 8).

**One sentence on releases, because it's essential:** none of this reaches the team until its quick test has passed here and the Mac runs in section 4 are done; and Marc's Mac is on nightly-84, where the archive "given up" is already fixed by a build it doesn't have (`jobs.ts:427` wakes it at start), and the import waiting since Nov 10 may be too (I didn't check why its nine files failed).

## 2. The changes, in the order to make them

**Rules for the work**
- For each change, write its quick test first and watch it fail on today's code. Then change the code. It's done when that same test passes. Nothing is called fixed before that.
- Commit only your own files (`git commit -o -- <paths>`). Another session's 19 removal files are uncommitted in this checkout. None of the changes below touches them. Leave them alone.
- Where a change replaces a rule, the old rule is deleted in the same commit. Nothing is left running beside its replacement.
- Run the unit suites you touch one file at a time, under the same memory cap as the bad-day run (section 3). One heavy thing at a time on this machine.
- Don't touch the dev server, prod Edit on :7790, `~/.edit-prod`, or the live relay. Change 2d is the only one that needs the relay, and it waits for Sphe.

### Change 1 · The bad-day tests exist, and the first ones fail
**Felt today:** every failure in this list was found by JJ or Marc, never by a machine.
**The change:** build the harness in section 3 with the cases for changes 2, 3 and 5. They must fail on today's code: that proves they can see the failure. Each later change adds its own case.
**Quick test:** `just bad-day` runs, stays under its memory cap, and reports those cases as failing for the reasons written below.

### Change 2 · Signed in means signed in (patch, five places)
**Felt today:** JJ's Script import tried one recording 13 times, hourly, from 19:52 on Nov 18 to 10:21 on Nov 19, each time "The sound library and Google Drive need you signed in to Edit", while he was signed in. Marc has a project stuck on "Sign in to Edit (401)". JJ's export made ahead (01:28) and his Genius Killer file (13:07:46) hit the same thing **(seen)**.
**The change**
- **2a.** `accounts.ts` `accessToken()`: give the token until it has really run out. Ask for a renewal when it's within 30 s, but don't return null for those 30 s. The relay already allows 60 s (`relay/src/auth.ts` `SKEW_SECONDS`).
- **2b.** `relay.ts`: delete the no-wait `token()` and the default in `authHeaders()`. Every caller waits for the token as `ask` does. The callers that call `fetch` themselves go through one function built on `ask`: `voices.ts:90`, `broll.ts:706`, `transcribe.ts:385`, `:532`, `:555`, `thumbnails/openart.ts:63`, `ideas/routes.ts:366`, `writer/trello.ts:54`, `relay.ts:250`.
- **2c.** `library.ts:232` `accessToken()`: wait for the token. If a sign-in is kept and there's still no token, throw the same passing error `relay.ask` uses ("the sign-in is being renewed"). Say "Sign in to Edit" only when no sign-in is kept at all.
- **2d.** The relay, `relay/src/auth.ts` `caller()`: when it can't read the accounts site's keys it answers 401 "Sign in to Edit". It should answer 503 "Edit asks again", as its slow-check branch already does **(seen)**. This may be why JJ's Mac logged "the relay refused the sign-in's token" five times between 11:32 and 13:09 today with a good token **(inferred)**. It needs a relay deploy: Sphe's go.
- **2e.** A wake detector, new and small: a one-second beat; a gap over ten seconds means the machine slept or was frozen. Then the sign-in is renewed first, and work that fell due starts only once the token is there (`jobs.ts` `wake`, and `writer/missing.ts` `tick` until change 7d removes it). Every other part that cares about a sleep listens to this one signal (changes 5 and 6).

**Quick test, `signin-after-freeze`:** the stand-in accounts site gives sign-ins that last 20 s. A Script import has one recording made to fail once, so a retry falls due. Edit and everything under it is frozen for 40 s, across the retry's time and the sign-in's end, with the line cut; then woken, the line back 5 s later. Checks: the stand-ins saw no request without a sign-in, or with a run-out one; Edit's log has no "need you signed in" and no "(401)"; the recording comes in on the first try after the wake; no project or script holds a sign-in error. Two more: `signin-site-slow` (the accounts site answers 25 s late: work waits, nothing says sign in) and `signin-ended` (the sign-in is really ended: one sign-in screen, work waits, and carries on within seconds of signing in). 2d gets a unit test where the relay's sign-in tests already are (`apps/web/src/lib/relay-auth.test.ts`): keys unreadable gives 503, a bad token still gives 401.

### Change 3 · One recording that can't be read never stops a case (patch)
**Felt today:** JJ's "Mom Of 4" on nightly-90: "its import stopped (Could not read BenjaminCunningham_202401112341_02619-0.)", after 48 recordings and 53 GB **(seen: his report)**.
**The change:** `writer/imports.ts`. `fetchRecording` already reads each recording's length, picture and sound. It hands them on, and `joinPreview` (line 1522) uses them instead of reading every recording a second time, often over the network. Where it must read again (a restart, a late recording joined in) and can't, that one recording is marked still missing with the real reason (`stillMissing`), and the rest are joined. It stops only when none can be read. The line `throw new Error("Could not read …")` goes: it hid the cause.
**Quick test, `unreadable-recording`:** a Drive folder of three recordings. In one run the line drops just as the join reads the second, whose copy here is already gone. In another the second is a megabyte of noise named `.mp4`. Checks: the import ends ready with the others; the second is listed as missing with its real reason; in the first run it comes in by itself when the line is back; nothing says "import stopped".

### Change 4 · Three leftovers of the Wi-Fi fix (patch)
**Felt today:** nothing yet. These are the same hole, still open at the side.
**The change**
- **4a.** `script.ts:111` `skipFootage`: a file given by name is refused unless it is the person's to answer (its row is `failed`). One that Edit is still bringing in says so: "Edit is still bringing this in by itself." The "*" path already does this.
- **4b.** `script_tools.ts:315`: the tool's answer says what now happens: the ranges hold their place as black cards.
- **4c.** `serve.ts:594`: an export a restart cut short whose kept timeline can't be read says so in the log and in its note ("exported as the edit is now"). It never swaps timelines silently.
- **4d.** A plain unit test on `layOut`: the edit's length equals the script's ranges' length, cards included. The old skip fails it.

**Quick test, `skip-named-file`:** an import with one file waiting on a cut line. The route and the agent's tool are both asked to skip that file by name. Checks: both refuse; the script's ranges are the same before and after; the file comes in when the line is back.

### Change 5 · Slow is never "stuck" (rewrite of how a step is stopped)
**Felt today:** JJ's log, Nov 18 to 19: ten tries of a file stopped by a time limit. "Finding the excerpt's keyframe took more than 2 min", five times. "Cutting an excerpt took more than 12 min" (then 16), five times, all on "Genius" Killer's first file, which has been going round since 11:09 **(seen)**. His line is slower than the limit assumes, and up to three cuts share it **(inferred: two were stopped a minute apart at 13:24 and 13:25)**. Every stop starts again from nothing.
**The change**
- **5a.** `import_steps.ts`: the limits that are a number of minutes go for anything read over the network: `LIMITS.cut`, `LIMITS.proxy`, `LIMITS.relayCopy`, and `LIMITS.probe` where it reads a URL. `bounded()` becomes "stop a step only after it has made no progress for five minutes". Progress is bytes: the cut's file growing, the copy's count rising. `cloud.ts` already has this idea (`Stall`); use one helper for all. A fixed limit stays only for work on this disk.
- **5b.** `script.ts` `runTool` and `cut()` take that helper. FFmpeg's own 30-second reconnect stays underneath.
- **5c.** `cloud_media.ts:1503` `EXCERPTS_AT_ONCE`: one at a time when cutting from the cloud's address, three from a file here.
- **5d.** "There isn't room on this Mac" becomes its own kind of wait (`room`, change 6), with its own line: "Needs 5.5 GB free on this Mac". It isn't a passing failure tried again every few minutes.
- **5e.** After a wake (2e), every "no progress since" clock starts again. A step isn't called stuck for the time the lid was shut.

**Quick tests.** All use a 150 MB file shaped like JJ's Axon files: index at the end, a keyframe every 8 s, B-frames. `slow-cut`: the line held to 2 Mbit/s, two 20-second ranges, time run 60 times faster so today's limit is 30 s. Checks: both excerpts are cut; nothing "was stopped"; bytes fetched are at most 1.3 times the excerpts' size. `stalled-cut`: the line goes silent mid-cut. Checks: stopped after the no-progress time, tried again by itself, done when the line is back. `frozen-cut`: Edit frozen 30 s mid-cut. Check: the cut isn't stopped. `no-room`: the import runs on a small disk. Checks: the line says how much room is needed; the same bytes aren't fetched over and over; no "No space left" reaches `jobs.json` or a project's file; the file comes in once room is made.

### Change 6 · One rule for what a failure means (rewrite: replaces two)
**Felt today:** the same trouble gets a different answer depending on where it lands. A dropped line stops Script mode's import for a person and not the editor's. A share that meets a blip says "Sharing stopped". A job cut by three restarts is "given up".
**The change:** one new module, `failure.ts`. It is the only place that says what a failure is and when Edit tries again. It keeps today's words and adds three.

| Kind | What it is | What Edit does | What the person sees |
|---|---|---|---|
| `passing` | a dropped line, a timeout, a busy service, the sign-in being renewed, a step that stood still, **and anything Edit doesn't recognise** | tries again after 1, 5 and 15 minutes, then every 30, for as long as it takes | one quiet line: "Trying again at 14:32" |
| `quota` | a paid plan out of credit, a day's allowance used | every 30 minutes, or at the reset | the line that says who adds credit |
| `limit` | Google Drive's download limit for a file | at Google's time, else in a day | the line with the copy's-link hint |
| `encoder` | the hardware encoder is busy | when it's free | nothing |
| `room` (new) | not enough room on this machine | when room appears, looked at every 5 minutes | "Needs 5.5 GB free on this Mac" |
| `signin` (new) | no sign-in is kept at all | when someone signs in | the sign-in screen, once |
| `person` | only a person can put it right: a file deleted, private, never shared, not a video | looks again every 30 minutes, in case it was put right (a file shared since); never guesses an answer | the one kind of question Edit asks (change 9) |
| `broken` (new) | Edit's own bug, or a refusal that is the same every time | stops; a new build tries it once | "This needs a fix in Edit" |

- The kind is read from the error's type first, and from its words only for text from outside Edit (Drive's pages, yt-dlp). `import_steps.ts`'s lists move here. `service.kindOf`'s table is read here too, so there is one answer.
- Waiting `passing` and `signin` work is woken at once, a few seconds apart, when the trouble is seen to be over: the relay or R2 answers again (`outages.ts` `answered`), the sign-in is renewed, the machine wakes (2e). Nobody waits half an hour because the Wi-Fi came back one minute after a try.
- A few quick tries inside one request stay where they are (`cloud.ts`, 2, 4, 8 s). Between tries of a piece of work, only this rule.
- One switch for the tests: `EDIT_BAD_DAY_SPEED=60` divides every wait in this module by 60. It's read here only, and ignored in a release build.
- This step moves no caller. `whyOf`, `passing`, `retryAt` and `service.isTemporary` answer from the new module, so behaviour changes in one way only: the two readers now agree.

**Quick test:** unit tests on the table: every error class and every outside phrase the two old readers knew gives the kind above; an unknown error is `passing`; each kind's next try is what the table says. Then the bad-day cases so far still pass.

### Change 7 · One table for all long work (rewrite: every caller moved, one at a time)
**Felt today:** JJ's log, Nov 11 to 19: an import stopped to ask him 11 times over a file that hadn't come in. Marc's archive sat "given up" for days. A share on a bad line ends "Sharing stopped" and waits for a press. Script mode's retries live on timers in memory, so a restart forgets them.
**The change:** `jobs.ts` stays the table, in its plain file. It gains one way to wait: `wait(key, kind, error)`, which takes the next try from `failure.ts`, and `wakePassing()`. Then each caller moves, in this order. Each step is one commit: the caller moved, its own rule deleted, its test passing. Don't start a step before the last one passes.

- **7a. The table itself.** `takeOver`: nothing is given up for restarts. Work cut short three times in a row with no progress waits by the `passing` schedule, whatever its kind. An agent's turn is the one exception: it ends, with its line in the chat, as now. `BACKS_OFF`, `MOST_RESUMES`'s give-up branch and `PUT_OFF` go. Rows an older build left "given up … cut short by" are woken at start, for every kind (today only some, `jobs.ts:427`).
- **7b. The editor's Script import** (`script.ts` `start`). The loop that sleeps one and five minutes inside the running import goes (line 2501). While it sleeps the import counts as working, so every answer is refused. A file that fails is settled at once by the rule, and the import waits in the table. Each file keeps its own kind and tries, as now.
- **7c. Script mode's import** (`writer/imports.ts`). It becomes one row from its start to "ready", with its steps written down. A `passing`, `quota`, `limit`, `encoder`, `room` or `signin` failure makes it wait and carry on by itself; the script stays importing with one status line, and no "The import stopped" notice goes out. Only `person` and `broken` stop it. The resumer in `serve.ts` (`script`) carries on every wait, not only credit's. Gone: `writer/index.ts` `carryOn`, `carryOnImport` and `carrying`; `store.markInterrupted` as the way imports are found; `stuck()` and `stuckOn` (it's `broken` now).
- **7d. Recordings that didn't come in** (`writer/missing.ts`). Its timer, its `due` list, `DELAYS_MS`, `HOURLY_MS`, `schedule`, `wake`, `tick` and the `.missing-here` dot file go. Each script with missing recordings has one row; its resumer calls `tryAgain`. The table is this machine's own, so the row itself says which Mac ran the import. `script.missing` stays on the script, for the page.
- **7e. The editor's missing footage** (`missing_media.ts`). Its `tries` list and timers go; one row a project. "Going on without" a file moves out of `footage-gone-without.json`, a file on one Mac, into the project, so it travels with the edit. The old file is read once, then deleted.
- **7f. Sharing** (`reviews.ts` `runShare`). A `passing` failure makes the share wait and go on from its step by itself. No "Sharing stopped" notice. The link's notice comes when it's up. Retry stays for `broken`.
- **7g. Exports' cloud copies, full-quality uploads, uploads, Drive uploads, footage from a Drive link.** Their `putOff` becomes `wait`. They try again after a minute, not an hour, and wake when the line is back.
- **7h. After an update** (`retry_after_update.ts`). It retries only work that ended `broken`. It deletes the export's chunks only when the render itself failed. A failed upload goes on from its step with the export it has (`reviews.retryShare`). Today it deletes them every time (line 187).
- **7i. One answer to "what is running"** (`busy.ts`). One function lists what runs now: the table's running rows, agent turns, effect renders, removal. Keeping the Mac awake (`serve.ts:479`), holding a restart (`busyWith`) and the cache's cleaner (`workingNow`) all read it. The three hand-kept lists go, and so does `wouldLose`, which returns nothing.

**Not moved in this pass, on purpose:** Claude's own runs on scripts, ideas and thumbnails, and agent turns. They wait on the plan's limit by a rule of their own and are in none of the incidents. Removal and effect renders, for the reasons in section 1.

**Quick tests**
- `wifi-drop-editor-import`: the night of Nov 18. Two files; the line drops for a scaled 90 s during the second, through the last quick try. Then, one run for each, every answer in the census is sent to the server as if its button had been pressed, shown or not. Checks: nothing is asked; no answer changes the ranges; the import finishes within seconds of the line coming back.
- `wifi-drop-script-import`: the same for a three-recording case in Script mode, with a kill in the middle. Checks: no "import stopped"; the retry survives the kill; the case is whole at the end.
- `kill-three-times`: Edit is killed three times in a row at each step of an import, an export and a share. Checks: nothing is given up; every piece of work is listed once; nothing already fetched is fetched again; nothing paid is sent twice (the stand-ins count hearings, voices and model calls).
- `share-drop`: the line drops during a share's upload. Checks: the share waits and its link comes by itself; nothing says "stopped"; the bytes sent are at most the file plus one part for each drop.
- `upload-failed-then-update`: a share fails at its upload; Edit starts as a newer build. Checks: no chunk is rendered again; the share goes up from the export it has.
- `awake-and-busy`: during each kind of work, the one answer names it; when nothing runs, it is empty.

### Change 8 · Footage comes down once and stays while the project is in work (rewrite of how an import fetches)
**Felt today:** on Nov 18 each of JJ's two files took 23 to 26 minutes through the cloud, with the relay in the path the whole time **(seen, his log)**. Since nightly-88 Script mode brings each recording down once, then removes it as soon as it's uploaded; the editor's import then reads the same recording back over the network **(seen in code: `writer/streamed.ts`, `script.ts` `footageToCloud`)**. Cutting over the network is where all three limits tripped.
**The change:** one way to fetch a source, used by both imports. A new module (the main agent names it) does what `writer/streamed.ts` does for Script mode since nightly-88: with room here, the source comes down to this disk, resuming where it stopped; the original reaches the cloud behind the work, by the relay's own copy where it can, else by this machine's upload job; the copy here is noted in `cloud/local-originals.json` and kept by the storage rules while the project is in work.
- **8a.** `cloud_media.ts` `driveExcerpts`: a file that is here is used before the cloud's address (`localOriginal`). Small, and first.
- **8b.** `writer/streamed.ts`: the copies in `.originals/` are noted as local originals, counted in the ledger, and no longer removed the moment they're uploaded. The storage rules let them go.
- **8c.** `script.ts` `start`: with room, a Drive file, a YouTube video or a post is fetched to this disk and its excerpts are cut here, in seconds. Without room, it goes through the cloud as today, under change 5. A source that lives only in the cloud (a shared master, a review's finished video) is downloaded the same resumable way. `footageToDisk` and `footageToCloud` become one function with a "room here?" branch.
- **8d.** When 8a to 8c pass: `cutsBetterHere`, `wholeHere` and nightly-90's fallback branch in `driveExcerpts` go. Cutting here is the first way now, not the rescue.

**Quick tests.** `handoff-no-refetch`: a three-recording case imported in Script mode, then "Start the edit" in the same run. Check: the editor's import fetches no original from the stand-in cloud. `resume-download`: a 150 MB file at 8 Mbit/s, the line cut five times and Edit killed once. Checks: bytes fetched are at most the file plus a little for each cut; the file's checksum is right; the excerpts match a clean run's, by length and by first, middle and last frame. `upload-behind`: the way up held to 1 Mbit/s. Checks: the edit is laid out while the original is still going up; with the line then cut, an export of that edit still finishes from the files here.

### Change 9 · The question census: what each one becomes
**Felt today:** Edit asks a person to choose over trouble that would have passed, and one of the answers used to destroy work.
**The change:** this is every place Edit asks someone to choose over a failure **(seen: the page's and the server's code)**. After changes 6 and 7 most stop by themselves. What is left is below.

| | Where | Asks today | Becomes |
|---|---|---|---|
| Q1 | The editor's import, a file it couldn't get (`WaitingFiles.tsx`, `script.ts` "waiting for the person") | Use another link · Make the edit with its parts black · Try again | Stays, and only for a file that is really the person's. Both answers keep the work since nightly-90. The side door is shut by 4a |
| Q2 | The editor, footage not here (`MissingCloud.tsx`, `missing_media.ts`) | Retry now · Go on without it | Retry now is shown only where the person may have put something right (a file shared since); for trouble that passes there's nothing to press. The other button is named for what it does: **Export with its parts black**. It only stops the export waiting. Edit keeps trying for the file, and it plays again when it comes |
| Q3 | Script mode, a recording that didn't come in (`writer/editor.tsx`, `writer/missing.ts`) | Retry now · Go on without it ("for good") | Retry now as in Q2. The other button: **Write without it**. Never "for good": the recording stays listed as left out and can be brought in later, the way footage is added to a script (`writer/links.ts` `addFootage` exists; I didn't read it). It isn't joined in by itself once a script is written, because that would move the script's times |
| Q4 | Script mode, "The import stopped" | Try again · Replace · Dismiss | Not shown for trouble that passes (7c). Left for a video that is gone (Replace) and for `broken` |
| Q5 | Script mode's older questions: "some recordings failed", "this folder holds too much" (`ChooseRecordings.tsx`) | Skip them · Choose | Carried on by itself since nightly-88. The code goes once every Mac has started a newer build (section 5) |
| Q6 | Script mode, "no sound" or "no words heard" | Open without a transcript · Cancel | Stays: it is a fact about the footage. But "no words heard" is said only when the hearing service answered with none, never when it failed |
| Q7 | Footage a clean-up cleared from a finished project (`FootageBack.tsx`) | Bring the footage back · Go on without them | Stays as it is: it isn't a failure. A source that can't be fetched joins Q2 |
| Q8 | A share that failed (`ShareDialog.tsx`, the "Sharing stopped" notice) | Retry | For trouble that passes: nothing to press. "Waiting for the connection. The link comes by itself." Retry is left for `broken` |
| Q9 | An export that failed (`ExportsView.tsx`) | Retry | The same as Q8 |
| Q10 | Work "given up" after restarts | an admin's unstick, from afar | Gone (7a) |
| Q11 | "Sign in to Edit (401)" on a project, a sync, an import | Sign in | Shown only when no sign-in is kept. Otherwise never (change 2) |
| Q12 | "This import needs N GB": the import stops with Retry | Retry | A wait with its own line (`room`); it carries on when there's room |
| Q13 | Someone else has the project open (`CloudBanner.tsx`) | Take over | Stays: a real choice |

Not on the list, on purpose: an agent's turn that failed (it's the person's own conversation), and the Update button.

One thing left as it is, knowingly: the editor's import still stops and waits when a file is really gone, where Script mode's goes on without it. Making the editor's go on at once needs "Use another link" to work on an edit already laid out. That is new work, not a fix, so it waits until features start again.

**Quick test, `nothing-asked`:** on in every case above. It fails a run if work waits for a person, a script waits on a choice, or a "needs you" or "stopped" notice goes out, for any kind but `person` and `broken`. And one plain test holds this table in code: every place the server parks work for a person must be on it, so a new question can't arrive unseen.

## 3. The quick bad-day tests

**What it is.** A script that runs a real Edit server, from this checkout, against stand-ins for everything outside it, and breaks things on purpose. It checks the outcome the way a person would judge it: did the work finish by itself, was anything lost, was anyone asked.

**Where it lives.** `app/scripts/bad-day/`:
- `run.ts`: builds the sandbox and starts the run inside it.
- `inside.ts`: starts the stand-ins, the bad line and Edit, runs the cases, prints one table.
- `cloud.ts`: the stand-ins. It reuses the tests' own (`apps/server/test/mocks/server.ts` and `mocks/cloud.ts`: the relay's routes, R2, Convex, Google) and adds an accounts site with short sign-ins and a Drive that serves files from disk in ranges. It keeps what's uploaded on disk, not in memory.
- `line.ts`: the bad line, a small program every connection passes through. It can slow each direction, add delay, drop every connection, go silent, or cut after so many bytes.
- `footage.ts`: makes the test footage once, with FFmpeg's own test pictures: files shaped like JJ's (index at the end, a keyframe every 8 s, B-frames), a file of noise, sound alone.
- `cases/`: one file a case: what it sets up, what it breaks, what it checks.

**How it runs.** One command, from `app/`: `just bad-day` for all of it (about 15 minutes, my estimate), or `just bad-day slow-cut` for one case (a minute or two). The time switch from change 6 makes an hour's wait a minute. A freeze is a stop signal to Edit and every program under it, with the line cut at the same moment; the line comes back five seconds after the wake, as a Mac's does. A kill is a kill. A sign-in is made to run out by giving it 20 seconds to live.

**What every case checks, whatever it tests**
1. Nobody is asked anything over trouble that passes.
2. Nothing is deleted: the script's ranges and the edit's length are the same before and after.
3. Every piece of work ends done, or is still trying by itself. None failed, none given up, none listed twice.
4. No request left Edit without a good sign-in.
5. Nothing is fetched twice: bytes fetched stay close to what was needed.
6. Nothing paid is sent twice.
7. The same saved edit gives the same video as it did before the work began: the same number of frames, and the same first, middle and last frame.

**How it keeps memory capped.** I tried the pieces on this machine today, without root **(seen)**:
```
systemd-run --user --scope --quiet --unit=edit-bad-day -p MemoryMax=6G -p MemorySwapMax=0 \
  bwrap --unshare-net --unshare-pid --die-with-parent \
    --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
    --bind "$RUN" "$RUN" --size 268435456 --tmpfs "$RUN/small-disk" \
    --tmpfs ~/.edit --tmpfs ~/.edit-dev --tmpfs ~/.edit-prod \
    --setenv TMPDIR "$RUN/tmp" \
    bun scripts/bad-day/inside.ts "$@"
```
- Six gigabytes for the whole run, and no swap. Past it the run is ended; the machine isn't.
- The run has one name, so a second can't start beside it: the second is refused ("already loaded"). One Edit server at a time, cases one after another.
- The run's folder is `~/.cache/edit-bad-day/`, on the real disk, with `TMPDIR` pointed into it. Never `/tmp`: on this machine `/tmp` is memory.
- The footage is 640 by 360 and at most 150 MB. The "nearly full disk" is 256 MB and counts inside the cap.
- It won't start with less than 8 GB of memory free.

**What it can never touch.** Inside that sandbox **(seen in today's probe)**:
- There is no network but its own. A public address couldn't be reached, and neither could prod Edit on `127.0.0.1:7790`. So it can't reach the dev server, prod Edit, the live relay or prod R2, whatever its settings say.
- `~/.edit`, `~/.edit-dev` and `~/.edit-prod` are empty folders. The rest of the disk can be read and not written. Only the run's folder can be written.
- Its programs have their own numbering, so a freeze or a kill can only hit what the run started, and everything ends with the run.
- Before it starts Edit, `inside.ts` checks all of that itself, and stops if a public address answers or `~/.edit-prod` isn't empty.

Two limits of this machine: shaping the line with the system's own tools needs root, so the bad line is a program; and a real small disk needs root, so the small disk is memory-backed. Neither changes what the cases prove.

## 4. What only full runs on real Macs can prove

Stop and go back to Sphe when every case in section 3 passes and I've checked the work. Then these are left, and none can be done here:

1. **Playing from files on the Mac** in the native player: first frame, jumps, scrub. The cloud playback code is deleted only after this.
2. **A real lid close.** macOS wakes in the night by itself, the network comes back seconds after the wake, the encoder's sessions die in sleep, and its timers don't count sleep the way a freeze here does.
3. **JJ's real line and real files:** a 6 GB Axon file end to end; a cut through the cloud when the Mac has no room for the file; Google's and YouTube's real refusals.
4. **Disks over days:** originals kept on a Mac with the storage rules, for a week of real projects.
5. **The hardware encoder** shared between an export and an import.
6. **Moving from an older build:** Marc's Mac from 84 and JJ's from 90, with their old work rows, old questions and the going-on-without file.
7. **The relay's change (2d)** on the live relay. It needs Sphe's go.
8. **Exports made ahead:** reused or not, counted from a week of JJ's log.
9. **The count:** how often the team is asked, and how often work stops, over weeks. That is the only proof that it's stable.

## 5. What to delete

**With the change that makes it dead (the evidence is that change's test passing)**
- Change 3: the "Could not read" throw in `joinPreview`.
- Change 5: `LIMITS.cut`, `LIMITS.proxy`, `LIMITS.relayCopy`, and `bounded()` as a clock.
- Change 6: `whyOf`, `passing`, `retryAt`, `RETRY_WAITS`, `PASSING_RETRY_MS`, `QUOTA_RETRY_MS`, `LIMIT_RETRY_MS` in `import_steps.ts` (they answer from `failure.ts` first, then go as each caller moves); `service.kindOf` for deciding about work.
- Change 7: `BACKS_OFF`, the give-up branch and `PUT_OFF` in `jobs.ts`; the sleeping retry loop in `script.ts`; `carryOn`, `carryOnImport` and `carrying` in `writer/index.ts`; `stuck()` and `stuckOn`; the timer, `due`, `DELAYS_MS`, `HOURLY_MS` and `.missing-here` in `writer/missing.ts`; `tries`, its timers and `footage-gone-without.json` in `missing_media.ts`; the unconditional chunk delete in `retry_after_update.ts`; `wouldLose` and the three hand-kept lists of what's running.
- Change 8: `cutsBetterHere`, `wholeHere`, the fallback branch in `driveExcerpts`; `footageToDisk` and `footageToCloud` as two functions.
- Change 9: "Retry now" for trouble that passes (`MissingCloud.tsx`, `TopBar.tsx`, `writer/editor.tsx`); Retry on a share or an export for trouble that passes; the words "for good" and the code behind them in `missing_media.ts` `goWithout` and `writer/missing.ts` `answer`.
- Tests that hold an old rule in place (the retry loop's waits, "given up" after three restarts) are rewritten to the new rule, not kept beside it.

**Only after every Mac has started the new build once**
- `script.wakeWhatPasses`; `writer/missing.ts` `carryOnOlder`; the "some recordings failed" and "too much" answers in `writer/imports.ts` with `ChooseRecordings.tsx`; the reading of the old going-on-without file; `jobs.ts`'s reading of rows from before Nov 8.

**Not yet: today's evidence doesn't carry it**
- Playback through the cloud (`playback_render.ts`, `playback_stream.ts`, `scrub.ts`, `cloud_blocks.ts`, `export_excerpts.ts`, `proxy_pieces.ts`, Script mode's own player): waits for item 1 of section 4.
- Exports made ahead: waits for the count.
- V1 beside V2, and the lock between Macs: no incident in this audit turns on them. They are Sphe's to decide later.

## What I didn't check
I ran no tests, builds or servers. I didn't pull new logs: the copies here end at 14:27 our time, so I don't know whether "Genius" Killer's file came in after that. I read the two imports, the job table, the sign-in, the relay's sign-in check, sharing's failure path and the page's failure prompts; I did not read the upload code line by line, nor Script mode's cloud sync. The relay's 401 as the cause of JJ's five refusals is inferred, not shown. The sandbox was proven with a small probe (its own network only, the prod folders empty, a 256 MB disk that fills, a second run refused), not with Edit running in it: that is the first thing change 1 will show. The sizes and times of the cases are my arithmetic; the main agent should adjust them until each case fails on today's code for the reason written.
