# Handoff: ASF footage import (PR #9)

PR: https://github.com/spheceo/edit/pull/9 · branch `fix-editor-loading-stuck`. Delete this file once the PR is merged and JJ's import has finished.

## The problem

JJ's import "Cops Catch Killer at Airport After Body Is Found" (project `p1795524349383-32937` on `mathiass-macbook-pro`, Writer script `5660a2b5`) is stuck at 72% ("Nothing has come in since 2:50 PM").

Three of its eight footage files are `.asf` bodycam recordings (H.264 + AAC), and 73 of the script's 83 clips come from them:

| File | Drive ID | Clips |
|---|---|---|
| Lt. Christopher Greene NEW 2024-04-22_16_36_25_057 | `1vTkoSQJqYwcTNfws9D8bCvNp4chp-00V` | 13 |
| Brent Griffin 2024-04-22_16_25_31_709 | `1jeKAZJCPmywFbB60ivFaKkHYYpuHgNol` | 17 |
| Detective Brandon Lagoy 2024-04-23_03_04_45_158 | `1AwWE3_BCAWxUpHatB7wurUBCGNS4GX9L` | 43 |

For each of those files, Edit:

1. downloaded the whole file over JJ's line (26 to 62 min each), because only MP4/MOV can be read in place from the cloud;
2. copied the clip's video into a new `.asf` file. The ASF container adds its preroll to the length it reports, so every clip read 1 to 2 s too long;
3. rejected the clip ("came out wrong (it runs 37.1 s, not 36.0 s)"). That counted as a temporary failure, so the download was deleted and the whole cycle ran again on every retry.

Script mode handled the same files fine because it re-encodes everything into its own `proxy.mp4`. Only the edit side copies video into the source's own container.

## What the PR does

All the changes are in `app/apps/server/src/script.ts` and `app/apps/server/src/failure.ts`.

- **ASF/WMV clips are written as MP4** (`excerptExtension`). The video is copied when MP4 can hold the codec (`picturePasses`). Windows Media video is re-encoded to H.264 instead, padded to even width and height. A cloud address is judged by the file name at the end of its path.
- **A bad cut from a file already on the Mac is cut again once, re-encoded** (`cut`). This happens when FFmpeg refuses a copied cut or the clip comes out the wrong length. Re-encoding cuts exactly in any container.
- **A clip still measured the wrong length stops for good** (`lasting`). It raises `failure.SameEveryTime`, which counts as `broken`, both from the error and from the words a job saves across a restart. The import then lays out without that file and asks the person instead of downloading it again. A length that can't be read at all (`UNREADABLE`) stays retryable. Downloads are checked against the object's size, so a whole copy on the Mac is always complete.
- **`chunks.rs`:** reformatted with `cargo fmt`, because `main` was failing the Rust format check.

Tests are in `test/script.test.ts` and `test/excerpt_check.test.ts`:

- an H.264 `.asf` clip comes out the right length;
- a Windows Media `.asf` file is cut from a local file and from a served cloud-style address;
- copied ASF and MKV cuts that read 2 s long are repaired by the second, re-encoded cut;
- a truncated file stays retryable (`passing`);
- AAC in a `.wav`, measured short every time, stops as `broken`.

## State at handoff (Nov 24, about 15:45)

- Every check had passed on `8837dcaa` except `check (macos-latest, tests-2)`, which was still running.
- No review threads are open. CodeRabbit's automatic reviews are paused because of the many commits, so comment `@coderabbitai review` after each new commit.
- The acceptance check once failed with "play 3 s: the playhead didn't move" on GitHub's virtual Mac, then passed on later commits. It's flaky, and this PR doesn't touch the player.
- Codex reviewed the first commit and had no findings.

## Next steps

1. Make sure every check is green, then tell Sphe the PR is ready to merge.
2. After the merge, a nightly needs Sphe's go-ahead. JJ's import keeps failing about once an hour until his Mac has the fix; then it should finish by itself. Check it from `app/` in the main checkout:
   `bun apps/server/scripts/remote.ts logs mathiass since=2h grep=p1795524349383`
3. **Don't hold, restart or change anything on JJ's Mac.** Sphe chose to leave it alone.

## Left open

- A clip that FFmpeg refuses even when re-encoded, from a file on the Mac, is still retried, and each retry downloads the whole file again. It gives up after `GIVE_UP_AFTER` (3) tries. This should be rare now that the re-encoded second cut exists.
- The cloud only reads MP4/MOV in place. Any other container is downloaded whole before cutting, which is slow on a line like JJ's.
