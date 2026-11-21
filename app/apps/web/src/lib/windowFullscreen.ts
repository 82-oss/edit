import { note } from "./diagnostics";
import { nativePreview } from "./nativePreview";

/**
 * Full screen in Edit.app's window (the owner, Nov 21: only the window's player plays on a Mac): the window itself goes
 * full screen and the viewer fills it inside the page (`html.viewer-full`, index.css), so the window's player goes on
 * drawing under it. The page's element full screen (a browser's, Linux's) puts the viewer in a layer of its own that
 * the window's picture isn't in, so the page's own player had to take over there, cold, and froze on a hold for the
 * whole 10 s (the MacBook Air, Nov 21: three runs out of three).
 */
let full = false;
/** When it last went full screen: the window's answer is ignored while its animation runs. */
let since = 0;
const SETTLE_MS = 1500;
const listeners = new Set<() => void>();

function tell() {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("viewer-full", full);
  for (const listener of listeners) listener();
}

export const windowFullscreen = {
  get: (): boolean => full,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** In or out; the viewer fills the window at once, the window follows (macOS animates it). */
  async set(on: boolean): Promise<void> {
    if (on === full) return;
    full = on;
    since = Date.now();
    tell();
    try {
      await nativePreview.fullscreen(on);
    } catch (error) {
      note("warn", "preview", `the window didn't ${on ? "go" : "leave"} full screen: ${error}`);
      if (!on) return;
      full = false;
      tell();
    }
  },
  /** The window left full screen by itself (its green button, ⌃⌘F): the viewer comes back with it. */
  async check(): Promise<void> {
    if (!full || Date.now() - since < SETTLE_MS) return;
    const now = await nativePreview.isFullscreen().catch(() => full);
    if (!now && full && Date.now() - since >= SETTLE_MS) {
      full = false;
      tell();
    }
  },
};
