import { useState } from "react";

import { api } from "../lib/api";
import { useEditor } from "../lib/store";
import type { Project, ScriptJob } from "../lib/types";
import { ProblemView } from "./ProblemView";
import { Button } from "./ui";

/**
 * An import waiting on the person: each file that can't be downloaded however
 * often it's tried (deleted, never shared, private; a dropped connection is
 * tried again by itself and never shows here), with its two answers, and one
 * for them all. Said where the edit would be (the Viewer), since the Downloads
 * tab that held them is gone: the first horror import (Nov 4) waited with
 * nothing to press anywhere. Each answer says what it does: the edit is made
 * with the file's parts left black (they hold their place), or another link.
 */
export function WaitingFiles({ project, job }: { project: Project; job: ScriptJob }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const missing = job.files.filter((file) => file.state === "failed");
  const linkOf = (file: string) => {
    const block = project.script?.blocks.find((one) => one.kind === "footage" && one.file === file);
    return block?.kind === "footage" ? block.url : file;
  };
  const skipAll = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const { job: next } = await api.answerFootage(project.id, "*", { skip: true });
      useEditor.setState({ scriptJob: next });
    } catch (error) {
      setFailed(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex max-h-[70%] w-[min(520px,90%)] flex-col gap-2 overflow-y-auto text-left">
      {missing.length > 1 && (
        <Button size="sm" variant="primary" className="self-center" disabled={busy} onClick={() => void skipAll()}>
          {busy ? "Making the edit…" : "Make the edit with their parts black"}
        </Button>
      )}
      {failed !== null && <ProblemView error={failed} doing="make the edit without them" />}
      {missing.map((file) => (
        <div key={file.file}>
          <div className="truncate text-[11px] text-muted" title={linkOf(file.file)}>{file.name ?? linkOf(file.file)}</div>
          <MissingFile project={project} file={file.file} error={file.error ?? ""} />
        </div>
      ))}
    </div>
  );
}

/**
 * Footage Edit couldn't fetch, even tried again: why, in plain words, and the
 * person's two answers (the team: "Do we just proceed without it? Do you have
 * a replacement?"). Try again only where something they did (shared it,
 * signed in to YouTube) can change the answer.
 */
function MissingFile({ project, file, error }: { project: Project; file: string; error: string }) {
  const [replacing, setReplacing] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const answer = (given: { url: string } | { skip: true }) => {
    setBusy(true);
    setFailed(null);
    void api
      .answerFootage(project.id, file, given)
      .then(({ job }) => useEditor.setState({ scriptJob: job }))
      .catch(setFailed)
      .finally(() => setBusy(false));
  };
  const again = () => {
    setBusy(true);
    void api
      .resumeScript(project.id)
      .then(({ job }) => useEditor.setState({ scriptJob: job }))
      .catch(setFailed)
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-1.5 flex flex-col gap-2 rounded-lg border border-line bg-panel p-2.5">
      <ProblemView error={error} doing="download this file" onRetry={again} />
      {replacing ? (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) answer({ url: url.trim() });
          }}
        >
          <input
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="A Google Drive or YouTube link to the same video"
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-black px-2 text-[12px] outline-none placeholder:text-faint focus:border-muted"
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || !url.trim()}>
            Use it
          </Button>
        </form>
      ) : (
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => setReplacing(true)} disabled={busy}>
            Use another link
          </Button>
          <Button size="sm" variant="ghost" onClick={() => answer({ skip: true })} disabled={busy}>
            Make the edit with its parts black
          </Button>
        </div>
      )}
      {failed !== null && <ProblemView error={failed} doing="use that" />}
    </div>
  );
}
