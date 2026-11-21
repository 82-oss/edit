// Whether an Edit V2 project shows its timeline (Sphe, Nov 21: "the timeline
// can be toggle as one of the buttons on the player. and your preference is
// saved so if you never toggle it, you never see it and if you do toggle it
// you do see it until you un toggle"). Off until the player's Timeline button
// (or T) is pressed; then on for every V2 project until it's pressed again.
// Kept as the editor keeps its other view choices (the timeline's height, the
// chat's width): in this computer's browser storage, so it's per computer.
// Its height is its own, apart from V1's: a V2 edit is watched first, so its
// timeline opens smaller than V1's half of the window.

import { create } from "zustand";

import { forgetSetting, readSetting, writeSetting } from "./storage";

const OPEN = "edit.v2.timeline";
const HEIGHT = "edit.v2.timelineHeight";

/** Until resized: two fifths of the space under the top bar (every row of a small edit in view, the player still the larger), at least 220 px. */
export function defaultV2Height(): number {
  const available = Math.max(320, (typeof window === "undefined" ? 900 : window.innerHeight) - 56);
  return Math.round(Math.max(220, available * 0.42));
}

export const useTimelineShown = create<{ open: boolean; height: number }>(() => ({
  open: readSetting(OPEN) === "open",
  height: Number(readSetting(HEIGHT)) || defaultV2Height(),
}));

/** The player's Timeline button: open it, or close it, and remember which. */
export function toggleTimeline(): void {
  const open = !useTimelineShown.getState().open;
  if (open) writeSetting(OPEN, "open");
  else forgetSetting(OPEN);
  useTimelineShown.setState({ open });
}

export function setTimelineHeight(height: number): void {
  writeSetting(HEIGHT, String(Math.round(height)));
  useTimelineShown.setState({ height });
}

export function resetTimelineHeight(): void {
  forgetSetting(HEIGHT);
  useTimelineShown.setState({ height: defaultV2Height() });
}
