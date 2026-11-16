import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";

import { timeOfDay } from "../lib/import_progress";
import { useMemory, watchMemory } from "../lib/memory";
import { useYoutubeWaiting, watchYoutubeWaiting } from "../lib/youtube_waiting";
import { cx } from "./ui";

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** "Low memory" in the top bar while macOS says the Mac is short of it; which app to quit on hover. Quitting is the person's to do. */
export function MemoryChip() {
  const { low, critical, app } = useMemory();
  useEffect(watchMemory, []);
  return (
    <AnimatePresence>
      {low && (
        <motion.span
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.92 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          tabIndex={0}
          className={cx(
            "group relative inline-flex h-7 shrink-0 cursor-default items-center gap-[7px] rounded-full border px-2.5 text-[12px] whitespace-nowrap outline-none",
            critical ? "border-danger/25 bg-danger-soft text-danger" : "border-warning/20 bg-warning-soft text-warning",
          )}
        >
          <span className={cx("size-[7px] rounded-full", critical ? "bg-danger shadow-[0_0_0_3px_#ff5c7022]" : "bg-warning shadow-[0_0_0_3px_#f5a05a22]")} />
          Low memory
          <span className="pointer-events-none absolute top-full right-0 z-50 mt-2 w-[250px] rounded-lg border border-line-strong bg-raised px-3 py-2.5 text-left text-[12px] leading-[1.45] whitespace-normal text-secondary opacity-0 shadow-[0_8px_24px_#0009] transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100">
            {app ? (
              <>
                <span className="font-medium text-fg">
                  {app.name} is using {gb(app.bytes)}.
                </span>{" "}
                Quitting it lets playback and exports run at full speed.
              </>
            ) : (
              "Quitting apps you aren't using lets playback and exports run at full speed."
            )}
          </span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** The top bar's chips: "Low memory", and "Waiting on YouTube" while work waits out YouTube turning Edit away. */
export function StatusChips() {
  return (
    <>
      <YoutubeChip />
      <MemoryChip />
    </>
  );
}

/** "Waiting on YouTube" while something waits for YouTube to stop turning Edit away; when it goes again on hover. Nothing for the person to do. */
function YoutubeChip() {
  const waiting = useYoutubeWaiting((state) => state.waiting);
  useEffect(watchYoutubeWaiting, []);
  return (
    <AnimatePresence>
      {waiting !== null && (
        <motion.span
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.92 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          tabIndex={0}
          className="group relative inline-flex h-7 shrink-0 cursor-default items-center gap-[7px] rounded-full border border-warning/20 bg-warning-soft px-2.5 text-[12px] whitespace-nowrap text-warning outline-none"
        >
          <span className="size-[7px] rounded-full bg-warning shadow-[0_0_0_3px_#f5a05a22]" />
          Waiting on YouTube
          <span className="pointer-events-none absolute top-full right-0 z-50 mt-2 w-[250px] rounded-lg border border-line-strong bg-raised px-3 py-2.5 text-left text-[12px] leading-[1.45] whitespace-normal text-secondary opacity-0 shadow-[0_8px_24px_#0009] transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100">
            <span className="font-medium text-fg">YouTube turned Edit away for now.</span> Edit tries again by itself at {timeOfDay(waiting.until)}; nothing to do.
          </span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
