// Who answers, across Edit (Sphe, Nov 7): Opus builds a script, an edit or an
// idea's first package, every time. Once it's built, its revisions are on the
// model the person picked in the chat's model menu (Opus 5.5 or Sonnet 5.5,
// Opus until they pick), and every chat thinks at the level they picked there
// (medium until they pick). The levels are the person's, one for every chat on
// their computer (the server keeps them in `<home>/models.json`). A project's
// model is its own: every new project opens on Opus 5.5, V1 and V2 alike,
// whatever was picked in another (Sphe, Nov 16: "Opus is for most things"),
// and a pick in it holds for it (`projects`). Scripts and ideas keep one pick
// for all (`revision`). Thumbnails stay on Opus. An Edit V2 chat offers every
// model at any time (Fable 5.2 among them) and thinks at its own level (high
// until they pick). The chats show the name of whichever answers next.

export interface ClaudeModel {
  /** What Claude Code is asked for. */
  id: string;
  /** What the chat shows. */
  name: string;
}

export const OPUS: ClaudeModel = { id: "claude-opus-5-5", name: "Opus 5.5" };
export const SONNET: ClaudeModel = { id: "claude-sonnet-5-5", name: "Sonnet 5.5" };
/** Edit V2's: it writes the graphics as code, which is what Fable did best in the session that proved the idea (Sphe, Nov 11: "for edit v2, let us use fable 5.2 high"). */
export const FABLE: ClaudeModel = { id: "claude-fable-5-2", name: "Fable 5.2" };

/** Every build. */
export const BUILD_MODEL = OPUS;
/** What a revision can be asked of, in the menu's order. */
export const REVISION_MODELS: readonly ClaudeModel[] = [OPUS, SONNET];

/** The thinking levels the menu offers, in order. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
/** Edit's own level: its work is mostly the house style applied again and again, which medium does as well as high in far less time. */
export const DEFAULT_EFFORT: Effort = "medium";

/** An Edit V2 project's turns until the person picks: Opus 5.5 (Sphe, Nov 16; Fable 5.2 until then), thinking high. */
export const HQ_MODEL = OPUS;
export const HQ_EFFORT: Effort = "high";
/** What an Edit V2 chat can be asked of at any time, build or revision, in the menu's order (Sphe, Nov 11: "allow us to switch models at any time in edit v2"). */
export const HQ_MODELS: readonly ClaudeModel[] = [FABLE, OPUS, SONNET];

/** The person's choice in the model menu. */
export interface ModelChoice {
  /** Scripts' and ideas' revisions' model id (one of `REVISION_MODELS`). */
  revision: string;
  effort: Effort;
  /** Edit V2's own thinking level, apart from the other chats'. */
  hq_effort: Effort;
  /** Each project's own pick (project id → model id), oldest first; a project with none is on Opus 5.5. */
  projects: Record<string, string>;
}

/** How many projects' picks are kept (the oldest go first). */
export const PROJECT_PICKS = 500;

export const DEFAULT_CHOICE: ModelChoice = { revision: OPUS.id, effort: DEFAULT_EFFORT, hq_effort: HQ_EFFORT, projects: {} };

/** A saved or sent choice, anything unknown in it taken as the default. */
export function readChoice(value: unknown): ModelChoice {
  const given = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const revision = REVISION_MODELS.find((model) => model.id === given.revision)?.id ?? DEFAULT_CHOICE.revision;
  const effort = EFFORTS.find((level) => level === given.effort) ?? DEFAULT_CHOICE.effort;
  const hq_effort = EFFORTS.find((level) => level === given.hq_effort) ?? DEFAULT_CHOICE.hq_effort;
  const picks = typeof given.projects === "object" && given.projects !== null && !Array.isArray(given.projects) ? Object.entries(given.projects as Record<string, unknown>) : [];
  const projects = Object.fromEntries(picks.filter((pick): pick is [string, string] => HQ_MODELS.some((model) => model.id === pick[1])).slice(-PROJECT_PICKS));
  return { revision, effort, hq_effort, projects };
}

/** `choice` with `project`'s pick set to `model` (the newest kept), or taken back to Opus 5.5 when it isn't a model. */
export function withProjectPick(choice: ModelChoice, project: string, model: string): ModelChoice {
  const { [project]: _was, ...rest } = choice.projects;
  return readChoice({ ...choice, projects: HQ_MODELS.some((one) => one.id === model) ? { ...rest, [project]: model } : rest });
}

/**
 * The model `project`'s chat runs on once it's built (an Edit V2 one's at any
 * time, of `HQ_MODELS`; else of `REVISION_MODELS`): its own pick, Opus 5.5
 * until it has one.
 */
export function projectModel(choice: ModelChoice, project: string, hq: boolean): ClaudeModel {
  const pick = choice.projects[project];
  return (hq ? HQ_MODELS : REVISION_MODELS).find((model) => model.id === pick) ?? (hq ? HQ_MODEL : OPUS);
}

/** The model a revision runs on. */
export const revisionModel = (choice: ModelChoice): ClaudeModel => REVISION_MODELS.find((model) => model.id === choice.revision) ?? OPUS;

/** A model id's name as the chat shows it ("Sonnet 5.5"); Claude Code's own `opus` is Opus's. */
export const nameOf = (id: string): string => (id === FABLE.id ? FABLE.name : REVISION_MODELS.find((model) => model.id === id)?.name ?? (/sonnet/u.test(id) ? SONNET.name : OPUS.name));

/** A thinking level as the menu shows it ("Medium", "Extra high"). */
export const effortName = (effort: Effort): string => (effort === "xhigh" ? "Extra high" : effort[0]!.toUpperCase() + effort.slice(1));

/** Opus to build it, the person's pick once it's built. */
export const modelFor = (built: boolean, choice: ModelChoice): ClaudeModel => (built ? revisionModel(choice) : BUILD_MODEL);

/** An idea is built once it has its titles. */
export const ideaBuilt = (idea: { titles: readonly unknown[] }): boolean => idea.titles.length > 0;

/** A script is built once it has its cut-ins (the server refuses a revision before then). */
export const scriptBuilt = (script: { clips: readonly { kind?: string }[] } | null): boolean => script !== null && script.clips.some((clip) => clip.kind === "cut-in");
