import { Check, Copy, Download, ExternalLink, FolderSearch, HardDriveDownload, Link2, MessageSquareText, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ExportSteps as Steps } from "@edit/types/export_steps";

import { api, type RangesBatch, type RangesMode, type Review } from "../lib/api";
import { projectDuration } from "../lib/edit";
import { marked as markedStretches } from "../lib/inOut";
import { shareStatus, shownPath } from "../lib/export-face";
import { aboutLeft } from "../lib/export-steps";
import { chaptersInSpan, DEFAULTS, scriptChapters, type ExportOptions } from "../lib/exporting";
import { onThisMac, showInFinder } from "../lib/files";
import { FILE_MANAGER, THIS_MACHINE } from "../lib/platform";
import { preview } from "../lib/playback";
import { readSetting, writeSetting } from "../lib/storage";
import { flushSave, useEditor } from "../lib/store";
import { clock } from "../lib/time";
import { rate } from "../lib/types";
import { useGrants } from "../writer/can";
import { askExportFolder } from "./ExportFolder";
import { ExportSteps } from "./ExportSteps";
import { ProblemView } from "./ProblemView";
import { Button, cx, Modal, Select } from "./ui";

/**
 * Share replaces Export (Oct 24): one button exports the whole edit for
 * YouTube (the project's size and rate, H.264, a keyframe every half second,
 * 320 kbps sound, −14 LUFS, the script's chapters) and puts it on the
 * project's review link, where anyone with it watches and leaves notes at a
 * moment, and the notes come back to the agent. The first share makes the
 * link. A later share replaces the latest version when it has no comments,
 * and adds the next version when it has any.
 *
 * Export is back beside it (JJ, Nov 10: "an export option that is only to
 * export on your pc … not to the feedback link where it takes a year"): the
 * same file, in the exports folder of the computer running Edit and nowhere
 * else. No review copy, no upload, no link, so it's there when the encode
 * ends (his Mac, Nov 9: an export of 24 s, and a link 19 min 35 s later).
 * The dialog is Export, and its two ways are side by side, each saying where
 * the video goes (Sphe, Nov 10: "the distinction between share and export
 * needs to be made more clear"): saved on this Mac, or sent for feedback.
 *
 * They're options with one Export button, the last one picked kept (Sphe,
 * Nov 12: "these two things should more be options and not buttons"). When
 * the agent has marked stretches (set_ranges, "set all the in and out points
 * for me"), saving here offers a video of each or one of them joined, beside
 * the whole edit ("i should be able to pick between those two options"), as
 * three cards, each with a picture of what comes out (Sphe, Nov 17: "7 videos,
 * one a stret…" didn't say whether it was seven files or one): the person
 * sees "parts", never "stretches".
 */
type Where = "here" | "feedback";
type What = "whole" | RangesMode;
const WHERE = "edit.export.where";
const WHAT = "edit.export.what";
const keptWhere = (): Where => (readSetting(WHERE) === "feedback" ? "feedback" : "here");
const keptWhat = (): What => {
  const kept = readSetting(WHAT);
  return kept === "each" || kept === "joined" ? kept : "whole";
};
const HOUSE: Omit<ExportOptions, "range" | "chapters"> = { ...DEFAULTS, size: null, fps: null, preset: "youtube" };
/** "Sam's Interrogations’ logo", "Inspector Ted’s logo". */
const possessive = (name: string) => (/s$/iu.test(name) ? `${name}’` : `${name}’s`);

export function ShareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((state) => state.project);
  const exportState = useEditor((state) => state.exportState);
  const toast = useEditor((state) => state.toast);
  const [review, setReview] = useState<Review | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  // Deleting the link is asked first (it can't be undone).
  const [deleting, setDeleting] = useState<"ask" | "running" | null>(null);
  const mayDelete = useGrants().shares;
  // A channel's watermark on the export (Sphe, Nov 2: "a checkbox to include the watermark and we pick the channel"):
  // a channel's project offers its channel's logo alone, or nothing when it has none (Sphe, Nov 16: "show watermarks
  // when available for that specific channel"); a project of no channel picks from the Watermarks folder's pictures.
  // What's offered and the project's last choice are the server's (channel_marks.ts, review.watermark).
  const [channels, setChannels] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const [usual, setUsual] = useState<string | null>(null);
  const [channelsFailed, setChannelsFailed] = useState<string | null>(null);
  const own = Boolean(project?.channel);
  const [marked, setMarked] = useState(false);
  const [channel, setChannel] = useState<string | null>(null);
  const [markTouched, setMarkTouched] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // A share or export just stopped here, so a finished export isn't announced as the new version.
  const [stopped, setStopped] = useState(false);
  // The export asked for here was an Export (this computer only), not a share's.
  const [only, setOnly] = useState(false);
  // The exports folder as shown ("~/Movies/Edit") and this computer's home, so where an Export went reads as `~/…`.
  const [folder, setFolder] = useState<{ shown: string; home: string } | null>(null);
  const [where, setWhere] = useState<Where>(keptWhere);
  const [what, setWhat] = useState<What>(keptWhat);
  // The marked stretches' export, and whether it's what the dialog says (begun here, or running as it opened).
  const [batch, setBatch] = useState<RangesBatch | null>(null);
  const [batchShown, setBatchShown] = useState(false);
  // What was picked as the export ended in failure, so changing it after makes Export the action, not Retry.
  const [endedWith, setEndedWith] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setMarkTouched(false);
    void api.exportFolder().then(
      (given) => setFolder({ shown: given.shown, home: given.home }),
      // Shown whole, then.
      () => {},
    );
    if (!project?.id) return;
    void api.watermarks(project.id).then(
      (given) => {
        setChannels(given.channels);
        setUsual(given.usual ?? null);
        setChannelsFailed(null);
      },
      (error: Error) => setChannelsFailed(error.message),
    );
  }, [open, project?.id]);
  const batchRunning = batch !== null && !batch.finished;
  // The dialog opened (after a reload too): the last stretches' export shows, finished or not, with its Download (Sphe, Nov 12: "I refreshed ... it was just gone").
  const openedRef = useRef(false);
  useEffect(() => {
    if (!open) openedRef.current = false;
  }, [open]);
  useEffect(() => {
    if (!open || !project?.id) return;
    let live = true;
    const look = () =>
      void api.rangesExport(project.id).then(
        (given) => {
          if (!live) return;
          setBatch(given);
          if (given !== null && (!given.finished || !openedRef.current)) setBatchShown(true);
          openedRef.current = true;
        },
        () => {},
      );
    look();
    const timer = setInterval(look, batchRunning ? 1000 : 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, project?.id, batchRunning]);
  const sections = preview.sections;
  const chapters = useMemo(() => (project ? scriptChapters(project, sections) : []), [project, sections]);
  const id = project?.id ?? "";

  // The review as it stands, and while a share runs, how it's going (the server's share job, the one answer Home and the Exports panel read too).
  const sharing = review?.sharing ?? null;
  const lastShare = review?.share ?? null;
  useEffect(() => {
    if (!open || !id) return;
    let live = true;
    const look = () =>
      void api
        .review(id)
        .then((given) => live && setReview(given))
        // Noted by api.ts; the next look asks again.
        .catch(() => {});
    look();
    const timer = setInterval(look, sharing !== null || starting ? 1500 : 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, id, sharing, starting]);

  // While it runs, its steps: the same row of the Exports queue the sidebar's card reads (the server's export_steps.ts).
  const [steps, setSteps] = useState<Steps | null>(null);
  const going = starting || sharing !== null || exportState?.state === "queued" || exportState?.state === "running";
  useEffect(() => {
    if (!open || !id || !going) {
      setSteps(null);
      return;
    }
    let live = true;
    const look = () =>
      void api.exportActivity().then(
        (rows) => {
          if (!live) return;
          const row = rows.find((one) => one.id === id && (one.kind ?? "edit") === "edit" && (one.state === "queued" || one.state === "running"));
          setSteps(row?.steps ?? null);
        },
        // The next look asks again.
        () => {},
      );
    look();
    const timer = setInterval(look, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, id, going]);

  // A share under way (begun here, or by Ready for changes) is what the dialog says, not an Export before it.
  useEffect(() => {
    if (sharing !== null) setOnly(false);
  }, [sharing]);

  // The watermark its next share carries, until it's changed here: the server's (reviews.nextWatermark: as last shared;
  // never shared, its channel's own or its kind's last), the one its export made ahead has, so Export copies every chunk.
  const savedMark = review?.watermark ?? null;
  useEffect(() => {
    if (markTouched || review === null) return;
    setMarked(savedMark !== null);
    if (savedMark !== null) setChannel(savedMark);
  }, [review, savedMark, markTouched]);
  useEffect(() => {
    // A channel's project: its channel's logo, whatever was picked before.
    if (own && channels) setChannel(channels[0]?.id ?? null);
    else if (channel === null && channels && channels.length > 0) setChannel((channels.find((one) => one.id === usual) ?? channels[0]!).id);
  }, [own, channels, channel, usual]);

  // A share that just finished: its link copied, said once.
  const [said, setSaid] = useState<string | null>(null);
  const latest = review?.review && review.review.versions.length > 0 ? Math.max(...review.review.versions.map((one) => one.n)) : null;
  useEffect(() => {
    if (!review?.review || sharing !== null || latest === null) return;
    const key = `${review.review.url}#${latest}`;
    if (said === null) {
      setSaid(key);
      return;
    }
    if (key !== said) {
      setSaid(key);
      // Said as it is: a copy refused (the window not focused) leaves the link in the dialog to copy by hand.
      const shared = `Shared v${latest}`;
      void (navigator.clipboard?.writeText(review.review.url) ?? Promise.reject(new Error("no clipboard"))).then(
        () => toast(`${shared}: link copied`, "info"),
        () => toast(shared, "info"),
      );
    }
  }, [review, sharing, latest, said, toast]);

  const failedNow = exportState?.state === "failed" || lastShare?.state === "failed";
  useEffect(() => {
    setEndedWith(failedNow ? `${where}|${what}|${marked ? channel : ""}` : null);
    // Only as it fails: what's picked after is the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedNow, open]);

  if (!project) return null;
  const busy = starting || sharing !== null;
  const exporting = exportState?.state === "queued" || exportState?.state === "running";
  const link = review?.review ?? null;
  // One at a time: either way makes the same file.
  const unable = busy || exporting || retrying || batchRunning || projectDuration(project) <= 0;
  // Everything marked to export, the in and out points among them (lib/inOut.ts).
  const ranges = markedStretches(project);
  // Stretches are saved here, not sent for feedback (the link is the edit's versions).
  const choosing = where === "here" && ranges.length > 0;
  // One stretch has nothing to join to: it's that stretch's video.
  const picked: What = what === "joined" && ranges.length === 1 ? "each" : what;
  const chosen: What = choosing ? picked : "whole";

  // Share and Export make the same file: the edit as saved, whole, the house export.
  const start = async (go: (options: ExportOptions, watermark: string | null) => Promise<void>) => {
    if (busy || exporting || batchRunning) return;
    setStarting(true);
    setStopped(false);
    setProblem(null);
    try {
      await askExportFolder();
      // The folder just chosen is the one the card names (it said ~/Movies/Edit still: kenobi, Nov 16).
      void api.exportFolder().then(
        (given) => setFolder({ shown: given.shown, home: given.home }),
        () => {},
      );
      useEditor.getState().endGesture();
      await flushSave();
      if (useEditor.getState().dirty) throw new Error("The latest changes couldn’t be saved. Try again once the connection returns.");
      const duration = projectDuration(project);
      const span: [number, number] = [0, duration];
      const embedded = chaptersInSpan(chapters, span, rate(project.settings));
      await go({ ...HOUSE, range: span, chapters: embedded.length >= 2 ? embedded : [] }, marked && channel !== null ? channel : null);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const share = () =>
    start(async (options, watermark) => {
      setOnly(false);
      setBatchShown(false);
      await api.shareProject(project.id, options, false, true, watermark);
      setReview(await api.review(project.id));
    });
  const exportHere = () =>
    start(async (options, watermark) => {
      await api.exportHere(project.id, options, watermark);
      setOnly(true);
      setBatchShown(false);
    });
  const exportStretches = (mode: RangesMode) =>
    start(async (options, watermark) => {
      setBatch(await api.exportRanges(project.id, mode, options, watermark));
      setBatchShown(true);
    });
  // What's picked in the dialog, done: Export's click, and Retry when the server has nothing of it to retry.
  const asPicked = () => {
    writeSetting(WHERE, where);
    if (choosing) writeSetting(WHAT, what);
    if (where === "feedback") return share();
    return chosen === "whole" ? exportHere() : exportStretches(chosen);
  };
  const go = () => void asPicked();

  // Approving deletes the other versions' files: two clicks.
  const approve = async () => {
    if (!approving) {
      setApproving(true);
      return;
    }
    try {
      const done = await api.approveReview(project.id);
      toast(`Approved v${done.version}`, "info");
      setReview(await api.review(project.id));
    } catch (error) {
      useEditor.getState().toastError(error, "approve it");
    } finally {
      setApproving(false);
    }
  };

  const removeLink = async () => {
    setDeleting("running");
    setProblem(null);
    try {
      await api.deleteReview(project.id);
      toast("Review link deleted", "info");
      setSaid(null);
      setReview(await api.review(project.id));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  // The server's answer: a reviewer's comment on the latest version makes the next share a new version, else it replaces it.
  const next = review?.next ?? null;
  const status = shareStatus({ exportState, sharing, share: lastShare, linked: link !== null, stopped, only });
  // The stretches' export says how it went in place of its parts' exports; finished, only while it's the last thing that
  // happened (the server leaves out one an export came after; a share's is said here): yesterday's stood in for today's share.
  const batchLast = batch !== null && (!batch.finished || (sharing === null && review !== null && (lastShare === null || lastShare.at <= (batch.finished_ms ?? 0))));
  const showBatch = batchShown && batch !== null && batchLast;
  // The steps in place of the progress line, while this edit's export or share runs (not the marked stretches').
  const running = busy || exporting || batchRunning;
  const stepsShown = steps !== null && !showBatch && (exporting || sharing !== null) && !problem;
  const ended = !showBatch && !busy && !exporting && (status.kind === "share-failed" || status.kind === "export-failed" || status.kind === "cancelled");
  // One next action once it's over (Astra, Nov 18: Retry and Export side by side): a failure, its choices as they were,
  // is tried again the way it was asked; a cancel, or anything changed since, is a new export with what's picked now.
  const asked = `${where}|${what}|${marked ? channel : ""}`;
  const retryable = ended && status.kind !== "cancelled" && (endedWith === null || endedWith === asked);
  const retry = async () => {
    if (busy || retrying) return;
    setRetrying(true);
    setProblem(null);
    try {
      await api.retryExport(project.id);
      setStopped(false);
      setReview(await api.review(project.id));
    } catch (error) {
      // Nothing of it on the server (cancelled before an export existed, or failed while it waited on its graphics):
      // what failed is done again, a share as a share (Ready for changes starts them too), anything else as picked here.
      // It was a share whatever had failed, and a failed Save to Mac went up to the review link as a new version, on a
      // link a client may have (audit E10c, Nov 21).
      if ((error as Error).message === "nothing to retry") {
        setRetrying(false);
        await (status.kind === "share-failed" ? share() : asPicked());
        return;
      }
      setProblem((error as Error).message);
    } finally {
      setRetrying(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    setProblem(null);
    try {
      if (sharing !== null) await api.cancelShare(project.id);
      if (batchRunning) {
        await api.cancelRanges(project.id);
        setBatch(await api.rangesExport(project.id));
      } else if (exporting) await api.cancelExport(project.id);
      setStopped(true);
      setReview(await api.review(project.id));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={500}>
      <div className="p-6">
        <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Export</h2>

        <div className="mt-4 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Where it goes">
          <Choice
            icon={<HardDriveDownload size={16} />}
            title={`Save to ${THIS_MACHINE}`}
            detail={`The video file, in ${folder?.shown ?? "your exports folder"}. Nothing is uploaded.`}
            selected={where === "here"}
            onClick={() => setWhere("here")}
          />
          <Choice
            icon={<MessageSquareText size={16} />}
            title="Send for feedback"
            detail="Uploads it to the review link, where the team watches it and leaves notes for the agent."
            note={link && next !== null ? (next.replace ? `Replaces v${next.version}: no one has commented on it` : `Adds v${next.version} to the link`) : link ? null : "Makes the link"}
            selected={where === "feedback"}
            onClick={() => setWhere("feedback")}
          />
        </div>

        {choosing && <Scope ranges={ranges} edit={projectDuration(project) / rate(project.settings)} fps={rate(project.settings)} picked={picked} onPick={setWhat} />}

        {stepsShown && <ExportSteps steps={steps.steps} className="mt-4" />}

        {link && (
          <div className="mt-4 flex flex-col rounded-[10px] border border-line bg-panel">
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <Link2 size={14} className="shrink-0 text-muted" />
              <a href={link.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[13px] text-fg hover:underline" title={link.url}>
                {link.url.replace(/^https?:\/\//, "")}
              </a>
              <Button size="sm" variant="ghost" title="Copy the link" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => toast("Link copied", "info"))}>
                <Copy size={13} />
              </Button>
              <a href={link.url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="subtle">
                  <ExternalLink size={13} /> Open
                </Button>
              </a>
            </div>
            <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-[12px] text-muted">
              <span className="flex-1">
                {latest !== null ? `${link.versions.length} ${link.versions.length === 1 ? "version" : "versions"}, latest v${latest}` : "No versions yet"}
                {link.approved && <span className="text-success"> · v{link.approved.version} approved by {link.approved.by}</span>}
              </span>
              {mayDelete && deleting === null && (
                <Button size="sm" variant="ghost" disabled={busy} title={busy ? "It's being shared: delete the link once that's done" : "Delete this review link for good"} onClick={() => setDeleting("ask")}>
                  <Trash2 size={13} /> Delete link
                </Button>
              )}
              {!link.approved && latest !== null && deleting === null && (
                <Button
                  size="sm"
                  variant={approving ? "danger" : "ghost"}
                  onClick={() => void approve()}
                  title="The team signed it off: the review closes, and the other versions' files and their exports here are deleted (their notes stay)"
                >
                  {approving ? `Approve v${latest} and delete the others` : `Approve v${latest}`}
                </Button>
              )}
            </div>
            {deleting !== null && (
              <div className="flex items-center gap-2 border-t border-line px-3 py-2.5 text-[12px]">
                <span className="min-w-0 flex-1 text-fg">Delete this link? It can't be undone: reviewers lose the page and every note on it. The exports here stay.</span>
                <Button size="sm" variant="ghost" disabled={deleting === "running"} onClick={() => setDeleting(null)}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" disabled={deleting === "running" || busy} onClick={() => void removeLink()}>
                  {deleting === "running" ? "Deleting…" : "Delete link"}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* A channel's project whose channel has no watermark: no watermark at all (shown while it's read only if reading it failed). */}
        {(!own || channelsFailed !== null || (channels !== null && channels.length > 0)) && (
          <div className="mt-4 flex items-center gap-3 rounded-[10px] border border-line bg-panel px-3 py-2.5">
            <label className="flex min-w-0 flex-1 items-center gap-2.5 text-[13px]" title="The channel's logo at 10%, moving around the frame like a DVD player's, over everything">
              <input
                type="checkbox"
                checked={marked}
                disabled={busy || channels === null || channels.length === 0}
                onChange={(event) => {
                  setMarkTouched(true);
                  setMarked(event.target.checked);
                }}
              />
              <span className="min-w-0">
                <span className="block text-fg">Watermark</span>
                <span className="block text-[12px] leading-snug text-muted">
                  {channelsFailed ? `The channels didn’t load: ${channelsFailed}` : channels === null ? "Loading the channels…" : channels.length === 0 ? "No channels in the Watermarks folder" : own ? `${possessive(channels[0]!.name)} logo at 10%, moving around the frame` : "The channel’s logo at 10%, moving around the frame"}
                </span>
              </span>
            </label>
            {!own && channels && channels.length > 0 && channel !== null && (
              <Select
                value={channel}
                options={channels.map((one) => ({ value: one.id, label: one.name }))}
                onChange={(value) => {
                  setMarkTouched(true);
                  setChannel(value);
                  setMarked(true);
                }}
                className={cx("h-[30px] min-w-[150px] shrink-0 justify-between rounded-lg border border-line-strong bg-bg pr-2.5 pl-3 text-[13px] hover:border-muted", !marked && "opacity-50")}
              />
            )}
          </div>
        )}

        {/* An Export's file, where it is (JJ, Nov 10: "save it locally and display where it is saved"). */}
        {showBatch && batch.finished && !batch.error && !batch.cancelled && batch.outputs.length > 0 && (
          <div className="mt-4 flex items-center gap-2.5 rounded-[10px] border border-line bg-panel px-3 py-2.5 text-[13px]">
            <Check size={14} className="shrink-0 text-success" />
            <span className="min-w-0 flex-1 truncate text-fg" title={batch.outputs.join("\n")}>
              {batch.outputs.length === 1 ? `Saved to ${shownPath(batch.outputs[0]!, folder?.home ?? null)}` : `${batch.outputs.length} videos saved to ${folder?.shown ?? "your exports folder"}`}
            </span>
            {onThisMac() ? (
              <Button size="sm" variant="subtle" className="shrink-0" onClick={() => showInFinder(batch.outputs[0]!)}>
                <FolderSearch size={13} /> Show in {FILE_MANAGER}
              </Button>
            ) : (
              batch.outputs.length === 1 && (
                <a className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-hover" href={`/api/exports/file?path=${encodeURIComponent(batch.outputs[0]!)}`} download>
                  <Download size={13} /> Download
                </a>
              )
            )}
          </div>
        )}

        {!showBatch && !problem && status.kind === "saved" && (
          <div className="mt-4 flex items-center gap-2.5 rounded-[10px] border border-line bg-panel px-3 py-2.5 text-[13px]">
            <Check size={14} className="shrink-0 text-success" />
            <span className="min-w-0 flex-1 truncate text-fg" title={status.path}>
              Saved to {shownPath(status.path, folder?.home ?? null)}
            </span>
            {onThisMac() ? (
              <Button size="sm" variant="subtle" className="shrink-0" onClick={() => showInFinder(status.path)}>
                <FolderSearch size={13} /> Show in {FILE_MANAGER}
              </Button>
            ) : (
              <a className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-hover" href={`/api/exports/file?path=${encodeURIComponent(status.path)}`} download>
                <Download size={13} /> Download
              </a>
            )}
          </div>
        )}

        <div className="mt-5 flex min-h-[34px] items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px]">
            {showBatch && !problem && (
              <>
                {!batch.finished && (
                  <span className="text-muted tabular">
                    {batch.current === "joining them" ? "Joining them…" : `Exporting ${batch.current ?? "…"} · ${Math.min(batch.done + 1, batch.total)} of ${batch.total}`}
                  </span>
                )}
                {batch.finished && batch.cancelled && <span className="text-muted">Cancelled</span>}
                {batch.finished && !batch.cancelled && batch.error && <ProblemView error={batch.error} doing="export the marked parts" />}
              </>
            )}
            {showBatch ? null : <>
            {status.kind === "progress" && (stepsShown ? <span className="text-muted tabular">{aboutLeft(steps.left_s)}</span> : <span className="text-muted tabular">{status.text}</span>)}
            {status.kind !== "progress" && problem && <ProblemView error={problem} doing="share it" />}
            {!problem && status.kind === "share-failed" && <ProblemView error={status.error} doing="share it" />}
            {!problem && status.kind === "export-failed" && (status.error ? <ProblemView error={status.error} doing="export it" /> : <span className="text-muted">Export failed</span>)}
            {!problem && status.kind === "cancelled" && <span className="text-muted">Cancelled</span>}
            {/* Only once the server says the version is published: the export finishing is not the share. */}
            {!problem && status.kind === "up" && (
              <span className="flex items-center gap-1.5 text-success">
                <Check size={13} /> Up on the link
              </span>
            )}
            </>}
            {showBatch && problem && <ProblemView error={problem} doing="export it" />}
          </div>
          {(exporting || sharing !== null || batchRunning) && (
            <Button variant="ghost" disabled={stopping || sharing === "cancelling"} onClick={() => void stop()}>
              {stopping || sharing === "cancelling" ? "Stopping…" : "Cancel export"}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {/* While one runs, Cancel export and Close; once it's over, one action: Retry a failure, Export again after a cancel. */}
          {!running &&
            (retryable ? (
              <Button variant="primary" disabled={retrying} onClick={() => void retry()}>
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            ) : (
              <Button variant="primary" disabled={unable} onClick={go}>
                {ended && status.kind === "cancelled" ? "Export again" : "Export"}
              </Button>
            ))}
        </div>
      </div>
    </Modal>
  );
}

/** Where the video goes: one of two options, said on the option itself. */
function Choice({ icon, title, detail, note, selected, onClick }: { icon: React.ReactNode; title: string; detail: string; note?: string | null; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        "flex min-w-0 flex-col items-start gap-1.5 rounded-[10px] border p-3.5 text-left transition-colors",
        selected ? "border-primary/60 bg-primary/10" : "border-line bg-panel hover:bg-hover",
      )}
    >
      <span className="flex items-center gap-2 text-[14px] font-semibold text-fg">
        <span className={selected ? "text-primary" : "text-muted"}>{icon}</span>
        {title}
      </span>
      <span className="text-[12px] leading-snug text-muted">{detail}</span>
      {note && <span className="text-[12px] leading-snug text-secondary">{note}</span>}
    </button>
  );
}

/** The pictogram's blocks: at most this many, each 5–15 px by its length (one alone, 32), shrunk alike to fit the card. */
const MOST_BLOCKS = 30;

/**
 * What the save holds, when parts are marked: the whole edit, each part its own video, or the parts as one, three cards
 * side by side, each a picture of what comes out (one bar, the blocks apart, the blocks butted), then what it is in words.
 */
function Scope({ ranges, edit, fps, picked, onPick }: { ranges: { start: number; end: number }[]; edit: number; fps: number; picked: What; onPick: (what: What) => void }) {
  const lengths = ranges.map((one) => (one.end - one.start) / fps);
  const total = lengths.reduce((sum, one) => sum + one, 0);
  const many = ranges.length > 1;
  const options: { value: What; title: string; detail: string }[] = many
    ? [
        { value: "whole", title: "The whole edit", detail: `1 video · ${clock(edit)}` },
        { value: "each", title: "Each part on its own", detail: `${ranges.length} videos · one per marked part` },
        { value: "joined", title: "The parts as one", detail: `1 video · ${ranges.length} parts back to back · ${clock(total)}` },
      ]
    : [
        { value: "whole", title: "The whole edit", detail: `1 video · ${clock(edit)}` },
        { value: "each", title: "The marked part", detail: `1 video · ${clock(total)}` },
      ];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, by: number) => {
    const to = (from + by + options.length) % options.length;
    onPick(options[to]!.value);
    refs.current[to]?.focus();
  };
  return (
    <div className={cx("mt-3 grid gap-2.5", many ? "grid-cols-3" : "grid-cols-2")} role="radiogroup" aria-label="What it exports">
      {options.map((option, index) => {
        const selected = picked === option.value;
        return (
          <button
            key={option.value}
            ref={(button) => {
              refs.current[index] = button;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onPick(option.value)}
            onKeyDown={(event) => {
              const by = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
              if (by === 0) return;
              event.preventDefault();
              move(index, by);
            }}
            className={cx(
              "flex min-w-0 flex-col items-stretch rounded-[10px] border px-3 pt-3 pb-3 text-left transition-colors",
              selected ? "border-primary/60 bg-primary/10" : "border-line bg-panel hover:bg-hover",
            )}
          >
            <Pictogram shape={option.value} lengths={lengths} selected={selected} />
            <span className="mt-2.5 text-[13.5px] leading-snug font-semibold text-fg">{option.title}</span>
            <span className="mt-0.5 text-[12px] leading-snug text-muted tabular">{option.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One full bar for the whole edit; the parts' blocks apart for each its own, butted into one bar for them joined. */
function Pictogram({ shape, lengths, selected }: { shape: What; lengths: number[]; selected: boolean }) {
  const fill = selected ? "bg-primary" : "bg-line-strong";
  if (shape === "whole") {
    return (
      <span className="flex h-[30px] items-center" aria-hidden>
        <i className={cx("block h-[18px] flex-1 rounded-[3px] transition-colors", fill)} />
      </span>
    );
  }
  const shown = lengths.slice(0, MOST_BLOCKS);
  const longest = Math.max(...shown, 1e-9);
  const apart = shape === "each" && shown.length > 1;
  // Butted, a hairline between them, so the one bar still reads as its parts.
  const gap = !apart ? (shown.length > 1 ? 1 : 0) : shown.length <= 8 ? 6 : shown.length <= 16 ? 3 : 2;
  return (
    <span className="flex h-[30px] min-w-0 items-center overflow-hidden" style={{ gap }} aria-hidden>
      {shown.map((length, index) => (
        <i
          key={index}
          className={cx("block h-[18px] min-w-[2px] shrink transition-colors", fill)}
          style={{
            width: shown.length === 1 ? 32 : 5 + 10 * (length / longest),
            borderRadius: apart || shown.length === 1 ? 3 : index === 0 ? "3px 0 0 3px" : index === shown.length - 1 ? "0 3px 3px 0" : 0,
          }}
        />
      ))}
    </span>
  );
}
