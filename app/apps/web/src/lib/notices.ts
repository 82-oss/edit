// Telling the person when work they left running is done (the server's
// notices.ts decides how). This page says where it is and whether its window
// has focus, on the events socket, each time either changes; the server
// answers with a toast here (Edit in front, another page) or, when nothing of
// Edit is in front, a system notification this page shows itself: Linux's
// Chrome window (its profile allows them, linux_desktop.ts) or a browser that
// was allowed. Edit.app's window posts its own (crates/edit-window), and a
// click there opens the page through `edit:open`. Settings → Notifications
// turns them back on after a "Don't Allow" (`permission`, `turnOn`, `sendTest`).

import { navigate, onPath } from "./route";
import { sendEvent, useEditor } from "./store";

export interface Notice {
  key: string;
  title: string;
  body: string;
  path: string;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Edit.app's window's calls (crates/edit-window/src/notices.rs), or null in a browser. */
const windowCalls = (): Invoke | null => {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
};

/** Edit.app's window: it posts notifications itself, in Notification Center. */
const inEditApp = (): boolean => (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

/** Linux's window: Chrome's app window onto edit.localhost (linux_desktop.ts). */
const inLinuxWindow = (): boolean => location.hostname === "edit.localhost";

/** A browser on Edit's plain http:// address (a Tailscale IP, not its https://….ts.net one): no browser shows notifications there. */
const insecure = (): boolean => !inEditApp() && typeof window.isSecureContext === "boolean" && !window.isSecureContext;

/** Whether this page may show the system's notifications itself. */
const mayShow = (): boolean => !inEditApp() && !insecure() && typeof Notification !== "undefined" && Notification.permission === "granted";

/** Where this page is and whether it's in front, as the server takes it (`app`: Edit.app's own window). */
export function attention(): { type: "attention"; focused: boolean; path: string; system: boolean; app: boolean } {
  return { type: "attention", focused: document.visibilityState === "visible" && document.hasFocus(), path: location.pathname, system: mayShow(), app: inEditApp() };
}

/**
 * How notifications stand here: "on", "off" (turned off for Edit), "ask"
 * (never answered), "insecure" (a browser on Edit's http:// address), or
 * "none" (this window can't have them).
 */
export type Permission = "on" | "off" | "ask" | "insecure" | "none";

export async function permission(): Promise<Permission> {
  const calls = windowCalls();
  if (calls !== null) {
    try {
      const said = await calls("notices_status");
      return said === "on" || said === "off" || said === "ask" ? said : "none";
    } catch {
      // A window from before Settings could ask.
      return "none";
    }
  }
  if (insecure()) return "insecure";
  if (typeof Notification === "undefined") return "none";
  return Notification.permission === "granted" ? "on" : Notification.permission === "denied" ? "off" : "ask";
}

/** Where turning them on was left: done here, or for the person to finish in System Settings, the reopening window, or the browser's own settings. */
export type TurnedOn = { now: Permission; then: "done" | "system" | "reopening" | "browser" };

/**
 * Turns notifications on as far as this window can (Settings → Notifications):
 * the question again while it may still be asked; once answered no, Edit.app
 * opens macOS's Notifications settings on Edit, and Linux's window reopens
 * with them allowed (Chrome asks only once, and opens no settings from outside).
 */
export async function turnOn(): Promise<TurnedOn> {
  const calls = windowCalls();
  if (calls !== null) {
    const now = (await calls("notices_allow")) as Permission;
    return { now, then: now === "off" ? "system" : "done" };
  }
  if (typeof Notification === "undefined") return { now: "none", then: "done" };
  if (Notification.permission === "default") {
    await Notification.requestPermission();
    window.dispatchEvent(new Event("edit:attention"));
    return { now: await permission(), then: "done" };
  }
  if (Notification.permission === "denied" && inLinuxWindow()) {
    const answer = (await fetch("/api/notifications/reopen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: location.pathname }) })
      .then((response) => response.json())
      .catch(() => ({}))) as { reopening?: unknown };
    if (answer.reopening === true) return { now: "off", then: "reopening" };
  }
  return { now: await permission(), then: Notification.permission === "granted" ? "done" : "browser" };
}

/** A notification now, as one about finished work comes, so the person sees they arrive; false when this browser wouldn't show it. */
export async function sendTest(): Promise<boolean> {
  const calls = windowCalls();
  if (calls !== null) {
    await calls("notices_test", { path: location.pathname });
    return true;
  }
  return await show("system", { key: "test", title: "Notifications are on", body: "This is how Edit tells you a draft, a revision or a share is done.", path: location.pathname });
}

/** The service worker that shows notifications (public/notices-sw.js), registered once; null where there's none to be had. */
let worker: Promise<ServiceWorkerRegistration | null> | null = null;
function noticesWorker(): Promise<ServiceWorkerRegistration | null> {
  if (inEditApp() || insecure() || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  worker ??= navigator.serviceWorker.register("/notices-sw.js").then(
    () => navigator.serviceWorker.ready,
    () => null,
  );
  return worker;
}

/** Opens the notice's page and brings this window forward. */
function open(path: string): void {
  window.focus();
  navigate(path);
}

/** Shows `notice`: a toast in this page, or the system's notification (whether it was shown). */
async function show(how: unknown, notice: Notice): Promise<boolean> {
  if (how === "toast") {
    useEditor.getState().toast(`${notice.title} · ${notice.body}`, "agent", { label: "Open", run: () => navigate(notice.path) });
    return true;
  }
  if (how !== "system" || !mayShow()) return false;
  // Each its own tag: one tagged as another still in the list replaces it without a sound or a banner, so a project's
  // second "Changes are done", or a second test, seemed never to come (Nov 16).
  const options = { body: notice.body, tag: `${notice.key}:${Date.now()}`, icon: "/apple-touch-icon.png" };
  // From the service worker where there is one: a phone's browser shows none from a page, and its click finds the tab.
  const registration = await noticesWorker().catch(() => null);
  if (registration !== null) {
    try {
      await registration.showNotification(notice.title, { ...options, data: { path: notice.path } });
      return true;
    } catch {
      // Shown from the page below instead.
    }
  }
  try {
    const shown = new Notification(notice.title, options);
    shown.onclick = () => {
      open(notice.path);
      shown.close();
    };
    return true;
  } catch {
    // A browser that won't show one from a page: the work is still there to see.
    return false;
  }
}

/** Starts reporting this page's attention and showing notices; returns how to stop. */
export function watchNotices(): () => void {
  let said = "";
  const report = (again = false) => {
    const now = JSON.stringify(attention());
    if (now === said && !again) return;
    said = now;
    sendEvent(now);
  };
  const changed = () => report();
  const connected = () => report(true);
  const heard = (event: Event) => {
    const detail = (event as CustomEvent<{ how?: unknown; notice?: Notice }>).detail;
    if (detail?.notice !== undefined) void show(detail.how, detail.notice);
  };
  // The service worker's notification was clicked.
  const clicked = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; path?: unknown } | null;
    if (data?.type === "edit:open" && typeof data.path === "string" && data.path.startsWith("/")) open(data.path);
  };
  // Edit.app's window: its notification was clicked.
  const opened = (event: Event) => {
    const path = (event as CustomEvent<unknown>).detail;
    if (typeof path === "string" && path.startsWith("/")) open(path);
  };
  // A browser asks once whether Edit may notify, on a click (it won't ask otherwise).
  const ask = () => {
    if (inEditApp() || insecure() || typeof Notification === "undefined" || Notification.permission !== "default") return;
    void Notification.requestPermission()
      .then(() => report())
      .catch(() => {});
  };
  window.addEventListener("focus", changed);
  window.addEventListener("blur", changed);
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("edit:connected", connected);
  // The permission changed here (Settings → Notifications): the server hears this page may show them now.
  window.addEventListener("edit:attention", changed);
  window.addEventListener("edit:notice", heard);
  window.addEventListener("edit:open", opened);
  window.addEventListener("pointerdown", ask, { once: true, capture: true });
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", clicked);
  // Ready before the first notice comes, where notifications are already allowed.
  if (mayShow()) void noticesWorker();
  const stopPath = onPath(changed);
  report(true);
  return () => {
    window.removeEventListener("focus", changed);
    window.removeEventListener("blur", changed);
    document.removeEventListener("visibilitychange", changed);
    window.removeEventListener("edit:connected", connected);
    window.removeEventListener("edit:attention", changed);
    window.removeEventListener("edit:notice", heard);
    window.removeEventListener("edit:open", opened);
    window.removeEventListener("pointerdown", ask, { capture: true });
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", clicked);
    stopPath();
  };
}
