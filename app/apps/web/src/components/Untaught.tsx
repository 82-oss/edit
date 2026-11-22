// A channel's project whose channel isn't taught yet (Sphe, Nov 16: "It only
// starts working on stuff once we have taught it things"): its import's first
// message waits (the server's teaching_gate.ts), so an empty chat says so in
// one quiet line on the composer's top edge. Its agent works when asked (Sphe,
// Nov 22), so once the chat has begun the line goes.

import { useEffect, useState } from "react";

import { useAgent } from "../lib/agent";
import { channelApi } from "../lib/channels";
import { useEditor } from "../lib/store";

/**
 * The channel's title while its edit style (and its group's) is still empty,
 * once its footage is in (Sphe, Nov 14) and before anything is said in the
 * chat; null otherwise, and when the channel couldn't be read (never taken
 * for untaught). Asked again after each turn, and gone once something is
 * taught.
 */
export function useUntaughtChannel(): string | null {
  const channel = useEditor((state) => state.project?.channel ?? null);
  const footage = useEditor((state) => (state.project?.media.length ?? 0) > 0);
  const running = useAgent((state) => state.running);
  const begun = useAgent((state) => state.entries.length > 0);
  const empty = useUntaughtLane(channel, "edit", running);
  return channel !== null && footage && !begun ? empty : null;
}

/**
 * The channel's title while one of its lanes (and its group's) is still
 * empty, read again whenever `busy` settles; null when it's taught, has no
 * channel, or couldn't be read (never taken for untaught). Script mode's page
 * says so for its Script lane (the server's writer/scripting.ts needsTeaching).
 */
export function useUntaughtLane(channel: string | null, lane: "edit" | "script", busy = false): string | null {
  const [empty, setEmpty] = useState<string | null>(null);
  useEffect(() => {
    if (channel === null || busy) return;
    let alive = true;
    void channelApi.page(channel).then(
      // A grouped channel is taught what its group is, as well as its own.
      (page) => alive && setEmpty(page.taught[lane].length === 0 && (page.group?.taught[lane].length ?? 0) === 0 ? page.channel.title : null),
      () => alive && setEmpty(null),
    );
    return () => {
      alive = false;
    };
  }, [channel, lane, busy]);
  return channel === null ? null : empty;
}

/** The line itself. */
export function UntaughtLine() {
  return <div className="px-3 py-1.5 text-[11.5px] text-muted">Waiting for this channel to be taught</div>;
}
