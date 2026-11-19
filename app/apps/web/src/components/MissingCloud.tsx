import type { EditMissing } from "@edit/types/footage_ready";
import { Cloud } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { Button, ConfirmDialog, escapeCloses, IconButton } from "./ui";

/**
 * Footage that didn't come in, at the top bar's cloud (Sphe, Nov 18: an
 * import never stops or asks because of one file, and missing footage is
 * never silently written around): the cloud with a dot, and dropped from it
 * once, a short plain note with its two answers, Retry now and Go on without
 * it (confirmed; the server remembers it per file). Hidden by a click away
 * or Escape, shown again from the cloud. Script mode's top bar and the
 * editor's show the same one; Edit tries again by itself meanwhile.
 */

export type MissingItem = { id: string; name: string };

/** "1 recording didn't come in: CH03.avi", "2 files didn't come in: a.mp4 and b.mp4". */
export function missingWords(items: MissingItem[], one = "recording", many = `${one}s`): string {
  const names = items.map((item) => item.name);
  const listed = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${items.length} ${items.length === 1 ? one : many} didn't come in: ${listed}`;
}

export function MissingCloud({
  items,
  noun = "recording",
  onRetry,
  onWithout,
  outcome,
}: {
  items: MissingItem[];
  /** What each is ("recording", "video", "file"). */
  noun?: string;
  onRetry: () => Promise<unknown>;
  /** Goes on without these, each remembered for good. */
  onWithout: (ids: string[]) => Promise<unknown>;
  /** What going on without them does, said before it's confirmed ("it" or "them"); left out for good, unless said otherwise. */
  outcome?: (it: "it" | "them") => string;
}) {
  const [open, setOpen] = useState(true);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<"retry" | "without" | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const line = missingWords(items, noun);
  const it = items.length === 1 ? "it" : "them";
  useEffect(() => {
    if (!open || asking) return;
    // A press anywhere else hides it and goes on to what was pressed: nothing is swallowed.
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    const leave = escapeCloses(() => setOpen(false));
    return () => {
      window.removeEventListener("pointerdown", away, true);
      leave();
    };
  }, [open, asking]);
  const run = async (which: "retry" | "without", work: () => Promise<unknown>) => {
    setBusy(which);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div ref={box} className="relative">
      <IconButton label={line} active={open} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((was) => !was)}>
        <span className="relative flex size-[22px] items-center justify-center">
          <Cloud size={16} />
          <span data-testid="missing-dot" className="absolute top-[2px] right-[1px] size-[7px] rounded-full border-[1.5px] border-bg bg-warning" />
        </span>
      </IconButton>
      <AnimatePresence>
        {open && (
          <motion.div
            role="status"
            aria-label="Footage missing"
            // The kit's menu, dropped from the cloud's right edge, as the footage coming down is (FootageCloud).
            className="absolute top-full right-0 z-40 mt-1.5 w-[300px] origin-top-right rounded-[10px] border border-line-strong bg-raised px-3.5 py-3 text-[12.5px] shadow-[0_12px_32px_#0009]"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          >
            <p className="leading-snug text-fg break-words">{line}</p>
            <div className="mt-3 flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setAsking(true)}>
                Go on without {it}
              </Button>
              <Button size="sm" variant="subtle" busy={busy === "retry"} disabled={busy !== null} onClick={() => void run("retry", onRetry)}>
                Retry now
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Go on without ${items.length === 1 ? items[0]!.name : `these ${items.length} ${noun}s`}?`}
        detail={outcome?.(it) ?? `It's left out for good and Edit stops trying to bring ${it} in.`}
        confirm={`Go on without ${it}`}
        busy={busy === "without"}
        onConfirm={() =>
          void run("without", () => onWithout(items.map((item) => item.id))).then(() => {
            setAsking(false);
            setOpen(false);
          })
        }
      />
    </div>
  );
}

/** How often the editor asks again while footage is missing (Edit tries it by itself meanwhile). */
export const missingTiming = { pollMs: 30_000 };

/**
 * The editor's missing footage (missing_media.ts): asked when the project
 * opens or its media change, then every half minute while some is missing,
 * so the note goes by itself once a try brings it in.
 */
export function useEditMissing(id: string, mediaCount: number, back: unknown) {
  const [found, setFound] = useState<EditMissing | null>(null);
  useEffect(() => {
    if (id === "") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const answer = await api.missingFootage(id).catch(() => null);
      if (!live) return;
      setFound(answer);
      if (answer !== null && answer.missing.length > 0) timer = setTimeout(() => void ask(), missingTiming.pollMs);
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, mediaCount, back]);
  return {
    items: found?.missing ?? [],
    retry: async () => setFound(await api.retryMissingFootage(id)),
    without: async (ids: string[]) => {
      let last: EditMissing | null = null;
      for (const media of ids) last = await api.goWithoutFootage(id, media);
      if (last !== null) setFound(last);
    },
  };
}
