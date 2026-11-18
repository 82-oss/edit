# Should Edit's footage become local-first? · independent review, 18 Nov 2026

Read-only review. Nothing was changed, committed or released. On the team's Macs I only read reports and cloud logs; no Mac took a live question (JJ's, Marc's and the M4 all timed out), so their numbers come from their latest reports, their shipped logs, and the disk listings saved from the M4 last night.

## Conclusions, ranked

1. **Yes, go local, but call it "local while in work", not "lives on the Mac".** Edit already downloads an active project's footage in full. It just keeps it in three to five overlapping forms and treats all of it as guesswork cache. The win is one form per source and no streaming on the path frames take, not a change in how many bytes sit on the Mac.

2. **The storage concern does not sink it, with one condition.** Per project, local-first as I'd shape it uses *less* disk than today: a 113-minute YouTube video is 1.8 GB as an original and 6–9 GB as today's preview copies. It does sink a 256 GB laptop if "whole on the Mac" means "kept until someone deletes it". Retention has to follow the project's state, automatically, with the cloud still holding every original.

3. **Disk filling is not caused by cloud or local.** It happened in the local era (Oct 18, Oct 21: 36 GB of cache), and in the cloud era (Nov 17: three ENOSPC bursts on the M4, 1,705 lines on kenobi). The cause both times is the same: derived copies with no ledger, a 1 GB free floor, and a cleaner that can't touch a project in use. Fix that first; it pays off whichever way the media decision goes.

4. **The proposal's proxy needs changing.** Today's proxy is bigger than most of the originals it stands in for (about 26 MB a minute against 2–20 MB a minute for YouTube footage). "Original plus one proxy" is right only if the proxy is one plain file, smaller, made locally from the original, and never uploaded.

5. **"One player" is mostly done already; finish it after the media change, not before.** Since Nov 6 the window's player and the export share decoders, mixer and compositor. What's left is full screen (still the page's player) and the server machinery kept alive for the page. Most of the native player's remaining faults are about where a picture comes from, which the media change removes.

6. **Leave Tauri alone.** The window is already a native layer under a see-through page. Replacing the shell rewrites the whole UI and touches none of playback, storage or imports.

7. **A shared Mac is not an alternative.** It is the same streaming problem with a home uplink in place of R2. A build box for overnight agent runs may be worth it later, for different reasons.

8. **Local-first will not fix imports' biggest failure**, which is YouTube refusing downloads, nor Vmake, the single effect-render slot, relay outages, or slow share uploads.

## Evidence and numbers

### What a source costs on disk today

Measured on mandalorian's dev cache, one long video (`youtube:OfywwsMVroM`, 113 min, 1080p):

| Form | Size |
|---|---:|
| Original (H.264 from YouTube, 2.1 Mbit/s) | 1.81 GB |
| Pieced proxy, picture (`video/`, 113 pieces, 25.9 MB/min) | 2.93 GB |
| The same pieces joined with sound (`joined/`) | 3.07 GB |
| Its sound (`audio/`) | 0.13 GB |
| The window's own copies on a Mac (`native2/`, ~26 MB/min of what plays) | up to ~2.9 GB |

So the preview forms of one video take 6.1 GB here and up to about 9 GB on a Mac that plays it all, three to five times the original. On top of that an export fetches stretches of the original back from R2 (`cloud/excerpts`: 12 GB in this dev cache).

Whole YouTube videos in the dev projects run 0.2–2.75 Mbit/s (ten samples); the proxy is a fixed ~3.5 Mbit/s. Edit asks YouTube for H.264 at 1080p or less (`youtube.ts:235`), which the Mac's decoder plays as it is.

### What a project costs

| | Originals | One proxy, whole, at today's rate | Source |
|---|---:|---:|---|
| Single-case edit (23 dev projects) | median 1.2 GB, range 0.1–5.5 | median 1.4 GB, max 7.2 (estimate) | project files' `cloud.size` and durations |
| 2-hour compilation (one sample: "Officers Traumatized…", 191 files) | 6.8 GB | 11 GB for its 432 min of long sources (estimate) | saved `project` answer from the M4 |
| Same compilation today | about 26 GB of pieces and proxies, inflated by the native-cut bug since fixed | | last night's log |

Other derived files per compilation, measured on the M4: export-ahead chunks 7.2–7.8 GB, smooth renders 0.9 GB, effects 0.4 GB, cleaned strips 0.9 GB, playback renders 1.1 GB.

R2 for comparison: 1,122 GB under `edit/` on Nov 11, $26–34 a month. Cloud storage is not the expensive part.

### The team's Macs

| Mac | Disk | Free | Edit's data | Notes |
|---|---:|---:|---:|---|
| Sphe's M4 Air | 245 GB | 12–18 GB (128 MB at 22:03 Nov 17) | 45 GB at that moment | about 150 GB is not Edit's |
| JJ's MacBook Pro | unknown | 112 GB | unknown | cleaner freed 71.5 GB on Nov 17, 23 GB by 09:00 Nov 18 |
| Marc's MacBook Air | unknown | 37–48 GB | unknown | cleaner freed 13 GB on Nov 17 |
| kenobi (8 GB M1, test) | — | 3–10 GB | — | not a teammate's |

- **JJ's Mac is the clearest sign the cache is guessing.** With 112 GB free, Edit caps itself at 50 GB (`storage.ts`), and in one day freed more than that whole budget while he opened at least five projects, each queueing its footage to "come down whole" again. I can't split how much of the 71.5 GB was re-downloaded footage and how much was export chunks.
- **The M4's problem is a full disk, not an architecture.** No design fits three 2-hour compilations plus overnight renders into 12–18 GB.

### How much work is in flight, and how often it moves

- New edit projects per week on JJ's Mac: 18, 17, 9, 5 (weeks of Oct 26 to Nov 16). Marc: 5, 5, 1, with 5 projects worked on in the last week.
- **Of 71 edit projects on the three Macs, none is on two of them.** Scripts are on every Mac; edits stay where they were made. The handoff that does happen is script to edit across people (last night: JJ's two scripts imported on the M4, 19 and 36 minutes each from R2). Caveat: a report lists what is on a Mac now, so a project opened elsewhere and since removed wouldn't show.

### The history says the same thing

- Oct 18–21: local previews fill disks. Oct 29: "everything on the cloud!". Oct 29–31: every R2 read from South Africa waits ~0.25 s; 21 fps and a 4.8 s freeze; "currently super laggy".
- Nov 2: work moves back onto the Macs. Nov 3: pieced proxies. Nov 6: native player, because a streamed preview took 3–8.6 s a frame to scrub; whole copies start coming down.
- Nov 8: the audit finds "the same proxy bytes kept in four forms" and agrees "footage kept local". Since then that has been built as more caches on a cloud-first model: blocks for all reads, three lanes, hedged reads, play holds, native piece copies, piece priming.
- Each fix measured well and the class came back. A picture can now come from five places (`docs/preview.md`), and each has its own cleaner rule, room claim and failure. `cloud_media.ts` has had 98 commits since Oct 17, `playback.ts` 70, `cache_cleanup.ts` 36.
- JJ's 23.6-minute export took 5 min 54 s cold; 2 min 19 s of it was fetching originals back from R2.

## A design that keeps storage bounded

**One form.** Per source: the original as imported, and at most one seek proxy as a plain file. Player, agent looks, export, removal and analysis read those two files. This removes pieced proxies, `joined/`, `native2/`, the stitched stream, playback blocks, sound copies and export excerpts.

**A smaller proxy, or none.** The one YouTube file I probed has keyframes 6–8 s apart, so scrubbing straight off an original would lag; jumps and plain playing should be fine. Measure on kenobi before deciding. If a proxy stays, make it viewer-sized (Sphe already accepted viewer-size preview on Nov 17), aim at or under the original's size, skip it for files with close keyframes, and don't upload it: on an 8 Mbit/s line an 11 GB proxy is three hours that a share then waits behind.

**Retention by project state, no settings.**
- In work (opened in the last few days, or an agent, export or removal running, or not yet in R2): pinned.
- Idle: derived files go first, then proxies, when room is needed.
- Done on Home, or idle a week or more: the whole project's footage goes, originals only once R2 confirms it has them. Opening it brings it back with a progress line.
- Evict whole projects, oldest first. Half a project is neither playable nor freed.

**A floor, not a share.** Keep the larger of 15 GB or 10% of the disk free; Edit may use the rest. JJ's Mac could hold three times what it's allowed; the M4 could not hold what it was given. Today's 1 GB floor let disk exhaustion reach project bookkeeping.

**Admission before the work, not ENOSPC during it.** An import, an open or an export adds up what it needs, evicts idle projects, and if still short says so in one plain line with the number. This needs one ledger of bytes by project and kind, per disk (Astra's finding 1).

**Derived files capped apart from footage.** Export chunks deleted after the join; one export-ahead per Mac and only on a settled edit; one local copy of an effect render.

**Rough capacity under this design** (estimates): a compilation in work is 15–20 GB, about 30 GB while exporting; a single-case edit about 3 GB. A Mac that can give Edit 60 GB holds three compilations or about fifteen single cases in work.

**What the cloud still does:** holds every original (which is what makes local copies safe to evict), hands scripts and projects between people, syncs projects, locks, lessons and reviews. Uploads run behind the import and never block it. The 30-day R2 rule, built and switched off since Nov 15, becomes the far end of the same lifecycle.

## Alternatives

- **Keep cloud-first and fix layers.** That is the last three weeks. I would not continue it.
- **External SSD for the smallest Mac.** Edit already copes with a cache on a removable drive. Cheap relief for the M4 now; not a plan for the team.
- **Shared Mac with big storage.** As a media server it streams over a home line to people in three countries. As a headless build box for overnight agent runs it addresses sleep, the full laptop disk and the one render slot, but it adds a machine to look after, and the Modal attempt (Oct 19 to Nov 2) ended on cost. Revisit after the media change.

## Order and risk

1. **Storage ledger, floor, whole-project eviction, admission, derived-file caps.** Days. Medium risk: deleting the only copy of something not yet uploaded is the failure to design against.
2. **One day of measurement on kenobi:** the native player straight off originals. Decides the proxy.
3. **Local media for new channel projects**, old projects left on today's path until they're Done. One to two weeks is my guess, not an estimate from a plan. Highest risk of the four, because eleven nightlies went out in three days under override; this one needs a canary on a real long project before the team gets it.
4. **One player:** native in full screen, the page's player off on Macs, then delete the smooth-render path. Linux and browser use lose their viewer unless a minimal one is kept for development.
5. **Tauri:** nothing.

## What I'm unsure of

- JJ's and Marc's disk sizes and how big Edit's data is on each: neither Mac answered.
- The compilation numbers rest on one project. The two built last night weren't measured.
- How much of JJ's daily 70 GB of evictions is footage downloaded again.
- Scrub speed off originals on an 8 GB M1, and the keyframe spacing across more than one YouTube file.
- Local proxy encode speed from a local file; the only figure in the code is "about 10 s a minute" when reading from R2.
- Download speeds on the team's lines. Only JJ's uplink (about 8 Mbit/s) is recorded, and time to first play after a handoff depends on the other direction.
- Whether an import of a local file can finish with the relay down. `putHashed` asks the registry first (`cloud_media.ts:912`); I read it, I didn't test it.
- How much of R2 is proxies and pieces that would become deletable.
