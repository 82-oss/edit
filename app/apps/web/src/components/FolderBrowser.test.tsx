// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderPicker } from "./FolderBrowser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
const button = (words: string) => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === words) as HTMLButtonElement | undefined;
const rows = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim());

const HOME = "/Users/jj";
const places = ["Desktop", "Documents", "Downloads", "Movies"].map((name) => ({ name, path: `${HOME}/${name}` })).concat({ name: "Home", path: HOME });

/** Edit's /api/fs as a Mac answers it: Documents kept by macOS's privacy settings, Movies open. */
function server() {
  const folders: Record<string, string[]> = { [HOME]: ["Desktop", "Documents", "Downloads", "Movies"], [`${HOME}/Movies`]: ["Old"] };
  const calls: string[] = [];
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${decodeURIComponent(url)}`);
      if (url.startsWith("/api/fs?") || url === "/api/fs") {
        const path = new URLSearchParams(url.split("?")[1] ?? "").get("path") ?? HOME;
        const parent = path.slice(0, path.lastIndexOf("/")) || null;
        if (path === `${HOME}/Documents`) return answer(403, { error: "macOS hasn't let Edit open Documents", refused: "privacy", path, parent, places });
        const names = folders[path];
        if (!names) return answer(404, { error: "folder not found" });
        return answer(200, { path, parent, places, entries: names.map((name) => ({ name, path: `${path}/${name}`, dir: true, size: 0 })) });
      }
      if (url === "/api/fs/folder") {
        const { path, name } = JSON.parse(String(init?.body)) as { path: string; name: string };
        if (folders[path]!.includes(name)) return answer(409, { error: `There's already a folder called “${name}” here` });
        folders[path]!.push(name);
        folders[`${path}/${name}`] = [];
        return answer(200, { path: `${path}/${name}` });
      }
      if (url === "/api/fs/privacy") return answer(200, { ok: true });
      return answer(404, { error: "no route" });
    }),
  );
  return calls;
}

function render(onPick = vi.fn(async () => {})) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onClose = vi.fn();
  act(() => root!.render(<FolderPicker open onClose={onClose} title="Where should exports go?" detail="" start={`${HOME}/Movies/Edit`} confirm="Use this folder" onPick={onPick} />));
  return { onPick, onClose };
}

describe("the folder picker", () => {
  it("opens at the nearest folder that's there, and offers no suggested folder to click", async () => {
    const calls = server();
    render();
    await settle();
    // ~/Movies/Edit isn't made yet: Movies, not Home.
    expect(calls).toEqual([`GET /api/fs?path=${HOME}/Movies/Edit`, `GET /api/fs?path=${HOME}/Movies`]);
    expect(rows()).toContain("Old");
    expect(document.body.textContent).not.toContain("Use ~/");
  });

  it("stays on a folder macOS keeps from Edit, says so in one line, and opens the privacy settings", async () => {
    const calls = server();
    render();
    await settle();
    await act(async () => button("Documents")!.click());
    await settle();
    expect(document.body.textContent).toContain("macOS hasn't let Edit open Documents.");
    // Still on Documents: its place is the one shown, nothing asked of home.
    expect(calls.filter((call) => call === "GET /api/fs")).toEqual([]);
    expect(button("Documents")!.className).toContain("bg-active");
    expect(button("Use this folder")!.disabled).toBe(true);
    expect(button("New folder")!.disabled).toBe(true);
    await act(async () => button("Open Settings")!.click());
    await settle();
    expect(calls).toContain("POST /api/fs/privacy");
    // Back in Edit after allowing it: looked at again.
    const before = calls.length;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(calls.slice(before)).toEqual([`GET /api/fs?path=${HOME}/Documents`]);
  });

  it("shows the folder last clicked, never an older answer that came in after it (kenobi, Nov 16: Documents' refusal over Downloads')", async () => {
    server();
    const real = globalThis.fetch as (url: string, init?: RequestInit) => Promise<Response>;
    let release: (() => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      // Documents asked again as Edit comes forward: its answer held back until after the next click's.
      if (release === null && url.includes("Documents") && (globalThis as { holding?: boolean }).holding) await new Promise<void>((resolve) => (release = resolve));
      return real(url, init);
    }));
    render();
    await settle();
    await act(async () => button("Documents")!.click());
    await settle();
    (globalThis as { holding?: boolean }).holding = true;
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await act(async () => button("Movies")!.click());
    await settle();
    expect(rows()).toContain("Old");
    await act(async () => (release as unknown as () => void)());
    await settle();
    delete (globalThis as { holding?: boolean }).holding;
    expect(rows()).toContain("Old");
    expect(document.body.textContent).not.toContain("macOS hasn't let Edit open Documents.");
  });

  it("makes a new folder where it is, named in place, then one inside it, and picks it", async () => {
    const calls = server();
    const { onPick, onClose } = render();
    await settle();
    const name = async (words: string) => {
      await act(async () => button("New folder")!.click());
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!;
      expect(document.activeElement).toBe(input);
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(input, words);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => input.form!.requestSubmit());
      await settle();
    };
    await name("Old");
    expect(document.body.textContent).toContain("There's already a folder called “Old” here");
    // Escape leaves the naming, not the dialog.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector('input[aria-label="Folder name"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await name("Renders");
    expect(calls).toContain(`POST /api/fs/folder`);
    expect(rows()).toContain("Renders");
    await act(async () => button("Renders")!.click());
    await settle();
    await name("Shorts");
    await act(async () => button("Shorts")!.click());
    await settle();
    await act(async () => button("Use this folder")!.click());
    await settle();
    expect(onPick).toHaveBeenCalledWith(`${HOME}/Movies/Renders/Shorts`);
  });
});
