import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmHost } from "./confirm";

import { Loader } from "../components/Logo";
import { closeScriptLock, getProgress, getScript, message, openScriptLock, takeOverScript } from "./api";
import { CommentaryEditor } from "./commentary-view";
import { Editor } from "./editor";
import { Icon, startToastTimer } from "./ui";
import { LitStyle } from "./comments";
import { ImportScreen } from "./import-screen";
import { lastOpened } from "./opened";
import { navigate, usePath } from "../lib/route";
import "./writer.css";
import type { ImportProgress, Script } from "./types";

/** How often an open script says so (apps/server/src/sync_core.ts TIMING.HEARTBEAT), and who's saying it. */
const HEARTBEAT_MS = 30_000;
const LOCK_CLIENT = `script-${Math.random().toString(36).slice(2, 10)}`;

/** The script a path opens (/scripts/<id>; App.tsx mounts Script mode only there), so a reload comes back to it. */
export const scriptOf = (path: string) => /^\/scripts\/([0-9a-f-]+)$/i.exec(path)?.[1];

// A click never leaves a focus ring (the kit's rule): a pointer marks the page until Tab brings the rings back.
let marking = false;
function markPointer() {
  if (marking) return;
  marking = true;
  const html = document.documentElement;
  document.addEventListener("pointerdown", () => html.setAttribute("data-pointer", ""), { capture: true });
  document.addEventListener("keydown", (event) => event.key === "Tab" && html.removeAttribute("data-pointer"), { capture: true });
}

function ImportFinished({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: { id: string; title: string };
  onOpen: () => void;
  onDismiss: () => void;
}) {
  // App re-renders while imports poll, handing a new onDismiss each time. The timer starts once.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => startToastTimer(() => dismiss.current()), []);
  return (
    <div className="toasts">
      <div className="toast import-complete" role="status">
        <span><b>Import finished</b> · {notice.title}</span>
        <button type="button" className="tool" onClick={() => { onOpen(); onDismiss(); }}>Open script</button>
        <button type="button" className="icon-tool" aria-label="Dismiss import notification" onClick={onDismiss}><Icon name="close" size={14} /></button>
      </div>
    </div>
  );
}

/** Script mode: a script open in Edit (Home lists them, with the edits). */
export function ScriptMode() {
  const path = usePath();
  // The script this screen opened. Leaving (Home, the edit) changes the path while the screen still
  // fades out for the next one (App's AnimatePresence): it keeps showing the script until it's gone.
  const [id, setId] = useState(() => scriptOf(path) ?? "");
  const now = scriptOf(path);
  if (now !== undefined && now !== id) setId(now);
  // One object a script, so the effects that follow it run when it changes, not every render.
  const route = useMemo(() => ({ id }), [id]);
  useEffect(() => {
    markPointer();
  }, []);
  // A script opened before opens at once (then catches up).
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<ImportProgress[]>([]);
  const [open, setOpen] = useState<Script | null>(() => lastOpened.get(route.id) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<{ id: string; title: string } | null>(null);
  const acceptScript = (fresh: Script) => setOpen((current) => {
    if (current?.id === fresh.id && (fresh.revision < current.revision || (fresh.revision === current.revision && fresh.updatedAt < current.updatedAt))) return current;
    lastOpened.set(fresh.id, fresh);
    return fresh;
  });
  const openScript = (next: string) => navigate(`/scripts/${next}`);
  /** The script this page last read whole, so the list arriving doesn't read it again. */
  const fetched = useRef<string | null>(null);
  // Another script, or this one opened again: read afresh.
  useEffect(() => () => { fetched.current = null; }, [route]);

  useEffect(() => {
    // `just dev` serves the page before the server is listening. Keep
    // asking until it answers rather than showing the refused request.
    let waiting: number | undefined;
    const connect = () => {
      void getProgress()
        .then((list) => {
          setProgress(Array.isArray(list) ? list : []);
          setError(null);
          setReady(true);
        })
        .catch(() => {
          setError("Starting Script mode…");
          waiting = window.setTimeout(connect, 1500);
        });
    };
    connect();
    // Hidden windows stop asking; the next look catches up.
    // One ask at a time: on a busy Mac an answer can take seconds, and asks every 0.8 s piled up behind each other.
    let asking = false;
    const timer = window.setInterval(() => {
      if (document.hidden || asking) return;
      asking = true;
      void getProgress()
        .then((list) => setProgress(Array.isArray(list) ? list : []))
        .catch(() => {})
        .finally(() => { asking = false; });
    }, 800);
    return () => {
      window.clearTimeout(waiting);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // Opened before: it shows at once while the fresh copy comes.
    const kept = lastOpened.get(route.id);
    if (kept) setOpen((current) => (current?.id === kept.id ? current : kept));
    // Asked for at once, beside the list rather than after it (the user, Oct 30:
    // "why does it take so long to open pages"); before the server answers at
    // all, it's asked again once the list comes.
    // Asked once (a second ask while the first is out only queues behind it on a busy Mac).
    if (fetched.current === route.id) return;
    fetched.current = route.id;
    const asked = route.id;
    void getScript(asked)
      .then((fresh) => {
        // A slow answer for a script since left must not overwrite the one now open.
        if (fetched.current !== asked) return;
        acceptScript(fresh);
      })
      .catch((cause) => {
        if (fetched.current === asked) fetched.current = null;
        if (ready) setError(message(cause));
      });
  }, [route, ready]);

  // Open here: the script's cloud lock is kept while the page says so (apps/server/src/writer/locks.ts), and
  // another computer holding it makes it read-only here, with Take over.
  const [heldBy, setHeldBy] = useState<string | null>(null);
  const scriptId = route.id;
  useEffect(() => {
    let alive = true;
    const say = () => {
      void openScriptLock(scriptId, LOCK_CLIENT).then((lock) => alive && setHeldBy(lock.holder)).catch(() => {});
    };
    say();
    const heartbeat = window.setInterval(say, HEARTBEAT_MS);
    return () => {
      alive = false;
      window.clearInterval(heartbeat);
      setHeldBy(null);
      void closeScriptLock(scriptId, LOCK_CLIENT).catch(() => {});
    };
  }, [scriptId]);

  // A script open here that another Mac changed comes down through the cloud
  // into its file; the open copy follows it.
  const opened = open && open.id === route.id ? open : null;
  const shown = useRef(opened);
  shown.current = opened;
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    const ask = () => {
      const now = shown.current;
      if (!now || document.hidden) return;
      void getScript(now.id)
        .then((fresh) => {
          const current = shown.current;
          // Imports save words, speakers and status without making an edit revision.
          // A share ending (it runs on its own) saves no revision either: its link and state follow.
          const shareMoved = Boolean(fresh.sharing) !== Boolean(current?.sharing) || fresh.review?.version !== current?.review?.version || fresh.shareFailed?.at !== current?.shareFailed?.at;
          if (!gone && current && fresh.id === current.id && (fresh.updatedAt > current.updatedAt || shareMoved) && fresh.revision >= current.revision) {
            acceptScript(fresh);
            if (current.status === "processing" && fresh.status === "ready") setImportNotice({ id: fresh.id, title: fresh.title });
          }
        })
        .catch(() => {});
    };
    const timer = window.setInterval(ask, 4000);
    const back = () => { if (!document.hidden) ask(); };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      gone = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [route, ready]);

  const previousImports = useRef<ImportProgress[]>([]);
  useEffect(() => {
    const finished = previousImports.current.filter((item) => !progress.some((now) => now.id === item.id));
    previousImports.current = progress;
    for (const item of finished) {
      void getScript(item.id).then((fresh) => {
        if (fresh.status !== "ready") return;
        setImportNotice({ id: fresh.id, title: fresh.title });
        if (shown.current?.id === fresh.id) acceptScript(fresh);
      }).catch(() => {});
    }
  }, [progress]);

  // Back from a script goes to Home, where scripts are listed with the edits (one app, Oct 30).
  const home = () => navigate("/");
  // The open script still importing: its progress shows over the project, which loads when it's done.
  const importing = progress.find((item) => item.id === route.id) ?? null;
  const wasImporting = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    const load = () => void getScript(route.id).then((fresh) => { if (!gone) acceptScript(fresh); }).catch((cause) => { if (!gone) setError(message(cause)); });
    if (importing) {
      wasImporting.current = route.id;
      // Its script.json may not be there for the first moments.
      if (!opened) load();
    } else if (wasImporting.current === route.id) {
      wasImporting.current = null;
      load();
    }
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!importing, importing?.stage, route, ready]);
  return (
    <div className="writer-root">
      <ConfirmHost />
      {opened?.commentary ? (
        <CommentaryEditor key={opened.id} script={opened} onChange={setOpen} onBack={home} />
      ) : opened ? (
        <Editor key={opened.id} script={opened} onChange={setOpen} onBack={home} />
      ) : (
        <div className="studio">
          <header className="topbar" data-tauri-drag-region>
            <button type="button" className="icon-tool" aria-label="All scripts" title="All scripts" onClick={home}>
              <Icon name="back" />
            </button>
            <div className="title-block" data-tauri-drag-region>Scripts</div>
          </header>
          {error ? (
            <p className="notice">{error}</p>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Loader label="Opening the script…" />
            </div>
          )}
        </div>
      )}
      {heldBy !== null && (
        <div className="notice" role="status" style={{ position: "fixed", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 40, display: "flex", alignItems: "center", gap: 12 }}>
          <span>{heldBy} is editing this script, so it's read-only here.</span>
          <button type="button" className="tool" onClick={() => void takeOverScript(scriptId).then((lock) => setHeldBy(lock.holder)).catch((cause) => setError(message(cause)))}>Take over</button>
        </div>
      )}
      <ImportScreen item={importing} onLeave={home} />
      {importNotice && (
        <ImportFinished
          key={importNotice.id}
          notice={importNotice}
          onOpen={() => openScript(importNotice.id)}
          onDismiss={() => setImportNotice(null)}
        />
      )}
      <LitStyle />
    </div>
  );
}
