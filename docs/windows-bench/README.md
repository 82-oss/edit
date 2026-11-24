# Windows vs WSL for agent work: bench to pick up on Windows

Sphe is moving back to Windows (Nov 24, 2026). Edit doesn't need Windows support; the question is only
where the coding agents and Edit itself run best: **native Windows (Git Bash / PowerShell)** or **WSL2**.
Run `bench.sh` in each, paste the tables below, decide, then delete this folder.

## What our agents actually do (427 Claude sessions in this repo, Nov 7–24)

- 56k tool calls; 85% are `Bash`. Then Read 3k, Write/Edit ~0.7k each, subagents and T3 delegates ~0.5k.
- Bash by first word: `grep` 11.9k, `sed -n` 9.5k, `python3` 6.2k, `git` 3.2k, `cat` 3.2k, `timeout` 1.6k,
  `ls` 1.3k, `for` loops 1.2k, `curl` 0.6k, `bun` 0.5k, `gh` 0.4k, `until` waits 0.3k, `systemd-run` 0.3k.
- git: `diff` 601, `status` 562, `show` 484, `log` 367, `add` 294, `fetch` 242, `grep` 211, `push` 85, `commit` 66.
- 5% of turns send 2–6 tool calls at once; 900 Bash calls ran in the background.
- 79% of calls finish under 1 s (`grep`/`sed`/`git diff` p50 ≈ 0.03 s). **All calls under 5 s add up to 1.2% of
  agents' active time** (4.5 h of 390 h): the model's thinking dominates. A shell 5× slower on small commands
  costs ~5% wall time; what decides it is builds/tests (the long calls) and whether commands work at all.

## How to run

Same script everywhere; it changes nothing tracked (scratch goes in `app/target/bench-tmp`). Close other heavy work first.

| where | setup | command |
|---|---|---|
| Linux (done) | — | `bash docs/windows-bench/bench.sh --heavy` |
| WSL2 | Ubuntu in WSL, clone into `~/code/edit` (WSL's own disk), bun + rustup + python3, `cd app && bun install` | same |
| WSL2 on `/mnt/c` (the trap) | same repo cloned under `/mnt/c/...` | same, without `--heavy` |
| Windows, Git Bash | Git for Windows, bun, Python, rustup; clone on NTFS, `cd app && bun install` | in Git Bash: same |
| Windows, Dev Drive | same clone on a Dev Drive (ReFS, Defender in performance mode) | in Git Bash: same |

On a fresh clone `--heavy` builds cold the first time: run it twice and keep the second table.
Claude Code on Windows runs its Bash tool through Git Bash, so Git Bash is what an agent would really feel.
A `(FAILED)` row means the step doesn't work there (expected for parts of Edit natively: it has no Windows build).

## Decide

1. Steps that fail natively that agents need daily (`bun test`, typecheck, `cargo check`, `python3`, `systemd-run`
   memory caps, `just`) → WSL, whatever the speed.
2. Otherwise compare the long rows (tsc, bun test, cargo check, bun install) and the 4-at-once row; small-command
   rows matter ~20× less (see above).
3. Edit itself (the app and the GUI) only runs on Linux/macOS, so it lives in WSL either way; check that Windows
   Chrome reaches it on `localhost` and that exports/renders work on the GPU there (Vulkan is WSL's weak spot).

## Results

### Linux (mandalorian, Ubuntu 26.04, Ryzen 9 5900XT, 31 GB, ext4)
cpu: 32 threads · git 2.53.0 · bun 1.4.0

| step | runs | ms/run | total s |
|---|--:|--:|--:|
| spawn a process (env true)               |   300 |       2.5 |     0.76 |
| cat a 4k-line file                       |   200 |       2.2 |     0.45 |
| sed -n a range                           |   200 |       1.1 |     0.23 |
| wc -l                                    |   200 |       2.1 |     0.42 |
| grep -rn across server src               |    30 |       5.0 |     0.15 |
| grep -rn across whole app (no deps)      |    10 |      23.1 |     0.23 |
| python3 -c (startup)                     |    30 |       9.4 |     0.28 |
| bun -e (startup)                         |    30 |       4.8 |     0.14 |
| git status                               |    30 |       5.3 |     0.16 |
| git diff HEAD~1 --stat                   |    30 |       3.8 |     0.11 |
| git log --oneline -20                    |    30 |       2.5 |     0.07 |
| git show HEAD                            |    30 |       2.5 |     0.08 |
| git grep -n                              |    20 |      19.7 |     0.39 |
| chained one-shell call                   |    20 |      17.4 |     0.35 |
| small edit cycle (write/sed/grep/rm)     |    50 |       7.1 |     0.35 |
| 300 small files make/list/remove         |     5 |      27.3 |     0.14 |
| 4 agents at once (status + grep)         |    10 |      17.4 |     0.17 |
| oxlint relay + packages                  |    10 |      63.7 |     0.64 |
| tsc server (typecheck)                   |     3 |    1297.7 |     3.89 |
| bun test one file (accounts)             |     3 |    1052.4 |     3.16 |
| bun install (warm cache, frozen)         |     1 |      38.7 |     0.04 |
| cargo check engine (incremental)         |     1 |    4319.3 |     4.32 |

whole run: 16.6 s

### WSL2 (repo on WSL's disk)

### WSL2 (repo on /mnt/c)

### Windows, Git Bash (NTFS)

### Windows, Git Bash (Dev Drive)
