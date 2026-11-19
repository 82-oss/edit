// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import type { Project, ScriptJob } from "../lib/types";
import { WaitingFiles } from "./WaitingFiles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(node: React.ReactNode): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

const buttons = () => [...document.querySelectorAll("button")].map((button) => button.textContent?.trim());
const project = { id: "p1", script: { blocks: [] } } as unknown as Project;

// Nov 18, JJ: "What do I click here?" over "I have a replacement" and "Go on without it". Each answer says what it does.
describe("an import waiting on the person", () => {
  it("offers only the file that's really gone, each answer saying what it does", async () => {
    const job: ScriptJob = {
      state: "waiting",
      files: [
        { file: "a", bytes: 10, total: 10, state: "done" },
        { file: "b", name: "25-11748 interview.mp4", bytes: 0, state: "failed", why: "person", error: "Google Drive can't find this file: it was deleted, or in the trash." },
        // A dropped connection beside it is tried again by itself: nothing to press for it.
        { file: "c", name: "door.mp4", bytes: 0, state: "waiting", why: "passing", retry_at: 1, error: "could not reach Edit's relay: The socket connection was closed unexpectedly." },
      ],
    };
    mount(<WaitingFiles project={project} job={job} />);
    expect(document.body.textContent).toContain("25-11748 interview.mp4");
    expect(document.body.textContent).toContain("That Google Drive file is gone");
    expect(document.body.textContent).not.toContain("door.mp4");
    expect(document.body.textContent).not.toContain("couldn't reach the internet");
    expect(buttons()).toEqual(["Use another link", "Make the edit with its parts black"]);
    const answer = vi.spyOn(api, "answerFootage").mockResolvedValue({ job: { ...job, state: "placing" } } as never);
    await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Make the edit with its parts black")!.click());
    expect(answer).toHaveBeenCalledWith("p1", "b", { skip: true });
  });
});
