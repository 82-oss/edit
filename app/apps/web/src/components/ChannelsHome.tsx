// Home's Channels (Sphe, Nov 15, the approved redesign): a table like the
// Edits page (search, All · Groups · Not set up, then a row a channel or a
// group, never a group's channels under it: "way too redundant"), a group's
// page (the first channel's banner, the lanes they share, a card a channel
// with its own voice and compilation switch) and a channel's page (its
// banner, its lanes with what comes from its group and what's its alone, its
// settings, who it's grouped with and what's in progress for it). Teachers
// change things; everyone else reads. Which page is open lives here
// (useChannelsNav), so Home's header can say where back goes and hold the
// page's buttons.

import { ArrowLeft, ArrowUpToLine, ChevronDown, Ellipsis, ExternalLink, FileText, Film, Image as ImageIcon, Layers, Lightbulb, Link2, Plus, Search, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";

import {
  bannerUrl,
  channelsOf,
  compact,
  countsOf,
  groupApi,
  groupTitle,
  LANES,
  loadChannels,
  narrationLabel,
  narrationShort,
  rowsOf,
  taughtWords,
  useChannels,
  useTaughtOf,
  channelApi,
  type Channel,
  type ChannelRow,
  type Group,
  type Lane,
  type Taught,
} from "../lib/channels";
import { api } from "../lib/api";
import { thumbnailsApi } from "../lib/thumbnails";
import { useEditor } from "../lib/store";
import { AddChannel, AddToGroup, ChannelAvatar, ChannelsFailed, facts, GroupAvatar, InPlace, LABEL, LabelField, LinkChannel, MakeGroup, TAUGHT_WORD, useVoices } from "./Channels";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { COLUMNS, NAME, PILL, ROW } from "./HomeTable";
import { Loader } from "./Logo";
import { Button, ConfirmDialog, cx, IconButton, Select, spring, Switch } from "./ui";
import { VoicePicker } from "./VoicePicker";

/** A piece of work for a channel that isn't done, as Home lists it. */
export interface ChannelWork {
  id: string;
  title: string;
  kind: "edit" | "script" | "idea" | "thumbnail";
  channel: string;
  open: () => void;
}

type Dialog = "add" | "link" | "group" | "add-to-group" | "ungroup";

/** Which page is open (none: the table), and which of its dialogs. */
export const useChannelsNav = create<{ open: { channel?: string; group?: string } | null; dialog: Dialog | null }>(() => ({ open: null, dialog: null }));
const go = (open: { channel?: string; group?: string } | null) => useChannelsNav.setState({ open, dialog: null });
const dialog = (which: Dialog | null) => useChannelsNav.setState({ dialog: which });

/** What's open, as the channels are now: a group only while two or more of its channels are seen. */
function useOpen(): { channel: Channel | null; group: { group: Group; members: Channel[] } | null; back: { label: string; to: { group: string } | null } } {
  const open = useChannelsNav((state) => state.open);
  const channels = useChannels((state) => state.channels) ?? [];
  const groups = useChannels((state) => state.groups);
  const channel = open?.channel !== undefined ? (channels.find((one) => one.key === open.channel) ?? null) : null;
  const shownOf = (key: string | undefined) => {
    const group = groups.find((one) => one.key === key);
    const members = group === undefined ? [] : channelsOf(group, channels);
    return group !== undefined && members.length >= 2 ? { group, members } : null;
  };
  const group = channel !== null ? (channel.group ? shownOf(channel.group) : null) : shownOf(open?.group);
  // A channel's page goes back to its group's when it has one shown; a group's to the table.
  const back = channel !== null && group !== null ? { label: groupTitle(group.group, channels), to: { group: group.group.key } } : { label: "Channels", to: null };
  return { channel, group, back };
}

/** Home's header on Channels: "Channels 7" over the table; on a page, where back goes. */
export function ChannelsTitle() {
  const open = useChannelsNav((state) => state.open);
  const channels = useChannels((state) => state.channels);
  const { back } = useOpen();
  if (open === null)
    return (
      <h1 className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap">
        <span className="truncate">Channels</span>
        {channels !== null && <span className="ml-1 text-[13px] font-normal text-faint tabular">{channels.length}</span>}
      </h1>
    );
  return (
    <button onClick={() => go(back.to)} className="-ml-2 flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg">
      <ArrowLeft size={14} className="shrink-0" />
      <span className="truncate">{back.label}</span>
    </button>
  );
}

/** The header's buttons: Add channel over the table; a page's own on a page (a teacher's, but Open on YouTube). */
export function ChannelsActions() {
  const teacher = useChannels((state) => state.teacher);
  const open = useChannelsNav((state) => state.open);
  const { channel, group } = useOpen();
  if (open === null)
    return teacher ? (
      <Button variant="light" onClick={() => dialog("add")}>
        <Plus size={15} strokeWidth={2.2} /> Add channel
      </Button>
    ) : null;
  if (channel !== null)
    return (
      <>
        {teacher && channel.youtubeId === null && channel.masked !== true && (
          <Button variant="subtle" onClick={() => dialog("link")}>
            <Link2 size={14} /> Link a YouTube channel
          </Button>
        )}
        {teacher && group === null && channel.masked !== true && (
          <Button variant="subtle" onClick={() => dialog("group")} title="Share one style with other channels">
            <Layers size={14} /> Group
          </Button>
        )}
        {channel.youtubeId !== null && channel.masked !== true && (
          <a
            href={`https://www.youtube.com/channel/${channel.youtubeId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-line-strong px-3.5 text-[13px] font-medium text-fg transition-colors hover:bg-hover"
          >
            Open on YouTube <ExternalLink size={13} className="text-muted" />
          </a>
        )}
      </>
    );
  if (group === null || !teacher) return null;
  return (
    <>
      <Button variant="subtle" onClick={() => dialog("add-to-group")}>
        <Plus size={14} /> Add a channel
      </Button>
      <button
        title="More"
        aria-label="More"
        onClick={(event) => toggleMenu(event.currentTarget, [{ label: "Ungroup…", onSelect: () => dialog("ungroup") }], { width: 160 })}
        className="flex size-[34px] items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg data-[menu-open]:bg-active data-[menu-open]:text-fg"
      >
        <Ellipsis size={16} />
      </button>
    </>
  );
}

/** Home's Channels: the table, or the page open. `work` is what Home lists that's for a channel and not done. */
export function ChannelsView({ work }: { work: ChannelWork[] }) {
  const channels = useChannels((state) => state.channels);
  const open = useChannelsNav((state) => state.open);
  const which = useChannelsNav((state) => state.dialog);
  const { channel, group } = useOpen();
  useEffect(() => {
    void loadChannels();
  }, []);
  // A page whose channel or group is gone (taken out, ungrouped, archived) is the table again; not while the
  // channels couldn't be read (they're null then, never an empty list), so a failed read keeps the page you're on.
  const gone = channels !== null && open !== null && channel === null && group === null;
  useEffect(() => {
    if (gone) go(null);
  }, [gone]);
  const all = useWork(work);
  const page = channel !== null ? `channel:${channel.key}` : group !== null ? `group:${group.group.key}` : "list";
  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={page} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ ...spring, duration: 0.16 }} className="flex flex-col">
          {channel !== null ? <ChannelPage channel={channel} group={group} work={all} /> : group !== null ? <GroupPage group={group.group} members={group.members} work={all} /> : <ChannelTable work={all} />}
        </motion.div>
      </AnimatePresence>
      <AddChannel open={which === "add"} onClose={() => dialog(null)} onAdded={(added) => go({ channel: added.key })} />
    </>
  );
}

/** Home's work, and the thumbnails being made now (asked once Channels opens). */
function useWork(work: ChannelWork[]): ChannelWork[] {
  const [thumbs, setThumbs] = useState<ChannelWork[]>([]);
  useEffect(() => {
    let alive = true;
    thumbnailsApi.list().then(
      ({ thumbnails }) =>
        alive &&
        setThumbs(
          thumbnails
            .filter((one) => one.summary.channel && (one.summary.run === "running" || one.summary.run === "queued"))
            .map((one) => ({ id: `thumb-${one.id}`, title: one.summary.title || "Untitled thumbnail", kind: "thumbnail", channel: one.summary.channel!, open: () => window.location.assign(`/thumbnails/${one.id}`) })),
        ),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return [...work, ...thumbs];
}

const WORK_WORD: Record<ChannelWork["kind"], [string, string]> = { edit: ["edit", "edits"], script: ["script", "scripts"], idea: ["idea", "ideas"], thumbnail: ["thumbnail", "thumbnails"] };
const WORK_ICON = { edit: Film, script: FileText, idea: Lightbulb, thumbnail: ImageIcon } as const;

/** "1 edit · 2 scripts", or null with nothing. */
function workWords(work: ChannelWork[]): string | null {
  const words = (Object.keys(WORK_WORD) as ChannelWork["kind"][]).flatMap((kind) => {
    const count = work.filter((one) => one.kind === kind).length;
    return count === 0 ? [] : [`${count} ${WORK_WORD[kind][count === 1 ? 0 : 1]}`];
  });
  return words.length === 0 ? null : words.join(" · ");
}

type Filter = "all" | "groups" | "setup";

const membersOf = (row: ChannelRow) => (row.kind === "group" ? row.members : [row.channel]);

/** The table: a search, the filters, then a row a group or a channel. */
function ChannelTable({ work }: { work: ChannelWork[] }) {
  const channels = useChannels((state) => state.channels);
  const groups = useChannels((state) => state.groups);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const failed = useChannels((state) => state.failed !== null);
  if (channels === null && failed)
    return (
      <div className="mx-auto mt-16 flex max-w-[360px] justify-center">
        <ChannelsFailed />
      </div>
    );
  if (channels === null)
    return (
      <div className="mt-20 flex justify-center">
        <Loader size={32} />
      </div>
    );
  if (channels.length === 0)
    return (
      <div className="mx-auto mt-16 max-w-[320px] text-center">
        <h3 className="text-[15px] font-semibold">No channels yet</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">Paste a link to a YouTube channel, or name one that isn't on YouTube yet. Each channel keeps its own style for ideas, thumbnails, scripts and edits.</p>
      </div>
    );
  const rows = rowsOf(channels, groups);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (row: ChannelRow) => words.length === 0 || membersOf(row).some((one) => words.every((word) => [one.title, one.handle ?? "", one.label ?? ""].join(" ").toLowerCase().includes(word)));
  const notSetUp = (row: ChannelRow) => membersOf(row).some((one) => one.narration === null);
  const found = rows.filter(matches);
  const counts = { groups: found.filter((row) => row.kind === "group").length, setup: found.filter(notSetUp).length };
  const shown = found.filter((row) => (filter === "groups" ? row.kind === "group" : filter === "setup" ? notSetUp(row) : true));
  const chip = (key: Filter, label: string, count: number | null) => {
    const on = filter === key;
    const empty = count === 0 && !on;
    return (
      <button
        key={key}
        disabled={empty}
        onClick={() => setFilter(on ? "all" : key)}
        className={cx("flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors", on ? "bg-active text-fg" : empty ? "text-faint" : "text-muted hover:bg-hover hover:text-fg")}
      >
        {label}
        {count !== null && count > 0 && <span className={cx("tabular", on ? "text-secondary" : "text-faint")}>{count}</span>}
      </button>
    );
  };
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-black px-2.5 text-muted focus-within:border-line-strong">
          <Search size={14} className="shrink-0" />
          <input
            value={query}
            placeholder="Search channels…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          />
          {query !== "" && (
            <button onClick={() => setQuery("")} title="Clear" className="shrink-0 text-faint hover:text-fg">
              <X size={13} />
            </button>
          )}
        </label>
      </div>
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-0.5">
        {chip("all", "All", null)}
        <span className="mx-1 h-4 w-px shrink-0 bg-line" />
        {chip("groups", "Groups", counts.groups)}
        {chip("setup", "Not set up", counts.setup)}
      </div>
      {shown.length === 0 ? (
        <div className="mt-16 text-center">
          <div className="text-[14px] font-medium">Nothing matches</div>
          <p className="mt-1.5 text-[13px] text-muted">{words.length > 0 ? `No channel is called “${query.trim()}”.` : "Every channel here is set up."}</p>
        </div>
      ) : (
        // Narrower, In progress goes first, then Taught, so a name always has room.
        <div className="@container">
          <div
            role="table"
            aria-label="Channels"
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,170px)_minmax(0,190px)_minmax(0,130px)_80px] gap-x-4 @max-[760px]:grid-cols-[minmax(0,1fr)_minmax(0,150px)_minmax(0,170px)_72px] @max-[560px]:grid-cols-[minmax(0,1fr)_minmax(0,130px)_64px]"
          >
            <div role="row" className={cx(COLUMNS, "px-3 pb-2 text-[12px] font-medium text-muted")}>
              <span role="columnheader">Channel</span>
              <span role="columnheader">Narration</span>
              <span role="columnheader" className={TAUGHT_COLUMN}>
                Taught
              </span>
              <span role="columnheader" className={WORK_COLUMN}>
                In progress
              </span>
              <span role="columnheader" className="text-right">
                Subscribers
              </span>
            </div>
            {shown.map((row) => (
              <TableRow key={row.key} row={row} work={work.filter((one) => membersOf(row).some((member) => member.key === one.channel))} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const TAUGHT_COLUMN = "@max-[560px]:hidden";
const WORK_COLUMN = "@max-[760px]:hidden";
const NOT_SET_UP = `${PILL} bg-warning-soft font-medium text-warning`;

function TableRow({ row, work }: { row: ChannelRow; work: ChannelWork[] }) {
  const channels = useChannels((state) => state.channels) ?? [];
  const members = membersOf(row);
  const taught = countsOf(useTaughtOf(row.kind === "group" ? `group:${row.key}` : `channel:${row.key}`));
  const voices = [...new Set(members.map((one) => narrationShort(one.narration)))];
  const subscribers = members.every((one) => one.subscribers === null) ? null : members.reduce((total, one) => total + (one.subscribers ?? 0), 0);
  const doing = workWords(work);
  const sub = row.kind === "group" ? `${members.length} channels · one style` : row.channel.masked === true ? null : row.channel.youtubeId === null ? "Placeholder" : row.channel.handle ? `@${row.channel.handle}` : null;
  return (
    <button role="row" onClick={() => go(row.kind === "group" ? { group: row.key } : { channel: row.key })} className={cx(COLUMNS, ROW, "w-full text-left outline-none focus-visible:bg-hover")}>
      <span role="cell" className="flex min-w-0 items-center gap-3">
        <span className="flex w-[38px] shrink-0 justify-center">{row.kind === "group" ? <GroupAvatar channels={members} size={26} ring="ring-2 ring-panel group-hover:ring-hover" /> : <ChannelAvatar channel={row.channel} size={32} />}</span>
        <span className="min-w-0">
          <span className={cx(NAME, "block font-medium")}>{row.kind === "group" ? groupTitle(row.group, channels) : row.channel.title}</span>
          {sub !== null && <span className="block truncate text-[12px] text-faint">{sub}</span>}
        </span>
      </span>
      <span role="cell" className="min-w-0 truncate text-[13px] text-secondary">
        {voices.includes(null) ? <span className={NOT_SET_UP}>Not set up</span> : voices.join(", ")}
      </span>
      <span role="cell" className={cx("min-w-0 truncate text-[13px]", TAUGHT_COLUMN)}>
        {taught === null ? <span className="inline-block h-2 w-16 rounded-full bg-active" /> : <span className={taughtWords(taught) === "Nothing yet" ? "text-faint" : "text-secondary"}>{taughtWords(taught)}</span>}
      </span>
      <span role="cell" className={cx("min-w-0 truncate text-[13px]", doing === null ? "text-faint" : "text-secondary", WORK_COLUMN)}>
        {doing ?? "—"}
      </span>
      <span role="cell" className="truncate text-right text-[13px] text-secondary tabular" title={row.kind === "group" && subscribers !== null ? "Together" : undefined}>
        {compact(subscribers)}
      </span>
    </button>
  );
}

/** A page's top: the banner across it fading into the panel, the picture over its foot, the name and a line under it. */
function Hero({ banner, picture, title, meta, children }: { banner: string | null; picture: ReactNode; title: string; meta: string; children?: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const shown = bannerUrl(banner);
  // Each page starts at its top.
  const top = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    top.current?.closest(".overflow-y-auto")?.scrollTo({ top: 0 });
  }, []);
  return (
    <div ref={top} className="-mx-4 -mt-3">
      {shown !== null ? (
        <div className="relative h-[clamp(96px,14vw,150px)] overflow-hidden bg-raised">
          <img src={shown} alt="" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} className={cx("size-full object-cover transition-opacity duration-500", loaded ? "opacity-100" : "opacity-0")} />
          <div className="absolute inset-0 bg-gradient-to-b from-panel/0 via-panel/30 to-panel" />
        </div>
      ) : (
        <div className="h-6" />
      )}
      <div className={cx("relative mx-auto flex max-w-[1120px] items-end gap-4 px-7", shown !== null && "-mt-9")}>
        {picture}
        <div className="min-w-0 pb-1">
          <h2 className="truncate text-[21px] font-semibold tracking-[-0.3px]">{title}</h2>
          {meta !== "" && <p className="mt-0.5 truncate text-[13px] text-muted">{meta}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** The page's two columns: the lanes, and what's beside them. */
function Columns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="@container">
      <div className="mx-auto grid max-w-[1120px] grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6 px-3 pt-6 pb-8 @max-[820px]:grid-cols-1">
        <div className="min-w-0">{left}</div>
        <div className="flex min-w-0 flex-col gap-6">{right}</div>
      </div>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[13px] font-medium text-muted">{children}</h3>;
}

const CARD = "rounded-xl border border-line bg-raised";

const failed = (what: string) => (error: unknown) => useEditor.getState().toastError(error, what);

/** One lane as a row: its name, its description, how much it's been taught; opened, what. */
interface LaneRow {
  lane: Lane;
  label: string;
  description: ReactNode;
  count: ReactNode;
  empty: boolean;
  body: ReactNode;
}

/** The lanes, one open at a time: the one taught most, to start with. */
function Lanes({ rows, most }: { rows: LaneRow[]; most: Lane | null | undefined }) {
  const [open, setOpen] = useState<Lane | null | undefined>(undefined);
  const shown = open === undefined ? most : open;
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      {rows.map((row, index) => {
        const on = shown === row.lane;
        const toggle = () => setOpen(on ? null : row.lane);
        return (
          <div key={row.lane} className={cx(index > 0 && "border-t border-line")}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={on}
              onClick={toggle}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                toggle();
              }}
              className={cx("group/lane flex items-start gap-3 px-3.5 py-3 outline-none transition-colors hover:bg-hover focus-visible:bg-hover", on && "bg-hover/60")}
            >
              <span className="w-[84px] shrink-0 text-[13px] leading-[22px] font-medium">{row.label}</span>
              <span className="min-w-0 flex-1" onClick={(event) => event.target instanceof HTMLTextAreaElement && event.stopPropagation()}>
                {row.description}
              </span>
              <span className={cx("mt-px flex h-5 shrink-0 items-center rounded-md bg-active px-1.5 text-[12px] text-secondary tabular", row.empty && "opacity-50")}>{row.count}</span>
              <ChevronDown size={14} className={cx("mt-1 shrink-0 text-faint transition-transform duration-200", on && "rotate-180")} />
            </div>
            <AnimatePresence initial={false}>
              {on && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
                  <div className="px-3.5 pt-0.5 pb-3.5 pl-[110px] @max-[520px]:pl-3.5">{row.body}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

/** The lane taught most (null: none taught anything; undefined: not read yet). */
function mostOf(...counts: (Record<Lane, number> | null)[]): Lane | null | undefined {
  if (counts.some((one) => one === null)) return undefined;
  const total = (lane: Lane) => counts.reduce((sum, one) => sum + one![lane], 0);
  const best = LANES.reduce<Lane | null>((top, lane) => (total(lane.key) > 0 && (top === null || total(lane.key) > total(top)) ? lane.key : top), null);
  return best;
}

const SHOWN = 8;

/** What a lane was taught, two to a line, names and notes: the first few, then "and N more". */
function TaughtItems({ items, lane }: { items: Taught[]; lane: Lane }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return <p className="text-[12.5px] text-faint">Nothing taught yet</p>;
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-1 @max-[520px]:grid-cols-1">
      {shown.map((one) => (
        <div key={one.key} className="min-w-0 truncate text-[12.5px]" title={[one.name, one.note].filter(Boolean).join(": ")}>
          <span className="font-medium">{one.name}</span>
          <span className="text-faint"> · {one.note || kindWord(one, lane)}</span>
        </div>
      ))}
      {items.length > SHOWN && (
        <button onClick={() => setAll(!all)} className="justify-self-start text-[12.5px] text-faint transition-colors hover:text-fg">
          {all ? "Fewer" : `and ${items.length - SHOWN} more`}
        </button>
      )}
    </div>
  );
}

const kindWord = (one: Taught, lane: Lane) => (one.kind === "template" && lane === "thumbnails" ? "graphic" : TAUGHT_WORD[one.kind].toLowerCase());

const SUB = "mb-1.5 text-[11.5px] font-medium text-faint";

/**
 * A group's page: their pictures over the first channel's banner, the lanes
 * they share (a teacher writes each one's line; what's been taught builds up
 * as the team works) and a card a channel, each with its own voice and
 * compilation switch. A teacher adds a channel, takes one out (it keeps a
 * copy of the group's teaching) or ungroups them all.
 */
function GroupPage({ group, members, work }: { group: Group; members: Channel[]; work: ChannelWork[] }) {
  const teacher = useChannels((state) => state.teacher);
  const channels = useChannels((state) => state.channels) ?? [];
  const which = useChannelsNav((state) => state.dialog);
  const taught = useTaughtOf(`group:${group.key}`, true);
  const counts = countsOf(taught);
  const total = counts === null ? null : LANES.reduce((sum, lane) => sum + counts[lane.key], 0);
  const [busy, setBusy] = useState(false);
  const ungroup = () => {
    setBusy(true);
    void groupApi
      .ungroup(group.key)
      .then(() => go(null), failed("ungroup these channels"))
      .finally(() => {
        setBusy(false);
        dialog(null);
      });
  };
  const meta = [`${members.length} channels share one style`, total === null ? null : total === 0 ? "nothing taught yet" : `${total} ${total === 1 ? "thing" : "things"} taught`].filter(Boolean).join(" · ");
  return (
    <>
      <Hero banner={members.find((one) => one.banner && one.masked !== true)?.banner ?? null} picture={<GroupAvatar channels={members} size={64} ring="ring-[3px] ring-panel" />} title={groupTitle(group, channels)} meta={meta} />
      <Columns
        left={
          <>
            <Heading>Shared style</Heading>
            <Lanes
              most={mostOf(counts)}
              rows={LANES.map((lane) => ({
                lane: lane.key,
                label: lane.label,
                description: (
                  <InPlace
                    value={group.lanes[lane.key]}
                    editable={teacher}
                    placeholder={teacher ? "Add a line about its style" : ""}
                    onSave={(text) => void groupApi.set(group.key, { [lane.key]: text }).catch(failed(`change the ${lane.label.toLowerCase()} style`))}
                    className="text-[13px] leading-[22px] text-muted"
                  />
                ),
                count: counts === null ? "·" : counts[lane.key],
                empty: (counts?.[lane.key] ?? 0) === 0,
                body: taught === null ? null : <TaughtItems items={taught[lane.key]} lane={lane.key} />,
              }))}
            />
          </>
        }
        right={
          <div>
            <Heading>Channels</Heading>
            <div className="flex flex-col gap-2.5">
              {members.map((one) => (
                <MemberCard key={one.key} channel={one} group={group} count={members.length} work={work.filter((each) => each.channel === one.key)} />
              ))}
            </div>
          </div>
        }
      />
      <AddToGroup open={which === "add-to-group"} group={group} onClose={() => dialog(null)} />
      <ConfirmDialog open={which === "ungroup"} onClose={() => dialog(null)} onConfirm={ungroup} busy={busy} tone="light" title="Ungroup these channels?" detail="Each keeps a copy of the shared style as its own." confirm="Ungroup" />
    </>
  );
}

/** A channel on its group's page: who it is, its own voice and compilation switch, and what's its alone. */
function MemberCard({ channel, group, count, work }: { channel: Channel; group: Group; count: number; work: ChannelWork[] }) {
  const teacher = useChannels((state) => state.teacher);
  const own = countsOf(useTaughtOf(`channel:${channel.key}`, true));
  const ownWords = own === null ? null : taughtWords(own);
  const open = () => go({ group: group.key, channel: channel.key });
  const takeOut = () => void groupApi.takeOut(group.key, channel.key).then(() => count <= 2 && go(null), failed(`take ${channel.title} out`));
  const menu: MenuItem[] = [{ label: "Open", onSelect: open }, ...(teacher ? ([{ separator: true }, { label: "Take out of the group", onSelect: takeOut }] satisfies MenuItem[]) : [])];
  const doing = workWords(work);
  return (
    <div className={cx(CARD, "p-3.5")}>
      <div className="flex items-center gap-3">
        <button onClick={open} className="group/name flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChannelAvatar channel={channel} size={36} />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium group-hover/name:underline">{channel.title}</span>
            {facts(channel) !== "" && <span className="block truncate text-[12px] text-faint">{shortFacts(channel)}</span>}
          </span>
        </button>
        <IconButton label="More" onClick={(event) => toggleMenu(event.currentTarget, menu, { width: 190 })}>
          <Ellipsis size={16} />
        </IconButton>
      </div>
      <div className="mt-3 flex gap-2 @max-[420px]:flex-col">
        <Narrator channel={channel} className="min-w-0 flex-1" />
        <Compilation channel={channel} boxed />
      </div>
      <button onClick={open} className="mt-2.5 block max-w-full truncate text-left text-[12px] text-faint transition-colors hover:text-fg">
        {ownWords === null ? " " : ownWords === "Nothing yet" ? "Nothing of its own: all from the group" : `Its own: ${ownWords}`}
        {doing !== null && ` · ${doing} in progress`}
      </button>
    </div>
  );
}

/** "@handle · 9.6K": a card's line (its page has the videos too). */
function shortFacts(channel: Channel): string {
  if (channel.masked === true) return "";
  if (channel.youtubeId === null) return "Placeholder";
  return [channel.handle ? `@${channel.handle}` : null, compact(channel.subscribers)].filter(Boolean).join(" · ");
}

const change = (channel: Channel, what: string, given: Parameters<typeof channelApi.set>[1]) => void channelApi.set(channel.key, given).catch(failed(`change ${channel.title}'s ${what}`));

/** Who narrates a channel's videos: a teacher picks, anyone else reads. */
function Narrator({ channel, className }: { channel: Channel; className?: string }) {
  const teacher = useChannels((state) => state.teacher);
  const voices = useVoices(teacher);
  if (!teacher)
    return (
      <div className={cx("flex h-9 items-center rounded-lg border border-line px-3 text-[13px]", className)}>
        {channel.narration === null ? <span className="text-faint">Not set up</span> : <span className="truncate">{narrationLabel(channel.narration)}</span>}
      </div>
    );
  return (
    <div className={className}>
      <VoicePicker value={channel.narration} voices={voices.voices} used={voices.used} channel={channel.key} onChange={(narration) => change(channel, "narration", { narration })} />
    </div>
  );
}

/** Whether it's a compilation channel: boxed beside the voice on a group's card, a line of its own on a channel's page. */
function Compilation({ channel, boxed = false }: { channel: Channel; boxed?: boolean }) {
  const teacher = useChannels((state) => state.teacher);
  const control = teacher ? <Switch checked={channel.compilation} onChange={(compilation) => change(channel, "compilation", { compilation })} /> : <span className="text-[13px] text-muted">{channel.compilation ? "Yes" : "No"}</span>;
  if (boxed)
    return (
      <div className="flex h-9 shrink-0 items-center justify-between gap-2.5 rounded-lg border border-line px-3 text-[12.5px] text-secondary" title="Several cases in each video">
        Compilation {control}
      </div>
    );
  return (
    <div className="flex items-center justify-between gap-3">
      <span>
        <span className="block text-[13px] font-medium">Compilation channel</span>
        <span className="block text-[12px] text-faint">Several cases in each video</span>
      </span>
      {control}
    </div>
  );
}

/**
 * Its watermark (Sphe, Nov 16: "show watermarks when available for that
 * specific channel"): its logo, picked from the Watermarks folder's pictures,
 * is what its projects' exports offer; None, they offer nothing. A teacher's
 * to pick, linked to the channel (not its name), so nobody else sees it here.
 */
function Watermark({ channel }: { channel: Channel }) {
  const [pictures, setPictures] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    void api.watermarks().then(
      (given) => live && setPictures(given.channels),
      () => live && setPictures([]),
    );
    return () => {
      live = false;
    };
  }, []);
  const value = channel.watermark ?? "";
  const options = [{ value: "", label: "None" }, ...(pictures ?? []).map((one) => ({ value: one.id, label: one.name }))];
  // Its own before the folder is read, or once it's left the folder.
  if (value !== "" && !options.some((one) => one.value === value)) options.push({ value, label: pictures === null ? "…" : "Not in the folder" });
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] font-medium">Watermark</span>
      <Select
        value={value}
        options={options}
        onChange={(picked) => change(channel, "watermark", { watermark: picked === "" ? null : picked })}
        className="h-[30px] min-w-[140px] shrink-0 justify-between rounded-lg border border-line-strong bg-bg pr-2.5 pl-3 text-[13px] hover:border-muted"
        menuWidth={200}
      />
    </div>
  );
}

/**
 * A channel's page: its banner, picture and YouTube facts; its lanes, each
 * with what comes from its group and what's its alone (which a teacher moves
 * into the group); its settings, who it's grouped with, and what's in
 * progress for it. A placeholder keeps its dashed picture and Link a YouTube
 * channel; one seen by its label alone shows nothing YouTube says of it.
 */
function ChannelPage({ channel, group, work }: { channel: Channel; group: { group: Group; members: Channel[] } | null; work: ChannelWork[] }) {
  const teacher = useChannels((state) => state.teacher);
  const which = useChannelsNav((state) => state.dialog);
  const ownTaught = useTaughtOf(`channel:${channel.key}`, true);
  const groupTaught = useTaughtOf(group === null ? null : `group:${group.group.key}`);
  const own = countsOf(ownTaught);
  const shared = group === null ? null : countsOf(groupTaught);
  const mine = work.filter((one) => one.channel === channel.key);
  const others = group === null ? [] : group.members.filter((one) => one.key !== channel.key);
  const [moving, setMoving] = useState<string | null>(null);
  const move = (item: Taught) => {
    if (group === null) return;
    setMoving(item.key);
    void groupApi
      .move(group.group.key, item.key)
      .catch(failed(`move ${item.name} into the group`))
      .finally(() => setMoving(null));
  };
  const saveLane = (lane: (typeof LANES)[number]) => (text: string) => change(channel, `${lane.label.toLowerCase()} style`, { lanes: { [lane.key]: text } });
  const rows: LaneRow[] = LANES.map((lane) => {
    const mineCount = own?.[lane.key] ?? 0;
    if (group === null)
      return {
        lane: lane.key,
        label: lane.label,
        description: <InPlace value={channel.lanes[lane.key]} editable={teacher} placeholder={teacher ? "Add a line about its style" : ""} onSave={saveLane(lane)} className="text-[13px] leading-[22px] text-muted" />,
        count: own === null ? "·" : mineCount,
        empty: mineCount === 0,
        body: ownTaught === null ? null : <TaughtItems items={ownTaught[lane.key]} lane={lane.key} />,
      };
    const fromGroup = shared?.[lane.key] ?? 0;
    const line = group.group.lanes[lane.key];
    return {
      lane: lane.key,
      label: lane.label,
      description: line ? (
        <p className="text-[13px] leading-[22px] text-muted">
          <span className="text-faint">From the group: </span>
          {line}
        </p>
      ) : channel.lanes[lane.key] ? (
        <p className="text-[13px] leading-[22px] text-muted">{channel.lanes[lane.key]}</p>
      ) : (
        <p className="text-[13px] leading-[22px] text-faint/80">From the group</p>
      ),
      count: shared === null || own === null ? "·" : mineCount > 0 ? `${fromGroup} + ${mineCount}` : fromGroup,
      empty: fromGroup + mineCount === 0,
      body: (
        <div className="flex flex-col gap-3.5">
          {groupTaught !== null && (
            <div>
              <div className={SUB}>From the group</div>
              <TaughtItems items={groupTaught[lane.key]} lane={lane.key} />
            </div>
          )}
          {(teacher || mineCount > 0 || channel.lanes[lane.key] !== "") && (
            <div>
              <div className={SUB}>Only this channel</div>
              <InPlace value={channel.lanes[lane.key]} editable={teacher} placeholder={teacher ? "Where it differs, in a line or two" : ""} onSave={saveLane(lane)} className="text-[13px] leading-relaxed text-secondary" />
              {ownTaught !== null && ownTaught[lane.key].length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {ownTaught[lane.key].map((item) => (
                    <li key={item.key} className="group/own flex min-h-6 min-w-0 items-center gap-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate" title={[item.name, item.note].filter(Boolean).join(": ")}>
                        <span className="font-medium">{item.name}</span>
                        <span className="text-faint"> · {item.note || kindWord(item, lane.key)}</span>
                      </span>
                      {teacher && (
                        <button
                          onClick={() => move(item)}
                          disabled={moving !== null}
                          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted opacity-0 transition-[opacity,color] group-hover/own:opacity-100 hover:text-fg focus-visible:opacity-100 disabled:opacity-40"
                        >
                          <ArrowUpToLine size={12} /> Move into the group
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ),
    };
  });
  return (
    <>
      <Hero
        banner={channel.masked === true ? null : channel.banner}
        picture={
          <span className="shrink-0 rounded-full bg-panel ring-[3px] ring-panel">
            <ChannelAvatar channel={channel} size={72} />
          </span>
        }
        title={channel.title}
        meta={facts(channel)}
      >
        <AnimatePresence initial={false}>
          {which === "link" && channel.youtubeId === null && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring} className="overflow-hidden">
              <div className="mx-auto max-w-[1120px] px-7">
                <div className="max-w-[520px]">
                  <LinkChannel channel={channel} onDone={() => dialog(null)} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Hero>
      <Columns
        left={
          <>
            <Heading>Its style</Heading>
            <Lanes rows={rows} most={mostOf(own, ...(group === null ? [] : [shared]))} />
          </>
        }
        right={
          <>
            <div>
              <Heading>Settings</Heading>
              <div className={cx(CARD, "flex flex-col gap-3.5 p-3.5")}>
                <div>
                  <span className={LABEL}>Who narrates</span>
                  <Narrator channel={channel} />
                </div>
                <Compilation channel={channel} />
                {teacher && channel.masked !== true && <Watermark channel={channel} />}
                {/* What someone given only its label sees for its name (accounts.spheceo.com), set by a teacher. */}
                {teacher && channel.masked !== true && (
                  <div className="border-t border-line pt-3">
                    <LabelField value={channel.label ?? ""} onSave={(text) => change(channel, "label", { label: text })} />
                  </div>
                )}
              </div>
            </div>
            {group !== null && others.length > 0 && (
              <div>
                <Heading>Grouped with</Heading>
                <div className={cx(CARD, "flex flex-col p-1.5")}>
                  {others.map((one) => (
                    <div key={one.key} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                      <button onClick={() => go({ group: group.group.key, channel: one.key })} className="group/name flex min-w-0 flex-1 items-center gap-2.5 text-left">
                        <ChannelAvatar channel={one} size={28} />
                        <span className="truncate text-[13px] font-medium group-hover/name:underline">{one.title}</span>
                      </button>
                      {teacher && (
                        <Button variant="ghost" size="sm" onClick={() => void groupApi.takeOut(group.group.key, one.key).catch(failed(`take ${one.title} out`))}>
                          Take out
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <Heading>In progress</Heading>
              <div className={cx(CARD, "flex flex-col p-1.5")}>
                {mine.length === 0 ? (
                  <p className="px-2 py-1.5 text-[12.5px] text-faint">Nothing on this channel right now</p>
                ) : (
                  mine.map((one) => {
                    const Icon = WORK_ICON[one.kind];
                    return (
                      <button key={one.id} onClick={one.open} className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover">
                        <Icon size={14} className="shrink-0 text-muted" />
                        <span className="min-w-0 flex-1 truncate text-[13px]">{one.title || "Untitled"}</span>
                        <span className="shrink-0 text-[12px] text-faint">{WORK_WORD[one.kind][0]}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </>
        }
      />
      <MakeGroup open={which === "group"} channel={channel} onClose={() => dialog(null)} onMade={(key) => go({ group: key })} />
    </>
  );
}
