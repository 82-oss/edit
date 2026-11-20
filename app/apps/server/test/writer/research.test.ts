import { afterEach, expect, test } from "bun:test";

import * as webPage from "../../src/web_page.ts";
import { host, read } from "../../src/writer/research.ts";

const { scrape } = webPage.hooks;

afterEach(() => {
  webPage.hooks.scrape = scrape;
  webPage.forget();
});

test("reads a page's main content and what its metadata says", async () => {
  const story = "The boy was arrested in March 2011 in Jacksonville, Florida, police said. ".repeat(8);
  webPage.hooks.scrape = async () => ({ success: true, data: { markdown: `## Arrest\n\n${story}`, metadata: { title: "A & B", "og:site_name": "News 4", publishedTime: "2011-03-02", statusCode: 200 } } });
  expect(await read("https://www.wjxt.com/news/a")).toEqual({ url: "https://www.wjxt.com/news/a", title: "A & B", outlet: "News 4", published: "2011-03-02", text: `## Arrest\n\n${story.trim()}` });
  // Too little to be a report.
  webPage.hooks.scrape = async () => ({ success: true, data: { markdown: "Subscribe to read.", metadata: { statusCode: 200 } } });
  expect(await read("https://www.wjxt.com/news/b")).toBeNull();
  expect(host("https://www.wjxt.com/news/a")).toBe("www.wjxt.com");
});
