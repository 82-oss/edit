import { useCallback, useEffect, useRef, useState } from "react";
import { askConfirm } from "./confirm";
import { approveReview, cancelScriptShare, compressReview, deleteReviewLink, getScript, restoreScript, message, onReviews, reviewNotes, scriptAudit, shareScript } from "./api";
import { makeDoc } from "./docs-dialog";
import type { BuildStatus, Cite, DocFile, Paragraph, ReviewApproval, ReviewBlock, ReviewNote, Script, ShareFailed, ShareStep, Sharing } from "./types";
import { useGrants } from "./can";
import { Dialog, Icon } from "./ui";
import { formatBytes } from "../lib/time";
import { THIS_MACHINE } from "../lib/platform";
import { ShareRunning, ShareSteps } from "./share-progress";
import { failedLine, runningTitle } from "./share-steps";

/**
 * Review on a Repack link (reviews.rs): Share, and what Claude changed for
 * the notes reviewers leave there, drawn as bands on the script. The notes
 * themselves are the chat agent's to pull and fix (Sphe, Nov 20: no comments
 * in the share dialog, nothing popping up on hover).
 */

/** A note for the video editor: Edit's agent follows it in that section (a line starting "edit:"). */
export const isEditNote = (text: string | undefined) => !!text && text.split("\n").some((line) => /^\s*edit:/i.test(line));

/** A script's notes and its blocks as they now read; asked again when notes change or the script does. */
export function useReview(id: string, revision: number) {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [blocks, setBlocks] = useState<ReviewBlock[]>([]);
  const [approved, setApproved] = useState<ReviewApproval | null>(null);
  const refresh = useCallback(
    () =>
      void reviewNotes(id).then(
        (found) => {
          setNotes(found.notes);
          setBlocks(found.blocks);
          setApproved(found.approved ?? null);
        },
        () => {},
      ),
    [id],
  );
  useEffect(() => {
    refresh();
    return onReviews(refresh);
  }, [refresh, revision]);
  return { notes, blocks, approved, refresh };
}

/** Part of a block's text a band covers: a fix's change, or an open note's words. */
export type Band = { start: number; end: number; notes: string[]; kind: "fix" | "open" | "note" };

/** Bands by block: each done note's changed ranges, and each open note's anchor. */
export function bandsOf(notes: ReviewNote[]): Map<string, Band[]> {
  const out = new Map<string, Band[]>();
  const add = (blockId: string, band: Band) => out.set(blockId, [...(out.get(blockId) ?? []), band]);
  for (const note of notes) {
    if (note.parentId) continue;
    if (note.status === "done") {
      for (const range of note.changedRanges) add(range.blockId, { start: range.start, end: range.end, notes: [note.id], kind: "fix" });
    } else if (note.anchor?.blockId) {
      add(note.anchor.blockId, { start: note.anchor.start ?? 0, end: note.anchor.end ?? 0, notes: [note.id], kind: "open" });
    }
  }
  return out;
}

/** A moment as blocks.rs prints a clip: whole seconds, rounded down. */
function stamp(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}` : `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

const citeLine = (cite: Cite) => `[${cite.video} ${stamp(cite.startMs)}–${stamp(cite.endMs)}]${cite.quote.trim() ? ` "${cite.quote.trim()}"` : ""}`;

/**
 * A paragraph's bands, piece by piece: its text is each piece on its own
 * line (blocks.rs paragraph_text), so a band on narration lands in that
 * piece's own offsets, and one touching a clip marks the clip.
 */
export function pieceBands(paragraph: Paragraph, bands: Band[] | undefined): Map<number, Band[]> {
  const out = new Map<number, Band[]>();
  if (!bands?.length) return out;
  let at = 0;
  paragraph.pieces.forEach((piece, index) => {
    const text = piece.kind === "say" ? piece.text : citeLine(piece);
    const [from, to] = [at, at + text.length];
    for (const band of bands) {
      // An empty band at a piece's start belongs to it; elsewhere a band must overlap.
      const touches = band.start === band.end ? band.start >= from && band.start <= to : band.start < to && band.end > from;
      if (!touches) continue;
      const local = { ...band, start: Math.max(0, band.start - from), end: Math.min(text.length, band.end - from) };
      out.set(index, [...(out.get(index) ?? []), local]);
    }
    at = to + 1;
  });
  return out;
}

/** Where a piece's text starts in its paragraph's block text (each piece on its own line, blocks.rs paragraph_text): a comment's words are named there. */
export function pieceOffset(paragraph: Paragraph, index: number) {
  let at = 0;
  paragraph.pieces.slice(0, index).forEach((piece) => (at += (piece.kind === "say" ? piece.text : citeLine(piece)).length + 1));
  return at;
}

/** What an element-wide band carries (a timestamp, a clip, a heading): its notes, for their colour and lighting. */
export function bandProps(bands: Band[] | undefined) {
  if (!bands?.length) return {};
  return { "data-band": bands.flatMap((band) => band.notes).join(" "), "data-band-kind": bands.some((band) => band.kind === "fix") ? "fix" : "open" };
}

// ---- Share -------------------------------------------------------

const when = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const docWhen = (value: string | number) => new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The script can become a Doc: a commentary once it has a draft, a footage script once it has a cut-in. */
const docReady = (script: Script) => (script.commentary ? !!script.commentary.draft : script.clips.some((clip) => clip.kind === "cut-in"));

/**
 * Export the script as a Google Doc, the share dialog's extra row (the edit
 * dialog's option rows). The fuller Doc window stays on the More menu.
 */
function DocExportRow({ script, onChange }: { script: Script; onChange: (script: Script) => void }) {
  const mayShare = useGrants().shares;
  const doc = script.docExport;
  const behind = !!doc && doc.revision !== script.revision;
  const ready = docReady(script);
  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<DocFile | null>(null);
  const latest = made?.url ?? doc?.url;

  const make = async () => {
    setExporting(true);
    setProblem(null);
    setMade(null);
    try {
      const next = await makeDoc(script, false);
      setMade(next);
      onChange(await getScript(script.id));
      window.open(next.url, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setExporting(false);
    }
  };

  const hint = !mayShare
    ? "Sign in to export."
    : problem
      ? problem
      : !ready
        ? "Write the script first."
        : made
          ? "Exported."
          : behind
            ? "The script has changed since the last Doc."
            : doc
              ? `Up to date · ${docWhen(doc.exportedAt)}`
              : "A new Doc from the script, with a comment on each timestamp.";

  return (
    <div className="share-row">
      <div className="share-copy">
        <b>Google Doc</b>
        <span className={problem ? "bad" : undefined}>
          {hint}
          {latest && !problem && (
            <>
              {" "}
              <a href={latest} target="_blank" rel="noreferrer">
                Open ↗
              </a>
            </>
          )}
        </span>
      </div>
      {mayShare && (
        <button type="button" className="sm" disabled={!ready || exporting} onClick={() => void make()}>
          {exporting ? "Exporting…" : doc ? "Export again" : "Export"}
        </button>
      )}
    </div>
  );
}

/** The topbar's Share button, the same red Share as the edit page. Open notes still show as a count. */
export function ReviewButton({ script, open, approved, onClick }: { script: Script; open: number; approved: ReviewApproval | null; onClick: () => void }) {
  const shared = !!script.review;
  return (
    <button
      type="button"
      className="primary review-button"
      title={
        approved
          ? `Approved v${approved.version} by ${approved.by}, ${when(approved.at)}.`
          : shared
            ? `Shared for review (v${script.review?.version}). ${open ? `${open} open ${open === 1 ? "note" : "notes"}.` : "No open notes."}`
            : "Share the script on a Repack link for review"
      }
      onClick={onClick}
    >
      <Icon name="share" size={14} />
      Share
      {open > 0 && <span className="count-badge">{open}</span>}
    </button>
  );
}

/**
 * Sharing, in the same box as the edit page's Share: the link and a Google
 * Doc export. While a share runs, those make way for its progress, as the
 * edit's Export dialog shows one (Sphe, Nov 22: "I don't have a very good
 * breakdown in the UI of the progress, as well as I do with the editing"):
 * what is happening, one number and bar, and each step the server goes
 * through with its own state. Close leaves a share running; opened again,
 * it shows where it is. One that stops says where and why, in words. The
 * notes left on the link are the chat agent's to pull and fix ("apply the
 * feedback"), never shown here.
 */
export function ReviewDialog({
  open,
  script,
  approved,
  busy,
  onClose,
  onChange,
  onRefresh,
}: {
  open: boolean;
  script: Script;
  /** The approved version, made here or on Repack's page. */
  approved: ReviewApproval | null;
  busy: boolean;
  onClose: () => void;
  onChange: (script: Script) => void;
  onRefresh: () => void;
}) {
  const [sharing, setSharing] = useState(false);
  const [making, setMaking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The share as the server last said it while this dialog follows it, the last that stopped, and the steps of one that just landed.
  const [live, setLive] = useState<Sharing | null>(null);
  const [failed, setFailed] = useState<ShareFailed | null>(script.shareFailed ?? null);
  const [landed, setLanded] = useState(false);
  const [landedSteps, setLandedSteps] = useState<{ version: number; steps: ShareStep[] } | null>(null);
  const said = useRef("");
  const sawShare = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  // Sharing, approving and fixing: anyone signed in; reading the notes: anyone.
  const mayShare = useGrants().shares;
  // What a reviewer would flag, checked before it's shared, as Edit's audit is before an export.
  const [flags, setFlags] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setLanded(false);
    setLandedSteps(null);
    // Opened again on one that stopped: it still says why, until the next share.
    setFailed(script.shareFailed ?? null);
    said.current = script.review ? `${script.review.url}#${script.review.version}` : "";
    onRefresh();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    void scriptAudit(script.id).then((found) => setFlags(found.flags), () => setFlags([]));
  }, [open, script.id, script.revision]);

  // A share runs on its own (JJ, Nov 1: "so we're not freezed on that screen"): this can close, and other scripts share meanwhile.
  const sharingNow = script.sharing !== undefined;
  const shareId = script.id;
  // The share this dialog saw end (by its start): the page's copy of the script can still say it's running until its next look.
  const [ended, setEnded] = useState<number | null>(null);
  const followedStart = useRef<number | null>(null);
  followedStart.current = script.sharing?.startedAt ?? null;
  useEffect(() => {
    if (!open || !sharingNow) return;
    let live = true;
    const look = () =>
      void getScript(shareId).then((fresh) => {
        if (!live) return;
        if (fresh.sharing) {
          sawShare.current = true;
          setLive(fresh.sharing);
          // One started again elsewhere (Home's row): the last stop no longer stands.
          setFailed(null);
          return;
        }
        const saw = sawShare.current;
        sawShare.current = false;
        setLive(null);
        setEnded(followedStart.current);
        if (fresh.shareFailed) {
          setLanded(false);
          setStopped(false);
          setFailed(fresh.shareFailed);
        } else if (fresh.review) {
          const key = `${fresh.review.url}#${fresh.review.version}`;
          if (key !== said.current) {
            said.current = key;
            setLanded(true);
            setLandedSteps(fresh.shared ?? null);
            setFailed(null);
            setStopped(false);
            void navigator.clipboard?.writeText(fresh.review.url).catch(() => {});
          } else if (saw) setStopped(true);
        } else if (saw) setStopped(true);
        change.current(fresh);
      }, () => {});
    look();
    const timer = window.setInterval(look, 1500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [open, sharingNow, shareId]);
  useEffect(() => {
    if (script.shareFailed) setFailed(script.shareFailed);
  }, [script.shareFailed?.at]);

  const link = script.review;
  const share = async () => {
    setSharing(true);
    setProblem(null);
    setFailed(null);
    setLanded(false);
    setLandedSteps(null);
    setStopped(false);
    setLive(null);
    try {
      const fresh = await shareScript(script.id);
      if (fresh.sharing) setLive(fresh.sharing);
      else if (fresh.review && !fresh.shareFailed) {
        const key = `${fresh.review.url}#${fresh.review.version}`;
        if (key !== said.current) {
          said.current = key;
          setLanded(true);
          setLandedSteps(fresh.shared ?? null);
          void navigator.clipboard?.writeText(fresh.review.url).catch(() => {});
        }
      }
      change.current(fresh);
    } catch (cause) {
      // Refused before it began (Claude is on it, it's still importing): said as a stopped share is.
      setFailed({ error: message(cause), at: Date.now() });
      setLive(null);
    } finally {
      setSharing(false);
    }
  };
  // The script as it is now as the link's only version, v1: the earlier versions go, their notes move onto v1.
  const makeFirst = async () => {
    if (!link) return;
    if (!(await askConfirm(`v1 to v${link.version} are removed from the link and every note is kept on v1. The script's own version history is untouched.`, { title: "Make the script as it is now v1?", ok: "Make this v1" }))) return;
    setMaking(true);
    setProblem(null);
    setLanded(false);
    setLandedSteps(null);
    try {
      const fresh = await compressReview(script.id);
      if (fresh.review) {
        said.current = `${fresh.review.url}#${fresh.review.version}`;
        setLanded(true);
        void navigator.clipboard?.writeText(fresh.review.url).catch(() => {});
      }
      change.current(fresh);
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setMaking(false);
    }
  };
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  // Deleting the link is asked first: it can't be undone (reviewers lose the page and their notes).
  const [deleting, setDeleting] = useState<"ask" | "running" | null>(null);
  useEffect(() => {
    if (!open) setDeleting(null);
  }, [open]);
  const removeLink = async () => {
    setDeleting("running");
    setProblem(null);
    try {
      onChange(await deleteReviewLink(script.id));
      onRefresh();
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setDeleting(null);
    }
  };
  const [approving, setApproving] = useState(false);
  const approve = async (yes: boolean) => {
    if (!link) return;
    const asked = yes
      ? askConfirm("The review link stops taking notes and the other versions' files are deleted. Every note from every round is kept, and the script's own version history is untouched.", { title: `Approve v${link.version}?`, ok: `Approve v${link.version}` })
      : askConfirm("The link takes notes again; files already deleted stay deleted.", { title: `Take back the approval of v${approved?.version}?`, ok: "Take back" });
    if (!(await asked)) return;
    setApproving(true);
    setProblem(null);
    try {
      await approveReview(script.id, yes);
      onRefresh();
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setApproving(false);
    }
  };
  const behind = link && link.revision !== script.revision;
  // What the dialog shows of a share under way: the server's last word, else the script's (opened mid-share), else its start.
  const stale = script.sharing !== undefined && script.sharing.startedAt === ended;
  const running: Sharing | null = sharing ? (live ?? { startedAt: Date.now() }) : sharingNow && !stale ? (live ?? script.sharing ?? null) : null;
  const cancelling = stopping || running?.stage === "cancelling";
  const stopShare = async () => {
    setStopping(true);
    setProblem(null);
    try {
      await cancelScriptShare(script.id);
      setLanded(false);
      setStopped(true);
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setStopping(false);
    }
  };
  const busyHere = running !== null || making;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="share-dialog"
      title={running ? runningTitle(running) : "Share"}
      description={
        running
          ? undefined
          : link
            ? "Each share publishes the script as it is now and adds it to this link as a new version. Only people signed in can open the link, read the script and leave notes."
            : "Publishes the script and makes a review link. Only people signed in can open it, read the script and leave notes. Later shares go on the same link as new versions."
      }
      width={500}
      footer={
        <>
          <span className="share-progress">
            {running && <span className="faint">It carries on if you close this.</span>}
            {!running && making && <span className="faint">Making this v1…</span>}
            {!running && !making && problem && <span className="bad">{problem}</span>}
            {!busyHere && !problem && stopped && <span className="faint">Cancelled</span>}
            {!busyHere && !problem && !stopped && landed && link && (
              <span className="up">
                <Icon name="check" size={13} /> Up on the link
              </span>
            )}
            {!busyHere && !problem && !stopped && !(landed && link) && !mayShare && <span className="faint">Sign in to share.</span>}
          </span>
          {running && (
            <button type="button" className="ghost" disabled={cancelling} onClick={() => void stopShare()}>
              {cancelling ? "Stopping…" : "Cancel"}
            </button>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
          {/* While it runs there is nothing to press but Cancel and Close; after a stop, this is the try again. */}
          {mayShare && !running && (
            <button type="button" className="primary share-go" disabled={making || busy} onClick={() => void share()}>
              {failed ? "Share again" : link ? `Share v${link.version + 1}` : "Share"}
            </button>
          )}
        </>
      }
    >
      {running ? (
        <ShareRunning sharing={running} durationMs={script.durationMs} />
      ) : (
      <div className="share-stack">
        {failed && (
          <p className="share-failed" role="status">
            <b>{failedLine(failed) || "Not shared."}</b>
            <span>{failed.error}</span>
          </p>
        )}
        {landed && link && landedSteps && landedSteps.steps.length > 0 && <ShareSteps steps={landedSteps.steps} version={landedSteps.version} durationMs={script.durationMs} />}
        {link && (
          <div className="share-card">
            <div className="share-url">
              <Icon name="link" size={14} />
              <a className="url" href={link.url} target="_blank" rel="noreferrer" title={link.url}>
                {link.url.replace(/^https?:\/\//, "")}
              </a>
              <button type="button" className="sm ghost" title="Copy the link" onClick={() => void copy()}>
                <Icon name={copied ? "check" : "copy"} size={13} />
              </button>
              <button type="button" className="sm" title="Open the link" onClick={() => window.open(link.url, "_blank", "noopener,noreferrer")}>
                <Icon name="external" size={13} /> Open
              </button>
            </div>
            <div className="share-meta">
              <span className="grow">
                {link.version} {link.version === 1 ? "version" : "versions"}, latest v{link.version}
                {behind ? " · the script has changed since" : ""}
                {approved && <span className="ok"> · v{approved.version} approved by {approved.by}</span>}
              </span>
              {mayShare && link.version > 1 && !approved && (
                <button type="button" className="sm ghost" disabled={busyHere || busy} title="The script as it is now becomes the link's only version, v1; every note is kept" onClick={() => void makeFirst()}>
                  Make this v1
                </button>
              )}
              {mayShare && deleting === null && (
                <button type="button" className="sm ghost" disabled={busyHere || busy} title={busyHere ? "It's being shared: delete the link once that's done" : busy ? "Claude is working on this script: delete the link once that's done" : "Delete this review link for good"} onClick={() => setDeleting("ask")}>
                  <Icon name="trash" size={13} /> Delete link
                </button>
              )}
              {mayShare && !approved && deleting === null && (
                <button type="button" className="sm ghost" disabled={busy || approving} title="The script is done: the link takes no more notes, and the other versions' files are deleted (their notes stay)" onClick={() => void approve(true)}>
                  {approving ? "Approving…" : `Approve v${link.version}`}
                </button>
              )}
            </div>
            {deleting !== null && (
              <div className="share-ask" role="alertdialog" aria-label="Delete the review link">
                <span>
                  <b>Delete this link?</b> It can't be undone: reviewers lose the page and every note on it{link.version > 1 ? `, v1 to v${link.version}` : ""}. The script and its own version history stay; sharing again makes a new link.
                </span>
                <button type="button" className="sm ghost" disabled={deleting === "running"} onClick={() => setDeleting(null)}>
                  Cancel
                </button>
                <button type="button" className="sm danger-fill" disabled={deleting === "running" || busyHere || busy} onClick={() => void removeLink()}>
                  {deleting === "running" ? "Deleting…" : "Delete link"}
                </button>
              </div>
            )}
          </div>
        )}
        {mayShare && flags.length > 0 && !approved && (
          <div className="review-flags">
            <strong>Before sharing: {flags.length === 1 ? "one thing" : `${flags.length} things`} the team would flag</strong>
            <ul>
              {flags.map((flag, index) => (
                <li key={index}>{flag}</li>
              ))}
            </ul>
          </div>
        )}
        <DocExportRow script={script} onChange={onChange} />
        {approved && (
          <p className="review-approved">
            <Icon name="check" size={14} />
            <span>
              <b>Approved v{approved.version}</b> · by {approved.by} · {when(approved.at)}
              <span className="faint"> · The link takes no more notes, and nothing is fixed by itself. Sharing again starts v{(link?.version ?? approved.version) + 1}, unapproved.</span>
            </span>
            {mayShare && (
              <button type="button" className="link-button" disabled={approving} onClick={() => void approve(false)}>
                Take back
              </button>
            )}
          </p>
        )}
      </div>
      )}
    </Dialog>
  );
}

// ---- Archived ---------------------------------------------------------------------


/**
 * An archived script, read-only: its footage was deleted to free space (from
 * Repack's page), its words and everything small kept. Restore brings the
 * footage back from its links; what came from this Mac's disk can't come back.
 */
export function ArchivedBanner({ script, working, onJob, onProblem }: { script: Script; working: boolean; onJob: (job: BuildStatus) => void; onProblem: (text: string) => void }) {
  const archive = script.archive;
  if (!archive) return null;
  const restore = async () => {
    try {
      onJob(await restoreScript(script.id));
    } catch (cause) {
      onProblem(message(cause));
    }
  };
  return (
    <div className="notice archived-notice">
      <span>
        <b>Footage archived</b> by {archive.by || "Repack"}, {when(archive.at)}
        {archive.freedBytes > 0 ? `, freeing ${formatBytes(archive.freedBytes)}` : ""}. The script and its words are kept; it reads but can't be edited until the footage is back.
        {archive.missing.length > 0 && <span className="bad"> Missing after the last restore (from {THIS_MACHINE}'s disk): {archive.missing.join(", ")}.</span>}
      </span>
      <button type="button" className="primary sm" disabled={working || archive.restoring} onClick={() => void restore()}>
        {working || archive.restoring ? "Restoring…" : "Restore footage"}
      </button>
    </div>
  );
}
