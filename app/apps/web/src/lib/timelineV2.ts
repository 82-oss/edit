// The V2 timeline's drawing (components/V2Timeline.tsx is the canvas, its
// pointer and its keys): rows by kind (lib/timelineRows.ts), the Subtitles row
// held under the ruler while the rest scroll beneath it (Sphe, Nov 21: "they
// should go to the very top and should be sort of locked to the top (so that
// even if we scroll up or down, we still get to see the subtitles)"), each
// picture block tiled with its own moments' frames, each sound block its own
// stretch of its waveform, and only what's in view drawn (3,173 clips on a
// 2-hour edit: the lanes are drawn into a layer once a change, as V1's are, and
// each tick draws the playhead over it).

import { COVER_HEX, ROW_HEX } from "./colors";
import { drawMoments } from "./filmstrip";
import { firstFrom, PICTURE_ROWS, SOUND_ROWS, type Block, type Layout, type Row, type RowKind } from "./timelineRows";
import { frameHeight, snapTime, type TimelineMedia } from "./timelineMedia";
import { drawPlayhead, drawRuler, marksOf, SCALE_ONLY } from "./timelineView";
import { rate, type Media, type Project } from "./types";

/** The ruler's height (the time scale alone). */
export const TOP = SCALE_ONLY;
/** Each kind's lane height (px): pictures tall enough to read, words one line, sounds a waveform's worth. */
export const LANE: Record<RowKind, number> = {
  subtitles: 22,
  graphics: 40,
  captions: 18,
  cutins: 40,
  footage: 40,
  looks: 16,
  footsound: 24,
  voiceover: 24,
  music: 24,
  sfx: 22,
};
/** A picture block's name strip above its frames (27 px of frames under it, as the approved prototype). */
const HEADER = 13;
/** Room above and below a row's lanes, between its lanes, and between what's seen and what's heard. */
const PAD = 3;
const GAP = 2;
const DIVIDE = 8;
const FONT = "500 10.5px Inter, system-ui, sans-serif";
/** What a graphic whose render isn't made (or isn't of its code now) says. */
export const NOT_RENDERED = "Not rendered yet";
const WORDS = "500 11px Inter, system-ui, sans-serif";

export interface Placed {
  row: Row;
  /** Its top: under the ruler for the held Subtitles row, else in the scrolled rows (from their top). */
  y: number;
  h: number;
  laneH: number;
  held: boolean;
}

export interface Rows {
  placed: Placed[];
  /** The held row's height (0 without subtitles): the scrolled rows start under it. */
  held: number;
  /** The scrolled rows' whole height. */
  content: number;
}

/** Where each row goes. */
export function placeRows(layout: Layout): Rows {
  const placed: Placed[] = [];
  let held = 0;
  let y = 0;
  let heard = false;
  for (const row of layout.rows) {
    const laneH = LANE[row.kind];
    const h = PAD * 2 + row.lanes * laneH + (row.lanes - 1) * GAP;
    if (row.kind === "subtitles") {
      placed.push({ row, y: 0, h, laneH, held: true });
      held = h + 1;
      continue;
    }
    if (SOUND_ROWS.has(row.kind) && !heard) {
      heard = true;
      if (placed.some((one) => !one.held)) y += DIVIDE;
    }
    placed.push({ row, y, h, laneH, held: false });
    y += h + 1;
  }
  return { placed, held, content: y + 6 };
}

/** The top of `placed` on screen. */
export function topOf(placed: Placed, rows: Rows, scrollY: number): number {
  return placed.held ? TOP + placed.y : TOP + rows.held + placed.y - scrollY;
}

/** The row and lane under `y` on screen, if any. */
export function laneAt(rows: Rows, y: number, scrollY: number): { placed: Placed; lane: number } | null {
  if (y < TOP) return null;
  for (const placed of rows.placed) {
    if (!placed.held && y < TOP + rows.held) continue;
    const top = topOf(placed, rows, scrollY) + PAD;
    const lane = Math.floor((y - top) / (placed.laneH + GAP));
    if (lane >= 0 && lane < placed.row.lanes && y - top - lane * (placed.laneH + GAP) <= placed.laneH) return { placed, lane };
  }
  return null;
}

/** A lane's top on screen. */
export function laneTop(placed: Placed, rows: Rows, lane: number, scrollY: number): number {
  return topOf(placed, rows, scrollY) + PAD + lane * (placed.laneH + GAP);
}

export interface Scene {
  project: Project;
  layout: Layout;
  rows: Rows;
  width: number;
  height: number;
  ppf: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
  /** Graphics whose code is newer than their render (lib/effects.ts `playedLive`): marked, not pictured. */
  stale: ReadonlySet<string>;
  media: TimelineMedia;
}

export function shade(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

/** Whether a graphic's block is marked "Not rendered yet": its render isn't made, or isn't of its code now. */
export function notRendered(media: Media | null, stale: ReadonlySet<string>): boolean {
  if (media === null || typeof media.effect !== "string") return false;
  return typeof media.effect_key !== "string" || stale.has(media.effect);
}

const fitted = new Map<string, string>();

/** `text` cut to `max` px with an ellipsis (never squashed), measured once per font, text and width. */
export function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max < 14 || text === "") return "";
  const key = `${ctx.font}|${text}|${Math.floor(max)}`;
  const known = fitted.get(key);
  if (known !== undefined) return known;
  let out = text;
  if (ctx.measureText(text).width > max) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) low = mid;
      else high = mid - 1;
    }
    // A stub ("S…", "Ar…") says nothing and clutters the row: the block stays clear, its tooltip names it.
    out = low >= Math.min(4, text.length) ? `${text.slice(0, low).trimEnd()}…` : "";
  }
  if (fitted.size > 4000) fitted.clear();
  fitted.set(key, out);
  return out;
}

/** The lanes and the ruler: drawn into the cached layer once a change. Asks the loader for what's in view. */
export function drawLanes(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { project, rows, width, height, ppf, scrollX, scrollY } = scene;
  const fps = rate(project.settings);
  const frame0 = scrollX / ppf;
  const frame1 = (scrollX + width) / ppf;
  scene.media.begin();
  ctx.fillStyle = "#101010";
  ctx.fillRect(0, TOP, width, height - TOP);
  // The scrolled rows under the held one, then the held one over them.
  const scrolledTop = TOP + rows.held;
  for (const pass of [false, true]) {
    ctx.save();
    ctx.beginPath();
    if (pass) ctx.rect(0, TOP, width, rows.held);
    else ctx.rect(0, scrolledTop, width, height - scrolledTop);
    ctx.clip();
    for (const placed of rows.placed) {
      if (placed.held !== pass) continue;
      const top = topOf(placed, rows, scrollY);
      if (top > height || top + placed.h < (pass ? TOP : scrolledTop)) continue;
      ctx.fillStyle = pass ? "#141414" : "rgba(255,255,255,0.022)";
      ctx.fillRect(0, top, width, placed.h);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(0, top + placed.h, width, 1);
      const { row } = placed;
      for (let at = firstFrom(row, frame0); at < row.blocks.length; at++) {
        const block = row.blocks[at]!;
        if (block.start > frame1) break;
        if (block.end < frame0) continue;
        drawBlock(ctx, scene, block, laneTop(placed, rows, block.lane, scrollY), placed.laneH, fps);
      }
    }
    if (!pass) drawCovers(ctx, scene);
    ctx.restore();
  }
  drawRuler(ctx, width, fps, ppf, scrollX, null, marksOf(project), project.markers, 0);
  scene.media.flush();
}

function drawBlock(ctx: CanvasRenderingContext2D, scene: Scene, block: Block, y: number, h: number, fps: number): void {
  const { ppf, scrollX, width } = scene;
  const x0 = block.start * ppf - scrollX;
  const x1 = block.end * ppf - scrollX;
  const w = Math.max(1.5, x1 - x0 - 1);
  const color = ROW_HEX[block.kind];
  // A sliver (the whole of a long edit in view: 2,028 subtitles in 1,200 px): its colour alone, nothing to clip or outline.
  if (w < 4) {
    ctx.fillStyle = shade(color, 0.6);
    ctx.fillRect(x0, y, w, h);
    return;
  }
  const radius = Math.min(4, w / 2, h / 2);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x0, y, w, h, radius);
  ctx.clip();
  const picture = PICTURE_ROWS.has(block.kind);
  const sound = SOUND_ROWS.has(block.kind);
  ctx.fillStyle = shade(color, picture ? 0.34 : sound ? 0.22 : block.kind === "subtitles" ? 0.3 : 0.42);
  ctx.fillRect(x0, y, w, h);
  const left = Math.max(x0, -2);
  const right = Math.min(x0 + w, width + 2);
  if (picture && w >= 10) drawFrames(ctx, scene, block, x0, y, w, h, left, right, fps);
  else if (sound && w >= 3) drawWave(ctx, scene, block, x0, y, w, h, left, right, fps);
  // Its name: in the strip over its frames, else inside on one line, held in view while it's scrolled partly off.
  if (w > 18) {
    const textX = Math.max(x0 + 5, 5);
    const room = x0 + w - textX - 4;
    ctx.font = block.kind === "subtitles" || block.kind === "captions" ? WORDS : FONT;
    ctx.textBaseline = "middle";
    const label = ellipsize(ctx, block.name, room);
    if (label !== "") {
      if (sound) {
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.shadowBlur = 3;
      }
      ctx.fillStyle = picture ? "rgba(255,255,255,0.96)" : sound ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.92)";
      ctx.fillText(label, textX, picture ? y + HEADER / 2 + 0.5 : sound ? y + 8 : y + h / 2 + 0.5);
      ctx.shadowBlur = 0;
    }
  }
  ctx.restore();
  ctx.strokeStyle = shade(color, 0.6);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x0 + 0.5, y + 0.5, Math.max(0.5, w - 1), h - 1, radius);
  ctx.stroke();
}

/** One frame per cell across the block, each its own moment's (`source_in` and `speed`), dimmed a little so the name reads. */
function drawFrames(ctx: CanvasRenderingContext2D, scene: Scene, block: Block, x0: number, y: number, w: number, h: number, left: number, right: number, fps: number): void {
  const clip = block.clip;
  const media = block.media;
  ctx.fillStyle = shade(ROW_HEX[block.kind], 0.9);
  ctx.fillRect(x0, y, w, HEADER);
  const top = y + HEADER;
  const th = h - HEADER;
  if (th < 6 || clip.type !== "video" || media === null) return;
  if (notRendered(media, scene.stale)) {
    // A clear still stands in for it: its block is striped (it reads at any width) and says so where the words fit.
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(x0, top, w, th);
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let x = Math.floor((x0 - th) / 9) * 9; x < x0 + w; x += 9) {
      if (x + th < left || x > right) continue;
      ctx.moveTo(x, top + th);
      ctx.lineTo(x + th, top);
    }
    ctx.stroke();
    ctx.font = FONT;
    ctx.textBaseline = "middle";
    const room = x0 + w - Math.max(x0 + 5, 5) - 4;
    if (ctx.measureText(NOT_RENDERED).width <= room) {
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillText(NOT_RENDERED, Math.max(x0 + 5, 5), top + th / 2);
    }
    return;
  }
  const speed = clip.speed > 0 ? clip.speed : 1;
  const sourceAt = (x: number) => clip.source_in + ((x - x0) / scene.ppf / fps) * speed;
  const aspect = media.width > 0 && media.height > 0 ? media.width / media.height : 16 / 9;
  drawMoments(ctx, { x: x0, y, w, h, header: HEADER }, aspect, sourceAt, (seconds, spacing, height) => scene.media.frame(scene.project.id, media, snapTime(seconds, spacing), frameHeight(height, scene.dpr)), left, right, 0.12);
}

/** The block's own stretch of its sound: a bar every 2 px, its gain in its height, on the peaks' square-root scale so a quiet one still reads. */
function drawWave(ctx: CanvasRenderingContext2D, scene: Scene, block: Block, x0: number, y: number, w: number, h: number, left: number, right: number, fps: number): void {
  const clip = block.clip;
  const media = block.media;
  if (clip.type !== "audio" || media === null) return;
  const data = scene.media.peaks(scene.project.id, media);
  if (data === null) return;
  const ppf = scene.ppf;
  const speed = clip.speed > 0 ? clip.speed : 1;
  // The peaks are already on a square-root scale (the engine's make_peaks), so the gain is too: its height shows it, and a
  // quiet one (music at -18 dB) is still drawn at half, the square root of a quarter.
  const gain = Math.sqrt(Math.min(1.6, Math.max(0.25, 10 ** (clip.volume_db / 20))));
  const mid = y + h / 2;
  const amp = h / 2 - 1.5;
  ctx.fillStyle = shade(ROW_HEX[block.kind], 0.95);
  const at = (x: number) => (clip.source_in + ((x - x0) / ppf / fps) * speed) * 100;
  for (let x = Math.floor(left); x < right; x += 2) {
    const a = Math.max(0, Math.floor(at(x)));
    const b = Math.max(a + 1, Math.ceil(at(x + 2)));
    let peak = 0;
    for (let i = a; i < b && i < data.length; i++) if (data[i]! > peak) peak = data[i]!;
    const bar = Math.max(0.5, Math.min(1, (peak / 255) * gain) * amp);
    ctx.fillRect(x, mid - bar, 1.5, bar * 2);
  }
  void w;
}

/** Removals and blurs, a band along the foot of the footage each covers. */
function drawCovers(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { layout, rows, ppf, scrollX, scrollY, width } = scene;
  if (layout.covers.length === 0) return;
  const footage = rows.placed.find((one) => one.row.kind === "footage") ?? rows.placed.find((one) => one.row.kind === "cutins");
  ctx.fillStyle = shade(COVER_HEX, 0.9);
  for (const cover of layout.covers) {
    const x0 = cover.start * ppf - scrollX;
    const x1 = cover.end * ppf - scrollX;
    if (x1 < 0 || x0 > width) continue;
    const band = bandOf(rows, cover.host, footage, scrollY);
    if (band === null) continue;
    ctx.fillRect(x0, band, Math.max(1.5, x1 - x0 - 1), 3);
  }
}

/** A cover's band's top on screen: at the foot of its host's lane, else of the footage row's first. */
export function bandOf(rows: Rows, host: Block | null, footage: Placed | undefined, scrollY: number): number | null {
  const placed = host === null ? footage : rows.placed.find((one) => one.row.kind === host.kind);
  if (placed === undefined) return null;
  return laneTop(placed, rows, host?.lane ?? 0, scrollY) + placed.laneH - 4;
}

/** The subtitle line at `frame` (the playhead's or the pointer's) drawn on its row when its block is too narrow to hold it. */
export function drawLine(ctx: CanvasRenderingContext2D, scene: Scene, x: number, frame: number): void {
  const held = scene.rows.placed.find((one) => one.held);
  if (held === undefined) return;
  const block = held.row.blocks.find((one) => one.start <= frame && frame < one.end);
  if (block === undefined) return;
  const w = (block.end - block.start) * scene.ppf - 1;
  ctx.font = WORDS;
  const full = ctx.measureText(block.name).width;
  if (full <= w - 10) return;
  const textW = Math.min(full, scene.width - 24);
  const pillW = textW + 16;
  const left = Math.min(Math.max(4, x - pillW / 2), scene.width - pillW - 4);
  const y = laneTop(held, scene.rows, block.lane, 0);
  ctx.fillStyle = "rgba(12,12,12,0.94)";
  ctx.beginPath();
  ctx.roundRect(left, y - 1, pillW, held.laneH + 2, 5);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.textBaseline = "middle";
  ctx.fillText(ellipsize(ctx, block.name, textW + 1) || block.name, left + 8, y + held.laneH / 2 + 0.5);
}

/** What's over the layer each tick: the line under the pointer or the playhead, and the playhead. */
export function drawOver(ctx: CanvasRenderingContext2D, scene: Scene, playheadFrame: number, pointer: { x: number; y: number } | null): void {
  const px = Math.round(playheadFrame * scene.ppf - scene.scrollX) + 0.5;
  const held = scene.rows.placed.find((one) => one.held);
  const overHeld = pointer !== null && held !== undefined && pointer.y >= TOP && pointer.y < TOP + scene.rows.held;
  if (overHeld) drawLine(ctx, scene, pointer.x, (pointer.x + scene.scrollX) / scene.ppf);
  else if (px >= 0 && px <= scene.width) drawLine(ctx, scene, px, playheadFrame);
  if (px >= -10 && px <= scene.width + 10) drawPlayhead(ctx, px, scene.height, 0);
}
