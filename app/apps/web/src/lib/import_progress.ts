import { explain } from "@edit/types/problems";
import type { ScriptJob } from "./types";

/** The server's job, with when it last moved (a byte, an excerpt cut, a file's state): script.ts `moved_ms`. */
type Moving = ScriptJob & { moved_ms?: number };

/** Not moved for this long while it says it's working: the line says since when instead (a slow line still moves bytes every few seconds). */
const STILL_MS = 5 * 60_000;

/**
 * A script import as one line and one fraction (0–1), for the viewer, the tab and the panel. Nov 20: a time Edit
 * tries again at that has passed reads "now" (a relaunch showed "Trying again at" an hour gone), and a running
 * import the server hasn't seen move for five minutes says so rather than "Downloading footage" for good.
 */
export function importProgress(job: Moving, now = Date.now()): { fraction: number; line: string } {
  const at = (ms: number) => (ms <= now ? "now" : `at ${timeOfDay(ms)}`);
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
          : (file.state === "waiting" || file.state === "queued") && file.total
            ? // In line for its cut (its bytes in) or waiting by itself: what came down still counts, never back to 0.
              0.6 * Math.min(file.bytes / file.total, 1)
            : 0;
  const footage = files.length === 0 ? 1 : files.reduce((sum, file) => sum + part(file), 0) / files.length;
  if (job.state === "transcribing") return { fraction: 0.88, line: "Transcribing to find exact cuts…" };
  if (job.state === "placing") return { fraction: 0.94, line: "Laying out the edit…" };
  if (job.state === "voicing") return { fraction: 0.97, line: "Making the voice-over…" };
  if (job.state === "failed") return { fraction: footage * 0.85, line: explain(job.error ?? "The import stopped", "finish the import").title };
  if (job.state === "waiting") {
    const missing = job.files.filter((file) => file.state === "failed").length;
    // A dropped connection, a busy Google: tried again by itself, said as the in-run tries are, nothing to press.
    const again = job.files.filter((file) => file.state === "waiting" && file.why === "passing");
    if (missing === 0 && again.length > 0 && again.length === job.files.filter((file) => file.state === "waiting").length && job.retry_at !== undefined) {
      return { fraction: footage * 0.85, line: `Trying ${again.length === 1 ? "a file" : `${again.length} files`} again ${at(job.retry_at)}` };
    }
    // Waiting by itself (the transcription plan's credit, the encoder): said as the server says it, nothing to press.
    if (missing === 0) return { fraction: footage * 0.85, line: job.error ?? "Waiting to carry on" };
    return { fraction: footage * 0.85, line: `${missing === 1 ? "One file" : `${missing} files`} can’t be downloaded` };
  }
  if (job.state === "done") return { fraction: 1, line: "Ready" };
  // A YouTube file waiting out YouTube turning Edit away (a downloading file with a time): it goes again by itself.
  const parked = files.find((file) => file.state === "downloading" && file.retry_at !== undefined);
  if (parked?.retry_at !== undefined) return { fraction: footage * 0.85, line: `YouTube turned Edit away · trying again ${at(parked.retry_at)}` };
  // Files that failed in a way that passes, tried again by themselves a little later.
  const again = files.filter((file) => file.state === "failed" && file.retry_at !== undefined);
  if (again.length > 0 && !files.some((file) => file.state === "downloading" || file.state === "cutting")) {
    return { fraction: footage * 0.85, line: `Trying ${again.length === 1 ? "a file" : `${again.length} files`} again ${at(Math.min(...again.map((file) => file.retry_at!)))}` };
  }
  if (job.moved_ms !== undefined && now - job.moved_ms >= STILL_MS) return { fraction: footage * 0.85, line: `Nothing has come in since ${timeOfDay(job.moved_ms)} · Edit keeps trying by itself` };
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
