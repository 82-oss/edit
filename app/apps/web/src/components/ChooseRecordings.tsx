import { useState } from "react";

import { shortDuration } from "../lib/time";
import type { Decision } from "../writer/types";
import { Button } from "./ui";

export type TooMuch = Extract<Decision, { kind: "too_much" }>;

/** Hours as the count says them: 23.4 h, 20 h. */
const hours = (ms: number) => `${Number((ms / 3_600_000).toFixed(1))} h`;
const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/**
 * A Drive folder's recordings to tick, every one to start with, and one
 * button to bring the chosen ones in. Drawn in the import's dialog in place
 * of its steps, for an import an Edit from before Nov 18 stopped as over a
 * case's limits ("too_much"): a case takes all its footage now (Sphe, Nov 18),
 * so Import as it opens brings the whole folder in, as Retry does, and
 * unticking leaves recordings out.
 */
export function ChooseRecordings({ decision, onClose, onChoose }: { decision: TooMuch; onClose: () => void; onChoose: (ids: string[]) => Promise<boolean> }) {
  const [picked, setPicked] = useState(() => new Set(decision.files.map((file) => file.id)));
  const [sent, setSent] = useState(false);
  const chosen = decision.files.filter((file) => picked.has(file.id));
  const total = chosen.reduce((sum, file) => sum + (file.durationMs ?? 0), 0);
  const toggle = (id: string, on: boolean) =>
    setPicked((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const choose = () => {
    setSent(true);
    // In the folder's order; busy until the import carries on (Home's next look), or again pressable if it was refused.
    void onChoose(chosen.map((file) => file.id)).then((ok) => ok || setSent(false));
  };
  return (
    <>
      <div>
        <p className="text-[13px] text-muted tabular">
          {chosen.length} of {decision.files.length} recordings · {hours(total)}
        </p>
        <div className="mt-2 max-h-[min(340px,45vh)] overflow-y-auto rounded-lg border border-line py-1">
          {decision.files.map((file) => (
            <label key={file.id} className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-[13px] hover:bg-hover">
              <input type="checkbox" className="shrink-0 accent-white" checked={picked.has(file.id)} onChange={(event) => toggle(file.id, event.target.checked)} />
              <span className="min-w-0 flex-1 truncate" title={file.title}>
                {file.title}
              </span>
              <span className="shrink-0 text-muted tabular">{file.durationMs !== null ? shortDuration(file.durationMs / 1000) : ""}</span>
              <span className="w-16 shrink-0 text-right text-faint tabular">{size(file.size)}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" busy={sent} disabled={chosen.length === 0} onClick={choose}>
          Import {chosen.length}
        </Button>
      </div>
    </>
  );
}
