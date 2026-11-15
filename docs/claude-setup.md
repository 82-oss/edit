# Claude Code setup and recovery

`apps/server/src/claude_support.ts`, with the waiting message in `agent.ts`.

Each installed nightly runs Claude maintenance once, on its first start. The attempt is recorded in `~/.edit/agent/claude-support.json` before it starts, so reopening Edit, even after an interrupted setup, does not repeatedly update Claude or open a browser. Development builds and packaging smoke tests skip it (`EDIT_CLAUDE_MAINTENANCE=0`).

Maintenance uses the installed CLI's updater, Homebrew for a Homebrew install, or npm for an npm install. A missing CLI is installed with Anthropic's native installer. Automatic background updating is disabled for CLI processes Edit starts; standalone Claude Code keeps its own settings. An update failure is recorded and diagnosis still runs against the installed version.

Diagnosis records the executable and version, the configuration directory and names of credential overrides (never their values), saved sign-in status, `claude doctor`, a small `claude -p` request using Edit's model and settings isolation, and a request through Edit's actual Agent SDK connection. A saved login alone is insufficient. These real requests use the user's Claude plan. Ordinary launches and status polling do not run them.

An authentication rejection saves the failed message in `agent/claude-pending.json` and starts one shared recovery flow on this Mac. If removing an inherited token makes a real request succeed, Edit uses that working saved login for its own child processes without changing the user's shell. Otherwise the user's own `claude auth login` opens Claude's website and owns the OAuth callback. Edit shows the CLI's authorization link as a fallback, waits for the CLI to finish, and verifies both real requests before resuming. Passwords, tokens and callback codes are never collected by Edit; authorization URLs are neither logged nor saved.

The retry keeps the original conversation and one visible user message. If tools already ran, it asks the agent to inspect the current project and continue rather than repeat completed work. It checks the cloud project's write lock again. Stop, New Chat, canceling setup, switching provider, or a newer message discards the pending retry. A second authentication failure does not automatically launch another login. Waiting messages survive app restarts.

`GET /api/agent/claude` only observes. `POST` accepts `diagnose`, `repair`, `login`, or `cancel`. The page shows one line only when someone has to act (`ClaudeSetupCard.tsx`: Set up Claude, Sign in or Repair, and Cancel while signing in), never once Claude is ready.
