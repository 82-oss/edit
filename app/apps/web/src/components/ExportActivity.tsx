import { ChevronRight, Copy, Download, FileText, Film, FolderSearch, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api, type ExportActivity as Activity } from "../lib/api";
import { cardFace, exportLabel } from "../lib/export-face";
import { leftWords, onGraphics, whereLine } from "../lib/export-steps";
import { onThisMac, showInFinder } from "../lib/files";
import { cancelScriptShare } from "../writer/api";
import { useAccount } from "../lib/account";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { ExportSteps } from "./ExportSteps";
import { FolderPicker } from "./FolderBrowser";
import { ProblemView } from "./ProblemView";
import { Button, cx, DialogTitle, IconButton, Modal } from "./ui";
import { FILE_MANAGER, THIS_MACHINE } from "../lib/platform";

export const exportActive = (job: Activity) => job.state === "queued" || job.state === "running";

const jobKey = (job: Activity) => `${job.kind ?? "edit"}:${job.id}`;

/**
 * A finished edit, and where it is. On the Mac running Edit (its window, or a
 * browser there) the file is already here: shown in Finder, or copied to a
 * folder picked; a "download" there was a second copy dropped out of sight
 * (Sphe, Nov 4). From another device, it's that device's download.
 */
function Finished({ job }: { job: Activity }) {
  const [copying, setCopying] = useState(false);
  const here = job.onDisk === true && job.saved !== undefined;
  const link = `/api/exports/file?path=${encodeURIComponent(job.path)}`;
  if (!onThisMac()) {
    return (
      <div className="mt-2 ml-[22px] flex items-center gap-2">
        <a className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-hover" href={link} download>
          <Download size={13} /> Download
        </a>
        <span className="text-[12px] text-muted">to this device's Downloads folder</span>
      </div>
    );
  }
  return (
    <div className="mt-1 ml-[22px]">
      <div className="text-[12px] leading-snug break-all text-muted" title={job.path}>
        {here ? `Saved to ${job.saved}` : `Kept in the cloud, not on ${THIS_MACHINE}: a copy comes back down when you save one.`}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {here && (
          <Button size="sm" variant="subtle" onClick={() => showInFinder(job.path)}>
            <FolderSearch size={13} /> Show in Finder
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setCopying(true)}>
          <Copy size={13} /> Save a copy to…
        </Button>
      </div>
      <FolderPicker
        open={copying}
        onClose={() => setCopying(false)}
        title="Save a copy"
        detail={`A copy of ${job.name}'s export goes in the folder you pick. The one Edit keeps stays where it is.`}
        start={job.path.slice(0, job.path.lastIndexOf("/"))}
        confirm="Save here"
        onPick={async (folder) => {
          const { path } = await api.copyExport(job.path, folder);
          setCopying(false);
          useEditor.getState().toast(`Saved a copy to ${path.split("/").slice(-2).join("/")}`, "info", { label: `Show in ${FILE_MANAGER}`, run: () => showInFinder(path) });
        }}
      />
    </div>
  );
}

/** One face. The red sits behind it, so a word is never half one colour and half another. */
function QueueFace({ subtitle, percent, attention, seen }: { subtitle: string; percent: number | null; attention: boolean; seen: boolean }) {
  return (
    <span className="relative z-10 flex w-full min-w-0 flex-col px-3 py-[7px]">
      <span className={cx("flex w-full items-center gap-2 text-[13px] font-medium", attention || seen ? "text-secondary" : "text-white")}>
        <span className="min-w-0 flex-1 truncate">Exports</span>
        {percent !== null && <span className="tabular">{percent}%</span>}
      </span>
      <span className={cx("mt-0.5 block truncate text-[11.5px]", attention ? "text-danger" : seen ? "text-muted" : "text-white/75")}>{subtitle}</span>
    </span>
  );
}

/**
 * The shared queue on Home's sidebar, above Later and Done. Edits and script
 * shares are one list. The card uses that card's border and background, and
 * the share button's red fills it left to right with the overall progress.
 * Clicking opens the queue. Hidden while nothing is running or left undismissed.
 */
/** Finished exports already looked at in the queue, by job and its last change: this viewer's, kept across reloads. */
const SEEN_KEY = "edit:exports-seen";
function readSeen(): Record<string, number> {
  try {
    const kept = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as unknown;
    return kept !== null && typeof kept === "object" ? (kept as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function ExportActivity() {
  const [jobs, setJobs] = useState<Activity[]>([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Record<string, number>>(readSeen);
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const [stopping, setStopping] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  // Folded or unfolded by hand, by job; the one under way is unfolded until then.
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const allowed = useAccount((state) => state.account === null || state.account.signed_in || !state.account.required);
  useEffect(() => {
    if (!allowed) {
      setJobs([]);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      // A hidden window looks again once it's shown.
      if (!document.hidden) {
        try {
          const rows = await api.exportActivity();
          if (live) setJobs(rows);
        } catch {
          /* Keep known jobs while reconnecting. */
        }
      }
      if (live) timer = setTimeout(() => void look(), 2000);
    };
    void look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [allowed]);
  const visible = jobs.filter((job) => exportActive(job) || hidden[jobKey(job)] !== job.updated_ms);
  const stop = async (job: Activity) => {
    const key = jobKey(job);
    setStopping(key);
    try {
      if (job.kind === "script") await cancelScriptShare(job.id);
      else await api.cancelExport(job.id);
      setJobs(await api.exportActivity());
    } catch (error) {
      useEditor.getState().toastError(error, "stop the export");
    } finally {
      setStopping(null);
    }
  };
  const again = async (job: Activity) => {
    const key = jobKey(job);
    setRetrying(key);
    try {
      await api.retryExport(job.id);
      setJobs(await api.exportActivity());
    } catch (error) {
      useEditor.getState().toastError(error, "retry the export");
    } finally {
      setRetrying(null);
    }
  };
  if (!visible.length) return null;
  const face = cardFace(visible);
  // Under way first, then those in line in the order they were asked for, then what's ended.
  const rank = (job: Activity) => (!exportActive(job) ? 2 : job.steps?.queued === true || job.state === "queued" ? 1 : 0);
  const ordered = [...visible].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? (a.started_ms ?? a.updated_ms) - (b.started_ms ?? b.updated_ms) : 0));
  const lead = ordered.find((job) => exportActive(job) && job.steps !== undefined && !job.steps.queued);
  const leadKey = lead === undefined ? null : jobKey(lead);
  const firstInLine = ordered.find((job) => exportActive(job) && job.steps?.queued === true);
  // Looked at in the queue and nothing new since: grey, not red, until another export starts or ends (Sphe, Nov 16).
  const allSeen = visible.every((job) => !exportActive(job) && seen[jobKey(job)] === job.updated_ms);
  const look = () => {
    setOpen(true);
    const next = Object.fromEntries(visible.filter((job) => !exportActive(job)).map((job) => [jobKey(job), job.updated_ms]));
    setSeen(next);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* Seen for this page only. */
    }
  };
  const dismiss = (job: Activity) => setHidden((previous) => ({ ...previous, [jobKey(job)]: job.updated_ms }));
  return (
    <>
      <button
        type="button"
        onClick={look}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={face.percent === null ? `Exports, ${face.title}` : `Exports, ${face.title}, ${face.percent}%`}
        title={face.title}
        className="relative mb-1 w-full min-w-0 overflow-hidden rounded-xl border border-line bg-panel text-left transition-colors hover:bg-hover"
      >
        {face.percent !== null && face.percent > 0 && (
          <span aria-hidden className={cx("pointer-events-none absolute inset-y-0 left-0 transition-[width,background-color] duration-300 ease-out", allSeen ? "bg-active" : face.graphics ? "fill-shimmer bg-primary" : "bg-primary")} style={{ width: `${face.percent}%` }} />
        )}
        <QueueFace subtitle={face.subtitle} percent={face.percent} attention={face.attention} seen={allSeen} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} width={500}>
        <div className="px-6 pt-6">
          <DialogTitle title="Exports" detail="Edits and scripts share this queue. They keep going if you close this or leave the project." />
        </div>
        <div className="mt-3 max-h-[60vh] overflow-y-auto border-t border-line">
          {ordered.map((job) => {
            const script = job.kind === "script";
            const key = jobKey(job);
            const steps = exportActive(job) ? job.steps : undefined;
            const inLine = steps?.queued === true;
            const unfolds = steps !== undefined && !inLine;
            const open = unfolds && (folded[key] ?? key !== leadKey) === false;
            const percent = steps === undefined ? null : Math.round(steps.progress * 100);
            const left = leftWords(steps?.left_s);
            const openProject = () => {
              setOpen(false);
              navigate(script ? `/scripts/${job.id}` : `/p/${job.id}`);
            };
            const cancel = (
              <Button size="sm" variant="ghost" disabled={stopping === key || job.stage === "cancelling"} onClick={() => void stop(job)}>
                {stopping === key || job.stage === "cancelling" ? "Stopping…" : steps !== undefined ? "Cancel export" : "Cancel"}
              </Button>
            );
            return (
              <div key={key} className="border-b border-line px-6 py-3 last:border-b-0">
                <div className="flex items-center gap-2">
                  {unfolds ? (
                    <button type="button" aria-expanded={open} aria-label={open ? `Fold ${job.name}'s steps` : `Show ${job.name}'s steps`} className="-m-1 rounded p-1 text-faint transition-colors hover:text-fg" onClick={() => setFolded((was) => ({ ...was, [key]: open }))}>
                      <ChevronRight size={14} className={cx("transition-transform duration-200", open && "rotate-90")} />
                    </button>
                  ) : script ? (
                    <FileText size={14} className="shrink-0 text-muted" />
                  ) : (
                    <Film size={14} className="shrink-0 text-muted" />
                  )}
                  <button type="button" className={cx("min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:underline", job.state === "done" && "text-secondary")} title={`Open ${job.name}`} onClick={openProject}>
                    {job.name}
                  </button>
                  {inLine ? (
                    <span className={cx("shrink-0 rounded-full px-[7px] py-0.5 text-[10.5px] font-semibold tracking-[0.02em]", job === firstInLine ? "bg-warning-soft text-warning" : "bg-active text-secondary")}>
                      {job === firstInLine ? "Next" : "Queued"}
                    </span>
                  ) : steps !== undefined ? (
                    <span className="shrink-0 text-[12px] text-muted tabular">{[`${percent}%`, left].filter(Boolean).join(" · ")}</span>
                  ) : exportActive(job) ? (
                    cancel
                  ) : (
                    <>
                      {!script && job.state === "done" && job.onDisk === true && <span className="shrink-0 text-[12px] text-success">Saved</span>}
                      {!script && (job.state === "failed" || job.state === "cancelled") && (
                        <Button size="sm" variant="ghost" disabled={retrying === key} onClick={() => void again(job)}>
                          {retrying === key ? "Retrying…" : "Retry"}
                        </Button>
                      )}
                      <IconButton label={`Dismiss ${job.name}'s export`} onClick={() => dismiss(job)}>
                        <X size={12} />
                      </IconButton>
                    </>
                  )}
                </div>
                {job.note && <div className="mt-1 pl-[22px] text-[12px] text-muted">{job.note}</div>}
                {job.state === "failed" && job.error ? (
                  <ProblemView error={job.error} doing="export it" className="mt-1.5" />
                ) : steps !== undefined ? (
                  <div className="mt-[3px] truncate pl-[22px] text-[12px] text-muted">
                    {inLine ? [steps.where === "here" ? `Save to ${THIS_MACHINE}` : "Send for feedback", ordered.indexOf(job) > 0 ? "starts after the one above" : job.waiting, left === null ? null : `${left} once it does`].filter(Boolean).join(" · ") : whereLine(steps)}
                  </div>
                ) : (
                  <div className="mt-1 pl-[22px] text-[12px] text-muted">{script ? `Script · ${exportLabel(job)}` : exportLabel(job)}</div>
                )}
                {exportActive(job) && !inLine && (
                  <div className="mt-2 ml-[22px] h-1 overflow-hidden rounded-full bg-active" aria-hidden>
                    <div className={cx("h-full rounded-full transition-[width] duration-300 ease-out", onGraphics(steps) ? "fill-shimmer bg-primary" : "bg-primary")} style={{ width: `${Math.round((steps?.progress ?? job.progress) * 100)}%` }} />
                  </div>
                )}
                {open && steps !== undefined && (
                  <>
                    <ExportSteps steps={steps.steps} small className="mt-2.5 mb-0.5 ml-[22px]" />
                    <div className="mt-2 ml-[22px] flex gap-1.5">
                      <Button size="sm" variant="subtle" onClick={openProject}>
                        Open project
                      </Button>
                      {cancel}
                    </div>
                  </>
                )}
                {!script && job.state === "done" && job.path !== "" && <Finished job={job} />}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-end px-6 py-4">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>
    </>
  );
}
