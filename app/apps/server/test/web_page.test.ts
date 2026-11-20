// web_page.ts: Firecrawl Local's answers read as pages, and (where it's built
// here, `just firecrawl`) the real program reading a page from the mock.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import * as tools from "../src/tools.ts";
import * as webPage from "../src/web_page.ts";
import { fromScraped, pictures, plainText } from "../src/web_page.ts";
import { MockServer } from "./mocks/server.ts";

const { scrape } = webPage.hooks;

afterEach(() => {
  webPage.hooks.scrape = scrape;
  webPage.forget();
});

test("markdown becomes plain lines: pictures dropped, links kept as their words", () => {
  const markdown = [
    "[Skip to content](https://news.example/#content)",
    "",
    "# Deputy rescues toddler",
    "",
    "[![](https://news.example/logo.png)](https://news.example/)",
    "",
    "- [Home](https://news.example/)",
    "",
    "",
    "",
    'Body camera footage captured a [deputy](https://news.example/tag/deputy_(sheriff) "Deputy") saving a girl.',
    "![A pond](https://news.example/pond.jpg)",
  ].join("\n");
  expect(plainText(markdown)).toBe("Skip to content\n\n# Deputy rescues toddler\n\n- Home\n\nBody camera footage captured a deputy saving a girl.");
  expect(pictures(markdown)).toEqual(["https://news.example/logo.png", "https://news.example/pond.jpg"]);
});

test("Firecrawl's answer read as a page: what it says it is, its pictures, and why one can't be read", () => {
  const page = fromScraped("https://wsvn.com/a", {
    success: true,
    data: {
      markdown: "Story.\n\n![](https://wsvn.com/in.jpg)\n![](/relative.jpg)",
      metadata: { url: "https://wsvn.com/a/", title: "Page", "og:title": ["Deputy rescues toddler", "x"], ogSiteName: "WSVN", publishedTime: "2026-11-18", "og:image": "https://wsvn.com/lead.jpg", statusCode: 200 },
    },
  });
  expect(page).toEqual({ url: "https://wsvn.com/a/", title: "Deputy rescues toddler", outlet: "WSVN", published: "2026-11-18", text: "Story.", images: ["https://wsvn.com/lead.jpg", "https://wsvn.com/in.jpg"] });
  // No name of its own: the site's address.
  expect(fromScraped("https://www.kent.example/a", { success: true, data: { markdown: "Story.", metadata: { statusCode: 200 } } }).outlet).toBe("kent.example");
  const fails = (scraped: webPage.Scraped) => () => fromScraped("https://x.example/", scraped);
  expect(fails({ success: true, data: { markdown: "Just a moment", metadata: { statusCode: 403 }, blocked: true } })).toThrow("bot check");
  expect(fails({ success: true, data: { markdown: "Error 451", metadata: { statusCode: 451 } } })).toThrow("doesn't serve this country");
  expect(fails({ success: true, data: { markdown: "Not found", metadata: { statusCode: 404 } } })).toThrow("the site answered 404");
  expect(fails({ success: true, data: { markdown: "", metadata: { statusCode: 200 }, warning: "the page needs a browser and none was found" } })).toThrow("nothing to read: the page needs a browser");
  expect(fails({ success: false, code: "SCRAPE_TIMEOUT", error: "timed out" })).toThrow("the page took too long to load");
  expect(fails({ success: false, code: "FETCH_FAILED", error: "dns error: failed to lookup address\nmore" })).toThrow("couldn't reach the page (dns error: failed to lookup address)");
});

test("a page is read once in a while, and only from the web", async () => {
  let asked = 0;
  webPage.hooks.scrape = async () => {
    asked++;
    return { success: true, data: { markdown: "Story.", metadata: { statusCode: 200 } } };
  };
  await webPage.read("https://93.184.216.34/a");
  await webPage.read("https://93.184.216.34/a");
  expect(asked).toBe(1);
  await expect(webPage.read("http://10.1.2.3/api/projects")).rejects.toThrow("or its network, not the web");
  expect(asked).toBe(1);
  // Not reached once: asked again, once.
  asked = 0;
  webPage.hooks.scrape = async () => (++asked === 1 ? { success: false, code: "FETCH_FAILED", error: "invalid peer certificate" } : { success: true, data: { markdown: "Story.", metadata: { statusCode: 200 } } });
  expect((await webPage.read("https://93.184.216.34/b")).text).toBe("Story.");
  expect(asked).toBe(2);
});

// The real program, where it's built here (CI's tests stub it: it's a release's sidecar).
const binary = tools.firecrawl();
let mock: MockServer;
let restore: () => void;
beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv();
});
afterAll(() => {
  restore();
  mock.stop();
});

test.skipIf(binary === null)("Firecrawl Local reads a page's main content and its metadata", async () => {
  const story = "Kent police said the teen drove the Prius into the crash on July 13. ".repeat(20);
  mock.on("GET", "/news/story", (_request, server) =>
    new Response(
      `<html><head><title>ignored</title><meta property="og:title" content="Teen charged in Kent crash"><meta property="og:site_name" content="Kent Reporter"><meta property="og:image" content="${server.url}/img/photo.jpg"></head><body><nav><a href="/">Home</a><a href="/news">News</a></nav><article><h1>Teen charged</h1><p>${story}</p><p>Read the <a href="${server.url}/charges">charges</a>.</p></article><footer>© Kent Reporter</footer></body></html>`,
      { headers: { "content-type": "text/html" } },
    ),
  );
  const page = await webPage.read(`${mock.url}/news/story`);
  expect(page.title).toBe("Teen charged in Kent crash");
  expect(page.outlet).toBe("Kent Reporter");
  expect(page.images).toEqual([`${mock.url}/img/photo.jpg`]);
  expect(page.text).toContain(story.trim());
  expect(page.text).toContain("Read the charges.");
  expect(page.text).not.toContain("http");
});
