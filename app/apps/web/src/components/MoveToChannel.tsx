// Today's kind of edit moved onto a channel from Home's ⋯ (Sphe, Nov 21:
// "click on a v1 project, pick a channel and have it converted"): with Edit
// V2 on here, a V1 edit's menu offers it, the channel is picked as New edit
// picks one (`ChannelField`), and the server makes it that channel's Edit V2
// project, its video the same (the server's channel_move.ts). Off, or for a
// V2 project, nothing is offered.

import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";

import { request } from "../lib/api";
import { useChannels } from "../lib/channels";
import { markSeen } from "../lib/seen";
import type { ProjectSummary } from "../lib/types";
import type { MenuItem } from "./ContextMenu";
import { ChannelField } from "./NewWork";
import { Button, Modal } from "./ui";

/** The ⋯ item, for a V1 edit with Edit V2 on here; none otherwise. */
export function moveItem(project: ProjectSummary, v2: boolean, open: () => void): MenuItem[] {
  if (!v2 || project.hq === true || project.problem) return [];
  return [{ label: "Move to a channel…", icon: <ArrowRightLeft size={14} />, onSelect: open }];
}

/** The picker: a channel, then Move. Closed once it's moved; the row shows its channel after `onMoved`. */
export function MoveToChannel({ project, open, onClose, onMoved }: { project: ProjectSummary; open: boolean; onClose: () => void; onMoved: () => void }) {
  const channels = useChannels((state) => state.channels);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    setPicked(null);
    setError(null);
    onClose();
  };
  const move = async () => {
    if (picked === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request("POST", `/api/channels/${encodeURIComponent(picked)}/projects/${encodeURIComponent(project.id)}`);
      // The person's own change: not Changed for them.
      markSeen(`edit:${project.id}`);
      setBusy(false);
      setPicked(null);
      onMoved();
      onClose();
    } catch (thrown) {
      setBusy(false);
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };
  return (
    <Modal open={open} onClose={close} width={520}>
      <form
        className="flex flex-col gap-4 px-6 pt-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          void move();
        }}
      >
        <h2 className="truncate text-[16px] font-semibold tracking-[-0.2px]">Move “{project.name}” to a channel</h2>
        <ChannelField kind="edit" channels={channels ?? []} value={picked} onChange={setPicked} />
        {error !== null && <p className="text-[12px] text-danger">{error}</p>}
        <footer className="flex items-center justify-end gap-2">
          <Button type="button" variant="subtle" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={picked === null} busy={busy}>
            Move
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
