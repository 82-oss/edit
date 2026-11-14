// A channel's agent reaching into another channel (Nov 14; Sphe: "the editing
// agents can then go out of their way to go and find that other effect…
// Other channels' editing styles shouldn't be easily accessible to the agent.
// It has to make the decision to go out and find it"). Its instructions name
// only its own channel; other_channels lists the rest when it asks, shows one
// channel's edit style, and brings a piece of it (or all of it, as a base)
// into this channel's own, a copy to change and rebrand here.

import * as channels from "./channels.ts";
import { handlerFor, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import * as v2cloud from "./v2_cloud.ts";

const KINDS = ["skill", "template", "sound"] as const;
const WORD: Record<(typeof KINDS)[number], string> = { skill: "lesson", template: "effect", sound: "sound" };

/** A channel's edit style: its own lessons, effects and sounds in V2's library. */
async function styleOf(channel: string): Promise<v2cloud.Item[]> {
  const place = v2cloud.laneKey(channel, "edit");
  const all = (await Promise.all(KINDS.map((kind) => v2cloud.list(kind)))).flat();
  return all.filter((item) => v2cloud.ownNicheOf(item.key) === place);
}

/** The channel the words name: its key, its @handle or its title. */
function named(all: channels.Channel[], given: string): channels.Channel {
  const words = given.trim().replace(/^@/, "").toLowerCase();
  const found = all.find((one) => one.key === words || one.handle?.toLowerCase() === words || one.title.toLowerCase() === words) ?? all.find((one) => one.title.toLowerCase().includes(words));
  if (found === undefined) throw new Error(`no channel "${given}": the channels are ${all.map((one) => one.title).join(", ") || "none yet"}`);
  return found;
}

async function otherChannels({ app, args, projectId }: ToolCall): Promise<Content[]> {
  if (!v2cloud.enabled()) throw new Error("Channels need this computer signed in to Edit.");
  const mine = app.store.get(projectId)?.project.channel ?? null;
  if (mine === null || mine === "") throw new Error("This project isn't a channel's: other_channels is for a channel's project.");
  const others = (await channels.list()).filter((one) => one.key !== mine);
  if (typeof args.channel !== "string" || args.channel.trim() === "") {
    if (others.length === 0) return text("There are no other channels.");
    const counts = await Promise.all(others.map(async (one) => (await styleOf(one.key)).length));
    return text(others.map((one, at) => `- ${one.title}${one.handle ? ` (@${one.handle})` : ""}: ${counts[at] === 0 ? "nothing taught yet" : `${counts[at]} lessons, effects and sounds`}${one.lanes.edit ? `. Its edit style: ${one.lanes.edit}` : ""}`).join("\n") + "\nother_channels with channel shows one's; bring copies a piece of it here.");
  }
  const from = named(others, args.channel);
  const style = await styleOf(from.key);
  if (args.bring === undefined) {
    if (style.length === 0) return text(`${from.title}'s edit style has nothing taught yet.`);
    return text(`${from.title}'s edit style${from.lanes.edit ? ` ("${from.lanes.edit}")` : ""}:\n${style.map((one) => `- ${WORD[one.kind as (typeof KINDS)[number]] ?? one.kind} ${one.name}${one.category ? ` [${one.category}]` : ""}: ${one.note ?? ""}`).join("\n")}\nbring: a name, or "all" for the whole style as this channel's base.`);
  }
  if (typeof args.bring !== "string" || args.bring.trim() === "") throw new Error('bring is a name from that channel\'s style, or "all"');
  const wanted = args.bring.trim() === "all" ? style : style.filter((one) => one.name === args.bring);
  if (wanted.length === 0) throw new Error(`${from.title}'s edit style has no ${args.bring}: other_channels with channel lists it`);
  const place = v2cloud.laneKey(mine, "edit");
  const mineNow = new Set((await styleOf(mine)).map((one) => `${one.kind}:${one.name}`));
  const brought: string[] = [];
  const kept: string[] = [];
  for (const item of wanted) {
    // What this channel has of its own already stays: bringing never writes over it.
    if (mineNow.has(`${item.kind}:${item.name}`)) {
      kept.push(item.name);
      continue;
    }
    if (await v2cloud.copyItem(item, v2cloud.ownKey(item.kind as (typeof KINDS)[number], place, item.name), `brought from ${from.title}'s edit style`)) brought.push(`${WORD[item.kind as (typeof KINDS)[number]] ?? item.kind} ${item.name}`);
  }
  v2cloud.forgetSkills();
  return text(
    (brought.length === 0 ? "Nothing new brought." : `Brought into this channel's own edit style, to change here: ${brought.join(", ")}.`) +
      (kept.length > 0 ? ` This channel has its own ${kept.join(", ")} already, kept as they are.` : "") +
      (brought.some((one) => one.startsWith("effect ")) ? " An effect comes into this project with use_from_library." : ""),
  );
}

/** Registers the tool with the MCP server (once). */
export function registerChannelTools(): void {
  if (handlerFor("other_channels")?.handler === otherChannels) return;
  registerTool("other_channels", otherChannels);
}
