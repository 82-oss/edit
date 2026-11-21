# Council answer · Claude Fable 5.2 (Nov 18, 2026)

Read only: no code changed, nothing committed. Evidence is the three Macs' logs (JJ 30 h, M4 38 h, Marc 72 h), their latest reports, the code on main at `bcf95ff6`, and a few read-only timings on mandalorian's prod Edit.

**What the logs can and can't say.** JJ spent Nov 18 in Script mode (no plays, no agent turns, no exports), so his editing evidence is Nov 17, on nightlies 78–80. The M4's log ends Nov 18 09:12. Marc hardly used Edit: his last key press was 14 h before his report, with Premiere open beside it.

## The list, ranked by how much the team would feel it

| # | Change | Size | In 88? |
|---|---|---|---|
| 1 | A share reuses the export made ahead | hours | yes |
| 2 | The V1 agent stops forgetting mid-turn | hours + a day of measuring | yes |
| 3 | An import never stops or asks because of one file | hours, then 1–2 days | first part |
| 4 | Edit leaves room on the line while it uploads | 1 day, then 1–2 days | first part, if measured |
| 5 | The review copy goes up ahead, so Share is a link in seconds | 2–3 days | no, list |
| 6 | No false "Sign in to Edit" after a nap | hours to a day | yes |
| 7 | Stuck work starts again by itself | 1 day | yes |
| 8 | Lists answer from this Mac, not the relay | hours, then 2–4 days | first part |
| 9 | Background encodes step aside for play | hours to a day | check PR #1 first |
| 10 | Tools forgive the agent's near-misses | hours | yes |
| 11 | Updates install themselves when the Mac is idle | hours | Sphe's call |
| 12 | A lighter review copy and one cloud copy of an export | hours + 1 day | yes |

### 1. A share reuses the export made ahead

- **Today.** Edit exports ahead after an edit rests, so Share should take seconds. On Nov 17 it never did for JJ. All three real exports redid every chunk:
  - "Parents Had No Idea…": ahead made 14:59 (7 min 57 s); shared 15:16 → `1 of 60 chunks already made`, 7 min 50 s.
  - "Cops Surprise Fellow Officer…": ahead made 14:13; shared 15:24 → `0 of 117`, 10 min 31 s.
  - "49-Year-Old Mother…": ahead made 17:24; shared 17:31 → `0 of 124`, 10 min 02 s.
  - Nine ahead runs that day cost about 80 minutes of encoding and saved none.
- **Cause 1 (read in the code).** The ahead export is made without the watermark. `export_ahead.ts:44–48` takes the watermark from this project's last share, and a project's first share has none. `channels.ts:293` returns "none" in that case even for a channel project. Each real export logged `SC's watermark at 10%, moving` just before starting from zero.
- **Cause 2 (likely, not proven).** The cleaner removed the chunks. It freed 5.96 GB in one file at 13:27, 55 minutes after an 18-minute ahead export; 8.05 GB at 14:28 and 5.39 GB at 16:12, each just before an ahead run that found `0 chunks`. That was under the old 50 GB cap; 86 changed the rules, and no export has run on 86 yet.
- **Change.** The ahead export uses the watermark the share will use: the channel's mark, or for a V1 project the one this person last shared that kind of video with. Confirm on 86 that an in-work project's chunks and ahead file are never cleaned.
- **After.** Share or Export takes 15–24 s (measured Nov 9 with chunks ready) instead of 8–10 minutes.
- **Size / risk / 88.** 2–4 hours. Low risk: a wrong guess costs what every share costs today. Yes.

### 2. The V1 agent stops forgetting mid-turn

- **Today.** JJ's projects are V1, which compacts near 150k tokens (`claude.ts:171`). Right after a compaction a call still reads about 72k (`2 model calls … reading 145314 tokens`), so the standing instructions and tools take half the room and about 80k is left to work in.
  - 17 compactions on Nov 17 across three projects, each down to 5–13k tokens. Three fell inside one 15 min 35 s turn (13:53, 13:59, 14:02).
  - Edit then has to re-ask what was dropped: `the turn left 5 of the user's asks open; asking for them (2 of 3)`.
  - A Script mode run ("finishing") died the same way after 115 s: `Autocompact is thrashing` (Nov 17 18:38).
- **Change.** Give V1 the window V2 already has (`agent.ts:1189`). The M4, on V2, compacted 4 times in 38 hours of heavy use. Then trim the standing prompt: the tool reference is written into it (`agent.ts:2100`) on top of the tool definitions themselves.
- **After.** Fewer dropped asks, fewer re-reads of the edit, shorter turns.
- **Size / risk / 88.** One line, plus a day to run the same turn at both sizes. The risk is the reason the 180k limit exists: slower, dearer calls. The M4's log doesn't show it (31 s a call above 400k of context, 21–46 s below, tool time included), but that's different work, so measure. Yes for the window; the prompt diet is 1–2 days, later.

### 3. An import never stops or asks because of one file

- **Today.**
  - Nov 18 11:51: a case import stopped after 1 h 1 min of downloading on `Could not read _Extraction_1_1_07-0346-Rummel-Devon_Hall_Interview_wav` (`writer/imports.ts:1334` throws for the whole case).
  - Nov 17 16:57 and Nov 18 12:31: imports paused after 32 and 28 minutes "for a choice: … couldn't be imported; the other 2 are ready. Go on without it, try it again, or cancel." The second script still wasn't through in his 18:19 report, six hours later.
  - Marc's "Kai Cenat" import waits on him with 9 of 18 files missing.
- **Change.** One rule: an import finishes with what it has. A file that can't be read is dropped with a note, as the AVI path already does. A video that wouldn't download keeps being tried quietly and is added when it comes ("add footage later" exists). One line on the script says what's still missing. No question mid-import.
- **After.** Start an import, walk away, come back to a script.
- **Size / risk / 88.** The unreadable-file drop is hours and fits 88. The no-question rule is 1–2 days. Risk: a script written without a key recording, so the script agent must be told what's missing and offer a rewrite when it lands.

### 4. Edit leaves room on the line while it uploads

- **Today.** On JJ's Mac 2,048 cloud calls took over 2 s in 30 hours (median 3.5 s, a tenth over 24 s). His report says `relay: answers in 2662 ms` while a 2.6 GB script preview was going up; Marc's says 37 ms. At 15:19–15:21 on Nov 18 Home's lists took 23 s to 1 min 02 s and lock renewals timed out. Nothing in the server paces uploads; a share only goes first.
  - Script previews alone were about 14 GB in two days, roughly four hours of his whole 8 Mbit/s line.
- **Change.** (a) While someone is using Edit, background uploads take about 70% of the line, measured from the uploads themselves; full speed when idle or for a share. (b) Stop uploading a script's preview: another Mac makes its own from the original, the plan's rule applied to Script mode.
- **After.** Home, Ideas and the agent's cloud calls stay quick during uploads, and so does the rest of his internet.
- **Size / risk / 88.** (a) 1 day, low risk, uploads finish later while in use. (b) 1–2 days, belongs with the plan's step 3. **Not proven:** the M4 also logged 2,980 slow calls, so some of this is the relay's path to the database and not the line (see "Measure first"). (a) fits 88 if the measurement agrees.

### 5. The review copy goes up ahead (bold)

- **Today.** A share is upload-bound: on Nov 9 a 23.6-minute edit's link came 19 min 35 s after its export. After item 1 the export is seconds, so the upload is the whole wait.
- **Change.** Once an ahead export is made and the edit has rested about ten minutes, upload its review copy quietly (paced as in item 4). Share then only makes the link. A changed edit replaces it. Later, upload in segments so only changed parts go up again and the reviewer can start before it's all there.
- **After.** Share → a link in seconds, for an edit that sat for half an hour.
- **Size / risk.** 2–3 days for whole files, more for segments. Risk: wasted upload on edits still changing, so one upload per rest and review copy only. On the list.

### 6. No false "Sign in to Edit" after a nap

- **Today.** On Marc's Mac, about every 61 minutes from 06:37 to 14:21 on Nov 18, the hourly renewal's first try failed on a dead connection after sleep, and 8–19 calls went out without a token: `sync stopped: Sign in to Edit (401)`, lock renewals refused, and a project left under "Needs attention" with that error while he was signed in. JJ had it overnight and once in the day (15:20).
- **Cause.** `accounts.ts:122–130` hands callers no token while a renewal is under way, and they call anyway.
- **Change.** Calls wait up to ~10 s for the renewal; a closed-connection renewal is retried at once; a 401 during a renewal isn't recorded as a project's error or a stopped sync.
- **Size / risk / 88.** Hours to a day. Low. Yes.

### 7. Stuck work starts again by itself

- **Today.** Marc: an archive `given up: cut short by 3 restarts in a row`, still that way in his latest report. JJ: two imports wait for a Retry. Each needs a person or a remote unstick.
- **Change.** Work stopped by a restart, an outage or a sign-in lapse starts again by itself, hourly then daily, until cancelled. "Given up" is kept for what can't change (a deleted file). Paid sends stay out of it.
- **Size / risk / 88.** 1 day. Low to medium (retry storms: one at a time, backed off). Yes.

### 8. Lists answer from this Mac, not the relay

- **Today.** Home asks the cloud for its scripts every 20 s. Timed on mandalorian's prod Edit: scripts 0.8–2.5 s with one 13.5 s; projects and ideas 0.2 s. The relay's edge answers in 50 ms, so the time is the scripts query itself. On JJ's Mac that route was slow 642 times (median 3.2 s, worst 91 s), and Ideas failed outright five times when the relay dropped (`GET /api/ideas failed: 502`).
- **Change.** The server keeps the last list on disk, answers from it at once and refreshes behind. Then the same for projects, ideas, channels and reviews: one sync loop, and no page route waits on the relay. Separately, lighten the scripts query (it's in mamagi; I couldn't read it).
- **Size / risk / 88.** Scripts: hours, fits 88. The full mirror: 2–4 days. Low risk; lists can be a few seconds old.

### 9. Background encodes step aside for play

- **Today.** On Nov 17, 35 of JJ's 99 plays had the sound run short (up to 50 times in a 3-second play) and 14 passed over more than 30 frames. The worst sat beside encodes: 13:43–13:48 during an ahead export, 15:19–15:20 during a real one (`100 frames shown, 2548 passed over`). The ahead export checks for play only before it starts (`export_ahead.ts:114`).
- **Change.** An ahead export pauses within a second of a play or drag and resumes ten seconds after; a real export halves its encoders while something plays.
- **Size / risk / 88.** Hours to a day. First check whether PR #1 already does this, and that it still happens on 86.

### 10. Tools forgive the agent's near-misses

- **Today.** Wasted round trips in JJ's log: `unknown tool mcp__edit__delete_clips`; `report_problem` refused twice for a missing `tool` field; `highlight_evidence` refused for a rectangle past the edge; `revision conflict: expected 238, current 240` after a background save.
- **Change.** Answer an unknown tool with the right one's name; make `tool` optional; clamp rectangles; re-apply a plan when only background work changed the project.
- **Size / 88.** Hours each. Yes.

### 11. Updates install themselves when the Mac is idle

- **Today.** Marc is on 84 with 86 out. JJ updated by hand twice mid-afternoon on Nov 17, each a restart in the middle of his work.
- **Change.** After the canary, each Mac updates when idle 30 minutes with nothing running (`remote_actions.watchIdle` already does this on request). The button goes.
- **Risk.** A bad nightly reaches everyone overnight. Sphe's call.

### 12. A lighter review copy, and one cloud copy of an export

- **Today.** The review copy is 720p at 3 Mbit/s (0.55 GB for 24 minutes), and the export goes up twice in full.
- **Change.** Try ~1.5 Mbit/s on real edits, kept only if nobody can tell. Copy the export inside R2 instead of uploading it again.
- **Size / 88.** Hours plus a day. Yes.

## What to delete or hide

- **Settings › Updates › Channel.** One usable choice; "Stable" is disabled as "Soon". Remove the group.
- **The import's mid-way question** (go on, try again, cancel). Item 3 answers it for them.
- **Retry on things Edit can retry itself** (item 7).
- **The Update button**, if item 11 goes ahead.
- **The watermark choice on a V1 share.** Start it on the last pick for that kind of video; most people then never touch it.
- **Settings › Beta › Edit V2.** A channel project is V2 and a niche one V1, so check whether the switch still decides anything.

## What I'd measure first

1. **Why cloud calls are slow.** Log each relay call's name, its connect time and its answer time, with the upload rate at that moment, for one day on JJ's Mac. That splits his line from the relay-to-database path and decides item 4(a).
2. **Chunk reuse on 86.** One real share after an ahead export, with and without the watermark fix: chunks reused, and whether the cleaner touched the project.
3. **V1 at a bigger window.** The same edit turn at 180k and at 1M: wall time, cost, compactions, asks left open.
4. **Play during an export on 86**, on JJ's Mac: sound run-shorts and frames passed over, before and after PR #1.
5. **The scripts query in mamagi:** what it reads for a 52 KB answer.
