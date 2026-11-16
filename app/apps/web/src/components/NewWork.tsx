// New: one dialog's frame for the four kinds of work (Sphe, Nov 14: "simplify
// the dialog boxes for edits, scripts, thumbnails, and ideas… they all become
// one dialog box"). Each opens from its own section and stays that kind (no
// switching: "I don't think we should be able to just change it to Edit and
// then just start an edit there"); what they share is the frame: the
// section's name, the channel, then what the work starts from, the rest
// folded under More, and one button that says what happens.

import { ChevronDown, FileText, Film, Image as ImageIcon, Lightbulb, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";

import { useBeta } from "../lib/beta";
import { useChannels, type Channel, type Lane } from "../lib/channels";
import { ChannelPicker } from "./Channels";
import { Button, cx, Modal, spring } from "./ui";

export type WorkKind = "edit" | "script" | "idea" | "thumbnail";

const KINDS: Record<WorkKind, { title: string; icon: LucideIcon; lane: Lane }> = {
  edit: { title: "New edit", icon: Film, lane: "edit" },
  script: { title: "New script", icon: FileText, lane: "script" },
  idea: { title: "New idea", icon: Lightbulb, lane: "ideas" },
  thumbnail: { title: "New thumbnail", icon: ImageIcon, lane: "thumbnails" },
};

export const FIELD = "h-9 w-full rounded-lg border border-line bg-black px-3 text-[13px] outline-none transition-colors placeholder:text-faint focus:border-muted";
export const AREA = "w-full resize-none rounded-lg border border-line bg-black px-3 py-2.5 text-[13px] leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-muted";

/**
 * The frame: the kind's name, its fields, and the footer (a way in of its
 * own on the left when there is one, Cancel and the button on the right).
 * Enter in a one-line field sends it.
 */
export function NewShell({ kind, open, onClose, onSubmit, ready, busy, action, error, aside, width = 560, children, after }: {
  kind: WorkKind;
  open: boolean;
  onClose: () => void;
  onSubmit: () => void;
  ready: boolean;
  busy: boolean;
  /** What the button does, in a word or three ("Write the script"). */
  action: string;
  error?: ReactNode;
  /** The footer's left: another way in ("Paste a Doc instead"). */
  aside?: ReactNode;
  width?: number;
  children: ReactNode;
  /** Dialogs of its own, opened from inside. */
  after?: ReactNode;
}) {
  const { title, icon: Icon } = KINDS[kind];
  return (
    <Modal open={open} onClose={onClose} width={width}>
      <form
        className="flex max-h-[min(86vh,820px)] flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) onSubmit();
        }}
      >
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-1">
          <span className="flex size-7 items-center justify-center rounded-lg bg-active text-secondary">
            <Icon size={15} strokeWidth={2} />
          </span>
          <h2 className="text-[16px] font-semibold tracking-[-0.2px]">{title}</h2>
        </header>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pt-3 pb-1">{children}</div>
        <div className="px-6">{error}</div>
        <footer className="flex items-center gap-2 px-6 pt-4 pb-5">
          <div className="min-w-0 flex-1">{aside}</div>
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} busy={busy}>
            {action}
          </Button>
        </footer>
      </form>
      {after}
    </Modal>
  );
}

/** A field: its label, a quiet hint on the right ("optional", "from the card"), and what's in it. */
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-medium text-muted">{label}</span>
        {hint !== undefined && <span className="min-w-0 truncate text-right text-[11.5px] text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * What the work is for. Edit V2: a channel, always (Sphe, Nov 16: "you pick a
 * channel, or you pick a placeholder channel, or you pick a group of
 * channels"; a group opens to its channels, ChannelPicker), never a niche.
 * Edit V1: `other`, the niche (today's kinds), and never a channel.
 */
export function ChannelField({ kind, channels, value, onChange, other }: { kind: WorkKind; channels: Channel[]; value: string | null; onChange: (key: string | null) => void; other?: ReactNode }) {
  const v2 = useBeta((beta) => beta.v2);
  const loaded = useChannels((state) => state.channels !== null);
  const teacher = useChannels((state) => state.teacher);
  if (!v2) return other === undefined ? null : <Field label="Kind">{other}</Field>;
  return (
    <Field label="Channel">
      {channels.length > 0 ? (
        <ChannelPicker channels={channels} value={value} lane={KINDS[kind].lane} onChange={onChange} />
      ) : !loaded ? (
        <div className="shimmer h-11 rounded-lg border border-line" />
      ) : (
        <p className="text-[12px] text-faint">{teacher ? "No channels yet: add one under Channels on Home." : "No channels yet: an admin can give you one at accounts.spheceo.com."}</p>
      )}
    </Field>
  );
}

/** Edit V2's work is a channel's: nothing starts until one is picked. */
export function useChannelNeeded(channel: string | null): boolean {
  const v2 = useBeta((beta) => beta.v2);
  return v2 && channel === null;
}

/** What's rarely needed, folded: its names say what's inside; open by itself when something in it is set. */
export function More({ names, set = false, children }: { names: string; set?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open || set;
  return (
    <div>
      <button type="button" onClick={() => setOpen(!shown)} className="flex items-center gap-1 text-[12px] text-faint transition-colors hover:text-muted">
        More
        <ChevronDown size={12} className={cx("transition-transform", shown && "rotate-180")} />
        {!shown && <span className="ml-1 text-faint/80">· {names}</span>}
      </button>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring} className="overflow-hidden">
            <div className="flex flex-col gap-4 pt-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The footer's other way in: quiet text that turns the dialog to it. */
export function Aside({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-[12px] text-faint transition-colors hover:text-fg">
      {children}
    </button>
  );
}
