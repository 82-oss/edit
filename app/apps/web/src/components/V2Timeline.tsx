import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useEffects } from "../lib/effects";
import { playhead, preview } from "../lib/playback";
import { useEditor } from "../lib/store";
import { layoutOf, SOUND_ROWS, blockAt, type Block, type Cover } from "../lib/timelineRows";
import { timelineMedia } from "../lib/timelineMedia";
import { bandOf, drawLanes, drawOver, laneAt, NOT_RENDERED, notRendered, placeRows, TOP, topOf, type Scene } from "../lib/timelineV2";
import { contentFrames, getLanesWidth, leftTheWindow, MOST_PPF, nextFollow, setLanesWidth, setView, useView } from "../lib/timelineView";
import { rate, type Project } from "../lib/types";
import { pinFor, useWatching } from "../lib/watching";
import { ZoomBar } from "./Timeline";

/** The row names' column. */
const LABELS = 104;

/** How long the lanes last took to draw, and how often they have: read by the acceptance check (scripts/v2-timeline.ts) on the page's test handle. */
export const drawn = { lanesMs: 0, count: 0 };
Object.assign(((globalThis as unknown as { __edit?: Record<string, unknown> }).__edit ??= {}), { timelineDrawn: drawn, timelineMedia, useView });

/** The rows' scroll as drawn: never past their foot (the window, the timeline or the edit got smaller since). */
export function heldScroll(scrollY: number, content: number, held: number, height: number): number {
  return Math.max(0, Math.min(scrollY, content - (height - TOP - held)));
}

/** The edit on screen: the version pinned while the agent works (lib/watching.ts), so the playhead and a click agree with the picture. */
export function viewedOf(live: Project | null, pinned: ReturnType<typeof useWatching.getState>["pinned"]): Project | null {
  return pinFor(pinned, live?.id ?? null)?.project ?? live;
}

/** Every graphic whose code is newer than its render (lib/effects.ts `playedLive`), by name; none while a version is pinned (it plays its renders). */
function staleOf(project: Project, effects: { name: string; key: string }[], pinnedNow: boolean): Set<string> {
  const stale = new Set<string>();
  if (pinnedNow) return stale;
  for (const media of project.media) {
    if (typeof media.effect !== "string") continue;
    const code = effects.find((effect) => effect.name === media.effect);
    if (code !== undefined && code.key !== media.effect_key) stale.add(media.effect);
  }
  return stale;
}

const clock = (frame: number, fps: number) => {
  const whole = Math.max(0, Math.floor(frame / fps));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

/**
 * Edit V2's timeline (Sphe, Nov 21: "a quick preview of where things like
 * sound effects, graphics, footage, and all the stuff are placed… a quick
 * glance over the entire project"): read only. It draws the edit by kind of
 * thing (lib/timelineRows.ts, lib/timelineV2.ts); a click or a drag moves the
 * playhead; the wheel, a pinch and = - \ zoom, from the whole edit to close
 * enough to read the words; it scrolls sideways and follows the playhead as
 * V1's does (lib/timelineView.ts); hovering a block says what it is and when.
 * Nothing in it changes the edit: no drag, trim, cut, menu or key of V1's.
 */
export function V2Timeline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const live = useEditor((state) => state.project)!;
  const pinned = useWatching((state) => state.pinned);
  const project = viewedOf(live, pinned) ?? live;
  const pinnedNow = project !== live;
  const effects = useEffects((state) => state.effects);
  const view = useView();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; name: string; time: string } | null>(null);
  const layout = useMemo(() => layoutOf(project), [project]);
  const rows = useMemo(() => placeRows(layout), [layout]);
  const stale = useMemo(() => staleOf(project, effects, pinnedNow), [project, effects, pinnedNow]);
  const fps = rate(project.settings);
  const scrolledY = heldScroll(view.scrollY, rows.content, rows.held, size.h);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const scrubbing = useRef(false);
  const follow = useRef(true);
  const wasPlaying = useRef(false);
  const queued = useRef(0);
  const layer = useRef<{ canvas: HTMLCanvasElement; key: unknown[] } | null>(null);
  const scene = useRef<Scene | null>(null);
  const latest = useRef({ project, layout, rows, stale });
  latest.current = { project, layout, rows, stale };

  const requestDraw = () => {
    if (queued.current) return;
    queued.current = requestAnimationFrame(() => {
      queued.current = 0;
      draw();
    });
  };

  // Another project: its pictures and fetches go.
  useLayoutEffect(() => () => timelineMedia.clear(), [live.id]);
  useEffect(() => () => useView.setState({ fitted: false, scrollX: 0, scrollY: 0 }), [live.id]);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const observer = new ResizeObserver(() => setSize({ w: wrap.clientWidth, h: wrap.clientHeight }));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // The whole edit in view when it opens; afterwards the view stays inside the edit as it grows and shrinks.
  useEffect(() => {
    if (!size.w) return;
    setLanesWidth(size.w);
    if (!useView.getState().fitted) {
      useView.setState({ fitted: true, scrollY: 0 });
      setView({ ppf: 0, scrollX: 0 });
    } else setView({});
  }, [size.w, project]);

  // The rows scroll no further than they go.
  useEffect(() => {
    const room = Math.max(0, rows.content - (size.h - TOP - rows.held));
    if (useView.getState().scrollY > room) useView.setState({ scrollY: room });
  }, [rows, size.h]);

  useEffect(() => {
    const offPlayhead = playhead.subscribe(() => {
      followPlayhead();
      requestDraw();
    });
    const offView = useView.subscribe(requestDraw);
    const offMedia = timelineMedia.onChange(requestDraw);
    const onFonts = () => {
      layer.current = null;
      requestDraw();
    };
    document.fonts?.addEventListener("loadingdone", onFonts);
    return () => {
      offPlayhead();
      offView();
      offMedia();
      document.fonts?.removeEventListener("loadingdone", onFonts);
      cancelAnimationFrame(queued.current);
      queued.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(requestDraw);

  // The V1 timeline's zoom keys: = and - about the playhead, \ for the whole edit.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || document.querySelector("[role=dialog], [data-menu]")) return;
      if (event.key === "=" || event.key === "+") zoomAround(playheadX(), 1.25);
      else if (event.key === "-") zoomAround(playheadX(), 0.8);
      else if (event.key === "\\") fit();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const xToFrame = (x: number) => (x + useView.getState().scrollX) / useView.getState().ppf;
  const playheadX = () => playhead.frame * useView.getState().ppf - useView.getState().scrollX;

  function zoomAround(x: number, factor: number) {
    const { ppf, scrollX } = useView.getState();
    const frame = (x + scrollX) / ppf;
    const next = Math.min(MOST_PPF, ppf * factor);
    setView({ ppf: next, scrollX: frame * Math.max(next, getLanesWidth() / contentFrames()) - x });
    noteManualScroll();
  }

  function fit() {
    setView({ ppf: 0, scrollX: 0 });
  }

  function noteManualScroll() {
    const width = canvasRef.current?.clientWidth ?? 0;
    const x = playheadX();
    follow.current = x >= 0 && x <= width;
  }

  function followPlayhead() {
    if (!playhead.playing) {
      wasPlaying.current = false;
      return;
    }
    if (scrubbing.current) return;
    const justStarted = !wasPlaying.current;
    wasPlaying.current = true;
    const width = canvasRef.current?.clientWidth ?? 0;
    if (!width) return;
    const next = nextFollow({ playing: true, justStarted, following: follow.current, x: playheadX(), width });
    follow.current = next.following;
    if (next.page) setView({ scrollX: playhead.frame * useView.getState().ppf - 40 });
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { project, layout, rows, stale } = latest.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const { ppf, scrollX } = useView.getState();
    const scrollY = heldScroll(useView.getState().scrollY, rows.content, rows.held, height);
    const now: Scene = { project, layout, rows, width, height, ppf, scrollX, scrollY, dpr, stale, media: timelineMedia };
    scene.current = now;
    const key = [project, rows, stale, ppf, scrollX, scrollY, canvas.width, canvas.height, timelineMedia.rev];
    const cached = layer.current;
    if (!cached || key.some((value, index) => value !== cached.key[index])) {
      const lanes = cached?.canvas ?? document.createElement("canvas");
      if (lanes.width !== canvas.width || lanes.height !== canvas.height) {
        lanes.width = canvas.width;
        lanes.height = canvas.height;
      }
      const pen = lanes.getContext("2d");
      if (pen === null) return;
      pen.setTransform(dpr, 0, 0, dpr, 0, 0);
      pen.clearRect(0, 0, width, height);
      const started = performance.now();
      drawLanes(pen, now);
      drawn.lanesMs = performance.now() - started;
      drawn.count++;
      layer.current = { canvas: lanes, key };
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer.current!.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOver(ctx, now, playhead.frame, pointer.current);
  }

  // --- the pointer: the playhead, and what's under it ----------------------

  const local = (event: { clientX: number; clientY: number }) => {
    const box = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const seekTo = (x: number) => preview.seek(Math.max(0, Math.round(xToFrame(x))));

  /** What's under the pointer: a block, or a removal or blur's band on its footage. */
  function hit(x: number, y: number): Block | Cover | null {
    const { rows, layout } = latest.current;
    const scrollY = heldScroll(useView.getState().scrollY, rows.content, rows.held, canvasRef.current?.clientHeight ?? 0);
    const frame = xToFrame(x);
    const footage = rows.placed.find((one) => one.row.kind === "footage") ?? rows.placed.find((one) => one.row.kind === "cutins");
    for (const cover of layout.covers) {
      if (frame < cover.start || frame >= cover.end) continue;
      const band = bandOf(rows, cover.host, footage, scrollY);
      if (band !== null && y >= band - 2 && y <= band + 5 && y >= TOP + rows.held) return cover;
    }
    const under = laneAt(rows, y, scrollY);
    return under === null ? null : blockAt(under.placed.row, under.lane, frame);
  }

  function showTip(x: number, y: number) {
    const found = y >= TOP ? hit(x, y) : null;
    const { rows } = latest.current;
    // The words of a subtitle are on its row (drawOver), its time in the ruler.
    if (found === null || ("kind" in found && found.kind === "subtitles" && y < TOP + rows.held)) {
      setTip(null);
      return;
    }
    const unmade = "kind" in found && found.kind === "graphics" && notRendered(found.media, latest.current.stale);
    const time = `${unmade ? `${NOT_RENDERED} · ` : ""}${clock(found.start, fps)} – ${clock(found.end, fps)}`;
    const name = found.name || ("kind" in found && SOUND_ROWS.has(found.kind) ? "Sound" : "");
    setTip((was) => (was !== null && was.name === name && was.time === time && Math.abs(was.x - x) < 1 && Math.abs(was.y - y) < 1 ? was : { x, y, name, time }));
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    canvasRef.current!.setPointerCapture(event.pointerId);
    scrubbing.current = true;
    follow.current = true;
    seekTo(local(event).x);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(event);
    pointer.current = { x, y };
    if (scrubbing.current) {
      if (leftTheWindow(event)) {
        scrubbing.current = false;
        canvasRef.current!.releasePointerCapture(event.pointerId);
        return;
      }
      seekTo(x);
      setTip(null);
      return;
    }
    // Over the ruler, a click would land the playhead here: Edit.app's window makes the frame ready.
    if (y < TOP) preview.hint(Math.max(0, Math.round(xToFrame(x))));
    showTip(x, y);
    requestDraw();
  };

  const onPointerUp = () => {
    scrubbing.current = false;
  };

  const onWheel = (event: React.WheelEvent) => {
    const { x } = local(event);
    if (event.ctrlKey || event.metaKey || event.altKey) {
      zoomAround(x, Math.exp(-event.deltaY * 0.0035));
      return;
    }
    const { scrollX, scrollY } = useView.getState();
    const room = rows.content - (size.h - TOP - rows.held);
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey || room <= 0;
    if (sideways) {
      setView({ scrollX: scrollX + (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) });
      noteManualScroll();
    } else {
      const from = heldScroll(scrollY, rows.content, rows.held, size.h);
      useView.setState({ scrollY: Math.min(Math.max(0, room), Math.max(0, from + event.deltaY)) });
    }
    setTip(null);
  };

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel" data-v2-timeline>
      <div className="relative flex min-h-0 flex-1">
        <div className="relative shrink-0 overflow-hidden border-r border-line" style={{ width: LABELS }} aria-hidden>
          <div style={{ transform: `translateY(${-scrolledY}px)` }}>
            {rows.placed
              .filter((one) => !one.held)
              .map((one) => (
                <RowLabel key={one.row.kind} label={one.row.label} top={topOf(one, rows, 0)} height={one.h} />
              ))}
          </div>
          {/* The ruler's corner and the held Subtitles row stay where they are while the rows under them scroll. */}
          <div className="absolute inset-x-0 top-0 bg-panel" style={{ height: TOP + rows.held }}>
            {rows.placed
              .filter((one) => one.held)
              .map((one) => (
                <RowLabel key={one.row.kind} label={one.row.label} top={topOf(one, rows, 0)} height={one.h} held />
              ))}
          </div>
        </div>
        <div ref={wrapRef} className="relative min-w-0 flex-1">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 size-full touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              pointer.current = null;
              setTip(null);
              requestDraw();
            }}
            onWheel={onWheel}
            onContextMenu={(event) => event.preventDefault()}
          />
          {tip !== null && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 max-w-[320px] rounded-md border border-line bg-[#1b1b1b]/95 px-2 py-1 text-[11.5px] leading-snug text-fg shadow-lg"
              style={{ left: Math.min(tip.x + 12, Math.max(0, size.w - 330)), top: tip.y + 16 > size.h - 44 ? tip.y - 44 : tip.y + 16 }}
            >
              {tip.name !== "" && <div className="truncate">{tip.name}</div>}
              <div className="text-muted tabular">{tip.time}</div>
            </div>
          )}
        </div>
      </div>
      <ZoomBar width={view.lanes} header={LABELS} onFit={fit} onManual={noteManualScroll} />
    </section>
  );
}

function RowLabel({ label, top, height, held }: { label: string; top: number; height: number; held?: boolean }) {
  return (
    <div className="absolute inset-x-0 flex items-center pl-2.5 text-[11px] font-medium text-muted" style={{ top, height: Math.min(height, 32) }}>
      <span className={held ? "text-fg/80" : undefined}>{label}</span>
    </div>
  );
}
