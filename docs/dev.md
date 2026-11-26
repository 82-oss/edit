# Development & Releases

Keep this file short. Feature details go in a comment at the top of the code they describe, not in a doc. Work not yet done goes in `TODO.md`, and is deleted from it when done. A plan is deleted once it is built.

Rust is for the engine, the player and the project's model; TypeScript is for the part that waits on networks, disks and people (decided Nov 19; not to be argued again without new evidence).

## Commands

Run `just` from the repo root or `app/`:

```sh
just dev           # server on :7700 + Vite hot reload on :5173
just dev-server    # server alone (auto-restarts on change/exit/hang)
just native        # rebuild Rust napi addon and swap it in
just wasm          # rebuild WASM engine after edit-core / edit-render changes
just types         # regenerate packages/edit-types from Rust (ts-rs)
just app           # build everything and open the desktop app
just check         # fmt, clippy, tests, typecheck, lint
just trial-server  # start|stop|restart|status|code|log (:7710, ~/.edit-trials)
just nightly       # tag and publish a nightly (only with permission)
```

Data lives in `~/.edit` (prod) or `~/.edit-dev` (`just dev`).

A server an agent starts in its own shell on Linux is stopped when that agent's turn ends, even under `setsid nohup` (T3 Code keeps each agent's processes in a group it ends): start one that has to outlive the turn with `systemd-run --user --unit=<name> …`. A server run from source serves the UI from `apps/web/dist`, which needs `just wasm` and then `just web` first; neither needs a restart (Nov 26: prod Edit on mandalorian went down mid-export when the Trooper thread finished).

## Dev vs Prod

Dev and prod stay separate so dev work never touches team installs:

| | Dev (`just dev`, trial server, agents) | Prod (installed nightlies & releases) |
|---|---|---|
| Relay | `edit-relay-dev` (`wrangler [env.dev]`) | `edit-relay` |
| Secrets | Infisical `dev` `/edit-relay` | Infisical `prod` `/edit-relay` |
| Convex | `determined-heron-867` (mamagi `development`) | `unique-shrimp-228` (mamagi prod) |
| R2 | `edit-dev` bucket | Bucket shared with Repack |
| Data folder | `~/.edit-dev` (`EDIT_HOME`) | `~/.edit` |
| Channels & groups | **Shared from prod** (`LIVE_RELAY`), teaching kept per environment | Prod list |

- Copy a prod project into dev (read-only on prod): `just copy-to-dev --list` / `just copy-to-dev <id or name>`.
- Deploy dev relay manually (`npx wrangler deploy --env dev` in `app/apps/relay/`). **Never deploy the prod relay by hand** — tagging a nightly deploys it via `release.yml`.

## Releases

- **Nightlies only unless told to bump a version (`just publish`).**
- **Nothing ships past a red Check, and at most one nightly a day** (`just nightly --force "<reason>"` only for urgent fixes).
- Push to `main`, wait for CI (`check.yml`) to pass, then `just nightly`.
- Linux builds/checks run on stable `v*` releases only; nightlies build Apple Silicon macOS (`aarch64-apple-darwin`).
- The first clause of a commit message is what `app/scripts/nightly-notes.ts` surfaces in the team's nightly notes.

## Rules that must hold on the team's Macs

Most of the month's breakages were rules that sounded right and were wrong on one real Mac (Nov 19: Edit kept a tenth of every disk free, which counted JJ's 494 GB Mac with 41 GB free as full). Two rules for every change:

- **A changed number comes with what it means on each Mac.** A free-space floor, a room check, a time limit, a size: add it to `apps/server/test/storage_machines.test.ts` (or a test beside it), which holds rules against every state a Mac can be in (empty to full) and the rules of scale (more free room, a bigger disk, a slower line or a bigger file is never worse off, only slower), and prints a plain line per Mac. Paste those lines into the commit message ("JJ: keeps 15 GB free, has 41; keeps here 2, 5.5 and 12 GB").
- **Every wait names what ends it.** Work that waits (the job table, a dialog, a retry) says what it waits on, and a test shows that doing what its line says ends it. Only an import's question waits on the person (`apps/server/test/census.test.ts`); a wait that isn't moving after five minutes reports itself, and each Mac's report checks Edit's rules against its own disk and line (`remote_actions.ts` `selfCheck`).
- **The bad-day run** (`just bad-day`, in `app/`, on Linux and macOS) breaks the line, freezes and kills Edit, and fills the disk on purpose; run the cases a change touches before it ships. Every case also fails if Edit stops answering for 2 s.
- **Nothing keeps the server's one thread.** Every page, play and progress line waits its turn on it (Nov 20: a sync round writing its ledger once a script froze Edit 20 to 30 s of every minute, on every Mac, for three weeks). No synchronous read, write, copy or hash of a media-sized file, no synchronous program, and no loop over many items without `breather()` (`apps/server/src/thread.ts`: an `await` on something already settled does not give anything else a turn). A hold of 2 s or more is a `[thread]` line in the log and in the Mac's report: read them after each nightly.
- **Run the server's tests the way CI does before pushing** (`bun test --timings=test/timings-mac.json --shard=N/3` in `apps/server`, and `vitest run` in `apps/web`): a test that passes alone can leave a lane held or a promise open for the files after it.

## By hand on a Mac

Before shipping a nightly that touches playback, sync, or imports:

1. **Edit.app's player**: from `app/`, `just native && just web && cargo build -p edit-window --release`, then `bun scripts/acceptance.ts --native target/release/edit-window` (port :7796 free). Passes: no frame >100 ms, `native=true`, every draw `Ok`.
2. **Cold cloud footage & cuts**: signed in, nothing exporting, `rm -rf ~/.edit/cache/cloud`, open a cloud-only edit, play across five cuts, scrub the timeline twice. Passes: first frame ≤3 s, no "Loading frame…" >1 s after the first minute, second scrub <100 ms/position.
3. **Full screen in Edit.app**: press `F` while playing, play 10 s, press `Esc`. Passes: no black frame either way, native preview keeps drawing.
4. **Script mode**: open a script with footage, play 10 s from the middle and scrub words. Passes: audio/video in sync, every scrubbed word shows its frame.
5. **Sleep & wake**: start a 20-min video import and an export on another project, close lid 10 min, open. Passes: both resume from where they were, `<home>/jobs.json` lists each once.
6. **Wi-Fi off mid-upload & mid-save**: share a ~2 GB export, drop Wi-Fi at ~40% for a minute; rename a project offline and quit before reconnecting. Passes: upload resumes without resetting to 0%, rename syncs cleanly with no duplicate history toast.
7. **Two Macs concurrently**: two teammates edit separate scripts/edits for 5 min. Passes: changes appear within a minute with no false takeover or "Not synced" copies.
