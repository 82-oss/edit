// @vitest-environment happy-dom
// The Docs dialog's one primary action and its comments read as it opens (Astra, Nov 18).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "../../lib/account";
import type { DocComment, Script } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

const docComments = vi.fn<(id: string) => Promise<{ doc: string; comments: DocComment[] }>>();
vi.mock("../api", async (original) => {
  const real = await original<typeof import("../api")>();
  return { ...real, docComments: (id: string) => docComments(id), listDocs: () => Promise.resolve([]) };
});
const { DocsDialog } = await import("../docs-dialog");

const DOC = { id: "d1", url: "https://docs.google.com/document/d/d1", revision: 4, exportedAt: 1 };
const script = (extra: Partial<Script>) =>
  ({ id: "s1", title: "A case", revision: 4, updatedAt: 1, clips: [{ id: "c1", kind: "cut-in" }], ...extra }) as unknown as Script;
const comment = (id: string, content: string, resolved = false) => ({ id, content, resolved, author: { displayName: "JJ" } }) as DocComment;

let root: Root | null = null;
beforeEach(() => {
  useAccount.setState({ account: { person: { email: "a@b.c", name: "A", image: null }, perms: [], admin: true } as never });
  docComments.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const settle = () => act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); });
function show(given: Script) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<DocsDialog open script={given} onClose={() => {}} onChange={() => {}} onUseComments={() => {}} />));
}
const footer = () => [...document.querySelectorAll("button.primary")].map((one) => one.textContent?.trim());
const labels = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim());

describe("DocsDialog", () => {
  it("the Doc matches the script: Open Doc is the one primary action and opens it", async () => {
    docComments.mockResolvedValue({ doc: "d1", comments: [] });
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    show(script({ docExport: DOC }));
    await settle();
    expect(footer()).toEqual(["Open Doc ↗"]);
    expect(labels()).not.toContain("Export again");
    expect(labels()).not.toContain("Export draft");
    act(() => document.querySelector<HTMLButtonElement>("button.primary")!.click());
    expect(opened).toHaveBeenCalledWith(DOC.url, "_blank", "noopener,noreferrer");
    expect(document.body.textContent).not.toContain("Repack");
  });

  it("the script changed since: Export updated Doc", async () => {
    docComments.mockResolvedValue({ doc: "d1", comments: [] });
    show(script({ docExport: DOC, revision: 5 }));
    await settle();
    expect(footer()).toEqual(["Export updated Doc"]);
  });

  it("a copy of the same revision and a draft are under All exports", async () => {
    docComments.mockResolvedValue({ doc: "d1", comments: [] });
    show(script({ docExport: DOC }));
    await settle();
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.includes("All exports"))!.click());
    await settle();
    expect(labels()).toContain("New export");
    expect(labels()).toContain("Export draft");
  });

  it("the comments are read as it opens, the open ones shown with a rewrite, no read button", async () => {
    docComments.mockResolvedValue({ doc: "d1", comments: [comment("c1", "Cut the intro"), comment("c2", "Done already", true)] });
    show(script({ docExport: DOC }));
    await settle();
    expect(docComments).toHaveBeenCalledWith("s1");
    expect(document.body.textContent).toContain("Cut the intro");
    expect(document.body.textContent).not.toContain("Done already");
    expect(labels()).toContain("Rewrite with 1 comment…");
    expect(labels()).not.toContain("Read comments from the Doc");
    expect(labels()).toContain("Refresh comments");
  });

  it("a late answer for another script doesn't fill this one's comments", async () => {
    let answer: (value: { doc: string; comments: DocComment[] }) => void = () => {};
    docComments.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    docComments.mockResolvedValueOnce({ doc: "d2", comments: [] });
    show(script({ docExport: DOC }));
    act(() => root!.render(<DocsDialog open script={script({ id: "s2", docExport: { ...DOC, url: "https://docs.google.com/document/d/d2" } })} onClose={() => {}} onChange={() => {}} />));
    await settle();
    answer({ doc: "d1", comments: [comment("c1", "From the other script")] });
    await settle();
    expect(document.body.textContent).not.toContain("From the other script");
  });
});
