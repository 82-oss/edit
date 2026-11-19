# Council brief: is Edit fixable as it stands, and what would make it stable? (Nov 19, 2026)

You're one of four independent reviewers: Claude Fable 5.1, Claude Fable 5.2, GPT 6.2 Astra and Muse Wonder 1.0. You won't see each other's answers. **Read only. Change no code, commit nothing, release nothing, restart nothing.** Write your answer to the file named at the end.

## The ask, in Sphe's words (he builds Edit)
"We have been working on this app for over a month, nearing two months, and the team is getting frustrated. I am getting frustrated. There are so many little paper cuts. There are so many big bugs. I'm tired of sending out models to do an audit of the codebase, and they come back with 4 out of 10 significance problems. They say 'just fix that, just fix that', when there are bugs popping up when the team uses the software that no model catches.

I don't know if it's just us being shallow with our audits. I don't know if it's us being too careful and playing it safe and not willing to say 'this entire thing needs a rewrite', or 'this app is never going to be stable at all, there's no reason to keep going.'

The app has helped produce a bunch of videos, but it's been an insane hill climb for each one: things breaking that we didn't catch or thought wouldn't break. Recently someone's Wi-Fi went off during an import, things went to shambles, they clicked 'Go on without it', and the project was lost."

**He is asking for honesty, not reassurance.** Earlier audits failed him by being cautious and local. If the right answer is "rewrite X", "rewrite all of it", "change the architecture", or "stop building this and use something else", say so plainly and argue it. If the right answer is "keep going, but change how you work", that's fine too, as long as it's argued from evidence and not from politeness. Don't hand back a list of small bugs; that's what has already failed.

## What Edit is
Read `AGENTS.md` first (Sphe's principles: quality + speed, reliability, minimalism; his note about not fearing a rewrite).

- A small team makes true-crime and bodycam YouTube videos. **JJ** (MacBook Pro, Norway, ~8 Mbit/s up, unreliable Wi-Fi) works in it all day. **Marc** uses a MacBook Air. **Sphe** has an M4 Air and this Linux machine (`mandalorian`).
- The flow: ideas → **Script mode** (import a case from a Drive folder, YouTube or a compilation; an agent writes the script) → **the editor (V2)**: an in-app agent cuts the video and writes effects as code, channels with lessons decide the style → text/watermark removal → export → share link for review.
- The app: a Tauri shell, a Bun/TypeScript server (`app/apps/server`), a React page (`app/apps/web`), a relay (`app/apps/relay`), a Rust engine and native player (`app/crates`, `app/engine`), footage in Cloudflare R2 with copies on the Mac, Convex for some cloud state, the in-app agent's instructions and skills in `agent/`. About 320k lines of TS/TSX/Rust/Python, ~2,190 commits since Jul 17, ~1,730 in the last 30 days; roughly 750 of those 30 days' commit subjects read as fixes. Release process and dev/prod split: `docs/dev.md`.
- Built almost entirely by coding agents (Claude, Codex) driven by Sphe, at very high speed. Commit messages are long incident narratives: they are a primary record of what broke for the team and why.

## Evidence (all read-only; please go wide, not deep in one file)
1. **Git history.** `git log` with bodies. Look for patterns: which subsystems keep getting fixed, fixes of fixes, the same failure class coming back, how big commits are, how much is tested against the real thing vs mocks. E.g. `git log --since=30.days --format='%h %ad %s' --date=short`, `git log --stat`, churn per file (`git log --since=30.days --name-only --format= | sort | uniq -c | sort -rn | head -50`).
2. **The coding-agent transcripts**, where Sphe's and the team's frustration is recorded word for word:
   - Claude Code: `~/.claude/projects/-home-spheg-Documents-code-edit/*.jsonl` (124 sessions, 1.2 GB) and the other `~/.claude/projects/*edit*` folders. Each line is JSON; Sphe's own words are entries with `"type":"user"` whose content is text (not tool results). **Stream them with `jq`/`grep`/`rg`; never load a whole file or all of them into memory** (see Limits).
   - Codex: `~/.codex/sessions/` (8.6 MB).
   - Team feedback notes: `docs/feedback/`, `TODO.md`, `docs/plans/` (incl. `2026-11-18-local-first-media/` with a stability audit and an earlier two-model council, whose framing you should feel free to reject).
3. **The team's Macs, read-only:** from `app/`, run `bun apps/server/scripts/remote.ts devices | latest <mac> | logs <mac> since=7d [grep=…] [level=warn|error] | crashes <mac> | reports`. Macs: `mathiass-macbook-pro` (JJ), `macbook-air-von-marc-2` (Marc), `siphesihles-macbook-air-m4` (Sphe). **Never** use `sh`, `call`, `agent`, `restart`, `update`, `say` or `help`: those change things or show on their screens.
4. **The code itself**: the structure, not just individual bugs. How state is held and recovered (jobs, imports, uploads, renders, the agent's turns), how many places own the same truth, how errors and restarts are handled, how many moving parts one user action touches, and what the tests actually prove.

One concrete incident to trace end to end as a case study: JJ's Wi-Fi dropped during a Script import (nightly-87, Nov 18), he pressed "Go on without it", the interview's ranges were dropped and the 25-minute edit became 2:44 of door footage. See commits `6e1275e3`, `268f4bc0`, `30a17052`. Ask: why was this possible in the first place, what class of bug is it, and how many other places in the code have the same shape?

## Questions to answer
1. **The verdict.** One of: (a) keep the architecture, change the process; (b) rewrite specific subsystems (name them, say into what); (c) rewrite the app on a different architecture; (d) stop and use something else (say what). Give your confidence and what evidence would change your mind.
2. **Root causes.** Not bugs: the 3–6 structural reasons Edit keeps breaking for the team. For each: evidence (commits, transcript quotes with file + date, log lines, code paths), and how much of the pain it explains.
3. **Why the audits miss what the team hits.** Be specific about the method: what audits looked at vs where the team's failures actually come from (network, restarts, long jobs, real footage, two Macs, cloud vs local, agent-in-the-loop…). What method would have caught the Wi-Fi incident before JJ did?
4. **What to keep.** What in Edit is genuinely good and must survive any rewrite (the team relies on it: quality + speed).
5. **The plan.** If you recommend a rewrite, the order, rough size in days for agents at this team's pace, how to do it without stopping video production, and what "stable" would be measured by. If you recommend keeping it, the concrete change in how work is done that makes the next month different from the last two.
6. **What you'd cut.** Features, surfaces or moving parts that cost more reliability than they're worth.

Number your claims and back each with something checkable. Mark what you inferred vs what you saw. Disagree with Sphe's framing where the evidence says to.

## Limits
- **Memory:** this machine froze twice from out-of-memory (Nov 17). Four reviewers run at once. Stream big files, cap anything heavy with `systemd-run --user --scope -p MemoryMax=3G …`, no test suites, no builds, no servers, nothing that decodes video.
- Don't touch the running dev/prod servers, `~/.edit-prod`, `~/.edit-dev`, or R2.
- Don't write anywhere but your answer file.

## Your answer
Write it to `docs/plans/2026-11-19-honest-council/<your-name>.md` (`fable-5-1.md`, `fable-5-2.md`, `astra.md` or `muse-wonder.md`). Start with the verdict in 3–5 sentences a tired person can read, then the rest. As long as it needs to be, no longer.
