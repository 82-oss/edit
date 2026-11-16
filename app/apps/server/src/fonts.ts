// Fonts an effect can use beyond Edit's own faces (Sphe, Nov 12: "have the
// agent research, pull fonts, do the comparisons if needed and be able to
// save the font to our v2 cloud if we want it to do so"; the reference's
// handwriting was narrower than any face Edit has). Two places:
//
// - a project's own: fetch_font brings a Google Fonts family (every one there
//   is open-licensed for video) into `<project>/fonts/<slug>/`, for any of the
//   project's effects to use by name at once;
// - V2's cloud: a teacher keeps one there (save_to_library kind font), and
//   every Edit V2 agent's effects have it by name from then on, a copy
//   kept here (`<cache>/v2-fonts/<name>-v<n>/`).
//
// Each is a folder of its font files and `font.json` (its family and faces).
// The effect page gets their @font-face lines ahead of its code, as it gets
// Edit's own (effects.ts), and their files at `edit-fonts/<slug>/<file>`.

import * as fs from "node:fs";

import * as r2 from "./cloud.ts";
import * as diag from "./diag.ts";
import { join } from "./paths.ts";
import type { Store } from "./store.ts";
import * as v2cloud from "./v2_cloud.ts";

export interface Face {
  weight: number;
  style: "normal" | "italic";
  file: string;
}

export interface Font {
  /** Its folder's name, and its address under edit-fonts/. */
  slug: string;
  family: string;
  faces: Face[];
  /** Where it came from, and its licence. */
  source: string;
  dir: string;
}

const MANIFEST = "font.json";

/** A family's folder name: "Reenie Beanie" → "reenie-beanie". */
export const slugOf = (family: string) =>
  family
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 60);

/** A project's own fonts' folder. */
export function projectDir(store: Store, project: string): string {
  return join(store.uploadsDir(project), "fonts");
}

function read(dir: string, slug: string): Font | null {
  try {
    const given = JSON.parse(fs.readFileSync(join(dir, MANIFEST), "utf8")) as Partial<Font>;
    if (typeof given.family !== "string" || !Array.isArray(given.faces)) return null;
    const faces = given.faces.filter((face): face is Face => typeof face?.file === "string" && fs.existsSync(join(dir, face.file)));
    return faces.length === 0 ? null : { slug, family: given.family, faces, source: typeof given.source === "string" ? given.source : "", dir };
  } catch {
    return null;
  }
}

/** The project's own fonts. */
export function projectFonts(store: Store, project: string): Font[] {
  const root = projectDir(store, project);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.map((name) => read(join(root, name), name)).filter((font): font is Font => font !== null);
}

/** Google Fonts' stylesheet of `family` at `weights` (a plain request answers TTF files). */
const CSS = "https://fonts.googleapis.com/css2";

/** Seams for tests. */
export const net = { fetch: (url: string) => fetch(url, { signal: AbortSignal.timeout(30_000) }) };

/**
 * `family` from Google Fonts into the project's fonts (every weight asked for
 * that it has; the family's own when none of them is), replacing what was
 * there under its name. Answers it as kept.
 */
export async function fetchGoogle(store: Store, project: string, family: string, weights: number[] = []): Promise<Font> {
  const name = family.trim().replace(/\s+/gu, " ");
  if (!/^[A-Za-z0-9 ]{2,60}$/u.test(name)) throw new Error(`"${family}" isn't a Google Fonts family name (letters, digits and spaces: "Reenie Beanie", "Caveat")`);
  const asked = [...new Set(weights.filter((weight) => Number.isInteger(weight) && weight >= 100 && weight <= 900))].sort((a, b) => a - b);
  const query = (withWeights: boolean) => `${CSS}?family=${encodeURIComponent(name).replace(/%20/gu, "+")}${withWeights && asked.length > 0 ? `:wght@${asked.join(";")}` : ""}`;
  let answer = await net.fetch(query(true));
  // A weight the family hasn't: its own instead.
  if (answer.status === 400 && asked.length > 0) answer = await net.fetch(query(false));
  if (answer.status === 400) throw new Error(`Google Fonts has no family "${name}": check its name on fonts.google.com (search_web), spelled as there`);
  if (!answer.ok) throw new Error(`Google Fonts answered ${answer.status} for ${name}`);
  const css = await answer.text();
  const found: { weight: number; style: "normal" | "italic"; url: string }[] = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
    const body = block[1]!;
    const url = /src:\s*url\(([^)]+)\)/u.exec(body)?.[1];
    const weight = Number(/font-weight:\s*(\d+)/u.exec(body)?.[1] ?? "400");
    const style = /font-style:\s*italic/u.test(body) ? "italic" : "normal";
    if (url !== undefined && url.startsWith("https://fonts.gstatic.com/") && !found.some((one) => one.weight === weight && one.style === style)) found.push({ weight, style, url });
  }
  if (found.length === 0) throw new Error(`Google Fonts gave no font files for ${name}`);
  const slug = slugOf(name);
  const dir = join(projectDir(store, project), slug);
  const partial = `${dir}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  const faces: Face[] = [];
  for (const one of found) {
    const got = await net.fetch(one.url);
    if (!got.ok) throw new Error(`Google Fonts' file for ${name} ${one.weight} answered ${got.status}`);
    const extension = /\.(ttf|otf|woff2?)(?:\?|$)/u.exec(one.url)?.[1] ?? "ttf";
    const file = `${name.replace(/ /gu, "")}-${one.weight}${one.style === "italic" ? "i" : ""}.${extension}`;
    fs.writeFileSync(join(partial, file), new Uint8Array(await got.arrayBuffer()));
    faces.push({ weight: one.weight, style: one.style, file });
  }
  const source = "Google Fonts (open licence: free to use in videos)";
  fs.writeFileSync(join(partial, MANIFEST), JSON.stringify({ family: name, faces, source }, null, 1));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(partial, dir);
  // The project's on every computer that opens it, as its effects are.
  sendUp(store, project, slug).catch((error: unknown) => diag.warn("effects", `${project}: the ${name} font didn't go to the cloud: ${diag.messageOf(error)}`));
  return { slug, family: name, faces, source, dir };
}

// ---------------------------------------------------------------- a project's own fonts in the cloud

// A project's own fonts follow it to every computer that opens it, as its
// effects' code does (Nov 16, the M4: Test Motion Graphics' seven fonts were
// only on the Mac that fetched them, so its effect rendered elsewhere in a
// stand-in serif). Each family's folder is kept as it is under the project's
// own place in the cloud, `edit/exports/<project>/fonts/<slug>/`, beside its
// effects' renders (which the renders' sweep, effect_cloud.ts, never touches).

const cloudPrefix = (project: string) => `edit/exports/${project}/fonts/`;
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/u;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** When each project's fonts in the cloud were last looked for. */
const lookedAt = new Map<string, number>();
const LOOK_EVERY_MS = 60_000;

/** Families known to be in the cloud, by project: what this run of Edit listed or sent there. */
const upThere = new Map<string, Set<string>>();

/** A project's own font `slug` (its folder) into the cloud, each file as it is. */
export async function sendUp(store: Store, project: string, slug: string): Promise<void> {
  if (!r2.enabled() || !SLUG.test(slug)) return;
  const dir = join(projectDir(store, project), slug);
  if (read(dir, slug) === null) return;
  for (const file of fs.readdirSync(dir)) {
    if (FILE.test(file) && fs.statSync(join(dir, file)).isFile()) await r2.uploadFile(join(dir, file), `${cloudPrefix(project)}${slug}/${file}`);
  }
  let known = upThere.get(project);
  if (known === undefined) upThere.set(project, (known = new Set()));
  known.add(slug);
}

/** The project's families in the cloud, each with its files' keys. */
async function inCloud(project: string): Promise<Map<string, string[]>> {
  const prefix = cloudPrefix(project);
  const families = new Map<string, string[]>();
  for (const object of await r2.list(prefix)) {
    const [slug, file, ...rest] = object.key.slice(prefix.length).split("/");
    if (slug === undefined || file === undefined || rest.length > 0 || !SLUG.test(slug) || !FILE.test(file)) continue;
    families.set(slug, [...(families.get(slug) ?? []), file]);
  }
  upThere.set(project, new Set(families.keys()));
  return families;
}

/**
 * The project's own fonts in the cloud that this computer hasn't, brought
 * down (each family whole, swapped in at once): the families brought.
 */
export async function bringDownProject(store: Store, project: string): Promise<string[]> {
  if (!r2.enabled()) return [];
  // Asked on every change to a V2 project (effects.ts bringDown): the cloud's list read at most once a minute.
  const at = lookedAt.get(project);
  if (at !== undefined && Date.now() - at < LOOK_EVERY_MS) return [];
  lookedAt.set(project, Date.now());
  const wanted = [...(await inCloud(project))].filter(([slug, files]) => read(join(projectDir(store, project), slug), slug) === null && files.includes(MANIFEST));
  // Every family's files at once, several at a time (one by one, 7 families' 19 files took 14 s on kenobi, Nov 16).
  for (const [slug] of wanted) {
    const partial = `${join(projectDir(store, project), slug)}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });
  }
  const files = wanted.flatMap(([slug, names]) => names.map((file) => ({ slug, file })));
  await v2cloud.eachAtOnce(files, ({ slug, file }) => r2.download(`${cloudPrefix(project)}${slug}/${file}`, join(`${join(projectDir(store, project), slug)}.partial`, file)));
  const brought: string[] = [];
  for (const [slug] of wanted) {
    const dir = join(projectDir(store, project), slug);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(`${dir}.partial`, dir);
    if (read(dir, slug) !== null) brought.push(slug);
  }
  return brought;
}

/** The project's own fonts here that the cloud hasn't (fetched before they were kept there, Nov 16), sent up. */
export async function keepUp(store: Store, project: string): Promise<void> {
  if (!r2.enabled()) return;
  const here = projectFonts(store, project).map((font) => font.slug);
  if (here.length === 0) return;
  const known = upThere.get(project) ?? new Set((await inCloud(project)).keys());
  for (const slug of here) if (!known.has(slug)) await sendUp(store, project, slug);
}

// ---------------------------------------------------------------- V2's cloud's fonts

/** The library's fonts as last read, each with its copy here. */
let cloudFonts: Font[] = [];
let readAt = 0;
let reading: Promise<void> | null = null;
const FRESH_MS = 30_000;

/** The library's fonts, read again when it's been a while (or `now`), each fetched here once. */
export async function refreshCloud(store: Store, now = false): Promise<Font[]> {
  if (!v2cloud.enabled()) return cloudFonts;
  if (!now && Date.now() - readAt < FRESH_MS) return cloudFonts;
  reading ??= (async () => {
    try {
      const items = await v2cloud.list("font");
      const next: Font[] = [];
      for (const item of items) {
        const dir = join(store.cacheDir(), "v2-fonts", `${item.name}-v${item.current}`);
        if (!fs.existsSync(join(dir, MANIFEST))) await v2cloud.fetchInto(v2cloud.fontKey(item.name), item.current, dir);
        const font = read(dir, item.name);
        if (font !== null) next.push(font);
      }
      cloudFonts = next;
    } catch (error) {
      diag.warn("effects", `V2's cloud's fonts weren't read: ${diag.messageOf(error)}`);
    } finally {
      // A refusal too waits the while before it's asked again, not once a page served.
      readAt = Date.now();
      reading = null;
    }
  })();
  await reading;
  return cloudFonts;
}

/** The library's fonts as last read (refreshCloud keeps them fresh). */
export const cloud = () => cloudFonts;

/** Every font an effect of `project` has beyond Edit's own: its own first, then the library's (by family, the project's wins). */
export function fontsFor(store: Store, project: string): Font[] {
  const own = projectFonts(store, project);
  return [...own, ...cloudFonts.filter((font) => !own.some((mine) => mine.family === font.family || mine.slug === font.slug))];
}

/** Their @font-face lines, for the page (files at edit-fonts/<slug>/<file>). */
export function facesOf(fonts: Font[]): string {
  return fonts.flatMap((font) => font.faces.map((face) => `@font-face { font-family: "${font.family}"; font-weight: ${face.weight}; font-style: ${face.style}; src: url(edit-fonts/${font.slug}/${face.file}); }`)).join("\n");
}

/** A font file an effect page asks for at edit-fonts/<slug>/<file>, or null. */
export function fileOf(store: Store, project: string, slug: string, file: string): string | null {
  const font = fontsFor(store, project).find((one) => one.slug === slug);
  const face = font?.faces.find((one) => one.file === file);
  return font === undefined || face === undefined ? null : join(font.dir, face.file);
}

/** What of these fonts a page's code names (by family), for its render's key: a new font re-renders only what uses it. */
export function usedBy(fonts: Font[], code: string): string {
  return fonts
    .filter((font) => code.includes(font.family))
    .map((font) => `${font.family}:${font.faces.map((face) => `${face.file}@${(() => { try { return fs.statSync(join(font.dir, face.file)).size; } catch { return 0; } })()}`).join(",")}`)
    .join(";");
}
