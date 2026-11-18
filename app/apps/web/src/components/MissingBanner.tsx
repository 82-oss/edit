// What followed an import that didn't go, said above the timeline. Footage that isn't here is said at the top bar's
// cloud now (MissingCloud.tsx), with Retry now and Go on without it.

import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { useEditor } from "../lib/store";

/**
 * What followed an import that didn't go (Nov 16): a reused case not found in its finished video ("Case 2 of … wasn't
 * found: … the whole video plays there"), the voice-over not made. The job kept the line and nothing showed it. One
 * line each, gone once read (this viewer's, by its words).
 */
export function ImportProblems() {
  const id = useEditor((state) => state.project?.id ?? "");
  const after = useEditor((state) => state.scriptJob?.after);
  const [closed, setClosed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("edit:import-problems-read") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const lines = (after ?? []).filter((one) => one.state === "failed" && typeof one.note === "string" && one.note !== "" && !closed.includes(`${id}:${one.note}`));
  if (lines.length === 0) return null;
  const close = (note: string) => {
    const next = [...closed, `${id}:${note}`].slice(-200);
    setClosed(next);
    try {
      localStorage.setItem("edit:import-problems-read", JSON.stringify(next));
    } catch {
      /* Read for this page only. */
    }
  };
  return (
    <>
      {lines.map((one) => (
        <div key={one.step} className="mx-2 mb-2 flex min-h-9 shrink-0 items-center gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-1.5 text-[12px]">
          <TriangleAlert size={13} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-fg">{one.note}</span>
          <button type="button" aria-label="Dismiss" onClick={() => close(one.note!)} className="shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg">
            <X size={13} />
          </button>
        </div>
      ))}
    </>
  );
}
