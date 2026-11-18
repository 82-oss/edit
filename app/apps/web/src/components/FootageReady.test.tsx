// @vitest-environment happy-dom
import type { FootageReady as Ready } from "@edit/types/footage_ready";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { FootageCard, FootageDialog, rowsOf, timing, useFootage } from "./FootageReady";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
delete (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;
const real = { ...timing };
beforeEach(() => {
  Object.assign(timing, { firstMs: 200, graceMs: 30, dialogMs: 10, cardMs: 10, roomMs: 40 });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  Object.assign(timing, real);
  vi.restoreAllMocks();
});

const answer = (fields: Partial<Ready> = {}): Ready => ({
  ready: false,
  done: false,
  made_on: "Lauana's Mac",
  head_s: 1200,
  length_s: 3000,
  bytes_done: 6.1e9,
  bytes_total: 9.4e9,
  files_done: 21,
  files_total: 32,
  speed_bps: 48e6,
  ready_in_s: 180,
  left_s: 180,
  steps: [
    { kind: "start", state: "done", left_s: 0 },
    { kind: "rest", state: "current", left_s: 180 },
    { kind: "graphics", state: "waiting", left_s: 5 },
  ],
  room: null,
  cant: null,
  ...fields,
});

/** The editor's part in it (Editor.tsx): the project behind, the dialog over it, the card in the corner. */
function Harness() {
  const footage = useFootage("p1", true);
  return (
    <>
      {footage.phase === "checking" ? <p>Opening the project…</p> : <p data-card={footage.card ? "on" : "off"}>The project</p>}
      {footage.phase === "dialog" && footage.answer && <FootageDialog answer={footage.answer} onOpen={footage.openNow} />}
      <FootageCard answer={footage.card} />
    </>
  );
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const dialog = () => document.querySelector("[role=dialog]");
const card = () => document.querySelector("[aria-label='Footage coming']");
/** Whether the card is asked for (happy-dom never ends motion's exit, so a card going stays in the page). */
const cardOn = () => document.querySelector("[data-card]")?.getAttribute("data-card") === "on";

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
}

/** The server's answers, one after another (the last one kept). */
function answers(...given: Ready[]) {
  const asked: boolean[] = [];
  const spy = vi.spyOn(api, "footageReady").mockImplementation(async (_id, waiting) => {
    asked.push(waiting);
    return given.length > 1 ? given.shift()! : given[0]!;
  });
  return { spy, asked };
}

describe("FootageReady", () => {
  it("a project ready to play smoothly opens as it always has: no dialog, no card", async () => {
    answers(answer({ ready: true, done: true }));
    mount();
    await wait(20);
    expect(document.body.textContent).toContain("The project");
    expect(dialog()).toBeNull();
    expect(card()).toBeNull();
    expect(cardOn()).toBe(false);
  });

  it("one ready within a couple of seconds never shows the dialog", async () => {
    answers(answer(), answer({ ready: true }));
    mount();
    await wait(5);
    // The editor waits on the loader meanwhile.
    expect(document.body.textContent).toContain("Opening the project…");
    await wait(80);
    expect(document.body.textContent).toContain("The project");
    expect(dialog()).toBeNull();
  });

  it("one that would stutter shows the dialog, which opens the project by itself once it's ready, and the card follows the rest until it's done", async () => {
    let now = answer();
    const asked: boolean[] = [];
    vi.spyOn(api, "footageReady").mockImplementation(async (_id, waiting) => {
      asked.push(waiting);
      return now;
    });
    mount();
    await wait(60);
    const shown = dialog();
    expect(shown?.textContent).toContain("Getting the footage ready for");
    expect(shown?.textContent).toContain("This edit was made on Lauana's Mac. Edit is bringing its footage here so it plays smoothly. It opens by itself when it's ready.");
    expect(shown?.textContent).toContain("6.1 of 9.4 GB · 21 of 32 files");
    expect(shown?.textContent).toContain("about 3 min");
    expect(shown?.textContent).toContain("Downloading at 48 MB/s");
    const rows = [...document.querySelectorAll("[aria-label='Footage steps'] li")].map((row) => row.textContent);
    expect(rows).toEqual(["The first 20 minutes of the edit" + "ready", "The rest of the footage~3 min", "The graphicsa moment"]);
    // Every ask while it's up brings the start first.
    expect(asked.every((one) => one)).toBe(true);
    // Ready: it opens by itself, nothing pressed, and the card follows what's still coming.
    now = answer({ ready: true, files_done: 23, left_s: 120 });
    await wait(40);
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain("The project");
    expect(card()?.textContent).toContain("9 files left · about 2 min");
    // Everything here: the card goes.
    now = answer({ ready: true, done: true, files_done: 32 });
    await wait(60);
    expect(cardOn()).toBe(false);
  });

  it("Open now opens it at once, the card keeping the same progress until everything's here, then going", async () => {
    let done = false;
    vi.spyOn(api, "footageReady").mockImplementation(async () => (done ? answer({ ready: true, done: true, files_done: 32 }) : answer({ files_done: 23 })));
    mount();
    await wait(60);
    const open = [...document.querySelectorAll("button")].find((button) => button.textContent === "Open now")!;
    act(() => open.click());
    await wait(30);
    expect(dialog()).toBeNull();
    expect(card()?.textContent).toContain("Getting the rest of the footage");
    expect(card()?.textContent).toContain("9 files left · about 3 min");
    done = true;
    await wait(60);
    expect(cardOn()).toBe(false);
  });

  it("a step whose footage can't all come here isn't ticked ready: it says it plays from the cloud", () => {
    const rows = rowsOf(answer({ steps: [{ kind: "start", state: "done", left_s: 0 }, { kind: "rest", state: "done", left_s: 0, streams: true }] }));
    expect(rows.map((row) => [row.state, row.right])).toEqual([["done", "ready"], ["waiting", "from the cloud"]]);
  });

  it("after it opened by itself the rest is still waited on; Open now lets the link go at once", async () => {
    let now = answer();
    const asked: boolean[] = [];
    vi.spyOn(api, "footageReady").mockImplementation(async (_id, waiting) => {
      asked.push(waiting);
      return now;
    });
    mount();
    await wait(60);
    now = answer({ ready: true });
    await wait(40);
    // The card's asks after an open by itself keep waiting on the footage.
    expect(cardOn()).toBe(true);
    expect(asked.slice(-2)).toEqual([true, true]);
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    asked.length = 0;
    now = answer();
    mount();
    await wait(60);
    const open = [...document.querySelectorAll("button")].find((button) => button.textContent === "Open now")!;
    act(() => open.click());
    await wait(30);
    // Said at once, and every card ask after it, without waiting.
    const after = asked.slice(asked.lastIndexOf(true) + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((one) => !one)).toBe(true);
  });

  it("one that can't become smooth says so instead of a time, Open now still the way on", async () => {
    const cant = "This Mac can't hold all of it and the connection is too slow to stream the rest smoothly. Open now plays the start smoothly; later parts may pause.";
    vi.spyOn(api, "footageReady").mockResolvedValue(answer({ cant, ready_in_s: 99_999 }));
    mount();
    await wait(60);
    expect(dialog()?.textContent).toContain(cant);
    expect(dialog()?.textContent).not.toContain("about");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Open now")).toBe(true);
  });
});
