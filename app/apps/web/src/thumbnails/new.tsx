// New thumbnail, in New's frame (components/NewWork.tsx; Sphe, Nov 14: "with
// thumbnails, I guess our import stage could be uploading reference images…
// Of course, we need a title… Or you can just go into it with nothing"): the
// channel, the title, its thumbnail guide and reference pictures, both
// optional, or an idea's title and guide picked in one go. Given a guide or
// pictures, Claude starts on them as it opens; given only a title, the
// thumbnail opens for the person's first word.

import { ImagePlus, Search, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useChannelChoice } from "../components/Channels";
import { AREA, Aside, ChannelField, FIELD, Field, NewShell } from "../components/NewWork";
import { cx } from "../components/ui";
import { postFile } from "../lib/chatFiles";
import { ideasApi } from "../lib/ideas";
import { navigate } from "../lib/route";
import { ago } from "../lib/time";
import { thumbnailsApi } from "../lib/thumbnails";
import type { IdeaRow } from "@edit/types/ideas";

/** The most reference pictures a new thumbnail takes. */
const MOST = 8;

type Picture = { file: File; url: string };

export function NewThumbnail({ open, onClose }: { open: boolean; onClose: () => void }) {
  const channels = useChannelChoice(open);
  const [channel, setChannel] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [guide, setGuide] = useState("");
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setChannel(null);
    setTitle("");
    setGuide("");
    // The last dialog's previews let go of.
    setPictures((was) => {
      was.forEach((one) => URL.revokeObjectURL(one.url));
      return [];
    });
    setChoosing(false);
    setError(null);
  }, [open]);

  const add = (given: Iterable<File>) => {
    const images = [...given].filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    setPictures((now) => [...now, ...images.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, MOST));
  };
  // Pictures pasted while it's open are references.
  useEffect(() => {
    if (!open) return;
    const pasted = (event: ClipboardEvent) => {
      const given = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (given.length === 0) return;
      event.preventDefault();
      add(given);
    };
    window.addEventListener("paste", pasted);
    return () => window.removeEventListener("paste", pasted);
  }, [open]);

  const starts = guide.trim() !== "" || pictures.length > 0;
  const ready = title.trim() !== "" && !busy;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await thumbnailsApi.create(title.trim(), guide.trim(), channel);
      const ids: string[] = [];
      for (const one of pictures) {
        const { image } = (await postFile(`/api/thumbnails/${encodeURIComponent(id)}/images?name=${encodeURIComponent(one.file.name || "reference.png")}`, one.file, () => {}, new AbortController().signal, { "content-type": one.file.type })) as { image: { id: string } };
        ids.push(image.id);
      }
      // A guide or pictures given: Claude starts on them; only a title: the person's first word starts it.
      if (starts) {
        const asked = guide.trim() !== "" && ids.length > 0 ? "Make it from the guide, with these reference pictures." : guide.trim() !== "" ? "Make it from the guide." : "Make it from these reference pictures.";
        await thumbnailsApi.chat(id, asked, ids);
      }
      onClose();
      navigate(`/thumbnails/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <NewShell
      kind="thumbnail"
      open={open}
      onClose={onClose}
      onSubmit={() => void create()}
      ready={ready}
      busy={busy}
      action={busy ? "Starting…" : starts ? "Make the thumbnail" : "Start"}
      error={error && <p className="pt-3 text-[12px] text-danger">{error}</p>}
      aside={<Aside onClick={() => setChoosing(!choosing)}>{choosing ? "Write it here instead" : "From an idea"}</Aside>}
    >
      <ChannelField kind="thumbnail" channels={channels} value={channel} onChange={setChannel} />
      <AnimatePresence initial={false} mode="wait">
        {choosing ? (
          <motion.div key="ideas" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
            <IdeaPicker
              channel={channel}
              onPick={(picked) => {
                setTitle(picked.title);
                setGuide(picked.guide);
                if (picked.channel && channels.some((one) => one.key === picked.channel)) setChannel(picked.channel);
                setChoosing(false);
              }}
            />
          </motion.div>
        ) : (
          <motion.div key="write" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }} className="flex flex-col gap-4">
            <Field label="Title">
              <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="The video's title" className={FIELD} />
            </Field>
            <Field label="Thumbnail guide" hint="optional">
              <textarea rows={3} value={guide} onChange={(event) => setGuide(event.target.value)} placeholder="What it shows: who, where, the moment, any words on it" className={AREA} />
            </Field>
            <Field label="Reference pictures" hint="optional">
              <div
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  add(event.dataTransfer.files);
                }}
                className="flex min-h-[64px] flex-wrap items-center gap-2 rounded-lg border border-dashed border-line-strong bg-black/40 p-2"
              >
                {pictures.map((one, index) => (
                  <span key={one.url} className="group relative h-12 w-[86px] overflow-hidden rounded-md bg-active">
                    <img src={one.url} alt="" className="size-full object-cover" />
                    <button
                      type="button"
                      aria-label="Take it out"
                      onClick={() => {
                        URL.revokeObjectURL(one.url);
                        setPictures((now) => now.filter((_, at) => at !== index));
                      }}
                      className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-black/75 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X size={10} strokeWidth={3} />
                    </button>
                  </span>
                ))}
                {pictures.length < MOST && (
                  <button type="button" onClick={() => files.current?.click()} className={cx("flex h-12 items-center gap-2 rounded-md px-3 text-[12px] text-faint transition-colors hover:text-fg", pictures.length === 0 && "flex-1 justify-center")}>
                    <ImagePlus size={15} />
                    {pictures.length === 0 ? "Drop, paste or choose pictures" : "More"}
                  </button>
                )}
                <input
                  ref={files}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    add(event.target.files ?? []);
                    event.target.value = "";
                  }}
                />
              </div>
            </Field>
          </motion.div>
        )}
      </AnimatePresence>
    </NewShell>
  );
}

/** An idea's title and thumbnail guide, picked: the channel's ideas first (or every one with none picked), newest first. */
function IdeaPicker({ channel, onPick }: { channel: string | null; onPick: (picked: { title: string; guide: string; channel: string | null }) => void }) {
  const [rows, setRows] = useState<IdeaRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ideasApi.home().then(
      (home) => alive && setRows(home.ideas),
      (error: unknown) => {
        if (!alive) return;
        setRows([]);
        setProblem((error as Error).message);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (rows ?? [])
      .filter((row) => channel === null || !row.summary.channel || row.summary.channel === channel)
      .filter((row) => words.every((word) => row.summary.title.toLowerCase().includes(word)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
  }, [rows, query, channel]);
  const pick = async (row: IdeaRow) => {
    setReading(row.id);
    setProblem(null);
    try {
      const { idea } = await ideasApi.get(row.id);
      onPick({ title: idea.main ?? idea.titles[0]?.text ?? row.summary.title, guide: idea.thumbnailGuide, channel: idea.channel ?? null });
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setReading(null);
    }
  };
  return (
    <Field label="Idea" hint="its title and thumbnail guide">
      <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-black px-3 text-muted transition-colors focus-within:border-muted">
        <Search size={13} className="shrink-0" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the ideas" className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint" />
      </label>
      <div className="mt-1.5 max-h-[260px] overflow-y-auto rounded-lg border border-line">
        {rows === null ? (
          <div className="shimmer px-3 py-2.5 text-[12px] text-muted">Reading the ideas…</div>
        ) : shown.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-faint">{problem ?? (query.trim() ? "No idea by that name." : "No ideas yet.")}</div>
        ) : (
          shown.map((row) => (
            <button
              type="button"
              key={row.id}
              disabled={reading !== null}
              onClick={() => void pick(row)}
              className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-hover disabled:opacity-60"
            >
              {row.summary.thumbnail ? <img src={row.summary.thumbnail} alt="" className="h-9 w-16 shrink-0 rounded object-cover" /> : <span className="h-9 w-16 shrink-0 rounded bg-active" />}
              <span className="min-w-0 flex-1">
                <span className={cx("block truncate text-[13px] font-medium", reading === row.id && "shimmer")}>{row.summary.title}</span>
                <span className="block truncate text-[11.5px] text-faint">{[row.summary.source || null, ago(row.updatedAt)].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
          ))
        )}
      </div>
      {problem !== null && shown.length > 0 && <p className="mt-1.5 text-[12px] text-danger">{problem}</p>}
    </Field>
  );
}

