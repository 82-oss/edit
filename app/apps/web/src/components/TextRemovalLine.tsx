// The editor's one line about what a re-uploader burned into the footage
// (their subtitles, labels, text) and taking it out of the picture
// (text_removal.ts): what it'll do and its price, one button; how far a run
// has got; or, plainly, why it can't (the Vmake account). Nothing at all when
// there's nothing to say: a channel not taught to take theirs out (its removal
// lesson), an agent's turn under way, or it's done.

import { useEffect, useState } from "react";

import { api, type TextRemoval } from "../lib/api";
import { useEditor } from "../lib/store";
import { Button } from "./ui";

export function TextRemovalLine() {
  const id = useEditor((state) => state.project?.id ?? "");
  // Asked again as the edit changes (a re-cut shows other footage) and as the agent's turn ends.
  const clips = useEditor((state) => state.project?.clips.length ?? 0);
  const media = useEditor((state) => state.project?.media.length ?? 0);
  // A channel's project: its lesson says what's taken out (the server answers nothing for an untaught channel).
  const marked = useEditor((state) => typeof state.project?.channel === "string" && state.project.channel !== "");
  const [said, setSaid] = useState<TextRemoval | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (id === "" || !marked) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .textRemoval(id)
        .then((answer) => live && setSaid(answer))
        .catch(() => live && setSaid(null));
    }, 1500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, marked, clips, media, tick]);
  // While a run goes, and while an offer waits on an agent's turn, look again now and then.
  useEffect(() => {
    if (!marked) return;
    const timer = setInterval(() => setTick((value) => value + 1), said?.running ? 3000 : 20000);
    return () => clearInterval(timer);
  }, [marked, said?.running]);
  if (!marked || said === null || said.line === null) return null;
  const act = async () => {
    setBusy(true);
    try {
      if (said.action === "sign_in") {
        const { open } = await api.vmakeSignIn();
        if (open !== "") window.open(open, "_blank", "noopener");
      } else setSaid(await api.removeText(id, said.action === "retry"));
    } catch {
      // Said by the next look.
    } finally {
      setBusy(false);
      setTick((value) => value + 1);
    }
  };
  const label = said.action === "remove" ? "Remove" : said.action === "retry" ? "Try again" : said.action === "sign_in" ? "Sign in" : null;
  return (
    <div className="mx-2 mb-2 flex h-9 shrink-0 items-center gap-3 rounded-lg border border-line bg-panel px-3 text-[12px]">
      <span className="min-w-0 flex-1 truncate text-fg">{said.line}</span>
      {said.running && (
        <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-line">
          <span className="block h-full bg-primary transition-[width] duration-500" style={{ width: `${Math.round((said.running.done / Math.max(1, said.running.total)) * 100)}%` }} />
        </span>
      )}
      {label !== null && (
        <Button size="sm" variant={said.action === "remove" ? "primary" : "subtle"} busy={busy} onClick={() => void act()}>
          {label}
        </Button>
      )}
    </div>
  );
}
