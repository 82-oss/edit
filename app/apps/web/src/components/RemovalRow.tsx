// Work under way in the background, at the end of the agent's chat (Sphe,
// Nov 17, like T3's background task; ~/.cache/mockups/background-wait.html):
// a dashed ring turning, "Waiting · Removing their text and watermarks · 12 of
// 25 pieces · 18m 04s", Stop (nothing more is done; what's done stays), a
// thin red line of how far under it. Only between turns: a turn's own work
// shows while it runs, and the row comes back below it when it ends. Its
// words are never cut: they wrap. When the run is done the row goes, and Edit
// wakes the agent itself: its turn and its answer are all that shows.
//
// Removal's, and since Nov 21 anything else the server runs on after a turn
// (background.ts: a channel's end-of-turn check, "Checking the edit"), each
// the same line, the older first ("I like this UI and only this UI"). One
// with nothing to count has no count and no line of how far.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { api, type BackgroundLine } from "../lib/api";
import { shortSpan } from "../lib/agentTurns";
import { useNow } from "../lib/now";
import { runLine } from "../lib/removal";

export function RemovalRow({ projectId, marked, running }: { projectId: string; marked: boolean; running: boolean }) {
  const [lines, setLines] = useState<BackgroundLine[]>([]);
  const [tick, setTick] = useState(0);
  const [stopping, setStopping] = useState<string | null>(null);
  const any = lines.length > 0;
  useEffect(() => {
    if (!marked) return;
    let live = true;
    api
      .background(projectId)
      .then((answer) => live && setLines(answer.lines))
      .catch(() => {});
    const timer = setTimeout(() => setTick((value) => value + 1), any ? 3000 : 15000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `any` only sets how soon it looks again; it looks again as each turn ends (a check starts then).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, marked, tick, running]);
  const now = useNow(any);
  const stop = async (key: string) => {
    setStopping(key);
    try {
      setLines((await api.stopBackground(projectId, key)).lines);
    } catch {
      // Said by the next look.
    } finally {
      setStopping(null);
    }
  };
  return (
    <AnimatePresence initial={false}>
      {!running &&
        lines.map((run) => (
          <motion.div
            key={run.key}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className="flex flex-col gap-1 px-0.5 py-1.5 text-[12.5px]"
            data-testid="removal-row"
          >
            <div className="flex items-start gap-2.5">
              <span className="wait-ring mt-[3px] block size-3.5 shrink-0 rounded-full border-[1.5px] border-dashed border-faint" aria-hidden />
              <span className="min-w-0 flex-1 leading-5 text-muted [overflow-wrap:anywhere]">
                Waiting · <span className="text-secondary">{runLine(run)}</span>
                <span className="tabular">
                  {" · "}
                  {shortSpan(Math.max(0, now - run.started_at))}
                </span>
              </span>
              <button type="button" disabled={stopping === run.key} onClick={() => void stop(run.key)} className="shrink-0 leading-5 font-medium text-fg transition-colors hover:text-primary disabled:opacity-45">
                Stop
              </button>
            </div>
            {run.total > 0 && (
              <span className="ml-6 block h-0.5 max-w-[300px] overflow-hidden rounded-full bg-active" aria-hidden>
                <span className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${Math.round((run.done / Math.max(1, run.total)) * 100)}%` }} />
              </span>
            )}
          </motion.div>
        ))}
    </AnimatePresence>
  );
}
