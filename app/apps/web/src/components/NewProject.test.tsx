// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const mocks = vi.hoisted(() => ({
  writerScripts: vi.fn(),
  importWriter: vi.fn(),
  createProject: vi.fn(),
  attachScript: vi.fn(),
  deleteProject: vi.fn(),
  firstPrompt: vi.fn(),
  scriptPreview: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  checkVideos: vi.fn(),
  importYoutube: vi.fn(),
  importDrive: vi.fn(),
  importCompilation: vi.fn(),
  createCommentary: vi.fn(),
  trelloCard: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      writerScripts: (...args: unknown[]) => mocks.writerScripts(...args),
      importWriter: (...args: unknown[]) => mocks.importWriter(...args),
      createProject: (...args: unknown[]) => mocks.createProject(...args),
      attachScript: (...args: unknown[]) => mocks.attachScript(...args),
      deleteProject: (...args: unknown[]) => mocks.deleteProject(...args),
      firstPrompt: (...args: unknown[]) => mocks.firstPrompt(...args),
      scriptPreview: (...args: unknown[]) => mocks.scriptPreview(...args),
    },
  };
});

vi.mock("../writer/api", () => ({
  checkVideos: (...args: unknown[]) => mocks.checkVideos(...args),
  importYoutube: (...args: unknown[]) => mocks.importYoutube(...args),
  importDrive: (...args: unknown[]) => mocks.importDrive(...args),
  importCompilation: (...args: unknown[]) => mocks.importCompilation(...args),
  createCommentary: (...args: unknown[]) => mocks.createCommentary(...args),
  trelloCard: (...args: unknown[]) => mocks.trelloCard(...args),
}));

vi.mock("../lib/route", () => ({
  navigate: (...args: unknown[]) => mocks.navigate(...args),
}));

vi.mock("../lib/beta", () => ({
  loadBeta: vi.fn(async () => {}),
  useBeta: (select: (state: { v2: boolean }) => unknown) => select({ v2: false }),
}));

vi.mock("../lib/account", () => ({
  useAccount: (select: (state: { account: null }) => unknown) => select({ account: null }),
  editStyles: () => null,
  makesVideos: () => true,
  writesScripts: () => true,
}));

vi.mock("../writer/can", () => ({
  CAN: { commentary: "writer.commentary" },
  useGrants: () => ({
    singleKinds: ["foia", "interrogation", "courtroom"],
    compilationKinds: ["foia", "interrogation", "courtroom"],
    has: () => true,
  }),
}));

vi.mock("../lib/channels", () => ({
  loadChannels: vi.fn(async () => {}),
  useChannels: (select: (state: { channels: []; failed: null; teacher: boolean }) => unknown) => select({ channels: [], failed: null, teacher: false }),
}));

import { useEditor } from "../lib/store";
import { NewProject } from "./Home";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function setInputValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function findButton(label: string | RegExp): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const found = buttons.find((button) => {
    const text = (button.textContent ?? "").trim();
    return typeof label === "string" ? text === label : label.test(text);
  });
  if (!found) throw new Error(`Button not found: ${String(label)}. Have: ${buttons.map((b) => JSON.stringify(b.textContent?.trim())).join(", ")}`);
  return found;
}

function findSwitch(label: RegExp): HTMLButtonElement {
  const switches = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="switch"]'));
  const found = switches.find((node) => label.test(node.closest("label")?.textContent ?? ""));
  if (!found) throw new Error(`Switch not found: ${String(label)}`);
  return found;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderDialog(props: { work: "edit" | "script"; open?: boolean; onClose?: () => void }) {
  if (container === null) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(<NewProject work={props.work} open={props.open ?? true} onClose={props.onClose ?? vi.fn()} />);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useEditor.setState({ toast: mocks.toast } as never);
  mocks.writerScripts.mockResolvedValue({
    scripts: [
      {
        id: "script-1",
        title: "Officer Stops Suspect",
        rev: 1,
        updatedAt: Date.now(),
        updatedBy: null,
        createdBy: null,
        project: null,
        handoff: null,
        clips: 8,
        durationMs: 600_000,
        built: true,
        style: "bodycam",
      },
    ],
  });
  mocks.importWriter.mockResolvedValue({ project: "proj-from-script" });
  mocks.createProject.mockResolvedValue({ project: { id: "proj-doc" } });
  mocks.attachScript.mockResolvedValue({ ok: true });
  mocks.deleteProject.mockResolvedValue({ ok: true });
  mocks.firstPrompt.mockResolvedValue({ ok: true });
  mocks.scriptPreview.mockResolvedValue({ title: "Doc Title", style: "bodycam", files: 2, narration: 10, seconds: 600 });
  mocks.importYoutube.mockResolvedValue({ id: "yt-1" });
  mocks.importDrive.mockResolvedValue({ id: "dr-1" });
  mocks.importCompilation.mockResolvedValue({ id: "comp-1" });
  mocks.createCommentary.mockResolvedValue({ id: "comm-1" });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("NewProject auto-start after import", () => {
  it("queues firstPrompt by default when starting an edit from a script, and skips it when turned off", async () => {
    const onClose = vi.fn();
    await renderDialog({ work: "edit", onClose });

    await act(async () => {
      findButton(/Officer Stops Suspect/).click();
    });
    expect(findButton("Start the edit").disabled).toBe(false);

    // Open More and toggle Start editing after import OFF; clicking the switch must NOT submit the form.
    await act(async () => {
      findButton(/^More/).click();
    });
    const toggle = findSwitch(/Start editing after import/i);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('input[placeholder*="Start the editing workflow"]')).not.toBeNull();

    await act(async () => {
      toggle.click();
    });
    expect(mocks.importWriter).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('input[placeholder*="Start the editing workflow"]')).toBeNull();
    expect(findButton("Import footage").disabled).toBe(false);

    // Submitting imports the script without queuing firstPrompt.
    await act(async () => {
      findButton("Import footage").click();
    });
    await flush();

    expect(mocks.importWriter).toHaveBeenCalledWith("script-1", {});
    expect(mocks.firstPrompt).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith("/p/proj-from-script");

    // Reopening resets auto-start back to ON and queues firstPrompt again.
    await renderDialog({ work: "edit", open: false, onClose });
    await renderDialog({ work: "edit", open: true, onClose });
    await act(async () => {
      findButton(/Officer Stops Suspect/).click();
    });
    await act(async () => {
      findButton("Start the edit").click();
    });
    await flush();

    expect(mocks.firstPrompt).toHaveBeenCalledWith("proj-from-script", "Start the editing workflow.");
  });

  it("respects the choice for edits from a pasted Google Doc and hides the toggle for blank edits", async () => {
    const onClose = vi.fn();
    mocks.writerScripts.mockResolvedValue({ scripts: [] });
    await renderDialog({ work: "edit", onClose });

    // Blank edit: no auto-start switch in More.
    await act(async () => {
      findButton(/^More/).click();
    });
    expect(document.querySelectorAll('button[role="switch"]')).toHaveLength(0);

    // Paste a Google Doc link: switch appears and defaults ON.
    const textarea = document.querySelector("textarea")!;
    await act(async () => {
      setInputValue(textarea, "https://docs.google.com/document/d/abc123/edit");
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await flush();

    const toggle = findSwitch(/Start editing after import/i);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    // Turn OFF and submit: creates project + attaches script, skips firstPrompt.
    await act(async () => {
      toggle.click();
    });
    await act(async () => {
      findButton("Import footage").click();
    });
    await flush();

    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.attachScript).toHaveBeenCalledWith("proj-doc", "https://docs.google.com/document/d/abc123/edit");
    expect(mocks.firstPrompt).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("“Doc Title”: importing its footage", "info");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits build for YouTube, Drive, and compilation scripts when Start writing after import is off", async () => {
    // 1. Single YouTube video, opted out
    mocks.checkVideos.mockResolvedValue([{ url: "https://youtu.be/abc123", title: "Suspect Chase", durationMs: 600_000, reuse: false, problem: null, warning: null }]);
    const onClose = vi.fn();
    await renderDialog({ work: "script", onClose });

    const textarea = document.querySelector("textarea")!;
    await act(async () => {
      setInputValue(textarea, "https://youtu.be/abc123");
    });
    await act(async () => {
      vi.advanceTimersByTime(550);
    });
    await flush();

    await act(async () => {
      findButton(/^More/).click();
    });
    await act(async () => {
      findSwitch(/Start writing after import/i).click();
    });
    await act(async () => {
      findButton("Import footage").click();
    });
    await flush();

    expect(mocks.importYoutube).toHaveBeenCalledWith("https://youtu.be/abc123", undefined, "Suspect Chase", "foia", undefined, undefined);
    expect(mocks.toast).toHaveBeenCalledWith("“Suspect Chase”: importing its footage", "info");

    // 2. Single Drive folder, default ON -> passes "" so server builds after import
    mocks.checkVideos.mockResolvedValue([{ url: "https://drive.google.com/drive/folders/folder1", title: "Bodycam Folder", durationMs: 900_000, reuse: false, problem: null, warning: null }]);
    await renderDialog({ work: "script", open: false, onClose });
    await renderDialog({ work: "script", open: true, onClose });
    await act(async () => {
      setInputValue(document.querySelector("textarea")!, "https://drive.google.com/drive/folders/folder1");
    });
    await act(async () => {
      vi.advanceTimersByTime(550);
    });
    await flush();
    await act(async () => {
      findButton("Write the script").click();
    });
    await flush();

    expect(mocks.importDrive).toHaveBeenCalledWith("https://drive.google.com/drive/folders/folder1", undefined, "Bodycam Folder", "foia", "", undefined);
    expect(mocks.toast).toHaveBeenCalledWith("“Bodycam Folder”: importing its footage, then writing the script", "info");

    // 3. Compilation, opted out -> passes undefined for build
    mocks.checkVideos.mockImplementation(async ([line]: [string]) => [
      { url: line, title: line.endsWith("1") ? "Case One" : "Case Two", durationMs: 300_000, reuse: false, problem: null, warning: null },
    ]);
    await renderDialog({ work: "script", open: false, onClose });
    await renderDialog({ work: "script", open: true, onClose });
    await act(async () => {
      setInputValue(document.querySelector("textarea")!, "https://youtu.be/vid1\nhttps://youtu.be/vid2");
    });
    await act(async () => {
      vi.advanceTimersByTime(550);
    });
    await flush();
    await act(async () => {
      findButton(/^More/).click();
    });
    await act(async () => {
      findSwitch(/Start writing after import/i).click();
    });
    await act(async () => {
      findButton("Import footage").click();
    });
    await flush();

    expect(mocks.importCompilation).toHaveBeenCalledWith("Case One", ["https://youtu.be/vid1", "https://youtu.be/vid2"], false, "foia", undefined, undefined);
  });

  it("does not show the auto-start switch for commentary scripts", async () => {
    const onClose = vi.fn();
    await renderDialog({ work: "script", onClose });

    await act(async () => {
      findButton("Commentary").click();
    });
    expect(document.querySelectorAll('button[role="switch"]')).toHaveLength(0);
    expect(Array.from(document.querySelectorAll("button")).some((b) => /^More/.test(b.textContent?.trim() ?? ""))).toBe(false);

    await act(async () => {
      setInputValue(document.querySelector("textarea")!, "https://example.com/brief");
      setInputValue(document.querySelector('input[placeholder="What the video is called"]')!, "Essay Title");
    });
    await act(async () => {
      findButton("Create").click();
    });
    await flush();

    expect(mocks.createCommentary).toHaveBeenCalledWith("Essay Title", ["https://example.com/brief"]);
    expect(mocks.toast).toHaveBeenCalledWith("“Essay Title”: ready to script", "info");
  });
});
