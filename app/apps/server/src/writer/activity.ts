// Whether Claude Code is there to do Script mode's work (`GET /api/writer/claude`).

import { findClaude } from "../claude.ts";
import { run } from "./proc.ts";

/** Claude Code on this Mac, signed in: what Script mode's builds run on (the person's own plan, as Edit's agent). */
export async function claudeStatus(): Promise<{ installed: boolean; loggedIn: boolean; subscription: string | null; message: string }> {
  const binary = await findClaude();
  if (binary === null) return { installed: false, loggedIn: false, subscription: null, message: "Install Claude Code and sign in. Edit uses that login, not an API key." };
  let value: { loggedIn?: unknown; subscriptionType?: unknown } = {};
  try {
    value = JSON.parse((await run(binary, ["auth", "status"], { timeoutMs: 20_000 })).trim()) as typeof value;
  } catch (error) {
    // Not answering isn't signed out (Edit updating Claude Code, the first start of a nightly): Edit's own setup says when it's a real problem.
    return { installed: true, loggedIn: true, subscription: null, message: `Claude Code didn't answer: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Only Claude saying so counts as signed out.
  const loggedIn = value.loggedIn !== false;
  const subscription = typeof value.subscriptionType === "string" && value.subscriptionType !== "" ? value.subscriptionType : null;
  return { installed: true, loggedIn, subscription, message: loggedIn ? (subscription ? `Claude · ${subscription}` : "Claude is signed in.") : "Claude Code isn't signed in. Open Terminal, run claude, and type /login." };
}
