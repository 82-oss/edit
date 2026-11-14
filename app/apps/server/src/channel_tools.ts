// A channel's agent reaching into another channel (Nov 14; Sphe: "the editing
// agents can then go out of their way to go and find that other effect…
// Other channels' editing styles shouldn't be easily accessible to the agent.
// It has to make the decision to go out and find it"). Its instructions name
// only its own channel; other_channels lists the rest when it asks, shows one
// channel's edit style, and brings a piece of it (or all of it, as a base)
// into this channel's own, a copy to change and rebrand here.
// The reach itself is lanes.ts', shared with the other lanes' agents.

import * as lanes from "./lanes.ts";
import { handlerFor, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import * as v2cloud from "./v2_cloud.ts";

async function otherChannels({ app, args, projectId }: ToolCall): Promise<Content[]> {
  if (!v2cloud.enabled()) throw new Error("Channels need this computer signed in to Edit.");
  const mine = app.store.get(projectId)?.project.channel ?? null;
  if (mine === null || mine === "") throw new Error("This project isn't a channel's: other_channels is for a channel's project.");
  const answer = await lanes.otherChannels(mine, "edit", args);
  return text(answer + (/^Brought .*\beffect /.test(answer) ? " An effect comes into this project with use_from_library." : ""));
}

/** Registers the tool with the MCP server (once). */
export function registerChannelTools(): void {
  if (handlerFor("other_channels")?.handler === otherChannels) return;
  registerTool("other_channels", otherChannels);
}
