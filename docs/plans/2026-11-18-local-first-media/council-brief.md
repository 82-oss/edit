# Council brief: what would make Edit feel smoother and cleaner to the team (Nov 18, 2026)

You're one of two independent reviewers: Claude Fable 5.2 and GPT 6.2 Astra. You won't see each other's answer. **Read only. Change no code, commit nothing, release nothing.** Write your answer to the file named at the end.

## The ask (Sphe, who builds Edit)
"Further areas in which we can make things a lot smoother and cleaner for the users. Could be anything, really." He wants improvements the team will **feel**: less waiting, fewer stuck or confusing moments, less to think about. Novel ideas are welcome, not only bug fixes. Ship-sized items go into nightly-88; bigger ones go on a list with a size.

## Who uses Edit and how
Read AGENTS.md (Sphe's principles: quality + speed, reliability, minimalism) and app/AGENTS.md (the code's map).

- A small team makes true-crime and bodycam YouTube videos. **JJ** (MacBook Pro, Norway, ~8 Mbit/s up) works in it all day. **Marc** uses a MacBook Air. **Sphe** has an M4 Air with 245 GB and little free space.
- Their day:
  - **Script mode:** import a case from a Drive folder, YouTube or a compilation, then an agent writes the script.
  - **The editor (V2):** an in-app agent cuts the video and writes effects as code; channels with lessons decide the style.
  - **Then:** text removal (Vmake), export, and a share link for review.
- **The app:** a Tauri shell, a Bun/TS server, a React page, and a Rust engine with a native player in the Mac window. Footage lives in R2, with copies on the Mac.

## Evidence to use
- **The team's Macs, read-only:** from `app/`, run `bun apps/server/scripts/remote.ts devices | latest <mac> | logs <mac> since=24h [grep=…] [level=warn|error] | crashes <mac> | reports`. Macs: `mathiass-macbook-pro` (JJ), `macbook-air-von-marc-2` (Marc), `siphesihles-macbook-air-m4` (Sphe). Don't use `sh`, `call`, `agent`, `restart`, `update`, `say` or `help`: those change things or show on their screens.
- **docs/plans/2026-11-18-local-first-media/:** plan.md (the media plan and its log), the morning's stability audit, two reviews of the media question, and the originals measurement.
- **Git history of the last week** (`git log --since=7.days`) and the code.

## Known today (don't re-report these as findings; build on them)
- **The media plan is decided and being built:** footage local while a project is in work, one player, storage by project state (shipped in 86).
- **Fixed in 86:** the 20 h Script mode cap, the recordings picker, low-disk playback copies, crash symbols.
- **Fixed for 87:** Drive .avi recordings from DVRs were dropped as unreadable (non-interleaved AVI over R2).
- **Bing first, then Parallel** for image search, planned for 88.
- **PR #1, merging now:** lighter exports and idle, and GPU framing for vertical exports, which the team doesn't use.
- **Open:**
  - Room-making blocks the server ~9 s on a slow disk.
  - An abort when the server stops mid-export.
  - A deleted script's original keeps uploading.
  - Vmake: an Apply press lost once; a piece shown done but never collected after a restart; removal tiers on hold.
  - Two of JJ's imports wait for a Retry.

## What to deliver
1. **The 10–15 most valuable improvements, ranked by how much the team would feel them.** For each:
   - what the person experiences today, with evidence (log lines, timings, code);
   - the change;
   - what they'd feel after;
   - size (hours, a day, days);
   - risk;
   - whether it fits nightly-88.
   Mix quick wins with a few bold ones.
2. **What to delete or hide:** anything on screen or in the flow that adds thinking for no benefit, per the minimalism rule.
3. **What you'd measure first** where you're unsure.

Be concrete and honest about uncertainty. Plain English; no audit-report padding.
