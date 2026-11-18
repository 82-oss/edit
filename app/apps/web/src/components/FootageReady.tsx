import type { FootageReady as Ready } from "@edit/types/footage_ready";
import { CloudDownload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { leftWords, type StepRow } from "../lib/export-steps";
import { THIS_MACHINE } from "../lib/platform";
import { navigate } from "../lib/route";
import { StepList } from "./ExportSteps";
import { Button, escapeCloses, IconButton, Modal, ProgressRing } from "./ui";

/**
 * A project whose footage isn't here enough to play smoothly from the start
 * (Sphe, Nov 17: never stuttering playback without a word): "Getting the
 * footage ready for this Mac" over it, which opens it by itself the moment a
 * play from 0:00 would be smooth; "Open now" opens it at once, and the top
 * bar's cloud follows the rest until it's here (`FootageCloud`). The server
 * says where it stands (footage_ready.ts); nothing shows when it's ready, or
 * nearly.
 */

/** How long the first answer may take before the project opens anyway, and how long a project nearly ready is given before the dialog shows. */
export const timing = { firstMs: 1_500, graceMs: 2_000, dialogMs: 1_000, cardMs: 3_000, roomMs: 10_000 };

export type Phase = "checking" | "dialog" | "open";

/**
 * Where project `id`'s opening stands, once it's `loaded`: "checking" (the editor waits, at most a couple of seconds),
 * "dialog" (it isn't ready to play smoothly), "open". `card`: the answer the top bar's cloud follows while the rest still comes.
 */
export function useFootage(id: string, loaded: boolean) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [answer, setAnswer] = useState<Ready | null>(null);
  const [card, setCard] = useState(false);
  // Open now pressed: the person goes on without the footage, so the link is no longer kept for it (footage_ready.ts).
  const [pressed, setPressed] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    setPhase("checking");
    setAnswer(null);
    setCard(false);
    setPressed(false);
  }, [id]);

  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const began = Date.now();
    const ask = (waiting: boolean) => api.footageReady(id, waiting).catch(() => null);
    const open = (withCard: boolean) => {
      if (!alive) return;
      setPhase("open");
      setCard(withCard);
    };
    // The dialog: asked every second, and the project opens by itself once it's ready.
    const follow = async () => {
      const now = await ask(true);
      if (!alive || phaseRef.current !== "dialog") return;
      if (now !== null) setAnswer(now);
      if (now?.ready) open(!now.done || now.room !== null);
      else timer = setTimeout(() => void follow(), timing.dialogMs);
    };
    void (async () => {
      // An answer slow to come opens the project as it always has: nothing here waits on the server.
      const first = await Promise.race([ask(true), new Promise<null>((resolve) => setTimeout(() => resolve(null), timing.firstMs))]);
      if (!alive) return;
      if (first === null || first.ready) {
        if (first !== null) setAnswer(first);
        // Ready, but the disk can't keep it all: said once, at the top bar's cloud (nothing waited on: the link isn't held).
        setPressed(true);
        open(first?.room != null);
        return;
      }
      // Nearly ready (in a couple of seconds): no dialog.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, timing.graceMs - (Date.now() - began))));
      if (!alive) return;
      const second = await ask(true);
      if (!alive) return;
      if (second === null || second.ready) {
        if (second !== null) setAnswer(second);
        setPressed(true);
        open(second?.room != null);
        return;
      }
      setAnswer(second);
      setPhase("dialog");
      phaseRef.current = "dialog";
      timer = setTimeout(() => void follow(), timing.dialogMs);
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, loaded]);

  // The top bar's cloud: asked every few seconds until everything's here (or, when it can't all be, said for a while).
  useEffect(() => {
    if (phase !== "open" || !card) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shownAt = Date.now();
    const tick = async () => {
      // Opened by itself, the rest is still waited on (background work gives way); after Open now it isn't.
      const now = await api.footageReady(id, !pressed).catch(() => null);
      if (!alive) return;
      if (now !== null) setAnswer(now);
      const over = now !== null && now.done && (now.room === null || Date.now() - shownAt >= timing.roomMs);
      if (over) setCard(false);
      else timer = setTimeout(() => void tick(), timing.cardMs);
    };
    timer = setTimeout(() => void tick(), timing.cardMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, phase, card, pressed]);

  return {
    phase,
    answer,
    card: phase === "open" && card ? answer : null,
    openNow: () => {
      setPhase("open");
      setCard(true);
      setPressed(true);
      // Said at once: what gave way to the footage carries on.
      void api.footageReady(id, false).catch(() => null);
    },
  };
}

/** "6.1 of 9.4 GB", "640 of 900 MB". */
export function sizeWords(done: number, total: number): string {
  if (total >= 1e9) return `${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`;
  return `${Math.round(done / 1e6)} of ${Math.max(1, Math.round(total / 1e6))} MB`;
}

/** "48 MB/s", "650 KB/s". */
export function speedWords(bps: number | null): string | null {
  if (bps === null || !(bps > 0)) return null;
  return bps >= 1e6 ? `${Math.round(bps / 1e6)} MB/s` : `${Math.max(1, Math.round(bps / 1e3))} KB/s`;
}

/** "about 3 min", "a moment"; null with no basis. */
export function aboutWords(seconds: number | null): string | null {
  const words = leftWords(seconds);
  if (words === null) return null;
  return words.startsWith("~") ? `about ${words.slice(1)}` : words;
}

/** "The first 4 minutes of the edit", "The first minute of the edit", "The whole edit". */
export function startWords(answer: Ready): string {
  if (answer.head_s >= answer.length_s - 0.5) return "The whole edit";
  const minutes = Math.round(answer.head_s / 60);
  return minutes <= 1 ? "The first minute of the edit" : `The first ${minutes} minutes of the edit`;
}

export function rowsOf(answer: Ready): StepRow[] {
  return answer.steps.map((step) => ({
    key: step.kind,
    // Some of it can't come here: no tick, said plainly.
    state: step.streams === true ? "waiting" : step.state,
    text: step.kind === "start" ? startWords(answer) : step.kind === "rest" ? "The rest of the footage" : "The graphics",
    progress: null,
    right: step.streams === true ? "from the cloud" : step.state === "done" ? "ready" : leftWords(step.left_s),
  }));
}

/** The dialog over a project not ready to play smoothly yet. */
export function FootageDialog({ answer, onOpen }: { answer: Ready; onOpen: () => void }) {
  const share = answer.bytes_total > 0 ? Math.min(1, answer.bytes_done / answer.bytes_total) : 0;
  // It can't become smooth here: said instead of a time that won't come true.
  const time = answer.cant ? null : aboutWords(answer.ready_in_s);
  const speed = speedWords(answer.speed_bps);
  return (
    <Modal open onClose={onOpen} width={440}>
      <div className="px-6 pb-[18px] pt-[22px]">
        <h2 className="text-[17px] font-semibold tracking-[-0.3px]">Getting the footage ready for {THIS_MACHINE}</h2>
        <p className="mt-1.5 text-[12.5px] leading-normal text-muted">
          {answer.made_on ? `This edit was made on ${answer.made_on}. ` : ""}
          Edit is bringing {answer.made_on ? "its" : "this edit's"} footage here so it plays smoothly. It opens by itself when it's ready.
        </p>
        <div className="mt-4 flex items-baseline justify-between text-[12.5px]">
          <span className="tabular">
            {sizeWords(answer.bytes_done, answer.bytes_total)} · {answer.files_done} of {answer.files_total} files
          </span>
          {time && <span className="tabular text-muted">{time}</span>}
        </div>
        <div className="mt-[7px] h-1.5 overflow-hidden rounded-full bg-active" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="fill-shimmer h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
        {(answer.cant ?? answer.room) && <p className="mt-3 text-[12px] leading-normal text-muted">{answer.cant ?? answer.room}</p>}
        <StepList label="Footage steps" rows={rowsOf(answer)} className="mt-3.5" small />
        <div className="mt-4 flex items-center gap-2">
          <span className="flex-1 text-[11.5px] leading-snug text-muted">{speed ? `Downloading at ${speed}` : ""}</span>
          <Button variant="ghost" onClick={() => navigate("/")}>
            Back
          </Button>
          <Button variant="subtle" onClick={onOpen}>
            Open now
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Whether the top bar's cloud says the footage is coming: the rest still on its way, or it can't all fit here (said for a while). */
export function footageShowing(answer: Ready | null): answer is Ready {
  return answer !== null && (!answer.done || answer.room !== null);
}

/**
 * The rest coming after the project opened, as the top bar's cloud (Sphe, Nov 18: the corner card covered the
 * bottom of the agent panel; "it should be somewhat of a dropdown from that, and then we can click away, and it
 * hides there"): a ring of how far it's got, its words dropped down under it as it opens, hidden by a click
 * anywhere else or Escape and shown again only from the cloud.
 */
export function FootageCloud({ answer }: { answer: Ready }) {
  const [open, setOpen] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const share = answer.bytes_total > 0 ? Math.min(1, answer.bytes_done / answer.bytes_total) : 0;
  const left = answer.files_total - answer.files_done;
  const title = answer.done ? "Not all the footage fits here" : "Getting the rest of the footage";
  const line = answer.done ? (answer.room ?? "") : [`${left} ${left === 1 ? "file" : "files"} left`, aboutWords(answer.left_s)].filter((one) => one !== null).join(" · ");
  useEffect(() => {
    if (!open) return;
    // A press anywhere else hides it and goes on to what was pressed (a play, a clip): nothing is swallowed.
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    const leave = escapeCloses(() => setOpen(false));
    return () => {
      window.removeEventListener("pointerdown", away, true);
      leave();
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <IconButton label={`${title} · ${line}`} active={open} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((was) => !was)}>
        <span className="relative flex size-[22px] items-center justify-center">
          <ProgressRing value={share} size={22} />
          <CloudDownload size={11} strokeWidth={2.2} className="absolute" />
        </span>
      </IconButton>
      <AnimatePresence>
        {open && (
          <motion.div
            role="status"
            aria-label="Footage coming"
            // The kit's menu (ContextMenu.tsx), dropped from the cloud's right edge.
            className="absolute top-full right-0 z-40 mt-1.5 w-[280px] origin-top-right rounded-[10px] border border-line-strong bg-raised px-3.5 py-3 text-[12.5px] shadow-[0_12px_32px_#0009]"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          >
            <b className="mb-[3px] block text-[13px] font-semibold">{title}</b>
            <span className="tabular text-muted">{line}</span>
            {!answer.done && (
              <div className="mt-[9px] h-[3px] overflow-hidden rounded-full bg-active">
                <div className="h-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${Math.round(share * 100)}%` }} />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
