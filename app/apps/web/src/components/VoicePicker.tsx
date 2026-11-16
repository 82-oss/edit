// Who narrates a channel (Sphe, Nov 14: "this is too bulky have a good search
// system and have a list of the ones we've already selected for other
// niches"): a search over the team's voices, with the ones already narrating
// for a niche or another channel first, each saying for whom, then the
// editor's own recording, then the rest. A voice's sample plays from its row.

import { Check, ChevronDown, Mic, Pause, Play, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Narration, Used, Voice } from "../lib/channels";
import { cx, escapeCloses } from "./ui";

const RECORDED = "recorded";
const WIDTH = 340;

/** "Brian - Warm, Smooth, Confident" → ["Brian", "Warm, Smooth, Confident"]. */
function split(name: string): [string, string | null] {
  const at = name.indexOf(" - ");
  return at < 0 ? [name, null] : [name.slice(0, at), name.slice(at + 3)];
}

interface Row {
  id: string;
  name: string;
  more: string | null;
  /** For whom it narrates already. */
  by: string[];
  sample?: string;
}

/** One sample plays at a time. */
let playing: HTMLAudioElement | null = null;

export function VoicePicker({ value, voices, used, channel, onChange, className }: {
  value: Narration | null;
  voices: Voice[] | null;
  used: Used[];
  /** The channel being set up: its own narrator isn't "in use" elsewhere. */
  channel?: string;
  onChange: (narration: Narration) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [lit, setLit] = useState(0);
  const [sample, setSample] = useState<string | null>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const one of used) if (one.channel === undefined || one.channel !== channel) by.set(one.voice, [...(by.get(one.voice) ?? []), one.label]);
    const all: Row[] = (voices ?? []).map((voice) => {
      const [name, more] = split(voice.name);
      return { id: voice.voice_id, name, more, by: by.get(voice.voice_id) ?? [], ...(voice.preview_url ? { sample: voice.preview_url } : {}) };
    });
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const recorded: Row = { id: RECORDED, name: "Recorded by the editor", more: null, by: [] };
    if (words.length > 0) {
      const text = new Map((voices ?? []).map((voice) => [voice.voice_id, [voice.name, voice.description ?? "", ...Object.values(voice.labels ?? {})].join(" ").toLowerCase().replaceAll("_", " ")]));
      const hits = all.filter((row) => {
        const hay = `${text.get(row.id) ?? ""} ${row.by.join(" ").toLowerCase()}`;
        return words.every((word) => hay.includes(word));
      });
      // Names first, then whatever else matched (a description, an accent).
      hits.sort((a, b) => Number(!a.name.toLowerCase().includes(words[0]!)) - Number(!b.name.toLowerCase().includes(words[0]!)));
      const mine = words.every((word) => "recorded by the editor own recording".includes(word)) ? [recorded] : [];
      return { inUse: [] as Row[], rest: [...mine, ...hits] };
    }
    const inUse = all.filter((row) => row.by.length > 0);
    return { inUse, rest: [recorded, ...all.filter((row) => row.by.length === 0)] };
  }, [voices, used, channel, query]);
  const flat = useMemo(() => [...rows.inUse, ...rows.rest], [rows]);

  const current = value === null ? null : value.kind === "recorded" ? RECORDED : value.id;
  const label = value === null ? (voices === null ? "Loading voices…" : "Pick who narrates") : value.kind === "recorded" ? "Recorded by the editor" : split(value.name)[0];

  const place = () => {
    const box = button.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.max(WIDTH, box.width);
    const up = window.innerHeight - box.bottom < 300 && box.top > window.innerHeight - box.bottom;
    setAt({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top: up ? box.top - 6 : box.bottom + 6, width, up });
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    // Escape closes this, not the dialog it's in.
    const leave = escapeCloses(() => {
      setOpen(false);
      button.current?.focus();
    });
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", place);
    return () => {
      leave();
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Closing stops a sample and starts the next search afresh.
  useEffect(() => {
    if (open) return;
    setQuery("");
    playing?.pause();
    setSample(null);
  }, [open]);

  useEffect(() => {
    setLit(Math.max(0, flat.findIndex((row) => row.id === current)));
  }, [flat, current]);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${lit}"]`)?.scrollIntoView({ block: "nearest" });
  }, [lit]);

  const pick = (row: Row) => {
    onChange(row.id === RECORDED ? { kind: "recorded" } : { kind: "voice", id: row.id, name: voices?.find((voice) => voice.voice_id === row.id)?.name ?? row.name });
    setOpen(false);
  };
  const listen = (row: Row) => {
    if (sample === row.id) {
      playing?.pause();
      setSample(null);
      return;
    }
    playing?.pause();
    if (!row.sample) return;
    playing = new Audio(row.sample);
    playing.onended = () => setSample(null);
    void playing.play().catch(() => setSample(null));
    setSample(row.id);
  };

  const line = (row: Row, index: number) => (
    <div
      key={row.id}
      data-row={index}
      onPointerMove={() => setLit(index)}
      onClick={() => pick(row)}
      className={cx("group flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-[13px]", index === lit && "bg-hover")}
    >
      {row.id === RECORDED ? (
        <Mic size={13} className="shrink-0 text-muted" />
      ) : (
        <button
          type="button"
          title={sample === row.id ? "Stop" : "Hear it"}
          disabled={!row.sample}
          onClick={(event) => {
            event.stopPropagation();
            listen(row);
          }}
          className={cx("flex size-5 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-active hover:text-fg disabled:opacity-30", sample === row.id && "bg-active text-fg")}
        >
          {sample === row.id ? <Pause size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" className="translate-x-px" />}
        </button>
      )}
      {/* The name always shows (Sphe, Nov 16): its description goes first, then the tags give way, one and "+N". */}
      <span className="min-w-[72px] flex-1 truncate">
        <span className="text-fg">{row.name}</span>
        {row.more && <span className="text-faint"> · {row.more}</span>}
      </span>
      {row.by.length > 0 && (
        <span className="flex min-w-0 max-w-[45%] shrink items-center gap-1" title={row.by.join(", ")}>
          <span className="min-w-0 truncate rounded bg-active px-1.5 py-px text-[11px] text-muted">{row.by[0]}</span>
          {row.by.length > 1 && <span className="shrink-0 rounded bg-active px-1.5 py-px text-[11px] text-muted tabular">+{row.by.length - 1}</span>}
        </span>
      )}
      {row.id === current && <Check size={13} className="shrink-0 text-fg" />}
    </div>
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={voices === null}
        onClick={() => setOpen((was) => !was)}
        className={cx("flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-black px-3 text-[13px] hover:border-line-strong disabled:opacity-60", open && "border-line-strong", className)}
      >
        <span className={cx("truncate", value === null && "text-faint")}>{label}</span>
        <ChevronDown size={13} className="shrink-0 text-faint" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && at !== null && (
            <motion.div
              ref={panel}
              initial={{ opacity: 0, y: at.up ? 4 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              style={{ left: at.left, width: at.width, ...(at.up ? { bottom: window.innerHeight - at.top } : { top: at.top }) }}
              className="fixed z-[70] flex max-h-[min(380px,60vh)] flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-[0_16px_48px_#000b]"
            >
              <div className="flex items-center gap-2 border-b border-line px-3">
                <Search size={13} className="shrink-0 text-faint" />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setLit((was) => (flat.length === 0 ? 0 : (was + (event.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length));
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      const row = flat[lit];
                      if (row) pick(row);
                    }
                  }}
                  placeholder="Search by name, accent, tone…"
                  className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
                />
              </div>
              <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1">
                {rows.inUse.length > 0 && <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-faint">In use</div>}
                {rows.inUse.map((row, index) => line(row, index))}
                {rows.inUse.length > 0 && <div className="mt-1 px-2 pb-1 pt-1.5 text-[11px] font-medium text-faint">All voices</div>}
                {rows.rest.map((row, index) => line(row, rows.inUse.length + index))}
                {flat.length === 0 && <div className="px-2 py-6 text-center text-[12px] text-faint">No voice matches “{query.trim()}”</div>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
