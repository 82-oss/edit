# Caption removal on Macs: handoff (Nov 24, evening)

PR #5 (`still-clean-model-fallback`) is caption removal made ready for Macs, at Sphe's request. PRs #3 (finder on RunPod) and #7 (Stop fixes) are folded in and closed. Delete this file once the PR is merged.

## Done
- **Still clean in the engine** (`crates/edit-engine/src/still/`, addon `stillClean`, `found.ts`): `finder/still.py` is ported to pure Rust, and `still.py` is removed.
  - Against Python on 13 real Hitman/Trooper stretches: the same decisions, boxes and plates, and 8 of the 9 cleaned strips byte-identical. It runs 1.3–4× faster.
  - FFmpeg's colour conversion is bit-exact, so an M1 Air comes within 0.05/255 of Linux.
  - Stretches cleaned at once follow memory as well as cores: 1 on 8 GB, 5 on 16 GB, 8 on mandalorian.
- **Finder on RunPod (from #3):** results are shared in R2. Boxes read on mandalorian before this go up the first time they're loaded, and `copy_to_dev.py` copies them.
- **Relay:** if a pool has no machine and every rent is refused for 10 minutes, its queued jobs fail with RunPod's own reason, instead of waiting silently for 3 hours.
- **Stop fixes (from #7)**, with all of their review fixes.
- **Dev setup:** the dev relay (`edit-relay-dev`) runs this branch. Hitman (`p1795378824613-3315`) and Trooper (`p1795379445677-5030`) are copied into dev, with their finder boxes in dev's R2.

## Open before merge
1. **CI on fc67e56d: two failures, not yet diagnosed.**
   - `check (macos-latest, rust)`: `check-rust` exited 101, so a Rust test failed, most likely in the engine's full suite, which wasn't run locally (to stay off mandalorian's GPU).
   - `check (macos-latest, tests-1)`: a server test failed; not read yet.
2. **CodeRabbit rates the PR high merge risk.** Each point needs fixing or answering:
   - The finder job runs Python sent with the job on shared GPU pods, using the pod's relay token. The clean job already did this; the finder extends it.
   - The shared found cache is one record per source, written without a condition, so two machines scanning different ranges can overwrite each other.
   - Cancelling a shared job counts per job id, not per subscriber, so a repeated cancel can drop another caller's interest.
   - A text plan can still start a paid finder read after a Stop. The still-clean placement doesn't check the plan's `stands()` at the final commit.
   - The still clean can accept frames it should send to the model.
3. **Codex: two findings on the original `still.py`** that apply to the Rust port too, since it is faithful to the Python:
   - Plates sample the original input without `beneath`, so a watermark that was already removed can come back inside a caption fill.
   - Captions left out of a stretch (away from the dominant caption area) can lose their blur when the stretch counts as cleaned.
4. **Not seen working live from a Mac:** the RunPod finder and the paid model. RunPod rented nothing, with the account at −$0.07.
5. **A Mac end-to-end rerun was running on kenobi** when Linux was left. It covers the free re-clean of Hitman's intro in dev Edit (:7720, `~/.edit-dev`) and one paid Trooper stretch. It posts its report as a comment on the PR and pushes any fixes to this branch.

## Needs Sphe
- Top up RunPod. Nothing on RunPod rents until then (finder, model, watermark machines), prod included.
- Babysit this PR from a thread on the Mac: CI first, then the review findings above.
