import { useEffect, useState } from "react";

/**
 * A picture strip drawn from one sheet of frames: a script's clips sample
 * their preview into one (no sheet is made for a script), and a clip's preview
 * card draws from it. No strip, no frames: the clip stays its flat colour.
 * The edit timelines draw each cell's own moment instead (`drawMoments`).
 */
export type Strip = {
  image: CanvasImageSource;
  width: number;
  height: number;
  count: number;
  /** The footage the frames are spread across, in seconds. */
  duration: number;
  /** Bumps as more frames land, so a view redraws the same canvas. */
  rev: number;
};

/** Tiles `strip` across a clip the way the edit timeline does: one frame per cell, picked from the source time under that cell, then dimmed so the colour still reads. */
export function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  strip: Strip,
  box: { x: number; y: number; w: number; h: number; header: number },
  sourceAt: (x: number) => number,
  visible0: number,
  visible1: number,
) {
  if (strip.count < 1 || strip.duration <= 0 || strip.height < 1 || box.w < 8) return;
  const cellW = strip.width / strip.count;
  const th = box.h - box.header;
  if (th < 1 || cellW < 1) return;
  const tw = Math.max(8, (th * cellW) / strip.height);
  const start = box.x + Math.floor((visible0 - box.x) / tw) * tw;
  for (let x = start; x < visible1; x += tw) {
    const index = Math.min(strip.count - 1, Math.max(0, Math.floor((sourceAt(x + tw / 2) / strip.duration) * strip.count)));
    ctx.drawImage(strip.image, index * cellW, 0, cellW, strip.height, x, box.y + box.header, tw, th);
  }
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(box.x, box.y + box.header, box.w, th);
}

/**
 * Tiles a clip with its own moments' frames (Nov 21: "like on v1 but have them work reliably this time"): one cell per
 * frame's width across the part in view, each the frame at that cell's source time (`sourceAt` of its middle) as
 * `frameAt` has it (lib/timelineMedia.ts asks for it when it hasn't), then dimmed so the colour and the name still read.
 * A cell whose frame isn't in yet is the clip's flat colour. Both timelines draw their picture clips with it.
 */
export function drawMoments(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number; header: number },
  aspect: number,
  sourceAt: (x: number) => number,
  /** A cell's frame: its source second, how many seconds a cell spans (for the grid it's asked on), and the cells' height. */
  frameAt: (seconds: number, spacing: number, height: number) => CanvasImageSource | null,
  visible0: number,
  visible1: number,
  dim = 0.18,
) {
  const th = box.h - box.header;
  if (th < 4 || box.w < 8) return;
  const tw = Math.max(8, th * (aspect > 0 ? aspect : 16 / 9));
  const top = box.y + box.header;
  const spacing = Math.abs(sourceAt(box.x + tw) - sourceAt(box.x));
  const start = box.x + Math.max(0, Math.floor((visible0 - box.x) / tw)) * tw;
  for (let x = start; x < visible1; x += tw) {
    const picture = frameAt(sourceAt(Math.min(x + tw / 2, box.x + box.w)), spacing, th);
    if (picture !== null) ctx.drawImage(picture, x, top, tw, th);
  }
  ctx.fillStyle = `rgba(0,0,0,${dim})`;
  ctx.fillRect(box.x, top, box.w, th);
}

const HEIGHT = 72;
/** Same budget as the edit's thumbnail sheet: at most 120 frames, about one every two seconds. */
const framesFor = (durationMs: number) => Math.min(120, Math.max(1, Math.ceil(durationMs / 2000)));

const seekTo = (video: HTMLVideoElement, time: number) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, 2000);
    video.addEventListener("seeked", finish);
    if (Math.abs(video.currentTime - time) < 0.04) finish();
    else video.currentTime = time;
  });

/**
 * A thumbnail strip sampled from a preview URL, filled in as frames arrive.
 * `src` empty, or a preview that won't decode, leaves it null.
 */
export function useVideoStrip(src: string, durationMs: number): Strip | null {
  const [strip, setStrip] = useState<Strip | null>(null);
  useEffect(() => {
    if (!src || durationMs <= 0) return;
    let gone = false;
    setStrip(null);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    const count = framesFor(durationMs);
    const duration = durationMs / 1000;
    const run = async () => {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("preview"));
      });
      if (gone || !video.videoWidth) return;
      const cellW = Math.max(8, Math.round(HEIGHT * (video.videoWidth / video.videoHeight)));
      const canvas = document.createElement("canvas");
      canvas.width = cellW * count;
      canvas.height = HEIGHT;
      const pen = canvas.getContext("2d");
      if (!pen) return;
      for (let i = 0; i < count; i++) {
        if (gone) return;
        await seekTo(video, Math.max(0, Math.min(duration - 0.05, ((i + 0.5) / count) * duration)));
        if (gone) return;
        pen.drawImage(video, i * cellW, 0, cellW, HEIGHT);
        if (i % 3 === 2 || i === count - 1) {
          setStrip({ image: canvas, width: canvas.width, height: HEIGHT, count, duration, rev: i });
        }
      }
    };
    void run().catch(() => {});
    return () => {
      gone = true;
      video.onloadeddata = null;
      video.onerror = null;
      video.src = "";
    };
  }, [src, durationMs]);
  return strip;
}
