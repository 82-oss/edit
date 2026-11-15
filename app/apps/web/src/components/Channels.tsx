// Channels on Home (Nov 14; Sphe: "a dedicated section where we load in
// channels"): the team's YouTube channels, one added by pasting any link to it
// and then set up (who narrates, whether it's a compilation channel); a
// channel's page shows its lanes (ideas, thumbnails, script, edit), each with
// its own style. Adding and changing one is a teacher's; anyone reads them.
// A placeholder (Sphe, Nov 15) is a channel by its name before it's on
// YouTube: a blank picture, a dashed border where it's picked, and Link on its
// page once the real channel is made (its teaching kept).
// A group (Sphe, Nov 15) is one row in place of its channels: their names
// together, their pictures stacked. Its page holds the shared lanes and each
// channel's own settings and "Only this channel" teaching.

import { ArrowLeft, ArrowUpToLine, ExternalLink, Layers, Link2, Mic, Plus, User } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

import { channelApi, channelsOf, compact, groupApi, groupTitle, LANES, loadChannels, narrationLabel, useChannels, type Channel, type Found, type Group, type Lane, type Narration, type Taught, type Used, type Voice } from "../lib/channels";
import { useEditor } from "../lib/store";
import { useBeta } from "../lib/beta";
import { Button, ConfirmDialog, cx, DialogActions, DialogTitle, Modal, spring, Switch } from "./ui";
import { VoicePicker } from "./VoicePicker";

const FIELD = "h-9 w-full rounded-lg border border-line bg-black px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted";
const LABEL = "mb-1.5 block text-[12px] font-medium text-muted";

/** Its picture, round; its first letter while there's none; a placeholder's blank, in a dashed ring. */
export function ChannelAvatar({ channel, size = 32 }: { channel: { title: string; avatar?: string | null; youtubeId?: string | null }; size?: number }) {
  if (channel.youtubeId === null)
    return (
      <span className="flex shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-line-strong text-faint/70" style={{ width: size, height: size }}>
        <User size={Math.round(size * 0.5)} strokeWidth={2} />
      </span>
    );
  if (channel.avatar) return <img src={channel.avatar} alt="" referrerPolicy="no-referrer" className="shrink-0 rounded-full bg-active object-cover" style={{ width: size, height: size }} />;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-active font-semibold text-muted" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {channel.title.charAt(0).toUpperCase()}
    </span>
  );
}

/** A group's picture: its first two channels' pictures overlapping, the first in front at the top left. */
export function GroupAvatar({ channels, size = 32 }: { channels: Channel[]; size?: number }) {
  const one = Math.round(size * 0.72);
  const [front, back] = channels;
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      {back && (
        <span className="absolute right-0 bottom-0 rounded-full">
          <ChannelAvatar channel={back} size={one} />
        </span>
      )}
      {front && (
        <span className="absolute top-0 left-0 rounded-full bg-bg ring-2 ring-bg">
          <ChannelAvatar channel={front} size={one} />
        </span>
      )}
    </span>
  );
}

/**
 * The channels to make something for, as pills (an idea's, a thumbnail's):
 * picking the one picked again takes it off, so none stays a choice. Nothing
 * shows without V2 or with no channels.
 */
export function useChannelChoice(open: boolean): Channel[] {
  const v2 = useBeta((beta) => beta.v2);
  const channels = useChannels((state) => state.channels);
  useEffect(() => {
    if (open && v2) void loadChannels();
  }, [open, v2]);
  return v2 ? (channels ?? []) : [];
}

export function ChannelPills({ channels, value, lane, onChange }: { channels: Channel[]; value: string | null; lane: Lane; onChange: (key: string | null) => void }) {
  const groups = useChannels((state) => state.groups);
  // A grouped channel's hint, on hover: what it's grouped with.
  const hint = (one: Channel) => {
    const group = groups.find((each) => each.key === one.group);
    const others = group === undefined ? [] : channelsOf(group, channels).filter((each) => each.key !== one.key);
    return others.length === 0 ? "" : ` · with ${others.map((each) => each.title).join(", ")}`;
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {channels.map((one) => (
        <button
          type="button"
          key={one.key}
          title={(one.lanes[lane] || one.title) + hint(one)}
          onClick={() => onChange(value === one.key ? null : one.key)}
          aria-pressed={value === one.key}
          // Picked, it's white (Sphe, Nov 14: "way more clear, maybe with a white background"), as the switches and Home's main button are.
          className={cx(
            "flex h-8 items-center gap-2 rounded-full border pr-3 pl-1 text-[12.5px] font-medium transition-[background-color,border-color,color] duration-150",
            value === one.key ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg",
            // A placeholder's border is dashed (Sphe, Nov 15).
            one.youtubeId === null && (value === one.key ? "border-dashed border-bg/40" : "border-dashed border-line-strong"),
          )}
        >
          <ChannelAvatar channel={one} size={22} />
          {one.title}
        </button>
      ))}
    </div>
  );
}

/** "@drinsanity · 1.2M subscribers"; a placeholder says it isn't on YouTube yet; one seen by its label alone says nothing. */
function facts(channel: { youtubeId?: string | null; handle?: string | null; subscribers?: number | null; videos?: number | null; masked?: boolean }): string {
  if (channel.masked === true) return "";
  if (channel.youtubeId === null) return "Placeholder · no YouTube channel yet";
  return [channel.handle ? `@${channel.handle}` : null, compact(channel.subscribers) ? `${compact(channel.subscribers)} subscribers` : null, compact(channel.videos) ? `${compact(channel.videos)} videos` : null].filter(Boolean).join(" · ");
}

/** The list's rows: a channel, or a group in place of its channels (where its first one stands). */
type Row = { channel: Channel } | { group: Group; channels: Channel[] };

function rowsOf(channels: Channel[], groups: Group[]): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    const group = groups.find((one) => one.key === channel.group);
    if (group === undefined) rows.push({ channel });
    else if (!seen.has(group.key)) {
      seen.add(group.key);
      rows.push({ group, channels: channelsOf(group, channels) });
    }
  }
  return rows;
}

/** Home's Channels: the list, a group's page, or one channel's page (back to its group when opened from it). */
export function ChannelsView({ adding, onAdding }: { adding: boolean; onAdding: (open: boolean) => void }) {
  const channels = useChannels((state) => state.channels);
  const groups = useChannels((state) => state.groups);
  const [open, setOpen] = useState<{ channel?: string; group?: string } | null>(null);
  useEffect(() => {
    void loadChannels();
  }, []);
  const shown = channels?.find((one) => one.key === open?.channel) ?? null;
  const group = groups.find((one) => one.key === open?.group) ?? null;
  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        {shown !== null ? (
          <motion.div key={shown.key} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={spring}>
            <ChannelPage channel={shown} back={group !== null ? groupTitle(group, channels ?? []) : "Channels"} onBack={() => setOpen(group !== null ? { group: group.key } : null)} onGroup={(key) => setOpen({ group: key })} />
          </motion.div>
        ) : group !== null ? (
          <motion.div key={group.key} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={spring}>
            <GroupPage group={group} onBack={() => setOpen(null)} onChannel={(key) => setOpen({ group: group.key, channel: key })} />
          </motion.div>
        ) : (
          <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="flex flex-col gap-0.5">
            {channels !== null && channels.length === 0 && (
              <div className="mx-auto mt-16 max-w-[320px] text-center">
                <h3 className="text-[15px] font-semibold">No channels yet</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">Paste a link to a YouTube channel, or name one that isn't on YouTube yet. Each channel keeps its own style for ideas, thumbnails, scripts and edits.</p>
              </div>
            )}
            {rowsOf(channels ?? [], groups).map((row) =>
              "group" in row ? (
                <button key={row.group.key} onClick={() => setOpen({ group: row.group.key })} className="flex h-14 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-hover">
                  <GroupAvatar channels={row.channels} size={34} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{groupTitle(row.group, channels ?? [])}</span>
                  {row.channels.some((one) => one.narration === null) && <span className="shrink-0 rounded-md bg-warning-soft px-1.5 py-0.5 text-[11px] font-semibold text-warning">Not set up</span>}
                </button>
              ) : (
                <button key={row.channel.key} onClick={() => setOpen({ channel: row.channel.key })} className="flex h-14 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-hover">
                  <ChannelAvatar channel={row.channel} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{row.channel.title}</span>
                    <span className="block truncate text-[12px] text-faint">{facts(row.channel)}</span>
                  </span>
                  {row.channel.narration === null && <span className="shrink-0 rounded-md bg-warning-soft px-1.5 py-0.5 text-[11px] font-semibold text-warning">Not set up</span>}
                </button>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <AddChannel open={adding} onClose={() => onAdding(false)} onAdded={(channel) => setOpen({ channel: channel.key })} />
    </>
  );
}

/** The voices, and who narrates for which niche or channel already (asked once it's needed). */
function useVoices(on: boolean): { voices: Voice[] | null; used: Used[] } {
  const [found, setFound] = useState<{ voices: Voice[] | null; used: Used[] }>({ voices: null, used: [] });
  useEffect(() => {
    if (!on || found.voices !== null) return;
    void channelApi.voices().then(setFound, () => setFound({ voices: [], used: [] }));
  }, [on, found.voices]);
  return found;
}

/** The YouTube channel a link is to, read as it's typed, a moment after the last key. */
function useFound(link: string, setError: (error: string | null) => void): { found: Found | null; looking: boolean } {
  const [found, setFound] = useState<Found | null>(null);
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    const given = link.trim();
    setFound(null);
    setError(null);
    if (given.length < 3) return;
    let stale = false;
    const timer = setTimeout(() => {
      setLooking(true);
      channelApi
        .resolve(given)
        .then((channel) => !stale && setFound(channel))
        .catch((cause: unknown) => !stale && setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => !stale && setLooking(false));
    }, 450);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [link, setError]);
  return { found, looking };
}

/** What YouTube says of a pasted link's channel, before it's added or linked. */
function FoundCard({ found, looking }: { found: Found | null; looking: boolean }) {
  return (
    <AnimatePresence initial={false} mode="wait">
      {found !== null ? (
        <motion.div key="found" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring} className="flex items-center gap-3 rounded-lg border border-line bg-black/40 p-3">
          <ChannelAvatar channel={found} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium">{found.title}</span>
            <span className="block truncate text-[12px] text-faint">{facts(found)}</span>
          </span>
        </motion.div>
      ) : looking ? (
        <motion.p key="looking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[12px] text-faint">
          Looking it up…
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * A channel added: a link pasted (read as it's typed, so the right channel is
 * seen before it's added), or a placeholder's name when it isn't on YouTube
 * yet; then set up: who narrates its videos and whether it's a compilation
 * channel. Its styles start empty, taught as it's worked on.
 */
function AddChannel({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (channel: Channel) => void }) {
  const [link, setLink] = useState("");
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { found, looking } = useFound(link, setError);
  const [added, setAdded] = useState<Channel | null>(null);
  const [narration, setNarration] = useState<Narration | null>(null);
  const [compilation, setCompilation] = useState(false);
  const [busy, setBusy] = useState(false);
  const voices = useVoices(open && added !== null);

  useEffect(() => {
    if (!open) return;
    setLink("");
    setPlaceholder(null);
    setError(null);
    setAdded(null);
    setNarration(null);
    setCompilation(false);
  }, [open]);

  const ready = placeholder !== null ? placeholder.trim() !== "" : found !== null;
  const add = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const channel = placeholder !== null ? await channelApi.addPlaceholder(placeholder.trim()) : await channelApi.add(link.trim());
      setAdded(channel);
      setNarration(channel.narration);
      setCompilation(channel.compilation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    if (added === null || narration === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const channel = await channelApi.set(added.key, { narration, compilation });
      onAdded(channel);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={460}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void (added === null ? add() : finish());
        }}
      >
        {added === null && placeholder !== null ? (
          <>
            <div className="flex items-center gap-3">
              <ChannelAvatar channel={{ title: placeholder, youtubeId: null }} size={40} />
              <DialogTitle title="Add a placeholder" />
            </div>
            <input autoFocus value={placeholder} onChange={(event) => setPlaceholder(event.target.value)} placeholder="Its name, like GTA 6 channel" maxLength={200} className={FIELD} />
            <p className="-mt-1 text-[12px] text-faint">Link it to the real channel once it's made. Everything it's been taught stays.</p>
          </>
        ) : added === null ? (
          <>
            <DialogTitle title="Add a channel" />
            <input autoFocus value={link} onChange={(event) => setLink(event.target.value)} placeholder="youtube.com/@channel, a video of theirs, or the channel ID" className={FIELD} />
            <FoundCard found={found} looking={looking} />
            {found === null && !looking && (
              <button type="button" onClick={() => {
                  setError(null);
                  setPlaceholder("");
                }} className="-mt-1 self-start text-[12px] text-faint transition-colors hover:text-fg">
                No YouTube channel yet? Add a placeholder
              </button>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <ChannelAvatar channel={added} size={40} />
              <DialogTitle title={`Set up ${added.title}`} />
            </div>
            <div>
              <span className={LABEL}>Who narrates</span>
              <VoicePicker value={narration} voices={voices.voices} used={voices.used} channel={added.key} onChange={setNarration} />
            </div>
            <label className="flex items-center justify-between gap-3">
              <span>
                <span className="block text-[13px] font-medium">Compilation channel</span>
                <span className="block text-[12px] text-faint">Several cases in each video. A project can still be one.</span>
              </span>
              <Switch checked={compilation} onChange={setCompilation} />
            </label>
          </>
        )}
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <DialogActions className="mt-1">
          <Button type="button" variant="subtle" onClick={added === null && placeholder !== null ? () => setPlaceholder(null) : onClose}>
            {added !== null ? "Later" : placeholder !== null ? "Back" : "Cancel"}
          </Button>
          {added === null ? (
            <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
              Add
            </Button>
          ) : (
            <Button type="submit" variant="primary" busy={busy} disabled={narration === null}>
              Done
            </Button>
          )}
        </DialogActions>
      </form>
    </Modal>
  );
}

/**
 * A channel's page: who it is on YouTube, how its videos are made, and its
 * lanes, each with its own style (a teacher writes the description; what its
 * agent is taught builds up as the team works with it). A grouped channel's
 * lanes show the group's teaching, then what's its alone.
 */
function ChannelPage({ channel, back, onBack, onGroup }: { channel: Channel; back: string; onBack: () => void; onGroup: (key: string) => void }) {
  const teacher = useChannels((state) => state.teacher);
  const channels = useChannels((state) => state.channels) ?? [];
  const groups = useChannels((state) => state.groups);
  const group = groups.find((one) => one.key === channel.group) ?? null;
  const [linking, setLinking] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [page, setPage] = useState<Awaited<ReturnType<typeof channelApi.page>> | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    void channelApi.page(channel.key).then((found) => alive && setPage(found), () => alive && setPage(null));
    return () => {
      alive = false;
    };
  }, [channel.key, channel.group, round]);
  const change = (what: string, given: Parameters<typeof channelApi.set>[1]) =>
    void channelApi.set(channel.key, given).catch((error: unknown) => useEditor.getState().toastError(error, `change ${channel.title}'s ${what}`));
  const others = group === null ? [] : channelsOf(group, channels).filter((one) => one.key !== channel.key);
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 pb-10">
      <div className="flex items-center gap-1">
        <button onClick={onBack} className="-ml-2 flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg">
          <ArrowLeft size={14} className="shrink-0" /> <span className="truncate">{back}</span>
        </button>
      </div>
      <div className="flex items-center gap-4">
        <ChannelAvatar channel={channel} size={64} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[20px] font-semibold tracking-[-0.3px]">{channel.title}</h2>
          <p className="truncate text-[13px] text-muted">{facts(channel)}</p>
          {group !== null && others.length > 0 && (
            <button onClick={() => onGroup(group.key)} className="mt-0.5 flex max-w-full items-center gap-1 truncate text-[12px] text-faint transition-colors hover:text-fg">
              <Layers size={12} className="shrink-0" /> <span className="truncate">With {others.map((one) => one.title).join(", ")}</span>
            </button>
          )}
        </div>
        {teacher && group === null && channel.masked !== true && (
          <Button variant="subtle" onClick={() => setGrouping(true)} title="Share one style with other channels">
            <Layers size={14} /> Group
          </Button>
        )}
        {channel.masked === true ? null : channel.youtubeId === null ? (
          teacher &&
          !linking && (
            <Button variant="subtle" onClick={() => setLinking(true)}>
              <Link2 size={14} /> Link a YouTube channel
            </Button>
          )
        ) : (
          <a
            href={`https://www.youtube.com/channel/${channel.youtubeId}`}
            target="_blank"
            rel="noreferrer"
            title="Open on YouTube"
            className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <ExternalLink size={15} />
          </a>
        )}
      </div>
      {/* What someone given only its label sees for its name (accounts.spheceo.com), set by a teacher. */}
      {teacher && channel.masked !== true && (
        <LabelField value={channel.label ?? ""} onSave={(text) => change("label", { label: text })} />
      )}
      <AnimatePresence initial={false}>
        {linking && channel.youtubeId === null && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring} className="-mt-2 overflow-hidden">
            <LinkChannel channel={channel} onDone={() => setLinking(false)} />
          </motion.div>
        )}
      </AnimatePresence>
      <ChannelSettings channel={channel} />
      <div className="flex flex-col gap-2">
        {LANES.map((lane) => (
          <div key={lane.key} className="rounded-xl border border-line p-4">
            <div className="mb-1 text-[13px] font-semibold">{lane.label}</div>
            {page?.group ? (
              <>
                {page.group.lanes[lane.key] && <p className="text-[13px] leading-relaxed text-secondary">{page.group.lanes[lane.key]}</p>}
                <TaughtList items={page.group.taught[lane.key]} lane={lane.key} />
                <OwnTeaching
                  channel={channel}
                  lane={lane.key}
                  items={page.taught[lane.key]}
                  group={page.group.key}
                  onMoved={() => setRound((n) => n + 1)}
                  onSave={(text) => change(`${lane.label.toLowerCase()} style`, { lanes: { [lane.key]: text } })}
                />
              </>
            ) : (
              <>
                <InPlace
                  value={channel.lanes[lane.key]}
                  editable={teacher}
                  placeholder={teacher ? "Its style, in a line or two" : "No style written yet"}
                  onSave={(text) => change(`${lane.label.toLowerCase()} style`, { lanes: { [lane.key]: text } })}
                  className="text-[13px] leading-relaxed text-secondary"
                />
                {page !== null && <TaughtList items={page.taught[lane.key]} lane={lane.key} />}
              </>
            )}
          </div>
        ))}
      </div>
      <MakeGroup open={grouping} channel={channel} onClose={() => setGrouping(false)} onMade={(key) => onGroup(key)} />
    </div>
  );
}

/** How a channel's videos are made: who narrates, and whether it's a compilation channel (a teacher's to change). */
function ChannelSettings({ channel, compact: small = false }: { channel: Channel; compact?: boolean }) {
  const teacher = useChannels((state) => state.teacher);
  const voices = useVoices(teacher);
  const change = (what: string, given: Parameters<typeof channelApi.set>[1]) =>
    void channelApi.set(channel.key, given).catch((error: unknown) => useEditor.getState().toastError(error, `change ${channel.title}'s ${what}`));
  return (
    <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
      <div className={cx("rounded-xl border border-line bg-black/30", small ? "p-2.5" : "p-3")}>
        <span className={LABEL}>
          <Mic size={12} className="mr-1 inline -translate-y-px" />
          Who narrates
        </span>
        {teacher ? <VoicePicker value={channel.narration} voices={voices.voices} used={voices.used} channel={channel.key} onChange={(narration) => change("narration", { narration })} /> : <p className="text-[13px]">{narrationLabel(channel.narration) ?? "Not set up"}</p>}
      </div>
      <div className={cx("flex items-center justify-between gap-3 rounded-xl border border-line bg-black/30", small ? "p-2.5" : "p-3")}>
        <span>
          <span className="block text-[13px] font-medium">Compilation channel</span>
          <span className="block text-[12px] text-faint">Several cases in each video</span>
        </span>
        {teacher ? <Switch checked={channel.compilation} onChange={(compilation) => change("compilation", { compilation })} /> : <span className="text-[13px] text-muted">{channel.compilation ? "Yes" : "No"}</span>}
      </div>
    </div>
  );
}

/** What a lane has been taught, a line each; `action` beside each (a teacher's Move into the group). */
function TaughtList({ items, lane, action }: { items: Taught[]; lane: Lane; action?: (item: Taught) => ReactNode }) {
  return (
    <div className="mt-2.5 border-t border-line pt-2.5">
      {items.length === 0 ? (
        <p className="text-[12px] text-faint">Nothing taught yet</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((one) => (
            <li key={one.key} className="group/taught flex min-w-0 items-baseline gap-2 text-[12.5px]">
              <span className="shrink-0 text-faint">{one.kind === "template" && lane === "thumbnails" ? "Graphic" : TAUGHT_WORD[one.kind]}</span>
              <span className="shrink-0 font-medium">{one.name}</span>
              {one.note && <span className="min-w-0 flex-1 truncate text-muted">{one.note}</span>}
              {action?.(one)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A grouped channel's own in one lane, "Only this channel": its own
 * description and what it was taught alone, each of which a teacher can
 * move into the group (shared from then on).
 */
function OwnTeaching({ channel, lane, items, group, onMoved, onSave }: { channel: Channel; lane: Lane; items: Taught[]; group: string; onMoved: () => void; onSave?: (text: string) => void }) {
  const teacher = useChannels((state) => state.teacher);
  const [moving, setMoving] = useState<string | null>(null);
  if (items.length === 0 && channel.lanes[lane] === "" && !(teacher && onSave)) return null;
  const move = (item: Taught) => {
    setMoving(item.key);
    void groupApi
      .move(group, item.key)
      .then(onMoved, (error: unknown) => useEditor.getState().toastError(error, `move ${item.name} into the group`))
      .finally(() => setMoving(null));
  };
  return (
    <div className="mt-3">
      <div className="text-[11.5px] font-medium text-faint">Only this channel</div>
      {onSave ? (
        <InPlace value={channel.lanes[lane]} editable={teacher} placeholder={teacher ? "Where it differs, in a line or two" : ""} onSave={onSave} className="mt-0.5 text-[13px] leading-relaxed text-secondary" />
      ) : (
        channel.lanes[lane] && <p className="mt-0.5 text-[13px] leading-relaxed text-secondary">{channel.lanes[lane]}</p>
      )}
      {items.length > 0 && (
        <TaughtList
          items={items}
          lane={lane}
          action={
            teacher
              ? (item) => (
                  <button
                    onClick={() => move(item)}
                    disabled={moving !== null}
                    title="Move into the group"
                    className="flex size-5 shrink-0 items-center justify-center self-center rounded text-faint opacity-0 transition-opacity group-hover/taught:opacity-100 hover:text-fg focus-visible:opacity-100 disabled:opacity-40"
                  >
                    <ArrowUpToLine size={12} />
                  </button>
                )
              : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * A group's page: its channels stacked and named together, the lanes they
 * share (description and teaching), then each channel with its own settings
 * and what it was taught alone. A teacher adds a channel, takes one out (it
 * keeps a copy of the group's teaching) or ungroups them all.
 */
function GroupPage({ group, onBack, onChannel }: { group: Group; onBack: () => void; onChannel: (key: string) => void }) {
  const teacher = useChannels((state) => state.teacher);
  const channels = useChannels((state) => state.channels) ?? [];
  const members = channelsOf(group, channels);
  const [taught, setTaught] = useState<Record<Lane, Taught[]> | null>(null);
  const [own, setOwn] = useState<Record<string, Record<Lane, Taught[]>>>({});
  const [round, setRound] = useState(0);
  const [adding, setAdding] = useState(false);
  const [ungrouping, setUngrouping] = useState(false);
  const [busy, setBusy] = useState(false);
  const keys = group.channels.join(" ");
  useEffect(() => {
    let alive = true;
    void groupApi.page(group.key).then((page) => alive && setTaught(page.taught), () => alive && setTaught(null));
    for (const key of keys.split(" ")) void channelApi.page(key).then((page) => alive && setOwn((now) => ({ ...now, [key]: page.taught })), () => undefined);
    return () => {
      alive = false;
    };
  }, [group.key, keys, round]);
  const failed = (what: string) => (error: unknown) => useEditor.getState().toastError(error, what);
  const ungroup = () => {
    setBusy(true);
    void groupApi
      .ungroup(group.key)
      .then(onBack, failed("ungroup these channels"))
      .finally(() => {
        setBusy(false);
        setUngrouping(false);
      });
  };
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 pb-10">
      <div className="flex items-center gap-1">
        <button onClick={onBack} className="-ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg">
          <ArrowLeft size={14} /> Channels
        </button>
      </div>
      <div className="flex items-center gap-4">
        <GroupAvatar channels={members} size={64} />
        <h2 className="min-w-0 flex-1 truncate text-[20px] font-semibold tracking-[-0.3px]">{groupTitle(group, channels)}</h2>
        {teacher && (
          <>
            <Button variant="subtle" onClick={() => setAdding(true)}>
              <Plus size={14} /> Add a channel
            </Button>
            <Button variant="subtle" onClick={() => setUngrouping(true)}>
              Ungroup
            </Button>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {LANES.map((lane) => (
          <div key={lane.key} className="rounded-xl border border-line p-4">
            <div className="mb-1 text-[13px] font-semibold">{lane.label}</div>
            <InPlace
              value={group.lanes[lane.key]}
              editable={teacher}
              placeholder={teacher ? "Their style, in a line or two" : "No style written yet"}
              onSave={(text) => void groupApi.set(group.key, { [lane.key]: text }).catch(failed(`change the ${lane.label.toLowerCase()} style`))}
              className="text-[13px] leading-relaxed text-secondary"
            />
            {taught !== null && <TaughtList items={taught[lane.key]} lane={lane.key} />}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {members.map((channel) => (
          <div key={channel.key} className="flex flex-col gap-3 rounded-xl border border-line p-4">
            <div className="flex items-center gap-3">
              <button onClick={() => onChannel(channel.key)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <ChannelAvatar channel={channel} size={34} />
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium hover:underline">{channel.title}</span>
                  <span className="block truncate text-[12px] text-faint">{facts(channel)}</span>
                </span>
              </button>
              {teacher && (
                <Button variant="subtle" size="sm" onClick={() => void groupApi.takeOut(group.key, channel.key).then(() => (members.length <= 1 ? onBack() : setRound((n) => n + 1)), failed(`take ${channel.title} out`))}>
                  Take out
                </Button>
              )}
            </div>
            <ChannelSettings channel={channel} compact />
            {own[channel.key] !== undefined &&
              LANES.filter((lane) => own[channel.key]![lane.key].length > 0 || channel.lanes[lane.key] !== "").map((lane) => (
                <div key={lane.key}>
                  <div className="text-[12px] font-semibold">{lane.label}</div>
                  <OwnTeaching channel={channel} lane={lane.key} items={own[channel.key]![lane.key]} group={group.key} onMoved={() => setRound((n) => n + 1)} />
                </div>
              ))}
          </div>
        ))}
      </div>
      <AddToGroup open={adding} group={group} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={ungrouping}
        onClose={() => setUngrouping(false)}
        onConfirm={ungroup}
        busy={busy}
        tone="light"
        title="Ungroup these channels?"
        detail="Each keeps a copy of the shared style as its own."
        confirm="Ungroup"
      />
    </div>
  );
}

/** Channels as pills to pick several of (`picked`), one tap each. */
function PickPills({ channels, picked, onToggle }: { channels: Channel[]; picked: string[]; onToggle: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {channels.map((one) => (
        <button
          type="button"
          key={one.key}
          onClick={() => onToggle(one.key)}
          aria-pressed={picked.includes(one.key)}
          className={cx(
            "flex h-8 items-center gap-2 rounded-full border pr-3 pl-1 text-[12.5px] font-medium transition-[background-color,border-color,color] duration-150",
            picked.includes(one.key) ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg",
            one.youtubeId === null && (picked.includes(one.key) ? "border-dashed border-bg/40" : "border-dashed border-line-strong"),
          )}
        >
          <ChannelAvatar channel={one} size={22} />
          {one.title}
        </button>
      ))}
    </div>
  );
}

/** Channels in no group, but `but`. */
function useUngrouped(but: string | null): Channel[] {
  const channels = useChannels((state) => state.channels) ?? [];
  return channels.filter((one) => !one.group && one.key !== but && one.masked !== true);
}

/**
 * A group made from a channel's page: the channels to group it with, and
 * whose style they start from (its teaching moves into the group; the
 * others keep theirs as their own exceptions).
 */
function MakeGroup({ open, channel, onClose, onMade }: { open: boolean; channel: Channel; onClose: () => void; onMade: (key: string) => void }) {
  const others = useUngrouped(channel.key);
  const channels = useChannels((state) => state.channels) ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const [from, setFrom] = useState(channel.key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setPicked([]);
    setFrom(channel.key);
    setError(null);
  }, [open, channel.key]);
  const members = [channel.key, ...picked];
  const make = async () => {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const group = await groupApi.make(members, members.includes(from) ? from : channel.key);
      onClose();
      onMade(group.key);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} width={460}>
      <div className="flex flex-col gap-4 p-6">
        <DialogTitle title={`Group ${channel.title} with`} />
        {others.length === 0 ? <p className="text-[13px] text-muted">Every other channel is in a group already.</p> : <PickPills channels={others} picked={picked} onToggle={(key) => setPicked((now) => (now.includes(key) ? now.filter((one) => one !== key) : [...now, key]))} />}
        {picked.length > 0 && (
          <div>
            <span className={LABEL}>Start from the style of</span>
            <ChannelPills channels={channels.filter((one) => members.includes(one.key))} value={from} lane="edit" onChange={(key) => key !== null && setFrom(key)} />
          </div>
        )}
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <DialogActions className="mt-1">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={picked.length === 0} onClick={() => void make()}>
            Group
          </Button>
        </DialogActions>
      </div>
    </Modal>
  );
}

/** A channel added to a group: it shares the group's style, what it was taught kept as its own. */
function AddToGroup({ open, group, onClose }: { open: boolean; group: Group; onClose: () => void }) {
  const others = useUngrouped(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setError(null);
  }, [open]);
  const add = async () => {
    if (picked === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await groupApi.add(group.key, picked);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} width={460}>
      <div className="flex flex-col gap-4 p-6">
        <DialogTitle title="Add a channel" />
        {others.length === 0 ? <p className="text-[13px] text-muted">Every channel is in a group already.</p> : <ChannelPills channels={others} value={picked} lane="edit" onChange={setPicked} />}
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <DialogActions className="mt-1">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={picked === null} onClick={() => void add()}>
            Add
          </Button>
        </DialogActions>
      </div>
    </Modal>
  );
}

/** A placeholder linked to its YouTube channel, once it's made: a link pasted, the channel seen, then Link. Its key stays, so all it's been taught does. */
function LinkChannel({ channel, onDone }: { channel: Channel; onDone: () => void }) {
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { found, looking } = useFound(link, setError);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (found === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await channelApi.link(channel.key, link.trim());
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input autoFocus value={link} onChange={(event) => setLink(event.target.value)} onKeyDown={(event) => event.key === "Escape" && onDone()} placeholder="youtube.com/@channel, a video of theirs, or the channel ID" className={FIELD} />
      <FoundCard found={found} looking={looking} />
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="subtle" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={busy} disabled={found === null}>
          Link
        </Button>
      </div>
    </form>
  );
}

/**
 * A channel's label (Sphe, Nov 15: the input was too big): a small field as wide as its words, beside a plain
 * "Label", the why on hover. Saved on Enter or leaving it, put back on Escape.
 */
function LabelField({ value, onSave }: { value: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const done = () => {
    if (text.trim() !== value.trim()) onSave(text.trim());
  };
  return (
    <label className="-mt-2 flex items-center gap-2 self-start" title="What someone given only the label sees instead of the channel">
      <span className="text-[12px] font-medium text-muted">Label</span>
      <input
        value={text}
        placeholder="Channel 1"
        maxLength={60}
        onChange={(event) => setText(event.target.value)}
        onBlur={done}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setText(value);
            event.currentTarget.blur();
          }
        }}
        className="h-7 min-w-[9ch] max-w-[28ch] rounded-md border border-line bg-active px-2 text-[12.5px] font-medium text-fg outline-none transition-colors [field-sizing:content] placeholder:text-faint hover:border-line-strong focus:border-muted"
      />
    </label>
  );
}

const TAUGHT_WORD: Record<Taught["kind"], string> = { skill: "Lesson", template: "Effect", sound: "Sound" };

/** Home's header button on Channels: a teacher's. */
export function AddChannelButton({ onClick }: { onClick: () => void }) {
  const teacher = useChannels((state) => state.teacher);
  if (!teacher) return null;
  return (
    <Button variant="light" onClick={onClick}>
      <Plus size={15} strokeWidth={2.2} /> Add channel
    </Button>
  );
}

/** Text a teacher changes where it stands (a lane's style): saved on Enter or leaving it, put back on Escape. */
function InPlace({ value, onSave, editable, placeholder, className }: { value: string; onSave: (text: string) => void; editable: boolean; placeholder: string; className: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const shape = "-mx-1.5 block w-[calc(100%+12px)] rounded-md border border-transparent px-1.5";
  if (!editable) return <div className={cx(className, shape)}>{value || <span className="text-faint">{placeholder}</span>}</div>;
  const done = () => {
    const given = text.trim();
    if (given === value.trim()) return;
    onSave(given);
  };
  return (
    // A line that wraps to show all of itself; Enter ends it.
    <textarea
      rows={1}
      value={text}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value.replace(/\n/g, " "))}
      onBlur={done}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.currentTarget.blur();
      }}
      className={cx(className, shape, "resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-faint hover:border-line focus:border-line-strong")}
    />
  );
}
