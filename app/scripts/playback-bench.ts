// The page player measured on a real project, in headless Chrome over its
// debugging protocol (a visible tab is throttled): open to the first exact
// frame, 40 jumps across the edit, ~160 s played across ~30 cuts, an 8 s
// scrub drag and a small edit, cold (an empty server cache, a new browser
// profile) and then warm. Each run is one JSON file (schema below) for
// comparing heads: `bun scripts/playback-bench.ts --label before --project <id>`.
//
//   --api      the Edit server the page is served from (default http://127.0.0.1:7761: a bench server of its own,
//              never the dev server on :7700)
//   --reset    a shell command that empties that server's cache and starts it again (the cold run); without it,
//              cold is only a new browser profile
//   --phases   which of open,jumps,play,scrub,edit to run (default all)
//   --out      folder for the results (default ~/.edit-bench-results), written as page-<label>[-<project>].json
//
// Chrome is /usr/bin/google-chrome with Vulkan (the GPU's WebGPU adapter; headless alone gets SwiftShader). Every
// time is the page's own clock (performance.now()), read from hooks on the player (`window.__edit.preview`): each
// picture the engine draws, and each frame the rendered video presents (requestVideoFrameCallback).
import os from "node:os";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const API = args.get("api") ?? "http://127.0.0.1:7761";
const LABEL = args.get("label") ?? "run";
const PROJECT = args.get("project");
const RESET = args.get("reset") ?? null;
const OUT = args.get("out") ?? `${os.homedir()}/.edit-bench-results`;
const PHASES = new Set((args.get("phases") ?? "open,jumps,play,scrub,edit").split(","));
const PLAY_SECONDS = Number(args.get("play-seconds") ?? 160);
const JUMPS = Number(args.get("jumps") ?? 40);
/** Where the play starts (a frame): a jump there and play, as a person jumping to the B-roll does; else a stretch of ~30 cuts. */
const PLAY_FROM = args.has("play-from") ? Number(args.get("play-from")) : null;
const PORT = 9350 + Math.floor(Math.random() * 40);
const PROFILE = `${os.tmpdir()}/edit-playbench-chrome-${PORT}`;
if (PROJECT === undefined) throw new Error("bun scripts/playback-bench.ts --label <label> --project <id>");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = async (command: string) => (await Bun.$`bash -c ${command}`.quiet().nothrow()).stdout.toString().trim();
const machine = async () => ({ uptime: await sh("uptime"), load: os.loadavg().map((n) => +n.toFixed(2)), freeMemGB: +(os.freemem() / 2 ** 30).toFixed(1),
  gpu: await sh("nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader 2>/dev/null") });
const status = async () => fetch(`${API}/api/projects/${PROJECT}/playback`).then((answer) => answer.json(), () => null);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1) : null);
  return { n: values.length, p50: at(0.5), p90: at(0.9), max: sorted.length ? +sorted.at(-1)!.toFixed(1) : null, under100: values.filter((v) => v < 100).length };
};

/** In the page before anything of it runs: hooks on the player as soon as it's made (`window.__edit` is set by its module). */
const RUNTIME = String.raw`(() => {
  const B = window.__bench = { shown: [], marks: {}, target: null, video: null, waiting: 0 };
  const now = () => performance.now();
  let stored;
  const fps = () => { const s = B.p?.project?.settings; return s ? (s.fps_num && s.fps_den ? s.fps_num / s.fps_den : s.fps) : 30; };
  // A picture on screen: [time, frame, how ("live" drawn here, "smooth" the render's video), exact].
  B.record = (frame, via, exact) => {
    const t = now();
    B.shown.push([t, frame, via, exact]);
    if (B.shown.length > 40000) B.shown.splice(0, 10000);
    const target = B.target;
    if (target && frame === target.frame && exact && t >= target.t0) { B.target = null; target.done({ ms: t - target.t0, via }); }
  };
  const hook = (edit) => {
    const p = edit && edit.preview;
    if (!p || B.p) return;
    B.p = p; B.marks.hooked = now();
    const setProject = p.setProject;
    p.setProject = function (...given) { if (B.marks.project === undefined) B.marks.project = now(); return setProject.apply(this, given); };
    const draw = p.draw;
    p.draw = function (scene) {
      if (!B.patched && this.engine) {
        B.patched = true; B.marks.engine = now();
        const proto = Object.getPrototypeOf(this.engine);
        const render = proto.render;
        proto.render = function (frame) { const out = render.call(this, frame); B.rendering = frame; return out; };
      }
      B.rendering = null;
      const out = draw.call(this, scene);
      const frame = B.rendering;
      if (frame !== null && frame !== undefined) {
        // Exact: every picture the frame shows is its own (not a stand-in near it), checked at rest or for a target.
        let exact = null;
        if (!this.smoothShown && (!edit.playhead.playing || B.target)) {
          try { exact = this.picturesReady(this.sceneSources(frame)); } catch { exact = false; }
        }
        B.record(frame, "live", exact !== false);
      }
      return out;
    };
  };
  Object.defineProperty(window, "__edit", { configurable: true, get() { return stored; }, set(value) { stored = value; hook(value); } });
  // The rendered video's frames, as it presents them.
  const watchVideo = () => {
    const video = document.querySelector("video");
    if (!video || video === B.video) return;
    B.video = video;
    video.addEventListener("waiting", () => { if (B.p && B.p.smoothShown) B.waiting++; });
    const each = (_at, meta) => {
      if (B.p && B.p.smoothShown) B.record(Math.floor(meta.mediaTime * fps() + 0.01), "smooth", true);
      video.requestVideoFrameCallback(each);
    };
    video.requestVideoFrameCallback(each);
  };
  setInterval(watchVideo, 100);
  B.state = () => {
    const p = B.p, d = p ? p.diagnostics : null;
    return { frame: window.__edit?.playhead?.frame, playing: window.__edit?.playhead?.playing, framed: p?.framed, smoothShown: p?.smoothShown, smooth: p?.smooth ?? null,
      error: p?.error ?? null, buffering: p?.buffering, renderedFrame: d?.renderedFrame, videoMisses: d?.videoMisses, audioUnderruns: d?.audioUnderruns,
      decodedFrames: d?.decodedFrames, videoRequests: d?.videoRequests, audioRequests: d?.audioRequests, mediaReads: d?.mediaReads, waiting: B.waiting,
      streamWaiting: B.streamWaiting ?? 0, audio: d?.audioOutput };
  };
  /** Seeks to frame and resolves when that exact frame is on screen (or the timeout). */
  B.jump = (frame, timeout) => new Promise((resolve) => {
    const t0 = now();
    const timer = setTimeout(() => { if (B.target && B.target.frame === frame) { B.target = null; resolve({ ms: null, via: null }); } }, timeout);
    B.target = { frame, t0, done: (r) => { clearTimeout(timer); resolve(r); } };
    window.__edit.preview.seek(frame);
    // Already there (the same frame twice): drawn again, so it says so.
    window.__edit.preview.invalidate();
  });
})()`;

const chrome = Bun.spawn(["/usr/bin/google-chrome", "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--use-angle=vulkan",
  "--autoplay-policy=no-user-gesture-required", "--window-size=1600,1000", "--no-first-run", "about:blank"], { stdout: "ignore", stderr: "ignore" });

type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<any>; js: <T = any>(expression: string) => Promise<T>; close: () => void };
async function connect(): Promise<Cdp> {
  let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let tries = 0; tries < 80 && !targets.some((t) => t.type === "page"); tries++) {
    await sleep(250);
    targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((answer) => answer.json() as Promise<typeof targets>, () => []);
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let next = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id !== undefined) pending.get(m.id)?.(m);
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve) => { const n = ++next; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async (expression: string) => {
    const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (answer.result?.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${JSON.stringify(answer.result.exceptionDetails).slice(0, 400)}`);
    return answer.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: RUNTIME });
  return { send, js, close: () => ws.close() };
}

/** Opens the project in the page; the open's timings (page clock, from navigation). */
async function open(cdp: Cdp, timeoutMs = 120_000) {
  await cdp.send("Page.navigate", { url: `${API}/p/${PROJECT}` });
  const began = performance.now();
  let first: any = null;
  while (performance.now() - began < timeoutMs) {
    await sleep(100);
    first = await cdp.js(`(() => { const B = window.__bench; if (!B || !B.p || !window.__edit.playhead) return null;
      const at = Math.floor(window.__edit.playhead.frame);
      const hit = B.shown.find(([, frame, , exact]) => frame === at && exact);
      return hit ? { ms: hit[0], frame: at, via: hit[2], marks: B.marks, state: B.state() } : null; })()`).catch(() => null);
    if (first) break;
  }
  const marks = first?.marks ?? (await cdp.js("window.__bench?.marks").catch(() => null));
  return { firstExactFrameMs: first ? +first.ms.toFixed(0) : null, frame: first?.frame ?? null, via: first?.via ?? null, marks, timedOut: first === null };
}

/** The edit's facts the runs need, from the page's store. */
async function facts(cdp: Cdp) {
  return cdp.js(`(() => { const p = window.__edit.useEditor.getState().project; const fps = p.settings.fps;
    const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
    const video = p.clips.filter((c) => c.type === "video" && !hidden.has(c.track));
    const duration = Math.max(...p.clips.map((c) => c.start + c.duration));
    return { id: p.id, name: p.name, hq: p.hq === true, fps, clips: p.clips.length, media: p.media.length, durationFrames: duration,
      cuts: [...new Set(video.map((c) => c.start))].sort((a, b) => a - b),
      videoRanges: video.map((c) => [c.start, c.start + c.duration]) }; })()`);
}

async function jumps(cdp: Cdp, positions: number[]) {
  const results: { frame: number; ms: number | null; via: string | null }[] = [];
  for (const frame of positions) {
    const result = await cdp.js<{ ms: number | null; via: string | null }>(`window.__bench.jump(${frame}, 10000)`);
    results.push({ frame, ms: result.ms === null ? null : +result.ms.toFixed(1), via: result.via });
    await sleep(1000);
  }
  const landed = results.filter((r) => r.ms !== null).map((r) => r.ms!);
  return { ...stats(landed), timeouts: results.filter((r) => r.ms === null).length, viaSmooth: results.filter((r) => r.via === "smooth").length, results };
}

/** Plays `seconds` from `start` (landed and rested first): what was shown, how it held, and how it sounded. */
async function play(cdp: Cdp, start: number, seconds: number, fps: number) {
  const landed = await cdp.js(`window.__bench.jump(${start}, 20000)`);
  await sleep(1500);
  const before = await cdp.js("window.__bench.state()");
  const t0 = await cdp.js(`(() => { const B = window.__bench; B.streamWaiting = 0; const sound = B.p.streamSound;
    if (sound && !sound.__benched) { sound.__benched = true; sound.addEventListener("waiting", () => B.streamWaiting++); }
    const t = performance.now(); window.__edit.preview.play(); return t; })()`);
  await sleep(seconds * 1000);
  const t1 = await cdp.js("(() => { const t = performance.now(); window.__edit.preview.pause(); return t; })()");
  const after = await cdp.js("window.__bench.state()");
  const shown: [number, number, string, boolean][] = await cdp.js(`window.__bench.shown.filter(([t]) => t >= ${t0} && t <= ${t1})`);
  const moving = shown.find(([, frame]) => frame > start);
  const frames = new Set<number>();
  const gaps: number[] = [];
  let last: number | null = null;
  for (const [t, frame] of shown) {
    if (frame <= start && moving !== undefined && t < moving[0]) continue;
    frames.add(frame);
    if (last !== null) gaps.push(t - last);
    last = t;
  }
  const playedMs = (t1 - (moving?.[0] ?? t1));
  const end = shown.at(-1)?.[1] ?? start;
  return {
    start, seconds, cuts: null as number | null, landedMs: landed.ms === null ? null : +landed.ms.toFixed(0),
    startMs: moving ? +(moving[0] - t0).toFixed(0) : null,
    framesShown: frames.size, framesExpected: Math.round((playedMs / 1000) * fps), framesAdvanced: end - start,
    holdsOver50: gaps.filter((g) => g > 50).length, holdsOver100: gaps.filter((g) => g > 100).length, longestHoldMs: gaps.length ? +Math.max(...gaps).toFixed(0) : null,
    smoothShare: shown.length ? +(shown.filter(([, , via]) => via === "smooth").length / shown.length).toFixed(3) : 0,
    videoMisses: (after.videoMisses ?? 0) - (before.videoMisses ?? 0), audioUnderruns: (after.audioUnderruns ?? 0) - (before.audioUnderruns ?? 0),
    renderWaits: (after.waiting ?? 0) - (before.waiting ?? 0), soundWaits: after.streamWaiting ?? 0,
    mediaReads: after.mediaReads, render: await status(),
  };
}

/** A drag: a position every 33 ms for `seconds`, `step` frames apart. */
async function scrub(cdp: Cdp, from: number, step: number, seconds: number) {
  const landed = await cdp.js(`window.__bench.jump(${from}, 20000)`);
  await sleep(1000);
  const run = await cdp.js(`(async () => { const B = window.__bench; const asked = []; const t0 = performance.now();
    for (let i = 0; performance.now() - t0 < ${seconds * 1000}; i++) { const frame = ${from} + i * ${step}; asked.push([performance.now(), frame]); window.__edit.preview.seek(frame);
      await new Promise((r) => setTimeout(r, 33)); }
    const lastFrame = asked.at(-1)[1], lastAt = asked.at(-1)[0];
    const settled = await new Promise((resolve) => { const t = performance.now(); const look = () => {
      const hit = B.shown.find(([at, frame, , exact]) => at >= lastAt && frame === lastFrame && exact);
      if (hit) resolve(hit[0] - lastAt); else if (performance.now() - t > 15000) resolve(null); else setTimeout(look, 10); }; look(); });
    const during = B.shown.filter(([at]) => at >= t0 && at <= lastAt + 33);
    const askedSet = new Set(asked.map(([, f]) => f));
    const shownAsked = new Set(during.filter(([, f]) => askedSet.has(f)).map(([, f]) => f));
    const gaps = []; for (let i = 1; i < during.length; i++) gaps.push(during[i][0] - during[i - 1][0]);
    return { asked: asked.length, shownPositions: shownAsked.size, pictures: during.length, smooth: during.filter(([, , via]) => via === "smooth").length,
      lastMs: settled, longestGapMs: gaps.length ? Math.max(...gaps) : null }; })()`);
  return { from, step, seconds, landedMs: landed.ms === null ? null : +landed.ms.toFixed(0), ...run, lastMs: run.lastMs === null ? null : +run.lastMs.toFixed(0), longestGapMs: run.longestGapMs === null ? null : +run.longestGapMs.toFixed(0) };
}

/** One clip (and its linked sound) moved a few frames into the gap after it, as a drag would, then that stretch played every few seconds until it plays clean. */
async function edit(cdp: Cdp, fps: number, maxSeconds = 600) {
  const moved = await cdp.js(`(() => { const state = window.__edit.useEditor.getState(); const p = state.project;
    const byTrack = new Map(); for (const c of p.clips) { const l = byTrack.get(c.track) ?? []; l.push(c); byTrack.set(c.track, l); }
    for (const l of byTrack.values()) l.sort((a, b) => a.start - b.start);
    const room = (c) => { const l = byTrack.get(c.track); const i = l.indexOf(c); const next = l[i + 1]; return next ? next.start - (c.start + c.duration) : Infinity; };
    const mid = Math.max(...p.clips.map((c) => c.start + c.duration)) / 3;
    const pick = p.clips.filter((c) => c.type === "video" && c.start > mid && room(c) >= 12 && p.clips.filter((o) => o.link && o.link === c.link && o !== c).every((o) => room(o) >= 12))
      .sort((a, b) => a.start - b.start)[0];
    if (!pick) return null;
    const ids = new Set(p.clips.filter((c) => c === pick || (pick.link && c.link === pick.link)).map((c) => c.id));
    const at = performance.now();
    state.edit((draft) => { for (const c of draft.clips) if (ids.has(c.id)) c.start += 6; });
    return { clip: pick.id, linked: ids.size, start: pick.start + 6, duration: pick.duration, at }; })()`);
  if (moved === null) return { moved: null };
  const began = performance.now();
  const tries: Record<string, unknown>[] = [];
  let clean: number | null = null;
  const from = Math.max(0, moved.start - Math.round(fps * 2));
  while ((performance.now() - began) / 1000 < maxSeconds) {
    const played = await play(cdp, from, 6, fps);
    const since = +((performance.now() - began) / 1000).toFixed(1);
    tries.push({ since, smoothShare: played.smoothShare, holdsOver50: played.holdsOver50, longestHoldMs: played.longestHoldMs, framesShown: played.framesShown, framesExpected: played.framesExpected, startMs: played.startMs, render: played.render?.state });
    if (played.holdsOver50 === 0 && played.framesShown >= played.framesExpected * 0.95 && (played.startMs ?? 9999) < 250) { clean = since; break; }
    await sleep(4000);
  }
  return { moved, cleanAfterSeconds: clean, tries };
}

/** Where ~30 cuts fall in `seconds` (the earliest such stretch), for the play. */
function stretch(f: Awaited<ReturnType<typeof facts>>, seconds: number) {
  const span = Math.round(seconds * f.fps);
  let best = { start: 0, cuts: 0 };
  for (let start = 0; start + span <= f.durationFrames; start += f.fps * 10) {
    const cuts = f.cuts.filter((c: number) => c > start && c < start + span).length;
    if (Math.abs(cuts - 30) < Math.abs(best.cuts - 30)) best = { start, cuts };
    if (cuts >= 28 && cuts <= 34) break;
  }
  return best;
}

/** Jump targets spread evenly across the edit, each moved onto a picture (inside a video clip). */
function spread(f: Awaited<ReturnType<typeof facts>>, count: number) {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let frame = Math.floor(((i + 0.5) / count) * f.durationFrames);
    const inside = f.videoRanges.find(([a, b]: number[]) => frame >= a! && frame < b!);
    if (!inside) {
      const next = f.videoRanges.filter(([a]: number[]) => a! >= frame).sort((x: number[], y: number[]) => x[0]! - y[0]!)[0];
      if (next) frame = next[0]! + 5;
    }
    out.push(frame);
  }
  return out;
}

const result: Record<string, any> = {
  label: LABEL, startedAt: new Date().toISOString(), api: API,
  git: { head: await sh("git rev-parse --short HEAD"), subject: await sh("git log -1 --format=%s | cut -c1-120"), dirty: (await sh("git status --porcelain -- apps/web apps/server")).split("\n").filter(Boolean) },
  machine: { host: os.hostname(), start: await machine() }, chrome: await sh("/usr/bin/google-chrome --version"),
};
try {
  if (RESET !== null) {
    console.error("cold: resetting the server");
    await sh(RESET);
  }
  for (let tries = 0; tries < 120 && !(await fetch(`${API}/api/projects`).then((a) => a.ok, () => false)); tries++) await sleep(500);
  const cdp = await connect();
  // Headless Chrome's GPU process often fails its first Vulkan surface and starts again; an adapter asked for meanwhile
  // is none, and the engine says "Preview failed to start". Asked for here until the GPU's comes, as a running browser has it.
  await cdp.send("Page.navigate", { url: `${API}/favicon.svg` });
  for (let tries = 0; tries < 40; tries++) {
    await sleep(500);
    result.gpu = await cdp.js(`(navigator.gpu ? navigator.gpu.requestAdapter({ powerPreference: "high-performance" }) : Promise.resolve(null)).then((a) => a ? { vendor: a.info.vendor, architecture: a.info.architecture, tries: ${tries} } : null)`).catch(() => null);
    if (result.gpu?.vendor === "nvidia") break;
  }
  const session = async (name: "cold" | "warm") => {
    console.error(`${name}: open`);
    result.open ??= {};
    result.open[name] = await open(cdp);
    result.open[name].render = await status();
    result.project ??= await facts(cdp);
    const f = result.project;
    const { cuts: _c, videoRanges: _v, ...shown } = f;
    result.projectSummary = shown;
    result.open[name].machine = await machine();
    if (PHASES.has("jumps")) {
      console.error(`${name}: jumps`);
      result.jumps ??= {};
      result.jumps[name] = await jumps(cdp, spread(f, JUMPS));
      result.jumps[name].render = await status();
    }
    if (PHASES.has("play")) {
      console.error(`${name}: play`);
      const where = PLAY_FROM === null ? stretch(f, PLAY_SECONDS) : { start: PLAY_FROM, cuts: f.cuts.filter((c: number) => c > PLAY_FROM && c < PLAY_FROM + PLAY_SECONDS * f.fps).length };
      result.play ??= {};
      result.play[name] = { ...(await play(cdp, where.start, PLAY_SECONDS, f.fps)), cuts: where.cuts, machine: await machine() };
    }
    if (PHASES.has("scrub")) {
      console.error(`${name}: scrub`);
      result.scrub ??= {};
      result.scrub[name] = await scrub(cdp, Math.floor(f.durationFrames * 0.6), 10, 8);
    }
  };
  await session("cold");
  await session("warm");
  if (PHASES.has("edit")) {
    console.error("edit");
    result.edit = await edit(cdp, result.project.fps);
  }
  result.log = await cdp.js(`(() => { try { return JSON.parse(localStorage.getItem("edit.timings") ?? "null"); } catch { return null; } })()`).catch(() => null);
  cdp.close();
} catch (error) {
  result.error = String(error);
  console.error(error);
} finally {
  chrome.kill();
  result.machine.end = await machine();
  result.finishedAt = new Date().toISOString();
  if (result.project) { delete result.project.cuts; delete result.project.videoRanges; }
  await Bun.$`mkdir -p ${OUT} && rm -rf ${PROFILE}`.quiet().nothrow();
  // One file per label, a run per project in it (another run of the same project replaces its own).
  const file = `${OUT}/page-${LABEL}.json`;
  const before = await Bun.file(file).json().catch(() => null);
  const runs = { ...(before?.schema === 1 ? before.runs : {}), [PROJECT]: result };
  await Bun.write(file, JSON.stringify({ schema: 1, label: LABEL, updatedAt: new Date().toISOString(), runs }, null, 2));
  console.log(file);
}
