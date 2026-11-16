// Channels' pieces (Nov 14; Sphe: "a dedicated section where we load in
// channels"): a channel's picture and a group's, the channel picker of the New
// dialogs, and the dialogs that add a channel, link a placeholder and group
// them. Home's Channels (the table, a group's page and a channel's) is
// ChannelsHome.tsx. A placeholder (Sphe, Nov 15) is a channel by its name
// before it's on YouTube: a blank picture, a dashed border where it's picked,
// and Link on its page once the real channel is made (its teaching kept). A
// group (Sphe, Nov 15) is channels sharing one style: their names together,
// their pictures stacked; work still belongs to one channel.

import { ChevronLeft, ChevronRight, User } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { channelApi, channelsOf, compact, groupApi, groupTitle, loadChannels, rowsOf, useChannels, type Channel, type Found, type Group, type Lane, type Narration, type Taught, type Used, type Voice } from "../lib/channels";
import { useAccount } from "../lib/account";
import { useBeta } from "../lib/beta";
import { ProblemView } from "./ProblemView";
import { Button, cx, DialogActions, DialogTitle, Modal, spring, Switch } from "./ui";
import { VoicePicker } from "./VoicePicker";

export const FIELD = "h-9 w-full rounded-lg border border-line bg-black px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted";
export const LABEL = "mb-1.5 block text-[12px] font-medium text-muted";

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

/**
 * A group's picture: its first two channels' pictures, the first in front at
 * the top left, the second down and to the right behind it. `size` is each
 * picture's; `ring` the colour around the front one (what it stands on).
 */
export function GroupAvatar({ channels, size = 26, ring = "ring-2 ring-panel" }: { channels: Channel[]; size?: number; ring?: string }) {
  const step = Math.round(size * 0.42);
  const drop = Math.round(step * 0.6);
  const [front, back] = channels;
  return (
    <span className="relative shrink-0" style={{ width: size + (back ? step : 0), height: size + (back ? drop : 0) }}>
      {back && (
        <span className="absolute rounded-full" style={{ left: step, top: drop }}>
          <ChannelAvatar channel={back} size={size} />
        </span>
      )}
      {front && (
        <span className={cx("absolute top-0 left-0 rounded-full bg-panel", ring)}>
          <ChannelAvatar channel={front} size={size} />
        </span>
      )}
    </span>
  );
}

/**
 * Why the channels aren't here: they couldn't be read (Try again reads them
 * again), or, signed out, a sign-in. Never "No channels yet" for either.
 */
export function ChannelsFailed({ className }: { className?: string }) {
  const failed = useChannels((state) => state.failed);
  const signedOut = useAccount((state) => state.account !== null && state.account.person === null && !state.account.signed_in);
  if (failed === null) return null;
  return <ProblemView error={signedOut ? "Sign in to Edit" : failed} doing="load the channels" onReload={() => void loadChannels()} className={className} />;
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

/**
 * The channel a piece of work is for, in a New dialog (Sphe, Nov 15): each
 * group first as one choice ("A & B", its pictures stacked, a chevron), then
 * the channels in none. A group opens to its channels, one of which is
 * picked: work belongs to one channel, never to a group. Picked, it's white;
 * picking it again takes it off. One group alone is open from the start.
 */
export function ChannelPicker({ channels, value, lane, onChange }: { channels: Channel[]; value: string | null; lane: Lane; onChange: (key: string | null) => void }) {
  const groups = useChannels((state) => state.groups);
  const rows = rowsOf(channels, groups);
  const holding = (key: string | null) => rows.find((row) => row.kind === "group" && row.members.some((one) => one.key === key))?.key ?? null;
  const [opened, setOpened] = useState<string | null>(() => holding(value));
  // A channel picked from elsewhere (a script's) shows where it is.
  useEffect(() => {
    const at = holding(value);
    if (at !== null) setOpened(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const alone = rows.length === 1 && rows[0]!.kind === "group" ? rows[0]! : null;
  const shown = alone ?? rows.find((row) => row.kind === "group" && row.key === opened) ?? null;
  // Keyboard focus follows the step: into the group's channels, and back onto the group it came from.
  const box = useRef<HTMLDivElement>(null);
  const focusOn = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusOn.current === null) return;
    box.current?.querySelector<HTMLElement>(focusOn.current)?.focus();
    focusOn.current = null;
  }, [shown?.key]);
  const option = (picked: boolean, placeholder: boolean) =>
    cx(
      "flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 text-left text-[13px] font-medium outline-none transition-[background-color,border-color,color] duration-150 focus-visible:border-muted",
      picked ? "border-fg bg-fg text-bg" : "border-line text-secondary hover:border-line-strong hover:bg-hover hover:text-fg",
      placeholder && (picked ? "border-dashed border-bg/40" : "border-dashed border-line-strong"),
    );
  const pick = (one: Channel) => onChange(value === one.key ? null : one.key);
  return (
    <div ref={box}>
      {shown !== null && shown.kind === "group" ? (
        <motion.div key={shown.key} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
          {alone === null && (
            <button
              type="button"
              data-back
              onClick={() => {
                focusOn.current = `[data-group="${shown.key}"]`;
                setOpened(null);
              }}
              className="-ml-1 mb-1.5 flex max-w-full items-center gap-0.5 rounded-md px-1 py-0.5 text-[12.5px] text-muted outline-none transition-colors hover:text-fg focus-visible:text-fg"
            >
              <ChevronLeft size={14} className="shrink-0" />
              <span className="truncate">{groupTitle(shown.group, channels)}</span>
            </button>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            {shown.members.map((one) => (
              <button type="button" key={one.key} data-option onClick={() => pick(one)} aria-pressed={value === one.key} title={one.lanes[lane] || one.title} className={cx(option(value === one.key, one.youtubeId === null), "h-12")}>
                <ChannelAvatar channel={one} size={28} />
                <span className="min-w-0">
                  <span className="block truncate">{one.title}</span>
                  <span className={cx("block truncate text-[11.5px] font-normal", value === one.key ? "text-bg/60" : "text-faint")}>{one.compilation ? "Compilation" : "One case each"}</span>
                </span>
              </button>
            ))}
          </div>
        </motion.div>
      ) : (
        <motion.div key="all" initial={false} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 gap-1.5">
          {rows.map((row) =>
            row.kind === "group" ? (
              <button
                type="button"
                key={row.key}
                data-group={row.key}
                onClick={() => {
                  focusOn.current = "[data-option]";
                  setOpened(row.key);
                }}
                title={row.members.map((one) => one.title).join(" & ")}
                className={cx(option(false, false), "h-11")}
              >
                <GroupAvatar channels={row.members} size={22} />
                <span className="min-w-0 flex-1 truncate">{groupTitle(row.group, channels)}</span>
                <ChevronRight size={14} className="shrink-0 text-faint" />
              </button>
            ) : (
              <button type="button" key={row.key} data-option onClick={() => pick(row.channel)} aria-pressed={value === row.key} title={row.channel.lanes[lane] || row.channel.title} className={cx(option(value === row.key, row.channel.youtubeId === null), "h-11")}>
                <ChannelAvatar channel={row.channel} size={22} />
                <span className="min-w-0 truncate">{row.channel.title}</span>
              </button>
            ),
          )}
        </motion.div>
      )}
    </div>
  );
}

/** "@drinsanity · 1.2M subscribers"; a placeholder says it isn't on YouTube yet; one seen by its label alone says nothing. */
export function facts(channel: { youtubeId?: string | null; handle?: string | null; subscribers?: number | null; videos?: number | null; masked?: boolean }): string {
  if (channel.masked === true) return "";
  if (channel.youtubeId === null) return "Placeholder · no YouTube channel yet";
  return [channel.handle ? `@${channel.handle}` : null, compact(channel.subscribers) ? `${compact(channel.subscribers)} subscribers` : null, compact(channel.videos) ? `${compact(channel.videos)} videos` : null].filter(Boolean).join(" · ");
}

/** The voices, and who narrates for which niche or channel already: asked once it's needed, shared by every picker on screen for half a minute. */
let voicesAsked: { at: number; answer: Promise<{ voices: Voice[]; used: Used[] }> } | null = null;

export function useVoices(on: boolean): { voices: Voice[] | null; used: Used[] } {
  const [found, setFound] = useState<{ voices: Voice[] | null; used: Used[] }>({ voices: null, used: [] });
  useEffect(() => {
    if (!on || found.voices !== null) return;
    if (voicesAsked === null || Date.now() - voicesAsked.at > 30_000) voicesAsked = { at: Date.now(), answer: channelApi.voices() };
    let alive = true;
    voicesAsked.answer.then(
      (answer) => alive && setFound(answer),
      () => {
        voicesAsked = null;
        if (alive) setFound({ voices: [], used: [] });
      },
    );
    return () => {
      alive = false;
    };
  }, [on, found.voices]);
  return found;
}

/** The YouTube channel a link is to, read as it's typed, a moment after the last key. */
export function useFound(link: string, setError: (error: string | null) => void): { found: Found | null; looking: boolean } {
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
export function FoundCard({ found, looking }: { found: Found | null; looking: boolean }) {
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

/** A link, a handle or a channel id, rather than a name. */
const LINK_LIKE = /youtu|https?:|^@|^UC[\w-]{22}$/i;

/** One way to add what was typed: the YouTube channel found, or a placeholder of that name; picked, it's white. */
function AddChoice({ picked, onPick, avatar, title, sub }: { picked: boolean; onPick: () => void; avatar: ReactNode; title: string; sub: string }) {
  return (
    <motion.button
      type="button"
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      onClick={onPick}
      aria-pressed={picked}
      className={cx("flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors", picked ? "border-fg bg-fg text-bg" : "border-line bg-black/40 hover:border-line-strong")}
    >
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{title}</span>
        <span className={cx("block truncate text-[12px]", picked ? "text-bg/60" : "text-faint")}>{sub}</span>
      </span>
    </motion.button>
  );
}

/**
 * A channel added: a link pasted, or a name typed. A link finds its channel;
 * a name offers both what YouTube finds by it and a placeholder of that name
 * (a channel not on YouTube yet), one picked (Sphe, Nov 15: the placeholder
 * hid behind a line of text). Then set up: who narrates and whether it's a
 * compilation channel. Its styles start empty, taught as it's worked on.
 */
export function AddChannel({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (channel: Channel) => void }) {
  const [link, setLink] = useState("");
  const [choice, setChoice] = useState<"youtube" | "placeholder" | null>(null);
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
    setChoice(null);
    setError(null);
    setAdded(null);
    setNarration(null);
    setCompilation(false);
  }, [open]);

  const typed = link.trim();
  const linkLike = LINK_LIKE.test(typed);
  // A name can be a placeholder; a link is a YouTube channel. Alone, the one way there is is picked.
  const canPlaceholder = typed.length >= 2 && !linkLike;
  const picked = linkLike ? (found !== null ? "youtube" : null) : choice ?? (canPlaceholder && found === null && !looking ? "placeholder" : null);
  const ready = picked === "placeholder" ? canPlaceholder : picked === "youtube" && found !== null;
  const add = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const channel = picked === "placeholder" ? await channelApi.addPlaceholder(typed) : await channelApi.add(typed);
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
        {added === null ? (
          <>
            <DialogTitle title="Add a channel" />
            <input
              autoFocus
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setChoice(null);
              }}
              placeholder="Paste a YouTube link, or type a name"
              maxLength={200}
              className={FIELD}
            />
            {(found !== null || canPlaceholder) && (
              <div className="flex flex-col gap-2">
                {found !== null && (
                  <AddChoice picked={picked === "youtube"} onPick={() => setChoice("youtube")} avatar={<ChannelAvatar channel={found} size={40} />} title={found.title} sub={facts(found)} />
                )}
                {canPlaceholder && (
                  <AddChoice
                    picked={picked === "placeholder"}
                    onPick={() => setChoice("placeholder")}
                    avatar={<ChannelAvatar channel={{ title: typed, youtubeId: null }} size={40} />}
                    title={typed}
                    sub="Placeholder: not on YouTube yet, linked once it is"
                  />
                )}
              </div>
            )}
            {looking && found === null && <p className="text-[12px] text-faint">Looking it up…</p>}
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
        {error && <ProblemView error={error} doing="add the channel" />}
        <DialogActions className="mt-1">
          <Button type="button" variant="subtle" onClick={onClose}>
            {added !== null ? "Later" : "Cancel"}
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
export function MakeGroup({ open, channel, onClose, onMade }: { open: boolean; channel: Channel; onClose: () => void; onMade: (key: string) => void }) {
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
        {error && <ProblemView error={error} doing="group them" />}
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
export function AddToGroup({ open, group, onClose }: { open: boolean; group: Group; onClose: () => void }) {
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
        {error && <ProblemView error={error} doing="add it to the group" />}
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
export function LinkChannel({ channel, onDone }: { channel: Channel; onDone: () => void }) {
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
      {error && <ProblemView error={error} doing="link it" />}
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
export function LabelField({ value, onSave }: { value: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const done = () => {
    if (text.trim() !== value.trim()) onSave(text.trim());
  };
  return (
    <label className="flex items-center gap-2 self-start" title="What someone given only the label sees instead of the channel">
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

export const TAUGHT_WORD: Record<Taught["kind"], string> = { skill: "Lesson", template: "Effect", sound: "Sound" };

/** Text a teacher changes where it stands (a lane's style): saved on Enter or leaving it, put back on Escape. */
export function InPlace({ value, onSave, editable, placeholder, className }: { value: string; onSave: (text: string) => void; editable: boolean; placeholder: string; className: string }) {
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
