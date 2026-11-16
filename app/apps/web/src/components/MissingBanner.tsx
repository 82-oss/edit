// The editor’s word on footage that’s gone: the timeline plays files that
// aren’t on this machine (deleted, or on a drive that isn’t plugged in) and
// the cloud can’t bring back, so those clips are black and silent.

import { TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { useEditor } from "../lib/store";
import { THIS_MACHINE } from "../lib/platform";

export function MissingBanner() {
  const id = useEditor((state) => state.project?.id ?? "");
  // Asked again when the media change (an import, a relink), and once cleared footage is back (FootageBack).
  const mediaCount = useEditor((state) => state.project?.media.length ?? 0);
  const back = useEditor((state) => (state.scriptJob?.back === true ? state.scriptJob.state : null));
  const [found, setFound] = useState<{ used: number; missing: { id: string; name: string; path: string }[] } | null>(null);
  useEffect(() => {
    if (id === "") return;
    let live = true;
    api
      .missingFootage(id)
      .then((answer) => live && setFound(answer))
      .catch(() => live && setFound(null));
    return () => {
      live = false;
    };
  }, [id, mediaCount, back]);
  const missing = found?.missing ?? [];
  if (missing.length === 0) return null;
  const names = missing.map((media) => media.name);
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  return (
    <div
      className="mx-2 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 text-[12px]"
      title={missing.map((media) => media.path).join("\n")}
    >
      <TriangleAlert size={13} className="shrink-0 text-warning" />
      <span className="shrink-0 text-fg">
        Footage missing: {missing.length} of {found?.used ?? missing.length} files
      </span>
      <span className="truncate text-muted">
        aren’t on {THIS_MACHINE}, so their clips play black and silent ({shown}).
      </span>
    </div>
  );
}

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
