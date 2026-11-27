// A script's "Reuse" case is a finished video of ours, played as it is: our subtitles, cut-ins and clean footage are
// already in it, so removal and subtitles leave it (project.ts `reusedMedia`). A Reuse link to someone else's upload
// isn't that (Nov 27, three Cuffed & Caught compilations on mandalorian: their last cases linked Midwest Patrol's and
// other channels' own videos, played whole with their logo, none of our subtitles and their text left in, the very
// things Lauana's review of the Boyfriends compilation asked never to see again). Such a block is a source played whole:
// its label says so, and removal and subtitles treat it as any footage.

import type { App } from "./app.ts";
import * as channels from "./channels.ts";
import * as diag from "./diag.ts";
import type { Project } from "./model.ts";
import { reusedLabel, WHOLE_SOURCE_LABEL } from "./project.ts";
import { videoId } from "./youtube.ts";

/** Said on a block taken for a source: whose upload it is. */
export const NOT_OURS_NOTE = "Someone else's video, so treated as a source: ";

/** Who uploaded a YouTube video, by its id: `{ name, handle }`, or null when YouTube didn't say (asked again later). */
export type Uploader = { name: string; handle: string | null };
const uploaders = new Map<string, Uploader>();

/** YouTube's own answer for a public video (oEmbed): its channel's name and @handle. */
export const hooks = {
  async uploader(id: string): Promise<Uploader | null> {
    const answer = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`, { signal: AbortSignal.timeout(15_000) });
    if (!answer.ok) return null;
    const body = (await answer.json()) as { author_name?: unknown; author_url?: unknown };
    if (typeof body.author_name !== "string") return null;
    const handle = typeof body.author_url === "string" ? (/\/@([^/?#]+)/u.exec(body.author_url)?.[1] ?? null) : null;
    return { name: body.author_name, handle };
  },
};

/** Whether `who` is one of the team's channels (by @handle, else by name). */
export function ours(who: Uploader, team: readonly { handle: string | null; title: string }[]): boolean {
  const handle = who.handle?.toLowerCase() ?? null;
  return team.some((channel) => (handle !== null && channel.handle?.toLowerCase() === handle) || channel.title.trim().toLowerCase() === who.name.trim().toLowerCase());
}

/** The Reuse blocks of `project` that link a YouTube video: their index and video id. */
export function reuseLinks(project: Project): { index: number; id: string }[] {
  const out: { index: number; id: string }[] = [];
  for (const [index, block] of (project.script?.blocks ?? []).entries()) {
    if (block.kind !== "footage" || !reusedLabel(block.label)) continue;
    const id = typeof block.url === "string" ? videoId(block.url) : null;
    if (id !== null) out.push({ index, id });
  }
  return out;
}

/**
 * Takes `id`'s Reuse blocks that link someone else's upload for sources played whole. Nothing changes when YouTube
 * can't be asked or the team's channels aren't known yet (asked again at the next plan). Returns how many changed.
 */
export async function check(app: App, id: string): Promise<number> {
  const live = app.store.get(id);
  if (live === null) return 0;
  const links = reuseLinks(live.project);
  if (links.length === 0) return 0;
  const team = channels.knownChannels();
  if (team.length === 0) return 0;
  const theirs = new Map<number, Uploader>();
  for (const link of links) {
    let who = uploaders.get(link.id) ?? null;
    if (who === null) {
      try {
        who = await hooks.uploader(link.id);
      } catch (error) {
        diag.info("removal", `${id}: who uploaded ${link.id} couldn't be asked (${diag.messageOf(error)}); asked again later`);
      }
      if (who !== null) uploaders.set(link.id, who);
    }
    if (who !== null && !ours(who, team)) theirs.set(link.index, who);
  }
  if (theirs.size === 0) return 0;
  const [, changed] = await app.store.update(id, "removal", (project) => {
    let count = 0;
    for (const [index, who] of theirs) {
      const block = project.script?.blocks[index];
      if (block === undefined || block.kind !== "footage" || !reusedLabel(block.label)) continue;
      block.label = WHOLE_SOURCE_LABEL;
      block.notes = [...(block.notes ?? []), `${NOT_OURS_NOTE}${who.name}${who.handle === null ? "" : ` (@${who.handle})`}`];
      count++;
    }
    return count;
  });
  if (changed > 0) diag.info("removal", `${id}: ${changed} Reuse link(s) are someone else's uploads (${[...new Set([...theirs.values()].map((who) => who.name))].join(", ")}): taken as sources, so their text and logos come out and our subtitles go on`);
  return changed;
}
