# Ideas and thumbnails: what's left (Nov 22)

Handoff from one session on `mandalorian`, to carry on from Windows. Delete this file once the list below is done.

## Why this work happened

Sphe's prod Linux Edit kept showing errors in an idea's chat. Three things came out of it:

1. **Restarts killed chats.** "Claude Code process exited with code 143" meant a deploy restarted prod in the middle of a chat.
2. **Ideas were fragile by design.** Every page load and every step of a run went straight to the cloud through the relay, so any relay hiccup became an error on screen. Edits and scripts never had this problem.
3. **The agent couldn't use pictures attached in the chat.** It could see them but couldn't put them on the card, so it asked Sphe to attach them by hand.

## What's done

| Commit | What |
| --- | --- |
| `e27cd3ec` | One failed ending is saved once, not twice |
| `2b122605` | Ideas and thumbnails work from a local copy (`app/apps/server/src/team_docs.ts`), and chat pictures can go on the card |

Changed on `mandalorian` only, outside the repo:

- `~/.config/systemd/user/edit-prod.service`: `KillMode=mixed` and `TimeoutStopSec=30`, so a restart signals Edit alone and a chat carries on afterwards.
- `~/.cache/edit-prod-build/idle.ts`: the check before a prod swap now reads Edit's own `/api/health` `busy` list, which includes idea chats.

**Neither commit is on prod yet.** Prod still runs an older build.

## What's left, in order

### 1. Reboot `mandalorian`

Its NVIDIA driver is wedged (`NVRM: dmaAllocMapping_GM107: can't alloc VA space`). The desktop, Chrome, FFmpeg and prod's GPU work are stuck, and killing them doesn't help. It may need a hard power cycle.

The full server test suite triggered this at 21:30 by running GPU tests beside prod's removal, and it was also running during the 20:30 freeze. The same driver error was in the log from 08:36, so prod's own load may trigger it too. That isn't settled.

**Don't run the whole suite on `mandalorian` while prod is busy.** Use CI, or run named files one at a time.

### 2. Finish checking `2b122605`

Passing so far: typecheck, lint, 703 web tests, and the `team_docs`, `ideas`, `thumbnails` and `channel_access` server tests.

22 server test files failed across the full runs on the overloaded machine:

- **10 pass** when run alone, with and without this change.
- **1 fails the same way without this change:** `exports.test.ts`, "an export that stops moving is started again by itself". It needs its own fix.
- **11 haven't been run again**, so they're still unproven:

```
test/effect_inputs.test.ts
test/effect_renders.test.ts
test/effects.test.ts
test/local_first.test.ts
test/local_first_minutes.test.ts
test/reviews_ask.test.ts
test/rife.test.ts
test/writer/import_stops.test.ts
test/writer/local_first.test.ts
test/writer/missing_recordings.test.ts
test/writer/preview_away.test.ts
```

First look at the GitHub Actions Check for `2b122605` or later, since it runs these on a clean machine:

```
gh run list --branch main --limit 5
```

If one fails there, run it against the commit before (`bbe0bb4e`) to see whether this change caused it. To run one by hand on Linux with prod idle:

```
cd app/apps/server
bun test --timeout=30000 ./test/local_first.test.ts
```

### 3. Try both changes in the real app

So far they've only run against stand-ins.

- **Pictures:** in an idea's chat, attach two pictures and repeat Sphe's request: take the mother from the first, place her in the second, shocked and covering her mouth. Both should appear on the card in order and reach Trello when sent.
- **Local copy:** cut the relay during a chat. The page should keep working, and the changes should reach the cloud once it's back. Restart Edit with a change still waiting.
- **Two computers:** change one idea on two Macs at once, and confirm a run on one refuses a run on the other.

### 4. Put it on prod, only on Sphe's word

Run `bun ~/.cache/edit-prod-build/idle.ts 7790` first and swap only when it exits 0. The build recipe is `~/.cache/edit-prod-build/build.sh`. Both live on `mandalorian`.

### 5. Smaller things found along the way

- **Finder freezes.** While the removal finder first read all the footage (19:15 to 19:47), Edit's main thread froze for 3 to 6 s every few seconds. It comes back whenever the finder reads a lot of new footage.
- **A refused change is silent.** If the cloud refuses a change after the page has moved on, it's undone here and only logged. The person should be told.
- **Leases with the relay down.** A run waits up to 15 s for the cloud, then goes on from the local copy, so two computers cut off from the relay could both run on one idea.
- **Still need the cloud:** deleting, and opening an idea this computer has never seen.
- **An old stash** from Nov 18 (18 files, from another session) is in the `mandalorian` checkout. Stashes don't push, so it isn't on GitHub. Look at it before dropping it.

## Continuing on Windows

- `git pull` on `main` gets everything in the repo, including this file.
- The session's memory, `~/.cache/edit-prod-build`, the prod service and prod's data stay on `mandalorian`.
- The repo has no Windows build or CI job. Reading code, editing and pushing will work, but the native addon, GPU tests and many server tests may not, and that hasn't been tried. Use GitHub Actions as the check.
- Commit only your own paths (`git commit -o -- <paths>`), since other sessions share the `mandalorian` checkout, and never add a `Co-authored-by` trailer.
