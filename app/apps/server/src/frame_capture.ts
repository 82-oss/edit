// An effect's frames drawn and written by a process of their own (`edit capture-frames`), not on the server's thread.
//
// Each frame of a render is a 1080p PNG Chrome sends as base64 in a DevTools message: about 20 MB of strings and
// buffers made and dropped a frame on the server's one thread, a few frames a second. With four compilations
// rendering (Nov 26, mandalorian) the server swung between 1.6 and 4.1 GB a minute, its collections held the thread
// for seconds at a time (18 min of every hour), and a frame took a second where Chrome draws it in a tenth. Here a
// render's Chrome page gets a second DevTools connection from this process, which seeks, shoots and writes each frame
// it's given and says one short line a frame on stdout: the server only counts them.
//
//   stdin: a Spec as JSON. stdout: one JSON line a frame, `{"index":n,"bytes":b}`, or `{"error":"…"}` and exit 1.

import * as fs from "node:fs";
import { join } from "node:path";

export interface Spec {
  /** The page's DevTools address (its `webSocketDebuggerUrl`). */
  target: string;
  /** The frames to draw, by index, in order. */
  indexes: number[];
  fps: number;
  width: number;
  height: number;
  /** Where each frame is written, as `frame-00042.png`. */
  dir: string;
  /** How long one seek may take before the page's own errors are asked for. */
  seekMs: number;
}

export function frameName(index: number): string {
  return `frame-${String(index).padStart(5, "0")}.png`;
}

type Answer = { result?: Record<string, unknown>; error?: { message?: string } };

/** Draws `spec`'s frames, saying each as it lands (`say`); what went wrong is thrown, in the words the render says it. */
export async function capture(spec: Spec, say: (line: Record<string, unknown>) => void): Promise<void> {
  const socket = new WebSocket(spec.target);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Rendering an effect: Chrome's connection timed out.")), 15_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Rendering an effect: Chrome's connection failed."));
    };
  });
  let next = 0;
  const pending = new Map<number, (answer: Answer) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Answer & { id?: number };
    if (message.id === undefined) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  let gone = false;
  socket.onclose = () => {
    gone = true;
    for (const resolve of pending.values()) resolve({ error: { message: "Chrome went away while it rendered" } });
    pending.clear();
  };
  const call = (method: string, params: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error("Chrome went away while it rendered"));
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, waitMs);
      pending.set(id, (answer) => {
        clearTimeout(timer);
        if (answer.error !== undefined) reject(new Error(answer.error.message ?? `${method} failed`));
        else resolve(answer.result ?? {});
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <T>(expression: string, waitMs: number): Promise<T> => {
    const answer = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, waitMs);
    const thrown = answer.exceptionDetails as { text?: string; exception?: { description?: string; value?: unknown } } | undefined;
    if (thrown !== undefined) {
      const value = thrown.exception?.value;
      throw new Error(thrown.exception?.description ?? (value === undefined ? undefined : JSON.stringify(value)) ?? thrown.text ?? "the page threw");
    }
    return (answer.result as { value?: T } | undefined)?.value as T;
  };
  try {
    // A connection's own, as the server's: the page at its size, and nothing behind it, so what it leaves unpainted is
    // see-through (without it here every frame came out opaque, and a see-through effect was never stacked).
    await call("Emulation.setDeviceMetricsOverride", { width: spec.width, height: spec.height, deviceScaleFactor: 1, mobile: false }, 15_000);
    await call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, 15_000);
    for (const index of spec.indexes) {
      const time = index / spec.fps;
      let drawn: { error?: string };
      try {
        drawn = await evaluate<{ error?: string }>(`window.__edit.seek(${time})`, spec.seekMs);
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        if (gone || !/timed out/.test(said)) throw error;
        const errors = await evaluate<string[]>("[...window.__edit.errors]", 5_000).catch(() => [] as string[]);
        if (errors.length === 0) throw error;
        throw new Error(`its page's seek(${time.toFixed(2)}) never finished in ${spec.seekMs / 1000} s, after it said: ${errors.map(firstLines).join("; ")}`);
      }
      if (drawn?.error !== undefined) throw new Error(`its page threw at ${time.toFixed(2)} s: ${firstLines(drawn.error)}`);
      const shot = await call("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: { x: 0, y: 0, width: spec.width, height: spec.height, scale: 1 } }, 60_000);
      if (typeof shot.data !== "string") throw new Error(`Chrome drew nothing at ${time.toFixed(2)} s`);
      // Whole frames only: one cut short by a quit is drawn again.
      const path = join(spec.dir, frameName(index));
      const png = Buffer.from(shot.data, "base64");
      await fs.promises.writeFile(`${path}.partial`, png);
      await fs.promises.rename(`${path}.partial`, path);
      say({ index, bytes: png.length });
    }
  } finally {
    socket.close();
  }
}

/** A page's error as the render says it (effects.ts `firstLines`, kept here so this process loads nothing of the server's). */
function firstLines(error: string): string {
  const lines = error.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const first = lines[0] ?? "";
  return /^[A-Za-z]*Error:?$/.test(first) && lines[1] !== undefined ? `${first} ${lines[1]}` : first;
}

/** `edit capture-frames`: the Spec on stdin, a line a frame on stdout. */
export async function run(): Promise<void> {
  const spec = JSON.parse(await new Response(Bun.stdin.stream()).text()) as Spec;
  try {
    await capture(spec, (line) => process.stdout.write(`${JSON.stringify(line)}\n`));
    process.exit(0);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}

if (import.meta.main) await run();
