// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "../lib/account";
import { api, type Review } from "../lib/api";
import { useEditor } from "../lib/store";
import type { Project } from "../lib/types";
import { ShareDialog } from "./ShareDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); });
const project = (channel?: string): Project =>
  ({ version: 1, id: "p1", name: "Case", style: "bodycam", next_id: 1, settings: { width: 1920, height: 1080, fps: 30 }, clips: [], media: [], tracks: [], ...(channel === undefined ? {} : { channel }) }) as Project;
const PICTURES = [
  { id: "pic-ted", code: "InspectorTed", name: "Inspector Ted" },
  { id: "pic-si", code: "SI", name: "Sam's Interrogations" },
];

/** The dialog open on `given`, the server offering `offer`; its watermark row, if any. */
async function open(given: Project, offer: Awaited<ReturnType<typeof api.watermarks>>, watermark: string | null = null) {
  useEditor.setState({ project: given, exportState: null });
  const offered = vi.spyOn(api, "watermarks").mockResolvedValue(offer);
  vi.spyOn(api, "review").mockResolvedValue({ sharing: null, share: null, watermark, review: null, next: null, notes: [] } as unknown as Review);
  vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me" } as never);
  vi.spyOn(api, "rangesExport").mockResolvedValue(null);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<ShareDialog open onClose={() => {}} />));
  await settle();
  expect(offered).toHaveBeenCalledWith("p1");
  const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  return { box, row: box?.closest("div") ?? null };
}

describe("ShareDialog's watermark (Sphe, Nov 16: only when the channel has one)", () => {
  it("a channel with a watermark: one checkbox for its logo, by its name, and no channel to pick", async () => {
    const { box, row } = await open(project("ch-6efba6498c"), { channel: { key: "ch-6efba6498c", name: "Sam's Interrogations" }, channels: [PICTURES[1]!] });
    expect(box).not.toBeNull();
    expect(box!.disabled).toBe(false);
    expect(row!.textContent).toContain("Sam's Interrogations’ logo at 10%");
    expect(row!.querySelector("button")).toBeNull();
  });

  it("a channel without one: no watermark option at all, whatever was kept before", async () => {
    const { box } = await open(project("ch-bcbfe704b8"), { channel: { key: "ch-bcbfe704b8", name: "GTA 6 Channel" }, channels: [] }, "pic-si");
    expect(box).toBeNull();
    expect(document.body.textContent).not.toContain("Watermark");
  });

  it("a project of no channel (V1) keeps the checkbox and the folder's pictures to pick from, starting on the usual one", async () => {
    const { box, row } = await open(project(), { channel: null, channels: PICTURES, usual: "pic-si" });
    expect(box).not.toBeNull();
    // Nov 22: it has no channel, so the row never says "the channel's": a logo, and the picker says whose.
    expect(row!.textContent).toContain("A logo at 10%");
    expect(row!.textContent).not.toContain("channel");
    // The picker, on the one picked most here.
    expect(row!.querySelector("button")?.textContent).toContain("Sam's Interrogations");
  });
});

describe("ShareDialog's steps while it runs (Sphe, Nov 17: design B)", () => {
  const STEPS = {
    where: "here" as const,
    queued: false,
    elapsed_s: 60,
    left_s: 240,
    progress: 0.2,
    steps: [
      { kind: "graphic" as const, state: "done" as const, label: "0:12", progress: null, left_s: 0 },
      { kind: "graphic" as const, state: "done" as const, label: "5:40", progress: null, left_s: 0 },
      { kind: "graphic" as const, state: "current" as const, label: "41:12", what: "map" as const, progress: 0.92, left_s: 4 },
      { kind: "graphic" as const, state: "waiting" as const, label: "50:02", progress: null, left_s: 15 },
      { kind: "graphic" as const, state: "waiting" as const, label: "1:02:10", progress: null, left_s: 25 },
      { kind: "video" as const, state: "waiting" as const, label: "1:48:29", progress: null, left_s: 180 },
      { kind: "save" as const, state: "waiting" as const, label: "~/Downloads/Edit", progress: null, left_s: 0 },
    ],
  };
  const buttons = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim());

  // Nov 21: the choices are gone while it runs (Sphe: "unnecessary decisions that are right in front of your face"), one
  // number and bar over the steps, and the step under way says its own time left beside its percent.
  it("waiting on graphics: no choices, the overall percent and time left, the steps, Cancel export and Close, no Export", async () => {
    vi.spyOn(api, "exportActivity").mockResolvedValue([{ id: "p1", name: "Case", path: "/x.mp4", state: "running", progress: 0, updated_ms: 1, waiting: "rendering the cutfx-21 effect", steps: STEPS }]);
    await open(project(), { channel: null, channels: PICTURES });
    act(() => useEditor.setState({ exportState: { state: "queued", progress: 0, path: "/x.mp4", waiting: "rendering the cutfx-21 effect · 405 of 439 frames" } as never }));
    await settle();
    const rows = [...document.querySelectorAll('ol[aria-label="Export steps"] > li')].map((row) => row.textContent);
    expect(rows).toEqual(["Graphics 1–2done", "Graphic 3 of 5 · the map at 41:1292% · a moment", "Graphics 4–5~40 s", "Video · 1:48:29~3 min", "Save to ~/Downloads/Edita moment"]);
    expect(document.querySelector('[data-state="current"]')).not.toBeNull();
    expect(document.querySelector("h2")?.textContent).toBe("Saving to this computer");
    expect(document.body.textContent).toContain("20%about 4 min left");
    expect(document.querySelector('[role="radiogroup"][aria-label="Where it goes"]')).toBeNull();
    expect(document.body.textContent).toContain("It carries on if you close this.");
    expect(document.body.textContent).not.toContain("cutfx");
    expect(buttons()).toContain("Cancel export");
    expect(buttons()).toContain("Close");
    expect(buttons()).not.toContain("Export");
  });

  // Nov 21: done says what happened ("Saved to …") over the steps with their times, and the one thing to do next is to
  // show the file; Export comes back the next time the dialog opens.
  it("exporting the video, then done: what happened is the heading, the steps are done, and the main action shows the file", async () => {
    const video = { ...STEPS, left_s: 100, steps: [{ ...STEPS.steps[0]!, label: "0:12" }, { kind: "video" as const, state: "current" as const, label: "1:48:29", progress: 0.4, left_s: 100 }, STEPS.steps[6]!] };
    const rows = vi.spyOn(api, "exportActivity").mockResolvedValue([{ id: "p1", name: "Case", path: "/home/me/Downloads/Edit/Case.mp4", state: "running", progress: 0.4, updated_ms: 1, steps: video }]);
    await open(project(), { channel: null, channels: PICTURES });
    act(() => useEditor.setState({ exportState: { state: "running", progress: 0.4, path: "/home/me/Downloads/Edit/Case.mp4" } as never }));
    await settle();
    expect(document.body.textContent).toContain("Video · 1:48:2940% · ~2 min");
    expect(document.body.textContent).toContain("about 2 min left");
    rows.mockResolvedValue([]);
    act(() => useEditor.setState({ exportState: { state: "done", progress: 1, path: "/home/me/Downloads/Edit/Case.mp4" } as never }));
    await settle();
    expect(document.querySelector("h2")?.textContent).toBe("Saved to ~/Downloads/Edit");
    // The server kept no times here: the steps as last seen, each done.
    expect([...document.querySelectorAll('ol[aria-label="Export steps"] > li')].map((row) => row.textContent)).toEqual(["The graphic at 0:12done", "Video · 1:48:29done", "Save to ~/Downloads/Editdone"]);
    expect(buttons()).not.toContain("Export");
    expect(buttons().some((one) => one?.startsWith("Show in") === true) || document.querySelector("a[download]") !== null).toBe(true);
  });
});

describe("ShareDialog's marked parts (Sphe, Nov 17: three cards, each a picture of what comes out)", () => {
  const FPS = 30;
  const EDIT = 6509; // 1:48:29
  // 31 + 44 + 52 + 25 + 40 + 30 + 30 = 252 s, 4:12.
  const LENGTHS = [31, 44, 52, 25, 40, 30, 30];
  const marked = (lengths: number[]): Project => {
    let at = 60;
    const ranges = lengths.map((length, index) => {
      const range = { start: at * FPS, end: (at + length) * FPS, name: `Part ${index + 1}` };
      at += length + 600;
      return range;
    });
    return { ...project(), clips: [{ id: "c1", track: "v1", start: 0, duration: EDIT * FPS }], ranges } as unknown as Project;
  };
  const cards = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="What it exports"] [role="radio"]')];
  const said = () => cards().map((card) => card.textContent);
  const checked = () => cards().map((card) => card.getAttribute("aria-checked"));
  const press = (card: number, key: string) => {
    act(() => {
      cards()[card]!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };

  it("seven parts: the whole edit, each on its own, the parts as one, with their counts and lengths, and never “stretch”", async () => {
    await open(marked(LENGTHS), { channel: null, channels: PICTURES });
    expect(said()).toEqual(["The whole edit1 video · 1:48:29", "Each part on its own7 videos · one per marked part", "The parts as one1 video · 7 parts back to back · 4:12"]);
    expect(checked()).toEqual(["true", "false", "false"]);
    // The pictures: one bar, seven blocks apart, seven blocks butted.
    expect(cards().map((card) => card.querySelectorAll("i").length)).toEqual([1, 7, 7]);
    expect(document.body.textContent?.toLowerCase()).not.toContain("stretch");
  });

  it("picked by a click or the arrow keys, and the pick is what Export sends", async () => {
    await open(marked(LENGTHS), { channel: null, channels: PICTURES });
    act(() => cards()[1]!.click());
    expect(checked()).toEqual(["false", "true", "false"]);
    expect(cards().map((card) => card.tabIndex)).toEqual([-1, 0, -1]);
    press(1, "ArrowRight");
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(document.activeElement).toBe(cards()[2]);
    press(2, "ArrowRight");
    expect(checked()).toEqual(["true", "false", "false"]);
    press(0, "ArrowLeft");
    expect(checked()).toEqual(["false", "false", "true"]);

    vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: true } as never);
    const sent = vi.spyOn(api, "exportRanges").mockResolvedValue({ mode: "joined", total: 1, done: 0, current: null, finished: false, outputs: [] } as never);
    // The action says what it does (Nov 21): a save is "Save to this computer".
    const exportButton = [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Save to this computer")!;
    act(() => exportButton.click());
    await settle();
    expect(sent).toHaveBeenCalledWith("p1", "joined", expect.anything(), null);
  });

  it("one part: the whole edit and the marked part, a video of its length, nothing to join", async () => {
    localStorage.setItem("edit.export.what", "joined");
    await open(marked([95]), { channel: null, channels: PICTURES });
    expect(said()).toEqual(["The whole edit1 video · 1:48:29", "The marked part1 video · 1:35"]);
    // Joined was kept from before: with one part it's that part's video.
    expect(checked()).toEqual(["false", "true"]);
    expect(document.body.textContent?.toLowerCase()).not.toContain("stretch");
  });

  it("sending for feedback: no cards, the link is the whole edit's", async () => {
    localStorage.setItem("edit.export.where", "feedback");
    await open(marked(LENGTHS), { channel: null, channels: PICTURES });
    expect(cards()).toEqual([]);
  });
});

describe("ShareDialog once an export has ended (Astra, Nov 18: one obvious next action)", () => {
  const labels = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim());
  const primary = () => [...document.querySelectorAll("button")].filter((one) => ["Retry", "Export again", "Save to this computer", "Share for feedback"].includes(one.textContent?.trim() ?? "")).map((one) => one.textContent?.trim());

  // The action says what it will do (Nov 21): the other destination, with no link yet, is "Share for feedback".
  it("a failed export: Retry alone, and it retries; picking another destination makes it that destination's action", async () => {
    await open(project(), { channel: null, channels: [] });
    act(() => useEditor.setState({ exportState: { state: "failed", progress: 0, path: "/x.mp4", error: "disk full" } as never }));
    await settle();
    expect(primary()).toEqual(["Retry"]);
    const retried = vi.spyOn(api, "retryExport").mockResolvedValue({ started: true });
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Retry")!.click());
    await settle();
    expect(retried).toHaveBeenCalledWith("p1");

    act(() => document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]')!.click());
    expect(primary()).toEqual(["Share for feedback"]);
    // Back to what failed: Retry again.
    act(() => document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]')!.click());
    expect(primary()).toEqual(["Retry"]);
  });

  // A Save-to-computer export that failed while it waited on its graphics has nothing on the server to retry (the
  // wait's failure is only said), and Retry fell back to sharing: the cut went up as a new version on the review link,
  // one a client may have, when only a file was asked for (audit E10c, Nov 21). Retry does what the dialog says.
  it("Retry with nothing to retry does what was picked: a Save-to-computer export saves, it never shares", async () => {
    await open(project(), { channel: null, channels: [] });
    act(() => useEditor.setState({ exportState: { state: "failed", progress: 0, path: "/x.mp4", error: "not enough room" } as never }));
    await settle();
    expect(primary()).toEqual(["Retry"]);
    vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: true } as never);
    vi.spyOn(api, "retryExport").mockRejectedValue(new Error("nothing to retry"));
    const shared = vi.spyOn(api, "shareProject").mockResolvedValue({} as never);
    const saved = vi.spyOn(api, "exportHere").mockResolvedValue({} as never);
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Retry")!.click());
    await settle();
    expect(shared).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledWith("p1", expect.anything(), null);
  });

  it("Retry with nothing to retry, sending for feedback: it shares, as picked", async () => {
    localStorage.setItem("edit.export.where", "feedback");
    await open(project(), { channel: null, channels: [] });
    act(() => useEditor.setState({ exportState: { state: "failed", progress: 0, path: "/x.mp4", error: "not enough room" } as never }));
    await settle();
    vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: true } as never);
    vi.spyOn(api, "retryExport").mockRejectedValue(new Error("nothing to retry"));
    const shared = vi.spyOn(api, "shareProject").mockResolvedValue({} as never);
    const saved = vi.spyOn(api, "exportHere").mockResolvedValue({} as never);
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Retry")!.click());
    await settle();
    expect(saved).not.toHaveBeenCalled();
    expect(shared).toHaveBeenCalledWith("p1", expect.anything(), false, true, null);
  });

  it("a cancelled export: Export again, no Retry", async () => {
    await open(project(), { channel: null, channels: [] });
    vi.spyOn(api, "exportActivity").mockResolvedValue([]);
    act(() => useEditor.setState({ exportState: { state: "running", progress: 0.2, path: "/x.mp4" } as never }));
    await settle();
    act(() => useEditor.setState({ exportState: { state: "cancelled", progress: 0, path: "/x.mp4" } as never }));
    await settle();
    expect(primary()).toEqual(["Export again"]);
    expect(labels()).not.toContain("Retry");
    expect(document.body.textContent).toContain("Cancelled");
  });

  // The MacBook Air, Nov 22: "Cancelled" was still there after closing the dialog and opening it again.
  it("a cancel seen before the dialog opened: the dialog as before, no Cancelled", async () => {
    await open(project(), { channel: null, channels: [] });
    act(() => useEditor.setState({ exportState: { state: "cancelled", progress: 0, path: "/x.mp4" } as never }));
    await settle();
    expect(document.body.textContent).not.toContain("Cancelled");
    expect(primary()).toEqual(["Save to this computer"]);
  });
});

// Sphe, Nov 21: "If we've already shared as V2 and now we want to share again, but there are no comments made, we
// then are given the option to replace V2 and not the option to share as V3." One action, its words the server's
// answer (reviews.ts `nextShare`, the review's `next`), never worked out here.
describe("ShareDialog's Send for feedback says what it will do, as the server answers", () => {
  const primary = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim()).filter((one) => one === "Save to this computer" || one === "Share for feedback" || /^(Replace|Share as) v\d+$/.test(one ?? ""));
  async function linked(next: { version: number; replace: boolean }) {
    localStorage.setItem("edit.export.where", "feedback");
    // An edit with something in it, so the action can be pressed.
    useEditor.setState({ project: { ...project(), clips: [{ id: "c1", track: "v1", start: 0, duration: 300 }] } as unknown as Project, exportState: null });
    vi.spyOn(api, "watermarks").mockResolvedValue({ channel: null, channels: [] });
    vi.spyOn(api, "review").mockResolvedValue({ sharing: null, share: null, watermark: null, review: { url: "https://feedback.test/r/x", versions: [{ n: 1, path: "/a.mp4" }, { n: 2, path: "/b.mp4" }], approved: null }, next, notes: [] } as unknown as Review);
    vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: true } as never);
    vi.spyOn(api, "rangesExport").mockResolvedValue(null);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<ShareDialog open onClose={() => {}} />));
    await settle();
  }

  it("no one has commented on v2: Replace v2, and pressing it asks the server to share", async () => {
    await linked({ version: 2, replace: true });
    expect(primary()).toEqual(["Replace v2"]);
    const shared = vi.spyOn(api, "shareProject").mockResolvedValue({ started: true } as never);
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Replace v2")!.click());
    await settle();
    expect(shared).toHaveBeenCalledWith("p1", expect.anything(), false, true, null);
  });

  it("someone has commented on v2: Share as v3", async () => {
    await linked({ version: 3, replace: false });
    expect(primary()).toEqual(["Share as v3"]);
  });

  // The MacBook Air, Nov 22: "Share as v2" ended "v1 is up" (the edit as v1's, the cloud gave v1 back).
  it("the edit unchanged since v2: never promised as v3, and it says why", async () => {
    await linked({ version: 2, replace: false, unchanged: true } as never);
    expect([...document.querySelectorAll("button")].map((one) => one.textContent?.trim())).toContain("Share v2 again");
    expect(document.body.textContent).toContain("The edit hasn’t changed since v2.");
    expect(document.body.textContent).not.toContain("v3");
  });

  // The MacBook Air, Nov 22: a first share stopped behind "Where should exports go?", which only a save needs.
  it("a share never asks where exports go", async () => {
    await linked({ version: 3, replace: false });
    const asked = vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: false } as never);
    const shared = vi.spyOn(api, "shareProject").mockResolvedValue({ started: true } as never);
    asked.mockClear();
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Share as v3")!.click());
    await settle();
    expect(shared).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Where should exports go");
  });

  it("saving to this computer instead: Save to this computer", async () => {
    await linked({ version: 3, replace: false });
    act(() => document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]')!.click());
    expect(primary()).toEqual(["Save to this computer"]);
  });
});

// Sphe, Nov 21, on the dialog mid-export: "I've only seen a very tiny message… which says 'Replaces V2'… I have no
// idea of progress other than the 'about 9 minutes left'… I don't know what 'Approve V2' is for or 'Delete link'."
describe("ShareDialog's three states: before, while it runs, done", () => {
  const LINK = { url: "https://feedback.test/r/x", versions: [{ n: 1, path: "/a.mp4" }, { n: 2, path: "/b.mp4" }], approved: null };
  const texts = () => [...document.querySelectorAll("button")].map((one) => one.textContent?.trim());
  const rows = () => [...document.querySelectorAll('ol[aria-label="Export steps"] > li')].map((row) => row.textContent);
  const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
  async function show(review: Partial<Review>, where: "here" | "feedback" = "feedback") {
    localStorage.setItem("edit.export.where", where);
    useEditor.setState({ project: { ...project(), clips: [{ id: "c1", track: "v1", start: 0, duration: 300 }] } as unknown as Project, exportState: null });
    vi.spyOn(api, "watermarks").mockResolvedValue({ channel: null, channels: [] });
    const asked = vi.spyOn(api, "review").mockResolvedValue({ sharing: null, share: null, watermark: null, review: null, next: null, notes: [], ...review } as unknown as Review);
    vi.spyOn(api, "exportFolder").mockResolvedValue({ shown: "~/Movies/Edit", home: "/home/me", chosen: true } as never);
    vi.spyOn(api, "rangesExport").mockResolvedValue(null);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<ShareDialog open onClose={() => {}} />));
    await settle();
    return asked;
  }

  it("before: Replace v2 with why beside it, never a note inside the card; Share as v3; Share for feedback for a first share", async () => {
    await show({ review: LINK, next: { version: 2, replace: true } } as never);
    expect(texts()).toContain("Replace v2");
    expect(document.body.textContent).toContain("No one has commented on v2, so this takes its place.");
    expect(document.querySelector('[role="radiogroup"][aria-label="Where it goes"]')!.textContent).not.toMatch(/Replaces|Adds v|Makes the link/);
    // Not "2 versions, latest v2", Approve or Delete link in front of it.
    expect(document.body.textContent).not.toContain("versions, latest");
    expect(texts()).not.toContain("Approve v2");
    expect(texts()).not.toContain("Delete link");
    act(() => root!.unmount());
    await show({ review: LINK, next: { version: 3, replace: false } } as never);
    expect(texts()).toContain("Share as v3");
    expect(document.body.textContent).not.toContain("so this takes its place");
    act(() => root!.unmount());
    await show({});
    expect(texts()).toContain("Share for feedback");
  });

  it("while a share the agent started runs: no choices, what's happening, the overall number and bar, each step with its own state and numbers", async () => {
    const STEPS = {
      where: "feedback" as const,
      queued: false,
      elapsed_s: 200,
      left_s: 380,
      progress: 0.34,
      steps: [
        { kind: "video" as const, state: "done" as const, label: "37:32", progress: null, left_s: 0, took_s: 408 },
        { kind: "copy" as const, state: "current" as const, label: "", progress: null, left_s: null, elapsed_s: 65 },
        { kind: "upload" as const, state: "waiting" as const, label: "", progress: null, left_s: 30 },
      ],
    };
    vi.spyOn(api, "exportActivity").mockResolvedValue([{ id: "p1", name: "Case", path: "/x.mp4", state: "running", progress: 0, updated_ms: 1, share: true, steps: STEPS } as never]);
    await show({ review: LINK, next: { version: 3, replace: false }, sharing: "making the review copy", share: { state: "running", step: "review copy", at: 1, target: { version: 2, replace: true } } } as never);
    await settle();
    // Its own target (the server's, from the share's job), not the next one's.
    expect(document.querySelector("h2")?.textContent).toBe("Replacing v2 on the review link");
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.body.textContent).toContain("34%about 6 min left");
    // Done with how long it took; under way with no percent, its time so far (never a made-up number); to come, its estimate.
    expect(rows()).toEqual(["Video · 37:326 min 48 s", "Review copy1 min 5 s so far", "Upload to the review link~30 s"]);
    expect(document.querySelector('[data-state="done"]')).not.toBeNull();
    expect(document.querySelector('[data-state="waiting"]')).not.toBeNull();
    expect(texts()).toEqual(expect.arrayContaining(["Cancel export", "Close"]));
    expect(texts()).not.toContain("Replace v2");
    expect(document.body.textContent).toContain("It carries on if you close this.");
  });

  // The MacBook Air, Nov 22: the heading said the last share's words for a second as the next one started.
  it("a share just pressed is headed by what it will do, never by the last share's words", async () => {
    vi.spyOn(api, "exportActivity").mockResolvedValue([]);
    await show({ review: LINK, next: { version: 3, replace: false }, share: { state: "done", step: "published", at: 1, version: 2, url: LINK.url, target: { version: 2, replace: true } } } as never);
    vi.spyOn(api, "shareProject").mockReturnValue(new Promise(() => {}));
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Share as v3")!.click());
    await settle();
    expect(document.querySelector("h2")?.textContent).toBe("Sharing v3 for feedback");
  });

  it("a share of an unchanged edit, done: it says nothing changed and that version is still the link", async () => {
    vi.spyOn(api, "exportActivity").mockResolvedValue([]);
    const asked = await show({ review: LINK, next: { version: 2, replace: false, unchanged: true }, sharing: "uploading 90%", share: { state: "running", step: "uploading", at: 1, target: { version: 2, replace: false, unchanged: true } } } as never);
    await settle();
    expect(document.querySelector("h2")?.textContent).toBe("Sharing v2 again");
    asked.mockResolvedValue({ sharing: null, share: { state: "done", step: "published", at: 2, version: 2, url: LINK.url, target: { version: 2, replace: false, unchanged: true } }, watermark: null, review: LINK, next: { version: 2, replace: false, unchanged: true }, notes: [] } as unknown as Review);
    await wait(1700);
    await settle();
    expect(document.querySelector("h2")?.textContent).toBe("Nothing changed, so v2 is still the link");
  });

  it("a step under way with a percent says it and its time left, with its own bar", async () => {
    const STEPS = { where: "feedback" as const, queued: false, elapsed_s: 20, left_s: 300, progress: 0.1, steps: [{ kind: "video" as const, state: "current" as const, label: "37:32", progress: 0.46, left_s: 240 }, { kind: "copy" as const, state: "waiting" as const, label: "", progress: null, left_s: 60 }, { kind: "upload" as const, state: "waiting" as const, label: "", progress: null, left_s: null }] };
    vi.spyOn(api, "exportActivity").mockResolvedValue([{ id: "p1", name: "Case", path: "/x.mp4", state: "running", progress: 0.46, updated_ms: 1, share: true, steps: STEPS } as never]);
    await show({ review: LINK, next: { version: 3, replace: false }, sharing: "exporting", share: { state: "running", step: "exporting", at: 1, target: { version: 3, replace: false } } } as never);
    await settle();
    expect(document.querySelector("h2")?.textContent).toBe("Sharing v3 for feedback");
    expect(rows()).toEqual(["Video · 37:3246% · ~4 min", "Review copy~1 min", "Upload to the review link"]);
    expect(document.querySelector<HTMLElement>('[data-state="current"]')?.closest("li")?.querySelector('[style*="width: 46%"]')).not.toBeNull();
  });

  it("done: what happened is the heading, the steps with their times, the link with Open, and Copy link the main action", async () => {
    const running = { where: "feedback" as const, queued: false, elapsed_s: 30, left_s: 3, progress: 0.95, steps: [{ kind: "video" as const, state: "done" as const, label: "37:32", progress: null, left_s: 0, took_s: 408 }, { kind: "copy" as const, state: "done" as const, label: "", progress: null, left_s: 0, took_s: 52 }, { kind: "upload" as const, state: "current" as const, label: "", progress: 0.9, left_s: 3 }] };
    const ended = { ...running, left_s: 0, progress: 1, steps: running.steps.map((one) => ({ ...one, state: "done" as const, progress: null, left_s: 0, took_s: one.took_s ?? 31 })) };
    const activity = vi.spyOn(api, "exportActivity").mockResolvedValue([{ id: "p1", name: "Case", path: "/x.mp4", state: "running", progress: 1, updated_ms: 1, share: true, steps: running } as never]);
    const asked = await show({ review: LINK, next: { version: 3, replace: false }, sharing: "uploading 90%", share: { state: "running", step: "uploading", at: 1, target: { version: 2, replace: true } } } as never);
    await settle();
    expect(document.querySelector("h2")?.textContent).toBe("Replacing v2 on the review link");
    // It's published: the server's share is done, its row done with its steps' times.
    asked.mockResolvedValue({ sharing: null, share: { state: "done", step: "published", at: 2, version: 2, url: LINK.url, target: { version: 2, replace: true } }, watermark: null, review: LINK, next: { version: 2, replace: true }, notes: [] } as unknown as Review);
    activity.mockResolvedValue([{ id: "p1", name: "Case", path: "/x.mp4", state: "done", progress: 1, updated_ms: 2, share: true, steps: ended } as never]);
    await wait(1700);
    await settle();
    expect(document.querySelector("h2")?.textContent).toBe("v2 replaced");
    expect(rows()).toEqual(["Video · 37:326 min 48 s", "Review copy52 s", "Upload to the review link31 s"]);
    expect(document.body.textContent).toContain("feedback.test/r/x");
    expect(texts()).toEqual(expect.arrayContaining(["Open", "Close", "Copy link"]));
    expect(texts()).not.toContain("Cancel export");
  });

  it("the link's Approve and Delete link are behind its ⋯: Approve keeps its two clicks, Delete link its question", async () => {
    // Someone who may delete a link (an admin here).
    useAccount.setState({ account: { person: { email: "someone@example.test", name: "A", image: null }, perms: [], admin: true } as never });
    await show({ review: LINK, next: { version: 3, replace: false } } as never);
    expect(texts()).not.toContain("Approve v2");
    const more = document.querySelector<HTMLButtonElement>('button[aria-label="More for this link"]')!;
    act(() => more.click());
    expect(texts()).toEqual(expect.arrayContaining(["Approve v2", "Delete link"]));
    const approved = vi.spyOn(api, "approveReview").mockResolvedValue({ version: 2, deleted: [] } as never);
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Approve v2")!.click());
    await settle();
    // The first click asks: nothing approved yet.
    expect(approved).not.toHaveBeenCalled();
    expect(texts()).toContain("Approve v2 and delete the others");
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Approve v2 and delete the others")!.click());
    await settle();
    expect(approved).toHaveBeenCalledWith("p1");
    // Delete link asks first, then deletes.
    act(() => [...document.querySelectorAll("button")].find((one) => one.textContent?.trim() === "Delete link")!.click());
    expect(document.body.textContent).toContain("Delete this link? It can't be undone");
    const deleted = vi.spyOn(api, "deleteReview").mockResolvedValue({} as never);
    const confirm = [...document.querySelectorAll("button")].filter((one) => one.textContent?.trim() === "Delete link").at(-1)!;
    act(() => confirm.click());
    await settle();
    expect(deleted).toHaveBeenCalledWith("p1");
    useAccount.setState({ account: null } as never);
  });
});
