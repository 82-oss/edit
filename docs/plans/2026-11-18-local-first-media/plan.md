# Local-first media · plan (Nov 18, 2026)

Sphe, Nov 18: playback, storage and imports have broken again and again since Edit started, the team is looking at
alternatives, and the cause looks like footage living in the cloud. "The local first plan and the unification of
players sounds good but … I think will lead to insane storage getting used up across many projects." Two independent
reviews were asked (GPT 6.2 Astra, Fable 5.2; same brief, `review-brief.md`): `review-astra.md`, `review-fable.md`.
This morning's stability audit (`stability-audit-astra.md`) is the background. Sphe then: "go ahead end to end, use
kenobi to test … then release a nightly when done." This file is the plan and the record; delete the folder once the
work has shipped and nothing here is still needed.

## Decisions

1. **Footage is local while a project is in work; the cloud keeps every original.** One form per source on the Mac
   (the original, and at most one seek proxy as a plain file), read by the player, the agent's looks, export, removal
   and analysis. The cloud (R2) holds originals, hands scripts and projects between people, and syncs projects, locks,
   lessons and reviews. Frames never travel from the cloud on the way to the player.
2. **Storage follows the project's state, automatically, with no settings** (Sphe's concern). In work: kept. Idle:
   derived copies go first, then proxies. Done on Home, or idle about a week: its local footage goes, originals only
   once R2 has confirmed them. Opening it again brings it back, with a progress line. Whole projects are evicted, oldest
   first (half a project is neither playable nor freed).
3. **Keep Tauri.** The window is already a native picture under a see-through page; the window's player and export
   share decoders, mixer and compositor (since Nov 6). Finishing "one player" (native full screen, the page's player
   off on Macs) comes after the media change.
4. **No shared Mac for playback** (the same streaming problem over a home line). Maybe later as an overnight
   agent/export worker, for other reasons.
5. **A nightly at most once a day**, each after a canary on kenobi (below).

## What the reviews measured (keep these numbers)

- One 113-minute YouTube video: original 1.81 GB; today's preview forms 6.1 GB (pieces 2.93, joined 3.07, sound
  0.13), up to ~9 GB with the window's copies; plus export excerpts fetched back from R2 (12 GB in mandalorian's dev
  cache). Today's proxy is ~26 MB a minute (~3.5 Mbit/s fixed), bigger than most YouTube originals (0.2–2.75 Mbit/s).
- Single-case edit originals: median 1.2 GB (0.1–5.5, 23 dev projects). A 2-hour compilation: 6.8 GB of originals
  (one sample, 191 files), ~11 GB at today's proxy rate. Killer Pastor: 3.0 GB originals, ~6.1 GB proxies.
- Other derived files per compilation on the M4: export-ahead 7.2–7.8 GB, smooth renders 0.9, effects 0.4, cleaned
  strips 0.9, playback renders 1.1 GB.
- Macs (Nov 18): Sphe's M4 245 GB, 12–18 GB free, ~150 GB not Edit's (Edit 45 GB at the 22:03 disk-full). JJ 112 GB
  free, Edit capped at 50 GB, the cleaner freed 71.5 GB on Nov 17 (much of it likely downloaded again). Marc 37–48 GB
  free. kenobi (8 GB M1, test) 24 GB free after today's clean.
- **0 of 71 edit projects on the three team Macs are on more than one Mac.** Handoffs happen at the script (JJ's two
  scripts → Sphe's M4, Nov 17), not mid-edit.
- New edits a week on JJ's Mac: 18, 17, 9, 5 (Oct 26 – Nov 16). R2: 1,122 GB under edit/ on Nov 11, $26–34/month.
- History: local previews filled disks Oct 18–21 → "everything on the cloud" Oct 29 → R2 reads from South Africa
  ~0.25 s each, "super laggy" → work back on the Macs Nov 2, pieced proxies Nov 3, native player Nov 6, then more
  caches on a cloud-first model (blocks, lanes, hedged reads, holds, native copies, priming). A picture can come from
  five places (docs/preview.md). cloud_media.ts 98 commits since Oct 17, playback.ts 70, cache_cleanup.ts 36.
- JJ's 23.6-minute export: 5 min 54 s cold, 2 min 19 s of it fetching originals back from R2; 15–24 s with its parts ready.

## Steps

### 1. Storage rules (helps today, whichever way the media goes)
- **One ledger** of bytes by project and kind (original, proxy, derived: pieces, excerpts, strips, renders, export
  chunks, ahead exports), per disk, in `storage.ts`; files shared by projects counted once.
- **A floor:** keep the larger of 15 GB or 10% of the disk free (today: ~1 GB for the cleaner, 3–4 GB for copies).
  Edit may use the rest; drop the fixed 50 GB cap and the "quarter of free space" share.
- **Retention by project state** as decision 2: in work = opened in the last 3 days, or an agent turn, export,
  removal or render running, or anything of it not yet in R2. Never delete the last recoverable copy (not yet
  uploaded, a file from someone's disk that can't be fetched again).
- **Admission before work:** an import, an open or an export adds up what it needs, evicts idle projects, and if still
  short says so in one plain line with the number (no ENOSPC mid-work).
- **Derived files capped:** export chunks gone after the join (unless an ahead export is reusing them), one ahead
  export per Mac and only of a settled edit (done, f663f77a), one local copy of an effect render.

### 2. One day of measurement on kenobi (decides the proxy)
The native window playing straight off originals: first frame, jumps to 20 distant cuts, scrub, keyframe spacing
across many YouTube/Drive files, an 8 GB M1 under an agent's load; local proxy encode speed from a local file.
Rule to decide: originals with close keyframes play as they are; others get one viewer-sized local proxy (short GOP),
never uploaded.

### 3. Local media for new channel projects (~1–2 weeks)
Import downloads each source whole once (or, for a long source the cut uses a little of, the excerpt with handles
either side, linked to its original time), uploads the original in the background (never blocking), makes the proxy
locally if step 2 says so. Player, window, agent, export and removal read those files. Old projects stay on today's
path until they're Done. Another Mac opening a project downloads what it needs, the timeline's order first, with a
progress line. The pieced-proxy path, joined/, native2/, the stitched stream and export excerpts are retired on the
Mac path once the comparison below passes and old projects still open.

### 4. One player
Native full screen; the page's player off on Macs; then delete the smooth-render path. Linux and browser keep a
minimal viewer for development.

### 5. Tauri: nothing.

## Canary before every nightly (kenobi)
The exact candidate commit, a dev home seeded with old state (old native/ copies, a stopped export with chunks, a
removal piece outstanding), one long and one short edit side by side, renders, a restart and a sleep mid-work, low
disk. Gate: no ENOSPC, no duplicate paid sends, no crash, the short edit not stuck behind the long one, first/middle/
last frames right in player, window and export. Flaky tests fixed, not re-run to green. Never a teammate's project or
paid quota.

## Not fixed by this
YouTube refusing downloads (the biggest import failure), Vmake's speed, slow share uploads on an 8 Mbit/s line, relay
outages (backoff done, 3e1e8a72), effect render throughput.

## Open
- JJ's and Marc's disk sizes and Edit's size on each; how much of JJ's daily evictions is footage downloaded again.
- Compilation numbers rest on one project; measure the two from Nov 17 (p1794942765038-42080, p1794942792254-42588).
- Scrub speed off originals on an 8 GB M1; keyframe spacing across more files.
- Whether a local file's import finishes with the relay down (`putHashed` asks the registry first, cloud_media.ts).

## Log
- Nov 18: plan written; nightly-86 = today's stability fixes (2a74df1d … df340d53), after kenobi's canary.
