// The player's volume (Sphe, Nov 13: "a button where we can mute but when you
// hover over it you can lower the volume"): a level and a mute, this
// computer's, kept between sessions. What's heard, not the edit's mix: the
// export and every clip's own levels are untouched. playback.ts applies it to
// each way the preview sounds (the live mix, the render, a stream's sound).

import { create } from "zustand";

const KEY = "edit.volume";

export interface Volume {
  /** 0 to 1, as the slider has it. */
  level: number;
  muted: boolean;
}

function saved(): Volume {
  try {
    const given = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Volume> | null;
    const level = typeof given?.level === "number" && Number.isFinite(given.level) ? Math.min(1, Math.max(0, given.level)) : 1;
    return { level, muted: given?.muted === true };
  } catch {
    return { level: 1, muted: false };
  }
}

export const useVolume = create<Volume>(() => saved());

function keep(next: Volume): void {
  useVolume.setState(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A private window: it holds for this session.
  }
}

/** The slider's level; moving it up from nothing unmutes. */
export function setLevel(level: number): void {
  const clamped = Math.min(1, Math.max(0, level));
  keep({ level: clamped, muted: clamped === 0 });
}

/** Mute or unmute; unmuting at nothing comes back at half. */
export function toggleMute(): void {
  const { level, muted } = useVolume.getState();
  if (muted || level === 0) keep({ level: level === 0 ? 0.5 : level, muted: false });
  else keep({ level, muted: true });
}

/** The gain heard, from the slider's level (squared: even steps to the ear). */
export function gainOf(volume: Volume): number {
  return volume.muted ? 0 : volume.level * volume.level;
}
