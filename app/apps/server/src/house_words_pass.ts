// Edit V2's house words, by itself (Sphe, Nov 17, for the next nightly). V1's
// agent runs mute_house_words once a turn because its instructions say so; V2's
// aren't told to, so a house word in a voice-over, a recording or a caption it
// wrote could slip through. When an HQ turn that changed the edit ends, Edit
// runs the same pass over the whole timeline on what's saved then: the footage's
// and recordings' sound muted at each word, the narration's all but its first
// sound, every text on screen starred, a "not muted" marker respected. It only
// adds: a mute already there (the agent's own, its `words`, a neglect run) is
// never taken away, and an edit already right is left alone (no new revision).
// The person hears of it in one line only when it did something.

import * as fs from "node:fs";
import * as addons from "./addons.ts";
import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import * as effects from "./effects.ts";
import { speech } from "./hq_ears.ts";
import type { Media, Mute, Project } from "./model.ts";
import { join } from "./paths.ts";
import { clipEnd, duration } from "./project.ts";
import { splitWhitespace } from "./rust.ts";
import { agentPanel, type Kept } from "./seams.ts";
import * as seams from "./seams.ts";
import type { Store } from "./store.ts";
import { houseWords, mutedWords, starOnScreen, suggestions } from "./subtitles.ts";

/** Who the pass's saves are from: Edit's own work, never the agent's or a person's. */
export const ORIGIN = "house-words";

/** What a pass did: house words muted in the narration and in the rest of the sound, words starred on screen. */
export interface Passed {
  narration: number;
  sound: number;
  starred: number;
}

/** A sound file the V2 pass hears as speech besides footage and voice-overs: a recording (a 911 call), not the library's music or effects. */
const recording = (media: Media) => media.kind === "audio" && speech(media);

/** Mutes in `fresh` that none of `had` covers already. */
function uncovered(had: readonly Mute[], fresh: readonly Mute[]): Mute[] {
  return fresh.filter((mute) => !had.some((one) => one.from < mute.to && one.to > mute.from));
}

/** How many words differ between two texts (the words starred). */
function wordsChanged(before: string, after: string): number {
  const [a, b] = [splitWhitespace(before), splitWhitespace(after)];
  return a.filter((word, index) => word !== b[index]).length;
}

/** Adds the pass's mutes and stars to `project` (in place); what it changed. */
function apply(project: Project, adds: ReadonlyMap<string, [string, Mute[]]>, kept: readonly Kept[], voiceovers: ReadonlySet<string>): Passed {
  const out: Passed = { narration: 0, sound: 0, starred: 0 };
  for (const clip of project.clips) {
    const add = adds.get(clip.id);
    // A clip changed since it was heard (another file in it) waits for the next turn's pass.
    if (add === undefined || clip.type !== "audio" || clip.media !== add[0]) continue;
    const fresh = uncovered(clip.mutes ?? [], add[1]);
    if (fresh.length === 0) continue;
    clip.mutes = [...(clip.mutes ?? []), ...fresh].sort((a, b) => a.from - b.from);
    if (voiceovers.has(clip.id)) out.narration += fresh.length;
    else out.sound += fresh.length;
  }
  const before = new Map(project.clips.flatMap((clip) => (clip.type === "text" ? [[clip.id, clip.text] as const] : [])));
  const end = Math.max(duration(project), ...project.clips.map(clipEnd), 1);
  starOnScreen(project, 0, end, false, [], kept);
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const was = before.get(clip.id);
    if (was !== undefined && was !== clip.text) out.starred += wordsChanged(was, clip.text);
  }
  return out;
}

const changed = (passed: Passed) => passed.narration + passed.sound + passed.starred > 0;

/**
 * Mutes and stars the house words over an Edit V2 project's whole timeline,
 * adding to what's there (never taking a mute away): what it did, or null
 * when the edit was already right (nothing saved).
 */
export async function pass(app: App, projectId: string): Promise<Passed | null> {
  const live = app.store.get(projectId);
  if (live === null || live.project.hq !== true) return null;
  const project = live.project as Project;
  const end = Math.max(duration(project), ...project.clips.map(clipEnd), 1);
  // Only what's heard already: a file not transcribed yet is never transcribed or waited on here.
  const house = await houseWords(app, project, 0, end, false, [], { cachedOnly: true, recordings: recording });
  const adds = new Map<string, [string, Mute[]]>();
  for (const [clipId, [, , fresh]] of house.mutes) {
    const clip = project.clips.find((one) => one.id === clipId);
    if (clip === undefined || clip.type !== "audio" || fresh.length === 0) continue;
    adds.set(clipId, [clip.media, fresh]);
  }
  const voiceovers = new Set(seams.voiceover.voiceoverSound(project, 0, end).map((clip) => clip.id));
  // Tried on a copy first: an edit already right is never saved again.
  if (!changed(apply(structuredClone(project) as Project, adds, house.kept, voiceovers))) return null;
  const [, passed] = await app.store.update(projectId, ORIGIN, (edited) => apply(edited, adds, house.kept, voiceovers));
  return changed(passed) ? passed : null;
}

/** The line the person reads when the pass did something: "Muted 3 house words in the narration." */
export function line(passed: Passed): string {
  const words = (count: number) => `${count} house word${count === 1 ? "" : "s"}`;
  const muted: string[] = [];
  if (passed.narration > 0) muted.push(`${words(passed.narration)} in the narration`);
  if (passed.sound > 0) muted.push(`${muted.length === 0 ? words(passed.sound) : passed.sound} in the footage's sound`);
  const parts: string[] = [];
  if (muted.length > 0) parts.push(`Muted ${muted.join(" and ")}`);
  if (passed.starred > 0) parts.push(`${parts.length === 0 ? "Starred" : "starred"} ${muted.length === 0 ? words(passed.starred) : passed.starred} on screen`);
  return `${parts.join(", and ")}.`;
}

/** Runs the pass when an Edit V2 turn that changed the edit ends, one project at a time; the person hears of it in a line when it did something. */
export function start(app: App): void {
  let chain = Promise.resolve();
  // The project's revision when its turn began: a turn that changed nothing isn't looked at again.
  const began = new Map<string, number>();
  app.store.subscribe((event) => {
    if (event.type !== "agent" || event.event !== "status" || typeof event.project !== "string") return;
    const root = event.project.split("~")[0]!;
    const live = app.store.get(root);
    if (live === null || live.project.hq !== true) return;
    if (event.running === true) {
      if (!began.has(root)) began.set(root, live.rev);
      return;
    }
    if (event.running !== false) return;
    chain = chain
      .then(async () => {
        // A sub-agent's turn over while the project's own goes on: its end does it.
        if (agentPanel(app).turn?.(root).running === true) return;
        const from = began.get(root);
        began.delete(root);
        const now = app.store.get(root);
        if (now === null || (from !== undefined && now.rev === from)) return;
        // The channel's add-ons (its extra muted words) read fresh first, bounded; one that fails answers with the
        // edit's style's, as before, and the pass runs either way.
        if (typeof now.project.channel === "string" && now.project.channel !== "") {
          await addons.ready().catch((error: unknown) => diag.warn("house words", `${root}: the channel's add-ons weren't read, so its style's are used: ${diag.messageOf(error)}`));
        }
        const passed = await pass(app, root);
        if (passed === null) return;
        const said = line(passed);
        diag.info("house words", `${root}: ${said}`);
        agentPanel(app).note?.(root, said);
      })
      .catch((error: unknown) => diag.warn("house words", `${root}: ${diag.messageOf(error)}`));
  });
}

/** The files of an effect read for words it shows: its page and scripts, not pictures, fonts or big data. */
const CODE = /\.(html?|m?js|json|txt|svg)$/iu;
const LARGEST_CODE = 512 * 1024;

/** A string in code that names something rather than shows it: one lower-case word, a key, a path ("dead", "crack-sound", "./shot.png"). */
const NAMING = /^[a-z0-9_$.\/#:@-]*$/u;

/** The words a piece of code may show: its string literals that aren't names, and an HTML page's text outside its scripts and styles. */
export function shownWords(code: string): string[] {
  const literals = [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/gu)].map((match) => match[2]!).filter((one) => !NAMING.test(one));
  const page = code.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/giu, " ").replace(/<[^>]*>/gu, "\n");
  return [...literals, ...page.split("\n")].map((one) => one.trim()).filter((one) => one !== "");
}

/** The house words a coded text shows unstarred (each once): what `starText` would star. */
export function unstarredIn(code: string, extra: readonly string[] = []): string[] {
  const found = new Set<string>();
  for (const piece of shownWords(code)) {
    const words = splitWhitespace(piece).map((text, index) => ({ text, start_ms: index * 100.0, end_ms: index * 100.0 + 50.0, speaker: null }));
    for (const one of suggestions(words, false, -Number.MAX_VALUE, Number.MAX_VALUE, extra)) found.add(one.term);
  }
  return [...found];
}

/**
 * An effect's house words shown unstarred, as the line its agent reads
 * (look_at_effect, add_effect), or null: its words are code, so they're the
 * agent's to star, never changed here.
 */
export function effectLine(store: Store, projectId: string, name: string): string | null {
  const live = store.get(projectId);
  if (live === null) return null;
  // The channel's extra muted words (its `muted-words` add-on), on top of the house list `suggestions` always has.
  const extra = addons.has(live.project, "muted-words") ? mutedWords(live.project) : [];
  const dir = effects.folder(store, projectId, name);
  const terms = new Set<string>();
  const files: string[] = [];
  const walk = (under: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(join(dir, under), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const inside = under === "" ? entry.name : `${under}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") walk(inside);
      else if (entry.isFile() && CODE.test(entry.name)) {
        try {
          if (fs.statSync(join(dir, inside)).size > LARGEST_CODE) continue;
          const found = unstarredIn(fs.readFileSync(join(dir, inside), "utf8"), extra);
          if (found.length === 0) continue;
          for (const term of found) terms.add(term);
          files.push(inside);
        } catch {
          // Unreadable: nothing to say of it.
        }
      }
    }
  };
  walk("");
  if (terms.size === 0) return null;
  return `HOUSE WORDS UNSTARRED in its words on screen (${files.join(", ")}): ${[...terms].map((term) => `"${term}"`).join(", ")}. Words your graphics show are starred as every text on screen is (k*ll, f***): star them in its code, unless the person asked for them as written.`;
}
