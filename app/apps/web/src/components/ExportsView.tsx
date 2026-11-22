// Home's Exports (Sphe, Nov 18, in Later's place, the floating queue gone
// into it): the sidebar's card says what's exporting (its name, how far, the
// time left and how many wait) or, idle, how many finished since the view was
// last opened and the last one's name; the view lists what's exporting (Stop,
// a failure's Retry, the one under way's steps), then what finished since the
// view was last opened, with All exports for the rest. Only this computer's
// exports, and only those whose files are still here (the server's
// exports_view.ts); opening the view is what clears Home's "Exported".

import type { ExportActivity as Activity, Exported } from "../lib/api";
import { Copy, Download, FolderSearch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { api } from "../lib/api";
import { useAccount } from "../lib/account";
import { aboutLeft, rowsOf } from "../lib/export-steps";
import { onThisMac, showInFinder } from "../lib/files";
import { useChannels } from "../lib/channels";
import { FILE_MANAGER } from "../lib/platform";
import { useEditor } from "../lib/store";
import { formatBytes, shortDuration } from "../lib/time";
import { cancelScriptShare } from "../writer/api";
import { ChannelAvatar } from "./Channels";
import { loadExportFolder, openExportFolder, useExportFolder } from "./ExportFolder";
import { ExportSteps } from "./ExportSteps";
import { FolderPicker } from "./FolderBrowser";
import { ProblemView } from "./ProblemView";
import { Button, cx, DialogTitle, Modal } from "./ui";

/** What Home knows of this computer's exports: the queue (every 2 s while Home is up) and the files here. */
export const useExports = create<{ jobs: Activity[]; files: Exported[] | null; viewed: number | null }>(() => ({ jobs: [], files: null, viewed: null }));

export const exportGoing = (job: Activity) => job.state === "queued" || job.state === "running";

/** In the view's Exporting: under way and in line, then what failed (Retry); one done is in Exported, one cancelled gone. */
export function exporting(jobs: Activity[]): Activity[] {
  const rank = (job: Activity) => (job.state === "running" && job.steps?.queued !== true ? 0 : exportGoing(job) ? 1 : 2);
  return jobs
    .filter((job) => exportGoing(job) || (job.state === "failed" && job.kind !== "script"))
    .sort((a, b) => rank(a) - rank(b) || (a.started_ms ?? a.updated_ms) - (b.started_ms ?? b.updated_ms));
}

/** The view's Exported: what finished since it was last opened (`since`), newest first. */
export const exportedSince = (files: Exported[], since: number | null) => (since === null ? [] : files.filter((one) => one.finished_ms > since));

/**
 * The sidebar card's words. Exporting: the one under way, how far, the
 * time left and how many more wait; idle: how many finished since the view
 * was opened and the last one's name.
 */
export function cardWords(jobs: Activity[], files: Exported[] | null, viewed: number | null): { live: boolean; count: string | null; name: string; detail: string | null; progress: number | null } {
  const going = jobs.filter(exportGoing);
  if (going.length > 0) {
    const lead = going.find((job) => job.state === "running" && job.steps?.queued !== true) ?? going[0]!;
    const progress = lead.steps?.progress ?? lead.progress;
    const left = aboutLeft(lead.steps?.left_s);
    // Shares run side by side (a share's upload beside another's export): only those in line are waiting (Nov 22: a
    // share that was going was called "waiting").
    const others = going.filter((job) => job !== lead);
    const waiting = others.filter((job) => job.state === "queued" || job.steps?.queued === true).length;
    const beside = others.length - waiting;
    const detail = [left === null ? null : left.replace(/ left$/u, "").toLowerCase(), beside > 0 ? `${beside} more going` : null, waiting > 0 ? `${waiting} more waiting` : null].filter(Boolean).join(" · ");
    // A script share with no bytes counted yet has no number, as its row on Home says none.
    return { live: true, count: lead.uncounted === true ? null : `${Math.round(progress * 100)}%`, name: lead.name, detail: detail || null, progress: lead.uncounted === true ? null : progress };
  }
  const fresh = exportedSince(files ?? [], viewed).length;
  const last = files?.[0];
  return { live: false, count: fresh > 0 ? String(fresh) : null, name: last ? `Last: ${last.name}` : "Nothing exported yet", detail: null, progress: null };
}

/** Follows the queue every 2 s and the files here now and then (and as an export ends), while Home is up. */
export function useWatchExports(): void {
  const allowed = useAccount((state) => state.account === null || state.account.signed_in || !state.account.required);
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let files = 0;
    let ended = -1;
    const look = async () => {
      if (!document.hidden) {
        try {
          const jobs = await api.exportActivity();
          if (!live) return;
          useExports.setState({ jobs });
          // The files again every 15 s, and at once when an export ends (it's then in Exported).
          const done = jobs.filter((job) => !exportGoing(job)).length;
          if (Date.now() - files > 15_000 || done !== ended) {
            files = Date.now();
            ended = done;
            const answer = await api.exportsHere();
            if (live) useExports.setState({ files: answer.exports, viewed: useExports.getState().viewed ?? answer.viewed_ms });
          }
        } catch {
          // Kept as they were while the server is away.
        }
      }
      if (live) timer = setTimeout(() => void look(), 2_000);
    };
    void look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [allowed]);
}

/** The sidebar's Exports: where Later was, above Done. */
export function ExportsCard({ on, onOpen }: { on: boolean; onOpen: () => void }) {
  const jobs = useExports((state) => state.jobs);
  const files = useExports((state) => state.files);
  const viewed = useExports((state) => state.viewed);
  const words = cardWords(jobs, files, viewed);
  return (
    <button onClick={onOpen} className={cx("flex w-full min-w-0 flex-col rounded-lg px-2 py-1.5 text-left transition-colors", on ? "bg-active" : "hover:bg-hover")}>
      <span className="flex w-full items-center gap-2 text-[13px] font-medium">
        <Download size={15} className={cx("shrink-0", on ? "text-fg" : "text-muted")} />
        <span className={cx("min-w-0 flex-1 truncate", on ? "text-fg" : "text-secondary")}>Exports</span>
        {words.count !== null && <span className={cx("text-[12px] tabular", words.live ? "text-secondary" : "text-faint")}>{words.count}</span>}
      </span>
      <span className={cx("mt-0.5 block truncate pl-[23px] text-[11.5px]", words.live ? "text-secondary" : "text-faint")} title={words.name}>
        {words.name}
      </span>
      {words.progress !== null && (
        <span className="mt-1.5 mb-0.5 ml-[23px] block h-[3px] overflow-hidden rounded-full bg-active" aria-hidden>
          <span className="block h-full rounded-full bg-fg transition-[width] duration-300 ease-out" style={{ width: `${Math.round(words.progress * 100)}%` }} />
        </span>
      )}
      {words.detail !== null && <span className="block truncate pl-[23px] text-[11.5px] text-faint">{words.detail}</span>}
    </button>
  );
}

/** A row's channel picture, or an empty circle for work made without one. */
function Face({ channel }: { channel: string | null }) {
  const owner = useChannels((state) => (channel === null ? undefined : state.channels?.find((one) => one.key === channel)));
  return owner !== undefined ? <ChannelAvatar channel={owner} size={28} /> : <span className="size-7 shrink-0 rounded-full border border-dashed border-line-strong" />;
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "Nov 12 · 34:29 · 2.4 GB · on its review link". */
function meta(file: Exported) {
  return (
    <>
      <span className="font-medium text-secondary">{day(file.finished_ms)}</span>
      {[file.seconds > 0 ? shortDuration(file.seconds) : null, formatBytes(file.bytes), file.on_review ? "on its review link" : null, file.whole ? null : "a part"].filter(Boolean).map((one) => ` · ${one}`)}
    </>
  );
}

/** Show (in Finder), or from another device, its download. */
function ShowButton({ file }: { file: Exported }) {
  if (!onThisMac())
    return (
      <a className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] font-medium text-secondary transition-colors hover:bg-hover hover:text-fg" href={`/api/exports/file?path=${encodeURIComponent(file.path)}`} download>
        <Download size={13} /> Download
      </a>
    );
  return (
    <Button size="sm" variant="subtle" onClick={() => showInFinder(file.path)} title={`Show in ${FILE_MANAGER}`}>
      <FolderSearch size={13} /> Show
    </Button>
  );
}

function FileRow({ file, copy }: { file: Exported; copy?: (file: Exported) => void }) {
  return (
    <div className="grid min-h-[58px] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line px-4 py-2 transition-colors hover:bg-hover">
      <Face channel={file.channel} />
      <div className="min-w-0">
        <div className="truncate text-[14px] text-fg" title={file.shown}>
          {file.name}
        </div>
        <div className="mt-[3px] truncate text-[12px] text-muted tabular">{meta(file)}</div>
      </div>
      <div className="flex items-center gap-1.5">
        {copy !== undefined && onThisMac() && (
          <Button size="sm" variant="ghost" onClick={() => copy(file)}>
            <Copy size={13} /> Copy to…
          </Button>
        )}
        <ShowButton file={file} />
      </div>
    </div>
  );
}

/** One export going (or failed): its name, how far and what it's on, Stop (or Retry), and the one under way's steps. */
function JobRow({ job, lead, first, channel }: { job: Activity; lead: boolean; first: boolean; channel: string | null }) {
  const [busy, setBusy] = useState(false);
  const script = job.kind === "script";
  const steps = job.steps;
  const inLine = job.state === "queued" || steps?.queued === true;
  // A script share's step with no bytes to count: said in words, no number (its row on Home says the same).
  const counted = job.uncounted !== true;
  const failed = job.state === "failed";
  const progress = steps?.progress ?? job.progress;
  const current = steps === undefined ? undefined : rowsOf(steps.steps).find((row) => row.state === "current");
  const line = failed
    ? null
    : inLine
      ? [first ? "Next" : "Queued", job.waiting].filter(Boolean).join(" · ")
      : [current?.text ?? job.phase ?? job.stage ?? null, aboutLeft(steps?.left_s)?.toLowerCase() ?? null].filter(Boolean).join(" · ");
  const act = async () => {
    setBusy(true);
    try {
      if (failed) await api.retryExport(job.id);
      else if (script) await cancelScriptShare(job.id);
      else await api.cancelExport(job.id);
      useExports.setState({ jobs: await api.exportActivity() });
    } catch (error) {
      useEditor.getState().toastError(error, failed ? "retry the export" : "stop the export");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid min-h-[58px] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line px-4 py-2.5">
      <Face channel={channel} />
      <div className="min-w-0">
        <div className="truncate text-[14px] text-fg">{job.name}</div>
        {line !== null && (
          <div className="mt-[3px] truncate text-[12px] text-muted">
            {!inLine && counted && <span className="font-medium text-fg tabular">{Math.round(progress * 100)}%</span>}
            {!inLine && counted && line !== "" ? " · " : ""}
            {line}
          </div>
        )}
        {failed && job.error && <ProblemView error={job.error} doing="export it" className="mt-1" />}
        {!inLine && !failed && counted && (
          <div className="mt-[7px] h-1 overflow-hidden rounded-full bg-active" aria-hidden>
            <div className="h-full rounded-full bg-fg transition-[width] duration-300 ease-out" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {lead && steps !== undefined && !inLine && <ExportSteps steps={steps.steps} small className="mt-2.5 mb-0.5" />}
      </div>
      <Button size="sm" variant="subtle" busy={busy || job.stage === "cancelling"} disabled={busy} onClick={() => void act()}>
        {failed ? "Retry" : "Stop"}
      </Button>
    </div>
  );
}

/** Every export of this computer whose file is still here, a copy of each a click away. */
function AllExports({ open, onClose, files }: { open: boolean; onClose: () => void; files: Exported[] }) {
  const [copying, setCopying] = useState<Exported | null>(null);
  return (
    <>
      <Modal open={open} onClose={onClose} width={640}>
        <div className="px-6 pt-6 pb-3">
          <DialogTitle title="All exports" />
        </div>
        <div className="max-h-[62vh] overflow-y-auto pb-2">
          {files.map((file) => (
            <FileRow key={file.path} file={file} copy={setCopying} />
          ))}
        </div>
      </Modal>
      <FolderPicker
        open={copying !== null}
        onClose={() => setCopying(null)}
        title="Copy to…"
        detail={copying === null ? "" : `A copy of ${copying.name} goes in the folder you pick. This one stays where it is.`}
        start={copying?.path.slice(0, copying.path.lastIndexOf("/"))}
        confirm="Copy here"
        onPick={async (folder) => {
          if (copying === null) return;
          const { path } = await api.copyExport(copying.path, folder);
          setCopying(null);
          useEditor.getState().toast(`Copied to ${path.split("/").slice(-2).join("/")}`, "info", { label: `Show in ${FILE_MANAGER}`, run: () => showInFinder(path) });
        }}
      />
    </>
  );
}

/**
 * The view, in Home's main area. Opening it marks every export finished
 * before then as seen (Home's "Exported" goes); what it lists as Exported is
 * what finished since the time before, and what finishes while it's open.
 * Leaving marks those seen too.
 */
export function ExportsView({ channelOf, onViewed }: { channelOf: (project: string) => string | null; onViewed: () => void }) {
  const jobs = useExports((state) => state.jobs);
  const files = useExports((state) => state.files);
  const [since, setSince] = useState<number | null>(null);
  const viewed = useRef(onViewed);
  viewed.current = onViewed;
  useEffect(() => {
    let live = true;
    const mark = () =>
      api
        .exportsViewed()
        .then(({ viewed_ms }) => {
          useExports.setState({ viewed: viewed_ms });
          viewed.current();
        })
        .catch(() => {});
    void api
      .exportsHere()
      .then((answer) => {
        if (!live) return;
        // What's new is since the last opening; marked seen once it's on screen.
        setSince(answer.viewed_ms);
        useExports.setState({ files: answer.exports });
        void mark();
      })
      .catch(() => setSince(Date.now()));
    return () => {
      live = false;
      void mark();
    };
  }, []);
  const going = exporting(jobs);
  const lead = going.find((job) => job.state === "running" && job.steps?.queued !== true);
  const firstInLine = going.find((job) => job !== lead && exportGoing(job));
  const fresh = exportedSince(files ?? [], since);
  const older = (files?.length ?? 0) - fresh.length;
  return (
    <div className="-mx-4 -mt-3 flex flex-col">
      {going.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 border-t border-line px-4 pt-4 pb-2 text-[13px] font-medium text-muted">
            Exporting <span className="font-normal text-faint tabular">{going.length}</span>
          </div>
          {going.map((job) => (
            <JobRow key={`${job.kind ?? "edit"}:${job.id}`} job={job} lead={job === lead} first={job === firstInLine} channel={job.kind === "script" ? null : channelOf(job.id)} />
          ))}
        </section>
      )}
      {fresh.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 border-t border-line px-4 pt-4 pb-2 text-[13px] font-medium text-muted">
            Exported <span className="font-normal text-faint tabular">{fresh.length}</span>
          </div>
          {fresh.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
        </section>
      )}
      {/* Home's own empty state (Sphe, Nov 18: "horrible empty ui"): what shows here, and where the rest are. */}
      {going.length === 0 && fresh.length === 0 && since !== null && (
        <div className="mt-16 text-center">
          <div className="text-[14px] font-medium">{older > 0 ? "No new exports" : "No exports yet"}</div>
          <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] text-muted">
            {older > 0 ? `What you export on this computer shows here while it runs and once it's done. The ${older} from before ${older === 1 ? "is" : "are"} under All exports.` : "What you export on this computer shows here while it runs and once it's done."}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The view's actions, in Home's header (Sphe, Nov 18: the folder line sat loose
 * over an empty page): where exports are saved, and All exports when there are any.
 */
export function ExportsActions() {
  const files = useExports((state) => state.files);
  const folder = useExportFolder((state) => state.folder);
  const [all, setAll] = useState(false);
  useEffect(() => void loadExportFolder(), []);
  return (
    <>
      {folder !== null && (
        <button type="button" onClick={() => openExportFolder("home")} title="Change where exports are saved" className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg">
          <FolderSearch size={14} className="shrink-0" />
          <span className="truncate">
            Saved to <span className="font-medium text-secondary">{folder.shown}</span>
          </span>
        </button>
      )}
      {(files?.length ?? 0) > 0 && (
        <Button variant="subtle" onClick={() => setAll(true)}>
          All exports
        </Button>
      )}
      <AllExports open={all} onClose={() => setAll(false)} files={files ?? []} />
    </>
  );
}
