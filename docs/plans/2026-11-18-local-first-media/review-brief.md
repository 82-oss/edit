# Question for an independent review: should Edit's footage become local-first?

You are reviewing a product/architecture decision for Edit, a desktop video-editing app (repo: /home/spheg/Documents/code/edit; read AGENTS.md and app/AGENTS.md first). READ-ONLY: change no code, make no commits, run no releases, and on remote Macs run only read-only questions.

## The situation (Sphe, who builds Edit)
Edit has been in team use for about a month (repo since July 17, ~2,100 commits). It works: the team ships many long videos (1–2 hour compilations of bodycam footage for YouTube channels) with an in-app AI agent editing in each channel's taught style. But the same three things have kept breaking since the start: PLAYBACK, STORAGE (disk filling up), IMPORTS. The team is looking at alternatives. Sphe is reflecting on two early decisions: (1) Tauri with a non-native web player, and (2) footage living in the cloud (R2), streamed/cached to the Mac, rather than local files.

## The proposal on the table (from the coding agent working with Sphe; judge it, don't assume it)
"Local-first media": each project's footage lives whole on the Mac that edits it (downloaded once at import: the original plus one proxy made for seeking); the cloud stays for backup and handoff between Macs, not the path frames take to the player. Plus "one player": today there are three things that must draw the same frame (the web player via a WASM engine, the Mac window's own native player in edit-window/edit-engine, and the export engine); unify on one engine on the Mac. The claim: this deletes, rather than fixes, layers like pieced proxies, the stitched loopback stream, the window's native piece copies, much of the cache guessing.

## Sphe's concern
"The local-first plan will lead to insane storage getting used up across many projects."

## What we want from you
An honest, evidence-based answer to: Is local-first right for Edit? Does the storage concern sink it, and if not, what design makes storage bounded and predictable across many projects (e.g. what's kept local, when it's evicted, proxies vs originals, per-project budgets, archiving finished projects, what the cloud still does)? Is there a better alternative (a hybrid; keep cloud but fix specific layers; a shared Mac with big storage, which a teammate once suggested; anything else)? What about the player unification and Tauri: worth it, what order, what risk? Quantify wherever you can (GB per project of originals vs proxies vs derived files, how many active projects per person, disk sizes of the team's Macs, how often edits move between Macs). Say what you're unsure of.

## Evidence to use
- The code: app/apps/server/src/cloud_media.ts, proxy_pieces.ts, native_preview.ts, cache_cleanup.ts, storage.ts, playing.ts, exports.ts, export_ahead.ts, text_removal.ts, clean_strips.ts, effects.ts; app/crates/edit-engine (render.rs, mac_media.m), app/crates/edit-window, app/apps/web (player, WASM engine); docs/preview.md and other docs/.
- Git history (`git log`, by file and by topic) — what has broken and been fixed, repeatedly.
- A prior stability audit (GPT 6.2 Astra, this morning): /tmp/claude-1000/-home-spheg-Documents-code-edit/0c144bab-9d45-4d5b-9b08-b39f8f430992/scratchpad/astra-audit.md
- Notes from the coding agent's sessions (context, incidents, decisions): /home/spheg/.claude/projects/-home-spheg-Documents-code-edit/memory/ (MEMORY.md is the index; overnight-nov-17-jj-imports.md is last night's incident log; v2-storage.md, share-time-is-upload-bound.md, playback-*.md, cold-open-playback-nov-16.md, resource-climb-nov-17.md, r2-cleanup.md, youtube-proxy-sticky.md are relevant).
- The team's Macs, read-only, from app/: `bun apps/server/scripts/remote.ts devices`, `... latest <mac>`, `... ask <mac> system|work|log since=… grep=…|get /api/...`. Macs: siphesihles-macbook-air-m4 (Sphe's; may be closed now), mathiass-macbook-pro (JJ), macbook-air-von-marc-2 (Marc), kenobi (test Mac). The `latest` reports include disk free and Edit's data/cache sizes. NEVER use update, restart, sh, call with non-GET, agent, hold, unstick.

## Output
Write your report to the path given in your task (markdown, plain English, ranked conclusions first, then evidence and numbers, then open questions). Keep it as long as it needs to be and no longer. Then reply with a short summary.
