// Bodycam HQ's sound in both ears, by itself (Sphe, Nov 13, the team on a
// 911 call: "part of the audio appears in one ear and part of the audio
// appears in the other ear… I don't know if there's a way for us to detect
// that this is the case and then fix it, but we need to fix it"). When an HQ
// turn ends, each source its sound clips play is measured (ears.ts: heard on
// one side, or split between them, a voice on each) and its clips that say
// nothing of a side play it in both ears: the agent needn't think of it, and
// nothing is sent to its chat (HQ is prompted by the team alone).

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import * as ears from "./ears.ts";
import * as localPreviews from "./local_previews.ts";
import type { Clip, Media } from "./model.ts";
import { fps as fpsOf } from "./project.ts";

/** The shortest recording measured: shorter sounds the agent made or brought in are effects, not speech. */
const SHORTEST_RECORDING_S = 5;

/** Whether a source is speech to hear in both ears: footage's sound, or a recording that isn't the library's music or effects. */
export function speech(media: Media): boolean {
  if (media.kind === "video") return media.has_audio === true;
  // The agent's own sounds (make_sound, effects.ts) are effects however long: a riser or a sweep keeps its sides.
  return media.kind === "audio" && (media as Media & { library?: unknown }).library == null && !media.path.includes("effect-sounds") && media.duration >= SHORTEST_RECORDING_S;
}

/** The audio clips with no side set, by source: the stretches they play ([from, seconds] of the source). One said "stereo" (both_ears, its own sides put back) is set, and stays as said. */
export function unsided(clips: readonly Clip[], fps: number): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  for (const clip of clips) {
    if (clip.type !== "audio" || (clip as { channel?: unknown }).channel != null) continue;
    const spans = out.get(clip.media) ?? [];
    spans.push([clip.source_in, (clip.duration / fps) * clip.speed]);
    out.set(clip.media, spans);
  }
  return out;
}

/** Measures an HQ project's unsided sources and sets the side of their clips that need one. */
export async function fix(app: App, project: string): Promise<void> {
  const live = app.store.get(project);
  if (live === null || live.project.hq !== true) return;
  const fps = fpsOf(live.project);
  const sides = new Map<string, ears.Side>();
  for (const [mediaId, spans] of unsided(live.project.clips, fps)) {
    const media = live.project.media.find((one) => one.id === mediaId);
    // Speech only: footage, and recordings (a call). Music and sound effects (the library's, or one the agent made) are
    // left as they are: a whoosh sweeping across is meant to.
    if (media === undefined || !speech(media)) continue;
    try {
      const side = await ears.liveSide(localPreviews.pathOf(app.store.cacheDir(), media), spans);
      if (side !== null) sides.set(mediaId, side);
    } catch (error) {
      diag.warn("ears", `${project}: ${media.name}'s sides couldn't be measured: ${diag.messageOf(error)}`);
    }
  }
  if (sides.size === 0) return;
  const [, changed] = await app.store.update(project, "ears", (edited) => {
    let count = 0;
    for (const clip of edited.clips) {
      const side = clip.type === "audio" ? sides.get(clip.media) : undefined;
      const own = clip as Clip & { channel?: ears.Side };
      if (side === undefined || own.channel != null) continue;
      own.channel = side;
      count++;
    }
    return count;
  });
  if (changed > 0) diag.info("ears", `${project}: ${changed} sound clip(s) put in both ears (${[...sides].map(([media, side]) => `${media} ${side}`).join(", ")})`);
}

/** Puts an HQ project's sound in both ears whenever an agent's turn on it ends, one project at a time. */
export function start(app: App): void {
  let chain = Promise.resolve();
  app.store.subscribe((event) => {
    if (event.type !== "agent" || event.event !== "status" || event.running !== false || typeof event.project !== "string") return;
    const project = event.project.split("~")[0]!;
    chain = chain.then(() => fix(app, project)).catch((error: unknown) => diag.warn("ears", `${project}: ${diag.messageOf(error)}`));
  });
}
