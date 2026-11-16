// The person's pick in the chats' model menu (`@edit/types/models`), kept in
// `<home>/models.json`: how hard every chat thinks (medium until they pick;
// an Edit V2 chat at its own level, high until they pick), the model a
// script's or idea's revisions run on (Opus 5.5 until they pick), and each
// project's own model (`projects`): a new project opens on Opus 5.5 whatever
// another was on (Sphe, Nov 16), and a pick in it holds for it.

import * as fs from "node:fs";

import { DEFAULT_CHOICE, readChoice, withProjectPick, type ModelChoice } from "@edit/types/models";

import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

const FILE = "models.json";

let home: string | null = null;
let choice: ModelChoice | null = null;

/** Where the choice is kept (Edit's data folder); the default until it's given. */
export function use(dir: string): void {
  if (home === dir) return;
  home = dir;
  choice = null;
}

/** The current pick: what was saved, the default where nothing (or nothing readable) was. */
export function current(): ModelChoice {
  if (home === null) return DEFAULT_CHOICE;
  if (choice === null) {
    try {
      choice = readChoice(JSON.parse(fs.readFileSync(join(home, FILE), "utf8")));
    } catch {
      choice = DEFAULT_CHOICE;
    }
  }
  return choice;
}

/** Saves a pick; anything unknown in it is taken as the default. */
export function save(given: unknown): ModelChoice {
  const next = readChoice(given);
  if (home !== null) {
    fs.mkdirSync(home, { recursive: true });
    writeAtomic(join(home, FILE), `${JSON.stringify(next)}\n`);
  }
  choice = next;
  return next;
}

/** Saves `project`'s own model pick (one of `HQ_MODELS`; anything else takes it back to Opus 5.5). */
export function pickFor(project: string, model: string): ModelChoice {
  return save(withProjectPick(current(), project, model));
}
