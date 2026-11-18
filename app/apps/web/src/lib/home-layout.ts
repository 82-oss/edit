// Home's table at a width (components/HomeTable.tsx): which columns it shows
// and how wide, so a name always has room; apart from the table so it's
// checked on its own (home-layout.test.ts).

/** The table's columns at a width, and which it does without. */
export interface Layout {
  columns: string;
  compact: boolean;
  slim: boolean;
  faces: boolean;
}

/** A name gets at least this much before a column goes. */
const NAME_ROOM = 260;
const GAP = 16;
/** A row's padding, which its first and last columns hold. */
const PAD = 24;
/** The channel's room: its picture and a name like "Inspector Ted". */
const CHANNEL = 160;

/**
 * The most the table can show at `width` (px) and still leave a name its room:
 * name, then status, channel, by, length and updated together on the right
 * (Sphe, Nov 18: status pushed right beside the channel), the row's buttons
 * over its right end on hover, no column of their own. Status and Channel are
 * as wide as what's in them, up to their room (fit-content), so what they
 * don't use goes to the name (Sphe, Nov 14).
 */
export function layoutFor(width: number, solo: boolean): Layout {
  const steps = [
    // Status as wide as two pills side by side ("Footage missing" and "On Drive ↗"), then narrower, its pills wrapping.
    { compact: false, slim: false, faces: false, status: 236 },
    { compact: true, slim: false, faces: false, status: 236 },
    { compact: true, slim: true, faces: false, status: 236 },
    { compact: true, slim: true, faces: true, status: 236 },
    { compact: true, slim: true, faces: true, status: 180 },
    { compact: true, slim: true, faces: true, status: 148 },
  ];
  // Each column's room, and whether it's as wide as what it holds (up to that) or fixed.
  const tracksOf = (step: (typeof steps)[number]) => [
    { px: step.status, fit: true },
    ...(step.slim ? [] : [{ px: CHANNEL, fit: true }]),
    ...(solo ? [] : [{ px: step.faces ? 36 : 120, fit: false }]),
    ...(step.compact ? [] : [{ px: 64, fit: false }]),
    { px: 76, fit: false },
  ];
  const step = steps.find((one) => {
    const tracks = tracksOf(one);
    return width - PAD - tracks.reduce((sum, track) => sum + track.px, 0) - tracks.length * GAP >= NAME_ROOM;
  }) ?? steps.at(-1)!;
  const columns = tracksOf(step).map((track) => (track.fit ? `fit-content(${track.px}px)` : `${track.px}px`));
  return { columns: ["minmax(0,1fr)", ...columns].join(" "), compact: step.compact, slim: step.slim, faces: step.faces };
}
