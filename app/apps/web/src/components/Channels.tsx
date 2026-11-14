// Channels on Home (Nov 14; Sphe: "a dedicated section where we load in
// channels"): the team's YouTube channels, one added by pasting any link to it
// and then set up (who narrates, whether it's a compilation channel); a
// channel's page shows its lanes (ideas, thumbnails, script, edit), each with
// its own style. Adding and changing one is a teacher's; anyone reads them.

import { ArrowLeft, ExternalLink, Mic, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { channelApi, compact, LANES, loadChannels, narrationLabel, useChannels, type Channel, type Found, type Narration, type Voice } from "../lib/channels";
import { useEditor } from "../lib/store";
import { InPlace } from "./Niches";
import { Button, DialogActions, DialogTitle, Modal, Select, spring, Switch } from "./ui";

const FIELD = "h-9 w-full rounded-lg border border-line bg-black px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted";
const LABEL = "mb-1.5 block text-[12px] font-medium text-muted";
const PICKER = "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-black px-3 text-[13px] hover:border-line-strong";
const RECORDED = "recorded";

/** Its picture, round; its first letter while there's none. */
export function ChannelAvatar({ channel, size = 32 }: { channel: { title: string; avatar?: string | null }; size?: number }) {
  if (channel.avatar) return <img src={channel.avatar} alt="" referrerPolicy="no-referrer" className="shrink-0 rounded-full bg-active object-cover" style={{ width: size, height: size }} />;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-active font-semibold text-muted" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {channel.title.charAt(0).toUpperCase()}
    </span>
  );
}

/** "@drinsanity · 1.2M subscribers". */
function facts(channel: { handle?: string | null; subscribers?: number | null; videos?: number | null }): string {
  return [channel.handle ? `@${channel.handle}` : null, compact(channel.subscribers) ? `${compact(channel.subscribers)} subscribers` : null, compact(channel.videos) ? `${compact(channel.videos)} videos` : null].filter(Boolean).join(" · ");
}

/** Home's Channels: the list, or one channel's page. */
export function ChannelsView({ adding, onAdding }: { adding: boolean; onAdding: (open: boolean) => void }) {
  const channels = useChannels((state) => state.channels);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void loadChannels();
  }, []);
  const shown = channels?.find((one) => one.key === open) ?? null;
  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        {shown !== null ? (
          <motion.div key={shown.key} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={spring}>
            <ChannelPage channel={shown} onBack={() => setOpen(null)} />
          </motion.div>
        ) : (
          <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="flex flex-col gap-0.5">
            {channels !== null && channels.length === 0 && (
              <div className="mx-auto mt-16 max-w-[320px] text-center">
                <h3 className="text-[15px] font-semibold">No channels yet</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">Paste a link to a YouTube channel. Each channel keeps its own style for ideas, thumbnails, scripts and edits.</p>
              </div>
            )}
            {(channels ?? []).map((channel) => (
              <button key={channel.key} onClick={() => setOpen(channel.key)} className="flex h-14 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-hover">
                <ChannelAvatar channel={channel} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{channel.title}</span>
                  <span className="block truncate text-[12px] text-faint">{facts(channel)}</span>
                </span>
                {channel.narration === null && <span className="shrink-0 rounded-md bg-warning-soft px-1.5 py-0.5 text-[11px] font-semibold text-warning">Not set up</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <AddChannel open={adding} onClose={() => onAdding(false)} onAdded={(channel) => setOpen(channel.key)} />
    </>
  );
}

/** Who narrates: the voices, then the editor's own recording. */
function NarrationPicker({ value, voices, onChange }: { value: Narration | null; voices: Voice[] | null; onChange: (narration: Narration) => void }) {
  const options = [
    ...(voices ?? []).map((voice) => ({ value: voice.voice_id, label: voice.name })),
    { value: RECORDED, label: "Recorded by the editor" },
    ...(value?.kind === "voice" && !(voices ?? []).some((voice) => voice.voice_id === value.id) ? [{ value: value.id, label: value.name }] : []),
  ];
  const current = value === null ? "" : value.kind === "recorded" ? RECORDED : value.id;
  return (
    <Select
      value={current}
      onChange={(picked) => onChange(picked === RECORDED ? { kind: "recorded" } : { kind: "voice", id: picked, name: voices?.find((voice) => voice.voice_id === picked)?.name ?? picked })}
      className={PICKER}
      menuWidth={260}
      options={current === "" ? [{ value: "", label: voices === null ? "Loading voices…" : "Pick who narrates", disabled: true }, ...options] : options}
    />
  );
}

function useVoices(on: boolean): Voice[] | null {
  const [voices, setVoices] = useState<Voice[] | null>(null);
  useEffect(() => {
    if (!on || voices !== null) return;
    void channelApi.voices().then(setVoices, () => setVoices([]));
  }, [on, voices]);
  return voices;
}

/**
 * A channel added: a link pasted (read as it's typed, so the right channel is
 * seen before it's added), then set up: who narrates its videos and whether
 * it's a compilation channel. Its styles start empty, taught as it's worked on.
 */
function AddChannel({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (channel: Channel) => void }) {
  const [link, setLink] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Channel | null>(null);
  const [narration, setNarration] = useState<Narration | null>(null);
  const [compilation, setCompilation] = useState(false);
  const [busy, setBusy] = useState(false);
  const voices = useVoices(open && added !== null);

  useEffect(() => {
    if (!open) return;
    setLink("");
    setFound(null);
    setError(null);
    setAdded(null);
    setNarration(null);
    setCompilation(false);
  }, [open]);

  // Read as it's typed, a moment after the last key.
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
  }, [link]);

  const add = async () => {
    if (found === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const channel = await channelApi.add(link.trim());
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
            <input autoFocus value={link} onChange={(event) => setLink(event.target.value)} placeholder="youtube.com/@channel, a video of theirs, or the channel ID" className={FIELD} />
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
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <ChannelAvatar channel={added} size={40} />
              <DialogTitle title={`Set up ${added.title}`} />
            </div>
            <div>
              <span className={LABEL}>Who narrates</span>
              <NarrationPicker value={narration} voices={voices} onChange={setNarration} />
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
          <Button type="button" variant="subtle" onClick={onClose}>
            {added === null ? "Cancel" : "Later"}
          </Button>
          {added === null ? (
            <Button type="submit" variant="primary" busy={busy} disabled={found === null}>
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
 * agent is taught builds up as the team works with it).
 */
function ChannelPage({ channel, onBack }: { channel: Channel; onBack: () => void }) {
  const teacher = useChannels((state) => state.teacher);
  const voices = useVoices(teacher);
  const change = (what: string, given: Parameters<typeof channelApi.set>[1]) =>
    void channelApi.set(channel.key, given).catch((error: unknown) => useEditor.getState().toastError(error, `change ${channel.title}'s ${what}`));
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 pb-10">
      <div className="flex items-center gap-1">
        <button onClick={onBack} className="-ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg">
          <ArrowLeft size={14} /> Channels
        </button>
      </div>
      <div className="flex items-center gap-4">
        <ChannelAvatar channel={channel} size={64} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[20px] font-semibold tracking-[-0.3px]">{channel.title}</h2>
          <p className="truncate text-[13px] text-muted">{facts(channel)}</p>
        </div>
        <a
          href={`https://www.youtube.com/channel/${channel.youtubeId}`}
          target="_blank"
          rel="noreferrer"
          title="Open on YouTube"
          className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ExternalLink size={15} />
        </a>
      </div>
      <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
        <div className="rounded-xl border border-line bg-black/30 p-3">
          <span className={LABEL}>
            <Mic size={12} className="mr-1 inline -translate-y-px" />
            Who narrates
          </span>
          {teacher ? <NarrationPicker value={channel.narration} voices={voices} onChange={(narration) => change("narration", { narration })} /> : <p className="text-[13px]">{narrationLabel(channel.narration) ?? "Not set up"}</p>}
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-black/30 p-3">
          <span>
            <span className="block text-[13px] font-medium">Compilation channel</span>
            <span className="block text-[12px] text-faint">Several cases in each video</span>
          </span>
          {teacher ? <Switch checked={channel.compilation} onChange={(compilation) => change("compilation", { compilation })} /> : <span className="text-[13px] text-muted">{channel.compilation ? "Yes" : "No"}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {LANES.map((lane) => (
          <div key={lane.key} className="rounded-xl border border-line p-4">
            <div className="mb-1 text-[13px] font-semibold">{lane.label}</div>
            <InPlace
              value={channel.lanes[lane.key]}
              editable={teacher}
              placeholder={teacher ? "Its style, in a line or two" : "No style written yet"}
              onSave={(text) => change(`${lane.label.toLowerCase()} style`, { lanes: { [lane.key]: text } })}
              className="text-[13px] leading-relaxed text-secondary"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

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
