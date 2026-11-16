// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEditor } from "../lib/store";
import { UntaughtLine, useUntaughtChannel } from "./Untaught";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the channel page answers: its edit lane's teaching, and its group's. */
let taught: { edit: unknown[] } = { edit: [] };
let fails = false;
vi.mock("../lib/channels", () => ({
  channelApi: { page: async () => (fails ? Promise.reject(new Error("offline")) : { channel: { title: "Cuffed & Caught" }, taught, group: null }) },
}));

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  taught = { edit: [] };
  fails = false;
});

function Panel() {
  return useUntaughtChannel() === null ? null : <UntaughtLine />;
}

async function shown(): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Panel />));
  return document.body.textContent ?? "";
}

describe("Waiting for this channel to be taught", () => {
  it("is said on a channel's project with its footage in while the channel is untaught, and not once it's taught or couldn't be read (Sphe, Nov 16)", async () => {
    useEditor.setState({ project: { id: "p1", channel: "cuffed", media: [{ id: "m1" }] } as never });
    expect(await shown()).toBe("Waiting for this channel to be taught");
    act(() => root!.unmount());
    taught = { edit: [{ kind: "skill", key: "skill:@cuffed--edit/pins", name: "pins" }] };
    expect(await shown()).toBe("");
    act(() => root!.unmount());
    taught = { edit: [] };
    fails = true;
    expect(await shown()).toBe("");
    act(() => root!.unmount());
    // No channel: nothing.
    fails = false;
    useEditor.setState({ project: { id: "p2", media: [{ id: "m1" }] } as never });
    expect(await shown()).toBe("");
  });
});
