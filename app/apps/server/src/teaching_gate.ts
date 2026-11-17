// A channel's agents don't edit until the channel is taught (Sphe, Nov 16:
// "Even if we import a bunch of footage, if we haven't taught the agents
// anything, it's not going to start working on anything. It only starts
// working on stuff once we have taught it things"). Taught: the V2 project's
// channel's edit lane, or its group's, has something in the library (a lesson
// or skill, an effect, a sound; the global skill is Edit's own workings, not
// a style). Until then the import still runs whole, the first message waits
// (first_prompt.ts), and the agent's tools that change the edit refuse in a
// line; teaching, reading and research go on. Never inferred from a cloud read
// that failed or hasn't come yet (`teachingKnown`), so a channel is never
// wedged by a slow read. V1 projects and V2 ones without a channel never wait.

import * as channels from "./channels.ts";
import * as v2cloud from "./v2_cloud.ts";

/** What's read of a project: whether it's Edit V2's, and its channel. */
type Of = { hq?: boolean | null; channel?: string | null };

/**
 * What the agent may do while its channel is untaught: teach (keep what the
 * person says, bring another channel's style in), read the edit, its footage
 * and the library, and research the case (it never touches the timeline).
 */
export const WHILE_UNTAUGHT: ReadonlySet<string> = new Set([
  // Teaching.
  "remember",
  "teach_removal",
  "save_to_library",
  "archive_in_library",
  "other_channels",
  "read_skill",
  "library",
  "effect_versions",
  "look_at_effect",
  // Reading the edit and its footage.
  "list_projects",
  "get_edit_context",
  "get_project",
  "review_edit",
  "edit_history",
  "recover_project",
  "look_at_media",
  "find_in_footage",
  "find_camera_time",
  "media_transcript",
  "read_transcript",
  "transcribe",
  "watch_footage",
  "render_frame",
  "contact_sheet",
  "review_motion",
  "check_shots",
  "measure_audio",
  "listen",
  "list_library",
  "read_upload",
  "read_review",
  "pull_feedback",
  // Research (the import's own message asks for it: "Don't change the timeline").
  "search_web",
  "read_page",
  "add_article",
  "case_articles",
  "collect_images",
  "look_at_found",
  "reject_found",
  "search_broll",
  "read_broll_source",
  "record_broll_observations",
  // The chat itself: each of a batch's calls is gated on its own.
  "batch",
  "wait",
  "new_chat",
  "report_problem",
]);

/** The line a refused tool answers with. */
export const REFUSAL =
  "This channel isn't taught yet, so nothing in the edit changes until it is: teach it first (how its videos should look, kept with remember, or an effect or a sound kept with save_to_library), or bring another channel's style in with other_channels.";

/** Whether `project` waits for its channel to be taught, as last read (never from a read that failed or hasn't come). */
export function waiting(project: Of): boolean {
  if (project.hq !== true) return false;
  const places = channels.placesOfProject(project);
  if (places === null || !v2cloud.enabled() || !v2cloud.teachingKnown()) return false;
  return !v2cloud.taughtAnything(places);
}

/**
 * `waiting`, read first when nothing has been read yet (Edit just started) or
 * what was may be old (a lesson just kept is seen at once). A read that fails
 * leaves it not waiting: unknown is never untaught.
 */
export async function stillWaiting(project: Of): Promise<boolean> {
  if (project.hq !== true || channels.placesOfProject(project) === null || !v2cloud.enabled()) return false;
  if (!v2cloud.teachingKnown() || waiting(project)) await v2cloud.refreshSkills();
  return waiting(project);
}

/** Why tool `name` is refused on `project` (REFUSAL), or null when it may run. */
export async function refusal(project: Of, name: string): Promise<string | null> {
  if (WHILE_UNTAUGHT.has(name)) return null;
  return (await stillWaiting(project)) ? REFUSAL : null;
}
