# Can it go faster than three weeks? · Claude Fable 5.2 · Nov 19, 2026

Read only, as before. I changed no code, committed nothing, released nothing, restarted nothing, and ran no tests or builds. I re-read the five council answers. Then I read JJ's shipped log from Nov 11 up to 14:40 today, the release tags and a few files of code. Times are ours; JJ's clock is an hour behind. **(seen)** means I read it today. **(my estimate)** means my own arithmetic or judgment.

## The short answer

**You're right about the code, and I priced the plan wrong.** I counted about three weeks of building. At this team's pace the building is three or four days.

**But Edit can't be stable by tomorrow in the sense you mean, and speed isn't the reason.** The reason is that nobody can know it by tomorrow. Only two things can tell us Edit is stable. One is kenobi having JJ's worst day, and one run of that takes a night. The other is the team working on a build that doesn't change, and that takes weeks. An agent can write a fix in an hour. It can't make JJ's line carry 6 GB any faster, and it can't make a week go by.

What is honest:
- **Tomorrow:** Edit stops changing under the team, and we have the first bad-day result.
- **Monday, Nov 23:** the team gets the first build that has been through a bad day.
- **Monday, Dec 7:** the earliest day anyone can say "stable" and mean it. If not then, Dec 14.

The three weeks were never for building. They were for finding out. I can't shorten that part, and I'd only be pleasing you if I said I could.

## 1. What is code, and what is the clock

| Part of the plan | What sets its pace | Honest time |
|---|---|---|
| The team held on one build | a decision | tonight |
| One branch per task, no forced builds | a decision | tonight |
| The census of questions | reading, then code | the list tomorrow, its fixes a day later |
| Building kenobi's bad day | code, plus errands | one to two days |
| **One bad-day run** | **JJ's line and JJ's files** | **a night** |
| One failure rule, one job table | code: a day or two. Proof: a night for each kind of job | about a week |
| Footage on the Mac | code: two or three days. Proof: nights, then real projects | one to two weeks |
| The weekly count | the team's use | a week for each number |
| The verdict | two or three counts | Dec 7 or Dec 14 |

**The code is fast. (seen)** The server was rewritten in two days (Oct 17 to 18). Script mode came in whole in one (Oct 29). The big-file fix was committed at 12:31 today and was at work on JJ's Mac by 13:35.

**A bad-day run is slow, and it has to be. (seen, then my estimate)** From JJ's log, Nov 11 to 19:
- 26 Script mode imports finished. They took 9 minutes to 2 hours 17 minutes. Half took more than half an hour.
- 15 imports into the editor finished. They took 2 to 49 minutes. Half took about 20.
- His exports took up to 18 minutes.
- On Nov 9 his share link came up 20 minutes after the export, and the full-quality copy an hour after (the Nov 10 note on his log).
- His biggest file this week is 6.3 GB. At 8 Mbit/s that is 105 minutes just to move it once.

Add what we break on purpose: Wi-Fi off for 2 minutes and for 20, the lid closed, a force-quit, an update, and a sign-in that runs out (they last an hour, `accounts.ts`). One case from start to finish is two to four hours. Three cases are a night. So we learn what broke about twice a day on each test machine, however many agents are writing.

A shorter run on small files would pass, and it would prove nothing. That is the check Edit has today. The limits that stopped JJ this week only trip on his real files over a slow line.

The errands are real time too: copies of JJ's three hardest cases in a test folder, room on kenobi's disk, and a way to slow its line.

**A week of the team is a week. (seen, then my estimate)** JJ finishes about 30 imports a week (41 in the nine days of log). At that rate one week can't tell "95% finish alone" from "99%": it's one or two failures against none or one. Three weeks can: about five against about one.

His log also shows why one good week proves little. From Nov 11 to 17 he started ten imports into the editor. All ten finished, and nobody was asked anything. Then, on Nov 18 and 19, an import stopped to ask him four times in two days. By that count, the week before had looked stable. What changed was the footage and the night: a 2.5-hour interview, a 6.3 GB file, a bad line. That is why kenobi has to have the bad night on purpose. We can't wait for JJ to have it.

The same holds for breakages **(my estimate)**. If Edit were still breaking three times a week, one week in five would show one breakage or none, by luck. Two such weeks in a row would be luck one time in sixteen. So two quiet weeks is the least that means anything.

A head start on today's number **(seen)**: in those nine days 41 of JJ's imports finished, and an import stopped to ask him 11 times over a file that hadn't come in. Seven of those were in Script mode and four in the editor.

## 2. The fastest honest version

| When | What happens | What you'll know |
|---|---|---|
| **Tonight, Thu Nov 19** | JJ and Marc go onto one build and are held there. One branch per task starts. Agents start building the bad day and reading for the census. | Nothing new yet |
| **Tomorrow, Fri Nov 20** | The census list is done and its fixes are written, on a branch. Kenobi has its first bad day, or at least the import half of it. | The first list of what a bad day breaks, found by a machine and not by JJ. I expect it to fail. Also today's number: how often a job finishes alone |
| **Sat Nov 21, Sun Nov 22** | Fix, run, fix, run. Three to five runs. | Which checks pass |
| **Mon Nov 23** | The team gets build 1 | |
| **Week of Nov 23** | One failure rule and one job table, one kind of job a night, imports first. Footage on the Mac, built on a branch and tried on kenobi. The bake-off against Claude Desktop and Premiere | **Mon Nov 30: the first count** |
| **Mon Nov 30** | Build 2: whatever passed its nights | |
| **Mon Dec 7** | | **The second count.** Two weeks in a row at one breakage or none: say "stable", and new features start again |
| **Mon Dec 14** | Only if needed | The third count, and the stop-or-go decision from my first answer |

**How to hold the team tonight.** Edit already has the switch: Settings, Updates, Stable. A Mac on Stable isn't offered nightlies (seen in `update.ts`; I didn't test it, so try it on kenobi first). Nightlies then go only to your Macs and kenobi. The team's Monday build becomes a release. That path was last used on Oct 21, so the first one needs a dry run.

I'd hold them on nightly-90. It's the first build with both import fixes, and Marc moves up from 84.

**Build 1 has a bar, not a date.** It goes out when it's no worse than the team's build on every check of the bad day, and better on at least one. I think Monday is likely. If nothing clears the bar by Monday, the team's build doesn't change that day. Nothing is forced.

**Your part:** say "freeze" tonight and make the worktrees. Each Monday, read the count and approve the build. For each ask, use the one question in section 3.

**Is "stable by tomorrow" possible? In one sense, yes.** From tomorrow, Edit is the same every morning. That is worth more than it sounds. JJ's Mac ran nine different builds between Nov 16 and today (seen: his log's headers), and every update cuts the long jobs that are running. In my first answer I put about a quarter of the team's pain down to that alone.

**In the sense you mean, no.** "It survives JJ's worst day" needs kenobi's runs to pass. That's the weekend at the earliest. "The team has stopped hitting breakages" needs the counts. That's Dec 7 at the earliest.

**Today's build shows why. (seen)** Nightly-90 went out at 13:31. It's the first build with the Wi-Fi fix and the big-file fix.
- At 13:35 it woke JJ's two waiting imports by itself.
- At 14:07 it met a "Sign in to Edit" error just after a restart, though he is signed in. It tried again by itself. The new rule held.
- At 14:09 the Scissors Attack import, stuck since last night, finished. The fix worked.
- But JJ's Mac has been trying to bring in one file of the Genius Killer case since 11:51. On nightly-89 it stopped to ask him twice. On 90 it hasn't asked. It also hasn't come in. The latest failure, at 14:25: "Cutting an excerpt took more than 16 min and was stopped".

That file had been failing in his log since 12:09, with the same kind of line. The fix was written from last night's video and committed at 12:31. The build left at 13:31. Nobody could have said then whether 90 covered it. An hour later JJ's Mac says: one import yes, one not yet. Saying "stable" tomorrow would be the same kind of sentence.

It's also the third of Edit's own limits to stop one of his big files in two days: two minutes to find a keyframe, a check that refused a good cut for running 0.6 seconds long, and now the time allowed to cut an excerpt. Each was met by a different video of JJ's, and each was found by JJ. One night on kenobi with his three hardest cases finds them together. That file should be the first test case.

**What can only be known later**
- Whether the team's breakages are down to about one a week: Dec 7 at the earliest.
- Whether keeping footage on the Mac keeps the disks healthy: after a week or two of real projects. The old path isn't deleted before that.
- Whether Edit beats Claude Desktop with Premiere: when the bake-off has been run. It's the only thing that can settle the "stop" question. It needs people, not code, so it can be done next week.

## 3. Small asks during the freeze

**Ask one thing: "If this goes wrong, what's the worst that happens to someone's work?"**

| The answer | What to do | Examples |
|---|---|---|
| "Nothing. It looks or reads wrong." | Yes. It rides in Monday's build | Wording, a label, a colour, where something sits, hiding a thing nobody uses |
| "An edit could come out worse." | Yes. If a channel lesson can do it, teach it today: that isn't a change to Edit. Otherwise Monday's build, after it's been tried on a real project | How the agent cuts, a style, a pace |
| "A job could stop or start over. A video could come out different. Something saved could change." | It waits, however small it sounds | Anything in imports, footage, playback, export, share, removal, sign-in, updates, or between two Macs. Anything that runs by itself in the background. Anything new on screen that a person has to choose |

Three rules go with it.
1. **You don't have to judge it yourself.** Before any work starts, the agent answers three things, a line each. Does it touch footage, or a job that runs longer than a minute? Does it change what's saved, or what an export looks or sounds like? Does it add a choice for the person? One "yes" and it waits.
2. **No ask gets a build of its own.** They all ride on Monday.
3. **The one exception is lost work.** That means: something a person made is gone or wrong, a job has to be started again by hand, a job can't finish at all, or something was paid for twice. That fix goes out as soon as it has had its run on kenobi. Within a day, not within the hour.

**Why the third row is strict. (seen)** JJ's audio crossfade was a small ask. It went out on Nov 11 as nightly-72, "a nightly of that change alone", and it crossfaded the sound at every cut between footage, in every video. Nightly-73 followed two hours later to put that right. It sounded like the first row. It was the third: it changed what every export sounds like.

So I'd add one check to kenobi's run: the same saved edit gives the same video on the new build as on the team's build, unless the change was meant to alter it. The crossfade would have failed that.

A paper cut in the third row goes on a list. It doesn't get its own patch. The job table and local footage replace the code it lives in, and patching one case at a time is how we got here.

**One thing to settle tonight. (seen)** As I write, 19 files in the shared checkout are changed and not committed. All of them are text and watermark removal, with 523 lines added. I don't know what was asked. Removal is third-row work: it runs for hours and it changes the picture. If this repairs lost work, it fits. If it makes removal better, it's a new feature, and the freeze hasn't started yet.

## 4. What I'd change, and the real risk

**What I'd change**
1. **The price.** Building is three or four days, not fifteen to twenty-one. The rest is nights and weeks.
2. **Build early, then watch.** In my plan the big changes landed across all three weeks, so the last one would have reached the team with no quiet week behind it. With code this fast, do the building in the first week. Then the weeks after it measure the finished thing.
3. **More test machines, not more agents.** Writing isn't the slow part any more. The runs are. A second machine having a bad day each night doubles the pace: your M4, or mandalorian with its network fenced off and its memory capped. More agents writing doesn't change it.
4. **Two bars, not one.** A build may reach the team when it's no worse than theirs on every check and better on at least one. "Stable" is said only when every check passes and two counts are quiet. The first runs will fail in several places. Waiting for all of them would hold back fixes that are plainly better.
5. **"Fixed" waits for the run.** Write the fix as fast as you like. Nobody calls it fixed until the run that showed it failing shows it passing.
6. **The bake-off moves up** to next week.

**What I wouldn't change:** the team held on one build, one build a week, no forced builds, the counts and the stop condition.

And one thing I should have said more plainly the first time. Only "no new features" is temporary. The bad-day run, the weekly build and one branch per task are for good. When features come back on Dec 7 or 14, they come back through them.

**The real risk of compressing it**

"Write it all tonight, ship it tomorrow, call it stable" isn't a new plan. It's the last thirty days.
- **Fast writing was never the problem. (seen)** The server took two days to write. Since then, about 750 of the last 30 days' 1,730 commits read as fixes (the brief's count). Writing took days. Finding out took a month, and the team did the finding.
- **Builds leave faster than the thing they fix can run. (seen)** There were 89 builds in 30 days. Nightly-88 and 89 went out 22 minutes apart, at 23:20 and 23:42 on Nov 18. One import on JJ's Mac takes longer than that.
- **Each fix is written from the incident in hand.** That was claim 5 of my first answer: the Wi-Fi fix told the story as a dropped connection and left out the limit that failed first. Today's case is in section 2.
- **Agreeing in principle has been tried. (seen)** The Nov 18 plan says "a nightly at most once a day, each after a canary on kenobi". By that evening the kenobi check was dropped. Nightly-87 went out at 20:38, forced: "JJ is away and needs them". JJ's three hours began on it at 22:05. To be fair, that check had no slow line and no Wi-Fi cut, so it wouldn't have caught his night. But the rule lasted less than a day. The one-a-day rule was overridden 18 times in 19, each time with a reason that sounded good: "JJ is away and needs them", "for the team overnight". That is why section 3 is a rule with a check behind it, and not a promise.
- **The cost isn't a bug. It's the team.** JJ had V2 switched off today. Marc has Premiere open. If tomorrow's build is called stable and one night next week goes like Wednesday night did, the next thing the team stops believing is the word.

## What I didn't check
I ran no tests, builds or servers. I read JJ's log through the read-only log reader, which keeps its copy in `/tmp/edit-remote`. I counted jobs in JJ's log only, not Marc's. I don't know whether the Genius Killer file came in after 14:40. I didn't test the Stable switch. Kenobi's last report here is from Nov 17, with 3.2 GB free; the Nov 18 plan says 24 GB after a clean, and Edit keeps 15 GB free, so its disk needs clearing before it can hold JJ's cases. The run lengths and the odds are my arithmetic, not measurements.
