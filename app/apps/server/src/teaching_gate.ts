// What a channel taught nothing yet holds back (Sphe, Nov 16: "if we haven't
// taught the agents anything, it's not going to start working on anything"):
// its import's first message, which waits (first_prompt.ts) and goes by itself
// once the channel's edit lane, or its group's, has something in the library
// (a lesson or skill, an effect, a sound; the global skill is Edit's own
// workings, not a style). The agent's tools are never refused for it (Sphe,
// Nov 22: "untaught channels should have that ability… play around with
// effects and what not in an empty project, add footage later and then be
// able to tell the agent, alright we need to teach this"): a person can build
// with it there, and its instructions say plainly that nothing is taught
// (agent.ts UNTAUGHT). Never inferred from a cloud read that failed or hasn't
// come yet (`teachingKnown`), so a channel is never wedged by a slow read. V1
// projects and V2 ones without a channel never wait.

import * as channels from "./channels.ts";
import * as v2cloud from "./v2_cloud.ts";

/** What's read of a project: whether it's Edit V2's, and its channel. */
type Of = { hq?: boolean | null; channel?: string | null };

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
