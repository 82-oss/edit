# Removal rework: where it stands (Nov 22, 2026, 21:50)

A handover for carrying on in another session. Delete this file once the work below is done.

## Continuing from Windows: read this first

Sphe means to carry on from Windows on the same PC. That changes what can be done:

- **Edit doesn't run on Windows.** From Windows you can read and change the code (it's all pushed to `origin/main`) and talk to RunPod and the relay, but you can't render, export or share a video.
- **The video's last steps need mandalorian booted into Linux**, where the finished removal, the finder's boxes and prod Edit live. Nothing below can be finished from Windows.
- **Don't open the Boyfriends project in Edit on a Mac to finish it there.** A Mac has no finder, so it would plan removal the old way from the agent's marks and could take tonight's blurs off. The project doesn't hold its removal on other machines (`removal_held` is unset).
- **What only exists on the Linux disk:** `~/.edit-prod` (prod Edit's data, including the finder's boxes under `cache/cleaned/found`), the lab at `~/.cache/removal-lab`, the finder's Python, and the rebuilt prod binary. The project itself and its cleaned strips are in the cloud.
- **Useful from Windows:** the code work under "Still open after this video" (cleaning up the finder, the label box that clips the camera stamp, the relay's card estimate), and the WSL2 trial.

## What Sphe asked for

1. Rethink subtitle and watermark removal (Vmake API, Vmake through Browser Use, and MiniMax on RunPod had all been unreliable).
2. Build the result into Edit.
3. Deliver one Cuffed & Caught video on a feedback link: intro and cases 1 and 2 cleaned by MiniMax on RunPod, the rest blurred.

Standing rules from this session:
- **Reuse cases are left exactly as they are**: no removal, no editing (a script block labelled "Reuse (the whole video)").
- **Blur is the floor.** The model's clean only replaces it; a failed clean stays blurred and never blocks an export.

## What exists now

**The finder (new).** Per footage file it finds what the re-uploader laid over the picture and writes boxes by frame: captions exact to the frame, labels and channel marks, notes. Nothing waits on the in-app agent's marks. A few unclear items go to an Opus judge with a picture of each.
- Python scripts: `app/apps/server/src/finder/` (entry `find.py`: `survey`, then `finish`).
- Edit side: `app/apps/server/src/found.ts` (store, boxes to tracks, judge call, queue), hooked into `text_blur.ts`, `text_removal.ts`, `removal_schedule.ts`.
- It runs only on a Linux machine with an NVIDIA card and `~/.local/share/edit-finder/venv`. Everywhere else removal works by the agent's marks as before.
- Tests: `app/apps/server/test/found.test.ts`.

**Commits on local `main`, not pushed:**

| Commit | What |
|---|---|
| `f0848f42` | The finder and its hooks |
| `e06eefc1` | Honours what was asked after a Stop |
| `e0c7d0a6` | RunPod pod self-test (in the relay's kit; **relay not deployed**) |
| `e028b348`, `bbe0bb4e` | Strips from before the finder are taken off; a strip counts when it lies within a stretch |
| `30abb787` | Two Chromes per graphic on Linux, not four |

**Prod Edit on mandalorian** (`~/.local/share/edit-prod/edit`) is built from `30abb787`, from a clean `git archive` copy in `~/.cache/edit-prod-build/src` (another session had uncommitted files in the checkout). The binary before all of this is `edit.before-f0848f42`.

**The lab** is `~/.cache/removal-lab` (venv, both videos' footage in `bf/` and `sm/`, scores, sheets). The finder's venv is a symlink into it, so don't delete it.

## The video: Boyfriends (`p1794942765038-42080`)

Done and saved in the project:
- 270 blur stretches and 128 model cleans, over the intro and cases 1 to 4. None failed. RunPod cost about $1.50 (balance about $1.16).
- Cases 5 and 6 untouched (reuse).
- The six big sources' boxes were seeded from the lab into `~/.edit-prod/cache/cleaned/{finder,found}`; prod's own finder read the 107 slowed copies.

**Left to do, in order:**
1. **Restart mandalorian** if it is still locked (see "The machine" below).
2. Let prod Edit re-render two graphics by itself: `interview-audio` (17,460 frames, about 80 min with two Chromes) and `cutin-keys`. Check with `GET /api/projects/<id>`: an effect whose path contains `effect-stills` is still on a placeholder.
3. Start the share again: `POST http://127.0.0.1:7790/api/projects/p1794942765038-42080/share` with `{}`. The 21:25 one failed ("The interview-audio effect didn't render") because of the lock-up.
4. Watch `GET .../review` until the link exists.
5. Eye-check **from the exported file**, never through Edit's `/frame/<n>` while it renders or exports.
6. Send Sphe the link with what's in it and what isn't perfect.

**Known flaws in this version:**
- The blur over the "OFFICER n" bar clips the bottom line of the Axon stamp, about 22 to 31 min. Fix: keep a label's plate box off the stamp boxes in `finder/assemble.py`.
- ARRESTFLIX shows in places around 58 to 61 min where the tracker had no sighting; elsewhere it is a moving blur patch.
- One of their subtitles is left at 23:05 ("Leslie, are you"), a finder miss inside a cleaned stretch.
- Labels and marks are blurred, not rebuilt, inside the cleaned sections too (the model only takes captions).

## The machine

Mandalorian's NVIDIA driver locked up twice on Nov 22 (about 20:45 and 21:34). The kernel log fills with `can't alloc VA space for mapping`, then every program that touches the card hangs until a restart.

- Cause as far as I can tell: the 8 GB card running out of address space. Edit drew each graphic with four Chromes through Vulkan (56 processes), beside the encoder and the desktop. The first time my finder's GPU reads were on top; the second time it was eight stills I asked Edit for.
- The same error is in the log on Nov 20 and 21.
- Changed: two Chromes on Linux (`30abb787`); a guard service `gpu-guard.service` (`~/.local/bin/gpu-guard.sh`) that kills the drawing Chromes at 40 errors a minute and logs to `~/.cache/gpu-guard.log`. **Neither is tested.**
- Rule: while Edit renders graphics or exports on that machine, run nothing else on the card and ask Edit for no frames. Check `journalctl -k -b 0 | grep -c "can't alloc VA"` before and during any GPU job.

## Still open after this video

**Finder**
- Blind test on the second video (SMART Cops): 3.7% of checked frames with a real miss, against 0.6% on the video it was tuned on. New failure kinds: a Getac camera's speed and altitude read-out taken for captions and blurred; a wide caption blurred only in the middle; a crown logo sticking out of the UNPOPULAR blur.
- See-through marks: BODYCAMTUBE (stays put) comes out cleanly with Edit's own watermark engine once given its place (`~/.cache/removal-lab/wm/wm.ts`). ARRESTFLIX (drifts) is followed to half a pixel (`wm/steady.py`) but three fills failed. Next idea: the generator on the small steadied window. "Bodycam Justice Reports" (very faint) is found by nothing.
- The scripts are the lab's, carried in as they were. They need cleaning up, and the venv needs a proper home outside `~/.cache`.
- The finder runs four reader processes at once (`PROCS` in `found.ts`); make that one on a small card.
- The in-app agent's instructions still tell it to mark stretches (`agent/instructions.md`); use the `in-app-agent` skill when changing them.
- Team Macs get none of this yet. Options: the finder on a rented pod (the relay already sends a worker's source with each job), or a port onto Vision.

**RunPod**
- Live and working: a pod leaves on its first CUDA error; the same job sent twice is one job; refused rentals fall back across six card types.
- Not deployed: the pod self-test (`e0c7d0a6`). Needs a relay deploy.
- The relay rents too few cards for tall caption bands (it assumes 5 GPU-seconds per footage second; tonight was 20 to 40). Two cards were rented where four would have halved the wait.
- Not done: the soak test (the same stretches three times at different hours, every run finishing by itself). Sphe was advised to add about $10 for it and the second video, not $25.
- MiniMax-Remover's licence is non-commercial (CC BY-NC). Sphe has been told three times and has not ruled on it.

**Housekeeping**
- Pushed to `origin/main` at 21:55 on Nov 22 (ten commits, some from other sessions); check that CI passed.
- Re-enable nothing: no services were disabled. `gpu-guard.service` is new and enabled.
- The 10-minute scheduled check in the T3 thread ("Boyfriends removal run: 10-minute check") should be deleted once the link is sent.
- Sphe asked about moving to Windows. Advice given: no port; try WSL2 first (Windows as the desktop, Edit's Linux build and the agents inside it), about half a day to test.
