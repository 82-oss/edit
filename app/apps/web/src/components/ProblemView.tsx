// How Edit shows something that went wrong: a short title, what to do, and
// the one button that helps, in plain words (problems.ts). No details or
// report buttons (Sphe, Nov 15: "when something goes wrong display it cleanly
// and have a human readable error"): the original words go to the log.

import { explain, type Problem } from "@edit/types/problems";
import { CircleAlert } from "lucide-react";

import { setupClaude } from "../lib/agent";
import { signIn } from "../lib/account";
import { cx } from "./ui";

/** The button for a problem's action; `onRetry` only where trying again is something this place can do. */
function ActionButton({ problem, onRetry }: { problem: Problem; onRetry?: () => void }) {
  const button = "mt-1.5 rounded-md border border-line-strong px-2 py-0.5 text-[12px] text-fg hover:bg-hover";
  if (problem.action === "sign-in") return <button className={button} onClick={() => void signIn()}>Sign in</button>;
  if (problem.action === "claude-sign-in") return <button className={button} onClick={() => void setupClaude("login")}>Sign in to Claude</button>;
  if (problem.action === "retry" && onRetry) return <button className={button} onClick={onRetry}>Try again</button>;
  return null;
}

export function ProblemView({
  error,
  doing,
  onRetry,
  compact,
  className,
}: {
  /** The error (or its words) as it came. */
  error: unknown;
  /** What was being done, as "Couldn't …" finishes it ("download this file"). */
  doing?: string;
  onRetry?: () => void;
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
        <ActionButton problem={problem} onRetry={onRetry} />
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
