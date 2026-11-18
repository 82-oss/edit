// Ideas on Home (Oct 31 2026): the team's ideas as rows of Home's table, in
// its Ideas section (Drafts, On the board); the idea page a click away (the
// user: "one tab, one mode, one page … i think thats better").

import { useChannelChoice } from "../components/Channels";
import { ProblemView } from "../components/ProblemView";
import { AREA, ChannelField, FIELD, Field, More, NewShell, useChannelNeeded } from "../components/NewWork";
import { useBeta } from "../lib/beta";
import { ArrowUpRight, CircleAlert, ExternalLink, Eye, Lightbulb, MessageSquare, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button, cx, Pulse, Switch, Tabs } from "../components/ui";
import { Category, CHIP, COLUMNS, contextMenu, CreatorCell, DoneStatus, FreshMark, KindMark, LengthCell, NAME, ROW, RowButtons, StatusCell, Updated, useDoneRow, withDone } from "../components/HomeTable";
import { WORKSPACE_NAMES, type Workspace } from "@edit/types/ideas";
import { ideasApi, NICHE, viewsLabel, type ChangeCard, type IdeaRow, type IdeasHome } from "../lib/ideas";
import { useKept } from "../lib/kept";
import { doneKey } from "../lib/done";
import type { Fresh } from "../lib/seen-status";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";

/** Where an idea is on Home: a draft (repackaging, ready, stopped), its card on the board, or done once the card is approved. */
export function ideaStage(row: IdeaRow): "drafts" | "board" | "done" {
  if (row.summary.status === "sent" && row.place?.approved === true) return "done";
  return row.summary.status === "sent" ? "board" : "drafts";
}

/** Home's ideas, polled while Claude works (every few seconds) and otherwise now and then. */
export function useIdeasHome(enabled: boolean): [IdeasHome | null, () => void, string | null] {
  const [home, setHome] = useKept<IdeasHome | null>("home.ideas", null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    ideasApi
      .home()
      .then((answer) => {
        setHome(answer);
        setError(null);
      })
      .catch((failure: unknown) => setError((failure as Error).message));
  }, [setHome]);
  const busy = home?.ideas.some((row) => row.summary.run === "running" || row.summary.run === "queued") ?? false;
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, busy ? 3_000 : 20_000);
    return () => clearInterval(timer);
  }, [busy, refresh, enabled]);
  return [home, refresh, error];
}

/** What an idea's row says of where it stands. */
function Status({ row }: { row: IdeaRow }) {
  const { summary, place } = row;
  if (place?.changes)
    return (
      <span className={cx(CHIP, "text-warning")} title={`Changes requested on its card (${place.list})`}>
        <MessageSquare size={12} /> Changes requested
      </span>
    );
  if (summary.run === "running" || summary.run === "queued")
    return (
      <span className={cx(CHIP, "max-w-full text-info")} title={summary.step ?? undefined}>
        <Pulse size={12} /> <span className="truncate">{summary.run === "queued" ? "Waiting" : (summary.step ?? "Repackaging")}</span>
      </span>
    );
  if (summary.status === "sent")
    return place?.missing ? (
      <span className={cx(CHIP, "text-warning")}>Card gone</span>
    ) : (
      <span className={cx(CHIP, "max-w-full", place?.approved ? "text-success" : "text-secondary")} title={place?.list ?? summary.card?.list}>
        <Send size={12} /> <span className="truncate">{place?.approved ? place.list : (place?.list ?? summary.card?.list ?? "On the board")}</span>
      </span>
    );
  if (summary.duplicate !== null)
    return (
      <span className={cx(CHIP, "text-warning")} title={`Already on the board as “${summary.duplicate}”`}>
        <CircleAlert size={12} /> On the board already
      </span>
    );
  if (summary.skipped !== null)
    return (
      <span className={cx(CHIP, "text-warning")} title={summary.skipped}>
        <TriangleAlert size={12} /> Skipped
      </span>
    );
  if (summary.run === "failed" || summary.run === "stopped")
    return (
      <span className={cx(CHIP, "text-danger")} title={summary.step ?? undefined}>
        <TriangleAlert size={12} /> {summary.run === "failed" ? "Stopped short" : "Stopped"}
      </span>
    );
  return <span className={cx(CHIP, summary.status === "ready" ? "text-success" : "text-muted")}>{summary.status === "ready" ? "Ready" : "Draft"}</span>;
}

/** An idea in Home's table: its main title, where it stands (New or Changed for you first), its kind, who started it, the video's views. */
export function IdeaTableRow({ row, fresh = null }: { row: IdeaRow; fresh?: Fresh }) {
  const { summary } = row;
  const marked = useDoneRow(doneKey("idea", row.id), summary.title);
  const open = () => navigate(`/ideas/${row.id}`);
  const items = withDone([{ label: "Open", icon: <ArrowUpRight size={14} />, onSelect: open }], marked.items);
  const details = [summary.source, summary.outlier && summary.outlier !== "unknown" ? `${summary.outlier} outlier` : "", summary.sources > 1 ? `${summary.sources} sources` : ""].filter(Boolean).join(" · ");
  return (
    <div role="row" onClick={open} onContextMenu={contextMenu(items)} className={cx(COLUMNS, ROW)}>
      <div role="cell" className="flex min-w-0 items-center gap-2.5" title={details || undefined}>
        <KindMark kind="idea" />
        <span className={NAME}>{summary.title}</span>
      </div>
      <StatusCell>
        {marked.entry ? (
          <DoneStatus entry={marked.entry} />
        ) : (
          <>
            <FreshMark fresh={fresh} />
            <Status row={row} />
          </>
        )}
      </StatusCell>
      {/* Its kind (Interrogation or Bodycam); a niche an older run gave beside it. */}
      <Category channel={summary.channel} text={[WORKSPACE_NAMES[row.workspace ?? "interrogation"], summary.niche ? NICHE[summary.niche].label : ""].filter(Boolean).join(" · ")} />
      <CreatorCell by={row.createdBy === null ? null : { sub: row.createdBy.sub, name: row.createdBy.name, ...(row.createdBy.picture !== null ? { picture: row.createdBy.picture } : {}) }} />
      <LengthCell title={summary.views !== null ? `${summary.views.toLocaleString()} views` : undefined}>
        {summary.views !== null && (
          <>
            <Eye size={13} className="shrink-0 text-faint" />
            {viewsLabel(summary.views).replace(/ views?$/u, "")}
          </>
        )}
      </LengthCell>
      <Updated at={row.updatedAt} title={row.updatedBy ? `by ${row.updatedBy}` : undefined} />
      <RowButtons extra={marked.button} items={items} />
    </div>
  );
}

/** A card on a lane waiting on changes that no idea has yet: opening it makes one. */
export function CardTableRow({ card, onOpened }: { card: ChangeCard; onOpened?: () => void }) {
  const [opening, setOpening] = useState(false);
  const last = card.comments.at(-1);
  const marked = useDoneRow(doneKey("card", card.id), card.name);
  const open = () => {
    setOpening(true);
    ideasApi
      .fromCard(card.id, card.workspace)
      .then(({ id }) => {
        onOpened?.();
        navigate(`/ideas/${id}`);
      })
      .catch((failure: unknown) => useEditor.getState().toastError(failure, "open that card"))
      .finally(() => setOpening(false));
  };
  const items = withDone(
    [
      { label: "Open as an idea", icon: <ArrowUpRight size={14} />, onSelect: open },
      { label: "Open on Trello", icon: <ExternalLink size={14} />, onSelect: () => window.open(card.url, "_blank", "noopener") },
    ],
    marked.items,
  );
  return (
    <div role="row" onClick={open} onContextMenu={contextMenu(items)} className={cx(COLUMNS, ROW)}>
      <div role="cell" className="flex min-w-0 items-center gap-2.5" title={last ? `${last.author}: ${last.text}` : card.list}>
        <KindMark kind="idea" />
        <span className={NAME}>{card.name}</span>
      </div>
      <StatusCell>
        {marked.entry ? (
          <DoneStatus entry={marked.entry} />
        ) : (
          <span className={cx(CHIP, "text-warning")} title={last ? `${last.author}: ${last.text}` : card.list}>
            {opening ? <Pulse size={12} /> : <MessageSquare size={12} />} Changes requested
          </span>
        )}
      </StatusCell>
      <Category text={card.list} />
      <CreatorCell by={null} />
      <LengthCell />
      <span role="cell" />
      <RowButtons extra={marked.button} items={items} />
    </div>
  );
}

/** No ideas yet: what an idea is, and the way to make one. */
export function NoIdeas({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center px-4 py-16 text-center">
      <Lightbulb size={22} className="text-muted" />
      <div className="mt-3 text-[14px] font-medium">No ideas yet</div>
      <p className="mt-1 max-w-[380px] text-[12.5px] text-muted">Paste a YouTube interrogation or bodycam video, or an article: Claude writes the titles and the thumbnail guide, and you send it to the board.</p>
      <Button className="mt-4" variant="light" onClick={onNew}>
        New idea
      </Button>
    </div>
  );
}

/** What a kind of idea is made from and an angle for it, as the dialog asks. */
const KIND: Record<Workspace, { what: string; angle: string }> = {
  interrogation: { what: "YouTube interrogations or articles", angle: "e.g. the GPS data, the moment her story collapses" },
  bodycam: { what: "YouTube bodycam videos or articles", angle: "e.g. what officers find inside, the moment she plays the victim" },
};

/**
 * New idea, in New's frame (components/NewWork.tsx): the channel, the cases
 * (links, one idea each), interrogation or bodycam where both are theirs and
 * no channel says which; the angle, the footage and a summary under More.
 */
export function NewIdea({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: () => void }) {
  const [links, setLinks] = useState("");
  // The kinds this person works on (both: they choose; the last choice is remembered on this Mac).
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>(() => (localStorage.getItem("ideas.workspace") === "bodycam" ? "bodycam" : "interrogation"));
  useEffect(() => {
    if (!open) return;
    void ideasApi.workspaces().then(({ workspaces: mine }) => {
      setWorkspaces(mine);
      setWorkspace((now) => (mine.length === 0 || mine.includes(now) ? now : mine[0]!));
    }, () => {});
  }, [open]);
  const choose = (value: Workspace) => {
    setWorkspace(value);
    localStorage.setItem("ideas.workspace", value);
  };
  // The channel it's for (V2's, always): its agent is taught that channel's Ideas lane.
  const channels = useChannelChoice(open);
  const [channel, setChannel] = useState<string | null>(null);
  const unpicked = useChannelNeeded(channel);
  const v2 = useBeta((beta) => beta.v2);
  const pick = (key: string | null) => {
    setChannel(key);
    // A channel narrated by the editor's recording makes interrogation ideas; a voice's, bodycam ones (where both are theirs).
    const found = channels.find((one) => one.key === key);
    const kind: Workspace | null = found?.narration ? (found.narration.kind === "recorded" ? "interrogation" : "bodycam") : null;
    if (kind !== null && workspaces.includes(kind)) setWorkspace(kind);
  };
  const [steer, setSteer] = useState("");
  const [summary, setSummary] = useState(false);
  const [footage, setFootage] = useState("");
  const [busy, setBusy] = useState(false);
  /** Why it didn't start, and what didn't ("repackage 2 of the links": those left in the box). */
  const [problem, setProblem] = useState<{ error: unknown; doing: string } | null>(null);
  // Links already an idea: theirs to open.
  const [known, setKnown] = useState<{ id: string; why: string }[]>([]);
  const count = (links.match(/https?:\/\/\S+/g) ?? []).length;
  const close = () => {
    if (busy) return;
    setProblem(null);
    onClose();
  };
  const make = () => {
    setBusy(true);
    setProblem(null);
    setKnown([]);
    ideasApi
      .create(links, steer, summary, count === 1 ? footage : "", workspace, channel)
      .then(({ ideas, refused }) => {
        onMade();
        const others = refused.filter((one) => one.id === undefined);
        setKnown(refused.flatMap((one) => (one.id !== undefined ? [{ id: one.id, why: one.why }] : [])));
        if (refused.length > 0) {
          // The links that didn't go stay in the box; why, said plainly (the first's).
          setProblem(others.length > 0 ? { error: others[0]!.why, doing: others.length === 1 ? "repackage the link left in the box" : `repackage the ${others.length} links left in the box` } : null);
          setLinks(others.map((one) => one.link).join("\n"));
          return;
        }
        setLinks("");
        setSteer("");
        setFootage("");
        setSummary(false);
        onClose();
        if (ideas.length === 1) navigate(`/ideas/${ideas[0]!.id}`);
      })
      .catch((failure: unknown) => setProblem({ error: failure, doing: "start repackaging" }))
      .finally(() => setBusy(false));
  };
  return (
    <NewShell
      kind="idea"
      open={open}
      onClose={close}
      onSubmit={make}
      ready={count > 0 && !busy && !unpicked}
      busy={busy}
      action={busy ? "Starting…" : count > 1 ? `Repackage ${count}` : "Repackage"}
      error={
        <>
          {problem !== null && <ProblemView error={problem.error} doing={problem.doing} className="pt-3" />}
          {known.map((one) => (
            <button key={one.id} type="button" onClick={() => navigate(`/ideas/${one.id}`)} className="mt-2 block text-left text-[12px] text-warning hover:underline hover:underline-offset-[3px]">
              {one.why} Open it ›
            </button>
          ))}
        </>
      }
    >
      <ChannelField kind="idea" channels={channels} value={channel} onChange={pick} />
      <Field label="Cases" hint={`${KIND[workspace].what}, one a line`}>
        <textarea autoFocus value={links} onChange={(event) => setLinks(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" rows={4} aria-label="Links" className={AREA} />
      </Field>
      {workspaces.length > 1 && !v2 && (
        <div className="flex items-center justify-between text-[12px] font-medium text-muted">
          <span>Kind</span>
          <Tabs framed id="new-idea-kind" label="Kind of idea" value={workspace} onChange={choose} tabs={workspaces.map((value) => ({ value, label: WORKSPACE_NAMES[value] }))} />
        </div>
      )}
      <More names={count <= 1 ? "angle, footage, summary" : "angle, summary"} set={steer !== "" || footage !== "" || summary}>
        <Field label="Angle" hint="optional">
          <input value={steer} onChange={(event) => setSteer(event.target.value)} placeholder={KIND[workspace].angle} className={FIELD} />
        </Field>
        {count <= 1 && (
          <Field label="Footage" hint="YouTube or Drive links; the idea's page adds more">
            <input value={footage} onChange={(event) => setFootage(event.target.value)} placeholder="https://drive.google.com/drive/folders/…  https://youtu.be/…" className={FIELD} />
          </Field>
        )}
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-[13px]">Write a summary</span>
            <span className="block text-[12px] text-faint">One paragraph, 35–55 words</span>
          </span>
          <Switch checked={summary} onChange={setSummary} />
        </label>
      </More>
    </NewShell>
  );
}
