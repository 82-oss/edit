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

### 1. An empty video is stopping one prod project's exports

Prod's copy of `YouTube video [649TcIBMrOQ].mp4` in project `p1794942765038-42080` is 0 bytes, dated Nov 19. Its exports have failed with "could not decode" since Nov 23 00:47, and the agent's frames fail the same way. It's the only empty file in prod's cloud cache.

The download checks its size against the cloud's, so the cloud's copy may be empty too. That hasn't been checked. Look there first: if the cloud has the real video, remove the empty copy so it downloads again. If not, the video has to be brought in again. Edit should also refuse an empty original instead of caching it. Change nothing on prod without Sphe's word.

### 2. Finish checking `2b122605`

GitHub's Check passed on `f464adcd`, which includes this change: all server tests on macOS, 0 failures.

On Linux after the Nov 23 reboot, run one file at a time: 10 of the 11 unproven files pass. `exports.test.ts` isn't a bug: it fails only when `TMPDIR` is inside the home folder, and passes otherwise.

**Only `test/rife.test.ts` is left to run on Linux**, with prod idle:

```
cd app/apps/server
bun test --timeout=30000 ./test/rife.test.ts
```

**Don't run GPU tests on `mandalorian` while prod is busy.** The driver error that wedged the machine twice on Nov 22 (`NVRM: dmaAllocMapping_GM107: can't alloc VA space`) came back twice at 00:55 on Nov 23 while `effect_renders` ran beside prod's work. It didn't wedge this time. That test also left Chrome processes running on the GPU, which had to be stopped by hand.

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

Windows is on the same PC as `mandalorian`, so prod Edit is off until the PC is back in Linux.

- `git pull` on `main` gets everything in the repo, including this file.
- **Edit doesn't run on Windows.** From there you can read and change the code, push, and use GitHub Actions as the check.
- **Possible from Windows:** the code for the items in step 5, and for refusing an empty original in step 1.
- **Needs Linux or a Mac:** the rest of steps 1 and 2, steps 3 and 4, and running the server tests by hand.
- The session's memory, `~/.cache/edit-prod-build`, the prod service and prod's data are on the Linux side.
- Commit only your own paths (`git commit -o -- <paths>`), since other sessions share the `mandalorian` checkout, and never add a `Co-authored-by` trailer.
