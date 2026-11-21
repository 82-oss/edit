// The agent's tools for a channel's add-ons (addons.ts; Sphe, Nov 21: "Edit V2
// is meant to give the agent as much control, and the user using it even more
// control through the agent"). The person never flips a switch: they tell the
// agent ("make every video here a Short", "mute these words too"), and it sets
// the add-on with `set_addon`, kept like a lesson (its group's by default, the
// channel's alone when asked) and by whoever may teach the channel. `addons`
// reads what this channel could have and what it has, for anyone.
//
// A channel's script add-ons too (`court-script`, `essay-script`: what a New
// script there is): they're how the channel is set up, not what its Script
// lane was taught, so the edit's chat sets them like the rest (until Nov 21
// evening they were refused here and nothing in the app could set one).
//
// Settings merge (Nov 21): each one given is set, the others stay as they
// were (as teach_removal's parts do), and one given as null goes back to its
// default. Replacing would have lost the words a channel was given each time
// the agent changed its list, and the agent can't see what it would be losing.
//
// What the answer says about when it starts follows the add-on's trigger
// (addons.ts `Trigger`), and a tool it gives is listed from the agent's next
// turn: each turn is a new connection that lists the tools again (agent.ts,
// `mcpServers` per turn; the server says `listChanged: false`, so nothing is
// pushed mid-turn). Built so an end-of-turn add-on can later run in the
// background and wake the agent itself (docs/v1-to-v2.md, "Add-ons"): these
// tools only keep the item, and nothing here runs or waits on one.

import * as addons from "./addons.ts";
import type { App } from "./app.ts";
import * as channels from "./channels.ts";
import { handlerFor, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import * as v2cloud from "./v2_cloud.ts";

/** Whether an add-on is for the channel's scripts, not its edits. */
const forScripts = (name: addons.Name): boolean => addons.CATALOGUE[name].lane === "script";

/** When each one runs, as the agent reads it. */
const WHEN: Record<addons.Trigger, string> = {
  made: "when a project is made in this channel",
  import: "when footage is imported",
  change: "after each change you make, in that change's answer",
  "turn-end": "when your turn ends",
  tool: "inside your tools",
};

/** When one runs, and the tools it gives. */
export function whenOf(name: addons.Name): string {
  const own = addons.CATALOGUE[name];
  const when = own.lane === "script" && own.trigger === "made" ? "when a script is made in this channel" : WHEN[own.trigger];
  return `${when}${own.tools === undefined ? "" : `; gives you ${own.tools.join(", ")}`}`;
}

/** Its settings as said: "list horror; words gizmo, widget". */
export function settingsText(settings: Record<string, unknown>): string {
  return Object.entries(settings)
    .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(", ") || "none" : String(value)}`)
    .join("; ");
}

/** What frame an add-on holds on, on a channel that makes Shorts (addons.ts `holding`). */
const frameWords = (name: addons.Name): string => (addons.CATALOGUE[name].form === "short" ? "Shorts" : addons.CATALOGUE[name].form === "long" ? "long videos" : "every frame");

/** The project's channel, or the refusal that says why it has no add-ons. */
function channelHere(app: App, projectId: string): { channel: string; project: addons.Of } {
  const project = app.store.get(projectId)?.project;
  if (project?.hq !== true) throw new Error("Add-ons are a channel's, in Edit V2: this project isn't an Edit V2 one.");
  if (typeof project.channel !== "string" || project.channel === "") {
    throw new Error("This project isn't a channel's, so it has no add-ons: they're set on a channel. Say so to the person: an edit made for a channel (New edit, Channel) has them.");
  }
  return { channel: project.channel, project };
}

/** A name the agent gave, or the refusal naming the ones there are. */
function nameOf(given: unknown): addons.Name {
  const names = addons.NAMES.join(", ");
  if (typeof given !== "string" || given.trim() === "") throw new Error(`name is required: one of ${names}`);
  const name = given.trim() as addons.Name;
  if (!(name in addons.CATALOGUE)) throw new Error(`Edit has no add-on called ${given}. The ones there are: ${names}.`);
  return name;
}

/** Where an add-on stands here, in a few words. */
function whereFrom(one: addons.Effective, grouped: boolean): string {
  if (one.from === "default") return "Edit's default for this channel";
  if (one.from === "group") return "set for the group";
  return grouped ? "set for this channel only" : "set for this channel";
}

/** The channels and the library read again when they're old (a group joined, an add-on set by another teacher since). */
async function fresh(): Promise<void> {
  await Promise.all([v2cloud.refreshSkills(), channels.refresh()]);
}

/** `addons`: every add-on this channel could have (its edits' first, then its scripts'), on or off, where that comes from, and its settings. */
async function list({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const { channel, project } = channelHere(app, projectId);
  await fresh();
  const grouped = channels.groupOf(channel) !== null;
  const only = args.name === undefined || args.name === null || args.name === "" ? null : nameOf(args.name);
  const all = [...addons.ofChannel(channel, "edit"), ...addons.ofChannel(channel, "script")].filter((one) => only === null || one.name === only);
  const lines = all.map((one) => {
    const own = addons.CATALOGUE[one.name];
    const takes = Object.entries(own.settings).map(([key, setting]) => `${key}: ${setting.words}`);
    // A script's add-on says nothing of this edit: only an edit's can differ on it (its frame, the kind it was made as).
    const differs = !forScripts(one.name) && addons.has(project, one.name) !== one.on;
    return (
      `- ${one.name} (${own.title}${forScripts(one.name) ? ", for this channel's scripts" : ""}): ${own.description} Runs ${whenOf(one.name)}. ` +
      `${one.on ? "On" : "Off"} here (${whereFrom(one, grouped)})` +
      (Object.keys(one.settings).length > 0 ? `, with ${settingsText(one.settings)}` : "") +
      "." +
      (takes.length > 0 ? ` Takes ${takes.join("; ")}.` : "") +
      (differs ? ` This project ${one.on ? `doesn't run it: it's for ${frameWords(one.name)}` : "runs it all the same: it was made with another kind of video's add-ons, and keeps them"}.` : "")
    );
  });
  const unread = !v2cloud.enabled() || !v2cloud.teachingKnown() ? "\nWhat's set on this channel couldn't be read yet, so this is Edit's defaults: ask again in a moment." : "";
  return text(`This channel's add-ons, Edit's own code that runs by itself (set_addon switches one on or off, with its settings, when the person asks):\n${lines.join("\n")}${unread}`);
}

/** A teacher's tool: refused, in words, to anyone else (as remember is, effect_tools.ts). */
function teacherOnly(): void {
  if (!v2cloud.enabled()) throw new Error("V2's cloud needs this computer signed in to Edit: nothing is kept or shared signed out");
  if (!v2cloud.teacher()) throw new Error("Setting a channel's add-ons is a teacher's to do (agent.teach; admins have it): this computer's account isn't one. Say so to the person: an admin can make them a teacher at accounts.spheceo.com.");
  // Not read yet, an add-on set now could replace one the team set, unseen (as remember, Nov 16 audit).
  if (!v2cloud.teachingKnown()) throw new Error("What's set on this channel couldn't be read from Edit's cloud yet, so nothing is set now. Say so to the person, and set it in a moment, once it reads.");
}

/** What the answer says about when it starts. */
function startsLine(name: addons.Name, on: boolean): string {
  if (!on) return "It stops from the next time it would have run.";
  const own = addons.CATALOGUE[name];
  const tools = own.tools === undefined ? "" : ` ${own.tools.join(" and ")} ${own.tools.length > 1 ? "are" : "is"} in your tools from your next turn (each turn lists them again), not this one.`;
  switch (own.trigger) {
    case "made":
      return own.lane === "script"
        ? "It shapes every script made in this channel from now on; scripts already made stay what they are."
        : `It shapes every project made in this channel from now on; projects already made keep their frame.${tools}`;
    case "import":
      return `It runs from the next import of footage here.${tools}`;
    case "change":
      return `It runs from your next change: what it finds is in that change's answer.${tools}`;
    case "turn-end":
      return `It runs from the end of this turn.${tools}`;
    case "tool":
      return own.tools === undefined ? "It holds inside your tools from your next call." : tools.trim();
  }
}

/**
 * `set_addon`: one add-on switched on or off for the channel, its settings
 * given merged over what's set, kept for the group by default when the
 * channel is in one, for this channel alone when asked (`for`). A teacher's.
 */
async function setAddon({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const { channel, project } = channelHere(app, projectId);
  teacherOnly();
  const name = nameOf(args.name);
  if (typeof args.on !== "boolean") throw new Error("on is true (switch it on here) or false (off here)");
  const on = args.on;
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the person said");
  if (args.settings !== undefined && args.settings !== null && (typeof args.settings !== "object" || Array.isArray(args.settings))) {
    const ok = addons.checked(name, args.settings);
    if ("error" in ok) throw new Error(ok.error);
  }
  await fresh();
  const kept = channels.keptIn(channel, addons.CATALOGUE[name].lane, args.for);
  const skill = addons.skillOf(name);
  const key = v2cloud.ownKey("skill", kept.place, skill);
  // What wins for this channel now (its own, else its group's), and what's at the place it's kept (the version a save must be over).
  const before = addons.itemOf(channel, name);
  const there = v2cloud.addonItems().find((one) => (one.key ?? v2cloud.skillKey(one.name)) === key);
  const thereRead = there === undefined ? null : addons.parse(name, there.text);
  const atPlace = thereRead === null || "error" in thereRead ? null : thereRead;
  // Merged over what's set where it's kept; a channel's own made for the first time starts from its group's, which it ran till now.
  // (Nothing at the place while the group's wins means it's kept for this channel: the group's own place has the group's.)
  const base = atPlace?.settings ?? (before?.from === "group" ? before.settings : {});
  const given = (args.settings ?? {}) as Record<string, unknown>;
  const cleared = Object.keys(given).filter((one) => given[one] === null);
  const set = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== null));
  const takes = Object.keys(addons.CATALOGUE[name].settings);
  const stray = cleared.find((one) => !takes.includes(one));
  if (stray !== undefined) {
    const ok = addons.checked(name, { [stray]: null });
    throw new Error("error" in ok ? ok.error : `${stray} isn't one of its settings`);
  }
  const ownGiven = addons.checked(name, set);
  if ("error" in ownGiven) throw new Error(ownGiven.error);
  const merged = { ...base, ...ownGiven.settings };
  for (const one of cleared) delete merged[one];
  const ok = addons.checked(name, merged);
  if ("error" in ok) throw new Error(ok.error);
  const where = `${kept.words === "" ? "" : ` ${kept.words}`}`;
  if (atPlace !== null && atPlace.on === on && JSON.stringify(atPlace.settings) === JSON.stringify(ok.settings)) {
    return text(`${addons.summary(name, on, ok.settings)} That's already how it's set${where}: nothing changed.`);
  }
  let saved: { n: number };
  try {
    // Over the version read at that place (the one a save must be over), so another teacher's since is refused, not lost.
    saved = await v2cloud.saveSkill(skill, addons.write(name, on, ok.settings), args.reason.trim(), addons.noteOf(name), {
      key,
      ...(there?.latest !== undefined ? { latest: there.latest } : {}),
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Someone else changed")) throw error;
    // saveSkill's own words are a lesson's ("remember it again"): an add-on's are what it is now, and to ask again.
    await v2cloud.refreshSkills();
    const now = addons.itemOf(channel, name);
    throw new Error(`Someone else set ${name} on this channel since this conversation read it, so nothing changed: ${now === null ? "it's at Edit's default now" : addons.summary(name, now.on, now.settings)} Tell the person, and set it again only if they still want theirs.`);
  }
  // Read again now, so this turn's next change, call and end see it (a failed read says so in the log and keeps the old).
  v2cloud.forgetSkills();
  await v2cloud.refreshSkills();
  const now = addons.itemOf(channel, name);
  // Kept for the group while this channel has its own: the channel's still wins here.
  const shadowed = now !== null && now.key !== key && now.from === "channel";
  const holdsHere = forScripts(name) || addons.has(project, name);
  return text(
    `${addons.summary(name, on, ok.settings)} Kept as ${skill} (version ${saved.n})${where}. ${startsLine(name, on)}` +
      (on && !holdsHere && !shadowed && now?.on === true ? ` It doesn't run on this project, though: it's for ${frameWords(name)}, and this one is ${addons.formOf(project) === "long" ? "a long one" : "a Short"}.` : "") +
      (shadowed ? ` This channel's own setting still wins here (${now.on ? "on" : "off"}): set it with for: "channel" to change it for this channel.` : ""),
  );
}

const TOOLS: [string, (call: ToolCall) => Promise<Content[]>][] = [
  ["addons", list],
  ["set_addon", setAddon],
];

/** Registers the add-ons' tools with the MCP server (once; later calls do nothing). */
export function registerAddonTools(): void {
  for (const [name, handler] of TOOLS) {
    if (handlerFor(name)?.handler === handler) continue;
    registerTool(name, handler);
  }
}
