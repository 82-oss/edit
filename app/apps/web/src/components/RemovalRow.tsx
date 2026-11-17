// Removal under way in the background, at the end of the agent's chat (Sphe,
// Nov 17, like T3's background task: "◌ Removing their text · 12 of 81
// 1m 32s  Stop"): what's being taken out and how far, how long it's been and
// about how long is left, and Stop (nothing more is sent; what's cleaned
// stays). Only between turns: a turn's own work shows while it runs, and the
// row comes back below it when it ends. Its words are never cut: they wrap.
// When the run is done, Edit tells the agent itself and the row goes.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { api, type TextRemoval } from "../lib/api";
import { shortSpan } from "../lib/agentTurns";
import { useNow } from "../lib/now";
import { leftLine, runLine } from "../lib/removal";
import { Button } from "./ui";

export function RemovalRow({ projectId, marked, running }: { projectId: string; marked: boolean; running: boolean }) {
  const [said, setSaid] = useState<TextRemoval | null>(null);
  const [tick, setTick] = useState(0);
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
          className="flex items-start gap-2 rounded-lg px-1.5 py-1 text-[12px]"
          data-testid="removal-row"
        >
          <span className="mt-0.5 grid size-4 shrink-0 place-items-center" aria-hidden>
            <span className="step-spin size-3.5 rounded-full border-2 border-primary/35 border-t-primary" />
          </span>
          <span className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]">
            <span className="text-fg">{runLine(run)}</span>
            <span className="text-faint tabular">
              {" · "}
              {shortSpan(Math.max(0, now - run.started_at))}
              {left !== null && ` · ${left}`}
            </span>
          </span>
          <Button size="sm" variant="ghost" busy={stopping} onClick={() => void stop()} className="shrink-0">
            Stop
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
