# Honest Council Review · Gemini 4 Neon (Nov 19, 2026)

## Verdict (read this first)

**Verdict: (b) Rewrite four core server/media subsystems from scratch, paired with a mandatory release-process reset and ruthless scope cuts — do not throw away the whole app, and do not keep patching the current server.** Edit's pain is not evenly distributed: its Rust core (`edit-core`, `edit-render`, `edit-window`, and the decode/mix/export core of `edit-engine`) is genuinely solid and low-churn, whereas its 141,652-line Bun server (`app/apps/server/src`) has collapsed into an un-testable sediment pile of 133 unlocked JSON state files, 297 module-level mutable maps, 31 polling timers, five overlapping media paths, and two duplicated applications (Writer and Editor) running in one fragile process. Keeping the current server architecture and "just being more careful" will fail because the code makes whole classes of bugs inevitable; conversely, throwing away the Rust engine, Tauri native window, V2 coded effects, and `agent/` skills to start over—or retreating to Premiere—would destroy the exact competitive advantage no off-the-shelf tool gives you. **Confidence: 85%.**

**What evidence would change my mind:**
- *Toward (c) full app rewrite:* If symbolizing the M4 native `SIGABRT` (Nov 18) and stress-testing `edit-engine` reveals pervasive memory corruption or architectural deadlock inside `render.rs`/`mac_media.m`, OR if the team cannot hold a 3-week feature freeze and stop running concurrent coding agents on a shared `main` checkout (in which case a subsystem rewrite will rot back into the current state within a month).
- *Toward (d) stop and use Premiere + external scripts:* If the team's weekly output has already fallen below what Premiere + a human editor delivers even *without* Edit's bugs, or if the team has zero appetite to pause new features (V2/removal/Ideas/Thumbnails) long enough to stabilize the spine.

---

## 1. Where I disagree with Sphe's framing

1. **"Maybe we just need deeper audits."** *Observed:* You already ran major audits on Nov 8 (Codex + Claude), Nov 13, Nov 16, and Nov 18 (Astra stability audit + Fable/Astra council). They found real bugs—and yet within 24 hours of the Nov 18 council, JJ lost a 25-minute edit to a Wi-Fi drop (`6e1275e3`), hit a second import failure on Scissors Attack (`30a17052`), and **right now on `nightly-90`** has a *third* script import stopped dead (`Could not read BenjaminCunningham_202401112341_02619-0.`) on the exact class of bug Fable flagged yesterday (`writer/imports.ts:1529-1531`). Deeper static code audits cannot fix a codebase growing at ~50,000 LOC/week across 1,732 commits/month with no unified state model and no fault-injection gate.
2. **"We shouldn't fear a rewrite, or maybe the whole app is doomed."** *Observed:* The Rust core is **not** the problem. Over the last 30 days, `edit-core` took 43 commits, `edit-render` 20, `edit-window` 28, `edit-native` 24, and `edit-engine` 133—while `app/apps/server/src` took **1,085 commits** (62.6% of the entire repo) and `app/apps/web/src` took **551**. Edit is not "broken everywhere"; it has a **strong native engine trapped inside a collapsing orchestration server**.
3. **"Shipping fast nightlies helps the team."** *Observed:* `docs/dev.md:42` says *"at most one nightly a day."* In reality, the last 20 days shipped up to **8 nightlies in a single day** (Oct 23: 8; Oct 30: 7; Nov 17: 7; Nov 18: 5; `nightly-90` today), with 10 consecutive tags overriding the cadence guard (`stability-audit-astra.md:160`). Shipping 5–7 builds/day directly off a `main` branch edited concurrently by multiple agent sessions (`2388963a`, `3038ff96`, `494e01b3`) is *creating* half the restarts, regressions, and team distrust (Marc's latest report shows `Adobe Premiere Pro 2026 4.9 GB` open beside Edit `nightly-84`, unused for 15.7 hours).

---

## 2. Five structural root causes (not individual bugs)

### Root Cause 1: No database, no transactions, and 297 process-global state maps (~30% of the pain)

- **Claim 1.1 (Observed):** Edit uses **zero SQLite** for application state (`youtube_signin.ts` is the only file referencing SQLite, to read Chrome cookies). Instead, `app/apps/server/src` persists state across **133 distinct ad-hoc `.json`/`.jsonl`/`.lock` files** (`jobs.json`, `cloud/projects.json`, `footage-gone-without.json`, `exports.json`, `reviews.json`, `script.json`, `ledger.json`, `uploads.json`, `removal-asks.json`, etc.), with no cross-file transactions, no foreign keys, and no schema migrations.
- **Claim 1.2 (Observed):** Live state is scattered across **297 module-level `Map`/`Set` singletons across 131 server files** (`effects.ts`: 18, `cloud_media.ts`: 14, `reviews.ts`: 10, `broll.ts`: 8, `native_preview.ts`: 7, `proxy_pieces.ts`: 7, `cloud_blocks.ts`: 6, `local_previews.ts`: 6, `writer/imports.ts`: 6) and driven by **31 independent `setInterval` loops across 29 files**.
- **Claim 1.3 (Observed):** Core process-safety invariants are missing or disabled:
  - `serve.ts:246-252` (`holdDataLock`): if a second Edit server opens the same `~/.edit` folder, it logs a `WARN` and **continues running**, allowing two processes to race on 133 unlocked JSON files.
  - `serve.ts:462`: `process.on("uncaughtException", ...)` swallows uncaught exceptions and keeps serving requests from potentially corrupted in-memory maps.
  - `jobs.ts:186-191`: `jobs.json` is mutated by unlocked synchronous read-modify-write (`read` → mutate → `writeAtomic`), with `frozen` as a module boolean.
  - Four separate predicates disagree on whether work is running: `busy.ts:25` (`wouldLose` literally returns `[]`, so auto-updates restart mid-work), `busy.ts:114-138` (`busyWith` omits effect renders and removal jobs), `busy.ts:61-80` (`workingNow` checks `projectWork`), and `serve.ts:479-496` (`keepAwakeWhile` checks effects/removal but omits Writer imports/Claude/Ideas/Thumbnails/shares).
- **Evidence of team impact (Observed):**
  - On Sphe's M4 (Nov 18 05:12:43), Edit logged `nothing running: the Mac may sleep again` while removal was actively running and slept for 20 minutes (`stability-audit-astra.md:80`).
  - On Marc's Mac right now (`nightly-84`, Nov 19 11:43 UTC): `Job archive:p1794249007710-7117: not started again (cut short by 3 restarts in a row)`.
  - On Nov 17–18, 25 `revision conflict` errors hit M4 (e.g. `expected 1, current 1093`) and 25 hit JJ (`stability-audit-astra.md:23,52`).
  - Every restart loses the 297 in-memory maps (e.g. `missing_media.ts:159` retry timers; `writer/cloud.ts` upload state), producing endless "only happens after restart/sleep" bugs (**247 commits, 188 fix-like, in 30 days** on restart/update/sleep/jobs).

### Root Cause 2: Sediment architecture — every pivot adds a layer without deleting the old one (~25% of the pain)

- **Claim 2.1 (Observed):** Every major architectural shift over the past 6 weeks stacked a new mechanism on top of the old one instead of replacing it:
  1. **Media & playback (16,214 LOC of TS across 26 files, excluding Rust; 514 commits / 331 fix-like in 30d):** Oct 18 local previews → Oct 29 "everything on the cloud" → Nov 2 smooth playback renders (`playback_render.ts`, `playback_stream.ts`) → Nov 3 pieced proxies (`proxy_pieces.ts` 1,230 LOC) + cloud blocks (`cloud_blocks.ts` 743 LOC) → Nov 6 native player (`native_preview.ts`, `local_previews.ts`) + export excerpts (`export_excerpts.ts`). A picture can come from **five places** (`docs/preview.md`), turning one 1.81 GB YouTube video into **6.1–9.0 GB** of overlapping local copies (`review-fable.md:27-37`).
  2. **Two duplicated applications inside one server:** **Writer / Script mode** (`38,972 LOC`) and **Editor** (`store.ts`, `script.ts`, `cloud_projects.ts`, `reviews.ts`) independently re-implemented storage, cloud sync (`cloud_projects.ts` 1,960 LOC vs `writer/cloud.ts` 1,533 LOC), imports (`script.ts` 3,564 LOC vs `writer/imports.ts` 1,792 LOC), locks, reviews (`reviews.ts` 2,830 LOC vs `writer/reviews.ts` 922 LOC), missing-footage recovery (**three** separate implementations: `script.ts`, `writer/missing.ts`, `missing_media.ts`), and playback (`web/lib/playback.ts` 2,560 LOC vs `web/writer/playback.ts` 690 LOC).
  3. **Two live editor generations (V1 + V2):** V1's 6 niches + 5,653 LOC of house graphics (`commentary_graphics.ts`, `desktop_screen.ts`, `cutin.ts`, etc.) + 127 MCP tools remain live beside V2's coded effects + channels + teaching (`7,682 LOC`). Sphe asked on Nov 19 (`0c144bab...jsonl:10682`): *"if something JJ isn't happy about... can he just switch off EditV2 and be able to do everything normally?"* Keeping both live doubles the test/bug surface.
  4. **Half-finished Effect-TS migration:** Started Nov 1 (*"fix this through Effect code"*, `4ec3283b`, `32a3a06d`), stopped at **19 of 362 server TS files (5.2%)**, leaving two incompatible concurrency and error-handling models side by side.
  5. **1,014-line `seams.ts` service-locator** (#7 highest-churn file in the repo: **94 commits in 30 days**) exists solely to hide circular imports across 363 server files and swap out real dependencies with throwing stubs during tests.
  6. **Revolving-door removal subsystem (`5,649 LOC TS + 8,723 LOC Rust`):** Custom Rust watermark removal → Vmake browser automation → parallelized → tiered → reverted (`af7eb186`) → nuked (`d3e14fcd`, Nov 19 after *"524 Browser Use browsers started on the team's credits"*; Sphe at `0c144bab...jsonl:10197`: *"I feel like we're just wasting time, resources, and money here on Vmake... just nuke the entire thing"*) → replaced the same morning with MiniMax-Remover + tracked blur (`cf6dbde6`) → **6 fresh agent bug reports on `mandalorian` within 10 hours** (`EISDIR`, whole-frame blurs, stale covers, `unmark` leaving blurs, strips turned into cloud URLs breaking filename checks in `6bb32205`).
- **Inferred:** This is why Sphe described the app on Nov 8 (`rollout-2026-11-08...jsonl:17`) as *"various webs branching out in the app. We just don't seem to realize that, okay, here are the areas in which things can go wrong."* Every fix to one branch silently breaks or duplicates another.

### Root Cause 3: Untyped, string-matched error handling paired with destructive/terminal escape hatches (~15% of the pain)

#### Case Study: JJ's Wi-Fi Drop (`6e1275e3`, `268f4bc0`, `30a17052`)

1. **What happened (Observed):** On Nov 18 (`nightly-87`, JJ's *School Bookkeeper*), JJ's Wi-Fi dropped mid-Script-import. The interview file failed with `'could not reach Edit's relay: The socket connection was closed unexpectedly'`. After two short retries (1m, 5m), `script.ts` ran `steps.whyOf(error)` and evaluated `whys.every((why) => why === "quota" || why === "encoder" || why === "limit")` (`script.ts` pre-`6e1275e3`). Because a dropped socket matched none of those three strings, it fell into the `else` bucket: **"waiting for the person"** (`"1 of N footage files couldn't be downloaded"`). When JJ's Wi-Fi returned, he saw a polite `"Go on without it"` button (`WaitingFiles.tsx`)—originally given a batch `"*"` shortcut in `268f4bc0` (Nov 4). Clicking it ran `edited.script.blocks = edited.script.blocks.filter(...)` (`script.ts:124` pre-`6e1275e3`), **permanently deleting all 19 interview ranges** and laying out 2:44 of door footage for a 25-minute video. JJ had to delete the project and start over.
2. **Why it was possible & what class of bug it is (Observed + Inferred):** It is a **three-part structural failure class**: *(i) Default-terminal error classification via regex/substring matching on stringified errors* (unknown error → blame the user / stop the job), *(ii) an irreversible, lossy recovery mutation disguised as a neutral UI action*, and *(iii) cross-layer inconsistency* (even `missing_media.ts`'s separate "Go on without it" in the editor still crashed exports with `could not decode the sound of ...` until `6e1275e3` patched `playable()` into 3 separate callers).
3. **Proof the fix only patched one instance (Observed):** Literally **6 hours after `6e1275e3`**, JJ's *Scissors Attack* on `nightly-89` (`30a17052`) hit the exact same shape: a 6.3 GB moov-at-end Axon MP4 hit a 2-minute keyframe `ffprobe` timeout and a 0.6 s B-frame duration check (`29.8 s vs 29.2 s`)—and once again fell straight into asking JJ `"I have a replacement"` / `"Go on without it"`. Even post-`6e1275e3`, `import_steps.ts:104-137` still relies on 4 giant regexes (`QUOTA`, `CREDIT`, `DAILY`, `PERSON`) over arbitrary error strings, and `script.ts:127` encodes `"gone without"` as a magic prefix string stuffed inside an untyped `block.notes: string[]` array.

#### How many other places in the codebase have this exact shape?

Across `app/apps/server/src`, **46 files classify errors by regex/substring matching on text**, and **162 files contain 405 silent/empty/fallback `catch` blocks**. Concrete instances verified directly in code right now:

| # | Location | Same structural shape | Observed impact |
|---|---|---|---|
| 1 | `writer/imports.ts:1529-1531` | `media.streams(path).catch(() => { throw new Error("Could not read ...") })` swallows the real cause and throws an untyped error inside `joinPreview()`, **aborting the entire script import** despite `writer/missing.ts` supposedly isolating missing files. | **Live on JJ's MacBook Pro right now (`nightly-90`, Nov 19 11:51 UTC):** *Mom Of 4 Meets New Man On Tinder* stopped on `Could not read BenjaminCunningham_202401112341_02619-0.` |
| 2 | `accounts.ts:122-130` | When an access token is within 30 s of expiry (e.g. after laptop sleep), `accessToken()` fires `void renew()` and **immediately returns `null`**. All concurrent callers fire unauthenticated, get HTTP 401, and persist `"Sign in to Edit (401)"` as a sticky project/sync failure. | **Live on Marc's Mac right now (`nightly-84`, Nov 19 11:43 UTC):** signed in, relay 232 ms, yet project `p1794971933004-17806` stuck under *Needs attention: Sign in to Edit (401)*. |
| 3 | `jobs.ts:105, 439-446` | `MOST_RESUMES = 2`: any non-`BACKS_OFF` job (`share`, `case`, `turn`, `writer`, `script`, `idea`, `thumbnail`, `map`—and until Nov 18, `archive`) interrupted by 3 unplanned restarts/crashes flips permanently to `given_up`, requiring admin `unstick`. | **Live on Marc's Mac right now:** `archive:p1794249007710-7117` stuck `given_up: cut short by 3 restarts in a row`. |
| 4 | `retry_after_update.ts:187` | On *any* failed export/share retried after update—including pure network/401 upload failures—runs `fs.rmSync(folder, { recursive: true, force: true })`, destroying valid rendered chunks. | Throws away 8–10 minutes of valid VideoToolbox work on transient upload errors. |
| 5 | `storage.ts:79-83` | If `statfsSync` fails (external volume / macOS permission prompt), `diskHooks.free()` returns `Number.POSITIVE_INFINITY`, silently bypassing every disk-space check until writes hit `ENOSPC`. | Contributed to unguarded disk exhaustion (`stability-audit-astra.md:42`). |
| 6 | `missing_media.ts:36, 159-235` | Machine-local `footage-gone-without.json` waivers never sync; retry timers live only in memory (`tries` Map); export safety relies on remembering to call `playable()` in every consumer. | Cross-Mac waiver loss; export crashes whenever a new consumer reads `project.clips` directly. |
| 7 | `writer/cloud.ts:396-418` + `1220-1285` | Sub-threshold uploads fail wholesale on socket drop; multi-GB preview uploads serialize ahead of/beside script sync on an 8 Mbit/s line (`council-astra.md:7-9`). | 309 of 355 WARN/ERROR lines in JJ's 7-day log are `network/relay/R2/timeout` (including 100× `part 813 of ...proxy.mp4 failed`). |
| 8 | `serve.ts:246-252, 462` | Lock collision only logs `WARN`; `uncaughtException` only logs `ERROR` and keeps serving corrupted process state. | Silent state divergence instead of fail-fast + clean restart from durable state. |

### Root Cause 4: Single-process blast radius & unbounded resource contention (~10% of the pain)

- **Claim 4.1 (Observed):** One Bun process owns HTTP (`~317` `/api/*` routes), `127` MCP tools, `31` background pollers, the in-process Rust `.node` addon, headless Chrome orchestration, FFmpeg spawns, Python workers, and Claude Code child processes.
- **Evidence (Observed):**
  - **Native crash kills everything:** On Sphe's M4 (Nov 18 05:18:49), a `SIGABRT` on `tokio-rt-worker` inside `.bun-501-*.node` terminated the entire server (`crashes` output), with symbols stripped in release builds until `e613c7d3` (Nov 18).
  - **One semaphore starves the machine:** `effects.ts:1706` holds a single global Chrome render slot for up to **34 minutes** (`stability-audit-astra.md:70-72`), causing a *different* project's title-card tool on M4 to time out after 10 minutes waiting behind it.
  - **Event-loop stalls freeze the UI:** `cache_cleanup.ts:208` walks the entire cache tree synchronously on the Bun loop (~9 s on a slow disk, `plan.md:117`); `writer/cloud.ts` synchronously scans 120+ script folders every 3 s (`council-astra.md:15`). Marc's latest report logs `32× WARN [ui] The page was stuck for 2.0 s`.
  - **Unbudgeted disk wrecks bookkeeping:** On Nov 16–18, M4 hit **309 `ENOSPC` errors** across 3 bursts (`stability-audit-astra.md:40`), stopping `cloud/projects.json` saves and Writer sync (`latest` report: `11× ENOSPC ... cloud/projects.json`, `9× ENOSPC ... writer sync stopped`), while speculative `export_ahead` wasted ~80 minutes of encoding across 9 runs on JJ's Mac in one day without reusing a single chunk (`council-fable.md:26-31`).

### Root Cause 5: Hyper-velocity multi-agent development without isolation, soak gates, or release discipline (~20% of the pain — and the multiplier behind #1–#4)

- **Claim 5.1 (Observed):** In roughly **6.5 weeks** (Oct 2026–Nov 19, 2026), Edit grew to **320,504 lines of code** across 1,162 files (2,172 commits since W40; **1,732 in the last 30 days**; **102 commits/day** on both Nov 16 and Nov 17).
- **Claim 5.2 (Observed):** The codebase is in a **churn death spiral**:
  - **55.9%** of the last 30 days' commits (969 of 1,732) have fix-like subjects.
  - **35.8%** (620 of 1,732) explicitly cite JJ, Marc, Sphe, M4, kenobi, or a `nightly-N` incident.
  - **21.1%** of the last 14 days' commits (171 of 812) are CI fixes, reverts, flaky-test patches, or mis-staged hunk repairs.
  - **99 commits in 30 days** explicitly cite an earlier commit hash in their subject to patch or revert it.
- **Claim 5.3 (Observed):** Multiple coding-agent sessions edit the **same working tree on `main`** concurrently (`77eb9a35...jsonl:5`: *"Other sessions share this checkout: never `git stash`, commit with `git commit -o -- <paths>`"*), actively corrupting files in production commits (`2388963a`: *"exports.ts parses again: 3eccb6ee committed archiveFinished's comment opener above Archived's instead (a hunk staged without context)"*; `3038ff96`: *"Puts back in place the lines cbf3e538 and 494e01b3 staged at the wrong spot beside other sessions' edits"*).
- **Claim 5.4 (Observed):** CI (`Check`) failed **134 of 299 runs (44.8%)** in Nov 4–18 (`stability-audit-astra.md:162`), with confirmed flaky retries; meanwhile the team shipped **3–8 nightlies/day** (90 nightlies in ~30 days), turning JJ's and Marc's live video deadlines into the real QA phase. Even Sphe's own Linux workstation froze and required hard reboots twice from OOM on Nov 17 (`b85fba94...jsonl:631`).

---

## 3. Why the audits (and 2,700 tests) miss what the team hits

Edit has **2,703 automated tests** (1,900 server, 568 web, 235 Rust) plus `app/scripts/acceptance.ts`—yet JJ and Marc hit showstopping bugs every single day. Here is specifically why:

1. **Zero real-process fault testing (Observed):** Across all 301 server test files, **0 files spawn and restart a real Edit server process** (only 6 even boot the HTTP app). Restart/resume tests call `jobs.takeOver()` in-process with fake state, never `SIGKILL`ing a running server with live FFmpeg/Claude/upload children and 297 populated in-memory maps.
2. **The acceptance test explicitly turns off the cloud and the native player (Observed):** `app/scripts/acceptance.ts:103-107` sets `EDIT_ACCOUNTS_URL=http://127.0.0.1:9` and `EDIT_RELAY_URL=http://127.0.0.1:9` (*"Signed out, so the cloud is off and the footage stays on this machine"*), uses tiny FFmpeg synthetic test sources, runs in headless Chrome (not `Edit.app`), downgrades timings to warnings and scrubs to skips on GitHub's virtual Mac (`HOSTED = true`, lines 65–74), and its `--native` CI job (`check.yml:271-295`) has no enrolled runner AND is broken at sign-in (`TODO.md:14`).
3. **Tests validate the mock seam, not the boundary (Observed):** Because agents write the fix and the unit test in the same reactive commit—using `seams.ts`, fake timers, and 2-second synthetic clips—the tests prove only *"if function X receives exact string Y, it returns Z."* They never test:
   - **Real messy media:** 6.3 GB Axon bodycam MP4s with moov-at-end and 8.3 s GOPs (`30a17052`), non-interleaved DVR `.avi`s (`nightly-87`), truncated `.wav`s (`writer/imports.ts:1529`), or 2-hour 191-file compilations (`6.8 GB` originals).
   - **Real degraded networks:** JJ's 8 Mbit/s Norwegian uplink with mid-transfer socket resets, DNS `ETIMEOUT`, and 60-minute sleep/wake token expirations (309/355 of JJ's 7d errors!).
   - **Real multi-feature interaction:** A long Chrome subtitle render + active removal + export-ahead + cache cleanup + auto-update + 18 GB free disk colliding simultaneously.
4. **Why prior *model* audits felt like "4/10 fixes" (Observed + Inferred):** Look at `council-brief.md` (Nov 18) and `stability-audit-astra.md` (Nov 18): both briefs implicitly assumed *"keep the 141k-line server, find what fits in `nightly-88`."* When you ask an agent to audit a 320k-line app under a "ship-sized fixes for tonight's nightly" frame, it faithfully gives you 12 local patches—never stopping to point out that you are patching three parallel missing-footage systems and 133 JSON files.

### What exact method would have caught JJ's Wi-Fi incident before JJ did?

A **30-minute chaos/fault-injection soak suite** running against a real compiled `Edit` binary (with a local proxy like `toxiproxy`/Bun TCP proxy simulating relay + R2 + Drive) enforcing **five invariant assertions**:
1. **Mid-import network severance:** Start a real multi-file Script import (including one 2+ GB moov-at-end MP4) through an 8 Mbit/s proxy; drop the TCP socket mid-transfer for 3 minutes, then restore it. **Invariant:** *Zero user prompts appear; import auto-recovers and finishes 100% intact.*
2. **Destructive-action blast-radius check:** On any UI button presented during an error state (`"Go on without it"`, `"Retry"`, `"Cancel"`), assert **zero silent deletion of user script blocks or timeline clips** (content-loss check: timeline duration and script block count must not silently collapse by >0% without an explicit reversible placeholder).
3. **Real `SIGKILL` mid-import / mid-upload / mid-export + restart:** Kill the server process abruptly 3 times in a row, restart, assert no orphaned FFmpeg/Claude processes and zero jobs stuck in `given_up` for transient/restart reasons.
4. **Sleep/wake + expired-token burst:** Freeze network for 65 minutes (or fast-forward token expiry), wake, fire 20 concurrent API/sync calls. **Invariant:** *Single token refresh awaited by all callers; zero sticky 401 errors.*
5. **Low-disk squeeze:** Run import + effect render + export against a 20 GB loopback disk image. **Invariant:** *Clean pre-flight refusal or idle-project eviction; zero `ENOSPC` in bookkeeping/sync.*

---

## 4. What to keep (the crown jewels)

Do **not** throw these away—they are why Edit is worth saving and why Premiere cannot replace it:

1. **The Rust core & native macOS player (`edit-core` 6.7k LOC, `edit-render` 6.1k LOC, `edit-window` 2.3k LOC, and the decode/mix/player/export core of `edit-engine` ~23k LOC).** *Observed:* Low churn (20–43 commits/month on `edit-core`/`edit-render`/`edit-window`), deterministic frame-exact JSON timeline model, shared compositor between live preview and export, CoreAnimation layer under Tauri, VideoToolbox decoding/encoding, CoreAudio + WSOLA 2× pitch-preserved playback (`docs/preview.md:49,127`: 4,810/4,824 frames drawn, p99 13 ms, 0 underruns when files are local).
2. **Edit V2: coded effects + channel teaching/lessons + instant viewer bench (`effects` runtime contract `window.seek(t)`, channel library).** *Observed:* Sphe on Nov 12 (`8f936b38...jsonl:2187`): *"fable 5.2 and our new effects as code is just INSANE!!!!!"* Delivers ~4× After Effects breadth (`docs/plans/2026-11-10-edit-v2.md:25`) without waiting on app releases for every graphic tweak.
3. **The `agent/` skills, house style rules, and visual-feedback MCP loop (`render_frame`, `contact_sheet`, `look_at_media`, `apply_edit_plan` with structural audit).** *Observed:* This encodes your team's actual YouTube editing taste and is what turns a 2-day manual edit into an agent turn.
4. **Script mode's writing & review workflow** (assembling a case transcript, producer comments tied to words that carry into the edit, Google Doc export/import) — keep the **UX and prompts**, rewrite its broken sync/import plumbing underneath.
5. **Review links (`feedback.spheceo.com` + Convex) and Cloudflare R2 as durable cold storage for originals** ($26–34/month for 1.1 TB, Convex <$10/month per `1c726ce8...jsonl:6560`). Keep R2 for **originals backup and Mac-to-Mac handoff**, never for frame-by-frame streaming.
6. **The Tauri shell + React editor workspace (`Timeline.tsx`, `Viewer.tsx`, `AgentPanel.tsx`, `GraphEditor.tsx`).** Keep the UI shell; rip out the duplicate playback/cache/import plumbing underneath it.

---

## 5. What I'd cut (or freeze immediately)

Every line of code you delete is a bug that can never happen. Cut these aggressively:

| Cut / Freeze | Approximate size | Why it costs more reliability than it's worth |
|---|---:|---|
| **1. Entire cloud-streaming / pieced-proxy / smooth-render playback stack** (`proxy_pieces.ts`, `cloud_blocks.ts`, `playback_render.ts`, `playback_stream.ts`, `native_preview.ts`, `export_excerpts.ts`, `scrub.ts`, `web/lib/smoothStream.ts`, `web/lib/decoder.ts`, `web/writer/playback.ts`) | ~10,000–12,000 LOC TS | Responsible for 514 commits in 30d, 6–9 GB disk blowups per video, and 5 competing frame paths. Replaced cleanly by 1 local file (original or 1 plain 720p seek proxy) + native macOS player (native fullscreen next). |
| **2. Speculative `export_ahead.ts`** | ~200 LOC + massive runtime blast radius | Burned 80 min of JJ's CPU on Nov 17 with **0% reuse** (`council-fable.md:30`), ate 7.8 GB of Sphe's M4 disk on unsettled edits (`stability-audit-astra.md:90`), and starved playback (2,548 dropped frames on JJ's Mac). Reintroduce *only* after core stability is proven—if ever needed once local exports take 15–30 s. |
| **3. In-app AI subtitle/watermark removal (Vmake already nuked; freeze MiniMax & tracked-blur R&D inside core Edit)** | ~5,650 LOC TS + ~8,700 LOC Rust | Churning 18+ commits every 4 days, burned 524 Browser Use sessions, triggered 6 new bug reports within 10 hours of switching to MiniMax today, and destabilizes timelines (`clean_strips.ts` invalidating 50 effects). Keep only **simple deterministic crop/static-blur** inside Edit for now; if AI inpainting is essential, run it as a **standalone external CLI/batch tool** that outputs clean MP4s before import, never wired into Edit's save hook (`Store.enforceRoom`)! |
| **4. Dual V1 + V2 maintenance** (freeze V1 house graphics & 6 legacy niches; 127 MCP tools → ~40) | ~5,650 LOC V1 generators + half of `edit_tools.ts`/`edit_plan.ts` | Maintaining V1 and V2 simultaneously splits every prompt, subtitle, caption, and UI change in two. Freeze V1 on read-only legacy support (zero new features) and commit to V2 channels, or cut V2 until V1 is stable—**do not evolve both at once**. |
| **5. `Ideas` (`4,150 LOC`) and `Thumbnails` (`4,779 LOC`) inside Edit's core server** | ~8,930 LOC | Completely unrelated workflows (Trello/web research/image cutouts) bolted into the same Bun process, `jobs.json`, `busy.ts`, and release cycle. Freeze them now; split into a separate lightweight web app later so a Trello/Bing/OpenArt change never forces an Edit desktop nightly. |
| **6. `seams.ts` (`1,014 LOC`) & partial Effect-TS (`19 files`)** | ~1,014 LOC + cognitive split | Replace with explicit constructor/context dependency injection and **one** consistent TypeScript error-result convention (`Result<T, TypedError>` or Effect everywhere—never 5% Effect + 95% throw/regex). |
| **7. Auto-updating 5–8×/day & silent `"Go on without it"` / `retry_after_update` destructive resets** | Process & UX | Replace with **1 weekly stable cut** (or at most 1 nightly/day after canary), opt-in update when idle, and zero destructive error buttons. |

---

## 6. The Plan: how to execute without stopping video production

### How to keep making videos during the rewrite (Zero-downtime split)

1. **Day 0 — Cut a `prod-stable` branch from `nightly-90`** (plus 2 surgical 1-hour hotfixes: `writer/imports.ts:1529` so JJ's script import doesn't abort on one unreadable file, and `accounts.ts:122-130` so token renewal is awaited instead of returning `null` 401s). **Freeze `prod-stable`**: for the next 3 weeks, ONLY P0 production blockers are cherry-picked to it, max 1 release every 2–3 days, tested on `kenobi` first. JJ and Marc stay on a quiet, unchanging build that stops moving under their feet.
2. **Stop concurrent agents on a shared checkout immediately.** Every agent works in its own git worktree and merges via PRs that pass CI. Zero `git commit -o` on shared dirty trees.
3. **Build the rewritten server spine on a dedicated `v3-spine` branch** (using the existing Rust crates, Tauri shell, React editor, and `agent/` untouched at first, swapping modules behind clean interfaces):

### Ordered Rewrite Roadmap (~18–24 agent-days at your team's pace, 3–4 calendar weeks with verification)

| Phase | What gets rewritten | Into what | Rough size |
|---|---|---|---|
| **Phase 0: Chaos Harness & Kill-Switch** | Build the real-process fault-injection suite on `kenobi` (8 Mbit/s proxy, mid-transfer socket drops, `SIGKILL` × 3, 65m token expiry, 20 GB disk cap, 6.3 GB moov-at-end Axon fixture, 2-hour compilation fixture). Fix `--native` acceptance sign-in. | Automated canary gate run before every single nightly. | **2–3 days** |
| **Phase 1: SQLite State Store & Unified Job Supervisor** | Replace the 133 JSON state files, `jobs.ts`, `busy.ts`, `storage.ts`/`ledger.ts`, and 297 module-level maps (for durable state) + `holdDataLock` + swallowed `uncaughtException`. | **One `bun:sqlite` WAL database** (`~/.edit/edit.db`, strict migrations, single-writer process lock that refuses double-launch) holding projects, scripts, media assets, disk byte ledger, sync outbox, and a **single durable job state machine** with explicit typed errors (`TransientNetwork`, `AuthExpired`, `DiskFull`, `PermanentUserAction`, `Canceled`). One `activeWork()` query feeds `busy`, `keepAwake`, and `update`. | **5–6 days** |
| **Phase 2: Unified Local-First Media & Single Player** | Delete the 5-path cloud streaming stack (`cloud_media.ts`, `proxy_pieces.ts`, `cloud_blocks.ts`, `playback_render.ts`, `playback_stream.ts`, `native_preview.ts`, `export_excerpts.ts`, `scrub.ts`, `export_ahead.ts`, `web/lib/smoothStream.ts`, `web/writer/playback.ts`). | **One Media Store** (SQLite-tracked originals + at most one plain local 720p seek proxy; R2 holds originals only; state-based whole-project eviction with 15 GB / 10% floor and pre-flight byte admission) + **one macOS native player** (including native fullscreen). | **5–7 days** |
| **Phase 3: Unified Ingestion & Sync Daemon** | Collapse `script.ts` + `writer/imports.ts` + `missing_media.ts` + `writer/missing.ts` AND collapse `cloud_projects.ts` + `writer/cloud.ts` + `accounts.ts` token handling. | **One Ingestion Pipeline** (resumable downloads, local-first probing/cutting, non-destructive placeholders on permanent failure, automatic quiet retry on transient failures—zero destructive buttons) and **One Sync Daemon** (single auth-awaiting HTTP client, SQLite transactional outbox, metadata/text commits independent of multi-GB resumable R2 uploads, single destination health circuit-breaker). | **4–5 days** |
| **Phase 4: Worker Isolation & Scope Cleanup** | Pull native `.node` exports/analysis and Chrome effect renders out of the main Bun HTTP/UI server process; freeze V1 / Ideas / Thumbnails; remove `seams.ts`. | Supervised child worker processes (`edit-worker` for native exports/heavy FFmpeg; chunk-preemptive Chrome effect worker so short projects never wait 34 min behind long ones). Main server stays thin, fast, and un-crashable. | **3–4 days** |

### What "Stable" is measured by (concrete exit gates)

Edit is **not** declared stable by "2,700 unit tests passed" or an audit report. It is stable only when **all six numbers hold for 14 consecutive days across JJ, Marc, and Sphe's Macs**:
1. **Zero data-loss incidents** (zero lost projects, zero lost script blocks, zero overwritten edits).
2. **Zero `ENOSPC` errors** on project/sync bookkeeping across all Macs (including Sphe's 245 GB M4).
3. **Zero user-facing prompts caused by transient network/auth/codec-probe glitches** (Wi-Fi drops, sleep/wake token renewals, and moov-at-end Axon files recover silently with 0 manual clicks).
4. **Zero `given_up` jobs requiring admin `unstick`** and **zero server crashes (`SIGABRT`/unexplained stop)** across 14 days.
5. **Playback & UI responsiveness:** `0` UI freezes >500 ms during background cleanup/sync; native playback ≥99.5% frames drawn with `0` audio underruns during active imports/edits; short project effect renders start within ≤1 chunk (<30 s) even behind a 1-hour render.
6. **Release discipline:** ≤1 nightly/day, **0** cadence overrides except documented P0s, **100%** passing the `kenobi` chaos/soak canary before any teammate receives a build, and fix-commit share dropping below **25%** of weekly commits (down from **55.9%** today).
