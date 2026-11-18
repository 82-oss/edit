import type { ExportStep } from "@edit/types/export_steps";
import { Check } from "lucide-react";

import { rowsOf, type StepRow } from "../lib/export-steps";
import { cx } from "./ui";

/**
 * An export's steps, one row each (Sphe, Nov 17, design B): done ones tick,
 * the one under way turns with its own bar, the rest wait with their time at
 * the right. The Export dialog and the Exports queue show this same list.
 */
export function ExportSteps({ steps, className, small = false }: { steps: ExportStep[]; className?: string; small?: boolean }) {
  return <StepList label="Export steps" rows={rowsOf(steps)} className={className} small={small} />;
}

/** Steps as rows, ticked, turning or waiting: the export's, and a project's footage coming here (FootageReady.tsx). */
export function StepList({ label, rows, className, small = false }: { label: string; rows: StepRow[]; className?: string; small?: boolean }) {
  return (
    <ol aria-label={label} className={cx("overflow-hidden rounded-xl border border-line bg-panel", className)}>
      {rows.map((row) => (
        <Row key={row.key} row={row} small={small} />
      ))}
    </ol>
  );
}

function Mark({ state }: { state: StepRow["state"] }) {
  if (state === "done")
    return (
      <span data-state="done" className="grid size-4 shrink-0 place-items-center rounded-full bg-success-soft text-success">
        <Check size={10} strokeWidth={3} />
      </span>
    );
  if (state === "current")
    return (
      <span data-state="current" className="grid size-4 shrink-0 place-items-center">
        <span className="step-spin size-3.5 rounded-full border-2 border-primary/35 border-t-primary" />
      </span>
    );
  return <span data-state="waiting" className="block size-4 shrink-0 rounded-full border-[1.5px] border-line-strong" />;
}

function Row({ row, small }: { row: StepRow; small: boolean }) {
  const right = row.right !== null && <span className={cx("shrink-0 whitespace-nowrap text-muted tabular", small ? "text-[11.5px]" : "text-[12px]")}>{row.right}</span>;
  return (
    <li className={cx("flex gap-2.5 border-t border-hover first:border-t-0", small ? "px-3 py-[9px] text-[12.5px]" : "px-3 py-2.5 text-[13px]", row.state === "current" ? "items-start" : "items-center")}>
      <span className={cx("flex", row.state === "current" && "mt-px")}>
        <Mark state={row.state} />
      </span>
      {row.state === "current" ? (
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-fg">
              {row.text}
              {row.note && <span className="text-muted"> · {row.note}</span>}
            </span>
            {right}
          </span>
          {row.progress !== null && (
            <span className={cx("block overflow-hidden rounded-full bg-active", small ? "mt-1.5 h-[3px]" : "mt-1.5 h-1")}>
              <span className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${Math.round(row.progress * 100)}%` }} />
            </span>
          )}
        </span>
      ) : (
        <>
          <span className={cx("min-w-0 flex-1 truncate", row.state === "done" ? "text-fg" : "text-muted")}>{row.text}</span>
          {right}
        </>
      )}
    </li>
  );
}
