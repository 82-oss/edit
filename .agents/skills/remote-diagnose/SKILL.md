---
name: remote-diagnose
description: Diagnose a problem on a teammate's Mac (JJ's, Marc's…) from this one. List the team's Macs, read their latest reports, ask a Mac read-only questions (its log by time and pattern, system, processes, network, work under way, a project, files in Edit's data folder, Edit's own GET routes), and, only when needed, unstick, restart or update it. Use whenever Sphe or a teammate reports something going wrong in Edit on another computer, or a fix needs checking there.
---

# Diagnosing a teammate's Mac

Everything goes through `app/apps/server/scripts/remote.ts`, run from `app/`. It signs in as the admin signed in to `~/.edit-dev` (`--home` for another data folder) and talks straight to the team's (prod) Convex and relay; no Edit needs to be running here. `--dev` talks to dev instead, where the dev server on :7700 is a device (`kenobi`): use it to try a new question before it ships.

```sh
bun apps/server/scripts/remote.ts devices                 # every Mac: build, started, last report
bun apps/server/scripts/remote.ts latest                  # each Mac's "needs attention", one block each
bun apps/server/scripts/remote.ts latest mathiass         # one Mac's whole latest report, and how old it is
bun apps/server/scripts/remote.ts logs mathiass since=6h level=warn       # its log from the cloud: works with the Mac off
bun apps/server/scripts/remote.ts logs mathiass since=1d grep=export lines=2000
bun apps/server/scripts/remote.ts crashes mathiass days=7  # its crashes and each time Edit stopped without quitting
bun apps/server/scripts/remote.ts ask mathiass help       # what can be asked
bun apps/server/scripts/remote.ts ask mathiass log since=2h level=warn
bun apps/server/scripts/remote.ts ask mathiass log since=1d grep=pieces|upload lines=2000
bun apps/server/scripts/remote.ts ask mathiass work       # jobs, uploads, pieces, imports, agent turns
bun apps/server/scripts/remote.ts ask mathiass cpu        # the server busy or big with nothing under way: its threads, event loop, JS heap
bun apps/server/scripts/remote.ts ask mathiass project p1793748290029-143711
bun apps/server/scripts/remote.ts ask mathiass get /api/projects/<id>/media/<m>/status
bun apps/server/scripts/remote.ts ask mathiass usage hours=48   # the Claude plan: meter now, each 15-min stretch and what spent it
bun apps/server/scripts/remote.ts history mathiass        # what was sent and how it went
```

Full control (a build with `remote_control.ts`, Nov 15 on; everything that changes something shows on their screen):

```sh
bun apps/server/scripts/remote.ts help mathiass Fixing your stuck export, back in 5 min   # a dialog over their Edit: you, why, each step live
bun apps/server/scripts/remote.ts help mathiass end Fixed: export it again                # closes it with those words
bun apps/server/scripts/remote.ts say mathiass Your export is fixed                       # a line on their screen
bun apps/server/scripts/remote.ts call mathiass POST /api/projects/<id>/export/cancel     # any of Edit's routes, as their Mac (GET is read-only)
bun apps/server/scripts/remote.ts agent mathiass <project> Keep the dates before the places  # to that project's agent, shown as yours
bun apps/server/scripts/remote.ts sh mathiass "df -h; ps aux | grep -i edit" --seconds 60  # a shell there, output scrubbed
bun apps/server/scripts/remote.ts restart mathiass --now --hold agents   # now; everything carries on after it but what's held
bun apps/server/scripts/remote.ts update mathiass --now                  # the newest build now, the same way
bun apps/server/scripts/remote.ts hold mathiass exports,imports          # / release mathiass   / open mathiass
```

A Mac is named by any part of its name (`devices` lists them). Answers print and are kept in `/tmp/edit-remote/`.

## How to go about it
1. **Read before asking.** `latest <mac>` is free and works when their Mac is off: what needs attention, problems grouped with counts, the log's end. Most problems are named there.
2. **Ask narrowly.** Ask `log since=… grep=…` rather than whole files, and widen in steps. A question over about 85 characters goes as a run (any length) on a build with `remote_control.ts`. The log keeps five rotations (about a week) on the Mac, and 30 days in the cloud (`logs`).
3. **The Mac must be on with Edit open** for `ask`, `diagnostics`, `probe` and the rest. If it isn't taken within `--wait` seconds (180 by default), the script says when that Mac last sent a report. Commands wait 10 minutes in the cloud.
4. **Questions are read-only.** `ask` never changes their work, settings or projects, and sign-in files are refused. The answers are scrubbed of URLs and tokens and go to `edit/reports/remote/`, which only an admin reads.
5. **What changes something says so: ask Sphe first** unless he asked for it. `unstick` (retries syncs and imports, stops agent turns quiet for 15 min, cleans the cache when the disk is full); `restart` (only when nothing's running; `--now` whatever runs); `update-when-idle` (waits for 20 min without use); `resume <id>`; and everything under Full control but `call … GET`, `sh` that only reads, and `open`.
6. **When the person is at their Mac, open with `help`** and close with `help … end`: they see who's working on their Edit and why, and each change as a step, instead of things happening to them. Outside a dialog every change is a notice on their screen anyway. Since Nov 10 exports, imports and agent turns carry on after a restart or update by themselves; `--hold` keeps chosen work from carrying on (say because it's what's broken) until `release`. An agent turn carries on only within 10 minutes of the restart.
7. **Fix it in code and ship it.** A diagnosis ends in a fix in the product (and a test), as AGENTS.md says, not in hand-edits on their Mac.

## Good to know
- `ask` needs a build with `remote_ask.ts` (after nightly-53). On an older build, `latest`, `diagnostics`, `probe` and `history` still work.
- Their `latest` report is pushed every 5 minutes when what needs attention changes, else every 10, while Edit is open (hourly before Nov 15's build).
- **Their log is in the cloud too, every 5 minutes** (`log_ship.ts`: `edit/reports/logs/<mac>/<day>/`, scrubbed, gzipped, kept 30 days), and once more as Edit quits and starts, so `logs <mac>` reads it with the Mac off or Edit closed; reach for it before `ask … log`. Times are the Mac's own (each chunk says its time zone; `since=` is counted in it). `crashes <mac>` lists macOS's crash reports of Edit's programs and a note each time Edit stopped without quitting (when, and its log's last 300 lines). Kept in `/tmp/edit-remote/logs/` and `/tmp/edit-remote/crashes/`. Needs a build from Nov 15 on.
- **A Mac that won't take a question still has its log here.** `latest <mac>` ends with the log's last lines, and `reports [days]` lists every report a Mac sent (the in-app agent files one on a tool error) and keeps each in `/tmp/edit-remote/home/reports-inbox/`, with about 3,000 log lines, INFO too: grep them for `[export]`, `[review]`, `[ui] preview`. An export's stages and a share's times were read that way on Nov 10, when no nightly-70 Mac took a question (their log: `[remote] [CONVEX Q(editSupport:pending)] … Server Error`; a Mac that has reported since the question was sent, with the question still `pending` in `history`, isn't asleep).
- **The Claude plan running out:** the report's "Claude plan" section and `ask <mac> usage` line up Anthropic's own meter (read every 15 minutes via Claude Code's /usage, at no cost to the plan) with Edit's calls and every other Claude Code conversation on that Mac (from `~/.claude/projects`: folder, model, tokens, never content). Each rise of the 5-hour meter goes to Edit, other Claude Code there, or *nothing on this Mac* — that last is claude.ai or the Claude app's chats, or another computer on the same account; Anthropic's week split (Claude Code / Chats / Cowork / Other) says which. Dollars are at API prices; "a 5-hour window held about $N" is that plan's size. Needs a build after Nov 5 (`plan_use.ts`).
- A new question goes in `remote_ask.ts` (read-only, tested in `test/remote_ask.test.ts`); try it with `--dev` before it ships.
