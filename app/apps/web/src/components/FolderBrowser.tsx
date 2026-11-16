// Folders on the Mac running Edit (`/api/fs`, so it works over Tailscale too),
// browsed the same way wherever Edit asks for one: importing media, and where
// exports go.

import { AudioLines, ChevronRight, CircleArrowDown, Clapperboard, FileText, Film, FolderPlus, House, Image, Monitor, Music, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { api, type FsEntry, type FsListing } from "../lib/api";
import { formatBytes } from "../lib/time";
import { Button, cx, DialogTitle, escapeCloses, Modal } from "./ui";
import { Loader } from "./Logo";

const AUDIO = /\.(wav|mp3|m4a|aac|flac|aif|aiff|ogg|opus)$/i;

/** Finder's glyph for each of the places, by the name the server gives it. */
const GLYPHS: Record<string, LucideIcon> = {
  Home: House,
  Desktop: Monitor,
  Documents: FileText,
  Downloads: CircleArrowDown,
  Movies: Clapperboard,
  Videos: Clapperboard,
  Music,
  Pictures: Image,
};

/** A Finder folder: blue, with a place's glyph pressed into its front. */
function FolderIcon({ glyph: Glyph }: { glyph?: LucideIcon }) {
  return (
    <svg width={18} height={15} viewBox="0 0 18 15" className="shrink-0" aria-hidden>
      <path d="M1 2.2C1 1.54 1.54 1 2.2 1h4.1c.36 0 .7.16.93.44L8.2 2.6h7.6c.66 0 1.2.54 1.2 1.2v8.9c0 .66-.54 1.2-1.2 1.2H2.2c-.66 0-1.2-.54-1.2-1.2z" fill="#3e8ed8" />
      <rect x={1} y={4} width={16} height={10} rx={1.3} fill="#62acf2" />
      {Glyph && <Glyph x={5.75} y={5.75} width={6.5} height={6.5} strokeWidth={2.6} color="#2d6db0" />}
    </svg>
  );
}

/** Where a new folder is named: in the list, at the top, as Finder does it. */
function Naming({ make, close }: { make: (name: string) => Promise<void>; close: () => void }) {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const leave = useRef(close);
  leave.current = close;
  // Escape leaves the naming, not the dialog under it.
  useEffect(() => escapeCloses(() => leave.current()), []);
  const submit = () => {
    if (busy) return;
    if (name.trim() === "") return close();
    setBusy(true);
    make(name).catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : String(error));
      setBusy(false);
    });
  };
  return (
    <div className="px-2.5 py-1">
      <form
        className="flex h-9 items-center gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FolderIcon />
        <input
          autoFocus
          value={name}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
          onBlur={() => name.trim() === "" && close()}
          placeholder="Folder name"
          spellCheck={false}
          aria-label="Folder name"
          className="h-7 min-w-0 flex-1 rounded-md bg-raised px-2 text-[13px] text-fg ring-1 ring-line-strong outline-none focus:ring-info/60"
        />
      </form>
      {problem && <p className="pt-1 pl-[28px] text-[12px] text-danger">{problem}</p>}
    </div>
  );
}

/** A folder Edit may not open: one line, and on a Mac the way to allow it. Looked at again when Edit comes back to the front. */
function Refused({ listing, onGo }: { listing: FsListing; onGo: (path: string) => void }) {
  useEffect(() => {
    const again = () => onGo(listing.path);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [listing.path, onGo]);
  const name = listing.places.find((place) => place.path === listing.path)?.name ?? listing.path.split("/").filter(Boolean).at(-1) ?? listing.path;
  const privacy = listing.refused === "privacy";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-[13px] text-muted">{privacy ? `macOS hasn't let Edit open ${name}.` : `Edit isn't allowed to open ${name}.`}</p>
      {privacy && (
        <Button size="sm" variant="subtle" onClick={() => void api.privacySettings().catch(() => undefined)}>
          Open Settings
        </Button>
      )}
    </div>
  );
}

/**
 * The places down the side, the path across the top, and what's in the folder.
 * `foldersOnly` lists folders alone (choosing a folder); otherwise files can be
 * picked (`picked`, `onPick`) and double-clicked (`onChoose`). `side` goes
 * under the places; `heading` over them. `naming` puts a new folder's name at
 * the top of the list; `fresh` is a folder just made, shown as it arrives.
 */
export function FolderBrowser({
  listing,
  problem,
  onGo,
  foldersOnly,
  picked = [],
  onPick,
  onChoose,
  heading,
  side,
  empty,
  naming,
  fresh,
}: {
  listing: FsListing | null;
  problem?: string | null;
  onGo: (path: string) => void;
  foldersOnly?: boolean;
  picked?: string[];
  onPick?: (entry: FsEntry, adding: boolean) => void;
  onChoose?: (entry: FsEntry) => void;
  heading?: ReactNode;
  side?: ReactNode;
  empty: string;
  naming?: { make: (name: string) => Promise<void>; close: () => void } | null;
  fresh?: string | null;
}) {
  const crumbs = listing ? listing.path.split("/").filter(Boolean) : [];
  const entries = (listing?.entries ?? []).filter((entry) => !foldersOnly || entry.dir);
  const places = new Map((listing?.places ?? []).map((place) => [place.path, place.name]));
  const freshRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    freshRow.current?.scrollIntoView({ block: "nearest" });
  }, [fresh, listing]);
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2">
        {heading && <div className="px-2 pt-1 pb-2 text-[13px] font-medium text-muted">{heading}</div>}
        {listing?.places.map((place) => {
          const Glyph = GLYPHS[place.name] ?? House;
          const here = listing.path === place.path;
          return (
            <button
              key={place.path}
              type="button"
              onClick={() => onGo(place.path)}
              className={cx("flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors", here ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}
            >
              <Glyph size={14} className="shrink-0 text-[#62acf2]" />
              <span className="min-w-0 flex-1 truncate">{place.name}</span>
            </button>
          );
        })}
        {side}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-3 text-[12px] whitespace-nowrap text-muted">
          <button type="button" onClick={() => onGo("/")} className="rounded px-1 hover:text-fg">
            /
          </button>
          {crumbs.map((crumb, index) => (
            <span key={`${crumb}-${index}`} className="flex items-center">
              <ChevronRight size={12} className="text-faint" />
              <button type="button" onClick={() => onGo(`/${crumbs.slice(0, index + 1).join("/")}`)} className={cx("rounded px-1", index === crumbs.length - 1 ? "text-fg" : "hover:text-fg")}>
                {crumb}
              </button>
            </span>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {problem && <p className="px-2 py-1.5 text-[12px] text-danger">{problem}</p>}
          {listing === null && !problem && (
            <div className="flex h-full items-center justify-center text-muted">
              <Loader size={28} />
            </div>
          )}
          {listing?.refused ? (
            <Refused listing={listing} onGo={onGo} />
          ) : (
            <>
              {naming && <Naming key={listing?.path} make={naming.make} close={naming.close} />}
              {listing !== null && entries.length === 0 && !naming && <p className="p-6 text-center text-[13px] text-muted">{empty}</p>}
              {entries.map((entry) => {
                const isPicked = picked.includes(entry.path);
                const isFresh = entry.path === fresh;
                return (
                  <button
                    key={entry.path}
                    ref={isFresh ? freshRow : undefined}
                    type="button"
                    onClick={(event) => (entry.dir ? onGo(entry.path) : onPick?.(entry, event.metaKey || event.shiftKey || event.ctrlKey))}
                    onDoubleClick={() => !entry.dir && onChoose?.(entry)}
                    className={cx("flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors", isPicked || isFresh ? "bg-white/10 text-fg" : "text-fg/90 hover:bg-hover", isFresh && "row-new")}
                  >
                    {entry.dir ? <FolderIcon glyph={places.has(entry.path) ? GLYPHS[places.get(entry.path)!] : undefined} /> : AUDIO.test(entry.name) ? <AudioLines size={15} className="shrink-0 text-success" /> : <Film size={15} className="shrink-0 text-pink-300" />}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {!entry.dir && <span className="shrink-0 text-[11px] text-faint tabular">{formatBytes(entry.size)}</span>}
                    {isPicked && <span className="size-1.5 shrink-0 rounded-full bg-white" />}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The folder above `path`, or null at the top. */
function above(path: string): string | null {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : cut === 0 && path !== "/" ? "/" : null;
}

/**
 * A dialog for choosing a folder on this Mac: where exports go, where a copy
 * is saved. Opens at `start` (or the nearest folder above it that's there, or
 * home), says what went wrong in place, and stays open with the error when
 * `onPick` fails. New folder makes one where the person is.
 */
export function FolderPicker({
  open,
  onClose,
  title,
  detail,
  start,
  confirm,
  cancel = "Cancel",
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  detail: string;
  start?: string;
  /** The answer's words ("Use this folder", "Copy here"). */
  confirm: string;
  cancel?: string;
  onPick: (path: string) => Promise<void>;
}) {
  return (
    <Modal open={open} onClose={onClose} width={640}>
      <Picking title={title} detail={detail} start={start} confirm={confirm} cancel={cancel} onClose={onClose} onPick={onPick} />
    </Modal>
  );
}

/** The picker's inside, mounted only while it's open: each opening starts fresh at `start`. */
function Picking({ title, detail, start, confirm, cancel, onClose, onPick }: { title: string; detail: string; start?: string; confirm: string; cancel: string; onClose: () => void; onPick: (path: string) => Promise<void> }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  // Only the newest ask is shown: a refused folder asked again as Edit comes forward answered after a click on
  // another place, and showed the folder left (kenobi, Nov 16: Documents' refusal over Downloads').
  const asked = useRef(0);
  const go = (path?: string, opening = false) => {
    const ask = ++asked.current;
    setProblem(null);
    setNaming(false);
    setFresh(null);
    api
      .browse(path)
      .then((given) => {
        if (ask === asked.current) setListing(given);
      })
      .catch((error: Error) => {
        if (ask !== asked.current) return;
        // Where it opens may be gone (a folder not made yet, or deleted): the nearest one above, then home.
        if (opening && path !== undefined) return go(above(path) ?? undefined, true);
        setProblem(error.message);
      });
  };
  useEffect(() => {
    go(start, true);
    // Where it opens is decided as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pick = (path: string) => {
    setBusy(true);
    setProblem(null);
    onPick(path).then(
      () => setBusy(false),
      (error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
        setBusy(false);
      },
    );
  };
  const here = listing?.path ?? "";
  const open = listing !== null && !listing.refused;
  const make = async (name: string) => {
    const made = await api.newFolder(here, name);
    setListing(await api.browse(here));
    setNaming(false);
    setFresh(made.path);
  };
  return (
    <div className="flex h-[520px] flex-col">
      <div className="border-b border-line px-6 pt-6 pb-4">
        <DialogTitle title={title} detail={detail} />
      </div>
      <FolderBrowser listing={listing} problem={problem} onGo={go} foldersOnly empty="No folders in here. You can still pick this one." naming={naming && open ? { make, close: () => setNaming(false) } : null} fresh={fresh} />
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <Button variant="ghost" disabled={!open || busy || naming} onClick={() => setNaming(true)}>
          <FolderPlus size={14} /> New folder
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {cancel}
          </Button>
          <Button variant="primary" busy={busy} disabled={!open} onClick={() => pick(here)}>
            {confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
