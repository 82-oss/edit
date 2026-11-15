// When an admin is working on this Edit from afar (the server's
// remote_control.ts; Sphe, Nov 15: "maybe we have a dialog box asking them to
// pause their work while we use their app"): a dialog over every screen with
// who it is, why, and each step as it's done, through restarts, until they end
// it. "Hide" leaves a small pill instead, for whoever has to carry on.

import { Check, LifeBuoy } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { request } from "../lib/api";
import { spring } from "./ui";

export interface Help {
  by: string;
  message: string;
  started: number;
  steps: { at: number; text: string }[];
  ended?: { at: number; message: string };
}

/** The help dialog as the server has it (null: none), set by the events socket (lib/store.ts) and on load. */
export const useRemoteHelp = create<{ help: Help | null }>(() => ({ help: null }));

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function RemoteHelp() {
  const help = useRemoteHelp((state) => state.help);
  const [hidden, setHidden] = useState<number | null>(null);
  useEffect(() => {
    void request<{ help: Help | null }>("GET", "/api/remote-help").then(
      (answer) => useRemoteHelp.setState({ help: answer.help }),
      () => undefined,
    );
  }, []);
  // A new session (or its end) shows again, whatever was hidden before.
  const shown = help !== null && (hidden !== help.started || help.ended !== undefined);
  return (
    <AnimatePresence>
      {help !== null && shown && (
        <motion.div
          key="dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={`${help.by} is working on your Edit`}
        >
          <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring} className="w-full max-w-[440px] rounded-2xl border border-line bg-panel p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-active text-fg">
                {help.ended ? <Check size={18} /> : <LifeBuoy size={18} />}
              </span>
              <h2 className="text-[16px] font-semibold tracking-[-0.2px]">{help.ended ? `${help.by} is done` : `${help.by} is working on your Edit`}</h2>
            </div>
            {help.ended ? (
              <p className="mt-3 text-[13px] leading-relaxed text-secondary">{help.ended.message}</p>
            ) : (
              <>
                {help.message && <p className="mt-3 text-[13px] leading-relaxed text-fg">{help.message}</p>}
                <p className="mt-2 text-[13px] leading-relaxed text-muted">Please pause your work for a moment. Edit may restart; whatever you had going carries on afterwards.</p>
                {help.steps.length > 0 && (
                  <ol className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3">
                    {help.steps.map((step, at) => (
                      <motion.li key={`${step.at}-${at}`} initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="flex gap-2.5 text-[12.5px]">
                        <span className="w-14 shrink-0 text-faint tabular-nums">{time(step.at)}</span>
                        <span className={at === help.steps.length - 1 ? "text-fg" : "text-muted"}>{step.text}</span>
                      </motion.li>
                    ))}
                  </ol>
                )}
                <div className="mt-5 flex justify-end">
                  <button type="button" onClick={() => setHidden(help.started)} className="text-[12px] text-faint transition-colors hover:text-fg">
                    Hide
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
      {help !== null && !shown && (
        <motion.button
          key="pill"
          type="button"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={spring}
          onClick={() => setHidden(null)}
          className="fixed bottom-4 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-panel px-3.5 py-2 text-[12.5px] text-fg shadow-xl"
        >
          <LifeBuoy size={14} className="text-muted" />
          {help.by} is working on your Edit
        </motion.button>
      )}
    </AnimatePresence>
  );
}
