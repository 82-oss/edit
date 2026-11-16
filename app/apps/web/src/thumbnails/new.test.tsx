// @vitest-environment happy-dom
// New thumbnail never makes a second thumbnail: once one is made, trying again does only what didn't go.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const create = vi.fn<(title: string, brief: string, channel: string | null) => Promise<{ id: string }>>();
const change = vi.fn<(id: string, change: { title?: string; brief?: string }) => Promise<unknown>>();
const chat = vi.fn<(id: string, text: string, images: string[]) => Promise<{ ok: true }>>();
const postFile = vi.fn<(url: string, file: File) => Promise<unknown>>();
const navigate = vi.fn<(to: string) => void>();

vi.mock("../lib/thumbnails", async (original) => ({
  ...(await original<typeof import("../lib/thumbnails")>()),
  thumbnailsApi: { create: (...args: Parameters<typeof create>) => create(...args), change: (...args: Parameters<typeof change>) => change(...args), chat: (...args: Parameters<typeof chat>) => chat(...args) },
}));
vi.mock("../lib/chatFiles", async (original) => ({ ...(await original<typeof import("../lib/chatFiles")>()), postFile: (url: string, file: File) => postFile(url, file) }));
vi.mock("../lib/route", async (original) => ({ ...(await original<typeof import("../lib/route")>()), navigate: (to: string) => navigate(to) }));

const { NewThumbnail } = await import("./new");

let root: Root;
let closed: number;

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <NewThumbnail
        open
        onClose={() => {
          closed += 1;
        }}
      />,
    ),
  );
}

/** Words typed into a field, as React hears them. */
function fill(field: HTMLInputElement | HTMLTextAreaElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  act(() => {
    setter.call(field, words);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function paste(file: File) {
  const event = new Event("paste", { cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [file] } });
  act(() => void window.dispatchEvent(event));
}

const button = (words: string) => [...document.querySelectorAll("button")].find((one) => one.textContent === words)!;

async function submit(words: string) {
  await act(async () => {
    button(words).click();
    await new Promise((done) => setTimeout(done, 0));
  });
}

describe("New thumbnail", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    for (const one of [create, change, chat, postFile, navigate]) one.mockReset();
    closed = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("tries again with only the picture that didn't go and Claude's first word, never a second thumbnail", async () => {
    create.mockResolvedValue({ id: "t1" });
    postFile.mockResolvedValueOnce({ image: { id: "i1" } }).mockRejectedValueOnce(new Error("fetch failed"));
    chat.mockResolvedValue({ ok: true });
    mount();
    fill(document.querySelector("input:not([type=file])")!, "Cop's worst day");
    paste(new File(["a"], "a.png", { type: "image/png" }));
    paste(new File(["b"], "b.png", { type: "image/png" }));
    await submit("Make the thumbnail");
    expect(create).toHaveBeenCalledOnce();
    expect(chat).not.toHaveBeenCalled();
    expect(closed).toBe(0);
    expect(button("Cancel").disabled).toBe(false);

    postFile.mockResolvedValueOnce({ image: { id: "i2" } });
    fill(document.querySelector("textarea")!, "The officer at the door");
    await submit("Try again");
    expect(create).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith("t1", { title: "Cop's worst day", brief: "The officer at the door" });
    expect(postFile).toHaveBeenCalledTimes(3);
    expect(postFile.mock.calls[2]![1].name).toBe("b.png");
    expect(chat).toHaveBeenCalledWith("t1", "Make it from the guide, with these reference pictures.", ["i1", "i2"]);
    expect(navigate).toHaveBeenCalledWith("/thumbnails/t1");
    expect(closed).toBe(1);
  });

  it("can't be cancelled while it works", async () => {
    create.mockReturnValue(new Promise(() => {}));
    mount();
    fill(document.querySelector("input:not([type=file])")!, "Cop's worst day");
    await submit("Start");
    expect(button("Cancel").disabled).toBe(true);
  });
});
