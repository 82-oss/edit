// Projects shaped like the real channel projects the V2 timeline was built
// against (Nov 21: 45, 1,355 and 3,173 clips): for its tests only, nothing in
// the app imports this.

import type { Clip, Media, Project, Track } from "./types";

type Fields = Record<string, unknown>;

export function track(id: string, kind: "video" | "audio", subtitles = false): Track {
  return { id, kind, hidden: false, muted: false, locked: false, ...(subtitles ? { subtitles: true } : {}) } as Track;
}

export function media(id: string, fields: Fields = {}): Media {
  return { id, name: `${id}.mp4`, path: `/footage/${id}.mp4`, kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true, ...fields } as Media;
}

const base = { color: "blue", fade_in: 0, fade_out: 0, keyframes: {} };
const transform = { x: 0, y: 0, scale: 1, rotation: 0 };

export function video(id: string, trackId: string, start: number, duration: number, mediaId: string, fields: Fields = {}): Clip {
  return { ...base, id, track: trackId, start, duration, type: "video", media: mediaId, source_in: 0, speed: 1, opacity: 1, transform, ...fields } as unknown as Clip;
}

export function audio(id: string, trackId: string, start: number, duration: number, mediaId: string, fields: Fields = {}): Clip {
  return { ...base, id, track: trackId, start, duration, type: "audio", media: mediaId, source_in: 0, speed: 1, volume_db: 0, ...fields } as unknown as Clip;
}

export function text(id: string, trackId: string, start: number, duration: number, words: string, fields: Fields = {}): Clip {
  return { ...base, id, track: trackId, start, duration, type: "text", text: words, opacity: 1, transform, ...fields } as unknown as Clip;
}

export function adjustment(id: string, trackId: string, start: number, duration: number, fields: Fields = {}): Clip {
  return { ...base, id, track: trackId, start, duration, type: "adjustment", grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 }, opacity: 1, ...fields } as unknown as Clip;
}

export function solid(id: string, trackId: string, start: number, duration: number, fields: Fields = {}): Clip {
  return { ...base, id, track: trackId, start, duration, type: "solid", fill: [0, 0, 0, 1], opacity: 1, ...fields } as unknown as Clip;
}

export function projectOf(fields: { id?: string; tracks: Track[]; media: Media[]; clips: Clip[]; script?: unknown }): Project {
  return { version: 1, id: fields.id ?? "p1", name: "Test", style: "bodycam", settings: { width: 1920, height: 1080, fps: 30 }, next_id: 1, hq: true, ...fields } as unknown as Project;
}

/**
 * A project the size of the biggest real one (3,173 clips on 28 tracks, 2 h 6 min, 389 media): 2,028 subtitles at
 * opacity 0, footage with its sound, cut-ins, removal strips on their footage, blurs, graphics (some stacked),
 * captions, looks, voice-over, music and sound effects.
 */
export function bigProject(): Project {
  const fps = 30;
  const end = 126 * 60 * fps;
  const tracks: Track[] = [];
  for (let at = 0; at < 22; at++) tracks.push(track(`v${at}`, "video"));
  tracks.push(track("subs", "video", true));
  for (let at = 0; at < 5; at++) tracks.push(track(`a${at}`, "audio"));
  const media: Media[] = [];
  const clips: Clip[] = [];
  let id = 0;
  const next = () => `c${id++}`;
  for (let at = 0; at < 150; at++) media.push(mediaOf(`f${at}`, {}));
  for (let at = 0; at < 120; at++) media.push(mediaOf(`s${at}`, { has_audio: false, cleans: { media: `f${at % 150}`, from: 0, to: 30, box: [0, 0.8, 1, 1] }, duration: 30 }));
  for (let at = 0; at < 60; at++) media.push(mediaOf(`g${at}`, { effect: `fx${at}`, effect_key: `k${at}`, stacked_alpha: at % 2 === 0, has_audio: false, duration: 20 }));
  for (let at = 0; at < 59; at++) media.push(mediaOf(`m${at}`, { kind: "audio", width: 0, height: 0, library: at < 10 ? "music" : "sfx", duration: at < 10 ? 180 : 2 }));
  // 148 footage clips end to end, each with its sound.
  const shot = Math.floor(end / 148);
  for (let at = 0; at < 148; at++) {
    const start = at * shot;
    clips.push(video(next(), "v0", start, shot, `f${at}`, { source_in: 10 }));
    clips.push(audio(next(), "a0", start, shot, `f${at}`, { source_in: 10 }));
  }
  // 113 cut-ins over them.
  for (let at = 0; at < 113; at++) clips.push(video(next(), "v1", at * shot + 100, 240, `f${(at + 7) % 150}`, { name: `Cut-in ${at + 1} · B-roll: a shot` }));
  // 176 removal strips and 64 + 21 blurs.
  for (let at = 0; at < 176; at++) clips.push(video(next(), `v${2 + (at % 3)}`, (at % 148) * shot + 20, 300, `s${at % 120}`, { parent: clips[(at % 148) * 2]!.id, name: `Subtitles removed · c${at}` }));
  for (let at = 0; at < 85; at++) clips.push(adjustment(next(), `v${5 + (at % 2)}`, at * 1500 + 40, 200, { blur: { radius: 30, y: 400, width: 600, height: 80 }, name: `Text blur · c${at}` }));
  // 228 graphics, 74 looks, 20 captions.
  for (let at = 0; at < 228; at++) clips.push(video(next(), `v${7 + (at % 8)}`, at * 990 + 30, 90 + (at % 5) * 60, `g${at % 60}`, { name: `Graphic ${at}` }));
  for (let at = 0; at < 74; at++) clips.push(adjustment(next(), "v15", at * 3000, 400, { name: `Cut-in ${at} · B-roll look` }));
  for (let at = 0; at < 20; at++) clips.push(text(next(), "v16", at * 11000 + 5, 48, `A caption ${at}`));
  // 2,028 subtitles, drawn by an effect: their text clips at opacity 0.
  const every = Math.floor(end / 2028);
  for (let at = 0; at < 2028; at++) clips.push(text(next(), "subs", at * every, every - 4, `These are the words of line ${at}`, { opacity: 0, name: "Subtitle · Officer" }));
  // 40 voice-over, 10 music, 255 sound effects.
  for (let at = 0; at < 40; at++) clips.push(audio(next(), "a1", at * 5600, 600, `m${10 + (at % 49)}`, { name: "Voice-over" }));
  for (let at = 0; at < 10; at++) clips.push(audio(next(), "a2", at * 22000, 5400, `m${at}`, { volume_db: -18 }));
  const sfx = 3173 - clips.length;
  for (let at = 0; at < sfx; at++) clips.push(audio(next(), `a${3 + (at % 2)}`, Math.floor((at * end) / sfx), 45, `m${10 + (at % 49)}`));
  return projectOf({ tracks, media, clips });
}

function mediaOf(id: string, fields: Fields): Media {
  return media(id, fields);
}
