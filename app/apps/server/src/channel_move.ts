// Today's kind of edit (V1) made a channel's Edit V2 project (Sphe, Nov 21:
// "Let's build the converter (which is used when edit v2 is turned on) we
// still want to keep it under a beta toggle"). The two are the same kind of
// file, played and exported by the same engine, which never reads `hq` or
// `channel`; what makes a project V2 is those two fields. So the move sets
// them (and `removal_held`, below) in one revision and touches nothing else (Store.relabel: not a clip,
// track, medium, setting, script link, person, nor its style, so code that
// runs for its kind still runs for it), and its video stays the same frame for
// frame. Asked from Home's ⋯ with Edit V2 on here, through the route that
// moves a V2 project between channels (channels.ts, POST
// /api/channels/{key}/projects/{id}), which checks the switch, the channel
// and that it's this person's before this runs.
//
// What the move sees to, beyond the two fields:
//   - nothing runs for the edit (an agent turn, an import, an export, a share,
//     anything the job table holds for it): refused, saying what to wait for;
//   - another computer holding it in the cloud refuses the save, in its words;
//   - its agent's next turn is a new conversation (agent.ts
//     `newConversation`): the one it had names tools V2 hasn't and was given
//     V1's instructions; the chat stays readable;
//   - the channel's removal of another channel's text and watermarks doesn't
//     start by itself on it (`Project.removal_held`, read by removal_asks.ts
//     as the chat's Stop is): it would change the picture before anyone
//     asked; the agent's start_removal still runs what the person asks for.
//     Kept in the project, so it holds on every computer that opens it (until
//     Nov 21 evening it was a file on the computer that made the move);
//   - recorded as the person's change (changes.ts), which undo_changes never
//     takes back (it isn't an edit: Home moves a project).
// The passes after a V2 turn (both ears, house words) run only once a turn
// ends, so after the person's first message, as on any channel project.

import type { App } from "./app.ts";
import * as busy from "./busy.ts";
import * as diag from "./diag.ts";
import { ApiError } from "./http/errors.ts";
import { agentPanel } from "./seams.ts";
import { refusalOf } from "./store.ts";

/** The person's change, as changes.ts reads an origin ("ui-…": the person), from no page (every open one takes it). */
export const ORIGIN = "ui-home";

/** Project `id`, today's kind of edit, made `channel`'s Edit V2 project; refused in words that say what to do. */
export async function convert(app: App, id: string, channel: { key: string; title: string }): Promise<{ id: string; channel: string; hq: true; rev: number }> {
  const before = app.store.get(id);
  if (before === null) throw new ApiError(404, "This edit isn't on this computer: open it here once, then move it.");
  if (before.project.hq === true) throw new ApiError(400, "It's an Edit V2 project already.");
  // Theirs after the move as before it: the channel's (tokenCarries, asked by the route) and its kind of video.
  const refused = refusalOf(before.project, { ...before.project, channel: channel.key } as typeof before.project);
  if (refused !== null) throw new ApiError(403, refused);
  // The cloud's lock first (taking a newer version from the cloud as it does), so what's checked below is what's moved.
  try {
    await app.store.mayWrite(id);
  } catch (error) {
    throw new ApiError(409, diag.messageOf(error));
  }
  const running = busy.workFor(app, id);
  if (running.length > 0) throw new ApiError(409, `${capital(listed(running))} ${running.length === 1 ? "is" : "are"} under way on this edit: move it once ${running.length === 1 ? "it's" : "they're"} done.`);
  // Its removal is held in the same save that makes it the channel's: that save's event starts the removal's look
  // 2 s later (removal_schedule.ts `start`), which reads the project.
  let live;
  try {
    live = await app.store.relabel(id, ORIGIN, { hq: true, channel: channel.key, removal_held: true });
  } catch (error) {
    throw new ApiError(409, diag.messageOf(error));
  }
  try {
    agentPanel(app).newConversation?.(id);
  } catch (error) {
    // Moved all the same; the next turn would resume the old conversation, so it's said.
    diag.warn("channels", `${id}: a new conversation after the move: ${diag.messageOf(error)}`);
  }
  diag.info("channels", `${live.project.name} (a ${live.project.style} edit) moved onto ${channel.title}: its Edit V2 project now, at rev ${live.rev}`);
  return { id, channel: channel.key, hq: true, rev: live.rev };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
