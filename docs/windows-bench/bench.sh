#!/usr/bin/env bash
# Replays what our coding agents do in this repo, day to day, and times it.
# Mix taken from 427 Claude sessions (Nov 7–24, 2026): see README.md beside this file.
# Run from anywhere inside the repo, in Linux, WSL, or Git Bash on Windows:
#   bash docs/windows-bench/bench.sh            # ~1-3 min on Linux
#   bash docs/windows-bench/bench.sh --heavy    # also bun install + cargo check
# Prints a Markdown table to paste into README.md. Changes nothing tracked.
set -u
cd "$(git rev-parse --show-toplevel)/app" || exit 1
heavy=0; [ "${1:-}" = "--heavy" ] && heavy=1
tmp="target/bench-tmp"; rm -rf "$tmp"; mkdir -p "$tmp"
big="apps/server/src/script.ts"

now() { date +%s%N; }
# row <label> <reps> <command...>: runs the command reps times, prints ms per run and total
row() {
  local label=$1 reps=$2; shift 2
  local t0 t1 i bad=0
  t0=$(now)
  for ((i = 0; i < reps; i++)); do "$@" >/dev/null 2>&1 || bad=1; done
  t1=$(now)
  [ $bad = 1 ] && label="$label (FAILED)"
  awk -v l="$label" -v r="$reps" -v d="$((t1 - t0))" \
    'BEGIN { printf "| %-40s | %5d | %9.1f | %8.2f |\n", l, r, d / r / 1e6, d / 1e9 }'
}
skip() { printf '| %-40s | %5s | %9s | %8s |\n' "$1" "-" "missing" "-"; }
has() { command -v "$1" >/dev/null 2>&1; }

edit_cycle() { # Write a file, read it back, sed a range, grep it, delete it: an agent's small change
  local f="$tmp/e$RANDOM.ts"
  cat "$big" >"$f"; sed -i 's/function /function  /' "$f"; grep -c "function" "$f"; sed -n '100,160p' "$f"; rm -f "$f"
}
many_files() { # 300 small files created, listed, removed: what Defender and the filesystem feel most
  local d="$tmp/many$RANDOM" i; mkdir -p "$d"
  for ((i = 0; i < 300; i++)); do echo "export const x$i = $i" >"$d/f$i.ts"; done
  ls "$d" | wc -l; cat "$d"/*.ts | wc -l; rm -rf "$d"
}
parallel4() { # four agents' worth of grep + git status at once (agents send 2-6 tool calls together)
  local i; for i in 1 2 3 4; do { git status --porcelain; grep -rn "export function" apps/server/src | wc -l; } & done; wait
}
script_style() { # the shape of our most common Bash calls: a few commands chained in one shell
  git log --oneline -5; grep -rn "TODO" apps/server/src | head -20; sed -n '1,40p' "$big"; ls apps/server/src | wc -l; date
}

echo "## $(uname -srm) · $(date '+%Y-%m-%d %H:%M')"
echo "cpu: $(nproc 2>/dev/null) threads · git $(git --version | awk '{print $3}') · bun $(bun --version 2>/dev/null || echo none)"
echo
echo "| step | runs | ms/run | total s |"
echo "|---|--:|--:|--:|"
T0=$(now)
row "spawn a process (env true)"            300 env true
row "cat a 4k-line file"                    200 cat "$big"
row "sed -n a range"                        200 sed -n '1200,1300p' "$big"
row "wc -l"                                 200 wc -l "$big"
row "grep -rn across server src"             30 grep -rn "export function" apps/server/src
row "grep -rn across whole app (no deps)"    10 grep -rn --exclude-dir=node_modules --exclude-dir=target "useState" apps
if has python3; then row "python3 -c (startup)" 30 python3 -c 'pass'; else skip "python3 -c (startup)"; fi
row "bun -e (startup)"                       30 bun -e '0'
row "git status"                             30 git status --porcelain
row "git diff HEAD~1 --stat"                 30 git diff HEAD~1 --stat
row "git log --oneline -20"                  30 git log --oneline -20
row "git show HEAD"                          30 git show HEAD
row "git grep -n"                            20 git grep -n "export function"
row "chained one-shell call"                 20 script_style
row "small edit cycle (write/sed/grep/rm)"   50 edit_cycle
row "300 small files make/list/remove"        5 many_files
row "4 agents at once (status + grep)"       10 parallel4
row "oxlint relay + packages"                10 node_modules/.bin/oxlint apps/relay/src packages
row "tsc server (typecheck)"                  3 bun run --cwd apps/server typecheck
row "bun test one file (accounts)"            3 bun test --cwd apps/server test/accounts.test.ts
if [ $heavy = 1 ]; then
  row "bun install (warm cache, frozen)"      1 bun install --frozen-lockfile
  if has cargo; then row "cargo check engine (incremental)" 1 cargo check -p edit-engine; else skip "cargo check engine"; fi
fi
T1=$(now)
awk -v d="$((T1 - T0))" 'BEGIN { printf "\nwhole run: %.1f s\n", d / 1e9 }'
rm -rf "$tmp"
