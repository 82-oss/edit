# Development & Releases

Keep this file short. Put feature details in code comments or dedicated topic docs under `docs/`, not here.

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
- The first clause of a commit message is what `scripts/nightly-notes.ts` surfaces in the team's nightly notes.

## By hand on a Mac

Before shipping a nightly that touches playback, sync, or imports:

1. **Edit.app's player**: from `app/`, `just native && just web && cargo build -p edit-window --release`, then `bun scripts/acceptance.ts --native target/release/edit-window` (port :7796 free). Passes: no frame >100 ms, `native=true`, every draw `Ok`.
2. **Cold cloud footage & cuts**: signed in, nothing exporting, `rm -rf ~/.edit/cache/cloud`, open a cloud-only edit, play across five cuts, scrub the timeline twice. Passes: first frame ≤3 s, no "Loading frame…" >1 s after the first minute, second scrub <100 ms/position.
3. **Full screen in Edit.app**: press `F` while playing, play 10 s, press `Esc`. Passes: no black frame either way, native preview keeps drawing.
4. **Script mode**: open a script with footage, play 10 s from the middle and scrub words. Passes: audio/video in sync, every scrubbed word shows its frame.
5. **Sleep & wake**: start a 20-min video import and an export on another project, close lid 10 min, open. Passes: both resume from where they were, `<home>/jobs.json` lists each once.
6. **Wi-Fi off mid-upload & mid-save**: share a ~2 GB export, drop Wi-Fi at ~40% for a minute; rename a project offline and quit before reconnecting. Passes: upload resumes without resetting to 0%, rename syncs cleanly with no duplicate history toast.
7. **Two Macs concurrently**: two teammates edit separate scripts/edits for 5 min. Passes: changes appear within a minute with no false takeover or "Not synced" copies.
