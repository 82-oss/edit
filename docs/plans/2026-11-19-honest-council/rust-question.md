# Would Rust have caught it? · Claude Fable 5.2 · Nov 19, 2026

Read only. I changed no code, committed nothing, and started no builds, tests or servers. I counted things in the code and the git history, ran one lint rule in its read-only mode to count with, and read the copies of JJ's answers and of this machine's own Edit log that were already on this disk. **(seen)** means I read it today, and where. **(inferred)** means it's my conclusion.

## The short answer

**No. Don't move the server back to Rust.** Of the failures the team hit this month, Rust's checker would have caught about one in fifteen. It would have made another one in nine a little less likely. For four in five it would have changed nothing: the code did exactly what it was written to do, and what it was written to do was wrong. Stop a slow cut after 12 minutes. Ask a person about a dropped line. Delete on "Go on without it". Give up after three restarts. A checker can tell that code agrees with itself. It can't tell that a rule is right.

Your instinct holds in one way. A rule a machine enforces gets kept, and a rule agents are asked to follow doesn't. That is worth using, on behaviour: the bad-day run, and the checks in section 5. It isn't a reason to change language.

Section 5 was added the same evening, for the free-space floor on JJ's Mac. That rule was mine, and so was the mistake.

## 1. This month's failures, in three buckets

- **Caught:** Rust's checker refuses the code, or the fault can't be written in Rust at all.
- **Less likely:** Rust's habits make it harder to write, but it passes the checker either way.
- **No change:** the code is correct as code. The rule in it is wrong, or the trouble is outside the code.

I took the 44 failures the council's answers name between Oct 21 and today, and put each in a bucket. The list is at the end, with a commit for each.

| Kind of failure | How many | Bucket | Why |
|---|---:|---|---|
| Trouble that passes was made final, or handed to a person: JJ's Wi-Fi import, "Go on without it", Marc's archive "given up", "Sharing stopped", ten ideas "skipped" | 11 | No change | Each was a written rule: two tries then ask, three restarts then give up |
| A limit in seconds or minutes stopped slow, healthy work: the 2-minute keyframe search, the 12-minute cut, a good cut refused for 0.6 s | 4 | No change | A number. Rust would hold the same numbers |
| One failure stopped a whole job: one unreadable recording out of 48 | 1 | No change | Rust's everyday way to pass an error up does exactly this |
| "Sign in" said to someone signed in: JJ's 13 hourly tries, Marc's stuck project | 2 | No change | "No token" meant both "signed out" and "being renewed". Rust's "maybe a value" has the same hole |
| Work remembered only in memory, or owned by several parts: retries lost at a restart, the Mac sleeping during removal, a full disk, an upload starting from zero | 8 | No change | Rust doesn't write memory to disk, and doesn't merge two owners |
| The wrong thing was built, or a copy wasn't checked: the crossfade on every cut, review copies 17 hours long | 2 | No change | |
| The shared checkout: lines staged in the wrong place, a file that didn't parse on main | 1 | No change | It's about how work is committed |
| Crashes and faults inside the engine and the player | 7 | No change | **This part already is Rust** |
| Two readers of what a failure means; a job left "exporting"; the page frozen for seconds; sync rounds overlapping; Bun itself crashing | 5 | Less likely | |
| A dropped line called "a bug in Edit"; a null read on the timeline; the remote script dying at start | 3 | Caught | |

**36 no change, 5 less likely, 3 caught.**

**A second count, to check the first.** I read every fifteenth commit since Oct 20: 119 of 1,777. Of those, 49 fix something that broke. Two would have been caught, eight are less likely, 39 no change **(seen: the commits; the sorting is mine)**. The two counts agree: about 5% caught, 10 to 15% less likely, 80% no change.

Four things say the same.

**1. The lines themselves are correct code. (seen)**
- **"Go on without it"** was one line that filtered the file's ranges out of the script (`script.ts`, before `6e1275e3`). Every type in it is right. And Rust did check JJ's project that night: every save goes through the Rust model's own check (`store.ts:768`, `edit-core/src/model.rs:2108`, "Agents write projects, so this runs on every save"). It passed, because a script with 19 fewer ranges is a valid script.
- **The sign-in loop:** `accessToken()` promised "a token or nothing" and returned nothing for the token's last 30 seconds (`accounts.ts`, before `20811f74`). The callers handled "nothing", as any checker demands. They handled it by saying "Sign in".
- **The unreadable recording:** `joinPreview` caught the failure and threw "Could not read …" (`writer/imports.ts`, before `2bd5405a`). In Rust that is one character, `?`, and it's the default.
- **The two readers** both had a typed list of kinds. One of them was written in Effect's typed errors (`effect/service.ts`). They disagreed about one thing: what to call a failure nobody recognises. Each said so in its own comment: "later" in one, "passing" in the other. Rust makes you choose a default too, and would have taken both.

**2. Edit's own Rust broke this month in the same ways. (seen)** A fifth of Edit's source is Rust: 48,195 lines, against 141,707 in the server.
- Of the 174 commits that touched Rust since Oct 20, 51% read as fixes by a crude word test. For the server's TypeScript it's 60% of 1,110. For each 1,000 lines added: 3.4 fixes in Rust, 4.9 in TypeScript. Lower, not different in kind. And the Rust does the easier job: the same frame in gives the same frame out.
- The Rust fixes are the same classes: a cancelled sound mix logged as an error 30 times a day on JJ's Mac (`6ac4ce95`); a reader that had failed put back in the pool and used again (`71e4ab4e`); a reader holding an old list of pieces (`b0959028`); the frame before a cut shown twice (`3befd844`); an export that crashed inside and hung instead of failing (`7df36996`); memory kept for good, until this machine's Edit was killed at 10 GB (`0735330b`).
- Every crash that took the whole server down came from this layer: the M4's abort (`e613c7d3`), the Mac trap in CI (`673f6017`, `79cfe1cf`), the window's crash on Escape (`91f5b2ca`). Rust's promises stop where it calls Apple's code and FFmpeg, and the engine does that all day.
- Its errors are plain text. About 200 of the 260 Rust functions that can fail hand back a sentence, not a kind. Typed failures are a choice in Rust, as in TypeScript, and the same agents didn't make it.

**3. The Rust server you remember had the same shape. (seen)** I read it at its last commit: 41,658 lines.
- About 250 of its 290 functions that could fail handed back text. It had no list of failure kinds at all.
- It read failures by their words: `error.contains("retry")` (`cloud_media.rs:1002`). It tried four times, 2, 4 and 8 seconds apart, then failed (`cloud.rs:469`). Its import marked the whole job failed if any file didn't come: "N of M files couldn't be downloaded" (`script.rs:1527`).
- On Oct 14 it needed its own fix for work left "working" for good after a crash inside it (`e4abdd18`).
- Nearly all of it was written between Oct 11 and 17. The first build the team got is tagged Oct 21, three days after it was deleted. **It never ran on JJ's or Marc's Mac.** So "it was safer when it was Rust" can't be known. It never had a bad day.

**4. Today's work passed the checker, then failed the bad-day run. (seen)** The main agent's 18 commits between 15:13 and 16:06 each passed the typecheck. By 18:44 the bad-day run had found eight things wrong in them (`e77516d9`, `aa0db540`, `ae50a999`): a 2-minute limit still applied to reading a cloud file's length; every cut stopped when the no-progress time got short; cuts sharing a slow line stopped at 30 seconds; the first try after a wake landed during the sign-in's renewal; a dead connection after the wake; a full disk with no number in its line; then the wrong words in that line. All of them are about time, order, sizes and words. A stricter checker passes every one.

## 2. What Rust would buy, and what it costs

**Why the server left Rust, from the commits. (seen, then inferred)** One evening, Oct 17: at 18:17 the build folders were moved onto the Mac's own disk and a one-line change was brought down to 8 seconds (`bb69cef6`). At 18:55 came a benchmark of that loop, at 18:58 the rewrite plan, at 19:02 the set-up for five agents porting at once, each in its own copy of the code. So it was disk, and also the wait after every change, and running many agents at once. No session log from that day is on this machine, so the weighting is mine. The plan named what it gave up, "fewer compile-time guarantees", and what it kept: the engine and the project's model stayed in Rust, and still are.

**What Rust would really buy**

| What | Evidence here | How much it's worth |
|---|---|---|
| Nothing runs unchecked. Bun runs TypeScript without checking it; the check is a separate step that gets skipped | Nine of the ten red Checks on Nov 11 were code pushed unchecked (the Nov 12 note; not re-read today). `exports.ts` didn't parse on main on Nov 18 (`2388963a`) | Real. So far it has cost red Checks, not the team's work, because releases wait for a green Check |
| A failure and a bug are different things by nature | A dropped line was called "a bug in Edit" 11 times on JJ's Mac (`b0212b58`) | One failure this month |
| No "trust me, this isn't empty" | Edit's Rust bans that shortcut and has 10 exceptions. The TypeScript allows it: 1,983 uses in the server, 532 in the page. Marc's broken clip drag was one (`625bfc6f`) | One failure, and it was in the page, which was never Rust |
| No faults from the order files load in | The remote script died at start on Nov 11 (`d52cbc32`) | One |
| Threads: one slow job can't freeze every request | The page stuck for 2 seconds, 32 times on Marc's Mac | Real, and Bun has workers for the same job |

**What it costs**

- **The wait after every change.** On Oct 17, after tuning, a one-line change to the 37,000-line server took 8 seconds on the M1, 45 seconds if it reached the core, and 10 minutes for a release build **(seen)**. The server is 3.8 times that size now. In TypeScript a change costs a restart. This machine is much faster than the M1; I didn't measure it, and I'd guess 10 to 40 seconds a change **(inferred)**. At 57 commits a day, every agent pays that on every try.
- **Several agents, one machine.** Rust locks its build folder, so agents sharing a checkout queue behind each other's builds. A folder each multiplies the disk. Rust builds are among the heaviest things a dev machine does, and this one froze twice on Nov 17 from running out of memory.
- **The disk problem didn't go away. It moved here. (seen)** Edit's Rust build folder on this machine is 47 GB today, for the fifth of the code that is still Rust, twelve days after the Linux port began. The disk it's on is 468 GB with 45 GB free: 91% full. The second disk has 677 GB free. And the Macs still build: GitHub's Macs for every release and every Rust check, a Mac for the hand checks in `docs/dev.md`, and the linked Mac whenever work is sent to it.
- **CI.** A push that changes Rust took Check from about 5 minutes to 18 on Nov 12 (the note from that day). Check skips the Rust when no Rust changed. With the server in Rust, every push changes Rust.
- **Rust only checks the kind of computer it builds for.** You build on Linux and the team runs Macs. Mac-only Rust isn't even read by the checker here. Three times this month, Rust that passed on one platform failed on the other in CI (`0e84fbb6`, `789ee749`, `f4160dba`). TypeScript is checked once for all of them.
- **Its strictness makes chores.** About half of the twenty-odd commits this month whose only job was to make a failed check pass were Rust formatting or lint, from a fifth of the code **(seen)**.
- **How agents write it.** I write correct Rust, more slowly. More of my mistakes are caught before the code runs, and that is the benefit. But most of what Rust's checker demands protects memory, and TypeScript can't have that fault in the first place. In a server that mostly waits on networks, disks and people, that is work with no pay. Waiting code in Rust also has its own trap: a job that is waiting can be dropped without a word when something else finishes first. That is "work cut short" again. I can't measure agents' error rates by language from this repo.
- **Today's own example. (seen)** One part of today's nine changes was left undone, 7e. The main agent's note at 16:45 says why: it "needs a field on edit-core's Media (Rust). Not done." Where the Rust begins is where today's work stopped.
- **The agent runs on a TypeScript library** (`claude.ts`, `writer/claude.ts`). I know of no Rust version and didn't look for one. That part would stay TypeScript or be built by hand.
- **A third rewrite.** 141,707 lines, and 56,410 lines of tests. The Oct 17 port was fast because it was told to copy behaviour exactly, with a harness comparing the two servers. So it copied the retry rules and the text errors across. A port back would copy today's rules into Rust the same way. Redesigning while porting is what today's nine changes already are, in TypeScript. Either way the quiet weeks start again from zero, and what the bad-day run proves about this code would need proving again. My first answer said Edit has been rewritten over and over, and that another rewrite run the same way gives the same result. This would be that.

## 3. Cheaper ways to get that safety in TypeScript

The server is already strict: the strict settings are on, and it has no "any type" anywhere **(seen: `tsconfig.json`, counted today)**. What's missing is small.

| What | Cost | What it would have caught in section 1 |
|---|---|---|
| Run the typecheck and lint before each commit, not after the push | An hour to set up, about 2 minutes a commit | The red Checks and the file that didn't parse. It's Rust's "nothing runs unchecked", almost free |
| Ban "trust me, this isn't empty" (`!`) in new code; the count may only go down | One lint line | Marc's clip drag |
| Every failure Edit raises has a kind; a bare error means a bug | `failure.ts` has the kinds since today. The server has 2,002 bare errors to sort, new code first | The dropped line called a bug. Half of the two readers. Today's leftover: Script mode can't tell its own refusals from unknown trouble |
| Make "a kind nobody handled" fail the check: one lint setting lets a catch-all stand in for a new kind | One setting, then fixing what it flags | Nothing on the list. It keeps the one rule one when a ninth kind is added |
| Separate names for look-alike values: a path, a cloud address, a file's id | Small, in the few places they meet | Nothing on the list. This week's strip that became a web address (`6bb32205`) is this class |
| Check a saved file's shape when reading it (239 of 264 reads trust it as read) | One helper; start with `jobs.json` | Nothing yet. It matters when Marc's Mac comes up from nightly-84 with old rows |

**Not Effect everywhere.** It came in on Nov 1, when you asked for it, and reached 21 of 235 server files that day. Today it's in 19 of 363 **(seen)**. 128 files were added since, and none uses it. One of the two readers that disagreed was the Effect one. Typed errors don't help when 5% of the code uses them. Leave it where it is. Don't spread it or pull it out during the freeze.

**The honest sum.** All of these together catch the same 3 of 44 that Rust would, and help with 2 or 3 of the 5. They cost days and none is a rewrite. The other 36 need the bad-day run, the census of questions, and section 5.

## 4. My recommendation

Don't move the server back to Rust, and don't move parts of it. Keep the line where it is: Rust for the engine, the player and the project's model, where exact, heavy work earns a checker its keep; TypeScript for the part that waits on networks, disks and people. Change nothing about language before or during the stabilising work and the real-Mac runs, because a port would restart every clock. Do two things now, since they change no behaviour: the check before each commit, and the two lint settings. Give every failure a kind after the two quiet weekly counts, through the bad-day gate like any other change. Look at this again only if those counts show that what's left is mostly faults a checker catches (empty reads, wrong shapes, a failure taken for a bug). Today that is under one in ten.

**What would change my mind**
- The weekly counts after the freeze show that more than a third of what's left is the "caught" kind.
- A measured trial. Port one small part (the job table) to Rust on a branch, with four agents working on this machine at once, and measure seconds per change, the build folder after a week, and Check's time. I expect it to lose. I haven't measured it.
- The server itself takes on heavy, exact work that today lives in the engine.

## 5. Added the same evening: the free-space floor on JJ's Mac

### What happened, and my part in it

- **The rule:** Edit keeps free "the larger of 15 GB or a tenth of the disk" (`storage.ts:35`, `keepFreeBytes`; shipped Nov 18 in `6e2fd4b5`, nightly-86). About twenty places in a dozen files read it **(seen)**.
- **It's mine.** `review-fable.md:90`, Nov 18: "Keep the larger of 15 GB or 10% of the disk free… JJ's Mac could hold three times what it's allowed." Thirty lines above it, my own table gives JJ's disk as "unknown", with 112 GB free that morning. I proposed a share of a disk whose size I hadn't read.
- **JJ's Mac today**, from its own answer at 18:47: a 494 GB disk, 41 GB free, 25.8 GB of memory **(seen)**. A tenth is 49 GB. So Edit counts his disk as full.
- **What that does. (seen in the code and in his Mac's answers)**
  - Copies kept to play sooner stop being kept, so long videos stream.
  - Script mode's recordings aren't kept on his Mac either, so they're read over the network: the slow path. Whether that is why today's cuts on his Mac tripped their limits I can't show. I don't know his free space at 11:00.
  - The footage dialog's answer for his project: all 2.0 GB counted as here, 79 of 97 files, 18 marked as never coming, and still "not ready", 145 seconds to go, with the line "Only 2.0 of the 2.0 GB fits on this Mac". It will say that for as long as it's asked.
  - Nightly-90's rescue, "download it here and cut it", refused his 5.5 GB file: "There isn't room on this Mac".
- **My second miss, today.** I quoted that exact line in `final.md` (section 1) and read it as a full disk. I never looked at his free space. Then, in changes 5d and 6, I made "no room" a wait with the line "Needs 5.5 GB free on this Mac". On his Mac that wait can't end by itself, and its number is wrong: he would have to free about 14 GB, 8 to get back over the floor and then 5.5.
- **Machines saw it and stepped round it. (seen)**
  - Every unit test is handed a disk with 1,000 GB free unless it sets its own (`test/setup.ts:55`).
  - The bad-day harness does the same, and says why: "this machine's own sits on Edit's keep-free line (a tenth of 468 GB)" (`inside.ts:60`). So the bug was met on this machine today and treated as noise in the test.
  - This machine's own Edit logged at 18:36 that it is clearing files "to keep 50 GB free", with about 45 free.
  - By my Nov 18 table your M4 has been under its floor since the rule shipped: 12 to 18 GB free against 24.5.
  - The report's "disk is low" warning fires under 5 GB (`remote_actions.ts:77`), a tenth of JJ's floor. His report said nothing.
- **Today's patch for the Midland file** (another session's, not committed) fixes one of those twenty places. Its comment and its test call JJ's Mac "a 1 TB Mac with 50 GB free". His Mac says 494 and 41. I didn't find where the 1 TB came from.

### 1. Its Rust bucket: no change

The rule is one line of arithmetic, and it would be the same line in Rust. Every value in it has the right type: 49 GB is a perfectly good number of bytes. No checker knows what a disk is, how big JJ's is, or whether a wait can end. And today's typed kind, `room`, is what turned a refusal into an endless wait. The type was right, and it spread the fault. With this one the list is 45: **37 no change, 5 less likely, 3 caught.**

### 2. The main agent's proposal

**A file of the team's real Macs, from their reports.** The right idea. The tests' disks are invented (1,000 GB free; 100 GB, 1 TB and 2 TB disks), and even today's fix invented JJ's. Two corrections.
- **The reports don't carry what it needs. (seen: `remote_actions.ts:338`)** The five-minute report has free space, memory and cores. It has no disk size (that is why my table said "unknown"), no line speed, no file sizes, and not what Edit itself holds. Add those five first. It's a small change.
- **"Kept current" pulls against "in Check on every commit".** If the file changes by itself, the same commit passes today and fails tomorrow. Update it with a named daily commit ("JJ's Mac: from 112 to 41 GB free"), so a red Check points at the Mac and not at whoever committed last.

**Would it have caught this? Not on the day.** On Nov 18 JJ had 112 GB free, so his line passes. The M4 and kenobi fail, and they would have been waved through: they really are full, and streaming there is the design. JJ went under the line a day and a half later, and the rule itself helped put him there: it says Edit may use the disk down to the floor. A file that follows the Macs goes red once a Mac is already in trouble. That beats a screenshot from JJ by hours. It doesn't prevent anything.

**A test of every rule with a number, and "every wait names what ends it".** The wait rule is the best part of the proposal. Today's `room` wait fails it at once on JJ's line: nothing Edit does ends it, and doing what its line says doesn't end it either. It also covers Marc's "given up", the import waiting since Nov 10, the stuck "Sign in" and the job left "exporting". Two limits.
- **A test has to be told what right is.** At the floor, streaming was the intended behaviour, so a test of the floor passes. It fails only if someone wrote "JJ's Mac with 41 GB free must be able to keep a 5.5 GB file". So the numbers must be tested against the team's work: a 6 GB file, a 53 GB case, a two-hour compilation.
- **"Every wait" has to include waits outside the job table.** The footage dialog is a page asking every second. It needs its own rule: an estimate falls, or it's withdrawn.

**In Check on every commit.** Yes, for everything that doesn't move by itself: the rules, the waits. It only binds if nothing ships past a red Check, and 16 of the last 60 Checks were green **(seen today)**.

**A day on your own Macs first.** Keep it, but alone it would not have caught this. Two of your machines are under this floor, the M4 since the rule shipped, and nobody noticed: a Mac that looks full and streams looks normal, "Open now" is one click away, and the only trace is a quiet line in a log. A day's use finds what someone, or something, is looking for.

### 3. What I'd add or change

1. **Test the sizes that don't change against every state they can be in.** A Mac's disk size, memory and line are fixed, and they belong in the file. Free space and the line's mood move. Test those across the whole range, empty to full and dead to fast. At each point the work goes on, or stops with a line that is true, names what ends it, and is enough: do what it says, and the work goes on. A disk sitting at the floor is the everyday state of any busy Mac under this rule, so it is the first point to test, not an edge.
2. **Three rules of scale, written once and run over every number.** More free room never gives a worse answer. A bigger disk with the same free room never gives a worse answer. A slower line or a bigger file makes work longer, never stopped. The floor broke the second on the day it was written: with 50 GB free, a 5.5 GB file is kept on a 256 GB Mac and refused on a 494 GB one. This week's three time limits broke the third. These need no file of Macs and can't go stale.
3. **Each Mac checks itself.** At start and in its five-minute report, Edit runs its own rules against its own disk, memory and measured line, and puts what it can't do under "Needs attention": "Edit keeps 49 GB free here and 41 are free: footage streams, nothing is kept." That covers a Mac nobody listed and a disk that changed an hour ago.
4. **A watch on waits that aren't moving.** Anything a person or a job has waited on for five minutes with nothing changing (the same estimate, the same bytes, the same reason on a third try) goes into the log and the report by itself. It needs no list of waits. It would have reported JJ's dialog, the 13 sign-in tries, and the M4 on Nov 18.
5. **A changed number comes with what it means on each Mac, in plain words, in the commit.** The test prints it and the agent pastes it: "JJ: keeps 49 GB free, has 41, so everything streams." You would have stopped that in five seconds. So would I, if I'd had to write it.
6. **Numbers that must agree are tested together.** The sign-in loop was four numbers in two programs: the token's hour, the 30-second renewal, the relay's 60 seconds, the hourly retry. One test puts them on one clock.
7. **Make one of your Macs JJ's.** His headroom, his 8 Mbit/s line, his real cases. The day's use runs there, and it passes only if the watch in point 4 stayed quiet.

I'm not offering a new number for the floor. A number chosen by reading is how this began. Whatever replaces it should be picked from the per-Mac lines of point 5 and pass the three rules of point 2.

### How much each approach would cover

From the same list, now 45. These are my own sortings, and hindsight flatters every test: a check catches what it was told to look for. Halve them, and the order stays the same.

| Approach | Failures it would likely have caught before the team |
|---|---:|
| Rust's checker | 3, with 5 more a little less likely |
| The proposal as written | about 12 |
| With the seven additions | about 20 |
| With the bad-day run and the census of questions too | about 34 |
| None of these | about 10 |

**What still gets through:** the wrong thing built (the crossfade), anything between two Macs, crashes inside the engine, taste, and a rule that sounds right and nobody thought to state. Point 5 is my answer to the last one. A person who knows the team reads one plain line for each Mac before a number ships.

Rust asks whether the code agrees with itself. The bad-day run asks whether it survives time and trouble. This section asks whether the rule is right for the machines the team has. Nearly all of this month's failures are the second and third questions.

## What I didn't check

- I ran no builds or tests. I didn't time a Rust build on this machine: the 10 to 40 seconds is a guess.
- The sorting into buckets is mine, read from commit messages. The sample is 49 fixes, which is small. Of the 44 failures, I re-read about 30 as commits today. The rest are as the other council members reported them: Marc's crash on Nov 11, his import waiting since Nov 10, his page stuck for 2 seconds, the cleaner's seven rounds, the revision conflicts.
- The counts of "functions that can fail" and of the `!` shortcut are pattern counts, close but not exact. The page's 532 includes its tests.
- "Reads as a fix" is a crude word test, applied the same way to both languages.
- No session log from Oct 17 is on this machine. Why the server moved is read from the commits.
- I didn't look for a Rust version of the agent's library.
- For section 5 I asked JJ's Mac nothing. I read today's copies in `/tmp/edit-remote`. I didn't trace every path that waits there: that the Script mode import waits for good is the other session's finding, and I saw only the checks it goes through. Marc's disk size is still unknown. Disk sizes are as each tool printed them, and I didn't settle GB against GiB.

## The list behind the counts

**No change (37).** Trouble made final or handed over: two tries then ask and "Go on without it" (`6e1275e3`); the fix reaching one import of two; Marc's archive given up (`5ec56099`); "Sharing stopped" (`5044e6c4`); Marc's import waiting since Nov 10; ideas skipped as "no captions" (`a41d04d7`); YouTube's refusal taken as final (`471b2142`); an edit made with no channel (`9f4c76b6`); a Vmake piece paid for twice (`380756f6`); exports cut short by restarts, five rounds. Limits: the keyframe search and the 0.6 s check (`30a17052`); the cut (`ed831188`); a minute-long check on a YouTube original (`597f55ae`). One failure stopping all: the unreadable recording (`2bd5405a`). Sign-in: JJ's loop and Marc's project (`20811f74`). Memory and owners: retries on timers (`70647b64`, `74afca38`); the Mac sleeping during removal (`d2d1e0c2`); a paused import carried on by another Mac (`a0e76d76`); blank stills pushed on a full disk; the cleaner's seven rounds; 309 "no space left" on the M4; the revision conflicts; JJ's 2.6 GB upload from zero (`67abe713`). Built wrong: the crossfade (`15eedd14`); 17-hour review copies (`44d91f47`). The checkout (`3038ff96`, `2388963a`). Inside the engine and player: the M4's abort (`e613c7d3`); Marc's crash; CI's Mac trap (`673f6017`, `79cfe1cf`); the crash on Escape (`91f5b2ca`); this machine's Edit killed at 10 GB (`0735330b`); the cancelled mix logged as an error (`6ac4ce95`); the engine's FFmpeg without certificates (`cb307998`). And the free-space floor (`6e2fd4b5`).

**Less likely (5).** The two readers (`73323afc`); the job left "exporting" (`9048f83a`); the page stuck for seconds; sync rounds overlapping (`b6e68253`); Bun crashing under load (`47ec889e`).

**Caught (3).** A dropped line called "a bug in Edit" (`b0212b58`); the null read on the timeline (`625bfc6f`, `f36cfafd`); the remote script dying at start (`d52cbc32`).
