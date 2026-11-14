// A thumbnail's graphics as code (Nov 14; Sphe: "the graphics should be
// written in code… instead of having an overlay be an image that we upload,
// it can be something that we teach, so I can send a picture… and then ask
// the agents to just completely recreate it"). The agent writes a graphic in
// HTML and CSS (a stamp, an arrow, a frame, a REC overlay, a recreated
// overlay the person sent); render.ts draws it on nothing, and it becomes one
// of the thumbnail's pictures, placed by an image layer like any other, so
// the editor, the grades and the layers stay as they are. Its code is kept
// beside it to change later. A graphic the person likes is taught: kept in
// V2's library under the channel's Thumbnails lane (the house's place,
// `thumbnails`, for a thumbnail of no channel), as an effect is, and any of
// that lane's thumbnails uses it again; another channel's comes in only
// through other_channels.

import * as fs from "node:fs";

import type { Thumbnail, ThumbImage } from "@edit/types/thumbnails";

import * as lanes from "../lanes.ts";
import { join } from "../paths.ts";
import * as v2cloud from "../v2_cloud.ts";
import * as cloud from "./cloud.ts";
import * as render from "./render.ts";

type Args = Record<string, unknown>;

/** What a graphic's tool needs of the turn. */
export interface Turn {
  id: string;
  by: string;
  origin: string;
  folder: string;
  place: lanes.Place | null;
}

/** The library's file for a graphic's code, and for its size. */
const CODE = "graphic.html";
const SIZE = "graphic.json";

/** Where a thumbnail's graphics are kept: its channel's Thumbnails lane, else the house's. */
export const placeOf = (place: lanes.Place | null): string => (place === null ? "thumbnails" : v2cloud.laneKey(place.channel, "thumbnails"));

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const newId = () => Math.random().toString(36).slice(2, 10);

export const TOOLS = [
  {
    name: "make_graphic",
    description:
      'Draw a graphic from code: HTML and CSS (script too) at its own size in px, on nothing (what you leave empty stays see-through), added to the thumbnail\'s images. Place it with an image layer (its id as source, fit "stretch" or "contain") like any picture: a stamp, an arrow or a circle on the evidence, a frame, a REC overlay, a split, a badge. The house\'s fonts are there by name ("Montserrat", "Arabic-font-2013", "ITC Avant Garde Gothic"). It\'s drawn once it has loaded and its fonts are in; code that draws later says when with parent.postMessage("ready", "*"). It can\'t reach the network\'s pages or Edit. replaces: a graphic\'s image id, changed: every layer on it takes the new one. Read the file it names.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "What it is, in a few words." },
        code: { type: "string", description: "The graphic: an HTML fragment or page." },
        width: { type: "number", description: `px, up to ${render.GRAPHIC_MOST.width}` },
        height: { type: "number", description: `px, up to ${render.GRAPHIC_MOST.height}` },
        replaces: { type: "string", description: "A graphic's image id: this is its new version." },
      },
      required: ["name", "code", "width", "height"],
    },
  },
  {
    name: "graphic_code",
    description: "A graphic's code, to change it (make_graphic with replaces).",
    inputSchema: { type: "object", additionalProperties: false, properties: { image: { type: "string" } }, required: ["image"] },
  },
  {
    name: "graphics",
    description: "The graphics this channel's thumbnails have been taught (the house's, for a thumbnail of no channel): each with its note on what it is and where it goes. query narrows them.",
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
  },
  {
    name: "use_graphic",
    description: "One of the taught graphics (graphics lists them) drawn into this thumbnail's images, to place with an image layer. Its code comes with it to change here (graphic_code, make_graphic with replaces); changing it here doesn't change what's taught.",
    inputSchema: { type: "object", additionalProperties: false, properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "save_graphic",
    description:
      'Teach a graphic, when the person asks to keep it ("keep this", "save it as an overlay", "use this from now on"): kept for this channel\'s thumbnails (the house\'s, for a thumbnail of no channel), with a note you will read later on what it is and where it goes ("a red stamp: across the suspect\'s chest, tilted"). The same name is its next version. A teacher\'s to do. When the person sends a picture to keep as an overlay, recreate it in code with make_graphic first (compare them close until they match), then teach that.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        image: { type: "string", description: "The graphic's image id." },
        name: { type: "string", description: "Lower-case words joined by hyphens (red-stamp, rec-overlay)." },
        note: { type: "string", description: "What it is and where it goes, a line." },
        category: { type: "string" },
        reason: { type: "string", description: "What the person said, quoted." },
      },
      required: ["image", "name", "note"],
    },
  },
];

export const NAMES = TOOLS.map((one) => one.name);

/** A graphic's code, from the cloud. */
async function codeOf(image: ThumbImage): Promise<string> {
  if (image.graphic === undefined) throw new Error(`${image.id} isn't a graphic: only a graphic made from code has code.`);
  return new TextDecoder().decode(await cloud.bytesOf(image.graphic.code));
}

/** Drawn, both kept (the picture and its code), and added to the thumbnail; layers on the one it replaces take it. */
async function keep(turn: Turn, name: string, code: string, width: number, height: number, from: { replaces?: ThumbImage; library?: { key: string; n: number } }): Promise<{ image: ThumbImage; path: string; moved: number }> {
  const bytes = await render.graphic(turn.origin, code, width, height);
  const [key, codeKey] = await Promise.all([cloud.put(turn.id, bytes, "image/png", "png"), cloud.put(turn.id, new TextEncoder().encode(code), "text/html", "html")]);
  const image: ThumbImage = {
    id: newId(),
    name: name.slice(0, 80),
    key,
    from: "graphic",
    width: Math.round(width),
    height: Math.round(height),
    graphic: { code: codeKey, ...(from.library ? { library: from.library } : {}) },
    at: Date.now(),
    by: turn.by,
  };
  let moved = 0;
  await cloud.change(turn.id, turn.by, (thumb) => {
    thumb.images = [...thumb.images, image].slice(-60);
    if (from.replaces !== undefined) moved = repoint(thumb, from.replaces.id, image.id);
  });
  const path = join(turn.folder, `${image.id}.png`);
  fs.writeFileSync(path, bytes);
  return { image, path, moved };
}

/** Every layer on one picture, in every version, on another: how many. */
export function repoint(thumb: Thumbnail, from: string, to: string): number {
  let moved = 0;
  const designs = [thumb.design, ...(thumb.versions ?? []).map((one) => one.design)];
  for (const design of designs) {
    for (const layer of design.layers) {
      if (layer.kind === "image" && layer.source === from) {
        layer.source = to;
        moved++;
      }
    }
  }
  return moved;
}

function size(value: unknown, what: string, most: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 4 || value > most) throw new Error(`${what} is 4 to ${most} px.`);
  return Math.round(value);
}

/** One of the graphics tools, answered in words. */
export async function call(turn: Turn, thumb: Thumbnail, name: string, args: Args): Promise<string> {
  if (["graphics", "use_graphic", "save_graphic"].includes(name) && !v2cloud.enabled()) throw new Error("Taught graphics need this computer signed in to Edit.");
  const image = (id: unknown): ThumbImage => {
    const found = thumb.images.find((one) => one.id === id);
    if (found === undefined) throw new Error(`There's no image ${String(id)}: give one of the thumbnail's image ids.`);
    return found;
  };
  switch (name) {
    case "make_graphic": {
      if (typeof args.code !== "string" || args.code.trim() === "") throw new Error("code is the graphic's HTML.");
      if (args.code.length > 200_000) throw new Error("A graphic's code is at most 200,000 characters: draw it, don't embed pictures in it.");
      const label = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : "graphic";
      const replaces = args.replaces === undefined ? undefined : image(args.replaces);
      if (replaces !== undefined && replaces.graphic === undefined) throw new Error(`${replaces.id} isn't a graphic: replaces names a graphic's image.`);
      const made = await keep(turn, label, args.code, size(args.width, "width", render.GRAPHIC_MOST.width), size(args.height, "height", render.GRAPHIC_MOST.height), { ...(replaces !== undefined ? { replaces } : {}) });
      return `Drew ${made.image.id} “${made.image.name}” (${made.image.width}×${made.image.height}, see-through where it's empty)${replaces !== undefined ? `: ${made.moved} layer${made.moved === 1 ? "" : "s"} on ${replaces.id} now show it` : ": place it with an image layer"}. Read it: ${made.path}`;
    }
    case "graphic_code":
      return codeOf(image(args.image));
    case "graphics": {
      const place = placeOf(turn.place);
      const words = typeof args.query === "string" ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const all = (await v2cloud.list("template")).filter((one) => v2cloud.ownPlaceOf(one.key) === place);
      const found = all.filter((one) => words.every((word) => `${one.name} ${one.note ?? ""} ${one.category ?? ""}`.toLowerCase().includes(word)));
      if (all.length === 0) return turn.place === null ? "No graphics are taught yet." : "This channel's thumbnails have no graphics taught yet (another channel's, only with other_channels when the person points you at one).";
      if (found.length === 0) return `None match: the graphics are ${all.map((one) => one.name).join(", ")}.`;
      return found.map((one) => `- ${one.name}${one.category ? ` [${one.category}]` : ""}: ${one.note ?? ""}`).join("\n");
    }
    case "use_graphic": {
      const wanted = typeof args.name === "string" ? args.name.trim() : "";
      const key = v2cloud.ownKey("template", placeOf(turn.place), wanted);
      if (!NAME.test(wanted)) throw new Error("name is one the graphics tool lists.");
      const dir = join(turn.folder, `graphic-${wanted}`);
      fs.rmSync(dir, { recursive: true, force: true });
      const version = await v2cloud.fetchInto(key, null, dir);
      if (version === null) throw new Error(`There's no graphic ${wanted}: graphics lists them.`);
      const code = fs.readFileSync(join(dir, CODE), "utf8");
      const kept = JSON.parse(fs.readFileSync(join(dir, SIZE), "utf8")) as { width?: number; height?: number };
      const made = await keep(turn, wanted, code, size(kept.width, "its width", render.GRAPHIC_MOST.width), size(kept.height, "its height", render.GRAPHIC_MOST.height), { library: { key, n: version.n } });
      return `${wanted} (version ${version.n}) is ${made.image.id} here (${made.image.width}×${made.image.height}): place it with an image layer. Read it: ${made.path}`;
    }
    case "save_graphic": {
      if (!v2cloud.teacher()) throw new Error("Teaching a graphic is a teacher's to do (agent.teach; admins have it): this computer's account isn't one. Say so to the person: an admin can make them a teacher at accounts.spheceo.com.");
      const found = image(args.image);
      const wanted = typeof args.name === "string" ? args.name.trim() : "";
      if (!NAME.test(wanted)) throw new Error("name is lower-case letters, digits and hyphens (red-stamp).");
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (note === "" || note.length > 160) throw new Error("note is a line on what it is and where it goes (at most 160 characters).");
      const dir = join(turn.folder, `teach-${wanted}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, CODE), await codeOf(found));
      fs.writeFileSync(join(dir, SIZE), `${JSON.stringify({ width: found.width, height: found.height })}\n`);
      const key = v2cloud.ownKey("template", placeOf(turn.place), wanted);
      const category = typeof args.category === "string" && args.category.trim() !== "" ? args.category.trim().slice(0, 40) : undefined;
      const kept = await v2cloud.save(key, wanted, dir, { note, ...(category ? { category } : {}), ...(typeof args.reason === "string" && args.reason.trim() !== "" ? { reason: args.reason.trim() } : {}) });
      const whose = turn.place === null ? "every thumbnail of no channel" : "this channel's thumbnails";
      return kept.made ? `${wanted} is version ${kept.n} of ${whose}' graphics: use_graphic brings it into any of them.` : `${wanted} is already exactly this (version ${kept.n}).`;
    }
    default:
      throw new Error(`There's no tool called ${name}.`);
  }
}
