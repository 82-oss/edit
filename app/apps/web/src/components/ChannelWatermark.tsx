// A channel's watermark, set on its page by a teacher (Sphe, Nov 16: "upload a
// watermark on the channel page and play with the opacity and what not"): its
// picture (uploaded here, kept with the channel; or one of the Watermarks
// folder's, as before) and its look, seen live on a still of the channel's
// own: the logo moving as its exports draw it (@edit/types/watermark, the
// path the export keyframes), changing as a slider is dragged and saved when
// it's let go. Linked to the channel, never its name. Nobody else sees any of
// this: the page shows it only to a teacher who sees the channel in full.

import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { boxOf, bounceAt, HOUSE_LOOK, LOOK_RANGE, startOf, type WatermarkLook } from "@edit/types/watermark";

import { api } from "../lib/api";
import { channelApi, type Channel } from "../lib/channels";
import { useEditor } from "../lib/store";
import { cx, Select, Switch } from "./ui";

const failed = (what: string) => (error: unknown) => useEditor.getState().toastError(error, what);

const NONE = "";
const UPLOADED = "uploaded";
const UPLOAD = "upload…";
/** The frame the look is set for: the export's, 1080p. */
const [W, H] = [1920, 1080];

export function ChannelWatermark({ channel, still }: { channel: Channel; /** One of its edits, whose frame stands in for a still when it has no YouTube video yet. */ still?: string }) {
  const [pictures, setPictures] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const saved = channel.watermarkLook ?? HOUSE_LOOK;
  const [look, setLook] = useState<WatermarkLook>(saved);
  const lookRef = useRef(look);
  lookRef.current = look;
  const savedKey = JSON.stringify(saved);
  useEffect(() => setLook(JSON.parse(savedKey) as WatermarkLook), [savedKey]);
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

  const upload = (file: File | undefined) => {
    if (file === undefined) return;
    setBusy(true);
    void channelApi
      .uploadWatermark(channel.key, file)
      .catch(failed(`upload ${channel.title}'s watermark`))
      .finally(() => setBusy(false));
  };
  const value = channel.watermarkUpload ? UPLOADED : (channel.watermark ?? NONE);
  const options = [
    { value: NONE, label: "None" },
    ...(channel.watermarkUpload ? [{ value: UPLOADED, label: "Uploaded picture" }] : []),
    ...(pictures ?? []).map((one) => ({ value: one.id, label: one.name })),
    { value: UPLOAD, label: "Upload a picture…" },
  ];
  // Its own before the folder is read, or once it's left the folder.
  if (value !== NONE && !options.some((one) => one.value === value)) options.splice(1, 0, { value, label: pictures === null ? "…" : "Not in the folder" });
  const pick = (picked: string) => {
    if (picked === UPLOAD) return input.current?.click();
    if (picked === value || picked === UPLOADED) return;
    void channelApi.set(channel.key, { watermark: picked === NONE ? null : picked }).catch(failed(`change ${channel.title}'s watermark`));
  };
  const save = () => {
    const now = lookRef.current;
    if (JSON.stringify(now) === savedKey) return;
    void channelApi.set(channel.key, { watermarkLook: now }).catch(failed(`change ${channel.title}'s watermark`));
  };
  // The ref at once too: a key's step saves straight after it.
  const change = (part: Partial<WatermarkLook>) => {
    lookRef.current = { ...lookRef.current, ...part };
    setLook(lookRef.current);
  };
  const url = channelApi.watermarkUrl(channel);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">Watermark</span>
        <Select
          value={busy ? UPLOAD : value}
          options={busy ? [{ value: UPLOAD, label: "Uploading…" }] : options}
          onChange={pick}
          className="h-[30px] min-w-[140px] shrink-0 justify-between rounded-lg border border-line-strong bg-bg pr-2.5 pl-3 text-[13px] hover:border-muted"
          menuWidth={210}
        />
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {url !== null && (
        <>
          <Preview channel={channel} picture={url} look={look} still={still} onFile={upload} />
          <div className="flex flex-col gap-1.5">
            <Slider label="Opacity" value={look.opacity} range={LOOK_RANGE.opacity} shown={`${Math.round(look.opacity * 100)}%`} onChange={(opacity) => change({ opacity })} onDone={save} />
            <Slider label="Size" value={look.size} range={LOOK_RANGE.size} shown={`${Math.round(look.size * 100)}%`} onChange={(size) => change({ size })} onDone={save} />
            {look.motion && <Slider label="Speed" value={look.speed} range={[0.005, 0.2]} shown={`${(look.speed / HOUSE_LOOK.speed).toFixed(1)}×`} onChange={(speed) => change({ speed })} onDone={save} />}
            <div className="flex h-7 items-center justify-between">
              <span className="text-[12.5px] text-secondary">Moves around</span>
              <Switch
                checked={look.motion}
                onChange={(motion) => {
                  change({ motion });
                  save();
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** A still of the channel's (its newest video's picture, else a frame of one of its edits) with the logo on it, moving as its exports draw it. */
function Preview({ channel, picture, look, still, onFile }: { channel: Channel; picture: string; look: WatermarkLook; still?: string; onFile: (file: File) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const logo = useRef<HTMLImageElement>(null);
  const [width, setWidth] = useState(0);
  const [natural, setNatural] = useState<[number, number] | null>(null);
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const lookRef = useRef(look);
  lookRef.current = look;

  useEffect(() => {
    let live = true;
    const frame = still === undefined ? null : `/api/projects/${encodeURIComponent(still)}/frame/300.png?max=640`;
    if (channel.youtubeId === null || channel.masked === true) setBackdrop(frame);
    else
      void channelApi.latestStill(channel.key).then(
        (found) => live && setBackdrop(found ?? frame),
        () => live && setBackdrop(frame),
      );
    return () => {
      live = false;
    };
  }, [channel.key, channel.youtubeId, channel.masked, still]);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The bounce, a frame at a time: the distance gone grows at the look's speed, so a speed dragged changes it smoothly.
  useEffect(() => {
    if (natural === null || width === 0) return;
    const scale = width / W;
    const start = startOf(channel.key, boxOf(lookRef.current, W, H, natural[0], natural[1]).reach);
    let gone = 0;
    let last = performance.now();
    let id = 0;
    const draw = (now: number) => {
      const shown = lookRef.current;
      gone += shown.speed * H * Math.min(0.1, (now - last) / 1000);
      last = now;
      const { h, reach } = boxOf(shown, W, H, natural[0], natural[1]);
      const [x, y] = shown.motion && shown.speed > 0 ? [bounceAt(start.from[0], start.heading[0], reach[0], gone), bounceAt(start.from[1], start.heading[1], reach[1], gone)] : reach;
      if (logo.current !== null) {
        logo.current.style.height = `${h * scale}px`;
        logo.current.style.opacity = String(shown.opacity);
        logo.current.style.transform = `translate(-50%, -50%) translate(${x * scale}px, ${y * scale}px)`;
      }
      id = requestAnimationFrame(draw);
    };
    id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [natural, width, channel.key]);

  return (
    <div
      ref={box}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file !== undefined) onFile(file);
      }}
      className={cx("relative aspect-video w-full overflow-hidden rounded-lg border bg-[radial-gradient(120%_90%_at_30%_20%,#2a2d33,#0b0c0e)] transition-colors", over ? "border-fg" : "border-line")}
    >
      {backdrop !== null && <img src={backdrop} alt="" draggable={false} onError={() => setBackdrop(null)} className="absolute inset-0 size-full object-cover" />}
      <img
        ref={logo}
        src={picture}
        alt=""
        draggable={false}
        onLoad={(event) => setNatural([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])}
        className="absolute top-1/2 left-1/2 max-w-none"
        style={{ opacity: 0 }}
      />
      {over && (
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/60 text-[12.5px] font-medium">
          <Upload size={14} /> Drop to use as the watermark
        </div>
      )}
    </div>
  );
}

/** A thin slider: dragged or arrowed, `onChange` as it moves, `onDone` once it's let go. */
function Slider({ label, value, range: [min, max], shown, onChange, onDone }: { label: string; value: number; range: readonly [number, number]; shown: string; onChange: (value: number) => void; onDone: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const share = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const at = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
    return Math.round((min + fraction * (max - min)) * 1000) / 1000;
  };
  return (
    <div className="grid h-7 grid-cols-[64px_1fr_40px] items-center gap-2.5">
      <span className="text-[12.5px] text-secondary">{label}</span>
      <div
        ref={track}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = true;
          onChange(at(event.clientX));
        }}
        onPointerMove={(event) => dragging.current && onChange(at(event.clientX))}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          onDone();
        }}
        onPointerCancel={() => {
          dragging.current = false;
          onDone();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = ((max - min) / 50) * (event.key === "ArrowRight" ? 1 : -1);
          onChange(Math.round(Math.min(max, Math.max(min, value + step)) * 1000) / 1000);
          onDone();
        }}
        className="group relative flex h-5 cursor-pointer touch-none items-center outline-none"
      >
        <div className="h-[3px] w-full rounded-full bg-active">
          <div className="h-full rounded-full bg-fg/70" style={{ width: `${share * 100}%` }} />
        </div>
        <div className="absolute size-3 -translate-x-1/2 rounded-full bg-fg shadow-[0_0_0_3px_var(--color-panel,#111)] transition-transform group-focus-visible:scale-125 group-active:scale-110" style={{ left: `${share * 100}%` }} />
      </div>
      <span className="text-right font-mono text-[11.5px] text-muted tabular">{shown}</span>
    </div>
  );
}
