// A channel's script styles (Sphe, Nov 24: JJ asked whether he could "put in
// a Dr Insanity script for it to understand the writing style"; Sphe: "paste
// in a video and then have the agents sort of pick up the style", and, as
// with effects on the edit's side, many styles in one channel, a script
// written in the one it's told to use, and a default the first build reaches
// for). A style is a lesson of the channel's Script lane named
// `style-<name>`, learned from references (writer/style_learn.ts): its guide,
// then the references themselves as examples. A script names its style
// (`Script.style`); one that names none is written in the channel's default
// (`style-default`, whose text is a style's name), and the other styles stay
// out of its instructions. Pure: lanes.ts reads the lessons and says them.

import type { Skill } from "./v2_cloud.ts";

export const PREFIX = "style-";
/** The lesson that names the channel's default style (its text is the style's name). */
export const DEFAULT = "style-default";
/** How long a style may be: its guide and its examples (newest first; older ones give way). */
export const MOST = 90_000;
/** How long its guide may be. */
export const GUIDE_MOST = 9_000;
const EXAMPLE_HEAD = "\n\n## Example: ";

export interface Style {
  /** Its lesson's name, `style-<slug>`. */
  name: string;
  title: string;
  guide: string;
  /** Its references, each "<what it is>\n<the script>", newest first. */
  examples: string[];
}

export const isStyle = (name: string): boolean => name.startsWith(PREFIX);

/** A style's lesson name from what someone calls it ("Dr Insanity" → style-dr-insanity). */
export function nameFor(said: string): string {
  const slug = said
    .trim()
    .toLowerCase()
    .replace(/^style-/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 50)
    .replace(/-+$/gu, "");
  return slug === "" || slug === "default" ? "" : `${PREFIX}${slug}`;
}

/** A style lesson as it's kept: "# Title", its guide, then "## Example: …" for each reference. */
export function parse(skill: Pick<Skill, "name" | "text">): Style {
  const text = skill.text.trim();
  const [head, ...rest] = text.split(EXAMPLE_HEAD);
  const lines = head!.split("\n");
  const titled = /^#\s+(.+)$/u.exec(lines[0] ?? "");
  const title = titled ? titled[1]!.trim() : skill.name.slice(PREFIX.length).replace(/-/gu, " ");
  return { name: skill.name, title, guide: (titled ? lines.slice(1) : lines).join("\n").trim(), examples: rest.map((one) => one.trim()).filter((one) => one !== "") };
}

/** A style's text: its guide whole, then as many examples as fit (newest first), each cut to fit only when it alone is over. */
export function compose(title: string, guide: string, examples: readonly string[], most = MOST): string {
  let text = `# ${title.trim()}\n\n${guide.trim()}`;
  for (const example of examples) {
    const room = most - text.length - EXAMPLE_HEAD.length;
    if (room < 2_000) break;
    const whole = example.trim();
    text += EXAMPLE_HEAD + (whole.length <= room ? whole : `${whole.slice(0, room - 40).replace(/\s+\S*$/u, "")}\n… (the rest left out for room)`);
  }
  return text;
}

/** The styles among a lane's lessons. */
export const stylesIn = (lessons: readonly Pick<Skill, "name" | "text">[]): Style[] => lessons.filter((one) => isStyle(one.name) && one.name !== DEFAULT).map(parse);

/**
 * The channel's default style's name, or null: the one `style-default` names,
 * else its only style when nothing else of its scripts is taught (a channel
 * taught by a reference alone is written in it). `beside`: its scripts are
 * taught otherwise too, in words the lessons don't hold (the Script lane's
 * style on the channel's page, or its group's).
 */
export function defaultIn(lessons: readonly Pick<Skill, "name" | "text">[], beside = false): string | null {
  const styles = stylesIn(lessons);
  const named = lessons.find((one) => one.name === DEFAULT)?.text.trim() ?? "";
  if (named !== "" && styles.some((one) => one.name === named)) return named;
  const others = lessons.filter((one) => !isStyle(one.name));
  return styles.length === 1 && others.length === 0 && !beside ? styles[0]!.name : null;
}

/** The style a script is written in: the one it names (by name, or as said), else the channel's default; null for none. */
export function chosen(lessons: readonly Pick<Skill, "name" | "text">[], picked: string | null | undefined, beside = false): Style | null {
  const styles = stylesIn(lessons);
  const asked = typeof picked === "string" && picked.trim() !== "" ? (isStyle(picked) ? picked : nameFor(picked)) : null;
  const found = asked === null ? undefined : styles.find((one) => one.name === asked);
  if (found !== undefined) return found;
  const fallback = defaultIn(lessons, beside);
  return styles.find((one) => one.name === fallback) ?? null;
}

const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();

/** Words just before a style's name that turn it away ("not Documentary", "instead of the old one"). */
const TURNED_AWAY = /\b(not|no|never|without|instead of|rather than|except|than|don t use|dont use|drop|stop using|away from|not the)( the| a| our| that| this| its)?\s*$/u;

/**
 * The style a note asks for by its title or name ("…in the Dr Insanity style"), or null: a style named only to be
 * turned away ("Classic, not Documentary") isn't asked for, and two asked for at once is none (the saved one stays).
 */
export function namedIn(lessons: readonly Pick<Skill, "name" | "text">[], note: string): Style | null {
  const said = ` ${plain(note)} `;
  const asked = (words: string): boolean => {
    if (words.length < 3) return false;
    let from = 0;
    for (let at = said.indexOf(` ${words} `, from); at >= 0; at = said.indexOf(` ${words} `, from)) {
      if (!TURNED_AWAY.test(said.slice(Math.max(0, at - 24), at + 1).trimEnd())) return true;
      from = at + 1;
    }
    return false;
  };
  const hits = stylesIn(lessons).filter((one) => [plain(one.title), plain(one.name.slice(PREFIX.length))].some(asked));
  // One style's name inside another's ("Dry" in "Dry Wit") is that one, not two.
  const distinct = hits.filter((one) => !hits.some((other) => other !== one && plain(other.title).includes(plain(one.title))));
  return distinct.length === 1 ? distinct[0]! : null;
}

/** What a script's writer is told of its style, and of the others the channel has. */
export function prompt(style: Style | null, all: readonly Style[], isDefault: boolean): string {
  const others = all.filter((one) => one.name !== style?.name);
  const lines: string[] = [];
  if (style !== null) {
    lines.push(
      `THIS SCRIPT'S STYLE: ${style.title}${isDefault ? " (the channel's default)" : ""}. Write it in this style: how the narration sounds, how it opens, how the story is laid out, and how narration and footage take turns, at the pacing measured below. Where it differs from the lessons above, the style wins for this script; the lessons still hold where it says nothing. ` +
        "Its examples are other videos rebuilt as scripts: they show the voice and the shape, never this case's facts, and they're never copied: no sentence of theirs, no catchphrase, no name, no channel line, sponsor read or sign-off of theirs. Write this case in that voice.\n\n" +
        `## ${style.title}: the guide\n${style.guide}` +
        (style.examples.length > 0 ? `\n\n## ${style.title}: its examples\n${style.examples.map((one) => `### ${one}`).join("\n\n")}` : ""),
    );
  }
  if (others.length > 0) lines.push(`The channel's other script styles, not this script's unless the producer asks for one: ${others.map((one) => one.title).join(", ")}.`);
  return lines.join("\n\n");
}
