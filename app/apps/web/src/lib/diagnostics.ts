// This window's problems and playback timings, sent to Edit's server log
// (which the Mac's automatic reports carry), and the copy helper. Nothing
// here is shown: there's no report to fill in (Sphe, Nov 15).

type Level = "info" | "warn" | "error";

let sentThisMinute = 0;
setInterval(() => (sentThisMinute = 0), 60_000);

/** An info line kept in this Mac's server log too (a `note` at info stays in the page): within the same allowance a minute. */
export function tell(area: string, message: string) {
  note("info", area, message);
  if (sentThisMinute++ < 20) {
    void fetch("/api/diagnostics/client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "info", message: `${area}: ${message}`.slice(0, 2000) }),
    }).catch(() => {});
  }
}

/** A problem in this window, sent to the server's log (an info line stays here: `tell` sends those). */
export function note(level: Level, area: string, message: string) {
  // Failed requests are already in the server's log; don't echo them back.
  if (level !== "info" && area !== "http" && sentThisMinute++ < 20) {
    void fetch("/api/diagnostics/client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, message: `${area}: ${message}`.slice(0, 2000) }),
    }).catch(() => {});
  }
}

/** Playback's own timings ("preview: …", "script preview: …") not yet sent to the server, by name. */
const unsent = new Map<string, number[]>();
/** Timings the Mac's report carries (the server keeps them as "ui: <name>"): how playback goes, not only its stalls. */
const SENT = /^(preview|script preview):/u;

/**
 * Sends playback's timings to the server once a minute, so a teammate's
 * report (and remote ask) has every wait for a frame, smooth or live, playing
 * or paused, not only the ones long enough to warn (Nov 5: JJ's Mac had no
 * record of the waits under 10 s).
 */
function sendTimings() {
  if (unsent.size === 0) return;
  const batch = [...unsent].map(([name, ms]) => ({ name, ms: ms.slice(-200) }));
  unsent.clear();
  void fetch("/api/diagnostics/timings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timings: batch }), keepalive: true }).catch(() => {});
}
if (typeof window !== "undefined") {
  setInterval(sendTimings, 60_000);
  window.addEventListener("pagehide", sendTimings);
}

/** How long something took here: playback's go to the server once a minute; the rest aren't kept. */
export function recordTiming(name: string, ms: number) {
  if (!SENT.test(name)) return;
  const list = unsent.get(name) ?? [];
  list.push(Math.round(ms));
  unsent.set(name, list);
}

/** A request's route with ids replaced, for the log: "GET /api/projects/:id/frame/:id". */
export function routeOf(method: string, url: string) {
  const path = url.split("?")[0].replace(/^https?:\/\/[^/]+/, "");
  const parts = path.split("/").map((part) => (/^[a-z]{0,2}\d[\w.-]*$/i.test(part) || part.length > 24 ? ":id" : part));
  return `${method.toUpperCase()} ${parts.join("/")}`;
}

let installed = false;

/** An error's first lines of stack, to say where it came from. */
function stackOf(error: unknown): string {
  const stack = (error as { stack?: string } | null)?.stack;
  return stack ? `\n${stack.split("\n").slice(0, 14).join("\n")}` : "";
}

/** React's own error hooks (createRoot's options): the error with the components it happened in. */
export const reactErrors = {
  onUncaughtError(error: unknown, info: { componentStack?: string }) {
    note("error", "ui", `React (uncaught): ${(error as Error)?.message ?? String(error)}${stackOf(error)}\ncomponents:${(info.componentStack ?? "").split("\n").slice(0, 16).join("\n")}`);
  },
  onCaughtError(error: unknown, info: { componentStack?: string }) {
    note("error", "ui", `React (caught): ${(error as Error)?.message ?? String(error)}\ncomponents:${(info.componentStack ?? "").split("\n").slice(0, 16).join("\n")}`);
  },
  onRecoverableError(error: unknown, info: { componentStack?: string }) {
    note("warn", "ui", `React (recovered): ${(error as Error)?.message ?? String(error)}\ncomponents:${(info.componentStack ?? "").split("\n").slice(0, 10).join("\n")}`);
  },
};

/** Catches this window's uncaught errors (once, at startup). */
export function installDiagnostics() {
  if (installed) return;
  installed = true;
  // With the stack: which function threw (names are kept in the build), not only the message.
  // Its column too: the build's lines are long, so a line alone doesn't say where.
  addEventListener("error", (event) => note("error", "ui", `${event.message} (${event.filename}:${event.lineno}:${event.colno})${stackOf(event.error)}`));
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { stack?: string } | undefined;
    note("error", "ui", `Unhandled: ${reason?.stack ?? String(event.reason)}`);
  });
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    note("error", "console", args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(" "));
    original(...args);
  };
}

/** Copies text, falling back to a selected textarea where the clipboard API isn't allowed. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}
