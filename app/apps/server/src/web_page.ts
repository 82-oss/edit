// A web page or PDF, read: its words, what it says it is, and its pictures.
// Every page Edit reads for research goes through here (read_page, add_article,
// a script's case research, whether a found picture is the case's).
//
// Firecrawl Local (`tools.firecrawl`, AGPL-3.0, run as its own program and
// never linked in) does the reading on this computer: a plain fetch, the
// local Chrome when the page is drawn by script, the page's main content
// kept as markdown, PDFs and Office files parsed. Nothing goes to Firecrawl's
// cloud (FIRECRAWL_CLOUD=off), so a page that refuses this computer says so.
// Measured Nov 18 on bodycam news pages: 0.4-2.8 s where Edit's own reader
// took 1.3-19.5 s, the story in paragraphs instead of one line with the menus.

import { headlessBinary } from "./chrome_devtools.ts";
import * as diag from "./diag.ts";
import { THIS_MACHINE } from "./machine.ts";
import { publicUrl } from "./net_guard.ts";
import * as tools from "./tools.ts";

/** A desktop Chrome's, so sites answer as they do a person. */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export interface WebPage {
  /** Where it ended up, after redirects. */
  url: string;
  title: string;
  /** The site's own name, else its address without www. */
  outlet: string;
  published: string | null;
  /** Its main content as plain lines: headings and paragraphs, no links' or pictures' addresses. */
  text: string;
  /** Its pictures' addresses: the lead (og:image) first, then the ones in its main content. */
  images: string[];
}

/** Firecrawl Local's answer for one page (`scrape`'s JSON). */
export interface Scraped {
  success: boolean;
  code?: string;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: Record<string, unknown>;
    warning?: string;
    blocked?: boolean;
  };
}

/** The way out that tests replace: Firecrawl Local itself. */
export const hooks = {
  scrape: (url: string, local: boolean): Promise<Scraped> => scrape(url, local),
};

/** Pages read in the last few minutes (a case's pictures often share one). */
const KEPT: [url: string, at: number, page: WebPage][] = [];
const FRESH_MS = 600_000;

/** The page at `url` (a public web address only, net_guard.ts), read. */
export async function read(url: string): Promise<WebPage> {
  const checked = await publicUrl(url);
  const now = performance.now();
  const kept = KEPT.find(([own, at]) => own === url && now - at < FRESH_MS);
  if (kept !== undefined) return kept[2];
  const local = checked.hostname === "127.0.0.1" || checked.hostname === "localhost";
  const page = fromScraped(
    url,
    await diag.timeAsync("research", "read a page", async () => {
      const first = await hooks.scrape(url, local);
      // A site's edge sometimes refuses one connection: asked again once (Nov 20: kbtx.com showed another name's
      // certificate on one read in three).
      return first.success || first.code !== "FETCH_FAILED" ? first : hooks.scrape(url, local);
    }),
  );
  for (let index = KEPT.length - 1; index >= 0; index--) {
    const [own, at] = KEPT[index]!;
    if (own === url || now - at >= FRESH_MS) KEPT.splice(index, 1);
  }
  if (KEPT.length >= 24) KEPT.shift();
  KEPT.push([url, now, page]);
  return page;
}

/** Forgets the pages kept (tests). */
export function forget(): void {
  KEPT.length = 0;
}

/** What Firecrawl Local said about `url` as a page, or why it couldn't be read. */
export function fromScraped(url: string, scraped: Scraped): WebPage {
  if (!scraped.success || scraped.data === undefined) throw new Error(failure(scraped));
  const { markdown = "", metadata = {}, warning, blocked } = scraped.data;
  if (blocked === true) throw new Error("the site blocks readers with a bot check; use another source");
  const status = typeof metadata.statusCode === "number" ? metadata.statusCode : 200;
  if (status === 451) throw new Error("the site doesn't serve this country; use another source");
  if (status >= 400) throw new Error(`the site answered ${status}; use another source`);
  const text = plainText(markdown);
  if (text === "") throw new Error(warning !== undefined && warning !== "" ? `nothing to read: ${warning}` : "the page has nothing to read");
  const said = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = first(metadata[key]);
      if (value !== null) return value;
    }
    return null;
  };
  const lead = said("og:image", "ogImage", "twitter:image");
  const images = [...(lead !== null ? [lead] : []), ...pictures(markdown)].filter((image, index, all) => image.startsWith("http") && all.indexOf(image) === index);
  return {
    url: said("url") ?? url,
    title: said("og:title", "ogTitle", "twitter:title", "title") ?? "",
    outlet: said("og:site_name", "ogSiteName", "application-name") ?? hostOf(url),
    published: said("article:published_time", "publishedTime", "datePublished", "pubdate"),
    text,
    images,
  };
}

/** Why a page couldn't be read, in words the agent can act on. */
function failure(scraped: Scraped): string {
  const why = (scraped.error ?? "").split("\n")[0]!.slice(0, 200);
  switch (scraped.code) {
    case "BLOCKED_TARGET":
      return `that address is on ${THIS_MACHINE} or its network, not the web`;
    case "SCRAPE_TIMEOUT":
      return "the page took too long to load";
    case "FETCH_FAILED":
      return `couldn't reach the page (${why})`;
    default:
      return why === "" ? "the page couldn't be read" : why;
  }
}

/** A metadata value as one string (Firecrawl lists a tag that's there twice). */
function first(value: unknown): string | null {
  const one = Array.isArray(value) ? value.find((item) => typeof item === "string" && item.trim() !== "") : value;
  return typeof one === "string" && one.trim() !== "" ? one.trim() : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^(?:www\.)+/u, "");
  } catch {
    return "";
  }
}

/** The pictures' addresses in markdown (`![…](address "title")`). */
export function pictures(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu)].map((match) => match[1]!);
}

/**
 * Markdown as plain lines for an agent: pictures dropped, links kept as their
 * words (an address costs tokens and says nothing about the story), lines
 * left empty by that gone, runs of blank lines made one.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/gu, "")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/gu, "$1")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\s*(?:[-*+]|#+|>)?\s*$/u.test(line) || line === "")
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Firecrawl Local's reading of one page: never its cloud, Edit's own headless Chrome for pages drawn by script. */
async function scrape(url: string, local: boolean): Promise<Scraped> {
  const binary = tools.firecrawl();
  if (binary === null) throw new Error("Edit's page reader isn't here: run `just firecrawl` (releases ship it)");
  const chrome = headlessBinary();
  // Its own limit is per page; this one only ends a reader that never answers.
  const command = [binary, "scrape", url, "--timeout", "30000", "--user-agent", USER_AGENT, ...(local ? [] : ["--public-only"])];
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FIRECRAWL_CLOUD: "off", ...(chrome !== null ? { FIRECRAWL_CHROME_PATH: chrome } : {}) },
  });
  const timer = setTimeout(() => child.kill(), 90_000);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  clearTimeout(timer);
  try {
    return JSON.parse(out) as Scraped;
  } catch {
    const said = err.trim().split("\n").pop() ?? "";
    throw new Error(code === 0 || said === "" ? "the page reader gave no answer" : `the page reader stopped: ${said.slice(0, 200)}`);
  }
}
