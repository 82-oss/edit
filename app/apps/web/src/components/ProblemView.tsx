// How Edit shows something that went wrong: a short title, what to do, and
// the one button that helps, in plain words (problems.ts). No details or
// report buttons (Sphe, Nov 15: "when something goes wrong display it cleanly
// and have a human readable error"): the original words go to the log.

import { explain, type Problem } from "@edit/types/problems";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { setupClaude } from "../lib/agent";
import { signIn } from "../lib/account";
import { cx } from "./ui";

/**
 * The button for a problem's action; `onRetry` only where trying again is
 * something this place can do; `onReload` whenever there's no other button
 * (a read nothing else will repeat: a page's, a list's).
 */
/** A problem's button, for a place's own beside it (ProblemView's `actions`). */
export const PROBLEM_BUTTON = "mt-1.5 rounded-md border border-line-strong px-2 py-0.5 text-[12px] text-fg hover:bg-hover";

function ActionButton({ problem, onRetry, onReload }: { problem: Problem; onRetry?: () => void; onReload?: () => void }) {
  const button = PROBLEM_BUTTON;
  if (problem.action === "sign-in") return <button className={button} onClick={() => void signIn()}>Sign in</button>;
  if (problem.action === "claude-sign-in") return <button className={button} onClick={() => void setupClaude("login")}>Sign in to Claude</button>;
  const again = (problem.action === "retry" ? onRetry : undefined) ?? onReload;
  if (again) return <button className={button} onClick={again}>Try again</button>;
  return null;
}

export function ProblemView({
  error,
  doing,
  onRetry,
  onReload,
  actions,
  compact,
  className,
}: {
  /** The error (or its words) as it came. */
  error: unknown;
  /** What was being done, as "Couldn't …" finishes it ("download this file"). */
  doing?: string;
  onRetry?: () => void;
  /** Try again whatever went wrong: what failed was a read nothing else repeats (a page loading, a list). */
  onReload?: () => void;
  /** A place's own buttons after the problem's (the editor's All projects), as PROBLEM_BUTTON. */
  actions?: ReactNode;
  /** One line for a row in a list (the fix shows on hover). */
  compact?: boolean;
  className?: string;
}) {
  const problem = explain(error, doing);
  if (compact) {
    return (
      <span className={cx("text-[11px] text-danger", className)} title={problem.fix || undefined}>
        {problem.title}
      </span>
    );
  }
  return (
    <div className={cx("flex items-start gap-2 text-[12px]", className)}>
      <CircleAlert size={14} className="mt-px shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">{problem.title}</div>
        {problem.fix && <p className="mt-0.5 leading-relaxed text-muted">{problem.fix}</p>}
        {actions === undefined ? (
          <ActionButton problem={problem} onRetry={onRetry} onReload={onReload} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton problem={problem} onRetry={onRetry} onReload={onReload} />
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

/** A toast's problem: the same, sized for a toast. */
export function ToastProblem({ problem }: { problem: Problem }) {
  return (
    <div className="min-w-0 flex-1 text-left">
      <div className="font-medium">{problem.title}</div>
      {problem.fix && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{problem.fix}</p>}
      <div onClick={(event) => event.stopPropagation()}>
        <ActionButton problem={problem} />
      </div>
    </div>
  );
}
