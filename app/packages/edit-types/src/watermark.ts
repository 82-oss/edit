// A channel's watermark: how it looks and where it is at any moment (Sphe,
// Nov 2: "the opacity is like 20% and the logo moves around the screen like
// the dvd player"; Nov 16: each channel sets its own on its page). The
// server's export (channel_marks.ts) keyframes this path; the channel page's
// preview draws it from here, so what a teacher sees as they drag is what the
// export draws. Change both together by changing this.

export interface WatermarkLook {
  /** 0–1. */
  opacity: number;
  /** The logo's height, a share of the frame's. */
  size: number;
  /** Its speed along each axis, frame heights a second. */
  speed: number;
  /** false: still, in the bottom-right corner. */
  motion: boolean;
}

/** The house look: 10% ("try 10%", Sphe, Nov 2), 14% of the frame's height, 0.04 frame heights a second (0.1 was "TOO fast"), moving. */
export const HOUSE_LOOK: WatermarkLook = { opacity: 0.1, size: 0.14, speed: 0.04, motion: true };

/** What a teacher may set on the channel's page (mamagi's channels.ts checks the same). */
export const LOOK_RANGE = { opacity: [0.02, 1], size: [0.03, 0.5], speed: [0, 0.5] } as const;

/** Kept off the frame's edge, a share of its height. */
export const MARGIN = 0.02;

/** A number in [0, 1) from `seed`, so each video starts the logo somewhere of its own, the same every time it's exported. */
export function unit(seed: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 100_000) / 100_000;
}

/** The logo's size in a `W`×`H` frame (a `logoW`×`logoH` picture at `look.size` of the frame's height), and how far its centre may go from the frame's each way. */
export function boxOf(look: Pick<WatermarkLook, "size">, W: number, H: number, logoW: number, logoH: number): { w: number; h: number; reach: [number, number] } {
  const h = look.size * H;
  const w = (h * Math.max(logoW, 1)) / Math.max(logoH, 1);
  const margin = MARGIN * H;
  return { w, h, reach: [Math.max(0, W / 2 - margin - w / 2), Math.max(0, H / 2 - margin - h / 2)] };
}

/** Where `seed`'s logo starts on each axis (from the frame's centre) and which way it heads first. */
export function startOf(seed: string, reach: [number, number]): { from: [number, number]; heading: [1 | -1, 1 | -1] } {
  return {
    from: [(unit(seed, 1) * 2 - 1) * reach[0], (unit(seed, 2) * 2 - 1) * reach[1]],
    heading: [unit(seed, 3) < 0.5 ? 1 : -1, unit(seed, 4) < 0.5 ? 1 : -1],
  };
}

/** One axis of the bounce after going `distance`: from `from` heading `heading`, turning at ±`reach`. */
export function bounceAt(from: number, heading: 1 | -1, reach: number, distance: number): number {
  if (reach <= 0) return 0;
  const span = 2 * reach;
  const unfolded = (((Math.max(-reach, Math.min(reach, from)) + reach + heading * distance) % (2 * span)) + 2 * span) % (2 * span);
  return (unfolded <= span ? unfolded : 2 * span - unfolded) - reach;
}

/** The logo's centre (from the frame's) `seconds` in: bouncing at the look's speed, or still in the bottom-right corner. */
export function placeAt(look: WatermarkLook, W: number, H: number, logoW: number, logoH: number, seed: string, seconds: number): [number, number] {
  const { reach } = boxOf(look, W, H, logoW, logoH);
  if (!look.motion || look.speed <= 0) return [reach[0], reach[1]];
  const { from, heading } = startOf(seed, reach);
  const distance = look.speed * H * seconds;
  return [bounceAt(from[0], heading[0], reach[0], distance), bounceAt(from[1], heading[1], reach[1], distance)];
}

/** An uploaded picture's place in Edit's cloud. */
export const uploadKey = (channel: string, sha256: string, ext: string) => `edit/channels/${channel}/watermark/${sha256}.${ext}`;

/** Where a mark's picture comes from. */
export type Picture = { kind: "drive"; id: string } | { kind: "upload"; channel: string; sha256: string; ext: string };

/** A channel's watermark as an export carries it: its picture, and its look unless it's the house's. */
export function markOf(picture: Picture, look: WatermarkLook | null | undefined): string {
  const named = picture.kind === "drive" ? picture.id : `up/${picture.channel}/${picture.sha256}.${picture.ext}`;
  if (look === null || look === undefined || (["opacity", "size", "speed", "motion"] as const).every((one) => look[one] === HOUSE_LOOK[one])) return named;
  return `${named}~${look.opacity},${look.size},${look.speed},${look.motion ? 1 : 0}`;
}

/** A mark read back: its picture and look (the house's when it names none); null when it isn't one. */
export function readMark(mark: string): { picture: Picture; look: WatermarkLook } | null {
  const [named, numbers] = mark.split("~", 2) as [string, string | undefined];
  const upload = /^up\/([a-z0-9][a-z0-9-]{0,39})\/([0-9a-f]{64})\.(png|jpg|webp)$/.exec(named);
  const picture: Picture | null = upload !== null ? { kind: "upload", channel: upload[1]!, sha256: upload[2]!, ext: upload[3]! } : /^[A-Za-z0-9_-]{1,200}$/.test(named) ? { kind: "drive", id: named } : null;
  if (picture === null) return null;
  if (numbers === undefined) return { picture, look: HOUSE_LOOK };
  const [opacity, size, speed, motion] = numbers.split(",").map(Number) as [number, number, number, number];
  const look = { opacity, size, speed, motion: motion === 1 };
  const within = (value: number, [low, high]: readonly [number, number]) => Number.isFinite(value) && value >= low && value <= high;
  if (!within(opacity, LOOK_RANGE.opacity) || !within(size, LOOK_RANGE.size) || !within(speed, LOOK_RANGE.speed)) return null;
  return { picture, look };
}
