// Footage the footage sweep cleared (mamagi's footage.ts: the project was Done and untouched for 30 days),
// said once as the project opens, with one answer: bring it back. Each source is checked first; one that
// can't be fetched again is named with why, and a place for a link to the same video, or it's left out.
// The fetching shows over the picture as an import's does (Viewer, `job.back`).

import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { readOnly } from "../lib/cloud";
import { useEditor } from "../lib/store";
import { ProblemView } from "./ProblemView";
import { Button, DialogActions, DialogTitle, Modal, TextField } from "./ui";

type Missing = { source: string; name: string; why: string };

export function FootageBack() {
  const id = useEditor((state) => state.project?.id ?? "");
  const blocked = useEditor((state) => readOnly(state.cloud));
  const job = useEditor((state) => (state.scriptJob?.back === true ? state.scriptJob : null));
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState<Missing[] | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);

  useEffect(() => {
    if (id === "") return;
    let live = true;
    setOpen(false);
    setMissing(null);
    setLinks({});
    setFailed(null);
    api
      .footageCleared(id)
      .then(({ cleared, job }) => {
        if (!live) return;
        if (job !== null && job.state !== "failed") useEditor.setState({ scriptJob: job });
        setOpen(cleared !== null && (job === null || job.state === "failed"));
      })
      // Offline, or a server from before: nothing to say.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  // A source that didn't come back: asked again, with why, instead of a failure over the picture.
  useEffect(() => {
    if (job?.state !== "failed") return;
    useEditor.setState({ scriptJob: null });
    setMissing(null);
    setFailed(job.error ?? "The footage didn't all come back.");
    setOpen(true);
  }, [job]);

  const filled = (source: string) => (links[source] ?? "").trim();
  const bringBack = async () => {
    setBusy(true);
    setFailed(null);
    try {
      if (missing === null) {
        const { missing: found } = await api.unfetchableFootage(id);
        if (found.length > 0) {
          setMissing(found);
          return;
        }
        await api.bringFootageBack(id, {}, []);
      } else {
        const given = Object.fromEntries(missing.flatMap((one) => (filled(one.source) !== "" ? [[one.source, filled(one.source)]] : [])));
        await api.bringFootageBack(id, given, missing.filter((one) => given[one.source] === undefined).map((one) => one.source));
      }
      setOpen(false);
    } catch (error) {
      setFailed(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open && !blocked} onClose={() => setOpen(false)} width={missing === null ? 400 : 460}>
      <div className="p-6">
        {missing === null ? (
          <DialogTitle title="Footage cleared" detail="This project’s footage was cleared to save space after it was done and untouched for 30 days." />
        ) : (
          <>
            <DialogTitle
              title={missing.length === 1 ? "One file can’t be fetched" : `${missing.length} files can’t be fetched`}
              detail="Paste a link to the same video for any you have, or go on without them."
            />
            <div className="mt-4 flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
              {missing.map((one) => (
                <div key={one.source}>
                  <div className="truncate text-[13px]" title={one.name}>
                    {one.name}
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted">{one.why}</div>
                  <TextField
                    className="mt-1.5 w-full"
                    value={links[one.source] ?? ""}
                    onChange={(event) => setLinks((now) => ({ ...now, [one.source]: event.target.value }))}
                    placeholder="A Google Drive or YouTube link"
                  />
                </div>
              ))}
            </div>
          </>
        )}
        {failed !== null && <ProblemView error={failed} doing="bring the footage back" className="mt-4" />}
        <DialogActions>
          <Button variant="subtle" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void bringBack()}>
            {missing === null || missing.every((one) => filled(one.source) !== "") ? "Bring the footage back" : "Go on without them"}
          </Button>
        </DialogActions>
      </div>
    </Modal>
  );
}
