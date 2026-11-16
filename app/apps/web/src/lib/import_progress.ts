import { explain } from "@edit/types/problems";
import type { ScriptJob } from "./types";

/** A script import as one line and one fraction (0–1), for the viewer, the tab and the panel. */
export function importProgress(job: ScriptJob): { fraction: number; line: string } {
  const files = job.files;
  const done = files.filter((file) => file.state === "done").length;
  // Each file: its download is most of it, then its excerpts.
  const part = (file: ScriptJob["files"][number]) =>
    file.state === "done"
      ? 1
      : file.state === "cutting"
        ? 0.6 + 0.4 * (file.cut && file.cut.total > 0 ? file.cut.done / file.cut.total : 0)
        : file.state === "downloading" && file.total
          ? 0.6 * (file.bytes / file.total)
          : file.state === "waiting" && file.total
            ? 0.6 * Math.min(file.bytes / file.total, 1)
            : 0;
  const footage = files.length === 0 ? 1 : files.reduce((sum, file) => sum + part(file), 0) / files.length;
  if (job.state === "transcribing") return { fraction: 0.88, line: "Transcribing to find exact cuts…" };
  if (job.state === "placing") return { fraction: 0.94, line: "Laying out the edit…" };
  if (job.state === "voicing") return { fraction: 0.97, line: "Making the voice-over…" };
  if (job.state === "failed") return { fraction: footage * 0.85, line: explain(job.error ?? "The import stopped", "finish the import").title };
  if (job.state === "waiting") {
    const missing = job.files.filter((file) => file.state === "failed").length;
    // Waiting by itself (the transcription plan's credit, the encoder): said as the server says it, nothing to press.
    if (missing === 0) return { fraction: footage * 0.85, line: job.error ?? "Waiting to carry on" };
    return { fraction: footage * 0.85, line: `Waiting for you: ${missing === 1 ? "one file" : `${missing} files`} couldn’t be downloaded` };
  }
  if (job.state === "done") return { fraction: 1, line: "Ready" };
  // A YouTube file waiting out YouTube turning Edit away (a downloading file with a time): it goes again by itself.
  const parked = files.find((file) => file.state === "downloading" && file.retry_at !== undefined);
  if (parked?.retry_at !== undefined) return { fraction: footage * 0.85, line: `YouTube turned Edit away · trying again at ${timeOfDay(parked.retry_at)}` };
  // Files that failed in a way that passes, tried again by themselves a little later.
  const again = files.filter((file) => file.state === "failed" && file.retry_at !== undefined);
  if (again.length > 0 && !files.some((file) => file.state === "downloading" || file.state === "cutting")) {
    return { fraction: footage * 0.85, line: `Trying ${again.length === 1 ? "a file" : `${again.length} files`} again at ${timeOfDay(Math.min(...again.map((file) => file.retry_at!)))}` };
  }
  const cutting = files.find((file) => file.state === "cutting" && file.cut);
  const line = cutting?.cut
    ? `Cutting excerpts · ${cutting.cut.done} of ${cutting.cut.total}`
    : files.some((file) => file.state === "downloading")
      ? "Downloading footage"
      : "Getting the footage ready";
  return { fraction: footage * 0.85, line: files.length > 1 ? `${line} · file ${Math.min(done + 1, files.length)} of ${files.length}` : line };
}

/** "2:05 PM" / "14:05", as this computer writes a time. */
export const timeOfDay = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
