import { useEffect, useRef, useState } from "react";
import type { ImportProgress } from "./types";
import { Dialog } from "./ui";
import { elapsed, STEPS, stepOf, stillLine } from "./import-steps";

/**
 * A script's import, shown over its project in the middle of the screen:
 * each step, how far it is, what it's doing now and for how long. The
 * import keeps going after the producer leaves; Home follows it. Its clock
 * is the server's (startedAt), so reopening it doesn't start it again, and
 * none shows when that's unknown; what it's doing is said once, over the
 * meter (Astra, Nov 18). Once the server hasn't seen it move for five minutes
 * (and it isn't waiting on a time of its own), the clock gives way to since
 * when nothing has come in (Nov 20: "Running for" kept counting through an
 * hour of nothing).
 */
export function ImportScreen({ item, onLeave }: { item: (ImportProgress & { movedAt?: number; retryAt?: number }) | null; onLeave: () => void }) {
  const shown = useRef(item);
  if (item) shown.current = item;
  const current = shown.current;
  const [now, setNow] = useState(() => Date.now());
  const step = current ? stepOf(current) : "download";
  const startedAt = current?.startedAt;
  const still = current && current.retryAt === undefined ? stillLine(current.movedAt, now) : null;
  const showing = item !== null;
  useEffect(() => {
    if (!showing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [showing]);
  const at = STEPS.findIndex((candidate) => candidate.key === step);
  const percent = Math.max(0, Math.min(100, current?.percent ?? 0));
  return (
    <Dialog
      open={!!item}
      onClose={onLeave}
      title={`Importing ${current?.title ?? ""}`}
      description="The footage is getting ready. It keeps going if you leave: Home follows it, and the script opens ready here."
      width={720}
      footer={
        <>
          <span className="faint">{still ?? (startedAt ? `Running for ${elapsed(now - startedAt)}` : "")}</span>
          <span className="spacer" />
          <button type="button" className="primary" data-autofocus onClick={onLeave}>
            Back to projects
          </button>
        </>
      }
    >
      <div className="import-screen">
        <div className="import-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="import-meter-head">
            <strong>{percent}%</strong>
            <span>{current?.detail || "Starting…"}</span>
          </div>
          <div className="import-bar">
            <i style={{ width: `${percent}%` }} />
          </div>
        </div>
        <ol className="import-steps">
          {STEPS.map((candidate, index) => {
            const state = index < at ? "done" : index === at ? "now" : "later";
            return (
              <li key={candidate.key} data-state={state}>
                <span className="import-dot" aria-hidden="true" />
                <div>
                  <strong>{candidate.label}</strong>
                  <p>{candidate.hint}</p>
                </div>
                <span className="faint import-time">{state === "done" ? "Done" : ""}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </Dialog>
  );
}
