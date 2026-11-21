// @vitest-environment happy-dom
// Scripts shared for review from Home, each on its own (Sphe, Nov 22: "it
// seems like there's a very weird thing around sharing multiple scripts"):
// a written script's ⋯ shares it without opening it, as an edit's row does;
// each row says how far its own share is, and one that stopped or couldn't
// start says so on its row in words, with what to do, while the others go.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "../lib/account";
import type { WriterScriptRow } from "../lib/api";
import type { Script, ShareFailed, Sharing } from "../writer/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

const shareScript = vi.fn<(id: string) => Promise<Script>>();
vi.mock("../writer/api", async (original) => {
  const real = await original<typeof import("../writer/api")>();
  return { ...real, shareScript: (id: string) => shareScript(id) };
});
const { ScriptTableRow } = await import("./Home");
const { ContextMenuHost } = await import("./ContextMenu");

const row = (id: string, title: string, extra: Partial<WriterScriptRow> = {}): WriterScriptRow =>
  ({ id, title, rev: 1, updatedAt: 1, updatedBy: null, createdBy: null, project: null, handoff: null, clips: 4, durationMs: 600_000, built: true, style: null, ...extra }) as WriterScriptRow;

const SENDING: Sharing = { startedAt: 1, stage: "uploading the footage 46%", version: 2, progress: 0.46, leftS: 240, steps: [{ kind: "check", state: "done" }, { kind: "script", state: "done" }, { kind: "footage", state: "current", total: 100, done: 46 }, { kind: "publish", state: "waiting" }] };
const PUBLISHING: Sharing = { startedAt: 1, stage: "publishing", version: 1, progress: null, leftS: null, steps: [{ kind: "script", state: "done" }, { kind: "publish", state: "current" }] };

let root: Root | null = null;
let container: HTMLDivElement;
beforeEach(() => {
  useAccount.setState({ account: { person: { email: "a@b.c", name: "A", image: null }, perms: [], admin: true } as never });
  shareScript.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const settle = () =>
  act(async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });

type Given = { script: WriterScriptRow; sharing?: Sharing | null; shareFailed?: ShareFailed | null };
function show(rows: Given[]) {
  act(() =>
    root!.render(
      <>
        {rows.map((one) => (
          <div key={one.script.id} data-row={one.script.id}>
            <ScriptTableRow script={one.script} writing={false} sharing={one.sharing ?? null} shareFailed={one.shareFailed ?? null} here fresh={null} onChanged={() => {}} />
          </div>
        ))}
        <ContextMenuHost />
      </>,
    ),
  );
}
const status = (id: string) => container.querySelector(`[data-row="${id}"] [role=cell]:nth-child(2)`)?.textContent ?? "";
const menuItems = () => [...document.querySelectorAll("[data-menu] [role=menuitem], [data-menu] button")].map((one) => one.textContent?.trim() ?? "");
async function shareFromMenu(id: string) {
  act(() => container.querySelector<HTMLButtonElement>(`[data-row="${id}"] button[title=More]`)!.click());
  const item = [...document.querySelectorAll<HTMLElement>("[data-menu] [role=menuitem], [data-menu] button")].find((one) => one.textContent?.trim() === "Share for review");
  if (item === undefined) return false;
  act(() => item.click());
  await settle();
  return true;
}

describe("Home's script rows and sharing", () => {
  it("a row says how far its share is: the percent where bytes are counted, else the step in words", () => {
    show([{ script: row("a", "One"), sharing: SENDING }, { script: row("b", "Two"), sharing: PUBLISHING }]);
    expect(status("a")).toBe("46%");
    expect(container.querySelector<HTMLElement>('[data-row="a"] [style*="width"]')?.style.width).toBe("46%");
    expect(status("b")).toBe("Publishing");
  });

  it("a share that stopped is said on its row in words, with what to do, and the row shares it again", async () => {
    show([{ script: row("a", "One"), shareFailed: { error: "Its preview hasn't reached the cloud yet. Wait for the sync to finish, then share again.", at: 1, step: "check" } }]);
    expect(status("a")).toBe("Share againSharing stopped while checking its preview in the cloud. Its preview hasn't reached the cloud yet. Wait for the sync to finish, then share again.");
    shareScript.mockResolvedValue({ id: "a", sharing: SENDING } as unknown as Script);
    act(() => container.querySelector<HTMLButtonElement>('[data-row="a"] button[title="Share it again"]')!.click());
    await settle();
    expect(shareScript).toHaveBeenCalledWith("a");
    expect(status("a")).toBe("46%");
  });

  it("three scripts shared from their menus start three shares, each row its own; one that can't start says why on its row, the others go", async () => {
    shareScript.mockImplementation(async (id) => {
      if (id === "c") throw new Error("Claude is still working on this script. Share it when that's done.");
      return { id, sharing: id === "a" ? SENDING : PUBLISHING } as unknown as Script;
    });
    // "d" isn't written yet: nothing for a reviewer, so its menu doesn't offer it.
    show([{ script: row("a", "One") }, { script: row("b", "Two") }, { script: row("c", "Three") }, { script: row("d", "Four", { built: false, clips: 1 }) }]);
    expect(await shareFromMenu("a")).toBe(true);
    expect(await shareFromMenu("b")).toBe(true);
    expect(await shareFromMenu("c")).toBe(true);
    expect(await shareFromMenu("d")).toBe(false);
    expect(menuItems()).not.toContain("Share for review");
    expect(shareScript.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
    expect(status("a")).toBe("46%");
    expect(status("b")).toBe("Publishing");
    expect(status("c")).toBe("Share againClaude is still working on this script. Share it when that's done.");
    expect(status("d")).toContain("Write script");
  });
});
