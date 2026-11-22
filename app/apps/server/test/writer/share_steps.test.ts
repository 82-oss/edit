// A script's share says each step it goes through, with the bytes it really
// moved and a time left only from a measured rate (Sphe, Nov 22: "I don't
// have a very good breakdown in the UI of the progress, as well as I do with
// the editing"). The cloud stands in: the share's own code runs.

import { afterAll, expect, mock, setSystemTime, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import type { App } from "../../src/app.ts";
import * as realCloud from "../../src/writer/cloud.ts";

const PREVIEW = 1_000;
/** The review copy's upload, held until the test lets it go, hearing bytes as the test says them. */
let upload: { report: (done: number, total: number) => void; finish: () => void; fail: (error: Error) => void; aborted: boolean } | null = null;
const standIn = { on: false, previewUp: true };
const real = { ...realCloud };
// The real one whenever this test isn't running: the mock is the whole run's.
void mock.module("../../src/writer/cloud.ts", () => ({
  ...realCloud,
  fileKey: (data: string, id: string, name: string) => (standIn.on ? { key: `writer/${id}/proxy.mp4`, size: PREVIEW, mtime: 0 } : real.fileKey(data, id, name)),
  sameAsHere: (data: string, id: string, name: string) => (standIn.on ? standIn.previewUp : real.sameAsHere(data, id, name)),
  // The kept preview is there; the review link has none yet.
  head: async (key: string) => (standIn.on ? (key.endsWith("/proxy.mp4") ? PREVIEW : null) : real.head(key)),
  putBytes: async (key: string, bytes: Uint8Array | string, type?: string) => (standIn.on ? undefined : real.putBytes(key, bytes, type)),
  // Held as a slow line holds it: it ends only when the test lets it, or when its signal aborts it.
  putFile: (script: string, key: string, path: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal) => {
    if (!standIn.on) return real.putFile(script, key, path, onProgress, signal);
    return new Promise<number>((resolve, reject) => {
      const held = { report: (done: number, total: number) => onProgress?.(done, total), finish: () => resolve(PREVIEW), fail: reject, aborted: false };
      signal?.addEventListener("abort", () => {
        held.aborted = true;
        reject(new Error("the share was cancelled"));
      });
      upload = held;
    });
  },
  convex: async (kind: string, path: string, args: Record<string, unknown>) => {
    if (!standIn.on) return real.convex(kind, path, args);
    return path === "reviews:publish" ? { ok: true as const, value: { reviewId: "review-1", url: "https://review.test/r/1", version: 1, token: "t" } } : { ok: true as const, value: {} };
  },
}));

const reviews = await import("../../src/writer/reviews.ts");
const store = await import("../../src/writer/store.ts");

const data = fs.mkdtempSync(join(os.tmpdir(), "edit-share-steps-"));
afterAll(() => {
  setSystemTime();
  fs.rmSync(data, { recursive: true, force: true });
});

function script(id: string, extra: Partial<Script> = {}): Script {
  const words = Array.from({ length: 20 }, (_, index) => ({ id: `w${index}`, text: index % 5 === 4 ? "end." : `word${index}`, startMs: index * 1000, endMs: index * 1000 + 800 }));
  const one: Script = {
    id,
    title: "A case",
    sourceKind: "youtube",
    sourceUrl: "",
    originalPath: "",
    status: "ready",
    stage: "",
    progress: 100,
    error: null,
    durationMs: 20_000,
    words,
    clips: [
      { id: "k1", startMs: 0, endMs: 0, kind: "cut-in", narration: "An intro." },
      { id: "c1", startMs: 0, endMs: 9_000 },
    ],
    overview: [],
    revision: 3,
    createdAt: 0,
    updatedAt: 0,
    proxyPath: null,
    ...extra,
  };
  const dir = store.scriptDir(data, id);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, one);
  fs.writeFileSync(store.proxyPath(dir), new Uint8Array(PREVIEW));
  return one;
}

/** Turns of the event loop, for the share to reach its next await. */
const settle = async () => {
  for (let n = 0; n < 20; n++) await new Promise((resolve) => setTimeout(resolve, 1));
};

const kinds = (id: string) => reviews.shareState(id).sharing?.steps?.map((step) => `${step.kind}:${step.state}`);

test("a script's share says each step: done with its time, the upload's bytes, and its time left once a rate is measured", async () => {
  const id = "7a001eed-86e7-471f-b0c0-3fcc4009a001";
  const shared = script(id);
  const snapshot = Buffer.byteLength(JSON.stringify(store.read(store.scriptDir(data, id))));
  standIn.on = true;
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  try {
    const going = reviews.startShare({} as App, data, id);
    await settle();
    // Up to the review copy: the preview checked, the script sent, the copy under way with nothing measured yet.
    expect(kinds(id)).toEqual(["check:done", "script:done", "footage:current", "publish:waiting"]);
    let state = reviews.shareState(id).sharing!;
    expect(state.version).toBe(1);
    expect(state.steps!.find((step) => step.kind === "script")!.total).toBe(snapshot);
    expect(state.steps!.find((step) => step.kind === "footage")!.total).toBe(PREVIEW);
    expect(state.leftS).toBeNull();

    upload!.report(100, PREVIEW);
    state = reviews.shareState(id).sharing!;
    const footage = () => reviews.shareState(id).sharing!.steps!.find((step) => step.kind === "footage")!;
    expect(footage().done).toBe(100);
    // No rate from a first reading alone: no time left is made up.
    expect(footage().leftS).toBeUndefined();
    expect(state.progress).toBeCloseTo((snapshot + 100) / (snapshot + PREVIEW));
    expect(state.stage).toBe("uploading the footage 10%");

    // 400 bytes in 4 s: 0.1 bytes a ms, so the 500 left take 5 s, and nothing after it moves bytes.
    setSystemTime(new Date(t0 + 4_000));
    upload!.report(500, PREVIEW);
    expect(footage().leftS).toBeCloseTo(5);
    expect(reviews.shareState(id).sharing!.leftS).toBeCloseTo(5);
    expect(footage().seconds).toBeCloseTo(4);
    // The export queue says the same number as the row.
    expect(reviews.shareQueue().find((one) => one.id === id)!.progress).toBeCloseTo((snapshot + 500) / (snapshot + PREVIEW));

    setSystemTime(new Date(t0 + 9_000));
    upload!.finish();
    const done = await going;
    expect(done.review?.url).toBe("https://review.test/r/1");
    // Landed: every step done with how long it took, kept for the dialog until the next share.
    const after = reviews.shareState(id);
    expect(after.sharing).toBeUndefined();
    expect(after.shared?.version).toBe(1);
    expect(after.shared?.steps.map((step) => `${step.kind}:${step.state}`)).toEqual(["check:done", "script:done", "footage:done", "publish:done"]);
    expect(after.shared?.steps.find((step) => step.kind === "footage")?.seconds).toBeCloseTo(9);
    expect(shared.id).toBe(id);
  } finally {
    standIn.on = false;
    upload = null;
    setSystemTime();
  }
});

test("a share that stops says why and the step it stopped in, and a commentary's has no preview steps or made-up percent", async () => {
  const id = "7a001eed-86e7-471f-b0c0-3fcc4009a002";
  script(id);
  standIn.on = true;
  try {
    const going = reviews.startShare({} as App, data, id);
    await settle();
    upload!.report(300, PREVIEW);
    upload!.fail(new Error("preview.mp4 didn't get through (the line dropped). Check the connection, then share again."));
    await expect(going).rejects.toThrow("didn't get through");
    expect(reviews.shareState(id).shareFailed).toMatchObject({ step: "footage", error: "preview.mp4 didn't get through (the line dropped). Check the connection, then share again." });

    const words = "7a001eed-86e7-471f-b0c0-3fcc4009a003";
    script(words, { commentary: { sources: [], draft: { open: [], sections: [{ heading: "One", paragraphs: [{ id: "p1", pieces: [{ kind: "say", text: "He lied." }] }] }], checks: [], report: "", writtenAt: 0 } } });
    const finished = reviews.startShare({} as App, data, words).catch(() => null);
    // Planned as it starts: the script and its publishing, no preview to check or send, and no percent made of its few bytes.
    const seen = reviews.shareState(words).sharing!;
    expect(seen.steps!.map((step) => step.kind)).toEqual(["script", "publish"]);
    expect(seen.progress).toBeNull();
    await finished;
  } finally {
    standIn.on = false;
    upload = null;
  }
});

// Nov 22, a MacBook Air in the real window: Cancel said "Stopping…" for 26 s while the footage kept going at full line rate.
test("Cancel stops the footage's upload at once", async () => {
  const id = "7a001eed-86e7-471f-b0c0-3fcc4009a004";
  script(id);
  standIn.on = true;
  try {
    const going = reviews.startShare({} as App, data, id);
    await settle();
    upload!.report(300, PREVIEW);
    const held = upload!;
    const began = Date.now();
    expect(reviews.cancelShare(id)).toBe(true);
    const settled = await Promise.race([going.then(() => "landed", (error: unknown) => (error instanceof reviews.ShareCancelled ? "cancelled" : `failed: ${String(error)}`)), new Promise<string>((resolve) => setTimeout(() => resolve("still going"), 2_000))]);
    expect(settled).toBe("cancelled");
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(held.aborted).toBe(true);
    if (!held.aborted) held.finish();
  } finally {
    standIn.on = false;
    upload = null;
  }
});

// Nov 22, the same MacBook Air: after a Cancel the row went back to "Start edit" and the dialog to a plain "Share".
test("a cancelled share says it was cancelled, not that it failed or where it stopped, until the next share", async () => {
  const id = "7a001eed-86e7-471f-b0c0-3fcc4009a006";
  script(id);
  standIn.on = true;
  try {
    const going = reviews.startShare({} as App, data, id).catch((error: unknown) => error);
    await settle();
    upload!.report(300, PREVIEW);
    reviews.cancelShare(id);
    // Let go as the step it was in lets go, whether or not its signal stopped it.
    upload!.finish();
    expect(await going).toBeInstanceOf(reviews.ShareCancelled);
    const said = reviews.shareState(id).shareFailed;
    expect(said?.why).toBe("cancelled");
    expect(said?.step).toBeUndefined();
    const again = reviews.startShare({} as App, data, id);
    await settle();
    expect(reviews.shareState(id).shareFailed).toBeUndefined();
    upload!.finish();
    await again;
  } finally {
    standIn.on = false;
    upload = null;
  }
});

// Nov 22, the same MacBook Air: a share asked for while the preview still went up read "Sharing stopped while checking its preview",
// as if it broke partway, and still said to wait after the preview was up.
test("a share refused before it starts says only why, as a refusal, and the line goes once the preview is up", async () => {
  const id = "7a001eed-86e7-471f-b0c0-3fcc4009a005";
  script(id);
  standIn.on = true;
  standIn.previewUp = false;
  try {
    await expect(reviews.startShare({} as App, data, id)).rejects.toThrow("still going up to the cloud");
    const said = reviews.shareState(id).shareFailed;
    expect(said?.why).toBe("refused");
    expect(said?.step).toBeUndefined();
    expect(said?.error).toBe("Its preview is still going up to the cloud. Share it again once it's there.");
    // The sync puts it up: nothing says to wait any more.
    standIn.previewUp = true;
    expect(reviews.shareState(id).shareFailed).toBeUndefined();
  } finally {
    standIn.on = false;
    standIn.previewUp = true;
  }
});
