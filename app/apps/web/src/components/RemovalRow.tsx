// Removal under way in the background, at the end of the agent's chat (Sphe,
// Nov 17, like T3's background task: "◌ Waiting · <name>  1m 32s  Details
// Stop"): what's being taken out and how far, how long it's been and about how
// long is left, its pieces under Details (the export's step rows), and Stop
// (nothing more is sent; what's cleaned stays). Only between turns: a turn's
// own work shows while it runs, and the row comes back below it when it ends.
// When the run is done, Edit tells the agent itself and the row goes.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { api, type RemovalPiece, type TextRemoval } from "../lib/api";
import { shortSpan } from "../lib/agentTurns";
import { useNow } from "../lib/now";
import { leftLine, pieceRows, runLine } from "../lib/removal";
import { StepList } from "./ExportSteps";
import { Button } from "./ui";

export function RemovalRow({ projectId, marked, running }: { projectId: string; marked: boolean; running: boolean }) {
  const [said, setSaid] = useState<TextRemoval | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [pieces, setPieces] = useState<RemovalPiece[] | null>(null);
  const [stopping, setStopping] = useState(false);
  const run = said?.background ?? null;
  useEffect(() => {
    if (!marked) return;
    let live = true;
    api
      .textRemoval(projectId)
      .then((answer) => live && setSaid(answer))
      .catch(() => {});
    const timer = setTimeout(() => setTick((value) => value + 1), run !== null ? 3000 : 15000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `run` only sets how soon it looks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, marked, tick]);
  useEffect(() => {
    if (!open || run === null) return;
    let live = true;
    api
      .removal(projectId)
      .then((answer) => live && setPieces(answer.pieces))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, projectId, tick, run]);
  const now = useNow(run !== null);
  const stop = async () => {
    setStopping(true);
    try {
      setSaid(await api.stopRemoval(projectId));
    } catch {
      // Said by the next look.
    } finally {
      setStopping(false);
    }
  };
  const left = run === null ? null : leftLine(run.left_s);
  return (
    <AnimatePresence initial={false}>
      {run !== null && !running && (
        <motion.div
          key="removal"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          className="flex flex-col gap-1.5"
          data-testid="removal-row"
        >
          <div className="flex min-h-8 items-center gap-2 rounded-lg px-1.5 text-[12px]">
            <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
              <span className="step-spin size-3.5 rounded-full border-2 border-primary/35 border-t-primary" />
            </span>
            <span className="min-w-0 flex-1 truncate text-muted">
              <span className="text-faint">Waiting · </span>
              <span className="text-fg">{runLine(run)}</span>
            </span>
            <span className="shrink-0 text-faint tabular">
              {shortSpan(Math.max(0, now - run.started_at))}
              {left !== null && ` · ${left}`}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
              Details
            </Button>
            <Button size="sm" variant="ghost" busy={stopping} onClick={() => void stop()}>
              Stop
            </Button>
          </div>
          <AnimatePresence initial={false}>
            {open && pieces !== null && pieces.length > 0 && (
              <motion.div
                key="pieces"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <StepList label="Removal's pieces" rows={pieceRows(pieces)} small className="max-h-64 overflow-y-auto" />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
