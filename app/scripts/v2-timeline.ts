// The V2 timeline seen for real (Nov 21), as scripts/acceptance.ts starts Edit:
// this checkout's server with a home of its own, signed out and pointed at no
// relay (nothing reaches dev's or prod's cloud), on a port of its own (7797),
// serving this checkout's page built into OUT (never apps/web/dist, which other
// work in this checkout serves). It makes footage, sounds, a rendered see-through
// graphic and a graphic not rendered yet with FFmpeg's test sources, imports
// them, lays an Edit V2 project of every kind of thing (subtitles at opacity 0,
// captions, cut-ins, footage and its sound, a look, a blur on the footage,
// voice-over, music and sound effects), opens it in headless Chrome and saves:
//
//   0-off.png          the player as it opens: no timeline (the choice is off)
//   1-whole.png        turned on: the whole edit fitted to the width
//   2-closer.png       zoomed in on the playhead
//   3-words.png        closest: a subtitle's words in its block
//   4-scrolled.png     the rows scrolled down: Subtitles held under the ruler
//   5-big.png          a 3,173-clip, 2-hour edit, fitted
//
// and prints the time to a screenful of pictures (first and second opening)
// and the lanes' redraw time in Chrome. Run it under a memory cap:
//
//   systemd-run --user --scope -q -p MemoryMax=4G bun scripts/v2-timeline.ts
//
// `--no-build` reuses the page built last time. `--serve <dir> …` is how it
// starts the server (the page served from <dir>), not for running by hand.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");

if (process.argv[2] === "--serve") {
  const dir = process.argv[3]!;
  process.argv.splice(2, 2);
  const assets = await import(join(APP, "apps/server/src/http/assets.ts"));
  assets.useAssets(assets.diskAssets(dir));
  await import(join(APP, "apps/server/src/main.ts"));
} else {
  await check();
}

async function check(): Promise<void> {
  const OUT = process.env.OUT ?? join(tmpdir(), "edit-v2-timeline");
  const PORT = 7797;
  const API = `http://127.0.0.1:${PORT}`;
  const CDP_PORT = 9347;
  const WEB = join(OUT, "web");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  mkdirSync(OUT, { recursive: true });
  const say = (line: string) => console.log(line);

  if (!process.argv.includes("--no-build") || !existsSync(join(WEB, "index.html"))) {
    const built = Bun.spawnSync([join(APP, "apps/web/node_modules/.bin/vite"), "build", "--outDir", WEB, "--emptyOutDir"], { cwd: join(APP, "apps/web"), stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`the page didn't build: ${built.stderr.toString().slice(-800)}`);
    say(`page built into ${WEB}`);
  }

  const home = mkdtempSync(join(tmpdir(), "edit-v2-timeline-home-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    EDIT_KEYCHAIN_FILE: join(home, "keychain.json"),
    EDIT_NO_BROWSER: "1",
    EDIT_CLAUDE_MAINTENANCE: "0",
    EDIT_ACCOUNTS_URL: "http://127.0.0.1:9",
    EDIT_RELAY_URL: "http://127.0.0.1:9",
  };
  delete env.EDIT_RELAY_TOKEN;
  const running: { server?: ReturnType<typeof Bun.spawn>; chrome?: ReturnType<typeof Bun.spawn> } = {};
  const stop = () => {
    running.chrome?.kill();
    running.server?.kill();
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(1);
  });

  try {
    const log = Bun.file(join(OUT, "server.log")).writer();
    running.server = Bun.spawn(["bun", import.meta.path, "--serve", WEB, "serve", "--home", home, "--port", String(PORT)], { env, stdout: "pipe", stderr: "pipe" });
    for (const stream of [running.server.stdout, running.server.stderr] as ReadableStream<Uint8Array>[]) {
      void (async () => {
        for await (const chunk of stream) log.write(chunk);
        void log.flush();
      })();
    }
    for (let tries = 0; ; tries++) {
      const health = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) }).then((answer) => answer.text(), () => "");
      if (health.includes('"name":"edit"')) break;
      if (tries > 120) throw new Error("the server didn't answer within 60 s (server.log)");
      await sleep(500);
    }
    say("server up");

    const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const answer = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await answer.text();
      if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status} ${text.slice(0, 400)}`);
      return JSON.parse(text) as T;
    };

    // ---- The footage, the sounds and the graphics ----
    const footage = join(home, "footage");
    mkdirSync(footage, { recursive: true });
    const make = (file: string, args: string[]) => {
      const done = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args, join(footage, file)]);
      if (done.exitCode !== 0) throw new Error(`${file}: ${done.stderr.toString().slice(-300)}`);
      return join(footage, file);
    };
    const files = {
      street: make("street.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000", "-t", "60", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "aac", "-af", "volume='2+5*abs(sin(t*0.7))':eval=frame"]),
      kitchen: make("kitchen.mp4", ["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.4:sample_rate=48000", "-t", "40", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "aac", "-af", "volume='0.2+0.8*abs(sin(t*2))':eval=frame"]),
      music: make("Tension - Blue Saga.m4a", ["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "90", "-af", "volume='4+3*sin(t*1.3)':eval=frame", "-c:a", "aac"]),
      whoosh: make("Whoosh, Dark, Big.wav", ["-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.9:duration=1.5", "-af", "afade=t=out:st=0.2:d=1.3"]),
      click: make("Mouse Click.wav", ["-f", "lavfi", "-i", "sine=frequency=1800:duration=0.15"]),
      voice: make("Story (voice-over) - Cut-in 1.m4a", ["-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.5:duration=12", "-af", "volume='abs(sin(t*6))':eval=frame", "-c:a", "aac"]),
      card: make("effect-name-card-k1.mp4", ["-f", "lavfi", "-i", "color=c=0x7c3aed:size=1280x720:rate=30:duration=6", "-f", "lavfi", "-i", "color=c=white:size=1280x720:rate=30:duration=6", "-filter_complex", "[0:v]drawtext=text='NAME CARD':fontcolor=white:fontsize=120:x=(w-tw)/2:y=(h-th)/2[top];[top][1:v]vstack=inputs=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15"]),
      still: make("clear-still.png", ["-f", "lavfi", "-i", "color=c=black@0:size=1280x720,format=rgba", "-frames:v", "1"]),
    };
    const created = await api<{ project: { id: string } }>("POST", "/api/projects", { name: "V2 timeline check", width: 1280, height: 720, fps: 30 });
    const id = created.project.id;
    await api("POST", `/api/projects/${id}/import`, { paths: Object.values(files) });
    for (let tries = 0; ; tries++) {
      const status = await api<{ media: Record<string, { proxy: string }> }>("GET", `/api/projects/${id}/media-status`);
      const all = Object.values(status.media);
      if (all.length === Object.keys(files).length && all.every((one) => one.proxy === "ready" || one.proxy === "skipped" || one.proxy === "failed")) break;
      if (tries > 240) throw new Error("the previews weren't made within 120 s");
      await sleep(500);
    }
    say("imported");

    // ---- The edit, as an Edit V2 project lays it ----
    type Any = Record<string, any>;
    const live = await api<{ rev: number; project: Any }>("GET", `/api/projects/${id}`);
    const project = live.project;
    const mediaOf = (path: string) => project.media.find((one: Any) => one.path === path || one.path.endsWith(`/${path.split("/").pop()}`))!;
    const m = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, mediaOf(path)])) as Record<keyof typeof files, Any>;
    m.music.library = "music";
    m.whoosh.library = "sfx";
    m.click.library = "sfx";
    // The rendered graphic: see-through (its picture above its mask), its render's version named.
    Object.assign(m.card, { effect: "name-card", effect_key: "k1", stacked_alpha: true, height: 720, name: "name-card" });
    // The graphic whose code is newer than its render: its clear still stands in.
    Object.assign(m.still, { effect: "map", name: "map" });
    project.hq = true;
    const tracks = ["v1", "v2", "v3", "v4", "v5", "subs", "a1", "a2", "a3", "a4"];
    project.tracks = tracks.map((track) => ({ id: track, kind: track.startsWith("a") ? "audio" : "video", hidden: false, muted: false, locked: false, ...(track === "subs" ? { subtitles: true } : {}) }));
    const clips: Any[] = [];
    let n = 0;
    const base = (track: string, start: number, duration: number, fields: Any) => ({ id: `k${n++}`, track, start, duration, color: "blue", fade_in: 0, fade_out: 0, ...fields });
    const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
    const picture = (track: string, start: number, duration: number, media: Any, sourceIn: number, name?: string, extra: Any = {}) =>
      clips.push(base(track, start, duration, { type: "video", media: media.id, source_in: sourceIn, speed: 1, opacity: 1, transform, ...(name ? { name } : {}), ...extra }));
    const sound = (track: string, start: number, duration: number, media: Any, sourceIn: number, volume = 0, name?: string) =>
      clips.push(base(track, start, duration, { type: "audio", media: media.id, source_in: sourceIn, speed: 1, volume_db: volume, ...(name ? { name } : {}) }));
    const words = (track: string, start: number, duration: number, text: string, opacity: number, name: string) =>
      clips.push(base(track, start, duration, { type: "text", text, opacity, transform, name, style: { font: "Inter", weight: 700, size: 54, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15, max_width: 1500 }, animation: { preset: "none", duration: 12, stagger: 1.5 } }));
    // Footage end to end (with its sound), cut-ins over it, a look over the cut-ins, a blur on the footage.
    const shots: [Any, number, number][] = [[m.street, 0, 12], [m.kitchen, 2, 9], [m.street, 20, 14], [m.kitchen, 15, 10], [m.street, 40, 15]];
    let at = 0;
    for (const [media, from, seconds] of shots) {
      picture("v1", at * 30, seconds * 30, media, from);
      sound("a1", at * 30, seconds * 30, media, from, -6);
      at += seconds;
    }
    picture("v2", 14 * 30, 5 * 30, m.kitchen, 30, "Cut-in 1 · B-roll: the kitchen camera");
    picture("v2", 33 * 30, 4 * 30, m.street, 50, "Cut-in 2 · B-roll: the street");
    clips.push(base("v3", 14 * 30, 5 * 30, { type: "adjustment", grade: { exposure: 0, contrast: 0, saturation: -0.6, temperature: 0, vignette: 0.3 }, opacity: 1, name: "Cut-in 1 · B-roll look" }));
    clips.push(base("v3", 3 * 30, 6 * 30, { type: "adjustment", grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 }, blur: { radius: 30, y: 300, width: 900, height: 80 }, opacity: 1, name: "Text blur · c12" }));
    picture("v4", 1 * 30, 5 * 30, m.card, 0, "Name pop-up: Officer Diaz");
    picture("v5", 26 * 30, 4 * 30, m.still, 0, "Date map · the street");
    picture("v4", 27 * 30, 6 * 30, m.card, 0, "Name pop-up: Kelly");
    words("v3", 10 * 30, 2 * 30, "Stop screaming at me", 1, "Caption · Michael");
    // Subtitles, most drawn by an effect (their text at opacity 0), a line every second or two.
    const lines = ["You cheated and I found out.", "Are you okay?", "Step out of the car for me.", "I didn't do anything!", "Hands where I can see them.", "He's a good guy.", "What happened from there?", "She threw everything everywhere, so.", "Hi, ma'am.", "Fine, yourself?"];
    for (let line = 0, time = 0; time < at - 2; line++) {
      const seconds = 1.2 + (line % 3) * 0.6;
      words("subs", Math.round(time * 30), Math.round(seconds * 30) - 3, lines[line % lines.length]!, line % 4 === 0 ? 1 : 0, "Subtitle · Officer");
      time += seconds + 0.25;
    }
    sound("a2", 13 * 30, 12 * 30, m.voice, 0, 0, "Voice-over");
    sound("a3", 0, 60 * 30, m.music, 5, -18);
    for (const second of [1, 14, 26, 33, 46]) sound("a4", second * 30 - 6, 45, m.whoosh, 0, -3);
    for (const second of [8, 9, 21, 40]) sound("a4", second * 30, 5, m.click, 0, -8);
    project.clips = clips;
    await api("PUT", `/api/projects/${id}`, { project, base_rev: live.rev });
    say(`laid ${clips.length} clips, ${at} s`);

    // A 3,173-clip, 2-hour edit of the same files, for the redraw time.
    const bigId = (await api<{ project: { id: string } }>("POST", "/api/projects", { name: "V2 timeline, 3,173 clips", width: 1280, height: 720, fps: 30 })).project.id;
    const bigLive = await api<{ rev: number; project: Any }>("GET", `/api/projects/${bigId}`);
    const big = { ...bigLive.project, hq: true, media: project.media, tracks: project.tracks };
    const bigClips: Any[] = [];
    const end = 126 * 60 * 30;
    const add = (fields: Any) => bigClips.push({ id: `b${bigClips.length}`, color: "blue", fade_in: 0, fade_out: 0, ...fields });
    const shot = Math.floor(end / 148);
    for (let one = 0; one < 148; one++) {
      const media = one % 2 === 0 ? m.street : m.kitchen;
      const length = Math.min(shot, Math.floor(media.duration * 30) - 30);
      add({ track: "v1", start: one * shot, duration: length, type: "video", media: media.id, source_in: 0, speed: 1, opacity: 1, transform });
      add({ track: "a1", start: one * shot, duration: length, type: "audio", media: media.id, source_in: 0, speed: 1, volume_db: -6 });
    }
    for (let one = 0; one < 113; one++) add({ track: "v2", start: one * shot + 300, duration: 240, type: "video", media: m.kitchen.id, source_in: 3, speed: 1, opacity: 1, transform, name: `Cut-in ${one + 1} · B-roll` });
    for (let one = 0; one < 240; one++) add({ track: one % 2 ? "v4" : "v5", start: one * 940 + 30, duration: 120, type: "video", media: m.card.id, source_in: 0, speed: 1, opacity: 1, transform, name: `Graphic ${one}` });
    for (let one = 0; one < 100; one++) add({ track: "v3", start: one * 2260, duration: 300, type: "adjustment", grade: { exposure: 0, contrast: 0, saturation: -0.6, temperature: 0, vignette: 0.3 }, opacity: 1, name: "B-roll look" });
    const every = Math.floor(end / 2028);
    for (let one = 0; one < 2028; one++) add({ track: "subs", start: one * every, duration: every - 4, type: "text", text: lines[one % lines.length], opacity: 0, transform, name: "Subtitle · Officer", style: { font: "Inter", weight: 700, size: 54, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15, max_width: 1500 }, animation: { preset: "none", duration: 12, stagger: 1.5 } });
    for (let one = 0; one < 40; one++) add({ track: "a2", start: one * 5600, duration: 300, type: "audio", media: m.voice.id, source_in: 0, speed: 1, volume_db: 0, name: "Voice-over" });
    for (let one = 0; one < 60; one++) add({ track: "a3", start: one * 3780, duration: 2400, type: "audio", media: m.music.id, source_in: 0, speed: 1, volume_db: -18 });
    while (bigClips.length < 3173) add({ track: "a4", start: Math.floor(((bigClips.length * 7919) % end)), duration: 40, type: "audio", media: m.whoosh.id, source_in: 0, speed: 1, volume_db: -3 });
    big.clips = bigClips;
    await api("PUT", `/api/projects/${bigId}`, { project: big, base_rev: bigLive.rev });
    say(`laid the big edit: ${bigClips.length} clips`);

    // ---- Headless Chrome ----
    const chrome = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => existsSync(path));
    if (chrome === undefined) throw new Error("no Chrome here");
    const profile = join(OUT, "profile");
    rmSync(profile, { recursive: true, force: true });
    running.chrome = Bun.spawn([chrome, "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "--hide-scrollbars", "about:blank"], { stdout: "ignore", stderr: "ignore" });
    let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
    for (let tries = 0; tries < 60 && targets.length === 0; tries++) {
      await sleep(500);
      targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((answer) => answer.json() as Promise<typeof targets>, () => []);
    }
    const target = targets.find((one) => one.type === "page")!;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    let next = 0;
    const pending = new Map<number, (value: any) => void>();
    const errors: string[] = [];
    let onPaused: ((params: { requestId: string }) => Promise<void>) | null = null;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) pending.get(message.id)?.(message);
      if (message.method === "Fetch.requestPaused") void onPaused?.(message.params);
      if (message.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).slice(0, 300));
    };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve) => {
        const one = ++next;
        pending.set(one, resolve);
        ws.send(JSON.stringify({ id: one, method, params }));
      });
    const js = async (expression: string): Promise<any> => {
      const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (answer.result?.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${JSON.stringify(answer.result.exceptionDetails).slice(0, 400)}`);
      return answer.result?.result?.value;
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/account", requestStage: "Response" }] });
    onPaused = async (params) => {
      const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: params.requestId }).then((answer) => answer.result);
      const account = JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString() : body);
      account.required = false;
      await send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(account)).toString("base64") });
    };
    const shotPng = async (name: string) => {
      const { result } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, "base64"));
      say(`saved ${join(OUT, `${name}.png`)}`);
    };
    const until = async (expression: string, ms: number) => {
      const started = performance.now();
      while (performance.now() - started < ms) {
        if (await js(expression).catch(() => false)) return performance.now() - started;
        await sleep(50);
      }
      return null;
    };
    /** Opens the editor; resolves with when it was asked for (performance.now()). */
    const openEditor = async (project: string, settle = 1200) => {
      const asked = performance.now();
      await send("Page.navigate", { url: `${API}/p/${project}` });
      if ((await until(`Boolean(window.__edit?.preview) && window.__edit.useEditor?.getState().project?.id === ${JSON.stringify(project)}`, 30_000)) === null) throw new Error("the editor didn't open");
      await sleep(settle);
      return asked;
    };
    /** From now, how long until everything the timeline draws is pictured (nothing waiting). */
    const toPictures = async (since = performance.now()) => {
      const waited = await until("window.__edit.timelineMedia && window.__edit.timelineDrawn.count > 0 && window.__edit.timelineMedia.waiting() === 0", 60_000);
      return waited === null ? null : performance.now() - since;
    };
    const view = (state: string) => js(`(window.__edit.useView.setState(${state}), true)`);
    const press = async (key: string, code: string, keyCode: number) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key, windowsVirtualKeyCode: keyCode });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    };
    const fit = () => press("\\", "Backslash", 220);

    await openEditor(id);
    await shotPng("0-off");
    say(`off: timeline on the page: ${await js("document.querySelector('[data-v2-timeline]') !== null")}, frame/peak asks: ${await js("performance.getEntriesByType('resource').filter((one) => /\\/(frames|peaks)/.test(one.name)).length")}`);
    await js("document.querySelector('button[aria-label=\"Timeline (T)\"]').click(), true");
    const first = await toPictures();
    say(`turned on: a screenful of pictures and waveforms in ${first === null ? "over 60 s" : `${(first / 1000).toFixed(2)} s`} (made here the first time)`);
    await sleep(300);
    await shotPng("1-whole");
    // Closer: zoomed in about the playhead, as = does.
    await js("window.__edit.preview.seek(13 * 30), true");
    for (let one = 0; one < 4; one++) await press("=", "Equal", 187);
    await toPictures();
    await sleep(300);
    await shotPng("2-closer");
    // Closest: a subtitle's words in their block.
    await view("{ ppf: 18, scrollX: 13 * 30 * 18 - 300 }");
    await toPictures();
    await sleep(300);
    await shotPng("3-words");
    // The rows scrolled down: Subtitles stay under the ruler.
    await view("{ ppf: 3, scrollX: 0, scrollY: 140 }");
    await toPictures();
    await sleep(300);
    await shotPng("4-scrolled");
    // Hovering a block: its name and its time.
    await view("{ scrollY: 0 }");
    await fit();
    await sleep(200);
    const box = await js("(() => { const r = document.querySelector('[data-v2-timeline] canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()");
    const graphicsY = await js("(() => { const labels = [...document.querySelectorAll('[data-v2-timeline] [aria-hidden] div')]; const one = labels.find((l) => l.textContent === 'Graphics'); return one ? one.getBoundingClientRect().top : null; })()");
    // The graphic not rendered yet (26 s to 30 s of the minute), on its lane.
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.w * (27.5 / 61.2), y: (graphicsY ?? box.y + 60) + 10 });
    await sleep(300);
    await shotPng("7-hover");
    // The lanes' redraw time in Chrome: a full redraw at each of 20 scroll positions.
    const redraw = async () =>
      js(`(async () => { const times = []; for (let i = 0; i < 20; i++) { window.__edit.useView.setState({ scrollX: window.__edit.useView.getState().scrollX + (i % 2 ? -1 : 1) }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); times.push(window.__edit.timelineDrawn.lanesMs); } times.sort((a, b) => a - b); return { median: times[10], worst: times[19] }; })()`);
    await view("{ scrollY: 0 }");
    await fit();
    say(`small edit, lanes redrawn: ${JSON.stringify(await redraw())} ms`);

    // Opened again: everything from disk and the browser (counted from asking for the editor: the page's own opening included).
    const reopened = await openEditor(id, 0);
    const again = await toPictures(reopened);
    say(`opened again: the editor opened and its timeline pictured in ${again === null ? "over 60 s" : `${(again / 1000).toFixed(2)} s`} from asking for the page`);

    // The 3,173-clip edit.
    await openEditor(bigId);
    const bigFirst = await toPictures();
    say(`3,173 clips, fitted: pictured in ${bigFirst === null ? "over 60 s" : `${(bigFirst / 1000).toFixed(2)} s`}`);
    say(`3,173 clips, fitted, lanes redrawn: ${JSON.stringify(await redraw())} ms`);
    await sleep(300);
    await shotPng("5-big");
    await view("{ ppf: 2, scrollX: 60 * 60 * 30 * 2 }");
    await toPictures();
    say(`3,173 clips, closer, lanes redrawn: ${JSON.stringify(await redraw())} ms`);
    await shotPng("6-big-closer");
    // A V1 project (its timeline on the same loader since Nov 21): its strips and waveforms, as it always looked.
    const v1Id = (await api<{ project: { id: string } }>("POST", "/api/projects", { name: "V1 check", width: 1280, height: 720, fps: 30 })).project.id;
    const v1Live = await api<{ rev: number; project: Any }>("GET", `/api/projects/${v1Id}`);
    const v1 = { ...v1Live.project, media: project.media };
    const video1 = v1.tracks.find((one: Any) => one.kind === "video").id;
    const audio1 = v1.tracks.find((one: Any) => one.kind === "audio").id;
    v1.clips = shots.map(([media, from, seconds], index) => [index, media, from, seconds] as const).flatMap(([index, media, from, seconds]) => {
      const start = shots.slice(0, index).reduce((sum, one) => sum + one[2], 0) * 30;
      return [
        { id: `v${index}`, track: video1, start, duration: seconds * 30, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: media.id, source_in: from, speed: 1, opacity: 1, transform, link: `l${index}` },
        { id: `s${index}`, track: audio1, start, duration: seconds * 30, color: "green", fade_in: 0, fade_out: 0, type: "audio", media: media.id, source_in: from, speed: 1, volume_db: 0, link: `l${index}` },
      ];
    });
    await api("PUT", `/api/projects/${v1Id}`, { project: v1, base_rev: v1Live.rev });
    await openEditor(v1Id, 0);
    const v1Pictured = await until("window.__edit.timelineMedia && window.__edit.timelineMedia.frames.size > 0 && window.__edit.timelineMedia.peaksCache.size > 0 && window.__edit.timelineMedia.waiting() === 0", 30_000);
    say(`V1: strips and waveforms ${v1Pictured === null ? "not all in within 30 s" : "in"}, no Timeline button: ${!(await js("Boolean(document.querySelector('button[aria-label=\"Timeline (T)\"]'))"))}`);
    await sleep(300);
    await shotPng("8-v1");
    say(errors.length === 0 ? "no page errors" : `page errors: ${errors.slice(0, 5).join("; ")}`);
  } finally {
    stop();
    rmSync(home, { recursive: true, force: true });
  }
}
