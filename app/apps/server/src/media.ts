// Background media work: scrub proxies, thumbnail strips, waveforms, and
// transcription. The heavy lifting is the addon's
// (probing, previews, waveforms, picture thumbnails); this side schedules it,
// keeps each file's status and tells the UI (`media` events). The FFmpeg-only
// thumbnail strip is made here.
//
// Preview proxies are small enough to stream over Wi-Fi: H.264 with a
// keyframe every half second and no B-frames, so the browser decodes at most
// a few frames to land anywhere and plays forward on one decoder. Sound is a
// separate AAC file, so decoding it never downloads the picture.

import * as fs from "node:fs";
import { Semaphore } from "./semaphore.ts";

import * as diag from "./diag.ts";
import { playbackKey } from "./cloud_playback.ts";
import { writeAtomic } from "./files.ts";
import * as framing from "./framing.ts";
import { isBug, message as crashMessage } from "./guard.ts";
import type { Media, MediaKind, Probe } from "./model.ts";
import { native, type CachePaths } from "./native/index.ts";
import { extension, join, parent, startsWith, withExtension, canonical } from "./paths.ts";
import * as playing from "./playing.ts";
import type { Store } from "./store.ts";
import * as tools from "./tools.ts";
import { FIRST_PASS_FROM_S, firstWords } from "./first_hearing.ts";
import * as log from "./hearing_log.ts";
import * as steps from "./import_steps.ts";
import * as failure from "./failure.ts";
import { hearJoined, merged, readKept, toHear, WHOLE_SHARE } from "./kept_hearing.ts";
import * as transcribe from "./transcribe.ts";
import * as voices from "./voices.ts";

export type { Probe } from "./model.ts";

export { Semaphore } from "./semaphore.ts";

/**
 * Shared across proxies, thumbnails and optional optical flow. Independent
 * per-feature limits used to add up to more RAM than an 8 GB Mac has.
 */
export const backgroundSlots = new Semaphore(1);
/**
 * Small ImageIO thumbnails need not sit behind minutes of video proxy work.
 * They have their own single, bounded decoder slot.
 */
const imageSlots = new Semaphore(1);

// The engine stops background analysis's FFmpeg (the censor checks) while a play is watched here, and starts it again after.
playing.onChange((now) => native().setPlaying?.(now));

/** Waveform resolution. */
export const PEAKS_PER_SECOND = 100;
export const THUMB_HEIGHT = 72;

export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "mxf"];
export const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "aac", "flac", "aif", "aiff", "ogg", "opus"];
/** A still image, which imports as a clip of footage (the addon keeps its own list). */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

export function isMediaPath(path: string): boolean {
  const ext = extension(path)?.toLowerCase();
  return ext !== undefined && (VIDEO_EXTENSIONS.includes(ext) || AUDIO_EXTENSIONS.includes(ext));
}

/** A still image (png, jpg…), which imports as a clip of footage. */
export function isImagePath(path: string): boolean {
  const ext = extension(path)?.toLowerCase();
  return ext !== undefined && IMAGE_EXTENSIONS.includes(ext);
}

/** What a file is (the addon: ImageIO for pictures on macOS, ffprobe otherwise). */
export function probe(path: string): Promise<Probe> {
  return native().probe(path);
}

/**
 * Identity of a source file's content for cache reuse across projects (the addon's).
 */
export function mediaKey(path: string): string {
  return native().mediaKey(path);
}

/** `waiting` (a transcript only): it waits on something outside Edit (the plan's credit, the day's allowance) and is tried again by itself at `transcript_retry_at`. */
export type Stage = "pending" | "working" | "ready" | "failed" | "skipped" | "waiting";

export interface MediaStatus {
  proxy: Stage;
  proxy_progress: number;
  /** The light preview (720p, ~1.5 Mbit/s) for watching from another machine. */
  light: Stage;
  thumbs: Stage;
  thumb_count: number;
  peaks: Stage;
  /** `pending` = not requested (it costs money, so it never starts on its own). */
  transcript: Stage;
  transcript_error?: string;
  /** Transcript waiting: when Edit tries it again by itself (ms since the epoch). */
  transcript_retry_at?: number;
  error?: string;
}

/** The status in the field order it's always been written in, optional fields left out when unset. */
function shown(status: MediaStatus): MediaStatus {
  const out: MediaStatus = {
    proxy: status.proxy,
    proxy_progress: status.proxy_progress,
    light: status.light,
    thumbs: status.thumbs,
    thumb_count: status.thumb_count,
    peaks: status.peaks,
    transcript: status.transcript,
  };
  if (status.transcript_error !== undefined) out.transcript_error = status.transcript_error;
  if (status.transcript_retry_at !== undefined) out.transcript_retry_at = status.transcript_retry_at;
  if (status.error !== undefined) out.error = status.error;
  return out;
}

/**
 * A file whose words aren't in, named for the agent with why when it waits
 * ("Bodycam.mp4 (the transcription plan … is out of credit …; Edit tries
 * again by itself at 14:30)"), else its name alone.
 */
export function unheardName(name: string, status: MediaStatus): string {
  if (status.transcript === "waiting" && status.transcript_error !== undefined) return `${name} (${status.transcript_error.replace(/\.$/, "")})`;
  return name;
}

/**
 * Whether `path` is one of this machine's copies of cloud files (a proxy,
 * which then is a preview already). Here, not in cloud_media.ts, because the
 * processor needs it.
 */
export function isLocalCopy(cache: string, path: string): boolean {
  return startsWith(path, join(cache, "cloud")) || startsWith(path, join(canonical(cache), "cloud"));
}

export class Processor {
  private statuses = new Map<string, MediaStatus>();
  private processing = new Set<string>();

  constructor(private store: Store) {}

  paths(source: string): CachePaths {
    const dir = join(this.store.cacheDir(), mediaKey(source));
    return {
      proxy: join(dir, "preview.mp4"),
      audio: join(dir, "preview.m4a"),
      proxyDone: join(dir, "preview.done"),
      thumbs: join(dir, "thumbs.jpg"),
      thumbsMeta: join(dir, "thumbs.json"),
      peaks: join(dir, "peaks.bin"),
      transcript: join(dir, "transcript.json"),
      light: join(dir, "preview-light.mp4"),
    };
  }

  /** Forgets what's known of a media key's files (cache_cleanup removed them): read from disk again when asked. */
  forgetKey(key: string): void {
    this.statuses.delete(key);
  }

  /** Native/background writers still own this media's generated files. */
  busyKey(key: string): boolean {
    return this.processing.has(key);
  }

  status(source: string): MediaStatus {
    const known = this.statuses.get(mediaKey(source));
    if (known === undefined) return this.statusFromDisk(source);
    // "Not in the cloud" is asked again once that answer is old: a dropped file's proxy is uploaded just after
    // the drop returns, so the first ask can find nothing (Nov 11: a fresh upload stayed "failed" for good).
    const key = known.error === MISSING_IN_CLOUD ? playbackKey(source) : null;
    if (key !== null && this.askAbout(source, key) === true) {
      // Known to be there now, by its upload ending or another look (Nov 21, a MacBook Air: a one-minute file stayed
      // "failed" for four minutes, until a restart, its proxy up after 7 s: an answer already at hand was returned
      // here and never took the failure back, which only a new ask's answer did).
      this.set(source, (status) => {
        status.proxy = "ready";
        status.proxy_progress = 1;
        delete status.error;
      });
      return shown(this.statuses.get(mediaKey(source)) ?? known);
    }
    return shown(known);
  }

  private statusFromDisk(source: string): MediaStatus {
    const paths = this.paths(source);
    let thumbCount = 0;
    try {
      const meta = JSON.parse(fs.readFileSync(paths.thumbsMeta, "utf8")) as { count?: unknown };
      if (typeof meta.count === "number" && Number.isInteger(meta.count) && meta.count >= 0) thumbCount = meta.count;
    } catch {
      thumbCount = 0;
    }
    const key = playbackKey(source);
    const streamed = key !== null;
    // A streamed proxy is ready unless the cloud said it isn't there (asked once, kept a while: `keyVerdict`).
    const gone = key !== null && this.askAbout(source, key) === false;
    const proxied = (streamed && !gone) || isFile(paths.proxyDone);
    return {
      proxy: gone ? "failed" : proxied ? "ready" : "pending",
      proxy_progress: proxied ? 1 : 0,
      ...(gone ? { error: MISSING_IN_CLOUD } : {}),
      light: streamed ? "skipped" : isFile(paths.light) ? "ready" : "pending",
      thumbs: thumbCount > 0 && isFile(paths.thumbs) ? "ready" : "pending",
      thumb_count: thumbCount,
      peaks: isFile(paths.peaks) ? "ready" : "pending",
      transcript: isFile(paths.transcript) ? "ready" : "pending",
    };
  }

  /** The cloud's verdict on a streamed proxy's key; unknown, it's asked, and a "not there" answer is said as the media's status. */
  private askAbout(source: string, key: string): boolean | null {
    const known = keyVerdict(key);
    if (known !== null) return known;
    // On its way up from this computer (an import's upload, waiting its turn or going): not there yet is not
    // missing. Asked just after a short file's import answered, the cloud said "not there", and the file read
    // "failed: its proxy isn't in the cloud", with Export offering its parts black, for a minute or more (Nov 21).
    if (mediaHooks.goingUp?.(key) === true) return null;
    void checkKey(key).then((there) => {
      const now = this.statuses.get(mediaKey(source));
      if (there === false && mediaHooks.goingUp?.(key) === true) {
        forgetKeyVerdict(key);
        return;
      }
      if (there === true) {
        // There after all (its upload finished): playable, as a streamed proxy is.
        if (now?.error !== MISSING_IN_CLOUD) return;
        this.set(source, (status) => {
          status.proxy = "ready";
          status.proxy_progress = 1;
          delete status.error;
        });
        return;
      }
      if (there !== false) return;
      if (now === undefined || now.proxy === "failed") return;
      this.set(source, (status) => {
        status.proxy = "failed";
        status.proxy_progress = 0;
        status.error = MISSING_IN_CLOUD;
      });
    });
    return null;
  }

  private entry(source: string): MediaStatus {
    const key = mediaKey(source);
    let entry = this.statuses.get(key);
    if (entry === undefined) {
      entry = this.statusFromDisk(source);
      this.statuses.set(key, entry);
    }
    return entry;
  }

  private set(source: string, change: (status: MediaStatus) => void): void {
    const entry = this.entry(source);
    change(entry);
    this.store.emit({ type: "media", path: source, status: shown(entry) });
  }

  /**
   * Starts whatever work is missing for `source`. Safe to call repeatedly.
   * `whole`: it plays as it is, with no preview copies (a coded effect's
   * render carrying its alpha below its picture: H.264 with short GOPs
   * already, which a copy capped at 1080 would halve).
   */
  ensure(source: string, probe: Probe, whole = false): void {
    // A cloud proxy still being made in the cloud: nothing local to process
    // yet (playback streams it); processing runs when a fetch caches it.
    if (isLocalCopy(this.store.cacheDir(), source) && !isFile(source)) return;
    if (probe.kind === "image" || whole) {
      this.set(source, (status) => {
        status.proxy = "skipped";
        status.light = "skipped";
        if (probe.kind === "image") status.peaks = "skipped";
      });
    }
    // Told to the engine at once, before anything there measures it.
    void this.inputOf(source);
    const key = mediaKey(source);
    if (this.processing.has(key)) return;
    this.processing.add(key);
    const paths = this.paths(source);
    try {
      fs.mkdirSync(paths.proxy.slice(0, paths.proxy.lastIndexOf("/")), { recursive: true });
    } catch {
      // Each step reports its own failure to write.
    }
    // Limit all FFmpeg work, including waveforms and thumbnails, rather than
    // starting two unbounded extra decoders for every import.
    const slots = probe.kind === "image" ? imageSlots : backgroundSlots;
    // Only thumbnails and a waveform to make (a project opened: a cloud file's are made from its stream): they
    // start once nothing plays here and no footage is waited on (playing.ts), file by file, never pulling the link and the CPU from a play someone watches
    // (kenobi, Nov 17). A preview copy an import needs before it plays at all starts at once.
    const copying = probe.kind === "video" && !whole && playbackKey(source) === null && this.status(source).proxy !== "ready";
    const start = (): Promise<void> => slots.with(() => this.process(source, probe, paths, whole));
    void (copying || playing.isIdle() ? start() : playing.whenIdle().then(start))
      .catch((error: unknown) => {
        // A crash mid-way leaves no stage "working" (and the file can be processed again).
        const said = isBug(error) ? crashMessage(error) : diag.messageOf(error);
        diag.error("media", `processing ${source} crashed: ${said}`);
        this.set(source, (status) => {
          for (const stage of ["thumbs", "peaks", "proxy", "light"] as const) {
            if (status[stage] === "working") status[stage] = "failed";
          }
          status.error = `processing crashed (${said})`;
        });
      })
      .finally(() => this.processing.delete(key));
  }

  private readonly inputs = new Map<string, Promise<string>>();

  /**
   * What analysis of `source` decodes: the source, or the original where
   * it's a pieced proxy (reading the proxy whole would make every piece of
   * it: the 10-hour trial's loudness asked for all 633), told to the engine
   * so its analyses read the same.
   */
  private inputOf(source: string): Promise<string> {
    const known = this.inputs.get(source);
    if (known !== undefined) return known;
    const found = (async () => {
      try {
        const input = (await mediaHooks.analysisInput?.(source)) ?? source;
        if (input !== source) native().analyseFrom(source, input);
        return input;
      } catch (error) {
        this.inputs.delete(source);
        diag.warn("media", `finding what to read for ${diag.scrub(source)}: ${diag.messageOf(error)}; reading it`);
        return source;
      }
    })();
    this.inputs.set(source, found);
    return found;
  }

  /** Its loudness analysis made now, in the background, so the first measure_audio / set_loudness is instant. */
  warmLoudness(source: string): void {
    void this.inputOf(source).then(() => native().loudnessWarm(source));
  }

  private async process(source: string, probe: Probe, paths: CachePaths, whole = false): Promise<void> {
    const status = this.status(source);
    const input = await this.inputOf(source);
    const pictured = (kind: MediaKind) => kind === "video" || kind === "image";
    const failed = (error: unknown) => diag.scrub(diag.messageOf(error));
    if (pictured(probe.kind) && status.thumbs !== "ready") {
      this.set(source, (s) => {
        s.thumbs = "working";
      });
      try {
        const count = await diag.timeOnAsync("media", "media: thumbnails", source, () =>
          probe.kind === "image" ? native().makeImageThumbs(source, paths) : makeThumbs(input, probe, paths),
        );
        this.set(source, (s) => {
          s.thumbs = "ready";
          s.thumb_count = count;
        });
      } catch (error) {
        if (isBug(error)) throw error;
        this.set(source, (s) => {
          s.thumbs = "failed";
          s.error = failed(error);
        });
      }
    } else if (!pictured(probe.kind)) {
      this.set(source, (s) => {
        s.thumbs = "skipped";
      });
    }
    if (probe.has_audio && status.peaks !== "ready") {
      this.set(source, (s) => {
        s.peaks = "working";
      });
      try {
        await diag.timeOnAsync("media", "media: waveform", source, () => native().makePeaks(input, paths.peaks));
        this.set(source, (s) => {
          s.peaks = "ready";
        });
      } catch (error) {
        if (isBug(error)) throw error;
        this.set(source, (s) => {
          s.peaks = "failed";
          s.error = failed(error);
        });
      }
    } else if (!probe.has_audio) {
      this.set(source, (s) => {
        s.peaks = "skipped";
      });
    }
    if (probe.kind === "image" || whole) {
      this.set(source, (s) => {
        s.proxy = "skipped";
      });
    } else if (playbackKey(source) !== null) {
      // Streamed from the cloud: its preview is the cloud's, ready while its key is there (`statusFromDisk`), and
      // never copied here. One the cloud no longer had (an effect's older render, Sphe's prod Nov 19 to 22) was taken
      // as a copy to make: FFmpeg, which reads only files for one, refused the stream's address ("Invalid argument"),
      // and its words replaced what was really wrong.
    } else if (status.proxy !== "ready") {
      this.set(source, (s) => {
        s.proxy = "working";
        delete s.error;
      });
      // A cloud proxy already is a preview: linked, not encoded again.
      const fromCloudProxy = isLocalCopy(this.store.cacheDir(), source) && probe.kind === "video";
      try {
        await diag.timeOnAsync("media", "media: preview copy", source, () =>
          native().makePreview({ source, probe, paths, fromCloudProxy }, (progress) =>
            this.set(source, (s) => {
              s.proxy_progress = progress;
            }),
          ),
        );
        this.set(source, (s) => {
          s.proxy = "ready";
          s.proxy_progress = 1;
        });
      } catch (error) {
        if (isBug(error)) throw error;
        this.set(source, (s) => {
          s.proxy = "failed";
          s.error = failed(error);
        });
      }
    }
    // Then the light one, from the preview (already scaled and tagged).
    const proxied = this.status(source).proxy === "ready";
    if (probe.kind !== "video" || whole || playbackKey(source) !== null) {
      this.set(source, (s) => {
        s.light = "skipped";
      });
    } else if (proxied && !isFile(paths.light)) {
      this.set(source, (s) => {
        s.light = "working";
      });
      try {
        await diag.timeOnAsync("media", "media: light preview", source, () =>
          native().makeLightPreview(source, paths, probe),
        );
        this.set(source, (s) => {
          s.light = "ready";
        });
      } catch (error) {
        if (isBug(error)) throw error;
        this.set(source, (s) => {
          s.light = "failed";
          s.error = failed(error);
        });
      }
    }
    // What only the agent's work needs (censor checks, borders, burned-in subtitles) waits for it: `warmForAgent`.
  }

  /** Footage `warmForAgent` has started on. */
  private warmed = new Set<string>();

  /**
   * What only the agent's work needs of a project's footage, started when an
   * agent first asks for its edit context (get_edit_context), never on opening
   * or importing it (kenobi, Nov 17: opening Cops Found 3 Bodies on an M1 began
   * 73 burned-in subtitle reads and 46 censor checks beside a cold play, the load
   * at 16.7 on 8 cores): each video's censored stretches (the light preview's
   * when there is one), so the audit's censored_broll is ready by the time the
   * edit is reviewed (started only by the audit, Mom Leaves 5 Kids' final pass
   * found all sixteen files still pending and its blurred B-roll went out); each
   * picture's own black borders (a tape's edge), so footage placed later fills
   * the frame; and the subtitles burned into each video's picture (another
   * channel's finished video), so the agent knows before it subtitles. One file
   * after another, each once nothing plays here. `footage`: the project's, less
   * effects' renders and finished videos of ours.
   */
  warmForAgent(footage: readonly Pick<Media, "path" | "name" | "kind" | "duration" | "width" | "height">[]): void {
    // Imported when needed: it reaches the watch and the pieces, which import this file.
    const videos = footage.filter((one) => one.kind === "video");
    if (videos.length > 0) void import("./burned_subtitles.ts").then((burned) => videos.forEach((one) => void burned.warm(this, one)));
    const fresh = footage.filter((one) => (one.kind === "video" || one.kind === "image") && !this.warmed.has(one.path));
    for (const one of fresh) this.warmed.add(one.path);
    if (fresh.length === 0) return;
    void (async () => {
      for (const one of fresh) {
        await playing.whenIdle();
        try {
          if (one.kind === "video") this.censorLater(one.path, await this.inputOf(one.path));
          framing.warmBorders(one);
        } catch (error) {
          diag.warn("media", `${diag.scrub(one.path)}: starting what the agent needs of it: ${diag.messageOf(error)}`);
        }
      }
    })();
  }

  /**
   * Transcribes `source` again, its transcript dropped first: for one the
   * transcriber garbled (a few stray words for a whole take).
   */
  retranscribe(source: string, hasAudio: boolean): MediaStatus {
    if (this.entry(source).transcript === "working") return this.status(source);
    fs.rmSync(this.paths(source).transcript, { force: true });
    this.stopWaiting(source);
    this.set(source, (status) => {
      status.transcript = "pending";
      delete status.transcript_error;
      delete status.transcript_retry_at;
    });
    return this.transcribe(source, hasAudio);
  }

  /**
   * Transcribes `source` through the relay unless already done or running,
   * listening for `keyterms` (the case's names, names.ts). `again` hears a
   * finished one again (with names it wasn't given): the old transcript stays
   * until the new one is in. `whole`: Scribe hears all of it now, with no free
   * first hearing (a link pasted in a chat, links.ts: one piece the person
   * asked for, not hours to cut down).
   */
  transcribe(source: string, hasAudio: boolean, keyterms: readonly string[] = [], again = false, freeOnly = false, whole = false): MediaStatus {
    const current = this.entry(source);
    // Shared analysis can arrive after status() first saw this file. It is
    // still completed work and must win over a new caption/paid request.
    if (!again && current.transcript !== "working" && isFile(this.paths(source).transcript)) {
      current.transcript = "ready";
      delete current.transcript_error;
      delete current.transcript_retry_at;
    }
    if (!hasAudio || current.transcript === "working" || (current.transcript === "ready" && !again)) return shown(current);
    // Waiting on the plan's credit: asked again at its time (`waitThenHear`), not into the same refusal now.
    if (current.transcript === "waiting" && (current.transcript_retry_at ?? 0) > Date.now()) return shown(current);
    this.stopWaiting(source);
    // Claimed before anything can wait: two requests cannot start the same
    // paid transcription between status() and set().
    this.set(source, (status) => {
      status.transcript = "working";
      delete status.transcript_error;
      delete status.transcript_retry_at;
    });
    const target = this.paths(source).transcript;
    // A local-first project's whole source (local_first.ts): its words are what the timeline keeps, never all of it
    // as a side effect of being imported whole (`localWholeOf`).
    const localWhole = sharedSourceOf(this.store.cacheDir(), source) === null ? this.localWholeOf(source) : null;
    // A cloud excerpt whose whole recording was heard already (Writer shares its words) takes its words from there,
    // and so does a local-first source, by its registry source: Script mode's hearing, or another project's.
    const shared = again ? null : (sharedSourceOf(this.store.cacheDir(), source) ?? localWhole);
    // Scribe's words and voices, never YouTube's captions: they have no voices (every line its own
    // `caption_turn_N`) and JJ's notes caught their words wrong ("bit*", "slept", a "you" missing).
    const words = async () => {
      if (shared !== null && mediaHooks.wholeTranscript !== null && (await mediaHooks.wholeTranscript(shared, target).catch(() => false))) return;
      // A pieced proxy is heard from its original, as its other analyses are: read through the proxy, a long
      // recording made every piece at once (Killer Pastor in dev, Nov 8: its 1 h 52 min tape heard again took Edit
      // past 23 GB and Bun aborted).
      const input = await this.inputOf(source);
      // A long file's first words are free (first_hearing.ts): the agent cuts on them, and Scribe hears only
      // what's kept (`refine`). Heard again on purpose (`again`): Scribe, whole.
      const seconds = again || whole ? 0 : await transcribe.seconds(input);
      if (!again && !whole && (seconds > FIRST_PASS_FROM_S || localWhole !== null)) {
        const work = join(parent(target) ?? ".", "first");
        try {
          if (await firstWords(this.store.home, this.cloudSource(source), input, target, work, seconds)) return;
        } finally {
          fs.rmSync(work, { recursive: true, force: true });
        }
      }
      if (freeOnly) throw new NothingFree();
      if (localWhole !== null && !again && !whole) {
        // No free words for it (Linux, or a video without word-timed captions): none rather than all of it paid for.
        // Scribe hears what the timeline keeps (`refine`: the import's ranges, a clip placed later) and any stretch
        // the agent asks for (broll.ts `mediaTranscript`), the way a long excerpt's rough words were refined.
        writeAtomic(target, transcribe.serialize({ model: log.NO_WORDS, language: null, words: [], heard: [], rough: log.NO_WORDS }));
        log.line(`${log.nameOf(localWhole)}: no free first words; Scribe hears only what the edit keeps of its ${log.clock(seconds)}`);
        return;
      }
      await transcribe.run(input, target, keyterms, again);
    };
    // The words, then pyannote's voices while the relay's flag is on (voices.ts; off from Nov 10), before
    // the transcript is ready, so speakers.ts names the voices that will stay.
    const hear = async () => {
      await words();
      if (await voices.on()) await voices.revoice(this.store.cacheDir(), await this.inputOf(source), target, this.cloudSource(source));
    };
    void diag
      .timeOnAsync("media", "media: transcription", source, hear)
      .then(
        () =>
          this.set(source, (status) => {
            status.transcript = "ready";
          }),
        (error: unknown) => {
          // Only free words were asked for and there are none here: nothing was done, nothing failed.
          if (error instanceof NothingFree) {
            this.set(source, (status) => {
              status.transcript = "pending";
            });
            return;
          }
          // Heard again for its names and failed: the transcript it had stands.
          if (again && isFile(target)) {
            diag.warn("media", `${source}: hearing it again with the case's names: ${diag.messageOf(error)}; the transcript it had stands`);
            this.set(source, (status) => {
              status.transcript = "ready";
            });
            return;
          }
          // The plan out of credit, or the day's allowance used up: it waits, said plainly, and is heard by itself
          // at its time (the plan's half hour, the allowance's reset). It failed for good, its reason lost (Nov 16 audit).
          if (!isBug(error) && failure.kindOf(error) === "quota") {
            const at = steps.retryAt("quota", Date.now(), error)!;
            diag.warn("media", `${diag.scrub(source)}: transcription waits until ${new Date(at).toLocaleString()}: ${diag.messageOf(error)}`);
            this.set(source, (status) => {
              status.transcript = "waiting";
              status.transcript_error = steps.hearingWaits(error, at);
              status.transcript_retry_at = at;
            });
            this.waitThenHear(source, at, () => this.transcribe(source, hasAudio, keyterms, again, freeOnly, whole));
            return;
          }
          this.set(source, (status) => {
            status.transcript = "failed";
            status.transcript_error = isBug(error)
              ? `transcription crashed (${crashMessage(error)}); this is a bug in Edit`
              : diag.messageOf(error);
          });
        },
      );
    return this.status(source);
  }

  /**
   * The registry source (`youtube:<id>`, `drive:<id>`, `sha256:<hex>`) of a local-first project's whole source this
   * file is (local_first.ts: one media a source, imported whole where today's path cut excerpts), else null.
   */
  localWholeOf(path: string): string | null {
    for (const id of this.store.usingMedia(path)) {
      const project = this.store.get(id)?.project;
      if (project?.local_media !== true) continue;
      const source = project.media.find((item) => item.path === path)?.cloud?.source;
      if (typeof source === "string" && /^(?:youtube|drive):[A-Za-z0-9_-]+$|^sha256:[a-f0-9]{64}$/u.test(source)) return source;
    }
    return null;
  }

  /** A file without words, named for the agent with why when it waits (`unheardName`): edit_tools' "Not transcribed yet". */
  unheard(source: string, name: string): string {
    return unheardName(name, this.status(source));
  }

  /** Files whose words wait on the plan's credit, each with its timer. */
  private waits = new Map<string, ReturnType<typeof setTimeout>>();

  /** Hears `source` again at `at`, by itself, if it's still waiting then. */
  private waitThenHear(source: string, at: number, hear: () => void): void {
    this.stopWaiting(source);
    const timer = setTimeout(() => {
      this.waits.delete(source);
      if (this.entry(source).transcript !== "waiting") return;
      this.set(source, (status) => {
        delete status.transcript_retry_at;
      });
      hear();
    }, Math.max(at - Date.now(), 0));
    timer.unref?.();
    this.waits.set(source, timer);
  }

  private stopWaiting(source: string): void {
    const timer = this.waits.get(source);
    if (timer !== undefined) clearTimeout(timer);
    this.waits.delete(source);
  }

  /** Refinements running, by file: one at a time each, so two readers never pay for the same stretch. */
  private refining = new Map<string, Promise<unknown>>();

  /**
   * Scribe's words over every stretch of `source` in `kept` (seconds into it)
   * that has only rough words (kept_hearing.ts): only those stretches, padded
   * and joined, are heard, once; heard before, they're left. Footage kept
   * almost whole is heard whole. Answers whether anything was heard.
   */
  refine(source: string, kept: readonly (readonly [number, number])[], keyterms: readonly string[] = [], again = false): Promise<boolean> {
    const before = this.refining.get(source) ?? Promise.resolve();
    const mine = before.then(() => this.refineNow(source, kept, keyterms, again));
    const settled = mine.catch(() => undefined);
    this.refining.set(source, settled);
    void settled.then(() => {
      if (this.refining.get(source) === settled) this.refining.delete(source);
    });
    return mine;
  }

  private async refineNow(source: string, kept: readonly (readonly [number, number])[], keyterms: readonly string[], again: boolean): Promise<boolean> {
    const target = this.paths(source).transcript;
    const transcript = readKept(target);
    if (transcript === null || transcript.heard === undefined) return false;
    const input = await this.inputOf(source);
    const length = Math.round((await transcribe.seconds(input)) * 1000) || Math.max(0, ...kept.map(([, to]) => to * 1000), ...transcript.words.map((word) => word.end * 1000));
    const heardMs = transcript.heard.map(([from, to]): [number, number] => [from * 1000, to * 1000]);
    // Again (for the case's names, heard without them): everything heard so far and what's kept, heard once more.
    // Again (for the case's names, heard without them): what's kept now, heard once more; stretches heard
    // before that the edit no longer keeps aren't paid for again.
    const keptMs = kept.map(([from, to]): [number, number] => [from * 1000, to * 1000]);
    const spans = toHear(keptMs, again ? [] : heardMs, length);
    if (spans.length === 0) return false;
    const total = spans.reduce((sum, [from, to]) => sum + to - from, 0);
    const work = join(parent(target) ?? ".", "kept");
    const cloudSource = this.cloudSource(source);
    const name = cloudSource !== null ? log.nameOf(cloudSource) : log.labelOf(source);
    const rough = transcript.rough ?? transcript.model;
    const heardBefore = transcript.heard.reduce((sum, [from, to]) => sum + to - from, 0);
    const began = Date.now();
    try {
      if (transcript.heard.length === 0 && total >= WHOLE_SHARE * length) {
        // Kept almost whole (a subtitled video): one request for the file.
        log.line(`${name}: the edit keeps ${log.clock(total / 1000)} of its ${log.clock(length / 1000)}, so Scribe hears all of it, replacing ${log.said(rough)}'s words`);
        const whole = join(work, "whole.json");
        fs.mkdirSync(work, { recursive: true });
        await transcribe.run(input, whole, keyterms);
        fs.renameSync(whole, target);
        const heard = readKept(target);
        log.line(`${name}: now ${log.said(heard?.model ?? transcribe.MODEL)} for all ${log.clock(length / 1000)}, ${log.count(heard?.words.length ?? 0)} words, in ${log.took(Date.now() - began)}`);
      } else {
        log.line(
          `${name}: Scribe to hear the ${spans.length} kept stretch${spans.length === 1 ? "" : "es"} ${again ? `again, for the case's ${keyterms.length} names` : "it hasn't yet"}, ${log.clock(total / 1000)} of its ${log.clock(length / 1000)} (${log.clock(heardBefore)} heard before); the rest stays ${log.said(rough)}`,
        );
        const words = await hearJoined(work, input, spans, [...keyterms]);
        // Re-read: naming or the watch may have written meanwhile. Heard whole meanwhile (Transcribe, heard again) or
        // gone, it's left as it is: these stretches never turn a whole hearing back into a partial one.
        const now = readKept(target);
        if (now === null || now.heard === undefined) {
          log.line(`${name}: heard whole or cleared while its kept stretches were heard; those words left out`);
          fs.rmSync(work, { recursive: true, force: true });
          return false;
        }
        const next = merged(now, spans, words, keyterms, transcribe.MODEL, again);
        writeAtomic(target, transcribe.serialize(next));
        const heardNow = (next.heard ?? []).reduce((sum, [from, to]) => sum + to - from, 0);
        log.line(
          `${name}: ${log.said(next.model)} heard the ${spans.length} kept stretch${spans.length === 1 ? "" : "es"} (${log.clock(total / 1000)}), ${log.count(words.flat().length)} words, in ${log.took(Date.now() - began)}; Scribe has now heard ${log.clock(heardNow)} of its ${log.clock(length / 1000)}, ${log.said(next.rough ?? rough)} the rest`,
        );
      }
    } catch (error) {
      // What Scribe answered is kept in `work` (writer/hearing.ts, transcribe.ts `saved`): a retry of the same
      // stretches reads it instead of paying again.
      log.line(`${name}: Scribe's hearing of the kept stretches failed (${diag.messageOf(error)}); what it answered is kept for the next try`);
      throw error;
    }
    fs.rmSync(work, { recursive: true, force: true });
    return true;
  }

  /**
   * Its censored stretches read in the background. A streamed cloud preview is read from its whole copy here,
   * once it's come down (the copy the players read: `mediaHooks.censorInput`), never through the stream: read
   * whole through the loopback, every frame of it, while an import filled the link, it failed again and again
   * with "Error opening input files: Input/output error" (the M4, Nov 16), FFmpeg's word for an answer that
   * ended short. A copy that can't come (no room for it, its fetch failing) isn't read at all, said in a line,
   * and is asked for again at the agent's next look (`warmForAgent`). A pieced proxy is read from its original
   * (`input`), on R2 over HTTPS when it isn't here (the engine gives every FFmpeg the system's certificates:
   * util.rs `ffmpeg_command`; until Nov 17 its own children had none, and on Sphe's M4 three failed at once).
   */
  private censorLater(source: string, input: string): void {
    const read = input === source ? null : input;
    const local = read === null ? mediaHooks.censorInput?.(source) ?? null : null;
    if (local === null) {
      native().censorWarm(source, read);
      return;
    }
    void local.then(
      (path) => native().censorWarm(source, path),
      (error: unknown) => {
        this.warmed.delete(source);
        diag.info("media", `${diag.scrub(source)}: censor check waits for its whole copy here (${diag.messageOf(error)}); not read from the stream`);
      },
    );
  }

  /** What a file's analyses read: a pieced proxy's original, else the file itself. */
  analysisInput(source: string): Promise<string> {
    return this.inputOf(source);
  }

  /** The cloud recording (and excerpt) a file is (`youtube:<id>#<ms>-<ms>`, `drive:<id>`…), from its project or the cache's layout, else null. */
  cloudSource(path: string): string | null {
    const shared = sharedSourceOf(this.store.cacheDir(), path);
    if (shared !== null) return shared;
    for (const id of this.store.usingMedia(path)) {
      const source = this.store.get(id)?.project?.media.find((item) => item.path === path)?.cloud?.source;
      if (typeof source === "string" && source !== "") return source;
    }
    return this.captionSource(path);
  }

  /** Resolve the original source and excerpt clock from saved provenance,
   * never from a display filename (a joined master is not one YouTube video). */
  private captionSource(path: string): string | null {
    const shared = sharedSourceOf(this.store.cacheDir(), path);
    if (shared?.startsWith("youtube:")) return shared;
    for (const id of this.store.usingMedia(path)) {
      const project = this.store.get(id)?.project;
      const media = project?.media.find((item) => item.path === path);
      if (!project || !media) continue;
      if (media.cloud?.source.startsWith("youtube:")) return media.cloud.source;
      const blocks = project.script?.blocks.filter((block) => block.kind === "footage" && block.media === media.id) ?? [];
      const block = blocks[0];
      if (block?.kind !== "footage" || !/^youtube:[A-Za-z0-9_-]{11}$/u.test(block.file)) continue;
      const offset = block.media_start ?? 0;
      if (!blocks.every((one) => one.kind === "footage" && one.file === block.file && (one.media_start ?? 0) === offset)) continue;
      return `${block.file}#${Math.round(offset * 1000)}-${Math.round((offset + media.duration) * 1000)}`;
    }
    return null;
  }
}

/** A streamed proxy whose key the cloud doesn't have: said as the media's error (and in the editor's missing footage). */
export const MISSING_IN_CLOUD = "Its proxy isn't in the cloud: the footage can't play until it's imported again.";

/** How long the cloud's answer about a key is kept: "there" for a while, "not there" briefly (an upload may be finishing). */
const VERDICT_MS = { there: 10 * 60_000, missing: 60_000 };
const verdicts = new Map<string, { there: boolean; at: number }>();
const asking = new Map<string, Promise<boolean | null>>();

/** Whether the cloud has `key`, as last asked (null: not asked lately, or a pieced proxy's address, which is no object of its own). */
export function keyVerdict(key: string): boolean | null {
  if (key.startsWith("edit/pieces/")) return true;
  const known = verdicts.get(key);
  if (known === undefined || Date.now() - known.at > (known.there ? VERDICT_MS.there : VERDICT_MS.missing)) return null;
  return known.there;
}

/** Forgets what the cloud said about `key` (its footage was just brought back), so the next look asks again. */
export function forgetKeyVerdict(key: string): void {
  verdicts.delete(key);
}

/** `key` was just put in the cloud from here (an import's upload ended): there, without asking. */
export function keyIsThere(key: string): void {
  verdicts.set(key, { there: true, at: Date.now() });
}

/** Asks the cloud whether it has `key` (HEAD through the relay, one ask at a time per key); null when it couldn't say. */
export function checkKey(key: string): Promise<boolean | null> {
  const known = keyVerdict(key);
  if (known !== null) return Promise.resolve(known);
  const ask = mediaHooks.keyAnswers;
  if (ask === null) return Promise.resolve(null);
  const flying = asking.get(key);
  if (flying !== undefined) return flying;
  const askedAt = Date.now();
  const flight = ask(key)
    .then(
      (there) => {
        // Put there while this was asked (its upload ended, `keyIsThere`): a "not there" from before that is old.
        const since = verdicts.get(key);
        if (!there && since?.there === true && since.at >= askedAt) return true as boolean | null;
        verdicts.set(key, { there, at: Date.now() });
        return there as boolean | null;
      },
      () => null,
    )
    .finally(() => asking.delete(key));
  asking.set(key, flight);
  return flight;
}

/** What media.ts reaches without importing it: cloud_media's shared transcripts (set as it loads). */
export const mediaHooks: {
  /** Whether the cloud has a key (cloud_media: HEAD); rejects when it can't say. */
  keyAnswers: ((key: string) => Promise<boolean>) | null;
  wholeTranscript: ((source: string, target: string) => Promise<boolean>) | null;
  /**
   * What a source's derived data (thumbnails, waveform, censored stretches)
   * is read from, when not the source itself: a pieced proxy's original
   * (cloud_media.ts), since reading the whole proxy would make every piece of
   * it. The results are still kept as the source's.
   */
  analysisInput: ((source: string) => Promise<string | null>) | null;
  /**
   * The file here the censor check reads for a streamed cloud preview `source` (its whole copy, fetched if it
   * isn't here yet, resolved once it is), or null for any other source (read as it is).
   */
  censorInput: ((source: string) => Promise<string> | null) | null;
  /** Whether an upload from this computer that puts `key` in the cloud is waiting or going (cloud_media's imports). */
  goingUp: ((key: string) => boolean) | null;
} = { keyAnswers: null, wholeTranscript: null, analysisInput: null, censorInput: null, goingUp: null };

/** `transcribe` was asked for free words only (an import) and there are none for this file. */
class NothingFree extends Error {}

/**
 * The cloud source a proxy in this machine's cache is (`<cache>/cloud/proxies/<drive|youtube>/<id>/<start>-<end>.mp4`
 * is the excerpt `<kind>:<id>#<start>-<end>`, `…/<id>.mp4` the whole recording: cloud_media's layout), or null.
 */
export function sharedSourceOf(cache: string, path: string): string | null {
  const root = join(cache, "cloud", "proxies");
  const streamed = playbackKey(path);
  if (streamed === null && !path.startsWith(`${root}/`)) return null;
  const rest = streamed === null ? path.slice(root.length + 1) : streamed.replace(/^edit\/proxies\//, "");
  const excerpt = /^(drive|youtube)\/([^/]+)\/(\d+)-(\d+)\.mp4$/u.exec(rest);
  if (excerpt !== null) return `${excerpt[1]}:${excerpt[2]}#${excerpt[3]}-${excerpt[4]}`;
  const whole = /^(drive|youtube)\/([^/]+)\.mp4$|^(sha256)\/([a-f0-9]{64})\.mp4$/u.exec(rest);
  return whole === null ? null : `${whole[1] ?? whole[3]}:${whole[2] ?? whole[4]}`;
}

function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The light preview of `source` in the media cache, if it's been made. */
export function lightPreview(source: string): string | null {
  return native().lightPreview(source);
}

/**
 * The thumbnail strip: keyframes only (fast), at most one per interval, tiled
 * into one JPEG strip 72 px high. Sparse keyframes yield fewer frames, so it
 * counts what came out before tiling. Long footage (a thumbnail every 20 s
 * or more) has each read where it is instead of the whole file read through
 * for them: a 10-hour original's 54 GB took the pass longer than the trial
 * (Nov 4) ran between restarts, and slowed everything else on its drive.
 */
/** Thumbnails this far apart (seconds) or more are each read where they are. */
const LONG_THUMB_INTERVAL = 20;

export async function makeThumbs(source: string, probe: Probe, paths: CachePaths): Promise<number> {
  const wanted = Math.min(Math.max(Math.ceil(probe.duration / 2), 1), 120);
  const interval = Math.max(probe.duration / wanted, 0.05);
  const framesDir = withExtension(paths.thumbs, "frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const read = (extra: string[], out: string, frames: number) =>
    tools.run([
      tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-skip_frame", "nokey",
      ...extra, "-protocol_whitelist", tools.protocols(source), ...tools.urlArgs(source), "-i", source, "-an",
      "-vf", frames === 1 ? `scale=-2:${THUMB_HEIGHT}` : `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${(interval * 0.99).toFixed(4)})',scale=-2:${THUMB_HEIGHT}`,
      "-fps_mode", "vfr", "-frames:v", String(frames), "-q:v", "5", out,
    ], { background: true });
  if (interval >= LONG_THUMB_INTERVAL) {
    const frame = (n: number) => join(framesDir, `${String(n + 1).padStart(4, "0")}.jpg`);
    let next = 0;
    const one = async () => {
      for (let n = next++; n < wanted; n = next++) {
        await read(["-ss", (n * interval).toFixed(3)], frame(n), 1).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: 4 }, one));
    // One that couldn't be read (past a file's real end) is its neighbour's, so each stays at its time.
    const made = Array.from({ length: wanted }, (_, n) => isFile(frame(n)));
    if (made.includes(true)) {
      for (let n = 0, last = made.indexOf(true); n < wanted; n++) {
        if (made[n]) last = n;
        else fs.copyFileSync(frame(last), frame(n));
      }
    }
  } else {
    await read([], join(framesDir, "%04d.jpg"), wanted);
  }
  const count = fs.readdirSync(framesDir).length;
  if (count === 0) {
    fs.rmSync(framesDir, { recursive: true, force: true });
    throw new Error("no thumbnails could be decoded");
  }
  const tmp = withExtension(paths.thumbs, "partial.jpg");
  try {
    await tools.run([
      tools.ffmpeg(),
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-threads",
      "2",
      "-filter_threads",
      "1",
      "-i",
      join(framesDir, "%04d.jpg"),
      "-vf",
      `tile=${count}x1`,
      "-frames:v",
      "1",
      "-q:v",
      "5",
      tmp,
    ], { background: true });
  } finally {
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
  fs.renameSync(tmp, paths.thumbs);
  writeAtomic(paths.thumbsMeta, JSON.stringify({ count, interval }));
  return count;
}
