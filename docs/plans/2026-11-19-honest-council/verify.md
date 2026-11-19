# Checking the work · Claude Fable 5.2 · Nov 19, 2026

I read `final.md` again, then every commit from `20811f74` to `ae50a999` against the code as it stands. I changed no code, committed nothing, released nothing, restarted nothing and touched no running server. I ran unit suites one at a time under a 5 GB cap, both typechecks, one bad-day case, and four small tests of my own from my scratch folder (they are in the appendix; nothing of mine is in the repo but this file).

**(seen)** means I read it or ran it today. **(inferred)** means it's my conclusion. Paths are under `app/apps/server/src/` unless they say otherwise.

## The answer

**Not ready for Sphe's Mac runs yet.**

- Changes 2, 3 and 4 are done as written and hold.
- Changes 6 and 7 are built and their own tests pass, but the job table now has three bugs I can show with failing tests, and one more in how a failure is read. All four sit in the paths the team is on every day: a share after a blip, an import on a bad line.
- Change 5 is half done. Change 8 is a quarter done, and the quarter that's done changes nothing for a case that came through Script mode.
- The bad-day cases for changes 7 and 8 are still stubs. Three of the four bugs below are exactly what `wifi-drop-*`, `share-drop` and `kill-three-times` were written to catch. `final.md`'s own rule was: back to Sphe when every case passes.

None of the bugs loses work. They make Edit slow to come back, or busy when it shouldn't be.

## 1. What's wrong, most felt first

### 1 · After a blip, waiting work goes one at a time. A share's link can sit for hours behind an import.

- **Where:** `jobs.ts:540` (`dueNow`), with `jobs.ts:331` and `jobs.ts:192`.
- **What's wrong:** the old rule "one put-off job at a time" was for work cut short by three restarts in a row: one of them might be what brings the server down, so they go singly. Change 7 made `jobs.wait` the way everything waits: Script mode's import, a share, an export's cloud copy, an upload. Each `wait` sets `put_off`, the row keeps it while it runs again (`fresh`, line 192), and `dueNow` starts no other put-off row while one is running and was noted in the last three hours (`PUT_OFF_RUN_MS`, line 113). Script mode's import never notes anything after it begins, so it holds the others for up to three hours each time.
- **What a person sees:** JJ's line drops. His share says "Waiting for the connection. The link comes by itself." A Script import waited on the same drop. The line comes back, the import goes on for two hours, and the share's link doesn't come until it ends. There's nothing to press: the share shows as running.
- **Shown by (seen):** two rows, a `script` and a `share`, both waited on "could not reach Edit's relay…", both due. `jobs.wake` three times: only `script:script-1` starts. The share stays `waiting`. Appendix, test A.
- **Fix:** hold one at a time only for rows put off for restarts (mark them in `takeOver`'s `postpone`, or read `why` starting "cut short by"). A row that waited on a failure goes when it's due. Add test A to `test/jobs.test.ts`.

### 2 · The editor's import forgets each file's tries. A file that keeps failing is tried again every minute, for good.

- **Where:** `script.ts:2453–2462` (`start` builds each file's row from `name` and `total` only), `script.ts:2537`, `script.ts:2562`.
- **What's wrong:** `ae452b13` says "each file with its own tries (1, 5, 15 minutes, then every 30)". Every wake from the job table goes through `carryOn` → `start`, which makes a new job whose rows have no `tries`. So after each failure `tries` is 1 again and the next try is one minute on.
- **What a person sees:** nothing on a short drop (it comes back sooner). On a failure that repeats, Edit never backs off: a YouTube video that's being refused is asked for again every minute (Sphe's rule of Nov 10: never risk a person's ban), and a file whose cut stands still for five minutes is cut again back to back, on JJ's line. With a try every minute the Mac hardly gets to sleep.
- **Shown by (seen):** one file failing on a dropped line, woken three times: `[tries, minutes to next try]` is `[1,1] [1,1] [1,1] [1,1]`, where the commit says `[1,1] [2,5] [3,15] [4,30]`. Appendix, test B.
- **Why the suite didn't see it:** `test/import_jobs.test.ts` "JJ's dropped connection" sets every wait to zero and never reads `tries` after a wake.
- **Fix:** in `start`, carry `was.tries` into the new row for a file that isn't done. Assert the four pairs in that test, with the real waits.

### 3 · Everything else has the opposite fault: its waits only grow. After three blips, each new one costs half an hour.

- **Where:** `jobs.ts:331` (`put_off = times + 1`), `jobs.ts:192` (kept when the row begins again), `jobs.ts:371` (`progressed`, the only thing that forgives it). Of the work that waits this way, only a full-quality upload (`reviews.ts:499`) and a footage upload (`cloud_media.ts:766`) call it.
- **What's wrong:** `final.md` 7a said three times in a row *with no progress*. For Script mode's import, a share and an export's cloud copy, nothing ever says they got further, so `put_off` counts every wait the row has ever had. The same goes for `attempts`: a long import cut by three ordinary quits, hours apart, is treated as a crash loop from then on.
- **What a person sees:** a share on JJ's line that meets three short drops waits 1, then 5, then 15 minutes, and 30 after every drop from there. A short drop isn't an "outage" (that takes three failed calls in a row, `outages.ts:76`), so nothing wakes it sooner.
- **Shown by (seen):** one `script` row, five waits with the import beginning again between each: `1, 5, 15, 30, 30` minutes. Appendix, test C.
- **Fix:** write the steps down, which 7c asked for and isn't done (the row only ever says "importing"): `jobs.step` at each stage of Script mode's import, and let `step` forgive `put_off` and `attempts`, as getting further should. A share already calls `step`. An export's cloud copy calls `progressed` as parts go up, as the full-quality file does.

### 4 · Script mode's import and a share still stop on a dropped line, when the words aren't on a list. And "signed out" was never built.

- **Where:** `failure.ts:138` (`surely`), `failure.ts:116` (the words), `writer/imports.ts:650–658`, `reviews.ts:615`. `failure.ts:88` (`SignedOut`).
- **What's wrong, part one:** this is the first departure the main agent named. For the editor's import, anything unknown is passing. For Script mode and shares, anything unknown stops, as before. So change 6's point, one answer to "what does this failure mean", holds for one import and not the other. The reason given is fair: their own refusals ("A compilation needs new footage", "export the whole edit first") are plain errors, and would wait for ever behind "Waiting for the connection". But the list of words is what now decides how often JJ sees "The import stopped", and it misses real ones.
- **Shown by (seen), each read as "not surely passing":**
  - FFmpeg's own line, as it prints it: `Server returned 5XX Server Error reply` (the list wants digits after the 5).
  - `Input/output error`, `No route to host`, `Failed to resolve hostname …`, `Stream ends prematurely at …`, `Invalid data found when processing input` (what a cut-off read looks like).
  - Bun's fetch when it can't connect: `Unable to connect. Is the computer able to access the url?`, with its code `ConnectionRefused`.
  - curl: `(6) Could not resolve host`, `(7) Failed to connect`, `(18) transfer closed with … bytes remaining`, `(35) … SSL_ERROR_SYSCALL`, `(92) HTTP/2 stream … was not closed cleanly`.
- **How much it's felt (inferred):** less than it looks. In a folder case each recording's failure never stops the import (it's left out and tried again, change 3), and Drive, the relay and transcription throw typed errors that are read right. What's left is a single video read back from the cloud at the join ("… couldn't be read: …"), a case where every recording failed, and a share's own steps.
- **What's wrong, part two:** `SignedOut` is thrown nowhere **(seen: no `new SignedOut` in the tree)**, and nothing wakes waiting work when someone signs in (`serve.ts:544–561` listens to a wake and to an outage ending, nothing else). So the `signin` kind in `final.md`'s table doesn't exist. Signed out for real, `library.ts:242` still throws "The sound library and Google Drive need you signed in to Edit." as a plain error: Script mode's import stops on it, and the editor's import spends a try on it as passing.
- **The test that proves less than its name:** bad-day `signin-ended` passes, but by three tenths of a second **(seen: its `edit.log` in the kept run of 17:32)**. The recording's retry fell due at 17:39:13.9. Edit was signed out from 17:38:43 to 17:39:25. The table looked at 17:39:13.7, missed the retry by 0.3 s, and tried it at its next look, 17:39:43.7, after the person had signed in. Three tenths earlier and the try would have been spent signed out on "need you signed in", which the case allows in the log, with the next one five minutes on.
- **Fix:** in this order.
  1. Throw `SignedOut` where no sign-in is kept (`library.ts:242`, and where `relay.ask` finds none). Wake `signin` waits from `accounts.onSessionChange`. Make `signin-ended` end the sign-in before the retry is due.
  2. Add the words above, and read the error's `code` (`ConnectionRefused`, `FailedToOpenSocket`, `ECONNRESET`…) before its words.
  3. Then make both imports the same again: unknown is passing everywhere, and an unknown failure with the same words four times in a row, no outage between, becomes `broken` and is asked about. That's what my table called "a refusal that is the same every time"; I gave no way to tell. It needs finding 2 fixed first. Give the imports' own refusals a type (`NeedsPerson`) so they stop at once.

### 5 · A full disk is waited out by doing the work again every five minutes, and half of Edit's own "no room" lines aren't read as room.

- **Where:** `failure.ts:114` and `:236`, `script.ts:2264–2267`, `storage.ts:172`, `reviews.ts:749`.
- **What's wrong:**
  - `final.md` 5d: room is "looked at every 5 minutes". What's built runs the import again every five minutes. A cut from the cloud writes until the disk is full, fails, deletes its file and waits. On the test's 256 MB disk that's 12 MB a try. On a Mac with 3 GB free and a 5 GB excerpt it's 3 GB of JJ's line each time, and a disk at zero for everything else on that Mac **(inferred: no room is asked for before `cut` writes, `cloud_media.ts` `excerptMedia`)**.
  - Edit's standard line, "This import needs about 12 GB free and this Mac has 6 GB. Free some space…" (`storage.ts:172`), isn't on the list: the list wants a number straight after "Needs". Nor is the cut's own "Needs 12 MB free…" (megabytes) or "This computer is out of room…". As classes they're right. As words kept in a job they're read back as passing **(seen: my `kinds` run)**. `import.ts:98` and `drive_import.ts:144` throw the standard line as a plain error.
  - A share that waits on a full disk, or on credit, says "Waiting for the connection. The link comes by itself." (`reviews.ts:749`: one line for every kind).
  - Q12 is done for Script mode and for the cut. An export, and the editor's import at its layout step (`script.ts:2630–2639`), still stop with Retry.
- **Fix:** keep the bytes needed on the row and have `due` look at the free room before it starts a `room` wait. Read "needs (about) N GB/MB free" and "out of room". Throw `NoRoom` from the three `storage.admit` callers. Move `writer/imports.ts` `waitLine` beside `failure.ts` and use it for the share's line.

### 6 · `jobs.wait` parks some work "for the person" where there is nobody to ask. It never wakes.

- **Where:** `jobs.ts:332–335` (`postpone`), `jobs.ts:525` (`due`), `jobs.ts:450` (`takeOver` skips it).
- **What's wrong:** a failure read as the person's sets `until: "person"`. That's right for the editor's import, which shows the question. It's wrong for an export's cloud copy, an upload, a Drive upload, or anything that failed as it started (`jobs.ts:702`): nothing shows a question, `due` never wakes it, a restart doesn't take it, and only an admin's unstick starts it again. That is Q10 ("gone") back by a side door. `final.md`'s table said the person's is looked at again every 30 minutes; `failure.nextTry` gives that time, and `postpone` throws it away.
- **Shown by (seen):** `jobs.wait(home, "archive:…", "its upload failed: the export has no bytes")` → `{ state: "waiting", until: "person" }`, no time; the same for a typed 403; `takeOver` returns neither. Appendix, test D.
- **The test that proves less than its name:** `test/census.test.ts:34` skips `jobs.ts`, "the table itself only says what `until: \"person\"` means". It's the one place that parks every kind.
- **Fix:** in `postpone`, the person's gets `retry_at` from `nextTry` (30 minutes) for every kind but `case`. Stop skipping `jobs.ts` in the census. The same "looked at again" isn't built for the editor's import either (`script.ts:2563` gives a person's file no time): JJ shares the file in Drive and nothing happens until he presses Try again.

### 7 · Asked for in `final.md`, not done, and not on the main agent's list

- **Q9, an export that failed.** The census commit lists Q4, Q8, Q10, Q11, Q12 as gone and Q1, Q6, Q7, Q13 as staying. Q9 isn't mentioned. An export still ends failed with Retry whatever stopped it (`exports.ts:1567`). A share's export is covered by the share (7f); a plain export isn't.
- **5a, the proxy's and the relay copy's fixed limits.** Still clocks, over the network: `cloud_media.ts:114` (`LIMITS.proxy`) and `:1262`, `:1303` (`LIMITS.relayCopy`). `ed831188` says so; the hand-over named only 5c.
- **7g, a Drive upload and footage from a Drive link.** `drive.ts:176` and `drive_import.ts:123` end their row on a failure. Only a restart or a failed start makes them wait.
- **7i, "the table's running rows".** `busy.ts:98–141` is still a list kept by hand, now one instead of three. Running and not on it: a share's full-quality file going up (`full`), a footage upload (`upload`), a missing recording or missing footage being fetched, smoothing, a watch, a map. So the Mac can still sleep in the middle of the big upload behind a share. `awake-and-busy` is a stub.
- **7h, "retries only work that ended broken".** It still queues every failed export and every failed share with fixes (`retry_after_update.ts:95–104`). The chunks are kept when they should be, which was the part that hurt.
- **2d, a narrower case left.** `apps/relay/src/auth.ts:69–88`: 503 when no keys were ever read. When keys are held but the accounts site has changed its key and the read fails, the token is checked against the old keys and answered 401 "Sign in", as before.

### 8 · Recordings that didn't come in: every wake tries all of them, whatever each one's own time

- **Where:** `serve.ts:689` (`tryAgain(job.project, true)`), `writer/missing.ts:141`.
- **What's wrong:** the commit says "each recording's next try failure.ts's for what failed". Each recording's time is worked out, but the row wakes at the soonest and tries them all. A recording at Drive's download limit (a day) is asked for whenever a neighbour's minute is up. Before, only the ones due were tried.
- **Fix:** on a timed wake try those due; when the line came back, those that failed on something passing; "Retry now" is the one that tries all.

### 9 · An edit's missing footage: the row never ends for a file that can't come back

- **Where:** `missing_media.ts:218–223`, `:172`.
- **What's wrong:** since the census the row counts the files gone on without as well, so "Export with its parts black" on a deleted video leaves the project trying it every 30 minutes for good, open or not, archived or not, across restarts. Before, the tries died with the session. Every kind is on the passing schedule too, Drive's day included. And every such row is woken together each time the Mac wakes.
- **Fix:** stop trying a file the person answered when it's theirs to put back (`asked`); try the others only while the project is in work.

### 10 · The wake detector fires when the server only stalled, and renews the sign-in every time

- **Where:** `wake.ts:39–46`, `serve.ts:548–556`.
- **What's wrong:**
  - A gap over ten seconds between beats is taken as a sleep. A server that was only busy looks the same. In four bad-day runs Edit logged "the machine was away for" 10.0 to 11.7 s at a moment when nothing was frozen **(seen: mine today at 19:04:54, forty seconds before its freeze; `signin-site-slow` twice and `unreadable-recording`, which never freeze)**. Each time the line just before it is the Linux check of the graphics card for smoothing, which holds the server for those seconds in the sandbox. That's this machine's quirk; what a Mac does is not known.
  - Each such "wake" renews the sign-in, good token or not, holds the table, and wakes everything waiting on something that passes. In my run it tried the missing recording 12 seconds after it failed instead of a minute.
  - A renewal swaps the kept sign-in for a new one. Doing that at every wake, in the seconds when the network is least sure, is more chances to lose the new one and be signed out for real **(inferred; a Mac's night will show it)**.
  - "A few seconds apart" (`jobs.ts:577`) isn't: the first goes now, the rest together at the table's next look, up to 30 s on.
  - `import_steps.ts:160` has a second detector of its own, where `final.md` 2e asked for one signal.
- **Fix:** call it a wake only when the process used almost no processor time across the gap (`process.cpuUsage`): asleep or frozen it uses none, stalled it uses all of it. Renew at a wake only when the token has under five minutes left.

### 11 · Smaller

- **4a is looser than written.** `script.ts:116`: a file waiting on anything but "passing" can be skipped by name. With the two new kinds that lets the agent's tool go on without a file that only waits for room or a sign-in. `final.md` said: only a file that is `failed`.
- **4c.** No test, as the main agent said. And when the export is a share's from an older build, the note isn't passed on (`serve.ts:623` sends `note`, not `said`); the log line is there.
- **After moving from an older build**, an import that build gave up shows "The import was cut short by restarts… Retry carries it on" (`script.ts:1561–1564`) for up to a minute and a half, until the table wakes it. It then goes on by itself.
- **`import_steps.ts:1–32`** still describes the rules that were deleted (`RETRY_WAITS`, `PASSING_RETRY_MS`, "every step is bounded").

## 2. What's fine

- **Change 2 (2a to 2e).** Done as written. A token is sent until it has really run out; every call to the relay waits for it; the library says a renewal under way as a moment's; the relay answers 503 for keys never read. `signin-after-freeze` passes on today's tree **(seen, 106 s)**; `accounts` 20, `relay` 5, `relay-auth` 17 pass. The old no-wait `token()` and the default in `authHeaders()` are gone, and nothing calls them.
- **Change 3.** Done. One unreadable recording is left out with its real reason and tried again; the "Could not read" throw is gone; what fetching read is handed to the join. `missing_recordings` 7 pass.
- **Change 4.** 4a, 4b, 4d done; 4c done but untested. `skip-named-file` fails on `7b59f4e2` and passes now **(seen: the kept runs)**.
- **Change 5, the cut.** A cut from the cloud's address runs for as long as its file grows, and is stopped only after five minutes with nothing new. The kept runs show the three cut cases now fail on the bytes rule alone, as the main agent said. I agree with the reason: every open of a file with its index at the end reads its front and its index again **(seen: the requests in `no-room`: seven to eight megabytes an open on a fast line)**.
- **Change 6, the module.** `failure.ts` is the one place, the two old readers answer from it, the speed switch is read there only and never in a release build. `failure` 4 pass.
- **Change 7a.** Nothing is given up for restarts but an agent's turn; older "given up … cut short by" rows wake in a minute, for every kind. `jobs` 20 pass.
- **Change 7b.** The sleeping loop is gone from the import; a file is settled at once and the import waits in the table; answers aren't refused as "still working". The voice-over's own two pauses still sleep inside, after the edit is laid out, where no answer is waited for.
- **Change 7c.** `carryOn`, `carryOnImport`, `carrying`, `markInterrupted`, `markStopped`, `stuck()` are gone, with nothing left calling them. An import an older build left importing gets its row before the table resumes anything **(seen: the order in `serve.ts:400` and `:493`)**.
- **Change 7d.** The timer, `due`, `DELAYS_MS`, `HOURLY_MS`, `tick` and `markHere` are gone; the dot file is read once and removed.
- **Change 7f.** A share that meets a drop waits and goes on from its step; no "Sharing stopped" goes out; Ready for changes stays "sharing" on the review page and ends when the link is up. The Share button's request had already answered, so nobody is shown an error.
- **Change 7h, the chunks.** Kept unless the render itself failed; a share whose export was made goes on from its step.
- **Change 8a.** Right as far as it goes, and it never removes the copy it cuts from (`script.ts:2953–2961`).
- **Change 9, the page.** "Export with its parts black", "Write without it", Retry now only where the person can put something right. Web typecheck and the two page suites I ran pass.
- **Both typechecks pass** on the tree as it is, the other session's `cloud_media.ts` included. Every suite I ran passes: failure, jobs, while_moving, census, busy, import_jobs, parallel_downloads, missing_media, reviews_share, retry_after_update, accounts, relay, update_mid_import, script, and Script mode's missing_recordings, import_stops, carry_on, whole_case, stuck.

## 3. The open items the main agent named, judged

| Item | Verdict |
|---|---|
| Script mode and shares wait only on what's "surely" passing | Not to be left as it is. Finding 4, with the order to fix it in. |
| 7e: "going on without" stays in a file on one Mac | **Can wait** until after the Mac runs. Since the census it only stops one export waiting; on another Mac the person is asked once more. It needs Rust, and it's the rarest path. `final.md` section 5's "read once, then deleted" no longer applies to that file. |
| 8b to 8d, and 5c | **Before the Mac runs that touch footage.** See below. |
| 4c has no test | Small. Write it with the fixes. Not a blocker. |
| A probe over the network gets 15 minutes | **Can wait.** FFmpeg's own 30-second timeout is underneath, so a dead line ends a probe sooner; a probe that truly hangs holds the one excerpt lane (`script.ts:2413`) for 15 minutes, for every project. With 8c most probes read a file here. |
| An update never waits for running work | Right, as Sphe decided on Nov 10. `wouldLose` returned nothing and nothing was lost with it. |
| The bytes rule (1.3×) | **With 8b to 8d and 5c.** It needs the index read once for a file, which is the same work. On JJ's line it costs seconds for each open, not an incident. |
| The stubs for changes 7 and 8, and check 7 | **Before Sphe.** They are `final.md`'s stop rule, and they'd have caught findings 1, 2 and 3. |

**On change 8.** 8a helps only a file already noted as an original on this Mac. A case that came through Script mode isn't: its copy is removed the moment it's uploaded **(seen, a bad-day log: "in the cloud and its piece made, so its copy here (6 MB) is removed")**. So "Start the edit" still reads every recording back over the network, which is where all of JJ's stopped files came from. Change 5 means that path no longer stops them. It's still the slow one. 8b to 8d change how every import fetches and how a small Mac's disk fills, and that is exactly what Mac items 3 and 4 are there to measure. Run before they're built, those items measure code about to be replaced. They wait on the other session's `cloud_media.ts`.

## 4. Before Sphe's Mac runs

**Must be done first**
1. Findings 1, 2 and 3 (the job table), each with its test.
2. Finding 4, steps 1 and 2 (signed out; the words). Step 3 as soon as 2 is fixed.
3. Finding 6 (work parked with nobody to ask), and finding 5's first two points (look at the room, read Edit's own line).
4. Finding 10's two guards. They are small, and the lid test is where a wrong one costs a sign-in.
5. The bad-day cases for change 7, written and passing: `wifi-drop-editor-import`, `wifi-drop-script-import` (with a share and an upload waiting beside the import, so finding 1 can't come back), `kill-three-times`, `share-drop`, `upload-failed-then-update`, `awake-and-busy`. And check 7.
6. 8b to 8d and 5c with their cases (`handoff-no-refetch`, `resume-download`, `upload-behind`), before Mac items 3 and 4. If Sphe wants one visit, everything waits for these. If he's content with two, items 2, 5, 6 and 7 can go once 1 to 5 above are done.
7. Then I look once more, at the fixes only.

**Can wait until after**
- Q9, 7g's two kinds, 7i's missing rows, 7h's queue, 2d's narrower case (finding 7).
- Findings 8, 9 and 11.
- 7e into the project; the probe's bound.

## 5. The real-Mac list now

`final.md`'s nine stand. What changed:

1. **Playing from files on the Mac.** As it was. Nothing here touched it.
2. **A real lid close.** Now also: count the "the machine was away for" lines over a day and a night against the Mac's real sleeps (`pmset -g log`); count sign-in renewals; and see that nobody is signed out by morning. This is the one place finding 10 can be judged.
3. **JJ's real line and real files.** After 8c: a 6 GB Axon file fetched to disk and cut there; then with no room, through the cloud, where the cut must never be stopped while it moves. Keep FFmpeg's and curl's own words from his log for the list in finding 4.
4. **Disks over days.** Only once 8b is in.
5. **The hardware encoder** shared between an export and an import. As it was.
6. **Moving from an older build.** Marc's from 84, JJ's from 90. Now with these to look for: "given up" rows of every kind waking within a minute; `.missing-here` turned into a row; a script left importing given its row; an old credit wait (`script` row) carried on; the going-on-without file still read, not moved.
7. **The relay's change (2d).** The commit says it goes out with the next tagged build, so the release is Sphe's go for it too. After: no "the relay refused the sign-in's token" with a good token.
8. **Exports made ahead.** As it was.
9. **The count.** As it was. Add: how often a share's link came later than its upload took (finding 1), and how long the longest wait before a retry was (finding 3).
10. **New: a nearly full Mac.** A real small disk can't be made here without root. An import on a Mac with less room than one excerpt needs: what it says, and what it does to the disk every five minutes (finding 5).
11. **New: signed out for real, with work waiting**, then signed in again: one sign-in screen, nothing stopped, work on within seconds (finding 4).

## 6. Where `final.md` itself was short

- **"Anything Edit doesn't recognise is passing … for as long as it takes."** That leaves a file with a fault of its own, in words nobody listed, waiting for ever with nothing to press: the page asks only about a `failed` file (`apps/web/src/components/WaitingFiles.tsx:21`). It was so before today. My table named "a refusal that is the same every time" and gave no way to tell one. Finding 4, step 3.
- **2e, "the sign-in is renewed first".** It should have said: when it's near its end.
- **7a** didn't say what becomes of "one put-off job at a time" once every wait is a put-off. It was kept, for everything. Finding 1.
- **"The person's: looked at again every 30 minutes."** For a Script mode recording that's a whole download each time. It needs to be a cheap look (is it shared now?) before the fetch.

## What I didn't check

I didn't run the whole server suite or the whole web suite, only the files named above; the main agent's commits list the rest. I ran one bad-day case and read the kept runs for the others. I didn't read `cloud_media.ts` beyond `driveExcerpts` and the lines cited: another session holds it. I read the upload code only where the job table touches it. Whether a Mac's server ever stalls for ten seconds is not known here. The risk in renewing at every wake is reasoned, not shown. My bad-day run left its folder at `~/.cache/edit-bad-day/runs/2026-11-19T17-04-37`.

## Appendix: the four tests

Self-contained; A, C and D fit `test/jobs.test.ts`, B fits `test/import_jobs.test.ts` beside "JJ's dropped connection" (it uses that file's `twoFiles`, `cloudFootage`, `settled`). All four fail on `ae50a999`.

```ts
// A (finding 1). Today: only "script:s1" starts; the share stays waiting through every wake.
test("two pieces of work that waited on one dropped line both go when it's back", async () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "jobs-"));
  const waits = failure.PASSING_WAITS.value;
  failure.PASSING_WAITS.value = [0, 0, 0];
  try {
    const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly";
    const script = jobs.begin(home, "script", "s1", { waiting_on: "import" }, "", "importing");
    const share = jobs.begin(home, "share", "p1", { id: "x" }, "", "uploading");
    jobs.wait(home, script, dropped);
    jobs.wait(home, share, dropped);
    const started: string[] = [];
    // As serve.ts' resumers do: start long work and return, the row left running.
    jobs.useResumers(home, { script: (job) => void started.push(job.key), share: (job) => void started.push(job.key) });
    await Bun.sleep(5);
    await jobs.wake(home);
    await jobs.wake(home);
    expect(started.sort()).toEqual([script, share].sort());
  } finally {
    failure.PASSING_WAITS.value = waits;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// B (finding 2). Today: [[1,1],[1,1],[1,1],[1,1]].
test("a file on a dropped line is tried again after 1 minute, then 5, then 15, then 30", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-tries", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly";
    cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new Error(dropped) : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    const seen: [number, number][] = [];
    const note = (job: ScriptJob) => seen.push([job.files[1]!.tries ?? 0, Math.round((job.files[1]!.retry_at! - Date.now()) / 60_000)]);
    await start(fixture.app, id, false);
    note(await settled(scripts, id));
    for (let wake = 0; wake < 3; wake++) {
      // What serve.ts' case resumer does when the table wakes it.
      expect(carryOn(fixture.app, id)).toBe("started");
      note(await settled(scripts, id));
    }
    expect(seen).toEqual([[1, 1], [2, 5], [3, 15], [4, 30]]);
  } finally {
    fixture.cleanup();
  }
});

// C (finding 3). Today: [1, 5, 15, 30, 30].
test("an import that meets blips an hour apart waits a minute after each, not longer every time", () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "jobs-"));
  try {
    const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly";
    const key = jobs.begin(home, "script", "s9", { waiting_on: "import" }, "", "importing");
    const waited: number[] = [];
    for (let blip = 0; blip < 5; blip++) {
      const now = Date.now();
      waited.push(Math.round((jobs.wait(home, key, dropped)! - now) / 60_000));
      // Woken, it begins again (writer/imports.ts:619) and gets an hour further before the next blip.
      jobs.begin(home, "script", "s9", { waiting_on: "import" }, "", "importing");
    }
    expect(waited).toEqual([1, 1, 1, 1, 1]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// D (finding 6). Today: { state: "waiting", until: "person" }, no retry_at, and a restart takes nothing.
test("a failure read as the person's is looked at again, never parked where nobody is asked", () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "jobs-"));
  try {
    const key = jobs.begin(home, "archive", "p2", { output: "/x.mp4", key: "k" }, "", "uploading");
    jobs.wait(home, key, "its upload failed: the export has no bytes");
    const row = jobs.get(home, key)!;
    expect(row.until).toBeUndefined();
    expect(row.retry_at).toBeGreaterThan(Date.now());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
```

For finding 4, the words came from a ten-line script printing `failure.surely(words)` for each line listed there; every one printed `null`.
