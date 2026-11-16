import { type ReactNode, useEffect, useState } from "react";
import { clock } from "./clips";
import { Icon } from "./ui";

/** Where a script's unsent message is kept, so a send that fails after the page is left still comes back to it. */
export const chatDraftKey = (id: string) => `writer.chat-draft.${id}`;

export function useChatDraft(id: string) {
  const key = chatDraftKey(id);
  const [text, setText] = useState(() => localStorage.getItem(key) ?? "");
  useEffect(() => { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key); }, [key, text]);
  return [text, setText] as const;
}

/** Time since a moment, ticking each second. */
export function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [since]);
  return <>{clock(Math.max(0, now - (since ?? now)))}</>;
}

export async function copyMessage(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* Plain HTTP uses the Mac's older clipboard command. */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0";
  document.body.append(area);
  area.select();
  const done = document.execCommand("copy");
  area.remove();
  return done;
}

function MessageActions({ text, at, onRetry }: { text: string; at?: number; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div className="message-actions">
    {onRetry && <button type="button" className="icon-tool sm" aria-label="Retry message" title="Retry message" onClick={onRetry}><Icon name="reset" size={13} /></button>}
    <button type="button" className="icon-tool sm" aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy message"} onClick={() => void copyMessage(text).then((done) => { if (done) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); } })}><Icon name={copied ? "check" : "copy"} size={13} /></button>
    {at && <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
  </div>;
}

/** Claude at work: what it is on, and for how long. */
export function Working({ stage, since, hint }: { stage: string; since: number | null; hint: string }) {
  return (
    <div className="turn working">
      <div className="thinking">
        <span className="dot live" />
        <span>{stage === "Editing the script" ? "Sonnet is editing the script" : stage && stage !== "Writing the script" ? (stage.includes("·") ? stage : `${stage}…`) : "Opus is writing the script"}</span>
        <span className="mono faint">
          <Elapsed since={since} />
        </span>
      </div>
      <small className="faint">{hint}</small>
    </div>
  );
}

const LINK = /(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/g;

/** A paragraph with its web addresses made into links that open in the browser. */
function linked(text: string): ReactNode[] {
  return text.split(LINK).map((part, index) =>
    index % 2 ? (
      // A new tab in a browser; Edit.app's window opens it in the default browser (edit-window's on_new_window).
      <a key={index} href={part} target="_blank" rel="noreferrer">
        {part.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
      </a>
    ) : (
      part
    ),
  );
}

/** What Claude said, a paragraph at a time. */
export function Said({ text, failed, at }: { text: string; costUsd?: number; failed?: boolean; at?: number }) {
  return (
    <div className={failed ? "turn failed" : "turn"}>
      {text.split(/\n{2,}/).map((part, index) => (
        <p key={index}>{linked(part)}</p>
      ))}
      <MessageActions text={text} at={at} />
    </div>
  );
}
